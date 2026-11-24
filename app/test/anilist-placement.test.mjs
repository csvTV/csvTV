import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveAniList } from '../src/anilist-placement.ts';
import { planAniListImport } from '../src/anilist-preview.ts';
import { aniListCorrections } from '../src/anilist-catalog-corrections.ts';
import { emptyTables } from '../src/model.ts';
import { TmdbError, tmdbResourceKey } from '../src/tmdb-client.ts';
import { openImportMetadata } from '../src/import-metadata.ts';

const now = Date.parse('2026-11-18T15:00:00Z');
const en = (id, progress, extra = {}) => ({id, progress, status:2, repeat:0, score:0, ...extra});
const map = (anilist_id, tv, tmdb, offset) => ({anilist_id, themoviedb_id:{tv}, season:{tmdb}, episode_offset:{tmdb:offset}});
const meta = (id, numbers) => ({show_id:id, show:'Fictional show ' + id, imdbId:null, firstAirDate:'2014-05-01',
  status:'Ended', seasons:numbers.map(season => ({season, episodeCount:7}))});
const season = (s, pairs, reusedPositions) => ({season:s, episodes:pairs.map(([episode,episode_id]) =>
  ({episode, episode_id, title:'Fictional episode ' + episode_id})), reusedPositions});
function fixture(entries, mappings, data) {
  const calls = [], cache = new Map();
  const state = {generation:3n, status:'ready'};
  const environment = {now:()=>now, online:()=>true};
  const service = {store:{role:'writer',mappingGate:async()=>({epoch:0n,until:0})}, environment,
    keyStatus:async()=>({...state}), read:async r=>cache.get(tmdbResourceKey(r)) ?? null,
    async fetchForImport(resource, generation, current) {
      assert.equal(generation, state.generation);
      assert.ok(current());
      const key = resource.kind === 'show' ? resource.id : resource.id + '/' + resource.season;
      calls.push(key);
      assert.ok(data.has(key), 'Unexpected TMDB call for ' + key);
      const value = data.get(key);
      if (value instanceof Error) throw value;
      return {value, fetchedAt:now};
    }};
  const archive = {entries, favourites:new Set([3]), notices:[]};
  let mappingCalls = 0;
  return {calls, cache, state, service, get mappingCalls() {return mappingCalls;},
    run: (options = {}) => resolveAniList(archive, service, {fetchMapping:async () => {mappingCalls++; return Response.json(mappings);}, ...options})};
}

test('An AniList export with no eligible anime keeps its parsing notices without contacting a provider', async () => {
  const f = fixture([], [], new Map());
  f.service.store.mappingGate = async () => { throw new Error('The mapping host is paused'); };
  const notice = {kind:'invalid', episodes:0, text:'List entry 2 was skipped.'};
  const placement = await resolveAniList({entries:[], favourites:new Set([2]), notices:[notice]}, f.service,
    {fetchMapping:async () => { throw new Error('Unexpected download'); }});
  assert.deepEqual([placement.notices, placement.shows, placement.watched, f.calls], [[notice], [], [], []]);
});

test('a cold AniList show can include explicit watched seasons while other placements keep their own episode checks', async () => {
  const entries = [en(101,1),en(102,1),en(103,1,{repeat:2}),en(104,0,{status:1}),
    en(105,2),en(106,1),en(107,1)];
  const mappings = [map(101,40,1,0),map(102,40,2,0),map(103,40,2,0),map(104,40,3,0),
    map(105,40,4,-1),map(106,40,5,0),map(107,40,0,null)];
  const data = new Map([[40,meta(40,[0,1,2,3,4,5,6])],
    ['40/1',season(1,[[1,401]])],['40/2',season(2,[[1,402]])],['40/6',season(6,[[1,406]])]]);
  const corrections = new Map([[106,{showId:40,publishedSeason:5,publishedOffset:0,segments:[{from:1,season:6,ids:[406]}]}]]);
  const direct = fixture(entries,mappings,data), expected = await direct.run({corrections});
  const bundled = fixture(entries,mappings,data), requests = [];
  bundled.service.client = {requestShowWithSeasons() {}};
  const fetch = bundled.service.fetchForImport;
  bundled.service.fetchForImport = async (resource,generation,current,combined) => {
    if (combined) {
      requests.push(combined.numbers);
      // Season two was missing from the combined reply. It must still be read directly.
      combined.received.set(1,data.get('40/1'));
    }
    return fetch(resource,generation,current);
  };
  const placed = await bundled.run({corrections});
  assert.deepEqual(requests,[[1,2]]);
  assert.deepEqual(bundled.calls,[40,'40/2','40/6']);
  for (const key of ['watched','shows','entries','entryRanges','notices']) assert.deepEqual(placed[key],expected[key]);
  assert.deepEqual(placed.watched.map(r=>[r.episode_id,r.times_watched]),[[401,1],[402,3],[406,1]]);
  assert.deepEqual(placed.cache,expected.cache);
  const before = {tables:emptyTables(),local:{}};
  assert.deepEqual(planAniListImport(placed,before).changes,planAniListImport(expected,before).changes);
});

