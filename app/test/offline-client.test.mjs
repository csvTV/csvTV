import assert from 'node:assert/strict';
import test from 'node:test';
import { OfflineShell, reloadOnlineBuild } from '../src/offline.ts';

const scope = 'https://fiction.test/tracker/';
const published = build => new Response('<head><meta name="csvtv-build" content="'+build+'"></head>',{headers:{'Content-Type':'text/html'}});
function windowFor(workers) {
  return {
    location: new URL(scope + 'index.html#/settings'),
    document: { querySelector: () => ({content:'a'.repeat(64)}),
      createElement(name) {
        assert.equal(name,'template');
        const template = {innerHTML:'',content:{querySelectorAll() {
          return [...template.innerHTML.matchAll(/name="csvtv-build" content="([^"]+)"/g)].map(match=>({content:match[1]}));
        }}};
        return template;
      } },
    navigator: {serviceWorker:workers, onLine:true},
    async fetch(url, options) {
      assert.equal(url.origin + url.pathname, scope);
      assert.deepEqual([...url.searchParams.keys()], ['csvtv-update']);
      assert.equal(url.hash, '');
      assert.equal(options.cache, 'no-store');
      return published('a'.repeat(64));
    },
  };
}

test('Site permissions can deny service workers while the online tracker remains available', async () => {
  const win = windowFor(undefined);
  Object.defineProperty(win.navigator, 'serviceWorker', {get() { throw new DOMException('Site permission denied', 'SecurityError'); }});
  const shell = new OfflineShell(win, assert.fail, assert.fail);
  shell.start();
  assert.match(shell.status, /unavailable in this browser/);
  assert.equal(shell.action, null);
  assert.equal(shell.supported, false);
  assert.equal(shell.installedCopy, false);
  assert.equal(await shell.canOpen(), true);
});

test('document checks keep the current origin and path and omit the page query and fragment', async () => {
  const win = windowFor(undefined);
  win.location = new URL('https://fiction.test//tracker/archive/?view=compact#/settings');
  let read = false;
  win.fetch = async (url,options) => {
    assert.equal(url.href,'https://fiction.test//tracker/archive/');
    assert.equal(options.mode,'same-origin');
    read = true;
    return published('a'.repeat(64));
  };
  await reloadOnlineBuild(win,() => false);
  assert.ok(read);
});

test('Online-only compatibility checks bound stalled document bodies and allow a retry', async t => {
  const deadlines = [];
  t.mock.method(AbortSignal,'timeout',ms => {
    deadlines.push(ms);
    return AbortSignal.abort(new DOMException('Timed out','TimeoutError'));
  });
  const win = windowFor(undefined);
  let requests = 0;
  win.fetch = async (_url, options) => {
    requests++;
    return {status:200, text:async () => { options.signal.throwIfAborted(); assert.fail('Body read continued'); }};
  };
  const options = {beforeReload:async () => assert.fail('The current writer was closed before a usable build was found')};
  win.navigator.onLine = false;
  assert.match(await reloadOnlineBuild(win,() => true,options), /Connect to the internet/);
  win.navigator.onLine = true;
  for (let i = 0; i < 2; i++) {
    assert.match(await reloadOnlineBuild(win,() => true,options), /Could not load an updated app/);
  }
  assert.deepEqual(deadlines,[10_000,10_000]);
  assert.equal(requests,2);
});

test('compatibility checks stop at the head, cancel oversized replies and leave the writer open for invalid documents', async () => {
  const win=windowFor(undefined), build='b'.repeat(64), tag='<meta name="csvtv-build" content="'+build+'">';
  let drains=0, reloads=0, canceled=0;
  win.location={origin:new URL(scope).origin,pathname:'/tracker/',reload(){ reloads++; }};
  win.sessionStorage=new Map();
  const options={beforeReload:async()=>{drains++;}};
  async function check(chunks,type='text/html') {
    win.fetch=async()=>new Response(new ReadableStream({
      start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); },
      cancel(){canceled++;}
    }),{headers:{'Content-Type':type}});
    return reloadOnlineBuild(win,()=>true,options);
  }
  assert.match(await check([tag],'text/plain'),/Could not load/);
  assert.match(await check(['x'.repeat(192*1024),tag]),/Could not load/);
  assert.match(await check(['<head>'+tag+tag+'</head>']),/Could not load/);
  assert.match(await check(['<head></head><body>'+tag]),/Could not load/);
  assert.match(await check(['<head>'+tag+' '.repeat(128*1024)]),/Could not load/);
  win.fetch=async()=>new Response('<head>'+tag,{headers:{'Content-Type':'text/html'}});
  assert.match(await reloadOnlineBuild(win,()=>true,options),/Could not load/);
  assert.deepEqual([drains,reloads,canceled],[0,0,5]);
  await check(['<head>'+tag+'</hea','d><body>unneeded host content']);
  assert.deepEqual([drains,reloads,canceled],[1,1,6]);
});

