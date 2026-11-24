// Runs against the same compiled application modules served to an isolated browser.
export async function importRecordWorkerCase({base,mode,changes=2053,expectWorker=true}) {
  const {openDeviceStore,canceledKey,deviceMigrations} = await import(base+'storage.js');
  const {writeCsv} = await import(base+'csv.js');
  const check = (ok,why) => { if (!ok) throw Error(mode+': '+why); };
  const original=Worker,nativePut=IDBObjectStore.prototype.put,name='fictional-import-job-'+crypto.randomUUID();
  const open=()=>openDeviceStore(mode==='legacy'?{name,migrations:deviceMigrations.slice(0,-2)}:{name});
  let store=await open(),later,expires=false,current=true,jobs=0,batches=0,requests=0,validated=0,failures=0;
  const submitted=Promise.withResolvers(),hold=Promise.withResolvers();
  const at=Date.now(),deadline=at+86400000;
  const account='import-test-owner',session={accountId:account,instanceId:'import-lease',signInDeadline:deadline};
  const auth={...session,appKey:'fictional-app',accessToken:'import-example-access',refreshToken:'import-example-refresh',
    accessExpiresAt:deadline,providerExpiresAt:deadline};
  const providerKey='import-example-provider-key', secret=[auth.accessToken,auth.refreshToken,providerKey];
  const managed=async()=>{store.connectProviderKeys(()=>{throw Error('Unexpected provider edit');},()=>expires?deadline:Date.now());
    await store.loadProviderKeys(session,[{setting:'tmdb_key',value:providerKey}],()=>true);};
  const keys=['tv/72/season/1','tv/72/season/2','tv/72/season/3','tv/72/season/4'];
  const cacheValue=x=>({fetchedAt:at-10000,value:{show_id:72,name:'Season '+x,season:x,episodes:[]}});
  const unrelated={show_id:11,show:'Fictional Moor',season:2,episode:1,episode_id:1101,title:'Moor',times_watched:3};
  const displaced={show_id:72,show:'Fictional Estuary',season:3,episode:1,episode_id:7200,title:'Early position',times_watched:2};
  const baseRows=[unrelated,displaced],putWatch=Array.from({length:changes-1},(_,i)=>({show_id:72,show:'Fictional Estuary',season:1,episode:i+1,
    episode_id:i+7200,title:'Chapter '+(i+1),times_watched:i===0?2:1}));
  const recent={setting:'recently_marked.72.3.0.0',value:'982/0'},oldMark={...recent,value:'654/654'};
  const kept={setting:'recently_marked.11',value:'12/12'},rating={show_id:72,show:'Fictional Estuary',rating:9};
  const title={show_id:72,show:'Fictional Estuary',year:2014,imdb_id:'tt1234567'};
  const list={list:'Favourites',show_id:72,show:'Fictional Estuary'};
  const patch={put:{watched:putWatch,ratings:[rating],shows:[title],lists:[list],settings:[recent]},
    remove:{watched:[[72,3,1]]},local:{recentlyMarked:[11]},removeLocal:['displacedRecentMark']};
  try {
    await store.whenWriter();await store.storeExchangedSession(auth);await managed();
    const first=await store.snapshot();const generation=first.tmdbGeneration;
    const existing=cacheValue(3);
    await store.commit(first.revision,{put:{watched:baseRows,settings:[kept,oldMark]},local:{recentlyMarked:[11,72],displacedRecentMark:72,
      [canceledKey('ratings')]:true,[canceledKey('watched')]:true}},{tmdbImport:{generation,entries:new Map([[keys[1],existing]])},current:()=>true});
    const before=await store.snapshot(),priorCache=await store.tmdbEntries(keys,at);
    const entries=new Map([[keys[0],{...cacheValue(1),prior:null}],[keys[1],{...cacheValue(2),prior:null}],
      [keys[2],{...cacheValue(3),fetchedAt:at+86400000,prior:null}],[keys[3],{...cacheValue(4),fetchedAt:1,prior:null}]]);
    const options={requireTmdbGeneration:generation,tmdbImport:{generation,entries,session},current:()=>current};
    if(mode==='native-expiry')IDBObjectStore.prototype.put=function(...args){
      const request=nativePut.apply(this,args);
      if(this.name==='watched' && args[0].episode===putWatch.at(-1).episode)
        request.addEventListener('success',()=>{expires=true;},{once:true});
      return request;
    };
    if(mode==='removed-key')store.clearProviderKeys();
    let revision=before.revision;
    if(mode==='prior-grant'||mode==='native-prior-grant'){
      await store.storeExchangedSession({...auth,instanceId:'same-owner-replacement'});
      revision=(await store.dropboxState()).revision;
    }
    let drain,closing;
    if(mode==='handoff')later=await open();
    const observe=(worker,event)=>{
      const {type}=event.data;
      if(type==='progress') {
        batches++;
        if(batches===1 && mode==='expired')expires=true;
        if(batches===1 && mode==='left')current=false;
        if(batches===1 && mode==='cleared')store.clearProviderKeys();
        if(batches===1 && mode==='handoff') {
          drain=store.afterPendingWrites(()=>{throw Error('An aborted import passed the update barrier');}).then(()=>false,()=>true);
          closing=store.closeForUpdate();
        }
        if(batches===1 && mode==='killed') {
          event.stopImmediatePropagation();worker.terminate();
          worker.dispatchEvent(new ErrorEvent('error',{cancelable:true}));
        }
      }
      if(type==='admission') {
        requests++;
        if(mode==='offline-at-end')current=false;
        if(mode==='no-admission')event.stopImmediatePropagation();
      }
      if(type==='complete' && mode==='lost-success') {
        event.stopImmediatePropagation();
        worker.dispatchEvent(new ErrorEvent('error',{cancelable:true}));
      }
    };
    window.Worker=class extends original {
      constructor(url,options){
        if(mode.startsWith('native'))throw new DOMException('Fictional unsupported worker','NotSupportedError');
        const fixture={'quota':'/fictional-cache-quota.js','constraint':'/fictional-constraint.js','worker-expired':'/fictional-worker-expiry.js'}[mode];
        super(fixture ? new URL(fixture,location.href) : url,options);
        this.addEventListener('message',event=>observe(this,event));
      }
      postMessage(message,...rest){
        const serialized=JSON.stringify(message,(_,v)=>typeof v==='bigint'?String(v):v instanceof Map?[...v]:v);
        check(!secret.some(key=>serialized.includes(key)),'A secret was sent to a record worker');
        if(message.patch){
          jobs++;
          check(Object.keys(message).sort().join()==='accountId,entries,erased,expiresAt,generation,id,patch,revision','Unexpected worker interface');
          submitted.resolve();
          if(mode==='revision'||mode==='grant'||mode==='erase'||mode==='generation'){
            void hold.promise.then(()=>super.postMessage(message,...rest));return;
          }
        }
        if(message.type==='admit')validated++;
        super.postMessage(message,...rest);
      }
    };
    const outcome=store.commit(revision,patch,options).then(()=>({saved:true}),e=>({saved:false,error:e.name,message:e.message}));
    if(['revision','grant','erase','generation'].includes(mode)){
      await submitted.promise;
      if(mode==='revision')await store.commit(before.revision,{put:{ratings:[{...rating,rating:4}]}});
      if(mode==='grant')await store.storeExchangedSession({...auth,instanceId:'another-lease'});
      if(mode==='erase')await store.eraseDevice(before.revision);
      if(mode==='generation')await store.commit(before.revision,{},{invalidateTmdbWork:true});
      hold.resolve();
    }
    const result=await outcome;
    if(mode==='handoff'){await closing;check(await drain,'Update acknowledged an aborted import');await later.whenWriter();later.close();later=undefined;}
    const expected=['valid','legacy','native','lost-success'].includes(mode);
    check(result.saved===expected,'Wrong transaction outcome '+JSON.stringify(result));
    if(!expected)check(result.error===({'no-admission':'TimeoutError',killed:'AbortError',quota:'QuotaExceededError',constraint:'ConstraintError'}[mode]??'StaleSnapshotError'),
      'Unexpected abort '+JSON.stringify(result));
    if(mode!=='handoff' && mode!=='erase'){
      const settled=await store.snapshot();
      if(expected)check(settled.revision===before.revision+1n && settled.local.recentlyMarked.join()==='11' &&
        !Object.hasOwn(settled.local,'displacedRecentMark'),'Revision or legacy recents differ before reopening');
      else check(settled.local.displacedRecentMark===72,'An interrupted import modified the older recents');
    }
    window.Worker=original;
    await store.closeForUpdate();store=await open();await store.whenWriter();
    const after=await store.snapshot(),cached=await store.tmdbEntries(keys,at),t=after.tables;
    if(mode==='erase')check(!t.watched.length&&!t.ratings.length&&!t.lists.length&&!t.shows.length,'Erased import returned');
    else if(expected) {
      check(writeCsv('watched',t.watched)===writeCsv('watched',[unrelated,...putWatch]),'Episode moves or counts differ, saved '+t.watched.length);
      check(after.revision===before.revision+2n,'Reopening the older recent list did not migrate it once');
      check(writeCsv('ratings',t.ratings)===writeCsv('ratings',[rating]) && writeCsv('shows',t.shows)===writeCsv('shows',[title]) &&
        writeCsv('lists',t.lists)===writeCsv('lists',[{...list,list:'Favorites'}]),'Ratings, index or lists differ');
      check(t.settings.some(r=>r.setting===recent.setting && r.value===recent.value) &&
        t.settings.some(r=>r.setting===kept.setting && r.value===kept.value) &&
        !Object.hasOwn(after.local,'displacedRecentMark'),'A shared or legacy recent mark changed incorrectly');
      check(!after.local[canceledKey('watched')] && !after.local[canceledKey('ratings')],'A canceled sync flag survived');
      check(cached[0]?.value.name==='Season 1' && cached[1]?.value.name===existing.value.name && !cached[2] && !cached[3],
        'New, superseded, future or expired cache metadata differs');
    } else {
      check(writeCsv('watched',t.watched)===writeCsv('watched',baseRows) && !t.lists.length && !t.shows.length,'Partial watch, list or index survived');
      check(t.ratings.length===(mode==='revision'?1:0) && (!t.ratings.length || t.ratings[0].rating===4),'Rating escaped or an independent edit was lost');
      check(JSON.stringify(cached)===JSON.stringify(priorCache),'Partial metadata survived');
      check(t.settings.some(r=>r.setting===oldMark.setting && r.value===oldMark.value) &&
        after.local[canceledKey('watched')],'Partial recent mark or sync state survived');
    }
    const shouldSend=expectWorker&&!mode.startsWith('native')&&!['prior-grant','removed-key'].includes(mode);
    check(jobs===Number(shouldSend),'Unexpected submissions '+jobs);
    if(shouldSend && expected)check(validated===1 && requests===1 && batches>0,'The editor did not admit exactly one complete transaction');
    return {mode,jobs,batches,requests,result};
  } finally {
    window.Worker=original;IDBObjectStore.prototype.put=nativePut;hold.resolve();later?.close();await store.closeForUpdate();
    await new Promise((yes,no)=>{const q=indexedDB.deleteDatabase(name);q.onsuccess=yes;q.onerror=()=>no(q.error);});
  }
}
