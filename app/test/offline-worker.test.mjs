import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { createOfflineBuild } from '../offline-build.mjs';
import { permissionsPolicy, securityPolicy } from '../hosting-policy.mjs';

const template = await readFile(new URL('../service-worker.js', import.meta.url), 'utf8');
const scope = 'https://example.test/tracker/';
const index = '<meta name="csvtv-build" content=""><script type="module" src="./main.js"></script>';
const shell = version => new Map([['index.html',index],['main.js','export const version = '+version],['style.css','body {}']]);
const mime = {html:'text/html',js:'application/javascript',css:'text/css'};

function storage() {
  const entries = new Map();
  let maintenance = Promise.resolve();
  return {
    entries, failWrite:undefined, full:false,
    lock(task) {
      const job = maintenance.then(task);
      maintenance = job.catch(() => {});
      return job;
    },
    async open(name) {
      if (!entries.has(name)) entries.set(name,new Map());
      const rows = entries.get(name);
      return {
        put: async (url,response) => {
          if (this.full) throw new DOMException('Device storage full','QuotaExceededError');
          if (url === this.failWrite) throw Error('Device storage full');
          rows.set(url,response);
        },
        keys: async () => [...rows.keys()].map(url => ({url})),
      };
    },
    async match(url,{cacheName}) { return entries.get(cacheName)?.get(url)?.clone(); },
    async has(name) { return entries.has(name); },
    async delete(name) { return entries.delete(name); },
    async keys() { return [...entries.keys()]; },
  };
}

// Dispatch to the generated production worker. Cache Storage and client IDs
// are local fakes here; the cold-start and two-build tests use the browser APIs.
function worker(files, caches = storage(), retired = [], bindings = new Map(), options = {}, idb) {
  const build = createOfflineBuild(files,template,retired,options);
  const bodies = new Map(files);
  bodies.set('index.html',build.html);
  const events = new Map(), calls = [];
  const state = {
    registrations:{scope,active:{state:'activated'}}, clients:[], claims:0, skipped:0, now:Date.now(),
    setTimeout, clearTimeout, timeoutSignal:ms => AbortSignal.timeout(ms),
    network(url) {
      const name = url === scope ? 'index.html' : url.slice(scope.length);
      return new Response(bodies.get(name),{headers:{'Content-Type':mime[name.split('.').pop()]}});
    },
  };
  const marker = 'const SHELL = ';
  assert.ok(build.worker.startsWith(marker));
  const context = vm.createContext({
    self:{
      registration:state.registrations,
      navigator:{locks:{request:(_key,task) => caches.lock(task)}},
      clients:{matchAll:async () => state.clients, get:async id => state.clients.find(c => c.id === id),
        claim:async () => { state.claims++; }},
      skipWaiting:async () => { state.skipped++; },
      addEventListener:(type,listener) => events.set(type,listener),
    },
    URL, Headers, Response, crypto, caches, indexedDB:idb, MessageChannel, AbortController,
    AbortSignal:{timeout:ms => state.timeoutSignal(ms),any:signals => AbortSignal.any(signals)},
    setTimeout:(...args) => state.setTimeout(...args), clearTimeout:id => state.clearTimeout(id),
    Date:class extends Date { static now() { return state.now; } },
    fetch:async (url,init) => {
      calls.push({url,init});
      return state.network(url,init);
    },
    pageStore:{
      get:id => ({result:bindings.get(id), set onsuccess(listener) { listener(); }}),
      getAll:() => ({result:[...bindings.values()]}),
      put:(value,id) => ({result:bindings.set(id,value)}),
      delete:id => ({result:bindings.delete(id)}),
    },
  });
  vm.runInContext(build.worker,context);
  if (!idb) vm.runInContext('binding = async (_store, _mode, operation) => operation(pageStore).result',context);
  function dispatch(type,data = {},responseOnly = false) {
    let response;
    const work = [];
    events.get(type)({waitUntil:p => work.push(p),respondWith:p => { response = p; },...data});
    if (responseOnly) return response;
    if (response || work.length) return Promise.all([response,...work]).then(([result]) => result);
  }
  function request(url,options = {},responseOnly = false) {
    const {clientId = '',resultingClientId = '',...req} = options;
    return dispatch('fetch',{clientId,resultingClientId, request:{
      url,method:'GET',mode:'cors',headers:new Headers(),destination:'',...req,
    }},responseOnly);
  }
  return {build,bindings,caches,calls,state,dispatch,request,cacheName:'csvTV:shell:'+scope+':'+build.build};
}

test('a build identifies its complete contents and worker policy and accepts byte-array HTML', () => {
  const files = shell(1);
  files.set('index.html',new TextEncoder().encode(index));
  const first = createOfflineBuild(files,template);
  assert.match(first.html,new RegExp(first.build));
  assert.equal(createOfflineBuild(new Map([...files].reverse()),template).build,first.build);
  assert.notEqual(createOfflineBuild(shell(2),template).build,first.build);
  assert.notEqual(createOfflineBuild(files,template+'\n// revised policy').build,first.build);
  for (const unsafe of ['../other.js','private.csv','backup.html','service-worker.js']) {
    assert.throws(() => createOfflineBuild(new Map([...files,[unsafe,'bad']]),template));
  }
});

test('a dedicated worker keeps the originating tab’s installed modules across releases and collection',async () => {
  const caches=storage(),pins=new Map(),old=worker(shell(1),caches,[],pins),current=worker(shell(2),caches,[],pins);
  await old.dispatch('install'); await old.dispatch('activate');
  await old.request(scope,{mode:'navigate',resultingClientId:'original'});
  await current.dispatch('install'); await current.dispatch('activate');
  const options={destination:'worker',clientId:'original',resultingClientId:'rating-job'};
  assert.equal(await (await current.request(scope+'main.js',options)).text(),shell(1).get('main.js'));
  assert.equal(pins.get('rating-job').build,old.build.build);
  current.state.clients=[{type:'worker',url:scope+'main.js',id:'rating-job'}];
  current.state.now+=61000;
  assert.equal(await (await current.request(scope+'main.js',{clientId:'rating-job'})).text(),shell(1).get('main.js'));
  assert.equal(pins.has('original'),false);
  assert.ok(pins.has('rating-job') && await caches.has(old.cacheName));
  const restarted=worker(shell(2),caches,[],pins);
  assert.equal(await (await restarted.request(scope+'main.js',{clientId:'rating-job'})).text(),shell(1).get('main.js'));
  restarted.state.now=current.state.now+61000;
  await restarted.request(scope,{mode:'navigate',resultingClientId:'fresh'});
  assert.equal(pins.has('rating-job'),false);
  assert.equal(await caches.has(old.cacheName),false);
});

