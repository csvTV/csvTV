import assert from 'node:assert/strict';
import test from 'node:test';
import { localCalendarDate, watchProgress } from '../src/progress.ts';
import { calculateStatistics } from '../src/statistics.ts';
import { createStatisticsCache, createStatisticsHistory, readStatisticsRecord } from '../src/statistics-data.ts';
import { tmdbResourceKey } from '../src/tmdb-client.ts';
import { cacheExpiresAt } from '../src/tmdb-refresh.ts';
import { readDisplayRatings } from '../src/critic-marks.ts';
import { ImdbService } from '../src/imdb-service.ts';

const validity = (from,until) => ({from,until,day:localCalendarDate(new Date(from))});

test('Statistics checks the report after the independent IMDb read and discards superseded or failed lookups',async()=>{
  const wanted=Array.from({length:16},(_,i)=>i+1);
  for (const outcome of ['current','superseded','failed','unavailable','aborted']) {
    const entered=Promise.withResolvers(), reply=Promise.withResolvers(), controller=new AbortController();
    const external=new Map(), headers=new Map(), calls=[];
    let now=10;
    const store=Object.assign(new EventTarget(),{
      imdbDisplayState:async()=>({generation:4n,source:'omdb'}),
      async imdbExternalEntries(ids,signal) {
        assert.deepEqual(ids,wanted);
        assert.equal(signal,controller.signal);
        calls.push('external');
        entered.resolve();
        return reply.promise;
      },
      async imdbIdentities(ids,cutoff,_deadline,shared,prior) {
        calls.push('identities');
        assert.deepEqual(ids,wanted);
        assert.equal(cutoff,20,'Expiry is checked when the score identities are resolved');
        assert.equal(shared,outcome==='superseded'?undefined:headers);
        assert.equal(prior,outcome==='current'?external:undefined);
        if (outcome==='unavailable') throw Error('Fictional identity retry failed');
        return new Map([[1,'tt0000001']]);
      },
      async imdbValues(generation) {
        assert.equal(generation,4n);
        return [{value:{rating:8}}];
      }
    });
    const service=new ImdbService({store,environment:{now:()=>now}});
    try {
      const read=readDisplayRatings({imdb:service},wanted,{imdb:new Map([[1,5]])},{signal:controller.signal,read:async()=>{
        calls.push('headers');
        return outcome==='superseded'?undefined:headers;
      }});
      let visible;
      read.render(scores=>{visible=scores.imdb?.get(1);});
      await entered.promise;
      assert.deepEqual(calls,['external']);
      now=20;
      if (outcome==='aborted') controller.abort();
      if (outcome==='failed' || outcome==='unavailable') reply.reject(Error('Fictional cache read failed')); else reply.resolve(external);
      const {complete}=await read.settled;
      const available=outcome!=='aborted' && outcome!=='unavailable';
      assert.equal(complete,available,'Only complete score projections may be retained');
      assert.equal(visible,available?8:undefined,'A failed lookup must clear the previous score');
      if (outcome==='aborted') {
        assert.deepEqual(calls,['external']);
      } else {
        assert.deepEqual(calls,['external','headers','identities']);
      }
    } finally {service.close();}
  }
});

const today = '2026-11-18';

test('A completed score projection expires with its earliest cached IMDb identity and retries unavailable sources', async () => {
  const imdb = {async readShows(ids,until) { until(150); until(120); return new Map([[ids[0],8.5]]); }};
  const read = readDisplayRatings({imdb},[7]);
  let visible;
  read.render(scores=>{ visible=scores; });
  assert.deepEqual(await read.settled,{complete:true,validUntil:120,scores:visible});
  assert.equal(visible.imdb.get(7),8.5);
  const failed = readDisplayRatings({imdb,critics:{async read(){ throw Error('Cache read interrupted'); }}},[7],visible);
  assert.deepEqual(await failed.settled,{complete:false,validUntil:120,scores:{imdb:new Map([[7,8.5]])}});
});

