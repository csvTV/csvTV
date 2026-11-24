import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as flush } from 'node:timers/promises';
import { DropboxController } from '../dist/dropbox-controller.js';
import { checkResponse, DropboxError } from '../dist/dropbox-client.js';
import { fictionalDropboxTransport } from './dropbox-roundtrip-cases.mjs';
import { DropboxApi, dropboxContentHash } from '../dist/dropbox-api.js';
import { writeCsv } from '../dist/csv.js';
import { dropboxSessionInfo, StaleSnapshotError } from '../dist/storage.js';
import { credentials, memoryStore, time } from './dropbox-sync-fixture-cases.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(configure = () => {}) {
  const win = Object.assign(new EventTarget(), { document: Object.assign(new EventTarget(), { visibilityState: 'visible' }),
    navigator: { onLine: true } });
  let clock = time, id = 0;
  const timers = new Map();
  win.setTimeout = (run, delay) => { timers.set(++id, { due: clock + delay, run }); return id; };
  win.clearTimeout = id => timers.delete(id);
  async function tick(ms) {
    const end = clock + ms;
    for (;;) {
      const next = [...timers].filter(([,v]) => v.due <= end).sort((a,b) => a[1].due - b[1].due)[0];
      if (!next) break;
      clock = next[1].due; timers.delete(next[0]); next[1].run(); await flush();
    }
    clock = end; await flush();
  }
  const base = memoryStore();
  const store = Object.assign(new EventTarget(),base,{role:'writer', saved:null, dirty:false});
  store.legacyProviderSettings = async () => ({migrated:true});
  store.dropboxState = async () => {
    const snap = await base.snapshot();
    return { revision:snap.revision, accountId:snap.local.syncAccountId,
      session:snap.local.dropboxSession ? dropboxSessionInfo(snap.local.dropboxSession) : null,
      recordAppKey:'fixture-registration', dirty:store.dirty, status:store.saved };
  };
  store.saveDropboxStatus = async (v,current) => {
    if (!current()) throw new StaleSnapshotError();
    const s = await store.dropboxState();
    if (s.accountId !== v.accountId || s.session?.instanceId !== v.instanceId) throw new StaleSnapshotError();
    store.saved = structuredClone(v); store.dirty = false;
  };
  const signouts = [], erases = [];
  const auth = Object.assign(new EventTarget(), {store, close(){}, showRegistration(){}, status:store.dropboxState, checkDeadline:async()=>true,
    signOut:async pair => {
      const s = await store.dropboxState();
      if (pair && (pair.owner !== s.accountId || pair.instanceId !== s.session?.instanceId)) throw new StaleSnapshotError();
      signouts.push(s.session?.instanceId);
      await store.commit(s.revision, {removeLocal:['dropboxSession']}); return 'revoked';
    },
    revokeForErase:async s => { signouts.push(s.instanceId); return 'revoked'; }, authorize:async()=>{}});
  store.eraseDevice = async revision => {
    const s = await store.dropboxState();
    if (s.revision !== revision) throw new StaleSnapshotError();
    erases.push(s.session?.instanceId);
    await store.commit(revision,{removeLocal:['dropboxSession','syncAccountId']});
  };
  const questions = [];
  const dialogs = {close(){}, choose(title, body) {
    const { resolve,promise } = deferred(); questions.push({title,body,answer:resolve}); return promise;
  }};
  async function session(accountId, instanceId) {
    const s = await store.snapshot();
    await store.commit(s.revision, { local:{dropboxSession:{...credentials,accountId,instanceId}} });
    auth.dispatchEvent(new Event('change')); await flush();
  }
  function visibility(value) {
    win.document.visibilityState = value; win.document.dispatchEvent(new Event('visibilitychange'));
  }
  configure(store);
  const cloud = new DropboxController(auth,win,dialogs,()=>clock);
  return { win, store, auth, dialogs, cloud, questions, signouts, erases, session, tick, visibility };
}

