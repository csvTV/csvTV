const SHELL = null;
// The build supplies the allowlist and SHA-256 of every file above.
const scope = self.registration.scope;
const scopedURL = name => new URL(name, scope).href;
const cacheName = build => 'csvTV:shell:' + scope + ':' + build;
const index = scopedURL('index.html');
const assets = new Map(Object.keys(SHELL.files).map(name => [scopedURL(name),name]));
const oldAssets = new Set(SHELL.retired.map(scopedURL));
const buildHash = /^[a-f0-9]{64}$/;
const types = {
  html:['text/html'], css:['text/css'], js:['text/javascript','application/javascript','application/ecmascript','text/ecmascript'],
  svg:['image/svg+xml'], png:['image/png'], ico:['image/x-icon','image/vnd.microsoft.icon'], webmanifest:['application/manifest+json','application/json']
};
const policyHeaders = ['Content-Security-Policy','X-Frame-Options','Permissions-Policy','Cross-Origin-Resource-Policy',
  'Cross-Origin-Opener-Policy','Cross-Origin-Embedder-Policy'];
const cacheLock = task => self.navigator.locks.request('csvTV/shell-maintenance/' + scope,task);

// Content-Length may describe a compressed transfer. Check decoded bytes against the release itself.
async function assetBytes(response, expectedSize, signal) {
  const reader = response.body?.getReader();
  const bytes = new Uint8Array(expectedSize);
  let offset = 0;
  if (reader) {
    const stop = () => { void reader.cancel().catch(() => {}); };
    try {
      signal.addEventListener('abort',stop,{once:true});
      signal.throwIfAborted();
      for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        if (value.byteLength > expectedSize - offset) {
          void reader.cancel().catch(() => {});
          throw Error('Shell asset exceeds its release size');
        }
        bytes.set(value, offset);
        offset += value.byteLength;
      }
    } finally { signal.removeEventListener('abort',stop); reader.releaseLock(); }
  }
  if (offset !== expectedSize) throw Error('Incomplete shell asset');
  return bytes;
}

// An individual file and a complete installation or repair have separate deadlines.
const assetTimeout = 50_000;
const installTimeout = 180_000;
async function verifiedBytes(name, response, signal) {
  const bytes = await assetBytes(response,SHELL.sizes[name],signal);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  if (signal.aborted || Array.from(digest, byte => byte.toString(16).padStart(2,'0')).join('') !== SHELL.files[name]) {
    throw Error('Wrong bytes for ' + name);
  }
  return bytes;
}

