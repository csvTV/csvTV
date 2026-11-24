import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveTrakt } from '../src/trakt-placement.ts';
import { TmdbClient, TmdbError, tmdbResourceKey } from '../src/tmdb-client.ts';
import { TmdbService } from '../src/tmdb-service.ts';
import { planTraktImport } from '../src/trakt-preview.ts';
import { emptyTables } from '../src/model.ts';

const now = Date.now();
const ids = (values = {}) => ({ trakt: null, tmdb: null, tvdb: null, imdb: null, ...values });
const series = (values, name = 'Fictional Quay') => ({ title: name, ids: ids(values) });
const quay = series({ trakt: 1, tmdb: 30, imdb: 'tt0000030' });
const episode = (number, values, season = 1) => ({ title: 'Trakt ' + number, number, season, ids: ids(values) });
const plays = (episode, count = 1, show = quay) => Array.from({ length: count }, () => ({ episode, show }));
const archive = (values = {}) => ({ history: [], totals: [], ratings: [], favourites: [], watchlist: [], issues: [], ...values });
const show = (id = 30, seasons = [1], imdb = null) => ({ id, name: 'Quay ' + id, first_air_date: '2021-08-04',
  status: 'Ended', seasons: seasons.map(season_number => ({ season_number, episode_count: 4, name: 'Season ' + season_number })),
  keywords: { results: [] }, external_ids: { imdb_id: imdb } });
const season = (season_number, pairs) => ({ season_number, episodes: pairs.map(([episode_number, id]) =>
  ({ episode_number, id, name: 'TMDB ' + id, air_date: '2021-09-01' })) });
const find = (tv = [], eps = []) => ({ tv_results: tv.map(id => ({ id, name: 'Quay ' + id })),
  tv_episode_results: eps.map(([show_id, id, season_number, episode_number]) => ({ show_id, id, season_number, episode_number })) });

// Exercise the actual normalization, credential fence, and cache read path. A test fails immediately if
// matching attempts to write a personal row or persist a speculative cache entry.
function provider(t, endpoints) {
  const calls = [], cache = new Map(), state = { token: 'fictional-key', refused: null, generation: 1n, cooldown: null };
  const network = { online: true };
  const store = { role: 'writer', providerKeysAvailable:true, seasonOrderState:async () => ({}), tmdbState: async () => ({ ...state }), tmdbEntry: async key => cache.get(key),
    writeTmdb: async (_generation, changes) => {
      assert(changes.refused && !changes.entries);
      state.refused = changes.refused;
      return true;
    } };
  const client = { async request(resource, token, hooks) {
    const key = tmdbResourceKey(resource);
    assert.equal(token, state.token);
    assert(await hooks.current());
    calls.push(key);
    const response = endpoints.get(key);
    assert.notEqual(response, undefined, 'Unexpected TMDB call for ' + key);
    if (response instanceof Error) throw response;
    return typeof response === 'function' ? response() : response;
  } };
  const service = new TmdbService(store, client, { now: () => now, online: () => network.online, visible: () => true });
  t.after(() => service.close());
  return { service, cache, calls, state, network };
}
const showKey = id => tmdbResourceKey({ kind: 'show', id });
const seasonKey = (id, season) => tmdbResourceKey({ kind: 'season', id, season });

test('Trakt season adjustments on a continuous TMDB season retain native episode IDs and positions', async t => {
  const id = 237150, fictional = series({tmdb:id}), header = show(id);
  header.seasons[0].episode_count = 32;
  const episodes = Array.from({length:32},(_,i) => [i+1,9001+i]);
  const {service,calls} = provider(t,new Map([[showKey(id),header],[seasonKey(id,1),season(1,episodes)]]));
  const placement = await resolveTrakt(archive({history:plays(episode(1,{tmdb:9013},2),1,fictional),
    totals:[{show:fictional,plays:2}]}),service);
  await placement.prepareSeason(id,3);
  assert.deepEqual([...new Set(calls)],[showKey(id),seasonKey(id,1)]);
  const plan = planTraktImport(placement,{local:{},tables:emptyTables()},new Set(),new Map([[id,new Map([[2,1]])]]));
  assert.deepEqual(plan.countSeasons.get(id).map(s => [s.season,s.matchedEpisodes,s.airedEpisodes]),[[1,0,12],[2,1,12],[3,0,8]]);
  assert.deepEqual(plan.changes.put.watched.map(r => [r.season,r.episode,r.episode_id,r.times_watched]).sort((a,b)=>a[1]-b[1]),
    episodes.slice(12,24).map(([n,episodeId])=>[1,n,episodeId,n === 13 ? 2 : 1]));
});

test('A flagged show lists every season from its header before fetching only the manual season chosen', async t => {
  const endpoints = new Map([[showKey(30),show(30,[4,2,1,0])],
    [seasonKey(30,1),season(1,[[1,101]])], [seasonKey(30,2),season(2,[[1,201],[2,202]])]]);
  const {service, calls} = provider(t,endpoints);
  const placed = await resolveTrakt(archive({history:plays(episode(1,{tmdb:101}),2),
    totals:[{show:quay,plays:3}]}), service);
  const snapshot = {tables:emptyTables(),local:{}};
  function plan(extras = new Map()) {
    return planTraktImport(placed,snapshot,new Set(),extras,new Map([[30,2]]));
  }
  assert.deepEqual(plan().countSeasons.get(30).map(s => [s.season,s.matchedEpisodes,s.airedEpisodes]), [
    [0,0,null],[1,1,1],[2,0,null],[4,0,null],
  ]);
  assert.deepEqual(plan().watched.map(p=>p.after),[4]);
  assert.deepEqual(calls,[showKey(30),seasonKey(30,1)]);
  await placed.prepareSeason(30,2);
  await placed.prepareSeason(30,2);
  assert.deepEqual(calls,[showKey(30),seasonKey(30,1),seasonKey(30,2)]);
  const chosen = plan(new Map([[30,new Map([[2,3]])]]));
  assert.deepEqual(chosen.watched.map(p=>[p.row.episode_id,p.after]),[[101,4],[201,3],[202,3]]);
  assert.equal(chosen.countSeasons.get(30).find(s=>s.season===2).eligibleEpisodes,2);
  assert.deepEqual(plan().watched.map(p=>p.after),[4]);
});