function statisticsFixture() {
  const id = 11, now = Date.UTC(2026,10,19);
  const tables = {
    watched:[{show_id:id,show:'Signal Boat',season:1,episode:1,episode_id:1101,times_watched:3,title:'Pilot'}],
    ratings:[{show_id:id,show:'Signal Boat',rating:8}], lists:[{show_id:id,show:'Signal Boat',list:'Anime'}], shows:[],
  };
  const title = {show_id:id,show:'Signal Boat',seasons:[{season:1,episodeCount:1}],genres:[],networks:[],keywords:[],
    originCountries:['NZ'],lastAired:{season:1,episode:1},nextAirDate:null,firstAirDate:'2019-01-01'};
  const season = {show_id:id,season:1,episodes:[{episode:1,episode_id:1101,runtime:40,airDate:'2019-01-01'}]};
  const cast = [{id:8,name:'Mira Vale'}], countries = [{code:'NZ',name:'New Zealand'}];
  const keys = Object.fromEntries(['show','season','cast','countries'].map(kind=>[kind,tmdbResourceKey({kind,id,season:1})]));
  return {id,now,tables,title,season,cast,countries,keys};
}

test('Statistics return cache discards expired, superseded and previous-account results and retains only display inputs', () => {
  const store = new EventTarget(), controller = new AbortController();
  store.role = 'writer';
  const history = createStatisticsHistory({store},controller.signal);
  const input = {shows:[],countries:[],imdb:new Map([[8,9]])};
  const visit = history.beginVisit();
  const save = (generation=history.generation) => history.saveRecord(visit,generation,input,17n,validity(100,120));
  for (const event of ['exportchange','cachechange','tmdbmetadata','dropboxchange','rolechange','deviceerased',
    'providerkeyschange','ratingscredentialschange','imdbconfigchange','malconfigchange']) {
    const initial = history.generation;
    save(initial);
    assert.deepEqual(history.read(101).input,{shows:[],countries:[]});
    store.dispatchEvent(new Event(event));
    save(initial);
    assert.equal(history.read(101),undefined,'A late result survived '+event);
  }
  for (const event of ['mdblistchange','imdbchange','malchange']) {
    const generation = history.generation;
    const retained = save(generation);
    store.dispatchEvent(new Event(event));
    assert.equal(save(generation),undefined,'A late score read survived '+event);
    const saved = history.read(101);
    assert.equal(saved.input,retained);
    assert.equal(saved.scores,undefined);
    assert.equal(saved.scoresCurrent,false);
  }
  for (const outside of [99,120]) {
    save();
    assert.equal(history.read(outside),undefined,'Clock rollback or expiry left old figures available');
  }
  save();
  const preferenceEdit = statisticsUnchangedAt => store.dispatchEvent(new CustomEvent('recordchange',{detail:{statisticsUnchangedAt}}));
  const projection = history.read(101);
  preferenceEdit(18n);
  preferenceEdit(20n);
  assert.equal(history.read(101),projection,'Irrelevant global revisions must leave the same verified report available');
  assert.equal(projection.revision,17n);
  history.clear();
  preferenceEdit(18n);
  preferenceEdit(19n);
  save();
  assert.equal(history.read(101).revision,17n,'A sort finishing during the snapshot must not rewrite its report revision');
  const beforeWatch = history.generation;
  store.dispatchEvent(new Event('exportchange'));
  preferenceEdit(21n);
  assert.equal(save(beforeWatch),undefined,'A late unchanged-preference event cannot reinstate an obsolete watch report');
  save();
  controller.abort();
  save();
  assert.equal(history.read(101),undefined,'Disposing the app should release the report');
});

test('Late Statistics scores only complete their own current visit, verified record and fresh score interval', () => {
  const store = Object.assign(new EventTarget(),{role:'writer'}), controller = new AbortController();
  const history = createStatisticsHistory({store},controller.signal);
  const input = {shows:[],countries:[],imdb:new Map([[8,1]])};
  const prior = {imdb:new Map([[8,6]])}, current = {imdb:new Map([[8,9]])};
  const first = history.beginVisit(), generation = history.generation;
  const record = history.saveRecord(first,generation,input,17n,validity(100,180));
  assert.equal(history.read(101).scoresCurrent,false);
  assert.ok(history.completeScores(first,generation,record,prior,160,101));
  assert.equal(history.read(102).scores,prior);
  const second = history.beginVisit();
  assert.equal(history.completeScores(first,generation,record,prior,160,103),false,'A new visit owns its reports as soon as it starts');
  assert.equal(history.saveRecord(first,generation,input,17n,validity(100,180)),undefined);
  const verified = history.saveRecord(second,generation,input,17n,validity(104,180));
  assert.equal(history.completeScores(second,generation,record,prior,160,105),false,'Same revision, superseded record');
  assert.equal(history.completeScores(second,generation,verified,prior,105,106),false,'Score expired during its read');
  assert.equal(history.completeScores(second,generation,verified,prior,200,180),false,'Metadata expired during its read');
  assert.equal(history.completeScores(second,generation,verified,prior,160,103),false,'Clock moved behind the snapshot');
  assert.ok(history.completeScores(second,generation,verified,current,170,106));
  assert.equal(history.completeScores(first,generation,record,prior,160,108),false);
  assert.equal(history.read(108).scores,current);
  assert.equal(history.read(170),undefined);
  for (const event of ['exportchange','dropboxchange','deviceerased','rolechange','imdbchange']) {
    const before = history.generation;
    const projection = history.saveRecord(second,before,input,18n,validity(171,200));
    store.dispatchEvent(new Event(event));
    assert.equal(history.completeScores(second,before,projection,prior,190,175),false,event);
    assert.equal(history.read(175)?.scores,undefined,event);
  }
  const before = history.generation;
  const latest = history.saveRecord(second,before,input,19n,validity(180,200));
  controller.abort();
  assert.equal(history.completeScores(second,before,latest,prior,190,185),false);
  assert.equal(history.read(185),undefined);
});

