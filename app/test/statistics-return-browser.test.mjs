import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {openChromium} from './offline-chromium.mjs';
import {linkFixture} from './offline-providers.mjs';
import {listen, stop, testSite} from './offline-site.mjs';

async function exerciseStatisticsReturn() {
  const {openDeviceStore} = await import('/tracker/storage.js');
  const {TmdbService} = await import('/tracker/tmdb-service.js');
  const {MdbListService} = await import('/tracker/mdblist-service.js');
  const {tmdbResourceKey} = await import('/tracker/tmdb-client.js');
  const {mountApplication} = await import('/tracker/application.js');
  await new Promise((resolve,reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet'; link.href = '/tracker/csvtv.css';
    link.onload = resolve; link.onerror = reject; document.head.append(link);
  });
  const store = await openDeviceStore();
  await store.whenWriter();
  const {session} = await store.dropboxState();
  store.connectProviderKeys(async () => { throw Error('Unexpected key edit'); }, Date.now);
  await store.loadProviderKeys(session,[{setting:'tmdb_key',value:'fictional-cache-key'},
    {setting:'mdblist_key',value:'fictional-scores'}],()=>true);
  const service = new TmdbService(store,undefined,{now:Date.now,online:()=>false,visible:()=>true});
  const critics = new MdbListService(store,undefined,service.environment);
  const now = Date.now(), entries = {}, watched = [];
  function cache(resource,value) { entries[tmdbResourceKey(resource)] = {fetchedAt:now,value}; }
  for (let id = 1; id <= 300; id++) {
    const show = 'Signal Station ' + id;
    const seasons = [1,2,3].map(season => ({season,episodeCount:15}));
    cache({kind:'show',id},{show_id:id,show,firstAirDate:'2013-01-02',genres:[],networks:[],keywords:[],
      originCountries:['US'],seasons,lastAired:{season:3,episode:15},nextAirDate:null});
    cache({kind:'cast',id},[{id:1,name:'Oak River'}]);
    for (const {season} of seasons) {
      const episodes = Array.from({length:15},(_,i)=>({episode:i+1,episode_id:id*10000+season*100+i+1,
        runtime:30,airDate:'2014-01-02',title:'Chapter '+(i+1)}));
      cache({kind:'season',id,season},{show_id:id,season,episodes});
      for (const ep of episodes) watched.push({show_id:id,show,season,episode:ep.episode,episode_id:ep.episode_id,
        title:ep.title,times_watched:ep.episode<=3 ? 2 : 1});
    }
  }
  cache({kind:'countries'},[{code:'US',name:'United States'}]);
  await store.commit((await store.snapshot()).revision,{put:{watched}});
  if (!await store.writeTmdb((await store.tmdbState()).generation,{entries})) throw Error('Unable to cache fictional title data');
  const root = document.body.appendChild(document.createElement('div'));
  history.replaceState({},'','#/settings');
  let firstOpenWrites = 0;
  const openStatistics = store.openStatistics.bind(store);
  let releaseOpening;
  const opening = new Promise(resolve=>{ releaseOpening = resolve; });
  store.openStatistics = async () => { firstOpenWrites++; await opening; return openStatistics(); };
  const app = mountApplication(root,service,undefined,undefined,undefined,critics);
  let recordReads = 0, metadataKeys = 0;
  const overview = store.overviewRows.bind(store), metadata = store.tmdbEntries.bind(store);
  store.overviewRows = (...args) => { recordReads++; return overview(...args); };
  store.tmdbEntries = (keys,...args) => { metadataKeys+=keys.length; return metadata(keys,...args); };
  function visit(plays, hours) {
    const start = performance.now();
    recordReads = metadataKeys = 0;
    return new Promise((resolve,reject) => {
      const timeout = setTimeout(()=>{ observer.disconnect(); reject(Error('Statistics did not show the expected record')); },10000);
      const observer = new MutationObserver(() => {
        const figure = name => root.querySelector('[data-stat='+name+'] dd')?.textContent;
        if (figure('plays') !== plays.toLocaleString() || figure('hours') !== hours.toLocaleString() ||
            !root.querySelector('[data-chart=cast]')?.getBoundingClientRect().height) return;
        clearTimeout(timeout); observer.disconnect();
        resolve({ms:performance.now()-start,recordReads,metadataKeys});
      });
      observer.observe(root,{childList:true,subtree:true,characterData:true});
      app.go({page:'statistics'});
    });
  }
  try {
    await app.ready;
    const visits = [await visit(16200,8100)];
    // A slow first-activation write must not hold personal totals or runtimes.
    releaseOpening();
    for (let i=0;i<4;i++) {
      // Let any independent metadata or score replies finish before navigating.
      await new Promise(resolve=>setTimeout(resolve,30));
      app.go({page:'settings'});
      visits.push(await visit(16200,8100));
    }
    async function until(predicate,message) {
      const end=performance.now()+4000;
      while(!predicate() && performance.now()<end) await new Promise(resolve=>setTimeout(resolve,5));
      if(!predicate()) throw Error(message);
    }
    for (const withEditor of [false,true]) {
      app.go({page:'settings'});
      await until(()=>root.querySelector('[data-edit]:not(:disabled)'),'The Settings key control did not open');
      const tiles=root.querySelector('#settings-services'), tileCount=tiles.children.length;
      let secret;
      if(withEditor) {
        root.querySelector('[data-edit]').click();
        secret=root.querySelector('dialog[open] input');
        secret.value='fictional-unsaved-value';
      }
      const original=store.statisticsState.bind(store), started=Promise.withResolvers(), blocked=Promise.withResolvers();
      store.statisticsState=async()=>{started.resolve(); await blocked.promise; return original();};
      try {
        app.go({page:'statistics'});
        await started.promise;
        if(withEditor) {
          if(secret.isConnected || secret.value || root.querySelector('dialog[open],input[type=password]')) {
            throw Error('A departed Settings editor retained the unsaved value');
          }
        } else if(!tiles.isConnected || !tiles.inert || tiles.children.length!==tileCount || root.querySelector('.statistics-screen')) {
          throw Error('The unchanged Settings layout vanished or accepted input while Statistics checked the record');
        }
      } finally {blocked.resolve();store.statisticsState=original;}
      await until(()=>root.querySelector('[data-stat=hours] dd')?.textContent==='8,100','The verified Statistics report did not appear');
    }
    app.go({page:'library'});
    await until(()=>root.querySelector('.library-grid li'),'The preceding Library did not appear');
    const previous=root.querySelector('main').firstElementChild;
    const state=store.statisticsState.bind(store), entered=Promise.withResolvers(), gate=Promise.withResolvers();
    store.statisticsState=async()=>{ entered.resolve(); await gate.promise; return state(); };
    try {
      app.go({page:'statistics'});
      await entered.promise;
      if(!previous.inert || !previous.isConnected || root.querySelector('.statistics-screen')) {
        throw Error('The preceding route accepted input or presented a loading screen during the revision check');
      }
      history.back();
      await until(()=>root.querySelector('main h1')?.textContent==='Library' && !previous.isConnected,
        'Back waited for an unresolved Statistics read');
      gate.resolve();
      await new Promise(resolve=>setTimeout(resolve,100));
      if(root.querySelector('.statistics-screen') || !root.querySelector('.library-grid') || previous.inert) {
        throw Error('The canceled Statistics route replaced the destination after Back');
      }
    } finally {gate.resolve(); store.statisticsState=state;}
    async function afterWork(work) {
      app.go({page:'settings'});
      await work();
      return visit(16200,8100);
    }
    const person = await afterWork(() => store.tmdbState().then(({generation}) => store.writeTmdb(generation,{entries:{
      [tmdbResourceKey({kind:'person',id:901})]:{fetchedAt:Date.now(),value:[]},
    }})));
    const unrelated = await afterWork(async () => {
      await store.saveDropboxStatus({accountId:session.accountId,instanceId:session.instanceId,synced:true,
        reason:'Fictional record synchronized',day:'2026-11-23'},()=>true);
      const request = service.client.request, online = service.environment.online;
      service.client.request = async resource => {
        if (resource.kind === 'show') return {id:901,name:'Outside the record',first_air_date:'2020-01-01',status:'Ended',
          seasons:[],keywords:{results:[]},external_ids:{imdb_id:null}};
        if (resource.kind === 'cast') return {id:901,cast:[]};
        if (resource.kind === 'recommendations') return {page:1,total_pages:0,results:[]};
        throw Error('Unexpected show lookup');
      };
      try {
        service.environment.online = () => true;
        const details = await service.openShow(901);
        if (!details.show.value || !details.cast.value || !details.recommendations.value ||
            (await store.dropboxState()).dirty) throw Error('An untracked Show lookup changed Dropbox or failed to load');
      } finally { service.client.request = request; service.environment.online = online; }
    });
    const sync = await afterWork(async () => {
      const {revision} = await store.devicePreference('statisticsScope');
      await store.commit(revision,{sync:{watched:{base:{revision:'fictional-synced',content:'watched'},pending:null}}},{syncWrite:true});
    });
    // Simulate fast scope clicks whose writes finish after navigating away and
    // returning. The first preference reply describes the old revision.
    async function withQueuedScopes(edit) {
      app.go({page:'settings'});
      const original = store.statisticsState.bind(store);
      let started, release, held = false;
      const pending = new Promise(resolve=>{ started = resolve; });
      const gate = new Promise(resolve=>{ release = resolve; });
      store.statisticsState = async () => {
        const state = await original();
        if (!held) {
          held = true;
          started();
          await gate;
        }
        return state;
      };
      try {
        const result = visit(edit ? 16202 : 16200,edit ? 8101 : 8100);
        await pending;
        await store.selectStatisticsScope('tv');
        if (edit) await store.commit((await store.snapshot()).revision,{put:{watched:[{...watched[0],times_watched:4}]}});
        await store.selectStatisticsScope('anime');
        await store.selectStatisticsScope('all');
        release();
        return await result;
      } finally { release(); store.statisticsState = original; }
    }
    const rapidScope = await withQueuedScopes(false);
    const edited = await withQueuedScopes(true);
    app.go({page:'settings'});
    await store.commit((await store.snapshot()).revision,{put:{ratings:[{show_id:1,show:'Signal Station 1',rating:8}]}});
    await visit(16202,8101);
    await new Promise(resolve=>setTimeout(resolve,80));
    app.go({page:'settings'});
    const generation = (await store.mdbListState()).generation;
    const entries = new Map([[1,{fetchedAt:Date.now(),scores:{tomatoes:91,metacritic:null,myanimelist:null}}]]);
    if (!await store.writeMdbList(generation,{entries})) throw Error('Could not update fictional score');
    const updatedScore = await visit(16202,8101);
    const deadline = performance.now()+3000;
    while (!root.querySelector('[data-table=tomatoes]')) {
      if (performance.now()>deadline) throw Error('The new critic score was absent from Statistics');
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    root.querySelector('[data-table=tomatoes]').click();
    if (!root.querySelector('dialog tbody')?.textContent.includes('91%')) throw Error('Expected the updated critic score');
    root.querySelector('dialog').close();
    const readCritics = critics.read.bind(critics);
    let cacheReads = 0;
    critics.read = (...args) => { cacheReads++; return readCritics(...args); };
    try {
      for (const id of [9001,1]) {
        app.go({page:'settings'});
        await store.writeMdbList(generation,{entries:new Map([[id,{...entries.get(1),fetchedAt:Date.now()+1}]])});
        cacheReads = 0;
        await visit(16202,8101);
        if (!root.querySelector('[data-chart=tomatoes]') || cacheReads) {
          throw Error('An unrelated or unchanged critic score discarded the visible comparison');
        }
      }
    } finally { critics.read = readCritics; }
    async function quickDeparture(firstCount, editWhileAway) {
      const total = 16200 + firstCount - 2;
      const putCount = async count => store.commit((await store.snapshot()).revision,
        {put:{watched:[{...watched[0],times_watched:count}]}});
      app.go({page:'settings'});
      await putCount(firstCount);
      const reader = critics.read.bind(critics);
      let release;
      const hold = new Promise(resolve=>{release = resolve;});
      let entered;
      const pending = new Promise(resolve=>{entered = resolve;});
      critics.read = async (...args) => {
        const result = await reader(...args);
        entered();
        await hold;
        return result;
      };
      try {
        await Promise.all([visit(total,total/2),pending]);
        const cast = root.querySelector('[data-chart=cast]');
        app.go({page:'settings'});
        const deadline = performance.now()+3000;
        while (cast.isConnected || root.querySelector('h1')?.textContent!=='Settings') {
          if (performance.now()>deadline) throw Error('Statistics did not close');
          await new Promise(resolve=>setTimeout(resolve,0));
        }
        if (editWhileAway) await putCount(firstCount+2);
        // Return the independent score after the record and cast were drawn
        // and the old screen was closed. It must never touch the Settings DOM.
        release();
        await new Promise(resolve=>setTimeout(resolve,0));
        if (cast.isConnected || root.querySelector('.statistics-screen')) throw Error('Unexpected departed Statistics view');
        critics.read = reader;
        const expected = total + (editWhileAway ? 2 : 0);
        const returned = await visit(expected,expected/2);
        return {...returned,sameCard:cast===root.querySelector('[data-chart=cast]')};
      } finally {release();critics.read = reader;}
    }
    const interrupted = await quickDeparture(6,false);
    const interruptedThenEdited = await quickDeparture(8,true);
    return {visits,person,unrelated,sync,rapidScope,edited,updatedScore,interrupted,interruptedThenEdited,firstOpenWrites};
  } finally { app.dispose(); critics.close(); service.close(); await store.closeForUpdate(); }
}

test('Returning to Statistics reuses unchanged episode and metadata reads and observes an edit made while away',
  {timeout:60000}, async t => {
    const {server} = await testSite(), origin = 'http://127.0.0.1:'+await listen(server);
    const profile = await mkdtemp(join(tmpdir(),'csvtv-statistics-return-'));
    let browser;
    t.after(async () => {
      try { await browser?.close(); }
      finally { await stop(server); await rm(profile,{recursive:true,force:true,maxRetries:6,retryDelay:150}); }
    });
    browser = await openChromium(profile);
    await linkFixture(browser,origin);
    await browser.send('Emulation.setCPUThrottlingRate',{rate:4});
    const {visits,person,unrelated,sync,rapidScope,edited,updatedScore,interrupted,interruptedThenEdited,firstOpenWrites} =
      await browser.evaluate('('+exerciseStatisticsReturn+')()');
    assert.equal(firstOpenWrites,1,'Returning to Statistics unexpectedly started another first-open write');
    t.diagnostic('Returns after cast-member lookup, sync bookkeeping and score refresh: '+JSON.stringify({person,sync,updatedScore}));
    const [first,...returns] = visits;
    assert.ok(first.recordReads>0 && first.metadataKeys>=1501,'Expected a full first projection');
    assert.ok(returns.every(v=>v.recordReads===0 && v.metadataKeys===0),JSON.stringify(visits));
    for (const visit of [person,unrelated,sync,rapidScope,updatedScore]) assert.ok(visit.recordReads===0 && visit.metadataKeys===0,JSON.stringify(visit));
    assert.ok(edited.recordReads>0 && edited.metadataKeys>=1501,'An edit should load a fresh record');
    assert.ok(interrupted.recordReads===0 && interrupted.metadataKeys===0 && interrupted.sameCard,JSON.stringify(interrupted));
    assert.ok(interruptedThenEdited.recordReads>0 && !interruptedThenEdited.sameCard,JSON.stringify(interruptedThenEdited));
    t.diagnostic('300 shows, 13,500 episodes. First and four return visits (ms): '+visits.map(v=>v.ms.toFixed(1)).join(', '));
  });
