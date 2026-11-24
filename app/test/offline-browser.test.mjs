import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { openChromium, until } from './offline-chromium.mjs';
import { linkFixture, offlineProviders, renewFixture } from './offline-providers.mjs';
import { readCsv } from '../dist/csv.js';
import { testSite, listen, stop, privateMarker } from './offline-site.mjs';
import { createRelease } from '../package-release.mjs';
import { releaseServer, unpack } from './release-site.mjs';

test('a broken installed bookmark can use a complete waiting release offline after another tab finishes', {timeout:90000}, async t => {
  const site = await testSite({oauth:true}), origin = 'http://127.0.0.1:'+await listen(site.server);
  const profile = await mkdtemp(join(tmpdir(),'csvtv-waiting-recovery-'));
  let browser;
  t.after(async () => {
    try { await browser?.close(); } finally { await stop(site.server); await rm(profile,{recursive:true,force:true,maxRetries:8,retryDelay:150}); }
  });
  browser = await openChromium(profile,offlineProviders(origin).respond);
  await browser.navigate(origin+'/fixture');
  await browser.evaluate('('+seedDevice.toString()+')()');
  const route = origin+'/tracker/#/library';
  const title = 'document.querySelector(\'[data-library-show="45"] strong\')?.textContent';
  await browser.navigate(route);
  await browser.waitFor(title+' === "The Listening House" && !!navigator.serviceWorker.controller','installed fictional Library');
  await browser.evaluate("window.otherTab=window.open(location.href,'csvtv-recovery-neighbor');true");
  await browser.waitFor('otherTab?.document.querySelector("main input[type=search]")','second tab with an editable search');
  await browser.evaluate("otherTab.document.querySelector('main input[type=search]').value='unsent search';true");
  site.publishDocument(); site.publishWorker();
  await browser.evaluate('navigator.serviceWorker.getRegistration().then(r=>r.update()).then(()=>true)');
  await browser.waitFor('navigator.serviceWorker.getRegistration().then(r=>!!r.waiting)','complete waiting release');
  const oldCache = 'csvTV:shell:'+origin+'/tracker/:'+site.manifest.build;
  assert.equal(await browser.evaluate('caches.open('+JSON.stringify(oldCache)+').then(c=>c.delete(location.origin+"/tracker/main.js"))'),true);
  await stop(site.server);
  await browser.offline(true);
  await browser.send('Page.reload');
  const retry = 'document.querySelector("#app > button")';
  await browser.waitFor(retry+'?.textContent === "Try again"','unavailable old entry');
  await browser.evaluate(retry+'.focus()');
  await browser.press('Enter');
  await browser.waitFor('document.querySelector("[data-opening]")?.textContent.includes("Close other csvTV tabs") && !'+retry+'?.disabled','other tab preserved');
  assert.equal(await browser.evaluate("window.otherTab=window.open('','csvtv-recovery-neighbor');otherTab.document.querySelector('main input[type=search]').value"),'unsent search');
  await browser.evaluate('otherTab.close();true');
  await browser.evaluate(retry+'.focus()');
  await browser.press('Enter');
  await browser.waitFor('document.querySelector("meta[name=csvtv-build]").content === '+JSON.stringify(site.nextBuild)+' && '+title+' === "The Listening House"','waiting release and unchanged offline record');
  assert.equal(await browser.evaluate('location.href'),route);
});

test('a failed startup dependency can be retried by keyboard on the original bookmark', {timeout:60000}, async t => {
  const {bytes} = await createRelease(new URL('../dist/',import.meta.url));
  let available = false;
  const server = releaseServer(await unpack(bytes),(req,res) => {
    if (available || req.url !== '/application.js') return false;
    res.writeHead(503,{'Cache-Control':'no-store'}).end();
    return true;
  });
  const origin = 'http://127.0.0.1:' + await listen(server);
  const profile = await mkdtemp(join(tmpdir(),'csvtv-first-visit-'));
  let browser;
  t.after(async () => {
    try { await browser?.close(); } finally { await stop(server); await rm(profile,{recursive:true,force:true,maxRetries:8,retryDelay:150}); }
  });
  browser = await openChromium(profile);
  await browser.navigate(origin+'/#/library');
  const status = 'document.querySelector("#app > [data-opening]")?.textContent';
  const retry = 'document.querySelector("#app > button")';
  await browser.waitFor(status+'?.includes("could not load")','startup failure');
  await browser.evaluate(retry+'.focus()');
  await browser.press('Enter');
  await browser.waitFor(status+'?.includes("still unavailable") && !'+retry+'?.disabled','ready to retry after another unavailable response');
  available = true;
  await browser.press('Enter');
  await browser.waitFor('document.querySelector("main h1")?.textContent === "Connect Dropbox"','recovered app');
  assert.equal(await browser.evaluate('location.hash'),'#/library');
});

test('first connection works before the record tools download and a failed tools download can recover on reload', {timeout:60000}, async t => {
  const {bytes} = await createRelease(new URL('../dist/',import.meta.url));
  const requested = new Set();
  let refuse = true;
  const server = releaseServer(await unpack(bytes),(req,res) => {
    requested.add(req.url);
    if (req.url !== '/dropbox-file-operations.js' || !refuse) return false;
    res.writeHead(503,{'Cache-Control':'no-store'}).end();
    return true;
  });
  const origin = 'http://127.0.0.1:'+await listen(server);
  const profile = await mkdtemp(join(tmpdir(),'csvtv-first-connection-'));
  const provider = offlineProviders(origin);
  await provider.settings({});
  let browser;
  t.after(async () => {
    try { await browser?.close(); } finally { await stop(server); await rm(profile,{recursive:true,force:true,maxRetries:8,retryDelay:150}); }
  });
  browser = await openChromium(profile,provider.respond);
  // Isolate what the active document loads from the offline installer's intentional background download.
  await browser.send('Page.addScriptToEvaluateOnNewDocument',{source:"Object.defineProperty(navigator,'serviceWorker',{value:undefined});"});
  await browser.navigate(origin+'/#/home');
  await browser.waitFor('document.querySelector("main h1")?.textContent==="Connect Dropbox"');
  await browser.click('[data-dropbox-help]');
  await browser.waitFor('document.querySelector("dialog[open] code")?.textContent===location.origin+"/"');
  await browser.press('Escape');
  await browser.click('[data-edit-client]');
  await browser.evaluate('const input=document.querySelector("input[name=appKey]");input.value="fictional-browser-registration";input.form.requestSubmit();');
  await browser.waitFor('!document.querySelector("[data-sign-in]").disabled');
  for (const name of ['record-screens','dropbox-file-operations','dropbox-backup','dropbox-sync','dropbox-reset','export-data']) {
    assert.ok(!requested.has('/'+name+'.js'),name+' loaded before a record was linked');
  }
  await linkFixture(browser,origin,'/');
  await browser.navigate(origin+'/#/settings');
  await browser.waitFor('document.querySelector(".sync-state")?.title?.includes("Dropbox tools could not load") || document.querySelector("[data-cloud-reason]")?.textContent?.includes("Dropbox tools could not load")','a failed tool download gives recovery guidance');
  refuse = false;
  await browser.send('Page.reload');
  await browser.waitFor('document.querySelector(".sync-state")?.dataset.synced==="true"','reload recovers the linked record');
});

