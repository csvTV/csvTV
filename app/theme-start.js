// Runs before styles or visible content. IndexedDB confirms this cached choice
// when the app opens, including after site storage has been cleared.
{
  let preference;
  try { preference = localStorage.getItem('csvTV-appearance'); } catch { /* Use the default. */ }
  const light = preference === 'light' || (preference === 'device' && matchMedia('(prefers-color-scheme: light)').matches);
  document.documentElement.dataset.theme = light ? 'light' : 'dark';
  document.querySelector('meta[name="theme-color"]').content = light ? '#f6f6f7' : '#0a0a0c';
}

// Prepare the established tab handoff before any version of the application
// entry can run. Only a memory-only return needs the compatible module.
const csvTVStartupReturn = (() => {
  try {
    const query = new URLSearchParams(location.search);
    if (!query.has('code') && !query.has('error')) return;
    const protocol = (/* Dropbox return protocol */ () => null)();
    let prepared = protocol.prepareDropboxCallback(window);
    const durable = prepared.canResumeAfterReload;
    if (!durable) {
      window.csvTVReturnReady = import('./dropbox-return.js')
        .then(module => module.keepDropboxReturn(prepared)).catch(() => {});
    }
    return {
      canResume: () => !!prepared?.canResumeAfterReload,
      release(olderEntry) {
        // The current entry owns its memory-only return until the database opens.
        if (durable || olderEntry) prepared?.forget();
        prepared = undefined;
      }
    };
  } catch { /* The module entry can also capture a return itself. */ }
})();

