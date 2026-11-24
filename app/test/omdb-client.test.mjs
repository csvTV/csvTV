import assert from 'node:assert/strict';
import test from 'node:test';
import {OmdbClient, OmdbError} from '../src/omdb-client.ts';

test('OMDb suppresses conflicting scores for distinct identified titles at one position',async()=>{
  const row=(episode,id,score)=>({Episode:String(episode),imdbID:'tt'+String(id).padStart(7,'0'),imdbRating:score});
  const episodes=[
    row(1,20,'7.50'),row(1,21,'6.8'),row(1,20,'7.50'),
    row(2,22,'7.1'),row(2,22,'7.6'),
    row(3,23,'07.50'),row(3,24,'7.5'),
    row(4,25,'7.0000000000000001'),row(4,26,'7.0000000000000002'),
    row(5,27,'7.2'),row(5,28,'6.0'),row(5,28,'7.20'),
    row(6,29,'8.2'),{Episode:'6',imdbID:'tt29',imdbRating:'8.7'},
  ];
  for(const values of [episodes,[...episodes].sort((a,b)=>a.imdbID.localeCompare(b.imdbID))]){
    const client=new OmdbClient({fetch:async()=>Response.json({Response:'True',Season:'1',Episodes:values})});
    const actual=(await client.lookup('tt0000001',1,'fictional')).episodes;
    assert.deepEqual([...actual].sort(([a],[b])=>a-b),[[2,7.6],[3,7.5],[5,7.2],[6,8.7]]);
  }
});

test('OMDb rejects partial seasons and malformed UTF-8 separately from a disconnected stream',async () => {
  const season = {Response:'True', Season:'1', Episodes:[]};
  const stream = new ReadableStream({start(controller) {controller.error(new TypeError('network failed'));}});
  for (const [response,kind] of [
    [Response.json(season,{status:206}),'invalid-response'],
    [new Response(Uint8Array.of(0xff)),'invalid-response'],
    [new Response(Uint8Array.of(0xe2,0x82)),'invalid-response'],
    [new Response(stream),'unreachable'],
  ]) {
    const client = new OmdbClient({fetch:async()=>response});
    await assert.rejects(client.lookup('tt0000001',1,'fictional'),{kind});
  }
});

test('OMDb uses encoded headerless GETs and resolves missing, repeated and unavailable episode ratings', async () => {
  const key = 'fictional &/# key', urls = [];
  const client = new OmdbClient({fetch:async (url,init) => {
    urls.push(url);
    assert.equal(url.origin,'https://www.omdbapi.com');
    assert.equal(url.searchParams.get('apikey'),key);
    assert.equal(init.method,'GET'); assert.equal(init.credentials,'omit'); assert.equal(init.redirect,'error');
    assert.equal(init.referrerPolicy,'no-referrer'); assert.equal(init.cache,'no-store');
    assert.deepEqual([...new Headers(init.headers)],[]);
    if (!url.searchParams.has('Season')) return Response.json({Response:'True',Type:'series',imdbID:'tt0000123',imdbRating:'8.1'});
    return Response.json({Response:'True', Season:'0', Episodes:[{Episode:'2',imdbRating:'9.1'},
      {Episode:'2',imdbRating:'N/A'}, {Episode:'1',imdbRating:'7.1'}, {Episode:'1',imdbRating:'7.7'}]});
  }});
  assert.equal((await client.lookup('tt0000123',null,key)).rating,8.1);
  assert.deepEqual([...(await client.lookup('tt0000123',0,key)).episodes],[[1,7.7]]);
  assert.equal(urls[1].searchParams.get('Season'),'0');
  await assert.rejects(client.lookup('tt0000123/unsafe',1,key),{kind:'invalid-response'});
  assert.equal(urls.length,2);
});

