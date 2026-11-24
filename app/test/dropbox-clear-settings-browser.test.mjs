import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRelease } from '../package-release.mjs';
import { readCsv, writeCsv } from '../dist/csv.js';
import { openChromium } from './offline-chromium.mjs';
import { linkFixture, offlineProviders } from './offline-providers.mjs';
import { listen, stop } from './offline-site.mjs';
import { releaseServer, unpack } from './release-site.mjs';

test('an incomplete offline sign-out survives a cold reopen and retires the grant before syncing any file', {timeout:60000}, async t => {
  const {bytes} = await createRelease(new URL('../dist/',import.meta.url));
  const server = releaseServer(await unpack(bytes)), origin = 'http://127.0.0.1:'+await listen(server);
  const profile = await mkdtemp(join(tmpdir(),'csvtv-signout-reopen-'));
  const cloud = offlineProviders(origin), calls = [];
  let browser, count = false;
  const start = () => openChromium(profile,(event,send) => {
    if (count && event.request.method === 'POST') calls.push(new URL(event.request.url).pathname);
    return cloud.respond(event,send);
  });
  t.after(async () => {
    try { await browser?.close(); await stop(server); }
    finally { await rm(profile,{recursive:true,force:true,maxRetries:6,retryDelay:180}); }
  });
  const settings = origin+'/#/settings', synced = 'document.querySelector("[data-cloud-reason]")?.dataset.synced === "true"';
  await cloud.settings({});
  await cloud.upload('ratings.csv',writeCsv('ratings',[{show_id:21,show:'Cloud Reader',rating:7}]));
  browser = await start(); await linkFixture(browser,origin,'/'); await browser.navigate(settings); await browser.waitFor(synced);
  await browser.evaluate(`(async () => {
    const {DeviceStore} = await import('/storage.js');
    const commit = DeviceStore.prototype.commit;
    DeviceStore.prototype.commit = function(revision,changes,options) {
      if (changes.removeLocal?.includes('dropboxSession')) throw new DOMException('Fictional storage limit','QuotaExceededError');
      return commit.call(this,revision,changes,options);
    };
  })()`);
  await browser.offline(true); count = true;
  await browser.click('[data-sign-out]');
  await browser.waitFor('document.querySelector("[data-sign-out]")?.textContent === "Finish sign-out"');
  const reason = await browser.evaluate('document.querySelector("[data-cloud-reason]").textContent');
  assert.match(reason,/revocation is unconfirmed/); assert.match(reason,/Free device storage/);
  assert.deepEqual(calls,[]);
  await browser.close(); browser = await start(); await browser.navigate(settings);
  await browser.waitFor('document.querySelector("[data-sign-in]")?.hidden === false && document.querySelector("[data-cloud-reason]")?.textContent.startsWith("Signed out")');
  assert.deepEqual(calls,['/2/auth/token/revoke']);
  const saved = await browser.evaluate(`(async () => {
    const {openDeviceStore} = await import('/storage.js'), store = await openDeviceStore();
    try { const state = await store.snapshot(); return [!!state.local.dropboxSession,state.tables.ratings[0].rating]; }
    finally { store.close(); }
  })()`);
  assert.deepEqual(saved,[false,7]);
});

