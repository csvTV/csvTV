import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRelease } from '../package-release.mjs';
import { readCsv, writeCsv } from '../dist/csv.js';
import { openChromium, until } from './offline-chromium.mjs';
import { linkFixture, offlineProviders } from './offline-providers.mjs';
import { listen, stop } from './offline-site.mjs';
import { releaseServer, unpack } from './release-site.mjs';

const show = {show_id:45,show:'The Listening House'};
const watched = [{...show,season:1,episode:1,title:'Recording 1',times_watched:2,episode_id:45011}];
const lists = [{...show,list:'Weekend'}];
const rating = score => [{...show,rating:score}];
const marker = generation => JSON.stringify({version:1,generations:{ratings:generation},pending:[],backupsClearedAt:0});
const review = 'document.querySelector("dialog:modal h2")?.textContent === "Review Dropbox clear history"';
const synced = 'document.querySelector(".sync-state")?.dataset.synced === "true"';

// Inspect only the fictional record and the generation the device acknowledged.
async function localRecord(browser) {
  return browser.evaluate('(' + (async () => {
    const {openDeviceStore} = await import('/storage.js');
    const store = await openDeviceStore();
    try {
      const {tables:{watched,ratings,lists},local} = await store.snapshot();
      return {watched,ratings,lists,generation:local.dropboxResetSeen?.generations?.ratings};
    } finally { store.close(); }
  }).toString() + ')()');
}

