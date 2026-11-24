import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRelease} from '../package-release.mjs';
import {openChromium} from './offline-chromium.mjs';
import {listen,stop} from './offline-site.mjs';
import {releaseServer,unpack} from './release-site.mjs';

test('a Dropbox export reuses the four record tables once, under the same store, revision, erase generation and grant',async t=>{
  const server = releaseServer(await unpack((await createRelease(new URL('../dist/',import.meta.url))).bytes));
  const origin = 'http://127.0.0.1:'+await listen(server),profile=await mkdtemp(join(tmpdir(),'csvtv-publication-'));
  let browser;
  t.after(async()=>{
    try { await browser?.close(); await stop(server); }
    finally { await rm(profile,{recursive:true,force:true,maxRetries:6,retryDelay:150}); }
  });
  browser = await openChromium(profile);
  await browser.navigate(origin+'/tmdb-logo.svg');
  const checks = await browser.evaluate('('+(async function(){
    const {openDeviceStore} = await import('/storage.js');
    const {tmdbResourceKey} = await import('/tmdb-client.js');
    const now=Date.now(), watch={show_id:40,show:'Signal Station',season:1,episode:1,episode_id:401,title:'Relay',times_watched:1};
    const grant={accountId:'fictional-account',instanceId:'fictional-sign-in',accessToken:'fictional-access',refreshToken:'fictional-refresh',
      appKey:'fictional-registration',accessExpiresAt:now+3600000,signInDeadline:now+7*86400000,providerExpiresAt:now+7*86400000};
    const stores=[];
    async function device() {
      const name='csvtv-publication-'+crypto.randomUUID(), store=await openDeviceStore({name});
      stores.push(store); await store.whenWriter(); await store.storeExchangedSession(grant);
      await store.commit((await store.snapshot()).revision,{put:{watched:[watch]}});
      return {name,store};
    }
    async function amend(name,stores,write) {
      const db=await new Promise((resolve,reject)=>{const open=indexedDB.open(name);open.onsuccess=()=>resolve(open.result);open.onerror=()=>reject(open.error);});
      try {
        const tx=db.transaction(stores,'readwrite');write(tx);
        await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});
      } finally { db.close(); }
    }
    const counts=[], original=IDBObjectStore.prototype.getAll, get=IDBObjectStore.prototype.get;
    try {
      const a=await device(), b=await device();
      let reads=0;
      let metadataReads=0;
      IDBObjectStore.prototype.get=function(...args) {
        if (this.name==='tmdb') metadataReads++;
        return get.apply(this,args);
      };
      IDBObjectStore.prototype.getAll=function(...args) {
        if (this.name==='watched') reads++;
        return original.apply(this,args);
      };
      const capture=async d=>(await d.store.snapshot(true)).exportRecord;
      const use=async(d,ref,time=now)=>{
        reads=0;const result=await d.store.exportSnapshot(true,time,true,undefined,ref);counts.push(reads);return result;
      };
      const first=await capture(a);
      const sid=tmdbResourceKey({kind:'show',id:40}), eid=tmdbResourceKey({kind:'external-ids',id:40});
      await amend(a.name,['tmdb'],tx=>{
        const cache=tx.objectStore('tmdb');
        cache.put({value:{show_id:40,show:'New catalog title',seasons:[]},fetchedAt:now,expiresAt:now+60000},sid);
        cache.put({value:{imdbId:'tt4040'},fetchedAt:now,expiresAt:now+60000},eid);
      });
      const live=await use(a,first);
      const proof={title:live.showMetadata.get(40)?.show,imdb:live.externalIds.get(40)};
      await use(a,first); // The handle is single-use.
      const other=await capture(a); await use(b,other); // The revisions deliberately match.
      let ref=await capture(a);
      await a.store.commit((await a.store.snapshot()).revision,{put:{watched:[{...watch,times_watched:2}]}});
      proof.count=(await use(a,ref)).tables.watched[0].times_watched;
      for(const [key,value] of [['syncAccountId','fictional-other'],['dropboxSession',{...grant,instanceId:'fictional-replaced'}]]) {
        ref=await capture(a);
        await amend(a.name,['local'],tx=>tx.objectStore('local').put(value,key));
        await use(a,ref);
        await amend(a.name,['local'],tx=>tx.objectStore('local').put(key==='syncAccountId'?grant.accountId:grant,key));
      }
      ref=await capture(a);
      await amend(a.name,['meta'],tx=>tx.objectStore('meta').put(99n,'deviceEraseRevision'));
      await use(a,ref);
      await use(a,await capture(a),grant.signInDeadline);
      const episodes=Array.from({length:2048},(_,i)=>({...watch,episode:i+1,episode_id:10000+i}));
      await b.store.commit((await b.store.snapshot()).revision,{replace:{watched:episodes}});
      const longRecord=await capture(b);
      metadataReads=0;
      const empty=await use(b,longRecord);
      proof.emptyCache={titles:empty.showMetadata.size,metadataReads};
      const retry=await capture(b);
      await amend(b.name,['tmdb'],tx=>tx.objectStore('tmdb').put({
        value:{show_id:40,show:'Cached during sync',seasons:[]},fetchedAt:now,expiresAt:now+60000},sid));
      const filled=await use(b,retry);
      proof.laterTitle=filled.showMetadata.get(40)?.show;
      return {counts,...proof};
    } finally {
      IDBObjectStore.prototype.getAll=original;
      IDBObjectStore.prototype.get=get;
      for(const store of stores)await store.closeForUpdate();
    }
  }).toString()+')()');
  assert.deepEqual(checks,{counts:[0,1,1,1,1,1,1,1,0,0],title:'New catalog title',imdb:'tt4040',count:2,
    emptyCache:{titles:0,metadataReads:0},laterTitle:'Cached during sync'});
});

