import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openChromium, until } from './offline-chromium.mjs';
import { linkFixture, offlineProviders } from './offline-providers.mjs';
import { listen, stop, testSite } from './offline-site.mjs';
import { createRelease } from '../package-release.mjs';
import { releaseServer, unpack } from './release-site.mjs';

test('opening the first importer preserves focus chosen while its code is downloading, including on failure',
  {timeout:45000}, async t => {
    const {bytes} = await createRelease(new URL('../dist/', import.meta.url));
    const files = await unpack(bytes);
    let pending;
    const server = releaseServer(files,async (request,response) => {
      if (!pending || request.url !== '/' + pending.module + '.js') return false;
      const gate = pending;
      gate.started.resolve();
      await gate.release.promise;
      if (!gate.fail) return false;
      response.writeHead(503).end();
      return true;
    });
    const origin = 'http://127.0.0.1:' + await listen(server);
    const profile = await mkdtemp(join(tmpdir(),'csvtv-import-navigation-'));
    let browser;
    t.after(async () => {
      pending?.release.resolve();
      try { await browser?.close(); await stop(server); }
      finally { await rm(profile,{recursive:true,force:true,maxRetries:6,retryDelay:150}); }
    });
    browser = await openChromium(profile,offlineProviders(origin).respond);
    await linkFixture(browser,origin,'/');
    await browser.send('Page.addScriptToEvaluateOnNewDocument',{source:
      "Object.defineProperty(navigator,'serviceWorker',{get(){return undefined;}});"});
    await browser.send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
    await browser.navigate(origin + '/#/settings');
    for (const [name,selector,fail] of [['trakt','.desktop-back',false],['anilist','.app-sidebar a[href="#/library"]',true]]) {
      pending = {module:name+'-import-screen',started:Promise.withResolvers(),release:Promise.withResolvers(),fail};
      await browser.click('.settings-imports a[href="#/' + name + '-import"]');
      await pending.started.promise;
      await browser.evaluate('document.querySelector(' + JSON.stringify(selector) + ').focus()');
      const holdingFocus = 'document.activeElement.matches(' + JSON.stringify(selector) + ')';
      assert.equal(await browser.evaluate(holdingFocus),true);
      pending.release.resolve();
      await browser.waitFor(fail ? 'document.querySelector("main").textContent.includes("Reload csvTV")' :
        '!!document.querySelector("main input[type=file]")');
      assert.equal(await browser.evaluate(holdingFocus),true,name + ' interrupted the selected control');
      await browser.click('.app-sidebar a[href="#/settings"]');
    }
  });

test('Import, Settings and Merge explain a browser lock restriction without sending the owner to another tab',
  {timeout:30000}, async t => {
    const {server} = await testSite();
    const origin = 'http://127.0.0.1:' + await listen(server);
    const profile = await mkdtemp(join(tmpdir(),'csvtv-restricted-import-'));
    let browser;
    t.after(async () => {
      try { await browser?.close(); await stop(server); }
      finally { await rm(profile,{recursive:true,force:true,maxRetries:6,retryDelay:150}); }
    });
    browser = await openChromium(profile,offlineProviders(origin).respond);
    await browser.navigate(origin + '/tracker/tmdb-logo.svg');
    await browser.evaluate('(' + (async function() {
      const {openDeviceStore} = await import('/tracker/storage.js');
      const store = await openDeviceStore();
      try {
        const record = await store.whenWriter();
        await store.commit(record.revision,{local:{syncAccountId:'fictional-lock-reader',firstUseDismissed:true}});
      } finally { await store.closeForUpdate(); }
    }).toString() + ')()');
    await browser.send('Page.addScriptToEvaluateOnNewDocument',{source:
      "Object.defineProperty(navigator,'locks',{get(){throw new DOMException('Fixture lock denial','SecurityError');}});"});
    await browser.navigate(origin + '/tracker/#/settings');
    await browser.waitFor('document.querySelector(".tab-state")?.textContent.includes("cannot lock")');
    const reason = await browser.evaluate('document.querySelector(".tab-state").textContent');
    for (const [route, heading, status, control] of [
      ['settings','Settings','[data-cloud-reason]','[data-edit]'],
      ['trakt-import','Import from Trakt','[data-block]','input[type=file]'],
      ['anilist-import','Import from AniList','[data-block]','input[type=file]'],
      ['hand-merge','Merge by hand','[data-block]','input[type=file]'],
    ]) {
      await browser.evaluate('location.hash = ' + JSON.stringify('#/' + route));
      await browser.waitFor('document.querySelector("main h1")?.textContent === ' + JSON.stringify(heading));
      const report = 'document.querySelector(' + JSON.stringify(status) + ')';
      await browser.waitFor(report + '?.textContent === ' + JSON.stringify(reason));
      assert.equal(await browser.evaluate('document.querySelector(' + JSON.stringify(control) + ').disabled'),true);
    }
  });

