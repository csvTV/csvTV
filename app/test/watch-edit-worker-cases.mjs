export const manualWatchModes=['online','legacy','native','cached-offline','undo-no-grant','cached-wrong-owner','key-expired',
  'new-revision','rotation','other-owner','erased','left','handoff','no-admission','lost-success','no-receipt','quota'];

export function manualWatchFixture(req,res) {
  if(req.url!=='/fictional-watch-edit-quota.js')return false;
  res.writeHead(200,{'content-type':'text/javascript'}).end(`
    const put=IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put=function(value,...args){
      if(this.name==='settings')throw new DOMException('Fictional storage full','QuotaExceededError');
      return put.call(this,value,...args);
    };
    await import('/tracker/watch-edit-worker.js');`);
  return true;
}

export async function manualWatchWorkerCase({base,mode}){
  const {openDeviceStore,deviceMigrations,canceledKey}=await import(base+'storage.js');
  const {writeCsv}=await import(base+'csv.js');
  const {PersonalRecordError}=await import(base+'personal-record.js');
  const check=(value,label)=>{if(!value)throw Error(mode+' · '+label);};
  const name='fictional-bulk-watch-'+crypto.randomUUID(),Original=Worker,account='fictional-watch-owner';
  const open=()=>openDeviceStore(mode==='legacy'?{name,migrations:deviceMigrations.slice(0,-2)}:{name});
  const submitted=Promise.withResolvers(),release=Promise.withResolvers();
  let store=await open(),peer,closing,drain,current=true,expired=false,submissions=0,admissions=0,batches=0;
  const now=Date.now(),deadline=now+86400000,session={accountId:account,instanceId:'watch-grant',signInDeadline:deadline};
  const auth={...session,providerExpiresAt:deadline,appKey:'fictional-app-key',accessToken:'watch-example-access',
    refreshToken:'watch-example-refresh',accessExpiresAt:deadline};
  const key='fictional-manual-key',secrets=[key,auth.accessToken,auth.refreshToken,auth.appKey];
  const kept={show_id:81,show:'Evening Orchard',season:1,episode:1,episode_id:8011,title:'Pears',times_watched:9};
  const deleted={...kept,show_id:82,show:'Pale Orchard',season:3,episode_id:8801};
  const rows=Array.from({length:520},(_,i)=>({show_id:82,show:'Pale Orchard',season:1,episode:i+1,episode_id:82000+i,title:'Part '+(i+1),times_watched:2}));
  const recent={setting:'recently_marked.82.1.0.0',value:'41/41'},unrelated={setting:'recently_marked.81.1.0.0',value:'11/11'};
  const variant=['new-revision','rotation','other-owner','erased'].includes(mode);
  try{
    await store.whenWriter();await store.storeExchangedSession(auth);
    store.connectProviderKeys(async()=>{throw Error('Unexpected key edit');},()=>expired?deadline:Date.now());
    await store.loadProviderKeys(session,[{setting:'tmdb_key',value:key}],()=>true);
    const first=await store.snapshot();
    await store.commit(first.revision,{put:{watched:[kept,deleted],settings:[unrelated]},local:{
      [canceledKey('settings')]:true,[canceledKey('watched')]:true,recentlyMarked:[81,82]}});
    if(['cached-offline','undo-no-grant'].includes(mode)){
      await store.commit((await store.snapshot()).revision,{removeLocal:['dropboxSession']});
      store.clearProviderKeys();
    }
    const before=await store.snapshot(),config={watchEdit:true,requireTmdbGeneration:mode==='undo-no-grant'?undefined:before.tmdbGeneration,
      cachedMarkAccount:mode==='cached-offline'?account:mode==='cached-wrong-owner'?'another-owner':undefined,current:()=>current};
    const patch={put:{watched:rows,settings:[recent]},remove:{watched:[[82,3,1]]},removeLocal:['recentlyMarked']};
    if(mode==='handoff')peer=await open();
    window.Worker=class extends Original{
      constructor(url,options){
        if(mode==='native')throw new DOMException('Fictional disabled worker','NotSupportedError');
        super(mode==='quota'?new URL('/fictional-watch-edit-quota.js',location.href):url,options);
        this.addEventListener('message',event=>{
          const type=event.data?.type;
          if(type==='progress'){
            batches++;
            if(batches===1 && mode==='key-expired')expired=true;
            if(batches===1 && mode==='left')current=false;
            if(batches===1 && mode==='handoff'){
              drain=store.afterPendingWrites(()=>{throw Error('Aborted edit passed the update barrier');}).then(()=>false,()=>true);
              closing=store.closeForUpdate();
            }
            if(batches===1 && mode==='no-receipt'){
              event.stopImmediatePropagation();this.terminate();this.dispatchEvent(new ErrorEvent('error',{cancelable:true}));
            }
          }
          if(type==='admission' && mode==='no-admission')event.stopImmediatePropagation();
          if(type==='complete' && mode==='lost-success'){
            event.stopImmediatePropagation();this.dispatchEvent(new ErrorEvent('error',{cancelable:true}));
          }
        });
      }
      postMessage(message,...rest){
        const wire=JSON.stringify(message,(_,value)=>typeof value==='bigint'?String(value):value);
        check(!secrets.some(s=>wire.includes(s)),'Unexpected credential in worker message');
        if(message.put){
          submissions++;
          check(Object.keys(message).sort().join()==='clearLegacy,erased,generation,id,owner,put,recent,remove,revision','Unexpected fields in manual watch job');
          check(message.put.length===520 && message.recent.length===1 && message.remove.length===1,'Wrong job projection');
          if(variant){submitted.resolve();void release.promise.then(()=>super.postMessage(message,...rest));return;}
        }
        if(message.type==='admit')admissions++;
        super.postMessage(message,...rest);
      }
    };
    const pending=store.commit(before.revision,patch,config).then(()=>({saved:true}),error=>({saved:false,name:error.name,review:error instanceof PersonalRecordError}));
    if(variant){
      await submitted.promise;
      if(mode==='new-revision')await store.commit(before.revision,{put:{ratings:[{show_id:81,show:kept.show,rating:8}]}});
      if(mode==='rotation')await store.commit(before.revision,{},{invalidateTmdbWork:true});
      if(mode==='other-owner')await store.commit(before.revision,{local:{syncAccountId:'another-owner'}});
      if(mode==='erased')await store.eraseDevice(before.revision);
      release.resolve();
    }
    const outcome=await pending;
    if(mode==='handoff'){await closing;check(await drain,'Update passed before aborted write');await peer.whenWriter();peer.close();peer=undefined;}
    const saved=['online','legacy','native','cached-offline','undo-no-grant','lost-success'].includes(mode);
    check(outcome.saved===saved,'Unexpected result '+JSON.stringify(outcome));
    if(mode==='no-receipt')check(outcome.review,'Uncertain rewatch could be replayed by generic Retry');
    else if(!saved)check(outcome.name===({quota:'QuotaExceededError','no-admission':'TimeoutError'}[mode]??'StaleSnapshotError'),'Unexpected error '+outcome.name);
    if(mode==='native'||mode==='cached-wrong-owner')check(submissions===0,'Ineligible rows left the document');
    else check(submissions===1,'Operation was dispatched more than once');
    if(saved&&mode!=='native')check(admissions===1,'No final UI admission');
    if(saved){
      const after=await store.snapshot();
      const req=r=>new Promise((ok,fail)=>{r.onsuccess=()=>ok(r.result);r.onerror=()=>fail(r.error);});
      const db=await req(indexedDB.open(name));
      try{check(await req(db.transaction('local').objectStore('local').getKey('recentlyMarked'))===undefined,'Legacy mark survived');}
      finally{db.close();}
      check(after.revision===before.revision+1n && after.local.recentlyMarked.join()==='82,81','Revision or displayed recency did not commit atomically');
      check(!after.local[canceledKey('settings')]&&!after.local[canceledKey('watched')],'Canceled file flags survived');
    }
    window.Worker=Original;await store.closeForUpdate();store=await open();await store.whenWriter();
    const after=await store.snapshot(),expected=mode==='erased'?[]:saved?[kept,...rows]:[kept,deleted];
    check(writeCsv('watched',after.tables.watched)===writeCsv('watched',expected),'Reopened counts or identities differ');
    check(after.tables.settings.some(r=>r.setting===recent.setting&&r.value===recent.value)===saved,'Personal recent mark and watched rows disagree');
    if(mode!=='erased')check(after.tables.settings.some(r=>r.setting===unrelated.setting&&r.value===unrelated.value),'Lost unrelated recency');
    if(mode==='new-revision')check(after.tables.ratings.some(r=>r.show_id===81&&r.rating===8),'Replaced a newer edit');
    return {mode,submissions,admissions,batches};
  }finally{
    release.resolve();window.Worker=Original;peer?.close();store.close();indexedDB.deleteDatabase(name);
  }
}