function servePublicFiles(app, intercept) {
  const network=app.state.network;
  app.state.network=async (url,init) => {
    const original=await network(url,init), headers=new Headers(original.headers);
    headers.set('Content-Security-Policy',securityPolicy);
    headers.set('Referrer-Policy','no-referrer');
    headers.set('X-Content-Type-Options','nosniff');
    const override=await intercept?.(url,init,headers);
    return override ?? new Response(init.method==='HEAD' ? null : original.body,{headers});
  };
}

test('eviction during the new cache writes does not install an incomplete successor',async () => {
  const caches = storage(), active = worker(shell(1),caches), next = worker(shell(2),caches);
  await active.dispatch('install');
  const open = caches.open.bind(caches);
  let removed = false;
  caches.open = async name => {
    const cache = await open(name);
    if (name !== next.cacheName) return cache;
    const put = cache.put.bind(cache);
    cache.put = async (url,response) => {
      if (!removed) { removed = true; await caches.delete(name); }
      await put(url,response);
    };
    return cache;
  };
  await assert.rejects(next.dispatch('install'),/removed during installation/);
  assert.equal(removed,true);
  assert.deepEqual(await caches.keys(),[active.cacheName]);
  assert.equal(await (await active.request(scope+'main.js')).text(),shell(1).get('main.js'));
  caches.open = open;
  await next.dispatch('install');
  assert.equal(caches.entries.get(next.cacheName).size,shell(2).size);
});

for (const operation of ['install','repair']) test('a slow '+operation+' admits eight files at a time and starts each file deadline on admission',async () => {
  const files=shell(1);
  for (let i=0;i<31;i++) files.set('tile-'+i+'.js','export const tile = '+i);
  const app=worker(files),normal=app.state.network,active=new Set(),timers=new Map();
  if (operation==='repair') { await app.dispatch('install'); await app.caches.delete(app.cacheName); }
  let time=0,maximum=0,admitted=0,completed=false;
  app.state.setTimeout=(fn,ms)=>{const id={};timers.set(id,{fn,at:time+ms});return id;};
  app.state.clearTimeout=id=>timers.delete(id);
  app.state.network=async(url,init)=>{
    const gate=Promise.withResolvers();active.add(gate);admitted++;maximum=Math.max(maximum,active.size);
    init.signal.addEventListener('abort',()=>gate.reject(Error('Request deadline')),{once:true});
    try {await gate.promise;return normal(url);} finally {active.delete(gate);}
  };
  const work=operation==='install' ? app.dispatch('install') :
    app.dispatch('message',{source:{type:'window',url:scope,id:'settings'},data:{type:'csvtv:repair'},
      ports:[{postMessage:reply=>assert.equal(reply.complete,true)}]});
  const done=work.then(()=>{completed=true;});
  for(let released=0;released<files.size;) {
    const expected=Math.min(files.size,released+8);
    const until=performance.now()+2500;
    while(admitted<expected && performance.now()<until) await new Promise(resolve=>setImmediate(resolve));
    assert.equal(admitted,expected);
    assert.equal(active.size,expected-released);
    time+=15_000;
    for(const {at,fn} of timers.values()) if(at<=time) fn();
    for(const gate of active) gate.resolve();
    released=expected;
  }
  await done;
  assert.ok(completed && time>50_000);
  assert.equal(maximum,8);
  assert.equal(app.caches.entries.get(app.cacheName).size,files.size);
});

test('a host declining HEAD switches later update files to GET without repeated unsupported probes',async () => {
  const files=shell(1);
  for (let i=0;i<45;i++) files.set('tile-'+i+'.js','export const tile = '+i);
  const old=worker(files);servePublicFiles(old);await old.dispatch('install');
  for(const status of [405,501]) {
    const next=worker(new Map([...files,['main.js','export const version = '+status]]),old.caches);
    servePublicFiles(next,async(_url,init)=> init.method==='HEAD'?new Response(null,{status}):undefined);
    await next.dispatch('install');
    const probes=next.calls.filter(call=>call.init.method==='HEAD');
    assert.ok(probes.length>0 && probes.length<=16);
    assert.equal(next.calls.filter(call=>call.init.method==='GET').length,files.size);
    assert.equal(next.caches.entries.get(next.cacheName).size,files.size);
    await next.caches.delete(next.cacheName);
  }
});

test('a public update reuses unchanged verified bytes and downloads changed, damaged or evicted files',async () => {
  for (const state of ['unchanged','damaged','evicted']) {
    const old=worker(shell(1)); servePublicFiles(old); await old.dispatch('install');
    const style=scope+'style.css', previous=old.caches.entries.get(old.cacheName);
    if (state==='damaged') previous.set(style,new Response('bad css',{headers:previous.get(style).headers}));
    if (state==='evicted') previous.delete(style);
    const next=worker(shell(2),old.caches); servePublicFiles(next);
    await next.dispatch('install');
    const methods=url=>next.calls.filter(call=>call.url===url).map(call=>call.init.method);
    assert.deepEqual(methods(scope),['GET'],'always fetch the new document');
    assert.deepEqual(methods(scope+'main.js'),['GET'],'new module bytes');
    assert.deepEqual(methods(style),[state==='unchanged'?'HEAD':'GET'],state);
    assert.equal(await (await next.caches.match(style,{cacheName:next.cacheName})).text(),shell(2).get('style.css'));
  }
});