test('A partial Trakt season uses aired TMDB rows for season passes and export identities for whole-show passes', async t => {
  const detail = season(1,[[1,101],[2,102],[3,103],[4,104]]);
  detail.episodes[2].air_date = null;
  detail.episodes[3].air_date = '2099-02-01';
  const {service,calls} = provider(t,new Map([[showKey(30),show(30,[1])],[seasonKey(30,1),detail]]));
  const placed = await resolveTrakt(archive({history:[...plays(episode(1,{tmdb:101}),2),
    ...plays(episode(3,{tmdb:103})),...plays(episode(4,{tmdb:104}))],totals:[{show:quay,plays:5}]}),service);
  const plan = (passes,whole) => planTraktImport(placed,{tables:emptyTables(),local:{}},new Set(),
    new Map([[30,new Map([[1,passes]])]]),new Map([[30,whole]]));
  const counts = p => [...p.watched].sort((a,b)=>a.row.episode-b.row.episode).map(p=>[p.row.episode,p.after]);
  assert.deepEqual(counts(plan(0,0)),[[1,2],[3,1],[4,1]]);
  assert.deepEqual(counts(plan(0,1)),[[1,3],[3,2],[4,2]]);
  const explicit = plan(6,1);
  assert.deepEqual(counts(explicit),[[1,9],[2,6],[3,2],[4,2]]);
  assert.equal(explicit.reviewShows[0].playDelta,15n);
  assert.deepEqual(counts(plan(-1,0)),[[1,1],[3,1],[4,1]]);
  assert.deepEqual(calls,[showKey(30),seasonKey(30,1)]);
});

test('A show total below detailed history enters count review without discarding an observed rewatch', async t => {
  const {service} = provider(t,new Map([[showKey(30),show(30,[1])],[seasonKey(30,1),season(1,[[1,101]])]]));
  const placed = await resolveTrakt(archive({history:plays(episode(1,{tmdb:101}),3),
    totals:[{show:quay,plays:1}]}),service);
  const state = {tables:emptyTables(),local:{}};
  const preview = planTraktImport(placed,state);
  assert.deepEqual(preview.counts.map(r=>[r.total,r.listedPlays,r.multiple]),[[1,3,null]]);
  assert.deepEqual(preview.changes.put.watched.map(r => r.times_watched),[3]);
  const adjusted = planTraktImport(placed,state,new Set(),new Map([[30,new Map([[1,-1]])]]));
  assert.deepEqual(adjusted.changes.put.watched.map(r => r.times_watched),[2]);
});
const findKey = (source, externalId) => tmdbResourceKey({ kind: 'find', source, externalId: String(externalId) });

function bundledProvider(t, numbers, adjust = () => {}) {
  let time = now;
  const calls = [], cache = new Map(), state = {token:'fictional', generation:1n, refused:null, cooldown:null};
  const store = {role:'writer', seasonOrderState:async () => ({}), tmdbState:async () => ({...state}), tmdbEntry:async key => cache.get(key),
    writeTmdb:async (_generation, change) => {
      assert(!change.entries, 'a preview must keep its metadata in memory');
      Object.assign(state, change); return true;
    }};
  const header = show(30, numbers);
  for (const row of header.seasons) { row.episode_count = 1; row.poster_path = null; }
  const direct = number => ({season_number:number, name:'Season ' + number, poster_path:null,
    episodes:[{show_id:30, season_number:number, episode_number:1, id:100 + number, name:'Episode ' + number}]});
  const client = new TmdbClient({now:() => time, sleep:async ms => {time += ms;}, fetch:async url => {
    if (url.pathname.includes('/season/')) {
      const number = Number(url.pathname.split('/').at(-1));
      calls.push(number);
      return Response.json(direct(number));
    }
    const parts = url.searchParams.get('append_to_response').split(',').filter(p => p.startsWith('season/'));
    calls.push(parts);
    const body = structuredClone(header);
    for (const part of parts) body[part] = direct(Number(part.slice(7)));
    return await adjust(body, parts) ?? Response.json(body);
  }});
  const service = new TmdbService(store, client, {now:() => time, online:() => true, visible:() => true});
  t.after(() => service.close());
  const input = archive({history:numbers.flatMap(n => plays(episode(1, {tmdb:100 + n}, n), 2))});
  return {service, cache, calls, state, input};
}

test('A cold preview groups six seasons at a time, preserves a vacated slot and reopens from canonical cache entries', async t => {
  const numbers = [0, 1, 2, 3, 4, 5, 6, 7], {service, calls, cache, input} = bundledProvider(t, numbers);
  cache.set(seasonKey(30, 0), {fetchedAt:0, value:null, vacatedPositions:[1]});
  const first = await resolveTrakt(input, service);
  assert.deepEqual(calls, [numbers.slice(0, 6).map(n => 'season/' + n), ['season/6', 'season/7']]);
  assert.deepEqual(first.watched.map(row => [row.episode_id, row.times_watched]), numbers.map(n => [100 + n, 2]));
  assert.deepEqual(first.cache.get(seasonKey(30, 0)).value.reusedPositions, [1]);
  assert.equal(cache.size, 1);
  assert.equal(first.cache.size, 9);
  for (const [key, entry] of first.cache) cache.set(key, entry);
  calls.length = 0;
  assert.deepEqual((await resolveTrakt(input, service)).watched, first.watched);
  assert.deepEqual(calls, []);
  cache.delete(seasonKey(30, 1)); cache.delete(seasonKey(30, 6));
  const partial = await resolveTrakt(input, service);
  assert.deepEqual(calls, [['season/1', 'season/6']]);
  assert.deepEqual(partial.watched, first.watched);
  assert.deepEqual([...partial.cache.keys()].sort(), [seasonKey(30, 1), seasonKey(30, 6)]);
});