test('a slow Dropbox catalog read returns a consistent public projection and recovers from a stale or unavailable worker',async t=>{
  const server=releaseServer(await unpack((await createRelease(new URL('../dist/',import.meta.url))).bytes));
  const origin='http://127.0.0.1:'+await listen(server),profile=await mkdtemp(join(tmpdir(),'csvtv-export-reader-'));
  let browser;
  t.after(async()=>{
    try { await browser?.close(); await stop(server); }
    finally { await rm(profile,{recursive:true,force:true,maxRetries:6,retryDelay:150}); }
  });
  browser=await openChromium(profile);
  await browser.navigate(origin+'/tmdb-logo.svg');
  const proof=await browser.evaluate('('+(async function(){
    const {openDeviceStore}=await import('/storage.js'),{tmdbResourceKey}=await import('/tmdb-client.js');
    const name='csvtv-publication-'+crypto.randomUUID(),store=await openDeviceStore({name}),now=Date.now();
    const NativeWorker=Worker,clock=Object.getOwnPropertyDescriptor(performance,'now');
    const grant={accountId:'fictional-account',instanceId:'fictional-sign-in',accessToken:'fictional-access',refreshToken:'fictional-refresh',
      appKey:'fictional-registration',accessExpiresAt:now+3600000,signInDeadline:now+86400000,providerExpiresAt:now+86400000};
    await store.whenWriter();await store.storeExchangedSession(grant);
    store.connectProviderKeys(()=>{throw Error('Unexpected key edit');},Date.now);
    await store.loadProviderKeys((await store.dropboxState()).session,[{setting:'tmdb_key',value:'fictional-publication-key'}],()=>true);
    const db=await new Promise((resolve,reject)=>{const open=indexedDB.open(name);open.onsuccess=()=>resolve(open.result);open.onerror=()=>reject(open.error);});
    async function edit(stores,write) {
      const tx=db.transaction(stores,'readwrite');write(tx);
      await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});
    }
    const watches=Array.from({length:64*32},(_,i)=>{
      const id=Math.floor(i/32)+1;
      return {show_id:id,show:'Fictional relay '+id,season:1,episode:i%32+1,episode_id:i+10000,title:'Chapter '+(i%32+1),times_watched:1};
    });
    const title=id=>tmdbResourceKey({kind:'show',id}),season=id=>tmdbResourceKey({kind:'season',id,season:1});
    const imdb=id=>tmdbResourceKey({kind:'external-ids',id});
    const row=value=>({value,fetchedAt:now,expiresAt:now+60000});
    const series=name=>({show_id:2,show:name,seasons:[]});
    let workers=0,inputs=[],orderNames=[],beforeReply,construction='ordinary',interceptError;
    function workerFixture() {
      // A separate constructor also resets the reader's failed-module cooldown between cases.
      globalThis.Worker=class extends NativeWorker {
        constructor(url,options) {
          const selected=String(url).includes('export-metadata-worker');
          if(selected){workers++;if(construction==='refused')throw new TypeError('Fictional unavailable module');}
          super(selected&&construction==='missing'?'/missing-fictional-module.js':url,options);
        }
        postMessage(data) { inputs.push(Object.keys(data).sort());super.postMessage(data); }
        set onmessage(listener) {
          super.onmessage=listener&& (async event=>{
            if(event.data?.result?.orders){
              orderNames.push(...event.data.result.orders.map(row=>row.setting));
              if(beforeReply){const action=beforeReply;beforeReply=null;try{await action();}catch(error){interceptError=String(error);}}
            }
            listener(event);
          });
        }
      };
    }
    async function slowSample() {
      // Exercise the measured-slow branch deterministically, without sleeping in a browser test.
      let sample=0;Object.defineProperty(performance,'now',{configurable:true,value:()=>++sample*500});
      try { return await store.exportSnapshot(true,now,true); }
      finally { if(clock)Object.defineProperty(performance,'now',clock);else delete performance.now; }
    }
    async function read(mode='ordinary',whileHeld) {
      construction=mode;workerFixture();beforeReply=whileHeld;
      await slowSample();
      const ref=(await store.snapshot(true)).exportRecord;
      const data=await store.exportSnapshot(true,now,true,undefined,ref);
      if(interceptError)throw Error(interceptError);
      return {missing:[...data.missingShowIds],title:data.showMetadata.get(2)?.show,order:data.showMetadata.get(2)?.manualSeasonOrder,
        expired:data.externalIds.has(3),imdb:data.externalIds.get(2),seen:data.observationTimes.get(season(2)),
        firstPlays:data.tables.watched[0].times_watched};
    }
    try {
      await store.commit((await store.snapshot()).revision,{replace:{watched:watches},put:{settings:[{setting:'season_order.2',value:'native'}]}});
      await edit(['tmdb','settings'],tx=>{
        const cache=tx.objectStore('tmdb');
        cache.put(row(null),title(1));cache.put(row(series('Fictional town')),title(2));
        cache.put({...row(null),repairScan:{at:44}},season(2));
        cache.put(row({imdbId:'tt000002'}),imdb(2));cache.put({...row({imdbId:'tt000003'}),expiresAt:now},imdb(3));
        tx.objectStore('settings').put({setting:'tmdb_key',value:'fictional-quarantined-key'});
      });
      const stable=await read(),refused=await read('refused'),missing=await read('missing');
      const {revision,tmdbGeneration}=await store.snapshot();
      const catalogChanged=await read('ordinary',()=>store.commit(revision,{},{tmdb:{
        generation:tmdbGeneration,key:title(2),entry:{value:series('Fictional town revised'),fetchedAt:now}}}));
      const replaced=await read('ordinary',()=>edit(['local','watched'],tx=>{
        tx.objectStore('local').put({...grant,instanceId:'fictional-replaced'},'dropboxSession');
        tx.objectStore('watched').put({...watches[0],times_watched:3});
      }));
      // An update-only version cannot open past this held connection. The lookup must leave its schema untouched.
      globalThis.Worker=NativeWorker;
      const scratch=await new Promise((resolve,reject)=>{const open=indexedDB.open('fictional-blocked-'+crypto.randomUUID(),1);
        open.onupgradeneeded=()=>open.result.createObjectStore('sentinel');open.onsuccess=()=>resolve(open.result);open.onerror=()=>reject(open.error);});
      let blocked;
      try {
        const {readExportMetadata}=await import('/export-metadata-reader.js');
        const value=await readExportMetadata({database:scratch.name,version:2,revision:0n,erased:0n,keys:[title(2)]},
          new AbortController().signal);
        blocked={unavailable:value===undefined,version:scratch.version,stores:[...scratch.objectStoreNames]};
      } finally {scratch.close();}
      return {stable,refused,missing,catalogChanged,replaced,blocked,workers,inputs,orderNames:[...new Set(orderNames)]};
    } finally {
      globalThis.Worker=NativeWorker;db.close();await store.closeForUpdate();
    }
  }).toString()+')()');
  const expected={missing:[1],title:'Fictional town',order:'native',expired:false,imdb:'tt000002',seen:44,firstPlays:1};
  assert.deepEqual(proof.stable,expected);assert.deepEqual(proof.refused,expected);assert.deepEqual(proof.missing,expected);
  assert.deepEqual(proof.catalogChanged,{...expected,title:'Fictional town revised'});
  assert.deepEqual(proof.replaced,{...expected,title:'Fictional town revised',firstPlays:3});
  assert.deepEqual(proof.blocked,{unavailable:true,version:1,stores:['sentinel']});
  assert.equal(proof.workers,5);assert.deepEqual(proof.orderNames,['season_order.2']);
  assert.deepEqual(proof.inputs,Array(4).fill(['database','erased','keys','revision','version']));
});
