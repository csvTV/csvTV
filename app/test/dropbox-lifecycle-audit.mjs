// Opt-in elapsed-time audit. Run separately from the acceptance suite.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createRelease} from '../package-release.mjs';
import {readCsv,writeCsv} from '../dist/csv.js';
import {connectFictionalDropbox,releaseWithDropbox} from './browser-dropbox-site.mjs';
import {linkFixture,offlineProviders} from './offline-providers.mjs';
import {listen,stop} from './offline-site.mjs';
import {unpack} from './release-site.mjs';

const minutes = Number(process.argv[2] ?? 270), interval = Number(process.argv[3] ?? 15);
const mode = process.argv[4] ?? 'handoff';
assert.ok(Number.isFinite(minutes) && minutes>0 && minutes<=720);
assert.ok(Number.isFinite(interval) && interval>0 && interval<=minutes);
assert.ok(['handoff','offline-idle'].includes(mode));
const engine = process.argv[5] ?? 'chromium';
assert.ok(['chromium','webkit'].includes(engine));
assert.ok(mode!=='offline-idle' || engine==='chromium','The two-profile offline-idle exercise uses Chromium network isolation.');
const browsers = createRequire(import.meta.url)(process.env.CSVTV_PLAYWRIGHT_MODULE || 'playwright-core');
const release = await createRelease(new URL('../dist/',import.meta.url));
const assets = await unpack(release.bytes);
let provider, context, page, renewals = 0, runs = 0, score = 7;
const site = releaseWithDropbox(assets,()=>provider);
const port = await listen(site), origin = 'http://127.0.0.1:'+port;
const profile = await mkdtemp(join(tmpdir(),'csvtv-lifecycle-'));
const start = Date.now(), deadline = start+minutes*60000;
const cloudScore = () => readCsv('ratings',provider.files.get('/ratings.csv').bytes).rows[0]?.rating;
const synced = page => page.waitForFunction(()=>document.querySelector('.sync-state')?.dataset.synced==='true');
const shown = (page,value) => page.waitForFunction(value=>document.querySelector('.rating-edit')?.value===String(value),value);
async function openContext(directory) {
  const browser = await browsers[engine].launchPersistentContext(directory,{...(engine==='chromium'?{channel:'chrome'}:{}),headless:true,viewport:{width:1280,height:800},
    proxy:{server:origin,bypass:'127.0.0.1,localhost'}});
  await connectFictionalDropbox(browser);
  return browser;
}
async function open() {
  context = await openContext(profile);
  page = context.pages()[0];
}
function progress(phase) {
  console.log(JSON.stringify({utc:new Date().toISOString(),build:release.build,engine,mode,minutes:(Date.now()-start)/60000,runs,score,renewals,phase}));
}
async function cycle() {
  const reader = await context.newPage();
  await reader.goto(origin+'/#/ratings');
  await reader.waitForFunction(()=>document.querySelector('.tab-state')?.textContent.includes('read-only') && document.querySelector('.rating-edit')?.disabled);
  await shown(reader,score);
  await page.close();
  page = reader;
  await page.waitForFunction(()=>document.querySelector('.rating-edit') && !document.querySelector('.rating-edit').disabled);

  provider.state.online = false;
  // WebKit's offline emulation can reject navigation before its service worker runs.
  if (engine==='webkit') await stop(site); else await context.setOffline(true);
  const next = score===7 ? 8.5 : 7;
  await page.locator('.rating-edit').focus();
  await page.locator('.rating-edit').selectOption(String(next));
  await page.waitForFunction(()=>document.querySelector('.undo-bar:not([hidden])') && !document.querySelector('.rating-edit').disabled);
  assert.equal(cloudScore(),score);
  await context.close(); context = undefined;
  await open();
  if (engine!=='webkit') await context.setOffline(true);
  await page.goto(origin+'/#/ratings');
  await shown(page,next);
  if (engine==='webkit') {
    assert.equal(await page.evaluate(()=>fetch('/fictional-network-probe.txt',{cache:'no-store'}).then(()=>false,()=>true)),true);
  } else assert.equal(await page.evaluate(()=>navigator.onLine),false);
  assert.equal(cloudScore(),score);
  provider.state.online = true;
  if (engine==='webkit') await listen(site,port); else await context.setOffline(false);
  await page.goto(origin+'/#/settings');
  await synced(page);
  await page.waitForFunction(()=>document.querySelector('[data-offline-status]')?.textContent==='Ready to open offline.');
  assert.equal(cloudScore(),next);
  score = next;
  runs++;
  await page.goto(origin+'/#/ratings');
  await shown(page,score);
  progress('verified writer handoff, offline edit, cold reopen and sync');
}
async function offlineIdle() {
  const peerProfile = await mkdtemp(join(tmpdir(),'csvtv-lifecycle-peer-'));
  let peer;
  const values = page => page.locator('.rating-edit').evaluateAll(fields=>Object.fromEntries(fields.map(field=>[field.closest('li').querySelector('strong').textContent,Number(field.value)])));
  const expected = (local,remote) => ({'The Listening House':local,'Fictional Evening':remote});
  const remoteValues = () => Object.fromEntries(readCsv('ratings',provider.files.get('/ratings.csv').bytes).rows.map(row=>[row.show,row.rating]));
  const change = async (page,title,score) => {
    const editor = page.locator('.ratings-rows li').filter({hasText:title}).locator('.rating-edit');
    await editor.focus();
    await editor.selectOption(String(score));
    await page.locator('.undo-bar:not([hidden])').waitFor();
  };
  try {
    await context.setOffline(true);
    await change(page,'The Listening House',8.5);
    assert.deepEqual(await values(page),expected(8.5,6));
    assert.deepEqual(remoteValues(),expected(7,6));
    peer = await openContext(peerProfile);
    const other = peer.pages()[0];
    await linkFixture({navigate:url=>other.goto(url),evaluate:script=>other.evaluate(script)},origin,'/');
    await other.goto(origin+'/#/ratings');
    await synced(other);
    await change(other,'Fictional Evening',9);
    await other.goto(origin+'/#/settings');
    await synced(other);
    assert.deepEqual(remoteValues(),expected(7,9));
    await peer.close(); peer = undefined;
    const offlineStart = Date.now(), reconnect = offlineStart+minutes*60000;
    let reopened = false, nextAt = offlineStart;
    while (nextAt<reconnect) {
      nextAt = Math.min(nextAt+interval*60000,reconnect);
      await delay(Math.max(0,nextAt-Date.now()));
      if (!reopened && Date.now()-offlineStart>=minutes*30000) {
        await context.close(); context = undefined;
        await open();
        await context.setOffline(true);
        await page.goto(origin+'/#/ratings');
        await page.waitForFunction(()=>document.querySelectorAll('.rating-edit').length===2);
        reopened = true;
      }
      assert.equal(await page.evaluate(()=>navigator.onLine),false);
      assert.deepEqual(await values(page),expected(8.5,6));
      assert.deepEqual(remoteValues(),expected(7,9));
      assert.equal(renewals,0);
      runs++;
      progress(reopened ? 'offline edits intact after cold reopen' : 'independent device edits remain separate');
    }
    await context.setOffline(false);
    await page.goto(origin+'/#/settings');
    await synced(page);
    await page.goto(origin+'/#/ratings');
    await page.waitForFunction(()=>document.querySelectorAll('.rating-edit').length===2);
    assert.deepEqual(await values(page),expected(8.5,9));
    assert.deepEqual(remoteValues(),expected(8.5,9));
    peer = await openContext(peerProfile);
    const otherReopened = peer.pages()[0];
    await otherReopened.goto(origin+'/#/settings');
    await synced(otherReopened);
    await otherReopened.goto(origin+'/#/ratings');
    // A clean peer can briefly show the status of its previous sync on cold start.
    await otherReopened.waitForFunction(()=>[...document.querySelectorAll('.rating-edit')].some(field=>field.value==='8.5'));
    assert.deepEqual(await values(otherReopened),expected(8.5,9));
    score = 8.5;
  } finally {
    try { await peer?.close(); }
    finally { await rm(peerProfile,{recursive:true,force:true,maxRetries:8,retryDelay:150}); }
  }
}
try {
  provider = offlineProviders(origin,form=>{
    assert.equal(form.get('refresh_token'),'example-refresh');
    renewals++;
    return {access_token:'example-access',token_type:'bearer',expires_in:14400};
  });
  const ratings = [{show_id:45,show:'The Listening House',rating:score}];
  if (mode==='offline-idle') ratings.push({show_id:46,show:'Fictional Evening',rating:6});
  await provider.upload('ratings.csv',writeCsv('ratings',ratings));
  await open();
  await linkFixture({navigate:url=>page.goto(url),evaluate:script=>page.evaluate(script)},origin,'/');
  await page.goto(origin+'/#/settings');
  await synced(page);
  await page.waitForFunction(()=>document.querySelector('[data-offline-status]')?.textContent==='Ready to open offline.');
  await page.goto(origin+'/#/ratings');
  await shown(page,score);
  if (mode==='offline-idle') await offlineIdle();
  else {
    let nextAt = start;
    for (;;) {
      await cycle();
      if (Date.now()>=deadline) break;
      nextAt = Math.min(nextAt+interval*60000,deadline);
      await delay(Math.max(0,nextAt-Date.now()));
    }
  }
  if (minutes>=241) assert.ok(renewals>=1,'The normal four-hour access token should have renewed.');
  if (mode==='handoff' && minutes>=480+interval+1) assert.ok(renewals>=2,'The replacement four-hour access token should also have renewed.');
  progress('completed');
} finally {
  try { await context?.close(); await stop(site); }
  finally { await rm(profile,{recursive:true,force:true,maxRetries:8,retryDelay:150}); }
}