test('An absent, truncated, misidentified or incompatible appended season uses only its own direct endpoint', async t => {
  const numbers = [1, 2, 3, 4, 5, 6];
  const {service, calls, input} = bundledProvider(t, numbers, (body, parts) => {
    if (!parts.length) return;
    delete body['season/2'];
    body['season/3'].episodes = [];
    body['season/4'].episodes[0].show_id = 999;
    delete body['season/5'].episodes[0].season_number;
    body['season/6'].poster_path = '/different.png';
  });
  const result = await resolveTrakt(input, service);
  assert.deepEqual(calls[0], numbers.map(n => 'season/' + n));
  // Direct fallbacks can run concurrently. Each missing or unusable season gets exactly one.
  assert.deepEqual(calls.slice(1).sort((a,b) => a-b), [2, 3, 4, 5, 6]);
  assert.deepEqual(result.watched.map(row => row.episode_id), numbers.map(n => 100 + n));
  assert.deepEqual(result.skipped, []);
});

test('A relocated Trakt episode searches remaining seasons in bounded groups, including missing or ambiguous identities', async t => {
  const numbers = Array.from({length:14}, (_,i) => i + 1);
  const {service, calls, cache} = bundledProvider(t, numbers, (body, parts) => {
    // Discover a duplicate of an earlier match. A missing part still needs its direct endpoint.
    if (parts.includes('season/6')) body['season/6'].episodes[0].id = 101;
    if (parts.includes('season/7')) delete body['season/7'];
  });
  const input = archive({history:[...plays(episode(1,{tmdb:101})),...plays(episode(2,{tmdb:114}),3),
    ...plays(episode(3,{tmdb:107}),2),...plays(episode(4,{tmdb:999}),4)]});
  const expectedCalls = [['season/1'],numbers.slice(1,7).map(n => 'season/'+n),
    numbers.slice(7,13).map(n => 'season/'+n),7,14];
  let originalSkipped;
  for (const history of [input.history, input.history.toReversed()]) {
    calls.length = 0;
    const placed = await resolveTrakt({...input,history}, service);
    assert.deepEqual(calls,expectedCalls);
    assert.deepEqual(placed.watched.map(r => [r.episode_id,r.season,r.times_watched]),[[107,7,2],[114,14,3]]);
    assert.equal(placed.skipped.length,2);
    assert.match(placed.skipped.join('\n'),/4 plays/);
    originalSkipped ??= placed.skipped;
    assert.deepEqual(placed.skipped,originalSkipped);
    assert.equal(placed.cache.size,15);
    assert.equal(cache.size,0);
  }
});

test('Both archive orders try the unique IMDb episode when later seasons invalidate an earlier TVDB match', async t => {
  const external = episode(1,{trakt:901,tvdb:401,imdb:'tt0000011'}), moved = episode(2,{trakt:902,tmdb:123});
  const history = [...plays(external,2),...plays(moved)];
  for (const rows of [history,history.toReversed()]) {
    const {service,calls} = provider(t,new Map([
      [showKey(30),show(30,[1,2])], [seasonKey(30,1),season(1,[[1,111],[2,112]])],
      [seasonKey(30,2),season(2,[[1,111],[2,123]])],
      [findKey('tvdb_id',401),find([],[[30,111,1,1]])],
      [findKey('imdb_id','tt0000011'),find([],[[30,112,1,2]])],
    ]));
    const placed = await resolveTrakt(archive({history:rows}),service);
    assert.deepEqual(placed.watched.map(r=>[r.season,r.episode_id,r.times_watched]),[[1,112,2],[2,123,1]]);
    assert.deepEqual(placed.skipped,[]);
    assert.equal(new Set(calls).size,calls.length,'A second identity check reuses completed requests.');
  }
});

test('Canceling or refusing a Trakt relocation batch stops later lookups and leaves cache and watches untouched', async t => {
  for (const cancel of [true,false]) {
    const controller = new AbortController(), numbers = Array.from({length:14}, (_,i) => i + 1);
    const {service,calls,cache} = bundledProvider(t,numbers,(_body,parts) => {
      if (!parts.includes('season/2')) return;
      if (cancel) controller.abort();
      else return new Response('',{status:401});
    });
    const input = archive({history:plays(episode(1,{tmdb:114}),3)});
    await assert.rejects(resolveTrakt(input,service,{signal:controller.signal}),
      error => error.kind === (cancel ? 'superseded' : 'refused'));
    assert.deepEqual(calls,[['season/1'],numbers.slice(1,7).map(n => 'season/'+n)]);
    assert.equal(cache.size,0);
  }
});

test('An unsupported show combination uses direct resources; refusal, cooldown and cancellation end matching', async t => {
  for (const status of [400, 404, 401, 403, 429]) {
    const {service, calls, state, input} = bundledProvider(t, [1], (_body, parts) => parts.length ?
      new Response(null, {status, headers:{'Retry-After':'120'}}) : undefined);
    if (status === 400 || status === 404) {
      assert.equal((await resolveTrakt(input, service)).watched[0].episode_id, 101);
      assert.deepEqual(calls, [['season/1'], [], 1]);
    } else {
      const expected = status === 401 ? 'refused' : status === 403 ? 'bad-request' : 'throttled';
      await assert.rejects(resolveTrakt(input, service), error => error.kind === expected);
      assert.deepEqual(calls, [['season/1']]);
      if (status === 401) assert(state.refused);
      if (status === 429) assert(state.cooldown.until > now);
    }
  }
  const abort = new AbortController();
  const {service, input, calls, cache} = bundledProvider(t, [1], () => {abort.abort();});
  await assert.rejects(resolveTrakt(input, service, {signal:abort.signal}), error => error.kind === 'superseded');
  assert.deepEqual(calls, [['season/1']]);
  assert.equal(cache.size, 0);
});