test('Back works during the first linked screen download and the old route cannot replace Settings', {timeout:60000}, async t => {
  const {bytes}=await createRelease(new URL('../dist/',import.meta.url));
  const gate=Promise.withResolvers(), requested=Promise.withResolvers();
  const server=releaseServer(await unpack(bytes),async req=>{
    if (req.url==='/settings-screens.js') { requested.resolve(); await gate.promise; }
    return false;
  });
  const origin='http://127.0.0.1:'+await listen(server), profile=await mkdtemp(join(tmpdir(),'csvtv-linked-route-'));
  let browser;
  t.after(async()=>{
    gate.resolve();
    try { await browser?.close(); } finally { await stop(server); await rm(profile,{recursive:true,force:true,maxRetries:8,retryDelay:150}); }
  });
  const provider=offlineProviders(origin);await provider.settings({});
  browser=await openChromium(profile,provider.respond);
  await browser.send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
  await browser.send('Page.addScriptToEvaluateOnNewDocument',{source:"Object.defineProperty(navigator,'serviceWorker',{configurable:true,value:undefined});"});
  await linkFixture(browser,origin,'/');
  const result=await browser.send('Page.navigate',{url:origin+'/#/imdb-ratings'});
  assert.equal(result.errorText,undefined);
  await requested.promise;
  await browser.waitFor('document.querySelector("main h1")?.textContent==="IMDb ratings" && document.querySelector(".desktop-back")','linked route placeholder');
  await browser.evaluate('document.querySelector(".desktop-back").focus()');await browser.press('Enter');
  await browser.waitFor('location.hash==="#/settings" && document.querySelector("main h1")?.textContent==="Settings"','back before the download');
  gate.resolve();
  await browser.waitFor('document.querySelector("#settings-services") && document.querySelector("main h1")?.textContent==="Settings"','Settings mounted after download');
  assert.equal(await browser.evaluate('document.querySelectorAll("#settings-services").length'),1);
});

test('links to a Settings control respect keyboard focus during its first download', {timeout:90000}, async t => {
  const {bytes}=await createRelease(new URL('../dist/',import.meta.url));
  const files=await unpack(bytes);
  for (const [route,moveFocus] of [['trakt-import',false],['anilist-import',true],['library',false]]) {
    await t.test(route,async t=>{
      const gate=Promise.withResolvers(),requested=Promise.withResolvers();
      const server=releaseServer(files,async req=>{
        if (req.url==='/settings-screens.js') {requested.resolve();await gate.promise;}
        return false;
      });
      const origin='http://127.0.0.1:'+await listen(server),profile=await mkdtemp(join(tmpdir(),'csvtv-import-key-'));
      let browser;
      t.after(async()=>{
        gate.resolve();
        try {await browser?.close();} finally {await stop(server);await rm(profile,{recursive:true,force:true,maxRetries:8,retryDelay:150});}
      });
      const provider=offlineProviders(origin);await provider.settings({});
      browser=await openChromium(profile,provider.respond);
      await browser.send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
      await browser.send('Page.addScriptToEvaluateOnNewDocument',{source:"Object.defineProperty(navigator,'serviceWorker',{value:undefined});"});
      const signedOut=route==='library';
      await linkFixture(browser,origin,'/',signedOut);
      if(signedOut)await browser.evaluate(`(async()=>{
        const {openDeviceStore}=await import('/storage.js'),store=await openDeviceStore();
        try {await store.whenWriter();await store.commit((await store.snapshot()).revision,{removeLocal:['dropboxSession']});}
        finally {await store.closeForUpdate();}
        localStorage.removeItem('csvTV-public-dropbox-app-key');
      })()`);
      await browser.navigate(origin+'/#/'+route);
      const action=signedOut?'.app-sidebar [data-cloud-sign]:not([hidden]):enabled':'[data-settings]';
      await browser.waitFor(signedOut?'document.querySelector('+JSON.stringify(action)+')':
        'document.querySelector("[data-block]")?.innerText.includes("Add a TMDB key")');
      await browser.evaluate('document.querySelector('+JSON.stringify(action)+').focus()');await browser.press('Enter');
      await browser.waitFor('location.hash==="#/settings" && document.activeElement===document.querySelector("main")');
      await requested.promise;
      const nav='.app-sidebar [data-destination=library]';
      if(moveFocus)await browser.evaluate('document.querySelector('+JSON.stringify(nav)+').focus()');
      gate.resolve();
      await browser.waitFor('document.querySelector("#settings-services #tmdb-key-label")');
      const expected=moveFocus?nav:signedOut?'#dropbox-label':'#tmdb-key-label';
      assert.equal(await browser.evaluate('document.activeElement===document.querySelector('+JSON.stringify(expected)+')'),true);
      if(signedOut){
        await browser.evaluate('document.querySelector('+JSON.stringify(action)+').focus()');await browser.press('Enter');
        await browser.waitFor('document.activeElement.id==="dropbox-label"','sign-in on Settings focuses the same control');
      }
    });
  }
});

