import { deviceMigrations, openDeviceStore } from '../dist/storage.js';
import { writeCsv } from '../dist/csv.js';
import { DropboxSync } from '../dist/dropbox-sync.js';
import {checkDropboxFile} from '../dist/dropbox-limits.js';
import { credentials, count, edit, FictionalDropbox, sync, time, watch, watchCsv } from './dropbox-sync-fixture-cases.mjs';

function check(value, message) { if (!value) throw Error(message); }
async function database(exercise) {
  const name = 'csvtv-dropbox-engine-' + crypto.randomUUID();
  const opened = new Set();
  async function open(writer = true) {
    const store = await openDeviceStore({ name }); opened.add(store);
    if (writer) await store.whenWriter();
    return store;
  }
  try {
    const first = await open(); await first.storeExchangedSession(credentials);
    await exercise(first, open, new FictionalDropbox());
  } finally {
    for (const store of opened) store.close();
    const deletion = indexedDB.deleteDatabase(name);
    await new Promise((yes, no) => { deletion.onsuccess = yes; deletion.onerror = () => no(deletion.error); });
  }
}

// Abort the real IndexedDB transaction at the chosen write, after saving the table was enqueued.
async function abortAt(outcome, execute) {
  const original = IDBObjectStore.prototype.put;
  let hit = false;
  IDBObjectStore.prototype.put = function (value, key) {
    const req = original.apply(this, arguments);
    if (!hit && this.name === 'sync' && key === 'watched' && (outcome === 'prepare' ? value.pending : !value.pending)) {
      hit = true;
      req.addEventListener('success', () => this.transaction.abort(), { once: true });
    }
    return req;
  };
  let failed = false;
  try { await execute(); }
  catch { failed = true; }
  finally { IDBObjectStore.prototype.put = original; }
  check(hit && failed, 'The named IndexedDB failure did not interrupt sync.');
}