test('An enclosing worker and an unavailable nested registration still allow an online app to open', async () => {
  const workers = new EventTarget();
  const foreign = new EventTarget();
  foreign.scriptURL = 'https://fiction.test/site-worker.js';
  foreign.postMessage = () => assert.fail('The app contacted an unrelated controller');
  workers.controller = foreign;
  workers.getRegistration = async () => ({scope:'https://fiction.test/',active:foreign});
  let requested = false;
  workers.register = async (url, options) => {
    requested = true;
    assert.equal(url.href, scope + 'service-worker.js');
    assert.equal(options.scope, scope);
    throw Error('Offline installation disabled in this browser');
  };
  const shell = new OfflineShell(windowFor(workers), assert.fail, assert.fail);
  const status = new Promise(resolve => shell.addEventListener('change', resolve, { once:true }));
  shell.start();
  await status;
  assert.equal(requested, true);
  assert.match(shell.status, /could not be installed/);
  assert.equal(shell.installedCopy, false);
  assert.equal(await shell.canOpen(), true);
});

test('An explicit update check follows the waiting or active replacement when the installation it awaited fails', async () => {
  const worker = state => Object.assign(new EventTarget(), {state,scriptURL:scope + 'service-worker.js'});
  for (const state of ['installed','activated']) {
    const old = worker('installing');
    const registration = Object.assign(new EventTarget(), {scope,active:worker('activated'),installing:old,waiting:null});
    const workers = Object.assign(new EventTarget(), {getRegistration:async () => registration});
    const shell = new OfflineShell(windowFor(workers), assert.fail, assert.fail);
    const checking = new Promise(resolve => shell.addEventListener('change', resolve, {once:true}));
    const result = shell.update();
    await checking;
    const replacement = worker(state);
    if (state === 'installed') registration.waiting = replacement;
    else {
      registration.active = workers.controller = replacement;
      replacement.postMessage = (_message, [port]) => { port.postMessage({type:'csvtv:version',build:'a'.repeat(64)}); port.close(); };
    }
    registration.installing = null;
    old.state = 'redundant';
    old.dispatchEvent(new Event('statechange'));
    assert.equal(await result, state === 'installed' ? 'Update available.' : 'Ready to open offline.');
    assert.equal(shell.action, state === 'installed' ? 'activate' : 'check');
  }
});

test('Cold starts share a version check, accept either delayed reply and keep the record closed when both are missing', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  for (const from of ['first', 'reminder', 'neither']) {
    const ports = [];
    const worker = Object.assign(new EventTarget(), {
      state:'activated', scriptURL:scope + 'service-worker.js',
      postMessage(message, [port]) {
        assert.equal(message.type, 'csvtv:version');
        ports.push(port);
      },
    });
    const shell = new OfflineShell(windowFor(Object.assign(new EventTarget(), {controller:worker})), assert.fail, assert.fail);
    const checks = Promise.all([shell.canOpen(), shell.canOpen()]);
    assert.equal(ports.length, 1);
    t.mock.timers.tick(4000);
    assert.equal(ports.length, 2);
    if (from === 'neither') {
      const failed = assert.rejects(checks, /worker did not reply/);
      t.mock.timers.tick(8000);
      await failed;
    } else {
      ports[from === 'first' ? 0 : 1].postMessage({type:'csvtv:version',build:'a'.repeat(64)});
      assert.deepEqual(await checks, [true,true]);
      assert.equal(shell.status, 'Ready to open offline.');
    }
    t.mock.timers.tick(12_000);
    assert.equal(ports.length, 2);
    for (const port of ports) port.close();
  }
});

