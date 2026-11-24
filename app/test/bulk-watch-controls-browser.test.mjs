import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {createRelease} from '../package-release.mjs';
import {writeCsv} from '../src/csv.ts';
import {openChromium} from './offline-chromium.mjs';
import {linkFixture,offlineProviders} from './offline-providers.mjs';
import {listen,stop} from './offline-site.mjs';
import {releaseServer,unpack} from './release-site.mjs';

const name='Evening Orchard',id=45;
const episode=(s,n)=>({show_id:id,season_number:s,episode_number:n,id:45000+s*100+n,name:'Chapter '+n,
  runtime:24,air_date:s===8 && n===20?'2999-01-01':'2010-02-01'});
const seasons=Array.from({length:9},(_,s)=>({id:450+s,season_number:s,name:s?'Season '+s:'Specials',episode_count:s?20:1}));
const detail=s=>({...seasons[s],episodes:Array.from({length:seasons[s].episode_count},(_,i)=>episode(s,i+1))});
const row=(s,n,w)=>({show_id:id,show:name,season:s,episode:n,episode_id:episode(s,n).id,title:'Chapter '+n,times_watched:w});
const expected=count=>[row(0,1,2),...seasons.slice(1).flatMap(s=>Array.from({length:s.season_number===8?19:20},(_,i)=>row(s.season_number,i+1,count)))];

function metadata(url) {
  const m=/^\/3\/tv\/45(?:\/(.*))?$/.exec(url.pathname);
  if(!m)return;
  const extras={external_ids:{id,imdb_id:null},episode_groups:{id,results:[]},aggregate_credits:{id,cast:[]},recommendations:{page:1,total_pages:0,results:[]}};
  if(m[1]?.startsWith('season/'))return detail(Number(m[1].slice(7)));
  if(m[1])return extras[m[1]];
  const header={id,name,first_air_date:'2010-02-01',overview:'',origin_country:['NZ'],status:'Returning Series',seasons,
    number_of_seasons:8,number_of_episodes:160,vote_average:7,vote_count:10,keywords:{results:[]},external_ids:extras.external_ids,
    last_episode_to_air:episode(8,19),next_episode_to_air:episode(8,20)};
  for(const key of (url.searchParams.get('append_to_response')??'').split(',')) {
    if(key.startsWith('season/'))header[key]=detail(Number(key.slice(7)));
    else if(extras[key])header[key]=extras[key];
  }
  return header;
}

async function inspect() {
  const {openDeviceStore}=await import('/storage.js'),{writeCsv}=await import('/csv.js'),store=await openDeviceStore();
  try{const {tables}=await store.snapshot();return {csv:writeCsv('watched',tables.watched),recent:tables.settings.filter(r=>r.setting.startsWith('recently_marked.'))};}
  finally{store.close();}
}

test('Finish, Watched again and Undo save one large show without touching its special or future episode',{timeout:90000},async t=>{
  const {bytes}=await createRelease(new URL('../dist/',import.meta.url)),server=releaseServer(await unpack(bytes));
  const origin='http://127.0.0.1:'+await listen(server),profile=await mkdtemp(join(tmpdir(),'csvtv-large-watch-controls-'));
  const cloud=offlineProviders(origin),inspectRecord='('+inspect.toString()+')()';
  let browser;t.after(async()=>{try{await browser?.close();}finally{await stop(server);await rm(profile,{recursive:true,force:true,maxRetries:6,retryDelay:150});}});
  await cloud.settings({tmdb_key:'fictional-offline-key'});await cloud.upload('watched.csv',writeCsv('watched',[row(0,1,2),row(1,1,1)]));
  const open=()=>openChromium(profile,(params,send)=>{
    const url=new URL(params.request.url),answer=url.hostname==='api.themoviedb.org'&&params.request.method==='GET'?metadata(url):null;
    return answer?send('Fetch.fulfillRequest',{requestId:params.requestId,responseCode:200,
      responseHeaders:[{name:'Access-Control-Allow-Origin',value:origin},{name:'Content-Type',value:'application/json'}],
      body:Buffer.from(JSON.stringify(answer)).toString('base64')}):cloud.respond(params,send);
  });
  browser=await open();await linkFixture(browser,origin,'/');await browser.navigate(origin+'/#/settings');
  await browser.waitFor('document.querySelector(".sync-state")?.dataset.synced==="true" && document.querySelector("[data-offline-status]")?.textContent==="Ready to open offline."');
  const observe=count=>browser.evaluate(`{const Real=Worker;window.bulkWatchCompletions=${count};window.Worker=class extends Real {
    constructor(url,options){super(url,options);if(String(url).endsWith('/watch-edit-worker.js'))this.addEventListener('message',e=>{
      if(e.data.type==='admission' && window.holdRewatch){e.stopImmediatePropagation();window.rewatchStaged=true;}
      if(e.data.type==='complete')window.bulkWatchCompletions++;
    });}
  };location.hash='/show/45';}`);
  await observe(0);
  const primary='document.querySelector(\'[data-focus="mark"]\')';
  await browser.waitFor(primary+'?.textContent==="Finish"');await browser.evaluate(primary+'.click()');
  await browser.waitFor('window.bulkWatchCompletions===1 && '+primary+'?.textContent==="Watched again"');
  const first=await browser.evaluate(inspectRecord);
  assert.equal(first.csv,writeCsv('watched',expected(1)));assert.ok(first.recent.length>=7);
  await browser.evaluate('window.holdRewatch=true;'+primary+'.click()');await browser.waitFor('window.rewatchStaged===true');
  void browser.send('Page.crash').catch(()=>{});await delay(150);await browser.close();
  browser=await open();await browser.navigate(origin+'/#/settings');await browser.waitFor('document.querySelector(".sync-state")?.dataset.synced==="true"');
  assert.deepEqual(await browser.evaluate(inspectRecord),first,'Interrupted rewatch changed the record');
  await observe(1);await browser.waitFor(primary+'?.textContent==="Watched again"');
  await browser.evaluate(primary+'.click()');
  await browser.waitFor('window.bulkWatchCompletions===2 && document.querySelector(".undo-bar:not([hidden])")?.textContent.includes("watched again")');
  const second=await browser.evaluate(inspectRecord);
  assert.equal(second.csv,writeCsv('watched',expected(2)));assert.deepEqual(second.recent,first.recent);
  const undo='[...document.querySelectorAll(".undo-bar button")].find(b=>b.textContent==="Undo")';
  await browser.evaluate(undo+'.click()');await browser.waitFor('window.bulkWatchCompletions===3 && document.querySelector(".undo-bar").hidden');
  assert.deepEqual(await browser.evaluate(inspectRecord),first);
  await browser.evaluate("location.hash='/settings'");await browser.waitFor('document.querySelector(".sync-state")?.dataset.synced==="true"');
  assert.equal(new TextDecoder().decode(cloud.files.get('/watched.csv').bytes),first.csv);
  await browser.close();browser=await open();await browser.offline(true);await browser.navigate(origin+'/#/library');
  await browser.waitFor('document.querySelector(".library-grid")?.innerText.includes("Evening Orchard")');
  assert.deepEqual(await browser.evaluate(inspectRecord),first);
});
