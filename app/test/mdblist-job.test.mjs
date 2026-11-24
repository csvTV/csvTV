import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';
import { TmdbLibrary } from '../src/tmdb-library.ts';
import { RatingRefreshJob } from '../src/rating-refresh-job.ts';

test('One background wake shares its title and season snapshot, then admits a fresh snapshot after an intervening edit',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  globalThis.window=new EventTarget(); globalThis.document=new EventTarget();
  const seen={tmdb:[],mdb:[],imdb:[]}, ready=Promise.withResolvers(), held=Promise.withResolvers();
  let show=17, reads=0;
  function heard(provider,id){
    seen[provider].push(id);
    if(Object.values(seen).every(values=>values.includes(17)))ready.resolve();
  }
  const store=Object.assign(new EventTarget(),{
    role:'reader',purgeTmdb:async()=>{},tmdbState:async()=>({token:'fictional',refused:null,cooldown:null}),
    async metadataTargets(){reads++;return {tables:{watched:[{show_id:show,season:1}],ratings:[],lists:[]},statisticsOpened:false};},
  });
  const service={store,environment:{now:Date.now,online:()=>true,visible:()=>true},
    read:async resource=>{
      if(resource.kind==='show')heard('tmdb',resource.id);
      return {fetchedAt:Date.now(),value:resource.kind==='show'?{status:'Ended',seasons:[{season:1}]}:[]};
    }};
  const mdb={keyStatus:async()=>({status:'ready'}),refresh:async ids=>{
    for(const id of ids)heard('mdb',id);
    await held.promise;
  }};
  const imdb={sourceStatus:async()=>({source:'omdb'}),refreshShows:async ids=>{for(const id of ids)heard('imdb',id);}};
  const library=new TmdbLibrary(service,mdb,imdb);
  t.after(()=>{held.resolve();library.close();delete globalThis.window;delete globalThis.document;});
  store.role='writer';
  const first=library.run();
  await ready.promise;
  assert.equal(reads,1,'The enabled sources read the same physical record more than once');
  show=18;
  store.dispatchEvent(new CustomEvent('recordchange',{detail:{tables:['watched'],settings:[],localKeys:[],onlyDescriptions:false}}));
  const second=library.run();
  held.resolve();await Promise.all([first,second]);
  assert.deepEqual(Object.values(seen).map(values=>values.at(-1)),[18,18,18]);
  assert.equal(reads,2,'A real edit must supersede the active title set exactly once');
  await library.run();
  assert.equal(reads,3,'The completed job left the previous target set installed');
});

test('A transient target-read failure can retry while a retired IMDb source is still settling',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  globalThis.window=new EventTarget();globalThis.document=new EventTarget();
  const entered=Promise.withResolvers(),hold=Promise.withResolvers(),scores=[];
  let source='github',reads=0;
  const store=Object.assign(new EventTarget(),{
    role:'reader',purgeTmdb:async()=>{},tmdbState:async()=>({token:null,refused:null,cooldown:null}),
    async metadataTargets(){
      if(++reads===2)throw Error('Fictional interrupted storage read');
      return {tables:{watched:[],ratings:[{show_id:reads===1?17:18}],lists:[]},statisticsOpened:false};
    },
  });
  const imdb={sourceStatus:async()=>({source}),refreshShows:async ids=>{
    if(source==='github'){entered.resolve();await hold.promise;}else scores.push(...ids);
  }};
  const library=new TmdbLibrary({store,environment:{now:Date.now,online:()=>true,visible:()=>true}},undefined,imdb);
  t.after(()=>{hold.resolve();library.close();delete globalThis.window;delete globalThis.document;});
  store.role='writer';const old=library.run();await entered.promise;
  source='omdb';
  store.dispatchEvent(new CustomEvent('recordchange',{detail:{tables:['ratings'],settings:[],localKeys:[],onlyDescriptions:false}}));
  store.dispatchEvent(new Event('imdbconfigchange'));
  await assert.rejects(library.run(),/interrupted storage read/);
  await library.run();
  assert.deepEqual(scores,[18]);assert.equal(reads,3);
  hold.resolve();await old;
});

