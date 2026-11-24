import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {openChromium} from './offline-chromium.mjs';
import {linkFixture, offlineProviders, waitForStoredGrant} from './offline-providers.mjs';
import {listen, stop} from './offline-site.mjs';
import {releaseServer, unpack} from './release-site.mjs';

test('a deployed installation stays editable through an incomplete update and opens the repaired release offline', {timeout:120_000}, async t => {
  const previous = await unpack(await readFile(process.env.CSVTV_DEPLOYED_RELEASE));
  const next = await unpack(await readFile(new URL('../release/csvTV.zip',import.meta.url)));
  const buildOf = files => JSON.parse(files.get('service-worker.js').toString().match(/^const SHELL = (.+);$/m)[1]).build;
  const priorBuild = buildOf(previous), build = buildOf(next);
  const needsNewGrant = !previous.get('dropbox-auth.js').toString().includes('providerExpiresAt');
  assert.notEqual(priorBuild,build);
  let server = releaseServer(previous), browser;
  const port = await listen(server), origin = 'http://127.0.0.1:' + port;
  const profile = await mkdtemp(join(tmpdir(),'csvtv-deployed-upgrade-'));
  t.after(async () => {
    try { await browser?.close(); }
    finally { await stop(server); await rm(profile,{recursive:true,force:true,maxRetries:6,retryDelay:150}); }
  });
  const providers = offlineProviders(origin);
  const record = {
    'watched.csv':'show_id,show,season,episode,title,times_watched,episode_id\r\n0,Signal Garden,0,1,Pilot,2,\r\n',
    'ratings.csv':'show_id,show,rating\r\n0,Signal Garden,8\r\n',
    'shows.csv':'show_id,show,year,imdb_id\r\n0,Signal Garden,2023,tt0012345\r\n',
    'lists.csv':'list,show_id,show\r\nFavourites,0,Signal Garden\r\nMy Favourites,0,Signal Garden\r\nStopped,42,Amber Station\r\n',
  };
  for (const [name,csv] of Object.entries(record)) await providers.upload(name,csv);
  const metadata = 'document.querySelector("meta[name=csvtv-build]").content';
  const ready = 'document.querySelector("[data-offline-status]")?.textContent === "Ready to open offline."';
  const synced = 'document.querySelector(".sync-state")?.dataset.synced === "true"';
  browser = await openChromium(profile,providers.respond);
  await linkFixture(browser,origin,'/',needsNewGrant);
  await browser.navigate(origin+'/#/settings');
  await browser.waitFor(ready+' && '+synced);
  await waitForStoredGrant(browser,true);
  assert.equal(await browser.evaluate(metadata),priorBuild);
  // These clicks run on the previously installed version, which may predate the update button's data attribute.
  const update = await browser.evaluate('Boolean(document.querySelector("[data-offline-update]"))')
    ? '[data-offline-update]' : '.offline-settings button:not([data-clear-device])';
  await stop(server);
  server = releaseServer(next);
  await listen(server,port);
  await browser.click(update);
  await browser.waitFor('document.querySelector(' + JSON.stringify(update) + ')?.textContent === "Reload to update"');

  // Reproduce a waiting shell losing a module after it passed its install check.
  const waitingCache = 'csvTV:shell:'+origin+'/:'+build;
  assert.ok(await browser.evaluate('(async () => (await caches.open('+JSON.stringify(waitingCache)+')).delete("/main.js"))()'));
  await stop(server);
  providers.state.online = false;
  await browser.offline(true);
  await browser.click(update);
  await browser.waitFor('/Close other csvTV tabs|update is missing files/i.test(document.querySelector("[data-offline-status]")?.textContent)');
  assert.equal(await browser.evaluate(metadata),priorBuild);
  await browser.navigate(origin+'/#/library');
  await browser.click('a[href="#/show/0"]');
  await browser.click('.show-rating');
  await browser.waitFor('document.querySelector("dialog[open] input[type=range]")?.value === "8"');
  await browser.evaluate('document.querySelector("dialog[open] input[type=range]").focus()');
  await browser.press('ArrowRight');
  await browser.click('dialog[open] .rating-commands button:last-child');
  await browser.waitFor('document.querySelector(".show-rating")?.textContent === "8.5/10"');
  await browser.navigate(origin+'/#/settings');
  await listen(server,port);
  providers.state.online = !needsNewGrant;
  await browser.offline(false);
  await browser.click(update);
  await browser.waitFor(metadata+' === '+JSON.stringify(build)+' && '+ready);
  if (needsNewGrant) {
    const signedOut = 'document.querySelector("[data-sign-in]")?.hidden === false';
    await browser.waitFor(signedOut, 'old grant retired after updating');
    await waitForStoredGrant(browser,false);
    assert.equal(await browser.evaluate(synced),false);
    assert.equal(new TextDecoder().decode(providers.files.get('/ratings.csv').bytes),record['ratings.csv']);
    await browser.navigate(origin+'/#/library');
    await browser.waitFor('document.querySelector(".library-rating")?.textContent === "8.5/10"',
      'pending edit survives the required new sign-in');
    providers.state.online = true;
    await linkFixture(browser,origin,'/');
    await browser.navigate(origin+'/#/settings');
  }
  await browser.waitFor(synced);
  assert.equal(new TextDecoder().decode(providers.files.get('/ratings.csv').bytes),
    record['ratings.csv'].replace('Garden,8','Garden,8.5'));
  assert.equal(new TextDecoder().decode(providers.files.get('/watched.csv').bytes),record['watched.csv']);
  assert.equal(new TextDecoder().decode(providers.files.get('/lists.csv').bytes),
    'list,show_id,show\r\nDropped,42,Amber Station\r\nFavorites,0,Signal Garden\r\nMy Favourites,0,Signal Garden\r\n');

  await browser.close();
  await stop(server);
  providers.state.online = false;
  browser = await openChromium(profile,providers.respond);
  await browser.offline(true);
  await browser.navigate(origin+'/#/library');
  await browser.waitFor('document.querySelector(".library-rating")?.textContent === "8.5/10"');
  assert.equal(await browser.evaluate(metadata),build);
});
