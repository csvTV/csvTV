export const resetDownloadModes = ['fresh','based','unavailable','wrong-marker','unavailable-wrong-marker','settings-receipt',
  'concurrent-rating','owner-canceled','lost-committed','lost-before-same-base','expired','handoff'];

/** This function also runs through browser-native test connections that cannot share ESM bindings. */
export async function resetWatchDownloadCase({base,mode}) {
  const {openDeviceStore,canceledKey} = await import(base+'storage.js');
  const {writeCsv} = await import(base+'csv.js');
  const name = 'fictional-watch-reset-'+crypto.randomUUID(), NativeWorker = Worker;
  function check(condition,message) { if (!condition) throw Error(mode+': '+message); }
  function requestResult(request) {
    return new Promise((resolve,reject)=>{
      request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
    });
  }
  let store = await openDeviceStore({name}), open = true, now = Date.now(), handoff;
  let sendHeld, submissions = 0;
  const held = Promise.withResolvers();
  try {
    await store.whenWriter();
    const deadline = now+86400000;
    const owner = {accountId:'fictional-clock',instanceId:'fictional-session',signInDeadline:deadline};
    const session = {...owner,accessToken:'fictional-protected-access',refreshToken:'fictional-protected-refresh',
      appKey:'fictional-app',accessExpiresAt:deadline,providerExpiresAt:deadline};
    await store.storeExchangedSession(session);
    store.connectProviderKeys(()=>{throw Error('Unexpected provider edit');},()=>now);
    const providerValue = 'fictional-protected-provider';
    await store.loadProviderKeys(owner,[{setting:'tmdb_key',value:providerValue}],()=>true);
    const episode = (n,plays=1)=>({show_id:70,show:'Meridian Clock',season:1,episode:n,episode_id:70000+n,title:'Bell '+n,times_watched:plays});
    const watches = Array.from({length:120},(_,i)=>episode(i+1)), content = writeCsv('watched',watches);
    const unchangedFile = mode==='lost-before-same-base';
    const old = unchangedFile ? watches : mode==='fresh' ? [] : [episode(1,7)];
    const oldBase = old.length ? {revision:unchangedFile?'after':'before',content:writeCsv('watched',old)} : null;
    const prior = oldBase ? {count:old.length,base:oldBase,lastClientModified:null} : undefined;
    const empty = {base:null,pending:null,lastClientModified:null};
    const receipt = {...empty,base:{revision:'after',content}};
    const previous = {accountId:owner.accountId,generations:{watched:'older'},ancestry:{watched:[null]},format:2};
    const next = {...previous,generations:{watched:'newer'},ancestry:{watched:[null,'older']}};
    const rating = {show_id:78,show:'Fictional archive',rating:7};
    const flags = {recentlyMarked:[7],displacedRecentMark:8,dropboxShowsHash:'old-hash',[canceledKey('watched')]:true};
    await store.commit((await store.snapshot()).revision,{replace:{watched:old},put:{ratings:[rating]},
      sync:{...(oldBase&&{watched:{...empty,base:oldBase}}),...(mode==='settings-receipt'&&{settings:empty})},
      local:{dropboxResetSeen:previous,...flags}});
    const before = await store.snapshot();
    const reset = {before:mode.endsWith('wrong-marker')?{...previous,generations:{watched:'another'}}:previous,
      after:next,initializeSettings:true};
    window.Worker = class extends NativeWorker {
      constructor(url,options) {
        if (mode.startsWith('unavailable')) throw new DOMException('Fictional worker unavailable','NotSupportedError');
        super(url,options);
        this.addEventListener('message',event=>{
          if (event.data.type==='admission') {
            if (mode==='owner-canceled') open=false;
            if (mode==='expired') now=deadline;
            if (mode==='handoff') handoff=store.closeForUpdate();
          }
          if (event.data.type==='complete' && mode==='lost-committed') {
            event.stopImmediatePropagation();this.dispatchEvent(new ErrorEvent('error',{cancelable:true}));
          }
        });
      }
      postMessage(message,...rest) {
        if (message.rows) {
          submissions++;
          const body=JSON.stringify(message,(_,v)=>typeof v==='bigint'?String(v):v);
          for (const value of [session.accessToken,session.refreshToken,providerValue,rating.show])
            check(!body.includes(value),'An unrelated record or credential reached the worker');
          check(message.reset?.after.generations.watched==='newer','The worker omitted the reviewed generation');
          if (mode==='concurrent-rating' || unchangedFile) {
            sendHeld=()=>unchangedFile?this.dispatchEvent(new ErrorEvent('error',{cancelable:true})):super.postMessage(message,...rest);
            held.resolve();return;
          }
        }
        return super.postMessage(message,...rest);
      }
    };
    const install = store.installWatchDownload(before.revision,watches,receipt,owner,()=>open,prior,reset)
      .then(()=>({ok:true}),error=>({ok:false,name:error.name}));
    const edited = mode==='concurrent-rating' || unchangedFile;
    if (edited) {
      await held.promise;
      await store.commit(before.revision,{put:{ratings:[{...rating,rating:9}]}});
      sendHeld();
    }
    const result = await install;
    const saved = ['fresh','based','unavailable','lost-committed'].includes(mode);
    check(result.ok===saved,'Unexpected save result '+JSON.stringify(result));
    // Inspect the legacy keys before reopening: the ordinary open migrates the old recent-history format.
    const db = await requestResult(indexedDB.open(name));
    try {
      const local=db.transaction('local').objectStore('local');
      const actual=await Promise.all(Object.keys(flags).map(key=>requestResult(local.get(key))));
      for (const [index,expected] of Object.values(flags).entries())
        check(JSON.stringify(actual[index])===JSON.stringify(saved?undefined:expected),'Partial reset cleanup');
    } finally {db.close();}
    if (handoff) await handoff; else await store.closeForUpdate();
    store=await openDeviceStore({name});await store.whenWriter();
    const state=await store.snapshot();
    check(writeCsv('watched',state.tables.watched)===(saved?content:writeCsv('watched',old)),'Wrong durable watches');
    check(JSON.stringify(state.local.dropboxResetSeen)===JSON.stringify(saved?next:previous),'The observed generation disagrees with its watches');
    check(state.tables.ratings[0].rating===(edited?9:7),'Unrelated rating lost');
    check(state.sync.watched?.base?.revision===(saved?'after':oldBase?.revision),'The watched receipt disagrees with the data');
    check(!!state.sync.settings===(saved||mode==='settings-receipt'),'The empty settings receipt was written too soon');
    check(state.tmdbGeneration===before.tmdbGeneration+(saved?1n:0n),'Pending metadata was invalidated at the wrong time');
    check((await store.statisticsState()).revision===before.revision+(saved||edited?1n:0n),'Statistics missed the changed record');
    if (unchangedFile) check(result.name==='AbortError','The shared watched base incorrectly confirmed a different reset');
    check(submissions===(mode.startsWith('unavailable')?0:1),'Unexpected number of submissions');
    return {mode,saved};
  } finally {
    window.Worker=NativeWorker;
    await store.closeForUpdate();await requestResult(indexedDB.deleteDatabase(name));
  }
}