test('a delayed shell repair cannot hide a waiting update or claim the replacement controller is complete', async () => {
  for (const replacing of [false,true]) {
    const held = Promise.withResolvers();
    const worker = state => Object.assign(new EventTarget(), {state,scriptURL:scope + 'service-worker.js'});
    const current = worker('activated'), next = worker('installing');
    const report = (port, complete) => { port.postMessage({type:'csvtv:version',build:'a'.repeat(64),complete}); port.close(); };
    current.postMessage = ({type},[port]) => {
      if (type === 'csvtv:repair') held.resolve(port);
      else report(port,true);
    };
    next.postMessage = (_message,[port]) => report(port,false);
    const registration = Object.assign(new EventTarget(), {scope,active:current,installing:null,waiting:null,update:async () => {}});
    const workers = Object.assign(new EventTarget(), {controller:current,getRegistration:async () => registration});
    const shell = new OfflineShell(windowFor(workers),assert.fail,assert.fail);
    const checking = shell.update(), result = await held.promise;
    registration.installing = next;
    registration.dispatchEvent(new Event('updatefound'));
    next.state = 'installed'; registration.waiting = next; registration.installing = null;
    next.dispatchEvent(new Event('statechange'));
    assert.equal(shell.action,'activate');
    if (replacing) {
      next.state = 'activated'; registration.active = workers.controller = next; registration.waiting = null;
      next.dispatchEvent(new Event('statechange'));
    }
    report(result,true);
    await checking;
    assert.equal(shell.action,replacing ? 'install' : 'activate');
    assert.match(shell.status,replacing ? /offline files are missing/ : /Update available/);
  }
});

test('a delayed inventory of missing files cannot undo a successful repair status', async () => {
  const delayed = Promise.withResolvers();
  const controller = Object.assign(new EventTarget(), {state:'activated',scriptURL:scope+'service-worker.js'});
  const report = (port, complete) => { port.postMessage({type:'csvtv:version',build:'a'.repeat(64),complete}); port.close(); };
  controller.postMessage = ({type},[port]) => {
    if (type === 'csvtv:repair') report(port,true);
    else delayed.resolve(port);
  };
  const registration = Object.assign(new EventTarget(), {scope,active:controller,update:async () => {}});
  const workers = Object.assign(new EventTarget(), {controller,getRegistration:async () => registration});
  const shell = new OfflineShell(windowFor(workers),assert.fail,assert.fail);
  const opening = shell.canOpen(), first = await delayed.promise;
  assert.equal(await shell.update(),'Up to date. Ready to open offline.');
  report(first,false);
  assert.equal(await opening,true);
  assert.equal(shell.action,'check');
  assert.equal(shell.status,'Up to date. Ready to open offline.');
});

test('a Reload click during the final inventory reply activates the waiting worker exactly once', async () => {
  const held = Promise.withResolvers();
  const worker = state => Object.assign(new EventTarget(), {state,scriptURL:scope+'service-worker.js'});
  const current = worker('activated'), next = worker('installing');
  current.postMessage = ({type},[port]) => {
    assert.equal(type,'csvtv:repair');
    held.resolve(port);
  };
  let activations = 0;
  next.postMessage = ({type},[port]) => {
    assert.equal(type,'csvtv:activate');
    activations++;
    port.postMessage({type:'csvtv:activating'}); port.close();
  };
  const registration = Object.assign(new EventTarget(), {scope,active:current,update:async () => {}});
  const workers = Object.assign(new EventTarget(), {controller:current,getRegistration:async () => registration});
  const shell = new OfflineShell(windowFor(workers),assert.fail,assert.fail);
  const checking = shell.update(), reply = await held.promise;
  registration.installing = next;
  registration.dispatchEvent(new Event('updatefound'));
  next.state = 'installed'; registration.waiting = next; registration.installing = null;
  next.dispatchEvent(new Event('statechange'));
  assert.equal(shell.action,'activate');
  const clicks = [shell.update(),shell.update()];
  reply.postMessage({type:'csvtv:version',build:shell.build,complete:true}); reply.close();
  await Promise.all([checking,...clicks]);
  assert.equal(activations,1);
  assert.equal(shell.status,'Updating csvTV…');
});

