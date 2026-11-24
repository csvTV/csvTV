import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {openChromium} from './offline-chromium.mjs';
import {linkFixture} from './offline-providers.mjs';
import {listen, stop, testSite} from './offline-site.mjs';

async function exerciseLibraryReads() {
  const {mountApplication} = await import('/tracker/application.js');
  const {openDeviceStore} = await import('/tracker/storage.js');
  const {TmdbService} = await import('/tracker/tmdb-service.js');
  const {tmdbResourceKey} = await import('/tracker/tmdb-client.js');
  const store = await openDeviceStore();
  await store.whenWriter();
  store.connectProviderKeys(async () => { throw Error('Unexpected key edit'); }, Date.now);
  await store.loadProviderKeys((await store.dropboxState()).session,[{setting:'tmdb_key',value:'fictional-cache-key'}],()=>true);
  const service = new TmdbService(store,undefined,{now:Date.now,online:()=>false,visible:()=>true});
  const entries = {}, watched = [], fetchedAt = Date.now();
  const seasonCount = 180;
  for (let id=1; id<=60; id++) {
    const show = 'Fictional station '+id, seasons = [1,2,3].map(season=>({season,episodeCount:1}));
    entries[tmdbResourceKey({kind:'show',id})] = {fetchedAt,value:{show_id:id,show,firstAirDate:'2013-01-02',
      genres:[],networks:[],keywords:[],originCountries:['US'],seasons,lastAired:{season:3,episode:1},nextAirDate:null}};
    for (const {season} of seasons) {
      const episode = {episode:1,episode_id:id*100+season,runtime:30,airDate:'2014-01-02',title:'Opening'};
      entries[tmdbResourceKey({kind:'season',id,season})] = {fetchedAt,value:{show_id:id,season,episodes:[episode]}};
      watched.push({show_id:id,show,season,episode:1,episode_id:episode.episode_id,title:episode.title,times_watched:1});
    }
  }
  await store.commit((await store.snapshot()).revision,{put:{watched}});
  if (!await store.writeTmdb((await store.tmdbState()).generation,{entries})) throw Error('Unable to seed the fictional season cache');
  const root = document.body.appendChild(document.createElement('div'));
  history.replaceState({},'','#/settings');
  const app = mountApplication(root,service);
  const readEntries = store.tmdbEntries.bind(store), readRecord = store.overviewRows.bind(store);
  function visit(page) {
    root.querySelector('.app-sidebar [data-destination='+page+']').click();
  }
  async function until(probe, label) {
    const deadline = performance.now()+10000;
    while (!probe()) {
      if (performance.now()>deadline) throw Error('Timed out waiting for '+label);
      await new Promise(resolve=>setTimeout(resolve,10));
    }
  }
  async function inspect(interrupt,page='library') {
    let transaction, independent, release = false;
    const destination = page === 'library' ? 'statistics' : 'settings';
    const ended = Promise.withResolvers();
    store.overviewRows = (...args) => { if (transaction) release = true; return readRecord(...args); };
    store.tmdbEntries = (keys,...args) => {
      const target = page === 'ratings' ? keys.find(key=>key.includes('?append_to_response=')) : keys.find(key=>key.includes('/season/'));
      if (transaction || root.dataset.page !== page || !target || (page !== 'ratings' && keys.length < seasonCount)) return readEntries(keys,...args);
      // Observe the very transaction created by the production bulk read, independently of its promise.
      const open = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function(...args) { return transaction = open.apply(this,args); };
      let result;
      try { result = readEntries(keys,...args); } finally { IDBDatabase.prototype.transaction = open; }
      independent = readEntries([target]);
      for (const event of ['complete','abort']) transaction.addEventListener(event,()=>ended.resolve({event,page:root.dataset.page}));
      if (interrupt === 'refresh') {
        // Keep this read pending until the queued online refresh starts, irrespective of machine speed.
        const data = transaction.objectStore('tmdb');
        function hold() { if (!release) data.getKey(keys[0]).onsuccess = hold; }
        hold();
      }
      queueMicrotask(()=>{ if (interrupt === 'refresh') dispatchEvent(new Event('online')); else visit(destination); });
      return result;
    };
    try {
      visit(page);
      await until(()=>transaction,'the '+page+' metadata batch');
      const outcome = await ended.promise;
      if (!(await independent)[0]?.value) throw Error('The separate concurrent read lost its metadata');
      if (interrupt === 'refresh') {
        await until(()=>root.querySelector('.library-grid')?.textContent.includes('Complete'),'the new Library projection');
        visit('settings');
      } else if (destination === 'statistics') {
        await until(()=>root.querySelector('[data-stat=plays] dd')?.textContent === '180','the Statistics projection');
      } else await until(()=>root.querySelector('.appearance-options'),'Settings after cancelling '+page);
      return outcome;
    } finally { release = true; store.tmdbEntries = readEntries; store.overviewRows = readRecord; }
  }
  async function leaveInitialRecord(page) {
    const initial = Promise.withResolvers();
    const method = {lists:'listPageRows',home:'homeRecord',watchlist:'watchlistMembers'}[page] ?? 'overviewRows';
    const read = store[method].bind(store);
    store[method] = (...args) => {
      store[method] = read;
      const open = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function(...inputs) {
        const tx = open.apply(this,inputs);
        for (const event of ['complete','abort']) tx.addEventListener(event,()=>initial.resolve(event));
        return tx;
      };
      try { return read(...args); }
      finally { IDBDatabase.prototype.transaction = open; queueMicrotask(()=>visit('settings')); }
    };
    visit(page);
    const outcome = await initial.promise;
    await until(()=>root.querySelector('.appearance-options'),'Settings after cancelling the initial '+page+' record');
    return outcome;
  }
  async function checkBrowsingUpdates() {
    visit('library');
    await until(()=>root.querySelector('.library-grid')?.textContent.includes('Complete'),'the populated Library');
    const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    await pause(400);
    const peer=await openDeviceStore(), generation=(await store.tmdbState()).generation;
    let reads=0;
    store.overviewRows=(...args)=>{reads++;return readRecord(...args);};
    try {
      async function change(entries) {
        const next=new Promise(resolve=>peer.addEventListener('tmdbbrowse',resolve,{once:true}));
        if (!await store.writeTmdb(generation,{entries})) throw Error('The fixture metadata was rejected.');
        return (await next).detail;
      }
      const entry=value=>({value,fetchedAt:Date.now()});
      const detail=await change({'person/901/tv_credits':entry(null),'tv/8/recommendations?page=1':entry(null)});
      await pause(400);
      const unrelatedReads=reads;
      await change({configuration:entry({secureBaseUrl:'https://image.tmdb.org/t/p/',posterSizes:['w92'],
        backdropSizes:[],profileSizes:[],stillSizes:[]})});
      await until(()=>reads>unrelatedReads,'the changed poster configuration');
      const artworkReads=reads;
      // A reader may still have a writer from an older deployed version.
      store.dispatchEvent(new Event('tmdbbrowse'));
      await until(()=>reads>artworkReads,'an older unclassified cache message');
      return {unrelatedReads,peerDetail:detail?.detailOnly===true,artwork:true,legacy:true};
    } finally {store.overviewRows=readRecord;await peer.closeForUpdate();}
  }
  try {
    await app.ready;
    const initialRecords = {};
    for (const page of ['home','library','lists','ratings','statistics','watchlist']) initialRecords[page] = await leaveInitialRecord(page);
    const refresh = await inspect('refresh');
    const leave = await inspect('leave');
    visit('settings');
    await store.commit((await store.snapshot()).revision,{put:{ratings:[{show_id:1,show:'Fictional station 1',rating:8}]}});
    const home = await inspect('leave','home');
    const watchlist = await inspect('leave','watchlist');
    const statistics = await inspect('leave','statistics');
    const artwork = await inspect('leave','ratings');
    const browsing=await checkBrowsingUpdates();
    return {initialRecords,refresh,leave,home,watchlist,statistics,artwork,browsing};
  } finally { app.dispose(); service.close(); await store.closeForUpdate(); }
}

test('Abandoning a large overview cancels only that screen’s metadata transaction and the active screen completes', {timeout:45000}, async t=>{
  const {server} = await testSite(), origin = 'http://127.0.0.1:'+await listen(server);
  const profile = await mkdtemp(join(tmpdir(),'csvtv-library-cache-'));
  let browser;
  t.after(async()=>{ try { await browser?.close(); } finally { await stop(server); await rm(profile,{recursive:true,force:true,maxRetries:6,retryDelay:150}); } });
  browser = await openChromium(profile);
  await linkFixture(browser,origin);
  const outcomes = await browser.evaluate('('+exerciseLibraryReads+')()');
  assert.deepEqual(outcomes,{initialRecords:{home:'abort',library:'abort',lists:'abort',ratings:'abort',statistics:'abort',watchlist:'abort'},refresh:{event:'abort',page:'library'},
    leave:{event:'abort',page:'statistics'},home:{event:'abort',page:'settings'},watchlist:{event:'abort',page:'settings'},
    statistics:{event:'abort',page:'settings'},artwork:{event:'abort',page:'settings'},
    browsing:{unrelatedReads:0,peerDetail:true,artwork:true,legacy:true}});
});
