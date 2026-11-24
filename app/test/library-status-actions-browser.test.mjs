import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {readCsv, writeCsv} from '../dist/csv.js';
import {openChromium} from './offline-chromium.mjs';
import {linkFixture, offlineProviders} from './offline-providers.mjs';
import {listen, stop, testSite} from './offline-site.mjs';

const title = 'The Listening House';
const initial = [3, 1].map((times_watched, i) => ({show_id:45, show:title, season:1, episode:i+1,
  title:'Recording '+(i+1), times_watched, episode_id:45011+i}));

async function seedEpisodeCache(headerOnly) {
  const {openDeviceStore} = await import('/tracker/storage.js');
  const {tmdbResourceKey} = await import('/tracker/tmdb-client.js');
  const store = await openDeviceStore();
  try {
    await store.whenWriter();
    const {session} = await store.dropboxState();
    store.connectProviderKeys(() => { throw Error('Unexpected key edit during fixture setup'); }, Date.now);
    await store.loadProviderKeys(session,[{setting:'tmdb_key',value:'fictional-offline-key'}],()=>true);
    if (headerOnly) await store.clearRebuildableCaches();
    const {generation} = await store.tmdbState(), now = Date.now();
    const summaries = [{season:0,name:'Specials',episodeCount:1,posterPath:null},
      {season:1,name:'Season 1',episodeCount:4,posterPath:null}];
    const show = {show_id:45, show:'The Listening House', status:'Returning Series', seasons:summaries,
      firstAirDate:'2020-10-01', overview:'', posterPath:null, backdropPath:null, networks:[], imdbId:null,
      genres:[], originCountries:[], keywords:[], lastAired:{season:1,episode:3,airDate:'2020-10-03'},
      nextAirDate:'2099-10-04', nextEpisode:{season:1,episode:4,airDate:'2099-10-04'}};
    if (headerOnly) {
      const estimate = {...show,seasons:[{...summaries[1],episodeCount:1}],
        lastAired:{season:1,episode:1,airDate:'2020-10-01'},nextAirDate:null,nextEpisode:null};
      return await store.writeTmdb(generation,{entries:{[tmdbResourceKey({kind:'show',id:45})]:{fetchedAt:now,value:estimate}}},now);
    }
    const entries = {[tmdbResourceKey({kind:'show',id:45})]:{fetchedAt:now,value:show}};
    for (const {season,name,episodeCount} of summaries) {
      const episodes = Array.from({length:episodeCount}, (_,i) => ({episode:i+1,episode_id:45001+season*10+i,
        title:'Recording '+(i+1),airDate:i===3 ? '2099-10-04':'2020-10-01',runtime:30,stillPath:null,overview:''}));
      entries[tmdbResourceKey({kind:'season',id:45,season})] = {fetchedAt:now,value:{show_id:45,season,name,posterPath:null,episodes}};
    }
    return await store.writeTmdb(generation,{entries},now);
  } finally { await store.closeForUpdate(); }
}

async function readRecord() {
  const {openDeviceStore} = await import('/tracker/storage.js');
  const store = await openDeviceStore();
  try {
    const {watched,lists} = await store.overviewRows();
    return {plays:watched.map(row=>[row.season,row.episode,row.times_watched]), lists:lists.map(row=>row.list)};
  } finally { store.close(); }
}

async function openLibrary(t,rows,headerOnly = false) {
  const {server} = await testSite(), origin = 'http://127.0.0.1:'+await listen(server);
  const profile = await mkdtemp(join(tmpdir(),'csvtv-library-status-')), providers = offlineProviders(origin);
  let browser;
  t.after(async () => {
    try { await browser?.close(); }
    finally { await stop(server); await rm(profile,{recursive:true,force:true,maxRetries:6,retryDelay:150}); }
  });
  await providers.settings({tmdb_key:'fictional-offline-key'});
  await providers.upload('watched.csv',writeCsv('watched',rows));
  browser = await openChromium(profile,providers.respond);
  await linkFixture(browser,origin);
  await browser.navigate(origin+'/tracker/#/settings');
  await browser.waitFor('document.querySelector("[data-cloud-reason]")?.textContent === "Synced"');
  await browser.navigate(origin+'/fixture');
  assert.equal(await browser.evaluate('('+seedEpisodeCache.toString()+')('+headerOnly+')'),true);
  const library = origin+'/tracker/#/library';
  await browser.send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
  await browser.navigate(library);
  return {browser,providers,library};
}