test('a reader shows a pending sync while the writer waits, then shows the confirmed result', async t => {
  const writer = fixture(), reader = fixture(store => { store.role = 'reader'; });
  const entered = deferred(), release = deferred();
  t.after(() => { release.resolve(); reader.cloud.close(); writer.cloud.close(); });
  reader.store.dropboxState = writer.store.dropboxState;
  const {store, cloud} = writer;
  const initial = await store.snapshot();
  await store.commit(initial.revision,{local:{dropboxShowsHash:await dropboxContentHash(writeCsv('shows',[]))}});
  store.exportSnapshot = async () => ({...await store.snapshot(), missingShowIds:new Set(), showMetadata:new Map(),
    externalIds:new Map(), seasons:new Map()});
  cloud.backupAccess = async binding => ({binding, state:await store.dropboxState(), api:{async upload(){}},
    engine:{async run(){ entered.resolve(); await release.promise; return {complete:true,listing:[]}; }}});
  await cloud.refresh();
  const sync = cloud.exclusive('sync',() => cloud.syncFiles(false,undefined,{weeklyBackup:false}));
  try {
    await entered.promise;
    assert.equal(cloud.reason,'Sync in progress.');
    assert.equal(store.saved.reason,'Sync pending.');
    await reader.cloud.refresh();
    assert.equal(reader.cloud.reason,'Sync pending.');
    assert.equal(reader.cloud.synced,false);
  } finally { release.resolve(); await sync; }
  await reader.cloud.refresh();
  assert.equal(reader.cloud.synced,true);
  assert.equal(reader.cloud.reason,'Every file is synced.');
});

test('only a current grant’s legacy unfinished marker is shown as pending on reopen', async t => {
  const {store,cloud,win} = fixture(store => { store.role = 'reader'; });
  t.after(() => cloud.close());
  const old = 'The previous sync did not finish.';
  store.saved = {accountId:credentials.accountId,instanceId:credentials.instanceId,synced:false,
    day:new Date(time).toISOString().slice(0,10),reason:old,notices:[]};
  await cloud.refresh(true);
  assert.equal(cloud.reason,'Sync pending.');
  assert.equal(store.saved.reason,old);
  store.saved.reason = 'Dropbox declined this request.';
  await cloud.refresh();
  assert.equal(cloud.reason,store.saved.reason);
  store.saved.reason = old;
  store.saved.instanceId = 'unrelated-grant';
  await cloud.refresh();
  assert.equal(cloud.reason,'Changes are waiting to sync.');
  store.saved.instanceId = credentials.instanceId;
  win.navigator.onLine = false;
  await cloud.refresh();
  assert.equal(cloud.reason,'No connection. Changes stay on this device.');
  win.navigator.onLine = true;
  await store.commit((await store.snapshot()).revision,{local:{dropboxSession:{...credentials,signInDeadline:time}}});
  await cloud.refresh();
  assert.equal(cloud.reason,'Sign in to Dropbox.');
});

test('Clear this device checks unsynced rows, receipts, the displayed identity and the revision at confirmation', async t => {
  for (const mode of ['cancel','confirmed','signed-out','new-edit','replaced-session','dirty','waiting-row','pending-upload']) {
    const f = fixture();
    t.after(()=>f.cloud.close());
    if (mode === 'signed-out') await f.store.commit((await f.store.snapshot()).revision,{removeLocal:['dropboxSession']});
    if (mode === 'dirty') f.store.dirty = true;
    if (mode === 'waiting-row') await f.store.commit((await f.store.snapshot()).revision,
      {replace:{ratings:[{show_id:23,show:'Fictional coast',rating:8}]}});
    if (mode === 'pending-upload') await f.store.commit((await f.store.snapshot()).revision,
      {sync:{watched:{base:null,pending:{targetContent:'unacknowledged'}}}});
    await f.cloud.refresh();
    const work = f.cloud.clearLinkedDevice();
    if (['dirty','waiting-row','pending-upload'].includes(mode)) {
      await assert.rejects(work,/waiting for Dropbox/); assert.equal(f.questions.length,0);
    } else {
      await flush(); assert.equal(f.questions.length,1);
      assert.match(f.questions[0].body,/stays in Dropbox/);
      if (mode === 'new-edit') await f.store.commit((await f.store.snapshot()).revision,
        {replace:{lists:[{show_id:23,show:'Fictional coast',list:'Watchlist'}]}});
      if (mode === 'replaced-session') await f.session('new-owner','other-instance');
      f.questions[0].answer(mode === 'cancel'?'cancel':'erase');
      if (['new-edit','replaced-session'].includes(mode)) await assert.rejects(work,StaleSnapshotError);
      else await work;
    }
    assert.equal(f.erases.length,['confirmed','signed-out'].includes(mode)?1:0,mode);
  }
});

