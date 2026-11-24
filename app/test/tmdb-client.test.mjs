import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { TmdbClient, TmdbError, tmdbResourceKey } from '../src/tmdb-client.ts';
import { TmdbService } from '../src/tmdb-service.ts';
import { StaleSnapshotError } from '../src/storage.ts';

const active = { current: () => true };

test('abandoning Search while reading a show header prevents its season reads',async () => {
  const controller = new AbortController(), gate = Promise.withResolvers();
  const service = new TmdbService({async tmdbEntry(key,now,signal) {
    assert.equal(signal,controller.signal);
    await gate.promise;
    return {fetchedAt:3,value:{show_id:10,seasons:[{season:2}]}};
  },tmdbEntries:assert.fail});
  const pending = service.showInfo(10,undefined,controller.signal);
  controller.abort(); gate.resolve();
  await assert.rejects(pending,{name:'AbortError'});
});

test('Retiring a writer while hashing a TMDB key prevents the first cooldown read',async t=>{
  const hashed=latch(), release=latch(), digest=crypto.subtle.digest.bind(crypto.subtle);
  t.mock.method(crypto.subtle,'digest',async(...args)=>{
    const bytes=await digest(...args);
    hashed.resolve(); await release.promise; return bytes;
  });
  let writer=true;
  const client=new TmdbClient({fetch:assert.fail});
  const request=client.request({kind:'configuration'},'fictional-token',{
    current:()=>writer,readCooldown:assert.fail,writeCooldown:assert.fail
  });
  await hashed.promise; writer=false; release.resolve();
  await assert.rejects(request,{kind:'superseded'});
});

test('Removing the displayed TMDB key waits for a newly opened hold and survives an unrelated edit', async () => {
  const attempted = latch();
  let release, revision = 1n, generation = 1n, removed = 0, attempts = 0;
  const store = {role:'writer',recordRevision:async()=>revision,currentTmdbGeneration:async expected=>expected===generation,
    async commit(expected, changes, options) {
      attempts++;
      if (attempts === 1) {
        release = service.holdRecordChanges();
        attempted.resolve();
      } else if (attempts === 2) revision++;
      if (expected !== revision || (options?.current && !options.current())) throw new StaleSnapshotError();
      assert.deepEqual(changes.remove.settings, ['tmdb_key']);
      removed++;
    }};
  const service = new TmdbService(store);
  const work = service.removeKey(1n);
  await attempted.promise;
  assert.equal(removed, 0);
  release();
  await work;
  assert.equal(removed, 1);
  assert.equal(attempts, 3);
  generation++;
  await assert.rejects(service.removeKey(1n), {kind:'superseded'});
  assert.equal(removed, 1);
});

test('Canceling a TMDB key check or closing the writer during its final credential read stops dispatch', async () => {
  for (const mode of ['candidate', 'active']) {
    const started = latch(), release = latch();
    const state = {token, generation:1n, refused:null, cooldown:null};
    let armed = false, disposed = false, admission, sent = 0;
    const read = async value => {
      assert.equal(disposed, false, 'A retired request opened its closed database');
      if (armed) { started.resolve(); await release.promise; }
      return value;
    };
    const store = {role:'writer', tmdbState:() => read(state), beginTmdbSubmission:async()=>1n,
      isTmdbSubmissionCurrent:() => read(true)};
    const client = {async request(_resource, _token, hooks) {
      armed = true;
      admission = hooks.current;
      if (!await hooks.current()) throw new TmdbError('superseded');
      sent++;
      throw new TmdbError('unreachable');
    }};
    const service = new TmdbService(store, client, {online:()=>true,visible:()=>true,now:Date.now});
    const work = mode === 'candidate' ? service.saveKey(token) : service.imdbIdentity(5,false,()=>true);
    await started.promise;
    if (mode === 'candidate') service.cancelKeyCheck();
    else service.close();
    release.resolve();
    await assert.rejects(work, failsAs('superseded'));
    assert.equal(sent,0,mode+' sent after its owner ended');
    disposed = true;
    assert.equal(await admission(),false,mode+' rechecked a dead store on a late retry');
  }
});
const config = { kind: 'configuration' };
const token = 'fictional.tmdb-token';
const ok = value => Response.json(value ?? { ok: true });
const status = (code, headers) => new Response(null, { status: code, headers });
const failsAs = kind => error => error instanceof TmdbError && error.kind === kind;
function clock(fetch) {
  let now = Date.UTC(2026, 0, 1);
  const starts = [];
  const client = new TmdbClient({
    fetch: (url, options) => { starts.push(now); return fetch(url, options); },
    now: () => now, sleep: async ms => { now += ms; },
  });
  return { client, starts, now: () => now, tick: ms => { now += ms; } };
}
function latch() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
function journal() {
  let data = null;
  const writes = [];
  return { writes, context: { ...active, readCooldown: async () => data,
    writeCooldown: async state => { writes.push(state); data = state; } } };
}