for (const issue of ['unavailable','from an earlier release']) test('a Library bookmark loads its own screens and a Ratings module '+issue+' can recover by keyboard', {timeout:60000}, async t => {
  const {bytes} = await createRelease(new URL('../dist/',import.meta.url));
  const requested = new Set();
  let refuse = true;
  const server = releaseServer(await unpack(bytes),(req,res) => {
    requested.add(req.url);
    if (!refuse || req.url !== '/catalog-screens.js') return false;
    if (issue === 'unavailable') res.writeHead(503,{'Cache-Control':'no-store'}).end();
    else res.writeHead(200,{'Content-Type':'text/javascript','Cache-Control':'no-store'}).end('export const earlierCatalog = true;');
    return true;
  });
  const origin = 'http://127.0.0.1:'+await listen(server), profile = await mkdtemp(join(tmpdir(),'csvtv-library-bookmark-'));
  let browser;
  t.after(async () => {
    try { await browser?.close(); } finally { await stop(server); await rm(profile,{recursive:true,force:true,maxRetries:8,retryDelay:150}); }
  });
  const provider = offlineProviders(origin); await provider.settings({});
  browser = await openChromium(profile,provider.respond);
  await browser.send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
  await browser.send('Page.addScriptToEvaluateOnNewDocument',{source:"Object.defineProperty(navigator,'serviceWorker',{value:undefined});"});
  await linkFixture(browser,origin,'/');
  await browser.navigate(origin+'/#/library');
  await browser.waitFor('document.querySelector(".library-screen input[type=search]") && document.querySelector(".sync-state")?.dataset.synced==="true"');
  assert.ok(requested.has('/record-screens.js'));
  for (const file of ['catalog-screens','settings-screens','hand-merge-screen','recovery-screen','trakt-import-screen','anilist-import-screen']) {
    assert.ok(!requested.has('/'+file+'.js'),file+' was not needed by Library');
  }
  await browser.click('.app-sidebar a[data-destination=ratings]');
  await browser.waitFor('document.querySelector("main [role=status]")?.textContent.includes("screen could not load")');
  await browser.click('.app-sidebar a[data-destination=library]');
  await browser.waitFor('document.querySelector(".library-screen input[type=search]")');
  await browser.click('.app-sidebar a[data-destination=ratings]');
  await browser.waitFor('Array.from(document.querySelectorAll("main button")).some(button=>button.textContent==="Reload csvTV")');
  refuse = false;
  await browser.evaluate('Array.from(document.querySelectorAll("main button")).find(button=>button.textContent==="Reload csvTV").focus()');
  await browser.press('Enter');
  await browser.waitFor('document.querySelector(".ratings-screen") && location.hash==="#/ratings"','recovered the requested bookmark');
});

test('an uncontrolled update interrupted during verification can retry the same Ratings bookmark by keyboard', {timeout:60000}, async t => {
  const {bytes} = await createRelease(new URL('../dist/',import.meta.url));
  let interrupted = false;
  const server = releaseServer(await unpack(bytes),(req,res) => {
    if (!interrupted || req.url !== '/export-screen.js') return false;
    res.writeHead(503,{'Cache-Control':'no-store'}).end();
    return true;
  });
  const origin = 'http://127.0.0.1:'+await listen(server);
  const profile = await mkdtemp(join(tmpdir(),'csvtv-retry-bookmark-'));
  let browser;
  t.after(async () => {
    try { await browser?.close(); } finally { await stop(server); await rm(profile,{recursive:true,force:true,maxRetries:8,retryDelay:150}); }
  });
  const provider = offlineProviders(origin);
  await provider.settings({});
  await provider.upload('ratings.csv','show_id,show,rating\r\n18,Signal Valley,8.5\r\n');
  browser = await openChromium(profile,provider.respond);
  await browser.send('Page.addScriptToEvaluateOnNewDocument',{source:"Object.defineProperty(navigator,'serviceWorker',{value:undefined});"});
  await linkFixture(browser,origin,'/');
  await browser.navigate(origin+'/?layout=compact#/ratings');
  const saved = 'document.querySelector(\'.ratings-rows [data-show-id="18"] .rating-edit\')?.value==="8.5"';
  await browser.waitFor(saved);
  interrupted = true;
  await browser.evaluate("sessionStorage.setItem('csvTV/startup//','0'.repeat(64));location.reload()");
  const retry = 'document.querySelector(".startup-actions button")';
  await browser.waitFor(retry+'?.textContent==="Try again"');
  assert.equal(await browser.evaluate('document.querySelector(".startup-actions a").href'),origin+'/');
  const first = await browser.evaluate('performance.timeOrigin');
  await browser.evaluate(retry+'.focus()');
  await browser.press('Enter');
  await browser.waitFor('document.querySelector("#app > p")?.textContent.includes("Could not verify the update")');
  assert.equal(await browser.evaluate('performance.timeOrigin'),first);
  interrupted = false;
  await browser.evaluate(retry+'.focus()');
  await browser.press('Enter');
  await browser.waitFor(saved);
  assert.equal(await browser.evaluate('location.hash'),'#/ratings');
});

test('a new Dropbox sign-in during the first sync module download cannot use either account’s files', {timeout:60000}, async t => {
  const {bytes} = await createRelease(new URL('../dist/',import.meta.url));
  const gate = Promise.withResolvers(), requested = Promise.withResolvers();
  const server = releaseServer(await unpack(bytes),async req => {
    if (req.url === '/dropbox-file-operations.js') { requested.resolve(); await gate.promise; }
    return false;
  });
  const origin = 'http://127.0.0.1:'+await listen(server);
  const profile = await mkdtemp(join(tmpdir(),'csvtv-first-sync-'));
  let browser;
  t.after(async () => {
    gate.resolve();
    try { await browser?.close(); } finally { await stop(server); await rm(profile,{recursive:true,force:true,maxRetries:8,retryDelay:150}); }
  });
  const cloud = offlineProviders(origin), files = [];
  browser = await openChromium(profile,(event,send) => {
    const path = new URL(event.request.url).pathname;
    if (event.request.method !== 'OPTIONS' && path.startsWith('/2/files/')) files.push(path);
    return cloud.respond(event,send);
  });
  await browser.send('Page.addScriptToEvaluateOnNewDocument',{source:"Object.defineProperty(navigator,'serviceWorker',{value:undefined});"});
  await linkFixture(browser,origin,'/');
  await browser.send('Page.navigate',{url:origin+'/#/settings'});
  await requested.promise;
  await browser.waitFor('document.querySelector("[data-cloud-reason]")?.textContent==="Syncing…"');
  await renewFixture(browser,'/',false,'fictional-second-owner');
  gate.resolve();
  await browser.waitFor('document.querySelector("dialog[open]")?.textContent.includes("Choose your Dropbox account")','choose accounts after the interrupted sync');
  assert.deepEqual(files,[]);
});