test('a permanently mixed publication ends one check with an actionable result and preserves the current shell', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const active = Object.assign(new EventTarget(), {state:'activated',scriptURL:scope+'service-worker.js',postMessage:assert.fail});
  let attempts = 0;
  const registration = Object.assign(new EventTarget(), {scope,active,update:async () => { attempts++; }});
  const win = windowFor(Object.assign(new EventTarget(), {controller:active,getRegistration:async () => registration}));
  win.fetch = async () => published('b'.repeat(64));
  const shell = new OfflineShell(win,assert.fail,assert.fail);
  const checking = shell.update();
  for (const [index,delay] of [1000,3000,6000].entries()) {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(attempts,index+1);
    assert.equal(shell.status,'Waiting for the published update…');
    t.mock.timers.tick(delay);
  }
  assert.match(await checking,/still becoming available/);
  assert.equal(attempts,4);
  assert.equal(shell.action,'check');
  assert.equal(shell.paused,false);
});

test('foreground discovery is rate limited, skips offline and hidden tabs, and offers the installed update without activating it', async t => {
  t.mock.timers.enable({apis:['Date'],now:1000});
  const active = Object.assign(new EventTarget(), {state:'activated',scriptURL:scope+'service-worker.js'});
  active.postMessage = ({type},[port]) => {
    assert.equal(type,'csvtv:version');
    port.postMessage({type,build:'a'.repeat(64),complete:true}); port.close();
  };
  let attempts = 0;
  const registration = Object.assign(new EventTarget(), {scope,active,update:async () => { attempts++; }});
  const win = windowFor(Object.assign(new EventTarget(), {controller:active,getRegistration:async () => registration}));
  win.navigator.onLine = false;
  const shell = new OfflineShell(win,assert.fail,assert.fail);
  const ready = new Promise(resolve => shell.addEventListener('change', resolve, {once:true}));
  shell.start(); await ready;
  shell.discoverInBackground();
  win.navigator.onLine = true; win.document.visibilityState = 'hidden'; shell.discoverInBackground();
  assert.equal(attempts,0);
  win.document.visibilityState = 'visible';
  shell.discoverInBackground(); shell.discoverInBackground();
  assert.equal(attempts,1);
  t.mock.timers.tick(60_000);
  const next = Object.assign(new EventTarget(), {state:'installing',scriptURL:active.scriptURL,postMessage:assert.fail});
  registration.update = async () => {
    attempts++;
    registration.installing = next; registration.dispatchEvent(new Event('updatefound'));
    registration.installing = null; registration.waiting = next; next.state = 'installed'; next.dispatchEvent(new Event('statechange'));
  };
  shell.discoverInBackground(); shell.discoverInBackground();
  assert.equal(attempts,2);
  assert.equal(shell.action,'activate');
  assert.equal(shell.paused,false);
});

test('an earlier shell inventory cannot hide the result of checking for an update offline', {timeout:3000}, async () => {
  const held = Promise.withResolvers();
  const worker = Object.assign(new EventTarget(), {state:'activated',scriptURL:scope+'service-worker.js'});
  const reply = port => { port.postMessage({type:'csvtv:version',build:'a'.repeat(64),complete:true}); port.close(); };
  worker.postMessage = ({type},[port]) => {
    assert.equal(type,'csvtv:version');
    held.resolve(port);
  };
  const registration = Object.assign(new EventTarget(), {scope,active:worker,waiting:null,update:assert.fail});
  const win = windowFor(Object.assign(new EventTarget(), {controller:worker,getRegistration:async () => registration}));
  win.navigator.onLine = false;
  const shell = new OfflineShell(win,assert.fail,assert.fail);
  const opening = shell.canOpen(), response = await held.promise;
  const feedback = await shell.update();
  reply(response);
  assert.equal(await opening,true);
  assert.match(feedback,/Connect to the internet/);
  assert.equal(shell.status,feedback);
  assert.equal(shell.action,'check');
  worker.postMessage = (_message,[port]) => reply(port);
  win.navigator.onLine = true;
  const checked = new Promise(resolve => shell.addEventListener('change',resolve,{once:true}));
  shell.checkAvailability();
  await checked;
  assert.equal(shell.status,'Ready to open offline.');
});

