import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {openChromium} from './offline-chromium.mjs';
import {linkFixture, offlineProviders, renewSyncedFixture} from './offline-providers.mjs';
import {listen, stop, testSite} from './offline-site.mjs';

async function device(t, metadata = new Map()) {
  const {server} = await testSite();
  const origin = 'http://127.0.0.1:' + await listen(server);
  const profile = await mkdtemp(join(tmpdir(),'csvtv-recent-marks-'));
  let browser;
  t.after(async () => {
    try { await browser?.close(); }
    finally { await stop(server); await rm(profile,{recursive:true,force:true,maxRetries:6,retryDelay:150}); }
  });
  const providers = offlineProviders(origin);
  const respond = (event,send) => {
    const url = new URL(event.request.url);
    const extra = url.hostname === 'api.themoviedb.org' && event.request.method === 'GET' && metadata.get(url.pathname);
    if (!extra) return providers.respond(event,send);
    return send('Fetch.fulfillRequest',{requestId:event.requestId,responseCode:200,
      responseHeaders:[{name:'Content-Type',value:'application/json'},{name:'Access-Control-Allow-Origin',value:origin}],
      body:Buffer.from(JSON.stringify(extra)).toString('base64')});
  };
  await providers.settings({tmdb_key:'fictional-offline-key'});
  browser = await openChromium(profile,respond);
  await linkFixture(browser,origin);
  return {app:origin + '/tracker/',browser,providers, async restart() {
    await browser.close();
    browser = await openChromium(profile,respond);
    return browser;
  }};
}

test('Upgrading older device history preserves watched titles in order and honors an existing shared dismissal', {timeout:30000}, async t => {
  const {browser} = await device(t);
  const result = await browser.evaluate('(' + (async function() {
    const {openDeviceStore} = await import('/tracker/storage.js');
    const name = 'legacy-recent-history';
    let store = await openDeviceStore({name});
    const watch = id => ({show_id:id,show:'Signal '+id,season:1,episode:1,episode_id:id,title:'Pilot',times_watched:1});
    try {
      await store.whenWriter();
      await store.commit((await store.snapshot()).revision,{local:{recentlyMarked:[80,20,40,30,20]},
        put:{watched:[20,30,40].map(watch),settings:[{setting:'recently_marked.40',value:'1234/0'}]}});
      await store.closeForUpdate();
      store = await openDeviceStore({name}); await store.whenWriter();
      const first = await store.snapshot();
      const order = (await store.tmdbRows(20)).recentlyMarked;
      await store.closeForUpdate();
      store = await openDeviceStore({name}); await store.whenWriter();
      const reopened = await store.snapshot();
      const pending = Array.from({length:20},(_,i) => ({setting:'recently_marked.'+(100+i)+'.1.0.0',value:'900/900'}));
      await store.commit(reopened.revision,{put:{settings:pending}});
      const visible = () => store.tmdbRows(20).then(record => store.isOnRecentRail(20,record));
      const membership = [await visible()];
      const controller = new AbortController(), original = IDBObjectStore.prototype.getKey;
      let checked = 0, aborted = false;
      IDBObjectStore.prototype.getKey = function(...args) {
        const request = original.apply(this,args);
        if (this.name === 'watched' && ++checked === 1) request.addEventListener('success',() => controller.abort(),{once:true});
        return request;
      };
      try { await store.isOnRecentRail(20,await store.tmdbRows(20,false),controller.signal); }
      catch (error) { aborted = error.name === 'AbortError'; }
      finally { IDBObjectStore.prototype.getKey = original; }
      if (!aborted || checked !== 1) throw Error('A closed menu kept checking later watch positions');
      const arrivals = Array.from({length:8},(_,i) => watch(i+100));
      await store.commit((await store.snapshot()).revision,{put:{watched:arrivals.slice(0,7)}});
      membership.push(await visible());
      await store.commit((await store.snapshot()).revision,{put:{watched:arrivals.slice(7)}});
      membership.push(await visible());
      await store.commit((await store.snapshot()).revision,{remove:{watched:arrivals.map(row=>[row.show_id,row.season,row.episode])}});
      await store.dismissRecentMark(20);
      return {order,reopened:reopened.local.recentlyMarked,rows:reopened.tables.settings,once:reopened.revision === first.revision,membership,
        afterDismiss:(await store.homeRecord()).local.recentlyMarked};
    } finally { await store.closeForUpdate(); indexedDB.deleteDatabase(name); }
  }).toString() + ')()');
  assert.deepEqual(result,{order:[20,30],reopened:[20,30],afterDismiss:[30],once:true,membership:[true,true,false],rows:[
    {setting:'recently_marked.20',value:'3/3'}, {setting:'recently_marked.30',value:'1/1'},
    {setting:'recently_marked.40',value:'1234/0'}]});
});