test('a changed hosting policy, private response or unavailable HEAD requires a verified public GET',async () => {
  const old=worker(shell(1)); servePublicFiles(old); await old.dispatch('install');
  for (const outcome of ['changed policy','missing policy','private','cookie','unsupported','stalled','refused']) {
    const next=worker(shell(2),old.caches), style=scope+'style.css';
    const clock=new AbortController();
    next.state.timeoutSignal=ms=>ms===10_000?clock.signal:AbortSignal.timeout(ms);
    servePublicFiles(next,async (url,init,headers)=>{
      if (url!==style) return;
      if (outcome==='refused') return new Response(null,{status:403});
      if (outcome==='changed policy') headers.set('Cross-Origin-Resource-Policy','same-origin');
      if (init.method!=='HEAD') return;
      if (outcome==='missing policy') headers.delete('Content-Security-Policy');
      if (outcome==='private') headers.set('Cache-Control','private, no-store');
      if (outcome==='cookie') headers.set('Vary','Accept, Cookie');
      if (outcome==='unsupported') return new Response(null,{status:405});
      if (outcome==='stalled') {
        assert.equal(init.signal.aborted,false); clock.abort();
        init.signal.throwIfAborted();
      }
    });
    if (outcome==='refused') await assert.rejects(next.dispatch('install'),/verify shell asset/);
    else {
      await next.dispatch('install');
      const response=await next.caches.match(style,{cacheName:next.cacheName});
      if (outcome==='changed policy') assert.equal(response.headers.get('Cross-Origin-Resource-Policy'),'same-origin');
      await next.caches.delete(next.cacheName);
    }
    assert.deepEqual(next.calls.filter(x=>x.url===style).map(x=>x.init.method),['HEAD','GET'],outcome);
    assert.deepEqual(await old.caches.keys(),[old.cacheName]);
  }
});

test('canonical host redirects work via the directory URL, preserving verified bytes and security headers only', async () => {
  const app = worker(shell(1));
  const ordinary = app.state.network;
  app.state.network = url => {
    assert.notEqual(url,scope+'index.html','directory index must work without following its alternate redirect');
    if (url !== scope) return ordinary(url);
    return new Response(app.build.html,{headers:{'Content-Type':'text/html; charset=UTF-8','Vary':'Cookie',
      'X-Private-Marker':'fictional','X-Frame-Options':'DENY','Content-Security-Policy':"script-src 'self'"}});
  };
  await app.dispatch('install');
  assert.equal(app.calls.length,3);
  assert.ok(app.calls.every(({url,init}) => init.credentials === 'same-origin' && init.redirect === 'error' &&
    init.cache === (url === scope ? 'no-store' : 'no-cache')));
  app.state.network = () => { throw Error('Disconnected'); };
  const response = await app.request(scope,{mode:'navigate',resultingClientId:'a'});
  assert.equal(await response.text(),app.build.html);
  assert.equal(response.headers.get('Content-Security-Policy'),"script-src 'self', "+securityPolicy);
  assert.equal(response.headers.get('X-Frame-Options'),'DENY');
  assert.equal(response.headers.get('Referrer-Policy'),'no-referrer');
  assert.ok(!response.headers.has('Vary') && !response.headers.has('X-Private-Marker'));
  assert.equal(app.bindings.get('a').build,app.build.build);
  assert.equal(await (await app.request(scope+'main.js',{clientId:'a'})).text(),shell(1).get('main.js'));
  assert.equal(await (await app.request(scope+'#/library',{mode:'navigate'})).text(),app.build.html);
  assert.equal(await (await app.request(scope+'index.html#/settings',{mode:'navigate'})).text(),app.build.html);
});

test('cached documents keep the release CSP and oversized or truncated decoded assets cannot install', async () => {
  const app = worker(shell(1));
  await app.dispatch('install');
  assert.equal((await app.request(scope,{mode:'navigate'})).headers.get('Content-Security-Policy'),securityPolicy);

  const next = worker(shell(2),app.caches);
  const ordinary = next.state.network;
  let canceled = false;
  const script = new TextEncoder().encode(shell(2).get('main.js'));
  next.state.network = url => url.endsWith('/main.js') ? new Response(new ReadableStream({
    pull(controller) { controller.enqueue(script); },
    cancel() { canceled = true; },
  }),{headers:{'Content-Type':'text/javascript','Content-Length':'1'}}) : ordinary(url);
  await assert.rejects(next.dispatch('install'),/verify shell asset/);
  assert.ok(canceled,'stop reading as soon as decoded bytes exceed this asset’s exact size');
  next.state.network = url => url.endsWith('/main.js') ? new Response(script.subarray(1),
    {headers:{'Content-Type':'text/javascript'}}) : ordinary(url);
  await assert.rejects(next.dispatch('install'),/verify shell asset/);
  assert.ok(!app.caches.entries.has(next.cacheName));
  assert.equal(await (await app.request(scope+'main.js')).text(),shell(1).get('main.js'));
});

