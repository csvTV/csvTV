import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import { describeObservation, observeGrant } from './dropbox-live/probe.js';
import {openChromium,until} from './offline-chromium.mjs';
import {listen,stop} from './offline-site.mjs';
import {offlineProviders} from './offline-providers.mjs';

const issued = { status: 200, data: { access_token: 'fictional-access', expires_in: 14400 } };
const refused = { status: 400, data: { error: 'invalid_grant' } };

async function observe(requestedExpiry, replies, revokeResult = 'revoked') {
  const calls = [];
  const signOut = async () => { calls.push('sign out'); return revokeResult; };
  async function transport(request) {
    const form = new URLSearchParams(request.body);
    calls.push([request.endpoint, form.get('grant_type'), form.get('client_id'), form.get('refresh_token')]);
    const { status, data } = replies.shift();
    return { status, bytes: new TextEncoder().encode(JSON.stringify(data)) };
  }
  const result = await observeGrant('fictional-key', 'fictional-grant', requestedExpiry, signOut, transport);
  assert.equal(replies.length, 0);
  return { result, calls };
}

const refresh = ['token', 'refresh_token', 'fictional-key', 'fictional-grant'];

test('A grant already refused after its requested expiry cannot establish revocation', async () => {
  const { result, calls } = await observe(true, [refused]);
  assert.deepEqual(result, { renewal: 'refused', revocation: 'unverified' });
  assert.deepEqual(calls, [refresh, 'sign out']);
  assert.match(describeObservation('exchange', 'accepted'), /fresh sign-in succeeded.*two-minute/);
  assert.match(describeObservation('renewal', result.renewal), /refused the refresh token after the requested expiry/);
  assert.match(describeObservation('revocation', result.revocation, result.renewal), /already refused.*before sign-out/);
});

test('A separate seven-day grant must work before sign-out and fail with invalid_grant afterwards', async () => {
  const { result, calls } = await observe(false, [issued, refused]);
  assert.deepEqual(result, { renewal: 'skipped', revocation: 'passed' });
  assert.deepEqual(calls, [refresh, 'sign out', refresh]);
  assert.match(describeObservation('exchange', 'bounded'), /fresh sign-in succeeded with the required seven-day/);
  assert.equal(describeObservation('renewal', result.renewal), undefined);
  assert.match(describeObservation('revocation', result.revocation, result.renewal), /worked immediately before sign-out.*refused the same token immediately afterward/);
});

test('A grant still issuing valid access tokens after acknowledged revocation fails the revocation test', async () => {
  const { result, calls } = await observe(true, [issued, issued]);
  assert.deepEqual(result, { renewal: 'accepted', revocation: 'failed' });
  assert.deepEqual(calls, [refresh, 'sign out', refresh]);
  assert.match(describeObservation('revocation', result.revocation, result.renewal), /continued to accept.*after acknowledging sign-out/);
});

test('An empty success, client error or unacknowledged sign-out leaves revocation unverified', async () => {
  const missingToken = await observe(true, [{ status: 200, data: {} }]);
  assert.deepEqual(missingToken.result, { renewal: 'unverified', revocation: 'unverified' });
  assert.deepEqual(missingToken.calls, [refresh, 'sign out']);
  const clientError = await observe(false, [issued, { status: 400, data: { error: 'invalid_client' } }]);
  assert.equal(clientError.result.revocation, 'unverified');
  const offline = await observe(false, [issued], 'offline');
  assert.equal(offline.result.revocation, 'unverified');
  assert.deepEqual(offline.calls, [refresh, 'sign out']);
  assert.match(describeObservation('revocation', offline.result.revocation, offline.result.renewal), /could not be verified/);
});

test('the development consent page completes its public-key and revocation check with a fictional provider', {timeout:40000}, async t => {
  let report, browser, challenge, issued = 0, refused = 0, revoked = false;
  const profile = await mkdtemp(join(tmpdir(),'csvtv-probe-'));
  const server = createServer(async (req,res) => {
    const path = new URL(req.url,'http://localhost').pathname;
    if (path === '/key') { res.writeHead(200,{'Content-Type':'application/json'}).end('"fictional-probe-key"'); return; }
    if (path === '/report') {
      let data = '';
      for await (const chunk of req) data += chunk;
      report = JSON.parse(data);
      res.writeHead(204).end(); return;
    }
    const file = path === '/' ? './dropbox-live/index.html' : path === '/probe.js' ? './dropbox-live/probe.js'
      : /^\/dist\/[\w-]+\.js$/.test(path) ? '..'+path : null;
    if (!file) { res.writeHead(404).end(); return; }
    res.writeHead(200,{'Content-Type':path === '/' ? 'text/html' : 'text/javascript','Cache-Control':'no-store'});
    res.end(await readFile(new URL(file,import.meta.url)));
  });
  const origin = 'http://127.0.0.1:'+await listen(server), approval = 'https://www.dropbox.com/oauth2/authorize';
  t.after(async () => {
    try { await browser?.close(); await stop(server); }
    finally { await rm(profile,{recursive:true,force:true,maxRetries:6,retryDelay:150}); }
  });
  const cloud = offlineProviders(origin,form => {
    if (form.get('grant_type') === 'authorization_code') {
      assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'),challenge);
      assert.equal(form.get('code'),'fictional-probe-approval');
      issued++;
      return {account_id:'fictional-owner',access_token:'example-access',refresh_token:'example-refresh',expires_in:14400};
    }
    return {access_token:'example-access',expires_in:14400};
  });
  browser = await openChromium(profile,async (event,send) => {
    const url = new URL(event.request.url);
    if (url.origin+url.pathname === approval) {
      assert.equal(url.searchParams.get('client_id'),'fictional-probe-key');
      challenge = url.searchParams.get('code_challenge');
      const location = origin+'/?'+new URLSearchParams({state:url.searchParams.get('state'),code:'fictional-probe-approval'});
      return send('Fetch.fulfillRequest',{requestId:event.requestId,responseCode:302,responseHeaders:[{name:'Location',value:location}]});
    }
    if (event.request.method === 'POST' && url.pathname === '/2/auth/token/revoke') revoked = true;
    if (revoked && event.request.method === 'POST' && url.pathname === '/oauth2/token') {
      assert.equal(new URLSearchParams(event.request.postData).get('grant_type'),'refresh_token');
      refused++;
      return cloud.respond(event,(method,result)=>send(method,{...result,responseCode:400,body:Buffer.from('{"error":"invalid_grant"}').toString('base64')}));
    }
    return cloud.respond(event,send);
  },{dropboxReleaseCheck:true});
  await browser.navigate(origin+'/'); await browser.click('#revoke-only:enabled');
  await browser.waitFor('document.querySelector("#status")?.textContent.includes("Provider test finished.")');
  await until(()=>report,'the fictional grant report');
  assert.equal(await browser.evaluate('location.search'),'');
  assert.equal(issued,1); assert.equal(refused,1); assert.equal(revoked,true);
  assert.equal(report?.exchange,'bounded'); assert.equal(report.revocation,'passed');
  const redacted = await browser.evaluate('('+(async function () {
    const {openDeviceStore} = await import('/dist/storage.js');
    const s = await openDeviceStore({name:'csvTV-dropbox-provider-probe-attempts'});
    try { const {session,accountId} = await s.dropboxState(); return {session,accountId}; }
    finally { await s.closeForUpdate(); }
  }).toString()+')()');
  assert.equal(redacted.session,null); assert.equal(redacted.accountId,null);
});
