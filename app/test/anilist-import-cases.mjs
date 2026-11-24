import { readAniListArchive } from '../dist/anilist-archive.js';
import { fetchAniListMapping } from '../dist/anilist-mapping.js';
import { resolveAniList } from '../dist/anilist-placement.js';
import { applyAniListImport, planAniListImport, describeImportChanges } from '../dist/anilist-import.js';
import { recordExportFiles } from '../dist/export-data.js';
import { TmdbClient, tmdbResourceKey } from '../dist/tmdb-client.js';
import { TmdbService } from '../dist/tmdb-service.js';
import { withTraktDevices as withDevices } from './trakt-import-cases.mjs';

function check(ok, message) { if (!ok) throw Error(message); }
function unexpected() { throw Error('Unexpected import prerequisite'); }
const hooks = {active:() => true, online:() => true, backup:unexpected, preflight:unexpected, confirm:unexpected};
const planning = { show_id:301, show:'Paper Harbor' };
const watching = { show_id:302, show:'Lake Radio' };

async function resolveSample(store) {
  const gdpr = {
    lists: [
      {series_type:0, series_id:101, status:1, score:80, progress:0, repeat:0},
      {series_type:0, series_id:102, status:3, score:75, progress:2, repeat:1},
    ],
    favourites:[{favourite_type:1, favourite_id:102}], user:{email:'unused-private-field@example.invalid'},
  };
  const data = await readAniListArchive(new Blob([JSON.stringify(gdpr)]));
  const client = new TmdbClient({fetch:async input => {
    const path = new URL(input).pathname;
    const show = path === '/3/tv/301' ? planning : path === '/3/tv/302' ? watching : null;
    if (show) return Response.json({id:show.show_id, name:show.show, status:'Ended', first_air_date:'2020-02-01',
      seasons:[{season_number:1, name:'Season 1', episode_count:2}], keywords:{results:[]}, external_ids:{}});
    check(path === '/3/tv/302/season/1', 'Unexpected provider route during placement');
    return Response.json({season_number:1, episodes:[1,2].map(n => ({
      id:3020 + n, name:'Chapter ' + n, episode_number:n, runtime:25, air_date:'2020-02-01',
    }))});
  }});
  const service = new TmdbService(store, client);
  try {
    return await resolveAniList(data, service, {fetchMapping:async () => Response.json([101,102].map(id => ({
      anilist_id:id, anidb_id:id, type:'TV', themoviedb_id:{tv:id+200}, season:{tmdb:1},
    })))});
  } finally { service.close(); }
}

async function exportedRecord(store) {
  const files = recordExportFiles(await store.exportSnapshot(false, Date.now()), Date.now());
  return Promise.all(files.map(async file => [file.name, await file.text()]));
}

