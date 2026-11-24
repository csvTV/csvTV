import assert from 'node:assert/strict';
import test from 'node:test';
import { readAniListArchive } from '../src/anilist-archive.ts';
import { fetchAniListMapping, readAniListMapping } from '../src/anilist-mapping.ts';
import { fetchProviderJson } from '../src/provider-http.ts';

const file = data => new Blob([JSON.stringify(data)]);
const entry = (series_id, extra) => ({series_type:0, series_id, progress:1, repeat:0, status:2, score:70, ...extra});
const row = (anilist_id, tv, extra) => ({anilist_id, themoviedb_id:{tv}, ...extra});

test('The mapping request bounds streamed bytes and catalog rows before matching', async () => {
  const url = new URL('https://example.test/mapping.json');
  const read = (maxBytes,headers) => fetchProviderJson(url,{},async () => new Response('[]',{headers}),
    1_000,() => false,kind => Error(kind),maxBytes);
  assert.deepEqual((await read(2,{})).value,[]);
  await assert.rejects(read(1,{}), /invalid-response/);
  await assert.rejects(read(1,{'Content-Length':'1'}), /invalid-response/);
  await assert.rejects(fetchAniListMapping(new Set([1]),undefined,async () =>
    new Response(JSON.stringify([row(1,5)]),{headers:{'Content-Length':String(16 * 1024 * 1024 + 1)}})), /could not be read/);
  const rows = Array(100_000).fill(row(1,5));
  assert.equal(readAniListMapping(rows,new Set([1])).get(1).showId,5);
  rows.push(row(2,9));
  assert.throws(() => readAniListMapping(rows,new Set([1])), /could not be read/);
});

test('AniList JSON retains only valid anime fields and type-1 favourites, with unique entries', async () => {
  const original = entry(3, {score:77.5, status:17, notes:'private note'});
  const parsed = await readAniListArchive(file({user:{name:'private name'}, lists:[
    original, original, entry(4, {series_type:1}), entry(3.5), entry(5, {progress:-1}),
    entry(6, {repeat:Number.MAX_SAFE_INTEGER}), entry(7), entry(7, {status:1}), entry(8, {score:0}),
  ], favourites:[{favourite_id:3, favourite_type:1}, {favourite_id:8, favourite_type:2}]}));
  assert.deepEqual(parsed.entries, [{id:3, score:77.5, status:17, progress:1, repeat:0}, {id:8, score:0, status:2, progress:1, repeat:0}]);
  assert.deepEqual([...parsed.favourites], [3]);
  assert.equal(parsed.notices.length, 4);
  assert.ok(parsed.notices.every(item => item.kind === 'invalid' && !item.anilistId));
  assert.ok(!JSON.stringify(parsed).includes('private'));
});

test('An unreadable file or missing lists fails before import; an empty list is readable', async () => {
  for (const blob of [new Blob(['{']), new Blob([new Uint8Array([0xff])]), file({}), file({lists:'private details'}), file([])]) {
    await assert.rejects(readAniListArchive(blob), /Could not read the AniList export/);
  }
  assert.deepEqual((await readAniListArchive(file({lists:[]}))).entries, []);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(readAniListArchive(file({lists:[]}), controller.signal), {name:'AbortError'});
});

test('An unreadable list or favourite type is reported while known non-anime types stay out of preview', async () => {
  const parsed = await readAniListArchive(file({lists:[entry(1),entry(2,{series_type:1}),{},entry(3,{series_type:'0'})],
    favourites:[{favourite_type:1,favourite_id:1},{favourite_type:2},null,{favourite_type:1,favourite_id:-2}]}));
  assert.deepEqual(parsed.entries.map(e => e.id),[1]);
  assert.deepEqual([...parsed.favourites],[1]);
  assert.deepEqual(parsed.notices.slice(0,2).map(n => n.text.match(/^List entry \d+/)[0]),['List entry 3','List entry 4']);
  assert.deepEqual(parsed.notices.slice(2).map(n => n.text),['Favorite entries skipped because of an invalid type or ID: 2.']);
});

test('Mapping keeps selected safe IDs, numeric TMDB seasons and offsets, films, and contradictory records', () => {
  const list = [
    {mal_id:9}, row(1, 12, {season:{tmdb:0}, episode_offset:{tmdb:0}}), row(2, 14, {season:{tmdb:'1'},episode_offset:{tmdb:-1}}),
    {anilist_id:3, themoviedb_id:{movie:[89,90]}}, row(4, 15), row(4, 16), {anilist_id:5}, row(6, 22),
    {anilist_id:7, themoviedb_id:{tv:31, movie:[90]}},
  ];
  const map = readAniListMapping(list, new Set([1,2,3,4,5,7]));
  assert.deepEqual(map.get(1), {kind:'show',showId:12,season:0,offset:0});
  assert.deepEqual(map.get(2), {kind:'show',showId:14,season:null,offset:null,uncertainPlacement:'invalid-position'});
  assert.equal(map.get(3).kind, 'film');
  assert.equal(map.get(4).kind, 'ambiguous');
  assert.equal(map.get(5).kind, 'unmapped');
  assert.ok(!map.has(6));
  assert.equal(map.get(7).kind, 'ambiguous');
  assert.equal(readAniListMapping(list, new Set([207])).size, 0);
});

