import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {createRelease} from '../package-release.mjs';
import {openChromium, until} from './offline-chromium.mjs';
import {linkFixture, offlineProviders} from './offline-providers.mjs';
import {listen, stop} from './offline-site.mjs';
import {releaseServer, unpack} from './release-site.mjs';

import {seedRatedLibrary} from './populated-navigation-fixture.mjs';

// Include style/layout and a frame with the completed charts, including all score dots.
async function paintedVisit(action, scope = 'all', removedRatings = 0) {
  const marks = scope === 'all' ? 300 : scope === 'anime' ? 100 : 200;
  const frame = () => new Promise(done=>requestAnimationFrame(done));
  function dots(chart) {
    const path = chart?.querySelector('.stats-dots path');
    return path ? path.getAttribute('d').split('M').length-1 : chart?.querySelectorAll('circle').length || 0;
  }
  const started = performance.now();
  let personalMs;
  window.statisticsReadCount = 0;
  if (action === 'back') history.back();
  else if (action === 'nav') document.querySelector('.app-sidebar [data-destination=statistics]').click();
  else document.querySelector('.stats-scope input[value='+scope+']').click();
  while (performance.now()-started<15000) {
    await frame();
    const count = document.querySelector('[data-stat=shows] dd')?.textContent;
    if (count === String(marks)) personalMs ??= Math.round(performance.now()-started);
    const chart = document.querySelector('[data-chart=myanimelist]');
    if (count !== String(marks) ||
        dots(chart) !== marks-removedRatings || dots(document.querySelector('[data-chart=imdb]')) !== marks-removedRatings ||
        !document.querySelector('[data-chart=cast]') ||
        !chart.getBoundingClientRect().height) continue;
    await frame();
    const dot = chart.querySelector('.stats-dots path, .stats-dots circle');
    const reused = dot === window.previousStatisticsDot;
    window.previousStatisticsDot = dot;
    return {ms:Math.round(performance.now()-started),personalMs,cacheReads:window.statisticsReadCount,reused};
  }
  throw Error('Stats did not paint '+scope+'; totals '+document.querySelector('[data-stat=shows] dd')?.textContent+
    ', dots '+dots(document.querySelector('[data-chart=myanimelist]')));
}

test('Packaged Statistics returns to painted provider charts through the sidebar and browser Back', {timeout:120000}, async t => {
  const comparisonArchive = process.env.CSVTV_STATS_COMPARISON_ZIP;
  const bytes = comparisonArchive ? await readFile(comparisonArchive) : (await createRelease(new URL('../dist/',import.meta.url))).bytes;
  const server = releaseServer(await unpack(bytes));
  const origin = 'http://127.0.0.1:'+await listen(server);
  const profile = await mkdtemp(join(tmpdir(),'csvtv-painted-statistics-'));
  const cloud = offlineProviders(origin);
  let browser;
  t.after(async () => {
    try { await browser?.close(); }
    finally { await stop(server); await rm(profile,{recursive:true,force:true,maxRetries:8,retryDelay:150}); }
  });
  browser = await openChromium(profile, (request,send) => new URL(request.request.url).hostname.endsWith('.dropboxapi.com')
    ? cloud.respond(request,send) : send('Fetch.failRequest',{requestId:request.requestId,errorReason:'InternetDisconnected'}));
  await browser.send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
  await linkFixture(browser,origin,'/');
  await cloud.settings({mdblist_key:'fictional-scores',imdb_source:'omdb'});
  await browser.evaluate('('+seedRatedLibrary+')()');
  await browser.navigate(origin+'/#/settings');
  const synced = 'document.querySelector(".sync-state")?.dataset.synced === "true"';
  // A saved scope waits through the ten-second sync debounce before Dropbox work starts.
  const waitForSync = () => until(() => browser.evaluate(synced), 'saved Statistics scope synced', 45_000);
  await browser.waitFor(synced+' && navigator.serviceWorker.controller','synced, controlled release');
  await browser.evaluate(`(() => {
    const get = IDBObjectStore.prototype.get;
    const getAll = IDBObjectStore.prototype.getAll;
    IDBObjectStore.prototype.get = function(key) {
      if (this.name === 'cache' || this.name === 'tmdb') window.statisticsReadCount++;
      return get.call(this,key);
    };
    IDBObjectStore.prototype.getAll = function(...args) {
      const request = getAll.apply(this,args);
      if (this.name === 'cache' || this.name === 'tmdb')
        request.addEventListener('success',()=>{ window.statisticsReadCount += request.result.length; });
      return request;
    };
  })()`);
  await browser.send('Emulation.setCPUThrottlingRate',{rate:4});
  const open = (action,scope='all',removed=0) => browser.evaluate('('+paintedVisit+')(...'+JSON.stringify([action,scope,removed])+')');
  const first = await open('nav');
  await waitForSync();
  const visits = [];
  for (const path of ['nav','back','nav','back','nav']) {
    await browser.click('.app-sidebar [data-destination=settings]');
    await browser.waitFor('location.hash === "#/settings" && document.querySelector(".appearance-options")');
    visits.push(await open(path));
  }
  const tabs = [];
  for (const scope of ['tv','anime','all','tv','all']) {
    tabs.push(await open('scope',scope));
    await waitForSync();
  }
  await browser.click('.app-sidebar [data-destination=settings]');
  const afterFiltering = await open('nav');
  t.diagnostic('Click to painted charts (ms), first '+first.ms+' (personal totals '+first.personalMs+'); returns '+visits.map(v=>v.ms).join(', ')+
    '; TV/Anime/All/TV/All '+tabs.map(v=>v.ms).join(', ')+'; after scope changes '+afterFiltering.ms+
    '. TMDB/score keyed reads on returns '+visits.map(v=>v.cacheReads).join(', ')+'.');
  if (!comparisonArchive) {
    const plotCounts = () => browser.evaluate(`[...document.querySelectorAll('.stats-dots path')].map(p=>p.getAttribute('d').split('M').length-1)`);
    assert.deepEqual(await plotCounts(),Array(5).fill(300));
    assert.ok(visits.slice(1).every(v=>v.reused && v.cacheReads<10),JSON.stringify(visits));
    assert.ok(afterFiltering.reused && afterFiltering.cacheReads<10,JSON.stringify(afterFiltering));
    await browser.click('.app-sidebar [data-destination=ratings]');
    const rating = 'select[aria-label="Rating for Signal Station 1 out of 10"]';
    await browser.waitFor('document.querySelector('+JSON.stringify(rating)+')?.disabled === false');
    const selected = await browser.evaluate(`(() => {
      const select = document.querySelector(${JSON.stringify(rating)});
      select.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));
      select.focus(); select.value = 'remove'; select.dispatchEvent(new Event('change',{bubbles:true}));
      return [select.value,select.options.length];
    })()`);
    assert.deepEqual(selected,['remove',22]);
    try { await browser.waitFor('!document.querySelector('+JSON.stringify(rating)+')'); }
    catch(error) {
      const reason = await browser.evaluate(`({dialog:document.querySelector('dialog[open]')?.innerText,
        notice:document.querySelector('.notices')?.innerText,score:document.querySelector(${JSON.stringify(rating)})?.value})`);
      throw Error(error.message+' '+JSON.stringify(reason),{cause:error});
    }
    const changed = await open('back','all',1);
    assert.ok(!changed.reused && changed.cacheReads>=300,'A changed rating must refresh the linked charts');
    assert.deepEqual(await plotCounts(),Array(5).fill(299));
  }
});
