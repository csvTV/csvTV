import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {createRelease} from '../package-release.mjs';
import {writeCsv} from '../src/csv.ts';
import {openChromium} from './offline-chromium.mjs';
import {linkFixture,offlineProviders} from './offline-providers.mjs';
import {listen,stop} from './offline-site.mjs';
import {releaseServer,unpack} from './release-site.mjs';

async function seedHeaders(count) {
  const {openDeviceStore} = await import('/storage.js');
  const {tmdbResourceKey} = await import('/tmdb-client.js');
  const store = await openDeviceStore();
  try {
    await store.whenWriter();
    const {session} = await store.dropboxState();
    store.connectProviderKeys(async () => { throw Error('Unexpected credential edit'); }, Date.now);
    await store.loadProviderKeys(session,[{setting:'tmdb_key',value:'fictional-offline-key'}],()=>true);
    const entries = {}, fetchedAt = Date.now();
    for (let id=1;id<=count;id++) {
      if (id===4 || id===6) continue;
      const seasons=[{season:0,episodeCount:1},{season:1,episodeCount:3}];
      entries[tmdbResourceKey({kind:'show',id})]={fetchedAt,value:{show_id:id,show:'Signal',status:'Returning Series',
        firstAirDate:'2015-01-05',seasons,lastAired:{season:1,episode:3},nextAirDate:null,nextEpisode:null,
        genres:[],networks:[],keywords:id===2?[{id:23,name:'anime'}]:[],originCountries:id===2 || id===3?['KR']:['US'],posterPath:null,imdbId:null}};
      const episodes=[1,2,3].map(n=>({episode:n,episode_id:id*100+n,title:'Episode '+n,
        airDate:n===3?'2999-01-02':'2015-01-05'}));
      entries[tmdbResourceKey({kind:'season',id,season:1})]={fetchedAt,value:{show_id:id,season:1,episodes}};
    }
    if (!await store.writeTmdb((await store.tmdbState()).generation,{entries})) throw Error('Unable to seed fictional seasons');
  } finally { await store.closeForUpdate(); }
}