async function getAsset(name, signal = AbortSignal.timeout(assetTimeout), previous, installing = false) {
  // On the private phone-test host the HTML route is decorated. The exact
  // document can instead be installed from this one build-selected sibling.
  const plainDocument = name === 'index.html' && SHELL.documentSource === 'offline-document.txt';
  const contentTypes = plainDocument ? ['text/plain'] : types[name.split('.').pop()];
  let urls = [scopedURL(name)];
  if (plainDocument) urls = [scopedURL('offline-document.txt')];
  else if (name === 'index.html') urls = [scope,index];
  let saved, previousHeaders;
  if (previous?.headSupported && name !== 'index.html') {
    try {
      const copy = await caches.match(scopedURL(name),{cacheName:previous.cache});
      if (copy?.headers.get('Content-Security-Policy') === SHELL.documentPolicy) {
        previousHeaders = copy.headers;
        saved = await verifiedBytes(name,copy,signal);
      }
    } catch { /* An evicted or different file needs a full request. */ }
  }
  const requests = urls.map(url => [url,'GET']);
  if (saved) requests.unshift([urls[0],'HEAD']);
  for (const [url,method] of requests) {
    if (signal?.aborted) break;
    try {
      // A host may not implement HEAD. Leave time for an ordinary GET.
      const requestSignal = method === 'HEAD' ? AbortSignal.any([signal,AbortSignal.timeout(10_000)]) : signal;
      // The opening page already fetched many of these modules. A conditional
      // GET still contacts the host before we check their release size and hash.
      const cache = installing && method === 'GET' && name !== 'index.html' && !SHELL.documentSource ? 'no-cache' : 'no-store';
      const response = await fetch(url, {method,cache,redirect:'error', credentials:'same-origin', referrerPolicy:'no-referrer', signal:requestSignal});
      if (method === 'HEAD' && (response.status === 405 || response.status === 501)) previous.headSupported = false;
      const receivedType = response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
      if (response.status !== 200 || response.redirected || response.type === 'opaque' || response.headers.has('Content-Range') ||
          (plainDocument && response.url !== url) || !contentTypes?.includes(receivedType) ||
          /^attachment\b/i.test(response.headers.get('Content-Disposition') || '')) {
        void response.body?.cancel().catch(() => {});
        continue;
      }
      if (method === 'HEAD') {
        // Reuse only exact release bytes under the standard public hosting policy.
        // A changed or withheld header, private response or negotiated login goes through GET.
        const current = response.headers;
        if (policyHeaders.some(key => current.get(key) !== previousHeaders.get(key)) ||
            current.get('Referrer-Policy') !== 'no-referrer' || current.get('X-Content-Type-Options') !== 'nosniff' ||
            /\b(private|no-store)\b/i.test(current.get('Cache-Control') || '') ||
            /(?:^|,)\s*(?:cookie|authorization|\*)\s*(?:,|$)/i.test(current.get('Vary') || '')) {
          void response.body?.cancel().catch(() => {});
          continue;
        }
      }
      const media = plainDocument ? 'text/html' : receivedType;
      const bytes = method === 'HEAD' ? saved : await verifiedBytes(name,response,signal);
      if (signal.aborted) break;
      // A private static host may vary on cookies and add session-specific
      // headers. Save just verified public bytes and the response's security policy.
      // Constructing a fresh response also avoids retaining an alternate canonical URL.
      const headers = new Headers({'Content-Type':media, 'Referrer-Policy':'no-referrer', 'X-Content-Type-Options':'nosniff'});
      if (media.startsWith('text/') || media === 'application/javascript') headers.set('Content-Type',media+'; charset=utf-8');
      for (const key of policyHeaders) {
        if (response.headers.has(key)) headers.set(key,response.headers.get(key));
      }
      if (name === 'index.html') {
        const hostPolicy = headers.get('Content-Security-Policy');
        if (plainDocument || !hostPolicy) headers.set('Content-Security-Policy',SHELL.documentPolicy);
        else if (hostPolicy !== SHELL.documentPolicy) headers.append('Content-Security-Policy',SHELL.documentPolicy);
        if (!headers.has('Permissions-Policy')) headers.set('Permissions-Policy',SHELL.permissionsPolicy);
      }
      return new Response(bytes,{status:200,headers});
    } catch { /* Hosts differ on whether the canonical document is / or /index.html. */ }
  }
  throw Error('Could not verify shell asset ' + name);
}

async function downloadFiles(entries, limit, signal, visit) {
  const queue = entries[Symbol.iterator]();
  async function load() {
    for (const [url,name] of queue) {
      signal.throwIfAborted();
      const file = new AbortController(), cancel = () => file.abort();
      const timer = setTimeout(cancel,assetTimeout);
      signal.addEventListener('abort',cancel,{once:true});
      try { await visit(url,name,file.signal); }
      finally { clearTimeout(timer); signal.removeEventListener('abort',cancel); }
    }
  }
  await Promise.all(Array.from({length:Math.min(limit,entries.size ?? entries.length)},load));
}