test('a linked device exchanges a returning sign-in while Home is still reading its watch record', {timeout:60000}, async t => {
  const {bytes}=await createRelease(new URL('../dist/',import.meta.url));
  const server=releaseServer(await unpack(bytes)), origin='http://127.0.0.1:'+await listen(server);
  const profile=await mkdtemp(join(tmpdir(),'csvtv-returning-device-'));
  let browser, exchanged=0;
  t.after(async()=>{
    try { await browser?.close(); } finally { await stop(server); await rm(profile,{recursive:true,force:true,maxRetries:8,retryDelay:150}); }
  });
  const provider=offlineProviders(origin,form=>{
    assert.equal(form.get('grant_type'),'authorization_code');
    assert.equal(form.get('code'),'fictional-return');
    exchanged++;
    return {account_id:'fictional-owner',access_token:'example-access',refresh_token:'example-refresh',expires_in:14400};
  });
  await provider.settings({});
  browser=await openChromium(profile,provider.respond);
  await linkFixture(browser,origin,'/');
  const state=await browser.evaluate(`(async()=>{
    const {openDeviceStore}=await import('/storage.js'), {DropboxAuth}=await import('/dropbox-auth.js');
    const store=await openDeviceStore(); await store.whenWriter();
    const auth=new DropboxAuth(store,'fictional-browser-registration');
    try {
      await auth.signOut();
      let destination;
      await auth.authorize({sessionStorage,location:{href:location.origin+'/',assign:value=>{destination=new URL(value);}}});
      return destination.searchParams.get('state');
    } finally { auth.close(); await store.closeForUpdate(); }
  })()`);
  await browser.send('Page.addScriptToEvaluateOnNewDocument',{source:`
    if (new URLSearchParams(location.search).has('code')) {
      void import('/storage.js').then(({DeviceStore})=>{
        const home=DeviceStore.prototype.homeRecord;
        const gate=new Promise(resolve=>{window.fixtureFinishHome=resolve;});
        DeviceStore.prototype.homeRecord=async function(...args) {
          window.fixtureHomeReading=true; await gate; return home.apply(this,args);
        };
      });
    }`});
  // The app removes the callback query before the browser's load event.
  const navigation=await browser.send('Page.navigate',{url:origin+'/?'+new URLSearchParams({code:'fictional-return',state})});
  assert.equal(navigation.errorText,undefined);
  await browser.waitFor('!location.search && window.fixtureHomeReading','returning to Home');
  try { await until(()=>exchanged===1,'Dropbox exchange before Home finishes',5000); }
  finally { await browser.evaluate('window.fixtureFinishHome()'); }
  await browser.waitFor('document.querySelector(".sync-state")?.dataset.synced==="true"','linked device synced');
  assert.equal(exchanged,1);
});

test('Settings gives a clean offline bookmark, detects missing shell files, and restores startup',
  {timeout:90000}, async t => {
    const {server} = await testSite();
    const port = await listen(server), origin = 'http://127.0.0.1:' + port;
    const app = origin + '/tracker/', settings = app + '#/settings';
    const profile = await mkdtemp(join(tmpdir(), 'csvtv-bookmark-repair-'));
    const providers = offlineProviders(origin);
    let browser;
    t.after(async () => {
      try { await browser?.close(); }
      finally { await stop(server); await rm(profile,{recursive:true,force:true,maxRetries:8,retryDelay:150}); }
    });
    const status = 'document.querySelector("[data-offline-status]")?.textContent';
    const ready = () => browser.waitFor(status + ' === "Ready to open offline."','complete installed shell');
    const removeModule = () => browser.evaluate(`(async () => {
      const cache = await caches.open((await caches.keys())[0]);
      return cache.delete(new URL('main.js',location.href));
    })()`);
    browser = await openChromium(profile,providers.respond);
    await linkFixture(browser, origin);
    await browser.navigate(app + '?source=fictional-bookmark#/settings');
    await browser.waitFor(status + '?.includes("before saving your bookmark")','query bookmark guidance');
    const link = 'document.querySelector("[data-offline-bookmark]")';
    assert.equal(await browser.evaluate(link+'.href'),settings);
    await browser.evaluate('document.querySelector("[data-offline-update]").focus()');
    await browser.press('Tab');
    assert.equal(await browser.evaluate(link+' === document.activeElement'),true,'Tab reaches the bookmark link from the update button');
    await browser.press('Enter');
    await browser.waitFor('location.href === '+JSON.stringify(settings),'keyboard opens the clean URL');
    await ready();

    assert.equal(await removeModule(),true);
    await browser.click('.app-sidebar a[href="#/library"]');
    await browser.click('.app-sidebar a[href="#/settings"]');
    await browser.waitFor(status + '?.includes("offline files are missing")','missing startup module reported');
    await browser.click('[data-offline-update]');
    await ready();
    assert.equal(await removeModule(),true,'explicit retry restored the missing module');
    await browser.close(); browser = undefined;
    await stop(server);
    browser = await openChromium(profile,providers.respond);
    await browser.offline(true);
    await browser.navigate(settings);
    await browser.evaluate('document.querySelector("#app summary").focus()');
    await browser.press('Enter');
    await browser.waitFor('document.querySelector("#app details[open]")?.innerText.includes("Reconnect to the internet")',
      'cold startup failure explains how to recover');
    await listen(server,port);
    await browser.offline(false);
    await browser.send('Page.reload');
    await ready();
  });

test('A late fictional provider response after navigation leaves the next page usable', {timeout:30000}, async t => {
  const {server} = await testSite();
  const origin = 'http://127.0.0.1:' + await listen(server);
  const profile = await mkdtemp(join(tmpdir(), 'csvtv-canceled-request-'));
  const started = Promise.withResolvers(), release = Promise.withResolvers(), replied = Promise.withResolvers();
  let browser;
  t.after(async () => {
    release.resolve();
    try { await browser?.close(); }
    finally { await stop(server); await rm(profile, {recursive:true, force:true, maxRetries:6, retryDelay:150}); }
  });
  browser = await openChromium(profile, async ({requestId}, send) => {
    started.resolve();
    await release.promise;
    try { await send('Fetch.fulfillRequest', {requestId, responseCode:200, body:''}); }
    finally { replied.resolve(); }
  });
  await browser.navigate(origin + '/fixture');
  await browser.evaluate('window.controller = new AbortController(); void fetch("https://api.mdblist.com/tmdb/show/45", {signal:controller.signal}).catch(() => {})');
  await started.promise;
  await browser.evaluate('controller.abort()');
  await browser.navigate(origin + '/fixture?next');
  release.resolve();
  await replied.promise;
  // Let the interception callback settle before the harness checks for fixture errors on the next page.
  await browser.send('Runtime.evaluate', {expression:'document.readyState'});
  assert.equal(await browser.evaluate('document.title'), 'Fictional device setup');
});

