import { deviceMigrations, openDeviceStore } from '../dist/storage.js';

const passed = [];
const name = 'Fictional watch record';
const watch = { show_id: 7, show: 'Signal Lake', season: 1, episode: 2,
  episode_id: 72, title: 'Tide', times_watched: 1 };
const credential = { accountId: 'fiction-A', instanceId: 'first', accessToken: 'example-access',
  refreshToken: 'example-refresh', accessExpiresAt: 3, signInDeadline: 4, providerExpiresAt: 4 };
const pending = { content: 'exact proposed bytes\r\n', targetRevision: 'r0',
  targetModified: '2026-11-01T00:00:00Z', targetContent: 'previous bytes\r\n',
  clientModified: '2026-11-01T00:02:00Z', preparedAt: 123 };
const sync = { base: { revision: 'r0', content: pending.targetContent },
  lastClientModified: pending.clientModified, pending };

function check(ok, message) { if (!ok) throw Error(message); }
async function rejects(operation, errorName) {
  try { await operation; } catch (error) {
    check(error.name === errorName, 'Expected ' + errorName + ', got ' + error.name + ': ' + error.message);
    return;
  }
  throw Error('Expected ' + errorName + ', operation succeeded');
}
async function until(ready) {
  const until = performance.now() + 7000;
  while (!ready()) {
    if (performance.now() >= until) throw Error('Timed out waiting for second tab.');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
function get(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Inject an error after a write has already been enqueued into the real transaction.
async function failBeforeCompletion(operation, failure) {
  const put = IDBObjectStore.prototype.put;
  let hit = false;
  IDBObjectStore.prototype.put = function (...args) {
    const request = put.apply(this, args);
    if (this.name === 'meta' && args[1] === 'revision' && !hit) {
      hit = true;
      if (failure === 'quota') throw new DOMException('Injected write failure', 'QuotaExceededError');
      request.addEventListener('success', () => this.transaction.abort(), { once: true });
    }
    return request;
  };
  try {
    await rejects(operation(), failure === 'quota' ? 'QuotaExceededError' : 'AbortError');
    check(hit, 'The named transaction did not reach the failure point.');
  } finally {
    IDBObjectStore.prototype.put = put;
  }
}

async function run() {
  let persistCalls = 0;
  const originalPersist = StorageManager.prototype.persist;
  StorageManager.prototype.persist = function () {
    persistCalls++;
    return originalPersist.call(this);
  };
  let db = await openDeviceStore({ name });
  let start = await db.whenWriter();
  await db.persistent;
  StorageManager.prototype.persist = originalPersist;
  check(persistCalls === 1 && start.revision === 0n && start.tables.watched.length === 0,
    'First writer should request persistence and load an empty committed snapshot.');
  passed.push('A new writer asks for persistence and opens an empty record.');

  await db.commit(start.revision, {
    put: { watched: [watch], settings: [{ setting: 'github_repo', value: 'fictional/ratings' }] },
    local: { appearance: 'light' },
  });
  await db.storeExchangedSession(credential);
  await db.cache('metadata/7', { title: 'cached fiction' });
  await rejects(db.commit(start.revision, { replace: { watched: [] } }), 'StaleSnapshotError');
  start = await db.snapshot();
  await failBeforeCompletion(() => db.commit(start.revision, {
    put: { watched: [{ ...watch, times_watched: 8 }] }, local: { appearance: 'dark' },
  }), 'quota');
  db.close();
  db = await openDeviceStore({ name });
  start = await db.whenWriter();
  check(start.tables.watched[0].times_watched === 1 && start.local.appearance === 'light',
    'A failed mark or a stale snapshot changed the record.');
  const [absent,matching] = await db.searchRecords([107,7]);
  check(!absent.watched.length && !absent.dropped && matching.watched.length === 1 && matching.watched[0].show_id === 7,
    'Search progress did not preserve result order or returned watches from another title.');
  passed.push('A stale change is refused. A quota failure rolls back the mark and local state after reopen.');

  let sent = 0;
  await failBeforeCompletion(async () => {
    await db.commit(start.revision, { sync: { watched: sync } });
    sent++;
  }, 'abort');
  db.close();
  db = await openDeviceStore({ name });
  start = await db.whenWriter();
  check(sent === 0 && !start.sync.watched, 'An aborted pending save may not release an upload.');
  passed.push('An aborted pending save sends no upload and survives reopening as unapplied.');

  const proposed = structuredClone(sync);
  const save = db.commit(start.revision, { sync: { watched: proposed } });
  proposed.pending.content = 'changed by caller after submission';
  await save;
  sent++;
  start = await db.snapshot();
  for (const invalid of [{ ...watch, times_watched: 0 }, { ...watch, episode_id: NaN }]) {
    let rejected = false;
    try {
      await db.commit(start.revision, { put: { watched: [invalid] }, sync: { watched: null } });
    } catch { rejected = true; }
    check(rejected, 'An invalid personal row was accepted.');
  }
  const afterInvalid = await db.snapshot();
  check(afterInvalid.revision === start.revision && afterInvalid.sync.watched.pending.content === pending.content
    && afterInvalid.tables.watched[0].times_watched === 1, 'Bad input changed the record or pending upload.');
  passed.push('Invalid row counts and IDs cannot change the record or a pending upload.');
  const acknowledged = { ...sync, base: { revision: 'r1', content: pending.content }, pending: null };
  await failBeforeCompletion(() => db.commit(start.revision, {
    sync: { watched: acknowledged },
  }), 'abort');
  db.close();
  db = await openDeviceStore({ name });
  start = await db.whenWriter();
  check(start.sync.watched.pending.content === pending.content && start.sync.watched.base.revision === 'r0',
    'The lost acknowledgement erased the pending bytes or advanced the base.');
  await db.clearRebuildableCaches();
  check((await db.cacheValue('metadata/7')) === undefined, 'Cache entry survived cleanup.');
  const afterCleanup = await db.snapshot();
  check(afterCleanup.revision === start.revision && afterCleanup.tables.settings[0].value === 'fictional/ratings'
    && afterCleanup.tables.watched[0].times_watched === 1 && afterCleanup.local.dropboxSession.instanceId === 'first'
    && afterCleanup.sync.watched.pending.content === pending.content, 'Cache cleanup removed personal data.');
  passed.push('An aborted acknowledgement retains the original pending payload. Cache cleanup preserves personal state.');

  // Simulate the settlement decision supplied by the later Dropbox client.
  const peer = window.open('/peer', 'csvtv-test-peer');
  check(peer, 'The second browser tab did not open.');
  await until(() => typeof peer.openStore === 'function');
  const reader = await peer.openStore({ name });
  check(reader.role === 'reader', 'The second tab should be read-only.');
  await rejects(reader.commit(start.revision, { replace: { watched: [] } }), 'InvalidStateError');
  let handoff = reader.whenWriter();
  await db.commit(start.revision, { sync: { watched: acknowledged } });
  await rejects(db.commit(start.revision, { sync: { watched: acknowledged } }), 'StaleSnapshotError');
  db.close();
  const latest = await handoff;
  check(latest.sync.watched.base.revision === 'r1' && latest.sync.watched.pending === null && sent === 1,
    'Lock handoff did not reload the settled record.');
  passed.push('One writer at a time. Queued tabs receive the settled record and a second acknowledgement is stale.');

  db = await openDeviceStore({ name });
  check(db.role === 'reader', 'The reopened tab acquired a held lock.');
  await db.storeExchangedSession({ ...credential, instanceId: 'second', accountId: 'fiction-B' });
  const switched = await reader.snapshot();
  check(switched.local.syncAccountId === 'fiction-A' && switched.local.dropboxSession.accountId === 'fiction-B',
    'Compatible nonwriter code exchange moved the record to another account.');
  handoff = db.whenWriter();
  peer.close(); // The writer leaves without an explicit DeviceStore.close().
  start = await handoff;
  check(start.local.dropboxSession.instanceId === 'second', 'Writer disappeared without transfer.');
  passed.push('A compatible reader can finish sign-in. Leaving the writer tab transfers the lock.');

  let finishPersistence;
  StorageManager.prototype.persist = () => new Promise(resolve => { finishPersistence = resolve; });
  const held = await openDeviceStore({ name: 'Persistence delay' });
  await held.whenWriter();
  const queued = await openDeviceStore({ name: 'Persistence delay' });
  const waiting = queued.whenWriter();
  StorageManager.prototype.persist = originalPersist;
  held.close();
  await waiting;
  finishPersistence(false);
  queued.close();
  passed.push('A pending persistence decision cannot delay writer handoff.');

  await db.commit(start.revision, { sync: { watched: sync } });
  const raw = await get(indexedDB.open(name, deviceMigrations.length));
  let blocked = false;
  let interrupted = false;
  const migration = (database, transaction) => {
    database.createObjectStore('futureCache');
    const store = transaction.objectStore('sync');
    const deletion = store.delete('watched');
    deletion.onsuccess = () => { interrupted = true; transaction.abort(); };
  };
  await rejects(openDeviceStore({ name, migrations: [...deviceMigrations, migration],
    onBlocked: () => { blocked = true; raw.close(); },
  }), 'AbortError');
  check(blocked && interrupted && db.role === 'obsolete', 'The old tab did not fence a blocked upgrade.');
  await rejects(db.whenWriter(), 'InvalidStateError');
  await rejects(db.storeExchangedSession(credential), 'InvalidStateError');
  await rejects(db.commit(start.revision, { replace: { watched: [] } }), 'InvalidStateError');
  const oldVersion = await get(indexedDB.open(name, deviceMigrations.length));
  check(!oldVersion.objectStoreNames.contains('futureCache'), 'The aborted upgrade left a partial schema.');
  oldVersion.close();
  const previous = await openDeviceStore({ name });
  const intact = await previous.whenWriter();
  check(intact.sync.watched.pending.content === pending.content && intact.tables.settings[0].value === 'fictional/ratings',
    'The failed migration discarded a pending upload or settings.');
  passed.push('A blocked, interrupted upgrade rolls back its schema and rows. Obsolete tabs cannot store a mark or sign-in.');

  const upgraded = await openDeviceStore({ name, migrations: [...deviceMigrations, db => db.createObjectStore('futureCache')] });
  const migrated = await upgraded.whenWriter();
  check(migrated.sync.watched.pending.content === pending.content && migrated.tables.watched.length === 1
    && migrated.local.syncAccountId === 'fiction-A', 'Upgraded writer lost the record.');
  await rejects(openDeviceStore({ name }), 'VersionError');
  upgraded.close();
  passed.push('A compatible upgrade preserves the record. Reopening with the old build fails closed.');
}

async function sessionViews() {
  const name = 'Dropbox session view test ' + crypto.randomUUID();
  const legacyVersion = 5; // Seed physical list aliases before their migration.
  const old = await openDeviceStore({name,migrations:deviceMigrations.slice(0,legacyVersion)});
  let store;
  try {
    const before = await old.whenWriter();
    const legacy = {...credential,signInDeadline:9000};
    delete legacy.providerExpiresAt;
    await old.commit(before.revision,{put:{watched:[watch]},sync:{watched:sync},
      local:{syncAccountId:legacy.accountId,dropboxSession:legacy}});
    const raw = await get(indexedDB.open(name,legacyVersion));
    const write = raw.transaction(['lists','sync'],'readwrite'), lists = write.objectStore('lists');
    for (const [list,id,title] of [['Favourites',1,'Old'],['Favorites',1,'Current'],['FAVORITES',2,'Other'],
      ['sToPpEd',3,'Old title'],['Dropped',3,''],['My Favourites',3,'Own']]) lists.add({list,show_id:id,show:title});
    const original = 'list,show_id,show\nFavourites,1,Old\n';
    const listReceipt = {...sync,base:{revision:'r0',content:original},pending:{...pending,targetContent:original,
      content:original+'sToPpEd,3,Old title\n'}};
    write.objectStore('sync').put(listReceipt,'lists');
    await new Promise((resolve,reject)=>{write.oncomplete=resolve;write.onabort=()=>reject(write.error);});
    raw.close();
    store = await openDeviceStore({name});
    const upgraded = await store.whenWriter();
    check(upgraded.tables.lists.map(r=>[r.list,r.show_id,r.show].join('/')).join('|') ===
      'Dropped/3/Old title|Favorites/1/Current|Favorites/2/Other|My Favourites/3/Own','The schema upgrade lost a membership, preferred an empty title or changed a custom list');
    check(JSON.stringify(upgraded.sync.lists)===JSON.stringify(listReceipt) && (await store.dropboxState()).dirty,
      'A list upgrade changed the outstanding upload evidence or failed to schedule sync');
    check(old.role === 'obsolete', 'The pre-cutoff client still owns the database');
    await rejects(old.snapshot(),'InvalidStateError');
    let now = 1000;
    store.connectProviderKeys(() => { throw Error('Unexpected key save'); },() => now);
    const keyRows = [{setting:'tmdb_key',value:'fictional-view-check'}];
    await rejects(store.loadProviderKeys(legacy,keyRows,()=>true),'StaleSnapshotError');
    const session = (await store.dropboxState()).session;
    check(session.signInDeadline === 0 && upgraded.local.dropboxSession.signInDeadline === 0 &&
      upgraded.tables.watched.length === 1 && upgraded.sync.watched.pending.content === pending.content,
      'An unverified grant stayed usable or the upgrade lost the watch or receipt');
    const verified = {...legacy,providerExpiresAt:8000};
    await store.storeExchangedSession(verified);
    store.close(); store = await openDeviceStore({name});
    const record = await store.whenWriter(), state = await store.dropboxState();
    const publication = await store.dropboxPublicationState();
    check(publication.revision === record.revision && publication.sync.watched.pending.content === pending.content &&
      JSON.stringify(publication.settings) === JSON.stringify(record.tables.settings) &&
      !('local' in publication) && !('watched' in publication) && !('tables' in publication),
      'Dropbox publication lost its receipt or exposed unrelated device data');
    const receipt = await store.dropboxSyncCheck('watched');
    check(receipt.local.syncAccountId === verified.accountId && receipt.pending?.content === pending.content &&
      !(await store.dropboxSyncCheck('ratings')).pending && !(await store.dropboxSyncCheck()).pending,
      'The receipt check mixed files, lost a pending write, or missed its owning account');
    for (const view of [record.local.dropboxSession,state.session,receipt.local.dropboxSession]) {
      check(Object.keys(view).sort().join(',') === 'accountId,instanceId,signInDeadline' &&
        view.accountId === verified.accountId && view.instanceId === verified.instanceId &&
        view.signInDeadline === verified.providerExpiresAt, 'A screen received a raw grant or missed the earlier cutoff');
    }
    const auth = await store.dropboxAuthState();
    check(auth.session.refreshToken === verified.refreshToken && auth.session.accessToken === verified.accessToken &&
      auth.session.accessExpiresAt === verified.accessExpiresAt, 'OAuth lost its dedicated credential read on restart');
    await store.saveDropboxCooldown(verified,{until:9000,strikes:2},()=>true,false);
    const reads = [], originalGet = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function(key) {
      reads.push([this.name,key]);
      return originalGet.call(this,key);
    };
    try {
      const bound = await store.dropboxAuthState(undefined,'request');
      check(bound.accountId === verified.accountId && bound.session.instanceId === verified.instanceId &&
        bound.cooldown === null && !('revision' in bound) && !('dirty' in bound) &&
        JSON.stringify(reads) === JSON.stringify([['local','syncAccountId'],['local','syncAppKey'],['local','dropboxSession']]),
        'The authentication check read unrelated sync fields or missed the current binding');
      reads.length = 0;
      const admission = await store.dropboxAuthState(verified.accountId,'request');
      check(admission.cooldown.until === 9000 && admission.cooldown.strikes === 2 && reads.length === 4 &&
        JSON.stringify(reads[3]) === JSON.stringify(['meta',['dropboxCooldown',verified.accountId]]),
        'The transfer check did not read its own account’s gate with the binding');
    } finally { IDBObjectStore.prototype.get = originalGet; }
    store.connectProviderKeys(() => { throw Error('Unexpected key save'); },() => now);
    await store.loadProviderKeys(state.session,keyRows,()=>true);
    now = verified.providerExpiresAt;
    check(!(await store.tmdbState()).token, 'Provider access persisted past the earlier verified cutoff');
  } finally {
    old.close(); store?.close();
    await get(indexedDB.deleteDatabase(name));
  }
  passed.push('Old clients lose database access; screen snapshots expose only bounded Dropbox identity across restart.');
}

async function largeWatchTransaction() {
  const name = 'fictional-large-watch-' + crypto.randomUUID();
  let store = await openDeviceStore({name});
  try {
    await store.whenWriter();
    await store.commit(0n,{put:{watched:[watch]}});
    const before = await store.snapshot();
    const rows = Array.from({length:4101},(_,i)=>({...watch,episode:i+1,episode_id:i+101}));
    // A duplicate in a later group must roll back the clear, every earlier add, the rating and the revision.
    await rejects(store.commit(before.revision,{replace:{watched:[...rows,rows[0]]},
      put:{ratings:[{show_id:7,show:watch.show,rating:9}]}}),'ConstraintError');
    store.close(); store = await openDeviceStore({name});
    const reopened = await store.whenWriter();
    check(reopened.revision === before.revision && reopened.tables.ratings.length === 0 &&
      reopened.tables.watched.length === 1 && reopened.tables.watched[0].episode_id === watch.episode_id,
      'Late episode failure published a partial transaction after reopen');

    const nativeAdd = IDBObjectStore.prototype.add;
    let issued = 0, atFirstResult = 0;
    IDBObjectStore.prototype.add = function(...args) {
      const request = nativeAdd.apply(this,args);
      if (this.name === 'watched' && ++issued === 1) request.addEventListener('success',() => {
        atFirstResult = issued;
        rows[rows.length-1].title = 'Changed after the write started';
      });
      return request;
    };
    try {
      await store.commit(before.revision,{replace:{watched:rows},remove:{watched:[[7,1,3],[7,1,4]]},
        put:{watched:[{...rows[2],times_watched:4}]}});
    } finally { IDBObjectStore.prototype.add = nativeAdd; }
    const saved = await store.snapshot(), watches = saved.tables.watched;
    check(atFirstResult > 0 && atFirstResult < rows.length && watches.length === rows.length-1 &&
      !watches.some(row=>row.episode === 4) && watches.find(row=>row.episode === 3)?.times_watched === 4 &&
      watches.at(-1).title === watch.title,'Batched replace, remove and put lost their order or submitted values');
    passed.push('Large episode writes yield between groups and roll back entirely on a late failure.');
  } finally { store.close(); indexedDB.deleteDatabase(name); }
}

async function ratedWatchProjection() {
  const name = 'fictional-rated-history-' + crypto.randomUUID(), store = await openDeviceStore({name});
  const original = IDBObjectStore.prototype.getAll;
  const read = [];
  const rating = id => ({show_id:id,show:'Station '+id,rating:8});
  try {
    await store.whenWriter();
    await store.commit(0n,{put:{watched:Array.from({length:12},(_,i)=>({...watch,show_id:i+1}))}});
    IDBObjectStore.prototype.getAll = function(...args) {
      read.push({store:this.name,range:args[0]});
      return original.apply(this,args);
    };
    const empty = await store.overviewRows('ratings');
    check(!empty.watched.length && !empty.ratings.length && empty.record.erased===0n &&
      read.every(call=>call.store==='ratings'),'Empty Ratings read unrelated watch or membership data');
    for (const count of [1,8,9]) {
      const ratings = Array.from({length:count},(_,i)=>rating(i+2));
      const {revision} = await store.devicePreference('appearance');
      await store.commit(revision,{replace:{ratings}});
      read.length = 0;
      const view = await store.overviewRows('ratings');
      const seen = new Set(view.watched.map(row=>row.show_id));
      check(view.ratings.length===count && ratings.every(r=>seen.has(r.show_id)) &&
        read.filter(call=>call.store==='ratings').length===1,'Ratings missed a score or reread its score table');
      if (count<=8) check(seen.size===count && read.some(call=>call.store==='watched' &&
        call.range instanceof IDBKeyRange && call.range.lower[0]===2 && call.range.upper[0]===count+1),
        'A small collection of scores read the whole watch history');
    }
    const controller = new AbortController();
    IDBObjectStore.prototype.getAll = function(...args) {
      const request = original.apply(this,args);
      if (this.name==='ratings') request.addEventListener('success',()=>controller.abort(),{once:true});
      return request;
    };
    await rejects(store.overviewRows('ratings',controller.signal),'AbortError');
    passed.push('Empty and sparsely rated libraries only read the watch history needed by their score cards.');
  } finally { IDBObjectStore.prototype.getAll=original; store.close(); indexedDB.deleteDatabase(name); }
}

async function unavailableWriterLock() {
  const name = 'unavailable-writer-lock-' + crypto.randomUUID();
  const descriptor = Object.getOwnPropertyDescriptor(navigator,'locks');
  function restore() {
    if (descriptor) Object.defineProperty(navigator,'locks',descriptor);
    else delete navigator.locks;
  }
  const denied = () => { throw new DOMException('Fixture browser restriction','SecurityError'); };
  let store = await openDeviceStore({name});
  try {
    const original = await store.whenWriter();
    await store.commit(original.revision,{put:{watched:[watch]}});
    await store.closeForUpdate();
    for (const [lock,error] of [[{value:undefined},'NotSupportedError'],[{get:denied},'SecurityError'],
      [{value:{request:async () => denied()}},'SecurityError']]) {
      Object.defineProperty(navigator,'locks',{configurable:true,...lock});
      store = await openDeviceStore({name});
      await rejects(store.whenWriter(),error);
      const saved = await store.snapshot();
      check(store.role === 'reader' && store.readOnlyReason?.includes('lock the record') &&
        saved.tables.watched[0]?.episode_id === watch.episode_id,'A browser lock restriction hid the record or blamed another tab');
      await rejects(store.commit(saved.revision,{replace:{watched:[]}}),'InvalidStateError');
      await store.closeForUpdate();
    }
    restore();
    store = await openDeviceStore({name});
    const reopened = await store.whenWriter();
    check(!store.readOnlyReason && reopened.tables.watched[0]?.times_watched === 1,'Restoring Web Locks lost the original watch');
    passed.push('Missing or denied Web Locks keep a record readable and explain why writes are disabled.');
  } finally { restore(); store.close(); indexedDB.deleteDatabase(name); }
}

try {
  await run();
  await unavailableWriterLock();
  await largeWatchTransaction();
  await ratedWatchProjection();
  await sessionViews();
  const { coreRoundtrip } = await import('./core-roundtrip.mjs');
  await coreRoundtrip();
  passed.push('CSV rows, persisted edits, episode identity, guard decisions and byte export work together across reopen.');
  const { tmdbStorageCases } = await import('./tmdb-storage-cases.mjs');
  await tmdbStorageCases(passed, failBeforeCompletion);
  const { tmdbIntegration } = await import('./tmdb-integration.mjs');
  await tmdbIntegration();
  passed.push('The TMDB client, settings view, cache and detail refresh work together.');
  const { tmdbUiCases } = await import('./tmdb-ui-cases.mjs');
  await tmdbUiCases();
  passed.push('TMDB Settings and Credits render and support key validation and recovery.');
  check(passed.length === 26, 'All storage and TMDB cases must run.');
  for (const [file, suite, count] of [
    ['provider-vault-cases','providerVaultCases',3],
    ['navigation-history-cases','navigationHistoryCases',5],
    ['tmdb-browse-cases','tmdbBrowseCases',10],
    ['provider-queue-cases','providerQueueCases',7],
    ['home-search-cases', 'homeSearchCases', 14], ['show-cases', 'showCases', 10],
    ['theme-cases', 'themeCases', 2], ['notice-cases', 'noticeCases', 1],
    ['mdblist-storage-cases', 'mdbListStorageCases', 10],
    ['imdb-storage-cases', 'imdbStorageCases', 19],
    ['mal-storage-cases', 'malStorageCases', 6],
    ['season-cases', 'seasonCases', 5], ['application-cases', 'applicationCases', 12],
    ['season-cases', 'repairScreenCases', 4],
    ['episode-repair-cases', 'episodeRepairCases', 5],
    ['personal-record-cases', 'personalRecordCases', 9], ['personal-sheets-cases', 'personalSheetsCases', 5],
    ['lists-cases', 'listsCases', 11], ['application-cases', 'personalApplicationCases', 3],
    ['library-cases', 'libraryCases', 13], ['watch-view-cases', 'watchViewCases', 7], ['cast-cases', 'castCases', 9],
    ['application-cases', 'discoveryApplicationCases', 7],
    ['statistics-screen-cases', 'statisticsScreenCases', 12], ['statistics-job-cases', 'statisticsJobCases', 3],
    ['application-cases', 'statisticsApplicationCases', 5],
    ['export-screen-cases', 'exportScreenCases', 4], ['application-cases', 'exportApplicationCases', 3],
    ['recovery-screen-cases', 'recoveryScreenCases', 9],
    ['dropbox-engine-cases','dropboxEngineCases',6],
    ['dropbox-compatibility-cases','dropboxCompatibilityCases',1],
    ['offline-upgrade-cases','offlineUpgradeCases',5],
    ['dropbox-protocol-cases','dropboxProtocolCases',8],
    ['dropbox-app-cases','dropboxAppCases',10],
    ['dropbox-roundtrip-cases','dropboxRoundtripCases',8],
    ['trakt-import-cases','traktImportWorkflowCases',6],
    ['anilist-import-cases','aniListWorkflowCases',4],
    ['import-commit-guard-cases','importCommitGuards',3],
    ['trakt-screen-cases','traktScreenCases',9],
    ['anilist-screen-cases','anilistScreenCases',5],
    ['trakt-review-cases','traktReviewCases',4],
  ]) {
    const start = passed.length;
    const module = await import('./' + file + '.mjs');
    await module[suite](async (name, exercise) => {
      try { await exercise(); } catch (error) { throw new Error(name + '\n' + (error.stack || error)); }
      passed.push(name);
    });
    check(passed.length - start === count, 'Expected ' + count + ' cases from ' + suite);
  }
  await fetch('/result', { method: 'POST', body: JSON.stringify({ passed }) });
} catch (error) {
  await fetch('/result', { method: 'POST', body: JSON.stringify({ passed, error: error.stack || String(error) }) });
}