async function installShell() {
  // Validate everything before writing, including on a deployment that changed midway.
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), installTimeout);
  let responses;
  try {
    const prefix = cacheName(''), current = cacheName(SHELL.build);
    let previous;
    if (!SHELL.documentSource && typeof AbortSignal.any === 'function') {
      const keys = await caches.keys().catch(() => []);
      const cache = keys.reverse().find(key => key !== current && key.startsWith(prefix) && buildHash.test(key.slice(prefix.length)));
      if (cache) previous = {cache,headSupported:true};
    }
    responses = [];
    // A first install downloads bodies, while most update requests check headers.
    await downloadFiles(assets,previous ? 16 : 8,controller.signal,async (url,name,signal) => {
      responses.push([url,await getAsset(name,signal,previous,true)]);
    });
  } finally {
    clearTimeout(deadline);
    controller.abort();
  }
  await cacheLock(async () => {
    const name = cacheName(SHELL.build), existing = await caches.has(name), cache = await caches.open(name);
    try {
      const writes = await Promise.allSettled(responses.map(([url,response]) => cache.put(url,response)));
      if (writes.some(result => result.status === 'rejected')) throw Error('Could not store the complete app shell');
      if (!await shellComplete(false)) throw Error('The installed app files were removed during installation');
    } catch (error) {
      if (!existing) await caches.delete(name);
      throw error;
    }
  });
}

// Installed workers can outlive their cache entries. Inspect the URL inventory
// without reading the bodies. Only an explicit repair fetches missing files.
async function shellComplete(repair, signal) {
  try {
    const name = cacheName(SHELL.build);
    if (!repair && !await caches.has(name)) return false;
    const cache = await caches.open(name);
    const present = new Set((await cache.keys()).map(request => request.url));
    const missing = [...assets].filter(([url]) => !present.has(url));
    if (!missing.length) return true;
    if (!repair) return false;
    // Browsers may evict the entire shell while the app is open. Start the
    // next file's deadline when it can be sent, just as on a new installation.
    const deadline = signal ?? AbortSignal.timeout(installTimeout);
    let storageError;
    await downloadFiles(missing,8,deadline,async (url,file,fileSignal) => {
      if (storageError) return;
      try {
        const response = await getAsset(file,fileSignal);
        if (!fileSignal.aborted) await cache.put(url,response);
      } catch (error) {
        if (error?.name === 'QuotaExceededError') storageError = error;
      }
    });
    // A Cache handle still accepts writes after storage drops its name. Recheck
    // the live inventory, including entries that were present before the fetch.
    const complete = await shellComplete(false);
    if (!complete && storageError) throw storageError;
    return complete;
  } catch (error) {
    if (repair && error?.name === 'QuotaExceededError') throw error;
    return false;
  }
}

// Store only the browser's document IDs and build hashes. Bindings survive worker
// restarts and let an old tab finish loading its own modules until it reloads.
let database;
function openBindings() {
  if (database) return database;
  const request = indexedDB.open('csvTV/offline-shell/' + scope, 1);
  const opening = new Promise((resolve,reject) => {
    const forget = () => { if (database === opening) database = undefined; };
    request.onupgradeneeded = () => {
      request.result.createObjectStore('pages');
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onclose = forget;
      db.onversionchange = () => { db.close(); forget(); };
      resolve(db);
    };
    request.onerror = () => { forget(); reject(request.error); };
  });
  database = opening;
  return opening;
}
async function binding(store, mode, operation) {
  const opening = openBindings();
  const db = await opening;
  let tx;
  try { tx = db.transaction(store,mode); }
  catch (error) {
    // A suspended worker can observe a closed connection before its close event.
    // Retry only transaction creation, before any operation has been submitted.
    if (error.name !== 'InvalidStateError') throw error;
    if (database === opening) database = undefined;
    tx = (await openBindings()).transaction(store,mode);
  }
  return new Promise((resolve,reject) => {
    const request = operation(tx.objectStore(store));
    tx.oncomplete = () => resolve(request.result);
    tx.onabort = () => reject(tx.error || Error('Shell binding transaction aborted'));
  });
}
const writePin = (id, build) => binding('pages','readwrite', s => s.put({id,build,at:Date.now()},id));
const bind = (id, build) => cacheLock(() => writePin(id,build));
const pageBuild = id => binding('pages','readonly', s => s.get(id));

// One document requests many shell assets at once. Share the lookup only
// while it is in flight so later requests see the current durable binding.
const pendingAssetPins = new Map();
function assetPin(id) {
  let read = pendingAssetPins.get(id);
  if (!read) {
    read = pageBuild(id).finally(() => pendingAssetPins.delete(id));
    pendingAssetPins.set(id,read);
  }
  return read;
}