test('A delayed dismissal stays with the selected record and mark across retries', {timeout:60000}, async t => {
  const {browser} = await device(t);
  const outcomes = await browser.evaluate('(' + (async function() {
    const {openDeviceStore} = await import('/tracker/storage.js');
    const results = [];
    for (const kind of ['erase','account','newer mark','unrelated edit','record guard']) {
      const name = 'recent-dismiss-' + crypto.randomUUID(), store = await openDeviceStore({name});
      try {
        await store.whenWriter();
        const id = 63, mark = 'recently_marked.63.1.0.0';
        const watch = {show_id:id,show:'Signal Garden',season:1,episode:1,episode_id:301,title:'Pilot',times_watched:1};
        const seed = {put:{watched:[watch],settings:[{setting:mark,value:'750/750'}]},local:{syncAccountId:'fictional-A'}};
        await store.commit((await store.snapshot()).revision,seed);
        const gate = Promise.withResolvers(), started = Promise.withResolvers(), submit = store.commit.bind(store);
        let active = true, once = true;
        store.commit = async (rev,patch,...options) => {
          if (once && patch.put?.settings?.some(row => row.setting === 'recently_marked.63' && row.value.endsWith('/0'))) {
            once = false; started.resolve(); await gate.promise;
          }
          return submit(rev,patch,...options);
        };
        const pending = store.dismissRecentMark(id,() => active);
        try {
          await started.promise;
          const {revision} = await store.snapshot();
          if (kind === 'erase') {
            await store.eraseDevice(revision);
            await store.commit((await store.snapshot()).revision,seed);
          } else if (kind === 'account') await store.commit(revision,{local:{syncAccountId:'fictional-B'}});
          else if (kind === 'newer mark') await store.commit(revision,{put:{settings:[{setting:mark,value:'850/850'}]}});
          else if (kind === 'unrelated edit') await store.commit(revision,{put:{ratings:[{show_id:94,show:'Beacon',rating:7}]}});
          else active = false;
        } finally { gate.resolve(); }
        await pending;
        const before = (await store.homeRecord()).local.recentlyMarked.includes(id);
        await store.dismissRecentMark(id);
        const after = await store.homeRecord();
        results.push([kind,before,after.local.recentlyMarked.includes(id),after.tables.watched[0].times_watched]);
      } finally { await store.closeForUpdate(); indexedDB.deleteDatabase(name); }
    }
    return results;
  }).toString() + ')()');
  assert.deepEqual(outcomes, [
    ['erase',true,false,1],['account',true,false,1],['newer mark',true,false,1],
    ['unrelated edit',false,false,1],['record guard',true,false,1],
  ]);
});

test('Home reads its record, recent history and setup state in one bounded IndexedDB transaction', async t => {
  const {browser} = await device(t);
  const observed = await browser.evaluate('(' + (async function() {
    const {openDeviceStore} = await import('/tracker/storage.js');
    const store = await openDeviceStore();
    try {
      await store.whenWriter();
      const title = {show_id:15,show:'Signal Garden'};
      const before = await store.snapshot();
      await store.commit(before.revision,{local:{firstUseDismissed:true,unrelatedValue:'fictional'},put:{
        watched:[{...title,season:1,episode:1,episode_id:1501,title:'First Light',times_watched:3}],
        ratings:[{...title,rating:8}],lists:[{...title,list:'Watchlist'}],shows:[{...title,year:2025,imdb_id:''}],
        settings:[{setting:'recently_marked.15',value:'1234/1234'},{setting:'recently_marked.16',value:'1235/0'}],
      }});
      const reads = [], transactions = [], undo = [];
      function trace(object,method,record) {
        const original = object[method];
        object[method] = function(...args) {
          record(this,args);
          return original.apply(this,args);
        };
        undo.push(() => { object[method] = original; });
      }
      trace(IDBDatabase.prototype,'transaction',(_,args) => transactions.push(Array.from(args[0]).sort()));
      for (const method of ['get','getKey','getAll','getAllKeys','openCursor']) {
        trace(IDBObjectStore.prototype,method,(table,[key]) => {
          const range = key instanceof IDBKeyRange ? [key.lower,key.upper] : key;
          reads.push([table.name,method,range ?? null]);
        });
      }
      try {
        const {tables,local} = await store.homeRecord();
        return {reads,transactions,local,rows:[tables.watched[0].times_watched,tables.ratings[0].rating,
          tables.lists[0].list,tables.shows[0].show]};
      } finally { undo.reverse().forEach(restore => restore()); }
    } finally { await store.closeForUpdate(); }
  }).toString() + ')()');
  assert.deepEqual(observed.rows,[3,8,'Watchlist','Signal Garden']);
  assert.deepEqual(observed.local,{recentlyMarked:[15],firstUseDismissed:true,syncAccountId:'fictional-owner',dropboxSession:true});
  assert.deepEqual(observed.transactions,[['lists','local','ratings','settings','shows','watched']]);
  assert.deepEqual(observed.reads.sort(),[
    ['watched','getAll',null],['ratings','getAll',null],['lists','getAll',null],['shows','getAll',null],
    ['settings','getAll',['recently_marked.','recently_marked.\uffff']],
    ['local','get','recentlyMarked'],['local','get','firstUseDismissed'],['local','get','syncAccountId'],
    ['local','getKey','dropboxSession'],
  ].sort());
});

