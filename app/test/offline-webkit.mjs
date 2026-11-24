import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { securityPolicy } from '../hosting-policy.mjs';
import { createRelease } from '../package-release.mjs';
import { listen, stop } from './offline-site.mjs';
import { offlineProviders } from './offline-providers.mjs';
import { releaseServer, unpack } from './release-site.mjs';

const require = createRequire(import.meta.url);
const prepare = fileURLToPath(new URL('./iphone-offline/prepare.mjs', import.meta.url));
const contentTypes = { html: 'text/html; charset=utf-8', js: 'text/javascript', css: 'text/css',
  txt: 'text/plain; charset=utf-8', svg: 'image/svg+xml', png: 'image/png' };

function fixtureServer(directory) {
  return createServer(async (request, response) => {
    const [path] = request.url.split('?');
    const file = path === '/' ? 'index.html' : path.slice(1);
    if (request.method !== 'GET' || !/^[-\w]+\.(?:html|js|css|txt|svg|png)$/.test(file)) {
      response.writeHead(404).end();
      return;
    }
    try {
      const bytes = await readFile(join(directory, file));
      response.writeHead(200, { 'Content-Type': contentTypes[file.split('.').pop()], 'Cache-Control': 'no-store' }).end(bytes);
    } catch { response.writeHead(404).end(); }
  });
}

function sampleRating(page) {
  const link = page.getByRole('link',{name:/Signal Garden/});
  return page.locator('.library-grid > li').filter({has:link}).locator('.library-rating');
}

async function expectSample(page, rating) {
  await page.getByText('Ready to go offline.', { exact: true }).waitFor();
  assert.equal(await sampleRating(page).textContent(), rating + '/10');
}

const sampleZip = new URL('./iphone-offline/signal-garden-record.zip', import.meta.url);

async function linkProfile(page, origin, active = false) {
  // Seed only the outcome of the OAuth exchange. A current session then downloads
  // the record using the built app's normal Dropbox client.
  await page.goto(origin + '/tmdb-logo.svg');
  await page.evaluate(async active => {
    const {openDeviceStore} = await import('/storage.js');
    const store = await openDeviceStore();
    try {
      await store.whenWriter();
      localStorage.setItem('csvTV-public-dropbox-app-key','fictional-webkit-registration');
      await store.storeExchangedSession({accountId:'fictional-offline-owner',instanceId:crypto.randomUUID(),
        accessToken:'example-access',refreshToken:'example-refresh',
        accessExpiresAt:Date.now()+(active ? 1 : -1)*3600000,signInDeadline:Date.now()+(active ? 7 : -1)*86400000,providerExpiresAt:Date.now()+(active ? 7 : -1)*86400000});
    } finally { await store.closeForUpdate(); }
  },active);
}

import {releaseWithDropbox,connectFictionalDropbox} from './browser-dropbox-site.mjs';

async function waitForSync(page, provider) {
  const reason = page.locator('[data-cloud-reason]');
  try { await reason.filter({hasText:/^Synced$/}).waitFor({timeout:45000}); }
  catch { throw Error('Dropbox sync status: ' + await reason.textContent() + '. Requests: ' + (provider.seen ?? []).join(', ')); }
}