test('Manual backup rejects offline, read-only, signed-out, expired or superseded sign-ins before a provider request', async () => {
  for (const change of ['offline','reader','signed-out','expired','same-account sign-in','different account']) {
    const {cloud,store,win,auth} = fixture();
    let requests = 0;
    auth.request = async () => { requests++; throw Error('Unexpected provider request'); };
    try {
      await cloud.refresh();
      assert.equal(cloud.canBackUpNow,true);
      const before = await store.snapshot();
      if (change === 'offline') win.navigator.onLine = false;
      else if (change === 'reader') store.role = 'reader';
      else if (change === 'signed-out') await store.commit(before.revision,{removeLocal:['dropboxSession']});
      else if (change === 'expired') await store.commit(before.revision,{local:{dropboxSession:{...credentials,signInDeadline:time}}});
      else {
        // Hold the view at its old session, as when an OAuth callback wins before its change notification.
        const accountId = change === 'different account' ? 'replacement-account' : credentials.accountId;
        await store.commit(before.revision, {local:{syncAccountId:accountId,dropboxSession:{...credentials,accountId,instanceId:'new'}}});
      }
      await assert.rejects(cloud.backUpNow(),undefined,change);
      assert.equal(requests,0,change);
      if (!change.includes('account')) {
        await cloud.refresh();
        assert.equal(cloud.canBackUpNow,false,change);
      }
    } finally { cloud.close(); }
  }
});

test('a canceled key migration stays closed on reconnect until a relevant key, grant or explicit request changes',async()=>{
  const f = fixture(), provider = fictionalDropboxTransport(), localKey = {setting:'omdb_key',value:'fictional-local'};
  f.auth.request = async request=>{
    const reply = await provider.transport({...request,headers:{...request.headers,Authorization:'Bearer example-access'}});
    checkResponse(reply); return reply;
  };
  const api = new DropboxApi(f.auth);
  let remote = await api.upload('/settings.csv',writeCsv('settings',[{...localKey,value:'fictional-cloud'}]),{mode:'add'});
  f.store.legacyProviderSettings = async()=>({migrated:false,rows:[localKey],sync:null,revision:(await f.store.snapshot()).revision});
  const attempt = async automatic=>(await f.cloud.backupAccess(undefined,automatic)).providerSettings.load();
  async function dismiss(automatic,number) {
    const work = attempt(automatic), answered = assert.rejects(work,/migration paused/);
    for (let i=0;i<200 && f.questions.length<number;i++) await flush();
    const question = f.questions[number-1];
    assert.ok(question, 'expected key review '+number);
    assert.equal(question.title,'Move saved keys to Dropbox');
    assert.match(question.body,/omdb_key/); assert.doesNotMatch(question.body,/fictional-/);
    question.answer('cancel'); await answered;
  }
  try {
    await f.cloud.refresh();
    await dismiss(true,1);
    await assert.rejects(attempt(true),/migration paused/);
    assert.equal(f.questions.length,1);
    const rows = [{...localKey,value:'fictional-cloud'},{setting:'github_repo',value:'fictional/shows'}];
    remote = await api.upload('/settings.csv',writeCsv('settings',rows),{mode:'update',revision:remote.rev});
    await assert.rejects(attempt(true),/migration paused/);
    assert.equal(f.questions.length,1);
    await dismiss(false,2);
    rows[0] = {...localKey,value:'fictional-changed-again'};
    await api.upload('/settings.csv',writeCsv('settings',rows),{mode:'update',revision:remote.rev});
    await dismiss(true,3);
    await f.session(credentials.accountId,'replacement-grant');
    await f.cloud.refresh();
    await dismiss(true,4);
  } finally { f.cloud.close(); }
});

