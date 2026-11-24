import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createRelease } from '../package-release.mjs';
import { readCsv, writeCsv } from '../dist/csv.js';
import { openChromium, until } from './offline-chromium.mjs';
import { linkFixture, offlineProviders } from './offline-providers.mjs';
import { listen, stop } from './offline-site.mjs';
import { releaseServer, unpack } from './release-site.mjs';

// Interrupt the actual restore worker at the approval and acknowledgement boundaries.
function interruptWatchRestore(boundary) {
  const NativeWorker = Worker;
  window.Worker = class extends NativeWorker {
    constructor(...args) {
      super(...args);
      this.addEventListener('message', event => {
        if (!this.restoring || event.data.type !== boundary) return;
        event.stopImmediatePropagation();
        window.restoreBoundary = boundary;
        if (boundary === 'complete') this.dispatchEvent(new ErrorEvent('error',{cancelable:true}));
      });
    }
    postMessage(value,...args) {
      if (value?.receipt?.pending?.absoluteWatches) this.restoring = true;
      return super.postMessage(value,...args);
    }
  };
}

for (const shape of ['dense','sparse']) test('a '+shape+' Restore survives a renderer closing before commit, a lost worker reply and an unavailable second file', {timeout:120000}, async t => {
  const {bytes} = await createRelease(new URL('../dist/',import.meta.url));
  const server = releaseServer(await unpack(bytes)), origin = 'http://127.0.0.1:'+await listen(server);
  const work = await mkdtemp(join(tmpdir(),'csvtv-restore-interruption-')), cloud = offlineProviders(origin);
  let browser, fresh, failRating = false, watchUploaded = false;
  t.after(async () => {
    try { await Promise.allSettled([browser?.close(),fresh?.close()]); await stop(server); }
    finally { await rm(work,{recursive:true,force:true,maxRetries:6,retryDelay:150}); }
  });
  const open = profile => openChromium(join(work,profile),(event,send) => {
    const route = new URL(event.request.url).pathname;
    const arg = new Headers(event.request.headers).get('Dropbox-API-Arg'), path = arg && JSON.parse(arg).path;
    if (route === '/2/files/upload' && path === '/watched.csv') watchUploaded = true;
    if (failRating && watchUploaded && route === '/2/files/download' && path === '/ratings.csv') {
      failRating = false;
      return send('Fetch.failRequest',{requestId:event.requestId,errorReason:'InternetDisconnected'});
    }
    return cloud.respond(event,send);
  });
  const show = {show_id:46,show:'Slate Library'};
  const episode = (i,plays) => ({...show,season:1+Math.floor(i/24),episode:1+i%24,episode_id:46601+i,
    title:'Leaf '+(i+1),times_watched:plays});
  const original = Array.from({length:shape==='dense'?2:2050},(_,i)=>episode(i,1));
  const incoming = shape==='dense' ? Array.from({length:2050},(_,i)=>episode(i,2)) :
    [...original.slice(1).map((row,i)=>i<60?{...row,times_watched:2}:row),episode(2050,3)];
  const initial = writeCsv('watched',original), restored = writeCsv('watched',incoming);
  const ratings = rating => writeCsv('ratings',[{...show,rating}]);
  const synced = 'document.querySelector(".sync-state")?.dataset.synced === "true"';
  const currentRecord = '('+(async function () {
    const {openDeviceStore} = await import('/storage.js'), {writeCsv} = await import('/csv.js');
    const store = await openDeviceStore();
    try {
      const {tables,sync} = await store.snapshot();
      return {watched:writeCsv('watched',tables.watched),rating:tables.ratings[0]?.rating,
        lists:tables.lists.map(row=>row.list),revision:sync.watched.base.revision,pending:sync.watched.pending};
    } finally { store.close(); }
  }).toString()+')()';
  const inspect = page => page.evaluate(currentRecord);
  async function settings(page) {
    await page.navigate(origin+'/#/settings');
    await page.waitFor(synced);
  }
  async function chooseBackup(ratingsOnly = false) {
    await browser.navigate(origin+'/#/recovery');
    await browser.click('[data-folder="Fictional archive"]');
    await browser.waitFor('!!document.querySelector("[data-restore]:enabled")');
    if (ratingsOnly) await browser.click('[data-files] input[value="watched"]');
  }
  await cloud.settings({});
  await cloud.upload('watched.csv',initial);
  await cloud.upload('ratings.csv',ratings(7));
  await cloud.upload('lists.csv',writeCsv('lists',[{...show,list:'Favorites'}]));
  browser = await open('returning');
  await linkFixture(browser,origin,'/');
  await settings(browser);
  const before = await inspect(browser);
  assert.equal(before.watched,initial);
  const folder = await browser.evaluate(`fetch('https://api.dropboxapi.com/2/files/create_folder_v2',{
    method:'POST',headers:{Authorization:'Bearer example-access','Content-Type':'application/json'},
    body:JSON.stringify({path:'/backups/Fictional archive'})}).then(r=>r.ok)`);
  assert.equal(folder,true);
  await cloud.upload('backups/Fictional archive/watched.csv',restored);
  await cloud.upload('backups/Fictional archive/ratings.csv',ratings(9));
  await chooseBackup();
  await browser.evaluate('('+interruptWatchRestore.toString()+')("admission")');
  await browser.click('[data-restore]');
  await browser.waitFor('window.restoreBoundary === "admission"');
  void browser.send('Page.crash').catch(()=>{});
  await delay(150);
  await browser.close();
  browser = await open('returning');
  await browser.navigate(origin+'/tmdb-logo.svg');
  assert.deepEqual(await inspect(browser),before);
  assert.equal(cloud.files.get('/watched.csv').meta.rev,before.revision);
  await settings(browser);
  await chooseBackup();
  await browser.evaluate('('+interruptWatchRestore.toString()+')("complete")');
  failRating = true;
  watchUploaded = false;
  await browser.click('[data-restore]');
  await browser.waitFor('window.restoreBoundary === "complete" && document.querySelector("[data-result]")?.textContent.includes("Not restored.")');
  const results = await browser.evaluate('document.querySelector("[data-result]").innerText');
  assert.match(results,/watched\.csv[\s\S]*Restored\./);
  assert.match(results,/ratings\.csv[\s\S]*Not restored\./);
  const expected = {watched:restored,rating:7,lists:['Favorites'],pending:null,revision:cloud.files.get('/watched.csv').meta.rev};
  assert.deepEqual(await inspect(browser),expected);
  fresh = await open('fresh');
  await linkFixture(fresh,origin,'/');
  await settings(fresh);
  assert.deepEqual(await inspect(fresh),expected);
  await chooseBackup(true);
  await browser.click('[data-restore]');
  await browser.waitFor('document.querySelector("[data-result]")?.textContent.includes("Restored.")');
  await fresh.click('[data-sync]');
  await until(async () => (await inspect(fresh)).rating === 9,'fresh profile receives separately restored rating');
  assert.deepEqual(await inspect(fresh),{...expected,rating:9});
});

