import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openChromium, until } from './offline-chromium.mjs';
import { linkFixture, offlineProviders } from './offline-providers.mjs';
import { listen, stop, testSite } from './offline-site.mjs';

test('Search and Show display available critic and MyAnimeList scores on the phone and after reopening offline', {timeout:65000}, async t => {
  const {server} = await testSite();
  const origin = 'http://127.0.0.1:' + await listen(server);
  const providers = offlineProviders(origin);
  const profile = await mkdtemp(join(tmpdir(), 'csvtv-critic-screens-'));
  const ids = [];
  const pending = Promise.withResolvers();
  let browser;
  t.after(async () => {
    pending.resolve();
    try { await browser?.close(); }
    finally { await stop(server); await rm(profile, {recursive:true, force:true, maxRetries:6, retryDelay:150}); }
  });
  async function intercept(message, send) {
    const {request, requestId} = message;
    const url = new URL(request.url);
    let body;
    if (url.hostname === 'api.themoviedb.org' && url.pathname === '/3/search/tv' && request.method === 'GET') {
      body = {page:1, total_pages:1, results:[
        {id:45, name:'The Listening House', first_air_date:'2019-10-01'},
        {id:46, name:'The Listening Shore', first_air_date:'2020-03-09'},
        {id:47, name:'The Listening Hill', first_air_date:'2021-03-09'},
      ]};
    } else if (url.hostname === 'api.mdblist.com') {
      assert.equal(request.method, 'GET');
      assert.equal(url.searchParams.get('apikey'), 'fictional-score-key');
      const id = Number(url.pathname.match(/^\/tmdb\/show\/(45|46|47)$/)?.[1]);
      assert.ok(id, 'Unexpected critic lookup');
      ids.push(id);
      await pending.promise;
      body = {ids:{tmdb:id}, mediatype:'show', ratings:[
        {source:'tomatoes', value:id === 45 ? 60 : null}, {source:'metacritic', value:id === 45 ? 39 : null},
        {source:'myanimelist', value:id === 45 ? 8 : id === 46 ? 7.3 : null},
      ]};
    } else {
      await providers.respond(message, send);
      return;
    }
    await send('Fetch.fulfillRequest', {requestId, responseCode:200,
      responseHeaders:[{name:'Content-Type',value:'application/json'},{name:'Access-Control-Allow-Origin',value:origin}],
      body:Buffer.from(JSON.stringify(body)).toString('base64')});
  }
  browser = await openChromium(profile, intercept);
  await browser.send('Emulation.setDeviceMetricsOverride', {width:320, height:720, deviceScaleFactor:1, mobile:false});
  const search = origin + '/tracker/#/search?q=listening';
  const show = origin + '/tracker/#/show/45';
  await providers.settings({tmdb_key:'fictional-offline-key'});
  await linkFixture(browser, origin);
  await browser.navigate(search);
  await browser.waitFor('document.querySelectorAll(".tv-results li").length === 3', 'searchable titles with no MDBList key');
  assert.deepEqual(ids, []);
  assert.equal(await browser.evaluate('document.querySelector(".outside-scores") === null'), true);
  await browser.navigate(origin + '/tracker/#/settings');
  await browser.click('[data-mdblist-edit]');
  await browser.waitFor('document.querySelector("#mdblist-input")');
  await browser.evaluate('document.querySelector("#mdblist-input").value = "fictional-score-key"');
  await browser.click('dialog button[type=submit]');
  await browser.waitFor('!document.querySelector("dialog[open]") && !document.querySelector("[data-mdblist-credit]").hidden');
  await browser.navigate(search);
  await until(() => ids.length, 'first critic lookup');
  assert.equal(await browser.evaluate('document.querySelectorAll(".tv-results li").length'), 3);
  pending.resolve();
  await browser.waitFor('document.querySelector(\'[data-show="45"] .critic-marks\')?.textContent === "60%39"');
  await browser.waitFor('document.querySelector(\'[data-show="46"] .myanimelist-score\')?.textContent === "7.3"');
  await until(() => ids.length === 3, 'all three show lookups');
  assert.equal(await browser.evaluate('document.querySelector(\'[data-show="45"] .myanimelist-score\').textContent'), '8.0');
  assert.deepEqual(await browser.evaluate(`(() => {
    const mark=document.querySelector('[data-show="45"] .myanimelist-score');
    return [mark.title,getComputedStyle(mark).color,getComputedStyle(mark).backgroundColor];
  })()`), ['MyAnimeList 8.0/10','rgb(255, 255, 255)','rgb(65, 105, 200)']);
  assert.equal(await browser.evaluate('document.querySelector(\'[data-show="46"] .critic-marks\') === null'), true);
  assert.equal(await browser.evaluate('document.querySelector(\'[data-show="47"] .outside-scores\') === null'), true);
  assert.ok(await browser.evaluate('document.documentElement.scrollWidth <= innerWidth'));
  // Activate the selected result using the keyboard; no screen or service is mounted by the test.
  await browser.evaluate('document.querySelector(\'[data-show="45"] a\').focus()');
  await browser.press('Enter');
  await browser.waitFor('location.hash === "#/show/45" && document.querySelector(".show-labels .critic-marks")?.textContent === "60%39"');
  assert.ok(await browser.evaluate('!document.querySelector(".show-page .myanimelist-score") && document.documentElement.scrollWidth <= innerWidth'));
  assert.deepEqual(ids, [45, 46, 47]);
  await browser.navigate(origin + '/tracker/#/settings');
  await browser.waitFor('document.querySelector("[data-offline-status]")?.textContent.includes("Ready to open offline")');
  await browser.close(); browser = null;
  browser = await openChromium(profile, intercept);
  await browser.offline(true);
  await browser.navigate(show);
  await browser.waitFor('document.querySelector(".show-title-block h1")?.textContent === "The Listening House" && ' +
    'document.querySelector(".show-labels .critic-marks")?.textContent === "60%39" && ' +
    '!document.querySelector(".show-labels .myanimelist-score")', 'cached Show scores after offline restart');
  assert.deepEqual(ids, [45, 46, 47]);
});