test('after Dropbox confirms a backup, losing the connection keeps the result tied to the same writer and session', async () => {
  for (const change of ['offline','same-account sign-in','read-only','expired','refused']) {
    const {cloud,store,win,auth} = fixture();
    const provider = fictionalDropboxTransport();
    let retention = false;
    auth.request = async request => {
      const path = JSON.parse(request.headers?.['Dropbox-API-Arg'] ?? request.body).path;
      if (request.endpoint === 'list' && path === '/backups' &&
          [...provider.files.keys()].some(name => name.endsWith('/completion.json')) &&
          !JSON.parse(new TextDecoder().decode(provider.files.get('/csvtv-reset.json').bytes)).reservations.length) {
        retention = true;
        if (change !== 'refused') win.navigator.onLine = false;
        if (change === 'read-only') store.role = 'reader';
        if (change === 'same-account sign-in' || change === 'expired') {
          const state = await store.snapshot();
          const session = change === 'expired' ? {...credentials,signInDeadline:time} : {...credentials,instanceId:'new-sign-in'};
          await store.commit(state.revision,{local:{dropboxSession:session}});
        }
        throw new DropboxError('unavailable');
      }
      if (retention && change === 'refused') throw new DropboxError('permission');
      const response = await provider.transport({...request,headers:{...request.headers,Authorization:'Bearer example-access'}});
      checkResponse(response);
      return response;
    };
    cloud.syncFiles = async () => store.saveDropboxStatus({accountId:credentials.accountId,instanceId:credentials.instanceId,
      synced:true,day:new Date(time).toISOString().slice(0,10),reason:'Synced.',notices:[]},()=>true);
    try {
      await cloud.refresh();
      if (change === 'offline') assert.equal((await cloud.backUpNow()).status,'verified');
      else await assert.rejects(cloud.backUpNow(), change === 'same-account sign-in' ? {kind:'account-changed'} :
        change === 'expired' ? /Sign in to Dropbox/ : change === 'read-only' ? /writer tab/ : {kind:'permission'});
      assert.equal(retention,true,change);
      assert.equal([...provider.files.keys()].filter(path => path.endsWith('/completion.json')).length,1,change);
    } finally { cloud.close(); }
  }
});

test('Sign out keeps a newer grant when a callback commits before Settings receives its change notification', async () => {
  for (const accountId of [credentials.accountId, 'replacement-account']) {
    const {cloud,store,signouts} = fixture();
    try {
      await cloud.refresh();
      const before = await store.snapshot();
      const replacement = {...credentials, accountId, instanceId:'new-login'};
      await store.commit(before.revision,{local:{dropboxSession:replacement}});
      await assert.rejects(cloud.signOut());
      assert.deepEqual(signouts,[]);
      assert.deepEqual((await store.dropboxState()).session,dropboxSessionInfo(replacement));
    } finally { cloud.close(); }
  }
});

test('Saving a key during background sync waits for that operation and rechecks the original form and account', async () => {
  for (const cancelled of [false,true]) {
    let save;
    const {cloud} = fixture(store=>{store.connectProviderKeys = callback=>{save = callback;};});
    await cloud.refresh();
    const release = deferred(), active = cloud.exclusive('sync',()=>release.promise);
    let current = true, sends = 0;
    cloud.backupAccess = async owner => {
      assert.equal(owner.instanceId,credentials.instanceId);
      return {providerSettings:{save:async () => {sends++;return [];}}};
    };
    const pending = save('omdb_key',null,'fictional',()=>current);
    await flush();
    assert.equal(sends,0);
    if (cancelled) current = false;
    release.resolve();
    await active;
    if (cancelled) await assert.rejects(pending,StaleSnapshotError); else assert.deepEqual(await pending,[]);
    assert.equal(sends,cancelled ? 0 : 1);
    cloud.close();
  }
});