test('Partly acquired comparisons belong to one verified projection and expire even when another source is still pending', () => {
  const store = Object.assign(new EventTarget(),{role:'writer'}), lifetime = new AbortController();
  const history = createStatisticsHistory({store},lifetime.signal), input = {shows:[],countries:[]};
  const visit = history.beginVisit();
  for (const event of ['mdblistchange','malchange','ratingscredentialschange','dropboxchange','rolechange','deviceerased','exportchange']) {
    const partial = {critics:new Map([[42,{tomatoes:80,metacritic:null,myanimelist:null}]])};
    const generation = history.generation;
    history.saveRecord(visit,generation,input,4n,validity(100,150),partial);
    assert.equal(history.read(120).scores,partial);
    assert.equal(history.read(120).scoresCurrent,false);
    store.dispatchEvent(new Event(event));
    partial.mal = new Map([[42,[{season:1,offset:0,malId:100,score:7.5}]]]);
    assert.equal(history.read(120)?.scores,undefined,event);
    assert.equal(history.saveRecord(visit,generation,input,4n,validity(100,150),partial),undefined,event);
  }
  for (const time of [99,150]) {
    history.saveRecord(visit,history.generation,input,4n,validity(100,150),{critics:new Map()});
    assert.equal(history.read(time),undefined,'Outside the verified interval');
  }
  lifetime.abort();
});

test('Statistics keeps saved counts while individual title, season, cast and country reads are pending or fail', async () => {
  const {now,tables,title,season,cast,countries,keys} = statisticsFixture();
  for (const rejected of ['show','season','cast','countries',null]) {
    const requests = new Map(), holds = new Map();
    for (const key of Object.values(keys)) holds.set(key,Promise.withResolvers());
    const store = {overviewRows:async()=>tables,tmdbEntries:async ([key],cutoff) => {
      assert.equal(cutoff,now);
      requests.set(key,(requests.get(key) ?? 0)+1);
      return holds.get(key).promise;
    }};
    const {input,loadMetadata} = await readStatisticsRecord({store,environment:{now:()=>now}});
    assert.equal(requests.size,0);
    let latest = input;
    const checking = loadMetadata(next => { latest = next; });
    const report = () => calculateStatistics(latest,'anime');
    const chart = id => report().charts.find(model=>model.id===id);
    assert.equal(report().totals.plays,3n);
    assert.deepEqual(chart('tmdb')?.rows ?? [],[]);
    assert.equal(chart('ratings').rows[16].value,1);
    async function settle(kind,value) {
      const hold = holds.get(keys[kind]);
      if (kind===rejected) hold.reject(Error('Fictional cache read failed'));
      else hold.resolve([{value,fetchedAt:now}]);
      await new Promise(resolve => setImmediate(resolve));
    }
    await settle('show',title);
    if(rejected!=='show') {
      assert.equal(chart('countries').rows[0].label,'NZ','Season and country reads are still pending');
    }
    await settle('cast',cast);
    if(rejected!=='show' && rejected!=='cast') assert.equal(chart('cast').rows[0].label,'Mira Vale');
    if(rejected!=='show') await settle('season',season);
    await settle('countries',countries);
    assert.equal(await checking,rejected === null,'Partial results should be retried on return');
    assert.equal(report().totals.plays,3n);
    assert.equal(report().totals.minutes,rejected==='show'||rejected==='season' ? 0n : 120n);
    if(rejected!=='show') assert.equal(chart('countries').rows[0].label,rejected==='countries'?'NZ':'New Zealand');
    assert.equal(!!chart('cast'),rejected!=='show' && rejected!=='cast');
    assert.ok([...requests.values()].every(n=>n===1),'Duplicated cache read');
  }
  const failure = Error('Fictional personal record read failed');
  await assert.rejects(readStatisticsRecord({store:{overviewRows:async()=>{throw failure;},tmdbEntries:assert.fail}}),failure);
});

