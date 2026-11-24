import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {openChromium} from './offline-chromium.mjs';
import {linkFixture,offlineProviders} from './offline-providers.mjs';
import {listen,stop,testSite} from './offline-site.mjs';

test('a provider key in a request URL stays out of the page’s timing records, including a reply after sign-out',async t => {
  const {server}=await testSite(),origin='http://127.0.0.1:'+await listen(server);
  const provider=offlineProviders(origin), key='fictional-timing-key';
  const pending=Promise.withResolvers(), release=Promise.withResolvers();
  const profile=await mkdtemp(join(tmpdir(),'csvtv-timing-'));
  let browser,requests=0;
  t.after(async()=>{
    release.resolve();
    try {await browser?.close();} finally {await stop(server);await rm(profile,{recursive:true,force:true,maxRetries:6,retryDelay:150});}
  });
  await provider.settings({omdb_key:key,imdb_source:'omdb'});
  browser=await openChromium(profile,async(event,answer)=>{
    const url=new URL(event.request.url);
    if(url.hostname!=='www.omdbapi.com') return provider.respond(event,answer);
    assert.equal(url.searchParams.get('apikey'),key);
    if(++requests===2) {pending.resolve();await release.promise;}
    const body=JSON.stringify({Response:'True',Type:'series',imdbID:url.searchParams.get('i'),imdbRating:'7.2'});
    await answer('Fetch.fulfillRequest',{requestId:event.requestId,responseCode:200,body:Buffer.from(body).toString('base64'),
      responseHeaders:[{name:'Access-Control-Allow-Origin',value:origin},{name:'Cache-Control',value:'no-store'},{name:'Content-Type',value:'application/json'}]});
  });
  await linkFixture(browser,origin);
  await browser.navigate(origin+'/tracker/#/settings');
  await browser.waitFor('document.querySelector(".sync-state")?.dataset.synced==="true"');
  const lookup='new (await import("./omdb-client.js")).OmdbClient().lookup';
  assert.equal(await browser.evaluate(`(async()=> (await ${lookup}("tt0500001",null,${JSON.stringify(key)})).rating)()`),7.2);
  await browser.evaluate(`(async()=>{window.pendingFictionalScore=${lookup}("tt0500002",null,${JSON.stringify(key)});})()`);
  await pending.promise;
  await browser.click('[data-sign-out]');
  await browser.waitFor('!document.querySelector("[data-sign-in]")?.hidden');
  release.resolve();
  assert.equal(await browser.evaluate('(async()=> (await window.pendingFictionalScore).rating)()'),7.2);
  await browser.click('.app-sidebar a[href="#/library"]');
  await browser.waitFor('document.querySelector(".library-screen")');
  assert.equal(await browser.evaluate(`performance.getEntriesByType('resource').some(entry => entry.name.includes(${JSON.stringify(key)}))`),false);
  assert.equal(requests,2);
});
