import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {readCsv,writeCsv} from '../dist/csv.js';
import {createRelease} from '../package-release.mjs';
import {openChromium,until} from './offline-chromium.mjs';
import {linkFixture,offlineProviders} from './offline-providers.mjs';
import {listen,stop} from './offline-site.mjs';
import {seedRatedLibrary} from './populated-navigation-fixture.mjs';
import {releaseServer,unpack} from './release-site.mjs';

test('returning to Statistics reuses its charts after a Library sort uploads and refreshes after a peer watch edit', {timeout:90000},async t=>{
  const {bytes}=await createRelease(new URL('../dist/',import.meta.url));
  const server=releaseServer(await unpack(bytes)), origin='http://127.0.0.1:'+await listen(server);
  const profile=await mkdtemp(join(tmpdir(),'csvtv-synced-statistics-'));
  const cloud=offlineProviders(origin);
  let browser;
  t.after(async()=>{
    try{await browser?.close();}finally{await stop(server);await rm(profile,{recursive:true,force:true,maxRetries:6,retryDelay:150});}
  });
  browser=await openChromium(profile,(event,send)=>new URL(event.request.url).hostname.endsWith('.dropboxapi.com')
    ? cloud.respond(event,send) : send('Fetch.failRequest',{requestId:event.requestId,errorReason:'InternetDisconnected'}));
  await browser.send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
  await cloud.settings({mdblist_key:'fictional-scores',imdb_source:'omdb'});
  await linkFixture(browser,origin,'/');
  const size=24, plays=size*54;
  await browser.evaluate('('+seedRatedLibrary.toString()+')({showCount:'+size+'})');
  await browser.navigate(origin+'/#/settings');
  const synced='document.querySelector("[data-cloud-reason]")?.textContent === "Synced"';
  await browser.waitFor(synced);
  const go=route=>browser.click('.app-sidebar a[href="#/'+route+'"]');
  const fullReport=total=>browser.waitFor(`document.querySelector('[data-stat=plays] dd')?.textContent === (${total}).toLocaleString() &&
    !!document.querySelector('[data-chart=cast]') && ['tmdb','tomatoes','metacritic','imdb','myanimelist'].every(key=>
    document.querySelector('[data-chart='+key+'] .stats-dots path')?.getAttribute('d')?.split('M').length - 1 === ${size})`);
  await go('statistics');
  await fullReport(plays);
  await browser.evaluate(`(async()=>{
    const {DeviceStore}=await import('/storage.js');
    window.savedChart=document.querySelector('[data-chart=tmdb]');
    window.reportReads=0;
    const original=DeviceStore.prototype.overviewRows;
    DeviceStore.prototype.overviewRows=function(...args){
      if(args[0]==='statistics')window.reportReads++;
      return original.apply(this,args);
    };
  })()`);
  await go('library');
  const sort='select[aria-label="Sort"]';
  await browser.waitFor('document.querySelector(".library-selects option[value=rating]")');
  await browser.evaluate(`const sort=document.querySelector(${JSON.stringify(sort)}); sort.value='rating'; sort.dispatchEvent(new Event('change',{bubbles:true}))`);
  await go('settings');
  const savedSort=()=>readCsv('settings',cloud.files.get('/settings.csv').bytes).rows.find(row=>row.setting==='library_sort')?.value;
  await until(()=>savedSort()==='rating','Library sort uploaded automatically',30000);
  await browser.waitFor(synced);
  await go('statistics');
  await fullReport(plays);
  assert.equal(await browser.evaluate('window.reportReads'),0,'Sync bookkeeping forced a fresh read of the watch record');
  assert.equal(await browser.evaluate("document.querySelector('[data-chart=tmdb]')===window.savedChart"),true,'The completed chart was discarded');

  const watched=readCsv('watched',cloud.files.get('/watched.csv').bytes).rows;
  watched[0].times_watched++;
  await cloud.upload('watched.csv',writeCsv('watched',watched));
  await go('settings');
  await browser.click('[data-sync]');
  await go('statistics');
  await fullReport(plays+1);
  assert.ok(await browser.evaluate('window.reportReads > 0'),'A new watch must refresh the report');
});
