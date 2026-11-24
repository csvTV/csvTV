import { openDeviceStore } from '../dist/storage.js';
import { writeCsv } from '../dist/csv.js';

function check(value,message) { if (!value) throw Error(message); }
function read(request) {
  return new Promise((resolve,reject)=>{
    request.onsuccess = ()=>resolve(request.result);
    request.onerror = ()=>reject(request.error);
  });

}
async function rejected(operation,message) {
  try { await operation; } catch { return; }
  throw Error(message);
}
async function assertNoSecrets(name,secrets) {
  const db = await read(indexedDB.open(name));
  try {
    const tx = db.transaction(Array.from(db.objectStoreNames));
    for (const record of await Promise.all(Array.from(db.objectStoreNames,async table=>{
      const store = tx.objectStore(table);
      const [keys,values] = await Promise.all([read(store.getAllKeys()),read(store.getAll())]);
      return JSON.stringify([keys,values],(_,v)=>typeof v === 'bigint' ? String(v) : v);
    }))) for (const value of secrets) check(!record.includes(value),'A provider credential reached persistent device storage');
  } finally { db.close(); }
}

export async function providerVaultCases(run) {
  await run('Opening a route or preparing sign-in can read the public registration without loading the Dropbox grant',async()=>{
    const name='fictional-registration-'+crypto.randomUUID(),store=await openDeviceStore({name});
    const get=IDBObjectStore.prototype.get;
    try {
      await store.whenWriter();
      const empty=await store.dropboxState('registration');
      check(empty.accountId===null && empty.recordAppKey===null,'A new device has no linked registration');
      const end=Date.now()+3_600_000;
      await store.storeExchangedSession({accountId:'fixture-owner',instanceId:'fixture-login',appKey:'fixture-app',
        accessToken:'fictional-only',refreshToken:'fictional-renewal',accessExpiresAt:end,providerExpiresAt:end,signInDeadline:end});
      const keys=[];
      IDBObjectStore.prototype.get=function(key){keys.push([this.name,key]);return get.call(this,key);};
      const registration=await store.dropboxState('registration');
      check(registration.accountId==='fixture-owner' && registration.recordAppKey==='fixture-app' &&
        Object.keys(registration).length===2,'Unexpected linked registration fields');
      check(JSON.stringify(keys)===JSON.stringify([['local','syncAccountId'],['local','syncAppKey']]),'A registration read loaded unrelated device data');
    } finally {IDBObjectStore.prototype.get=get;await store.closeForUpdate();indexedDB.deleteDatabase(name);}
  });
  await run('An upgrade without space to store its device key keeps the existing record readable until reopening', async () => {
    const name = 'quota-upgrade-' + crypto.randomUUID();
    let store = await openDeviceStore({name});
    const original = IDBObjectStore.prototype.put;
    try {
      const snapshot = await store.whenWriter();
      await store.commit(snapshot.revision,{put:{ratings:[{show_id:1,show:'Quiet Crossing',rating:7}]}});
      await store.closeForUpdate();
      const db = await read(indexedDB.open(name));
      const tx = db.transaction('meta','readwrite');
      tx.objectStore('meta').delete('providerTagKey');
      await new Promise((resolve,reject) => { tx.oncomplete=resolve; tx.onabort=()=>reject(tx.error); });
      db.close();
      IDBObjectStore.prototype.put = function(value,key) {
        if (this.name === 'meta' && key === 'providerTagKey') throw new DOMException('Fixture storage is full','QuotaExceededError');
        return original.apply(this,arguments);
      };
      store = await openDeviceStore({name});
      await rejected(store.whenWriter(),'A full device was admitted as a writer');
      check(store.role === 'reader' && store.readOnlyReason?.includes('storage is full'),'Storage limit did not leave the record readable');
      check((await store.snapshot()).tables.ratings[0]?.rating === 7,'The existing rating was inaccessible');
      check((await store.exportSnapshot(false,Date.now())).tables.ratings[0]?.rating === 7,'The existing rating could not be exported');
      await store.closeForUpdate();
      IDBObjectStore.prototype.put = original;
      store = await openDeviceStore({name});
      check((await store.whenWriter()).tables.ratings[0]?.rating === 7,'A retry lost the existing rating');
    } finally {
      IDBObjectStore.prototype.put = original;
      await store.closeForUpdate();
      indexedDB.deleteDatabase(name);
    }
  });
  await run('Provider keys stay in Dropbox across a failed edit, session replacement, the weekly cutoff and an offline reopen',async()=>{
    const name = 'fictional cloud-only keys '+crypto.randomUUID();
    const secrets = ['fictional-title-token','fictional-critic-key','fictional-omdb-key','fictional-github-token'];
    const rows = ['tmdb_key','mdblist_key','omdb_key','github_token'].map((setting,i)=>({setting,value:secrets[i]}));
    const now = Date.now();
    let time = now, writes = 0, accepted = false;
    const session = {accountId:'fictional-A',instanceId:'fictional-lease',signInDeadline:now+10,providerExpiresAt:now+10,
      accessExpiresAt:now+5,accessToken:'fictional-dropbox-access',refreshToken:'fictional-dropbox-refresh'};
    const save = async (key,expected,next,current)=>{
      check(current() && key === 'mdblist_key' && expected === secrets[1] && next === 'fictional-replacement','Incorrect remote compare-and-save');
      writes++;
      if (!accepted) throw Error('Dropbox unavailable');
      return rows.map(row=>row.setting === key ? {...row,value:next} : row);
    };
    let store = await openDeviceStore({name}), peer;
    try {
      await store.whenWriter();
      const change = async () => store.commit((await store.snapshot()).revision,{put:{settings:[{setting:'mdblist_key',value:'fictional-replacement'}]}});
      await rejected(change(),'An unbound device saved a provider key');
      await store.storeExchangedSession(session);
      store.connectProviderKeys(save,()=>time);
      await rejected(store.loadProviderKeys({...session,accountId:'fictional-B'},rows,()=>true),'Wrong Dropbox account hydrated keys');
      await store.loadProviderKeys(session,rows,()=>true);
      check((await store.tmdbState()).token === secrets[0] && !(await store.snapshot()).tables.settings.length,'Cloud-only credential read failed');
      const gen = (await store.mdbListState()).generation;
      await store.writeMdbList(gen,{entries:new Map([[7,{fetchedAt:now,scores:{tomatoes:70,metacritic:null,myanimelist:null}}]])});
      await rejected(change(),'Failed remote write was acknowledged');
      check((await store.mdbListState()).key === secrets[1],'Rejected remote edit changed the active key');
      accepted = true; await change();
      check((await store.mdbListState()).key === 'fictional-replacement' && writes === 2,'Verified replacement was not admitted');
      const wire = writeCsv('settings',rows);
      await store.commit((await store.snapshot()).revision,{sync:{settings:{base:{content:wire,revision:'r1'},lastClientModified:null,
        pending:{content:wire,targetContent:wire,targetRevision:'r1',targetModified:null,preparedAt:0,clientModified:'fictional-time'}}}});
      await assertNoSecrets(name,[...secrets,'fictional-replacement']);
      const active = (await store.mdbListState()).generation;
      time = session.signInDeadline;
      check(!(await store.tmdbState('access')).token && !store.providerKeysAvailable && !await store.writeMdbList(active,{pause:null}) &&
        !(await store.imdbState()).config.omdb_key && !(await store.malState()).config.github_token,'Expired credentials admitted work');
      await rejected(change(),'Expired session saved a key');
      check(writes === 2,'Expired session attempted a remote write');
      store.close(); store = await openDeviceStore({name}); await store.whenWriter();
      const offline = await store.mdbListState([7]);
      check(!offline.key && offline.entries.get(7)?.scores.tomatoes === 70 && store.hasProviderKey('mdblist_key'),'Cold offline reopen lost scores or exposed credentials');
      const renewed = {...session,instanceId:'renewed',signInDeadline:time+100,providerExpiresAt:time+100};
      await store.storeExchangedSession(renewed); store.connectProviderKeys(save,()=>time);
      await store.loadProviderKeys(renewed,rows,()=>true);
      peer = await openDeviceStore({name});
      await peer.storeExchangedSession({...renewed,accountId:'fictional-B',instanceId:'different'});
      check(!(await store.tmdbState('access')).token && !(await store.tmdbState()).token && !(await store.malState()).config.github_token,
        'Delayed account-change notification left a credential usable');
      await assertNoSecrets(name,[...secrets,'fictional-replacement']);
    } finally { peer?.close(); store.close(); indexedDB.deleteDatabase(name); }
  });
}