test('A large report shares requested headers before unmatched seasons finish, and includes those season runtimes', async () => {
  const {tables,title,now} = statisticsFixture();
  tables.watched = Array.from({length:16},(_,i)=>({...tables.watched[0],show_id:i+1,episode_id:100+i}));
  tables.revision = 25n;
  const values = new Map();
  for (const [i,row] of tables.watched.entries()) {
    const id = row.show_id;
    values.set(tmdbResourceKey({kind:'show',id}),{...title,show_id:id,seasons:[{season:1,episodeCount:1},{season:2,episodeCount:1}]});
    // TMDB moved the watched episode out of its season as recorded in the CSV.
    values.set(tmdbResourceKey({kind:'season',id,season:2}),{show_id:id,season:2,episodes:[{
      episode:1,episode_id:row.episode_id,runtime:20+i,airDate:'2019-01-01'}]});
  }
  const later = Promise.withResolvers(), calls = [];
  const service = {environment:{now:()=>now},store:{overviewRows:async()=>tables,tmdbEntries:async keys=>{
    calls.push(keys);
    if (keys.every(key=>key.endsWith('/season/2'))) await later.promise;
    return keys.map(key=>values.has(key) ? {value:values.get(key),fetchedAt:now} : undefined);
  }}};
  const record = await readStatisticsRecord(service);
  let input = record.input;
  const pending = record.loadMetadata(value=>{ input=value; });
  const headers = await record.imdbHeaders.ready;
  assert.equal(headers.size,16);
  assert.equal(headers.get(3).value.show_id,3);
  assert.equal(record.revision,25n);
  assert.equal(calculateStatistics(input).totals.plays,48n);
  later.resolve();
  assert.equal(await pending,true);
  assert.equal(calculateStatistics(input).totals.minutes,1320n);
  assert.equal(calls.length,2);
  assert.equal(new Set(calls.flat()).size,calls.flat().length);
});

test('Warm Statistics refresh uses current personal rows and keeps each confirmed source until its own read settles', async () => {
  const {now,tables,title,season,cast,countries,keys} = statisticsFixture();
  const values = new Map([[keys.show,title],[keys.season,season],[keys.cast,cast],[keys.countries,countries]]);
  const holds = new Map();
  const service = {store:{
    overviewRows:async()=>structuredClone(tables),
    tmdbEntries:async requested => holds.get(requested[0])?.promise ?? requested.map(key=>({value:values.get(key),fetchedAt:now})),
  },environment:{now:()=>now}};
  const cache = createStatisticsCache();
  const first = await readStatisticsRecord(service,cache);
  await first.loadMetadata(()=>{});
  tables.watched[0].times_watched = 4;
  tables.ratings[0].rating = 6;
  for (const key of Object.values(keys)) holds.set(key,Promise.withResolvers());
  const warm = await readStatisticsRecord(service,cache);
  let latest = warm.input;
  const report = () => calculateStatistics(latest,'anime');
  function expectWarm() {
    assert.equal(report().totals.minutes,160n);
    assert.equal(report().totals.plays,4n);
    assert.equal(latest.shows[0].rating,6);
    assert.deepEqual(rows(report(),'cast'),[['Mira Vale',1n]]);
    assert.deepEqual(rows(report(),'countries'),[['New Zealand',1n]]);
  }
  expectWarm();
  const checking = warm.loadMetadata(update=>{ latest=update; });
  holds.get(keys.countries).resolve([{value:countries,fetchedAt:now}]);
  await new Promise(resolve=>setImmediate(resolve));
  expectWarm();
  holds.get(keys.show).resolve([{value:title,fetchedAt:now}]);
  await new Promise(resolve=>setImmediate(resolve));
  expectWarm();
  holds.get(keys.cast).resolve([undefined]);
  holds.get(keys.season).reject(Error('Season cache unavailable'));
  await checking;
  assert.equal(report().totals.minutes,0n);
  assert.equal(report().totals.plays,4n);
  assert.deepEqual(rows(report(),'cast'),[]);
  assert.deepEqual(rows(report(),'countries'),[['New Zealand',1n]]);
  assert.deepEqual((await readStatisticsRecord(service,cache)).input,latest);
});

