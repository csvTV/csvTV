import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {releaseServer,unpack} from './release-site.mjs';
import {listen,stop} from './offline-site.mjs';
import {until} from './offline-chromium.mjs';
import {openWindowsFirefox} from './windows-firefox.mjs';

// Firefox retains a failed module load for one document, even when its server recovers.
const archive=process.env.CSVTV_WINDOWS_AUDIT_ZIP ?? new URL('../release/csvTV.zip',import.meta.url);
const failures=new Map([['/trakt-import-screen.js',0],['/anilist-import-screen.js',0]]);
const server=releaseServer(await unpack(await readFile(archive)),(req,res)=>{
  const path=new URL(req.url,'http://localhost').pathname;
  if (path==='/service-worker.js') {
    // Exercise first use before the offline worker provides a full installed copy.
    res.writeHead(404).end(); return true;
  }
  if (path==='/fixture') {
    res.writeHead(200,{'Content-Type':'text/html'}).end('<!doctype html><title>Fictional account setup</title>'); return true;
  }
  if (failures.has(path)) {
    const count=failures.get(path); failures.set(path,count+1);
    if (!count) { res.writeHead(503,{'Cache-Control':'no-store'}).end(); return true; }
  }
  return false;
});
const origin='http://127.0.0.1:'+await listen(server),profile=await mkdtemp(join(tmpdir(),'csvtv-firefox-import-'));
let browser;
try {
  browser=await openWindowsFirefox(profile);
  await browser.navigate(origin+'/fixture');
  await browser.evaluate('('+(async function() {
    const {openDeviceStore}=await import('/storage.js'),store=await openDeviceStore();
    try {
      await store.whenWriter();
      await store.commit((await store.snapshot()).revision,{local:{syncAccountId:'fictional-import-recovery'}});
    } finally { await store.closeForUpdate(); }
  })+')()');
  const wait = (expression,label) => until(()=>browser.evaluate(expression).catch(()=>false),label);
  const click = selector => browser.evaluate('document.querySelector('+JSON.stringify(selector)+').click()');
  const reloadButton='[...document.querySelectorAll("main button")].find(button=>button.textContent==="Reload csvTV")';
  await browser.navigate(origin+'/#/settings');
  await wait('!!document.querySelector(".settings-imports a")','Settings import links');
  await click('.settings-imports a[href="#/trakt-import"]');
  await wait('!!('+reloadButton+')','failed Trakt module offers Reload');
  await click('.desktop-back');
  await wait('location.hash==="#/settings" && !!document.querySelector(".settings-imports a")','Back from a failed import');
  await click('.settings-imports a[href="#/anilist-import"]');
  await wait('!!('+reloadButton+')','failed AniList module offers Reload');
  await browser.evaluate('setTimeout(()=>('+reloadButton+').click(),0)');
  await wait('location.hash==="#/anilist-import" && !!document.querySelector(".anilist-import input[type=file]")','reloaded AniList file picker');
  assert.equal(await browser.evaluate('performance.getEntriesByType("navigation")[0].type'),'reload');
  await click('.desktop-back');
  await wait('!!document.querySelector(".settings-imports a")','Back after successful reload');
  await click('.settings-imports a[href="#/trakt-import"]');
  await wait('!!document.querySelector(".trakt-import input[type=file]")','Trakt file picker on the recovered document');
  assert.deepEqual([...failures.values()],[2,2]);
  console.log('Firefox '+browser.version+' passed one-time HTTP 503, Back and reload; build '+
    await browser.evaluate('document.querySelector(\'meta[name="csvtv-build"]\').content'));
} finally {
  try { await browser?.close(); } finally {
    await stop(server); await rm(profile,{recursive:true,force:true,maxRetries:8,retryDelay:150});
  }
}
