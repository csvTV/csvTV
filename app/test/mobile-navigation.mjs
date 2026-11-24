import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import test from 'node:test';
import {createRelease} from '../package-release.mjs';
import {writeCsv} from '../dist/csv.js';
import {openChromium, until} from './offline-chromium.mjs';
import {linkFixture, offlineProviders} from './offline-providers.mjs';
import {listen, stop} from './offline-site.mjs';
import {releaseServer, unpack} from './release-site.mjs';

// The watch record travels through the shipped Dropbox client. Provider requests
// stay inside the isolated profile's local fixture, including background detail.
test('phone navigation paints the record during first sync and cached detail before remote refresh', {timeout:600000}, async t => {
  const comparison = process.env.CSVTV_NAVIGATION_COMPARISON_ZIP;
  const zip = comparison ? await readFile(comparison) : (await createRelease(new URL('../dist/',import.meta.url))).bytes;
  const server = releaseServer(await unpack(zip)), origin = 'http://127.0.0.1:' + await listen(server);
  const dir = await mkdtemp(join(tmpdir(),'csvtv-phone-navigation-'));
  let browser;
  const holds = new Map();
  t.after(async () => {
    for (const gate of holds.values()) gate.resolve();
    try { await browser?.close(); } finally { await stop(server); await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:150}); }
  });
  const cloud = offlineProviders(origin), count = 300, watched = [], ratings = [], shows = [], lists = [];
  const name = id => 'Signal ' + String(id).padStart(3,'0');
  for (let id=1; id<=count; id++) {
    const title = {show_id:id,show:name(id)};
    shows.push({...title,year:2020,imdb_id:''});
    ratings.push({...title,rating:8});
    if (id % 5 === 0) lists.push({...title,list:'Watchlist'});
    for (let ep=1; ep<=45; ep++) watched.push({...title,season:1,episode:ep,episode_id:id*100+ep,title:'Episode '+ep,times_watched:1});
  }
  for (const [table,rows] of Object.entries({shows,watched,ratings,lists})) await cloud.upload(table+'.csv',writeCsv(table,rows));
  await cloud.settings({tmdb_key:'fictional-offline-key'});
  const loaded = new Set(), headers = new Set(), held = new Set();
  browser = await openChromium(dir, async (event, send) => {
    const {hostname,pathname} = new URL(event.request.url);
    await delay(hostname.includes('dropbox') ? 75 : 120);
    const path = /^\/3\/tv\/(\d+)(?:\/(.*))?$/.exec(pathname);
    if (!path || event.request.method !== 'GET') return cloud.respond(event,send);
    const id = Number(path[1]), child = path[2];
    const gate = id === 1 && holds.get(child ?? 'header');
    if(gate) { held.add(child ?? 'header'); await gate.promise; }
    const body = !child ? {id,name:name(id),first_air_date:'2020-01-01',status:'Ended',overview:'Fictional series.',
      seasons:[{season_number:1,episode_count:45}],last_episode_to_air:{season_number:1,episode_number:45,air_date:'2021-01-01'},
      keywords:{results:[]},external_ids:{imdb_id:null}} : child === 'season/1' ? {season_number:1,episodes:
        Array.from({length:45},(_,i) => ({id:id*100+i+1,episode_number:i+1,name:'Episode '+(i+1),air_date:'2020-01-01'}))} :
      child === 'aggregate_credits' ? {id,cast:[]} : {page:1,total_pages:1,results:[]};
    await send('Fetch.fulfillRequest',{requestId:event.requestId,responseCode:200,
      responseHeaders:[{name:'Content-Type',value:'application/json'},{name:'Access-Control-Allow-Origin',value:origin}],
      body:Buffer.from(JSON.stringify(body)).toString('base64')});
    if(child === 'season/1') loaded.add(id);
    if(!child) headers.add(id);
  });
  await browser.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await browser.send('Emulation.setTouchEmulationEnabled',{enabled:true});
  await linkFixture(browser,origin,'/');
  await browser.send('Emulation.setCPUThrottlingRate',{rate:4});
  await browser.send('Page.addScriptToEvaluateOnNewDocument',{source:`(() => {
    const timing = window.navTiming = {gridRemovals:0}, frame = () => {
      const stamp = Math.round(performance.now()), mark = (key, found) => { if (found && timing[key]===undefined) timing[key]=stamp; };
      mark('shell',document.querySelector('.phone-nav'));
      const totals = document.querySelector('.record-totals');
      mark('totals',totals?.firstElementChild?.lastElementChild?.textContent === '300' &&
        totals.lastElementChild.lastElementChild.textContent.replace(/[^0-9]/g,'') === '13500');
      mark('synced',document.querySelector('.sync-state')?.dataset.synced === 'true');
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    new MutationObserver(records => { for(const rec of records) if(rec.target.matches?.('.library-grid')) timing.gridRemovals += rec.removedNodes.length; })
      .observe(document,{childList:true,subtree:true});
  })()`});
  await browser.navigate(origin+'/#/home');
  await until(() => browser.evaluate('window.navTiming.totals'),'full personal Home totals',150000);
  const personal = await browser.evaluate('window.navTiming');
  t.diagnostic('Fresh signed-in shell '+personal.shell+' ms, all 13,500 watches in Home '+personal.totals+' ms');
  async function visit(click,ready) {
    return browser.evaluate(`(async () => {
      const elapsed = performance.now(), frame = () => new Promise(resolve=>requestAnimationFrame(resolve));
      document.querySelector(${JSON.stringify(click)}).click();
      do { await frame(); if (${ready}) { await frame(); return Math.round(performance.now()-elapsed); } }
      while(performance.now()-elapsed<20000);
      throw Error('Page did not paint on '+location.hash);
    })()`);
  }
  const libraryReady = 'document.querySelectorAll(".library-grid > li").length === 300';
  const library = '.phone-nav [data-destination=library]';
  t.diagnostic('First Library with background metadata running '+await visit(library,libraryReady)+' ms');
  const snapshot = () => ({headers:headers.size,seasons:loaded.size,other:[...cloud.metadataReads]});
  try { await until(() => loaded.size === count,'all '+count+' title and season responses',420000); }
  catch (error) { throw new Error(error.message+' '+JSON.stringify(snapshot())+' '+await browser.evaluate('document.body.innerText.slice(0,350)')); }
  await browser.waitFor('document.querySelectorAll(".library-status-caption").length === 300 && [...document.querySelectorAll(".library-status-caption")].every(n => n.textContent === "Complete")');
  await until(() => browser.evaluate('Number.isFinite(window.navTiming.synced) && document.querySelector(".sync-state")?.dataset.synced === "true"'),'painted Dropbox sync after background metadata',100000);
  const done = await browser.evaluate('({...navTiming,end:Math.round(performance.now())})');
  t.diagnostic('First synced indicator '+done.synced+' ms; 300 headers, seasons, Library completion labels and synced indicator '+done.end+' ms; Library card removals '+done.gridRemovals);
  const open = async (page,ready) => visit('.phone-nav [data-destination='+page+']',ready);
  const visits = [];
  for(let i=0;i<3;i++) {
    const rating = await open('ratings','document.querySelectorAll(".ratings-screen select[aria-label^=\'Rating for\']").length === 300');
    const grid = await open('library',libraryReady);
    visits.push({rating,library:grid});
  }
  t.diagnostic('Warm Ratings and Library navigation (ms) '+JSON.stringify(visits));
  // Stall a cached show's live refresh. Determine whether navigation painted the cached
  // show before releasing it, then repeat on a season with 45 cached episode identities.
  const measured = {};
  for(const [route,click,ready] of [
    ['show','.library-grid a[href="#/show/1"]','document.querySelector(".show-hero h1")?.textContent === "Signal 001"'],
    ['season','.show-season-row','document.querySelectorAll(".season-episode").length === 45'],
  ]) {
    const resource = route === 'show' ? 'header' : 'season/1';
    const gate = Promise.withResolvers();
    holds.set(resource,gate);
    const result = visit(click,ready);
    await until(() => held.has(resource),'stalled '+route+' request');
    await delay(700);
    const early = await browser.evaluate(ready);
    measured[route] = {early};
    gate.resolve();
    holds.delete(resource);
    measured[route].paint = await result;
  }
  t.diagnostic('Remote refresh gate '+JSON.stringify(measured));
  if(!comparison) {
    assert.ok(measured.show.early,'a cached show waited for its live refresh');
    assert.ok(measured.season?.early,'a cached episode list waited for its live refresh');
    assert.equal(done.gridRemovals,0,'the Library replaced cards as provider details arrived');
  }
});