test('Statistics drops expired, removed, and prior-session metadata and ignores superseded reads', async () => {
  const fixture = statisticsFixture();
  const {now,tables,title,season,cast,countries,keys} = fixture;
  const values = new Map([[keys.show,title],[keys.season,season],[keys.cast,cast],[keys.countries,countries]]);
  const cache = createStatisticsCache();
  const hold = Promise.withResolvers();
  let clock = now, pending = false;
  const service = {store:{overviewRows:async()=>structuredClone(tables),tmdbEntries:async requested => {
    if (pending) await hold.promise;
    return requested.map(key=>({value:values.get(key),fetchedAt:key===keys.cast ? now - 1000 : now}));
  }},environment:{now:()=>clock}};
  await (await readStatisticsRecord(service,cache)).loadMetadata(()=>{});
  clock = cacheExpiresAt(now-1000);
  const justCastExpired = (await readStatisticsRecord(service,cache)).input;
  assert.equal(justCastExpired.shows[0].cast,null);
  assert.equal(calculateStatistics(justCastExpired).totals.minutes,120n);
  clock = cacheExpiresAt(now);
  const expired = (await readStatisticsRecord(service,cache)).input;
  assert.equal(expired.shows[0].metadata,null);
  assert.deepEqual(expired.countries,[]);
  clock = now;
  await (await readStatisticsRecord(service,cache)).loadMetadata(()=>{});
  pending = true;
  const old = (await readStatisticsRecord(service,cache)).loadMetadata(assert.fail);
  const saved = tables.watched.splice(0);
  assert.equal((await readStatisticsRecord(service,cache)).input.shows.length,0);
  tables.watched.push(...saved);
  const readded = await readStatisticsRecord(service,cache);
  assert.equal(readded.input.shows[0].metadata,null);
  const beforeReset = readded.loadMetadata(assert.fail);
  cache.clear();
  hold.resolve();
  await Promise.all([old,beforeReset]);
  assert.deepEqual((await readStatisticsRecord(service,cache)).input,readded.input);
  pending = false;
  await (await readStatisticsRecord(service,cache)).loadMetadata(()=>{});
  const failure = Error('Personal record unavailable');
  await assert.rejects(readStatisticsRecord({store:{overviewRows:async()=>{throw failure;}}},cache),failure);
  assert.deepEqual((await readStatisticsRecord(service,cache)).input,readded.input);
});
function series(id, title, watches, options = {}) {
  const episodes = watches.map(([season, episode, times_watched, runtime = null]) => ({
    row: { show_id: id, show: title, season, episode, times_watched, title: 'Episode ' + episode, episode_id: null }, runtime,
  }));
  const metadata = options.missing || options.unfetched ? null : {
    show_id: id, show: title, seasons: [{ season: 1, episodeCount: 2 }], nextAirDate: null,
    lastAired: { season: 1, episode: 2 }, genres: [], networks: [], originCountries: [], firstAirDate: null,
    ...options.metadata,
  };
  return { id, title, posterPath: null, rating: options.rating ?? null, lists: options.lists ?? [], metadata, missing: options.missing ?? false,
    episodes, cast: options.cast ?? null, progress: watchProgress(id, episodes.map(e => e.row), [], metadata, today) };
}
function report(shows, countries = []) { return calculateStatistics({ shows, countries }); }
function rows(result, id) {
  return result.charts.find(chart => chart.id === id)?.rows.map(row => [row.label, row.value]) ?? [];
}