async function seedDevice() {
  const {openDeviceStore} = await import('/tracker/storage.js');
  const db = await openDeviceStore();
  try {
    await db.whenWriter();
    await db.storeExchangedSession({accountId:'fictional-owner', instanceId:'device-a', accessToken:'example-access',
      refreshToken:'example-refresh', accessExpiresAt:Date.now()+600000, signInDeadline:Date.now()+86400000,providerExpiresAt:Date.now()+86400000});
    await db.commit((await db.snapshot()).revision, {put:{
      watched:[{show_id:45,show:'The Listening House',season:1,episode:1,episode_id:45011,title:'Recording 1',times_watched:1}],
      lists:[{list:'Watchlist',show_id:46,show:'Signal Park'},{list:'Radio',show_id:45,show:'The Listening House'}],
      ratings:[{show_id:45,show:'The Listening House',rating:8.5}],

    }});
    localStorage.setItem('csvTV-public-dropbox-app-key','fictional-offline-app');
  } finally { db.close(); }
}

async function cacheContents() {
  const result = [];
  for (const name of await caches.keys()) {
    const cache = await caches.open(name);
    for (const request of await cache.keys()) {
      const body = await (await cache.match(request)).text();
      const markers = ['fictional-private-response','fictional-offline-key','example-access','fictional-once','fictional-pkce-verifier'];
      result.push({name,url:request.url,private:markers.some(marker => body.includes(marker))});
    }
  }
  return result.sort((a,b) => a.url.localeCompare(b.url));
}

async function receiveOnSecondDevice() {
  const [{openDeviceStore}, {DropboxAuth}, {DropboxController}, {DropboxDialogs}] = await Promise.all(
    ['storage','dropbox-auth','dropbox-controller','dropbox-dialogs'].map(name => import('/tracker/'+name+'.js')));
  const db = await openDeviceStore({name:'fictional-offline-peer'});
  let controller;
  try {
    await db.whenWriter();
    await db.storeExchangedSession({accountId:'fictional-owner',instanceId:'device-b',accessToken:'example-access',
      refreshToken:'example-refresh',accessExpiresAt:Date.now()+600000,signInDeadline:Date.now()+86400000,providerExpiresAt:Date.now()+86400000});
    controller = new DropboxController(new DropboxAuth(db,'fictional-offline-app'),window,new DropboxDialogs(document));
    await controller.refresh(true);
    const end = performance.now() + 15000;
    while (!controller.synced || controller.busy) {
      if (performance.now() > end) throw Error('Second device sync timed out: ' + controller.reason);
      await new Promise(resolve => setTimeout(resolve,60));
    }
    return (await db.snapshot()).tables;
  } finally { controller?.close(); db.close(); }
}