test('Replacing an MDBList key starts the new library job before a stalled lookup on the old key ends', async t => {
  globalThis.window = new EventTarget();
  globalThis.document = new EventTarget();
  const store = Object.assign(new EventTarget(), {
    role:'reader',
    async metadataTargets() { return {tables:{watched:[], ratings:[{show_id:17}], lists:[
      {show_id:18,list:'Following upcoming'}, {show_id:18,list:'Hidden from upcoming'},
    ]},statisticsOpened:false}; },
    async purgeTmdb() {},
    async tmdbState() { return {token:null,refused:null,cooldown:null}; },
  });
  const pending = Promise.withResolvers(), started = Promise.withResolvers();
  let key = 'first';
  const calls = [];
  const service = {store,environment:{now:Date.now,online:()=>true,visible:()=>true}};
  const library = new TmdbLibrary(service, {
    async keyStatus() { return {status:'ready'}; },
    async refresh(ids) {
      calls.push([key,...ids]);
      if (key === 'first') { started.resolve(); await pending.promise; }
    },
  });
  t.after(() => { pending.resolve(); library.close(); delete globalThis.window; delete globalThis.document; });
  store.role = 'writer';
  const oldJob = library.run();
  await started.promise;
  key = 'replacement';
  store.dispatchEvent(new CustomEvent('recordchange',{detail:{
    tables:['settings'], settings:['mdblist_key'], localKeys:[], onlyDescriptions:false,
  }}));
  await library.run();
  assert.deepEqual(calls,[['first',17],['replacement',17]]);
  pending.resolve();
  await oldJob;
});

test('A TMDB cache notification preserves the MDBList retry, and closing the app cancels the next deadline', async t => {
  const start = Date.UTC(2026, 10, 18, 12);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: start });
  globalThis.window = new EventTarget();
  globalThis.document = new EventTarget();
  t.after(() => { delete globalThis.window; delete globalThis.document; });

  const store = Object.assign(new EventTarget(), {
    role: 'reader',
    async metadataTargets() { return {tables:{watched:[], ratings:[{show_id:17}], lists:[]},statisticsOpened:false}; },
    async purgeTmdb() {},
    async tmdbState() { return { token: 'fictional', refused: null, cooldown: null }; },
  });
  const pendingTitle = Promise.withResolvers();
  const titleStarted = Promise.withResolvers();
  const title = { fetchedAt: start, value: null };
  const service = {
    store, environment: { now: Date.now, online: () => true, visible: () => true },
    async read(resource) { return resource.kind === 'configuration' ? { fetchedAt: start, value: {} } : null; },
    async refresh() { titleStarted.resolve(); await pendingTitle.promise; return title; },
  };
  let deadline = start + 300_000;
  const requested = [];
  const critics = {
    async keyStatus() { return Date.now() < deadline ? { status: 'throttled', retryAt: deadline } : { status: 'ready' }; },
    async refresh(ids) { requested.push([...ids]); },
  };
  const library = new TmdbLibrary(service, critics);
  t.after(() => library.close());
  let cacheChanges = 0, scoreChanges = 0;
  library.addEventListener('cachechange', () => cacheChanges++);
  store.addEventListener('mdblistchange', () => scoreChanges++);
  store.role = 'writer';
  const firstRun = library.run();
  await titleStarted.promise;
  // Let the paused score job install its timer before the independent TMDB refresh completes.
  await nextTurn();
  pendingTitle.resolve();
  await firstRun;
  assert.equal(cacheChanges, 1);
  t.mock.timers.tick(299_999);
  assert.equal(scoreChanges, 0);
  assert.deepEqual(requested, []);
  t.mock.timers.tick(1);
  assert.equal(scoreChanges, 1, 'The visible screen should retry at the provider deadline');
  t.mock.timers.tick(1);
  await nextTurn();
  assert.deepEqual(requested, [[17]], 'The background library should resume at the same deadline');

  deadline = Date.now() + 300_000;
  store.dispatchEvent(new Event('mdblistpausechange'));
  await nextTurn();
  library.close();
  t.mock.timers.tick(300_001);
  assert.equal(scoreChanges, 1, 'A closed app woke a screen for an obsolete timer');
  assert.deepEqual(requested, [[17]]);
});
test('A delayed status read cannot cancel a newer scheduled ratings probe', async t => {
  t.mock.timers.enable({apis:['setTimeout','Date'], now:1000});
  const earlier = Promise.withResolvers();
  let reads = 0, wakes = 0;
  const job = new RatingRefreshJob({store:{role:'writer'}, environment:{now:Date.now}}, {
    status: () => ++reads === 1 ? earlier.promise : Promise.resolve({enabled:false,retryAt:4000}),
    refresh: async () => {}, wake: () => { wakes++; },
  });
  const first = job.scheduleRetry();
  await job.scheduleRetry();
  earlier.resolve({enabled:true});
  await first;
  t.mock.timers.tick(2999);
  assert.equal(wakes, 0);
  t.mock.timers.tick(1);
  assert.equal(wakes, 1);
  job.close();
});