test('A long Trakt series fills ten lookup slots and reuses the first free slot while a slow season is pending', async t => {
  const numbers = Array.from({length: 14}, (_, i) => i + 1), unplayedSeason = 15;
  const gates = numbers.map(() => Promise.withResolvers());
  const endpoints = new Map([[showKey(30), show(30, [...numbers, unplayedSeason])]]);
  const started = [];
  let active = 0, peak = 0;
  for (const n of numbers) {
    endpoints.set(seasonKey(30, n), async () => {
      started.push(n);
      peak = Math.max(peak, ++active);
      try { await gates[n - 1].promise; return season(n, [[1, n]]); }
      finally { active--; }
    });
  }
  const {service, calls} = provider(t, endpoints);
  const lookup = resolveTrakt(archive({history:numbers.flatMap(n => plays(episode(1, {tmdb:n}, n), 2))}), service);
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(started, numbers.slice(0, 10));
    gates[1].resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(started, numbers.slice(0, 11));
    assert.equal(active, 10);
  } finally {
    for (const gate of gates) gate.resolve();
  }
  const result = await lookup;
  assert.equal(peak, 10);
  assert.equal(calls.length, 1 + numbers.length);
  assert.deepEqual(result.watched.map(r => [r.season, r.episode_id, r.times_watched]), numbers.map(n => [n, n, 2]));
  assert.deepEqual(result.skipped, []);
});

test('Canceling a busy Trakt lookup starts no remaining seasons and saves no speculative reads', async t => {
  const numbers = Array.from({length: 16}, (_, n) => n + 1);
  const resume = Promise.withResolvers();
  const endpoints = new Map([[showKey(30), show(30, numbers)]]);
  for (const n of numbers) endpoints.set(seasonKey(30, n), async () => { await resume.promise; return season(n, [[1, n]]); });
  const {service, calls, cache} = provider(t, endpoints);
  const controller = new AbortController();
  const lookup = resolveTrakt(archive({history:numbers.flatMap(n => plays(episode(1, {tmdb:n}, n)))}), service, {signal:controller.signal});
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.length, 11);
    controller.abort();
  } finally { resume.resolve(); }
  await assert.rejects(lookup, error => error.kind === 'superseded');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 11);
  assert.equal(cache.size, 0);
});

test('Trakt shares idle lookup slots between small archives while keeping the preferred external IDs and exact results', async t => {
  const endpoints = new Map(), history = [], waiting = [], expected = [];
  let active = 0, peak = 0, releaseRest = false;
  for (const id of [30,41]) {
    const ref = series({tmdb:id});
    endpoints.set(showKey(id),show(id));
    const episodes = [];
    for (let n = 1; n <= 14; n++) {
      const eid = id*100+n, external = id*1000+n;
      episodes.push([n,eid]);
      expected.push([id,n,eid,n % 3 ? 1 : 2]);
      const identifiers = {trakt:eid,tvdb:external,imdb:'tt'+(70000+eid)};
      if (n === 14) identifiers.tmdb = eid;
      history.push(...plays(episode(n,identifiers),n % 3 ? 1 : 2,ref));
      if (n === 14) continue;
      // Only the missing TVDB match needs the lower-priority IMDb request.
      if (n === 3) endpoints.set(findKey('imdb_id',identifiers.imdb),find([],[[id,eid,1,n]]));
      endpoints.set(findKey('tvdb_id',external),async () => {
        const gate = Promise.withResolvers();
        waiting.push(gate);
        peak = Math.max(peak,++active);
        try { if (!releaseRest) await gate.promise; return n === 3 ? find() : find([],[[id,eid,1,n]]); }
        finally { active--; }
      });
    }
    endpoints.set(seasonKey(id,1),season(1,episodes));
  }
  // Already matched titles in the same ZIP do not consume fallback slots.
  for (let id = 60; id < 75; id++) {
    const eid = id*100+1, ref = series({tmdb:id});
    endpoints.set(showKey(id),show(id));
    endpoints.set(seasonKey(id,1),season(1,[[1,eid]]));
    history.push(...plays(episode(1,{trakt:eid,tmdb:eid}),1,ref));
    expected.push([id,1,eid,1]);
  }
  const {service,calls} = provider(t,endpoints);
  const pending = resolveTrakt(archive({history:history.toReversed()}),service);
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(waiting.length,10);
    waiting[1].resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(waiting.length,11);
  } finally {
    releaseRest = true;
    for (const gate of [...waiting].reverse()) gate.resolve();
    await pending.catch(() => {});
  }
  const placed = await pending;
  assert.equal(peak,10);
  assert.equal(new Set(calls).size,calls.length);
  assert.deepEqual(placed.watched.map(r => [r.show_id,r.episode,r.episode_id,r.times_watched]),expected);
  assert.deepEqual(placed.skipped,[]);
});

test('Trakt relocation fallbacks withhold duplicate IDs across slow seasons and stop on cancellation, refusal or cooldown', async t => {
  for (const mode of ['normal','reverse','cancel','refused','throttled']) {
    const numbers = Array.from({length:17},(_,i) => i+1);
    const endpoints = new Map([[showKey(30),show(30,numbers)],[seasonKey(30,1),season(1,[[1,101]])]]);
    const gates = new Map(), controller = new AbortController();
    let active = 0, peak = 0, releaseRest = false;
    for (const n of numbers.slice(1)) endpoints.set(seasonKey(30,n),async () => {
      const gate = Promise.withResolvers();gates.set(n,gate);peak=Math.max(peak,++active);
      try { if (!releaseRest) await gate.promise;return season(n,[[1,n===15?101:100+n]]); }
      finally { active--; }
    });
    const {service,calls,cache} = provider(t,endpoints);
    const history = [...plays(episode(1,{trakt:11,tmdb:101})),...plays(episode(2,{trakt:22,tmdb:117}),2)];
    const pending = resolveTrakt(archive({history:mode==='reverse'?history.toReversed():history}),service,{signal:controller.signal})
      .then(value=>({value}),error=>({error}));
    await new Promise(resolve => setImmediate(resolve));
    const firstWave = [...gates.keys()];
    try {
      assert.deepEqual(firstWave,numbers.slice(1,11));
      if (mode === 'cancel') controller.abort();
      if (mode === 'refused' || mode === 'throttled') {
        gates.get(2).reject(new TmdbError(mode,undefined,mode==='throttled'?now+60000:undefined,mode==='throttled'?429:401));
        const {error} = await pending;
        assert.equal(error?.kind,mode);
      }
    } finally {
      releaseRest = true;
      for (const gate of [...gates.values()].reverse()) gate.resolve();
      await pending;
    }
    if (mode === 'normal' || mode === 'reverse') {
      const {value,error} = await pending;
      assert.ifError(error);
      assert.deepEqual(value.watched.map(r => [r.season,r.episode,r.episode_id,r.times_watched]),[[17,1,117,2]]);
      assert.equal(value.skipped.length,1);
      assert.match(value.skipped[0],/1×1.*1 play/);
      assert.equal(calls.length,1+numbers.length);
    } else {
      const {error} = await pending;
      assert.equal(error?.kind,mode === 'cancel'?'superseded':mode);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(calls.length,12);
    }
    assert.equal(peak,10);
    assert.equal(cache.size,0);
  }
});