test('Statistics counts unique episodes and seasons, includes early marks and specials, and weights each known runtime by plays', () => {
  const shows = [
    series(10, 'Signal Boat', [[1, 1, 3, 40], [1, 2, 2, 40], [1, 3, 5, 35], [0, 1, 4, 15]], {
      rating: 0, metadata: { firstAirDate: '1999-02-01', voteAverage: 8.35 },
    }),
    series(20, 'Paper Lake', [[1, 1, 2, 30], [1, 2, 2], [2, 1, 2, 15]], { rating: 7.5, cast: [],
      metadata: { seasons: [{ season: 1, episodeCount: 2 }, { season: 2, episodeCount: 1 }],
        lastAired: { season: 2, episode: 1 }, firstAirDate: '2000-01-02', voteAverage: 0 },
    }),
    series(30, 'Lost Lantern', [[0, 2, 3], [3, 9, 1]], { rating: 8, missing: true }),
    series(40, 'Ahead', [[1, 1, 1]], { metadata: { lastAired: null } }),
    series(50, 'Only rated', [], { rating: 10, cast: [{ id: 44, name: 'Nobody' }] }),
  ];
  const result = report(shows);
  assert.deepEqual(result.totals, { shows: 4, seasons: 7, episodes: 10, plays: 25n, minutes: 525n, runtimeEpisodes: 6 });
  assert.equal(result.omittedShows, 1);
  assert.equal(result.missingCast, 2);
  assert.deepEqual(rows(result, 'rewatches'), [['First watches', 10n], ['Rewatches', 15n]]);
  assert.deepEqual(rows(result, 'plays-by-show'), [['Signal Boat', 14n], ['Paper Lake', 6n], ['Lost Lantern', 4n], ['Ahead', 1n]]);
  assert.deepEqual(rows(result, 'hours-by-show'), [['Signal Boat', 435n], ['Paper Lake', 90n]]);
  assert.deepEqual(rows(result, 'rewatched-shows'), [['Signal Boat', 2n], ['Paper Lake', 2n]]);
  assert.ok(!result.charts.some(chart => chart.id === 'rewatched-seasons' || chart.id === 'rewatched-episodes'));
  assert.deepEqual(rows(result, 'decades'), [['1990s', 1], ['2000s', 1]]);
  const gap = series(60, 'Archive broadcast', [[1, 1, 1]], { metadata: { firstAirDate: '1978-01-12' } });
  assert.deepEqual(rows(report([gap, shows[0]]), 'decades'), [['1970s', 1], ['1980s', 0], ['1990s', 1]]);
  assert.deepEqual(rows(result, 'ratings'), Array.from({ length: 21 }, (_, i) => [String(i / 2), [0, 15, 16].includes(i) ? 1 : 0]));
  assert.deepEqual(result.charts.find(chart => chart.id === 'tmdb').rows, [
    { label: 'Paper Lake', rating: 7.5, value: 0 }, { label: 'Signal Boat', rating: 0, value: 8.35 },
  ]);
});

test('Progress bands use the exact aired share on either side of each boundary and omit shows with no regular aired episodes', () => {
  const watched = [0, 24, 25, 49, 50, 74, 75, 99, 100];
  const shows = watched.map((n, i) => {
    const marks = Array.from({ length: n }, (_, j) => [1, j + 1, 1]);
    return series(i + 1, 'Folio ' + n, [[0, 1, 9], ...marks], {
      metadata: { seasons: [{ season: 1, episodeCount: 100 }], lastAired: { season: 1, episode: 100 } },
    });
  });
  shows.push(series(15, 'Zero aired', [[0, 1, 1]], { metadata: { lastAired: null } }),
    series(16, 'Unfetched', [[1, 1, 3]], { unfetched: true }));
  const result = report(shows);
  assert.deepEqual(rows(result, 'progress').map(([, count]) => count), [2, 2, 2, 2, 1]);
  assert.equal(result.omittedShows, 1);
});

