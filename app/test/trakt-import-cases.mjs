import { DropboxProviderSettings } from '../dist/dropbox-provider-settings.js';
import { openDeviceStore } from '../dist/storage.js';
import { planTraktImport, applyTraktImport, describeTraktChanges } from '../dist/trakt-import.js';
import { DropboxAuth } from '../dist/dropbox-auth.js';
import { DropboxApi } from '../dist/dropbox-api.js';
import { DropboxSync } from '../dist/dropbox-sync.js';
import { writeBackup } from '../dist/dropbox-backup.js';
import { publishDerived } from '../dist/dropbox-derived.js';
import { readCsv, writeCsv } from '../dist/csv.js';
import { fictionalDropboxTransport } from './dropbox-roundtrip-cases.mjs';

const title = { show_id: 72, show: 'Fictional Estuary', year: 2024, imdb_id: 'tt1234567' };
const episode = { show_id: 72, show: title.show, season: 1, episode: 1, episode_id: 7211, title: 'Tide', times_watched: 1 };
const rating = value => ({ show_id: 72, show: title.show, rating: value });
const unexpected = message => () => { throw Error(message); };
function check(result, message) { if (!result) throw Error(message); }
async function rejects(fn, pattern) {
  try { await fn(); } catch (error) { check(pattern.test(error.message), 'Unexpected failure: ' + error.message); return; }
  throw Error('Expected the import to stop');
}
const base = { active: () => true, online: () => true, confirm: unexpected('Unexpected reconfirmation'),
  preflight: unexpected('Unexpected Dropbox sync'), backup: unexpected('Unexpected Dropbox backup') };
const session = () => ({ accountId: 'fictional-owner', appKey:'example-app', instanceId: crypto.randomUUID(), accessToken: 'example-access',
  refreshToken: 'example-refresh', accessExpiresAt: Date.now() + 600000, signInDeadline: Date.now() + 86400000, providerExpiresAt: Date.now() + 86400000 });
const bytes = tables => ['watched', 'ratings', 'lists', 'shows'].map(name => writeCsv(name, tables[name])).join('\0');
function placed(snapshot) {
  return { shows: [title], watched: [episode], ratings: [rating(8)], lists: [{ show_id: title.show_id, show: title.show, list: 'Favorites' }],
    skipped: [], counts: [{ show_id: 72, show: title.show, total: 3, listedPlays: 1, listedEpisodes: 1, multiple: 3 }],
    cache: new Map(), generation: snapshot.tmdbGeneration, reusedPositions: new Set() };
}

export async function withTraktDevices(exercise) {
  const names = new Set(), opened = [], auths = [];
  const provider = fictionalDropboxTransport();
  async function open(name = 'csvTV-trakt-' + crypto.randomUUID()) {
    names.add(name);
    const store = await openDeviceStore({ name });
    opened.push(store);
    await store.whenWriter();
    const binding = (await store.dropboxAuthState()).session ?? session();
    await store.storeExchangedSession(binding);
    const auth = new DropboxAuth(store, 'example-app', { transport: provider.transport });
    auths.push(auth);
    const api = new DropboxApi(auth, binding);
    const keys = new DropboxProviderSettings(store,api,binding,Date.now,()=>true,unexpected('Unexpected migration conflict'));
    store.connectProviderKeys((...args)=>keys.save(...args),Date.now);
    await keys.load();
    if (!(await store.tmdbState()).token) {
      await store.commit((await store.snapshot()).revision,{put:{settings:[{setting:'tmdb_key',value:'example-key'}]}});
    }
    async function sync() {
      const result = await new DropboxSync(store,api,binding,{},Date.now,()=>keys.load()).run({ retryCanceled: true });
      if (!result.complete) throw Error(result.reason);
      await publishDerived(store, api, result.listing, binding, Date.now());
    }
    return { name, store, auth, sync, backup: () => writeBackup(api) };
  }
  try { await exercise({ open, linked:open, provider }); }
  finally {
    for (const auth of auths) auth.close();
    for (const store of opened) store.close();
    for (const name of names) {
      const request = indexedDB.deleteDatabase(name);
      await new Promise((ok, fail) => { request.onsuccess = ok; request.onerror = () => fail(request.error); });
    }
  }
}