test('failed or canceled preferred Trakt lookups stop the queued requests before trying any lower-priority ID', async t => {
  for (const mode of ['cancel','refused','throttled']) {
    const endpoints = new Map([[showKey(30),show()],[seasonKey(30,1),season(1,[[1,101]])]]);
    const gates = [], controller = new AbortController();
    const history = Array.from({length:14},(_,n) => {
      const id = 301+n;
      endpoints.set(findKey('tvdb_id',id),async () => {
        const gate = Promise.withResolvers();gates.push(gate);
        await gate.promise;return find([],[[30,101,1,1]]);
      });
      return {show:quay,episode:episode(n+1,{trakt:id,tvdb:id,imdb:'tt'+id})};
    });
    const {service,calls,cache} = provider(t,endpoints);
    const outcome = resolveTrakt(archive({history}),service,{signal:controller.signal})
      .then(()=>undefined,error=>error);
    await new Promise(resolve=>setImmediate(resolve));
    const started = gates.length;
    try {
      if (mode==='cancel' || started !== 10) controller.abort();
      else {
        gates[0].reject(new TmdbError(mode,undefined,mode==='throttled'?now+60000:undefined,mode==='throttled'?429:401));
        await outcome;
      }
    } finally {
      for (const gate of gates) gate.resolve();
    }
    const error = await outcome;
    assert.equal(started,10);
    assert.equal(error?.kind,mode==='cancel'?'superseded':mode);
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(calls.length,12);
    assert.equal(cache.size,0);
  }
});

test('Overlapping season replies cannot assign a duplicated episode ID according to arrival order', async t => {
  for (const delayedSeason of [1, 2]) {
    const release = Promise.withResolvers();
    let count = 0;
    const endpoints = new Map([[showKey(30), show(30, [1, 2])]]);
    for (const n of [1, 2]) endpoints.set(seasonKey(30, n), async () => {
      count++;
      if (n === delayedSeason) await release.promise;
      return season(n, n === 1 ? [[1, 101]] : [[1, 101], [2, 102]]);
    });
    const {service} = provider(t, endpoints);
    const lookup = resolveTrakt(archive({history:[...plays(episode(1, {tmdb:101}, 1), 3),
      ...plays(episode(2, {tmdb:102}, 2), 2)]}), service);
    // Give the released season time to reach the index first.
    try { await new Promise(resolve => setImmediate(resolve)); assert.equal(count, 2); }
    finally { release.resolve(); }
    const result = await lookup;
    assert.deepEqual(result.watched.map(r => [r.episode_id, r.times_watched]), [[102, 2]]);
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0], /3 plays.*could not be placed/);
  }
});

test('A misplaced TMDB ID is found in another season, and a genuinely absent episode is reported once with its plays', async t => {
  const { service, calls } = provider(t, new Map([
    [showKey(30), show(30, [0, 1, 2])], [seasonKey(30, 0), season(0, [])], [seasonKey(30, 1), season(1, [[1, 101]])],
    [seasonKey(30, 2), season(2, [[4, 105]])],
  ]));
  const notifications = [];
  const result = await resolveTrakt(archive({ history: [
    ...plays(episode(1, { trakt: 1, tmdb: 101 })), ...plays(episode(2, { trakt: 2, tmdb: 105 })),
    ...plays(episode(3, { trakt: 3, tmdb: 199 }), 2),
  ], totals: [{ show: quay, plays: 6 }] }), service, { progress: n => notifications.push(n) });
  assert.deepEqual(result.watched.map(r => [r.episode_id, r.season, r.episode, r.title]), [[101, 1, 1, 'TMDB 101'], [105, 2, 4, 'TMDB 105']]);
  assert.equal(result.shows[0].imdb_id, 'tt0000030');
  assert.equal(result.shows[0].year, 2021);
  assert.deepEqual(result.counts, [{ show_id: 30, show: 'Quay 30', total: 6, listedPlays: 4, listedEpisodes: 3, multiple: 2 }]);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0], /1×3.*2 plays.*could not be placed/);
  assert.deepEqual(calls, [showKey(30), seasonKey(30, 1), seasonKey(30, 0), seasonKey(30, 2)]);
  assert.deepEqual(notifications, [1, 2, 3, 4]);
});

test('Direct ID beats a more frequently watched duplicate found by external ID, in either history order', async t => {
  const history = [...plays(episode(8, { trakt: 108, tvdb: 408 }), 3), ...plays(episode(9, { trakt: 109, tmdb: 190 }))];
  for (const input of [history, history.toReversed()]) {
    const { service } = provider(t, new Map([[showKey(30), show()], [seasonKey(30, 1), season(1, [[9, 190]])],
      [findKey('tvdb_id', 408), find([], [[30, 190, 1, 9]])]]));
    const result = await resolveTrakt(archive({ history: input }), service);
    assert.equal(result.watched.length, 1);
    assert.equal(result.watched[0].times_watched, 1);
    assert.match(result.skipped[0], /1×8.*3 plays.*Duplicate/);
  }
});

