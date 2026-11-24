import { connectFixtureProviders, replaceFixtureSettings } from './provider-fixture-cases.mjs';
import { openDeviceStore } from '../dist/storage.js';
import { MdbListClient } from '../dist/mdblist-client.js';
import { MdbListService } from '../dist/mdblist-service.js';

const day = 86_400_000;
const start = Date.UTC(2026, 10, 18);
const check = (ok, message) => { if (!ok) throw new Error(message); };
const sample = (id, score = 71) => ({ ids: { tmdb: id }, type: 'show', ratings: [{ source: 'metacritic', value: score }] });
function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { resolve, promise };
}
async function fixture(exercise) {
  const dbName = 'MDBList fictional shows ' + crypto.randomUUID();
  const env = { time: start, isOnline: true, isVisible: true,
    now() { return this.time; }, online() { return this.isOnline; }, visible() { return this.isVisible; } };
  const state = { calls: [], handler: id => Response.json(sample(id)) };
  const send = async (url, init) => {
    const id = Number(url.pathname.split('/').pop());
    check(init.method === 'GET', 'Expected a browser-simple GET');
    state.calls.push(id);
    return state.handler(id);
  };
  let store, service;
  const reopen = async () => {
    service?.close(); store?.close();
    store = await openDeviceStore({ name: dbName });
    await connectFixtureProviders(store,dbName);
    service = new MdbListService(store, new MdbListClient({ fetch: send, now: () => env.time }), env);
    return { store, service };
  };
  try { await exercise({ ...await reopen(), name: dbName, state, env, reopen }); }
  finally { service?.close(); store?.close(); indexedDB.deleteDatabase(dbName); }
}