export async function dropboxEngineCases(run) {
  await run('Two offline databases upgrade their physical list keys, sync independent edits and reopen with identical memberships', async () => {
    const cloud = new FictionalDropbox(), path = '/lists.csv';
    const content = 'list,show_id,show\nfavourites,1,Clock Beach\nFavorites,1,Clock Beach\nStopped,2,Second Shore\n' +
      Array.from({length:8},(_,i)=>'My Favourites,'+(i+3)+',Story '+i+'\n').join('');
    const file = await cloud.put(path,content), stores = [], databases = [];
    const request = read=>new Promise((resolve,reject)=>{read.onsuccess=()=>resolve(read.result);read.onerror=()=>reject(read.error);});
    async function priorDevice() {
      const name = 'legacy-list-keys-'+crypto.randomUUID();
      databases.push(name);
      const legacyVersion = 5; // The last schema with the old physical list keys.
      const prior = await openDeviceStore({name,migrations:deviceMigrations.slice(0,legacyVersion)}); stores.push(prior);
      await prior.whenWriter(); await prior.storeExchangedSession(credentials);
      await prior.commit((await prior.snapshot()).revision,{sync:{lists:{base:{content,revision:file.rev},pending:null}}});
      await prior.closeForUpdate();
      const db = await request(indexedDB.open(name,legacyVersion));
      try {
        const tx = db.transaction('lists','readwrite'), list = tx.objectStore('lists');
        for (const line of content.trimEnd().split('\n').slice(1)) {
          const [label,id,title] = line.split(',');
          list.add({list:label,show_id:Number(id),show:title});
        }
        await new Promise((res,rej)=>{tx.oncomplete=res;tx.onabort=()=>rej(tx.error);});
      } finally {db.close();}
      return name;
    }
    async function reopen(name) {
      const db = await openDeviceStore({name}); stores.push(db); await db.whenWriter(); return db;
    }
    try {
      const left = await priorDevice(), right = await priorDevice(), a = await reopen(left), b = await reopen(right);
      await a.commit((await a.snapshot()).revision,{remove:{lists:[['Dropped',2]]}});
      await b.commit((await b.snapshot()).revision,{put:{lists:[{list:'FAVOURITES',show_id:11,show:'Late Signal'}]}});
      for (const device of [a,b,a]) check((await sync(device,cloud).run()).complete,'Unexpected guard during list migration');
      await a.closeForUpdate(); await b.closeForUpdate();
      for (const name of [left,right]) {
        const db = await reopen(name), snapshot = await db.snapshot(), rows = snapshot.tables.lists;
        check(rows.length===10 && rows.filter(row=>row.list==='Favorites').length===2 && rows.filter(row=>row.list==='My Favourites').length===8,
          'A peer restored a removed drop, lost a favorite or renamed a custom list');
        check(writeCsv('lists',rows)===snapshot.sync.lists.base.content && new TextDecoder().decode(cloud.live.get(path).bytes)===snapshot.sync.lists.base.content,
          'Cloud and reopened devices disagree on the actual CSV bytes');
      }
    } finally {
      for (const db of stores) db.close();
      for (const name of databases) await request(indexedDB.deleteDatabase(name));
    }
  });
  await run('An oversized Dropbox record cannot replace local watches or advance the base; a corrected file syncs after reopening', () =>
    database(async (store, open, cloud) => {
      const path = '/watched.csv';
      const base = await cloud.put(path,watchCsv(1));
      await sync(store,cloud).run();
      await edit(store,watch(2));
      const tooWide = await cloud.put(path,','.repeat(128));
      cloud.before = async (method,name) => {
        if (method === 'download' && name === path) checkDropboxFile(path,cloud.live.get(path).bytes);
      };
      let failure;
      try { await sync(store,cloud).run(); } catch(error) { failure=error; }
      check(failure?.kind==='too-large','Sync hid an oversized Dropbox file');
      const state = (await store.snapshot()).sync.watched;
      check(await count(store)===2 && state.base.revision===base.rev && !state.pending &&
        cloud.live.get(path).metadata.rev===tooWide.rev,'Oversized input changed local watches, remote file or the acknowledged base');
      store.close();
      const next = await open();
      await cloud.put(path,watchCsv(1));
      const result = await sync(next,cloud).run();
      check(result.complete && await count(next)===2 && cloud.rows('watched')[0].times_watched===2,
        'Reopening after replacing the large file lost the offline edit');
    }));

  await run('A reopened incomplete upload receipt preserves the record and asks before sending any watched data', () =>
    database(async (store, open, cloud) => {
      const base = await cloud.put('/watched.csv', watchCsv(1));
      await sync(store, cloud).run();
      await edit(store, watch(2));
      const snapshot = await store.snapshot(), stamp = new Date(time).toISOString();
      const pending = {content:watchCsv(2),targetRevision:base.rev,targetModified:base.serverModified,clientModified:stamp,preparedAt:time};
      await store.commit(snapshot.revision, {sync:{watched:{...snapshot.sync.watched,lastClientModified:'unusable',pending}}});
      store.close();
      const reopened = await open(); cloud.calls.length = 0;
      let question;
      await sync(reopened, cloud, {guard:async q => { question = q; return 'cancel'; }}).run();
      check(question?.decision.case === 3 && question.unsynced === null,
        'The reopened receipt was accepted or a missing target was treated as a known count');
      check(!cloud.calls.some(c => c.method === 'upload' && c.path === '/watched.csv') &&
        cloud.rows('watched')[0].times_watched === 1 && await count(reopened) === 2, 'Cancel did not preserve both records');
      await sync(reopened, cloud, {guard:async () => 'combine'}).run({retryCanceled:true});
      check(cloud.rows('watched')[0].times_watched === 2 && !(await reopened.snapshot()).sync.watched.pending,
        'The reviewed combine did not recover the incomplete receipt');
      check(Date.parse(cloud.live.get('/watched.csv').metadata.clientModified) === time + 1000,
        'The reviewed combine reused the timestamp of a previous upload');
    }));

  await run('A failed pending-upload transaction sends nothing and the original row survives a close and reopen', () =>
    database(async (store, open, cloud) => {
      await edit(store, watch(3));
      await abortAt('prepare', () => sync(store, cloud).run());
      check(!cloud.calls.some(c => c.method === 'upload'), 'Aborted preparation sent bytes.');
      store.close();
      const reopened = await open();
      check(await count(reopened) === 3 && !(await reopened.snapshot()).sync.watched?.pending, 'Partial preparation persisted.');
      await sync(reopened, cloud).run();
      check(cloud.rows('watched')[0].times_watched === 3, 'Retry did not send the original local row.');
    }));

  await run('After an accepted upload and failed acknowledgement, a reopened device settles remote and offline increases exactly once', () =>
    database(async (store, open, cloud) => {
      await cloud.put('/watched.csv', watchCsv(1));
      await sync(store, cloud).run();
      await edit(store, watch(2));
      await abortAt('ack', () => sync(store, cloud).run());
      const accepted = cloud.live.get('/watched.csv').metadata;
      check(cloud.rows('watched')[0].times_watched === 2, 'Dropbox did not receive the interrupted upload.');
      store.close();
      const reopened = await open();
      const pending = (await reopened.snapshot()).sync.watched.pending;
      check(pending.content === watchCsv(2) && accepted.clientModified === pending.clientModified, 'Pending bytes or timestamp changed on reopen.');
      await edit(reopened, watch(3));
      await cloud.put('/watched.csv', watchCsv(5));
      await sync(reopened, cloud, { doubleMarks: async review => ({ choice:review.delivery?'one':'two' }) }).run();
      check(await count(reopened) === 6 && cloud.rows('watched')[0].times_watched === 6, 'Lost acknowledgement reapplied a previous delta.');
      check(!(await reopened.snapshot()).sync.watched.pending, 'Reconciled upload stayed pending.');
    }));

  await run('A code exchange in a reader fences the writer’s accepted reply; signing into the data-owning account settles it', () =>
    database(async (store, open, cloud) => {
      await edit(store, watch(2));
      const reader = await open(false);
      cloud.after = async () => {
        cloud.after = async () => {};
        await reader.storeExchangedSession({ ...credentials, accountId:'other', instanceId:'other-session' });
      };
      let failed = false;
      try { await sync(store, cloud).run(); } catch { failed = true; }
      const stranded = await store.snapshot();
      check(failed && stranded.local.syncAccountId === credentials.accountId &&
        stranded.local.dropboxSession.accountId === 'other' && stranded.sync.watched.pending, 'Old reply crossed the account boundary.');
      cloud.calls.length = 0;
      try { await new DropboxSync(store, cloud, { accountId:'other', instanceId:'other-session' }, {}, () => time).run(); }
      catch { /* Mismatched record owner. */ }
      check(cloud.calls.length === 0, 'The second account saw the first account’s record.');
      const restored = { ...credentials, instanceId:'next-instance' };
      await reader.storeExchangedSession(restored);
      await new DropboxSync(store, cloud, restored, {}, () => time).run();
      const result = await store.snapshot();
      check(!result.sync.watched.pending && result.sync.watched.base.revision === cloud.live.get('/watched.csv').metadata.rev &&
        await count(store) === 2, 'The owner could not settle its earlier upload.');
      await store.saveDropboxStatus({accountId:restored.accountId, instanceId:restored.instanceId,
        day:'2026-10-01',synced:true,reason:'Every file is synced.',notices:[]},()=>true);
      const synced = await reader.dropboxState();
      check(synced.status.synced && !synced.dirty, 'Read-only tab missed the persisted sync outcome.');
      await edit(store,watch(3));
      check((await reader.dropboxState()).dirty, 'A committed edit left the stored sync indicator current.');
      let denied = false;
      try { await reader.saveDropboxStatus(synced.status,()=>true); } catch { denied=true; }
      check(denied && (await store.dropboxState()).dirty, 'A read-only tab rewrote the sync indicator.');
    }));
}