// Cold boot means a second browser process with the same profile and no HTTP server.
// The provider emulator also refuses traffic independently of navigator.onLine.
test('Installed app cold-starts disconnected, exports local edits, and syncs both edits to a second device',
  {timeout:120000}, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'csvtv-offline-'));
    const profile = join(directory,'profile'), downloads = join(directory,'downloads');
    await mkdir(downloads);
    const {server,manifest} = await testSite();
    let browser;
    t.after(async () => {
      try { if (browser) await browser.close(); }
      finally { await stop(server); await rm(directory,{recursive:true,force:true,maxRetries:12,retryDelay:150}); }
    });
    const port = await listen(server);
    const origin = 'http://127.0.0.1:' + port, appUrl = origin + '/tracker/';
    const provider = offlineProviders(origin);
    const cloudRows = name => readCsv(name, Buffer.from(provider.files.get('/' + name + '.csv').bytes).toString()).rows;
    const route = page => browser.click('.app-sidebar a[href="#/' + page + '"]');
    const pageScript = fn => browser.evaluate('(' + fn.toString() + ')()');
    const textIs = (selector,value) => browser.waitFor('document.querySelector(' +
      JSON.stringify(selector) + ')?.textContent === ' + JSON.stringify(value), selector + ' shows ' + value);
    browser = await openChromium(profile, provider.respond);
    await browser.navigate(origin + '/fixture');
    await provider.settings({tmdb_key:'fictional-offline-key'});
    await pageScript(seedDevice);
    await browser.navigate(appUrl);
    await route('library');
    await browser.click('.library-screen a[href="#/show/45"]');
    await browser.click('[data-season="1"]');
    await browser.waitFor('!!document.querySelector(\'[data-episode="episode-2"]\')', 'both opened episodes');
    await textIs('.sync-state','Synced');
    assert.ok(provider.metadataReads.has('/3/tv/45') && provider.metadataReads.has('/3/tv/45/season/1'));
    assert.equal(cloudRows('watched').length,1);
    assert.equal(cloudRows('lists').length,2);
    await browser.waitFor('Boolean(navigator.serviceWorker.controller)', 'a controlling installed worker');

    const probes = [
      {path:'./main.js', options:{headers:{Authorization:'Bearer test-only'}}},
      {path:'./main.js?test-key=sensitive'}, {path:'./?code=test-only&state=test-only'},
    ];
    for (const {path,options} of probes) {
      const response = await browser.evaluate('fetch(' + JSON.stringify(path) + ',' + JSON.stringify(options ?? {}) +
        ').then(response => response.text())');
      assert.equal(response,privateMarker,'Private request must pass through to the network: '+path);
    }
    const keys = await pageScript(cacheContents);
    assert.deepEqual([...new Set(keys.map(key => key.name))], ['csvTV:shell:' + appUrl + ':' + manifest.build]);
    assert.deepEqual(keys.map(key => key.url).sort(), Object.keys(manifest.files).map(file => appUrl + file).sort());
    assert.ok(keys.every(key => !key.private), 'A private body entered the shell cache');

    await browser.close(); browser = null;
    await stop(server);
    provider.state.online = false;
    browser = await openChromium(profile, provider.respond);
    await browser.offline(true);
    await browser.navigate(appUrl + '#/library');
    assert.equal(await browser.evaluate('navigator.onLine'),false);
    await browser.waitFor('Boolean(navigator.serviceWorker.controller)', 'cached app control after restarting Chromium');
    assert.equal(await browser.evaluate('fetch("/fixture").then(() => false, () => true)'),true,'Network-only page still reachable');
    const icons = await pageScript(async () => {
      const links = document.head.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"]');
      return Promise.all(Array.from(links, async link => {
        const image = new Image();
        image.src = link.href;
        await image.decode();
        return {url:link.href, type:link.type, sizes:link.sizes.value, width:image.naturalWidth, height:image.naturalHeight};
      }));
    });
    assert.deepEqual(icons.map(({url,type,sizes}) => [url,type,sizes]), [
      [appUrl + 'favicon-32.png','image/png','32x32'],
      [appUrl + 'favicon.svg','image/svg+xml','any'],
      [appUrl + 'apple-touch-icon.png','image/png','180x180'],
    ]);
    assert.deepEqual([icons[0].width, icons[0].height], [32, 32]);
    assert.deepEqual([icons[2].width, icons[2].height], [180, 180]);
    await textIs('.sync-state','Not synced');
    await textIs('.library-screen h1','Library');
    await browser.click('.library-screen a[href="#/show/45"]');
    await browser.click('[data-season="1"]');
    await browser.click('[data-season-focus="episode-2-add"]');
    await browser.waitFor('!!document.querySelector(".undo-bar:not([hidden])")','committed offline watch');
    await route('watchlist');
    await browser.click('[data-watchlist-remove="46"]');
    await textIs('.watch-lead','Your Watchlist is empty.');
    await route('lists');
    await textIs('#chosen-list','Radio');
    await textIs('.list-shows strong','The Listening House');
    await route('statistics');
    await textIs('[data-stat="plays"] dd','2');
    await textIs('[data-stat="episodes"] dd','2');
    await route('export');
    await browser.click('input[value="record"]');
    await browser.send('Browser.setDownloadBehavior',{behavior:'allow', downloadPath:downloads});
    for (const name of ['watched','ratings','lists','shows']) {
      await browser.click('a[download="' + name + '.csv"]');
      const contents = await until(async () => {
        try { return await readFile(join(downloads,name+'.csv'),'utf8'); } catch { return false; }
      }, name + ' download');
      const rows = readCsv(name,contents).rows;
      const showIds = [...new Set(rows.map(row=>row.show_id))].sort();
      assert.deepEqual(showIds, name === 'lists' || name === 'shows' ? [45,46] : [45]);
      if (name === 'watched') assert.deepEqual(rows.map(row => row.episode),[1,2]);
      if (name === 'lists') assert.deepEqual(rows.map(row => [row.show_id,row.list]),[[46,'Hidden from upcoming'],[45,'Radio']]);
      if (name === 'ratings') assert.deepEqual(rows.map(row=>row.rating),[8.5]);
    }
    await route('settings');
    await browser.waitFor('/Offline|waiting to sync/.test(document.querySelector("[data-cloud-reason]")?.textContent) ' +
      '&& document.querySelector("[data-sync]").disabled', 'pending edits and disconnected sync');
    await browser.waitFor('document.querySelector("[data-offline-update]")?.textContent === "Check for update"',
      'offline update control');
    const updateFocused = 'document.activeElement.matches("[data-offline-update]")';
    for (let tabs = 0; tabs < 50 && !await browser.evaluate(updateFocused); tabs++) await browser.press('Tab');
    assert.equal(await browser.evaluate(updateFocused),true,'Keyboard could not reach the update control');
    await browser.press('Enter');
    const displayedStatus = 'document.querySelector("[data-offline-status]")?.textContent';
    try { await browser.waitFor('/[Cc]onnect/.test(' + displayedStatus + ')','keyboard update reports the connection requirement'); }
    catch (error) { throw Error(error.message + '; displayed status: ' + await browser.evaluate(displayedStatus)); }
    assert.equal(cloudRows('watched').length,1);
    assert.equal(cloudRows('lists').length,2);
    // Kill the JS session again before reconnecting. Only committed offline edits survive.
    await browser.close(); browser = null;
    browser = await openChromium(profile,provider.respond);
    await browser.offline(true);
    await browser.navigate(appUrl);
    await textIs('.home-screen h1','Home');
    await textIs('.sync-state','Not synced');
    await route('statistics');
    await textIs('[data-stat="episodes"] dd','2');
    await route('watchlist');
    await textIs('.watch-lead','Your Watchlist is empty.');
    await listen(server,port);
    provider.state.online = true;
    await browser.offline(false);
    await textIs('.sync-state','Synced');
    assert.deepEqual(cloudRows('watched').map(row => [row.episode,row.times_watched]), [[1,1],[2,1]]);
    assert.deepEqual(cloudRows('lists').map(row => row.list), ['Hidden from upcoming','Radio']);
    assert.deepEqual(await pageScript(cacheContents),keys,'A provider or private response changed the shell cache');
    await browser.navigate(origin + '/fixture');
    const peer = await pageScript(receiveOnSecondDevice);
    assert.deepEqual(peer.watched,cloudRows('watched'));
    assert.deepEqual(peer.lists,cloudRows('lists'));
  });

