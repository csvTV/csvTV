// Runs inside an isolated browser. All gates interpose on the dedicated worker's messages.
export async function firstWatchDownloadCase({base,mode,shortIdle=false}) {
  const {openDeviceStore,canceledKey,deviceMigrations}=await import(base+'storage.js'),{writeCsv}=await import(base+'csv.js');
  const check=(value,message)=>{if(!value)throw Error(message);};
  const name='fictional-download-'+crypto.randomUUID(),NativeWorker=Worker,originalTimer=window.setTimeout,nativeAdd=IDBObjectStore.prototype.add;
  const options=mode==='legacy'?{name,migrations:deviceMigrations.slice(0,-2)}:{name};
  const store=await openDeviceStore(options);
  let other,release,submissions=0,workers=0,progress=0,expired=false;
  let heldResolve,startedResolve;
  const held=new Promise(r=>{heldResolve=r;}),started=new Promise(r=>{startedResolve=r;});
  const pause=ms=>new Promise(r=>setTimeout(r,ms));
  let work;
  try {
    await store.whenWriter();
    const accountId='fictional-download-owner', deadline=Date.now()+(mode==='expiry'?4500:86400000);
    const identity={accountId,instanceId:'fictional-first-grant',signInDeadline:deadline};
    const auth={...identity,appKey:'fictional-registration',providerExpiresAt:deadline,
      accessToken:'fixture-private-access',refreshToken:'fixture-private-refresh',accessExpiresAt:deadline};
    const providerKey='fictional-provider-key-stays-in-document';
    if(mode==='unavailable-expiry')store.connectProviderKeys(()=>{throw Error('Unexpected key edit');},()=>expired?deadline+1:Date.now());
    await store.storeExchangedSession(auth);
    if(mode==='valid'||mode==='stalled-old-instance'){
      store.connectProviderKeys(()=>{throw Error('Unexpected key edit');},Date.now);
      await store.loadProviderKeys(identity,[{setting:'tmdb_key',value:providerKey}],()=>true);
    }
    const state=await store.snapshot();
    const earlier={show_id:71,show:'Previously watched',season:1,episode:1,episode_id:7101,title:'Pilot',times_watched:3};
    const prior={revision:'old-revision',content:writeCsv('watched',[])};
    await store.commit(state.revision,{local:{[canceledKey('watched')]:true},
      ...(mode==='nonempty' && {put:{watched:[earlier]}}),
      ...(mode==='prior-receipt' && {sync:{watched:{base:prior,pending:null,lastClientModified:null}}}),
      ...(mode==='pending' && {sync:{watched:{base:null,lastClientModified:null,pending:{content:prior.content,targetRevision:null,
        targetModified:null,targetContent:null,clientModified:'2026-02-28T12:00:00Z',preparedAt:1}}}})});
    let before=await store.snapshot();
    if(mode==='constructor-old-instance'||mode==='stalled-old-instance'){
      const priorRevision=before.revision;
      await store.storeExchangedSession({...auth,instanceId:'replacement-for-same-account'});
      before=await store.snapshot();
      check(before.revision===priorRevision+1n && before.local.dropboxSession.instanceId==='replacement-for-same-account','Replacement grant did not advance revision');
      check(store.providerKeysAvailable===(mode==='stalled-old-instance'),'Unexpected provider lease before document fallback');
    }
    const size=mode==='terminated'?32768:['duplicate','expiry-during'].includes(mode)?2051:32;
    const rows=Array.from({length:size},(_,i)=>({
      show_id:29,show:'Fictional Valley',season:1,episode:i+1,episode_id:20100+i,title:'Part '+(i+1),times_watched:1,
    }));
    if (mode==='duplicate') rows.push({...rows[0]});
    const content=mode==='duplicate'?'fictional duplicate test':writeCsv('watched',rows);
    const receipt={base:{content,revision:'fictional-revision'},lastClientModified:null,pending:null};
    if(mode==='unavailable-expiry')IDBObjectStore.prototype.add=function(...args){
      const request=nativeAdd.apply(this,args);
      if(this.name==='watched')request.addEventListener('success',()=>{expired=true;},{once:true});
      return request;
    };
    if(shortIdle) window.setTimeout=(fn,ms,...args)=>originalTimer(fn,ms===45_000?1500:ms,...args);
    window.Worker=class extends NativeWorker {
      constructor(url,options){
        if(mode==='constructor-old-instance'){workers++;startedResolve();throw new DOMException('Fixture module worker unavailable.','NotSupportedError');}
        super(mode==='expiry-during'?new URL('/fictional-expiry-worker.js',location.href):url,options);
        workers++;startedResolve();
        this.addEventListener('message',e=>{
          if(mode.startsWith('stalled') && e.data.type==='ready')e.stopImmediatePropagation();
          if(e.data.type==='progress' && ++progress===1 && mode==='terminated')this.terminate();
          if(mode==='lost-silent' && e.data.type==='complete')e.stopImmediatePropagation();
          if(mode==='lost-committed' && e.data.type==='complete'){
            e.stopImmediatePropagation();
            this.dispatchEvent(new ErrorEvent('error',{cancelable:true}));
          }
        });
      }
      postMessage(message,...rest){
        const sent=JSON.stringify(message,(_,v)=>typeof v==='bigint'?String(v):v);
        for(const secret of [auth.accessToken,auth.refreshToken,providerKey])check(!sent.includes(secret),'Credential sent to the worker');
        const keys=value=>Object.keys(value).sort().join(',');
        if(!message.rows){
          check(keys(message)==='database,version','Unexpected database-open message fields');
          if(mode.startsWith('unavailable'))throw new DOMException('Fixture worker unavailable.','InvalidStateError');
          return super.postMessage(message,...rest);
        }
        submissions++;
        check(keys(message)==='accountId,erased,expiresAt,receipt,revision,rows' && keys(message.receipt)==='base,lastClientModified,pending' &&
          keys(message.receipt.base)==='content,revision' && message.receipt.pending===null &&
          message.rows.every(row=>keys(row)==='episode,episode_id,season,show,show_id,times_watched,title'),'Unexpected record message fields');
        if(mode==='lost-before-write'){
          queueMicrotask(()=>this.dispatchEvent(new ErrorEvent('error',{cancelable:true})));return;
        }
        if(['revision','grant','erase','expiry','drain'].includes(mode)){
          release=()=>super.postMessage(message,...rest);heldResolve();return;
        }
        super.postMessage(message,...rest);
      }
    };
    const caller=mode==='unavailable-wrong-owner'?{...identity,accountId:'a different fictional account'}:identity;
    const notices=[];store.addEventListener('recordchange',event=>notices.push(event.detail));
    work=store.installWatchDownload(before.revision,rows,receipt,caller,()=>true)
      .then(()=>({ok:true}),e=>({ok:false,name:e.name,message:e.message}));
    // Submitting the mutable source a second time must never change the already-admitted row.
    rows[0].title='Changed after submission';
    if(['revision','grant','erase','expiry','drain'].includes(mode)){
      await held;
      if(mode==='revision')await store.commit(before.revision,{put:{ratings:[{show_id:29,show:'Fictional Valley',rating:8}]}});
      if(mode==='grant')await store.storeExchangedSession({...auth,instanceId:'fictional-second-grant'});
      if(mode==='erase')await store.eraseDevice(before.revision);
      if(mode==='expiry')await pause(Math.max(0,deadline-Date.now())+70);
      if(mode==='drain'){
        other=await openDeviceStore({name});
        let handedOff=false,drained=false;
        const barrier=store.afterPendingWrites(()=>{drained=true;});
        const closing=store.closeForUpdate().then(()=>{handedOff=true;});
        await pause(80);check(!drained && !handedOff && other.role==='reader','Writer was released before its download settled');
        release();await Promise.all([closing,barrier]);await other.whenWriter();check(drained,'Update barrier did not drain');
      } else release();
    }
    if(mode==='stalled-update'){
      await started;other=await openDeviceStore({name});
      await store.closeForUpdate();await other.whenWriter();
    }
    const result=await work, final=await (other??store).snapshot();
    const succeeded=['valid','legacy','lost-committed','lost-silent','stalled-fallback','unavailable','drain'].includes(mode);
    check(result.ok===succeeded,'Wrong result '+JSON.stringify(result));
    if(succeeded){
      check(writeCsv('watched',final.tables.watched)===content,'Written watches differ');
      check(final.sync.watched.base.content===content && final.sync.watched.base.revision===receipt.base.revision,'Wrong base');
      check(final.revision===before.revision+1n && !final.local[canceledKey('watched')],'Receipt or revision written twice');
      const projections=await new Promise((ok,no)=>{
        const opening=indexedDB.open(name);opening.onerror=()=>no(opening.error);
        opening.onsuccess=()=>{
          const db=opening.result,has=db.objectStoreNames.contains('statistics'),tx=db.transaction(has?['meta','statistics']:['meta']);
          const dirty=tx.objectStore('meta').get('dropboxDirty'),stamp=has && tx.objectStore('statistics').get('revision');
          tx.oncomplete=()=>{db.close();ok({dirty:dirty.result,revision:stamp?stamp.result.value:null});};
          tx.onabort=()=>{db.close();no(tx.error);};
        };
      });
      check(projections.dirty && (projections.revision===null || projections.revision===final.revision),'Stale sync or Statistics revision');
      check(notices.filter(n=>n.syncWrite && n.tables.includes('watched')).length===1,'Expected exactly one committed watch event');
      if(mode==='valid')check(progress>0,'Did not use the record worker');
    } else {
      check(writeCsv('watched',final.tables.watched)===writeCsv('watched',before.tables.watched) &&
        JSON.stringify(final.sync.watched)===JSON.stringify(before.sync.watched) &&
        (mode==='erase'?!final.local[canceledKey('watched')]:final.local[canceledKey('watched')]),'A partial download escaped');
      check(!notices.some(n=>n.syncWrite && n.tables.length===1 && n.tables[0]==='watched'),'Published a failed watch event');
      const independent=['revision','grant','erase'].includes(mode);
      check(final.revision===before.revision+(independent?1n:0n),'Failed download advanced the record revision');
      if(mode==='revision')check(final.tables.ratings[0]?.rating===8,'Independent rating lost');
      if(['revision','expiry','expiry-during','grant','stalled-update','constructor-old-instance','stalled-old-instance','erase','nonempty','prior-receipt','pending',
        'unavailable-expiry','unavailable-wrong-owner'].includes(mode))check(result.name==='StaleSnapshotError','Expected a stale write');
      if(mode==='unavailable-expiry')check(expired,'Document fallback never entered its write transaction');
      if(mode==='duplicate')check(result.name==='ConstraintError','Expected duplicate-row rollback');
      if(mode==='terminated'||mode==='expiry-during')check(progress>=1,'Never started the native write transaction');
    }
    check(workers===1 && submissions===(mode.startsWith('stalled')||mode.startsWith('unavailable')||mode==='constructor-old-instance'?0:1),'Unexpected duplicate submission');
    return {mode,written:succeeded,submissions,progress};
  } finally {
    window.Worker=NativeWorker;
    window.setTimeout=originalTimer;
    IDBObjectStore.prototype.add=nativeAdd;
    release?.();
    await store.closeForUpdate();await other?.closeForUpdate();
    await new Promise((ok,no)=>{const q=indexedDB.deleteDatabase(name);q.onsuccess=ok;q.onerror=()=>no(q.error);});
  }
}