test('a cached AniList show groups only its missing explicitly watched seasons and retries incomplete components individually', async () => {
  const id=40,numbers=Array.from({length:10},(_,i)=>i+1),header=meta(id,numbers);
  header.seasons=numbers.map(n=>({season:n,episodeCount:1,name:'Season '+n,posterPath:null}));
  const seasons=new Map(numbers.map(n=>[n,{...season(n,[[1,400+n]]),name:'Season '+n,posterPath:null}]));
  const data=new Map([[id,header],...numbers.map(n=>[id+'/'+n,seasons.get(n)])]);
  const entries=[...numbers.map(n=>en(800+n,n===10?0:1)),en(820,1),en(821,1),en(822,1)];
  const maps=[...numbers.map(n=>map(800+n,id,n,0)),map(820,id,2,0),map(821,id,90,0),map(822,id,0,null)];
  function seeded() {
    const f=fixture(entries,maps,data);
    f.cache.set(tmdbResourceKey({kind:'show',id}),{fetchedAt:now,value:header});
    f.cache.set(tmdbResourceKey({kind:'season',id,season:2}),{fetchedAt:now,value:seasons.get(2)});
    return f;
  }
  const direct=seeded(),expected=await direct.run(),bundled=seeded(),groups=[];
  bundled.service.client={requestShowWithSeasons(){}};
  const load=bundled.service.fetchForImport;
  bundled.service.fetchForImport=async (resource,generation,current,combined)=>{
    if (!combined) return load(resource,generation,current);
    groups.push([...combined.numbers]);
    for (const n of combined.numbers) if (n!==5) combined.received.set(n,seasons.get(n));
    return {fetchedAt:now,value:header};
  };
  const actual=await bundled.run();
  assert.deepEqual(groups,[[1,3,4,5,6,7],[8,9]]);
  assert.deepEqual(bundled.calls,['40/5']);
  for(const key of ['watched','shows','entries','entryRanges','notices','cache'])assert.deepEqual(actual[key],expected[key]);
  const state={tables:emptyTables(),local:{}};
  assert.deepEqual(planAniListImport(actual,state).changes,planAniListImport(expected,state).changes);
});

test('missing optional responses fall back to individual seasons and a later usable show reply resumes batching', async () => {
  const f = fixture([],[],new Map()), groups = [], singles = [];
  function header(id) {
    return {...meta(id,[1,2]),seasons:[1,2].map(n=>({season:n,episodeCount:1,name:'Season '+n,posterPath:null}))};
  }
  function detail(id,n) {
    return {...season(n,[[1,id*10+n]]),name:'Season '+n,posterPath:null};
  }
  f.service.client = {requestShowWithSeasons(){}};
  f.service.fetchForImport = async (resource,_generation,_current,combined) => {
    const {id} = resource;
    if (resource.kind === 'season') {
      singles.push(id+'/'+resource.season);
      return {fetchedAt:now,value:detail(id,resource.season)};
    }
    if (combined) {
      groups.push(id);
      if (id === 2) throw new TmdbError('invalid-response');
      if (id === 3) combined.received.set(1,{...detail(id,1),name:'Incompatible header'});
      if (id >= 5) for (const n of combined.numbers) combined.received.set(n,detail(id,n));
    }
    return {fetchedAt:now,value:header(id)};
  };
  const session = await openImportMetadata(f.service,'AniList');
  for (const id of [1,2,3,4,5,6]) {
    if (id !== 5) f.cache.set(tmdbResourceKey({kind:'show',id}),{fetchedAt:now,value:header(id)});
    const show = await session.load({kind:'show',id},undefined,[1,2]);
    await session.preloadSeasons(show,[1,2]);
    for (const n of [1,2]) assert.deepEqual(await session.load({kind:'season',id,season:n},show),detail(id,n));
  }
  assert.deepEqual(groups,[1,2,3,5,6]);
  assert.deepEqual(singles,['1/1','1/2','2/1','2/2','3/1','3/2','4/1','4/2']);
  session.close();
});

