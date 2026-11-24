import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {createReleaseConsent} from './dropbox-live/release-consent.mjs';

const origin = 'http://localhost:8765';
const appKey = 'fictional-app-key';
const state = 'S'.repeat(43);
function authorize(stateValue = state) {
  const url = new URL('https://www.dropbox.com/oauth2/authorize');
  url.search = new URLSearchParams({client_id:appKey, response_type:'code', token_access_type:'offline',
    redirect_uri:origin+'/', scope:'files.metadata.read files.content.read files.content.write', state:stateValue,
    code_challenge:'C'.repeat(43), code_challenge_method:'S256'}).toString();
  return url;
}
async function request(consent, target, {method='GET',headers={},body=''}={}) {
  const req = Object.assign(Readable.from([body]), {url:target,method,headers:{host:'localhost:8765',...headers}});
  const res = {headers:{}, setHeader(name,value) { this.headers[name] = value; },
    writeHead(status,headers) { this.status = status; Object.assign(this.headers,headers); return this; },
    end(text='') { this.body = text; }};
  res.handled = await consent.handle(req,res);
  return res;
}

test('The owner enters a public registration and approves each isolated release sign-in once', async () => {
  const consent = createReleaseConsent(origin), url = authorize();
  const page = await request(consent,consent.path);
  assert.equal(page.headers['Cache-Control'],'no-store');
  assert.match(page.body,/Dropbox public app key/);
  const submit = {method:'POST',body:'key='+appKey,headers:{origin,'content-type':'application/x-www-form-urlencoded'}};
  assert.equal((await request(consent,consent.path+'/key',{...submit,headers:{...submit.headers,origin:'https://outside.test'}})).status,403);
  assert.equal((await request(consent,consent.path+'/key',submit)).status,303);
  assert.equal(await consent.publicKey,appKey);
  const first = consent.expectAuthorization(url);
  assert.match((await request(consent,consent.path)).body,/Continue to Dropbox/);
  assert.equal((await request(consent,consent.path+'/authorize')).headers.Location,url.href);
  const callback = '/?state='+state+'&code=fictional-code';
  assert.equal((await request(consent,callback,{headers:{'user-agent':'csvTV-release-check'}})).handled,false);
  assert.equal((await request(consent,'/?state=unrelated&code=fictional-code')).status,400);
  assert.equal((await request(consent,callback)).headers.Location,consent.path);
  assert.deepEqual(await first,{state,code:'fictional-code'});
  assert.equal((await request(consent,callback)).status,400);
  const secondState = 'T'.repeat(43), second = consent.expectAuthorization(authorize(secondState));
  assert.match((await request(consent,consent.path)).body,/same Dropbox account/);
  await request(consent,'/?state='+secondState+'&code=fictional-second-code');
  assert.deepEqual(await second,{state:secondState,code:'fictional-second-code'});
  consent.markDone(true);
  assert.match((await request(consent,consent.path)).body,/test finished/);
  consent.close();
});

test('The handoff validates the registration, redirect, PKCE and permissions and discards refused authorizations', async () => {
  const consent = createReleaseConsent(origin,appKey);
  assert.equal((await request(consent,consent.path,{headers:{host:'outside.test'}})).status,403);
  for (const [name,value] of [['redirect_uri',origin+'/other'],['client_id','different-registration'],['code_challenge_method','plain'],
    ['scope','account_info.read files.content.read files.content.write'],['state','short']]) {
    const url = authorize();
    url.searchParams.set(name,value);
    assert.throws(()=>consent.expectAuthorization(url),/unexpected/);
  }
  const skipped = consent.expectAuthorization(authorize());
  const rejected = assert.rejects(skipped,/declined/);
  await request(consent,'/?state='+state+'&error=access_denied');
  await rejected;
  const stale = consent.expectAuthorization(authorize('T'.repeat(43)));
  const stopped = assert.rejects(stale,/closed/);
  consent.close();
  await stopped;
});

test('The local import form verifies its masked TMDB token before offering authorization', async () => {
  let calls = 0;
  const consent = createReleaseConsent(origin,appKey,{acceptTmdb:async token => {
    calls++; return token==='fictional-approved-token';
  }});
  try {
    const initial = await request(consent,consent.path);
    assert.match(initial.body,/name="tmdb" type="password"/);
    assert.throws(()=>consent.expectAuthorization(authorize()),/unavailable/);
    const submit = value => request(consent,consent.path+'/key',{method:'POST',body:new URLSearchParams({tmdb:value}).toString(),
      headers:{origin,'content-type':'application/x-www-form-urlencoded'}});
    const refused = await submit('fictional-refused-token');
    assert.equal(refused.status,400);
    assert.ok(!refused.body.includes('fictional-refused-token'));
    assert.equal((await submit('fictional-approved-token')).status,303);
    assert.equal(await consent.publicKey,appKey);
    assert.equal(calls,2);
    assert.ok(!(await request(consent,consent.path)).body.includes('fictional-approved-token'));
  } finally { consent.close(); }
});
