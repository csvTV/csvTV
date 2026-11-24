import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {listen,stop,testSite} from './offline-site.mjs';

/** Compare the shipped lookup with the former one-get-per-key read on the same data. */
async function compareReads() {
  const {openDeviceStore}=await import('/tracker/storage.js');
  const name='fictional-metadata-benchmark', device=await openDeviceStore({name});
  const result=request=>new Promise((resolve,reject)=>{
    request.onsuccess=()=>resolve(request.result); request.onerror=()=>reject(request.error);
  });
  const done=tx=>new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});
  const db=await result(indexedDB.open(name));
  try {
    const tx=db.transaction('tmdb','readwrite'),cache=tx.objectStore('tmdb'),now=Date.now();
    const put=(key,value)=>cache.put({value,fetchedAt:now,expiresAt:now+86400000},key);
    const cases={seasons:[],headers:[],combined:[],sparse:[]};
    for(let id=1;id<=60;id++) {
      const root='tv/'+id, header=root+'?append_to_response=keywords,external_ids';
      cases.headers.push(header); cases.combined.push(header);
      put(header,{key:header,name:'Signal Station '+id});
      put(root+'/aggregate_credits',{cast:[{id,name:'Cam River'}]});
      for(let season=1;season<=3;season++) {
        const key=root+'/season/'+season;
        cases.seasons.push(key); cases.combined.push(key);
        put(key,{key,episodes:Array.from({length:15},(_,i)=>({id:id*1000+season*20+i,title:'Broadcast '+i,
          overview:'A short fictional description',runtime:30,episode:i+1}))});
      }
      if(id%4===0){cases.sparse.push(header);put(root+'/recommendations?page=1',{titles:['Unrelated'.repeat(150)]});}
    }
    await done(tx);
    async function previous(keys) {
      const hasShows=keys.some(key=>/^tv\/\d+(?:\?|$)/.test(key));
      const tx=db.transaction(hasShows?['tmdb','settings']:['tmdb']),cache=tx.objectStore('tmdb');
      const [rows,settings]=await Promise.all([Promise.all(keys.map(key=>result(cache.get(key)))),
        hasShows?result(tx.objectStore('settings').getAll(IDBKeyRange.bound('season_order.','season_order.\uffff'))):[],done(tx)]);
      const orders=new Map(settings.map(row=>['tv/'+row.setting.slice('season_order.'.length)+'?append_to_response=keywords,external_ids',row.value]));
      return rows.map((r,i)=>r && r.expiresAt>now && r.fetchedAt<=now ? {fetchedAt:r.fetchedAt,
        value:orders.has(keys[i])?{...r.value,manualSeasonOrder:orders.get(keys[i])}:r.value}:undefined);
    }
    const readings={};
    for (const [name,keys] of Object.entries(cases)) {
      const samples={single:[],batched:[]};readings[name]=samples;
      for(const method of ['single','batched','batched','single']) {
        const start=performance.now();
        const rows=method==='single'?await previous(keys):await device.tmdbEntries(keys,now);
        samples[method].push(Math.round(performance.now()-start));
        if(rows.some((row,i)=>row?.value.key!==keys[i])) throw Error('A metadata value was assigned to a different key');
      }
    }
    return readings;
  } finally {db.close();await device.closeForUpdate();}
}

const require=createRequire(import.meta.url), engines=require(process.env.CSVTV_PLAYWRIGHT_MODULE || 'playwright-core');
const choice=process.argv[2];assert.ok(choice==='webkit'||choice==='chromium','Choose webkit or chromium');
const {server}=await testSite(), origin='http://127.0.0.1:'+await listen(server);
let browser;
try {
  browser=await engines[choice].launch({headless:true,...(choice==='chromium'?{channel:'chrome'}:{})});
  const page=await browser.newPage();
  await page.goto(origin+'/fixture');
  console.log(choice+' '+JSON.stringify(await page.evaluate(compareReads)));
} finally {try {await browser?.close();} finally {await stop(server);}}