test('AniList splits continuous episode ranges in the preview and edits only the selected broadcast season', async () => {
  const id = 237150, entries = [en(11,12),en(12,12),en(13,1,{repeat:1,status:0})];
  const header = {...meta(id,[1]),seasons:[{season:1,episodeCount:32}]};
  const detail = season(1,Array.from({length:32},(_,i)=>[i+1,1001+i]));
  for (const ep of detail.episodes) ep.airDate = '2020-01-01';
  const source = fixture(entries,[map(11,id,1,0),map(12,id,1,12),map(13,id,1,24)],
    new Map([[id,header],[id+'/1',detail]]));
  const placement = await source.run();
  await placement.prepareSeason(id,2);
  assert.deepEqual([...new Set(source.calls)],[id,id+'/1']);
  const state = {local:{},tables:emptyTables()};
  const plan = planAniListImport(placement,state,{seasonExtras:new Map([[id,new Map([[3,1]])]])});
  assert.deepEqual(plan.entryGroups[0].entries.map(e=>e.seasons),
    [[{season:1,ranges:[[1,12]]}],[{season:2,ranges:[[1,12]]}],[{season:3,ranges:[[1,1]]}]]);
  assert.deepEqual(plan.reviewShows[0].seasons.map(s=>[s.season,s.airedEpisodes,s.displayCount]),[[1,12,1],[2,12,1],[3,8,3]]);
  assert.deepEqual(plan.changes.put.watched.map(r=>[r.season,r.episode,r.episode_id,r.times_watched]),
    detail.episodes.map(e=>[1,e.episode,e.episode_id,e.episode === 25 ? 3 : 1]));
});

test('A verified sequel can join Watchlist without assigning the original series’ episodes', async () => {
  const missing={anilist_id:181951,type:'TV'}, parent=map(145728,229676,1,0);
  const data=new Map([[229676,meta(229676,[1,2])]]);
  const placement=await fixture([en(181951,2,{status:1,score:80})],[missing,parent],data).run();
  assert.deepEqual(placement.watched,[]);
  assert.deepEqual(placement.notices.map(n=>[n.kind,n.episodes]),[['unplaced',2]]);
  assert.match(placement.notices[0].text,/verified.*sequel/i);
  assert.ok(placement.reviewSeasonNumbers.has(229676));
  const plan=planAniListImport(placement,{tables:emptyTables(),local:{}});
  assert.deepEqual(plan.changes.put.lists.map(row=>row.list),['Anime','Watchlist']);
  assert.deepEqual(plan.changes.put.ratings.map(row=>row.rating),[8]);
  const newParent=map(145728,33,1,0);
  const changed=await fixture([en(181951,0,{status:1})],[missing,newParent],new Map()).run();
  assert.equal(changed.shows.length,0);
  const remapped=await fixture([en(181951,1)],[map(181951,33,2,0),parent],
    new Map([[33,meta(33,[2])],['33/2',season(2,[[1,331]])]])).run();
  assert.deepEqual(remapped.watched.map(r=>r.episode_id),[331]);
});

test('Verified supplemental entries use current episode identities even without an upstream TV ID', async () => {
  const rows=[{anilist_id:20811,type:'OVA'},map(16498,1429,1,0)];
  const placement=await fixture([en(20811,2)],rows,new Map([[1429,meta(1429,[0,1])],
    ['1429/0',season(0,[[2,1029396],[1,941],[5,1029395]])]])).run();
  assert.deepEqual(placement.watched.map(r=>[r.season,r.episode,r.episode_id]),[[0,2,1029396],[0,5,1029395]]);
  const changed=await fixture([en(20811,1)],[{anilist_id:20811,type:'OVA',themoviedb_id:{movie:941}},rows[1]],new Map()).run();
  assert.equal(changed.shows.length,0);
  assert.equal(changed.notices[0].kind,'film');
});