test('Clear Dropbox in Settings reviews, cancels and retries before clearing only the confirmed categories', {timeout:90000}, async t => {
  const {bytes} = await createRelease(new URL('../dist/',import.meta.url));
  const server = releaseServer(await unpack(bytes));
  const origin = 'http://127.0.0.1:'+await listen(server);
  const profile = await mkdtemp(join(tmpdir(),'csvtv-settings-clear-'));
  let renewals = 0;
  const cloud = offlineProviders(origin, form => {
    assert.equal(form.get('grant_type'),'refresh_token');
    renewals++;
    return {access_token:'example-access',expires_in:renewals === 1 ? 1 : 14400};
  });
  const show = {show_id:45,show:'The Listening House'};
  const watched = [{...show,season:1,episode:1,episode_id:45011,title:'Recording 1',times_watched:2}];
  const lists = [{...show,list:'Weekend'}];
  const ratings = [{...show,rating:7}];
  const retainedSetting = {setting:'tmdb_key',value:'fictional-offline-key'};
  let browser, refuseReview = false, failedReads = 0, writes = 0;
  t.after(async () => {
    try { await browser?.close(); await stop(server); }
    finally { await rm(profile,{recursive:true,force:true,maxRetries:6,retryDelay:150}); }
  });
  const start = () => openChromium(profile,async (event,send) => {
    const {requestId,request} = event;
    const path = new URL(request.url).pathname;
    if (request.method === 'POST' && ['/2/files/upload','/2/files/delete_v2','/2/files/create_folder_v2'].includes(path)) writes++;
    if (refuseReview && request.method === 'POST' && path === '/2/files/list_folder') {
      failedReads++;
      await send('Fetch.fulfillRequest',{requestId,responseCode:renewals === 0 ? 401 : 403,
        responseHeaders:[{name:'Access-Control-Allow-Origin',value:origin},{name:'Content-Type',value:'application/json'}],
        body:Buffer.from(JSON.stringify({error_summary:'forbidden/private-diagnostic'})).toString('base64')});
      return;
    }
    await cloud.respond(event,send);
  });
  for (const [name,rows] of Object.entries({watched,ratings,lists,settings:[retainedSetting]})) {
    await cloud.upload(name+'.csv',writeCsv(name,rows));
  }
  const synced = 'document.querySelector("[data-cloud-reason]")?.dataset.synced === "true" && document.querySelector("[data-clear-dropbox]:enabled")';
  const headings = title => 'document.querySelector("dialog:modal h2")?.textContent === '+JSON.stringify(title);
  const rows = name => readCsv(name,cloud.files.get('/'+name+'.csv').bytes).rows;
  const revisions = () => [...cloud.files].map(([path,file])=>[path,file.meta.rev]).sort();
  const backupFiles = () => [...cloud.files.keys()].filter(path=>path.startsWith('/backups/'));
  async function activate(label) {
    const control = '[...document.querySelectorAll("dialog:modal button")].find(button=>button.textContent === '+JSON.stringify(label)+')';
    await browser.waitFor('!!('+control+') && !('+control+').disabled','enabled '+label);
    await browser.evaluate('('+control+').focus()');
    await browser.press('Enter');
  }
  async function selectCategories() {
    await browser.click('[data-clear-dropbox]');
    await browser.waitFor(headings('Clear Dropbox'));
    assert.equal(await browser.evaluate('document.querySelectorAll("dialog:modal input:checked").length'),0);
    assert.equal(await browser.evaluate('[...document.querySelectorAll("dialog:modal button")].find(b=>b.textContent==="Review").disabled'),true);
    await browser.click('dialog:modal input[value=ratings]');
    await browser.click('dialog:modal input[value=backups]');
    await activate('Review');
  }
  browser = await start();
  await linkFixture(browser,origin,'/');
  const settings = origin+'/#/settings';
  await browser.navigate(settings);
  await browser.waitFor(synced,'first sync including weekly backup');
  assert.ok(backupFiles().length > 0);
  const before = revisions(), writesBeforeReview = writes;

  refuseReview = true;
  await selectCategories();
  await browser.waitFor(`(() => {
    const message = document.querySelector('[data-dropbox-feedback]')?.textContent;
    return !document.querySelector('dialog:modal') && message && !message.includes('Checking');
  })()`,'read failure is visible before confirmation');
  assert.ok(failedReads > 0);
  const failure = await browser.evaluate('document.querySelector("[data-dropbox-feedback]").textContent');
  assert.match(failure,/list the csvTV app folder/i);
  assert.match(failure,/review made no changes/i);
  assert.doesNotMatch(failure,/private-diagnostic/);
  assert.equal(writes,writesBeforeReview,'the failed review sent a mutation request');
  assert.deepEqual(revisions(),before,'a failed review must leave every Dropbox file untouched');
  refuseReview = false;

  // The first renewal granted one actual second of access. The next Review must renew again.
  await browser.waitFor(`(async () => {
    const {openDeviceStore} = await import('/storage.js'); const store = await openDeviceStore();
    try { return (await store.dropboxAuthState(undefined,'request')).session.accessExpiresAt <= Date.now(); }
    finally { store.close(); }
  })()`,'the fictional access token expires before Review');
  assert.equal(renewals,1);
  await browser.evaluate(`(async () => {
    const {DeviceStore} = await import('/storage.js'); const read = DeviceStore.prototype.dropboxState;
    DeviceStore.prototype.dropboxState = function(...args) {
      if (this.role === 'writer') { window.fixtureEditingStore = this; DeviceStore.prototype.dropboxState = read; }
      return read.apply(this,args);
    };
  })()`);
  await selectCategories();
  await browser.waitFor(headings('Clear selected Dropbox data?'));
  assert.equal(renewals,2,'review continued across the same grant’s access-token renewal');
  const confirmation = await browser.evaluate('document.querySelector("dialog:modal").innerText');
  for (const text of ['fictional-owner','Ratings','Backups',backupFiles().length+' files']) assert.ok(confirmation.includes(text),text);
  await activate('Cancel');
  await browser.waitFor('!document.querySelector("dialog:modal") && document.querySelector("[data-clear-dropbox]:enabled")');
  assert.equal(writes,writesBeforeReview,'the canceled review sent a mutation request');
  assert.deepEqual(revisions(),before,'canceling after a successful review changed Dropbox');

  await selectCategories();
  await browser.waitFor(headings('Clear selected Dropbox data?'));
  // An ordinary rating save from the editing tab finishes while the confirmation is open.
  await browser.evaluate(`(async () => {
    const store = window.fixtureEditingStore; delete window.fixtureEditingStore;
    await store.commit(await store.recordRevision(),{put:{ratings:[{show_id:45,show:'The Listening House',rating:8}]}});
  })()`);
  await activate('Clear selected data');
  await browser.waitFor('document.querySelector("[data-dropbox-feedback]")?.textContent.includes("record changed")');
  const unaffected = files => files.filter(([path]) => !['/ratings.csv','/summary.csv'].includes(path));
  assert.deepEqual(unaffected(revisions()),unaffected(before),'stale confirmation changed the clear marker, a backup or an unrelated file');
  assert.ok([7,8].includes(rows('ratings')[0]?.rating),'stale confirmation removed the reviewed rating');
  await browser.click('[data-sync]');
  await browser.waitFor(synced,'the intervening rating reaches Dropbox');
  assert.equal(rows('ratings')[0].rating,8);

  await selectCategories();
  await browser.waitFor(headings('Clear selected Dropbox data?'));
  await activate('Clear selected data');
  await browser.waitFor('document.querySelector("[data-dropbox-feedback]")?.textContent === "Selected Dropbox data cleared."');
  await browser.waitFor(synced,'post-clear sync');
  const marker = JSON.parse(new TextDecoder().decode(cloud.files.get('/csvtv-reset.json').bytes));
  assert.deepEqual(marker.pending,[]);
  assert.deepEqual(Object.keys(marker.generations).sort(),['backups','ratings']);
  const verifyRemote = () => {
    assert.deepEqual(rows('ratings'),[]);
    assert.deepEqual(rows('watched'),watched);
    assert.deepEqual(rows('lists'),lists);
    assert.ok(rows('settings').some(row=>row.setting===retainedSetting.setting && row.value===retainedSetting.value));
    assert.deepEqual(backupFiles(),[]);
  };
  verifyRemote();

  await browser.close();
  browser = await start();
  await browser.navigate(settings);
  await browser.waitFor(synced,'browser reopens with the completed clear');
  const record = await browser.evaluate(`(async () => {
    const {openDeviceStore} = await import('/storage.js');
    const store = await openDeviceStore();
    try {
      const {tables:{watched,lists,ratings},local} = await store.snapshot();
      return {watched,lists,ratings,generations:local.dropboxResetSeen?.generations};
    } finally { store.close(); }
  })()`);
  assert.deepEqual(record,{watched,lists,ratings:[],generations:marker.generations});
  verifyRemote();
});