test('A background ratings job rechecks visibility, connectivity and writer access after asynchronous reads', async () => {
  for (const read of ['status', 'snapshot']) for (const change of ['hidden', 'offline', 'reader']) {
    const gate = Promise.withResolvers(), started = Promise.withResolvers();
    let paused = false, snapshots = 0, fetches = 0;
    async function waitAt(name) {
      if (name === read) { started.resolve(); await gate.promise; }
    }
    const store = {role:'writer', async metadataTargets() {
      snapshots++; await waitAt('snapshot'); return {tables:{watched:[{show_id:17}], ratings:[], lists:[]}};
    }};
    const environment = {online:() => !(paused && change === 'offline'), visible:() => !(paused && change === 'hidden')};
    const job = new RatingRefreshJob({store, environment}, {
      async status() { await waitAt('status'); return {enabled:true}; },
      async refresh(ids) { assert.deepEqual([...ids], [17]); fetches++; }, wake() {},
    });
    const work = job.run();
    await started.promise;
    paused = true;
    if (change === 'hidden') job.hidden();
    if (change === 'reader') store.role = 'reader';
    gate.resolve(); await work;
    assert.equal(snapshots, read === 'snapshot' ? 1 : 0, read + '/' + change);
    assert.equal(fetches, 0);
    paused = false; store.role = 'writer';
    await job.run(); assert.equal(fetches, 1);
    job.close();
  }
});

test('TMDB library retirement between cleanup, metadata and retry bookkeeping ends the active run', async t => {
  globalThis.window = new EventTarget();
  globalThis.document = new EventTarget();
  t.after(() => { delete globalThis.window; delete globalThis.document; });
  for (const phase of ['purge', 'status', 'detail']) for (const retired of ['closed', 'obsolete']) {
    const began = Promise.withResolvers(), resume = Promise.withResolvers();
    async function pause(at) {
      if (phase === at) { began.resolve(); await resume.promise; }
    }
    const store = Object.assign(new EventTarget(), {
      role:'reader', purgeTmdb:() => pause('purge'),
      tmdbState:async () => {
        assert.equal(store.role, 'writer', 'Read the retired database after ' + phase);
        await pause('status');
        return { token:'fictional', refused:null, cooldown:null };
      },
    });
    const library = new TmdbLibrary({store, environment:{now:Date.now, online:()=>true, visible:()=>true}});
    library.job.run = () => {
      assert.equal(store.role, 'writer', 'Started detail work on a retired device');
      return pause('detail');
    };
    store.role = 'writer';
    const work = library.run();
    await began.promise;
    store.role = retired;
    store.dispatchEvent(new Event('rolechange'));
    resume.resolve();
    await work;
    library.close();
  }
});