export async function protectedBulkUndo(base) {
  const {openDeviceStore}=await import(base+'storage.js'),{TmdbService}=await import(base+'tmdb-service.js');
  const {WatchActions}=await import(base+'watch-actions.js'),{episodeKey}=await import(base+'watch-identity.js');
  const {tmdbResourceKey}=await import(base+'tmdb-client.js'), name='fictional-bulk-undo-'+crypto.randomUUID();
  const original=Worker,check=(ok,message)=>{if(!ok)throw Error(message);};
  let store=await openDeviceStore({name}),service;
  const total=520,id=71,show='Fictional glasshouse',changed=10;
  const watched=Array.from({length:total},(_,i)=>({show_id:id,show,season:1,episode:i+1,episode_id:71000+i,title:'Chapter '+i,times_watched:1}));
  try{
    await store.whenWriter();
    const deadline=Date.now()+86400000,session={accountId:'fictional-undo-owner',instanceId:'fictional-undo-lease',signInDeadline:deadline};
    await store.storeExchangedSession({...session,appKey:'fictional-app',accessToken:'example-access',refreshToken:'example-refresh',
      accessExpiresAt:deadline,providerExpiresAt:deadline});
    store.connectProviderKeys(async()=>{throw Error('Unexpected credential edit');},Date.now);
    await store.loadProviderKeys(session,[{setting:'tmdb_key',value:'fictional-undo-key'}],()=>true);
    const prior=await store.snapshot(),fetchedAt=Date.now(),episodes=watched.map(({episode,episode_id,title})=>({episode,episode_id,title,runtime:24,airDate:'2014-01-01'}));
    const header={show_id:id,show,status:'Ended',seasons:[{season:1,episodeCount:total}],lastAired:{season:1,episode:total,airDate:'2014-01-01'},nextEpisode:null,nextAirDate:null};
    await store.writeTmdb(prior.tmdbGeneration,{entries:{
      [tmdbResourceKey({kind:'show',id})]:{fetchedAt,value:header},
      [tmdbResourceKey({kind:'season',id,season:1})]:{fetchedAt,value:{show_id:id,season:1,episodes}},
    }});
    await store.commit((await store.dropboxState()).revision,{put:{watched}},{watchEdit:true,current:()=>true});
    service=new TmdbService(store);
    const notices=[],actions=new WatchActions(service,async()=>true,()=>{},message=>notices.push(message));
    await actions.bulk(id,{},'again');
    const before=await store.snapshot();
    check(before.tables.watched.every(r=>r.times_watched===2),'Rewatch did not save exactly once');
    await store.commit(before.revision,{put:{watched:[{...watched[changed],times_watched:5}]}},{syncWrite:true});
    const sizes=[];
    window.Worker=class extends original{
      constructor(url,options){
        super(url,options);let protectedRow=false;
        this.addEventListener('message',event=>{
          if(sizes.length===1 && !protectedRow && event.data.type==='progress'){
            protectedRow=true;actions.protect([episodeKey(watched[changed])]);
          }
        });
      }
      postMessage(message,...other){if(message.put)sizes.push(message.put.length);super.postMessage(message,...other);}
    };
    await actions.undo();
    check(sizes.join()===total+','+(total-1),'Undo did not discard its first proposal and replan the unprotected rows');
    check(notices.length===1 && notices[0].includes('1 row changed by sync'),'The protected count was not reported');
    window.Worker=original;service.close();service=undefined;await store.closeForUpdate();store=await openDeviceStore({name});await store.whenWriter();
    const after=await store.snapshot();
    check(after.tables.watched.length===total && after.tables.watched.every(r=>r.times_watched===(r.episode_id===watched[changed].episode_id?5:1)),
      'Undo changed an externally protected episode or applied to an unrelated watch');
    return sizes;
  }finally{window.Worker=original;service?.close();store.close();indexedDB.deleteDatabase(name);}
}