test('Ratings shows regular aired progress after plays and reads episode details as cards approach the viewport', {timeout:60000}, async t=>{
  const {bytes}=await createRelease(new URL('../dist/',import.meta.url));
  const server=releaseServer(await unpack(bytes)), origin='http://127.0.0.1:'+await listen(server);
  const profile=await mkdtemp(join(tmpdir(),'csvtv-rated-status-')), cloud=offlineProviders(origin);
  let browser;
  t.after(async()=>{try{await browser?.close();}finally{await stop(server);await rm(profile,{recursive:true,force:true,maxRetries:6,retryDelay:150});}});
  const count=48, title=id=>'Signal '+String(id).padStart(2,'0');
  const row=(id,season,episode,plays,episodeId=id*100+episode)=>({
    show_id:id,show:title(id),season,episode,episode_id:episodeId,times_watched:plays,title:'Chapter '+episode});
  await cloud.settings({tmdb_key:'fictional-offline-key',ratings_sort:'shuffle'});
  await cloud.upload('ratings.csv',writeCsv('ratings',Array.from({length:count},(_,i)=>({show_id:i+1,show:title(i+1),rating:8}))));
  await cloud.upload('lists.csv',writeCsv('lists',[{show_id:3,show:title(3),list:'Dropped'},{show_id:4,show:title(4),list:'Anime'}]));
  await cloud.upload('watched.csv',writeCsv('watched',[
    row(1,1,1,2),row(1,1,2,1),row(1,0,1,3,199),
    row(2,1,1,2),row(2,1,3,2),row(2,0,1,3,299),row(3,1,1,1),row(3,1,2,1),
    row(4,1,1,3),row(7,1,1,1,9999),row(count,1,2,1),
  ]));
  browser=await openChromium(profile,(params,send)=>new URL(params.request.url).hostname==="api.themoviedb.org"
    ? send('Fetch.failRequest',{requestId:params.requestId,errorReason:'InternetDisconnected'}) : cloud.respond(params,send));
  await browser.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await linkFixture(browser,origin,'/');
  await browser.evaluate('('+seedHeaders+')('+count+')');
  await browser.navigate(origin+'/#/settings');
  await browser.waitFor('document.querySelector(".sync-state")?.dataset.synced==="true"');
  await browser.evaluate(`(async()=>{
    const {DeviceStore}=await import('/storage.js'), original=DeviceStore.prototype.tmdbEntries;
    window.seasonReads=[];
    const headers = Promise.withResolvers();
    window.releaseRatingHeaders = headers.resolve;
    DeviceStore.prototype.tmdbEntries=function(keys,...args){
      // The background refresh also reads these seasons. Only count reads tied to the Ratings screen.
      if (location.hash === '#/ratings' && args[1] instanceof AbortSignal) {
        window.seasonReads.push(...keys.filter(key=>key.includes('/season/')));
        if (keys.some(key=>key.startsWith('tv/') && key.split('/').length===2)) {
          return headers.promise.then(()=>original.call(this,keys,...args));
        }
      }
      return original.call(this,keys,...args);
    };
  })()`);
  await browser.evaluate('document.querySelector(\'.phone-nav a[href="#/ratings"]\').click()');
  await browser.waitFor('document.querySelector(".ratings-rows li")');
  await chooseCategory('k-drama');
  assert.equal(await browser.evaluate('document.querySelector(".ratings-screen .tv-empty").textContent'),'Loading…');
  assert.equal(await browser.evaluate('document.querySelector(".ratings-total").textContent'),'');
  const search = 'document.querySelector(".ratings-screen input")';
  await browser.evaluate(`{ const input=${search}; input.value="fictional missing title"; input.dispatchEvent(new Event("input")); }`);
  await browser.evaluate('window.releaseRatingHeaders()');
  await browser.waitFor('document.querySelector(".ratings-screen .tv-empty").textContent==="No matching ratings."','completed category lookup');
  assert.equal(await browser.evaluate('document.querySelector(".ratings-total").textContent'),'0 shows');
  await browser.evaluate(`{ const input=${search}; input.value=""; input.dispatchEvent(new Event("input")); }`);
  await browser.waitFor('document.querySelectorAll(".ratings-rows li").length===2','Korean ratings after metadata');
  await chooseCategory('all');
  const caption=id=>'document.querySelector(\'.ratings-rows [data-show-id="'+id+'"] .rating-show-copy small\')?.textContent';
  for (const [id,expected] of [[1,'2015 · 6 plays · Completed'],[2,'2015 · 7 plays · 1 of 2'],[3,'2015 · 2 plays · Dropped'],
    [4,'3 plays · 1 episode'],[5,'2015 · 0 plays · 0 of 2'],[6,'0 plays · Not watched'],[7,'2015 · 1 play · 0 of 2']]) {
    await browser.waitFor(caption(id)+'==='+JSON.stringify(expected),expected);
  }
  const before=await browser.evaluate('window.seasonReads');
  assert.ok(!before.includes('tv/'+count+'/season/1'),'An offscreen series requested its seasons');
  assert.ok(!before.some(key=>key.startsWith('tv/3/') || key.endsWith('/season/0')),'Dropped or special season details were read');
  await browser.evaluate('document.querySelector(\'.ratings-rows [data-show-id="'+count+'"]\').scrollIntoView()');
  await browser.waitFor(caption(count)+'==="2015 · 1 play · 1 of 2"','progress for a newly visible card');
  assert.ok(await browser.evaluate('window.seasonReads.includes("tv/'+count+'/season/1")'));
  assert.equal(await browser.evaluate('document.querySelector(\'select[aria-label="Sort"]\').value'),'high');
  async function chooseCategory(value) {
    await browser.evaluate('(()=>{const field=document.querySelector(\'select[aria-label="Category"]\');field.value='+JSON.stringify(value)+
      ';field.dispatchEvent(new Event("change",{bubbles:true}));})()');
  }
  const ids='[...document.querySelectorAll(".ratings-rows li")].map(el=>Number(el.dataset.showId))';
  await chooseCategory('anime');
  assert.deepEqual(await browser.evaluate(ids),[2,4]);
  await chooseCategory('k-drama');
  assert.deepEqual(await browser.evaluate(ids),[2,3]);
  await chooseCategory('tv');
  const other=await browser.evaluate(ids);
  assert.equal(other.length,count-4);
  assert.ok([2,3,4,6].every(id=>!other.includes(id)));
  await browser.evaluate('document.querySelector(\'.phone-nav a[href="#/library"]\').click()');
  await browser.waitFor('document.querySelector(".library-screen")');
  await browser.evaluate('document.querySelector(\'.phone-nav a[href="#/ratings"]\').click()');
  await browser.waitFor(ids+'.length==='+count);
  assert.equal(await browser.evaluate('document.querySelector(\'select[aria-label="Category"]\').value'),'all');
  assert.match(Buffer.from(cloud.files.get('/settings.csv').bytes).toString(),/ratings_sort,shuffle/,'Opening a retired sort rewrote the remote preference');
});
