import assert from 'node:assert/strict';
import test from 'node:test';
import { readCredits } from './settings-credits.mjs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { openChromium } from './offline-chromium.mjs';
import { linkFixture, offlineProviders, renewSyncedFixture } from './offline-providers.mjs';
import { listen, stop, testSite } from './offline-site.mjs';

const repo = 'fixture-owner/local-ratings';
const token = 'fictional-imdb-settings-token';
const file = gzipSync('show,season,episode,rating\n12,,,8.2\n12,1,1,7.9\n90,,,9.1\n');
const omdbHelp = 'https://www.omdbapi.com/apikey.aspx';
const newRepo = 'https://github.com/new?name=csvtv-ratings&visibility=private';
const newToken = 'https://github.com/settings/personal-access-tokens/new?name=csvTV+ratings&description=Reads+the+ratings+files&contents=read&expires_in=30';
const q = selector => 'document.querySelector(' + JSON.stringify(selector) + ')';
const text = selector => q(selector) + '?.textContent';
const sourceSection = source => '[data-imdb-section=' + source + ']';

test('IMDb Settings, help, credential changes and recovery in the compiled app', {timeout:90000}, async t => {
  const {server} = await testSite();
  const origin = 'http://127.0.0.1:' + await listen(server);
  const profile = await mkdtemp(join(tmpdir(), 'csvtv-imdb-settings-'));
  let browser, replyStatus = 200, requests = 0;
  let syncListing, tokenUpload, firstGithubDownload;
  t.after(async () => {
    try { await browser?.close(); }
    finally { await stop(server); await rm(profile, {recursive:true, force:true, maxRetries:6, retryDelay:150}); }
  });
  const providers = offlineProviders(origin);
  browser = await openChromium(profile, async (message, send) => {
    const {requestId,request} = message;
    const url = new URL(request.url);
    if (url.hostname.endsWith('.dropboxapi.com')) {
      if (syncListing && request.method === 'POST' && url.pathname === '/2/files/list_folder' &&
          JSON.parse(request.postData).path === '') {
        syncListing.started.resolve();
        await syncListing.resume.promise;
      }
      if (tokenUpload && request.method === 'POST' && url.pathname === '/2/files/upload') {
        const args = JSON.parse(new Headers(request.headers).get('Dropbox-API-Arg'));
        const data = request.postDataEntries?.[0]?.bytes;
        const body = data ? Buffer.from(data,'base64').toString() : request.postData;
        if (args.path === '/settings.csv' && body?.includes(token)) await tokenUpload.promise;
      }
      return providers.respond(message, send);
    }
    assert.equal(request.url, 'https://api.github.com/repos/' + repo + '/contents/imdb-ratings.csv.gz?ref=data');
    const headers = [{'name':'Access-Control-Allow-Origin', value:origin},
      {name:'Access-Control-Allow-Headers',value:'Authorization, Accept'},{name:'Access-Control-Allow-Methods',value:'GET, OPTIONS'}];
    if (request.method === 'OPTIONS') {
      await send('Fetch.fulfillRequest', {requestId,responseCode:204,responseHeaders:headers});
      return;
    }
    const received = new Headers(request.headers);
    assert.equal(request.method, 'GET');
    assert.equal(received.get('authorization'), 'Bearer ' + token);
    assert.equal(received.get('accept'), 'application/vnd.github.raw+json');
    requests++;
    if (firstGithubDownload) await firstGithubDownload.promise;
    const data = replyStatus === 200 ? file : Buffer.from(JSON.stringify({message:'Bad credentials'}));
    await send('Fetch.fulfillRequest', {requestId,responseCode:replyStatus,
      responseHeaders:[...headers,{name:'Content-Type',value:replyStatus === 200 ? 'application/octet-stream' : 'application/json'}],
      body:data.toString('base64')});
  });
  // Inject only the clock and clipboard boundaries. No system clipboard contents are read or replaced.
  await browser.send('Page.addScriptToEvaluateOnNewDocument', {source:`
    const start = ${Date.now()};
    globalThis.age = 0;
    Date.now = () => start + globalThis.age;
    Object.defineProperty(navigator,'clipboard',{value:{writeText:async value => { globalThis.copiedFile = value; }}});
  `});
  const viewport = width => browser.send('Emulation.setDeviceMetricsOverride', {width,height:740,deviceScaleFactor:1,mobile:false});
  await linkFixture(browser, origin);
  const route = async page => {
    await browser.navigate(origin + '/tracker/#/' + page);
    await browser.waitFor(q('#app') + '?.dataset.page === ' + JSON.stringify(page));
  };
  const choose = async source => {
    const radio = 'input[name=imdb-source][value=' + source + ']';
    await browser.click(radio);
    await browser.waitFor(q(radio) + '?.checked && !' + q(radio) + '.disabled && ' +
      q(sourceSection('github')) + '.hidden === ' + (source !== 'github') + ' && ' +
      q(sourceSection('omdb')) + '.hidden === ' + (source !== 'omdb'));
  };
  const edit = setting => browser.click('[data-imdb-edit=' + setting + ']');
  const submit = () => browser.click('dialog[open] [type=submit]');
  const type = value => browser.evaluate(q('#imdb-setting-input') + '.value = ' + JSON.stringify(value));
  const closed = () => browser.waitFor('!document.querySelector("dialog[open]")');
  const form = async (setting, value) => { await edit(setting); await type(value); await submit(); await closed(); };
  const assertFits = async selector => assert.ok(await browser.evaluate(
    '(' + q(selector) + '.scrollWidth <= ' + q(selector) + '.clientWidth + 1)'), 'Horizontal overflow on ' + selector);
  const sourceHelp = source => 'fieldset [data-imdb-help=' + source + ']';
  const steps = () => browser.evaluate('[...document.querySelectorAll("dialog[open] li")].map(li => li.innerText)');
  const links = () => browser.evaluate('[...document.querySelectorAll("dialog[open] a")].map(a => [a.href, a.textContent])');
  await viewport(320);
  await route('settings');
  await browser.waitFor('document.querySelector(".sync-state")?.dataset.synced === "true"',
    'first Dropbox sync finishes before changing the ratings source');

  await t.test('Both source help sheets open by keyboard at phone width and copy the exact canonical job files', async () => {
    await browser.waitFor(text('.imdb-settings-link p') + '?.includes("None")');
    assert.ok(!(await browser.evaluate('document.body.innerText')).includes('Information courtesy of IMDb'));
    await browser.evaluate(q('.imdb-settings-link') + '.focus()');
    await browser.press('Enter');
    await browser.waitFor(q('input[value=none]') + '?.checked');
    assert.ok(await browser.evaluate(q(sourceSection('omdb')) + '.hidden && ' + q(sourceSection('github')) + '.hidden'));
    await assertFits('.imdb-settings');
    await browser.evaluate(q(sourceHelp('github')) + '.focus()');
    await browser.press('Enter');
    await browser.waitFor('document.querySelector("dialog[open] li")');
    const instructions = await steps();
    assert.equal(instructions.length, 6);
    assert.deepEqual((await links()).map(row => row[0]), [newRepo, newToken, newRepo]);
    assert.equal((await links())[1][1], 'github.com/settings/personal-access-tokens/new');
    await assertFits('dialog[open]');
    for (const filename of ['build.mjs','imdb-ratings.yml']) {
      const path = filename === 'build.mjs' ? filename : '.github/workflows/' + filename;
      const expected = await readFile(new URL('../../jobs/imdb/' + filename, import.meta.url), 'utf8');
      const selector = 'dialog[open] [aria-label="Copy ' + path + '"]';
      await browser.waitFor(q(selector) + '?.disabled === false');
      await browser.evaluate(q(selector) + '.focus()');
      await browser.press('Enter');
      await browser.waitFor(text('dialog[open] .feedback') + ' === ' + JSON.stringify('Copied ' + path + '.'));
      assert.equal(await browser.evaluate('globalThis.copiedFile'), expected);
      await browser.evaluate("navigator.clipboard.writeText = async () => { throw new DOMException('Denied','NotAllowedError'); }");
      await browser.click(selector);
      await browser.waitFor('document.activeElement.matches("dialog[open] textarea[readonly]")');
      const selected = await browser.evaluate('document.activeElement.value.slice(document.activeElement.selectionStart,document.activeElement.selectionEnd)');
      assert.equal(selected, expected.replace(/\r\n/g,'\n'));
      await assertFits('dialog[open]');
      await browser.evaluate("navigator.clipboard.writeText = async value => { globalThis.copiedFile = value; }");
    }
    await browser.press('Escape');
    assert.ok(await browser.evaluate('document.activeElement.matches(' + JSON.stringify(sourceHelp('github')) + ')'));
    await browser.click(sourceHelp('omdb'));
    const omdbSteps = await steps();
    assert.equal(omdbSteps.length, 5);
    assert.deepEqual(await browser.evaluate(`[...document.querySelectorAll('dialog[open] .help-instruction')].map(step=>{
      const range=document.createRange(); range.selectNodeContents(step); return range.getClientRects().length;
    })`), [1,1,1,1,1]);
    assert.deepEqual((await links()).map(row => row[0]), [omdbHelp, omdbHelp]);
    await browser.press('Escape');
    for (const [source, expected] of [['omdb',omdbSteps],['github',instructions]]) {
      await choose(source);
      assert.equal(await browser.evaluate(`[...document.querySelectorAll('[data-imdb-help=${source}]')].filter(button => button.getClientRects().length).length`),
        1, source + ' setup help appears twice after its credential controls open');
      await browser.click(sourceHelp(source));
      assert.deepEqual(await steps(), expected);
      await browser.press('Escape'); await closed();
      assert.ok(await browser.evaluate('document.activeElement === ' + q(sourceHelp(source))));
    }
    assert.equal(requests, 0);
  });

  await t.test('GitHub settings validate the repository, hide the token, fetch immediately and track the earliest identical file', async () => {
    await viewport(1152);
    await assertFits('.imdb-settings');
    await edit('github_repo');
    await type('https://github.com/' + repo);
    await submit();
    await browser.waitFor(text('dialog[open] .feedback') + '?.includes("owner/name")');
    await type(repo); await submit(); await closed();
    assert.equal(requests, 0);
    await edit('github_token');
    assert.ok(await browser.evaluate('document.activeElement.matches("#imdb-setting-input[type=password]") && !document.activeElement.value'));
    syncListing = {started:Promise.withResolvers(), resume:Promise.withResolvers()};
    tokenUpload = Promise.withResolvers();
    firstGithubDownload = Promise.withResolvers();
    try {
      await browser.evaluate('window.dispatchEvent(new Event("online"))');
      await syncListing.started.promise;
      await type(token); await submit();
      await browser.waitFor('document.querySelector("dialog[open]")?.innerText.includes("Waiting for Dropbox sync…")');
      syncListing.resume.resolve();
      await browser.waitFor('document.querySelector("dialog[open]")?.innerText.includes("Saving to Dropbox…")');
      assert.ok(await browser.evaluate(q('dialog[open] [type=submit]') + '.disabled'));
      assert.equal(await browser.evaluate(text('[data-imdb-value=github_token]')), 'None saved');
      assert.equal(requests, 0, 'GitHub downloads start only after Dropbox accepts the saved token');
      tokenUpload.resolve();
      await closed();
      await browser.waitFor(text('[data-imdb-value=github_token]') + ' === "Saved in Dropbox"');
      assert.ok(new TextDecoder().decode(providers.files.get('/settings.csv').bytes).includes('github_token,' + token));
    } finally {
      syncListing.resume.resolve(); syncListing = undefined;
      tokenUpload.resolve(); tokenUpload = undefined;
      firstGithubDownload.resolve(); firstGithubDownload = undefined;
    }
    await browser.waitFor(text('[data-fetched]') + '?.includes("2 shows rated")');
    const first = await browser.evaluate(text('[data-fetched]'));
    const date = first.match(/^Fetched (.+?) ·/)[1];
    assert.equal(requests, 1);
    assert.ok(!(await browser.evaluate('document.body.innerText')).includes(token));
    await edit('github_token');
    assert.equal(await browser.evaluate(q('#imdb-setting-input') + '.value'), '');
    await browser.press('Escape');
    await browser.evaluate('globalThis.age = 3600000');
    await renewSyncedFixture(browser);
    await browser.waitFor(text('[data-imdb-value=github_token]') + ' === "Saved in Dropbox"');
    await browser.evaluate('globalThis.age = 7 * 86400000');
    await browser.click('[data-imdb-refresh]');
    await browser.waitFor(text('[data-fetched]') + '?.includes(' + JSON.stringify('Unchanged since ' + date) + ')');
    assert.equal(requests, 2);
    replyStatus = 401;
    await browser.click('[data-imdb-refresh]');
    await browser.waitFor(text('[data-imdb-value=github_token]') + '?.includes("401")');
    assert.equal(requests, 3, 'Explicit retry with a refused credential');
    assert.ok(await browser.evaluate(text('[data-fetched]') + '?.includes("2 shows rated")'));
    await route('settings');
    await browser.waitFor(text('.imdb-settings-link p') + '?.includes("fetched")');
    const credits = await readCredits(browser);
    assert.ok(credits.includes('Information courtesy of IMDb') && !credits.includes('provided by OMDb'));
    await route('imdb-ratings');
    await browser.waitFor(text('[data-imdb-value=github_token]') + '?.includes("401")');
    assert.equal(requests, 3);
    replyStatus = 200;
    await browser.click('[data-imdb-refresh]');
    await browser.waitFor(text('[data-imdb-value=github_token]') + ' === "Saved in Dropbox" && ' + q('[data-imdb-refresh]') + '.matches(":enabled")');
    assert.equal(requests, 4);
  });

  await t.test('Removing the token retains the file, while choosing another source clears it and updates Credits', async () => {
    await edit('github_token'); await submit();
    await browser.click('dialog[open] [data-cancel]');
    await edit('github_token'); await submit();
    await browser.click('dialog[open] [data-remove]');
    await browser.waitFor(q('[data-imdb-refresh]') + '.disabled && ' + text('[data-imdb-value=github_token]') + ' === "None saved"');
    assert.ok((await browser.evaluate(text('[data-fetched]'))).includes('2 shows rated'));
    await choose('omdb'); await form('omdb_key', 'fictional-omdb-key');
    await route('settings');
    await browser.waitFor(text('.imdb-settings-link p') + '?.includes("OMDb")');
    const credits = await readCredits(browser);
    assert.ok(credits.includes('Information courtesy of IMDb') && credits.includes('provided by OMDb'));
    assert.ok(!credits.includes('fictional-omdb-key'));
    await route('imdb-ratings');
    await choose('github');
    assert.equal(await browser.evaluate(text('[data-fetched]')), 'No file downloaded');
    await choose('none'); await route('settings');
    await browser.waitFor(text('.imdb-settings-link p') + '?.includes("None")');
    assert.ok(!(await readCredits(browser)).includes('Information courtesy of IMDb'));
    assert.equal(requests, 4);
  });

  await t.test('A reader cannot edit, newly admitted writers can, and changes to the configuration or store dismiss stale editors', async () => {
    await browser.navigate(origin + '/fixture');
    await browser.evaluate(`(async () => {
      const {openDeviceStore} = await import('/tracker/storage.js');
      const {TmdbService} = await import('/tracker/tmdb-service.js');
      const {ImdbService} = await import('/tracker/imdb-service.js');
      const {mountImdbRatings} = await import('/tracker/imdb-settings.js');
      const name = 'IMDb Settings ownership';
      const first = await openDeviceStore({name});
      await first.whenWriter();
      const expiry = Date.now() + 3600000;
      const session = {accountId:'viewer',instanceId:'handoff',accessToken:'example-access',refreshToken:'example-refresh',accessExpiresAt:expiry,signInDeadline:expiry,providerExpiresAt:expiry};
      await first.storeExchangedSession(session);
      const reader = await openDeviceStore({name});
      reader.connectProviderKeys(async () => { throw Error('Unexpected save from the role-change fixture'); }, Date.now);
      const tmdb = new TmdbService(reader);
      const imdb = new ImdbService(tmdb);
      const screen = mountImdbRatings(document.body, imdb, reader, () => reader.providerKeysAvailable);
      const notice = () => { void screen.refresh(); };
      reader.addEventListener('imdbchange',notice);
      await screen.ready;
      globalThis.fixture = {first,reader,tmdb,imdb,screen,session};
    })()`);
    assert.ok(await browser.evaluate('[...document.querySelectorAll("input[name=imdb-source]")].every(r => r.disabled)'));
    await browser.evaluate('fixture.first.close(); fixture.reader.whenWriter().then(() => fixture.reader.loadProviderKeys(fixture.session,[],()=>true))');
    await choose('github'); await edit('github_repo'); await type('unsubmitted/repository');
    await browser.evaluate(`(async () => {
      const store = fixture.reader;
      const {revision} = await store.snapshot();
      await store.commit(revision,{put:{settings:[{setting:'imdb_source',value:'omdb'}]}});
    })()`);
    await closed();
    assert.ok(await browser.evaluate(q(sourceSection('github')) + '.hidden'));
    await edit('omdb_key');
    await browser.evaluate('fixture.reader.closeForUpdate()');
    await closed();
    assert.ok(await browser.evaluate('[...document.querySelectorAll("input[name=imdb-source]")].every(r => r.disabled)'));
    await browser.evaluate('fixture.screen.dispose();fixture.imdb.close();fixture.tmdb.close();true');
  });

  await t.test('Clearing rebuildable caches refetches the GitHub file while the same configured session stays open', async () => {
    await browser.navigate(origin + '/fixture');
    await browser.evaluate(`(async () => {
      const {openDeviceStore} = await import('/tracker/storage.js');
      const {TmdbService} = await import('/tracker/tmdb-service.js');
      const {TmdbLibrary} = await import('/tracker/tmdb-library.js');
      const {ImdbService} = await import('/tracker/imdb-service.js');
      const store = await openDeviceStore({name:'IMDb quota recovery'});
      await store.whenWriter();
      const expiry = Date.now() + 3600000;
      const session = {accountId:'viewer',instanceId:'quota',accessToken:'example-access',refreshToken:'example-refresh',accessExpiresAt:expiry,signInDeadline:expiry,providerExpiresAt:expiry};
      await store.storeExchangedSession(session);
      store.connectProviderKeys(async () => { throw Error('Unexpected save while rebuilding caches'); }, Date.now);
      await store.loadProviderKeys(session,[{setting:'github_token',value:${JSON.stringify(token)}}],()=>true);
      await store.commit((await store.snapshot()).revision,{put:{settings:[
        {setting:'imdb_source',value:'github'}, {setting:'github_repo',value:${JSON.stringify(repo)}}]}});
      const tmdb = new TmdbService(store);
      const imdb = new ImdbService(tmdb);
      const library = new TmdbLibrary(tmdb, undefined, imdb);
      globalThis.fixture = {store, tmdb, imdb, library};
    })()`);
    const hasFile = '(async () => (await fixture.imdb.status()).showCount === 2)()';
    await browser.waitFor(hasFile, 'configured file at startup');
    const before = requests;
    await browser.evaluate('fixture.store.clearRebuildableCaches()');
    await browser.waitFor(hasFile, 'automatic ratings file recovery after cache cleanup');
    assert.equal(requests, before + 1);
    await browser.evaluate('fixture.library.close();fixture.imdb.close();fixture.tmdb.close();fixture.store.closeForUpdate()');
  });
});
