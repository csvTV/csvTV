import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openChromium } from './offline-chromium.mjs';
import { linkFixture, offlineProviders } from './offline-providers.mjs';
import { listen, stop, testSite } from './offline-site.mjs';
import { unpack } from './release-site.mjs';

test('Offline bookmarked Library displays its restored record when optional IndexedDB reads fail',
  {timeout:60000}, async t => {
    const {server} = await testSite();
    const origin = 'http://127.0.0.1:' + await listen(server);
    const profile = await mkdtemp(join(tmpdir(), 'csvtv-offline-library-'));
    const sample = await unpack(await readFile(new URL('./iphone-offline/signal-garden-record.zip', import.meta.url)));
    const files = [...sample].map(([name, bytes]) => [name, bytes.toString('utf8')]);
    const providers = offlineProviders(origin);
    const open = () => openChromium(profile, providers.respond);
    let browser;
    t.after(async () => {
      try { await browser?.close(); await stop(server); }
      finally { await rm(profile, {recursive:true, force:true, maxRetries:6, retryDelay:150}); }
    });
    browser = await open();
    const bookmark = origin + '/tracker/#/library';
    await browser.navigate(bookmark);
    await browser.waitFor('document.querySelector("#app")?.dataset.page === "dropbox-setup"');
    for (const [name,content] of files) await providers.upload(name,content);
    await linkFixture(browser, origin);
    await browser.navigate(bookmark);
    const hasSample = "document.querySelector('.library-grid strong')?.textContent === 'Signal Garden'" +
      " && document.querySelector('.library-rating')?.textContent === '7/10'";
    await browser.waitFor(hasSample);
    await browser.navigate(origin + '/tracker/#/settings');
    await browser.waitFor("document.querySelector('[data-offline-status]')?.textContent === 'Ready to open offline.'");
    await browser.close();
    await stop(server);

    for (const unavailable of ['tmdb', 'critics']) {
      browser = await open();
      await browser.offline(true);
      await browser.send('Page.addScriptToEvaluateOnNewDocument', {source:'(' + function (unavailable) {
        window.failedCacheReads = 0;
        const transaction = IDBDatabase.prototype.transaction;
        IDBDatabase.prototype.transaction = function (stores, ...args) {
          if (unavailable === 'tmdb' && stores === 'tmdb' && location.hash === '#/library') {
            window.failedCacheReads++;
            throw new DOMException('Fictional optional read failure', 'UnknownError');
          }
          return transaction.call(this, stores, ...args);
        };
        const get = IDBObjectStore.prototype.get;
        IDBObjectStore.prototype.get = function(key) {
          if (unavailable === 'critics' && location.hash === '#/library' && this.name === 'meta' &&
              key === 'mdblist-control' && this.transaction.mode === 'readonly' &&
              !this.transaction.objectStoreNames.contains('local')) {
            window.failedCacheReads++;
            throw new DOMException('Fictional optional critic read failure','UnknownError');
          }
          return get.apply(this,arguments);
        };
      }.toString() + ')(' + JSON.stringify(unavailable) + ')'});
      await browser.navigate(bookmark);
      try { await browser.waitFor(hasSample + ' && window.failedCacheReads > 0',unavailable + ' cache failure'); }
      catch (error) {
        const state = await browser.evaluate('({screen:document.querySelector("#app")?.dataset.page,reads:window.failedCacheReads,body:document.body.innerText.slice(0,350)})');
        throw Error(error.message + ' · ' + JSON.stringify(state),{cause:error});
      }
      assert.equal(await browser.evaluate('document.querySelector("[data-category=all]").textContent'), 'All 1');
      assert.equal(await browser.evaluate('document.querySelector(".library-recovery").hidden'), true);
      assert.equal(await browser.evaluate("document.body.innerText.includes('Could not open this screen.')"), false);
      await browser.close();
    }
  });