export async function aniListWorkflowCases(run) {
  await run('The anonymous mapping limit survives a database restart and an older reply cannot cross device erasure',
    () => withDevices(async ({open})=>{
      let {store,name} = await open();
      const now = 100_000, ids = new Set([101]);
      const send = async () => new Response(null,{status:429,headers:{'Retry-After':'120'}});
      const read = (transport) => fetchAniListMapping(ids,undefined,transport,{store,now:()=>now});
      async function expectLimit(work) {
        try { await work; } catch (error) {check(error.message.includes('limiting downloads'),'Unexpected mapping error');return;}
        throw Error('Anonymous file download should have been limited');
      }
      await expectLimit(read(send));
      store.close();
      store = (await open(name)).store;
      await expectLimit(read(unexpected));
      const previous = await store.mappingGate();
      check(previous.until === now + 120_000,'A restarted importer lost its file-host deadline');
      await store.eraseDevice((await store.snapshot()).revision);
      await store.saveMappingGate(previous.epoch,now + 600_000);
      check((await store.mappingGate()).until === 0,'An erased import reintroduced the old file-host limit');
    }));
  await run('AniList preflight rechecks Planning, kept ratings and list spelling, and two linked devices converge after backup', () =>
    withDevices(async ({linked, provider}) => {
      const a = await linked(), b = await linked();
      const placement = await resolveSample(a.store);
      const choices = {seasonExtras:new Map([[302,new Map([[1,1]])]]),wholeShowPasses:new Map([[302,1]])};
      const original = planAniListImport(placement, await a.store.snapshot(), choices);
      check(original.watched.every(row => row.after === 4),'The initial season and whole-show passes were dropped');
      check(original.lists.some(item => item.row.list === 'Watchlist'), 'The preview omitted the unwatched Planning show');
      await b.store.commit((await b.store.snapshot()).revision, {put:{
        watched:[{...planning, season:1, episode:1, episode_id:3011, title:'Opening', times_watched:1}],
        ratings:[{...planning, rating:9}], lists:[{...planning, list:'anime'}],
      }});
      await b.sync();
      const linkedHooks = {...hooks, preflight:a.sync, backup:a.backup};
      let reviews = 0;
      const canceled = await applyAniListImport(a.store, placement, original, {...linkedHooks, backup:unexpected,
        confirm:async (revised, before) => {
          reviews++;
          check(revised.watched.every(row => row.after === 4),'Preflight discarded the original count edits');
          check(revised.ratings.some(row => row.row.show_id === 301 && row.after === 9) &&
            !revised.lists.some(item => item.row.show_id === 301 && item.row.list === 'Watchlist') &&
            revised.lists.some(item => item.row.show_id === 302 && item.row.list === 'anime'),
          'The new watch, rating or list spelling was missing from the revised proposal');
          const changes = describeImportChanges(revised, before);
          check(changes.some(line => line.includes('Anime filter')) && changes.some(line => line.includes('9')), 'Reconfirmation omitted the changes');
          return false;
        }});
      let snapshot = await a.store.snapshot();
      check(!canceled && reviews === 1 && snapshot.tables.watched.length === 1 && snapshot.tables.lists.length === 1,
        'Cancel reverted the sync or applied import rows');
      let backups = 0;
      const saved = await applyAniListImport(a.store, placement, planAniListImport(placement, snapshot, choices), {...linkedHooks,
        backup: async owner => {
          await a.backup(owner);
          if (++backups === 1) await a.store.commit((await a.store.snapshot()).revision, {put:{ratings:[{...watching, rating:6}]}});
        },
        confirm: async revised => { reviews++; return revised.ratings.some(row => row.row.show_id === 302 && row.after === 6); }});
      check(saved && backups === 2 && reviews === 2, 'A changed rating during backup bypassed fresh approval');
      await a.sync(); await b.sync();
      snapshot = await b.store.snapshot();
      check(snapshot.tables.watched.length === 3 && snapshot.tables.watched.filter(row => row.times_watched === 4).length === 2 &&
        snapshot.tables.lists.filter(row => row.list === 'anime').length === 2 &&
        ['Dropped','Favorites'].every(name => snapshot.tables.lists.some(row => row.show_id === 302 && row.list === name)) &&
        !snapshot.tables.lists.some(row => row.show_id === 301 && row.list === 'Watchlist'), 'The confirmed record did not reach the other device');
      for (const file of provider.files.values()) check(!new TextDecoder().decode(file.bytes).includes('unused-private-field'),
        'The original export leaked into a synced file');
    }));

  await run('An import with every personal row already present restores its matched metadata and syncs the resulting summary', () =>
    withDevices(async ({open,provider}) => {
      let {store,name,sync,backup} = await open();
      const placement = await resolveSample(store), empty = await store.snapshot();
      await store.commit(empty.revision, planAniListImport(placement, empty).changes);
      await sync();
      const snapshot = await store.snapshot(), plan = planAniListImport(placement,snapshot);
      check(Object.values(plan.changes.put).every(rows=>!rows.length) && placement.cache.size === 3,
        'Fixture needs an exact personal record and three newly fetched metadata entries');
      const exported = JSON.stringify(await exportedRecord(store));
      const today = new Date().toISOString().slice(0,10);
      let exportsChanged = 0, summaryChanged = 0;
      store.addEventListener('summarychange',()=>summaryChanged++);
      store.addEventListener('exportchange',()=>exportsChanged++);
      const saved = await applyAniListImport(store,placement,plan,{...hooks,preflight:sync,backup:async owner=>{
        await backup();
        await store.saveDropboxStatus({...owner,synced:true,reason:'',day:today,notices:[]},()=>true);
      }});
      check(saved && (await store.dropboxState()).dirty && summaryChanged && exportsChanged,
        'A matching record silently dropped the newly fetched metadata or its export notifications');
      check((await store.snapshot()).revision === snapshot.revision && JSON.stringify(await exportedRecord(store)) === exported,
        'Caching an identical import rewrote the personal record');
      store.close();
      ({store,sync} = await open(name));
      const cached = await store.tmdbEntries([...placement.cache.keys()],Date.now());
      check(cached.every(entry=>entry?.value),'An identical import left missing show or season details after reopening');
      await sync();
      const summary = new TextDecoder().decode(provider.files.get('/summary.csv')?.bytes);
      check(summary.includes('Lake Radio,2020,1,2,2,'),'The next sync missed the season completion in the refreshed summary');
    }));

  await run('A failed AniList save rolls back the staged TMDB data and all four CSVs, and reimporting the same file is idempotent after reopen', () =>
    withDevices(async ({open}) => {
      let {store, name, sync, backup} = await open();
      const placement = await resolveSample(store);
      const original = planAniListImport(placement, await store.snapshot());
      const empty = JSON.stringify(await exportedRecord(store));
      const offer = {...hooks,preflight:()=>sync(),backup:()=>backup()};
      let aborted = false, failed = false;
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function(value) {
        const req = put.apply(this, arguments);
        if (!aborted && this.name === 'shows') {
          aborted = true;
          req.addEventListener('success', () => this.transaction.abort(), {once:true});
        }
        return req;
      };
      try { await applyAniListImport(store, placement, original, offer); }
      catch { failed = true; }
      finally { IDBObjectStore.prototype.put = put; }
      store.close();
      ({store,sync,backup} = await open(name));
      const key = tmdbResourceKey({kind:'show',id:302});
      check(aborted && failed && JSON.stringify(await exportedRecord(store)) === empty &&
        !(await store.tmdbEntries([key], Date.now()))[0], 'Failed import left rows or matching metadata on disk');
      check(await applyAniListImport(store, placement, planAniListImport(placement, await store.snapshot()), offer), 'Retry failed');
      const saved = JSON.stringify(await exportedRecord(store));
      check(saved !== empty && !saved.includes('unused-private-field') && (await store.tmdbEntries([key], Date.now()))[0],
        'Retry missed the staged metadata or produced incorrect recovery files');
      store.close();
      ({store,sync,backup} = await open(name));
      await sync();
      const again = await resolveSample(store), snapshot = await store.snapshot();
      await applyAniListImport(store, again, planAniListImport(again, snapshot), offer);
      check(JSON.stringify(await exportedRecord(store)) === saved && (await store.snapshot()).revision === snapshot.revision,
        'A repeated import rewrote the record');
    }));
}
