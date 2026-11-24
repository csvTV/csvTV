import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {readCsv,writeCsv} from '../dist/csv.js';
import {openChromium,until} from './offline-chromium.mjs';
import {linkFixture,offlineProviders} from './offline-providers.mjs';
import {listen,stop,testSite} from './offline-site.mjs';

// Hold the new list's winning read until the shell has superseded the editor's own refresh.
async function overlapListRefreshes(name) {
  const {DeviceStore} = await import('/tracker/storage.js');
  const read = DeviceStore.prototype.listPageRows, gate = Promise.withResolvers();
  const race = window.listFocusRace = {reads:0, superseded:false, release() {
    DeviceStore.prototype.listPageRows = read;
    gate.resolve();
  }};
  DeviceStore.prototype.listPageRows = async function(selected,signal,...rest) {
    if (selected === name && ++race.reads === 1) {
      signal.addEventListener('abort',()=>{ race.superseded = true; },{once:true});
      window.dispatchEvent(new Event('online'));
    }
    const result = await read.call(this,selected,signal,...rest);
    if (!signal.aborted) await Promise.race([gate.promise,new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}))]);
    return result;
  };
}

test('Create an empty list, restore it on another device and add a TMDB search result with the keyboard', {timeout:90000},async t=>{
  const {server} = await testSite(), origin = 'http://127.0.0.1:'+await listen(server);
  const profiles = await mkdtemp(join(tmpdir(),'csvtv-list-search-')), cloud = offlineProviders(origin);
  const local = {show_id:45,show:'The Listening House'}, remote = {show_id:46,show:'Signal Park'};
  const listName = 'Rainy evenings and long weekends at the lighthouse by the sea';
  const catalogMatch = {show_id:47,show:'Listening Post'};
  await cloud.settings({tmdb_key:'fictional-offline-key'});
  await cloud.upload('watched.csv',writeCsv('watched',[{...local,season:1,episode:1,episode_id:45011,title:'Recording 1',times_watched:1}]));
  const queries = [];
  async function respond(params,send) {
    const {request,requestId} = params, url = new URL(request.url);
    if (url.hostname === 'api.themoviedb.org' && url.pathname === '/3/search/tv' && request.method === 'GET') {
      const term = url.searchParams.get('query');
      queries.push(term);
      const matches = [local,remote,catalogMatch].filter(show => show.show.toLowerCase().includes(term.toLowerCase()));
      const results = matches.map(show=>({id:show.show_id,name:show.show,first_air_date:'2019-10-01'}));
      return send('Fetch.fulfillRequest',{requestId,responseCode:200,
        responseHeaders:[{name:'Access-Control-Allow-Origin',value:origin},{name:'Content-Type',value:'application/json'}],
        body:Buffer.from(JSON.stringify({page:1,total_pages:1,results})).toString('base64')});
    }
    return cloud.respond(params,send);
  }
  let browser;
  t.after(async()=>{
    try { await browser?.close(); }
    finally { await stop(server); await rm(profiles,{recursive:true,force:true,maxRetries:6,retryDelay:150}); }
  });
  const visit = route => browser.navigate(origin+'/tracker/#/'+route);
  const remoteList = () => {
    const file = cloud.files.get('/lists.csv');
    return file ? readCsv('lists',file.bytes).rows.filter(row=>row.list===listName) : [];
  };
  async function signIn(name,width) {
    browser = await openChromium(join(profiles,name),respond);
    await browser.send('Emulation.setDeviceMetricsOverride',{width,height:800,deviceScaleFactor:1,mobile:width<600});
    await linkFixture(browser,origin);
    await visit('settings');
    await browser.waitFor('document.querySelector(".sync-state")?.dataset.synced === "true"');
    await visit('lists');
  }
  await signIn('desktop',1280);
  await browser.click('.list-new');
  await browser.send('Input.insertText',{text:listName});
  await browser.evaluate('('+overlapListRefreshes.toString()+')('+JSON.stringify(listName)+')');
  await browser.press('Enter');
  await browser.waitFor('window.listFocusRace.superseded && window.listFocusRace.reads >= 2','two overlapping list refreshes');
  await browser.evaluate('window.listFocusRace.release()');
  const chosen = 'document.querySelector("#chosen-list")?.textContent === '+JSON.stringify(listName);
  const field = '.lists-screen section input[type=search]';
  await browser.waitFor(chosen+' && !document.querySelector("dialog:modal")');
  assert.equal(await browser.evaluate('document.activeElement.matches('+JSON.stringify(field)+')'),true,
    'The new list should be ready to search as soon as its heading appears');
  await browser.evaluate('window.listFocusBeforeRefresh = document.querySelector(".list-new"); window.dispatchEvent(new Event("online"))');
  await browser.waitFor('!window.listFocusBeforeRefresh.isConnected','a background update of the list controls');
  assert.equal(await browser.evaluate('document.activeElement.matches('+JSON.stringify(field)+')'),true,
    'A queued refresh moved focus away from the new list search');
  assert.equal(await browser.evaluate('document.querySelectorAll(".list-shows li").length'),0);
  await visit('settings'); await browser.click('[data-sync]');
  await until(()=>remoteList().length===1,'the empty list to reach fictional Dropbox');
  await browser.close(); browser = undefined;

  await signIn('phone',320);
  await browser.waitFor(chosen);
  assert.equal(await browser.evaluate('document.querySelectorAll(".list-shows li").length'),0);
  const add = title => 'button[aria-label="Add '+title+' to '+listName+'"]';
  async function search(text) {
    await browser.evaluate('document.querySelector('+JSON.stringify(field)+').focus()');
    await browser.evaluate('document.querySelector('+JSON.stringify(field)+').select()');
    await browser.send('Input.insertText',{text});
  }
  await search('listening');
  await until(()=>queries.some(term=>term.toLowerCase()==='listening'),'the TMDB search for an existing Library show');
  await browser.waitFor('!!document.querySelector('+JSON.stringify(add(catalogMatch.show))+')');
  assert.equal(await browser.evaluate('document.querySelectorAll('+JSON.stringify(add(local.show))+').length'),1);
  await browser.evaluate('document.querySelector(".list-tools select").focus()');
  await browser.press('Home');
  await browser.waitFor('document.querySelector(".list-tools select").value === "high"','the longer Highest rated sort label');
  await search('signal');
  await browser.waitFor('!!document.querySelector('+JSON.stringify(add(remote.show))+')');
  for (const width of [1920,1280,900,899,844,601,600,390,375,320]) {
    await browser.send('Emulation.setDeviceMetricsOverride',{width,height:800,deviceScaleFactor:1,mobile:width<600});
    await browser.send('Emulation.setTouchEmulationEnabled',{enabled:width<900});
    await browser.waitFor('innerWidth === '+width);
    const layout = await browser.evaluate(`(() => {
      const bounds = selector => document.querySelector(selector).getBoundingClientRect();
      const heading = bounds('#chosen-list'), field = bounds('.list-search .tv-search-field');
      const sort = bounds('.list-tools select'), manage = bounds('.list-more'), results = bounds('.list-search-menu');
      const center = rect => rect.top+rect.height/2;
      const input = document.querySelector('.list-search input');
      const hint = document.createElement('span');
      const ink = getComputedStyle(input,'::placeholder');
      Object.assign(hint.style,{position:'absolute',visibility:'hidden',width:'max-content',
        fontFamily:ink.fontFamily,fontSize:ink.fontSize,fontWeight:ink.fontWeight,letterSpacing:ink.letterSpacing});
      hint.textContent = input.placeholder;
      input.after(hint);
      const hintWidth = hint.getBoundingClientRect().width;
      hint.remove();
      return {oneRow:Math.abs(center(field)-center(sort)) < 2 && Math.abs(center(sort)-center(manage)) < 2,
        ordered:field.right <= sort.left && sort.right <= manage.left,
        inputWidth:input.getBoundingClientRect().width, hintWidth, resultWidth:results.width,
        touchTargets:[field,sort,manage].every(box=>box.height>=44),
        headingBeside:heading.right <= field.left && heading.bottom > field.top,
        fits:results.left >= 0 && results.right <= innerWidth && results.top >= field.bottom &&
          manage.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth};
    })()`);
    assert.ok(layout.oneRow && layout.ordered && layout.fits,'Search, Sort, menu and suggestions must fit at '+width+'px');
    assert.ok(layout.hintWidth > 0 && layout.inputWidth >= layout.hintWidth + 2 && layout.resultWidth >= 200,
      'List search is too narrow at '+width+'px: '+JSON.stringify(layout));
    if (width < 900) assert.ok(layout.touchTargets,'Search, Sort and list actions should remain tappable at '+width+'px');
    if (width === 1920) assert.ok(layout.headingBeside,'A wide screen should keep search next to its list heading');
  }
  await browser.press('ArrowDown');
  assert.equal(await browser.evaluate('document.activeElement.matches('+JSON.stringify(add(remote.show))+')'),true);
  await browser.press('Escape');
  await browser.waitFor('document.activeElement.matches('+JSON.stringify(field)+') && !document.querySelector('+JSON.stringify(add(remote.show))+')?.getClientRects().length');
  await search('signal park');
  await browser.waitFor('!!document.querySelector('+JSON.stringify(add(remote.show))+')?.getClientRects().length');
  await browser.press('ArrowDown'); await browser.press('Enter');
  await browser.waitFor('document.querySelector(".list-shows strong")?.textContent === "Signal Park"');
  assert.equal(await browser.evaluate('document.querySelectorAll(".list-shows li").length'),1);
  await visit('settings'); await browser.click('[data-sync]');
  await until(()=>remoteList().some(row=>row.show_id===remote.show_id),'the new member to reach fictional Dropbox');
  assert.deepEqual(remoteList().filter(row=>row.show).map(row=>[row.show_id,row.show]),[[remote.show_id,remote.show]]);
  assert.deepEqual(readCsv('watched',cloud.files.get('/watched.csv').bytes).rows.map(row=>[row.show_id,row.times_watched]),[[local.show_id,1]]);
});