function appClient(client) {
  if (!client || client.type !== 'window') return false;
  const url = new URL(client.url);
  url.search = ''; url.hash = '';
  return url.href === scope || url.href === index;
}
async function pages() {
  return (await self.clients.matchAll({type:'window',includeUncontrolled:true})).filter(appClient);
}
function ask(client, message, milliseconds) {
  return new Promise(resolve => {
    const channel = new MessageChannel();
    function finish(value) {
      clearTimeout(timer); channel.port1.close(); resolve(value);
    }
    const timer = setTimeout(() => finish(null), milliseconds);
    channel.port1.onmessage = event => finish(event.data);
    try { client.postMessage(message,[channel.port2]); } catch { finish(null); }
  });
}
function isWaiting() {
  return !!self.registration.waiting && (!self.serviceWorker || self.registration.waiting === self.serviceWorker);
}
async function beforeDeadline(end, work) {
  const remaining = end - Date.now();
  if (remaining <= 0) return null;
  let timer;
  try {
    const expired = new Promise(resolve => { timer = setTimeout(() => resolve(null), remaining); });
    const value = await Promise.race([expired, work()]);
    // After device sleep, the timer and the completed request may both be runnable.
    return Date.now() < end ? value : null;
  } finally { clearTimeout(timer); }
}
async function prepareAndActivate(attempt, refreshClient) {
  const contacted = new Map();
  // Deployed older pages stop waiting after 20s. Leave time to return a result and reopen paused tabs.
  const start = Date.now(), end = start + 18_000;
  let preparing = true;
  let failure = 'csvtv:blocked';
  try {
    // The browser can evict files after installation. Repair the waiting copy
    // before pausing writers, and verify it again after the last tab has drained.
    const repair = new AbortController();
    try {
      if (!await beforeDeadline(start + 8000, () => shellComplete(true, repair.signal))) return 'csvtv:incomplete';
    } finally { repair.abort(); }
    // A new document may appear while another tab finishes its admitted writes.
    for (let pass = 0; pass < 5 && isWaiting(); pass++) {
      const live = await beforeDeadline(end, pages);
      if (!live) break;
      // A refresh can update this tab only. Older tabs do not understand a
      // conditional prepare message and would otherwise close their editors.
      const alone = list => list?.length === 1 && list[0].id === refreshClient;
      if (refreshClient && !alone(live)) { failure = 'csvtv:deferred'; break; }
      const pending = live.filter(client => !contacted.has(client.id));
      if (!pending.length && isWaiting()) {
        if (!await beforeDeadline(end, () => shellComplete(false))) { failure = 'csvtv:incomplete'; break; }
        if (refreshClient && !alone(await beforeDeadline(end, pages))) { failure = 'csvtv:deferred'; break; }
        if (!isWaiting() || Date.now() >= end) break;
        await self.skipWaiting();
        return 'csvtv:activating';
      }
      const answers = await beforeDeadline(end, () => Promise.all(pending.map(async client => {
        contacted.set(client.id,client);
        const reply = await ask(client,{type:'csvtv:prepare',build:SHELL.build,attempt,refresh:!!refreshClient},3000);
        if (!preparing || Date.now() >= end) return false;
        if (refreshClient && reply?.type === 'csvtv:deferred') { failure = 'csvtv:deferred'; return false; }
        if (reply?.type === 'csvtv:ready' && reply.attempt === attempt && buildHash.test(reply.pageBuild)) {
          await bind(client.id,reply.pageBuild);
          return true;
        }
        return !await self.clients.get(client.id);
      })));
      if (!answers || answers.some(ready => !ready)) break;
    }
  } catch (error) {
    if (error?.name === 'QuotaExceededError') failure = 'csvtv:storage-full';
  }
  finally { preparing = false; }
  for (const client of contacted.values()) {
    try { client.postMessage({type:'csvtv:resume',build:SHELL.build,attempt,reason:failure}); } catch { /* The document already closed. */ }
  }
  return failure;
}