test('A later matching controller reopens a previously unverified document exactly once', {timeout:4000}, async () => {
  const workers = new EventTarget();
  const controller = new EventTarget();
  controller.scriptURL = scope + 'service-worker.js';
  controller.state = 'activated';
  workers.controller = controller;
  controller.postMessage = (_message, [port]) => { port.postMessage({type:'unknown worker'}); port.close(); };
  const reopened = Promise.withResolvers();
  const stopped = Promise.withResolvers();
  let opens = 0;
  const shell = new OfflineShell(windowFor(workers), async reason => stopped.resolve(reason), () => { opens++; reopened.resolve(); });
  workers.dispatchEvent(new Event('controllerchange'));
  assert.equal(await stopped.promise, 'Could not verify the installed app. Reopen csvTV to try again.');
  assert.equal(shell.status, await stopped.promise);
  controller.postMessage = (_message, [port]) => {
    port.postMessage({type:'csvtv:version', build:'a'.repeat(64)}); port.close();
  };
  workers.dispatchEvent(new Event('controllerchange'));
  workers.dispatchEvent(new Event('controllerchange'));
  await reopened.promise;
  await shell.canOpen();
  assert.equal(opens, 1);
  assert.equal(shell.status, 'Ready to open offline.');
});

test('A delayed registration reopens the offline bookmark when the same worker later verifies', {timeout:4000}, async () => {
  const registered = Promise.withResolvers();
  const controller = Object.assign(new EventTarget(), {state:'activated', scriptURL:scope + 'service-worker.js'});
  const workers = Object.assign(new EventTarget(), {controller, getRegistration:() => registered.promise});
  const win = windowFor(workers);
  win.navigator.onLine = false;
  let reopened = 0;
  const shell = new OfflineShell(win, assert.fail, () => { reopened++; });
  controller.postMessage = (_message, [port]) => { port.postMessage({type:'unverified'}); port.close(); };
  shell.start();
  await assert.rejects(shell.canOpen(), /Unknown app version/);
  const ready = new Promise(resolve => shell.addEventListener('change', resolve, {once:true}));
  controller.postMessage = (_message, [port]) => { port.postMessage({type:'csvtv:version',build:'a'.repeat(64)}); port.close(); };
  registered.resolve(Object.assign(new EventTarget(), {scope, active:controller}));
  await ready;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reopened, 1);
  assert.equal(shell.status, 'Ready to open offline.');
});

test('A superseded offline worker leaves the replacement update available', async () => {
  const worker = () => Object.assign(new EventTarget(), {state:'installing', scriptURL:scope + 'service-worker.js'});
  const first = worker();
  const next = worker();
  const registration = Object.assign(new EventTarget(), {scope, installing:first, waiting:null, active:null});
  const workers = Object.assign(new EventTarget(), {getRegistration:async () => registration});
  const shell = new OfflineShell(windowFor(workers), assert.fail, assert.fail);
  shell.start();
  await new Promise(resolve => setImmediate(resolve));
  function install(candidate) {
    registration.installing = null;
    registration.waiting = candidate;
    candidate.state = 'installed';
    candidate.dispatchEvent(new Event('statechange'));
  }
  install(first);
  registration.installing = next;
  registration.dispatchEvent(new Event('updatefound'));
  install(next);
  first.state = 'redundant';
  first.dispatchEvent(new Event('statechange'));
  assert.equal(shell.status, 'Update available.');
  assert.equal(shell.action, 'activate');
  const latest = worker();
  registration.installing = latest;
  registration.dispatchEvent(new Event('updatefound'));
  install(latest);
  registration.waiting = null;
  registration.active = workers.controller = latest;
  latest.postMessage = (_message, [port]) => { port.postMessage({type:'csvtv:version',build:'a'.repeat(64)}); port.close(); };
  latest.state = 'activated';
  latest.dispatchEvent(new Event('statechange'));
  await shell.canOpen();
  next.state = 'redundant';
  next.dispatchEvent(new Event('statechange'));
  assert.equal(shell.status, 'Ready to open offline.');
  const failed = worker();
  registration.installing = failed;
  registration.dispatchEvent(new Event('updatefound'));
  registration.installing = null;
  failed.state = 'redundant';
  failed.dispatchEvent(new Event('statechange'));
  assert.equal(shell.action, 'install');
});