test('the private fixture installs verified HTML from one same-origin text file and leaves that URL network-only', async () => {
  const options = {documentSource:'offline-document.txt'};
  const app = worker(shell(1),storage(),[],new Map(),options);
  const release = worker(shell(1));
  assert.notEqual(release.build.build,app.build.build);
  assert.throws(() => createOfflineBuild(shell(1),template,[],{documentSource:'https://elsewhere.test/index.txt'}));
  const plainURL = scope+options.documentSource;
  function plainResponse(body, url = plainURL, type = 'text/plain; charset=utf-8') {
    const response = new Response(body,{headers:{'Content-Type':type,'Content-Security-Policy':"default-src 'none'",'X-Private':'fictional'}});
    Object.defineProperty(response,'url',{value:url});
    return response;
  }
  const normal = app.state.network;
  app.state.network = url => url === plainURL ? plainResponse(app.build.html) : normal(url);
  await app.dispatch('install');
  const sourceCalls = app.calls.filter(({url}) => url === plainURL);
  assert.equal(sourceCalls.length,1);
  assert.equal(sourceCalls[0].init.credentials,'same-origin');
  assert.equal(sourceCalls[0].init.redirect,'error');
  assert.ok(!app.calls.some(({url}) => url === scope || url === scope+'index.html'));
  assert.deepEqual([...app.caches.entries.get(app.cacheName).keys()].sort(),Object.keys(app.build.hashes).map(name=>scope+name).sort());
  const document = await app.request(scope+'#/library',{mode:'navigate'});
  assert.equal(document.headers.get('Content-Type'),'text/html; charset=utf-8');
  assert.equal(document.headers.get('Content-Security-Policy'),securityPolicy);
  assert.equal(document.headers.get('Permissions-Policy'),permissionsPolicy);
  assert.equal(document.headers.get('X-Content-Type-Options'),'nosniff');
  assert.equal(document.headers.has('X-Private'),false);
  assert.equal(await document.text(),app.build.html);
  assert.equal(app.request(plainURL),undefined);
  assert.equal(app.request(plainURL,{mode:'navigate'}),undefined);

  for (const [label,source] of [
    ['modified markup',w => plainResponse(w.build.html+'<script>hostDecoration()</script>')],
    ['wrong MIME',w => plainResponse(w.build.html,plainURL,'text/html')],
    ['wrong origin',w => plainResponse(w.build.html,'https://elsewhere.test/offline-document.txt')],
    ['wrong sibling',w => plainResponse(w.build.html,scope+'another.txt')],
    ['missing provenance',w => new Response(w.build.html,{headers:{'Content-Type':'text/plain'}})],
  ]) {
    const invalid = worker(shell(1),storage(),[],new Map(),options), ordinary = invalid.state.network;
    invalid.state.network = url => url === plainURL ? source(invalid) : ordinary(url);
    await assert.rejects(invalid.dispatch('install'),/verify shell asset index.html/,label);
    assert.deepEqual(await invalid.caches.keys(),[],label);
  }
  const ordinary = release.state.network;
  release.state.network = url => {
    if (url === scope || url === scope+'index.html') return new Response(release.build.html+'<script>hostDecoration()</script>',
      {headers:{'Content-Type':'text/html'}});
    if (url === plainURL) return plainResponse(release.build.html);
    return ordinary(url);
  };
  await assert.rejects(release.dispatch('install'),/verify shell asset index.html/);
  assert.ok(!release.calls.some(({url}) => url === plainURL),'A regular release probed the fixture-only file');
});

test('requests outside the exact GET shell allowlist receive no worker response', async () => {
  const app = worker(shell(1));
  const js = scope+'main.js';
  for (const [url,req] of [
    [scope+'?code=fiction&state=test#/settings',{mode:'navigate'}], [scope+'#access_token=fiction',{mode:'navigate'}],
    [js+'?',{}], [js+'?token=fiction',{}], [js,{mode:'navigate'}],
    [scope+'unlisted.js',{destination:'script',clientId:'a'}], [scope+'watched.csv',{}],
    ['https://api.themoviedb.org/3/tv/1',{}], ['https://content.dropboxapi.com/2/files/download',{}],
    [js,{method:'POST'}], [js,{headers:new Headers({Authorization:'Bearer fictional'})}], [js,{headers:new Headers({Range:'bytes=0-10'})}],
    ['https://example.test/other/main.js',{}], [scope+'service-worker.js',{}],
  ]) assert.equal(app.request(url,req),undefined,url);
  assert.equal(app.calls.length,0);
});

test('partial deployments, wrong MIME, changed bytes and storage failures preserve the active installation', async () => {
  const caches = storage(), installed = worker(shell(1),caches);
  await installed.dispatch('install');
  for (const [label,response] of [
    ['login response',() => new Response('<p>Sign in</p>',{headers:{'Content-Type':'text/html'}})],
    ['stale bytes',() => new Response(shell(1).get('main.js'),{headers:{'Content-Type':'text/javascript'}})],
    ['wrong MIME',() => new Response(shell(2).get('main.js'),{headers:{'Content-Type':'text/plain'}})],
    ['partial',() => new Response(shell(2).get('main.js'),{status:206,headers:{'Content-Type':'text/javascript'}})],
  ]) {
    const next = worker(shell(2),caches), normal = next.state.network;
    next.state.network = url => url.endsWith('/main.js') ? response() : normal(url);
    await assert.rejects(next.dispatch('install'),/verify shell asset/,label);
    assert.deepEqual(await caches.keys(),[installed.cacheName],label);
  }
  const next = worker(shell(2),caches);
  caches.failWrite = scope+'style.css';
  await assert.rejects(next.dispatch('install'),/complete app shell/);
  assert.deepEqual(await caches.keys(),[installed.cacheName]);
  assert.equal(await (await installed.request(scope+'main.js')).text(),shell(1).get('main.js'));
});

test('activation preserves pinned generations, reclaims abandoned caches and leaves other scopes alone', async () => {
  const caches = storage(), pins = new Map(), oldFiles = shell(1);
  oldFiles.set('retired.js','// formerly used by this tab');
  const old = worker(oldFiles,caches,[],pins), next = worker(shell(2),caches,['retired.js'],pins);
  await old.dispatch('install');
  await old.request(scope,{mode:'navigate',resultingClientId:'old-tab'});
  const orphan = 'csvTV:shell:'+scope+':'+'e'.repeat(64);
  const sibling = 'csvTV:shell:'+scope+'nested/:'+'f'.repeat(64);
  await caches.open(orphan);
  await caches.open(sibling);
  await caches.open('unrelated');
  await next.dispatch('install');
  await next.dispatch('activate');
  assert.equal(next.state.claims,1);
  assert.deepEqual((await caches.keys()).sort(),[old.cacheName,next.cacheName,sibling,'unrelated'].sort());
  // A new worker process uses the durable build binding and explicit historic filename.
  const restarted = worker(shell(2),caches,['retired.js'],pins);
  assert.equal(await (await restarted.request(scope+'main.js',{clientId:'old-tab'})).text(),oldFiles.get('main.js'));
  assert.equal(await (await restarted.request(scope+'retired.js',{clientId:'old-tab'})).text(),oldFiles.get('retired.js'));
  caches.entries.get(old.cacheName).delete(scope+'retired.js');
  assert.equal((await restarted.request(scope+'retired.js',{clientId:'old-tab'})).status,503);
  assert.equal(restarted.calls.length,0,'An old document consumed unverified bytes at a retired URL');
  await restarted.request(scope,{mode:'navigate',resultingClientId:'new-tab'});
  assert.equal(await (await restarted.request(scope+'main.js',{clientId:'new-tab'})).text(),shell(2).get('main.js'));
  pins.get('old-tab').at -= 61000;
  await restarted.dispatch('activate');
  assert.equal(await caches.has(old.cacheName),false);
});