test('A queued key finishes at the next settled sync stage, before weekly backup, without restarting the file merge', async t => {
  for (const stage of ['file merge','last merge','derived files']) {
    let save;
    const {cloud,store} = fixture(s=>{s.connectProviderKeys = callback=>{save = callback;};});
    t.after(()=>cloud.close());
    await cloud.refresh();
    const initial = await store.snapshot();
    await store.commit(initial.revision,{local:{dropboxShowsHash:await dropboxContentHash(writeCsv('shows',[]))}});
    const entered = deferred(), release = deferred(), installed = deferred(), backup = deferred(), finishBackup = deferred();
    async function pause(label) {
      if (stage === label) { entered.resolve(); await release.promise; }
    }
    let merges = 0, writes = 0;
    const operations = [];
    cloud.changed.addEventListener('change',()=>operations.push(cloud.operation));
    store.exportSnapshot = async () => {
      await pause('derived files');
      return {...await store.snapshot(), missingShowIds:new Set(), showMetadata:new Map(), externalIds:new Map(), seasons:new Map()};
    };
    const binding = {accountId:credentials.accountId, instanceId:credentials.instanceId};
    const engine = {async run({beforeMerge}) {
      merges++;
      await pause('file merge');
      const served = await beforeMerge();
      assert.equal(served,stage === 'file merge');
      await pause('last merge');
      return {complete:true, listing:[]};
    }};
    const api = {async upload(){}, async list(path) {
      assert.equal(path,'/backups'); backup.resolve(); await finishBackup.promise;
      throw Error('Fictional backup unavailable');
    }};
    cloud.backupAccess = async expected => {
      assert.equal(expected.accountId,binding.accountId);
      assert.equal(expected.instanceId,binding.instanceId);
      return {engine,api,binding,state:await store.dropboxState(),
        providerSettings:{async save() { writes++; return []; }}};
    };
    const sync = cloud.exclusive('sync',()=>cloud.syncFiles(false));
    await entered.promise;
    const key = save('github_token',null,'fictional-test-value',()=>true,installed.promise);
    assert.equal(writes,0);
    release.resolve();
    assert.deepEqual(await key,[]);
    assert.equal(writes,1);
    assert.equal(cloud.operation,'save key');
    await assert.rejects(cloud.signOut(),/Another operation/);
    installed.resolve();
    await backup.promise;
    assert.equal(cloud.operation,'sync');
    assert.equal(merges,1);
    assert.ok(operations.indexOf('sync') < operations.indexOf('save key'));
    assert.ok(operations.lastIndexOf('sync') > operations.indexOf('save key'));
    finishBackup.resolve();
    await assert.rejects(sync,/Fictional backup unavailable/);
    assert.equal(cloud.busy,false);
  }
});

test('A queued key cannot outlive its grant or its editing tab, or interrupt restore and manual backup', async t => {
  for (const change of ['expired','closed','restore','backup']) {
    let save;
    const {cloud,store,auth} = fixture(s=>{s.connectProviderKeys = callback=>{save = callback;};});
    t.after(()=>cloud.close());
    await cloud.refresh();
    const release = deferred();
    const active = cloud.exclusive(['restore','backup'].includes(change) ? change : 'sync',()=>release.promise);
    let sends = 0;
    auth.request = async () => { sends++; throw Error('Unexpected key transfer'); };
    const refused = assert.rejects(save('github_token',null,'fictional-test-value',()=>true),
      change === 'expired' ? /Sign in to Dropbox/ : change === 'closed' ? StaleSnapshotError : /Another operation/);
    if (change === 'expired') {
      const snapshot = await store.snapshot();
      await store.commit(snapshot.revision,{local:{dropboxSession:{...credentials,signInDeadline:time}}});
    } else if (change === 'closed') cloud.close();
    if (change !== 'expired') await refused;
    release.resolve(); await Promise.all([active,refused]);
    assert.equal(sends,0);
  }
});

test('Manual backup holds the operation, preserves the preflight failure and creates no generation after a newer edit', async () => {
  for (const change of ['failed sync','new edit','new session']) {
    const {cloud,store,auth} = fixture();
    const started = deferred(), release = deferred();
    let requests = 0;
    auth.request = async request => {
      if (request.endpoint === 'download' && JSON.parse(request.headers['Dropbox-API-Arg']).path === '/csvtv-reset.json')
        throw new DropboxError('not-found');
      requests++; throw Error('Unexpected backup request');
    };
    try {
      await cloud.refresh();
      cloud.syncFiles = async (manual,expected) => {
        assert.equal(manual,true);
        assert.equal(expected.accountId,credentials.accountId); assert.equal(expected.instanceId,credentials.instanceId);
        started.resolve(); await release.promise;
        if (change === 'failed sync') throw Error('Resolve the rating conflict first.');
        await store.saveDropboxStatus({accountId:credentials.accountId,instanceId:credentials.instanceId,
          synced:true,day:new Date(time).toISOString().slice(0,10),reason:'Synced.',notices:[]},()=>true);
        if (change === 'new edit') cloud.edited();
        if (change === 'new session') await store.commit((await store.snapshot()).revision,
          {local:{dropboxSession:{...credentials,instanceId:'later'}}});
      };
      const backup = cloud.backUpNow(); await started.promise;
      assert.equal(cloud.operation,'backup'); assert.equal(cloud.canBackUpNow,false);
      await assert.rejects(cloud.backUpNow(),/Another operation/);
      await assert.rejects(cloud.signOut(),/Another operation/);
      release.resolve();
      await assert.rejects(backup, change === 'failed sync' ? /Resolve the rating conflict/ :
        change === 'new edit' ? /Changes are waiting/ : error => error.kind === 'account-changed');
      assert.equal(requests,0); assert.equal(cloud.busy,false);
    } finally { cloud.close(); }
  }
});