test('A fractional OMDb position cannot round onto a real season or displace its episode score', async () => {
  let season = '1.0';
  const client = new OmdbClient({fetch:async()=>Response.json({Response:'True',Season:season,Episodes:[
    {Episode:'1.00',imdbRating:'7.5'},{Episode:'1.00000000000000001',imdbRating:'9.2'},
    {Episode:'2',imdbRating:'10.00000000000000001'}, {Episode:'3',imdbRating:'10.00'},
  ]})});
  assert.deepEqual([...(await client.lookup('tt0000123',1,'fictional')).episodes], [[1,7.5],[3,10]]);
  season = '1.00000000000000001';
  await assert.rejects(client.lookup('tt0000123',1,'fictional'), {kind:'invalid-response'});
});

test('Live-shaped OMDb misses and refusals remain distinguishable, and arbitrary errors cannot echo credentials',async () => {
  for (const Error of ['Incorrect IMDb ID.','Movie not found!', 'Series or season not found!']) {
    const client = new OmdbClient({fetch:async()=>Response.json({Response:'False',Error})});
    assert.equal((await client.lookup('tt0000001',null,'fictional')).rating,null);
  }
  for (const [message,status] of [['Invalid API key!',401],['Request limit reached!',200],['unknown URL with fictional-secret',403]]) {
    const client = new OmdbClient({fetch:async()=>Response.json({Response:'False',Error:message},{status})});
    await assert.rejects(client.lookup('tt0000001',null,'fictional-secret'), error => error instanceof OmdbError &&
      error.kind === 'refused' && !error.message.includes('fictional') && (message.includes('fictional') || error.message === message));
  }
  const wrong = new OmdbClient({fetch:async()=>Response.json({Response:'True',Type:'series',imdbID:'tt0000999',imdbRating:'8'})});
  await assert.rejects(wrong.lookup('tt0000001',null,'fictional'),{kind:'invalid-response'});
});

test('OMDb retries individual server failures and enforces inactivity and a shared quota deadline',async () => {
  const sleeps = []; let calls = 0;
  const client = new OmdbClient({fetch:async()=>{calls++;return new Response(null,{status:503});},sleep:async n=>sleeps.push(n)});
  await assert.rejects(client.lookup('tt0000001',null,'fictional'),{kind:'unreachable'});
  assert.deepEqual(sleeps,[1000,2000,4000,8000]); assert.equal(calls,5);
  const limited = new OmdbClient({now:()=>5000,fetch:async()=>new Response(null,{status:429,headers:{'Retry-After':'30'}})});
  await assert.rejects(limited.lookup('tt0000001',null,'fictional'),{kind:'throttled',retryAt:35000});
  const maintenance = new OmdbClient({now:()=>5000,sleep:assert.fail,fetch:async()=>new Response(null,{status:503,
    headers:{'Retry-After':new Date(65000).toUTCString(),'X-RateLimit-Reset':'9999'}})});
  await assert.rejects(maintenance.lookup('tt0000001',null,'fictional'),{kind:'throttled',retryAt:65000});
  const elapsed = new OmdbClient({now:()=>5000,fetch:async()=>new Response(null,{status:429,
    headers:{'Retry-After':new Date(1000).toUTCString(),'X-RateLimit-Reset':'4'}})});
  await assert.rejects(elapsed.lookup('tt0000001',null,'fictional'),{kind:'throttled', retryAt:undefined});
  const stalled = new OmdbClient({inactivityMs:20,fetch:()=>new Promise(()=>{})});
  await assert.rejects(stalled.lookup('tt0000001',null,'fictional'),{kind:'unreachable'});
});

test('An obsolete OMDb lookup releases its queue immediately after a server error', async () => {
  let current = true;
  const waits = [];
  const client = new OmdbClient({
    fetch: async () => { current = false; return new Response(null, {status:503}); },
    sleep: async delay => { waits.push(delay); },
  });
  await assert.rejects(client.lookup('tt0000001', 1, 'fictional', async () => current), {kind:'superseded'});
  assert.deepEqual(waits, []);
});