test('ordinary use reclaims closed pages and retired versions while protecting waiting, installing and active builds', async () => {
  const caches = storage(), pins = new Map();
  const old = worker(shell(1),caches,[],pins), current = worker(shell(2),caches,[],pins);
  await old.dispatch('install');
  await old.dispatch('activate');
  await old.request(scope,{mode:'navigate',resultingClientId:'live-old-tab'});
  await old.request(scope,{mode:'navigate',resultingClientId:'closed-old-tab'});
  const oldTab = {type:'window',url:scope,id:'live-old-tab'};
  current.state.clients = [oldTab];
  await current.dispatch('install');
  await current.dispatch('activate');
  const candidate = worker(shell(3),caches,[],pins);
  await candidate.dispatch('install');
  current.state.now += 61000;
  current.state.registrations.waiting = {};
  await current.request(scope+'main.js',{clientId:oldTab.id});
  assert.equal(pins.has('closed-old-tab'),false);
  assert.ok(pins.has('live-old-tab') && await caches.has(old.cacheName) && await caches.has(candidate.cacheName));
  current.state.clients = [];
  current.state.now += 61000;
  current.state.registrations.installing = {};
  delete current.state.registrations.waiting;
  await current.request(scope,{mode:'navigate',resultingClientId:'new-tab'});
  assert.equal(pins.has('live-old-tab'),false);
  assert.ok(await caches.has(candidate.cacheName),'Installing generation was deleted');
  delete current.state.registrations.installing;
  current.state.now += 61000;
  // A late event from the replaced worker also runs after its local throttle expires.
  old.state.now = current.state.now;
  await old.request(scope+'style.css');
  assert.ok(await caches.has(current.cacheName) && await caches.has(candidate.cacheName),'Superseded worker deleted a newer generation');
  await current.request(scope,{mode:'navigate',resultingClientId:'subsequent-tab'});
  assert.deepEqual(await caches.keys(),[current.cacheName]);
  assert.deepEqual([...pins.keys()].filter(key => typeof key === 'string'),['subsequent-tab']);
});

test('cache repair rejects bytes from a later release and retries the exact version online', async () => {
  const app = worker(shell(1));
  await app.dispatch('install');
  app.caches.entries.get(app.cacheName).delete(scope+'main.js');
  const correct = app.state.network;
  app.state.network = () => new Response(shell(2).get('main.js'),{headers:{'Content-Type':'text/javascript'}});
  assert.equal((await app.request(scope+'main.js')).status,503);
  app.state.network = correct;
  assert.equal(await (await app.request(scope+'main.js')).text(),shell(1).get('main.js'));
  app.state.network = () => { throw Error('Disconnected'); };
  assert.equal(await (await app.request(scope+'main.js')).text(),shell(1).get('main.js'));
});

test('a full device reports storage failure during shell repair and preserves the working release', async () => {
  const current = worker(shell(1)), waiting = worker(shell(2),current.caches,[],current.bindings);
  await current.dispatch('install');
  await current.dispatch('activate');
  await waiting.dispatch('install');
  waiting.state.registrations.waiting = {};
  const page = {type:'window',id:'settings',url:scope};
  async function message(target,type) {
    let reply;
    await target.dispatch('message',{source:page,data:{type},ports:[{postMessage:value => { reply = value; }}]});
    return reply;
  }
  current.caches.entries.get(current.cacheName).delete(scope+'style.css');
  current.caches.entries.get(waiting.cacheName).delete(scope+'style.css');
  current.caches.full = true;
  const missing = await message(current,'csvtv:repair');
  assert.equal(missing.storageFull,true);
  assert.equal(missing.complete,false);
  assert.equal((await message(waiting,'csvtv:activate')).type,'csvtv:storage-full');
  assert.equal(waiting.state.skipped,0);
  assert.equal(await (await current.request(scope+'main.js')).text(),shell(1).get('main.js'));
  current.caches.full = false;
  assert.equal((await message(current,'csvtv:repair')).complete,true);
  assert.equal((await message(waiting,'csvtv:activate')).type,'csvtv:activating');
});

test('offline readiness inspects the installed inventory and repairs only missing verified files', async () => {
  const app = worker(shell(1));
  const scopeClient = {type:'window',url:scope,id:'settings'};
  async function message(type) {
    let reply;
    await app.dispatch('message',{source:scopeClient, origin:new URL(scope).origin, data:{type},
      ports:[{postMessage:value => { reply = value; }}]});
    assert.equal(reply.build,app.build.build);
    return reply.complete;
  }
  const status = () => message('csvtv:version');
  const repair = () => message('csvtv:repair');
  assert.equal(await status(),false);
  assert.equal(await app.caches.has(app.cacheName),false,'Checking created an empty cache');
  await app.dispatch('install');
  await app.dispatch('activate');
  assert.equal(await status(),true);
  const target = scope+'main.js';
  app.caches.entries.get(app.cacheName).delete(target);
  app.calls.length = 0;
  assert.equal(await status(),false);
  assert.equal(app.calls.length,0);
  const ordinary = app.state.network;
  app.state.network = () => new Response(shell(2).get('main.js'),{headers:{'Content-Type':'text/javascript'}});
  assert.equal(await repair(),false);
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  app.state.network = async url => { started.resolve(); await release.promise; return ordinary(url); };
  const one = repair(), two = repair();
  await started.promise;
  assert.equal(await status(),false,'Ongoing repairs must not block a page from opening its record');
  release.resolve();
  assert.deepEqual(await Promise.all([one,two]),[true,true]);
  assert.equal(await status(),true);
  assert.deepEqual(app.calls.map(call => call.url),[target,target]);
  for (const entire of [false,true]) {
    app.caches.entries.get(app.cacheName).delete(target);
    const fetching = Promise.withResolvers(), resume = Promise.withResolvers();
    app.state.network = async url => { fetching.resolve(); await resume.promise; return ordinary(url); };
    const delayed = repair();
    await fetching.promise;
    if (entire) await app.caches.delete(app.cacheName);
    else app.caches.entries.get(app.cacheName).delete(scope+'style.css');
    resume.resolve();
    assert.equal(await delayed,false,'Writes to a detached or depleted cache claimed the shell was complete');
    app.state.network = ordinary;
    assert.equal(await repair(),true);
  }
});