// Browser client IDs are strings. A single numeric key in the same database
// records which active build owns cleanup, including across worker restarts.
const maintenanceKey = 0;
const gracePeriod = 60_000;
let nextSweep = 0;
async function bindNavigation(id) {
  // The active build is protected from collection. Check ownership and write
  // its new document's pin atomically, without waiting for cache maintenance.
  const owner = await binding('pages','readwrite', store => {
    const read = store.get(maintenanceKey);
    read.onsuccess = () => {
      if (read.result?.active === SHELL.build) store.put({id,build:SHELL.build,at:Date.now()},id);
    };
    return read;
  });
  if (owner?.active === SHELL.build) return true;
  // A navigation already in flight at activation can race collection. Pin its
  // build only if the collector left those assets available to the new document.
  return cacheLock(async () => {
    if (!await caches.has(cacheName(SHELL.build))) return false;
    await writePin(id,SHELL.build);
    return true;
  });
}
async function collect(activating) {
  await cacheLock(async () => {
    const now = Date.now();
    const owner = await pageBuild(maintenanceKey);
    if (!activating && (owner?.active !== SHELL.build || (owner.at <= now && now - owner.at < gracePeriod))) return;
    const previous = activating && owner?.active !== SHELL.build ? owner?.active : owner?.previous;
    const activatedAt = activating ? now : owner.activatedAt;
    const keep = new Set([SHELL.build]);
    // The old worker can have an in-flight response for a reserved document
    // whose ID is not visible yet. Give it time to record that document's pin.
    if (previous && now - activatedAt < gracePeriod) keep.add(previous);
    // A dedicated worker can request another module after its owner has been
    // suspended. Keep its build until the browser no longer lists its client.
    const clients = await self.clients.matchAll({type:'all',includeUncontrolled:true});
    const live = new Set(clients.filter(client => client.type === 'worker' || appClient(client)).map(client => client.id));
    const expired = [];
    for (const page of await binding('pages','readonly', s => s.getAll())) {
      if (!page.id) continue;
      if (live.has(page.id) || now - page.at < gracePeriod) keep.add(page.build);
      else expired.push(page.id);
    }
    await binding('pages','readwrite', s => {
      for (const id of expired) s.delete(id);
      return s.put({active:SHELL.build,at:now,activatedAt,previous:keep.has(previous) ? previous : undefined},maintenanceKey);
    });
    // A waiting version can be superseded without ever firing activate. Walk our
    // scoped cache names so interrupted installs and superseded versions retire too.
    const prefix = cacheName('');
    for (const name of await caches.keys()) {
      if (!name.startsWith(prefix)) continue;
      const build = name.slice(prefix.length);
      if (!buildHash.test(build) || build === SHELL.build) continue;
      if (keep.has(build) && activating) {
        const cache = await caches.open(name);
        for (const request of await cache.keys()) oldAssets.add(request.url);
      } else if (!keep.has(build) && !self.registration.installing && !self.registration.waiting &&
          (self.serviceWorker ? self.registration.active === self.serviceWorker : activating || self.registration.active?.state === 'activated')) {
        await caches.delete(name);
      }
    }
  });
}
function maintainOnUse(event) {
  const now = Date.now();
  if (now < nextSweep && nextSweep - now <= gracePeriod) return;
  nextSweep = now + gracePeriod;
  event.waitUntil(collect(false).catch(() => { nextSweep = 0; }));
}
async function activateShell() {
  await Promise.all((await pages()).map(async client => {
    if (await pageBuild(client.id)) return;
    // First install can claim an already open, previously uncontrolled app.
    const reply = await ask(client,{type:'csvtv:page-version'},500);
    if (reply?.type === 'csvtv:page-version' && buildHash.test(reply.build)) await bind(client.id,reply.build);
  }));
  await collect(true);
  await self.clients.claim();
  activation = undefined;
}

