import { connectFixtureProviders } from './provider-fixture-cases.mjs';
import { openDeviceStore } from '../dist/storage.js';
import { tmdbResourceKey, TmdbError } from '../dist/tmdb-client.js';
import { TmdbService } from '../dist/tmdb-service.js';
import { TmdbDetailJob } from '../dist/tmdb-refresh.js';
import { WatchActions } from '../dist/watch-actions.js';
import { prepareExport } from '../dist/export-data.js';
import { readLocalRecord } from '../dist/local-restore.js';

const id = 454;
function check(value, message) { if (!value) throw Error(message); }
function barrier() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
const row = (episode, episode_id, times_watched) => ({
  show_id: id, show: 'Paper Harbour', season: 1, episode, episode_id, title: 'Episode ' + episode_id, times_watched,
});
const normalizedSeason = (season, ids) => ({ show_id: id, name: 'Season ' + season, season, posterPath: null,
  episodes: ids.map((episode_id, i) => ({ episode_id, episode: i + 1, title: 'Episode ' + episode_id,
    airDate: null, overview: '', stillPath: null, runtime: null })) });
const seasons = [1, 2, 3].map(season => ({ season, episodeCount: 2, name: 'Season ' + season }));
const show = { show_id: id, show: 'Paper Harbour', seasons };
const asKey = (kind, season) => tmdbResourceKey({ kind, id, season });
const asRaw = (s, ids) => ({ season_number: s, episodes: ids.map((id, n) => ({ id, episode_number: n + 1, name: 'Episode ' + id })) });
const pending = { content: 'unacknowledged fictional bytes', targetRevision: 'base-A', targetModified: null,
  targetContent: 'previously synced fictional bytes', clientModified: '2026-11-01T00:00:00Z', preparedAt: 12 };
const sync = { base: { revision: pending.targetRevision, content: pending.targetContent }, pending, lastClientModified: null };

