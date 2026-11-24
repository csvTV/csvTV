import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchProviderJson } from '../src/provider-http.ts';
import { GithubRatingsClient } from '../src/github-ratings-client.ts';

// Keep the response open. The transport can explicitly release the body even if
// a fetch adapter does not connect its returned stream to the request signal.
function openResponse(status, bytes, headers = {}) {
  let cancellations = 0;
  const body = new ReadableStream({
    start(controller) { if (bytes) controller.enqueue(bytes); },
    cancel() { cancellations++; return new Promise(() => {}); },
  });
  return {response:new Response(body,{status,headers}), cancellations:() => cancellations};
}

const sample = new URL('https://fixture.invalid/lookup');
const read = (witness, init = {}) => fetchProviderJson(sample,init,async () => witness.response,
  1000,status => status === 400,kind => Error(kind),4);

test('The JSON provider reader releases unread partial, malformed, oversized and skipped replies', async () => {
  const malformed = Uint8Array.of(0xff), oversized = new Uint8Array(5);
  for (const [status,bytes,headers,error] of [
    [206,null,{},true], [200,malformed,{},true], [400,malformed,{},false],
    [200,oversized,{},true], [400,oversized,{},false], [200,null,{'Content-Length':'5'},true],
    [400,null,{'Content-Length':'5'},false], [404,null,{},false],
  ]) {
    const witness = openResponse(status,bytes,headers);
    if (error) await assert.rejects(read(witness),{message:'invalid-response'});
    else assert.equal((await read(witness)).status,status);
    assert.equal(witness.cancellations(),1,`HTTP ${status} (${bytes?.length ?? 0} bytes)`);
    assert.equal(witness.response.body.locked,false);
  }
});

test('Canceling a JSON read releases its open body and preserves the caller’s abort reason', async () => {
  const witness = openResponse(200,Uint8Array.of(123));
  const controller = new AbortController();
  const pending = read(witness,{signal:controller.signal});
  await new Promise(resolve => setTimeout(resolve,0));
  controller.abort(new Error('Lookup no longer needed'));
  await assert.rejects(pending,{message:'Lookup no longer needed'});
  assert.equal(witness.cancellations(),1);
  assert.equal(witness.response.body.locked,false);
});

test('A response delivered after either provider transport timed out disposes its unread body', async () => {
  for (const provider of ['metadata','GitHub']) {
    const witness = openResponse(200);
    let deliver;
    const send = () => new Promise(resolve => { deliver = resolve; });
    const pending = provider === 'metadata'
      ? fetchProviderJson(sample,{},send,10,() => false,kind => Error(kind),16)
      : new GithubRatingsClient('imdb',async () => assert.fail('unexpected file'),{
          fetch:send, inactivityMs:10,
        }).download('sample-owner/ratings','fixture-credential');
    await assert.rejects(pending,provider === 'metadata' ? {message:'unreachable'} : {kind:'unreachable'});
    deliver(witness.response);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(witness.cancellations(),1,provider);
  }
});

test('The GitHub download releases skipped, size-limited and truncated error bodies', async () => {
  const max = 4 * 1024 * 1024;
  const rateLimit = new Uint8Array(16384);
  rateLimit.set(new TextEncoder().encode('secondary rate limit'));
  for (const [status,bytes,headers,kind] of [
    [206,null,{},'http'], [401,null,{},'refused'], [404,null,{},'http'], [429,null,{},'throttled'],
    [200,null,{'Content-Length':String(max+1)},'file-too-large'], [200,new Uint8Array(max+1),{},'file-too-large'],
    [403,new Uint8Array(16385),{},'http'], [403,rateLimit,{},'throttled'],
  ]) {
    const witness = openResponse(status,bytes,headers);
    const client = new GithubRatingsClient('mal',async () => assert.fail('no completed file'),{fetch:async () => witness.response});
    await assert.rejects(client.download('sample-owner/ratings','fixture-credential'),{kind});
    assert.equal(witness.cancellations(),1,`HTTP ${status} (${bytes?.length ?? 0} bytes)`);
    assert.equal(witness.response.body.locked,false);
  }
});
