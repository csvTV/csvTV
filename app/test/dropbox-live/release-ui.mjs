import assert from 'node:assert/strict';
import {until} from '../offline-chromium.mjs';
import {offlineProviders} from '../offline-providers.mjs';

const show = {show_id:45,show:'The Listening House'};
const planned = {show_id:46,show:'The Listening Post'};
export const sampleRecord = {
  watched:[{...show,season:1,episode:1,title:'Recording 1',times_watched:1,episode_id:45011}],
  ratings:[{...show,rating:7}], lists:[{...planned,list:'Watchlist'}],
  shows:[{...show,year:2019,imdb_id:''},{...planned,year:null,imdb_id:''}],
};
export const dummyKeys = {
  tmdb_key:'fictional-offline-key', mdblist_key:'fictional-dropbox-probe-scores',
  omdb_key:'fictional-dropbox-probe-imdb', github_token:'fictional-dropbox-probe-github',
};

// Only Dropbox is live. Responses from metadata providers use the same made-up show as the release tests.
export async function providerReply(message, send, origin) {
  const {request,requestId} = message, url = new URL(request.url);
  assert.ok(['api.themoviedb.org','api.mdblist.com','www.omdbapi.com'].includes(url.hostname),'Unexpected provider');
  const headers = new Headers(request.headers);
  const preflight = request.method === 'OPTIONS';
  if (url.hostname === 'api.themoviedb.org') {
    if (!preflight) assert.ok(headers.get('authorization') === 'Bearer ' + dummyKeys.tmdb_key, 'Unexpected TMDB credential');
    if (!['/3/tv/45/external_ids','/3/tv/46','/3/tv/46/external_ids'].includes(url.pathname)) return offlineProviders(origin).respond(message,send);
  }
  let data;
  if (!preflight) {
    assert.equal(request.method,'GET');
    if (url.hostname === 'api.mdblist.com') {
      assert.ok(url.searchParams.get('apikey') === dummyKeys.mdblist_key,'Unexpected MDBList credential');
      assert.ok(['/tmdb/show/45','/tmdb/show/46'].includes(url.pathname));
      data = {ids:{tmdb:Number(url.pathname.split('/').at(-1))},type:'show',ratings:[]};
    } else if (url.hostname === 'www.omdbapi.com') {
      assert.ok(url.searchParams.get('apikey') === dummyKeys.omdb_key,'Unexpected OMDb credential');
      data = {Response:'False',Error:'Series not found!'};
    } else if (url.pathname === '/3/tv/46') {
      data = {id:planned.show_id,name:planned.show,status:'Planned',seasons:[],keywords:{results:[]},external_ids:{imdb_id:null}};
    } else data = {id:Number(url.pathname.split('/')[3]),imdb_id:null};
  }
  await send('Fetch.fulfillRequest',{requestId,responseCode:preflight ? 204 : 200,
    responseHeaders:Object.entries({'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Methods':'GET, OPTIONS',
      'Access-Control-Allow-Headers':'Authorization, Content-Type','Content-Type':'application/json','Cache-Control':'no-store'})
      .map(([name,value])=>({name,value})),
    ...(preflight ? {} : {body:Buffer.from(JSON.stringify(data)).toString('base64')})});
}

const element = selector => 'document.querySelector(' + JSON.stringify(selector) + ')';
const readyButton = selector => element(selector) + '?.matches(":enabled:not([hidden])") && ' + element(selector) + '.getClientRects().length > 0';
const wait = (browser, expression, description) => until(()=>browser.evaluate(expression),description,180_000);
const route = (browser,origin,screen) => browser.navigate(new URL('/#/'+screen,origin).href);

export async function beginSignIn(browser,origin,publicKey) {
  await route(browser,origin,'settings');
  const configured = await browser.evaluate("document.querySelector('meta[name=dropbox-app-key]')?.content || localStorage.getItem('csvTV-public-dropbox-app-key')");
  if (configured) assert.ok(configured === publicKey,'The isolated browser contains a different app registration.');
  else {
    await wait(browser,readyButton('[data-edit-client]'),'public Dropbox app registration');
    await browser.click('[data-edit-client]');
    await browser.evaluate('const field = document.querySelector(\'input[name="appKey"]\'); field.value=' +
      JSON.stringify(publicKey) + '; field.form.requestSubmit();');
  }
  await wait(browser,readyButton('[data-sign-in]'),'Dropbox sign-in button');
  await browser.click('[data-sign-in]');
}

