import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {openChromium} from './offline-chromium.mjs';
import {listen, stop, testSite} from './offline-site.mjs';

async function exercise() {
  const {openDeviceStore,deviceMigrations} = await import('/tracker/storage.js');
  const name = 'fictional-statistics-migration';
  // The reader must observe the committed database even without peer messages.
  window.BroadcastChannel = undefined;
  function check(condition,message) { if (!condition) throw Error(message); }
  function requestResult(request) {
    return new Promise((resolve,reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  function finished(tx) {
    return new Promise((resolve,reject) => {
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error);
    });
  }
  const watched = {show_id:77,show:'Signal Garden',season:1,episode:1,episode_id:7701,title:'Landing',times_watched:1};
  let writer = await openDeviceStore({name,migrations:deviceMigrations.slice(0,7)});
  let reader, raw;
  try {
    await writer.whenWriter();
    const edit = async (patch,options) => writer.commit((await writer.devicePreference('statisticsScope')).revision,patch,options);
    await edit({put:{watched:[watched]},local:{statisticsScope:'anime',statisticsOpened:true}});
    const old = await writer.statisticsState();
    check(old.preference==='anime' && old.statisticsOpened && old.revision === (await writer.overviewRows('statistics')).revision,
      'A device with the previous schema must read its record and legacy tab');
    await writer.closeForUpdate();
    writer = await openDeviceStore({name});
    await writer.whenWriter();
    reader = await openDeviceStore({name});
    raw = await requestResult(indexedDB.open(name));
    async function stateAt(scope,opened,plays) {
      const [state,canonical,record] = await Promise.all([reader.statisticsState(),reader.devicePreference('statisticsScope'),
        reader.overviewRows('statistics')]);
      check((state.preference ?? null) === scope && (canonical.preference ?? null) === scope &&
        state.statisticsOpened === opened && canonical.statisticsOpened === opened,'Wrong tab or first-open state');
      check(state.revision===record.revision && record.watched.reduce((n,row)=>n+row.times_watched,0)===plays,
        'Record and report revision disagree');
      return state.revision;
    }
    const initial = await stateAt('anime',true,1);
    // Hold the *actual* stores for a pending Library preference. A new report can
    // read all its inputs before that write settles, with no timing assumptions.
    const blocker = raw.transaction(['settings','meta','local'],'readwrite');
    const drained = finished(blocker);
    let hold = true;
    function keepAlive() { if (hold) blocker.objectStore('settings').get('library_sort').onsuccess = keepAlive; }
    keepAlive();
    let saved = false;
    const sorting = writer.selectDisplayPreference('librarySort','title').then(()=>{ saved = true; });
    let timeout;
    try {
      const [stamp,record] = await Promise.race([Promise.all([reader.statisticsState(),reader.overviewRows('statistics')]),
        new Promise((_,reject)=>{ timeout = setTimeout(()=>reject(Error('Report reads blocked on a pending sort')),3000); })]);
      check(!saved && stamp.revision===initial && record.revision===initial && record.watched[0].times_watched===1,
        'A pending sort prevented reading the committed report');
    } finally {
      clearTimeout(timeout);
      hold = false;
      await Promise.all([drained,sorting]);
    }
    const sort = await reader.devicePreference('librarySort');
    check(sort.preference==='title' && sort.revision>initial && await stateAt('anime',true,1)===initial,
      'The durable sort must advance the sync revision without changing the report');
    await edit({sync:{watched:{base:{revision:'fictional-receipt',content:'verified'},pending:null}}},{syncWrite:true});
    check(await stateAt('anime',true,1)===initial,'A sync receipt invalidated the report');
    const canceled = ['watched','ratings','lists','settings'].map(name=>'dropboxCanceled:'+name);
    const beforeCancel = (await reader.snapshot()).revision;
    await edit({local:Object.fromEntries(canceled.map(name=>[name,true]))},{syncWrite:true});
    const suppressed = await reader.snapshot();
    check(suppressed.revision>beforeCancel && canceled.every(name=>suppressed.local[name]===true) &&
      await stateAt('anime',true,1)===initial,'A canceled review must persist without discarding the report');
    await edit({removeLocal:canceled},{syncWrite:true});
    const cleared = await reader.snapshot();
    check(cleared.revision>suppressed.revision && canceled.every(name=>!Object.hasOwn(cleared.local,name)) &&
      await stateAt('anime',true,1)===initial,'Resuming a canceled file must clear its marker without discarding the report');
    await edit({replace:{settings:[{setting:'statistics_scope',value:'tv'}]}},{syncWrite:true});
    await stateAt('tv',true,1);
    await edit({remove:{settings:['statistics_scope']}},{syncWrite:true});
    await stateAt('anime',true,1);
    await edit({replace:{settings:[{setting:'statistics_scope',value:'tv'}]},remove:{settings:['statistics_scope']},
      put:{settings:[{setting:'statistics_scope',value:'all'}]},removeLocal:['statisticsScope','statisticsOpened']});
    const beforeEdit = await stateAt('all',false,1);
    await edit({put:{watched:[{...watched,times_watched:2}]},removeLocal:['dropboxCanceled:watched']},{syncWrite:true});
    const afterEdit = await stateAt('all',false,2);
    check(afterEdit>beforeEdit,'Editing a watched episode must invalidate the report in a reader');
    await writer.openStatistics();
    await writer.selectStatisticsScope('tv');
    check(await stateAt('tv',true,2)===afterEdit,'Selecting a tab must preserve the underlying record');
    const explicitCommit = IDBTransaction.prototype.commit;
    try {
      IDBTransaction.prototype.commit = undefined;
      await writer.selectDisplayPreference('librarySort','episodes');
    } finally { IDBTransaction.prototype.commit = explicitCommit; }
    check((await reader.devicePreference('librarySort')).preference==='episodes' && await stateAt('tv',true,2)===afterEdit,
      'The preference must commit normally in a browser without explicit transaction commit');

    // If only an older/incomplete stamp is available, use the authoritative record revision.
    const damaged = raw.transaction('statistics','readwrite');
    damaged.objectStore('statistics').delete('revision');
    await finished(damaged);
    check(await stateAt('tv',true,2)===(await reader.devicePreference('statisticsScope')).revision,
      'A missing report stamp must fall back to the entire record');
    await edit({put:{watched:[{...watched,times_watched:3}]}});
    await stateAt('tv',true,3);
    // An unsuccessful write cannot publish a new revision or scope to another tab.
    const current = (await reader.devicePreference('statisticsScope')).revision;
    let refused = false;
    try { await writer.commit(current-1n,{replace:{settings:[]},remove:{watched:[[77,1,1]]}}); }
    catch { refused = true; }
    check(refused && await stateAt('tv',true,3)===current,'An aborted transaction exposed uncommitted report state');
    const put = IDBObjectStore.prototype.put;
    let failedAtStamp = false;
    try {
      IDBObjectStore.prototype.put = function(value,...args) {
        if (this.name==='statistics' && value.key==='revision') throw new DOMException('Fictional quota','QuotaExceededError');
        return put.call(this,value,...args);
      };
      try { await edit({put:{watched:[{...watched,times_watched:4}],settings:[{setting:'statistics_scope',value:'anime'}]}}); }
      catch(error) { failedAtStamp = error.name==='QuotaExceededError'; }
    } finally { IDBObjectStore.prototype.put = put; }
    check(failedAtStamp && await stateAt('tv',true,3)===current,'A failed report write must also roll back watches and settings');
    async function failSort() {
      const attempt = {};
      let rejected = false;
      IDBTransaction.prototype.commit = function() { this.abort(); };
      try { await writer.selectDisplayPreference('librarySort','rating',attempt); }
      catch { rejected = true; }
      finally { IDBTransaction.prototype.commit = explicitCommit; }
      check(rejected && attempt.previous,'A real failed sort must retain its conditions for Retry');
      return attempt;
    }
    const beforeAccount = await failSort();
    const deadline = Date.now()+86400000;
    const session = {accountId:'fictional-new-account',instanceId:crypto.randomUUID(),
      accessToken:'fictional-access',refreshToken:'fictional-refresh',accessExpiresAt:Date.now()+300000,
      providerExpiresAt:deadline,signInDeadline:deadline};
    await reader.storeExchangedSession(session);
    const signedIn = await stateAt('tv',true,3);
    check(signedIn>current,'A reader completing sign-in must fence every earlier report');
    await writer.selectDisplayPreference('librarySort','rating',beforeAccount);
    check((await reader.devicePreference('librarySort')).preference==='episodes','A failed save retried under another linked account');
    await edit({remove:{settings:['library_sort']}});
    const beforeErase = await failSort();
    await writer.eraseDevice((await reader.devicePreference('librarySort')).revision);
    check(await stateAt(null,false,0)>signedIn,'Device erasure must fence every earlier report');
    await reader.storeExchangedSession({...session,instanceId:crypto.randomUUID()});
    await writer.selectDisplayPreference('librarySort','rating',beforeErase);
    check(!(await reader.devicePreference('librarySort')).preference,'A Retry survived device erasure and same-account sign-in');
    return true;
  } finally {
    raw?.close();
    await reader?.closeForUpdate();
    await writer.closeForUpdate();
  }
}

test('Statistics reads through a pending sort and tracks the committed inputs across upgrade, sync, rejection and erase',
  {timeout:30000},async t => {
    const {server} = await testSite(), origin = 'http://127.0.0.1:'+await listen(server);
    const profile = await mkdtemp(join(tmpdir(),'csvtv-statistics-inputs-'));
    let browser;
    t.after(async () => {
      try { await browser?.close(); }
      finally { await stop(server); await rm(profile,{recursive:true,force:true,maxRetries:6,retryDelay:150}); }
    });
    browser = await openChromium(profile);
    await browser.navigate(origin+'/fixture');
    assert.equal(await browser.evaluate('('+exercise+')()'),true);
  });