test('Mobile Dropbox sign-in can restart after an external MFA error and survives a reload before opening the returned record',
  {timeout:60000}, async t => {
    const {bytes} = await createRelease(new URL('../dist/',import.meta.url));
    const server = releaseServer(await unpack(bytes));
    const origin = 'http://127.0.0.1:' + await listen(server), app = origin + '/';
    const registration = 'fictional-mobile-registration', code = 'fictional-mobile-result';
    const authorization = 'https://www.dropbox.com/oauth2/authorize';
    const accounts = createServer((req,res) => {
      res.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-store'});
      res.end(req.url === '/first' ? '<h1>Fictional identity provider failed before returning</h1>' :
        '<meta name="viewport" content="width=device-width,initial-scale=1"><a id="resume" href="' +
        authorization + '?fixture=approved">Approve fictional second factor</a>');
    });
    const mfa = 'http://127.0.0.1:' + await listen(accounts), requests = [];
    let exchanges = 0, browser;
    const profile = await mkdtemp(join(tmpdir(),'csvtv-mobile-return-'));
    t.after(async () => {
      try { await browser?.close(); }
      finally { await Promise.all([stop(server),stop(accounts)]); await rm(profile,{recursive:true,force:true,maxRetries:8,retryDelay:150}); }
    });
    const provider = offlineProviders(origin, form => {
      assert.equal(form.get('code'),code);
      assert.equal(form.get('client_id'),registration);
      assert.equal(form.get('redirect_uri'),app);
      assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'),requests.at(-1).get('code_challenge'));
      exchanges++;
      return {account_id:'fictional-owner',access_token:'example-access',refresh_token:'example-refresh',expires_in:14400};
    });
    async function request(event, send) {
      const url = new URL(event.request.url);
      if (url.origin+url.pathname !== authorization) return provider.respond(event,send);
      assert.equal(event.resourceType,'Document');
      let location;
      if (url.searchParams.get('fixture') === 'approved') {
        location = app + '?' + new URLSearchParams({code,state:requests.at(-1).get('state')});
      } else {
        const params = url.searchParams;
        assert.equal(params.get('redirect_uri'),app);
        assert.equal(params.get('client_id'),registration);
        assert.equal(params.get('code_challenge_method'),'S256');
        assert.ok(params.get('state') && params.get('code_challenge'));
        requests.push(params);
        location = mfa + (requests.length === 1 ? '/first' : '/second');
      }
      await send('Fetch.fulfillRequest',{requestId:event.requestId,responseCode:302,responseHeaders:[{name:'Location',value:location}]});
    }
    const launch = async () => {
      browser = await openChromium(profile, request, {dropboxReleaseCheck:true});
      await browser.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:3,mobile:true});
      await browser.send('Emulation.setTouchEmulationEnabled',{enabled:true});
    };
    const tap = async selector => {
      const center = await until(() => browser.evaluate(`(() => {
        const el=document.querySelector(${JSON.stringify(selector)});
        if (!el || el.disabled || !el.getClientRects().length) return false;
        el.scrollIntoView({block:'center'});
        const rect=el.getBoundingClientRect(); return {x:rect.x+rect.width/2,y:rect.y+rect.height/2};
      })()`),selector);
      await browser.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[center]});
      await browser.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    };
    await launch();
    await browser.navigate(app);
    await tap('[data-edit-client]');
    await browser.evaluate('document.querySelector("#settings-services input").value=' + JSON.stringify(registration));
    await tap('#settings-services button[type="submit"]');
    await tap('[data-sign-in]');
    await browser.waitFor('location.href === '+JSON.stringify(mfa+'/first'),'external MFA error stays on the provider page');
    assert.equal(exchanges,0);
    await browser.close(); browser = undefined;

    // A fresh app tab after a browser restart can begin a new attempt without a callback from the first.
    await launch();
    await browser.navigate(app);
    await tap('[data-sign-in]');
    await browser.waitFor('location.href === '+JSON.stringify(mfa+'/second'),'the external MFA step');
    assert.equal(requests.length,2);
    assert.notEqual(requests[0].get('state'),requests[1].get('state'));
    // Hold IndexedDB during the return document only. Reload after the app has scrubbed
    // the callback, before database initialization allows submission of the one-use code.
    await browser.send('Page.addScriptToEvaluateOnNewDocument',{source:`
      if (new URLSearchParams(location.search).get('code') === ${JSON.stringify(code)}) {
        const open = indexedDB.open.bind(indexedDB);
        indexedDB.open = function(name,...args) {
          if (name !== 'csvTV') return open(name,...args);
          window.fixtureWaitingForRecord = true;
          return new EventTarget();
        };
      }`});
    await tap('#resume');
    await browser.waitFor('location.origin === '+JSON.stringify(origin)+' && !location.search && window.fixtureWaitingForRecord',
      'returned app scrubbed its URL before the record opened');
    assert.equal(exchanges,0);
    await browser.send('Page.reload');
    await browser.waitFor('document.querySelector(".sync-state")?.textContent === "Synced"','mobile callback survives a reload');
    assert.equal(exchanges,1);
    assert.equal(await browser.evaluate('JSON.stringify(sessionStorage).includes('+JSON.stringify(code)+')'),false);
    await browser.close(); browser = undefined;
    await launch();
    await browser.navigate(app + '#/library');
    await browser.waitFor('document.querySelector("#app")?.dataset.page === "library" && document.querySelector(".sync-state")?.textContent === "Synced"');
    assert.equal(exchanges,1,'Reopening must use the committed session');
  });

for (const page of ['Library','Search']) test('refresh opens ' + page + ' during publication, then updates once with its saved search',
  {timeout:60000}, async t => {
    const site = await testSite({oauth:true});
    const origin = 'http://127.0.0.1:' + await listen(site.server);
    const profile = await mkdtemp(join(tmpdir(),'csvtv-refresh-update-'));
    let browser;
    t.after(async () => {
      try { await browser?.close(); }
      finally { await stop(site.server); await rm(profile,{recursive:true,force:true,maxRetries:8,retryDelay:150}); }
    });
    browser = await openChromium(profile,offlineProviders(origin).respond);
    await browser.navigate(origin + '/fixture');
    await browser.evaluate('(' + seedDevice.toString() + ')()');
    const route = origin + '/tracker/' + (page === 'Library' ? '#/library' : '#/search?q=Listening');
    const search = 'document.querySelector("main input[type=search]")';
    await browser.navigate(route);
    await browser.waitFor(search + ' && !!navigator.serviceWorker.controller','first screen and installed shell');
    if (page === 'Library') {
      await browser.evaluate(`const filter = ${search}; filter.value = 'Listening'; filter.dispatchEvent(new Event('input',{bubbles:true}))`);
      assert.equal(await browser.evaluate('typeof history.state.csvtvVisit === "string" && !JSON.stringify(history.state).includes("Listening")'),true);
    }
    const savedView = search + '?.value === "Listening"' + (page === 'Library'
      ? ' && document.querySelector(\'.library-grid a[href="#/show/45"] strong\')?.innerText === "The Listening House"' : '');
    await browser.waitFor(savedView,'query present before refreshing');
    const readBuild = 'document.querySelector("meta[name=csvtv-build]")?.content';
    const firstVisit = await browser.evaluate('performance.timeOrigin');
    site.publishDocument();
    const lookup = Promise.withResolvers();
    site.server.on('request', req => { if (req.url.includes('csvtv-update=')) lookup.resolve(); });
    await browser.send('Page.reload');
    await browser.waitFor(savedView + ' && performance.timeOrigin !== ' + firstVisit,page+' usable during partial publication');
    await lookup.promise;
    assert.equal(await browser.evaluate(readBuild), site.manifest.build);
    site.publishWorker();
    await browser.waitFor(readBuild + ' === ' + JSON.stringify(site.nextBuild) + ' && ' + savedView,
      'untouched refreshed '+page+' applies the completed release with the saved query');
    assert.equal(await browser.evaluate('location.href'),route);
    const finalVisit = await browser.evaluate('performance.timeOrigin');
    await browser.evaluate('navigator.serviceWorker.getRegistration().then(reg => reg.update()).then(() => true)');
    assert.equal(await browser.evaluate('performance.timeOrigin'),finalVisit);
  });

