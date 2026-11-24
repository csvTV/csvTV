import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readCredits } from './settings-credits.mjs';
import { openChromium } from './offline-chromium.mjs';
import { linkFixture, offlineProviders } from './offline-providers.mjs';
import { listen, stop, testSite } from './offline-site.mjs';

async function seed() {
  const {openDeviceStore} = await import('/tracker/storage.js');
  const store = await openDeviceStore();
  try {
    const {revision} = await store.whenWriter();
    await store.commit(revision, {put:{
      watched:[{show_id:11, show:'Island Radio', season:1, episode:1, episode_id:1101, title:'Up early', times_watched:1}],
      lists:[{show_id:22, show:'North Garden', list:'Watchlist'}],
      ratings:[{show_id:33, show:'Twin Planet', rating:0}],
    }});
  } finally { await store.closeForUpdate(); }
}

test('Optional critic scores in Settings and the background detail job', {timeout:60000}, async t => {
  const {server} = await testSite();
  const origin = 'http://127.0.0.1:' + await listen(server);
  const profile = await mkdtemp(join(tmpdir(), 'csvtv-mdblist-settings-'));
  const calls = [];
  let browser;
  t.after(async () => {
    try { await browser?.close(); }
    finally { await stop(server); await rm(profile, {recursive:true, force:true, maxRetries:6, retryDelay:150}); }
  });
  const providers = offlineProviders(origin);
  browser = await openChromium(profile, async (message, send) => {
    const {requestId,request} = message;
    if (new URL(request.url).hostname.endsWith('.dropboxapi.com')) return providers.respond(message, send);
    const url = new URL(request.url);
    assert.equal(url.origin, 'https://api.mdblist.com');
    assert.equal(request.method, 'GET');
    const id = Number(url.pathname.match(/^\/tmdb\/show\/(\d+)$/)?.[1]);
    assert.ok(Number.isInteger(id));
    const key = url.searchParams.get('apikey');
    calls.push({key,id});
    const denied = key === 'fictional-refused';
    const result = denied ? {error:'Invalid API key'} : {ids:{tmdb:id}, type:'show', ratings:[{source:'tomatoes',value:0}]};
    await send('Fetch.fulfillRequest', {requestId, responseCode:denied ? 401 : 200,
      responseHeaders:[{name:'Content-Type',value:'application/json'}, {name:'Access-Control-Allow-Origin',value:origin}],
      body:Buffer.from(JSON.stringify(result)).toString('base64')});
  });
  await linkFixture(browser, origin);
  const goSettings = () => browser.navigate(origin + '/tracker/#/settings');
  const edit = () => browser.click('[data-mdblist-edit]');
  const submit = () => browser.click('dialog[open] [type=submit]');
  const type = value => browser.evaluate('document.querySelector("#mdblist-input").value = ' + JSON.stringify(value));
  const shown = () => browser.evaluate('document.body.innerText');
  await browser.send('Emulation.setDeviceMetricsOverride', {width:320, height:720, deviceScaleFactor:1,mobile:false});
  await browser.navigate(origin + '/fixture');
  await browser.evaluate('(' + seed.toString() + ')()');
  await goSettings();
  await t.test('Settings offers help and a blank masked field at phone width, without requesting scores before opt-in', async () => {
    await browser.waitFor('document.querySelector("[data-mdblist-edit]")?.disabled === false');
    assert.equal(calls.length, 0);
    assert.equal(await browser.evaluate('document.querySelector("[data-mdblist-credit]").hidden'), true);
    await browser.click('[data-mdblist-help]');
    assert.deepEqual(await browser.evaluate('[...document.querySelectorAll("dialog[open] li a")].map(a=>a.href)'),
      ['https://mdblist.com/signin','https://mdblist.com/preferences/']);
    assert.equal(await browser.evaluate('document.querySelector("dialog[open] .actions a").href'), 'https://mdblist.com/signin');
    assert.ok((await shown()).includes('Rotten Tomatoes, Metacritic and MyAnimeList scores'));
    assert.ok(await browser.evaluate('document.querySelector("dialog[open]").scrollWidth <= document.querySelector("dialog[open]").clientWidth'));
    await browser.press('Escape');
    assert.ok(await browser.evaluate('document.activeElement.matches("[data-mdblist-help]")'));
    await edit();
    assert.ok(await browser.evaluate('document.activeElement.matches("#mdblist-input[type=password]") && !document.activeElement.value'));
    await type('fictional-refused');
    await submit();
  });
  await t.test('A refused first use pauses the whole record, displays a safe message, and a new key fills scores without a TMDB key', async () => {
    await browser.waitFor('document.querySelector("[data-mdblist-status]")?.textContent.includes("Invalid API key")');
    assert.equal(calls.filter(x => x.key === 'fictional-refused').length, 1);
    const credits = await readCredits(browser);
    assert.ok(credits.includes('Critic scores and MyAnimeList scores come from MDBList.'));
    assert.ok(credits.includes('not affiliated with Rotten Tomatoes, Metacritic or MyAnimeList.'));
    assert.ok(!(await shown()).includes('fictional-refused'));
    await edit();
    assert.equal(await browser.evaluate('document.querySelector("#mdblist-input").value'), '');
    await type('fictional-replacement');
    await submit();
    await browser.waitFor('document.querySelector("[data-mdblist-status]")?.textContent === "Saved in Dropbox"');
    await browser.waitFor(`(async () => {
      const {openDeviceStore} = await import('/tracker/storage.js');
      const reader = await openDeviceStore();
      try { return (await reader.mdbListState([11,22,33])).entries.size === 3; }
      finally { reader.close(); }
    })()`, 'all three record sources in the cache');
    assert.deepEqual(calls.filter(x => x.key === 'fictional-replacement').map(x => x.id).sort(), [11,22,33]);
    assert.ok(!(await shown()).includes('fictional-replacement'));
    assert.ok(!(await browser.evaluate('location.href')).includes('fictional'));
  });
  await t.test('The saved key is masked after reopening, Cancel keeps it, and confirmed removal clears cached critic scores', async () => {
    await browser.navigate(origin + '/fixture');
    await goSettings();
    await edit();
    assert.equal(await browser.evaluate('document.querySelector("#mdblist-input").value'), '');
    await submit();
    await browser.click('dialog[open] [data-cancel]');
    assert.equal(await browser.evaluate('document.querySelector("[data-mdblist-credit]").hidden'), false);
    await edit();
    await submit();
    await browser.click('dialog[open] [data-remove]');
    await browser.waitFor('document.querySelector("[data-mdblist-credit]")?.hidden && document.querySelector("[data-mdblist-edit]")?.textContent === "Add key"');
    await browser.navigate(origin + '/fixture');
    assert.deepEqual(await browser.evaluate(`(async () => {
      const {openDeviceStore} = await import('/tracker/storage.js');
      const store = await openDeviceStore();
      try {
        const {key,entries} = await store.mdbListState([11,22,33]);
        return [key === null, entries.size, (await store.snapshot()).tables.watched.length];
      } finally { store.close(); }
    })()`), [true,0,1]);
    assert.equal(calls.length, 4);
  });
  await t.test('Credits identifies the selected GitHub job when the synced preference exists without an MDBList key', async () => {
    await browser.evaluate(`(async () => {
      const {openDeviceStore} = await import('/tracker/storage.js');
      const store = await openDeviceStore();
      try {
        const {revision} = await store.whenWriter();
        await store.commit(revision, {put:{settings:[{setting:'mal_source',value:'github'}]}});
      } finally { await store.closeForUpdate(); }
    })()`);
    await goSettings();
    await browser.waitFor('!document.querySelector("[data-mdblist-credit]")?.hidden && document.querySelector("[data-mdblist-credit]")?.textContent.includes("GitHub job")');
    const credits = await readCredits(browser);
    assert.ok(credits.includes('MyAnimeList’s API. csvTV is not affiliated with MyAnimeList.'));
    assert.ok(!credits.includes('scores come from MDBList.'));
    assert.equal(calls.length, 4);
  });
});