test('Home import links survive refresh, support native navigation and open in a read-only tab',
  {timeout:60000}, async t => {
    const {server} = await testSite();
    const origin = 'http://127.0.0.1:' + await listen(server);
    const profile = await mkdtemp(join(tmpdir(), 'csvtv-home-import-'));
    let browser;
    t.after(async () => {
      try { await browser?.close(); await stop(server); }
      finally { await rm(profile, {recursive:true, force:true, maxRetries:6, retryDelay:150}); }
    });
    const providers = offlineProviders(origin);
    browser = await openChromium(profile, providers.respond);
    await linkFixture(browser, origin);
    const home = origin + '/tracker/#/home';
    const selector = route => `[data-setup] a[href="#/${route}"]`;
    const link = route => 'document.querySelector(' + JSON.stringify(selector(route)) + ')';
    async function point(route) {
      await browser.waitFor(link(route));
      return browser.evaluate(`(() => {
        const element = ${link(route)};
        element.scrollIntoView({block:'nearest'});
        const bounds = element.getBoundingClientRect();
        return {x:bounds.x+bounds.width/2, y:bounds.y+bounds.height/2};
      })()`);
    }
    async function mouse(type, position, modifiers = 0) {
      await browser.send('Input.dispatchMouseEvent', {type, ...position, modifiers,
        button:'left', buttons:type === 'mousePressed' ? 1 : 0, clickCount:1});
    }
    // Hold the actual writer lock until the link is pressed. Startup scheduling
    // otherwise decides whether Home initially appears as a reader or a writer.
    const hold = await browser.send('Page.addScriptToEvaluateOnNewDocument', {source:
      "navigator.locks.request('csvTV/writer/csvTV', () => new Promise(resolve => { window.releaseHomeWriter = resolve; }));"});
    await browser.send('Emulation.setDeviceMetricsOverride',{width:390,height:480,deviceScaleFactor:1,mobile:true});
    await browser.navigate(home);
    await browser.send('Page.removeScriptToEvaluateOnNewDocument', {identifier:hold.identifier});
    await browser.waitFor(link('trakt-import'));
    assert.equal(await browser.evaluate("document.querySelector('.app-column > .tab-status-area > .tab-state')?.innerText.includes('read-only')"), true);
    assert.equal(await browser.evaluate('scrollY'),0,'Home scrolled on its own before the user reached the import link');
    await browser.evaluate('scrollTo(0,document.documentElement.scrollHeight)');
    await browser.waitFor("scrollY > 56 && Math.abs(document.querySelector('.tab-state').getBoundingClientRect().top) <= 1", 'Home keeps its read-only notice at the top when scrolled');
    const position = await point('trakt-import');
    const chosenScroll = await browser.evaluate('scrollY');
    assert.ok(chosenScroll > 0,'The short viewport must exercise a link reached by scrolling');
    const atPointer = `document.elementFromPoint(${position.x},${position.y})?.closest('a,button')`;
    assert.ok(await browser.evaluate(atPointer + ' === ' + link('trakt-import')), 'Import link is obscured before pointer-down');
    await mouse('mousePressed', position);
    await browser.evaluate('window.heldLink = ' + link('trakt-import') +
      '; window.releaseHomeWriter(); window.dispatchEvent(new Event("online")); true');
    await browser.waitFor('document.querySelector("[data-setup] button:last-child")?.disabled === false' +
      ' && !document.querySelector(".tab-state").textContent', 'Home setup controls become writable after handoff');
    assert.equal(await browser.evaluate('heldLink.isConnected'), true);
    assert.equal(await browser.evaluate('scrollY'),chosenScroll,'The writer handoff moved the user’s scroll position');
    assert.ok(await browser.evaluate(atPointer + ' === heldLink'), 'The writer handoff moved the original click target');
    await mouse('mouseReleased', position);
    await browser.waitFor("location.hash === '#/trakt-import'", 'Trakt navigation after pointer release');
    await browser.waitFor("document.querySelector('[data-block]')?.textContent.includes('TMDB key')", 'Missing TMDB key on the writer import screen');
    assert.equal(await browser.evaluate('document.querySelector(".tab-status-area + .reports + main") === document.querySelector("main")'), true);
    await browser.evaluate('history.back()');
    await browser.waitFor(link('anilist-import'));

    // An incoming membership verifies that Home refreshed while the keyboard stayed on its link.
    await browser.waitFor('document.querySelector(".sync-state")?.dataset.synced === "true"');
    await browser.evaluate(link('anilist-import') + '.focus()');
    await providers.upload('lists.csv','list,show_id,show\r\nWatchlist,17,Paper Comet\r\n');
    await browser.evaluate('window.dispatchEvent(new Event("online")); true');
    await browser.waitFor('document.querySelector("[data-home-watchlist] a")?.textContent.includes("Paper Comet")',
      'Home displays the synced Watchlist member while AniList keeps focus');
    assert.equal(await browser.evaluate('document.activeElement.hash'), '#/anilist-import');
    await browser.press('Enter');
    await browser.waitFor("location.hash === '#/anilist-import' && document.querySelector('main h1')?.textContent === 'Import from AniList'");
    await browser.evaluate('history.back()');
    const modified = await point('trakt-import');
    await mouse('mousePressed', modified, 2); // Control-click opens a separate tab in Chromium.
    await mouse('mouseReleased', modified, 2);
    const tab = await until(async () => (await browser.send('Target.getTargets')).targetInfos
      .find(target => target.type === 'page' && target.url === origin + '/tracker/#/trakt-import'), 'native new-tab import link');
    assert.equal(await browser.evaluate('location.hash'), '#/home');
    await browser.send('Target.closeTarget', {targetId:tab.targetId});

    await browser.evaluate('window.reader = window.open(' + JSON.stringify(origin + '/tracker/#/anilist-import') + ', "csvtv-import-reader"); true');
    const reader = 'reader.document';
    await browser.waitFor(reader + ".querySelector('.tab-state')?.textContent.includes('read-only')");
    await browser.waitFor(reader + ".querySelector('main h1')?.textContent === 'Import from AniList'");
    await browser.evaluate("reader.location.hash = '#/home'");
    for (const [route, heading] of [['trakt-import','Trakt'], ['anilist-import','AniList']]) {
      const readerLink = reader + '.querySelector(' + JSON.stringify(selector(route)) + ')';
      await browser.waitFor(readerLink);
      assert.equal(await browser.evaluate(reader + '.querySelector("[data-setup] button:last-child").disabled'), true);
      await browser.evaluate(readerLink + '.click()');
      await browser.waitFor(reader + '.querySelector("main h1")?.textContent === ' + JSON.stringify('Import from ' + heading));
      await browser.waitFor('/another .*tab/i.test(' + reader + '.querySelector("[data-block]")?.textContent)');
      assert.equal(await browser.evaluate(reader + '.querySelector("input[type=file]").disabled'), true);
      await browser.evaluate('reader.history.back()');
    }
  });