test('An unanchored supplemental entry alone cannot borrow a regular season, while an explicit placement and a standalone regular series still work', async () => {
  const data = new Map([[17,{...meta(17,[1]),seasons:[{season:1,episodeCount:2}]}],['17/1',season(1,[[1,171],[2,172]])]]);
  for (const type of ['SPECIAL','OVA','MOVIE','MUSIC']) {
    const source = fixture([en(1,2,{score:80,status:1})],[{...map(1,17),type}],data);
    const placement = await source.run();
    assert.deepEqual(source.calls,[17]);
    assert.deepEqual(placement.watched,[]);
    assert.equal(placement.reviewSeasonNumbers.size,0);
    assert.deepEqual(placement.notices.map(n=>[n.episodes,n.review]),[[2,undefined]]);
    assert.match(placement.notices[0].text,/supplemental entry/);
    const plan = planAniListImport(placement,{tables:emptyTables(),local:{}});
    assert.deepEqual(plan.changes.put.ratings.map(r => r.rating),[8]);
    assert.ok(plan.changes.put.lists.some(row => row.list === 'Watchlist'));
  }
  for (const published of [{...map(1,17,1,1),type:'OVA'},{...map(1,17),type:'ONA'}]) {
    const placement = await fixture([en(1,1)],[published],data).run();
    assert.deepEqual(placement.watched.map(r => r.episode_id),[published.type === 'OVA' ? 172 : 171]);
  }
});

test('Partial progress on a verified rebroadcast uses the rebroadcast order, starting beyond the TMDB pilot', async () => {
  const episodes=season(1,[[1,880923],[2,880922],[3,880925],[5,880930],[7,880934],[10,880928],
    [13,880931],[14,880932],[4,880927],[15,1522926]]);
  const result=await fixture([en(4382,8)],[map(4382,42511,1,0)],new Map([[42511,meta(42511,[1])],['42511/1',episodes]])).run();
  assert.deepEqual(result.watched.map(r=>r.episode),[2,3,4,5,10,13,14,15]);
});

test('AniList places offsets at TMDB episode numbers, merges overlapping counts and retains all matched scores and statuses', async () => {
  const f = fixture([en(1,3,{score:80}),en(2,4,{repeat:2,score:90,status:0}),en(3,5,{score:75,status:13}),en(4,0),en(5,1)],
    [map(1,7,1,0),map(2,7,1,1),map(3,7,6),map(4,7,2),map(5,7,0)],
    new Map([[7,meta(7,[0,1,2])],['7/1',season(1,[[3,703],[1,701],[2,702]], [2])]]));
  const result = await f.run();
  assert.equal(f.mappingCalls, 1);
  assert.deepEqual(f.calls, [7,'7/1']);
  assert.deepEqual(result.shows, [{show_id:7,show:'Fictional show 7',year:2014,imdb_id:''}]);
  assert.deepEqual(result.watched.map(r=>[r.episode,r.episode_id,r.times_watched,r.title]),
    [[1,701,1,'Fictional episode 701'],[2,702,3,'Fictional episode 702'],[3,703,3,'Fictional episode 703']]);
  assert.deepEqual(result.entries.map(r=>[r.id,r.score,r.status,r.favourite]), [[1,80,2,false],[2,90,0,false],[3,75,13,true],[4,0,2,false],[5,0,2,false]]);
  assert.equal(result.reusedPositions.size, 1);
  const kind = k=>result.notices.filter(n=>n.kind === k);
  assert.deepEqual(kind('unplaced').map(n=>[n.entryId,n.episodes]), [[2,2],[3,5],[5,1]]);
  assert.match(kind('unplaced')[0].text,/Episodes 3–4.*end of season 1/i);
  assert.equal(kind('overlap').length,2);
  assert.equal(kind('rewatching')[0].entryId,2);
  assert.equal(kind('unknown-status')[0].entryId,3);
  assert.ok(result.notices.every(n=>n.anilistId === undefined));
});

test('AniList places progress against the new episode occupying a slot after its parent was refreshed', async () => {
  const f = fixture([en(1,1)], [map(1,7,1,0)], new Map([['7/1',season(1,[[1,200],[5,100]])]]));
  f.cache.set(tmdbResourceKey({kind:'show',id:7}), {fetchedAt:now, value:meta(7,[1])});
  f.cache.set(tmdbResourceKey({kind:'season',id:7,season:1}), {fetchedAt:now - 86_400_000, value:season(1,[[1,100]])});
  const preview = await f.run();
  assert.deepEqual(preview.watched.map(row => [row.episode_id, row.episode]), [[200,1]]);
  assert.deepEqual(f.calls, ['7/1']);
});