test('Unmapped format labels require consistent public types and never change placement', () => {
  const rows = [
    {anilist_id:1,type:'SPECIAL'}, {anilist_id:1,type:'SPECIAL'}, {anilist_id:2,type:'TV'},
    {anilist_id:3,type:'OVA'}, {anilist_id:4,type:'ONA'}, {anilist_id:5,type:'UNKNOWN'},
    {anilist_id:6,type:'TV'}, {anilist_id:6,type:'SPECIAL'}, {anilist_id:6,type:'TV'},
    {anilist_id:7,type:'SPECIAL'}, {anilist_id:7}, {anilist_id:8,type:'OVA',themoviedb_id:{tv:12}},
    {anilist_id:9,type:'TV',themoviedb_id:{movie:22}}, {anilist_id:10,type:'<b>TV</b>'},
  ];
  const ids = new Set(rows.map(r=>r.anilist_id));
  for (const input of [rows, [...rows].reverse()]) {
    const map = readAniListMapping(input,ids);
    assert.deepEqual([...ids].map(id=>map.get(id).format),
      ['Special','TV series','OVA','ONA',undefined,undefined,undefined,undefined,undefined,undefined]);
    assert.equal(map.get(6).kind,'unmapped');
    assert.equal(map.get(8).kind,'show');
    assert.equal(map.get(9).kind,'film');
  }
});

test('Mapping duplicates compare the effective episode placement, including specials with no offset', () => {
  const first = row(1, 12, {season:{tmdb:2}});
  const zero = {...first, episode_offset:{tmdb:0}};
  const whole = row(2, 12);
  const special = row(3, 12, {season:{tmdb:0}});
  const rows = [first,zero,whole,{...whole,episode_offset:{tmdb:8}},special,{...special,episode_offset:{tmdb:0}}];
  for (const input of [rows,rows.toReversed()]) {
    const result = readAniListMapping(input,new Set([1,2,3]));
    assert.deepEqual(result.get(1), {kind:'show',showId:12,season:2,offset:0});
    assert.deepEqual(result.get(2), {kind:'show',showId:12,season:null,offset:null,uncertainPlacement:'regular-sibling'});
    assert.equal(result.get(3).kind, 'ambiguous');
  }
});

test('Only a distinct regular AniList entry on the same TV show makes a seasonless placement uncertain', () => {
  const first = row(1,10,{type:'TV'});
  const extras = [row(2,10,{type:'SPECIAL'}), row(3,10,{type:'OVA',season:{tmdb:0}}),
    row(4,10,{type:'TV',season:{tmdb:0}}), row(5,12,{type:'ONA'}),
    {anilist_id:6,type:'TV',themoviedb_id:{tv:10,movie:[9]}}];
  for (const sample of [[first,...extras,first],[first,...extras.toReversed(),first]]) {
    const selected = readAniListMapping(sample,new Set([1,2]));
    assert.equal(selected.get(1).uncertainPlacement,undefined);
    assert.equal(selected.get(2).uncertainPlacement,'unanchored-supplement');
    for (const rows of [[...sample,row(7,10,{type:'ONA',season:{tmdb:2}})], [row(7,10,{type:'TV'}),...sample]]) {
      assert.equal(readAniListMapping(rows,new Set([1])).get(1).uncertainPlacement,'regular-sibling');
    }
  }
  const invalid = readAniListMapping([row(8,16,{season:{tmdb:1},episode_offset:{tmdb:-3}})],new Set([8]));
  assert.equal(invalid.get(8).uncertainPlacement,'invalid-position');
  const malformed = readAniListMapping([row(9,19,{season:2}),row(10,20,{season:{tmdb:3},episode_offset:4})],new Set([9,10]));
  assert.deepEqual([...malformed.values()].map(m => m.uncertainPlacement),['invalid-position','invalid-position']);
});

test('A canceled public mapping request exits the GitHub queue before reading the retired device', async () => {
  const reading = Promise.withResolvers(), release = Promise.withResolvers();
  const token = new AbortController();
  let reads = 0;
  const store = {async mappingGate() {
    reads++;
    if (reads > 1) throw Error('The owner already closed this store');
    reading.resolve();
    await release.promise;
    return {epoch:0n,until:0};
  }};
  const first = fetchAniListMapping(new Set([1]),undefined,async () => Response.json([row(1,3)]),{store});
  await reading.promise;
  const second = fetchAniListMapping(new Set([1]),token.signal,async () => assert.fail('Canceled request reached GitHub'),{store});
  token.abort();
  release.resolve();
  await first;
  await assert.rejects(second,{name:'AbortError'});
  assert.equal(reads,1);
});