// A site permission can deny this getter while the ordinary online app still works.
const csvTVStartupWorkers = (() => {
  try { return navigator.serviceWorker; } catch { return undefined; }
})();
// Installed documents already have their modules in the pinned offline shell.
try {
  if (!csvTVStartupWorkers?.controller) {
    const files = /* startup dependencies */ {};
    const build = document.querySelector('meta[name="csvtv-build"]').content;
    const key = 'csvTV/startup/' + location.pathname;
    const slowKey = key + '/slow-files';
    // History state survives an ordinary reload when optional Web Storage is denied.
    const tab = {
      read(name) {
        try { return sessionStorage.getItem(name); }
        catch { return history.state?.[name]; }
      },
      write(name,value) {
        try { sessionStorage.setItem(name,value); }
        catch { history.replaceState({...history.state,[name]:value},''); }
      }
    };
    let previous, slowFiles = false;
    try {
      previous = tab.read(key);
      slowFiles = tab.read(slowKey) === build;
      if (!previous) tab.write(key, build);
    } catch { /* The app can still start without tab storage. */ }

    const changed = !!previous && previous !== build;
    const clock = () => window.performance?.now() ?? Date.now();
    // Chrome can carry sticky user activation across a reload. Only input in
    // this document should interrupt its automatic file check.
    const interactions = ['pointerdown','click','keydown','wheel','compositionstart','beforeinput','input','change','submit','hashchange','popstate','pagehide'];
    let touched = false;
    if (changed) {
      const early = new AbortController();
      const touch = () => { touched = true; early.abort(); };
      for (const event of interactions) window.addEventListener(event,touch,{capture:true,passive:true,signal:early.signal});
      document.addEventListener('DOMContentLoaded',() => early.abort(),{once:true});
    }

    // An uncontrolled WebKit tab can retain a previous document's modulepreloads
    // across a release even when the server requires HTTP revalidation.
    window.csvTVStartup = {
      changed,
      async refresh(manual = false) {
        const attempt = key + '/refresh';
        if (!manual) {
          if (touched || tab.read(attempt) === build) return false;
          tab.write(attempt,build);
          if (tab.read(attempt) !== build) return false;
        }
        const started = clock();
        if (!await verifyFiles(Object.entries({...files.base,...files.record}),files.hash,manual ? 'reload' : 'no-cache')) return false;
        try { tab.write(key,build); } catch { if (!manual) return false; }
        // On a slow connection WebKit can time out queued module requests when
        // optional hints compete with the entry's own imports after the reload.
        try {
          if (clock() - started >= 30_000) tab.write(slowKey,build);
          else if (slowFiles) tab.write(slowKey,'');
        } catch { /* The hints are optional. */ }
        location.reload();
        return true;
      },
      async checkPage(page) {
        if (!Object.hasOwn(files.routes,page)) return true;
        const group = files.routes[page];
        return verifyFiles(files.groups[group].map(name => [name,files.record[name]]),files.groupHashes[group],'reload');
      }
    };
    async function verifyFiles(entries,expected,cache) {
      const controller = new AbortController();
      const cancel = () => controller.abort();
      const timeout = setTimeout(cancel, 180000);
      try {
        for (const event of interactions) {
          window.addEventListener(event,cancel,{capture:true,passive:true,signal:controller.signal});
        }
        const digests = new Array(entries.length);
        const queue = entries.entries();
        async function reloadFile(name,size,progress) {
          const response = await fetch('./' + name, {cache, mode:'same-origin', credentials:'same-origin',
            redirect:'error', referrerPolicy:'no-referrer', signal:controller.signal});
          progress();
          const mime = response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
          if (response.status !== 200 || !/^(application|text)\/(javascript|ecmascript)$/.test(mime) ||
              response.headers.has('Content-Range') || /^attachment\b/i.test(response.headers.get('Content-Disposition') || '')) {
            void response.body?.cancel().catch(() => {});
            throw Error('App file unavailable');
          }
          const reader = response.body?.getReader();
          if (!reader) throw Error('App file unavailable');
          const bytes = new Uint8Array(size);
          let offset = 0;
          try {
            for (;;) {
              const {done,value} = await reader.read();
              if (done) break;
              if (value.byteLength > size-offset) {
                void reader.cancel().catch(() => {});
                throw Error('App file exceeds its release size');
              }
              bytes.set(value,offset);
              offset += value.byteLength;
              if (value.byteLength) progress();
            }
          } finally { reader.releaseLock(); }
          if (offset !== size) throw Error('Incomplete app file');
          return new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
        }
        async function recover() {
          for (const [index,[name,size]] of queue) {
            if (controller.signal.aborted) return;
            let deadline;
            const progress = () => { clearTimeout(deadline); deadline = setTimeout(cancel,50000); };
            progress();
            try { digests[index] = await reloadFile(name,size,progress); }
            finally { clearTimeout(deadline); }
          }
        }
        await Promise.all(Array.from({length:Math.min(8,entries.length)},recover));
        if (controller.signal.aborted) return false;
        // The packaged order is stable. One checksum covers every requested
        // module without adding an individual digest to each preload hint.
        const manifest = new Uint8Array(digests.length * 32);
        digests.forEach((digest,i) => manifest.set(digest,i*32));
        const hash = new Uint8Array(await crypto.subtle.digest('SHA-256',manifest));
        return !controller.signal.aborted && Array.from(hash,b => b.toString(16).padStart(2,'0')).join('') === expected;
      } finally {
        clearTimeout(timeout);
        controller.abort();
      }
    }
    if (!window.csvTVStartup.changed && !slowFiles && document.createElement('link').relList.supports('modulepreload')) {
      let returning = Boolean(previous || (location.hash?.startsWith('#/') && location.hash !== '#/home'));
      try { returning ||= Boolean(localStorage.getItem('csvTV-public-dropbox-app-key')); } catch { /* Optional preload hint. */ }
      const path = (location.hash || '').slice(2).split('?')[0].split('/');
      const page = path[0] === 'show' && path[2] === 'season' ? 'season' : path[0] || 'home';
      const pending = [], requested = new Set();
      let active = 0;
      function preloadNext() {
        // Leave room for the entry and styles. WebKit can time out in a queue of unbounded hints.
        while (pending.length && active < 16) {
          const link = document.createElement('link');
          link.rel = 'modulepreload';
          link.href = './' + pending.shift();
          active++;
          link.onload = link.onerror = () => { link.remove(); active--; preloadNext(); };
          document.head.append(link);
        }
      }
      function hint(names) {
        for (const name of names) if (!requested.has(name)) { requested.add(name); pending.push(name); }
        preloadNext();
      }
      window.csvTVStartup.preloadPage = page => {
        try { if (Object.hasOwn(files.routes,page)) hint(files.groups[files.routes[page]]); }
        catch { /* The browser can still resolve the route's imports normally. */ }
      };
      hint(Object.keys(files.base).filter(name => name !== 'main.js'));
      if (returning) window.csvTVStartup.preloadPage(page);
    }
  }
} catch { /* The module entry still loads when optional hints are unavailable. */ }

