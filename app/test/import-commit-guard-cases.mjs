import {openDeviceStore} from '../dist/storage.js';
import {applyTraktImport,planTraktImport} from '../dist/trakt-import.js';
import {applyAniListImport,planAniListImport} from '../dist/anilist-import.js';
import {tmdbResourceKey} from '../dist/tmdb-client.js';
import {sameImportOutcome} from '../dist/import-preview.js';

function check(ok,message) { if (!ok) throw Error(message); }

async function interrupted(source,mode) {
  const name='fictional-import-commit-'+crypto.randomUUID(),deadline=Date.now()+86400000;
  const identity={accountId:'fictional-owner',instanceId:'fictional-grant',signInDeadline:deadline};
  const auth={...identity,providerExpiresAt:deadline,accessExpiresAt:deadline,appKey:'example-key',
    accessToken:'example-access',refreshToken:'example-refresh'};
  let at=Date.now(),active=true,online=true,fired=false,writes=0,backups=0;
  const now=()=>at, originalPut=IDBObjectStore.prototype.put, originalWorker=window.Worker;
  const hooks={now,active:()=>active,online:()=>online,preflight:async()=>{},backup:async()=>{backups++;},
    confirm:async()=>{throw Error('Unchanged fictional import requested a second approval');}};
  const plan=source==='Trakt'?planTraktImport:planAniListImport,apply=source==='Trakt'?applyTraktImport:applyAniListImport;
  let store=await openDeviceStore({name});
  async function unlock() {
    await store.whenWriter();
    store.connectProviderKeys(()=>{throw Error('Unexpected key save');},now);
    await store.loadProviderKeys(identity,[{setting:'tmdb_key',value:'fictional-key'}],()=>true);
  }
  try {
    // Exercise the native document fallback even on browsers with dedicated workers.
    window.Worker=undefined;
    await store.storeExchangedSession(auth);await unlock();
    const before=await store.snapshot(),title={show_id:72,show:'Fictional Estuary',year:2014,imdb_id:'tt1234567'};
    const counted=mode!=='metadata';
    const placement={shows:counted?[title]:[],watched:[],ratings:[],lists:[],skipped:[],counts:[],entries:[],notices:[],
      archive:{entries:[]},generation:before.tmdbGeneration,reusedPositions:new Set(),cache:new Map()};
    const watchCount=mode==='threshold-expiry'?32:2052;
    if(counted)for(let e=1;e<=watchCount;e++)placement.watched.push({show_id:72,show:title.show,season:1,episode:e,episode_id:e+100,title:'Chapter '+e,times_watched:1});
    for(let s=1;s<=8;s++)placement.cache.set(tmdbResourceKey({kind:'season',id:72,season:s}),{
      fetchedAt:at-200,prior:null,value:{show_id:72,season:s,name:'Season '+s,episodes:[]}});
    const preview=plan(placement,before);
    IDBObjectStore.prototype.put=function(...args){
      const req=originalPut.apply(this,args);
      if(this.name===(counted?'watched':'tmdb') && ++writes===(counted?Math.min(35,watchCount):3))req.addEventListener('success',()=>{
        fired=true;
        if(mode==='left')active=false;
        else if(mode==='offline')online=false;
        else at=deadline;
      },{once:true});
      return req;
    };
    const outcome=await apply(store,placement,preview,hooks).then(saved=>({saved}),error=>({error:error.message}));
    IDBObjectStore.prototype.put=originalPut;
    check(fired && backups===1,'Did not interrupt the final native transaction');
    if(mode==='left')check(outcome.saved===false,'Left import reported as saved');
    else check(mode==='offline'?outcome.error?.includes('internet'):outcome.error?.includes('sign-in'),'Lost import prerequisite ignored');
    await store.closeForUpdate();store=await openDeviceStore({name});
    at=Date.now();active=online=true;await unlock();
    const reopened=await store.snapshot(),keys=[...placement.cache.keys()];
    check(reopened.revision===before.revision && !reopened.tables.watched.length && !reopened.tables.shows.length &&
      !(await store.tmdbEntries(keys,at)).some(Boolean),'Interrupted rows, cache or revision survived reopening');
    check(await apply(store,placement,plan(placement,reopened),hooks),'New approval did not save');
    const saved=await store.snapshot();
    check(saved.tables.watched.length===placement.watched.length && (await store.tmdbEntries(keys,at)).filter(Boolean).length===keys.length,
      'The fresh import did not save its reviewed watches and cache');
  } finally {
    IDBObjectStore.prototype.put=originalPut;window.Worker=originalWorker;await store.closeForUpdate();
    await new Promise((ok,no)=>{const q=indexedDB.deleteDatabase(name);q.onsuccess=ok;q.onerror=()=>no(q.error);});
  }
}