test('Only the fixed public mapping URL receives a GET, without credentials, search IDs or referrer', async () => {
  const inputs = [];
  const mapping = await fetchAniListMapping(new Set([17]), undefined, async (url, init) => {
    inputs.push(String(url));
    assert.equal(init.method, 'GET');
    assert.equal(init.headers, undefined);
    assert.equal(init.body, undefined);
    assert.equal(init.credentials, 'omit');
    assert.equal(init.referrerPolicy, 'no-referrer');
    assert.equal(init.redirect, 'error');
    assert.equal(init.cache, 'no-store');
    return new Response(JSON.stringify([row(17, 44)]), {headers:{'content-type':'text/plain'}});
  });
  assert.deepEqual(inputs, ['https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-mini.json']);
  assert.equal(mapping.get(17).showId, 44);
});

test('A malformed, partial, refused or canceled map fails without returning the response text', async () => {
  for (const response of [new Response('private response', {status:403}), new Response('private response'),
    Response.json({error:'private response'}), Response.json([{}]), Response.json([]),
    Response.json([row(1,2), null]), Response.json([row(1,2)], {status:206})]) {
    await assert.rejects(fetchAniListMapping(new Set([1]), undefined, async () => response), e =>
      e.message.includes('mapping file') && !e.message.includes('private response'));
  }
  const started = Promise.withResolvers();
  const controller = new AbortController();
  const pending = fetchAniListMapping(new Set([1]), controller.signal, (_url, init) => {
    started.resolve(init.signal);
    return new Promise(() => {});
  });
  const signal = await started.promise;
  controller.abort();
  await assert.rejects(pending, {name:'AbortError'});
  assert.equal(signal.aborted, true);
});

test('a transient file-host failure retries with bounded backoff and respects canceled imports', async () => {
  let until = 0;
  const store = {mappingGate:async()=>({epoch:0n,until}),saveMappingGate:async (_epoch,deadline)=>{until=deadline;}};
  await assert.rejects(fetchAniListMapping(new Set([1]),undefined,async()=>new Response(null,{status:503,
    headers:{'Retry-After':'90','X-RateLimit-Reset':'9999'}}),{store,now:()=>1000,sleep:assert.fail}),/Try again after/);
  assert.equal(until,91000);
  const ids = new Set([1]), waits = [];
  let calls = 0;
  const broken = async () => { calls++; return new Response(null,{status:503}); };
  await assert.rejects(fetchAniListMapping(ids,undefined,broken,{sleep:async ms=>waits.push(ms)}),/503/);
  assert.deepEqual(waits,[1000,2000,4000,8000]);
  assert.equal(calls,5);
  const recovered = await fetchAniListMapping(ids,undefined,async () => ++calls === 6 ?
    new Response(null,{status:502}) : Response.json([row(1,3)]),{sleep:async()=>{}});
  assert.equal(recovered.get(1).showId,3);
  const controller = new AbortController(), reached = Promise.withResolvers();
  const request = fetchAniListMapping(ids,controller.signal,async () => {reached.resolve();return await broken();});
  await reached.promise; controller.abort();
  await assert.rejects(request,{name:'AbortError'});
  assert.equal(calls,8);
});

test('anonymous GitHub limits serialize imports and admit one probe, preserving its failure or success', async () => {
  let until = 0, now = 10_000, calls = 0;
  const store = {mappingGate:async()=>({epoch:0n,until}),saveMappingGate:async (_epoch,deadline)=>{until=deadline;}};
  const ids = new Set([1]);
  let response = () => new Response('Secondary rate limit exceeded',{status:403,
    headers:{'X-RateLimit-Remaining':'240','X-RateLimit-Reset':'9999'}});
  const load = () => fetchAniListMapping(ids,undefined,async()=>{calls++;return response();},{now:()=>now,store});
  await Promise.all([assert.rejects(load(),/limiting/),assert.rejects(load(),/limiting/)]);
  assert.deepEqual([calls,until],[1,70_000]);
  now = until;
  response = () => new Response(null,{status:429,headers:{'Retry-After':'120'}});
  await assert.rejects(load(),/limiting/);
  assert.deepEqual([calls,until],[2,190_000]);
  now = until;
  response = () => {throw TypeError('unreachable');};
  await Promise.all([assert.rejects(load(),/connection/),assert.rejects(load(),/limiting/)]);
  assert.deepEqual([calls,until],[3,250_000]);
  now = until;
  response = () => Response.json([row(1,22)]);
  assert.equal((await load()).get(1).showId,22);
  assert.deepEqual([calls,until],[4,0]);
});