test('AniList review reuses matched season details and verifies a new season before offering its aired episodes', async () => {
  const one = season(1, [[1,71],[2,72],[3,73]]);
  one.episodes.forEach((e,i) => { e.airDate = i === 2 ? null : '2004-01-01'; });
  const two = season(2, [[1,81],[2,71]], [1]);
  two.episodes.forEach((e,i) => { e.airDate = i ? '2050-01-01' : '2005-01-01'; });
  const data = new Map([[7,meta(7,[2,1])], ['7/1',one], ['7/2',Error('Interrupted lookup')]]);
  const f = fixture([en(1,1,{repeat:1,status:0})], [map(1,7,1)], data);
  const placement = await f.run();
  const ids = () => placement.reviewCandidates.get(7).map(row => row.episode_id);
  assert.deepEqual(f.calls, [7,'7/1']);
  assert.deepEqual(placement.reviewSeasonNumbers.get(7), [1,2]);
  assert.deepEqual(ids(), [71,72]);
  assert.equal(placement.watched.length,1);
  await assert.rejects(placement.prepareSeason(7,2), /Interrupted lookup/);
  assert.deepEqual([...placement.reviewLoadedSeasons.get(7)], [1]);
  data.set('7/2',two);
  await placement.prepareSeason(7,2);
  assert.deepEqual(ids(), [71,72,81]);
  assert.deepEqual([...placement.reviewAmbiguousIds.get(7)], [71]);
  const calls = [...f.calls];
  await placement.prepareSeason(7,2);
  assert.deepEqual(f.calls,calls);
  f.state.generation++;
  await assert.rejects(placement.prepareSeason(7,1), e => e.kind === 'superseded');
});

test('No-season entries count actual regular episodes in order, ignore their offset and fetch only reached seasons', async () => {
  const header = meta(7,[3,1,0,2]);
  for (const s of header.seasons) s.episodeCount = s.season === 3 ? 1 : 2;
  const data = new Map([[7,header],['7/1',season(1,[[2,72],[1,71]])],
    ['7/2',season(2,[[1,73],[2,74]])],['7/3',season(3,[[1,75]])]]);
  const short = fixture([en(1,3)], [map(1,7,undefined,200)], data);
  assert.deepEqual((await short.run()).watched.map(r=>[r.season,r.episode,r.episode_id]), [[1,1,71],[1,2,72],[2,1,73]]);
  assert.deepEqual(short.calls, [7,'7/1','7/2']);
  const long = fixture([en(1,8)], [map(1,7,undefined,200)], data);
  const result = await long.run();
  assert.equal(result.watched.length,5);
  assert.match(result.notices[0].text,/Episodes 6–8.*end of the show/i);
  assert.equal(result.notices[0].episodes,3);
});

test('Malformed TMDB offsets on a seasonless AniList entry keep its plays in review and preserve its rating and list', async () => {
  const data = new Map([[17,{...meta(17,[1]),seasons:[{season:1,episodeCount:2}]}],['17/1',season(1,[[1,171],[2,172]])]]);
  for (const offset of [4, {tmdb:-2}, {tmdb:'1'}, {tmdb:1.5}, {tmdb:Number.MAX_SAFE_INTEGER+1}]) {
    const source = fixture([en(1,2,{score:80,status:1})],[{...map(1,17),episode_offset:offset}],data);
    const placement = await source.run();
    assert.deepEqual(placement.watched,[]);
    assert.deepEqual(source.calls,[17]);
    assert.deepEqual(placement.notices.map(n => [n.kind,n.episodes,n.review]),[['unplaced',2,true]]);
    assert.match(placement.notices[0].text,/invalid TMDB season or offset/);
    const plan = planAniListImport(placement,{tables:emptyTables(),local:{}});
    assert.deepEqual(plan.changes.put.ratings.map(r => r.rating),[8]);
    assert.ok(plan.changes.put.lists.some(row => row.list === 'Watchlist'));
  }
});

test('Explicit specials offsets include zero, missing numeric slots are reported, and extreme progress stays bounded', async () => {
  const f = fixture([en(1,3), en(2,Number.MAX_SAFE_INTEGER)], [map(1,8,0,0),map(2,8,1,Number.MAX_SAFE_INTEGER)],
    new Map([[8,meta(8,[0,1])],['8/0',season(0,[[1,81],[3,83]])],['8/1',season(1,[[1,84]])]]));
  const result = await f.run();
  assert.deepEqual(result.watched.map(r=>[r.season,r.episode]), [[0,1],[0,3]]);
  assert.deepEqual(result.notices.map(n=>[n.entryId,n.episodes]), [[1,1],[2,Number.MAX_SAFE_INTEGER]]);
  assert.match(result.notices[0].text,/Episode 2.*missing from TMDB season 0/i);
});