for (const choice of ['Keep local edits','Use Dropbox']) {
  test('returning device can postpone an ambiguous Dropbox clear and choose ' + choice, {timeout:60000}, async t => {
    const {bytes} = await createRelease(new URL('../dist/',import.meta.url));
    const server = releaseServer(await unpack(bytes));
    const origin = 'http://127.0.0.1:' + await listen(server);
    const profile = await mkdtemp(join(tmpdir(),'csvtv-clear-review-'));
    const providers = offlineProviders(origin);
    let browser, holdRatingRead;
    t.after(async () => {
      try { await browser?.close(); await stop(server); }
      finally { await rm(profile,{recursive:true,force:true,maxRetries:6,retryDelay:150}); }
    });
    const start = () => openChromium(profile,async (event,answer) => {
      const {request} = event;
      if (holdRatingRead && request.method === 'POST' && new URL(request.url).pathname === '/2/files/download' &&
          JSON.parse(new Headers(request.headers).get('Dropbox-API-Arg') ?? '{}').path === '/ratings.csv') {
        const hold = holdRatingRead;
        holdRatingRead = undefined;
        hold.started = true;
        await hold.release.promise;
      }
      return providers.respond(event,answer);
    });
    const settings = origin + '/#/settings';
    const cloudRows = name => readCsv(name,providers.files.get('/'+name+'.csv').bytes).rows;
    await providers.upload('csvtv-reset.json',marker('first-generation'));
    for (const [name,rows] of Object.entries({watched,lists,ratings:rating(7)})) {
      await providers.upload(name+'.csv',writeCsv(name,rows));
    }
    browser = await start();
    await linkFixture(browser,origin,'/');
    await browser.navigate(origin+'/#/ratings');
    await browser.waitFor(synced,'initial device sync');
    await browser.waitFor('document.querySelector(".rating-edit:enabled")?.value === "7"');
    await browser.offline(true);
    providers.state.online = false;
    await browser.waitFor('!navigator.onLine && document.querySelector(".rating-edit:enabled")?.value === "7"');
    const picked = await browser.evaluate(`(() => {
      const score = document.querySelector('.rating-edit');
      score.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true})); score.focus();
      score.value = '8';
      if (score.value !== '8') return false;
      score.dispatchEvent(new Event('change',{bubbles:true}));
      return true;
    })()`);
    assert.equal(picked,true,'The open rating menu should offer 8/10');
    await browser.waitFor('document.querySelector(".rating-edit:enabled")?.value === "8"','offline rating saved');
    assert.equal((await localRecord(browser)).generation,'first-generation');
    await browser.close();
    browser = undefined;

    // The other device has cleared ratings. Its old-format marker has no verifiable parent.
    await providers.upload('ratings.csv',writeCsv('ratings',[]));
    await providers.upload('csvtv-reset.json',marker('unknown-generation'));
    providers.state.online = true;
    browser = await start();
    await browser.navigate(settings);
    await browser.waitFor(review,'returning device reviews the ambiguous ratings generation');
    assert.equal(await browser.evaluate('document.activeElement === document.querySelector("dialog:modal h2")'),true);
    const message = await browser.evaluate('document.querySelector("dialog:modal").innerText');
    for (const label of ['fictional-owner','Ratings','Decide later','Keep local edits','Use Dropbox']) assert.ok(message.includes(label),label);
    await browser.press('Escape');
    const closed = '!document.querySelector("dialog:modal") && document.querySelector("[data-sync]:enabled")';
    await browser.waitFor(closed);
    const prior = {watched,lists,ratings:rating(8),generation:'first-generation'};
    assert.deepEqual(await localRecord(browser),prior,'Escape changed the local rating or acknowledged the clear');
    assert.deepEqual(cloudRows('ratings'),[],'Escape uploaded the local rating');
    const automatic = {started:false, release:Promise.withResolvers()};
    holdRatingRead = automatic;
    try {
      await browser.evaluate('window.dispatchEvent(new Event("online"))');
      await until(() => automatic.started,'the automatic sync reads ratings.csv');
      assert.equal(await browser.evaluate('document.querySelector("[data-sync]").disabled'),true);
    } finally { automatic.release.resolve(); }
    await browser.waitFor(closed,'the automatic sync finishes without another clear decision');
    assert.equal(await browser.evaluate('!!document.querySelector("dialog:modal")'),false,
      'The queued online sync reopened an unchanged clear review');

    async function reviewFromSettings() {
      // A background operation can disable the button between focusing it and delivering the key.
      // Retry only an undelivered activation. Once the button receives Enter, the app must reopen the decision itself.
      await browser.evaluate(`(() => {
        delete document.body.dataset.syncActivated;
        document.addEventListener('click',function activated(event) {
          if (!event.isTrusted || !event.target.matches('[data-sync]:enabled')) return;
          document.body.dataset.syncActivated = 'yes';
          document.removeEventListener('click',activated,true);
        },true);
      })()`);
      const activated = 'document.body.dataset.syncActivated === "yes"';
      await until(async () => {
        if (await browser.evaluate(activated)) return true;
        const focused = await browser.evaluate(`(() => {
          const button = document.querySelector('[data-sync]:enabled');
          if (!button || button.hidden || document.querySelector('dialog:modal')) return false;
          button.focus(); return document.activeElement === button;
        })()`);
        if (focused) await browser.press('Enter');
        return browser.evaluate(activated);
      },'the enabled Sync now button receives Enter');
      await browser.waitFor(review,'Sync now reopens the postponed decision');
    }
    await reviewFromSettings();
    await browser.press('Tab');
    assert.equal(await browser.evaluate('document.activeElement.textContent'),'Decide later');
    await browser.press('Enter');
    await browser.waitFor(closed);
    assert.equal(await browser.evaluate('document.activeElement.matches("[data-sync],main")'),true,
      'Cancelling should restore keyboard focus to Sync now or the Settings content');
    assert.deepEqual(await localRecord(browser),prior);

    // A real change to a paused review wakes it, including without pressing Sync now.
    const newerFile = choice === 'Keep local edits';
    if (newerFile) await providers.upload('ratings.csv',writeCsv('ratings',rating(4)));
    else await providers.upload('csvtv-reset.json',marker('intervening-generation'));
    await browser.evaluate('window.dispatchEvent(new Event("online"))');
    await browser.waitFor(review,'a changed file revision or clear generation reopens automatic review');
    // Another device changes a reviewed file or its marker while this owner's dialog is open.
    const finalGeneration = newerFile ? 'unknown-generation' : 'latest-generation';
    if (newerFile) await providers.upload('ratings.csv',writeCsv('ratings',rating(5)));
    else await providers.upload('csvtv-reset.json',marker(finalGeneration));
    await browser.evaluate('[...document.querySelectorAll("dialog:modal button")].find(b=>b.textContent==="Use Dropbox").focus()');
    await browser.press('Enter');
    await browser.waitFor(closed + ' && document.querySelector("[data-cloud-reason]").textContent.includes("changed during review")',
      'stale confirmation reports the intervening change');
    assert.deepEqual(await localRecord(browser),prior,'A stale choice acknowledged the clear or replaced the offline rating');
    assert.deepEqual(cloudRows('ratings'),newerFile ? rating(5) : [],'A stale choice changed Dropbox');
    assert.match(await browser.evaluate('document.querySelector("[data-cloud-reason]").textContent'),/sync again/i,
      'A stale sync decision should return the owner to Sync now');

    await reviewFromSettings();
    const labels = await browser.evaluate('[...document.querySelectorAll("dialog:modal button")].map(b=>b.textContent)');
    const reached = [];
    for (let i = 0; i < labels.length; i++) {
      await browser.press('Tab');
      reached.push(await browser.evaluate('document.activeElement.textContent'));
    }
    assert.deepEqual(reached,labels,'Tab should reach each available choice in DOM order');
    await browser.press('Tab');
    assert.equal(await browser.evaluate('document.activeElement.textContent'),labels[0],'Tab escaped the dialog');
    for (let i = 0; i < labels.indexOf(choice); i++) await browser.press('Tab');
    await browser.press('Enter');
    await browser.waitFor(synced,'decision completes ordinary sync');
    assert.equal(await browser.evaluate('!document.querySelector("dialog:modal")'),true);
    const expectedRatings = choice === 'Keep local edits' ? rating(8) : [];
    const expected = {watched,lists,ratings:expectedRatings,generation:finalGeneration};
    assert.deepEqual(await localRecord(browser),expected);
    assert.deepEqual(cloudRows('ratings'),expectedRatings);
    assert.deepEqual(cloudRows('watched'),watched);
    assert.deepEqual(cloudRows('lists'),lists);
    await browser.close();
    browser = await start();
    await browser.navigate(settings);
    await browser.waitFor(synced,'completed choice remains settled after the browser process reopens');
    assert.deepEqual(await localRecord(browser),expected);
    assert.equal(await browser.evaluate('!!document.querySelector("dialog:modal")'),false);
  });
}
