import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRelease } from '../package-release.mjs';
import { openChromium, until } from './offline-chromium.mjs';
import { linkFixture, offlineProviders } from './offline-providers.mjs';
import { listen, stop } from './offline-site.mjs';
import { releaseServer, unpack } from './release-site.mjs';
import { releaseWithDropbox } from './browser-dropbox-site.mjs';

const authorize = 'https://www.dropbox.com/oauth2/authorize';
const code = 'fictional-route-recovery-code';
const isLinked = '(' + (async function () {
  const {openDeviceStore} = await import('/storage.js'), store = await openDeviceStore();
  try { return !!(await store.dropboxState()).session; } finally { store.close(); }
}).toString() + ')()';

for (const outcome of ['approved','denied','navigated','missing entry','unsavable return','missing return module']) {
  const entryFailure = !['approved','denied','navigated'].includes(outcome);
  const title = entryFailure ? 'a Dropbox return is removed from the address when startup reports '+outcome
    : 'a manual screen reload waits for the submitted Dropbox callback when '+outcome;
  test(title, {timeout:60000}, async t => {
    const {bytes} = await createRelease(new URL('../dist/',import.meta.url));
    const profile = await mkdtemp(join(tmpdir(),'csvtv-callback-reload-'));
    const received = Promise.withResolvers(), release = Promise.withResolvers();
    let browser, authorization, unavailable = false, exchanges = 0, returnedDocuments = 0;
    const server = releaseServer(await unpack(bytes),(request,response) => {
      const {pathname,searchParams} = new URL(request.url,'http://localhost');
      if (pathname === '/' && searchParams.has('code')) returnedDocuments++;
      if (pathname === '/approve') {
        response.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-store'});
        response.end('<a id="approve" href="'+authorize+'?fictional-approval=1">Approve</a>');
        return true;
      }
      const failed = entryFailure ? '/main.js' : '/record-screens.js';
      if (unavailable && (pathname === failed || outcome === 'missing return module' && pathname === '/dropbox-return.js')) {
        response.writeHead(503,{'Cache-Control':'no-store'}).end();
        return true;
      }
      return false;
    });
    const origin = 'http://127.0.0.1:'+await listen(server);
    t.after(async () => {
      release.resolve();
      try { await browser?.close(); await stop(server); }
      finally { await rm(profile,{recursive:true,force:true,maxRetries:6,retryDelay:150}); }
    });
    const cloud = offlineProviders(origin,form => {
      assert.equal(form.get('code'),code);
      assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'),authorization.get('code_challenge'));
      exchanges++;
      return {account_id:'fictional-owner',access_token:'example-access',refresh_token:'example-refresh',expires_in:14400};
    });
    browser = await openChromium(profile,async (event,send) => {
      const {requestId,request} = event, url = new URL(request.url);
      if (url.origin+url.pathname === authorize) {
        let location;
        if (url.searchParams.has('fictional-approval')) {
          unavailable = true;
          location = origin+'/?'+new URLSearchParams({state:authorization.get('state'),code,view:'fictional'})+'#/home';
        } else {
          authorization = url.searchParams;
          location = origin+'/approve';
        }
        return send('Fetch.fulfillRequest',{requestId,responseCode:302,responseHeaders:[{name:'Location',value:location}]});
      }
      if (url.pathname === '/oauth2/token' && request.method === 'POST') {
        return cloud.respond(event,async (method,params) => {
          received.resolve();
          await release.promise;
          if (outcome === 'denied') params = {...params,responseCode:400,body:Buffer.from('{"error":"invalid_grant"}').toString('base64')};
          return send(method,params);
        });
      }
      return cloud.respond(event,send);
    },{dropboxReleaseCheck:true});
    // A first online visit without an installed shell can encounter a temporarily unavailable route.
    await browser.send('Page.addScriptToEvaluateOnNewDocument',{source:outcome === 'missing entry'
      ? "Object.defineProperty(navigator,'serviceWorker',{get(){throw new DOMException('Fictional site permission','SecurityError')}})"
      : "Object.defineProperty(navigator,'serviceWorker',{value:undefined})"});
    if (outcome === 'unsavable return') await browser.send('Page.addScriptToEvaluateOnNewDocument',{source:`
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key,value) {
        if (key.startsWith('csvTV/dropbox-callback-v2/')) throw new DOMException('Fictional storage limit','QuotaExceededError');
        return set.call(this,key,value);
      };`});
    await cloud.settings({});
    await linkFixture(browser,origin,'/');
    await browser.navigate(origin+'/#/settings');
    await browser.waitFor('document.querySelector(".sync-state")?.dataset.synced==="true"');
    await browser.click('[data-sign-out]');
    await browser.click('[data-sign-in]:enabled');
    await browser.click('#approve');
    if (entryFailure) {
      const sameTab = outcome !== 'unsavable return';
      const action = sameTab ? '[data-opening] + button' : '[data-opening] + a';
      await browser.waitFor('!!document.querySelector('+JSON.stringify(action)+')');
      assert.equal(await browser.evaluate('location.search+location.hash'),'?view=fictional#/home');
      assert.equal(returnedDocuments,1);
      assert.equal(exchanges,0);
      if (sameTab) {
        unavailable = false;
        await browser.click(action);
        await received.promise;
        release.resolve();
        await until(()=>browser.evaluate(isLinked),'the original tab saved its pending sign-in');
        assert.equal(exchanges,1);
        assert.equal(returnedDocuments,1,'The browser should only send the return address on the original redirect.');
      } else {
        const link = 'document.querySelector('+JSON.stringify(action)+')';
        assert.equal(await browser.evaluate(link+'.href'),origin+'/');
        assert.equal(await browser.evaluate(link+'.rel'),'noopener noreferrer');
        assert.equal(await browser.evaluate(link+'.target'),'_blank');
        assert.ok(await browser.evaluate(link+'.getBoundingClientRect().height >= 44 && '+link+'.getBoundingClientRect().left >= 8'));
      }
      return;
    }
    await received.promise;
    const buttons = '[...document.querySelectorAll("button")]';
    const recovery = buttons+'.find(b=>b.textContent==="Reload csvTV")';
    await browser.waitFor('!!'+recovery);
    assert.equal(await browser.evaluate('location.search'),'?view=fictional');
    unavailable = false;
    const documentStart = await browser.evaluate('performance.timeOrigin');
    await browser.evaluate(recovery+'.click()');
    await browser.waitFor(buttons+'.some(b=>b.disabled && b.textContent==="Waiting for changes…")');
    assert.equal(await browser.evaluate('performance.timeOrigin'),documentStart);
    if (outcome === 'navigated') await browser.evaluate("location.hash='#/settings'");
    release.resolve();
    if (outcome === 'denied') {
      await browser.waitFor('!!'+recovery+' && !'+recovery+'.disabled');
      assert.equal(await browser.evaluate(isLinked),false);
      assert.equal(await browser.evaluate('performance.timeOrigin'),documentStart);
      await browser.evaluate(recovery+'.click()');
    } else if (outcome === 'navigated') {
      await until(()=>browser.evaluate(isLinked),'the grant was saved after leaving the failed route');
      assert.equal(await browser.evaluate('location.hash'),'#/settings');
      assert.equal(await browser.evaluate('performance.timeOrigin'),documentStart);
    }
    if (outcome !== 'navigated') {
      await until(async () => (await browser.evaluate('performance.timeOrigin').catch(()=>documentStart)) !== documentStart,'safe reload');
      await until(async () => (await browser.evaluate(isLinked).catch(()=>undefined)) === (outcome === 'approved'),'expected grant after reload');
    }
    assert.equal(exchanges,1);
  });
}