test('Home removes the last watch from Recently marked, survives a restart and accepts a new mark', {timeout:90000}, async t => {
  const session = await device(t);
  const {app,providers} = session;
  let {browser} = session;
  await providers.upload('ratings.csv','show_id,show,rating\r\n45,The Listening House,8\r\n');
  await providers.upload('lists.csv','list,show_id,show\r\nWatchlist,45,The Listening House\r\n');

  const recent = '[data-recent] a[href="#/show/45"]';
  const episode = (number,control) => '[data-season-focus="episode-' + number + '-' + control + '"]';
  const query = selector => 'document.querySelector(' + JSON.stringify(selector) + ')';
  async function home(plays) {
    await browser.navigate(app + '#/home');
    await browser.waitFor(query('.record-totals > div:last-child dd') + '?.textContent === ' + JSON.stringify(String(plays)), 'Home play total ' + plays);
    assert.equal(await browser.evaluate('!!' + query(recent)), plays > 0, 'Recently marked disagrees with the remaining watches');
  }
  async function season() {
    await browser.navigate(app + '#/show/45/season/1');
    await browser.waitFor(query(episode(1,'add')) + '?.matches(":enabled")', 'usable season controls');
  }
  async function count(number, played) {
    await browser.waitFor(query(episode(number,'count')) + '?.textContent === ' +
      JSON.stringify(played ? '1×' : '0×'), 'episode ' + number + (played ? ' marked' : ' unmarked'));
  }
  async function chooseAction(label) {
    const button = 'Array.from(document.querySelectorAll("dialog[open] .watch-sheet-action")).find(b => b.firstElementChild.textContent === ' + JSON.stringify(label) + ')';
    await browser.waitFor(button,label + ' in the actions menu');
    await browser.evaluate(button + '.focus()');
    await browser.press('Enter');
  }
  async function remove(number) {
    await browser.click(episode(number,'subtract'));
    await count(number,false);
  }
  async function undo() {
    await browser.click('.undo-bar:not([hidden]) [data-undo]');
    await browser.waitFor(query('.undo-bar') + '?.hidden', 'Undo committed');
  }

  await home(0);
  await season();
  await browser.click(episode(1,'add'));
  await count(1,true);
  await undo();
  await home(0);

  await season();
  await browser.click(episode(1,'add'));
  await count(1,true);
  await browser.click(episode(2,'add'));
  await count(2,true);
  await home(2);
  await season();
  await remove(2);
  await home(1);
  await season();
  await remove(1);
  await undo();
  await home(1);
  await browser.navigate(app + '#/show/45');
  await browser.click('.show-more');
  await chooseAction('Remove watches');
  await browser.click('dialog[open] [data-accept]');
  await browser.waitFor(query('.undo-bar:not([hidden])') + '?.textContent.includes("Watches removed")', 'show removal committed');
  await home(0);

  browser = await session.restart();
  await home(0);
  await browser.navigate(app + '#/show/45');
  await browser.waitFor(query('.show-rating') + '?.textContent === "8/10"');
  await browser.click('.show-more');
  await browser.waitFor(query('dialog[open]') + '?.textContent.includes("Remove from Watchlist")', 'the existing Watchlist entry after restart');
  await browser.press('Escape');
  await season();
  await browser.click(episode(2,'add'));
  await count(2,true);
  await home(1);
});