test('Each critic chart pairs only watched, personally rated shows with that source, retaining zeroes and title order', () => {
  const shows = [
    series(1, 'Wave', [[1, 1, 2]], { rating: 0, unfetched: true }),
    series(2, 'Amber', [[0, 1, 1]], { rating: 7.5 }),
    series(3, 'Amber', [[1, 1, 1]], { rating: 10 }),
    series(4, 'Only rated', [], { rating: 5 }),
    series(5, 'Only watched', [[1, 1, 1]]),
    series(6, 'No critics', [[1, 1, 1]], { rating: 5 }),
  ];
  const critics = new Map([
    [1, { tomatoes: 0, metacritic: 100 }], [2, { tomatoes: 50, metacritic: null }],
    [3, { tomatoes: 90, metacritic: 0 }], [4, { tomatoes: 33, metacritic: 44 }],
    [5, { tomatoes: 88, metacritic: 77 }], [6, { tomatoes: null, metacritic: null, myanimelist: 8 }],
  ]);
  const calculate = scores => calculateStatistics({ shows: shows.toReversed(), countries: [], critics: scores });
  const comparisons = calculate(critics).charts.filter(chart => chart.kind === 'dots');
  assert.deepEqual(comparisons.map(chart => [chart.id, chart.rows]), [
    ['tomatoes', [{ label: 'Amber', value: 50, rating: 7.5 }, { label: 'Amber', value: 90, rating: 10 }, { label: 'Wave', value: 0, rating: 0 }]],
    ['metacritic', [{ label: 'Amber', value: 0, rating: 10 }, { label: 'Wave', value: 100, rating: 0 }]],
    ['myanimelist', [{ label: 'No critics', value: 8, rating: 5 }]],
  ]);
  assert.deepEqual(calculate(new Map([[2, critics.get(2)]])).charts.filter(chart => chart.kind === 'dots').map(chart => chart.id), ['tomatoes']);
  assert.ok(!calculate(undefined).charts.some(chart => chart.kind === 'dots'));
});

test('Every total, omission and chart uses the selected TV or Anime shows before aggregation or ranking', () => {
  const scored = new Map();
  const imdb = new Map();
  function make(id, lists, keywords, missing = false) {
    const title = 'Harbour ' + id;
    scored.set(id, { tomatoes: 70, metacritic: 85, myanimelist: id === 1 ? 0 : 8.5 });
    imdb.set(id, 7.2);
    return series(id, title, [[1, 1, id + 1, 10], [1, 2, 2, 20]], {
      missing, lists, rating: id / 2, cast: id === 2 ? null : [{ id, name: 'Actor ' + id }],
      metadata: { keywords: keywords.map(name => ({ id: 10, name })), firstAirDate: '2000-01-01',
        genres: [{ id, name: 'Genre ' + id }], networks: [{ id, name: 'Network ' + id }], originCountries: ['US'], voteAverage: 9 },
    });
  }
  const anime = [make(1, ['aNiMe'], [], true), make(2, ['Drama'], ['anime']), make(3, ['Anime'], ['anime'])];
  const tv = [make(4, ['Ánime'], ['animation']), make(5, ['Anime '], []), make(6, [], [], true)];
  const input = { shows: [...anime, ...tv], critics: scored, imdb, countries: [{ code: 'US', name: 'United States' }] };
  const all = calculateStatistics(input), reportTV = calculateStatistics(input, 'tv'), reportAnime = calculateStatistics(input, 'anime');
  assert.equal(all.charts.length, 16);
  assert.deepEqual(reportTV, calculateStatistics({ ...input, shows: tv }));
  assert.deepEqual(reportAnime, calculateStatistics({ ...input, shows: anime }));
  for (const key of Object.keys(all.totals)) assert.equal(all.totals[key], reportTV.totals[key] + reportAnime.totals[key], key);
  assert.deepEqual([reportTV.omittedShows, reportAnime.omittedShows, reportTV.missingCast, reportAnime.missingCast], [1, 1, 0, 1]);
  assert.deepEqual(rows(reportAnime, 'myanimelist'), [['Harbour 1', 0], ['Harbour 2', 8.5], ['Harbour 3', 8.5]]);
});

test('Genres and networks count weighted hours in each credit; cast and countries count a person or country only once per watched show', () => {
  const person = (id, name) => ({ id, name });
  const groupA = person(1, 'Night'), groupB = person(2, 'Arc');
  const shows = [
    series(10, 'Quiet', [[1, 1, 2, 30]], { rating: 0, cast: [person(9, 'Echo'), person(9, 'Echo'), person(10, 'Echo')],
      metadata: { genres: [groupA, groupA, groupB], networks: [groupA, groupB], originCountries: ['ZZ', 'ZZ', 'FR'],
        firstAirDate: '2001-07-01', voteAverage: 5 } }),
    series(20, 'Spring', [[1, 1, 1, 20]], { cast: [person(9, 'Echo'), person(11, 'Ángel'), person(12, 'Zen')],
      metadata: { genres: [groupB], networks: [groupA], originCountries: ['FR'] } }),
    series(30, 'Calendar', [[1, 1, 1]], { cast: [], metadata: { genres: [person(51, 'No runtime')] } }),
    series(40, 'Nothing watched', [], { cast: [person(10, 'Echo')] }),
  ];
  const countries = [{ code: 'FR', name: 'France' }];
  const result = report(shows, countries);
  assert.deepEqual(rows(result, 'genres'), [['Arc', 80n], ['Night', 60n]]);
  assert.deepEqual(rows(result, 'networks'), [['Night', 80n], ['Arc', 60n]]);
  assert.deepEqual(rows(result, 'countries'), [['France', 2n], ['ZZ', 1n]]);
  assert.deepEqual(rows(result, 'cast'), [['Echo', 2n], ['Echo', 1n], ['Zen', 1n], ['Ángel', 1n]]);
  assert.deepEqual(result.charts.map(chart => chart.id), ['plays-by-show', 'hours-by-show', 'rewatches',
    'ratings', 'decades', 'progress', 'genres', 'networks', 'countries', 'cast', 'tmdb']);
  assert.deepEqual(report([...shows].reverse(), countries), result);
});