test('Settings keeps an incomplete waiting update retryable without interrupting the working version', async () => {
  const active = Object.assign(new EventTarget(), {scriptURL:scope+'service-worker.js',state:'activated'});
  const waiting = Object.assign(new EventTarget(), {scriptURL:active.scriptURL,state:'installed'});
  const registration = Object.assign(new EventTarget(), {scope, active, waiting});
  const workers = Object.assign(new EventTarget(), {controller:active,getRegistration:async () => registration});
  const shell = new OfflineShell(windowFor(workers), assert.fail, assert.fail);
  active.postMessage = (_data,[port]) => { port.postMessage({type:'csvtv:version',build:shell.build,complete:true}); port.close(); };
  waiting.postMessage = (_data,[port]) => { port.postMessage({type:'csvtv:incomplete'}); port.close(); };
  assert.equal(await shell.update(),'Update available.');
  assert.match(await shell.update(), /update is missing files/);
  assert.equal(shell.action,'activate');
  assert.equal(await shell.canOpen(),true);
  waiting.postMessage = (_data,[port]) => { port.postMessage({type:'csvtv:activating'}); port.close(); };
  assert.equal(await shell.update(),'Updating csvTV…');
});

function refreshWithWaiting() {
  const worker = state => Object.assign(new EventTarget(), {state,scriptURL:scope+'service-worker.js'});
  const active = worker('activated'), waiting = worker('installed');
  const registration = Object.assign(new EventTarget(), {scope, active, waiting});
  const workers = Object.assign(new EventTarget(), {controller:active,getRegistration:async () => registration});
  const win = Object.assign(new EventTarget(), windowFor(workers), {
    document:Object.assign(new EventTarget(),{visibilityState:'visible',
      querySelector:selector => selector.startsWith('meta') ? {content:'a'.repeat(64)} : null}),
    sessionStorage:{getItem:() => null},
    performance:{getEntriesByType:() => [{type:'reload'}]},
    setTimeout:(fn,ms) => setTimeout(fn,ms).unref(), clearTimeout,
  });
  const shell = new OfflineShell(win,assert.fail,assert.fail);
  return {shell,win,waiting};
}

test('only an untouched online user refresh may automatically request a waiting update', async () => {
  for (const reason of ['navigation','offline','background','callback','query','updated document','storage unavailable',
    'input','compositionstart','dialog','legacy worker']) {
    const {shell,win,waiting} = refreshWithWaiting();
    if (reason === 'navigation') win.performance.getEntriesByType = () => [{type:'navigate'}];
    if (reason === 'offline') win.navigator.onLine = false;
    if (reason === 'background') win.document.visibilityState = 'hidden';
    if (reason === 'query') win.location.search = '?from=bookmark';
    if (reason === 'updated document') win.sessionStorage.getItem = () => 'a'.repeat(64);
    if (reason === 'storage unavailable') win.sessionStorage.getItem = () => { throw Error('Storage blocked'); };
    if (reason === 'dialog') win.document.querySelector = () => ({open:true});
    const requests = [];
    waiting.postMessage = ({type},[port]) => {
      requests.push(type);
      port.postMessage({type:'csvtv:activation-status',attempt:null}); port.close();
    };
    shell.start(reason !== 'callback');
    if (reason === 'input' || reason === 'compositionstart') win.dispatchEvent(new Event(reason));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(requests,reason === 'legacy worker' ? ['csvtv:activation-status'] : [],reason);
    assert.equal(shell.action,'activate');
  }
});

test('an explicit Reload takes over an automatic check that is awaiting worker capability negotiation', async () => {
  const {shell,waiting} = refreshWithWaiting();
  const features = Promise.withResolvers();
  const requests = [];
  waiting.postMessage = ({type}, [port]) => {
    requests.push(type);
    if (type === 'csvtv:activation-status') features.resolve(port);
    else { port.postMessage({type:'csvtv:activating'}); port.close(); }
  };
  shell.start();
  const port = await features.promise;
  const click = shell.update();
  port.postMessage({type:'csvtv:activation-status',refreshActivation:true}); port.close();
  assert.equal(await click,'Updating csvTV…');
  assert.deepEqual(requests,['csvtv:activation-status','csvtv:activate']);
});