test('Only the first watch in a previously unseen season can bring an imported or dismissed show into Home', {timeout:90000}, async t => {
  const session = await device(t,new Map([
    ['/3/tv/45',{id:45,name:'The Listening House',first_air_date:'2019-10-01',status:'Ended',overview:'Fictional broadcasts.',
      keywords:{results:[]},external_ids:{imdb_id:null},
      seasons:[1,2].map(n => ({season_number:n,name:'Season '+n,episode_count:2})),
      last_episode_to_air:{season_number:2,episode_number:2,air_date:'2021-10-01'}}],
    ['/3/tv/45/season/2',{season_number:2,name:'Season 2',episodes:[1,2].map(n => ({
      id:45020+n,episode_number:n,name:'Recording '+n,runtime:30,air_date:'2021-10-01'}))}],
    ['/3/tv/45/aggregate_credits',{id:45,cast:[{id:81,name:'Mira Vale',total_episode_count:2,roles:[{character:'The Announcer'}]}]}],
    ['/3/person/81/tv_credits',{id:81,cast:[{id:45,name:'The Listening House',first_air_date:'2019-10-01',character:'The Announcer'}]}],
  ]));
  const {app,providers} = session;
  let {browser} = session;
  const remote = 'show_id,show,season,episode,title,times_watched,episode_id\r\n45,The Listening House,1,1,Recording 1,1,45011\r\n';
  await providers.upload('watched.csv',remote);
  const firstAdd = '[data-season-focus="episode-1-add"]';
  const firstCount = '[data-season-focus="episode-1-count"]';
  const link = '[data-recent] a[href="#/show/45"]';
  async function home(plays, marked, step) {
    await browser.navigate(app + '#/home');
    await browser.waitFor('document.querySelector(".record-totals > div:last-child dd")?.textContent === ' +
      JSON.stringify(String(plays)), step + ' play count');
    assert.equal(await browser.evaluate('!!document.querySelector(' + JSON.stringify(link) + ')'),marked,step);
  }
  async function rewatch() {
    await browser.navigate(app + '#/show/45/season/1');
    await browser.waitFor('document.querySelector('+JSON.stringify(firstAdd)+')?.matches(":enabled")');
    await browser.evaluate('document.querySelector('+JSON.stringify(firstAdd)+').focus()');
    await browser.press('Enter');
    await browser.waitFor('document.querySelector(' + JSON.stringify(firstCount) + ')?.textContent === "2×"');
  }
  await home(1,false,'Existing Dropbox watch at first sign-in');
  await browser.waitFor('document.querySelector(".sync-state")?.dataset.synced === "true"', 'initial sync');
  const revision = providers.files.get('/watched.csv').meta.rev;
  await browser.navigate(app + '#/library');
  await browser.click('.library-screen a[href="#/show/45"]');
  await browser.click('[data-season="1"]');
  await browser.waitFor('document.querySelector(' + JSON.stringify(firstCount) + ')?.textContent === "1×"');
  await browser.navigate(app + '#/show/45');
  await browser.click('.show-cast-member[href="#/cast/81?show=45"]');
  await browser.waitFor('document.querySelector(".cast-page h1")?.textContent === "Mira Vale"');
  await browser.click('.cast-page a[href="#/show/45"]');
  await browser.waitFor('document.querySelector(".show-hero h1")?.textContent === "The Listening House"');
  await home(1,false,'Viewing the show, season and cast');
  await renewSyncedFixture(browser);
  await home(1,false,'Same-account sign-in and sync');
  assert.equal(providers.files.get('/watched.csv').meta.rev,revision,'Browsing or syncing rewrote watched.csv');
  await rewatch();
  await browser.click('.undo-bar:not([hidden]) [data-undo]');
  await browser.waitFor('document.querySelector(' + JSON.stringify(firstCount) + ')?.textContent === "1×"');
  await home(1,false,'Undo of the only local mark');
  browser = await session.restart();
  await home(1,false,'Undone rewatch after browser restart');
  await rewatch();
  await home(2,false,'A later deliberate rewatch');
  browser = await session.restart();
  await home(2,false,'A retained local rewatch after browser restart');
  await browser.navigate(app + '#/show/45/season/2');
  await browser.click(firstAdd + ':enabled');
  await browser.waitFor('document.querySelector(' + JSON.stringify(firstCount) + ')?.textContent === "1×"');
  await home(3,true,'The first watch in the second season');
  const dismiss = '[data-recent] [data-dismiss-recent="45"]';
  await browser.waitFor('document.querySelector(' + JSON.stringify(dismiss) + ')');
  await browser.evaluate('document.querySelector(' + JSON.stringify(dismiss) + ').focus()');
  await browser.press('Enter');
  await browser.waitFor('!document.querySelector(' + JSON.stringify(link) + ')','removed recent card');
  assert.equal(await browser.evaluate('location.hash'),'#/home','Dismissing opened the show');
  await home(3,false,'Dismissing a recent show keeps every play');
  browser = await session.restart();
  await home(3,false,'Dismissed recent show stays hidden after restart');
  await browser.navigate(app + '#/show/45/season/1');
  await browser.click('[data-season-focus="episode-2-add"]:enabled');
  await browser.waitFor('document.querySelector(\'[data-season-focus="episode-2-count"]\')?.textContent === "1×"');
  await home(4,false,'Another episode in the already-started first season keeps a dismissed show hidden');
});