test('Opening syncs immediately, edits debounce for ten seconds, hiding flushes a pending edit, and a minute away reopens sync', async () => {
  const {cloud, tick, visibility} = fixture(), calls = [];
  cloud.syncFiles = async manual => { calls.push(manual); };
  await cloud.refresh(true); await tick(0);
  assert.deepEqual(calls,[true]);
  cloud.edited(); await tick(9000); cloud.edited(); await tick(9999); assert.equal(calls.length,1);
  await tick(1); assert.deepEqual(calls,[true,false]);
  cloud.edited(); visibility('hidden'); await tick(0); assert.deepEqual(calls,[true,false,false]);
  await tick(59999); visibility('visible'); await tick(0); assert.equal(calls.length,3);
  visibility('hidden'); await tick(60000); visibility('visible'); await flush(); await tick(0);
  assert.deepEqual(calls,[true,false,false,true]);
  cloud.close();
});

test('An explicit sync during restore waits, coalesces requests, and starts once after the exclusive operation ends', async () => {
  const {cloud,tick} = fixture(), calls = [];
  cloud.syncFiles = async manual => { calls.push([manual,cloud.operation]); };
  await cloud.refresh(true); await tick(0); calls.length=0;
  const wait = deferred();
  const restore = cloud.exclusive('restore',async () => { await wait.promise; });
  cloud.queueSync(); cloud.queueSync(true); cloud.edited(); await tick(10001);
  await assert.rejects(cloud.exclusive('hand merge',async()=>{}),/Another operation/);
  await assert.rejects(cloud.exclusive('import',async()=>{}),/Another operation/);
  await assert.rejects(cloud.signOut(),/Another operation/);
  assert.deepEqual(calls,[]);
  wait.resolve(); await restore; await tick(0);
  assert.deepEqual(calls,[[true,'sync']]); cloud.close();
});

test('an edit arriving after Sync now keeps its scheduled manual retry', async t => {
  const {cloud,store,tick} = fixture(), runs = [];
  t.after(() => cloud.close());
  cloud.syncFiles = async (retry, owner, {automatic}) => {
    runs.push({retry,automatic});
    store.saved = {accountId:credentials.accountId, instanceId:credentials.instanceId,
      day:new Date(time).toISOString().slice(0,10), synced:true, reason:'Every file is synced.', notices:[]};
  };
  await cloud.refresh(true); await tick(0); runs.length = 0;
  cloud.queueSync(true);
  cloud.edited();
  await tick(0);
  assert.deepEqual(runs,[{retry:true,automatic:false}]);
  await cloud.refresh();
  assert.equal(cloud.synced,true);
  await tick(10_000);
  assert.equal(runs.length,1);
});

test('Import preflight and backup reject a replaced sign-in before contacting Dropbox', async () => {
  const {cloud, session, auth, store} = fixture();
  const expected = {accountId: credentials.accountId, instanceId: credentials.instanceId};
  let requests = 0;
  auth.request = async () => { requests++; throw Error('Unexpected Dropbox request'); };
  try {
    await session(credentials.accountId, 'replacement');
    await assert.rejects(cloud.backupAccess(expected), error => error.kind === 'account-changed');
    await assert.rejects(cloud.syncFiles(true, expected), error => error.kind === 'account-changed');
    assert.equal(requests, 0);
    assert.equal((await store.dropboxState()).session.instanceId, 'replacement');
  } finally { cloud.close(); }
});

test('Erase and backup access recheck the active writer after reading the session', async () => {
  for (const action of ['erase','backup']) for (const change of ['handoff','close',...(action === 'backup' ? ['offline'] : [])]) {
    const {cloud,store,win,signouts,erases}=fixture();
    const revision=(await store.snapshot()).revision;
    const read=store.dropboxState, paused=deferred(), resume=deferred();
    const delayed=async () => {
      const state=await read();
      paused.resolve();
      await resume.promise;
      return state;
    };
    if (action==='erase') store.dropboxState=delayed;
    else cloud.auth.status=delayed;
    const operation=action==='erase' ? cloud.erase(revision) : cloud.backupAccess();
    await paused.promise;
    if (change==='handoff') store.role='reader';
    else if (change==='offline') win.navigator.onLine=false;
    else cloud.close();
    resume.resolve();
    try {
      await assert.rejects(operation);
      assert.deepEqual(signouts,[],action+' '+change);
      assert.deepEqual(erases,[],action+' '+change);
      assert.equal((await read()).session.instanceId,credentials.instanceId);
    } finally { cloud.close(); }
  }
});

