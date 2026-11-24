import { connectFixtureProviders, replaceFixtureSettings } from './provider-fixture-cases.mjs';
import { deviceMigrations, openDeviceStore } from '../dist/storage.js';
import { cacheExpiresAt } from '../dist/tmdb-refresh.js';

function check(condition, message) { if (!condition) throw Error(message); }
function response(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// A screen can be disposed after a read succeeds and before its handler queues
// the next request. The canceled operation must reject without an uncaught exception.
async function cancelAtReply(target, method, source, read) {
  const original = target.prototype[method], controller = new AbortController(), errors = [];
  const onError = event => { errors.push(event.message); event.preventDefault(); };
  window.addEventListener('error',onError);
  target.prototype[method] = function(...args) {
    const request = original.apply(this,args);
    if (this.name === source) request.addEventListener('success',() => controller.abort(),{once:true});
    return request;
  };
  let stopped = false;
  try {
    try { await read(controller.signal); }
    catch (error) { if (error.name !== 'AbortError') throw error; stopped = true; }
    await new Promise(resolve=>setTimeout(resolve,0));
  } finally {
    target.prototype[method] = original;
    window.removeEventListener('error',onError);
  }
  check(controller.signal.aborted && stopped && !errors.length,
    'Canceling a '+source+' reply failed to stop cleanly: '+errors.join(', '));
}

async function checkBatchedMetadata(db, generation, now) {
  const showKey = 'tv/700?append_to_response=keywords,external_ids';
  const keys = Array.from({length:240},(_,i)=>'batch/'+String(i).padStart(3,'0'));
  const entries = Object.fromEntries(keys.map(key=>[key,{fetchedAt:now,value:{key}}]));
  entries[showKey] = {fetchedAt:now,value:{key:showKey}};
  entries[keys[2]] = {fetchedAt:now,value:null,vacatedPositions:[1,3]};
  entries[keys[4]].fetchedAt = now+1000;
  entries[keys[5]].fetchedAt = now-200*86400000;
  const settings = [{setting:'season_order.700',value:'1/2:1'}, {setting:'appearance',value:'light'}];
  await db.commit((await db.snapshot()).revision,{put:{settings}});
  await db.writeTmdb(generation,{entries});
  const requested = [showKey, ...keys.slice(0,19), 'batch/000-missing', ...keys.slice(224), keys[1], keys[2]].reverse();
  const wanted = new Set(requested), accessed = [], probes = [];
  const original = {};
  for (const method of ['get','getAll','getAllKeys']) {
    original[method] = IDBObjectStore.prototype[method];
    IDBObjectStore.prototype[method] = function (...args) {
      const request = original[method].apply(this,args);
      if (this.name==='settings' && method==='getAll') {
        check(args[0] instanceof IDBKeyRange && args[0].lower==='season_order.' && args[0].upper==='season_order.\uffff',
          'Metadata read unrelated settings');
      }
      if (this.name==='tmdb') {
        if (method==='getAllKeys') probes.push(args[1]);
        else request.addEventListener('success',()=>{
          const results = method==='getAll' ? request.result : [request.result];
          for (const entry of results) if (entry?.value?.key) accessed.push(entry.value.key);
        });
      }
      return request;
    };
  }
  let rows;
  try { rows=await db.tmdbEntries(requested,now); }
  finally { for (const [method,fn] of Object.entries(original)) IDBObjectStore.prototype[method]=fn; }
  check(probes.length>0 && probes.every(n=>Number.isInteger(n) && n>0 && n<240),'Expected bounded key-only probes');
  check(accessed.every(key=>wanted.has(key)), 'A range loaded an unrequested metadata value');
  check(rows.length===requested.length && rows.every((row,i)=>{
    const key=requested[i];
    if ([keys[4],keys[5],'batch/000-missing'].includes(key)) return row===undefined;
    if (key===keys[2]) return row?.value===null && row?.vacatedPositions?.join()==='1,3';
    return row?.value?.key===key && (key!==showKey || row.value.manualSeasonOrder==='1/2:1');
  }),'Batched reads lost order, duplicate positions, TTL, missing evidence or a manual season order');
  const [titleOnly] = await db.tmdbEntries([showKey],now,undefined,{seasonOrders:false});
  check(titleOnly?.value?.key===showKey && titleOnly.value.manualSeasonOrder===undefined,
    'A title card unnecessarily read the personal season order');

  const watched=[], metadata={};
  for (let id=700;id<724;id++) {
    const show='Station '+id, episode=1, season=1, episode_id=id*10+1;
    watched.push({show_id:id,show,season,episode,episode_id,times_watched:2,title:'Pilot'});
    if (id===703) continue;
    const fetchedAt=id===702 ? now-200*86400000 : now;
    const header='tv/'+id+'?append_to_response=keywords,external_ids', detail='tv/'+id+'/season/1';
    metadata[header]={fetchedAt,value:id===701 ? null : {show_id:id,...(id===704 ? {} : {show}),key:header}};
    metadata[detail]={fetchedAt,value:id===701 ? null : {...(id===705 ? {} : {show_id:id,season}),episodes:[{episode,episode_id}],key:detail}};
    metadata['tv/'+id+'/external_ids']={fetchedAt,value:{imdbId:'tt'+id}};
    metadata['tv/'+id+'/aggregate_credits']={fetchedAt,value:[{key:'unrequested-cast'}]};
    metadata['tv/'+id+'/season/0']={fetchedAt,value:{show_id:id,season:0,episodes:[],key:'unrequested-specials'}};
  }
  await db.commit((await db.snapshot()).revision,{put:{watched}});
  await db.writeTmdb(generation,{entries:metadata});
  const headers = Object.keys(metadata).filter(key=>key.includes('?append_to_response='));
  await cancelAtReply(IDBIndex,'getAllKeys','showHeaders',signal=>db.tmdbEntries(headers,now,signal));
  await cancelAtReply(IDBObjectStore,'getAllKeys','tmdb',signal=>db.tmdbEntries(keys,now,signal));
  await cancelAtReply(IDBObjectStore,'getAll','shows',signal=>db.exportSnapshot(true,now,false,signal));
  await cancelAtReply(IDBObjectStore,'getAllKeys','tmdb',signal=>db.exportSnapshot(false,now,true,signal));
  await cancelAtReply(IDBIndex,'getAllKeys','expiry',signal=>db.cachedCastMember(1729,now,signal));
  await cancelAtReply(IDBObjectStore,'getAll','lists',signal=>db.watchlistMembers(signal));
  await cancelAtReply(IDBObjectStore,'getAll','lists',signal=>db.listPageRows(undefined,signal));
  const indexed = new Set(), loaded = [], undo = [];
  for (const api of [IDBIndex,IDBObjectStore]) for (const method of ['get','getAll']) {
    const original = api.prototype[method];
    api.prototype[method] = function(...args) {
      const request = original.apply(this,args);
      if ((this.objectStore?.name ?? this.name)==='tmdb') {
        if (api===IDBIndex) indexed.add(this.name);
        request.addEventListener('success',()=>{
          const rows = method==='getAll' ? request.result : [request.result];
          for (const row of rows) {
            const key = row?.value?.key ?? row?.value?.[0]?.key;
            if (key) loaded.push(key);
          }
        });
      }
      return request;
    };
    undo.push(()=>{api.prototype[method]=original;});
  }
  let exported;
  try {
    await db.exportSnapshot(true,now);
    check(indexed.has('showHeaders') && indexed.has('seasonDetails') && loaded.every(key=>!key.startsWith('unrequested')),
      'The dense export read unrelated bodies or failed to use both metadata indexes');
    indexed.clear();
    exported=await db.exportSnapshot(true,now,true);
    check(indexed.has('showHeaders') && indexed.has('seasonDetails') && loaded.every(key=>!key.startsWith('unrequested')),
      'The derived snapshot lost indexed title/season lookups or copied unrelated bodies when reading external IDs');
    indexed.clear();
    const portable=await db.exportSnapshot(false,now,true);
    check(indexed.has('showHeaders') && !indexed.has('seasonDetails') && !portable.seasons.size &&
      portable.externalIds.size===exported.externalIds.size && [...portable.externalIds].every(([id,value])=>exported.externalIds.get(id)===value),
      'The four-file export read seasons or disagreed with the derived snapshot on standalone external IDs');
    loaded.length=0;
    const sparse = Object.keys(metadata).filter(key=>
      !key.startsWith('tv/710/') && !key.startsWith('tv/710?') && (key.endsWith('/season/1') || key.includes('?'))).reverse();
    sparse.push(sparse[0]);
    const found=await db.tmdbEntries(sparse,now), allowed=new Set(sparse);
    check(loaded.length>0 && loaded.every(key=>allowed.has(key)) && found.every((row,i)=>{
      if (sparse[i].startsWith('tv/701')) return row?.value===null;
      if (sparse[i].startsWith('tv/702')) return !row;
      return row?.value?.key===sparse[i];
    }),'Sparse or repeated keys loaded a foreign body, lost a stored 404 or dropped a fieldless legacy value');

    const cold=Array.from({length:20},(_,i)=>'tv/'+(99000+i)+'?append_to_response=keywords,external_ids');
    check((await db.tmdbEntries(cold,now)).every(row=>row===undefined),'An empty key interval invented metadata');
    await db.writeTmdb(generation,{entries:{[cold[3]]:{fetchedAt:now,value:null},[cold[6]]:{fetchedAt:now,value:{legacy:true}}}});
    const legacy=await db.tmdbEntries(cold,now);
    check(legacy[3]?.value===null && legacy[6]?.value?.legacy && legacy.filter(Boolean).length===2,
      'An empty secondary index concealed stored negative or legacy responses');

    const controller=new AbortController(), getKeys=IDBIndex.prototype.getAllKeys;
    IDBIndex.prototype.getAllKeys=function(...args) {
      const request=getKeys.apply(this,args);
      if(this.name==='showHeaders') queueMicrotask(()=>controller.abort());
      return request;
    };
    let stopped=false;
    try { await db.exportSnapshot(true,now,false,controller.signal); }
    catch(error) { stopped=error.name==='AbortError'; }
    finally { IDBIndex.prototype.getAllKeys=getKeys; }
    check(stopped,'Canceling an indexed export failed to abort the snapshot');
  } finally { undo.forEach(restore=>restore()); }
  for (const {show_id:id,episode_id} of watched) {
    const key='tv/'+id+'/season/1', header='tv/'+id+'?append_to_response=keywords,external_ids';
    if (id===701) {
      check(exported.missingShowIds.has(id) && exported.seasons.get(key)===null && exported.observationTimes.get(key)===now,
        'The export lost confirmed missing metadata');
    } else if (id===702 || id===703) {
      check(!exported.showMetadata.has(id) && !exported.missingShowIds.has(id) && !exported.seasons.has(key) &&
        !exported.observationTimes.has(header) && !exported.externalIds.has(id),'An absent or expired cache entry escaped into export');
    } else {
      const show=exported.showMetadata.get(id);
      check(show?.show_id===id && (id!==700 || show.manualSeasonOrder==='1/2:1') && exported.seasons.get(key)?.episodes[0].episode_id===episode_id &&
        exported.externalIds.get(id)==='tt'+id && exported.observationTimes.get(header)===now,'A batched export crossed metadata identities');
    }
  }
}

async function checkMetadataTargets(db) {
  const show_id = 9001, show = 'Fictional station';
  const watched = [[1,1],[1,2],[3,8],[0,1]].map(([season,episode])=>({
    show_id,show,season,episode,title:'Transmission',times_watched:2,episode_id:null,
  }));
  const ratings = [{show_id:9002,show:'Rated programme',rating:0}];
  const lists = [{show_id:9003,show:'Saved programme',list:'Watchlist'},{show_id:9004,show:'Old series',list:'Dropped'}];
  await db.commit((await db.snapshot()).revision,{put:{watched,ratings,lists},local:{statisticsOpened:true}});
  const calls = [], restore = [];
  for (const method of ['get','getAll','getAllKeys']) {
    const original = IDBObjectStore.prototype[method];
    IDBObjectStore.prototype[method] = function(...args) {
      calls.push([this.name,method,...args].join('/'));
      return original.apply(this,args);
    };
    restore.push(()=>{IDBObjectStore.prototype[method]=original;});
  }
  let references;
  try { references = await db.metadataTargets(); }
  finally { restore.forEach(undo=>undo()); }
  const expected = ['watched/getAllKeys','ratings/getAllKeys','lists/getAll','local/get/statisticsOpened'];
  check(calls.slice().sort().join()===expected.sort().join(),'Background jobs read unrelated device data');
  const {tables,statisticsOpened} = references;
  check(statisticsOpened && tables.watched.filter(row=>row.show_id===show_id).map(row=>row.season).join()==='0,1,3' &&
    tables.ratings.some(row=>row.show_id===9002) && lists.every(item=>tables.lists.some(row=>row.show_id===item.show_id && row.list===item.list)),
    'The provider job lost Specials, repeated episodes, season gaps, a zero rating or list-only shows');
}

async function checkCacheSweep(db, generation, now) {
  const deadline = cacheExpiresAt(now), calls = [], transaction = IDBDatabase.prototype.transaction;
  const changes = [], events = ['tmdbbrowse','tmdbmetadata','summarychange','exportchange','cachechange'];
  const listen = event => { changes.push(event.type); };
  events.forEach(name=>db.addEventListener(name,listen));
  IDBDatabase.prototype.transaction = function(names, mode, options) {
    if ((Array.isArray(names) ? names : [names]).includes('tmdb')) calls.push(mode ?? 'readonly');
    return transaction.apply(this,arguments);
  };
  try {
    await db.purgeTmdb(now);
    check(calls.join()==='readonly','An empty cache took a write lock');
    const person='person/3/tv_credits',cast='tv/7/aggregate_credits',season='tv/7/season/1';
    await db.writeTmdb(generation,{entries:{[person]:{value:null,fetchedAt:now},[cast]:{value:[],fetchedAt:now+1},[season]:{value:null,fetchedAt:now+2}}});
    const {session} = await db.dropboxState();
    await db.saveDropboxStatus({accountId:session.accountId,instanceId:session.instanceId,synced:true,reason:'Fixture prepared',day:'2026-11-22'},()=>true);
    let invalidTime = false;
    try { await db.purgeTmdb(NaN); } catch { invalidTime = true; }
    check(invalidTime && !!await db.tmdbEntry(person,now),'An invalid clock discarded the cache');
    calls.length=0;changes.length=0;
    await db.purgeTmdb(deadline-1);
    check(calls.join()==='readonly' && !changes.length,'Unexpired observations triggered writes or a cache change');
    calls.length=0;
    await db.purgeTmdb(deadline);
    check(calls.join()==='readonly,readwrite' && changes.join()==='tmdbbrowse' && !(await db.dropboxState()).dirty,
      'A person-only eviction took the wrong locks or scheduled Dropbox sync');
    check(!await db.tmdbEntry(person,now) && !!await db.tmdbEntry(cast,deadline),
      'Eviction retained the expired 404 or removed the next live entry');
    await db.purgeTmdb(deadline);
    check(changes.length===1,'Repeated maintenance republished an eviction');
    changes.length=0;await db.purgeTmdb(deadline+1);
    check(changes.join()==='tmdbmetadata' && !(await db.dropboxState()).dirty,'Cast expiry failed to update Statistics independently of Dropbox');
    changes.length=0;await db.purgeTmdb(deadline+2);
    check(changes.join()==='tmdbmetadata,exportchange,summarychange' && (await db.dropboxState()).dirty,'Season expiry failed to schedule its derived CSV update');
  } finally { IDBDatabase.prototype.transaction=transaction; events.forEach(name=>db.removeEventListener(name,listen)); }
}

export async function tmdbStorageCases(passed, failBeforeCompletion) {
  const name = 'TMDB fictional store ' + crypto.randomUUID();
  const now = Date.now();
  const a = 'fictional-credential-A', b = 'fictional-credential-B';
  const saved = { value: { images: ['fictional'] }, fetchedAt: now };
  const seed = indexedDB.open(name, 1);
  seed.onupgradeneeded = () => {
    deviceMigrations[0](seed.result, seed.transaction);
    seed.transaction.objectStore('settings').put({ setting: 'tmdb_key', value: a });
    seed.transaction.objectStore('watched').put({ show_id: 7, show: 'Island', season: 1, episode: 1,
      episode_id: 71, title: 'Morning', times_watched: 3 });
    seed.transaction.objectStore('lists').put({ list: 'Notes', show_id: 7, show: 'Island' });
    seed.transaction.objectStore('lists').put({ list: 'Notes', show_id: 9, show: 'Other' });
  };
  (await response(seed)).close();
  let db = await openDeviceStore({ name });
  try {
    let record = await db.whenWriter();
    check(!(await db.tmdbState()).token && !record.tables.settings.length, 'Legacy key escaped quarantine');
    const legacy = await db.legacyProviderSettings();
    check(legacy.rows[0].value === a && !legacy.migrated, 'Legacy migration input is missing');
    await connectFixtureProviders(db,name,legacy.rows);
    await db.finishProviderMigration((await db.snapshot()).revision,null,(await db.dropboxState()).session,()=>true);
    record = await db.snapshot();
    let state = await db.tmdbState();
    const initial = state.generation;
    check(state.token === a && record.tables.watched[0].times_watched === 3, 'v1 record failed to migrate');
    let narrow = await db.tmdbRows(7);
    check(narrow.tables.lists.length === 1 && narrow.tables.watched.length === 1 &&
      narrow.tables.settings.length === 0 && narrow.tmdbGeneration === initial, 'Indexed lookup mixed records or revisions');
    passed.push('A v1 key and watch record survive upgrade and per-show reads use the new list index.');

    await checkCacheSweep(db,initial,now);
    passed.push('An empty or fresh metadata cache uses a read-only maintenance check and expires entries exactly at the cutoff.');

    const gate = { until: now + 60000, strikes: 2 };
    await db.writeTmdb(initial, { entries: { 'show/7': saved }, cooldown: gate });
    await db.writeTmdb(initial, { cooldown: { until: now + 1000, strikes: 1 } });
    await db.writeTmdb(initial, { cooldown: null }, now);
    await db.writeTmdb(initial, { refused: 'Fictional refusal' });
    db.close();
    db = await openDeviceStore({ name });
    await connectFixtureProviders(db,name);
    state = await db.tmdbState();
    check(state.refused === 'Fictional refusal' && state.cooldown.until === gate.until &&
      state.cooldown.strikes === 2 && (await db.tmdbEntry('show/7')).fetchedAt === now,
      'Refusal, cache or shared deadline was lost before its probe');
    const get = IDBObjectStore.prototype.get;
    let ownerReads = 0, gateReads = 0;
    IDBObjectStore.prototype.get = function(key) {
      if (this.name === 'local' && key === 'syncAccountId') ownerReads++;
      if (this.name === 'tmdbGates') gateReads++;
      return get.call(this,key);
    };
    try {
      const access = await db.tmdbState('access');
      check(access.token === state.token && access.generation === state.generation && access.refused === state.refused &&
        access.cachedMarkAccount === state.cachedMarkAccount && !Object.hasOwn(access,'cooldown') && ownerReads === 1 && gateReads === 0,
        'Access validation must use the current account and credential without rereading the provider deadline');
    } finally { IDBObjectStore.prototype.get = get; }
    await db.clearRebuildableCaches();
    check(!await db.tmdbEntry('show/7') && (await db.tmdbState()).refused === state.refused &&
      (await db.tmdbState()).cooldown.until === gate.until, 'Cache cleanup erased credential state');
    passed.push('Metadata, refusal and the longest cooldown survive reopening, and cleanup preserves the credential state.');

    const events = [];
    db.addEventListener('recordchange', event => events.push(event.detail));
    const ticket = await db.beginTmdbSubmission();
    record = await db.snapshot();
    await db.commit(record.revision, { put: { settings: [{ setting: 'tmdb_key', value: b }] } });
    const changed = await db.tmdbState();
    check(changed.refused === null && changed.cooldown === null && changed.generation > initial, 'New key inherited active refusal or gate');
    await db.commit((await db.snapshot()).revision, { put: { settings: [{ setting: 'tmdb_key', value: a }] } });
    state = await db.tmdbState();
    check(state.generation > changed.generation && state.cooldown.until === gate.until, 'Returning credential lost generation or quota scope');
    check(!await db.acceptTmdbSubmission(ticket, b, 'config', saved), 'Old key check succeeded after A to B to A');
    check(!await db.writeTmdb(initial, { entries: { late: saved }, refused: 'old 401', cooldown: null }),
      'Old response passed the A to B to A fence');
    check(!await db.tmdbEntry('late') && (await db.tmdbState()).refused === null, 'Obsolete data or status was stored');
    check(events.length === 2 && events[0].settings.includes('tmdb_key') && events[1].settings.includes('tmdb_key'),
      'Record notifications must follow successful settings transactions');
    await db.commit((await db.snapshot()).revision, { put: { settings: [{ setting: 'tmdb_key', value: a }] } });
    check((await db.tmdbState()).generation === state.generation, 'Unchanged synced key invalidated active work');
    passed.push('Sync and restore settings changes fence late data, retries and refusals across A to B to A.');

    const older = await db.beginTmdbSubmission();
    const newer = await db.beginTmdbSubmission();
    check(!await db.isTmdbSubmissionCurrent(older) && await db.isTmdbSubmissionCurrent(newer), 'Superseded form check stayed active');
    check(!await db.writeTmdbSubmissionCooldown(older, b, gate), 'Old form reclosed the gate');
    check(await db.writeTmdbSubmissionCooldown(newer, b, gate), 'Candidate gate was not saved');
    check((await db.tmdbSubmissionCooldown(newer, b)).until === gate.until, 'Candidate gate missing');
    await db.writeTmdbSubmissionCooldown(newer, b, null, gate.until);
    check(await db.tmdbSubmissionCooldown(newer, b) === null, 'Successful probe left the old gate active');
    await db.writeTmdb(state.generation, { refused: 'Fictional refusal' });
    const revision = (await db.snapshot()).revision;
    check(!await db.acceptTmdbSubmission(newer, b, 'canceled', saved, () => false),
      'An edited or canceled input field still saved its validated token');
    check(await db.acceptTmdbSubmission(newer, a, 'config', saved), 'Same key could not be revalidated');
    record = await db.snapshot();
    check(!await db.isTmdbSubmissionCurrent(newer) && record.revision === revision + 1n &&
      (await db.tmdbState()).refused === null && (await db.tmdbEntry('config')).value.images[0] === 'fictional',
      'Validated key, configuration, revision and refusal reset were not saved together');
    passed.push('Superseded forms lose write access and a successful same-key check saves configuration and clears refusal.');

    let active = record.tmdbGeneration;
    const description = { put: { watched: [{ ...record.tables.watched[0], title: 'Updated chapter' }] } };
    const atomic = { tmdb: { generation: active, key: 'season/7/1', entry: saved }, onlyDescriptions: true };
    await failBeforeCompletion(() => db.commit(record.revision, description, atomic), 'quota');
    check((await db.tmdbRows(7)).tables.watched[0].title === 'Morning' && !await db.tmdbEntry(atomic.tmdb.key),
      'A failed atomic title rewrite left fresh cache or a partly changed personal record');
    const eventCount = events.length;
    await db.commit(record.revision, { put: { watched: [] } }, { ...atomic, tmdb: { ...atomic.tmdb, key: 'cacheOnly' } });
    check((await db.tmdbRows(7)).revision === record.revision && events.length === eventCount && await db.tmdbEntry('cacheOnly'),
      'Cache-only refresh incremented the record or fired a detail-job trigger');
    let rejected = false;
    try { await db.commit(record.revision, description, { ...atomic, tmdb: { ...atomic.tmdb, generation: initial } }); }
    catch (error) { rejected = error.name === 'StaleSnapshotError'; }
    check(rejected && !await db.tmdbEntry(atomic.tmdb.key), 'Superseded credential applied an atomic rewrite');
    await db.commit(record.revision, description, atomic);
    check((await db.tmdbRows(7)).tables.watched[0].title === 'Updated chapter' && await db.tmdbEntry(atomic.tmdb.key) &&
      events.at(-1).onlyDescriptions, 'The active generation did not save the cache and corrected title together');
    const old = { fetchedAt: Date.UTC(2000, 7, 31, 12), value: 'old fictional title' };
    const dated = { fetchedAt: Date.UTC(2100, 7, 31, 12), value: 'fictional title' };
    const boundary = Date.UTC(2101, 1, 28, 12);
    await db.writeTmdb(active, { entries: { boundary: dated, missing: { value: null, fetchedAt: now } } });
    check(await db.tmdbEntry('boundary', boundary - 1) && !await db.tmdbEntry('boundary', boundary),
      'Six calendar months must clamp month ends at the same UTC time');
    await db.writeTmdb(active, { entries: { expired: old } });
    let raw = await response(indexedDB.open(name, deviceMigrations.length));
    const limit = performance.now() + 3000;
    while (await response(raw.transaction('tmdb').objectStore('tmdb').getKey('expired'))) {
      check(performance.now() < limit, 'Long-running writer retained expired data');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    db.close();
    // Simulate an entry reaching its deadline while every app tab is closed.
    await response(raw.transaction('tmdb', 'readwrite').objectStore('tmdb').put(
      { ...old, expiresAt: Date.UTC(2001, 1, 28, 12) }, 'untouched'));
    raw.close();
    db = await openDeviceStore({ name });
    await connectFixtureProviders(db,name);
    raw = await response(indexedDB.open(name, deviceMigrations.length));
    const keys = await response(raw.transaction('tmdb').objectStore('tmdb').getAllKeys());
    raw.close();
    check(!keys.includes('expired') && !keys.includes('untouched') && keys.includes('missing') && keys.includes('config'),
      'Writer startup failed to purge unread expired entries or erased recent missing evidence');
    passed.push('Six-month expiry clamps the month end and startup physically purges untouched expired metadata.');

    active = (await db.tmdbState()).generation;
    const importRevision = (await db.snapshot()).revision;
    const prior = { value: 'old season positions', fetchedAt: now - 65 * 86_400_000 };
    const staged = { generation: active, entries: new Map([
      ['import/missing', { value: 'staged', fetchedAt: now }],
      ['import/stale', { value: 'new season positions', fetchedAt: now, prior }],
      ['import/concurrent', { value: 'staged', fetchedAt: now, prior }],
      ['import/same-time', { value: 'staged', fetchedAt: now, prior }],
      ['import/missing-season', { value: null, fetchedAt: now, vacatedPositions: [1, 3] }],
      ['import/other-missing-season', { value: 'staged', fetchedAt: now, prior: { value: null, fetchedAt: now, vacatedPositions: [1] } }],
      ['import/expired', old],
    ]) };
    const importedRating = { put: { ratings: [{ show_id: 815, show: 'Fictional Summit', rating: 8 }] } };
    await db.writeTmdb(active, { entries: { 'import/stale': prior, 'import/concurrent': { value: 'newer', fetchedAt: Date.now() },
      'import/same-time': { value: 'different concurrent season', fetchedAt: prior.fetchedAt },
      'import/other-missing-season': { value: null, fetchedAt: now, vacatedPositions: [1, 2] } } });
    await failBeforeCompletion(() => db.commit(importRevision, importedRating, { tmdbImport: staged }), 'quota');
    check(!await db.tmdbEntry('import/missing') && (await db.tmdbEntry('import/stale')).value === prior.value &&
      !(await db.tmdbRows(815)).tables.ratings.length,
      'An aborted import published staged metadata or a personal row');
    await db.commit(importRevision, importedRating, { tmdbImport: staged });
    db.close();
    db = await openDeviceStore({ name });
    await connectFixtureProviders(db,name);
    check((await db.tmdbRows(815)).tables.ratings[0].rating === 8 && (await db.tmdbEntry('import/missing')).value === 'staged' &&
      (await db.tmdbEntry('import/stale')).value === 'new season positions' &&
      (await db.tmdbEntry('import/same-time')).value === 'different concurrent season' &&
      (await db.tmdbEntry('import/concurrent')).value === 'newer' && !await db.tmdbEntry('import/expired'),
      'Reopened import lost staged data, replaced a concurrent refresh, or admitted expired data');
    check((await db.tmdbEntry('import/missing-season')).vacatedPositions?.join() === '1,3' &&
      (await db.tmdbEntry('import/other-missing-season')).vacatedPositions?.join() === '1,2',
      'Reopening lost the occupied slots of a removed season or replaced newer slot history');
    const negativeExpiry = cacheExpiresAt(now);
    check((await db.tmdbEntry('import/missing-season',negativeExpiry - 1))?.vacatedPositions?.join() === '1,3' &&
      !await db.tmdbEntry('import/missing-season',negativeExpiry),
      'Removed-season slot history must expire with its 404 at the six-month boundary');
    passed.push('Import rows and fresh TMDB placements commit together, preserving newer and same-timestamp concurrent cache changes after reopen.');

    await checkBatchedMetadata(db,active,now);
    await checkMetadataTargets(db);
    passed.push('Batched TMDB reads preserve misses, expiry, input order and manual season splits without reading unrelated payloads.');

    const peer = await openDeviceStore({ name });
    try {
      check((await peer.tmdbEntry('config')).value.images.length === 1, 'Read-only tab cannot read cached configuration');
      let refused = false;
      try { await peer.writeTmdb(active, { entries: { reader: saved } }); }
      catch (error) { refused = error.name === 'InvalidStateError'; }
      check(refused && !await db.tmdbEntry('reader'), 'A reader could write metadata');
    } finally { peer.close(); }
    const stale = await db.beginTmdbSubmission();
    narrow = await db.tmdbRows(7);
    await db.invalidateTmdb();
    check(!await db.isTmdbSubmissionCurrent(stale) && !await db.writeTmdb(active, { entries: { late: saved } }) &&
      !await db.tmdbEntry('config') && (await db.snapshot()).revision > narrow.revision, 'Erase failed to fence a metadata reply or rewrite');
    passed.push('Readers can use cached data and erase fences pending checks, replies and row rewrites.');
  } finally { db.close(); }
}