for (const inputEvent of [true,false]) test('refresh preserves ' + (inputEvent ? 'typing' : 'a silently restored field') +
  ' during an update and applies the waiting release on the next untouched refresh',
  {timeout:60000}, async t => {
    const site = await testSite({oauth:true});
    const origin = 'http://127.0.0.1:' + await listen(site.server);
    const profile = await mkdtemp(join(tmpdir(),'csvtv-refresh-input-'));
    let browser;
    t.after(async () => {
      try { await browser?.close(); }
      finally { await stop(site.server); await rm(profile,{recursive:true,force:true,maxRetries:8,retryDelay:150}); }
    });
    browser = await openChromium(profile,offlineProviders(origin).respond);
    await browser.navigate(origin + '/tracker/#/settings');
    await browser.waitFor('!!navigator.serviceWorker.controller && !!document.querySelector("[data-offline-status]")');
    // Place the draft immediately before the page handles the worker's final preparation request.
    await browser.send('Page.addScriptToEvaluateOnNewDocument',{source:`
      navigator.serviceWorker.addEventListener('message', event => {
        if (!event.data?.refresh || event.data.type !== 'csvtv:prepare' || sessionStorage.getItem('typed')) return;
        const draft = document.createElement('input');
        document.body.append(draft);
        draft.id = 'unsaved';
        draft.value = 'fictional unsaved draft';
        if (${inputEvent}) draft.dispatchEvent(new Event('input',{bubbles:true}));
        sessionStorage.setItem('typed','1');
      });`});
    const initial = await browser.evaluate('performance.timeOrigin');
    await browser.send('Page.reload');
    await browser.waitFor('performance.timeOrigin !== ' + initial + ' && !!document.querySelector("[data-offline-status]")');
    const refreshed = await browser.evaluate('performance.timeOrigin');
    site.publishDocument();
    site.publishWorker();
    await browser.evaluate('navigator.serviceWorker.getRegistration().then(reg => reg.update()).then(() => true)');
    await browser.waitFor('document.querySelector("[data-offline-update]")?.textContent === "Reload to update"');
    await browser.waitFor('document.querySelector("#unsaved")?.value === "fictional unsaved draft"');
    assert.equal(await browser.evaluate('performance.timeOrigin'),refreshed);
    await browser.send('Page.reload');
    await browser.waitFor('document.querySelector("meta[name=csvtv-build]")?.content === ' + JSON.stringify(site.nextBuild) +
      ' && !!document.querySelector("[data-offline-status]")','previously waiting update applied on reload');
  });

test('OAuth callback survives a mixed deployment and finishes once before a waiting update activates',
  {timeout:60000}, async t => {
    const site = await testSite({oauth:true});
    const port = await listen(site.server);
    const origin = 'http://127.0.0.1:'+port, appUrl = origin+'/tracker/';
    const profile = await mkdtemp(join(tmpdir(),'csvtv-offline-callback-'));
    const tokenReply = Promise.withResolvers();
    let calls = 0;
    const verifier = 'fictional-pkce-verifier-'.repeat(2);
    const provider = offlineProviders(origin, async form => {
      assert.equal(form.get('code'),'fictional-once');
      assert.equal(form.get('code_verifier'),verifier);
      assert.equal(form.get('redirect_uri'),appUrl);
      calls++;
      await tokenReply.promise;
      return {account_id:'fictional-owner',access_token:'example-access',refresh_token:'example-refresh',expires_in:14400};
    });
    let browser;
    t.after(async () => {
      tokenReply.resolve();
      try { if (browser) await browser.close(); }
      finally { await stop(site.server); await rm(profile,{recursive:true,force:true,maxRetries:12,retryDelay:150}); }
    });
    browser = await openChromium(profile,provider.respond);
    await browser.navigate(appUrl);
    await browser.waitFor('Boolean(navigator.serviceWorker.controller)', 'release one installed');
    const ticket = {state:'fictional-state',uri:appUrl,verifier,appKey:'fictional-offline-app',createdAt:Date.now()};
    const attempt = {state:ticket.state,createdAt:ticket.createdAt};
    await browser.evaluate('localStorage.setItem("csvTV-public-dropbox-app-key","fictional-offline-app");' +
      'sessionStorage.setItem("csvTV/dropbox-attempt-v2",' + JSON.stringify(JSON.stringify(attempt)) + ');' +
      'sessionStorage.setItem("csvTV/dropbox-pkce-v2",' + JSON.stringify(JSON.stringify(ticket)) + ')');
    // The callback is a network navigation to release two. Its unsubmitted
    // code must survive the reload back to the fully installed first release.
    site.publishDocument();
    await browser.send('Page.navigate',{url:appUrl+'?code=fictional-once&state=fictional-state#/settings'});
    await until(() => calls === 1,'the single token exchange',18000);
    assert.equal(await browser.evaluate('location.search'),'');
    assert.equal(await browser.evaluate('document.querySelector("meta[name=csvtv-build]").content'),site.manifest.build);
    assert.equal(await browser.evaluate('JSON.stringify(sessionStorage).includes("fictional-once")'),false);
    assert.equal(await browser.evaluate('JSON.stringify(sessionStorage).includes("fictional-pkce-verifier")'),false);

    // While the one-use token request is unanswered, install and request the
    // next build. The old compatible tab must commit the reply before releasing its DB.
    await browser.click('[data-offline-update]');
    await browser.waitFor('document.querySelector("[data-offline-status]")?.textContent === "Waiting for the published update…"',
      'one check stays open when the published document is ahead of its worker');
    site.publishWorker({failOnce:true});
    await browser.waitFor('document.querySelector("[data-offline-update]")?.textContent === "Reload to update"',
      'fully installed second release');
    assert.equal(site.failedAssets(),1,'the check retried the missing installation asset without another click');
    await browser.click('[data-offline-update]');
    await browser.waitFor('document.body.innerText.includes("Waiting for other csvTV tabs")','old document draining the exchange');
    tokenReply.resolve();
    await browser.waitFor('document.querySelector("meta[name=csvtv-build]")?.content === '+JSON.stringify(site.nextBuild),
      'second release opened');
    await browser.waitFor('document.querySelector(".sync-state")?.textContent === "Synced"','new build sees committed sign-in');
    assert.equal(calls,1);
    const cached = await browser.evaluate('('+cacheContents.toString()+')()');
    assert.ok(cached.every(entry => !entry.private && !new URL(entry.url).search), 'OAuth data entered CacheStorage');
  });
