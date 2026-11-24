import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {readCsv} from '../dist/csv.js';
import {createRelease} from '../package-release.mjs';
import {openChromium,until} from './offline-chromium.mjs';
import {linkFixture,offlineProviders} from './offline-providers.mjs';
import {listen,stop} from './offline-site.mjs';
import {releaseServer,unpack} from './release-site.mjs';

function abortNextPreferenceWrite() {
  const commit = IDBTransaction.prototype.commit;
  IDBTransaction.prototype.commit = function() {
    if (this.objectStoreNames.contains('settings')) {
      IDBTransaction.prototype.commit = commit;
      this.abort();
    } else commit.call(this);
  };
}

test('Compact retries its original choice and cannot reverse a later Watchlist or Lists selection', {timeout:60000}, async t => {
  const {bytes} = await createRelease(new URL('../dist/',import.meta.url));
  const server = releaseServer(await unpack(bytes)), origin = 'http://127.0.0.1:'+await listen(server);
  const provider = offlineProviders(origin), profile = await mkdtemp(join(tmpdir(),'csvtv-compact-retry-'));
  let browser;
  t.after(async () => {
    try { await browser?.close(); }
    finally { await stop(server); await rm(profile,{recursive:true,force:true,maxRetries:6,retryDelay:150}); }
  });
  await provider.settings({watchlist_density:'comfortable'});
  browser = await openChromium(profile,provider.respond);
  await linkFixture(browser,origin,'/');
  const button = 'document.querySelector(".watch-density")', retry = '.report[data-retry] button:first-of-type';
  const saved = () => readCsv('settings',provider.files.get('/settings.csv').bytes).rows.find(r=>r.setting==='watchlist_density')?.value;
  async function checked(value) {
    await browser.waitFor(button+'?.disabled === false && '+button+'.getAttribute("aria-pressed") === '+JSON.stringify(String(value)));
  }
  async function fail() {
    await browser.evaluate('('+abortNextPreferenceWrite+')()');
    await browser.evaluate(button+'.focus()');
    await browser.press('Space');
    await browser.waitFor('!!document.querySelector('+JSON.stringify(retry)+')','retry for failed Compact choice');
  }
  for (const route of ['watchlist','lists']) {
    await browser.navigate(origin+'/#/'+route);
    await browser.waitFor('document.querySelector(".sync-state")?.dataset.synced === "true"');
    await checked(false);
    await fail();
    await checked(false);
    await browser.click(retry);
    await checked(true);
    if (route==='watchlist') await until(()=>saved()==='compact','retried choice uploaded');
    await fail();
    await browser.click('.watch-density');
    await checked(false);
    await browser.click(retry);
    await browser.evaluate('('+async function() {
      const {openDeviceStore} = await import('/storage.js');
      const reader = await openDeviceStore();
      try {
        const {preference} = await reader.devicePreference('watchlistDensity');
        if (preference!=='comfortable') throw Error('A stale Retry reversed the saved preference');
      } finally { reader.close(); }
    }+')()');
    await checked(false);
  }
  await fail();
  await browser.evaluate('window.previousCompactRetry = document.querySelector('+JSON.stringify(retry)+')');
  await browser.navigate(origin+'/#/watchlist');
  await checked(false);
  await browser.evaluate('window.previousCompactRetry.click()');
  await browser.send('Page.reload',{});
  await checked(false);
  await browser.click('.app-sidebar a[href="#/settings"]');
  await browser.click('[data-sync]');
  await until(()=>saved()==='comfortable','latest choice uploaded after reopening');

  // Keep a failed callback alive while another tab replaces or erases the linked record.
  // The displayed density can be identical on both sides of each change.
  const guarded = await browser.evaluate('('+async function(abortWrite) {
    const {openDeviceStore} = await import('/storage.js');
    const {compactControl} = await import('/view-select.js');
    const name = 'fictional-compact-owner';
    const writer = await openDeviceStore({name}), reader = await openDeviceStore({name});
    const page = document.createElement('section');
    let retry, pending, control;
    try {
      await writer.whenWriter();
      control = compactControl(page,{service:{store:writer},run(action) {
        pending = action().catch(() => { retry = action; }); return pending;
      }});
      page.append(control.button);
      async function fail() {
        await control.read();
        retry = undefined;
        abortWrite();
        control.button.click();
        await pending;
        if (!retry) throw Error('Missing failed compact choice');
        return retry;
      }
      async function link(accountId) {
        const deadline = Date.now()+86400000;
        await reader.storeExchangedSession({accountId,instanceId:crypto.randomUUID(),accessToken:'fictional-access',
          refreshToken:'fictional-refresh',accessExpiresAt:Date.now()+300000,providerExpiresAt:deadline,signInDeadline:deadline});
      }
      const preference = async () => (await reader.devicePreference('watchlistDensity')).preference ?? null;
      await link('fictional-first-account');
      const changedOwner = await fail();
      await link('fictional-second-account');
      // Signing in asks which account to keep. The confirmed switch rebinds the record.
      await writer.commit((await reader.devicePreference('watchlistDensity')).revision,
        {local:{syncAccountId:'fictional-second-account'}},{syncWrite:true});
      await changedOwner();
      const account = await preference();
      const erasedRecord = await fail();
      await writer.eraseDevice((await reader.devicePreference('watchlistDensity')).revision);
      await link('fictional-second-account');
      await erasedRecord();
      const erased = await preference();
      const closedWriter = await fail();
      await writer.closeForUpdate();
      await reader.whenWriter();
      await closedWriter();
      return {account,erased,reader:await preference(),disabled:control.button.disabled};
    } finally { control?.dispose(); reader.close(); writer.close(); }
  }+')('+abortNextPreferenceWrite+')');
  assert.deepEqual(guarded,{account:null,erased:null,reader:null,disabled:true});
});