export async function mdbListStorageCases(run) {
  await run('Score notices preserve Statistics for unrelated titles and unchanged critic scores across tabs',()=>fixture(async({store,service,name})=>{
    await service.saveKey('fictional-score-cache');
    const reader=await openDeviceStore({name});
    try {
      const {generation}=await store.mdbListState();
      async function set(score, shouldChangeStatistics, extra) {
        const signals=[store,reader].map(db=>new Promise(resolve=>db.addEventListener('mdblistchange',resolve,{once:true})));
        const entries=new Map([[33,{fetchedAt:Date.now(),scores:{tomatoes:score,metacritic:null,myanimelist:null}}]]);
        if(extra)entries.set(34,{fetchedAt:Date.now(),scores:{tomatoes:52,metacritic:null,myanimelist:null}});
        check(await store.writeMdbList(generation,{entries}),'Could not install fixture score');
        for(const event of await Promise.all(signals))
          check((event.detail?.statisticsUnchanged !== true) === shouldChangeStatistics,'Wrong comparison invalidation');
        check((await reader.mdbListScores([33])).entries.get(33)?.scores.tomatoes===score,'Reader did not get the new score');
      }
      await set(62,false);
      await store.commit((await store.snapshot()).revision,{put:{ratings:[{show_id:33,show:'Fictional show',rating:8}]}});
      await set(62,false);await set(91,true);await set(null,true);await set(null,false);
      await store.commit((await store.snapshot()).revision,{remove:{ratings:[33]}});
      await set(45,false);
      await set(87,true,true);
    }finally{await reader.closeForUpdate();}
  }));
  await run('MDBList checks the background and foreground requester again when a queued cache write takes its turn',
    ()=>fixture(async({store,service,env,reopen})=>{
      await service.saveKey('fictional-critics');
      const write=store.writeMdbList.bind(store);
      for(const [id,background,interruption] of [[1,true,'hidden'],[2,false,'offline'],[3,false,'hidden']]){
        const entered=Promise.withResolvers(),release=Promise.withResolvers();
        store.writeMdbList=async(...args)=>{entered.resolve();await release.promise;return write(...args);};
        const pending=service.refresh([id],background);await entered.promise;
        if(interruption==='hidden')env.isVisible=false;else env.isOnline=false;
        release.resolve();await pending;
        env.isVisible=env.isOnline=true;
      }
      const next=await reopen();
      check([...(await next.service.read([1,2,3])).keys()].join()==='3',
        'An interrupted score committed or a still-eligible foreground score was dropped');
    }));
  await run('Large critic projections use bounded key probes and read only requested values, including after a sparse probe fills',
    () => fixture(async ({store,service,env}) => {
      await service.saveKey('fictional-critics');
      const entries = new Map();
      for (let id=1;id<=710;id++) if (id%19) {
        entries.set(id,{fetchedAt:env.time-id,scores:{tomatoes:id%101,metacritic:null,myanimelist:null}});
      }
      check(await store.writeMdbList((await store.mdbListState()).generation,{entries}),'Could not seed score samples');
      const probeLimits = [], read = [], rangeSizes = [], originals = new Map();
      const prototype = IDBObjectStore.prototype;
      for (const method of ['get','getAll','getAllKeys']) {
        const original = prototype[method]; originals.set(method,original);
        prototype[method] = function(...args) {
          const request = original.apply(this,args);
          if (this.name !== 'cache') return request;
          if (method === 'getAllKeys') probeLimits.push(args[1]);
          else request.addEventListener('success',()=>{
            const rows = method === 'get' ? [request.result] : request.result;
            if (method === 'getAll') rangeSizes.push(rows.length);
            for (const row of rows) if (row) read.push(env.time-row.fetchedAt);
          });
          return request;
        };
      }
      try {
        for (const [count,stride] of [[32,1],[90,1],[90,7]]) {
          probeLimits.length = read.length = rangeSizes.length = 0;
          const ids = Array.from({length:count},(_,i)=>1+stride*i).reverse();
          const wanted = new Set(ids);
          const actual = (await store.mdbListState([...ids,...ids.slice(0,8)])).entries;
          check(probeLimits.length === 1 && probeLimits[0] === (count>32?513:129),'Unexpected critic key probe size');
          check(read.every(id=>wanted.has(id)) && read.length===actual.size,'Read unrelated or duplicate critic scores');
          check(ids.every(id=>actual.get(id)?.fetchedAt===entries.get(id)?.fetchedAt),'Missing or misassigned score');
          if (stride===1) check(rangeSizes.length===1,'Dense scores required multiple value reads');
        }
      } finally { for (const [method,original] of originals) prototype[method]=original; }
    }));

  await run('A second tab updates MyAnimeList scores on a real synced source change without another request',
    () => fixture(async ({ name, store, service, state, env }) => {
      await service.saveKey('fixture-tab');
      state.handler = id => Response.json({ ids: { tmdb: id }, type: 'show', ratings: [{ source: 'myanimelist', value: 7.4 }] });
      await service.refresh([24]);
      const reader = await openDeviceStore({ name });
      const display = new MdbListService(reader, new MdbListClient({ fetch: () => { throw Error('Reader made a request'); } }), env);
      try {
        check(reader.role === 'reader', 'A second connection acquired the writer');
        const initial = (await display.keyStatus()).generation;
        let notices = 0;
        reader.addEventListener('mdblistchange', () => { notices++; });
        const github = { setting: 'mal_source', value: 'github' };

        async function sync(patch, expectedNotices, expectedScore) {
          // The sync status message follows any score invalidation on the same broadcast channel.
          const settled = new Promise(resolve => reader.addEventListener('dropboxstatus', resolve, { once: true }));
          await store.commit((await store.snapshot()).revision, patch, { syncWrite: true });
          await settled;
          check(notices === expectedNotices && (await display.read([24])).get(24).myanimelist === expectedScore,
            'The reader missed a source change or received an invalidation for an identical setting');
          check((await display.keyStatus()).generation === initial, 'A source-only change invalidated a working MDBList key');
        }
        await sync({ put: { settings: [github] } }, 1, null);
        let aborted = false;
        try { await store.commit((await store.snapshot()).revision, { replace: { settings: [github, github] } }); }
        catch (error) { aborted = error.name === 'ConstraintError'; }
        check(aborted, 'The duplicate setting did not abort the simulated restore');
        await sync({ replace: { settings: [github] } }, 1, null);
        await sync({ remove: { settings: ['mal_source'] } }, 2, 7.4);
        await sync({ replace: { settings: [github] } }, 3, null);
        await sync({ replace: { settings: [] } }, 4, 7.4);
        await service.refresh([24]);
        check(state.calls.join() === '24', 'A source-only change downloaded fresh critic scores again');
      } finally { display.close(); reader.close(); }
    }));

  await run('An in-flight MDBList response respects synced MyAnimeList source changes and its cached score returns offline',
    () => fixture(async ({ store, service, state, env, reopen }) => {
      check((await service.keyStatus()).malSource === 'mdblist', 'A fresh device did not default to MDBList');
      await service.saveKey('fixture-one');
      const started = deferred(), release = deferred();
      state.handler = async id => {
        started.resolve(); await release.promise;
        return Response.json({ ids: { tmdb: id }, type: 'show', ratings: [
          { source: 'myanimelist', value: 8.2 }, { source: 'tomatoes', value: 0 }, { source: 'metacritic', value: 79 },
        ] });
      };
      const pending = service.refresh([24]);
      await started.promise;
      await store.commit((await store.snapshot()).revision, { put: { settings: [{ setting: 'mal_source', value: 'github' }] } });
      release.resolve(); await pending;
      ({ store, service } = await reopen());
      env.isOnline = false;
      const score = (await service.read([24])).get(24);
      check((await service.keyStatus()).malSource === 'github' && score.myanimelist === null &&
        score.tomatoes === 0 && score.metacritic === 79, 'An inactive score appeared or the active critic scores disappeared');
      await store.commit((await store.snapshot()).revision, { remove: { settings: ['mal_source'] } });
      check((await service.read([24])).get(24).myanimelist === 8.2 && state.calls.join() === '24',
        'Selecting MDBList again must reuse the score already obtained with the critics');
      await service.removeKey((await service.keyStatus()).generation);
      check(!(await service.read([24])).has(24), 'MyAnimeList score survived key removal');
    }));

  await run('The library scans more than 200 MDBList titles, shares overlapping screen requests, and refreshes scores and misses only after seven days',
    () => fixture(async ({ service, state, env, reopen }) => {
      await service.refresh([9, 3]);
      check(!state.calls.length && !(await service.read([9])).size, 'The optional provider ran without a key');
      await service.saveKey('fixture-one');
      env.isVisible = false;
      await service.refresh([9, 3], true);
      env.isVisible = true; env.isOnline = false;
      await service.refresh([9]);
      check(!state.calls.length, 'A hidden job or offline screen made a call');
      env.isOnline = true;
      state.handler = id => id === 3 ? Response.json({ error: 'Show not found' }, { status: 404 }) : Response.json(sample(id));
      const ids = Array.from({ length: 202 }, (_, i) => i + 1);
      await service.refresh(ids, true);
      check(state.calls.length === 202 && state.calls.every((id, i) => id === ids[i]), 'A show was omitted or fetched twice');
      await Promise.all([service.refresh([203, 204]), service.refresh([203, 204])]);
      check(state.calls.length === 204, 'Overlapping callers duplicated a fresh lookup');
      env.time += 7 * day;
      await service.refresh([3, 4]);
      check(state.calls.length === 204, 'Seven-day entries were treated as stale early');
      ({ service } = await reopen());
      env.isOnline = false; env.time++;
      check((await service.read([3, 4])).get(4).metacritic === 71, 'The cached offline score was lost on reopen');
      check((await service.read([3])).get(3).metacritic === null, 'Missing show did not survive reopen');
      env.isOnline = true;
      await service.refresh([3, 4]);
      check(state.calls.length === 206 && state.calls.slice(-2).join(',') === '3,4', 'Stale score and negative hit did not refresh');
    }));

  await run('Individual MDBList lookups cache a 404 as a miss and pause only the active key after a refusal',
    () => fixture(async ({ service, state, store, env, reopen }) => {
      await service.saveKey('fixture-A');
      state.handler = id => id === 2 ? Response.json({ error: 'Media not found' }, { status: 404 }) : Response.json(sample(id, 60));
      await service.refresh([1, 2, 3]);
      check(state.calls.join(',') === '1,2,3', 'Did not fetch all three shows');
      await service.refresh([2, 3, 4]);
      check(state.calls.length === 4 && state.calls.at(-1) === 4, 'An individual miss was not cached');
      const first = await service.keyStatus();
      state.handler = () => Response.json({ error: 'Invalid API key' }, { status: 401 });
      await service.refresh([5, 6]);
      let status = await service.keyStatus();
      check(status.status === 'refused' && status.message === 'Invalid API key' && status.retryAt === start + day, 'Missing refusal state');
      ({ store, service } = await reopen());
      check((await service.read([1])).get(1).metacritic === 60, 'Refusal erased existing scores');
      await service.refresh([7]);
      check(state.calls.length === 5, 'Reopen lost an active pause');
      await service.saveKey('fixture-B');
      check((await service.keyStatus()).status === 'ready', 'Replacement key inherited a refusal');
      try { await service.removeKey(first.generation); throw Error('stale remove ran'); }
      catch (error) { check(error.message.includes('changed'), 'Stale removal deleted the replacement'); }
      await service.refresh([7]);
      env.time += day;
      check((await service.keyStatus()).status === 'ready', 'A one-day refusal did not expire');
    }));

  await run('The persistent MDBList quota holds concurrent requests, admits a single probe and backs off after a failed probe',
    () => fixture(async ({ service, state, env, reopen }) => {
      await service.saveKey('fictional-quota');
      state.handler = () => Response.json({ detail: 'Rate limit exceeded' }, { status: 429 });
      await Promise.all([service.refresh([9, 10]), service.refresh([11]), service.refresh([12], true)]);
      check(state.calls.length === 1 && (await service.keyStatus()).retryAt === start + 300_000, 'A quota did not close the provider queue');
      await service.saveKey('fictional-replacement');
      check((await service.keyStatus()).status === 'ready', 'Different key was blocked');
      await service.saveKey('fictional-quota');
      ({ service } = await reopen());
      check((await service.keyStatus()).retryAt === start + 300_000, 'Reusing a throttled key lost the deadline');
      env.time += 300_000;
      const started = deferred(), release = deferred();
      state.handler = async () => { started.resolve(); await release.promise; throw Error('fictional network failure'); };
      const one = service.refresh([13]), two = service.refresh([14]);
      await started.promise;
      check(state.calls.length === 2, 'Concurrent expiry probes');
      release.resolve(); await Promise.all([one, two]);
      const retryAt = (await service.keyStatus()).retryAt;
      check(state.calls.length === 2 && retryAt > env.time, 'Failed probe exhausted the remaining queue');
      env.time = retryAt;
      state.handler = id => Response.json(sample(id));
      await service.refresh([13]);
      check((await service.keyStatus()).status === 'ready' && (await service.read([13])).has(13), 'Successful probe did not restore scoring');
    }));

  await run('Key deletion and score deletion are atomic across sync, rollback, reopening, late replies and device erasure',
    () => fixture(async ({ name, service, store, state, reopen }) => {
      await service.saveKey('fictional-old');
      await service.refresh([2]);
      const initial = await service.keyStatus();
      const waiting = deferred(), release = deferred();
      state.handler = async id => { waiting.resolve(); await release.promise; return Response.json(sample(id)); };
      const loading = service.refresh([3]);
      await waiting.promise;
      // A duplicate in the same replacement aborts the key removal and the cache purge.
      const other = { setting: 'mal_source', value: 'github' };
      try { await store.commit((await store.snapshot()).revision, { replace: { settings: [other, other] } }); }
      catch (error) { check(error.name === 'ConstraintError', 'Unexpected transaction failure'); }
      check((await service.read([2])).has(2) && (await service.keyStatus()).generation === initial.generation,
        'An aborted settings update cleared scores or advanced the generation');
      await service.removeKey(initial.generation);
      await service.saveKey('fictional-old');
      release.resolve(); await loading;
      ({ store, service } = await reopen());
      check(!(await service.read([2, 3])).size && (await service.keyStatus()).generation > initial.generation,
        'Old scores survived key removal, A-B-A or reopen');
      const active = await service.keyStatus();
      await store.eraseDevice((await store.snapshot()).revision);
      await connectFixtureProviders(store,name);
      await service.saveKey('fictional-old');
      check(!await store.writeMdbList(active.generation, { pause: { kind: 'refused', message: 'stale', until: start + day } }),
        'An erased generation repopulated the device');
    }));

  await run('Hiding the background job during an admitted request retains its throttle or credential refusal',
    () => fixture(async ({ service, state, env }) => {
      for (const [status, kind, message] of [[429, 'throttled', 'Daily API limit exceeded!'], [401, 'refused', 'Invalid API key']]) {
        env.isVisible = true;
        await service.saveKey('fictional-status-' + status);
        const sent = deferred(), release = deferred();
        state.handler = async () => { sent.resolve(); await release.promise; return Response.json({ error: message }, { status }); };
        const job = service.refresh([1, 2], true);
        await sent.promise;
        env.isVisible = false;
        release.resolve();
        await job;
        check((await service.keyStatus()).status === kind, 'A late ' + status + ' was ignored after hiding');
        env.isVisible = true;
        const calls = state.calls.length;
        await service.refresh([1, 2]);
        check(state.calls.length === calls, 'Returning to the screen bypassed a provider pause');
      }
    }));
}