test('A group keeps its corroborated Trakt ID for duplicate tie-breaks even if the display row lacks it', async t => {
  const withId = {...episode(1, {trakt:4, tmdb:91}), title:'Earlier reference'};
  const withoutId = {...episode(1, {tmdb:91}), title:'Alternate name'};
  const history = [...plays(withId), ...plays(withoutId), ...plays(episode(2, {trakt:7, tmdb:91}), 2)];
  for (const input of [history, history.toReversed()]) {
    const {service} = provider(t, new Map([[showKey(30),show()], [seasonKey(30,1),season(1,[[9,91]])]]));
    const result = await resolveTrakt(archive({history:input}), service);
    assert.equal(result.watched[0].times_watched, 2);
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0], /1×2.*Duplicate listing/);
  }
});

test('A 354-play total over 177 listed episodes offers 2× when only 176 can be placed', async t => {
  const detail = Array.from({ length: 176 }, (_, index) => [index + 1, 1001 + index]);
  const { service } = provider(t, new Map([[showKey(30), show()], [seasonKey(30, 1), season(1, detail)]]));
  const history = Array.from({ length: 177 }, (_, index) => ({
    show: quay, episode: episode(index + 1, { trakt: index + 1, tmdb: 1001 + index }),
  }));
  const result = await resolveTrakt(archive({ history, totals: [{ show: quay, plays: 354 }] }), service);
  assert.equal(result.watched.length, 176);
  assert.equal(result.skipped.length, 1);
  assert.deepEqual(result.counts[0], { show_id: 30, show: 'Quay 30', total: 354,
    listedPlays: 177, listedEpisodes: 177, multiple: 2 });
  assert(result.watched.every(row => row.times_watched === 1));
});

test('A divisible total cannot offer a common count below the plays of a listed episode, even when it is skipped', async t => {
  const history = [
    ...plays(episode(1, {trakt:1, tmdb:101}), 3),
    ...plays(episode(2, {trakt:2, tmdb:102})), ...plays(episode(3, {trakt:3, tmdb:103})),
  ];
  for (const pairs of [[[1,101],[2,102],[3,103]], [[2,102],[3,103]]]) {
    const {service} = provider(t, new Map([[showKey(30), show()], [seasonKey(30,1), season(1, pairs)]]));
    const result = await resolveTrakt(archive({history, totals:[{show:quay, plays:6}]}), service);
    assert.equal(result.counts[0].multiple, null);
    assert.equal(result.counts[0].listedPlays, 5);
    assert.equal(result.counts[0].listedEpisodes, 3);
    assert.equal(result.watched.length, pairs.length);
  }
});

test('Repeated plays without Trakt IDs survive optional ID changes and duplicate reports are independent of ZIP order', async t => {
  const direct = episode(1, {tmdb:91});
  const backfilled = {...direct, ids:ids({tmdb:91, tvdb:18})};
  const first = {...episode(2, {tvdb:201}), title:'Amber'};
  const second = {...episode(2, {tvdb:202}), title:'Cobalt'};
  const inputs = [direct, backfilled, first, second].map(e => ({show:quay, episode:e}));
  for (const history of [inputs, inputs.toReversed()]) {
    const {service} = provider(t, new Map([[showKey(30),show()], [seasonKey(30, 1),season(1, [[1,91],[2,92]])],
      [findKey('tvdb_id',201),find([],[[30,92,1,2]])], [findKey('tvdb_id',202),find([],[[30,92,1,2]])]]));
    const placed = await resolveTrakt(archive({history}),service);
    const planned = planTraktImport(placed,{local:{}, tables:emptyTables()});
    assert.deepEqual(planned.changes.put.watched.map(r => [r.episode_id,r.times_watched]), [[91,2],[92,1]]);
    assert.equal(placed.skipped.length, 1);
    assert.match(placed.skipped[0], /Cobalt.*Duplicate/);
  }
});

test('A missing Trakt ID follows a unique same-slot external identity and never arbitrarily chooses between two Trakt episodes', async t => {
  const {service} = provider(t, new Map([[showKey(30), show()], [seasonKey(30, 1), season(1, [[1, 110]])],
    [findKey('tvdb_id', 421), find([], [[30, 110, 1, 1]])]]));
  const named = plays(episode(1, {trakt:11, tmdb:110, tvdb:421}));
  const missing = plays(episode(1, {tvdb:421}));
  for (const entries of [[...named,...missing],[...missing,...named]]) {
    const resolved = await resolveTrakt(archive({history:entries}), service);
    assert.deepEqual(resolved.watched.map(r=>r.times_watched), [2]);
    assert.deepEqual(resolved.skipped, []);
    const ambiguous = await resolveTrakt(archive({history:[...entries,...plays(episode(1,{trakt:12,tmdb:110}))]}), service);
    assert.deepEqual(ambiguous.watched.map(r=>r.times_watched), [1]);
    assert.equal(ambiguous.skipped.length, 2);
  }
});

test('Two direct matches use the greater count; two equal external matches use the lower Trakt ID and preserve repeats', async t => {
  const { service } = provider(t, new Map([[showKey(30), show()], [seasonKey(30, 1), season(1, [[1, 110], [2, 120]])],
    [findKey('tvdb_id', 421), find([], [[30, 120, 1, 2]])], [findKey('imdb_id', 'tt0422'), find([], [[30, 120, 1, 2]])]]));
  const result = await resolveTrakt(archive({ history: [
    ...plays(episode(8, { trakt: 11, tmdb: 110 })), ...plays(episode(9, { trakt: 12, tmdb: 110 }), 3),
    ...plays(episode(6, { trakt: 22, imdb: 'tt0422' }), 2), ...plays(episode(7, { trakt: 21, tvdb: 421 }), 2),
  ] }), service);
  assert.deepEqual(result.watched.map(r => r.times_watched), [3, 2]);
  assert(result.skipped.some(s => s.includes('1×8') && s.includes('Duplicate')));
  assert(result.skipped.some(s => s.includes('1×6') && s.includes('Duplicate')));
});