test('a rejected update stops downloading its other files and keeps the installed build', async () => {
  const caches = storage(), active = worker(shell(1),caches), update = worker(shell(2),caches);
  await active.dispatch('install');
  const ordinary = update.state.network;
  let stalled;
  update.state.network = (url,{signal}) => {
    if (url === scope+'style.css') return new Response('incomplete',{status:503});
    if (url !== scope+'main.js') return ordinary(url);
    stalled = signal;
    return new Response(new ReadableStream({start(stream) {
      signal.addEventListener('abort', () => stream.error(signal.reason), {once:true});
    }}),{headers:{'Content-Type':'text/javascript'}});
  };
  await assert.rejects(update.dispatch('install'),/verify shell asset style.css/);
  assert.equal(stalled.aborted,true);
  assert.deepEqual(await caches.keys(),[active.cacheName]);
});

test('a stalled shell body releases installation and shared repairs so the next request can recover', {timeout:3000}, async () => {
  const app = worker(shell(1)), ordinary = app.state.network;
  const target = scope+'main.js';
  function stall() {
    const started = Promise.withResolvers();
    app.state.network = (url, {signal}) => url !== target ? ordinary(url) : new Response(new ReadableStream({
      start(stream) {
        started.resolve(signal);
        signal.addEventListener('abort', () => stream.error(signal.reason), {once:true});
      },
    }), {headers:{'Content-Type':'text/javascript'}});
    return started.promise;
  }
  let expireInstallation;
  app.state.setTimeout = (callback,ms) => {
    if (ms === 180_000) expireInstallation = callback;
    else assert.ok(ms > 0 && ms < 60_000);
    return 0;
  };
  const firstBody = stall(), installation = app.dispatch('install');
  await firstBody;
  expireInstallation();
  await assert.rejects(installation,/Could not verify shell asset/);
  app.state.setTimeout = setTimeout;
  assert.deepEqual(await app.caches.keys(),[]);
  app.state.network = ordinary;
  await app.dispatch('install');
  app.caches.entries.get(app.cacheName).delete(target);
  const repair = async () => {
    let reply;
    await app.dispatch('message',{source:{type:'window',url:scope,id:'settings'}, data:{type:'csvtv:repair'},
      ports:[{postMessage:value => {reply = value;}}]});
    return reply.complete;
  };
  let expireFile;
  app.state.setTimeout = (callback,ms) => { assert.equal(ms,50_000); expireFile=callback; return 0; };
  const secondBody = stall(), repairs = Promise.all([repair(),repair()]);
  const stalled = await secondBody;
  expireFile();
  assert.equal(stalled.aborted,true);
  assert.deepEqual(await repairs,[false,false]);
  app.state.setTimeout = setTimeout;
  app.state.network = ordinary;
  assert.equal(await repair(),true);
  assert.equal(await (await app.request(target)).text(),shell(1).get('main.js'));
});

test('an offline document can pin its active build while Cache Storage maintenance is busy', async () => {
  const caches = storage(), pins = new Map();
  const old = worker(shell(1),caches,[],pins), next = worker(shell(2),caches,[],pins);
  await old.dispatch('install');
  await old.dispatch('activate');
  old.state.network = () => { throw Error('Offline'); };
  const held = Promise.withResolvers(), release = Promise.withResolvers();
  const maintenance = caches.lock(() => { held.resolve(); return release.promise; });
  await held.promise;
  let timer;
  try {
    const navigation = old.request(scope+'#/library',{mode:'navigate',resultingClientId:'in-flight'},true);
    // respondWith must settle before the background lifetime extension finishes.
    const response = await Promise.race([navigation,new Promise((_,reject) => {
      timer = setTimeout(() => reject(Error('Cached navigation waited for cache maintenance')),300);
    })]);
    assert.equal(await response.text(),old.build.html);
    assert.equal(pins.get('in-flight').build,old.build.build,'HTML left before its durable pin');
  } finally { clearTimeout(timer); release.resolve(); await maintenance; }
  await next.dispatch('install');
  await next.dispatch('activate');
  assert.equal(await (await next.request(scope+'main.js',{clientId:'in-flight'})).text(),shell(1).get('main.js'));
  const fresh = await next.request(scope,{mode:'navigate',resultingClientId:'fresh'});
  assert.equal(await fresh.text(),next.build.html);
  assert.equal(await (await next.request(scope+'main.js',{clientId:'fresh'})).text(),shell(2).get('main.js'));
});

test('concurrent shell assets share an in-flight pin per document and read again after success or failure', async () => {
  const pins = new Map(), caches = storage();
  const old = worker(shell(1),caches), current = worker(shell(2),caches,[],pins);
  await old.dispatch('install');
  await current.dispatch('install');
  pins.set('older',{build:old.build.build});
  pins.set('current',{build:current.build.build});
  let reads = 0, fail = false;
  pins.get = function (id) {
    if (typeof id === 'string') {
      reads++;
      if (fail) throw Error('Pin read interrupted');
    }
    return Map.prototype.get.call(this,id);
  };
  const script = async clientId => (await current.request(scope+'main.js',{clientId})).text();
  assert.deepEqual(await Promise.all([script('older'),script('current'),script('older')]),
    [shell(1).get('main.js'),shell(2).get('main.js'),shell(1).get('main.js')]);
  assert.equal(reads,2);
  pins.set('older',{build:current.build.build});
  fail = true;
  const failed = await Promise.allSettled([script('older'),script('older')]);
  assert.ok(failed.every(r => r.status === 'rejected' && r.reason.message === 'Pin read interrupted'));
  assert.equal(reads,3);
  fail = false;
  assert.equal(await script('older'),shell(2).get('main.js'));
  assert.equal(reads,4);
});