export async function importCommitGuards(run) {
  await run('Small import reviews read the selected watches, preserve global classifications and expose only the sign-in identity',async()=>{
    const name='fictional-preview-projection-'+crypto.randomUUID(),store=await openDeviceStore({name});
    const deadline=Date.now()+86_400_000;
    const grant={accountId:'fictional-owner',instanceId:'fictional-grant',signInDeadline:deadline,providerExpiresAt:deadline,
      accessExpiresAt:deadline,accessToken:'fictional-access-secret',refreshToken:'fictional-refresh-secret',appKey:'fictional-public'};
    const original=IDBObjectStore.prototype.getAll;
    try{
      await store.whenWriter();await store.storeExchangedSession(grant);
      const shows=[2,53,718].map(id=>({show_id:id,show:'Fictional Station '+id,year:2016,imdb_id:''}));
      const watched=shows.map(show=>({show:show.show,show_id:show.show_id,season:1,episode:1,episode_id:show.show_id*10,title:'Fictional Moon',times_watched:3}));
      const before=await store.snapshot();
      await store.commit(before.revision,{put:{shows,watched,ratings:[{show:shows[0].show,show_id:2,rating:4}],
        lists:[{show:shows[1].show,show_id:53,list:'anime'}],settings:[{setting:'appearance',value:'light'}]}});
      const full=await store.snapshot(),reads=[];
      IDBObjectStore.prototype.getAll=function(...args){
        if(this.name==='watched')reads.push(args[0]?[args[0].lower[0],args[0].upper[0]]:null);
        return original.apply(this,args);
      };
      const projected=await store.importPreviewSnapshot([718,2,718]);
      IDBObjectStore.prototype.getAll=original;
      check(JSON.stringify(reads)==='[[2,2],[718,718]]','A sparse selection loaded unrelated watched episodes or duplicate ranges');
      check(projected.tables.watched.map(row=>row.show_id).join()==='2,718' && projected.tables.lists[0].list==='anime','Missing selected watches or global list spelling');
      check(!('settings' in projected.tables) && !('sync' in projected) && Object.keys(projected.local).sort().join()==='dropboxSession,syncAccountId',
        'The initial review carried settings or sync data');
      check(Object.keys(projected.local.dropboxSession).join()==='instanceId' && !JSON.stringify(projected).includes('-secret'),
        'A credential reached the initial review');
      const titles=[shows[0],shows[2]],rows=[watched[0],watched[2]];
      const placement={shows:titles,watched:rows,skipped:[],counts:[],entries:titles.map(s=>({...s,id:s.show_id,status:2,score:90,favourite:true})),
        notices:[],ratings:titles.map(s=>({...s,rating:9})),lists:[],reusedPositions:new Set()};
      for(const plan of [planTraktImport,planAniListImport]){
        const small=plan(placement,projected),all=plan(placement,full);
        check(sameImportOutcome(small,all) && JSON.stringify(small.changes)===JSON.stringify(all.changes),'Projected and complete review disagree');
        check(small.accountId===grant.accountId && small.instanceId===grant.instanceId,'Review lost its binding');
      }
      const unmatched=await store.importPreviewSnapshot([]);
      check(Object.values(unmatched.tables).every(rows=>!rows.length) && unmatched.local.syncAccountId===grant.accountId,
        'An unmatched archive loaded personal rows or lost its account binding');
      const stopped=new AbortController();stopped.abort();
      const canceled=await store.importPreviewSnapshot([2],stopped.signal).then(()=>false,e=>e.name==='AbortError');
      check(canceled,'A canceled read continued preparing an old review');
    }finally{
      IDBObjectStore.prototype.getAll=original;await store.closeForUpdate();
      await new Promise((yes,no)=>{const q=indexedDB.deleteDatabase(name);q.onsuccess=yes;q.onerror=()=>no(q.error);});
    }
  });
  for (const source of ['Trakt','AniList']) await run(source+' requires a current review through the final watch and cache writes',async()=>{
    for(const mode of ['expired','left','offline','metadata','threshold-expiry'])await interrupted(source,mode);
  });
}