test('Changing the device clock does not stall or accelerate the shared TMDB dispatch allowance', async () => {
  let wall = Date.UTC(2026,10,18), elapsed = 0;
  const starts = [];
  const client = new TmdbClient({now:()=>wall, paceNow:()=>elapsed, sleep:async ms=>{elapsed+=ms; wall+=ms;},
    fetch:async()=>{starts.push(elapsed);return ok();}});
  await client.request(config, token, active);
  wall -= 3_600_000;
  elapsed += 10;
  await client.request(config, token, active);
  wall += 7_200_000;
  await client.request(config, token, active);
  assert.deepEqual(starts,[0,50,100]);
});

test('a waiting interactive lookup passes queued background work without starving it or exceeding the shared pace', async () => {
  let elapsed = 0, blocked = true;
  const asleep = latch(), resume = latch(), sent = [];
  const client = new TmdbClient({paceNow:()=>elapsed,sleep:async ms => {
    if (blocked) { asleep.resolve(); await resume.promise; }
    elapsed += ms;
  },fetch:async url => {
    sent.push({id:Number(url.pathname.split('/').at(-1)),elapsed});
    return ok();
  }});
  const show = id => ({kind:'show',id});
  await client.request(show(1),token,active);
  const paused = client.request(show(2),token,{...active,background:()=>true});
  await asleep.promise;
  const slots = [];
  for (const id of [3,4,5,6,7,8,9,10,11,12,13,14,15]) {
    const waiting = latch();
    const slot = {background:id<9, current:true};
    let checks = 0;
    const work = client.request(show(id),token,{
      current() { if (++checks === 2) waiting.resolve(); return slot.current; },
      background:()=>slot.background,
    });
    slots.push({slot,work});
    await waiting.promise;
  }
  slots[2].slot.background = false; // A screen requested a job's already-queued resource.
  slots.at(-1).slot.current = false;
  const completed = Promise.allSettled(slots.map(item => item.work));
  blocked = false; resume.resolve(); await paused;
  const outcomes = await completed;
  assert.equal(outcomes.at(-1).reason.kind,'superseded');
  assert.ok(outcomes.slice(0,-1).every(row => row.status==='fulfilled'));
  assert.deepEqual(sent.map(row=>row.id),[1,2,5,9,10,3,11,12,13,4,14,6,7,8]);
  assert.deepEqual(sent.map(row=>row.elapsed),sent.map((_,i)=>i*50));
});

test('a screen joining queued detail work promotes the same validated transport request', async () => {
  for (const join of ['screen','import']) {
    const waiting = latch(), release = latch();
    const state = {generation:2n, token, refused:null, cooldown:null};
    const store = {role:'writer',providerCacheGeneration:0,tmdbState:async()=>state,writeTmdb:async()=>true};
    let hooks, requests = 0;
    const client = {async request(_resource,_token,context) {
      requests++; hooks=context; waiting.resolve(); await release.promise; return {id:27,cast:[]};
    }};
    const service = new TmdbService(store,client,{now:Date.now,online:()=>true,visible:()=>true});
    const cast = {kind:'cast',id:27};
    const detail = service.refresh(cast,true);
    await waiting.promise; assert.equal(hooks.background(),true);
    const foreground = join==='screen' ? service.refresh(cast) : service.fetchForImport(cast,state.generation,()=>true);
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(hooks.background(),false);
    assert.equal(await hooks.current(),true);
    release.resolve();
    const [a,b] = await Promise.all([detail,foreground]);
    assert.deepEqual(a.value,b.value);
    assert.equal(requests,1);
  }
});