export async function traktImportWorkflowCases(run) {
  await run('A Trakt import cannot revive a stale Recently marked entry from an earlier build', () =>
    withTraktDevices(async ({open}) => {
      const {store, name, sync, backup} = await open();
      const other = {...episode, show_id: 73, show: 'Fictional Tributary', episode_id: 7311};
      await store.commit((await store.snapshot()).revision, {put: {watched: [other]}});
      await sync();
      // Older builds could leave the ID in this list after the final watch was removed.
      await store.commit((await store.snapshot()).revision, {local: {recentlyMarked: [72, 73]}});
      const before = await store.snapshot();
      const data = placed(before);
      check(await applyTraktImport(store, data, planTraktImport(data, before), {...base, preflight: sync, backup}),
        'The fictional import did not finish');
      const saved = await store.snapshot();
      check(saved.tables.watched.some(row => row.show_id === 72) && saved.local.recentlyMarked.join() === '73',
        'Import failed to save the watch or revived its stale local mark');
      await sync();
      store.close();
      const reopened = await open(name);
      const next = await reopened.store.snapshot();
      check(next.local.recentlyMarked.join() === '73' && next.tables.watched.some(row => row.show_id === 72),
        'Sync or reopening revived the stale entry or lost the imported watch');
    }));

  await run('A linked import backs up again and revises the preview when a rating changes during the first backup',
    () => withTraktDevices(async ({ open }) => {
      const { store, name, sync, backup } = await open();
      let snap = await store.snapshot();
      const data = placed(snap), extras = new Map([[72, new Map([[1,2],[2,-1],[3,4]])]]);
      data.watched.push({...episode,episode:2,episode_id:7212});
      data.watched.push({...episode,season:2,episode_id:7221,times_watched:2});
      data.today = '2026-11-20';
      data.reviewShows = new Map([[72,{seasons:[{season:1},{season:2},{season:3}]}]]);
      data.reviewSeasons = new Map([[72,new Map([[3,{episodes:[
        {episode:1,episode_id:7231,title:'Headwater',airDate:'2026-11-20'},
        {episode:2,episode_id:7232,title:'Open Ocean',airDate:'2026-11-21'},
        {episode:3,episode_id:7212,title:'Conflicting placement',airDate:'2026-11-20'}]}]])]]);
      data.counts = [{...data.counts[0],total:7,listedPlays:4,listedEpisodes:3,multiple:null}];
      const whole = new Map([[72,2]]), approved = planTraktImport(data, snap, new Set(), extras, whole);
      let offers = 0, reviews = 0;
      const saved = await applyTraktImport(store, data, approved, { ...base,
        preflight:sync,
        backup:async () => {
          await backup();
          const snapshot = await store.snapshot();
          offers++;
          check(!snapshot.tables.watched.length, 'Suggestion applied before the local recovery offer');
          if (offers === 1) await store.commit(snapshot.revision, { put: { ratings: [rating(9)] } });
          else check(snapshot.tables.ratings[0].rating === 9, 'Repeated recovery offer contains stale bytes');
          return true;
        },
        confirm: async (current, previous) => {
          reviews++;
          check(!current.watched.some(p=>p.row.episode_id===7212) && current.skipped.filter(s=>s.includes('TMDB episode 7212')).length===2,
            'Confirmation restored an ambiguous match or repeated its skipped placement');
          check(describeTraktChanges(current, previous).some(line => line.includes('keep your rating 9')), 'New rating conflict not shown');
          check(current.seasonExtras.get(72)?.get(1) === 2 && current.seasonExtras.get(72)?.get(2) === -1,
            'The new preview lost the raised or lowered season count');
          check(current.wholeShowPasses.get(72) === 2 && current.seasonExtras.get(72)?.get(3) === 4 &&
            current.watched.map(row => row.after).join() === '5,3,4',
            'The new preview mixed or lost the whole-show and manual season counts');
          return true;
        } });
      check(saved && offers === 2 && reviews === 1, 'Wrong number of local reviews');
      store.close();
      const againDevice = await open(name), reopened = againDevice.store;
      snap = await reopened.snapshot();
      check(snap.tables.watched.map(row => row.times_watched).join() === '5,3,4' && snap.tables.ratings[0].rating === 9 &&
        snap.tables.shows[0].imdb_id === title.imdb_id, 'Import did not survive reopening');
      const first = bytes(snap.tables), again = planTraktImport(data, snap, new Set(), extras, whole);
      await applyTraktImport(reopened, data, again, {...base,preflight:againDevice.sync,backup:againDevice.backup});
      check(bytes((await reopened.snapshot()).tables) === first, 'Repeated import changed the exported record');
    }));

  await run('A sync brings in a different rating, cancellation preserves it, and a later import carries the Trakt IMDb ID to another device',
    () => withTraktDevices(async ({ linked, provider }) => {
      const a = await linked(), b = await linked();
      const snap = await a.store.snapshot(), data = placed(snap);
      const original = planTraktImport(data, snap, new Set([72]));
      await b.store.commit((await b.store.snapshot()).revision, { put: { ratings: [rating(9)] } });
      await b.sync();
      const hooks = { ...base, preflight: a.sync, backup: a.backup };
      const first = await applyTraktImport(a.store, data, original, { ...hooks, backup: unexpected('Backup before revised approval'),
        confirm: async (now, old) => {
          check(now.ratings[0].after === 9 && old.ratings[0].after === 8, 'Preflight missed the remote rating');
          return false;
        } });
      let current = await a.store.snapshot();
      check(!first && current.tables.ratings[0].rating === 9 && !current.tables.watched.length, 'Canceled import undid sync or saved a watch');
      const approved = planTraktImport(data, current, new Set([72]));
      let backups = 0, reviews = 0;
      await applyTraktImport(a.store, data, approved, { ...hooks,
        backup: async () => {
          await a.backup();
          if (++backups === 1) await a.store.commit((await a.store.snapshot()).revision, { put: { ratings: [rating(7)] } });
        }, confirm: async proposed => { reviews++; return proposed.ratings[0].after === 7; } });
      check(reviews === 1 && backups === 2, 'An edit during backup was not backed up and reconfirmed');
      await a.sync(); await b.sync(); await a.sync();
      current = await b.store.snapshot();
      check(current.tables.watched[0].times_watched === 3 && current.tables.shows[0].imdb_id === title.imdb_id &&
        current.tables.ratings[0].rating === 7, 'Second device lost a count, rating or Trakt-only IMDb ID');
      check(readCsv('shows', provider.files.get('/shows.csv').bytes).rows[0].imdb_id === title.imdb_id, 'Dropbox lost the Trakt-only IMDb ID');
    }));

  await run('A failed prerequisite or an interrupted pre-import backup leaves no import to replay on reopening',
    () => withTraktDevices(async ({ linked, open }) => {
      const a = await linked();
      const snap = await a.store.snapshot(), data = placed(snap), plan = planTraktImport(data, snap);
      await rejects(() => applyTraktImport(a.store, data, plan, { ...base, preflight: unexpected('Sync failure') }), /Sync failure/);
      await rejects(() => applyTraktImport(a.store, data, plan, { ...base, preflight: a.sync, backup: unexpected('Backup failure') }), /Backup failure/);
      await rejects(() => applyTraktImport(a.store, data, plan, { ...base, preflight: async () => {
        await a.store.commit((await a.store.snapshot()).revision, { put: { ratings: [rating(5)] } });
      } }), /waiting to sync/);
      let active = true;
      const saved = await applyTraktImport(a.store, data, plan, { ...base, active: () => active, preflight: a.sync,
        confirm: async () => true, backup: async () => { await a.backup(); active = false; } });
      check(!saved, 'Disposed screen applied an import');
      a.store.close();
      const reopened = await open(a.name), after = await reopened.store.snapshot();
      check(after.tables.watched.length === 0 && after.tables.lists.length === 0 && after.tables.ratings[0].rating === 5, 'Reopened an unapproved change');
    }));

  await run('Import refuses an offline device, changed TMDB credentials and a replaced sign-in at commit',
    () => withTraktDevices(async ({ open }) => {
      const { store, sync } = await open(), snap = await store.snapshot(), data = placed(snap), plan = planTraktImport(data, snap);
      await rejects(() => applyTraktImport(store, data, plan, { ...base, online: () => false }), /internet/);
      await rejects(() => applyTraktImport(store, data, plan, { ...base, preflight:sync, backup:async () => {
        await store.commit((await store.snapshot()).revision, { put: { settings: [{ setting: 'tmdb_key', value: 'example-replaced' }] } });
        return true;
      } }), /TMDB key changed/);
      const now = await store.snapshot(), next = placed(now);
      await rejects(() => applyTraktImport(store, next, planTraktImport(next, now), { ...base, preflight:sync, backup:async () => {
        await store.storeExchangedSession(session()); return true;
      } }), /Dropbox sign-in changed/);
      check(!(await store.snapshot()).tables.watched.length, 'Rows appeared under a new account or credential');
    }));

  await run('A failed final IndexedDB write rolls back every Trakt table and a fresh confirmation can retry',
    () => withTraktDevices(async ({ open }) => {
      let { store, name, sync, backup } = await open();
      let snap = await store.snapshot();
      const data = placed(snap), plan = planTraktImport(data, snap, new Set([72]));
      const oldPut = IDBObjectStore.prototype.put;
      let aborted = false, rejected = false;
      IDBObjectStore.prototype.put = function (value) {
        const req = oldPut.apply(this, arguments);
        if (this.name === 'shows' && value.show_id === 72 && !aborted) {
          aborted = true; req.addEventListener('success', () => this.transaction.abort(), { once: true });
        }
        return req;
      };
      try { await applyTraktImport(store, data, plan, { ...base, preflight:sync, backup }); }
      catch { rejected = true; }
      finally { IDBObjectStore.prototype.put = oldPut; }
      store.close();
      ({store,sync,backup} = await open(name)); snap = await store.snapshot();
      check(aborted && rejected && ['watched', 'ratings', 'lists', 'shows'].every(table => !snap.tables[table].length),
        'Some rows survived the failed transaction');
      await applyTraktImport(store, data, planTraktImport(data, snap, new Set([72])), { ...base, preflight:sync, backup });
      check((await store.snapshot()).tables.watched[0].times_watched === 3, 'Retry after reopening lost the approved count');
    }));
}