test('A short foreground return across UTC midnight schedules the new shared-summary date', async () => {
  const {cloud,tick,visibility} = fixture(), runs=[];
  cloud.syncFiles=async manual=>{runs.push(manual);};
  await cloud.refresh(true); await tick(0);
  await tick(12 * 60 * 60 * 1000 - 10_000);
  visibility('hidden'); await tick(11_000); visibility('visible'); await flush(); await tick(0);
  assert.deepEqual(runs,[true,false]); cloud.close();
});

test('A signed-out or offline writer sends nothing; reconnecting resumes without retrying canceled files as a manual sync', async () => {
  const {cloud,win,store,tick} = fixture();
  const notices = [];
  cloud.hooks.notice = message => notices.push(message);
  let calls = [];
  cloud.syncFiles = async manual => { calls.push(manual); };
  win.navigator.onLine = false;
  await cloud.refresh(true); cloud.queueSync(true); await tick(0);
  assert.equal(cloud.synced,false); assert.match(cloud.reason,/No connection/); assert.deepEqual(calls,[]);
  win.navigator.onLine = true; win.dispatchEvent(new Event('online')); await flush(); await tick(0);
  assert.deepEqual(calls,[false]); await cloud.signOut(); await flush();
  assert.ok(notices.includes('Signed out. Your watch record stays on this device.'));
  assert.equal(cloud.signedIn,false); cloud.queueSync(true); await tick(0); assert.equal(calls.length,1);
  assert.equal((await store.dropboxState()).accountId,credentials.accountId); cloud.close();
});

test('A reader shows the persisted writer outcome and reports, responds to dirty data, and expires without dispatching a sync', async () => {
  const {cloud,store,tick} = fixture(); store.role='reader';
  store.saved = { accountId:credentials.accountId, instanceId:credentials.instanceId, day:'2026-10-01', synced:true,
    reason:'Every file is synced.', notices:['Kept a rating.'] };
  cloud.syncFiles = async () => { throw Error('A reader cannot run sync'); };
  await cloud.refresh(true); assert.equal(cloud.synced,true); assert.deepEqual(cloud.notices,['Kept a rating.']);
  store.dirty = true; store.dispatchEvent(new Event('dropboxstatus')); await flush();
  assert.equal(cloud.synced,false); assert.match(cloud.reason,/waiting/);
  await tick(credentials.signInDeadline - time);
  assert.equal(cloud.signedIn,false); assert.equal(cloud.synced,false); assert.match(cloud.reason,/Sign in/); cloud.close();
});

test('Canceling a different Dropbox sign-in uses only account state and revokes only the displayed grant', async () => {
  for (const change of ['unchanged','same-account-replacement','expired','reader']) {
    const {cloud,questions,session,store,signouts,tick} = fixture();
    try {
      await session('B','login-b');
      if (change === 'same-account-replacement') await session('B','replacement');
      if (change === 'expired') await tick(credentials.signInDeadline - time);
      if (change === 'reader') store.role = 'reader';
      let snapshots = 0;
      store.snapshot = async () => { snapshots++; throw Error('Cancel cannot load the watch record'); };
      questions[0].answer('cancel'); await flush();
      assert.equal(snapshots,0,change);
      assert.deepEqual(signouts,change === 'unchanged' ? ['login-b'] : [],change);
      assert.equal((await store.dropboxState()).accountId,credentials.accountId,change);
    } finally { cloud.close(); questions.at(-1)?.answer('cancel'); }
  }
});

test('Old account choices cannot merge data, erase the record, or revoke a more recent callback', async () => {
  for (const choice of ['merge','erase','cancel']) {
    const {cloud,questions,session,store,signouts,erases} = fixture();
    await session('B','login-b'); await flush(); assert.match(questions[0].body,/B/);
    await session('C','login-c'); questions[0].answer(choice); await flush();
    const state = await store.dropboxState();
    assert.equal(state.accountId,credentials.accountId); assert.equal(state.session.instanceId,'login-c');
    assert.equal(cloud.mismatch,true); assert.equal(cloud.synced,false); assert.match(questions.at(-1).body,/C/);
    assert.deepEqual(signouts,[]); assert.deepEqual(erases,[]); cloud.close(); questions.at(-1).answer('cancel');
  }
});