test('retired search pages skip queued retries while a live copy of the same query shares one lookup', async () => {
  for (const leave of [false,true]) {
    let now=1000, sleepers=0, oldVisit=true, currentVisit=true;
    const sent=[], firstSleep=latch(), waiting=latch(), release=latch();
    const state={generation:1n,token,refused:null,cooldown:null};
    const store={role:'writer',providerCacheGeneration:0,tmdbState:async()=>state,
      writeTmdb:async (_generation,patch)=>{Object.assign(state,patch);return true;}};
    const client=new TmdbClient({now:()=>now,sleep:async ms=>{
      if (ms>=1000) {
        sleepers++;
        if (sleepers===1) firstSleep.resolve();
        if (sleepers===2) waiting.resolve();
        await release.promise;
      } else now+=ms;
    },fetch:async url=>{
      const q=url.searchParams.get('query');
      sent.push(q);
      if (sent.length===1) return status(429,{'Retry-After':'4'});
      return ok({page:2,total_pages:2,results:[{id:77,name:q}]});
    }});
    const service=new TmdbService(store,client,{now:()=>now,online:()=>true,visible:()=>true});
    const original=service.search('Original query',1,()=>oldVisit);
    const obsolete=assert.rejects(original,failsAs('superseded'));
    await firstSleep.promise;
    const duplicate=service.search('Same query',2,()=>oldVisit);
    const redundant=assert.rejects(duplicate,failsAs('superseded'));
    await waiting.promise;
    const fresh=service.search('Same query',2,()=>currentVisit);
    // Let the fresh page attach its own consumer to the in-flight identical request.
    await new Promise(resolve=>setImmediate(resolve));
    oldVisit=false; currentVisit=!leave;
    const losing=leave?assert.rejects(fresh,failsAs('superseded')):undefined;
    assert.deepEqual(state.cooldown,{until:5000,strikes:1});
    now=5000;release.resolve();
    await Promise.all([obsolete,redundant,losing]);
    if (leave) {
      assert.deepEqual(sent,['Original query']);
      assert.deepEqual(state.cooldown,{until:5000,strikes:1});
    } else {
      assert.equal((await fresh).value.results[0].show,'Same query');
      assert.deepEqual(sent,['Original query','Same query']);
      assert.equal(state.cooldown,null);
    }
  }
});

test('a canceled cooldown probe updates the next TMDB session according to its actual reply', async () => {
  for (const outcome of ['ok','disconnected','server failure']) {
    let wanted = true, now = 30_000, calls = 0;
    const store = journal();
    await store.context.writeCooldown({until:now,strikes:2});
    const probe = new TmdbClient({now:()=>now,fetch:async () => {
      calls++; wanted = false;
      if (outcome === 'disconnected') throw new TypeError();
      return outcome === 'ok' ? ok() : status(503);
    }});
    await assert.rejects(probe.request(config,token,{...store.context,current:()=>wanted,credentialCurrent:()=>true}),
      failsAs('superseded'));
    const saved = await store.context.readCooldown();
    assert.deepEqual(saved,outcome === 'ok' ? null : {until:32_000,strikes:2});
    const reopened = new TmdbClient({now:()=>now,sleep:async ms=>{now+=ms;},fetch:async()=>{calls++;return ok();}});
    await reopened.request(config,token,store.context);
    assert.equal(now,outcome === 'ok' ? 30_000 : 32_000);
    assert.equal(calls,2);
  }
});