test('A cached mark survives restoration of the same Dropbox account and TMDB key during the tap', {timeout:60000}, async t => {
  const {browser,app} = await device(t);
  await browser.navigate(app + '#/show/45/season/1');
  await browser.waitFor('document.querySelector(\'[data-season-focus="episode-2-add"]\')?.matches(":enabled")');
  await browser.waitFor('document.querySelector(".sync-state")?.dataset.synced === "true"');
  await browser.navigate(new URL('/fixture',app).href);
  const result = await browser.evaluate('(' + (async function() {
    const {openDeviceStore} = await import('/tracker/storage.js');
    const {TmdbService} = await import('/tracker/tmdb-service.js');
    const {WatchActions} = await import('/tracker/watch-actions.js');
    const store = await openDeviceStore();
    const service = new TmdbService(store);
    try {
      await store.whenWriter();
      const {session} = await store.dropboxState();
      store.connectProviderKeys(async () => { throw Error('No credential writes are expected'); },Date.now);
      const cached = await service.keyStatus();
      if (cached.status !== 'missing-key' || cached.cachedMarkAccount !== session.accountId) throw Error('Expected a cached offline mark');
      const edit = service.editWatches.bind(service);
      const restoreKey = value => store.loadProviderKeys(session,[{setting:'tmdb_key',value}],()=>true);
      // Resume the real credential read between the tap's initial check and its guarded write.
      service.editWatches = async (...args) => {
        await restoreKey('fictional-offline-key');
        return edit(...args);
      };
      const watch = new WatchActions(service,async()=>true,()=>{},()=>{});
      const episode = {show_id:45,show:'The Listening House',season:1,episode:2,title:'Recording 2',episode_id:45012};
      await watch.episode(episode,'mark');
      service.editWatches = edit;
      const ready = await service.keyStatus();
      if (ready.status !== 'ready' || ready.generation !== cached.generation) throw Error('The same credential must retain its generation');
      async function rejected(action) {
        try { await action(); } catch (error) { return error.kind; }
        throw Error('Unexpected mark approval');
      }
      const candidate = ({tables}) => ({rows:tables.watched.map(row => ({...row,times_watched:row.times_watched+1}))});
      const wrongOwner = await rejected(() => edit(45,candidate,{generation:cached.generation,accountId:'fictional-different-account'}));
      const missingEpisode = await rejected(() => watch.episode({...episode,episode:3,episode_id:45013},'mark'));
      await restoreKey('fictional-replacement');
      const changedKey = await rejected(() => edit(45,candidate,{generation:cached.generation,accountId:session.accountId}));
      const replacement = await service.keyStatus();
      await store.writeTmdb(replacement.generation,{refused:'Fictional provider refusal'});
      const refusedKey = await rejected(() => edit(45,candidate,{generation:replacement.generation,accountId:session.accountId}));
      await store.loadProviderKeys(session,[],()=>true);
      const removedKey = await rejected(() => watch.episode(episode,'again'));
      const record = await store.tmdbRows(45);
      return {watch:record.tables.watched.map(row => [row.episode,row.times_watched]),recent:record.recentlyMarked,
        wrongOwner,missingEpisode,changedKey,refusedKey,removedKey};
    } finally { service.close(); await store.closeForUpdate(); }
  }).toString() + ')()');
  assert.deepEqual(result,{watch:[[2,1]],recent:[45],wrongOwner:'superseded',missingEpisode:'not-found',
    changedKey:'superseded',refusedKey:'superseded',removedKey:'refused'});
});
