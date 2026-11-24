import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readCredits } from './settings-credits.mjs';
import { gzipSync } from 'node:zlib';
import { openChromium } from './offline-chromium.mjs';
import { linkFixture, offlineProviders, renewSyncedFixture } from './offline-providers.mjs';
import { listen, stop, testSite } from './offline-site.mjs';

const repository = 'fixture/studio-scores';
const token = 'fictional-shared-settings-token';
const clientHelp = 'https://myanimelist.net/apiconfig';
const github = 'https://api.github.com/repos/' + repository + '/contents/';
const file = gzipSync('show,season,offset,mal_id,score\n13,1,0,120,8.72\n13,1,5,121,8.97\n');
const imdbFile = gzipSync('show,season,episode,rating\n12,,,8.2\n');
const query = selector => 'document.querySelector(' + JSON.stringify(selector) + ')';
const content = selector => query(selector) + '?.textContent';

test('MyAnimeList source settings and setup in the compiled app', {timeout:90000}, async t => {
  const {server} = await testSite();
  const origin = 'http://127.0.0.1:' + await listen(server);
  const profile = await mkdtemp(join(tmpdir(), 'csvtv-mal-settings-'));
  let browser, status = 200, settingsRead;
  const requests = [];
  t.after(async () => {
    try { await browser?.close(); }
    finally { await stop(server); await rm(profile, {recursive:true,force:true,maxRetries:6,retryDelay:150}); }
  });
  const providers = offlineProviders(origin);
  browser = await openChromium(profile, async (message, send) => {
    const {requestId,request} = message;
    const url = new URL(request.url);
    if (url.hostname.endsWith('.dropboxapi.com')) {
      if (settingsRead && request.method === 'POST' && url.pathname === '/2/files/download' &&
          JSON.parse(new Headers(request.headers).get('Dropbox-API-Arg')).path === '/settings.csv') {
        settingsRead.entered.resolve();
        await settingsRead.resume.promise;
      }
      return providers.respond(message, send);
    }
    const isMal = request.url === github + 'mal-ratings.csv.gz?ref=mal-data';
    assert.ok(isMal || request.url === github + 'imdb-ratings.csv.gz?ref=data');
    const headers = [{name:'Access-Control-Allow-Origin', value:origin},
      {name:'Access-Control-Allow-Headers', value:'Authorization, Accept'}, {name:'Access-Control-Allow-Methods', value:'GET, OPTIONS'}];
    if (request.method === 'OPTIONS') return send('Fetch.fulfillRequest', {requestId,responseCode:204,responseHeaders:headers});
    const received = new Headers(request.headers);
    assert.equal(received.get('authorization'), 'Bearer ' + token);
    assert.equal(received.get('accept'), 'application/vnd.github.raw+json');
    assert.equal(request.method, 'GET');
    requests.push(isMal ? 'mal' : 'imdb');
    const body = status === 200 ? (isMal ? file : imdbFile) : Buffer.from('{"message":"Bad credentials"}');
    await send('Fetch.fulfillRequest', {requestId,responseCode:status,responseHeaders:headers,body:body.toString('base64')});
  });
  await linkFixture(browser, origin);
  // Keep the test clock and clipboard inside this disposable profile.
  await browser.send('Page.addScriptToEvaluateOnNewDocument', {source:`
    const start = ${Date.now()};
    globalThis.age = 0;
    Date.now = () => start + age;
    Object.defineProperty(navigator,'clipboard',{value:{writeText:async value => {globalThis.copied = value;}}});
  `});
  const viewport = width => browser.send('Emulation.setDeviceMetricsOverride', {width,height:740,deviceScaleFactor:1,mobile:false});
  const fit = async selector => assert.ok(await browser.evaluate(query(selector) + '.scrollWidth <= ' + query(selector) + '.clientWidth + 1'),
    'Horizontal overflow in ' + selector);
  const settings = () => browser.navigate(origin + '/tracker/#/settings');
  const choose = async (source, id = 'mal') => {
    const radio = 'input[name=' + id + '-source][value=' + source + ']';
    await browser.click(radio);
    const group = query('[data-' + id + '-section=github]');
    await browser.waitFor(query(radio) + '?.checked && !' + query(radio) + '.disabled && ' + group + '.hidden === ' + (source !== 'github'));
  };
  const dialog = 'dialog[open]';
  const close = () => browser.waitFor('!' + query(dialog));
  const edit = setting => browser.click('[data-mal-edit=' + setting + ']');
  const fill = value => browser.evaluate(query('#mal-setting-input') + '.value = ' + JSON.stringify(value));
  const save = () => browser.click(dialog + ' [type=submit]');
  const tokenRow = '[data-mal-value=github_token]';
  const steps = () => browser.evaluate('[...document.querySelectorAll("dialog[open] li")].map(li => li.innerText)');
  await viewport(320);
  await settings();
  await browser.waitFor('document.querySelector(".sync-state")?.dataset.synced === "true"',
    'first Dropbox sync finishes before changing the ratings source');

  await t.test('MDBList is the default and a single GitHub setup control opens the help with exact copyable templates', async () => {
    await browser.waitFor(content('.mal-settings-link p') + '?.includes("MDBList")');
    assert.ok(!(await readCredits(browser)).includes('MyAnimeList'));
    await browser.evaluate(query('.mal-settings-link') + '.focus()'); await browser.press('Enter');
    await browser.waitFor(query('input[value=mdblist]') + '?.checked');
    assert.ok(await browser.evaluate(query('[data-mal-section=github]') + '.hidden'));
    const help = 'fieldset [data-mal-help=github]';
    await browser.evaluate(query(help) + '.focus()'); await browser.press('Enter');
    await browser.waitFor(query(dialog + ' li'));
    const instructions = await steps();
    for (const [index, expected] of ['private repo','Create ID','MAL_CLIENT_ID','mal-build.mjs','mal-ratings.yml','mal-data','owner/name'].entries()) {
      assert.ok(instructions[index]?.includes(expected), 'Setup step ' + (index + 1));
    }
    assert.equal(instructions.length, 7);
    assert.deepEqual(await browser.evaluate('[...document.querySelectorAll("dialog[open] a")].map(a => [a.href,a.target,a.rel])'),
      [[clientHelp,'_blank','noopener noreferrer'],[clientHelp,'_blank','noopener noreferrer']]);
    assert.equal(await browser.evaluate(content('dialog[open] li a')), 'myanimelist.net/apiconfig');
    await fit(dialog);
    for (const name of ['mal-build.mjs','mal-ratings.yml']) {
      const path = name.endsWith('.yml') ? '.github/workflows/' + name : name;
      const button = query('button[aria-label="Copy ' + path + '"]');
      await browser.waitFor(button + '?.disabled === false');
      await browser.evaluate(button + '.focus()'); await browser.press('Enter');
      await browser.waitFor(content(dialog + ' .feedback') + ' === ' + JSON.stringify('Copied ' + path + '.'));
      assert.equal(await browser.evaluate('globalThis.copied'), await readFile(new URL('../../jobs/mal/' + name, import.meta.url), 'utf8'));
    }
    await browser.press('Escape'); await close();
    assert.ok(await browser.evaluate('document.activeElement === ' + query(help)));
    await browser.evaluate(query('input[value=mdblist]') + '.focus()'); await browser.press('ArrowRight');
    await browser.waitFor('!' + query('[data-mal-section=github]') + '.hidden');
    await fit('.mal-settings'); await fit('html');
    assert.equal(await browser.evaluate(`[...document.querySelectorAll('[data-mal-help=github]')].filter(button => button.getClientRects().length).length`),
      1, 'GitHub setup help appears twice after its credential controls open');
    await browser.click(help);
    assert.deepEqual(await steps(), instructions);
    await browser.click(dialog + ' .actions button'); await close();
    assert.ok(await browser.evaluate('document.activeElement === ' + query(help)));
    assert.equal(requests.length, 0);
  });

  await t.test('Shared credentials, unchanged files, refused downloads and source attribution follow the chosen job', async () => {
    await viewport(1120); await fit('.mal-settings');
    await edit('github_repo'); await fill('https://github.com/' + repository); await save();
    await browser.waitFor(content(dialog + ' .feedback') + '?.includes("owner/name")');
    await fill(repository); await save(); await close();
    await edit('github_token');
    const abandoned = 'fictional-closed-form-token';
    settingsRead = {entered:Promise.withResolvers(),resume:Promise.withResolvers()};
    try {
      await fill(abandoned); await save();
      await settingsRead.entered.promise;
      await browser.evaluate('location.hash = "#/settings"');
      await browser.waitFor('document.querySelector("#app").dataset.page === "settings" && !document.querySelector("dialog[open]")');
    } finally { settingsRead.resume.resolve(); settingsRead = undefined; }
    await browser.waitFor('document.querySelector("[data-sync]")?.matches(":enabled")');
    assert.ok(!new TextDecoder().decode(providers.files.get('/settings.csv')?.bytes).includes(abandoned));
    await browser.evaluate('location.hash = "#/mal-scores"');
    await edit('github_token');
    assert.ok(await browser.evaluate('document.activeElement.matches("#mal-setting-input[type=password]") && !document.activeElement.value'));
    await fill(token); await save(); await close();
    await browser.waitFor(content('[data-fetched]') + '?.includes("2 entries scored")');
    assert.deepEqual(requests, ['mal']);
    const first = await browser.evaluate(content('[data-fetched]'));
    const date = first.match(/^Fetched (.+?) ·/)[1];
    await browser.evaluate('globalThis.age = 3600000');
    await renewSyncedFixture(browser);
    await browser.waitFor(content(tokenRow) + ' === "Saved in Dropbox"');
    await browser.evaluate('globalThis.age = 7 * 86400000'); await browser.click('[data-mal-refresh]');
    await browser.waitFor(content('[data-fetched]') + '?.includes(' + JSON.stringify('Unchanged since ' + date) + ')');
    assert.equal(requests.length, 2);
    status = 401; await browser.click('[data-mal-refresh]');
    await browser.waitFor(content(tokenRow) + '?.includes("401")');
    assert.deepEqual(requests, ['mal','mal','mal'], 'Explicit retry with a refused credential');
    assert.ok((await browser.evaluate(content('[data-fetched]'))).includes('2 entries scored'));
    assert.ok(!(await browser.evaluate('document.body.innerText')).includes(token));
    await edit('github_token');
    assert.equal(await browser.evaluate(query('#mal-setting-input') + '.value'), '');
    await browser.press('Escape'); await close();
    status = 200; await browser.click('[data-mal-refresh]');
    await browser.waitFor(content(tokenRow) + ' === "Saved in Dropbox" && ' + query('[data-mal-refresh]') + '.matches(":enabled")');
    assert.deepEqual(requests, ['mal','mal','mal','mal'], 'Explicit retry recovers the same credential');
    await settings();
    await browser.waitFor(content('.mal-settings-link p') + '?.includes("GitHub job, fetched")');
    const credits = await readCredits(browser);
    assert.ok(credits.includes('MyAnimeList’s API') && credits.includes('not affiliated with MyAnimeList'));
    await browser.click('.imdb-settings-link'); await choose('github','imdb');
    await browser.waitFor(content('[data-fetched]') + '?.includes("1 show rated")');
    assert.equal(await browser.evaluate(content('[data-imdb-value=github_repo]')), repository);
    assert.equal(await browser.evaluate(content('[data-imdb-value=github_token]')), 'Saved in Dropbox');
    await settings(); await browser.click('.mal-settings-link'); await choose('mdblist');
    await settings(); await browser.waitFor(content('.mal-settings-link p') + '?.includes("MDBList")');
    assert.ok(!(await readCredits(browser)).includes('MyAnimeList'));
    assert.deepEqual(requests, ['mal','mal','mal','mal','imdb']);
  });
});