self.addEventListener('install', event => event.waitUntil(installShell()));
self.addEventListener('activate', event => event.waitUntil(activateShell()));
let activation, repair;
self.addEventListener('message', event => {
  const port = event.ports[0];
  if (!port || !appClient(event.source) || (event.origin && event.origin !== new URL(scope).origin)) return;
  if (event.data?.type === 'csvtv:version' || event.data?.type === 'csvtv:repair') {
    const inventory = event.data.type === 'csvtv:repair'
      ? repair ??= shellComplete(true).finally(() => { repair = undefined; }) : shellComplete(false);
    event.waitUntil(inventory.then(complete =>
      port.postMessage({type:'csvtv:version',build:SHELL.build,complete}), error =>
      port.postMessage({type:'csvtv:version',build:SHELL.build,complete:false,storageFull:error?.name === 'QuotaExceededError'})));
    maintainOnUse(event);
  } else if (event.data?.type === 'csvtv:activation-status') {
    port.postMessage({type:'csvtv:activation-status',attempt:activation?.attempt ?? null,refreshActivation:true});
  } else if (event.data?.type === 'csvtv:activate' || event.data?.type === 'csvtv:activate-on-refresh') {
    if (!isWaiting()) { port.postMessage({type:'csvtv:blocked',build:SHELL.build}); return; }
    if (!activation) {
      const attempt = crypto.randomUUID();
      const refreshClient = event.data.type === 'csvtv:activate-on-refresh' ? event.source.id : undefined;
      activation = {attempt,result:prepareAndActivate(attempt,refreshClient).then(type => {
        if (type !== 'csvtv:activating') activation = undefined;
        return type;
      })};
    }
    event.waitUntil(activation.result.then(type => port.postMessage({type,build:SHELL.build})));
  }
});

async function serve(event, name) {
  const navigation = event.request.mode === 'navigate';
  const pin = !navigation && event.clientId ? await assetPin(event.clientId) : null;
  const build = pin?.build || SHELL.build;
  const url = name === 'index.html' ? index : event.request.url;
  let cached = await caches.match(url,{cacheName:cacheName(build)});
  if (!cached && build === SHELL.build && name) {
    try {
      cached = await getAsset(name);
      await (await caches.open(cacheName(build))).put(url,cached.clone());
    } catch { /* Do not substitute bytes from a different build. */ }
  }
  if (!cached && !name && build === SHELL.build) return fetch(event.request);
  if (cached && navigation && event.resultingClientId) {
    try { if (!await bindNavigation(event.resultingClientId)) cached = undefined; }
    catch { return new Response('Your browser could not open storage for this page. Reopen csvTV to try again.', {status:503}); }
  }
  if (cached && event.request.destination === 'worker' && event.resultingClientId) {
    // The worker's entry request has the originating page's clientId. Its
    // module imports use the new worker clientId, including after an update.
    try { await bind(event.resultingClientId,build); }
    catch { return new Response('The worker could not open this installed version.',{status:503}); }
  }
  if (cached) return cached;
  const message = navigation ? 'This installed version is unavailable. Close all csvTV tabs, then reopen your bookmark while online. Your watch record stays on this device.' :
    'This installed version is unavailable. Reopen csvTV while online.';
  return new Response(message,{status:503});
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || req.headers.has('Authorization') || req.headers.has('Range')) return;
  const url = new URL(req.url);
  const navigation = req.mode === 'navigate';
  // Browsers may expose the navigation fragment. Our #/ routes share the
  // same document; fragment credentials and fragments on assets are unrelated.
  if (navigation && url.hash.startsWith('#/')) url.hash = '';
  // Check the raw query marker too (an explicitly empty '?' is still a different URL).
  if (url.origin !== new URL(scope).origin || url.href.includes('?') || url.hash || url.username || url.password) return;
  let name = assets.get(url.href);
  if (navigation) {
    if (url.href !== scope && url.href !== index) return;
    name = 'index.html';
  } else if (!name && !(event.clientId && oldAssets.has(url.href))) return;
  event.respondWith(serve(event,name));
  maintainOnUse(event);
});