test('Search carries an actual provider deadline through writer handoff and keeps ordinary failures distinct', async () => {
  for (const code of [429,503]) {
    let now=Date.UTC(2026,0,12,17,15,25),calls=0;
    const state={generation:4n,token,refused:null,cooldown:null};
    const store={role:'writer',providerCacheGeneration:0,tmdbState:async()=>state,
      writeTmdb:async (_id,patch)=>{Object.assign(state,patch);return true;}};
    const open=()=>new TmdbService(store,new TmdbClient({now:()=>now,fetch:async()=>{
      calls++;
      return calls===1 ? status(code,{'Retry-After':'25'}) : status(404);
    }}),{now:()=>now,online:()=>true,visible:()=>true});
    const search=service=>service.search('Fictional title',1,()=>true);
    const original=open(),deadline=now+25_000;
    assert.equal((await search(original)).retryAt,deadline);
    original.close();
    store.role='reader';
    const next=open();
    assert.equal((await search(next)).status,'read-only');
    store.role='writer';now+=10_000;
    assert.equal((await search(next)).retryAt,deadline);
    assert.equal(calls,1);
    now=deadline;
    const missing=await search(next);
    assert.equal(missing.status,'unavailable');assert.equal(missing.retryAt,undefined);
    assert.equal(calls,2);
  }
});

test('canceling an import preserves its credential’s late refusal or cooldown across service restarts', async () => {
  for (const httpStatus of [401, 429]) for (const replaced of [false, true]) {
    const reached = latch(), response = latch(), now = Date.UTC(2026, 1, 1);
    let interested = true, calls = 0;
    const state = {generation:1n, token, cooldown:null, refused:null};
    const store = {role:'writer', tmdbState:async () => ({...state}), writeTmdb:async (generation, patch) => {
      assert.equal(generation, state.generation);
      Object.assign(state, patch);
      return true;
    }};
    const open = () => new TmdbService(store, new TmdbClient({now:() => now, fetch:async () => {
      calls++;
      reached.resolve();
      return await response.promise;
    }}), {now:() => now, online:() => true, visible:() => true});
    const importing = open().fetchForImport(config, 1n, () => interested);
    await reached.promise;
    interested = false;
    if (replaced) state.generation++;
    response.resolve(status(httpStatus, {'Retry-After':'120'}));
    await assert.rejects(importing, failsAs('superseded'));
    if (replaced) {
      assert.equal(state.refused, null);
      assert.equal(state.cooldown, null);
    } else {
      await assert.rejects(open().fetchForImport(config, 1n, () => true), failsAs(httpStatus === 401 ? 'refused' : 'throttled'));
      if (httpStatus === 429) assert.deepEqual(state.cooldown, {until:now + 120_000, strikes:1});
    }
    assert.equal(calls, 1);
  }
});

test('all supported endpoints use fixed HTTPS origin, encoded parameters, English, and header-only credentials', async () => {
  const seen = [];
  const { client } = clock((url, opts) => { seen.push({ url, opts }); return ok({ result: 1 }); });
  const cases = [
    [config, 'configuration'], [{ kind: 'countries' }, 'configuration/countries'],
    [{ kind: 'search', query: 'A & B/#?', page: 2 }, 'search/tv'],
    [{ kind: 'show', id: 42 }, 'tv/42'], [{ kind: 'season', id: 42, season: 0 }, 'tv/42/season/0'],
    [{ kind: 'cast', id: 42 }, 'tv/42/aggregate_credits'], [{ kind: 'external-ids', id: 42 }, 'tv/42/external_ids'],
    [{ kind: 'person', id: 3 }, 'person/3/tv_credits'],
    [{ kind: 'recommendations', id: 42 }, 'tv/42/recommendations'],
    [{ kind: 'find', externalId: 'tt001', source: 'imdb_id' }, 'find/tt001'],
    [{ kind: 'find', externalId: '1234', source: 'tvdb_id' }, 'find/1234'],
  ];
  for (const [input, path] of cases) {
    assert.deepEqual(await client.request(input, token, active), { result: 1 });
    const { url, opts } = seen.at(-1);
    assert.equal(url.origin, 'https://api.themoviedb.org');
    assert.equal(url.pathname, '/3/' + path);
    assert.equal(url.searchParams.get('language'), 'en-US');
    assert.equal(url.toString().includes(token), false);
    assert.equal(opts.headers.Authorization, 'Bearer ' + token);
    assert.deepEqual([opts.redirect, opts.credentials, opts.cache], ['error', 'omit', 'no-store']);
  }
  assert.equal(seen[2].url.searchParams.get('query'), 'A & B/#?');
  assert.equal(seen[2].url.searchParams.get('page'), '2');
  assert.equal(seen[3].url.searchParams.get('append_to_response'), 'keywords,external_ids,episode_groups');
  assert.equal(seen.at(-1).url.searchParams.get('external_source'), 'tvdb_id');
  assert.equal(tmdbResourceKey({ kind: 'search', query: 'x' }), tmdbResourceKey({ kind: 'search', query: 'x', page: 1 }));
  for (const input of [{ kind: 'countries/../secret' }, { kind: 'show', id: -1 },
    { kind: 'find', source: 'imdb_id', externalId: '../configuration' },
    { kind: 'search', page: 501, query: 'test' }]) {
    await assert.rejects(client.request(input, token, active), failsAs('bad-request'));
  }
  assert.equal(seen.length, cases.length);
});