test('A missing regular season stops a whole-series count before an unverified placement in a later season', async () => {
  const header = meta(8,[1,2,3]);
  header.seasons[0].episodeCount = 2;
  const f = fixture([en(1,5)], [map(1,8,undefined)], new Map([[8,header],
    ['8/1',season(1,[[1,81],[2,82]])],['8/2',null]]));
  const result = await f.run();
  assert.deepEqual(f.calls,[8,'8/1','8/2']);
  assert.deepEqual(result.watched.map(r=>r.episode_id), [81,82]);
  assert.match(result.notices[0].text, /Episodes 3–5.*season 2.*missing/i);
  assert.equal(result.notices[0].episodes,3);
});

test('Two unanchored regular entries cannot restart at episode one even when only one is in the export', async () => {
  const mappings = [{...map(21,8),type:'TV'}, {...map(22,8),type:'ONA',episode_offset:{tvdb:12}}];
  const data = new Map([[8,meta(8,[0,1,2])], ['8/1',season(1,[[1,81],[2,82]])]]);
  for (const entries of [[en(22,2,{score:85,repeat:1})], [en(21,1),en(22,2)], [en(21,0,{status:1}),en(22,2)]]) {
    const f = fixture(entries,mappings,data);
    const result = await f.run();
    assert.deepEqual(result.watched,[]);
    assert.equal(result.entries.length,entries.length);
    assert.equal(result.notices.filter(n => n.review && n.kind === 'unplaced').length,entries.filter(e=>e.progress).length);
    assert.deepEqual(result.reviewSeasonNumbers.get(8),[0,1,2]);
    assert.deepEqual(f.calls,[8]);
  }
  const planning = await fixture([en(21,0,{status:1})],mappings,data).run();
  assert.deepEqual([planning.notices,planning.entries.map(e=>e.status),planning.watched],[[],[1],[]]);
});

test('A partial season cannot move absolute progress across an unknown slot into a later season', async () => {
  const header = meta(8,[1,2]);
  header.seasons[0].episodeCount = 3;
  const f = fixture([en(1,4)], [map(1,8)], new Map([[8,header],
    ['8/1',season(1,[[1,81],[3,83]])], ['8/2',season(2,[[1,91],[2,92]])]]));
  const result = await f.run();
  assert.deepEqual(result.watched.map(r=>r.episode_id),[81]);
  assert.deepEqual(f.calls,[8,'8/1']);
  assert.deepEqual(result.notices.map(n=>[n.episodes,n.review]),[[3,true]]);
  assert.match(result.notices[0].text,/episodes 2–4.*season 1/i);
});

test('Explicit overflow keeps the anchored prefix and offers regular season controls without guessing the continuation', async () => {
  const f = fixture([en(1,4)], [map(1,8,1)], new Map([[8,meta(8,[0,1,2])],
    ['8/1',season(1,[[1,81],[2,82]])],['8/2',season(2,[[1,91],[2,92]])]]));
  const result = await f.run();
  assert.deepEqual(result.watched.map(r=>r.episode_id),[81,82]);
  assert.equal(result.notices[0].review,true);
  assert.deepEqual(f.calls,[8,'8/1']);
  await result.prepareSeason(8,2);
  assert.deepEqual(f.calls,[8,'8/1','8/2']);
});

test('Supplemental and invalid mappings cannot turn into regular first-season watches', async () => {
  const mappings = [{...map(1,8),type:'TV'}, {...map(2,8),type:'SPECIAL'}, map(3,9,1,-4)];
  const result = await fixture([en(2,3,{score:90}),en(3,1)], mappings, new Map([
    [8,meta(8,[1,2])], [9,meta(9,[1])], ['8/1',season(1,[[1,81]])], ['9/1',season(1,[[1,91]])],
  ])).run();
  assert.deepEqual(result.watched,[]);
  assert.deepEqual(result.entries.map(e => [e.id,e.score,e.targetSeason]), [[2,90,null],[3,0,1]]);
  assert.equal(result.reviewSeasonNumbers.has(8),false);
  assert.deepEqual(result.reviewSeasonNumbers.get(9),[1]);
});

