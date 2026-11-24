import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openChromium } from './offline-chromium.mjs';
import { linkFixture, offlineProviders } from './offline-providers.mjs';
import { listen, stop, testSite } from './offline-site.mjs';

async function prepareRecord(withPremiere = false) {
  const { openDeviceStore } = await import('/tracker/storage.js');
  const { tmdbResourceKey } = await import('/tracker/tmdb-client.js');
  const store = await openDeviceStore();
  try {
    const { revision } = await store.whenWriter();
    const titles = ['Glass Orchard', 'Cloud Crossing', 'Winter Coda'];
    const watched = titles.map((show, i) => ({ show_id: i + 1, show, season: 1, episode: 1,
      episode_id: 11 + i, title: 'Opening', times_watched: [2, 3, 1][i] }));
    const {session} = await store.dropboxState();
    store.connectProviderKeys(async () => { throw Error('Unexpected write while seeding cached scores'); },Date.now);
    await store.loadProviderKeys(session, [{setting:'tmdb_key',value:'fictional-tmdb'},{setting:'mdblist_key',value:'fictional-scores'}], () => true);
    await store.commit((await store.snapshot()).revision, { put: { watched, lists: [
      {list:'aNiMe',show_id:1,show:titles[0]}, {list:'Evenings',show_id:1,show:titles[0]}],
      ratings: titles.map((show, i) => ({ show_id: i + 1, show, rating: [7.5, 9, 0][i] })) } });
    const fetchedAt = Date.now(), entries = {}, scores = new Map();
    for (const [i, show] of titles.entries()) {
      const id = i + 1;
      entries[tmdbResourceKey({ kind: 'show', id })] = { fetchedAt, value: { show_id: id, show, status: 'Ended',
        firstAirDate: '2014-01-03', genres: [], networks: [], originCountries: [], voteAverage: 8.25, posterPath: null,
        seasons: [{ season: 1, episodeCount: 1 }], lastAired: { season: 1, episode: 1 }, nextAirDate: null,
        keywords: id === 2 ? [{ id: 9, name: 'anime' }] : [] } };
      entries[tmdbResourceKey({ kind: 'season', id, season: 1 })] = { fetchedAt, value: { show_id: id, season: 1,
        episodes: [{ episode: 1, episode_id: 11 + i, runtime: [30, 12, 42][i], airDate: '2014-01-03' }] } };
      scores.set(id, { fetchedAt, scores: { tomatoes: 90+i, metacritic: null, myanimelist: [8, null, 9.1][i] } });
    }
    if (withPremiere) {
      const {localCalendarDate} = await import('/tracker/progress.js');
      const next = new Date(fetchedAt);
      next.setDate(next.getDate()+1);
      const airDate = localCalendarDate(next);
      const show = entries[tmdbResourceKey({kind:'show',id:1})].value;
      show.status = 'Returning Series'; show.seasons[0].episodeCount = 2;
      show.nextAirDate = airDate; show.nextEpisode = {season:1,episode:2,airDate};
      entries[tmdbResourceKey({kind:'season',id:1,season:1})].value.episodes.push({episode:2,episode_id:14,runtime:30,airDate});
    }
    await store.writeTmdb((await store.tmdbState()).generation, { entries });
    await store.writeMdbList((await store.mdbListState()).generation, { entries: scores });
  } finally { await store.closeForUpdate(); }
}

test('an installed Statistics table follows a change of local date while offline in both travel directions', {timeout:60000}, async t => {
  const {server} = await testSite(), origin = 'http://127.0.0.1:'+await listen(server);
  const profile = await mkdtemp(join(tmpdir(),'csvtv-calendar-'));
  let browser;
  t.after(async () => {
    try { await browser?.close(); } finally { await stop(server); await rm(profile,{recursive:true,force:true,maxRetries:6,retryDelay:150}); }
  });
  const provider = offlineProviders(origin);
  browser = await openChromium(profile,provider.respond);
  const zone = timezoneId => browser.send('Emulation.setTimezoneOverride',{timezoneId});
  await zone('Etc/GMT+12');
  await linkFixture(browser,origin);
  await browser.evaluate('('+prepareRecord+')(true)');
  await browser.navigate(origin+'/tracker/#/settings');
  await browser.waitFor('document.querySelector("[data-offline-status]")?.textContent==="Ready to open offline."');
  await browser.offline(true);
  await browser.click('a[href="#/statistics"]');
  async function completeCount(value) {
    await browser.waitFor('document.querySelector("dialog[open] tbody tr:last-child td")?.textContent==='+JSON.stringify(String(value)),'shows with 100% watched');
  }
  await browser.click('[data-table=progress]');
  await completeCount(3);
  await zone('Pacific/Kiritimati');
  // Return from operating-system settings with the Statistics table still open.
  await browser.evaluate('window.dispatchEvent(new Event("focus"));true');
  await completeCount(2);
  await browser.press('Escape');
  await browser.click('a[href="#/settings"]');
  await zone('Etc/GMT+12');
  await browser.click('a[href="#/statistics"]');
  await browser.click('[data-table=progress]');
  await completeCount(3);
});