test('Settings Merge and Restore preview, return, save selected files, sync and survive reopening', {timeout:120000}, async t => {
  const {bytes} = await createRelease(new URL('../dist/',import.meta.url));
  const server = releaseServer(await unpack(bytes));
  const origin = 'http://127.0.0.1:'+await listen(server);
  const work = await mkdtemp(join(tmpdir(),'csvtv-restore-merge-'));
  const cloud = offlineProviders(origin), profile = join(work,'profile');
  let browser, refusal, holdListing, countMarkers;
  t.after(async () => {
    try { await browser?.close(); await stop(server); }
    finally { await rm(work,{recursive:true,force:true,maxRetries:6,retryDelay:150}); }
  });
  const show = {show_id:45,show:'The Listening House'};
  const episode = (number,plays) => ({...show,season:1,episode:number,episode_id:45010+number,title:'Recording '+number,times_watched:plays});
  const weekend = {...show,list:'Weekend'}, favorites = {...show,list:'Favorites'}, ratings = [{...show,rating:7}];
  const initial = {watched:[episode(1,2)],ratings,lists:[weekend]};
  const merged = {watched:[episode(1,4),episode(2,1)],ratings,lists:[favorites,weekend]};
  const restored = {...merged,watched:initial.watched};
  const setting = {setting:'github_token',value:'fictional-recovery-token'};
  const filePaths = [];
  for (const [name,rows] of Object.entries(initial)) await cloud.upload(name+'.csv',writeCsv(name,rows));
  await cloud.upload('settings.csv',writeCsv('settings',[setting]));
  for (const [name,rows] of Object.entries({watched:merged.watched,ratings:[{...show,rating:9}],lists:[favorites]})) {
    const path = join(work,name+'.csv');
    await writeFile(path,writeCsv(name,rows));
    filePaths.push(path);
  }
  const synced = 'document.querySelector(".sync-state")?.dataset.synced === "true"';
  const rows = name => readCsv(name,cloud.files.get('/'+name+'.csv').bytes).rows;
  const sortRecord = record => ({...record,lists:record.lists.toSorted((a,b)=>a.list.localeCompare(b.list)),
    watched:record.watched.toSorted((a,b)=>a.episode-b.episode)});
  const verifyRemote = expected => {
    assert.deepEqual(sortRecord({watched:rows('watched'),ratings:rows('ratings'),lists:rows('lists')}),expected);
    assert.ok(rows('settings').some(row=>row.setting===setting.setting && row.value===setting.value));
  };
  async function back() {
    await browser.evaluate(`[...document.querySelectorAll('[aria-label="Go back"]')].find(b=>b.getClientRects().length).focus()`);
    await browser.press('Enter');
    await browser.waitFor('document.querySelector("[data-file-actions]") && location.hash==="#/settings"');
  }
  const open = page => browser.click('[data-file-actions] a[href="#/'+page+'"]');
  const revisions = () => [...cloud.files].map(([path,file])=>[path,file.meta.rev]).sort();
  const start = () => openChromium(profile,async (event,send) => {
    const {requestId,request} = event;
    if (request.method==='POST' && (holdListing || countMarkers)) {
      const route=new URL(request.url).pathname;
      if (route==='/2/files/list_folder' && JSON.parse(request.postData).path==='/backups' && holdListing) {
        const hold=holdListing;
        holdListing=undefined;
        hold.started.resolve();
        await hold.resume.promise;
      }
      if (route==='/2/files/download') countMarkers?.(JSON.parse(new Headers(request.headers).get('Dropbox-API-Arg')).path);
    }
    if (refusal && request.method==='POST' && new URL(request.url).pathname==='/2/files/'+refusal.route) {
      const args = JSON.parse(new Headers(request.headers).get('Dropbox-API-Arg') ?? request.postData);
      if (args.path===refusal.path) {
        const body = {error_summary:'private-diagnostic',error:refusal.error};
        return send('Fetch.fulfillRequest',{requestId,responseCode:refusal.status,
          responseHeaders:[{name:'Access-Control-Allow-Origin',value:origin},{name:'Content-Type',value:'application/json'}],
          body:Buffer.from(JSON.stringify(body)).toString('base64')});
      }
    }
    return cloud.respond(event,send);
  });
  async function chooseFiles() {
    const selector = 'main input[type=file]:enabled';
    await browser.waitFor('document.querySelector('+JSON.stringify(selector)+')');
    const {root} = await browser.send('DOM.getDocument');
    const {nodeId} = await browser.send('DOM.querySelector',{nodeId:root.nodeId,selector});
    await browser.send('DOM.setFileInputFiles',{nodeId,files:filePaths});
    await browser.waitFor('document.querySelector("[data-preview]:not([hidden])") && document.querySelector("[data-continue]:enabled:not([hidden])")');
    const review = await browser.evaluate('document.querySelector("[data-preview]").textContent');
    for (const text of ['2 → 4 plays','keep rating 7','selected file 9','Favorites']) {
      assert.ok(review.includes(text),review);
    }
  }
  browser = await start();
  await linkFixture(browser,origin,'/');
  const settings = origin+'/#/settings';
  await browser.navigate(settings);
  await browser.waitFor(synced+' && document.querySelector("[data-backup]:enabled")','finished first backup');
  verifyRemote(initial);
  // Keep the report open in a reader tab across failed and successful recovery operations.
  const reportHasPlays = count => "window.statsReader.document.querySelector('[data-stat=plays] dd')?.textContent === "+JSON.stringify(String(count));
  await browser.evaluate("window.statsReader=window.open('/#/statistics','csvtv-restore-statistics'); Boolean(window.statsReader)");
  await browser.waitFor(reportHasPlays(2),'initial Statistics report');
  const firstBackup = [...cloud.files.keys()].find(path=>path.endsWith('/completion.json')).split('/')[2];
  const beforeMerge = revisions();
  await open('hand-merge');
  await chooseFiles();
  await browser.click('[data-cancel]');
  await browser.waitFor('document.querySelector("[data-state]")?.textContent === "Merge canceled." && document.activeElement.matches("input[type=file]")');
  assert.deepEqual(revisions(),beforeMerge);
  await chooseFiles();
  await back();
  assert.deepEqual(revisions(),beforeMerge,'Back accepted a merge preview');
  await open('hand-merge');
  await chooseFiles();
  await browser.click('[data-continue]');
  await browser.waitFor('document.querySelector("[data-state]")?.textContent === "Merge saved on this device."','merge saved');
  await until(()=>rows('watched').length===2 && rows('lists').length===2,'automatic Dropbox sync of merged files');
  await back();
  await browser.waitFor('document.querySelector("[data-cloud-reason]")?.textContent === "Synced" && document.querySelector("[data-backup]:enabled")');
  verifyRemote(merged);
  await browser.waitFor(reportHasPlays(5),'merged plays in the open Statistics report');

  const beforeRestore = revisions();
  async function selectWatched() {
    await browser.waitFor('document.querySelector("[data-folders] h2")?.textContent === "Verified backups"');
    await browser.click('[data-folder="'+firstBackup+'"]');
    await browser.waitFor('document.querySelector("[data-files] input[value=watched]:checked")');
    const choices = await browser.evaluate('[...document.querySelectorAll("[data-files] input:checked")].map(box=>box.value)');
    for (const name of ['watched','ratings','lists']) assert.ok(choices.includes(name),name);
    for (const name of choices) if (name!=='watched') await browser.click('[data-files] input[value="'+name+'"]');
  }
  async function expectStatus(step,reason) {
    await browser.waitFor('document.querySelector("[data-state]")?.textContent.includes('+JSON.stringify(step)+')',step);
    const status = await browser.evaluate('document.querySelector("[data-state]").textContent');
    assert.match(status,reason);
    assert.doesNotMatch(status,/private-diagnostic/);
    assert.deepEqual(revisions(),beforeRestore);
  }
  const stalled = {started:Promise.withResolvers(),resume:Promise.withResolvers()};
  holdListing=stalled;
  const manifest='/backups/'+firstBackup+'/completion.json';
  let reads=0;
  countMarkers=path=>{ if (path===manifest) reads++; };
  try {
    await open('recovery');
    await stalled.started.promise;
    await back();
    await open('recovery');
  } finally { stalled.resume.resolve(); }
  await browser.waitFor('document.querySelector("[data-folder]")');
  assert.equal(reads,1,'Leaving Restore should stop the first listing before it reads the same backup again');
  countMarkers=undefined;
  await back();
  refusal = {route:'list_folder',path:'/backups',status:403,error:{'.tag':'no_permission'}};
  await open('recovery');
  await expectStatus('Could not list Dropbox backups',/denied permission/i);
  refusal = undefined;
  await browser.click('[data-refresh]');
  await browser.waitFor('document.querySelector("[data-folder]")');
  refusal = {route:'download',path:'/backups/'+firstBackup+'/watched.csv',status:503};
  await browser.click('[data-folder="'+firstBackup+'"]');
  await expectStatus('Could not read the Dropbox backup',/server error/i);
  refusal = undefined;
  await browser.click('[data-refresh]');
  await selectWatched();
  await back();
  assert.deepEqual(revisions(),beforeRestore,'Back changed a reviewed backup or the live record');
  await open('recovery');
  await selectWatched();
  refusal = {route:'create_folder_v2',path:'/backups',status:409,error:{'.tag':'path',path:{'.tag':'insufficient_space'}}};
  await browser.click('[data-restore]');
  await browser.waitFor('document.querySelector("[data-result]")?.textContent.includes("watched.csv — Not restored.")','failed restore has file outcome');
  const failed = await browser.evaluate('document.querySelector("[data-result]").textContent');
  assert.match(failed,/Dropbox storage is full/);
  assert.doesNotMatch(failed,/private-diagnostic/);
  assert.deepEqual(revisions(),beforeRestore,'A failed prerequisite backup must leave the record untouched');
  assert.equal(await browser.evaluate(reportHasPlays(5)),true,'The failed restore changed the report');
  refusal = undefined;
  await browser.click('[data-refresh]');
  await selectWatched();
  await browser.click('[data-restore]');
  await browser.waitFor('document.querySelector("[data-result]")?.textContent.includes("Restore complete.")','restore completion');
  const outcome = await browser.evaluate('document.querySelector("[data-result]").textContent');
  assert.match(outcome,/watched\.csv — Restored\./);
  assert.doesNotMatch(outcome,/ratings\.csv|lists\.csv/);
  await browser.waitFor(synced,'post-restore sync');
  verifyRemote(restored);
  await browser.waitFor(reportHasPlays(2),'restored plays in the open Statistics report');
  await browser.close();
  browser = await start();
  await browser.navigate(settings);
  await browser.waitFor(synced+' && document.querySelector("[data-backup]:enabled")','reopened record synced');
  const stored = await browser.evaluate(`(async () => {
    const {openDeviceStore} = await import('/storage.js'); const store = await openDeviceStore();
    try { const {tables:{watched,ratings,lists}} = await store.snapshot(); return {watched,ratings,lists}; }
    finally { store.close(); }
  })()`);
  assert.deepEqual(sortRecord(stored),restored);
  verifyRemote(restored);
});