test('Films, missing mappings and absent TV shows only produce numbered links and no record contributions', async () => {
  const f = fixture([en(1,1),en(2,3),en(3,1), en(4,4)],
    [{anilist_id:1,themoviedb_id:{movie:76}}, map(3,9,1),map(4,10,1),map(4,11,1)], new Map([[9,null]]));
  const result = await f.run();
  assert.deepEqual(f.calls,[9]);
  assert.deepEqual([result.entries,result.shows,result.watched],[[],[],[]]);
  assert.deepEqual(result.notices.map(n=>[n.kind,n.anilistId,n.episodes]),
    [['film',1,1],['unmapped',2,3],['missing-show',3,1],['unmapped',4,4]]);
});

test('A duplicated stable episode ID in two fetched seasons cannot produce a new CSV row', async () => {
  const f = fixture([en(1,2),en(2,1)], [map(1,8,1),map(2,8,2)], new Map([[8,meta(8,[1,2])],
    ['8/1',season(1,[[1,91],[2,92]])],['8/2',season(2,[[1,91]])]]));
  const result = await f.run();
  assert.deepEqual(result.watched.map(r=>r.episode_id),[92]);
  assert.deepEqual(result.notices.map(n=>[n.entryId,n.episodes]),[[1,1],[2,1]]);
});

test('A mapped TV series imports when separate unwatched special and series entries have no TMDB placement', async () => {
  const f = fixture([en(15,2), en(16,0), en(17,0), en(18,0)], [
    {...map(15,34,1), type:'TV'}, {anilist_id:16,type:'SPECIAL'}, {anilist_id:17,type:'TV'},
  ], new Map([[34,meta(34,[1])],['34/1',season(1,[[1,341],[2,342]])]]));
  const result = await f.run();
  assert.deepEqual(f.calls,[34,'34/1']);
  assert.deepEqual(result.watched.map(r=>r.episode_id),[341,342]);
  assert.deepEqual(result.entries.map(e=>e.id),[15]);
  assert.deepEqual(result.notices.map(n=>[n.anilistId,n.episodes,n.text]),[
    [16,0,'AniList entry 16 · Special · No TMDB show in the mapping file.'],
    [17,0,'AniList entry 17 · TV series · No TMDB show in the mapping file.'],
    [18,0,'AniList entry 18 · No TMDB show in the mapping file.'],
  ]);
});

test('An entry can span specials and regular seasons by verified ID, retaining repeats and a repeatable import', async () => {
  const mapping = map(17,7,1,9);
  const corrections = new Map([[17,{showId:7,publishedSeason:1,publishedOffset:9,segments:[
    {from:1,season:2,ids:[81,82]}, {from:3,season:0,ids:[175]}, {from:4,season:3,ids:[95,97,92]},
  ]}]]);
  const data = new Map([[7,meta(7,[0,1,2,3])],['7/0',season(0,[[8,175]])],
    ['7/2',season(2,[[5,81],[6,82]])],['7/3',season(3,[[1,95],[2,996],[3,97],[4,92]])]]);
  const partial = fixture([en(17,2,{repeat:2})],[mapping],data);
  const started = await partial.run({corrections});
  assert.deepEqual(partial.calls,[7,'7/2']);
  assert.deepEqual(started.watched.map(row=>[row.season,row.episode,row.times_watched]),[[2,5,3],[2,6,3]]);
  const all = fixture([en(17,6,{repeat:2,score:85})],[mapping],data);
  const complete = await all.run({corrections});
  assert.equal(complete.entries[0].targetSeason,null);
  assert.deepEqual(all.calls,[7,'7/2','7/0','7/3']);
  assert.deepEqual(complete.watched.map(row=>[row.season,row.episode,row.episode_id]),
    [[0,8,175],[2,5,81],[2,6,82],[3,1,95],[3,3,97],[3,4,92]]);
  assert.deepEqual(complete.notices,[]);
  assert.deepEqual(complete.entryRanges.map(r=>[r.season,r.first,r.last]),[[0,8,8],[2,5,6],[3,1,1],[3,3,4]]);
  const saved = {local:{},tables:emptyTables()};
  const first = planAniListImport(complete,saved);
  for (const [table,rows] of Object.entries(first.changes.put)) saved.tables[table].push(...rows);
  assert.deepEqual(saved.tables.watched.map(row=>row.times_watched),[3,3,3,3,3,3]);
  assert.deepEqual([saved.tables.ratings[0].rating,saved.tables.lists[0].list],[8.5,'Anime']);
  const second = planAniListImport(await all.run({corrections}),saved);
  assert.ok(Object.values(second.changes.put).every(rows=>rows.length===0));
});