test('The top ten shows by plays and hours and the five most rewatched shows use Library title order after numeric ties', () => {
  const shows = Array.from({ length: 13 }, (_, i) => series(i + 1, 'Studio ' + String.fromCharCode(65 + i),
    [[10, 1, 2, 15], [2, 1, 2, 15]], { metadata: {
      seasons: [{ season: 10, episodeCount: 1 }, { season: 2, episodeCount: 1 }], lastAired: { season: 10, episode: 1 },
    }, cast: [{ id: i + 1, name: 'Person ' + String.fromCharCode(65 + i) }] }));
  const result = report(shows.reverse());
  assert.equal(rows(result, 'cast').length, 8);
  for (const id of ['plays-by-show','hours-by-show']) {
    assert.deepEqual(rows(result,id).map(([title]) => title),Array.from('ABCDEFGHIJ',letter => 'Studio ' + letter));
  }
  assert.deepEqual(rows(result, 'rewatched-shows').map(([title]) => title), Array.from('ABCDE', letter => 'Studio ' + letter));
  const tied = report([
    series(1, 'A', [[1, 1, 2, 45]]), series(2, 'Z', [[1, 1, 3, 30]]),
  ]);
  assert.deepEqual(rows(tied, 'hours-by-show'), [['A', 90n], ['Z', 90n]]);
});

test('Very large play totals and weighted runtimes retain exact values when ranked one play or minute apart', () => {
  const n = Number.MAX_SAFE_INTEGER;
  const result = report([
    series(1, 'Amber', [[1, 1, n, n]]),
    series(2, 'Zinc', [[1, 1, n, n], [1, 2, 1, 1]]),
  ]);
  const large = BigInt(n), minutes = large * large;
  assert.equal(result.totals.plays, 2n * large + 1n);
  assert.equal(result.totals.minutes, 2n * minutes + 1n);
  assert.deepEqual(rows(result, 'plays-by-show'), [['Zinc', large + 1n], ['Amber', large]]);
  assert.deepEqual(rows(result, 'hours-by-show'), [['Zinc', minutes + 1n], ['Amber', minutes]]);
});

test('An empty record has no charts, while keyless records keep file-only charts and omit unsupported scores', () => {
  assert.deepEqual(report([series(1, 'Only listed', [], { rating: 4 })]), {
    totals: { shows: 0, seasons: 0, episodes: 0, plays: 0n, minutes: 0n, runtimeEpisodes: 0 },
    omittedShows: 0, missingCast: 0, charts: [],
  });
  const noCache = report([series(2, 'Missing metadata', [[1, 1, 2]], { unfetched: true, rating: 9 })]);
  assert.deepEqual(noCache.charts.map(chart => chart.id), ['plays-by-show', 'rewatches', 'ratings']);
  assert.equal(noCache.omittedShows, 1);
  const legacy = report([series(2, 'Old cache', [[1, 1, 1]], { rating: 0 })]);
  assert.ok(!legacy.charts.some(chart => chart.id === 'tmdb'));
  assert.equal(legacy.missingCast, 1);
  assert.equal(legacy.totals.runtimeEpisodes, 0);
  const knownZero = report([series(4, 'Interlude', [[1, 1, 2, 0]], { metadata: { genres: [{ id: 1, name: 'Short' }] } })]);
  assert.equal(knownZero.totals.runtimeEpisodes, 1);
  assert.deepEqual(rows(knownZero, 'hours-by-show'), [['Interlude', 0n]]);
  assert.deepEqual(rows(knownZero, 'genres'), [['Short', 0n]]);
});