test('Changing accounts cannot upload or discard a quarantined key, including one held only in an old receipt', async () => {
  for (const source of ['row','base','pending','targetContent','unreadable']) {
    const {cloud,questions,session,store,signouts,tick} = fixture();
    const value = 'setting,value\r\nomdb_key,fictional-before-upgrade\r\n';
    const state = {migrated:false,rows:source==='row'?[{setting:'omdb_key',value:'fictional-before-upgrade'}]:[],
      sync:{base:source==='base'?{content:value}:null,pending:source==='pending'?{content:value}:
        source==='targetContent'?{targetContent:value}:source==='unreadable'?{content:'damaged legacy file'}:null}};
    store.legacyProviderSettings = async () => state;
    let transfers = 0;
    cloud.syncFiles = async () => { transfers++; };
    await session('different-account','other-login');
    questions[0].answer('merge'); await flush(); await tick(1);
    assert.equal((await store.snapshot()).local.syncAccountId,credentials.accountId);
    assert.deepEqual(signouts,['other-login']);
    assert.equal(transfers,0);
    assert.ok(cloud.notices.some(text=>text.includes('original Dropbox account')));
    cloud.close();
  }
});

test('Merge consent resets old bases and pending files, retains the last timestamp, and queues a no-base sync', async () => {
  const {cloud,questions,session,store,tick} = fixture(), runs = [];
  const cm = '2026-09-01T00:00:01Z';
  const before = await store.snapshot();
  await store.commit(before.revision,{sync:{watched:{base:{revision:'old',content:'old'},pending:{},lastClientModified:cm}},
    local:{'dropboxCanceled:watched':true,dropboxShowsHash:'old'}});
  cloud.syncFiles = async () => { runs.push(await store.dropboxState()); };
  await session('B','login-b'); await flush(); questions[0].answer('merge'); await flush(); await tick(1);
  const after = await store.snapshot();
  assert.equal(after.local.syncAccountId,'B'); assert.deepEqual(after.sync.watched,{base:null,pending:null,lastClientModified:cm});
  assert.equal(after.local['dropboxCanceled:watched'],undefined); assert.equal(after.local.dropboxShowsHash,undefined);
  assert.equal(runs.length,1); assert.equal(runs[0].accountId,'B'); cloud.close();
});

test('Cancellation caused by closing the app cannot sign the owner out; a callback during erase revocation fences the final deletion', async () => {
  const first = fixture();
  first.dialogs.close = () => first.questions.at(-1)?.answer('cancel');
  await first.session('B','login-b'); await flush();
  first.cloud.close(); await flush(); assert.deepEqual(first.signouts,[]); assert.deepEqual(first.erases,[]);
  const f = fixture(), gate = deferred();
  f.auth.revokeForErase = async session => { f.signouts.push(session.instanceId); await gate.promise; return 'revoked'; };
  await f.session('B','login-b'); await flush(); f.questions[0].answer('erase'); await flush();
  f.questions[1].answer('erase'); await flush(); assert.deepEqual(f.signouts,['login-b']);
  await f.session('C','login-c'); gate.resolve(); await flush();
  assert.deepEqual(f.erases,[]); assert.equal((await f.store.dropboxState()).session.instanceId,'login-c');
  f.cloud.close(); f.questions.at(-1)?.answer('cancel');
});

test('A failed file keeps a durable reason and notices; derived files and weekly backup are skipped', async () => {
  const {cloud,store,tick} = fixture();
  cloud.backupAccess = async () => ({api:{}, binding:credentials,state:await store.dropboxState(), engine:{async run() {
    cloud.report('Review the changed watch rows.'); return {complete:false,reason:'Review canceled.',listing:[],notices:[]};
  }}});
  await cloud.refresh(true); await tick(0);
  assert.equal(cloud.synced,false); assert.equal(store.saved.synced,false); assert.equal(store.saved.reason,'Review canceled.');
  assert.deepEqual(store.saved.notices,['Review the changed watch rows.']); cloud.close();
});