test('Statistics switches with arrow keys and keeps the imported Anime classification through an offline restart and custom list rename', { timeout: 65000 }, async t => {
  const { server } = await testSite();
  const origin = 'http://127.0.0.1:' + await listen(server);
  const profile = await mkdtemp(join(tmpdir(), 'csvtv-stats-scope-'));
  const providers = offlineProviders(origin);
  const noProvider = (message, send) => {
    if (new URL(message.request.url).hostname.endsWith('.dropboxapi.com')) return providers.respond(message, send);
    throw Error('Cached Statistics requested an external service');
  };
  let browser;
  t.after(async () => {
    try { await browser?.close(); }
    finally { await stop(server); await rm(profile, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 }); }
  });
  const stats = origin + '/tracker/#/statistics';
  const viewport = width => browser.send('Emulation.setDeviceMetricsOverride', { width, height: 760, deviceScaleFactor: 1, mobile: false });
  async function ready(stage, scope, totals) {
    try {
      await browser.waitFor(`
        document.querySelector('.stats-scope input:checked')?.value === ${JSON.stringify(scope)} &&
        !document.querySelector('.stats-scope input').disabled &&
        Array.from(document.querySelectorAll('[data-stat] dd:first-of-type'), el => el.textContent).join() === ${JSON.stringify(totals)}
      `, stage + ' · Statistics totals for ' + scope + ': ' + totals);
    } catch (error) {
      const state = await browser.evaluate(`({
        title: document.title, route: location.hash, online: navigator.onLine, worker: navigator.serviceWorker.controller?.state,
        selected: document.querySelector('.stats-scope input:checked')?.value,
        disabled: document.querySelector('.stats-scope input:checked')?.disabled,
        totals: Array.from(document.querySelectorAll('[data-stat] dd:first-of-type'), el => el.textContent),
        status: document.querySelector('.tab-state')?.textContent || document.body.innerText.slice(0, 160)
      })`).catch(failed => ({ diagnosticError: failed.message }));
      throw Error(error.message + ' · ' + JSON.stringify(state), { cause: error });
    }
  }
  const table = '[data-chart="myanimelist"] table';
  const rows = () => browser.evaluate(`Array.from(document.querySelectorAll('${table} tbody tr'), row =>
    Array.from(row.cells, cell => cell.textContent))`);
  browser = await openChromium(profile, noProvider);
  await viewport(320);
  await linkFixture(browser, origin);
  await providers.settings({mdblist_key:'fictional-scores'});
  await browser.evaluate('(' + prepareRecord.toString() + ')()');
  await browser.navigate(stats);
  await ready('First opening', 'all', '3,3,3,6,2.3');
  // Personal totals are available before the first Dropbox settings read. Wait
  // for that read to finish invalidating/reloading optional provider scores.
  await browser.waitFor('document.querySelector(".sync-state")?.dataset.synced === "true" && document.querySelector("[data-table=tomatoes]")');
  assert.ok(await browser.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'The phone page overflows horizontally');
  const phoneHeader = await browser.evaluate(`[document.querySelector('.stats-scope').getBoundingClientRect().top,
    document.querySelector('.phone-title').getBoundingClientRect().bottom]`);
  assert.ok(phoneHeader[0] >= phoneHeader[1], 'The phone group selector overlaps the title ' + phoneHeader);
  const summaryRows = () => browser.evaluate(`[...document.querySelectorAll('.stats-summary [data-stat]')]
    .map(tile => Math.round(tile.getBoundingClientRect().top))`);
  assert.equal((await summaryRows()).length,5,'The summary should contain five totals');
  assert.equal(new Set(await summaryRows()).size,3,'Five totals should use three rows at phone width');
  await viewport(1920);
  assert.equal(new Set(await summaryRows()).size,1,'Five totals should fit one row on a wide desktop');
  for (const width of [320,390,899,900,1000,1920]) {
    await viewport(width);
    const desktop = width >= 900;
    const hasRewatchesTable = await browser.evaluate('document.querySelector("[data-table=rewatches]").getClientRects().length > 0');
    assert.equal(hasRewatchesTable, desktop, 'Rewatches table control at ' + width + 'px');
    const hasRewatchesBar = await browser.evaluate('document.querySelector(".stats-rewatch progress").getClientRects().length > 0');
    assert.equal(hasRewatchesBar, desktop, 'Rewatches progress bar at ' + width + 'px');
    for (const id of [desktop ? 'rewatches' : 'progress','tomatoes']) {
      await browser.click('[data-table='+id+']');
      const layout = await browser.evaluate(`(() => {
        const dialog=document.querySelector('dialog[open]'), table=dialog.querySelector('table');
        const box=dialog.getBoundingClientRect();
        return {fits:box.left >= 0 && box.right <= innerWidth+1 && box.top >= 0 && box.bottom <= innerHeight+1 &&
          [...table.querySelectorAll('thead button')].every(button => {
            const range = document.createRange(); range.selectNodeContents(button.firstChild); return range.getClientRects().length === 1;
          }), width:box.width, tile:dialog.closest('[data-chart]').getBoundingClientRect().width};
      })()`);
      assert.ok(layout.fits, 'Table exceeds viewport or wraps heading at '+width);
      if (width >= 1000) assert.ok(layout.width > layout.tile, 'Desktop table must open wider than its chart');
      if (id !== 'tomatoes') await browser.press('Escape');
      else {
        for (const type of ['mousePressed','mouseReleased'])
          await browser.send('Input.dispatchMouseEvent',{type,x:1,y:1,button:'left',clickCount:1});
      }
      await browser.waitFor('!document.querySelector("dialog[open]") && document.activeElement.dataset.table === '+JSON.stringify(id));
    }
  }
  await viewport(320);
  await browser.evaluate('document.querySelector(".stats-scope input:checked").focus()');
  await browser.press('ArrowRight');
  await ready('Keyboard selection', 'tv', '1,1,1,1,0.7');
  assert.equal(await browser.evaluate('document.activeElement.value'), 'tv');
  await browser.evaluate('document.querySelector("[data-table=myanimelist]").focus()');
  await browser.press('Enter');
  await browser.waitFor('document.querySelector(' + JSON.stringify(table) + ')');
  assert.deepEqual(await rows(), [['Winter Coda', '0', '9.1']]);
  await browser.click('dialog[open] .stats-table-heading button');
  await browser.evaluate('document.querySelector(".stats-scope input:checked").focus()');
  await browser.press('ArrowRight');
  await ready('Keyboard selection', 'anime', '2,2,2,5,1.6');
  await browser.click('[data-table=myanimelist]');
  assert.deepEqual(await rows(), [['Glass Orchard', '7.5', '8.0']]);
  await browser.press('Escape');
  const point = await browser.evaluate(`(() => {
    const chart = document.querySelector('[data-chart=myanimelist]'), dot = chart.querySelector('.stats-dots path').getPointAtLength(0);
    return [dot.x, dot.y, ...Array.from(chart.querySelectorAll('.stats-y-ticks span'), n => n.textContent)];
  })()`);
  assert.deepEqual(point, [75, 20, '10.0', '5.0', '0.0']);
  const ink = await browser.evaluate(`(async () => {
    const path = document.querySelector('[data-chart=myanimelist] .stats-dots path');
    path.closest('svg').scrollIntoView({block:'center'});
    await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));
    const p = path.getPointAtLength(0).matrixTransform(path.getScreenCTM());
    return {x:Math.round(p.x+scrollX),y:Math.round(p.y+scrollY),expected:getComputedStyle(path).stroke};
  })()`);
  const {data} = await browser.send('Page.captureScreenshot',{format:'png',clip:{x:ink.x,y:ink.y,width:1,height:1,scale:1}});
  const pixel = await browser.evaluate(`(async () => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(data)}),char=>char.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes],{type:'image/png'}));
    const context = new OffscreenCanvas(1,1).getContext('2d');
    context.drawImage(bitmap,0,0); bitmap.close();
    return 'rgb('+[...context.getImageData(0,0,1,1).data].slice(0,3).join(', ')+')';
  })()`);
  assert.equal(pixel,ink.expected,'The plotted score should paint in the accent colour at its expected coordinates');
  await browser.navigate(origin + '/tracker/#/settings');
  await browser.waitFor('document.querySelector("[data-offline-status]")?.textContent.includes("Ready to open offline")');
  await browser.close(); browser = undefined;
  await stop(server);
  browser = await openChromium(profile, noProvider);
  // A cold worker can service a navigation before its version reply reaches the page.
  // Delay delivery of the genuine replies during startup, keeping both the worker and the record unchanged.
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const post = ServiceWorker.prototype.postMessage;
    const open = IDBFactory.prototype.open;
    const probe = window.coldStartProbe = {requests:0, verified:false, openedEarly:false};
    IDBFactory.prototype.open = function(name, ...args) {
      if (name === 'csvTV' && !probe.verified) probe.openedEarly = true;
      return open.call(this, name, ...args);
    };
    let until = 0;
    ServiceWorker.prototype.postMessage = function(message, transfer) {
      if (message.type !== 'csvtv:version') return post.call(this, message, transfer);
      probe.requests++;
      until ||= performance.now() + 4500;
      const [destination] = transfer;
      const channel = new MessageChannel();
      channel.port1.onmessage = event => setTimeout(() => {
        probe.verified ||= event.data.build === document.querySelector('meta[name="csvtv-build"]').content;
        destination.postMessage(event.data); destination.close(); channel.port1.close();
      }, Math.max(0, until - performance.now()));
      return post.call(this, message, [channel.port2]);
    };
  })()` });
  await viewport(1100);
  await browser.offline(true);
  await browser.navigate(stats);
  await ready('Offline restart', 'anime', '2,2,2,5,1.6');
  const probe = await browser.evaluate('window.coldStartProbe');
  assert.ok(probe.requests >= 1 && probe.verified && !probe.openedEarly, 'The record opened before build verification');
  assert.equal(await browser.evaluate('navigator.onLine'), false);
  assert.ok(await browser.evaluate(`document.querySelector('.stats-scope').getBoundingClientRect().left >=
    document.querySelector('.statistics-screen h1').getBoundingClientRect().right`));
  await browser.navigate(origin + '/tracker/#/lists');
  await browser.click('[data-list-focus="chip/Evenings"]');
  assert.equal(await browser.evaluate('document.querySelector(\'[data-list-focus="chip/aNiMe"]\') !== null'),false);
  await browser.click('.list-more');
  await browser.click('.watch-sheet-action');
  await browser.waitFor('document.querySelector("dialog form input")');
  await browser.evaluate('document.querySelector("dialog form input").value = "Matinée"');
  await browser.click('dialog [type=submit]');
  await browser.click('dialog.remove-question [data-accept]');
  await browser.waitFor('document.querySelector("#chosen-list")?.textContent === "Matinée"');
  await browser.navigate(stats);
  await ready('After list rename', 'anime', '2,2,2,5,1.6');
  await browser.click('[data-table=myanimelist]');
  assert.deepEqual(await rows(), [['Glass Orchard', '7.5', '8.0']]);
  await browser.press('Escape');
  await browser.click('.stats-scope input[value=tv]');
  await ready('After list rename', 'tv', '1,1,1,1,0.7');
  await browser.click('[data-table=myanimelist]');
  assert.deepEqual(await rows(), [['Winter Coda', '0', '9.1']]);
  const legacy = await browser.evaluate(`(async () => {
    const {openDeviceStore}=await import('/tracker/storage.js'), store=await openDeviceStore();
    try { return (await store.personalRows()).lists.filter(r=>r.list.toLowerCase()==='anime'); }
    finally {store.close();}
  })()`);
  assert.deepEqual(legacy,[{list:'aNiMe',show_id:1,show:'Glass Orchard'}]);
});
