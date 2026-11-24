import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openChromium, until } from './offline-chromium.mjs';
import { readCsv } from '../src/csv.ts';
import { linkFixture, offlineProviders } from './offline-providers.mjs';
import { testSite, listen, stop } from './offline-site.mjs';

test('Import a local AniList file through the file picker and reopen the resulting Anime statistics offline', {timeout:60000}, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'csvtv-anilist-import-'));
  const file = join(directory, 'gdpr_data.json'), profile = join(directory, 'browser');
  const {server} = await testSite();
  const origin = 'http://127.0.0.1:' + await listen(server);
  const providers = offlineProviders(origin), localRequests = [];
  server.on('request', req => localRequests.push([req.method, req.url]));
  let browser, downloads = 0;
  t.after(async () => {
    try { await browser?.close(); }
    finally { await stop(server); await rm(directory, {recursive:true, force:true, maxRetries:6, retryDelay:150}); }
  });
  const privateText = 'fictional-private-profile-note';
  const first = {series_type:0, series_id:9001, status:2, score:75, progress:2, repeat:1};
  await writeFile(file, JSON.stringify({lists:[first, {...first, series_id:9002, score:80, progress:1, repeat:2}, {series_id:9003}],
    favourites:[{favourite_id:9001, favourite_type:1}], user:{name:privateText}, reviews:[{text:privateText}]}));
  async function intercept(message, send) {
    const {request, requestId} = message, url = new URL(request.url);
    const headers = new Headers(request.headers);
    assert.ok(!JSON.stringify(request).includes(privateText));
    if (url.hostname.endsWith('.dropboxapi.com')) return providers.respond(message, send);
    if (url.hostname === 'api.themoviedb.org') {
      assert.ok(!request.url.includes('9001') && !request.url.includes('9002'));
      return providers.respond(message, send);
    }
    assert.equal(request.url, 'https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-mini.json');
    assert.equal(request.method, 'GET');
    assert.ok(!request.postData && !headers.has('Authorization') && !headers.has('Cookie') && !headers.has('Referer'));
    downloads++;
    const data = [9001,9002].map((id, offset) => ({anilist_id:id, themoviedb_id:{tv:45}, season:{tmdb:1}, episode_offset:{tmdb:offset}}));
    await send('Fetch.fulfillRequest', {requestId, responseCode:200, responseHeaders:[
      {name:'Content-Type',value:'text/plain'}, {name:'Access-Control-Allow-Origin',value:'*'},
    ], body:Buffer.from(JSON.stringify(data)).toString('base64')});
  }
  browser = await openChromium(profile, intercept);
  await providers.settings({tmdb_key:'fictional-offline-key'});
  await linkFixture(browser, origin);
  const route = hash => browser.navigate(origin + '/tracker/#/' + hash);
  async function animeLibrary() {
    await route('library');
    await browser.click('[data-category=anime]');
    await browser.waitFor('document.querySelector("[data-category=anime]")?.getAttribute("aria-pressed")==="true" && document.querySelector(".library-grid strong")?.textContent === "The Listening House"');
    assert.equal(await browser.evaluate('document.querySelector(\'[data-filter=list] option[value="=Anime"]\')!==null'),false);
    await route('lists');
    await browser.waitFor('document.querySelector("#chosen-list")?.textContent');
    assert.equal(await browser.evaluate('!!document.querySelector(\'[data-list-focus="chip/Anime"]\')'),false);
  }
  await route('settings');
  await browser.click('a[href="#/anilist-import"]');
  const selector = '.anilist-import input[type=file]:not(:disabled)';
  await browser.waitFor('document.querySelector(' + JSON.stringify(selector) + ')');
  const {root} = await browser.send('DOM.getDocument');
  const {nodeId} = await browser.send('DOM.querySelector', {nodeId:root.nodeId, selector});
  await browser.send('DOM.setFileInputFiles', {nodeId, files:[file]});
  await browser.waitFor('document.querySelector(".import-totals") && !document.querySelector("[data-apply]").disabled');
  assert.equal(downloads, 1);
  await browser.click('[data-count-review="45"] [data-count-summary]');
  const preview = await browser.evaluate('document.querySelector("[data-preview]").textContent');
  assert.match(preview,/List entry 3 contains an invalid type/);
  assert.ok(preview.includes('3×') && preview.includes('8/10') && !preview.includes(privateText), 'Overlap and rounded score in preview');
  await browser.click('[data-apply]');
  await browser.waitFor('document.querySelector("[data-status]")?.textContent.includes("Import complete")');
  await animeLibrary();
  await route('settings');
  await browser.click('[data-sync]');
  await until(()=>providers.files.has('/lists.csv') && readCsv('lists',providers.files.get('/lists.csv').bytes).rows
    .some(row=>row.list==='Anime' && row.show_id===45),'Anime classification in fictional Dropbox');
  await browser.waitFor('document.querySelector("[data-offline-status]")?.textContent.includes("Ready to open offline")');
  await browser.close(); browser = undefined;
  browser = await openChromium(profile, intercept);
  await browser.offline(true);
  await route('statistics');
  await browser.click('.stats-scope input[value=anime]');
  await browser.waitFor('document.querySelector("[data-stat=plays] dd")?.textContent === "5" && document.querySelector(".stats-scope input:checked")?.value === "anime"');
  assert.equal(await browser.evaluate('document.querySelector("[data-stat=episodes] dd").textContent'), '2');
  await animeLibrary();
  await browser.close(); browser = undefined;
  browser = await openChromium(join(directory,'fresh-browser'),intercept);
  await linkFixture(browser,origin);
  await route('settings');
  await browser.waitFor('document.querySelector(".sync-state")?.dataset.synced==="true"');
  await animeLibrary();
  assert.equal(downloads, 1);
  assert.ok(localRequests.every(([method, path]) => method === 'GET' && !path.includes(privateText)));
});