export async function episodeRepairCases(run) {
  await run('A cold detail job finds a cross-season swap before either season screen opens', async () => {
    const name = 'csvtv-cold-season-swap-' + crypto.randomUUID();
    let store = await openDeviceStore({ name });
    const now = Date.now(), started = new Set(), both = barrier();
    const environment = { now: () => now, online: () => true, visible: () => true };
    const client = { async request(resource) {
      if (resource.kind === 'configuration') return {images:{secure_base_url:'https://image.tmdb.org/t/p/',
        poster_sizes:[], backdrop_sizes:[], still_sizes:[], profile_sizes:[]}};
      if (resource.kind === 'show') return {id, name:show.show, status:'Ended', keywords:{results:[]}, external_ids:{},
        seasons:[1,2].map(s => ({season_number:s, episode_count:1}))};
      started.add(resource.season);
      if (started.size === 2) both.resolve();
      await both.promise;
      return asRaw(resource.season, [resource.season === 1 ? 22 : 11]);
    }};
    const service = new TmdbService(store, client, environment);
    try {
      const initial = await connectFixtureProviders(store,name,[{setting:'tmdb_key',value:'fictional-swap'}]);
      await store.commit(initial.revision,{put:{watched:[row(1,11,3), {...row(1,22,5), season:2}]}});
      const job = new TmdbDetailJob({ active:() => true, now:() => now, today:() => '2026-11-01',
        record:async () => ({tables:(await store.snapshot()).tables, statisticsOpened:false}),
        read:resource => service.read(resource), refresh:resource => service.refresh(resource,true) });
      await job.run();
      const review = await service.repairPreview(id);
      check(review.moves.length === 2 && !review.missing.length, 'Show cannot offer Review after the detail job finished');
      check(await service.updateRepair(review), 'A coherent cross-season swap could not be approved');
      store.close(); store = await openDeviceStore({name});
      const saved = await store.snapshot();
      check(JSON.stringify(saved.tables.watched.map(r => [r.season,r.episode_id,r.times_watched])) === '[[1,22,5],[2,11,3]]',
        'Reopening after Review changed an episode identity or its plays');
    } finally { both.resolve(); service.close(); store.close(); indexedDB.deleteDatabase(name); }
  });

  await run('Background repair shares only overlapping sibling reads before a provider reply', async () => {
    const name = 'csvtv-season-observation-' + crypto.randomUUID(), store = await openDeviceStore({name});
    const now = Date.now(), pending = new Map(), all = [];
    const client = { async request(resource) {
      const waiting = pending.get(resource.id + '/' + resource.season);
      waiting.started.resolve();
      await waiting.reply.promise;
      if (waiting.fail) throw new TmdbError('unreachable');
      const raw = asRaw(resource.season,[100 + resource.season]);
      const episodes = raw.episodes;
      Object.defineProperty(raw,'episodes',{get() { waiting.normalized.resolve(); return episodes; }});
      return raw;
    }};
    const service = new TmdbService(store,client,{now:() => now,online:() => true,visible:() => true});
    function start(showId, season, background = true, fail = false) {
      const waiting = {started:barrier(),reply:barrier(),normalized:barrier(),fail};
      pending.set(showId + '/' + season,waiting);
      const work = service.refresh({kind:'season',id:showId,season},background);
      all.push(work.catch(() => {}));
      return {...waiting,work};
    }
    const release = service.holdRecordChanges();
    try {
      await connectFixtureProviders(store,name,[{setting:'tmdb_key',value:'fictional-observation'}]);
      const first = start(id,1), sibling = start(id,2), other = start(id+1,1), foreground = start(id,3,false);
      await Promise.all([first,sibling,other,foreground].map(x => x.started.promise));
      first.reply.resolve(); await first.normalized.promise;
      const later = start(id,4); await later.started.promise;
      sibling.reply.resolve(); await sibling.normalized.promise;
      const overlapsLater = start(id,5); await overlapsLater.started.promise;
      for (const pending of [other,foreground,later,overlapsLater]) pending.reply.resolve();
      release();
      const entries = await Promise.all([first,sibling,other,foreground,later,overlapsLater].map(x => x.work));
      const groups = entries.map(entry => entry.repairScan.group);
      check(groups[0] === groups[1] && groups[4] === groups[5] && new Set(groups).size === 4,
        'A foreground, unrelated or post-reply season shared stale evidence');
      const failed = start(id,6,true,true);
      await failed.started.promise; failed.reply.resolve();
      try { await failed.work; throw Error('Failed season refresh resolved'); }
      catch (error) { check(error.kind === 'unreachable','Unexpected failure for a missing provider reply'); }
      check(!await service.read({kind:'season',id,season:6}), 'Failed season created evidence');
      const retry = start(id,6); await retry.started.promise; retry.reply.resolve();
      check(!groups.includes((await retry.work).repairScan.group), 'Sequential background refresh reused evidence');
    } finally {
      release();
      for (const waiting of pending.values()) waiting.reply.resolve();
      await Promise.all(all); service.close(); store.close(); indexedDB.deleteDatabase(name);
    }
  });

  await run('An interrupted TMDB relocation search cannot merge a still-moving episode, including after reopening the database', async () => {
    const name = 'csvtv-renumbered-' + crypto.randomUUID();
    let store = await openDeviceStore({ name }), service;
    const previous = Date.now() - 60_000;
    let now = previous + 100, online = true;
    const paused = barrier(), release = barrier(), requested = [];
    let first = true;
    const client = { async request(resource) {
      requested.push(resource.kind + '/' + (resource.season ?? ''));
      if (resource.kind === 'show') return { id, name: show.show, status: 'Ended', keywords: { results: [] }, external_ids: {},
        seasons: seasons.map(s => ({ season_number: s.season, episode_count: s.episodeCount })) };
      if (resource.season === 1) return asRaw(1, [22]);
      if (resource.season === 2) {
        if (first) { paused.resolve(); await release.promise; throw Error('Provider request interrupted'); }
        return asRaw(2, [55, 11]);
      }
      return asRaw(3, [66]);
    } };
    const environment = { now: () => now, visible: () => true, online: () => online };
    function currentFigures(snapshot) {
      return snapshot.tables.watched.map(r => [r.season, r.episode, r.episode_id, r.times_watched]);
    }
    try {
      const initial = await connectFixtureProviders(store,name,[{setting:'tmdb_key',value:'fictional-renumbering'}]);
      await store.commit(initial.revision, { put: {
        watched: [row(1, 11, 3), row(2, 22, 4)] }, local: { recentlyMarked: [id] }, sync: { watched: sync } });
      const entries = { [asKey('show')]: { fetchedAt: previous, value: show } };
      for (const [s, ids] of [[1, [11, 22]], [2, [55]], [3, [66]]]) {
        entries[asKey('season', s)] = { fetchedAt: previous, value: normalizedSeason(s, ids) };
      }
      await store.writeTmdb((await store.tmdbState()).generation, { entries });
      service = new TmdbService(store, client, environment);
      const checking = service.refresh({ kind: 'season', id, season: 1 });
      await paused.promise;
      const partial = await service.repairPreview(id);
      release.resolve();
      await checking;
      check(!partial.missing.length && !partial.moves.length, 'In-flight search merged an occupant using older season data');
      check(requested.includes('season/3'), 'One failed season starved the remaining lookup');
      await store.close();
      store = await openDeviceStore({ name });
      await connectFixtureProviders(store,name);
      service.close();
      service = new TmdbService(store, client, environment);
      online = false;
      const reopened = await service.repairPreview(id);
      check(!reopened.missing.length && !reopened.moves.length, 'The failed lookup looked complete after reopening offline');
      online = true; first = false; now += 10;
      await service.refresh({ kind: 'season', id, season: 1 });
      const found = await service.repairPreview(id);
      check(found.moves.length === 2 && found.moves.every(move => !move.occupied), 'Fresh coverage failed to separate both moves');
      const target = { ...row(2, 11, 1), season:2 };
      const actions = new WatchActions(service, async()=>true, ()=>{}, ()=>{});
      let refused = false;
      try { await actions.episode(target,'mark'); } catch (error) { refused = /review/i.test(error.message); }
      check(refused, 'Marking the moved episode before review created another stable ID');
      check(JSON.stringify(currentFigures(await store.snapshot())) === '[[1,1,11,3],[1,2,22,4]]', 'Discovery changed a position');
      check(await service.updateRepair(found), 'The reviewed move did not commit');
      check(!await service.updateRepair(found), 'A second approval applied the same move twice');
      const copy = await readLocalRecord((await prepareExport(service,'record')).files);
      check(copy.watched.length === 2 && new Set(copy.watched.map(r=>r.episode_id)).size === 2,
        'The repaired record could not be recovered from its four-file export');
      store.close(); store = await openDeviceStore({ name });
      const saved = await connectFixtureProviders(store,name);
      check(JSON.stringify(currentFigures(saved)) === '[[1,1,22,4],[2,2,11,3]]', 'Reopening lost repaired episode identities or counts');
      check(JSON.stringify(saved.sync.watched) === JSON.stringify(sync) && saved.local.recentlyMarked.join() === String(id),
        'Repair rewrote the last synced base, pending upload or Recently marked');
    } finally {
      release.resolve(); service?.close(); store.close(); indexedDB.deleteDatabase(name);
    }
  });

  await run('Approval is bound to current metadata, record and account; aborting a swap after the first write rolls back both rows', async () => {
    const name = 'csvtv-repair-commit-' + crypto.randomUUID();
    let store = await openDeviceStore({ name }), service;
    const now = Date.now();
    const env = { now: () => now, online: () => false, visible: () => true };
    const source = [row(1, 11, 2), row(2, 22, 2)];
    try {
      const initial = await connectFixtureProviders(store,name,[{setting:'tmdb_key',value:'fixture-repair-commit'}]);
      await store.commit(initial.revision, { put: { watched: source },
        sync: { watched: sync } });
      const { generation } = await store.tmdbState();
      const seasonKey = asKey('season', 1);
      const entry = ids => ({ fetchedAt: now, value: normalizedSeason(1, ids) });
      await store.writeTmdb(generation, { entries: { [asKey('show')]: { fetchedAt: now, value: { ...show, seasons: [seasons[0]] } },
        [seasonKey]: entry([22, 11]) } });
      service = new TmdbService(store, {}, env);
      const first = await service.repairPreview(id);
      check(first.moves.length === 2, 'Expected a swap');
      const originalCommit = store.commit.bind(store);
      store.commit = async (revision, patch, options) => {
        store.commit = originalCommit;
        await store.writeTmdb(generation, { entries: { [seasonKey]: entry([11, 22]) } });
        check((await store.snapshot()).revision === revision, 'The metadata-only change should retain its record revision');
        return originalCommit(revision, patch, options);
      };
      check(!await service.updateRepair(first) && JSON.stringify((await store.snapshot()).tables.watched) === JSON.stringify(source),
        'Old destination accepted after a metadata-only change between reads and commit');

      await store.writeTmdb(generation, { entries: { [seasonKey]: entry([22, 11]) } });
      const approvedForA = await service.repairPreview(id);
      const release = service.holdRecordChanges();
      const waiting = service.updateRepair(approvedForA);
      await store.commit((await store.snapshot()).revision, { local: { syncAccountId: 'fiction-B' } });
      release();
      check(!await waiting, 'A held approval survived switching Dropbox accounts');

      const retry = await service.repairPreview(id);
      const put = IDBObjectStore.prototype.put;
      let watchedWrites = 0;
      IDBObjectStore.prototype.put = function (...args) {
        if (this.name === 'watched' && ++watchedWrites === 2) throw new DOMException('Fixture write interrupted', 'QuotaExceededError');
        return put.apply(this, args);
      };
      let failure;
      try { await service.updateRepair(retry); } catch (error) { failure = error; }
      finally { IDBObjectStore.prototype.put = put; }
      check(watchedWrites === 2 && failure?.name === 'QuotaExceededError', 'Second write did not reach the injected quota error');
      service.close(); store.close(); store = await openDeviceStore({ name });
      const reopened = await store.whenWriter();
      check(JSON.stringify(reopened.tables.watched) === JSON.stringify(source) && JSON.stringify(reopened.sync.watched) === JSON.stringify(sync),
        'Failed swap changed the record or pending state after reopen');
      service = new TmdbService(store, {}, env);
      check(await service.updateRepair(await service.repairPreview(id)), 'Retry could not save the swap');
      check((await store.snapshot()).tables.watched.map(r => r.episode_id).join() === '22,11', 'Equal counts hid an identity change');
    } finally { service?.close(); store.close(); indexedDB.deleteDatabase(name); }
  });

  await run('A removed season and a season returning 404 both trigger discovery in the remaining seasons', async () => {
    for (const omitted of [true, false]) {
      const name = 'csvtv-retired-season-' + crypto.randomUUID();
      const store = await openDeviceStore({ name });
      const now = Date.now(), requests = [];
      const client = { async request(resource) {
        requests.push(resource.kind + '/' + (resource.season ?? ''));
        if (resource.kind === 'show') return { id, name: show.show, status: 'Ended', keywords: { results: [] }, external_ids: {},
          seasons: (omitted ? [2] : [1, 2]).map(s => ({ season_number: s, episode_count: 1 })) };
        if (resource.season === 1) throw new TmdbError('not-found');
        return asRaw(2, [11]);
      } };
      const service = new TmdbService(store, client, { now: () => now, online: () => true, visible: () => true });
      try {
        const initial = await connectFixtureProviders(store,name,[{setting:'tmdb_key',value:'fictional-removed-season'}]);
        await store.commit(initial.revision, { put: { watched: [row(1, 11, 3), row(2, 22, 1)] } });
        if (omitted) await service.refresh({ kind: 'show', id });
        else await service.refresh({ kind: 'season', id, season: 1 });
        const review = await service.repairPreview(id);
        check(requests.includes('season/2') && requests.includes('season/1') !== omitted, 'Incorrect season discovery requests');
        check(review.moves.length === 1 && review.moves[0].to.season === 2 && review.missing[0]?.episode_id === 22,
          'Move from a removed season was dropped or its unmatched row was lost');
        check(await service.updateRepair(review), 'Confirmed cross-season move failed');
        const rows = (await store.snapshot()).tables.watched;
        check(rows[0].season === 1 && rows[0].episode_id === 22 && rows[1].season === 2 && rows[1].times_watched === 3,
          'The confirmed move changed a row missing from all seasons');
      } finally { service.close(); store.close(); indexedDB.deleteDatabase(name); }
    }
  });
}
