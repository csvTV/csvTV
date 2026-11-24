import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { releaseServer, unpack } from './release-site.mjs';
import { permissionsPolicy, securityPolicy } from '../hosting-policy.mjs';
import { createRelease } from '../package-release.mjs';
import { openChromium, until } from './offline-chromium.mjs';
import { linkFixture, offlineProviders } from './offline-providers.mjs';
import { listen, stop } from './offline-site.mjs';

test('The release ZIP opens online, requires Dropbox on first use and cold-opens a linked record for offline editing and export', {timeout:60000}, async t => {
  const {bytes, build} = await createRelease(new URL('../dist/', import.meta.url));
  const files = await unpack(bytes);
  const server = releaseServer(files);
  const directory = await mkdtemp(join(tmpdir(), 'csvtv-release-'));
  const profile = join(directory,'first-device');
  let browser;
  t.after(async () => {
    try { await browser?.close(); }
    finally { await stop(server); await rm(directory,{recursive:true, force:true, maxRetries:6, retryDelay:150}); }
  });
  const home = 'http://127.0.0.1:' + await listen(server) + '/';
  async function checkDevicePermissions() {
    const allowed = await browser.evaluate(`['camera','microphone','geolocation'].map(name =>
      (document.permissionsPolicy ?? document.featurePolicy).allowsFeature(name))`);
    assert.deepEqual(allowed,[false,false,false]);
  }
  const unexpectedProvider = async () => { throw Error('A new device unexpectedly contacted a provider'); };
  const origin = new URL(home).origin;
  const providers = offlineProviders(origin);
  const reply = await fetch(home);
  assert.equal(reply.status, 200);
  assert.equal(reply.headers.get('Content-Security-Policy'), securityPolicy);
  assert.equal(reply.headers.get('Permissions-Policy'), permissionsPolicy);
  assert.equal(reply.headers.get('Referrer-Policy'), 'no-referrer');
  assert.equal(reply.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.deepEqual(Buffer.from(await reply.arrayBuffer()), files.get('index.html'));
  for (const [name, type] of [['favicon.svg', 'image/svg+xml'], ['favicon-32.png', 'image/png'], ['apple-touch-icon.png', 'image/png']]) {
    assert.ok(files.has(name), 'Missing release asset ' + name);
    const icon = await fetch(new URL(name, home));
    assert.equal(icon.status, 200, name);
    assert.equal(icon.headers.get('Content-Type'), type, name);
    assert.deepEqual(Buffer.from(await icon.arrayBuffer()), files.get(name));
  }
  browser = await openChromium(profile, unexpectedProvider);
  const denied = await browser.send('Page.addScriptToEvaluateOnNewDocument', {source:`
    Object.defineProperty(navigator, 'serviceWorker', {get() { throw new DOMException('Blocked', 'SecurityError'); }});`});
  // This profile belongs to the fixture. Seed a future schema before the app first opens it.
  await browser.navigate(home + 'tmdb-logo.svg');
  await browser.evaluate(`new Promise((resolve,reject) => {
    const req = indexedDB.open('csvTV', 1000);
    req.onupgradeneeded = () => req.result.createObjectStore('future-record').put('preserved','watch');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => { req.result.close(); resolve(); };
  })`);
  await browser.navigate(home);
  const newerRequired = 'document.querySelector("#app [role=status]")?.textContent.includes("newer version")';
  await browser.waitFor(newerRequired);
  await checkDevicePermissions();
  await browser.offline(true);
  await browser.click('#app button');
  await browser.waitFor('document.querySelector("#app [role=status]")?.textContent.includes("Connect to the internet")');
  await browser.offline(false);
  const initialDocument = await browser.evaluate('performance.timeOrigin');
  await browser.click('#app button');
  await browser.waitFor(`performance.timeOrigin !== ${initialDocument} && ${newerRequired}`);
  await browser.click('#app button');
  await browser.waitFor('document.querySelector("#app [role=status]")?.textContent.includes("still cannot open this device")');
  await browser.navigate(home + 'tmdb-logo.svg');
  assert.equal(await browser.evaluate(`new Promise((resolve,reject) => {
    const req = indexedDB.open('csvTV');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result, read = db.transaction('future-record').objectStore('future-record').get('watch');
      read.onsuccess = () => { db.close(); resolve(read.result); };
      read.onerror = () => reject(read.error);
    };
  })`), 'preserved');
  await browser.evaluate(`new Promise((resolve,reject) => {
    const req = indexedDB.deleteDatabase('csvTV');
    req.onsuccess = () => resolve(); req.onerror = () => reject(req.error);
  })`);
  await browser.navigate(home);
  await browser.waitFor('document.querySelector("#app")?.dataset.page === "dropbox-setup"');
  await browser.waitFor('document.querySelector("[data-offline-status]")?.textContent.includes("unavailable in this browser")');
  await browser.send('Page.removeScriptToEvaluateOnNewDocument', {identifier:denied.identifier});
  await browser.navigate('about:blank');
  await browser.send('Page.addScriptToEvaluateOnNewDocument', {source:`
    for (const method of ['getItem', 'setItem']) {
      const original = Storage.prototype[method];
      Storage.prototype[method] = function (key, ...args) {
        if (!window.allowRegistrationSave && key === 'csvTV-public-dropbox-app-key') throw new DOMException('Blocked storage', 'SecurityError');
        return original.call(this, key, ...args);
      };
    }`});
  await browser.navigate(home);
  await browser.waitFor('document.querySelector("#app")?.dataset.page === "dropbox-setup"');
  await browser.waitFor('navigator.serviceWorker.controller && document.querySelector("[data-offline-status]")?.textContent === "Ready to open offline."');
  await browser.click('[data-edit-client]');
  await browser.evaluate(`const field = document.querySelector('input[name="appKey"]');
    field.value = 'FictionalRegistration'; field.form.requestSubmit();`);
  await browser.waitFor('document.querySelector("[data-dropbox-feedback]")?.textContent.includes("could not save the Dropbox public app key")');
  assert.equal(await browser.evaluate('document.activeElement === field && field.value === "FictionalRegistration" && !field.disabled'), true);
  assert.equal(await browser.evaluate('document.body.innerText.split("could not save the Dropbox public app key").length'), 2);
  await browser.evaluate('window.allowRegistrationSave = true; field.form.requestSubmit()');
  await browser.waitFor('document.querySelector("[data-dropbox-feedback]").textContent.includes("App key saved") && !document.querySelector("[data-sign-in]").hidden');
  assert.equal(await browser.evaluate('document.querySelector("meta[name=csvtv-build]").content'), build);
  await browser.close(); browser = undefined;
  await stop(server);
  browser = await openChromium(profile, unexpectedProvider);
  await browser.offline(true);
  await browser.navigate(home + '#/library');
  await checkDevicePermissions();
  await browser.waitFor('document.querySelector("#app")?.dataset.page === "dropbox-setup"');
  assert.equal(await browser.evaluate('document.querySelector(\'link[rel="apple-touch-icon"]\')?.href'), home + 'apple-touch-icon.png');
  assert.equal(await browser.evaluate('navigator.onLine'), false);
  assert.equal(await browser.evaluate('document.querySelector("meta[name=csvtv-build]").content'), build);

  const record = {
    'watched.csv':'show_id,show,season,episode,title,times_watched,episode_id\r\n0,Signal Garden,0,1,Pilot,2,\r\n',
    'ratings.csv':'show_id,show,rating\r\n0,Signal Garden,8\r\n',
    'lists.csv':'list,show_id,show\r\n"Winter, ""rewatches""\r\nand specials ❄",0,Signal Garden\r\n',
    'shows.csv':'show_id,show,year,imdb_id\r\n0,Signal Garden,2023,tt0012345\r\n',
  };
  await browser.close();
  await listen(server, Number(new URL(home).port));
  for (const [name, content] of Object.entries(record)) await providers.upload(name,content);
  const listDownload = Promise.withResolvers();
  let listsRequested = false;
  browser = await openChromium(profile, async (message, send) => {
    const {request} = message;
    if (request.method === 'POST' && new URL(request.url).pathname === '/2/files/download' &&
        JSON.parse(new Headers(request.headers).get('Dropbox-API-Arg')).path === '/lists.csv') {
      listsRequested = true;
      await listDownload.promise;
    }
    return providers.respond(message, send);
  });
  const synced = 'document.querySelector(".sync-state")?.dataset.synced === "true"';
  try {
    await linkFixture(browser, origin, '/');
    await browser.navigate(home + '#/library');
    await until(() => listsRequested, 'first device requests its list memberships');
    // Watched and ratings can reach Library before the lists file is committed.
    await browser.waitFor('document.querySelector(".library-grid strong")?.textContent === "Signal Garden" && document.querySelector(".library-rating")?.textContent === "8/10"');
    assert.equal(await browser.evaluate(synced), false);
  } finally { listDownload.resolve(); }
  await browser.waitFor(synced, 'first device finishes syncing the complete record before disconnecting');
  await browser.offline(true);
  await browser.click('a[href="#/show/0"]');
  await browser.click('.show-rating');
  const slider = 'dialog[open] input[type=range]';
  await browser.waitFor(`document.querySelector('${slider}')?.value === '8'`);
  await browser.evaluate(`document.querySelector('${slider}').focus()`);
  for (const type of ['keyDown','keyUp']) {
    await browser.send('Input.dispatchKeyEvent', {type,key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});
  }
  await browser.click('dialog[open] .rating-commands button:last-child');
  await browser.waitFor('document.querySelector(".show-rating")?.textContent === "8.5/10"');

  await browser.close(); browser = undefined;
  browser = await openChromium(profile, unexpectedProvider);
  await browser.send('Emulation.setDeviceMetricsOverride', {width:390,height:844,deviceScaleFactor:2,mobile:true});
  await browser.offline(true);
  await browser.navigate(home + '#/show/0/season/0');
  await browser.waitFor('document.querySelector(".season-heading h1")?.textContent === "Specials" && document.querySelector(".episode-name")?.textContent === "Pilot"');
  async function activateVisible(selector) {
    await browser.waitFor(`document.querySelector(${JSON.stringify(selector)})?.getClientRects().length > 0`);
    await browser.evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
    await browser.press('Enter');
  }
  await activateVisible('.phone-back');
  await browser.waitFor('location.hash === "#/show/0" && document.querySelector(".show-rating")?.textContent === "8.5/10"');
  async function checkCustomList() {
    assert.equal(await browser.evaluate('document.querySelector(".show-list-tag") === null'),true);
    await browser.click('.show-list');
    await browser.waitFor('document.querySelector(".membership-choices input:checked")');
    assert.equal(await browser.evaluate('document.querySelector(".membership-choices input:checked").value'), 'Winter, "rewatches"\r\nand specials ❄');
    await browser.click('dialog[open] .actions .primary');
  }
  await checkCustomList();
  await browser.send('Emulation.setTouchEmulationEnabled', {enabled:true, maxTouchPoints:1});
  async function tap(selector) {
    await browser.waitFor(`document.querySelector(${JSON.stringify(selector)})?.getClientRects().length > 0`);
    const point = await browser.evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      node.scrollIntoView({block:'center'});
      const rect = node.getBoundingClientRect();
      return {x:rect.left + rect.width / 2, y:rect.top + rect.height / 2};
    })()`);
    await browser.send('Input.dispatchTouchEvent', {type:'touchStart',touchPoints:[point]});
    await browser.send('Input.dispatchTouchEvent', {type:'touchEnd',touchPoints:[]});
  }
  await tap('.show-rating');
  await tap('dialog[open] .rating-commands .destructive');
  await browser.waitFor('document.querySelector(".show-rating")?.textContent === "Rate"');
  await tap('.show-rating');
  await browser.waitFor(`document.querySelector('${slider}')?.value === '5' && document.querySelector('.rating-commands button').disabled`);
  await tap(slider);
  await tap('dialog[open] .rating-commands button:enabled');
  await browser.waitFor('document.querySelector(".show-rating")?.textContent === "5/10"');
  await activateVisible('.phone-nav a[href="#/home"]');
  await activateVisible('.settings-shortcut');
  await activateVisible('.settings-phone-export');
  await browser.click('input[value=record]');
  const downloads = join(directory, 'downloaded-record');
  await mkdir(downloads);
  await browser.send('Browser.setDownloadBehavior', {behavior:'allow',downloadPath:downloads,eventsEnabled:true});
  const expected = {...record, 'ratings.csv':'show_id,show,rating\r\n0,Signal Garden,5\r\n'};
  for (const [name, contents] of Object.entries(expected)) {
    await browser.download('a[download="' + name + '"]:not([aria-disabled=true])',name);
    const actual = await readFile(join(downloads,name),'utf8');
    assert.equal(actual, contents, name);
  }

  // A second linked device receives the files exported by the first device.
  await browser.close(); browser = undefined;
  for (const name of Object.keys(expected)) await providers.upload(name, await readFile(join(downloads,name),'utf8'));
  browser = await openChromium(join(directory, 'second-device'), providers.respond);
  await linkFixture(browser, origin, '/');
  await browser.navigate(home + '#/library');
  await browser.waitFor(synced + ' && document.querySelector(".library-rating")?.textContent === "5/10"',
    'second device finishes syncing the exported record');
  await browser.navigate(home + '#/show/0');
  await browser.waitFor('document.querySelector(".show-rating")?.textContent === "5/10"');
  await checkCustomList();
  await browser.navigate(home + '#/show/0/season/0');
  await browser.waitFor('document.querySelector(".episode-count")?.textContent === "2×"');
  assert.equal(await browser.evaluate('document.querySelector(".episode-name").textContent'), 'Pilot');
});