test('Library status actions finish, drop, pick up and rewatch a show without navigating or changing unrelated episodes',
  {timeout:90000}, async t => {
    const {browser,providers,library} = await openLibrary(t,initial);

    const row = '[data-library-show="45"]', status = row+' [aria-haspopup=menu]', touchButton = row+' [aria-haspopup=dialog]';
    const query = css => 'document.querySelector('+JSON.stringify(css)+')';
    const control = query(status), menu = '.library-status-menu', dialog = 'dialog[open]', toggle = '[data-filter=dropped]';
    const record = () => browser.evaluate('('+readRecord.toString()+')()');
    const partly = {plays:[[1,1,3],[1,2,1]],lists:[]};
    const waitStatus = text => browser.waitFor(query(row+' .library-status-caption')+'?.textContent === '+JSON.stringify(text)+' && location.hash === "#/library"',text+' in Library');
    const labels = 'Array.from(document.querySelectorAll("dialog[open] .watch-sheet-action span"),s=>s.textContent)';
    async function checkOptions(expected) {
      if (!await browser.evaluate('Boolean('+query(menu)+')')) await browser.click(status);
      assert.deepEqual(await browser.evaluate('Array.from(document.querySelectorAll(".library-status-menu [role=menuitem]"),o=>o.textContent)'),expected);
      assert.equal(await browser.evaluate('Boolean('+query(dialog)+')'),false);
    }
    async function choose(label) {
      if (!await browser.evaluate('Boolean('+query(menu)+')')) {
        await browser.evaluate(control+'.focus()');
        await browser.press('ArrowDown');
      }
      if (label === 'Drop') await browser.press('End');
      assert.equal(await browser.evaluate('document.activeElement.textContent'),label);
      await browser.press('Enter');
    }
    async function controlPoint(selector) {
      return browser.evaluate('('+ (function(selector) {
        const control = document.querySelector(selector);
        control.scrollIntoView({block:'center'});
        const {x,y,width,height} = control.getBoundingClientRect();
        return {x:x+width/2,y:y+height/2};
      }).toString()+')('+JSON.stringify(selector)+')');
    }
    async function checkSpacing() {
      const read = selector => query(row+' '+selector)+'.getBoundingClientRect()';
      const gap = await browser.evaluate(read('.library-status-caption')+'.top - '+read('strong')+'.bottom');
      assert.ok(gap >= 0 && gap <= 5,'Title-to-count gap was '+gap+'px');
    }

    await waitStatus('2 of 3');
    assert.deepEqual(await record(),partly);
    await checkSpacing();
    const point = await controlPoint(status);
    const before = await browser.evaluate(control+'.getBoundingClientRect().toJSON()');
    async function clickPoint(point) {
      for (const type of ['mousePressed','mouseReleased']) await browser.send('Input.dispatchMouseEvent',{type,...point,button:'left',clickCount:1});
    }
    await clickPoint(point);
    await browser.waitFor(control+'.getAttribute("aria-expanded")==="true" && '+query(menu));
    await checkOptions(['Complete','Drop']);
    assert.deepEqual(await browser.evaluate(control+'.getBoundingClientRect().toJSON()'),before,'opening moved the count');
    const menuColors = 'Array.from(document.querySelectorAll(".library-status-menu button"),button=>getComputedStyle(button).backgroundColor)';
    await browser.waitFor('document.activeElement === '+query(menu));
    assert.equal(await browser.evaluate('getComputedStyle(document.activeElement).outlineStyle'),'none','A pointer-opened Library menu has no focus outline');
    const neutralColors = await browser.evaluate(menuColors);
    assert.deepEqual(neutralColors,['rgba(0, 0, 0, 0)','rgba(0, 0, 0, 0)'],'clicking the count should leave both choices neutral');
    await browser.press('Enter');
    assert.deepEqual(await record(),partly);
    await browser.press('ArrowDown');
    assert.equal(await browser.evaluate('document.activeElement.textContent'),'Complete');
    assert.equal(await browser.evaluate('getComputedStyle(document.activeElement).outlineStyle'),'solid','Arrow navigation keeps the focused menu item visible');
    const dropPoint = await browser.evaluate('('+(function() {
      const {x,y,width,height} = document.querySelector('.library-status-menu button:last-child').getBoundingClientRect();
      return {x:x+width/2,y:y+height/2};
    }).toString()+')()');
    await browser.send('Input.dispatchMouseEvent',{type:'mouseMoved',...dropPoint});
    await browser.waitFor('document.activeElement.textContent === "Drop"');
    const pointerColors = await browser.evaluate(menuColors);
    assert.notEqual(pointerColors[0],pointerColors[1]);
    await browser.send('Input.dispatchMouseEvent',{type:'mouseMoved',...point});
    await browser.waitFor('document.activeElement === '+query(menu));
    assert.deepEqual(await browser.evaluate(menuColors),neutralColors,'leaving the choices should clear pointer highlighting');
    await browser.press('ArrowUp');
    assert.equal(await browser.evaluate('document.activeElement.textContent'),'Drop','ArrowUp from the neutral menu should start at the last action');
    await browser.send('Input.dispatchMouseEvent',{type:'mouseMoved',...dropPoint});
    await browser.press('ArrowDown');
    assert.deepEqual(await browser.evaluate(menuColors),pointerColors.toReversed(),'the keyboard transfers the single highlight even with the mouse over Drop');
    await browser.press('ArrowUp');
    assert.equal(await browser.evaluate('document.activeElement.textContent'),'Drop');
    await browser.press('Home');
    assert.equal(await browser.evaluate('document.activeElement.textContent'),'Complete');
    await browser.press('Escape');
    await browser.waitFor('!'+query(menu)+' && document.activeElement === '+control);
    assert.deepEqual(await record(),partly);
    await clickPoint(point);
    await browser.waitFor(query(menu));
    await clickPoint(point);
    await browser.waitFor('!'+query(menu)+' && document.activeElement === '+control);
    await clickPoint(point);
    await browser.waitFor(query(menu));
    await clickPoint({x:1438,y:897});
    await browser.waitFor('!'+query(menu));
    assert.deepEqual(await record(),partly);
    await browser.evaluate(control+'.focus()');

    // Place the real count at the lower-right edge at the app's 125% desktop scale.
    await browser.evaluate(control+'.parentElement.style.cssText="position:fixed;right:1px;bottom:2px"');
    await browser.press('ArrowUp');
    assert.equal(await browser.evaluate('document.activeElement.textContent'),'Drop');
    await browser.waitFor(query(menu)+'.hasAttribute("data-above") && '+query(menu)+'.getBoundingClientRect().right <= innerWidth && '+
      query(menu)+'.getBoundingClientRect().bottom <= '+control+'.getBoundingClientRect().top');
    await browser.evaluate(control+'.parentElement.style.cssText="position:fixed;left:8px;top:8px"; document.querySelector(".library-selects input[type=search]").dispatchEvent(new Event("input"))');
    await browser.waitFor('!'+query(menu)+'.hasAttribute("data-above") && '+query(menu)+'.getBoundingClientRect().top >= '+control+'.getBoundingClientRect().bottom');
    await browser.press('Tab',{shift:true});
    await browser.waitFor('!'+query(menu)+' && document.activeElement === '+query(row+' a'));
    await browser.evaluate(control+'.parentElement.removeAttribute("style")');
    await browser.click(status);
    const outside = await controlPoint('.library-selects input[type=search]');
    await clickPoint(outside);
    await browser.waitFor('!'+query(menu)+' && document.activeElement.matches(".library-selects input[type=search]")');
    await clickPoint(point);
    await browser.waitFor(query(menu));
    await browser.send('Input.dispatchMouseEvent',{type:'mouseMoved',...dropPoint});
    await clickPoint(dropPoint);
    await waitStatus('Dropped');
    assert.deepEqual(await record(),{...partly,lists:['Dropped']});
    await browser.click('.undo-bar [data-undo]');
    await waitStatus('2 of 3');
    assert.deepEqual(await record(),partly);
    await choose('Drop');
    await waitStatus('Dropped');
    await browser.click(toggle);
    await browser.waitFor(query(toggle)+'.getAttribute("aria-pressed") === "true" && '+query(row)+'?.textContent.includes("2 of 3")');
    await checkOptions(['Pick up']);
    await choose('Pick up');
    await browser.waitFor('!'+query(row));
    assert.deepEqual(await record(),{...partly,lists:['csvTV: picked up']});
    await browser.click(toggle);
    await waitStatus('2 of 3');

    await browser.evaluate('window.libraryReader = window.open(location.href,"csvtv-library-reader"); true');
    const readerControl = row+' .library-status-trigger';
    await browser.waitFor('libraryReader.document.querySelector('+JSON.stringify(readerControl)+')?.disabled','read-only status in second tab');
    await browser.evaluate('libraryReader.document.querySelector('+JSON.stringify(readerControl)+').click()');
    assert.equal(await browser.evaluate('Boolean(libraryReader.document.querySelector("dialog[open],.library-status-menu"))'),false);
    await browser.evaluate('libraryReader.close()');
    await browser.offline(true);

    // Hold a real watch write at the transaction boundary, then filter away its card.
    await browser.evaluate('('+(async function() {
      const {DeviceStore} = await import('/tracker/storage.js');
      const commit = DeviceStore.prototype.commit;
      DeviceStore.prototype.commit = async function(revision,changes,options) {
        if (!changes.put?.watched?.length) return commit.call(this,revision,changes,options);
        DeviceStore.prototype.commit = commit;
        await new Promise(resolve=>{ window.releaseLibraryCommit = resolve; });
        try { return await commit.call(this,revision,changes,options); }
        finally { window.libraryCommitSettled = true; }
      };
    }).toString()+')()');
    await checkOptions(['Complete','Drop']);
    await choose('Complete');
    await browser.waitFor('typeof window.releaseLibraryCommit === "function"','delayed watch write');
    await browser.click(toggle);
    await browser.waitFor('!'+query(row));
    await browser.evaluate('window.releaseLibraryCommit()');
    await browser.waitFor('window.libraryCommitSettled','stale action settles after filtering');
    assert.deepEqual((await record()).plays,partly.plays);
    await browser.click(toggle);
    await waitStatus('2 of 3');

    await browser.evaluate('('+(async function() {
      const {DeviceStore} = await import('/tracker/storage.js');
      const original = DeviceStore.prototype.overviewRows;
      window.libraryRecordReads = 0;
      DeviceStore.prototype.overviewRows = function(...args) {
        if (this.role === 'writer') window.libraryRecordReads++;
        return original.apply(this,args);
      };
    }).toString()+')()');
    await choose('Complete');
    await waitStatus('Complete');
    assert.deepEqual((await record()).plays,[[1,1,3],[1,2,1],[1,3,1]]);
    await browser.evaluate('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))');
    assert.equal(await browser.evaluate('window.libraryRecordReads'),1,'one Library record read per offline edit');
    await checkOptions(['Watch again']);

    // A narrow desktop window also uses the sheet. Widen it while the sheet
    // has focus before changing this browser target to touch input.
    await browser.send('Emulation.setDeviceMetricsOverride',{width:375,height:760,deviceScaleFactor:1,mobile:false});
    await browser.click(touchButton);
    await browser.waitFor(query(dialog));
    await browser.send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
    await browser.waitFor('!'+query(dialog)+' && '+control+' && document.activeElement === '+control,'switch from an open sheet to the desktop picker');

    await browser.send('Emulation.setDeviceMetricsOverride',{width:375,height:760,deviceScaleFactor:1,mobile:true});
    await browser.send('Emulation.setTouchEmulationEnabled',{enabled:true});
    await browser.waitFor(query(touchButton));
    await checkSpacing();
    assert.ok(await browser.evaluate(query(touchButton)+'.getBoundingClientRect().height >= 44'));
    const touch = await controlPoint(touchButton);
    await browser.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[touch]});
    await browser.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    await browser.waitFor(query(dialog));
    assert.deepEqual(await browser.evaluate(labels),['Watch again']);
    await browser.press('Escape');
    await browser.waitFor('!'+query(dialog)+' && document.activeElement === '+query(touchButton));
    await browser.click(touchButton);
    await browser.click('dialog[open] .watch-sheet-action');
    const after = {plays:[[1,1,4],[1,2,2],[1,3,2]],lists:['csvTV: picked up']};
    await browser.waitFor('('+readRecord.toString()+')().then(value=>JSON.stringify(value) === '+JSON.stringify(JSON.stringify(after))+')', 'one rewatch per aired regular episode');
    await waitStatus('Complete');
    await browser.offline(false);
    await browser.click(row+' a[href="#/show/45"]');
    await browser.waitFor('location.hash === "#/show/45" && document.querySelector("#app")?.dataset.page === "show"');
    await browser.navigate(library);
    await waitStatus('Complete');
    assert.deepEqual(await record(),after);
    await browser.waitFor('document.querySelector(".sync-state")?.dataset.synced === "true"');
    const downloaded = readCsv('watched',providers.files.get('/watched.csv').bytes);
    assert.deepEqual(downloaded.rows.map(row=>[row.season,row.episode,row.times_watched]),after.plays);
  });

test('an estimated Complete cannot add rewatches when fetching a season reveals an unwatched aired episode', {timeout:60000}, async t => {
  const {browser} = await openLibrary(t,initial.slice(0,1),true);
  const trigger = 'document.querySelector(".library-status-trigger")';
  const caption = 'document.querySelector(".library-status-caption")?.textContent';
  await browser.waitFor(caption+' === "Complete"');
  await browser.evaluate(trigger+'.focus()');
  await browser.press('ArrowDown');
  await browser.press('Enter');
  await browser.waitFor(caption+' === "1 of 2"','newly discovered aired episode');
  assert.deepEqual((await browser.evaluate('('+readRecord.toString()+')()')).plays,[[1,1,3]]);
  await browser.evaluate(trigger+'.focus()');
  await browser.press('ArrowDown');
  await browser.press('Enter');
  await browser.waitFor(caption+' === "Complete"','complete remaining episode');
  assert.deepEqual((await browser.evaluate('('+readRecord.toString()+')()')).plays,[[1,1,3],[1,2,1]]);
});
