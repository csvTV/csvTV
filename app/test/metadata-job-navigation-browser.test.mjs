import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {createRelease} from '../package-release.mjs';
import {writeCsv} from '../dist/csv.js';
import {openChromium} from './offline-chromium.mjs';
import {linkFixture,offlineProviders} from './offline-providers.mjs';
import {listen,stop} from './offline-site.mjs';
import {releaseServer,unpack} from './release-site.mjs';

async function captureJob() {
  const {TmdbLibrary} = await import('/tmdb-library.js'), original = TmdbLibrary.prototype.run;
  const ready = Promise.withResolvers();
  TmdbLibrary.prototype.run = function() {
    TmdbLibrary.prototype.run = original;
    window.fictionalMetadataJob = this;
    const running = original.call(this);
    running.then(ready.resolve,ready.reject);
    return running;
  };
  dispatchEvent(new Event('online'));
  await ready.promise;
  await new Promise(resolve=>setTimeout(resolve,600));
}

async function renewSeason() {
  const {cacheExpiresAt} = await import('/tmdb-refresh.js');
  const {tmdbResourceKey} = await import('/tmdb-client.js');
  const job = window.fictionalMetadataJob, store = job.service.store;
  const key = tmdbResourceKey({kind:'season',id:45,season:1}), age = Date.now()-62*86400000;
  // Make this one entry due as it would be after two months away. Keep the sign-in live.
  const db = await new Promise((resolve,reject)=>{
    const req = indexedDB.open('csvTV'); req.onsuccess=()=>resolve(req.result); req.onerror=()=>reject(req.error);
  });
  try {
    await new Promise((resolve,reject)=>{
      const tx = db.transaction('tmdb','readwrite'), cache = tx.objectStore('tmdb'), found = cache.get(key);
      found.onsuccess=()=>{
        if (!found.result) {tx.abort();return;}
        cache.put({...found.result,fetchedAt:age,expiresAt:cacheExpiresAt(age)},key);
      };
      tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error ?? Error('Missing fictional season'));
    });
  } finally {db.close();}
  const state = store.statisticsState, changes = [];
  const observe = e=>changes.push(e.type);
  let checks = 0;
  store.statisticsState=function(...args){checks++;return state.apply(this,args);};
  for (const event of ['tmdbmetadata','tmdbbrowse']) store.addEventListener(event,observe);
  try {
    await job.run();
    await new Promise(resolve=>setTimeout(resolve,700));
    return {checks,changes,hours:document.querySelector('[data-stat=hours] dd').textContent};
  } finally {
    store.statisticsState=state;
    for (const event of ['tmdbmetadata','tmdbbrowse']) store.removeEventListener(event,observe);
  }
}

test('the packaged detail job keeps an unchanged Statistics report mounted and publishes a real runtime change', {timeout:45000},async t=>{
  const {bytes}=await createRelease(new URL('../dist/',import.meta.url)), server=releaseServer(await unpack(bytes));
  const origin='http://127.0.0.1:'+await listen(server), cloud=offlineProviders(origin);
  const profile=await mkdtemp(join(tmpdir(),'csvtv-job-notices-'));
  let browser, runtime=30, seasonCalls=0;
  t.after(async()=>{try{await browser?.close();}finally{await stop(server);await rm(profile,{recursive:true,force:true,maxRetries:6,retryDelay:150});}});
  await cloud.settings({tmdb_key:'fictional-offline-key'});
  await cloud.upload('watched.csv',writeCsv('watched',[1,2].map(episode=>({show_id:45,show:'The Listening House',season:1,
    episode,title:'Recording '+episode,times_watched:1,episode_id:45010+episode}))));
  browser=await openChromium(profile,(request,send)=>cloud.respond(request,(method,reply)=>{
    if (new URL(request.request.url).pathname==='/3/tv/45/season/1' && request.request.method==='GET' && reply.body) {
      const season=JSON.parse(Buffer.from(reply.body,'base64'));
      for (const episode of season.episodes) episode.runtime=runtime;
      reply={...reply,body:Buffer.from(JSON.stringify(season)).toString('base64')};
      seasonCalls++;
    }
    return send(method,reply);
  }));
  await linkFixture(browser,origin,'/');
  await browser.navigate(origin+'/#/statistics');
  await browser.waitFor('document.querySelector("[data-stat=hours] dd")?.textContent === "1" && document.querySelector(".sync-state")?.dataset.synced === "true"');
  await browser.evaluate('('+captureJob+')()');
  const previous=seasonCalls, unchanged=await browser.evaluate('('+renewSeason+')()');
  assert.ok(seasonCalls>previous);
  assert.deepEqual(unchanged,{checks:0,changes:['tmdbbrowse'],hours:'1'});
  runtime=90;
  const changed=await browser.evaluate('('+renewSeason+')()');
  assert.ok(changed.checks>=1);
  assert.deepEqual(changed.changes,['tmdbmetadata']);
  assert.equal(changed.hours,'3');
});