test('Narrow WebKit fits list and search controls beside their titles and opens season tiles by touch',
  { timeout:90000 }, async t => {
    const {webkit} = require(process.env.CSVTV_PLAYWRIGHT_MODULE || 'playwright-core');
    const {bytes,build} = await createRelease(new URL('../dist/',import.meta.url));
    let provider, context;
    const server = releaseWithDropbox(await unpack(bytes),()=>provider);
    const origin = 'http://127.0.0.1:' + await listen(server);
    const profile = await mkdtemp(join(tmpdir(),'csvtv-webkit-layout-'));
    t.after(async () => {
      try { await context?.close(); }
      finally { await stop(server); await rm(profile,{recursive:true,force:true,maxRetries:6,retryDelay:150}); }
    });
    provider = offlineProviders(origin);
    await provider.settings({tmdb_key:'fictional-offline-key'});
    await provider.upload('lists.csv','list,show_id,show\r\nFavourites,45,The Listening House\r\n');
    await provider.upload('ratings.csv','show_id,show,rating\r\n45,The Listening House,7.5\r\n');
    context = await webkit.launchPersistentContext(profile,{headless:true,viewport:{width:320,height:740},
      isMobile:true,hasTouch:true,proxy:{server:origin,bypass:'127.0.0.1'}});
    await connectFictionalDropbox(context);
    await context.addInitScript(() => {
      const fetch = window.fetch.bind(window);
      window.fetch = (input,init) => {
        const url = new URL(input instanceof Request ? input.url : input,location.href);
        if (url.origin === 'https://api.themoviedb.org') return fetch('/fictional-dropbox/'+url.host+url.pathname+url.search,init);
        return fetch(input,init);
      };
    });
    const page = await context.newPage();
    await linkProfile(page,origin,true);
    await page.goto(origin+'/#/settings');
    await waitForSync(page,provider);
    const helpButton = page.locator('[data-help]');
    await helpButton.tap();
    const helpHeading = page.locator('#sheet-title');
    assert.equal(await helpHeading.evaluate(e => document.activeElement === e && getComputedStyle(e).outlineStyle === 'none'),true,
      'A touch-opened help heading drew a box');
    await page.getByRole('button',{name:'Done',exact:true}).tap();
    assert.equal(await helpButton.evaluate(e => document.activeElement === e && getComputedStyle(e).outlineStyle === 'none'),true,
      'Tapping Done left a ring around the help button');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.matches(':focus-visible') && getComputedStyle(document.activeElement).outlineStyle === 'solid'),true,
      'A hardware Tab after touch should show the keyboard focus ring');
    await helpButton.tap();
    await page.getByRole('button',{name:'Done',exact:true}).tap();
    await page.keyboard.press('Space');
    await helpHeading.waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-touch-input')),false,
      'Space on a touch-focused button should restore keyboard navigation');
    await page.keyboard.press('Escape');
    const clearDevice = page.locator('[data-clear-device]');
    await clearDevice.tap();
    const decision = page.getByRole('dialog',{name:'Clear this device?'});
    const cancelClear = decision.getByRole('button',{name:'Cancel',exact:true});
    const confirmClear = decision.getByRole('button',{name:'Clear this device',exact:true});
    await confirmClear.waitFor();
    const [cancelBox,confirmBox] = await Promise.all([cancelClear.boundingBox(),confirmClear.boundingBox()]);
    assert.ok(Math.max(confirmBox.x - cancelBox.x - cancelBox.width,
      confirmBox.y - cancelBox.y - cancelBox.height) >= 11.5,'Cancel and Clear this device touch at phone width');
    await cancelClear.tap();
    assert.equal(await clearDevice.evaluate(button => button === document.activeElement),true);
    await page.goto(origin+'/#/ratings');
    const category = page.getByRole('combobox',{name:'Category'});
    await category.click();
    assert.equal(await category.evaluate(el=>getComputedStyle(el).outlineStyle),'none');
    await page.keyboard.press('k');
    assert.equal(await category.inputValue(),'k-drama','Typing selects Korean');
    assert.equal(await category.evaluate(el=>getComputedStyle(el).outlineStyle),'solid','Typing in a dropdown restores keyboard focus');
    for (const [screen,selector] of [['home','form'],['lists','.watch-density']]) {
      await page.goto(origin+'/#/'+screen);
      const title = page.locator('.screen-heading h1'), control = page.locator('.screen-heading '+selector);
      await title.waitFor();
      const [a,b] = await Promise.all([title.boundingBox(),control.boundingBox()]);
      assert.ok(a.x+a.width <= b.x+1 && a.y+a.height > b.y && b.y+b.height > a.y,screen+' header at 320 pixels');
      if (screen === 'home') {
        await control.locator('input').tap();
        assert.equal(await control.evaluate(e => getComputedStyle(e).outlineStyle),'none','Touch outlined the full search bar');
        await page.keyboard.type('ab');
        await page.keyboard.press('ArrowLeft');
        assert.equal(await control.locator('input').evaluate(e => e.selectionStart),1);
        assert.equal(await control.evaluate(e => getComputedStyle(e).outlineStyle),'none','Moving the caret outlined the full search bar');
        await control.locator('input').evaluate(e => e.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', isComposing:true, bubbles:true})));
        assert.equal(await control.evaluate(e => getComputedStyle(e).outlineStyle),'none','Composing text enabled the page focus ring');
        await page.keyboard.press('Tab');
        assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-touch-input')),false);
      }
    }
    await page.locator('.watch-density').tap();
    await page.locator('.watch-compact .list-shows a').tap();
    const count = page.locator('button.show-season-count[data-focus="watch-season-1"]:enabled');
    await count.waitFor();
    const overview = await page.locator('.show-overview').boundingBox();
    const seasons = await page.locator('.show-seasons').boundingBox();
    assert.ok(overview.height > 0 && seasons.y >= overview.y+overview.height-1);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth+1));
    await page.getByRole('button',{name:'More show actions'}).tap();
    await page.getByRole('button',{name:'Season order',exact:true}).tap();
    await page.locator('.season-order-form').getByRole('button',{name:'Cancel'}).tap();
    assert.equal(await page.locator('.show-more').evaluate(e=>e===document.activeElement),true);
    assert.equal(await count.innerText(),'0×');
    await count.tap();
    const form = page.locator('.season-count-form');
    const input = form.locator('input[name=count]');
    await input.waitFor();
    await form.locator('[data-increase]').tap();
    assert.equal(await input.inputValue(),'1');
    assert.ok(await form.evaluate(el => el.scrollWidth <= el.clientWidth + 1),'season editor overflows at 320px');
    await form.getByRole('button',{name:'Cancel',exact:true}).tap();
    assert.equal(await count.innerText(),'0×');
    const addWatch = page.getByRole('button',{name:'Add one watch to Season 1',exact:true});
    const addBox = await addWatch.boundingBox(), countBox = await count.boundingBox();
    assert.ok(addBox.width >= 44 && addBox.height >= 44 && addBox.x >= countBox.x + countBox.width - 1);
    await addWatch.tap();
    await count.filter({hasText:'1×'}).waitFor();
    assert.equal(await page.locator('dialog[open]').count(),0);
    await count.tap();
    await input.fill('2');
    await form.getByRole('button',{name:'Save',exact:true}).tap();
    await count.filter({hasText:'2×'}).waitFor();
    assert.match(page.url(),/#\/show\/45$/);
    await page.locator('.show-season-row .show-season-copy').tap();
    try { await page.locator('.season-episode').first().waitFor(); }
    catch (error) { throw Error('Season tile tap at '+page.url()+' · '+(await page.locator('main').innerText()).slice(-500),{cause:error}); }
    assert.equal(await page.locator('.season-episode').count(),2);
    assert.deepEqual(await page.locator('.episode-row .episode-count').allInnerTexts(),['2×','2×']);
    assert.match(page.url(),/#\/show\/45\/season\/1$/);
    await page.getByRole('link',{name:'Stats',exact:true}).tap();
    const openTable = page.locator('[data-table=plays-by-show]');
    await openTable.tap();
    const tableDialog = page.getByRole('dialog',{name:'Plays by show'});
    const sortPlays = tableDialog.getByRole('button',{name:/^Plays/});
    await sortPlays.tap();
    assert.equal(await sortPlays.locator('..').getAttribute('aria-sort'),'descending');
    await sortPlays.tap();
    assert.equal(await sortPlays.locator('..').getAttribute('aria-sort'),'ascending');
    assert.equal(await tableDialog.locator('tbody td').innerText(),'4');
    assert.ok((await tableDialog.getByRole('searchbox').boundingBox()).height >= 44);
    await tableDialog.getByRole('button',{name:'Close'}).tap();
    await tableDialog.waitFor({state:'detached'});
    assert.equal(await openTable.evaluate(el=>el===document.activeElement),true);
    await page.locator('.phone-nav a[href="#/library"]').tap();
    const librarySort = page.locator('.library-selects .view-sort');
    const librarySearch = page.locator('.library-selects .view-sort + .tv-search-field');
    try {
      await librarySearch.waitFor({timeout:8000});
    } catch (error) {
      const state = await page.evaluate(() => {
        const nav = document.querySelector('.phone-nav a[href="#/library"]').getBoundingClientRect();
        return {hash:location.hash,heading:document.querySelector('main h1')?.textContent,
          main:document.querySelector('main')?.innerText.slice(0,240),
          tapTarget:document.elementFromPoint(nav.x + nav.width/2,nav.y + nav.height/2)?.outerHTML.slice(0,180),
          dialog:document.querySelector('dialog[open]')?.getAttribute('aria-label'),
          controls:[...document.querySelectorAll('.library-selects > *')].map(element=>element.className)};
      });
      throw Error('Library after the Statistics table closed: '+JSON.stringify(state),{cause:error});
    }
    const sortBox = await librarySort.boundingBox(), searchBox = await librarySearch.boundingBox();
    assert.ok(searchBox.y >= sortBox.y + sortBox.height - 1 && searchBox.x + searchBox.width <= 321);
    await page.locator('[data-category=tv]').tap();
    await page.locator('.library-grid a[href="#/show/45"]').waitFor();
    await page.getByLabel('Progress',{exact:true}).selectOption('complete');
    const complete = page.locator('.library-details button').filter({hasText:'Complete'});
    await complete.waitFor();
    assert.equal(await page.locator('.library-grid a').count(),1);
    await complete.tap();
    const statusMenu = page.locator('dialog[open]');
    await statusMenu.getByRole('button',{name:'Watch again',exact:true}).waitFor();
    await statusMenu.getByRole('button',{name:'Cancel',exact:true}).tap();
    assert.equal(await complete.evaluate(el=>el===document.activeElement),true);
    assert.match(page.url(),/#\/library$/);
    await page.locator('[data-category=k-drama]').tap();
    await page.locator('.tv-empty').filter({hasText:'No matching shows'}).waitFor();
    const ratingsTab = page.locator('.phone-nav [data-destination=library] + a');
    assert.equal(await ratingsTab.innerText(),'Ratings');
    await ratingsTab.tap();
    const rating = page.getByRole('combobox',{name:'Rating for The Listening House out of 10'});
    await rating.focus();
    assert.equal(await rating.inputValue(),'7.5');
    const ratingBox = await rating.boundingBox();
    assert.ok(ratingBox.width>=44 && ratingBox.height>=44 && ratingBox.x+ratingBox.width<=321);
    await rating.selectOption('8');
    await page.waitForFunction(()=>document.querySelector('.rating-edit:enabled')?.value==='8');
    await page.locator('.undo-bar [data-undo]').tap();
    await page.waitForFunction(()=>document.querySelector('.rating-edit:enabled')?.value==='7.5');
    t.diagnostic('Desktop WebKit '+context.browser().version()+', touch viewport 320, release '+build);
  });

test('Mobile-size WebKit returns from fictional external MFA through Dropbox and reopens the synced account',
  {timeout:90000}, async t => {
    const {webkit} = require(process.env.CSVTV_PLAYWRIGHT_MODULE || 'playwright-core');
    const {bytes,build} = await createRelease(new URL('../dist/',import.meta.url));
    let provider, context, authorization, exchanges = 0;
    const server = releaseWithDropbox(await unpack(bytes),()=>provider);
    const origin = 'http://127.0.0.1:' + await listen(server);
    const profile = await mkdtemp(join(tmpdir(),'csvtv-webkit-mfa-'));
    t.after(async () => {
      try { await context?.close(); }
      finally { await stop(server); await rm(profile,{recursive:true,force:true,maxRetries:6,retryDelay:150}); }
    });
    const launch = () => webkit.launchPersistentContext(profile,{headless:true,viewport:{width:390,height:844},
      isMobile:true,hasTouch:true,proxy:{server:origin,bypass:'127.0.0.1'}});
    const registration = 'fictional-webkit-registration';
    provider = offlineProviders(origin, form => {
      assert.equal(form.get('client_id'),registration);
      assert.equal(form.get('redirect_uri'),origin+'/');
      assert.equal(form.get('code'),'fictional-webkit-result');
      assert.ok(form.get('code_verifier')?.length >= 43);
      exchanges++;
      return {account_id:'fictional-owner',access_token:'example-access',refresh_token:'example-refresh',expires_in:14400};
    });
    context = await launch();
    await connectFictionalDropbox(context);
    const authorize = 'https://www.dropbox.com/oauth2/authorize', mfa = 'https://identity.example.invalid/second-factor';
    const consent = 'https://www.dropbox.com/fictional-consent';
    const link = (route,target,label) => route.fulfill({contentType:'text/html; charset=utf-8',body:
      '<meta name="viewport" content="width=device-width,initial-scale=1"><a href="' + target.replaceAll('&','&amp;') + '">' + label + '</a>'});
    await context.route(authorize+'**', route => {
      authorization = new URL(route.request().url()).searchParams;
      return link(route,mfa,'Continue with fictional identity provider');
    });
    await context.route(mfa,route=>link(route,mfa+'?retry','Retry fictional provider sign-in'));
    await context.route(mfa+'?retry',route=>link(route,consent,'Approve fictional second factor'));
    await context.route(consent, route=>link(route,origin+'/?'+new URLSearchParams({
      code:'fictional-webkit-result',state:authorization.get('state')}),'Return to csvTV'));
    let page = await context.newPage();
    await page.goto(origin+'/#/library');
    await page.locator('[data-edit-client]').tap();
    await page.locator('#settings-services input').fill(registration);
    await page.getByRole('button',{name:'Save app key'}).tap();
    await page.getByRole('button',{name:'Sign in to Dropbox'}).tap();
    await page.getByRole('link',{name:'Continue with fictional identity provider'}).tap();
    await page.waitForURL(mfa);
    assert.equal(page.url(),mfa);
    assert.equal(authorization.get('redirect_uri'),origin+'/');
    assert.equal(authorization.get('client_id'),registration);
    assert.equal(exchanges,0);
    await page.getByRole('link',{name:'Retry fictional provider sign-in'}).tap();
    const other = await context.newPage();
    await other.bringToFront(); await page.bringToFront();
    await page.getByRole('link',{name:'Approve fictional second factor'}).tap();
    await page.getByRole('link',{name:'Return to csvTV'}).tap();
    await page.waitForFunction(() => document.querySelector('.sync-state')?.textContent === 'Synced');
    assert.equal(new URL(page.url()).search,'');
    assert.equal(exchanges,1);
    await context.close(); context = await launch();
    await connectFictionalDropbox(context);
    page = await context.newPage();
    await page.goto(origin+'/#/library');
    await page.locator('.library-screen').waitFor();
    await page.waitForFunction(() => document.querySelector('.sync-state')?.textContent === 'Synced');
    assert.equal(exchanges,1);
    t.diagnostic('Desktop WebKit with mobile viewport and touch, build '+build);
  });

test('Desktop WebKit cold-opens the public fixture and retains an offline rating after a process restart',
  { timeout: 120_000 }, async t => {
    const { webkit } = require(process.env.CSVTV_PLAYWRIGHT_MODULE || 'playwright-core');
    const directory = await mkdtemp(join(tmpdir(), 'csvtv-webkit-'));
    const site = join(directory, 'site');
    const profile = join(directory, 'profile');
    const server = fixtureServer(site);
    let context;
    t.after(async () => {
      try { await Promise.all([context?.close(), stop(server)]); }
      finally { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
    });
    await promisify(execFile)(process.execPath, [prepare, '--public', site]);
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    // External requests can reach only our loopback server, which does not forward traffic.
    const options = { headless: true, viewport: { width: 390, height: 844 },
      proxy: { server: origin, bypass: '127.0.0.1' } };
    context = await webkit.launchPersistentContext(profile, options);
    t.diagnostic('Desktop WebKit ' + context.browser().version());
    let page = await context.newPage();
    await page.goto(origin + '/#/library');
    await page.getByRole('heading',{name:'Connect Dropbox'}).waitFor();
    await page.getByRole('link',{name:'Open sample setup'}).waitFor();
    assert.equal(await page.locator('.library-grid a').count(), 0);
    const setup = await context.newPage();
    await setup.goto(origin + '/');
    await setup.getByRole('button', {name:'Prepare Signal Garden and open Library'}).click();
    await setup.getByText('Waiting for access. Close other tracker tabs on this test site.', {exact:true}).waitFor();
    await setup.evaluate(() => { location.hash = '#/library'; });
    await setup.getByRole('heading',{name:'Connect Dropbox'}).waitFor();
    await page.close();
    await setup.locator('.tab-state').filter({hasText:/^$/}).waitFor({state:'attached'});
    assert.equal(await setup.locator('.library-grid a').count(), 0);
    page = setup;
    await page.goto(origin + '/');
    await page.getByRole('button', {name:'Prepare Signal Garden and open Library'}).press('Enter');
    await expectSample(page, 7);
    const search = page.getByRole('searchbox', {name:'Search your shows'});
    await search.fill('absent');
    await page.getByText('The current filters hide all shows.', {exact:true}).waitFor();
    await search.fill('');
    await expectSample(page, 7);
    await page.locator('#sample-guide a[href="#/settings"]').click();
    await page.getByText('Ready to open offline.', {exact:true}).waitFor();
    assert.equal(await page.evaluate(async () => {
      const build = document.querySelector('meta[name="csvtv-build"]').content;
      return (await caches.open('csvTV:shell:' + location.origin + '/:' + build)).delete('./csvtv.css');
    }), true);
    await page.locator('a[href="#/library"]:visible').first().click();
    await page.getByText('Some offline files are missing.', {exact:true}).waitFor();
    await page.locator('#sample-guide a[href="#/settings"]').click();
    const offline = page.locator('section').filter({has:page.locator('[data-offline-status]')}).last();
    await offline.getByRole('button', {name:'Try again'}).click();
    await page.getByText('Ready to open offline.', {exact:true}).waitFor();
    await page.locator('a[href="#/library"]:visible').first().click();
    await expectSample(page, 7);
    const bookmark = page.url();
    assert.equal(bookmark, origin + '/#/library');
    await page.close();

    // Physically stop the host. Playwright WebKit's offline emulation can reject
    // the navigation before it is dispatched to a controlling service worker.
    await stop(server);
    page = await context.newPage();
    await page.goto(bookmark, {waitUntil:'domcontentloaded'});
    await expectSample(page, 7);
    const networkFailed = await page.evaluate(() => fetch('./offline-document.txt', { cache: 'no-store' })
      .then(() => false, () => true));
    assert.equal(networkFailed, true, 'The network-only installation document should be unreachable.');
    await page.getByRole('link', { name: /Signal Garden/ }).click();
    await page.locator('.show-rating').click();
    const slider = page.getByRole('slider', { name: 'Your rating' });
    for (let step = 0; step < 3; step++) await slider.press('ArrowRight');
    assert.equal(await slider.inputValue(), '8.5');
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await page.locator('.show-rating', { hasText: '8.5' }).waitFor();

    await context.close();
    context = undefined;
    context = await webkit.launchPersistentContext(profile, options);
    page = await context.newPage();
    await page.goto(bookmark, {waitUntil:'domcontentloaded'});
    await expectSample(page, 8.5);
  });

test('Desktop WebKit cold-opens the release ZIP twice and retains an offline edit under its shipped headers',
  { timeout: 120_000 }, async t => {
    const { webkit } = require(process.env.CSVTV_PLAYWRIGHT_MODULE || 'playwright-core');
    const {bytes, build} = await createRelease(new URL('../dist/', import.meta.url));
    let provider;
    const server = releaseWithDropbox(await unpack(bytes),()=>provider);
    const profile = await mkdtemp(join(tmpdir(), 'csvtv-webkit-release-'));
    let context;
    t.after(async () => {
      try { await Promise.all([context?.close(), stop(server)]); }
      finally { await rm(profile, {recursive:true, force:true, maxRetries:5, retryDelay:200}); }
    });
    const origin = 'http://127.0.0.1:' + await listen(server);
    const options = { headless:true, viewport:{width:390,height:844}, proxy:{server:origin,bypass:'127.0.0.1'} };
    const launch = () => webkit.launchPersistentContext(profile, options);
    context = await launch();
    t.diagnostic('Desktop WebKit ' + context.browser().version() + ', release ' + build);
    let page = await context.newPage();
    const reply = await page.goto(origin + '/#/settings');
    assert.equal(reply.headers()['content-security-policy'], securityPolicy);
    assert.equal(reply.headers()['referrer-policy'], 'no-referrer');
    assert.equal(reply.headers()['x-content-type-options'], 'nosniff');
    await page.getByRole('heading',{name:'Connect Dropbox'}).waitFor();
    provider = offlineProviders(origin);
    for (const [name,bytes] of await unpack(await readFile(sampleZip))) await provider.upload(name,bytes.toString());
    await connectFictionalDropbox(context);
    await linkProfile(page,origin,true);
    await page.goto(origin + '/#/settings');
    await waitForSync(page,provider);
    await page.getByText('Ready to open offline.', {exact:true}).waitFor();
    await page.locator('a[href="#/library"]:visible').first().click();
    const original = page.getByRole('link', {name:/Signal Garden/});
    await original.waitFor();
    assert.equal(await sampleRating(page).textContent(), '7/10');
    assert.equal(await page.locator('[data-category="all"] span').textContent(), '1');
    await page.setViewportSize({width:1280,height:800});
    const status = page.locator('.library-status-trigger[aria-haspopup=menu]');
    await status.click();
    const menu = page.getByRole('menu');
    const item = menu.getByRole('menuitem').first();
    await item.waitFor();
    assert.equal(await menu.evaluate(el=>el===document.activeElement),true);
    await item.hover();
    assert.equal(await item.evaluate(el=>el===document.activeElement),true);
    await status.hover();
    assert.equal(await menu.evaluate(el=>el===document.activeElement),true);
    await page.keyboard.press('ArrowDown');
    assert.equal(await item.evaluate(el=>el===document.activeElement),true);
    assert.ok(await menu.evaluate(el=>{
      const box = el.getBoundingClientRect(), anchor = el.previousElementSibling.getBoundingClientRect();
      return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight &&
        Math.min(Math.abs(box.top-anchor.bottom),Math.abs(box.bottom-anchor.top)) <= 5;
    }),'menu stays beside the count and inside the viewport');
    await page.keyboard.press('Escape');
    await menu.waitFor({state:'detached'});
    assert.equal(await status.evaluate(el=>el===document.activeElement),true);
    const bookmark = page.url();
    assert.equal(bookmark, origin + '/#/library');
    await context.close(); context = undefined;
    await stop(server);

    async function coldOpen(rating) {
      context = await launch();
      page = await context.newPage();
      const document = await page.goto(bookmark, {waitUntil:'domcontentloaded'});
      assert.equal(document.fromServiceWorker(), true);
      assert.equal(await page.locator('meta[name=csvtv-build]').getAttribute('content'), build);
      const show = page.getByRole('link', {name:/Signal Garden/});
      await show.waitFor();
      assert.equal(await sampleRating(page).textContent(), rating + '/10');
      const unreachable = await page.evaluate(() => fetch('/host-connectivity-check', {cache:'no-store'})
        .then(() => false, () => true));
      assert.equal(unreachable, true);
      await show.click();
    }
    await coldOpen(7);
    const touchIcon = await page.evaluate(async () => {
      const link = document.querySelector('link[rel="apple-touch-icon"]');
      const image = new Image();
      image.src = link.href;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(image,0,0);
      const pixel = (x,y) => Array.from(ctx.getImageData(x,y,1,1).data);
      return {size:[canvas.width,canvas.height],background:pixel(0,0),screen:pixel(50,50),check:pixel(80,100)};
    });
    assert.deepEqual(touchIcon, {size:[180,180],background:[10,10,12,255],screen:[214,48,60,255],check:[255,255,255,255]});
    await page.locator('.show-rating').click();
    const slider = page.getByRole('slider', {name:'Your rating'});
    for (let i = 0; i < 3; i++) await slider.press('ArrowRight');
    assert.equal(await slider.inputValue(), '8.5');
    await page.getByRole('button', {name:'Done',exact:true}).click();
    await page.locator('.show-rating', {hasText:'8.5/10'}).waitFor();
    await context.close(); context = undefined;
    await coldOpen(8.5);
    assert.equal(await page.locator('.show-list-tag').count(), 0);
    await page.locator('.show-list').click();
    assert.equal(await page.getByRole('checkbox',{name:'Winter rewatches'}).isChecked(),true);
    await page.getByRole('button',{name:'Done',exact:true}).click();
    await page.getByRole('link', {name:/Specials/}).click();
    assert.equal(await page.locator('.episode-name').textContent(), 'Pilot');
    assert.equal(await page.locator('.episode-count').textContent(), '2×');
  });

test('Offline Library distinguishes linked origins and profiles, and a returning account recovers its four CSVs from Dropbox',
  {timeout:120_000}, async t => {
    const {webkit} = require(process.env.CSVTV_PLAYWRIGHT_MODULE || 'playwright-core');
    const {bytes} = await createRelease(new URL('../dist/', import.meta.url));
    const assets = await unpack(bytes);
    let provider;
    const original = releaseWithDropbox(assets,()=>provider), alternate = releaseServer(assets);
    const directory = await mkdtemp(join(tmpdir(), 'csvtv-bookmarks-'));
    let context;
    t.after(async () => {
      try { await Promise.all([context?.close(), stop(original), stop(alternate)]); }
      finally { await rm(directory, {recursive:true, force:true, maxRetries:5, retryDelay:200}); }
    });
    const origin = 'http://127.0.0.1:' + await listen(original);
    const other = 'http://127.0.0.1:' + await listen(alternate);
    provider = offlineProviders(origin);
    const sample = await unpack(await readFile(sampleZip));
    for (const [name,bytes] of sample) await provider.upload(name,bytes.toString());
    async function launch(profile) {
      await context?.close();
      context = await webkit.launchPersistentContext(join(directory, profile), {
        headless:true, viewport:{width:390,height:844}, proxy:{server:origin, bypass:'127.0.0.1'},
      });
      await connectFictionalDropbox(context);
      return context.newPage();
    }
    async function install(page, address) {
      await linkProfile(page,address);
      await page.goto(address + '/#/settings');
      await page.getByText('Ready to open offline.', {exact:true}).waitFor();
    }
    async function offlineLibrary(page, address, populated) {
      const reply = await page.goto(address + '/#/library');
      assert.equal(reply.fromServiceWorker(), true);
      assert.equal(await page.evaluate(() => fetch('/unavailable', {cache:'no-store'}).then(() => true, () => false)), false);
      const count = page.locator('[data-category="all"] span');
      await count.filter({hasText:populated ? /^1$/ : /^0$/}).waitFor();
      if (populated) {
        assert.equal(await sampleRating(page).textContent(), '7/10');
      } else {
        await page.getByText('Shows appear here when you mark an episode watched.', {exact:true}).waitFor();
        assert.equal(await page.locator('.library-grid a').count(), 0);
      }
    }

    let page = await launch('first');
    await install(page, other);
    await linkProfile(page,origin,true);
    await page.goto(origin + '/?from=fixture#/settings');
    const canonical = page.getByRole('link', {name:'Open the page to bookmark'});
    await canonical.waitFor();
    await page.locator('[data-offline-update]').press('Tab');
    assert.equal(await canonical.evaluate(link => link === document.activeElement), true);
    await page.keyboard.press('Enter');
    await page.getByText('Ready to open offline.', {exact:true}).waitFor();
    assert.equal(page.url(), origin + '/#/settings');
    await waitForSync(page,provider);
    await page.goto(origin + '/#/library');
    await page.getByRole('link',{name:/Signal Garden/}).waitFor();
    await page.goto(origin + '/#/export');
    await page.getByText('All four data files', {exact:true}).click();
    const saved = new Map();
    for (const [name, expected] of sample) {
      const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', {name:'Download ' + name}).click()]);
      assert.equal(download.suggestedFilename(), name);
      const data = await readFile(await download.path());
      assert.deepEqual(data, expected);
      saved.set(name, data);
    }
    page = await launch('second');
    await install(page, origin);
    await context.close(); context = undefined;
    await Promise.all([stop(original), stop(alternate)]);
    provider.state.online = false;

    page = await launch('first');
    await offlineLibrary(page, other, false);
    await offlineLibrary(page, origin, true);
    page = await launch('second');
    await assert.rejects(page.goto(other + '/#/library', {waitUntil:'domcontentloaded'}),
      /could not connect|connection refused|failed to connect|cannot connect/i);
    await offlineLibrary(page, origin, false);
    const help = page.getByText('Looking for your shows?', {exact:true});
    await help.press('Enter');
    await help.press('Tab');
    const recovery = page.getByRole('link', {name:'Backups and restore',exact:true});
    assert.equal(await recovery.evaluate(link => link === document.activeElement), true);
    await page.keyboard.press('Enter');
    await page.getByText('Sign in to Dropbox to list your backups.',{exact:true}).waitFor();
    await new Promise((resolve,reject) => original.once('error',reject).listen(Number(new URL(origin).port),'127.0.0.1',resolve));
    for (const [name,bytes] of saved) await provider.upload(name,bytes.toString());
    provider.state.online = true;
    await linkProfile(page,origin,true);
    await page.goto(origin + '/#/settings');
    await waitForSync(page,provider);
    await page.goto(origin + '/#/library');
    assert.equal(await sampleRating(page).textContent(),'7/10');
    await stop(original);
    provider.state.online = false;
    page = await launch('second');
    await offlineLibrary(page, origin, true);
    // Both import screens must still open from the installed shell, even when
    // this profile never visited either screen before losing the network.
    for (const name of ['Trakt','AniList']) {
      await page.locator('.settings-shortcut').click();
      await page.getByRole('link',{name:'Import from '+name,exact:true}).click();
      const picker = page.locator('.import-screen input[type=file]');
      await picker.waitFor({state:'attached'});
      assert.equal(await page.locator('.import-screen h1').textContent(),'Import from '+name);
    }
  });