test('A higher-priority ID backfilled on one play joins only a uniquely corroborated source episode', async t => {
  const sparse = episode(1,{tvdb:18}), direct = episode(1,{tvdb:18,tmdb:91});
  const alternate = episode(1,{tvdb:18,tmdb:92});
  const byImdb = episode(1,{imdb:'tt0018'}), linked = episode(1,{tvdb:18,imdb:'tt0018'});
  for (const [episodes, counts, skipped] of [
    [[sparse,direct], [2], 0],
    [[byImdb,linked,direct], [3], 0],
    [[sparse,direct,alternate], [1,1], 1],
  ]) {
    for (const order of [episodes,episodes.toReversed()]) {
      const {service} = provider(t,new Map([[showKey(30),show()], [seasonKey(30,1),season(1,[[1,91],[2,92]])],
        [findKey('tvdb_id',18),find([],[[30,91,1,1]])]]));
      const placed = await resolveTrakt(archive({history:order.map(e=>({show:quay,episode:e}))}),service);
      assert.deepEqual(placed.watched.map(r=>r.times_watched),counts);
      assert.equal(placed.skipped.length,skipped);
    }
  }
});

test('Show lookups use TheTVDB then IMDb across all four import sources. Episodes must belong to the matched show', async t => {
  const ref = series({ trakt: 1, tvdb: 800, imdb: 'tt0000800' });
  const { service, calls } = provider(t, new Map([
    [findKey('tvdb_id', 800), find()], [findKey('imdb_id', 'tt0000800'), find([30])], [showKey(30), show(30, [1], 'tt2222')],
    [seasonKey(30, 1), season(1, [[1, 101]])], [findKey('tvdb_id', 404), find([], [[88, 101, 1, 1]])],
    [findKey('imdb_id', 'tt1111'), find([], [[30, 101, 1, 1]])],
  ]));
  const result = await resolveTrakt(archive({ history: plays(episode(2, { trakt: 1, tvdb: 404, imdb: 'tt1111' }), 2, ref),
    ratings: [{ show: ref, rating: 8 }], favourites: [ref], watchlist: [ref],
  }), service);
  assert.deepEqual(calls, [findKey('tvdb_id', 800), findKey('imdb_id', 'tt0000800'), showKey(30),
    seasonKey(30, 1), findKey('tvdb_id', 404), findKey('imdb_id', 'tt1111')]);
  assert.equal(result.shows[0].imdb_id, 'tt2222');
  assert.equal(result.watched[0].times_watched, 2);
  assert.deepEqual(result.ratings.map(r => r.rating), [8]);
  assert.deepEqual(result.lists.map(r => r.list), ['Favorites', 'Watchlist']);
});

test('A missing show, an unmatched ID, and an episode with no matching external ID are named and skipped', async t => {
  const gone = series({ tmdb: 81 }, 'Fictional Lane'), neither = series({ tvdb: 83, imdb: 'tt0083' }, 'Fictional Lamp');
  const { service, calls } = provider(t, new Map([
    [showKey(81), new TmdbError('not-found')], [findKey('tvdb_id', 83), new TmdbError('not-found')],
    [findKey('imdb_id', 'tt0083'), find()], [showKey(30), show()], [seasonKey(30, 1), season(1, [[3, 103]])],
    [findKey('tvdb_id', 1), find()],
  ]));
  const result = await resolveTrakt(archive({ history: [...plays(episode(3, { trakt: 1, tvdb: 1 })),
    ...plays(episode(1, { trakt: 1 }), 1, gone)], ratings: [{ show: neither, rating: 9 }], favourites: [neither], watchlist: [gone],
    totals: [{ show: quay, plays: 1 }], issues: ['Watchlist item 9 could not be read.'] }), service);
  assert.deepEqual(result.shows.map(s => s.show_id), [30]);
  assert.deepEqual([result.ratings, result.lists, result.watched, result.counts], [[], [], [], []]);
  for (const label of ['Lane · 1×1', 'Lane · Watchlist', 'Lamp · rating 9', 'Lamp · Favorites', 'Quay 30 · 1×3', 'Watchlist item 9']) {
    assert(result.skipped.some(s => s.includes(label)), label);
  }
  assert(calls.indexOf(findKey('tvdb_id', 83)) < calls.indexOf(findKey('imdb_id', 'tt0083')));
});

test('Fresh metadata serves an online preview. Missing or refused credentials and offline devices cannot prepare one', async t => {
  const { service, state, cache, network, calls } = provider(t, new Map([[showKey(30), show()], [seasonKey(30, 1), season(1, [[1, 100]])]]));
  const input = archive({ history: plays(episode(1, { trakt: 1, tmdb: 100 })) });
  const first = await resolveTrakt(input, service);
  assert.equal(cache.size, 0);
  for (const [key, entry] of first.cache) cache.set(key, entry);
  const second = await resolveTrakt(input, service);
  assert.equal(second.cache.size, 0);
  assert.deepEqual(second.watched, first.watched);
  network.online = false;
  await assert.rejects(resolveTrakt(input, service), /could not be reached/);
  network.online = true;
  state.token = null;
  await assert.rejects(resolveTrakt(input, service), /Add a TMDB/);
  state.token = 'fictional';
  state.refused = 'refused';
  await assert.rejects(resolveTrakt(input, service), /refused/);
  assert.deepEqual(calls, [showKey(30), seasonKey(30, 1)]);
});

test('Refreshing a stale show also checks older season data and retains the prior response for the confirmed cache write', async t => {
  const map = new Map([[showKey(30), show()], [seasonKey(30, 1), season(1, [[1, 100]])]]);
  const { service, cache, calls } = provider(t, map);
  const input = archive({ history: plays(episode(1, { trakt: 1, tmdb: 100 })) });
  const first = await resolveTrakt(input, service);
  const staleShow = { value: first.cache.get(showKey(30)).value, fetchedAt: now - 61 * 86_400_000 };
  const cachedSeason = { value: first.cache.get(seasonKey(30, 1)).value, fetchedAt: now - 86_400_000 };
  cache.set(showKey(30), staleShow);
  cache.set(seasonKey(30, 1), cachedSeason);
  map.set(seasonKey(30, 1), season(1, [[5, 100]]));
  calls.length = 0;
  const relocated = await resolveTrakt(input, service);
  assert.deepEqual(calls, [showKey(30), seasonKey(30, 1)]);
  assert.equal(relocated.watched[0].episode, 5);
  assert.deepEqual(relocated.cache.get(seasonKey(30, 1)).prior, cachedSeason);
  assert.deepEqual(cache.get(seasonKey(30, 1)), cachedSeason);
});

