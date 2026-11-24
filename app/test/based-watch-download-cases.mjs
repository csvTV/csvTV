export const basedDownloadModes = ['normal','native','legacy','wrong-base','wrong-content','wrong-count','wrong-stamp',
  'pending','native-base','native-grant','duplicate','stale-edit','erased','before-admission','handoff','expiry','lost','terminated'];
export const absoluteRestoreModes = [...basedDownloadModes,'native-expiry','other-receipt','missing-absolute','unreviewed-target'];
export const sparsePeerCases = [
  ...basedDownloadModes.filter(mode=>mode!=='duplicate').map(mode=>({mode,sparse:'mixed',size:mode==='normal'?520:32})),
  {mode:'native-expiry',sparse:'mixed',size:32},
  ...['updates','removals'].flatMap(sparse=>['normal','native','native-expiry','lost'].map(mode=>({mode,sparse,size:32}))),
];
export const sparseRestoreCases = [...sparsePeerCases,
  ...['other-receipt','missing-absolute','unreviewed-target'].map(mode=>({mode,sparse:'mixed',size:32}))];

/** Exercise replacement of an existing watched.csv through the actual document and worker transactions. */
export async function basedWatchDownloadCase({base,mode,size=2052,restore=false,sparse}) {
  const {openDeviceStore,deviceMigrations}=await import(base+'storage.js'),{writeCsv}=await import(base+'csv.js');
  const check=(v,m)=>{if(!v)throw Error(mode+': '+m);},name='fictional-based-download-'+crypto.randomUUID();
  const options=mode==='legacy'?{name,migrations:deviceMigrations.slice(0,-2)}:{name};
  let store=await openDeviceStore(options),closing,release,submissions=0,batches=0,admissions=0,current=true;
  const NativeWorker=Worker;
  const lastOperation=sparse==='removals'?'delete':sparse?'put':'add',nativeOperation=IDBObjectStore.prototype[lastOperation];
  const held=Promise.withResolvers();
  try{
    await store.whenWriter();
    const deadline=Date.now()+86400000,owner={accountId:'fictional-peer-owner',instanceId:'fictional-grant',signInDeadline:deadline};
    const auth={...owner,appKey:'fictional-key',accessToken:'fictional-private-access',refreshToken:'fictional-private-refresh',
      accessExpiresAt:deadline,providerExpiresAt:deadline};
    await store.storeExchangedSession(auth);
    let now=Date.now();
    store.connectProviderKeys(()=>{throw Error('Unexpected key save');},()=>now);
    await store.loadProviderKeys(owner,[{setting:'tmdb_key',value:'fictional-private-provider'}],()=>true);
    const row=(episode,plays=1)=>({show_id:66,show:'Linden Station',season:1,episode,episode_id:12000+episode,title:'Chapter '+episode,times_watched:plays});
    const original=[row(1,3),row(2,1),row(3,2)],lastClientModified='2026-03-01T00:00:00Z';
    if(sparse==='removals')for(let i=0;i<size-2;i++)original.push(row(i+4));
    const oldBase={revision:'fictional-prior',content:writeCsv('watched',original)};
    const oldReceipt={base:oldBase,lastClientModified,pending:mode==='pending'?{content:oldBase.content,targetRevision:'pending',
      targetModified:null,targetContent:oldBase.content,preparedAt:now,clientModified:lastClientModified}:null};
    const safeRating={show_id:65,show:'Another Station',rating:8.5},safeList={show_id:65,show:'Another Station',list:'Coastal routes'};
    const recent={setting:'recently_marked.66.1.0.0',value:'10/10'};
    await store.commit((await store.snapshot()).revision,{replace:{watched:original},put:{ratings:[safeRating],lists:[safeList],settings:[recent]},
      sync:{watched:oldReceipt},local:{'dropboxCanceled:watched':true}});
    const first=await store.snapshot(),prior={count:original.length,base:{...oldBase},lastClientModified};
    if (mode==='wrong-base'||mode==='native-base') prior.base.revision='another-version';
    if (mode==='wrong-count') prior.count++;
    if (mode==='wrong-content') prior.base.content=writeCsv('watched',[row(1,8),row(2,1),row(3,2)]);
    if (mode==='wrong-stamp') prior.lastClientModified=null;
    let incoming=[row(2,5),row(3,2),...Array.from({length:size-2},(_,i)=>row(i+4))];
    if(sparse==='removals')incoming=[original[2]];
    if(sparse==='updates')incoming.push(original[0],row(size+2));
    const keys=rows=>rows.map(r=>[r.show_id,r.season,r.episode]);
    const delta=sparse==='removals'?{put:[],remove:keys(original.filter(r=>r.episode!==3))}:
      sparse==='updates'?{put:incoming.filter(r=>r.episode!==1&&r.episode!==3),remove:[]}:
      {put:incoming.filter(r=>r.episode!==3),remove:keys([original[0]])};
    const content=writeCsv('watched',incoming),nextStamp='2026-03-02T00:00:00Z';
    const pending={content,targetContent:prior.base.content,targetRevision:prior.base.revision,targetModified:nextStamp,
      clientModified:nextStamp,preparedAt:now,absoluteWatches:true};
    const receipt=restore?{base:{...prior.base},pending,lastClientModified:nextStamp}:{base:{revision:'fictional-next',content},pending:null,lastClientModified};
    if(mode==='missing-absolute')delete pending.absoluteWatches;
    if(mode==='unreviewed-target')pending.targetRevision='different-target';
    const invalid=mode==='missing-absolute'||mode==='unreviewed-target';
    if(mode==='duplicate')incoming.push({...incoming[0]});
    if(mode==='native-expiry')IDBObjectStore.prototype[lastOperation]=function(...args){
      const request=nativeOperation.apply(this,args);
      const episode=Array.isArray(args[0])?args[0][2]:args[0].episode;
      const last=sparse==='removals'?delta.remove.at(-1)[2]:(sparse?delta.put:incoming).at(-1).episode;
      if(this.name==='watched' && episode===last)
        request.addEventListener('success',()=>{now=deadline;},{once:true});
      return request;
    };
    const events=[];store.addEventListener('recordchange',e=>events.push(e.detail));
    window.Worker=class extends NativeWorker{
      constructor(url,opts){
        if(mode.startsWith('native'))throw new DOMException('Module worker unavailable','NotSupportedError');
        super(url,opts);
        this.addEventListener('message',event=>{
          const type=event.data?.type;
          if(type==='progress')batches++;
          if(type==='admission'){
            admissions++;
            if(mode==='before-admission')current=false;
            if(mode==='expiry')now=deadline;
            if(mode==='handoff')closing=store.closeForUpdate();
            if(mode==='terminated'){
              event.stopImmediatePropagation();this.terminate();
              this.dispatchEvent(new ErrorEvent('error',{cancelable:true}));
            }
          }
          if(type==='complete'&&mode==='lost'){
            event.stopImmediatePropagation();this.dispatchEvent(new ErrorEvent('error',{cancelable:true}));
          }
        });
      }
      postMessage(message,...rest){
        const text=JSON.stringify(message,(_,v)=>typeof v==='bigint'?String(v):v);
        for(const secret of [auth.accessToken,auth.refreshToken,'fictional-private-provider',safeList.list])check(!text.includes(secret),'Worker received unrelated data');
        if(message.rows){
          submissions++;
          const fields=sparse?'accountId,erased,expiresAt,prior,receipt,remove,revision,rows':'accountId,erased,expiresAt,prior,receipt,revision,rows';
          check(Object.keys(message).sort().join(',')===fields,'Unexpected message fields');
          if(sparse)check(JSON.stringify(message.rows)===JSON.stringify(delta.put) && JSON.stringify(message.remove)===JSON.stringify(delta.remove),
            'Worker received rows outside the computed patch');
          check(JSON.stringify(message.prior)===JSON.stringify(prior),'Wrong source state');
          if(mode==='stale-edit'||mode==='erased'||mode==='other-receipt'){
            release=()=>mode==='other-receipt'?this.dispatchEvent(new ErrorEvent('error',{cancelable:true})):super.postMessage(message,...rest);
            held.resolve();return;
          }
        }
        return super.postMessage(message,...rest);
      }
    };
    const submitted=mode==='native-grant'?{...owner,instanceId:'earlier-grant'}:owner;
    const work=store[restore?'installWatchRestore':'installWatchDownload'](first.revision,sparse?delta:incoming,receipt,submitted,()=>current,prior)
      .then(()=>({ok:true}),e=>({ok:false,name:e.name}));
    let competing;
    if(mode==='stale-edit'||mode==='erased'||mode==='other-receipt'){
      await held.promise;
      if(mode==='stale-edit')await store.commit(first.revision,{put:{ratings:[{...safeRating,rating:7}]}});
      else if(mode==='other-receipt'){
        competing={...receipt,pending:{...pending,preparedAt:pending.preparedAt-1000}};
        await store.commit(first.revision,{replace:{watched:incoming},sync:{watched:competing}});
      }
      else await store.eraseDevice(first.revision);
      release();
    }
    const outcome=await work;
    if(closing)await closing;else await store.closeForUpdate();
    store=await openDeviceStore(options);await store.whenWriter();
    const after=await store.snapshot(),ok=['normal','legacy','native','lost'].includes(mode);
    check(outcome.ok===ok,'Unexpected outcome '+JSON.stringify(outcome));
    if(!ok)check(outcome.name===(mode==='duplicate'?'ConstraintError':mode==='terminated'||competing?'AbortError':'StaleSnapshotError'),'Wrong failure '+outcome.name);
    if(mode==='erased')check(after.tables.watched.length===0 && !after.sync.watched,'Erased record was repopulated');
    else {
      check(writeCsv('watched',after.tables.watched)===(ok||competing?content:oldBase.content),'Watch counts changed after reopen');
      check(JSON.stringify(after.sync.watched)===JSON.stringify(competing??(ok?receipt:oldReceipt)),'Receipt differs from the saved watches');
      check(after.tables.ratings[0].rating===(mode==='stale-edit'?7:8.5) && after.tables.lists[0].list===safeList.list &&
        after.tables.settings.find(r=>r.setting===recent.setting)?.value===recent.value,'Unrelated rows changed');
      check(!!after.local['dropboxCanceled:watched']===!(ok||competing),'Canceled-review state was partly changed');
      check(after.revision===first.revision+(ok||competing||mode==='stale-edit'?1n:0n),'Unexpected record revision');
    }
    check(submissions===(invalid||mode.startsWith('native')?0:1),'Duplicate submission');
    if(ok&&!mode.startsWith('native')||['before-admission','expiry','handoff','terminated'].includes(mode))
      check(batches===Math.ceil(size/512) && admissions===1,'The final approval boundary was not exercised');
    check(events.filter(e=>e.syncWrite&&e.tables.length===1&&e.tables[0]==='watched').length===Number(ok),'Incorrect download notifications');
    return {mode,batches,admissions,saved:outcome.ok};
  } finally {
    window.Worker=NativeWorker;IDBObjectStore.prototype[lastOperation]=nativeOperation;
    await store.closeForUpdate();
    await new Promise((ok,no)=>{const q=indexedDB.deleteDatabase(name);q.onsuccess=ok;q.onerror=()=>no(q.error);});
  }
}