export async function waitSynced(browser,origin,expectedRating) {
  await route(browser,origin,'library');
  await wait(browser,element('.library-grid strong')+'?.textContent === "The Listening House" && '+
    element('.library-rating')+'?.textContent === '+JSON.stringify(expectedRating+'/10')+' && '+
    element('.sync-state')+'?.textContent === "Synced"','Dropbox sync and the expected Library rating');
}

async function saveKey(browser,edit,field,key,status) {
  await wait(browser,readyButton(edit),'available provider key editor');
  await browser.click(edit);
  await browser.waitFor(element(field)+'?.matches("input[type=password]")','blank masked key field');
  assert.equal(await browser.evaluate(element(field)+'.value'),'');
  await browser.evaluate(element(field)+'.value = '+JSON.stringify(key));
  await browser.click('dialog[open] button[type=submit]');
  await wait(browser,'!document.querySelector("dialog[open]") && '+element(status)+'?.textContent === "Saved in Dropbox"',
    'verified save in the provider settings');
}

export async function saveProviderKeys(browser,origin,onStage = ()=>{}) {
  await route(browser,origin,'settings');
  onStage('saving the TMDB key');
  await saveKey(browser,'[data-edit]','#tmdb-input',dummyKeys.tmdb_key,'#tmdb-key-label ~ [data-key-status]');
  onStage('saving the MDBList key');
  await saveKey(browser,'[data-mdblist-edit]','#mdblist-input',dummyKeys.mdblist_key,'[data-mdblist-status]');
  await route(browser,origin,'imdb-ratings');
  for (const [source,setting] of [['omdb','omdb_key'],['github','github_token']]) {
    onStage('saving the '+source+' key');
    await browser.click('input[name="imdb-source"][value="'+source+'"]');
    await saveKey(browser,'[data-imdb-edit="'+setting+'"]','#imdb-setting-input',dummyKeys[setting],
      '[data-imdb-value="'+setting+'"]');
  }
  // The fixture contains no repository, so no GitHub file or external account is needed.
  onStage('sync after saving the four keys');
  await route(browser,origin,'settings');
  await wait(browser,readyButton('[data-sync]'),'manual sync after configuring all providers');
  await browser.click('[data-sync]');
  await waitSynced(browser,origin,7);
}

export async function signOutAndEditOffline(browser,origin,onOffline) {
  await route(browser,origin,'settings');
  await wait(browser,element('[data-offline-status]')+'?.textContent === "Ready to open offline." && navigator.serviceWorker.controller',
    'installed offline release');
  await wait(browser,readyButton('[data-sign-out]'),'sign out of the first Dropbox grant');
  await browser.click('[data-sign-out]');
  await wait(browser,readyButton('[data-sign-in]')+' && '+element('[data-sign-out]')+'.hidden','signed out of Dropbox');
  await onOffline?.();
  await browser.offline(true);
  assert.equal(await browser.evaluate('navigator.onLine'),false);
  await route(browser,origin,'library');
  await browser.click('a[href="#/show/45"]');
  await browser.click('.show-rating');
  const slider = 'dialog[open] input[type=range]';
  await browser.waitFor(element(slider)+'?.value === "7"','initial personal rating');
  await browser.evaluate(element(slider)+'.focus()');
  await browser.press('ArrowRight');
  await browser.press('ArrowRight');
  await browser.waitFor(element(slider)+'.value === "8"','offline rating selection');
  await browser.click('dialog[open] .rating-commands button:last-child');
  await browser.waitFor(element('.show-rating')+'?.textContent === "8/10"','offline rating saved');
  await route(browser,origin,'watchlist');
  const removeMembership = '[data-watchlist-remove="46"]';
  await browser.waitFor(readyButton(removeMembership),'original unwatched Watchlist membership');
  await browser.evaluate(element(removeMembership)+'.focus()');
  await browser.press('Enter');
  const removed = element('.watch-lead')+'?.textContent === "Your Watchlist is empty." && !'+element(removeMembership);
  await browser.waitFor(removed,'offline Watchlist removal');
  const previousDocument = await browser.evaluate('performance.timeOrigin');
  await browser.send('Page.reload');
  await wait(browser,'performance.timeOrigin !== '+previousDocument+' && !navigator.onLine && '+removed,
    'a new offline page retaining the Watchlist removal');
  await route(browser,origin,'library');
  await wait(browser,element('.library-rating')+'?.textContent === "8/10" && '+element('.sync-state')+'?.textContent === "Not synced"',
    'a new offline page retaining the rating');
}