test('An already refreshed show prevents Trakt from placing a stable ID at its former episode number', async t => {
  const map = new Map([[showKey(30), show()], [seasonKey(30, 1), season(1, [[1, 100]])]]);
  const { service, cache, calls } = provider(t, map);
  const input = archive({ history: plays(episode(1, { trakt: 1, tmdb: 100 })) });
  const first = await resolveTrakt(input, service);
  for (const [key, entry] of first.cache) cache.set(key, entry);
  cache.get(seasonKey(30, 1)).fetchedAt = now - 86_400_000;
  map.set(seasonKey(30, 1), season(1, [[1, 200], [5, 100]]));
  calls.length = 0;
  const relocated = await resolveTrakt(input, service);
  assert.deepEqual(relocated.watched.map(row => [row.episode_id, row.episode]), [[100, 5]]);
  assert.deepEqual(calls, [seasonKey(30, 1)]);
  assert.equal(cache.get(seasonKey(30, 1)).value.episodes[0].episode_id, 100);
});

test('A missing season that returns with a different episode cannot reidentify an existing blank-ID watch', async t => {
  const key = seasonKey(30, 1);
  const endpoints = new Map([[showKey(30), show()], [key, season(1, [[1, 100]])]]);
  const { service, cache } = provider(t, endpoints);
  const resource = {kind:'season', id:30, season:1};
  async function saveObservation() {
    cache.set(key, await service.fetchForImport(resource, 1n, () => true));
  }
  await saveObservation();
  endpoints.set(key, new TmdbError('not-found'));
  await saveObservation();
  assert.equal(cache.get(key).value, null);
  await saveObservation();
  endpoints.set(key, season(1, [[1, 200]]));
  cache.get(key).fetchedAt = now - 86_400_000;
  const input = archive({ history: plays(episode(1, { trakt: 1, tmdb: 200 })) });
  const placement = await resolveTrakt(input, service);
  const tables = emptyTables();
  tables.watched = [{...placement.watched[0], episode_id:null, title:'Older broadcast', times_watched:5}];
  const plan = planTraktImport(placement, {tables, local:{}});
  assert.equal(plan.watched.length, 0, 'The preview reassigned five older plays to a replacement episode');
  assert.match(plan.skipped.join(' '), /reused|occupies/);
  // An older installation may have retained only the 404, with no prior slot list.
  cache.set(key, {value:null, fetchedAt:now - 86_400_000});
  const older = await resolveTrakt(input, service);
  assert.equal(planTraktImport(older, {tables, local:{}}).watched.length, 0,
    'A previously saved 404 without slot history allowed blank-ID watches to be reassigned');
  // A known empty season is distinguishable from one with no recorded slot history.
  cache.delete(key);
  endpoints.set(key, season(1, []));
  await saveObservation();
  endpoints.set(key, new TmdbError('not-found'));
  await saveObservation();
  await saveObservation();
  assert.deepEqual(cache.get(key).vacatedPositions, []);
  endpoints.set(key, season(1, [[1, 200]]));
  cache.get(key).fetchedAt = now - 86_400_000;
  const newlyAdded = await resolveTrakt(input, service);
  assert.equal(planTraktImport(newlyAdded, {tables, local:{}}).watched.length, 1);
});

test('A network failure after a successful lookup, cancellation, and a changed credential discard the preview', async t => {
  const map = new Map([[showKey(30), show()], [seasonKey(30, 1), new TmdbError('unreachable')]]);
  const { service, state, cache, calls } = provider(t, map);
  const input = archive({ history: plays(episode(1, { trakt: 1, tmdb: 100 })) });
  await assert.rejects(resolveTrakt(input, service), /could not be reached/);
  assert.equal(cache.size, 0);
  calls.length = 0;
  let current = true;
  await assert.rejects(resolveTrakt(input, service, { progress: () => { current = false; }, current: () => current }), /no longer current/);
  assert.deepEqual(calls, [showKey(30)]);
  map.set(seasonKey(30, 1), () => { state.generation++; return season(1, [[1, 100]]); });
  await assert.rejects(resolveTrakt(input, service), /no longer current/);
  assert.equal(cache.size, 0);
});

test('Cancel during a 429 wait prevents the import retry, while another active caller can finish the same request', async t => {
  for (const anotherCaller of [false, true]) {
    let time = now, calls = 0, active = true, cooldown = null;
    const waiting = Promise.withResolvers(), resume = Promise.withResolvers();
    const store = { role: 'writer', providerKeysAvailable:true, tmdbState: async () => ({ token: 'fictional', refused: null, generation: 1n, cooldown }),
      writeTmdb: async (_gen, changes) => { cooldown = changes.cooldown; return true; } };
    const client = new TmdbClient({ now: () => time, sleep: async ms => {
      waiting.resolve(); await resume.promise; time += ms;
    }, fetch: async () => ++calls === 1 ? new Response(null, { status: 429, headers: { 'Retry-After': '1' } }) : Response.json(find()) });
    const service = new TmdbService(store, client, { now: () => time, online: () => true, visible: () => true });
    t.after(() => service.close());
    const reference = series({ tvdb: 600 });
    const canceled = assert.rejects(resolveTrakt(archive({ favourites: [reference] }), service,
      { current: () => active }), error => error.kind === 'superseded');
    await waiting.promise;
    const screen = anotherCaller ? service.refresh({ kind: 'find', source: 'tvdb_id', externalId: '600' }) : null;
    await new Promise(resolve => setImmediate(resolve));
    active = false;
    resume.resolve();
    await canceled;
    if (screen) assert.deepEqual((await screen).value, { shows: [], episodes: [] });
    assert.equal(calls, anotherCaller ? 2 : 1);
  }
});