test('a closed IndexedDB pin connection reopens without mixing builds', async () => {
  let connection, opens = 0, putCount = 0, abortWrites = false;
  const pins = new Map();
  const idb = {open() {
    opens++;
    const db = { closed:false, close() { this.closed = true; }, transaction(_name,mode) {
      if (this.closed) throw new DOMException('Connection is closed', 'InvalidStateError');
      const store = {
        get(id) { return {result:pins.get(id), set onsuccess(listener) { listener(); }}; },
        put(value,id) { putCount++; if (!abortWrites) pins.set(id,value); return {result:id}; },
      };
      const tx = {objectStore:() => store};
      queueMicrotask(() => abortWrites && mode === 'readwrite' ? tx.onabort() : tx.oncomplete());
      return tx;
    }};
    connection = db;
    const req = {result:db};
    queueMicrotask(() => req.onsuccess());
    return req;
  }};
  const app = worker(shell(2),storage(),[],pins,{},idb);
  const old = worker(shell(1),app.caches);
  await old.dispatch('install');
  await app.dispatch('install');
  pins.set(0,{active:app.build.build,at:app.state.now});
  pins.set('old',{build:old.build.build});
  const script = async () => (await app.request(scope+'main.js',{clientId:'old'})).text();
  assert.equal(await script(),shell(1).get('main.js'));
  connection.close(); // A transaction can discover the close before notification arrives.
  const stale = connection;
  const html = await app.request(scope,{mode:'navigate',resultingClientId:'new'});
  assert.equal(await html.text(),app.build.html);
  assert.equal(putCount,1);
  assert.equal(opens,2);
  stale.onclose?.();
  assert.equal(await script(),shell(1).get('main.js'));
  assert.equal(opens,2,'A delayed close event discarded the replacement');
  connection.close();
  connection.onclose();
  assert.equal(await script(),shell(1).get('main.js'));
  assert.equal(opens,3);
  assert.equal(await (await app.request(scope+'main.js',{clientId:'new'})).text(),shell(2).get('main.js'));
  abortWrites = true;
  const refused = await app.request(scope,{mode:'navigate',resultingClientId:'never-committed'});
  assert.equal(refused.status,503);
  assert.match(await refused.text(),/could not open storage/);
  assert.equal(pins.has('never-committed'),false);
  assert.equal(putCount,2,'A transaction which aborted after submission was replayed');
  assert.equal(opens,3);
});

test('a superseded worker holds its response until the older build can be retained', async () => {
  const caches = storage(), pins = new Map();
  const old = worker(shell(1),caches,[],pins), next = worker(shell(2),caches,[],pins);
  await old.dispatch('install');
  await old.dispatch('activate');
  await next.dispatch('install');
  await next.dispatch('activate');
  // Start both workers' periodic sweep now so only the fallback pin requests the lock below.
  await old.request(scope+'main.js');
  await next.request(scope+'main.js');
  const requested = Promise.withResolvers(), release = Promise.withResolvers();
  const maintenance = caches.lock(async () => {
    await release.promise;
    // A later activation or sweep may reclaim a build whose reserved client is still invisible.
    await caches.delete(old.cacheName);
  });
  const lock = caches.lock.bind(caches);
  caches.lock = task => { requested.resolve(); return lock(task); };
  const navigation = old.request(scope,{mode:'navigate',resultingClientId:'late'},true);
  try {
    await requested.promise;
    assert.equal(pins.has('late'),false);
  } finally { release.resolve(); await maintenance; }
  const response = await navigation;
  assert.equal(response.status,503,'The document was served after its generation was collected');
  assert.equal(pins.has('late'),false);
  assert.equal(await (await next.request(scope+'main.js')).text(),shell(2).get('main.js'));
});

test('waiting worker identifies each preparation attempt and ignores acknowledgments from an earlier attempt', async () => {
  const target = worker(shell(2)), page = {type:'window',id:'open-tab',url:scope};
  await target.dispatch('install');
  target.state.registrations.waiting = {};
  target.state.clients = [page];
  const sourceBuild = createOfflineBuild(shell(1),template).build;
  const message = (worker,type) => new Promise(resolve => {
    worker.dispatch('message',{source:page,origin:new URL(scope).origin,
      data:{type},ports:[{postMessage:resolve}]});
  });
  const resume = [];
  async function run(previousAttempt) {
    let ready;
    const preparing = new Promise(resolve => { ready = resolve; });
    page.postMessage = (data,ports) => {
      if (data.type === 'csvtv:resume') { resume.push(data.attempt); return; }
      ready({data,port:ports[0]});
    };
    const result = message(target,'csvtv:activate');
    const {data,port} = await preparing;
    assert.equal((await message(target,'csvtv:activation-status')).attempt,data.attempt);
    assert.equal((await message(worker(shell(2)),'csvtv:activation-status')).attempt,null,'A restarted process claimed a lost attempt');
    port.postMessage({type:'csvtv:ready',pageBuild:sourceBuild,attempt:previousAttempt ?? data.attempt});
    return {reply:await result,attempt:data.attempt};
  }
  const first = await run('stale-attempt');
  assert.equal(first.reply.type,'csvtv:blocked');
  assert.deepEqual(resume,[first.attempt]);
  assert.equal((await message(target,'csvtv:activation-status')).attempt,null);
  const second = await run();
  assert.notEqual(first.attempt,second.attempt);
  assert.equal(second.reply.type,'csvtv:activating');
  assert.equal(target.state.skipped,1);
});