test('Corrections retire when the published show, season or offset changes', async () => {
  const corrections = new Map([[1,{showId:8,publishedSeason:1,publishedOffset:0,segments:[{from:1,season:2,ids:[95]}]}]]);
  for (const [showId,mappedSeason,offset,expected] of [[9,1,0,81],[8,2,0,85],[8,1,1,82],[8,1,0,95]]) {
    const f = fixture([en(1,1)],[map(1,showId,mappedSeason,offset)],new Map([[showId,meta(showId,[1,2])],
      [showId+'/1',season(1,[[1,81],[2,82]])],[showId+'/2',season(2,[[1,85],[2,95]])]]));
    const result = await f.run({corrections});
    assert.deepEqual(result.watched.map(row=>row.episode_id),[expected]);
    assert.equal(result.entries[0].targetSeason,expected===95 ? 2 : mappedSeason);
    assert.deepEqual(result.notices,[]);
  }
});

test('Every published correction has a valid source tuple and distinct source positions and episode identities', () => {
  const valid = (value,minimum) => Number.isSafeInteger(value) && value >= minimum;
  for (const [entry,correction] of aniListCorrections) {
    assert.ok(valid(entry,1) && valid(correction.showId,1) && valid(correction.publishedSeason,0) &&
      (valid(correction.publishedOffset,0) || correction.publishedSeason === 0 && correction.publishedOffset === null) && correction.segments.length);
    const sources = new Set(), episodes = new Set();
    for (const {from,season,ids} of correction.segments) {
      assert.ok(valid(from,1) && valid(season,0) && ids.length);
      for (const [offset,id] of ids.entries()) {
        assert.ok(valid(id,1) && !episodes.has(id) && !sources.has(from+offset), 'Ambiguous catalog entry ' + entry);
        sources.add(from+offset); episodes.add(id);
      }
    }
  }
});

test('A verified run with missing, duplicate or unverified episodes places only surviving unique IDs', async () => {
  const corrections = new Map([[1,{showId:8,publishedSeason:1,publishedOffset:0,segments:[
    {from:1,season:1,ids:[81,82,83,84]}, {from:6,season:2,ids:[94]}, {from:7,season:4,ids:[101]},
  ]}]]);
  const f = fixture([en(1,Number.MAX_SAFE_INTEGER)], [map(1,8,1)], new Map([[8,meta(8,[1,2])],
    ['8/1',season(1,[[1,81],[2,91],[3,83],[4,84],[5,83]])],['8/2',season(2,[[1,94]])]]));
  const result = await f.run({corrections});
  assert.deepEqual(result.watched.map(row=>row.episode_id),[81,84,94]);
  assert.deepEqual(f.calls,[8,'8/1','8/2']);
  assert.deepEqual(result.notices.map(n=>n.episodes).sort((a,b)=>a-b),[1,1,2,Number.MAX_SAFE_INTEGER-7]);
  assert.ok(result.notices.every(n => n.review && n.kind === 'unplaced'));
});

test('No key, offline, read-only, failed mapping, canceled lookup or a changed TMDB key prevent a preview', async () => {
  const f = fixture([en(1,1)], [map(1,7,1)], new Map([[7,meta(7,[1])],['7/1',Error('TMDB failed')]]));
  f.state.status = 'missing-key';
  await assert.rejects(f.run(), /TMDB.*Settings.*AniList/);
  f.state.status = 'ready';
  f.service.environment.online = () => false;
  await assert.rejects(f.run(), e => e.kind === 'unreachable');
  f.service.environment.online = () => true;
  f.service.store.role = 'reader';
  await assert.rejects(f.run(), e => e.kind === 'superseded');
  assert.equal(f.mappingCalls,0);
  f.service.store.role = 'writer';
  await assert.rejects(f.run({fetchMapping:async()=>Response.json({error:true})}), /mapping file/);
  assert.deepEqual(f.calls,[]);
  await assert.rejects(f.run({fetchMapping:async()=>{f.state.generation++;return Response.json([map(1,7,1)]);}}), e => e.kind === 'superseded');
  assert.deepEqual(f.calls,[]);
  const aborter = new AbortController();
  await assert.rejects(f.run({signal:aborter.signal,progress:()=>aborter.abort()}), e => e.kind === 'superseded');
  assert.deepEqual(f.calls,[7]);
  await assert.rejects(f.run(), /TMDB failed/);
});