// Deferred modules run before DOMContentLoaded. If a dependency could not
// load or link, main.js never ran and the original status is still in place.
document.addEventListener('DOMContentLoaded', async () => {
  if (window.csvTVReturnReady) await window.csvTVReturnReady;
  const opening = document.querySelector('#app > [data-opening]');
  if (!opening) {
    const olderEntry = !!window.csvTVReturnReady;
    csvTVStartupReturn?.release(olderEntry);
    if (olderEntry) {
      // A cached older entry can read the durable handoff but cannot claim a
      // memory-only return. Keep its screen usable and explain how to finish.
      delete window.csvTVReturnReady;
      const notice = document.createElement('p');
      notice.setAttribute('role','status');
      notice.textContent = 'Sign in to Dropbox again to finish connecting with this version of csvTV.';
      document.querySelector('#app')?.before(notice);
    }
    return;
  }
  const reopen = 'Close all csvTV tabs, then reopen this bookmark. Your watch record stays on this device.';
  // main.js could not run, so there is no database connection or writer to
  // drain. If a newer release is waiting, use its single-tab handoff.
  async function recoverInstalled() {
    const workers = csvTVStartupWorkers;
    const scope = new URL('./',location.href);
    const script = new URL('service-worker.js',scope).href;
    const registration = await workers?.getRegistration(scope.href);
    if (registration?.scope !== scope.href || workers.controller?.scriptURL !== script) return reopen;
    function waitFor(target,event,ready,ms) {
      return new Promise(resolve => {
        function finish(result) {
          clearTimeout(timer);
          target.removeEventListener(event,changed);
          resolve(result);
        }
        function changed() { if (ready()) finish(true); }
        const timer = setTimeout(() => finish(false),ms);
        target.addEventListener(event,changed);
        changed();
      });
    }
    function ask(worker,type,ms) {
      return new Promise(resolve => {
        const channel = new MessageChannel();
        function finish(value) { clearTimeout(timer); channel.port1.close(); resolve(value); }
        const timer = setTimeout(() => finish(null),ms);
        channel.port1.onmessage = event => finish(event.data);
        try { worker.postMessage({type},[channel.port2]); } catch { finish(null); }
      });
    }
    if (!registration.waiting && !registration.installing && navigator.onLine) {
      let timer;
      try {
        await Promise.race([registration.update().catch(() => {}),new Promise(done => { timer = setTimeout(done,15000); })]);
      } finally { clearTimeout(timer); }
    }
    const installing = registration.installing;
    if (installing?.scriptURL === script) {
      opening.textContent = 'Downloading updated app files…';
      await waitFor(installing,'statechange',() => installing.state !== 'installing',190000);
    }
    const waiting = registration.waiting, active = workers.controller;
    if (!opening.isConnected || !active || active.scriptURL !== script) return reopen;
    if (!waiting) {
      opening.textContent = 'Checking installed app files…';
      const status = await ask(active,'csvtv:repair',190000);
      if (status?.type === 'csvtv:version' && status.complete && opening.isConnected) {
        location.reload();
        return;
      }
      if (status?.storageFull) return 'Free up device storage, then try again.';
      return 'Some app files are still unavailable. Reconnect and try again. ' + reopen;
    }
    if (waiting.scriptURL !== script || !(await ask(waiting,'csvtv:activation-status',3000))?.refreshActivation) return reopen;
    const pageBuild = document.querySelector('meta[name="csvtv-build"]')?.content;
    if (!/^[a-f0-9]{64}$/.test(pageBuild || '')) return reopen;
    function prepare(event) {
      if (opening.isConnected && registration.waiting === waiting && event.source === waiting &&
          event.data?.type === 'csvtv:prepare' && event.data.refresh === true && typeof event.data.attempt === 'string') {
        event.ports[0]?.postMessage({type:'csvtv:ready',pageBuild,attempt:event.data.attempt});
      }
    }
    workers.addEventListener('message',prepare);
    try {
      const reply = await ask(waiting,'csvtv:activate-on-refresh',21000);
      if (reply?.type === 'csvtv:deferred' || reply?.type === 'csvtv:blocked') return 'Close other csvTV tabs, then try again.';
      if (reply?.type === 'csvtv:storage-full') return 'Free up device storage, then try again.';
      if (reply?.type === 'csvtv:activating' && await waitFor(workers,'controllerchange',() => workers.controller === waiting,12000) && opening.isConnected) {
        location.reload();
        return;
      }
      return reopen;
    } finally { workers.removeEventListener('message',prepare); }
  }
  const canResume = csvTVStartupReturn?.canResume;
  function requestNewSignIn() {
    csvTVStartupReturn?.release(true);
    delete window.csvTVReturnReady;
    opening.textContent = 'Open csvTV in a new tab and sign in to Dropbox again.';
    const link = document.createElement('a');
    link.href = location.origin + location.pathname;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.className = 'button';
    link.textContent = 'Open csvTV to sign in again';
    opening.after(link);
    return link;
  }
  if (canResume && !canResume()) { requestNewSignIn(); return; }
  opening.textContent = canResume ? 'Retry in this tab to finish signing in to Dropbox.'
    : 'Some app files could not load. Reconnect and try again.';
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.textContent = 'Try again';
  retry.addEventListener('click', async () => {
    if (canResume && !canResume()) { retry.remove(); requestNewSignIn().focus(); return; }
    const focused = document.activeElement === retry;
    retry.disabled = true;
    opening.textContent = 'Reloading app files…';
    let failure = 'The app files are still unavailable. Reconnect and try again.';
    try {
      if (csvTVStartupWorkers?.controller) { failure = await recoverInstalled(); if (!failure) return; }
      else if (window.csvTVStartup) { if (await window.csvTVStartup.refresh(true)) return; }
      else { location.reload(); return; }
    } catch { /* Allow another manual retry. */ }
    opening.textContent = failure;
    retry.disabled = false;
    if (focused && document.activeElement === document.body) retry.focus({preventScroll:true});
  });
  opening.after(retry);
}, {once:true});