test('the 20-per-second limit includes parallel screen and job calls and different credentials', async () => {
  const { client, starts } = clock(() => ok());
  await Promise.all(Array.from({ length: 42 }, (_, i) => client.request(
    { kind: 'show', id: i + 1 }, i % 2 ? token : 'fictional-other', active)));
  for (let i = 20; i < starts.length; i++) assert.ok(starts[i] - starts[i - 20] >= 1000);
});

test('five transient server errors retry at 1, 2, 4, 8 seconds and a later request can succeed', async () => {
  const maintenance = clock(() => status(503,{'Retry-After':'90','X-RateLimit-Reset':'9999999999'}));
  const {context,writes} = journal(), until = maintenance.now() + 90_000;
  await assert.rejects(maintenance.client.request(config,token,context),{kind:'throttled',retryAt:until});
  assert.equal(maintenance.starts.length,1);
  assert.equal(writes.at(-1).until,until);
  let fail = true;
  const { client, starts } = clock(() => fail ? status(503) : ok());
  await assert.rejects(client.request(config, token, active), failsAs('unreachable'));
  assert.deepEqual(starts.map(v => v - starts[0]), [0, 1000, 3000, 7000, 15000]);
  fail = false;
  assert.deepEqual(await client.request(config, token, active), { ok: true });
});

test('short throttles share exponential backoff and the fifth closes the gate for at least 15 minutes', async () => {
  const { client, starts, now } = clock(() => status(429, { 'Retry-After': '-1' }));
  const { writes, context } = journal();
  await assert.rejects(client.request(config, token, context), failsAs('throttled'));
  assert.deepEqual(starts.map(v => v - starts[0]), [0, 1000, 3000, 7000, 15000]);
  assert.equal(writes.at(-1).until, now() + 15 * 60_000);
  assert.deepEqual(writes.map(v => v.strikes), [1, 2, 3, 4, 5]);
});

test('a throttle with an elapsed provider deadline backs off before sending the next request', async () => {
  let attempts = 0;
  const { client, starts } = clock(() => ++attempts === 1 ?
    status(429, {'Retry-After': new Date(Date.UTC(2025, 11, 31)).toUTCString()}) : ok());
  await client.request(config, token, active);
  assert.deepEqual(starts.map(time => time - starts[0]), [0, 1000]);
});