test('a waiting update with a missing file keeps the working build until the file can be repaired', async () => {
  const current = worker(shell(1)), waiting = worker(shell(2),current.caches,[],current.bindings);
  await current.dispatch('install');
  await current.dispatch('activate');
  await waiting.dispatch('install');
  waiting.state.registrations.waiting = {};
  const network = waiting.state.network;
  const page = {type:'window',id:'reader',url:scope};
  const activate = () => new Promise(resolve => waiting.dispatch('message',{source:page,
    data:{type:'csvtv:activate'},ports:[{postMessage:reply => resolve(reply.type)}]}));
  const evict = () => waiting.caches.entries.get(waiting.cacheName).delete(scope+'main.js');
  evict();
  waiting.state.network = () => { throw Error('Offline'); };
  assert.equal(await activate(),'csvtv:incomplete');
  assert.equal(waiting.state.skipped,0);
  assert.equal(await (await current.request(scope+'main.js')).text(),shell(1).get('main.js'));

  // Storage can also lose a file while a tab is draining its queued writes.
  waiting.state.network = network;
  let resumed;
  page.postMessage = (data,ports) => {
    if (data.type === 'csvtv:resume') { resumed = data.reason; return; }
    evict();
    ports[0].postMessage({type:'csvtv:ready',attempt:data.attempt,pageBuild:current.build.build});
  };
  waiting.state.clients = [page];
  assert.equal(await activate(),'csvtv:incomplete');
  assert.equal(resumed,'csvtv:incomplete');
  assert.equal(waiting.state.skipped,0);
  waiting.state.clients = [];
  assert.equal(await activate(),'csvtv:activating');
  assert.equal(waiting.state.skipped,1);
  assert.equal(await (await waiting.request(scope+'main.js')).text(),shell(2).get('main.js'));
});

test('automatic activation can prepare only its own sole open tab and respects edits until preparation', async () => {
  for (const situation of ['already open','opened during preparation','editing','idle']) {
    const candidate = worker(shell(2));
    await candidate.dispatch('install');
    candidate.state.registrations.waiting = {};
    const other = {type:'window',id:'other-tab',url:scope,postMessage:assert.fail};
    let prepares = 0;
    const page = {type:'window',id:'refreshing-tab',url:scope,postMessage(data,ports) {
      if (data.type === 'csvtv:resume') return;
      assert.equal(data.refresh,true);
      prepares++;
      if (situation === 'opened during preparation') candidate.state.clients.push(other);
      ports[0].postMessage({type:situation === 'editing' ? 'csvtv:deferred' : 'csvtv:ready',
        attempt:data.attempt,pageBuild:candidate.build.build});
    }};
    candidate.state.clients = situation === 'already open' ? [page,other] : [page];
    const result = await new Promise(resolve => candidate.dispatch('message',{source:page,
      data:{type:'csvtv:activate-on-refresh'},ports:[{postMessage:resolve}]}));
    assert.equal(result.type,situation === 'idle' ? 'csvtv:activating' : 'csvtv:deferred');
    assert.equal(prepares,situation === 'already open' ? 0 : 1);
    assert.equal(candidate.state.skipped,situation === 'idle' ? 1 : 0);
  }
});

test('a stalled waiting-build download or body times out before older pages stop listening and a fresh click can retry', async () => {
  for (const stage of ['fetch','body']) {
    const waiting = worker(shell(2));
    await waiting.dispatch('install');
    waiting.state.registrations.waiting = {};
    const page = {type:'window',id:'reader',url:scope}, messages = [];
    const activate = () => new Promise(resolve => waiting.dispatch('message',{source:page,
      data:{type:'csvtv:activate'},ports:[{postMessage:reply=>resolve(reply.type)}]}));
    page.postMessage = (data,ports) => {
      messages.push(data.type);
      if (data.type === 'csvtv:prepare') ports[0].postMessage({type:'csvtv:ready',attempt:data.attempt,pageBuild:waiting.build.build});
    };
    waiting.state.clients = [page];
    const timers = new Map();
    waiting.state.setTimeout = (callback, ms) => {
      const id = Symbol(); timers.set(id,{callback,ms}); return id;
    };
    waiting.state.clearTimeout = id => timers.delete(id);
    const fetching = Promise.withResolvers(), release = Promise.withResolvers();
    const network = waiting.state.network;
    waiting.state.network = async (url, init) => {
      const response = network(url,init);
      const stall = async () => { fetching.resolve(init.signal); await release.promise; };
      if (stage === 'fetch') { await stall(); return response; }
      return new Response(new ReadableStream({
        async pull(controller) {
          await stall();
          controller.enqueue(new Uint8Array(await response.arrayBuffer()));
          controller.close();
        },
      }),{headers:response.headers});
    };
    const main = scope + 'main.js';
    waiting.caches.entries.get(waiting.cacheName).delete(main);
    const first = activate();
    const signal = await fetching.promise;
    const activeTimers = [...timers.values()].sort((a,b)=>a.ms-b.ms);
    assert.equal(activeTimers.length,2);
    assert.equal(activeTimers[1].ms,50_000,'The per-file deadline also ends when the activation is canceled');
    const [{ms,callback}] = activeTimers;
    assert.ok(ms > 0 && ms < 20_000);
    waiting.state.now += ms;
    callback();
    assert.equal(await first,'csvtv:incomplete');
    assert.equal(signal.aborted,true);
    assert.deepEqual(messages,[]);
    assert.equal(waiting.state.skipped,0);
    assert.equal(await waiting.caches.match(main,{cacheName:waiting.cacheName}),undefined);
    waiting.state.network = network;
    assert.equal(await activate(),'csvtv:activating');
    // A noncooperative old response can finish even after its signal was aborted.
    release.resolve();
    await new Promise(done=>setImmediate(done));
    assert.deepEqual(messages,['csvtv:prepare']);
    assert.equal(waiting.state.skipped,1);
    assert.equal(timers.size,0);
  }
});

test('a tab that drains after the update deadline resumes without activating the expired attempt', async () => {
  const waiting = worker(shell(2));
  await waiting.dispatch('install');
  waiting.state.registrations.waiting = {};
  const messages = [];
  const page = {id:'reader',type:'window',url:scope,postMessage(data,ports) {
    messages.push(data.type);
    if (data.type === 'csvtv:prepare') {
      waiting.state.now += 20_000; // The document was suspended while finishing its writes.
      ports[0].postMessage({type:'csvtv:ready',attempt:data.attempt,pageBuild:waiting.build.build});
    }
  }};
  waiting.state.clients = [page];
  const reply = await new Promise(resolve=>waiting.dispatch('message',{source:page,data:{type:'csvtv:activate'},
    ports:[{postMessage:resolve}]}));
  assert.equal(reply.type,'csvtv:blocked');
  assert.deepEqual(messages,['csvtv:prepare','csvtv:resume']);
  assert.equal(waiting.state.skipped,0);
});