for (const late of [false,true]) test(late ? 'a copied Dropbox return uses its already completed sign-in'
  : 'two tabs that inherit one verified Dropbox return send exactly one code', {timeout:60000}, async t => {
  const {bytes} = await createRelease(new URL('../dist/',import.meta.url));
  const assets = await unpack(bytes), profile = await mkdtemp(join(tmpdir(),'csvtv-copied-return-'));
  // Direct both tabs' Dropbox fetches to the same local fixture, including the popup outside the driver.
  assets.set('index.html',Buffer.from(assets.get('index.html').toString().replace('<script src="./theme-start.js"',
    '<script src="./two-tab-fixture.js"></script><script src="./theme-start.js"')));
  const fixture = () => {
    Object.defineProperty(navigator,'serviceWorker',{value:undefined});
    const native = fetch.bind(window);
    window.fetch = (target,init) => {
      const url = new URL(target instanceof Request ? target.url : target,location.href);
      const test = ['api.dropboxapi.com','content.dropboxapi.com'].includes(url.host);
      return native(test ? '/fictional-dropbox/'+url.host+url.pathname+url.search : target,init);
    };
  };
  assets.set('two-tab-fixture.js',Buffer.from('('+fixture.toString()+')();'));
  let cloud,browser,ticket,hold = false,exchanges = 0;
  const main = Promise.withResolvers(), accepted = Promise.withResolvers(), reply = Promise.withResolvers();
  const serve = releaseWithDropbox(assets,()=>cloud).listeners('request')[0];
  const server = createServer(async (req,res) => {
    if (hold && req.url === '/main.js') await main.promise;
    serve(req,res);
  });
  const origin = 'http://127.0.0.1:'+await listen(server);
  t.after(async () => {
    main.resolve(); reply.resolve();
    try { await browser?.close(); await stop(server); }
    finally { await rm(profile,{recursive:true,force:true,maxRetries:6,retryDelay:150}); }
  });
  cloud = offlineProviders(origin,async form => {
    assert.equal(form.get('code'),code);
    assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'),ticket.challenge);
    exchanges++;
    accepted.resolve();
    await reply.promise;
    return {account_id:'fictional-owner',access_token:'example-access',refresh_token:'example-refresh',expires_in:14400};
  });
  await cloud.settings({});
  browser = await openChromium(profile);
  await linkFixture(browser,origin,'/'); await browser.navigate(origin+'/#/settings');
  await browser.waitFor('document.querySelector(".sync-state")?.dataset.synced==="true"');
  await browser.click('[data-sign-out]'); await browser.waitFor('!!document.querySelector("[data-sign-in]:enabled")');
  await browser.navigate(origin+'/tmdb-logo.svg');
  ticket = await browser.evaluate('('+(async function () {
    const {openDeviceStore} = await import('/storage.js'), {DropboxAuth} = await import('/dropbox-auth.js');
    const store = await openDeviceStore(); await store.whenWriter();
    const auth = new DropboxAuth(store,()=>localStorage.getItem('csvTV-public-dropbox-app-key'));
    let destination;
    try {
      await auth.authorize({sessionStorage,location:{href:location.origin+'/',assign:url=>{destination=new URL(url);}}});
      return {state:destination.searchParams.get('state'),challenge:destination.searchParams.get('code_challenge')};
    } finally { auth.close(); await store.closeForUpdate(); }
  }).toString()+')()');
  hold = true;
  await browser.send('Page.navigate',{url:origin+'/?'+new URLSearchParams({state:ticket.state,code})+'#/settings'});
  const handoff = '"csvTV/dropbox-callback-v2//"';
  await browser.waitFor('location.search==="" && !!sessionStorage.getItem('+handoff+')');
  await browser.evaluate('void(window.fixtureSibling=window.open('+(late ? '"/tmdb-logo.svg"' : 'location.href')+',"_blank"))');
  const copied = late ? 'window.fixtureSibling?.location.pathname==="/tmdb-logo.svg"' : 'window.fixtureSibling?.document.querySelector("#app")';
  await browser.waitFor(copied+' && !!window.fixtureSibling.sessionStorage.getItem('+handoff+')');
  main.resolve(); await accepted.promise;
  if (!late) await browser.waitFor('[document,window.fixtureSibling.document].some(d=>d.body.innerText.includes("This Dropbox sign-in was already submitted."))');
  assert.equal(exchanges,1);
  reply.resolve();
  await until(()=>browser.evaluate(isLinked),'the accepted sign-in is available to both tabs');
  if (late) {
    await browser.evaluate('void(window.fixtureSibling.location.href=location.href)');
    await browser.waitFor('!!window.fixtureSibling.document.querySelector("main [data-dropbox-help]") && !window.fixtureSibling.sessionStorage.getItem('+handoff+')');
    assert.doesNotMatch(await browser.evaluate('window.fixtureSibling.document.body.innerText'),/Start Dropbox sign-in again|was already submitted|different Dropbox sign-in/);
  }
  assert.equal(await browser.evaluate('window.fixtureSibling.location.search'), '');
  assert.equal(await browser.evaluate('!!sessionStorage.getItem('+handoff+') || !!window.fixtureSibling.sessionStorage.getItem('+handoff+')'),false);
  assert.equal(exchanges,1);
});
