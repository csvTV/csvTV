import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {readCsv} from '../dist/csv.js';
import {createRelease} from '../package-release.mjs';
import {openChromium, until} from './offline-chromium.mjs';
import {linkFixture, offlineProviders} from './offline-providers.mjs';
import {listen, stop} from './offline-site.mjs';
import {releaseServer, unpack} from './release-site.mjs';

async function holdSettingsWriter() {
  const db = await new Promise((resolve,reject) => {
    const open = indexedDB.open('csvTV');
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  const tx = db.transaction('settings','readwrite'), settings = tx.objectStore('settings');
  const finished = new Promise((resolve,reject) => {
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onabort = () => { db.close(); reject(tx.error); };
  });
  let hold = true;
  window.releaseSettingsWriter = () => { hold = false; return finished; };
  await new Promise(resolve => {
    function keepOpen() {
      resolve();
      if (hold) settings.getKey('library_sort').onsuccess = keepOpen;
    }
    settings.getKey('library_sort').onsuccess = keepOpen;
  });
}

for (const [page,moduleName,helpButton] of [
  ['trakt-import','trakt-import-screen.js'],
  ['imdb-ratings','imdb-job-text.js','fieldset [data-imdb-help=github]'],
]) {
  test('The failed module Reload on '+page+' keeps an admitted edit and retries the same screen', {timeout:45000},async t=>{
    const {bytes} = await createRelease(new URL('../dist/',import.meta.url));
    let failModule = true, documents = 0, compatibilityChecks = 0;
    const server = releaseServer(await unpack(bytes),(req,res)=>{
      if (req.url === '/') {
        if (req.headers['sec-fetch-dest'] === 'document') documents++;
        else compatibilityChecks++;
      }
      if (failModule && req.url === '/'+moduleName) { res.writeHead(503).end(); return true; }
      return false;
    });
    const origin = 'http://127.0.0.1:'+await listen(server);
    const provider = offlineProviders(origin);
    const profile = await mkdtemp(join(tmpdir(),'csvtv-module-reload-'));
    let browser;
    t.after(async()=>{
      try { await browser?.close(); }
      finally { await stop(server); await rm(profile,{recursive:true,force:true,maxRetries:6,retryDelay:150}); }
    });
    browser = await openChromium(profile,provider.respond);
    await browser.send('Page.addScriptToEvaluateOnNewDocument',{source:
      "Object.defineProperty(navigator,'serviceWorker',{configurable:true,value:undefined});"});
    await linkFixture(browser,origin,'/');
    await browser.navigate(origin+'/#/library');
    const sort = 'document.querySelector(\'.library-selects select[aria-label="Sort"]\')';
    const retry = '[...document.querySelectorAll("main button")].find(b=>b.textContent==="Reload csvTV")';
    async function prepare(value) {
      await browser.waitFor(sort);
      await browser.evaluate('('+holdSettingsWriter+')()');
      await browser.evaluate(`{ const choice=${sort}; choice.value=${JSON.stringify(value)}; choice.dispatchEvent(new Event('change',{bubbles:true})); location.hash='#/${page}'; }`);
      if (helpButton) { await browser.waitFor('document.querySelector('+JSON.stringify(helpButton)+')'); await browser.click(helpButton); }
      await browser.waitFor(retry,'failed '+moduleName);
    }
    await browser.waitFor('document.querySelector(".sync-state")?.dataset.synced==="true" && '+sort);
    const before = await browser.evaluate('performance.timeOrigin'), baselineDocuments = documents, baselineChecks = compatibilityChecks;
    await prepare('episodes');
    const waiting = '[...document.querySelectorAll("main button")].some(b=>b.disabled && b.textContent==="Waiting for changes…")';
    await browser.evaluate(retry+'.click()');
    await browser.waitFor(waiting);
    if (helpButton) {
      await browser.evaluate('[...document.querySelectorAll("dialog button")].find(b=>b.textContent==="Done").click()');
      await browser.evaluate('window.releaseSettingsWriter()');
      assert.equal(await browser.evaluate('location.hash'),'#/'+page);
      await browser.evaluate("location.hash='#/library'");
    } else {
      await browser.evaluate("location.hash='#/library'");
      await browser.waitFor(sort);
      await browser.evaluate('window.releaseSettingsWriter()');
    }
    await browser.waitFor(sort+'?.value==="episodes"');
    assert.equal(await browser.evaluate('performance.timeOrigin'),before,'Closing or leaving while waiting reloaded the other screen');

    await prepare('title');
    await browser.evaluate(retry+'.click()');
    await browser.waitFor(waiting);
    await browser.evaluate(`(async()=>{
      const commit=IDBTransaction.prototype.commit;
      IDBTransaction.prototype.commit=function() {
        if (this.objectStoreNames.contains('settings')) { IDBTransaction.prototype.commit=commit; this.abort(); }
        else commit.call(this);
      };
      await window.releaseSettingsWriter();
    })()`);
    await browser.waitFor('document.querySelector("main").textContent.includes("Check that your changes were saved") && '+retry+'?.disabled===false');
    assert.equal(await browser.evaluate('performance.timeOrigin'),before,'A failed write was discarded by reloading');
    await browser.evaluate("location.hash='#/library'");
    await browser.waitFor(sort+'?.value==="episodes"');
    await prepare('rating');
    failModule = false;
    await browser.evaluate(`Object.defineProperty(navigator,'onLine',{configurable:true,value:false}); const retry=${retry}; retry.click(); retry.click(); true`);
    await new Promise(resolve=>setTimeout(resolve,150));
    const replacedEarly = await browser.evaluate('performance.timeOrigin') !== before;
    if (!replacedEarly) await browser.evaluate('window.releaseSettingsWriter()');
    await browser.waitFor('performance.timeOrigin!=='+before+' && document.querySelector("main h1")');
    assert.equal(await browser.evaluate('location.hash'),'#/'+page);
    if (helpButton) {
      await browser.click(helpButton);
      await browser.waitFor('document.querySelector("dialog[open] button[aria-label^=Copy]:not(:disabled)")');
    } else await browser.waitFor('document.querySelector("main input[type=file]")');
    const saved = await browser.evaluate(`(async()=>{
      const {openDeviceStore}=await import('/storage.js');
      const reader=await openDeviceStore();
      try { return (await reader.devicePreference('librarySort')).preference ?? 'missing'; }
      finally { reader.close(); }
    })()`);
    assert.deepEqual({replacedEarly,saved,documents:documents-baselineDocuments,checks:compatibilityChecks-baselineChecks},
      {replacedEarly:false,saved:'rating',documents:1,checks:0});
  });
}

test('Library sort syncs after immediate Statistics navigation and offline edits, while filters stay per visit', {timeout:90000}, async t => {
  const {bytes,build} = await createRelease(new URL('../dist/',import.meta.url));
  const server = releaseServer(await unpack(bytes));
  const directory = await mkdtemp(join(tmpdir(),'csvtv-display-sync-'));
  let browser;
  t.after(async () => {
    try { await browser?.close(); }
    finally { await stop(server); await rm(directory,{recursive:true,force:true,maxRetries:8,retryDelay:150}); }
  });
  const origin = 'http://127.0.0.1:' + await listen(server);
  const provider = offlineProviders(origin);
  let peerWillEdit = false, uploadConflict = false;
  async function respond(event,send) {
    const {request} = event;
    if (peerWillEdit && request.method==='POST' && new URL(request.url).pathname==='/2/files/upload' &&
        JSON.parse(new Headers(request.headers).get('Dropbox-API-Arg')).path==='/settings.csv') {
      // A peer wins the same Dropbox revision just before our upload reaches it.
      peerWillEdit = false;
      await provider.settings({...saved(),statistics_scope:'tv'});
      return provider.respond(event,(method,data) => {
        uploadConflict = data.responseCode === 409;
        return send(method,data);
      });
    }
    return provider.respond(event,send);
  }
  const expected = {
    appearance:'device', statistics_scope:'tv', watchlist_density:'compact', library_sort:'rating',
    more_to_watch_sort:'title', ratings_sort:'plays', lists_sort:'low', tmdb_key:'fictional-offline-key',
  };
  const record = {
    'watched.csv':'show_id,show,season,episode,title,times_watched,episode_id\r\n45,The Listening House,1,1,Recording 1,2,45011\r\n',
    'ratings.csv':'show_id,show,rating\r\n45,The Listening House,8\r\n',
    'lists.csv':'list,show_id,show\r\nFavourites,45,The Listening House\r\nShared viewing with the television club,45,The Listening House\r\nWatchlist,45,The Listening House\r\n',
    'shows.csv':'show_id,show,year,imdb_id\r\n45,The Listening House,2019,\r\n',
  };
  await provider.settings({tmdb_key:expected.tmdb_key});
  for (const [name,content] of Object.entries(record)) await provider.upload(name,content);
  const q = selector => 'document.querySelector('+JSON.stringify(selector)+')';
  const go = route => browser.click('.app-sidebar a[href="#/'+route+'"]');
  const valueIs = (selector,value) => browser.waitFor(q(selector)+'?.value === '+JSON.stringify(value));
  const checked = selector => browser.waitFor(q(selector)+'?.checked === true');
  const sort = 'select[aria-label="Sort"]', list = 'select[aria-label="List"]', rating = 'select[aria-label="Rating"]';
  const density = '.watch-density', appearance = '.appearance-options input[value=device]', anime = 'input[name=statistics-scope][value=anime]';
  const tv = 'input[name=statistics-scope][value=tv]';
  const synced = 'document.querySelector(".sync-state")?.dataset.synced === "true"';
  async function fresh(name) {
    browser = await openChromium(join(directory,name),respond);
    await browser.send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
    await browser.navigate(origin+'/tmdb-logo.svg');
    assert.deepEqual(await browser.evaluate('indexedDB.databases().then(rows=>rows.map(row=>row.name))'),[]);
    await linkFixture(browser,origin,'/');
    await browser.navigate(origin+'/#/settings');
    await browser.waitFor(synced);
    assert.equal(await browser.evaluate(q('meta[name=csvtv-build]')+'.content'),build);
  }
  async function choose(selector,value) {
    await browser.waitFor(q(selector)+'?.disabled === false && [...'+q(selector)+'.options].some(o=>o.value==='+JSON.stringify(value)+')');
    const steps = await browser.evaluate('(() => {const field='+q(selector)+';field.focus(); return [...field.options].findIndex(o=>o.value==='+JSON.stringify(value)+');})()');
    for (const key of ['Home',...Array(steps).fill('ArrowDown')]) {
      const fields = {key,code:key,windowsVirtualKeyCode:key === 'Home' ? 36 : 40};
      await browser.send('Input.dispatchKeyEvent',{type:'rawKeyDown',...fields});
      await browser.send('Input.dispatchKeyEvent',{type:'keyUp',...fields});
    }
    await valueIs(selector,value);
  }
  async function sortThenOpenStatistics(...choices) {
    await browser.waitFor(q(sort)+'?.disabled === false && !!'+q('.library-selects option[value=episodes]'));
    // Issue the changes and navigation in one browser task, before any save can finish.
    await browser.evaluate('('+function(values) {
      const field = document.querySelector('.library-screen select[aria-label="Sort"]');
      for (const value of values) {
        field.value = value;
        if (field.value !== value) throw Error('Unavailable Library sort');
        field.dispatchEvent(new Event('change',{bubbles:true}));
      }
      document.querySelector('.app-sidebar a[href="#/statistics"]').click();
    }.toString()+')('+JSON.stringify(choices)+')');
  }
  async function openMore() {
    // A new device first needs this series' public episode count to show its unfinished season.
    await go('library');
    await browser.click('.library-grid a[href="#/show/45"]');
    await browser.waitFor(q('.show-overview p')+'?.textContent.includes("forgotten broadcasts")');
    await go('watchlist');
    await browser.waitFor(q('[data-section=more-to-watch] .watch-rows strong')+'?.textContent === "The Listening House"');
  }
  const saved = () => Object.fromEntries(readCsv('settings',provider.files.get('/settings.csv').bytes).rows.map(({setting,value})=>[setting,value]));
  function verifyRecord() {
    for (const [name,content] of Object.entries(record)) {
      const expected = name === 'lists.csv' ? content.replace('Favourites,','Favorites,') : content;
      assert.equal(Buffer.from(provider.files.get('/'+name).bytes).toString('utf8'),expected,name);
    }
  }

  await fresh('first');
  await browser.click(appearance);
  await checked(appearance);
  await go('lists');
  await browser.waitFor(q('.list-shows strong')+'?.textContent === "The Listening House"');
  await valueIs(sort,'title');
  await choose(sort,'low');
  assert.equal(await browser.evaluate(q(sort)+' === document.activeElement'),true,'Lists lost keyboard focus after sorting');
  const roomier = await browser.evaluate(q('.list-shows li')+'.getBoundingClientRect().height');
  await browser.evaluate(q(density)+'.focus()');
  await browser.press('Space');
  await browser.waitFor(q(density)+'.getAttribute("aria-pressed") === "true"');
  assert.ok(await browser.evaluate(q('.list-shows li')+'.getBoundingClientRect().height') < roomier);
  assert.equal(await browser.evaluate('getComputedStyle('+q('.list-shows .tv-poster')+').display'),'none');
  assert.equal(await browser.evaluate(q('.list-shows .list-rating')+'.textContent'),'8/10');
  await go('watchlist');
  await browser.waitFor(q('.watchlist-screen.watch-compact .watch-rows strong')+'?.textContent === "The Listening House"');
  await openMore();
  await choose(sort,'title');
  await go('library');
  await choose(sort,'rating');
  await choose(list,'=Favorites');
  await choose(rating,'rated');
  await browser.click('[data-category=tv]');
  await choose('[data-filter=progress]','more');
  // Finish the setup edits' sync before artificially holding a settings writer. An unrelated
  // sync could otherwise hold its multi-table transaction behind our intentional block.
  await until(()=>saved().library_sort === 'rating','initial sort reached Dropbox',30000);
  await browser.waitFor(synced);
  // The initial visit has a second choice queued. Returning to Library gives the
  // owner a new usable control even while the first visit's write is committing.
  await browser.evaluate('('+holdSettingsWriter.toString()+')()');
  try {
    await sortThenOpenStatistics('title','rating');
    await browser.waitFor('!!document.querySelector("[data-page=statistics] h1")');
    await go('library');
    await browser.waitFor(q('.library-grid a[data-show-id=\"45\"] strong')+'?.textContent === "The Listening House"',
      'the actual watched title while a settings writer is held');
    await sortThenOpenStatistics('episodes');
  } finally { await browser.evaluate('window.releaseSettingsWriter()'); }
  await browser.waitFor(q('[data-stat=shows] dd')+'?.textContent === "1"');
  await browser.click(anime);
  await checked(anime);
  await until(()=>saved().statistics_scope === 'anime','display settings uploaded automatically after immediate navigation',30000);
  await browser.waitFor(synced+' && !!navigator.serviceWorker.controller');
  assert.equal(saved().library_sort,'episodes','A choice from an earlier Library visit replaced the newest sort in Dropbox');
  await go('library');
  await valueIs(sort,'episodes');
  await browser.offline(true);
  provider.state.online = false;
  // Exercise restoration after an actual document departure while settings is busy.
  // The short hold ends on its own even if the old document stays alive.
  await browser.evaluate('('+holdSettingsWriter.toString()+')().then(()=>{setTimeout(()=>window.releaseSettingsWriter(),240);})');
  await sortThenOpenStatistics('title','rating');
  await checked(anime);
  await browser.waitFor(q('[data-stat=shows] dd')+'?.textContent === "0"');
  await browser.navigate('about:blank');
  await browser.navigate(origin+'/#/library');
  await valueIs(sort,'rating');
  assert.equal(saved().library_sort,'episodes','The offline edit has not reached Dropbox');
  // A peer edits one preference before reconnect and another during the resulting upload.
  await provider.settings({...saved(),ratings_sort:'plays'});
  peerWillEdit = true;
  provider.state.online = true;
  await browser.offline(false);
  await until(() => Object.entries(expected).every(([key,value])=>saved()[key] === value),
    'newest offline Library sort and the peer setting synced on reconnect',30000);
  await browser.waitFor(synced);
  assert.equal(uploadConflict,true,'The first reconnect upload must hit a Dropbox revision conflict');
  assert.deepEqual(saved(),expected);
  await go('statistics');
  await checked(tv);
  await browser.waitFor(q('[data-stat=shows] dd')+'?.textContent === "1"');
  verifyRecord();
  await browser.close(); browser = undefined;

  await fresh('second');
  await checked(appearance);
  await go('lists');
  await valueIs(sort,'low');
  await go('ratings');
  await valueIs(sort,'plays');
  await go('library');
  await valueIs(sort,'rating');
  await valueIs(list,'');
  await valueIs(rating,'any');
  await browser.waitFor(q('[data-category=all]')+'.getAttribute("aria-pressed") === "true"');
  await valueIs('[data-filter=progress]','all');
  await browser.waitFor(q('.library-grid strong')+'?.textContent === "The Listening House"');
  await openMore();
  await valueIs(sort,'title');
  await browser.waitFor(q(density)+'.getAttribute("aria-pressed") === "true"');
  await go('watchlist');
  await browser.waitFor(q('.watch-compact .watch-rows strong')+'?.textContent === "The Listening House"');
  await go('statistics');
  await checked(tv);
  await browser.waitFor(q('[data-stat=shows] dd')+'?.textContent === "1"');
  await browser.waitFor(synced);
  assert.deepEqual(saved(),expected);
  verifyRecord();

  const pages = [
    ['lists','.watch-density'],['watchlist','.watch-density'],
    ['home','.tv-search-field'],['search','.tv-search-field'],
  ];
  for (const width of [1440,390,320]) {
    await browser.send('Emulation.setDeviceMetricsOverride',{width,height:850,deviceScaleFactor:1,mobile:width < 900});
    for (const [route,control] of pages) {
      await browser.navigate(origin+'/#/'+route);
      await browser.waitFor(q('[data-page="'+route+'"] .screen-heading '+control)+'?.getBoundingClientRect().width > 0');
      const measured = await browser.evaluate(`(() => {
        const heading = document.querySelector('.screen-heading h1').getBoundingClientRect();
        const tool = document.querySelector('.screen-heading ${control}').getBoundingClientRect();
        return heading.width > 1 && heading.right <= tool.left && heading.bottom > tool.top && tool.bottom > heading.top
          && document.documentElement.scrollWidth <= innerWidth + 1;
      })()`);
      assert.ok(measured,route+' title and '+control+' must share a row at '+width);
      if (route === 'lists') {
        await browser.waitFor(q('.watch-compact .list-shows strong')+'?.textContent === "The Listening House"');
        await valueIs(sort,'low');
        assert.ok(await browser.evaluate(`(() => {
          const field = document.querySelector('.lists-screen select[aria-label="Sort"]');
          const box = field.getBoundingClientRect();
          return field instanceof HTMLSelectElement && !field.disabled && box.left >= 0 &&
            box.right <= innerWidth + 1 && box.height > 0 && document.documentElement.scrollWidth <= innerWidth + 1;
        })()`),'List sort must fit in the viewport at '+width);
      }
    }
    await browser.navigate(origin+'/#/library');
    // The initial Library shell has smaller controls until the saved lists and sort arrive.
    await browser.waitFor(`innerWidth === ${width} && document.querySelector('.library-selects option[value="=Shared viewing with the television club"]') &&
      document.querySelector('.library-selects .view-sort select')?.value === 'rating' &&
      document.querySelector('.library-grid strong')?.textContent === 'The Listening House'`);
    const library = await browser.evaluate(`(() => {
      const sort = document.querySelector('.library-selects .view-sort');
      const fields = sort.parentElement, search = fields.querySelector('.tv-search-field');
      const a = sort.getBoundingClientRect(), b = search.getBoundingClientRect();
      return {follows:sort.nextElementSibling === search, overflow:document.documentElement.scrollWidth - innerWidth,
        sameRow:a.right <= b.left && a.bottom > b.top && a.top < b.bottom, nextRow:a.bottom <= b.top,
        searchWidth:b.width, rowWidth:fields.getBoundingClientRect().width};
    })()`);
    assert.ok(library.follows && library.overflow <= 1, 'Library filters at '+width+': '+JSON.stringify(library));
    assert.ok(width === 1440 ? library.sameRow && library.searchWidth >= 150 :
      library.nextRow && Math.abs(library.searchWidth - library.rowWidth) <= 1,
      'Library search placement at '+width+': '+JSON.stringify(library));
    const moreHeading = '[data-section=more-to-watch] h2';
    const focusedMore = 'document.activeElement.matches('+JSON.stringify(moreHeading)+')';
    await browser.navigate(origin+'/#/home');
    assert.equal(await browser.evaluate(q('.app-sidebar a[href="#/more-to-watch"]')+' === null'),true);
    await browser.click('#more-heading a');
    await browser.waitFor(focusedMore+' && location.hash === "#/watchlist/more-to-watch"');
    assert.ok(await browser.evaluate('(()=>{const r='+q(moreHeading)+'.getBoundingClientRect();return r.top >= -1 && r.bottom <= innerHeight;})()'),
      'Home linked to a More section outside the viewport at '+width);
    assert.equal(await browser.evaluate('document.querySelectorAll(".watch-density").length'),1);
    assert.equal(await browser.evaluate(q('.app-sidebar a[aria-current=page]')+'?.hash'),'#/watchlist');
    await browser.evaluate('history.back()');
    await browser.waitFor('location.hash === "#/home" && !!document.querySelector("#more-heading a")');
    // Opening an old bookmark must replace its obsolete hash so Back still leads directly Home.
    await browser.evaluate('location.hash = "#/more-to-watch"');
    await browser.waitFor(focusedMore+' && location.hash === "#/watchlist/more-to-watch"');
    await browser.evaluate('history.back()');
    await browser.waitFor('location.hash === "#/home" && !!document.querySelector("#more-heading a")');
  }
});

test('The online compatibility Reload finishes an admitted Library sort before replacing its document', {timeout:60000}, async t => {
  const {bytes} = await createRelease(new URL('../dist/',import.meta.url));
  const server = releaseServer(await unpack(bytes));
  const directory = await mkdtemp(join(tmpdir(),'csvtv-online-reload-'));
  let browser;
  t.after(async () => {
    try { await browser?.close(); }
    finally { await stop(server); await rm(directory,{recursive:true,force:true,maxRetries:8,retryDelay:150}); }
  });
  const origin = 'http://127.0.0.1:' + await listen(server);
  const provider = offlineProviders(origin);
  await provider.settings({});
  await provider.upload('watched.csv',
    'show_id,show,season,episode,title,times_watched,episode_id\r\n45,The Listening House,1,1,Recording 1,2,45011\r\n');
  browser = await openChromium(directory,provider.respond);
  await browser.send('Page.addScriptToEvaluateOnNewDocument',{
    source:"Object.defineProperty(navigator,'serviceWorker',{configurable:true,value:undefined})",
  });
  await linkFixture(browser,origin,'/');
  await browser.navigate(origin+'/#/library');
  await browser.waitFor('document.querySelector(".sync-state")?.dataset.synced === "true" && !!document.querySelector(".library-selects option[value=rating]")');
  const previous = await browser.evaluate('performance.timeOrigin');
  await browser.evaluate('('+holdSettingsWriter.toString()+')()');
  await browser.evaluate(`(async () => {
    const {DeviceStore} = await import('/storage.js');
    const close = DeviceStore.prototype.closeForUpdate;
    DeviceStore.prototype.closeForUpdate = function(...args) {
      window.compatibilityDrainStarted = true;
      return close.apply(this,args);
    };
    const select = document.querySelector('.library-selects select[aria-label=Sort]');
    select.value = 'rating';
    select.dispatchEvent(new Event('change',{bubbles:true}));
    const [{version}] = await indexedDB.databases();
    const peer = indexedDB.open('csvTV',version + 1);
    // Trigger the real obsolete-record banner and leave the schema intact for reopening.
    peer.onupgradeneeded = () => peer.transaction.abort();
    peer.onerror = () => {};
  })()`);
  await browser.waitFor('document.querySelector(".tab-state button")?.textContent === "Reload"');
  await browser.click('.tab-state button');
  await browser.waitFor('window.compatibilityDrainStarted || performance.timeOrigin !== '+previous,'reload decision');
  assert.equal(await browser.evaluate('performance.timeOrigin'),previous,'The app reloaded while the sort was still queued');
  await browser.evaluate('window.releaseSettingsWriter()');
  await browser.waitFor('performance.timeOrigin !== '+previous+' && !!document.querySelector(".library-selects option[value=rating]")');
  assert.equal(await browser.evaluate(`(async () => {
    const {openDeviceStore} = await import('/storage.js');
    const store = await openDeviceStore();
    try { return (await store.devicePreference('librarySort')).preference; }
    finally { store.close(); }
  })()`),'rating');
  await until(() => readCsv('settings',provider.files.get('/settings.csv').bytes).rows.some(
    row => row.setting === 'library_sort' && row.value === 'rating'),'saved sort uploaded after compatibility reload',30000);

  // An unchanged build or a superseded page must not tear down a working session.
  const checks = await browser.evaluate(`(async () => {
    const {reloadOnlineBuild} = await import('/offline.js');
    const build = document.querySelector('meta[name=csvtv-build]').content;
    let active = true, marker = build, drains = 0, reloads = 0;
    const win = {document,navigator:{onLine:true},location:{origin:location.origin,pathname:'/',reload:() => reloads++},
      fetch:async () => new Response('<head><meta name="csvtv-build" content="'+build+'"></head>',{headers:{'Content-Type':'text/html'}}),
      sessionStorage:{getItem:() => marker,setItem:(_key,value) => { marker = value; }}};
    const options = {unchanged:'Already checked',beforeReload:async () => { drains++; active = false; }};
    const invalid = await reloadOnlineBuild({...win,fetch:async () => new Response('no app build')},() => active,options);
    const tag = '<meta name="csvtv-build" content="'+build+'">';
    const decorated = head => ({...win,fetch:async () => new Response('<head>'+head+'</head>',{headers:{'Content-Type':'text/html'}})});
    const commentOnly = await reloadOnlineBuild(decorated('<!-- '+tag+' -->'),() => active,options);
    const img = new URL('/fictional-host-decoration.png',location.href).href;
    const inert = await reloadOnlineBuild(decorated(tag+'<img src="'+img+'">'),() => active,options);
    await new Promise(resolve => setTimeout(resolve,100));
    const loadedImage = performance.getEntriesByName(img).length;
    const repeated = await reloadOnlineBuild(win,() => active,options);
    marker = null;
    await reloadOnlineBuild(win,() => false,options);
    await reloadOnlineBuild(win,() => active,options);
    return {invalid,commentOnly,inert,loadedImage,repeated,marker,drains,reloads};
  })()`);
  assert.deepEqual(checks,{invalid:'Could not load an updated app. Your record is saved on this device.',
    commentOnly:'Could not load an updated app. Your record is saved on this device.',
    inert:'Already checked',loadedImage:0,repeated:'Already checked',marker:null,drains:1,reloads:0});
});
