import test from 'node:test';
import assert from 'node:assert/strict';
import { MdbListClient } from '../dist/mdblist-client.js';

const key = 'fictional +&/=? key';
const current = async () => true;
const show = (id, ratings) => ({ ids: { tmdb: id }, type: 'show', ratings });
const json = (value, status = 200, headers) => Response.json(value, { status, headers });
const clientFor = send => new MdbListClient({ fetch: send });

test('The MDBList lookup percent-encodes its key and keeps critic zeroes, missing entries and source scales distinct', async () => {
  const client = clientFor(async (url, init) => {
    assert.equal(url.origin + url.pathname, 'https://api.mdblist.com/tmdb/show/1');
    assert.equal(url.searchParams.get('apikey'), key);
    const request = new Request(url, init);
    assert.deepEqual([...request.headers], []);
    assert.equal(request.method, 'GET');
    assert.equal(request.cache, 'no-store');
    assert.equal(request.redirect, 'error');
    assert.equal(request.credentials, 'omit');
    return json(show(1, [{ source: 'audience', value: 99 }, { source: 'tomatoes', value: 0 },
      { source: 'metacritic', value: null }, { source: 'myanimelist', value: 8.2 }]));
  });
  assert.deepEqual(await client.lookup(1, key, current), { tomatoes: 0, metacritic: null, myanimelist: 8.2 });
});

test('The individual show lookup uses a headerless GET and safely distinguishes misses, access failures and invalid responses', async () => {
  let response;
  const client = clientFor(async (url, init) => {
    assert.equal(url.pathname, '/tmdb/show/10');
    const req = new Request(url, init);
    assert.equal(req.method, 'GET');
    assert.deepEqual([...req.headers], []);
    return response;
  });
  const get = () => client.lookup(10, key, current);
  response = json({ error: 'Not found' }, 404);
  assert.equal((await get()).metacritic, null);
  response = json({ error: 'Invalid API key' }, 401);
  await assert.rejects(get(), { kind: 'refused', message: 'Invalid API key' });
  response = json({ error: 'https://api.mdblist.com/?apikey=' + encodeURIComponent(key) }, 403);
  await assert.rejects(get(), { kind: 'refused', message: 'MDBList refused the request.' });
  response = json(show(99, []));
  await assert.rejects(get(), { kind: 'invalid-response' });
  response = json({ ids: { tmdb: 10 }, ratings: 'broken' });
  await assert.rejects(get(), { kind: 'invalid-response' });
  response = json(show(10, [{ source: 'tomatoes', value: 128 }, { source: 'metacritic', value: 51.7 }]));
  assert.deepEqual((await get()), { tomatoes: null, metacritic: null, myanimelist: null });
});

test('MDBList waits for the longest provider deadline, including next UTC midnight and the unnamed quota window', async () => {
  const now = Date.UTC(2026, 10, 18, 20, 0, 0);
  const midnight = Date.UTC(2026, 10, 19);
  let response;
  const client = new MdbListClient({ fetch: async () => response, now: () => now });
  for (const [data, headers, until] of [
    [{ error: 'Daily request limit exceeded' }, { 'Retry-After': '120' }, midnight],
    [{}, { 'X-RateLimit-Remaining': '0' }, midnight],
    [{}, { 'X-RateLimit-Remaining': '000' }, midnight],
    [{}, { 'X-RateLimit-Remaining': '0042', 'X-RateLimit-Reset': String(midnight / 1000) }, now + 300_000],
    [{ error: 'Five-minute limit reached' }, { 'X-RateLimit-Remaining': '42',
      'X-RateLimit-Reset': String(midnight / 1000) }, now + 300_000],
    [{ limit_type: 'daily' }, { 'X-RateLimit-Reset': String((midnight + 10_000) / 1000) }, midnight + 10_000],
    [{ error: 'Rate limit exceeded' }, {}, now + 300_000],
    [{ error: 'Five-minute limit reached' }, { 'Retry-After': new Date(now + 540_000).toUTCString() }, now + 540_000],
  ]) {
    response = json(data, 429, headers);
    await assert.rejects(client.lookup(2, key, current), { kind: 'throttled', retryAt: until });
  }
});

test('MDBList caps 5xx retries and rechecks the credential and visibility before every send', async () => {
  const maintenance = new MdbListClient({now:()=>1000,sleep:assert.fail,
    fetch:async()=>json({},503,{'Retry-After':'90','X-RateLimit-Remaining':'0','X-RateLimit-Reset':'9999'})});
  await assert.rejects(maintenance.lookup(1,key,current),{kind:'throttled',retryAt:91000});
  const waits = [];
  let calls = 0, active = true;
  const client = new MdbListClient({ fetch: async () => { calls++; return json({}, 503); }, sleep: async ms => {
    waits.push(ms); if (calls > 5) active = false;
  } });
  await assert.rejects(client.lookup(1, key, current), { kind: 'unreachable' });
  assert.equal(calls, 5);
  assert.deepEqual(waits, [1000, 2000, 4000, 8000]);
  await assert.rejects(client.lookup(1, key, async () => active), { kind: 'superseded' });
  assert.equal(calls, 6);
});

test('A stalled MDBList body aborts without exposing its URL', async () => {
  let signal;
  const client = new MdbListClient({ fetch: async (_url, init) => {
    signal = init.signal;
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); } }));
  }, inactivityMs: 20 });
  await assert.rejects(client.lookup(4, key, current), { kind: 'unreachable', message: 'Cannot reach MDBList.' });
  assert.equal(signal.aborted, true);
});