test('a persisted provider deadline blocks a whole queue; exactly one probe admits the queue after restart', async () => {
  const { context, writes } = journal();
  const start = Date.UTC(2026, 0, 1);
  const until = start + 90_000;
  const first = clock(() => status(429, { 'Retry-After': new Date(start + 60_000).toUTCString(),
    'X-RateLimit-Reset': String(until / 1000) }));
  await assert.rejects(first.client.request(config, token, context), e => e.kind === 'throttled' && e.retryAt === until);
  assert.deepEqual(writes, [{ until, strikes: 1 }]);
  const sentProbe = latch(), permit = latch();
  let calls = 0;
  const next = clock(async () => {
    if (++calls === 1) { sentProbe.resolve(); await permit.promise; }
    return ok();
  });
  const batch = () => Array.from({ length: 10 }, (_, id) => next.client.request({ kind: 'show', id }, token, context));
  const paused = await Promise.allSettled(batch());
  assert.ok(paused.every(r => r.reason?.retryAt === until));
  assert.equal(calls, 0);
  next.tick(90_000);
  const waiting = Promise.all(batch());
  await sentProbe.promise;
  await delay(1);
  assert.equal(calls, 1);
  await next.client.request(config, 'fictional-other', active);
  assert.equal(calls, 2);
  permit.resolve();
  await waiting;
  assert.equal(calls, 11);
  assert.equal(writes.at(-1), null);
});

test('an unanswered probe preserves cooldown; another in-flight throttle can extend a deadline', async () => {
  const began = latch(), late = latch();
  let calls = 0;
  const { context, writes } = journal();
  const { client, now, tick } = clock(async () => {
    const n = ++calls;
    if (n === 1) { began.resolve(); await late.promise; return status(429, { 'Retry-After': '600' }); }
    if (n === 2) return status(429, { 'Retry-After': '30' });
    throw Error('network unavailable');
  });
  const slow = client.request(config, token, context);
  await began.promise;
  await assert.rejects(client.request({ kind: 'countries' }, token, context), e => e.retryAt === now() + 30_000);
  late.resolve();
  await assert.rejects(slow, e => e.retryAt === now() + 600_000);
  assert.equal(writes.at(-1).strikes, 1);
  tick(600_000);
  await assert.rejects(client.request(config, token, context), failsAs('unreachable'));
  assert.ok(writes.at(-1).until > now());
});

test('key refusal, missing titles, bad JSON and network failures are distinct and never repeat provider secrets', async () => {
  const queue = [
    Response.json({ status_code: 7, status_message: token }, { status: 401 }), status(404),
    new Response('invalid JSON with ' + token), new TypeError(token),
  ];
  const { client } = clock(() => { const item = queue.shift(); if (item instanceof Error) throw item; return item; });
  for (const kind of ['refused', 'not-found', 'invalid-response', 'unreachable']) {
    await assert.rejects(client.request(config, token, active), e => {
      assert.equal(e.kind, kind);
      assert.ok(!String(e).includes(token));
      if (kind === 'refused') assert.match(e.message, /Invalid API key/);
      return true;
    });
  }
});

test('an obsolete token response or retry cannot update cooldown, report refusal, or send again', async () => {
  for (const statusCode of [200, 401, 429, 503]) {
    const sent = latch(), release = latch();
    let generation = 1;
    const { context, writes } = journal();
    const { client, starts } = clock(async () => {
      sent.resolve(); await release.promise;
      return statusCode === 200 ? ok() : status(statusCode);
    });
    const pending = client.request(config, token, { ...context, generation: 1n, current: () => generation === 1 });
    await sent.promise;
    generation = 3;
    release.resolve();
    await assert.rejects(pending, failsAs('superseded'));
    assert.equal(starts.length, 1);
    assert.deepEqual(writes, []);
  }
});

test('the inactivity deadline tracks response headers and body chunks, and stops stalled requests', async () => {
  let controller;
  const stream = new ReadableStream({ start(c) { controller = c; } });
  const chunks = ['{"part"', ':', '"', 'done"}'];
  const chunked = new TmdbClient({ inactivityMs: 100, fetch: async () => {
    (async () => {
      for (const chunk of chunks) { await delay(35); controller.enqueue(new TextEncoder().encode(chunk)); }
      controller.close();
    })();
    return new Response(stream);
  } });
  assert.deepEqual(await chunked.request(config, token, active), { part: 'done' });
  let signal;
  for (const send of [() => new Promise(() => {}), () => new Response(new ReadableStream())]) {
    const stalled = new TmdbClient({ inactivityMs: 15, fetch: async (_, opts) => { signal = opts.signal; return send(); } });
    await assert.rejects(stalled.request(config, token, active), failsAs('unreachable'));
    assert.equal(signal.aborted, true);
  }
});
