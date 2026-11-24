// Exercises shipped cache workers and the same per-show keys used by earlier releases.
export async function malIndexWorkerCase({base,mode}) {
  const {openDeviceStore} = await import(base+'storage.js');
  const check = (value,why) => { if (!value) throw Error(mode+' · '+why); };
  const name = 'Fictional MAL cache '+crypto.randomUUID(), Native = Worker;
  const deadline = Date.now()+86_400_000, accountId = 'fictional-score-owner';
  const auth = {accountId,instanceId:crypto.randomUUID(),signInDeadline:deadline,providerExpiresAt:deadline,accessExpiresAt:deadline,
    accessToken:'fictional-mal-access',refreshToken:'fictional-mal-refresh'};
  const key = 'fictional-mal-provider', id = i=>17+i*11;
  const rows = i=>[{season:2,offset:5,score:6+(i%8)/10,malId:6500+i},{season:null,offset:0,score:8.4,malId:15000+i}];
  const file = (digest,entryCount)=>({digest,entryCount,fetchedAt:123_456,firstAt:123_456});
  const store = await openDeviceStore({name}), sent = Promise.withResolvers(), go = Promise.withResolvers();
  const produced=Promise.withResolvers(), deliver=Promise.withResolvers();
  let reader, reopened, expires=false, current=true, installs=0, admissions=0, lookups=0, readAudit;
  try {
    await store.whenWriter();
    await store.storeExchangedSession(auth);
    store.connectProviderKeys(()=>{throw Error('Unexpected key edit');},()=>expires?deadline:Date.now());
    await store.loadProviderKeys(auth,[{setting:'github_token',value:key}],()=>true);
    await store.commit((await store.snapshot()).revision,{put:{settings:[{setting:'mal_source',value:'github'},{setting:'github_repo',value:'fictional/scores'}]}});
    const {generation} = await store.malState(), prior = [{season:1,offset:0,score:7.4,malId:4}];
    const install=(shows,digest,bytes) => store.writeMal(generation,{update:{file:file(digest,[...shows.values()].reduce((n,v)=>n+v.length,0)),
      needsFile:false,fileError:null},githubPause:null,replacement:{shows,bytes:new Uint8Array(bytes).buffer}},()=>current);
    await install(new Map([[id(5),prior]]),'old',[3,2,1]);
    const oldVersion=(await store.statisticsState()).scoresVersion;
    const record = (await store.snapshot()).revision;
    const large = new Map(Array.from({length:1030},(_,j)=>{const i=1029-j;return [id(i),rows(i)];}));
    window.Worker = class extends Native {
      constructor(url,options) {
        const write = url.pathname.endsWith('/github-index-worker.js'), read = url.pathname.endsWith('/mal-lookup-worker.js');
        check(write||read,'Unexpected worker entry');
        if (mode==='unavailable') throw new DOMException('Fictional missing worker','NotSupportedError');
        const shim = read?'/fictional-mal-inspect.js':mode==='quota'?'/fictional-mal-quota.js':null;
        super(shim ?? url,options);
        this.addEventListener('message',event=>{
          const msg = event.data;
          if (msg.audit) readAudit = msg.audit;
          if (msg.audit && mode.startsWith('late-') && !this.held) {
            this.held=true;event.stopImmediatePropagation();produced.resolve();
            void deliver.promise.then(()=>this.dispatchEvent(new MessageEvent('message',{data:msg})));return;
          }
          if (msg.type==='progress' && mode==='expired') expires=true;
          if (msg.type==='admission') {
            admissions++;
            if (mode==='hidden') current=false;
            if (mode==='retired') store.clearProviderKeys();
          }
          if (msg.type==='complete' && mode==='lost-commit') {
            event.stopImmediatePropagation(); this.dispatchEvent(new ErrorEvent('error',{cancelable:true}));
          }
          if (msg.type==='progress' && mode==='killed') {
            event.stopImmediatePropagation(); this.terminate(); this.dispatchEvent(new ErrorEvent('error',{cancelable:true}));
          }
        });
      }
      postMessage(message,...rest) {
        const text=JSON.stringify(message,(_,v)=>typeof v==='bigint'?String(v):v instanceof Map?[...v]:v);
        check(![auth.accessToken,auth.refreshToken,key].some(secret=>text.includes(secret)),'A credential crossed the cache worker boundary');
        if (message.write) {
          installs++; sent.resolve();
          check(message.source==='mal' && Object.keys(message).sort().join()==='accountId,erased,expiresAt,generation,id,revision,source,write','Unexpected installation fields');
          if (['grant','generation','unrelated-edit'].includes(mode)) { void go.promise.then(()=>super.postMessage(message,...rest)); return; }
        }
        if (message.ids) {
          lookups++;
          check(Object.keys(message).sort().join()==='database,ids,version','Unexpected reader fields');
        }
        super.postMessage(message,...rest);
      }
    };
    const saving = install(large,'new',[9,4,8]).then(saved=>({saved}),e=>({error:e.name}));
    if (['grant','generation','unrelated-edit'].includes(mode)) {
      await sent.promise;
      if (mode==='grant') await store.storeExchangedSession({...auth,instanceId:crypto.randomUUID()});
      if (mode==='generation') await store.commit(record,{put:{settings:[{setting:'github_repo',value:'fictional/new'}]}});
      if (mode==='unrelated-edit') await store.commit(record,{put:{ratings:[{show_id:93,show:'Fictional Channel',rating:7}]}});
      go.resolve();
    }
    const outcome=await saving, accepted=['valid','lost-commit','unavailable','disabled-reader','unrelated-edit'].includes(mode)||mode.startsWith('late-');
    const newVersion=(await store.statisticsState()).scoresVersion;
    check(typeof oldVersion==='string' && (accepted ? newVersion!==oldVersion : newVersion===oldVersion),
      'The Statistics score version did not commit or roll back with the cache worker');
    check(mode==='quota'?outcome.error==='QuotaExceededError':outcome.saved===accepted,'Incorrect save outcome '+JSON.stringify(outcome));
    if (accepted && mode!=='unavailable') check(admissions===1,'Expected exactly one admitted commit');
    check(mode==='unrelated-edit'?installs<=2:installs===(mode==='unavailable'?0:1),'Unexpected repeated cache installation');
    reader=await openDeviceStore({name});
    if (mode==='disabled-reader') await store.commit((await store.snapshot()).revision,{remove:{settings:['mal_source']}});
    const requested=Array.from({length:45},(_,n)=>id(n*7+5)).concat([0,1,17_000_000,id(5)]);
    const pending=reader.malEntries(requested);
    if (mode.startsWith('late-')) {
      await produced.promise;
      if(mode==='late-source')await store.commit((await store.snapshot()).revision,{remove:{settings:['mal_source']}});
      if(mode==='late-erase')await store.eraseDevice((await store.snapshot()).revision);
      if(mode==='late-file')await install(new Map([[id(5),prior]]),'third',[5]);
      deliver.resolve();
    }
    const hidden=mode==='disabled-reader'||mode.startsWith('late-'),matches=await pending;
    check(matches.size===(hidden?0:accepted?45:1),'Stale results or unexpected number of matching rows');
    if (!hidden) {
      for (const [show,entries] of matches) {
        const index=(show-17)/11, wanted=accepted?rows(index):prior;
        check(JSON.stringify(entries)===JSON.stringify(wanted),'A placement, score or saved row order changed');
      }
    }
    if (mode==='disabled-reader') check(!lookups,'An unselected source launched a worker');
    else if (mode!=='unavailable') {
      check(lookups===1 && readAudit.transaction==='settings,cache' && readAudit.source===1 && !readAudit.unexpected,
        'A reader accessed a private setting or a non-MAL score');
      check(readAudit.rows===(mode==='disabled-reader'?0:requested.length),'Disabled source or skipped requested shows');
    }
    if (mode==='unrelated-edit') check((await store.snapshot()).tables.ratings[0].rating===7,'Independent rating disappeared');
    await reader.closeForUpdate();reader=undefined;await store.closeForUpdate();
    reopened=await openDeviceStore({name});await reopened.whenWriter();
    const bytes=await reopened.cacheValue(['mal','file']), placed=await reopened.cacheValue(['mal','show',id(5)]);
    if(['disabled-reader','late-source','late-erase'].includes(mode))check(!bytes&&!placed,'Switching sources or erasing retained the job index');
    else if(mode==='late-file')check(String(new Uint8Array(bytes))==='5'&&placed[0].score===7.4,'The newer file disappeared');
    else check(String(new Uint8Array(bytes))===(accepted?'9,4,8':'3,2,1') && JSON.stringify(placed)===JSON.stringify(accepted?rows(5):prior) &&
      (await reopened.malState()).file.digest===(accepted?'new':'old'),'File, unchanged old cache keys and metadata disagreed after reopening');
    return {mode,installs,lookups};
  } finally {
    go.resolve();deliver.resolve();window.Worker=Native;
    await reader?.closeForUpdate();await reopened?.closeForUpdate();await store.closeForUpdate();
    await new Promise((yes,no)=>{const r=indexedDB.deleteDatabase(name);r.onsuccess=yes;r.onerror=()=>no(r.error);});
  }
}
