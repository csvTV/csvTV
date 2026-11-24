import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRelease} from '../package-release.mjs';
import {readCsv,writeCsv} from '../dist/csv.js';
import {openChromium} from './offline-chromium.mjs';
import {linkFixture,offlineProviders} from './offline-providers.mjs';
import {listen,stop} from './offline-site.mjs';
import {releaseServer,unpack} from './release-site.mjs';

for(const firstCopy of [false,true]) test(firstCopy ? 'shipped season controls review an interrupted first watch file after an offline correction' :
  'shipped season controls recover a lost Dropbox reply after restart, with cancel, a season choice and an episode override',
  {timeout:90_000},async t=>{
    const {bytes}=await createRelease(new URL('../dist/',import.meta.url));
    const server=releaseServer(await unpack(bytes)),origin='http://127.0.0.1:'+await listen(server);
    const site=offlineProviders(origin),profiles=await Promise.all([1,2].map(()=>mkdtemp(join(tmpdir(),'csvtv-watch-review-'))));
    let browser,interrupt=false,observed=false;
    t.after(async()=>{
      try {await browser?.close(); await stop(server);}
      finally {await Promise.all(profiles.map(profile=>rm(profile,{recursive:true,force:true,maxRetries:7,retryDelay:180})));}
    });
    const start=profile=>openChromium(profile,async(event,send)=>{
      const {request,requestId}=event,url=new URL(request.url);
      if (interrupt && request.method==='POST' && url.pathname==='/2/files/upload') {
        const arg=new Headers(request.headers).get('Dropbox-API-Arg');
        if (arg && JSON.parse(arg).path==='/watched.csv') {
          interrupt=false;
          // The service accepts the contents; the connection drops before the response reaches the app.
          return site.respond(event,async(_action,reply)=>{
            assert.equal(reply.responseCode,200);
            observed=true;
            if(firstCopy)site.state.online=false;
            await send('Fetch.failRequest',{requestId,errorReason:'ConnectionClosed'});
          });
        }
      }
      return site.respond(event,send);
    });
    const syncReady='document.querySelector(".sync-state")?.dataset.synced === "true"';
    const cloudCounts=()=>readCsv('watched',site.files.get('/watched.csv').bytes).rows.map(row=>row.times_watched);
    const show={show:'The Listening House',show_id:45};
    const watched=[1,2].map(episode=>({...show,season:1,episode,episode_id:45010+episode,title:'Recording '+episode,times_watched:1}));
    if(!firstCopy)await site.upload('watched.csv',writeCsv('watched',watched));
    await site.settings({tmdb_key:'fictional-offline-key'});
    browser=await start(profiles[0]);
    await linkFixture(browser,origin,'/');
    await browser.navigate(origin+'/#/settings');
    await browser.waitFor(syncReady);
    await browser.navigate(origin+'/#/show/45');
    await browser.waitFor('document.querySelector(".show-season-add:not(:disabled)")');
    interrupt=true;
    await browser.click('.show-season-add');
    await browser.waitFor(`(async()=>{
      const {openDeviceStore}=await import('/storage.js'),s=await openDeviceStore();
      try {return !!(await s.snapshot()).sync.watched?.pending && (await s.dropboxState()).status?.reason.includes('unknown outcome');}
      finally{s.close();}
    })()`,'unconfirmed delivery saved for the next browser session');
    assert.ok(observed); assert.deepEqual(cloudCounts(),firstCopy?[1,1]:[2,2]);
    if(firstCopy) {
      await browser.offline(true);
      await browser.click('.show-season-count');
      await browser.click('.season-count-form [data-decrease]');
      await browser.click('.season-count-form [type=submit]');
      await browser.waitFor('document.querySelector(".show-season-count")?.textContent==="0×"');
    }
    site.state.online=true;
    await browser.close(); browser=await start(profiles[0]);
    await browser.navigate(origin+'/#/settings');
    const dialog='dialog:modal',summary=dialog+' summary';
    const offered=firstCopy?'0 or 1 play':'2 or 3 plays';
    await browser.waitFor('document.querySelector("'+summary+'")?.textContent.includes("'+offered+'")');
    await browser.press('Escape');
    await browser.waitFor('!document.querySelector("dialog:modal")');
    await browser.click('[data-sync]');
    await browser.waitFor('!!document.querySelector("'+summary+'")');
    await browser.evaluate('document.querySelector("dialog:modal select").focus()');
    await browser.press('End');
    assert.equal(await browser.evaluate('document.querySelector("dialog:modal select").value'),'two');
    await browser.evaluate('document.querySelector("dialog:modal summary").focus()');
    await browser.press('Enter');
    await browser.waitFor('document.querySelectorAll("dialog:modal fieldset").length === 2');
    await browser.click('dialog:modal fieldset:first-of-type label:nth-child(2) input'); // First episode once.
    const button=firstCopy?'Shared copy':'One change';
    await browser.evaluate('[...document.querySelectorAll("dialog:modal button")].find(b=>b.textContent==="'+button+'").focus()');
    await browser.press('Enter');
    await browser.waitFor(syncReady);
    assert.deepEqual(cloudCounts(),firstCopy?[1]:[2,3]);
    await browser.close(); browser=await start(profiles[1]);
    await linkFixture(browser,origin,'/');
    await browser.navigate(origin+'/#/settings');
    await browser.waitFor(syncReady);
    await browser.navigate(origin+'/#/library');
    await browser.click('.library-screen a[href="#/show/45"]');
    await browser.click('[data-season="1"]');
    const expected=firstCopy?'["0×","1×"]':'["2×","3×"]';
    await browser.waitFor('JSON.stringify([...document.querySelectorAll(".episode-row .episode-count")].map(e=>e.textContent)) === \''+expected+'\'',
      'both chosen episode counts restored in a separate empty profile');
  });

for(const intervening of [true,false]) test('a cold Ratings reopen keeps the peer score ' +
  (intervening ? 'when the matching revision followed an intervening update' : 'after reviewing the two possible matching updates'),
  {timeout:90_000},async t=>{
  const {bytes}=await createRelease(new URL('../dist/',import.meta.url));
  const server=releaseServer(await unpack(bytes)),origin='http://127.0.0.1:'+await listen(server);
  const site=offlineProviders(origin),profiles=await Promise.all([1,2].map(()=>mkdtemp(join(tmpdir(),'csvtv-score-recovery-'))));
  let browser,loseNext=false;
  const lostRequest=Promise.withResolvers();
  t.after(async()=>{
    try {await browser?.close(); await stop(server);}
    finally {await Promise.all(profiles.map(profile=>rm(profile,{recursive:true,force:true,maxRetries:7,retryDelay:180})));}
  });
  const start=profile=>openChromium(profile,async(event,send)=>{
    const {request,requestId}=event,arg=new Headers(request.headers).get('Dropbox-API-Arg');
    if (loseNext && request.method==='POST' && new URL(request.url).pathname==='/2/files/upload' && arg) {
      const options=JSON.parse(arg);
      if (options.path==='/ratings.csv') {
        loseNext=false; site.state.online=false; lostRequest.resolve(options.client_modified);
        return send('Fetch.failRequest',{requestId,errorReason:'ConnectionClosed'});
      }
    }
    return site.respond(event,send);
  });
  const csv=rating=>writeCsv('ratings',[{show_id:45,show:'The Listening House',rating}]);
  const synced='document.querySelector(".sync-state")?.dataset.synced==="true"';
  async function choose(value) {
    await browser.evaluate('document.querySelector(".rating-edit:enabled").focus()');
    await browser.waitFor('Array.from(document.querySelector(".rating-edit")?.options ?? []).some(option=>option.value==="'+value+'")');
    await browser.evaluate('(()=>{const score=document.querySelector(".rating-edit");score.value="'+value+
      '";score.dispatchEvent(new Event("change",{bubbles:true}));})()');
    await browser.waitFor('document.querySelector(".undo-bar:not([hidden])") && document.querySelector(".rating-edit:enabled")?.value==="'+value+'"');
  }
  await site.upload('ratings.csv',csv(7)); await site.settings({tmdb_key:'fictional-offline-key'});
  browser=await start(profiles[0]);
  await browser.send('Emulation.setFocusEmulationEnabled',{enabled:true});
  await linkFixture(browser,origin,'/');
  await browser.navigate(origin+'/#/ratings'); await browser.waitFor(synced);
  await browser.waitFor('document.querySelector(".rating-edit:enabled")?.value==="7"');
  loseNext=true; await choose(8);
  await browser.navigate(origin+'/#/settings'); await browser.click('[data-sync]');
  await browser.waitFor(`(async()=>{
    const {openDeviceStore}=await import('/storage.js'),s=await openDeviceStore();
    try {return !!(await s.snapshot()).sync.ratings?.pending;}
    finally{s.close();}
  })()`,'durable unacknowledged rating');
  const submittedTime=await lostRequest.promise;
  assert.ok(submittedTime);
  await browser.offline(true);
  await browser.click('.app-sidebar a[href="#/ratings"]');
  await browser.waitFor('document.querySelector(".rating-edit:enabled")?.value==="8"');
  await choose(7);
  await browser.close(); browser=undefined;
  if(intervening)await site.upload('ratings.csv',csv(9));
  await site.upload('ratings.csv',csv(8),submittedTime);
  const peerRevision=site.files.get('/ratings.csv').meta.rev;
  site.state.online=true;
  for (const [index,profile] of profiles.entries()) {
    browser=await start(profile);
    if (index===1) await linkFixture(browser,origin,'/');
    await browser.navigate(origin+'/#/settings');
    if(!intervening && index===0) {
      const dialog='document.querySelector("dialog:modal")';
      await browser.waitFor(dialog+'?.innerText.includes("Choose which ratings to keep")');
      const alternatives=await browser.evaluate(dialog+'.innerText');
      for(const text of ['The Listening House','This device’s upload · 7/10','Separate change · 8/10'])assert.ok(alternatives.includes(text),text);
      await browser.press('Escape');
      await browser.waitFor('!'+dialog+' && document.querySelector("[data-sync]:enabled")');
      assert.equal(site.files.get('/ratings.csv').meta.rev,peerRevision);
      await browser.click('[data-sync]');
      await browser.waitFor(dialog+'?.innerText.includes("Choose which ratings to keep")');
      await browser.evaluate('[...document.querySelectorAll("dialog:modal .actions button")].find(b=>b.textContent==="Separate change").focus()');
      await browser.press('Enter');
    }
    await browser.waitFor(synced);
    await browser.click('.app-sidebar a[href="#/ratings"]');
    await browser.waitFor('document.querySelector(".rating-edit:enabled")?.value==="8"','peer rating in profile '+index);
    assert.equal(site.files.get('/ratings.csv').meta.rev,peerRevision);
    await browser.close(); browser=undefined;
  }
});
