import type { DeviceStore } from './storage.ts';

type Reply = { type: string; build?: string; complete?: boolean; storageFull?: boolean; attempt?: string | null; refreshActivation?: boolean };
type OfflineAction = 'check' | 'activate' | 'install' | null;
type Preparation = { worker: ServiceWorker; attempt: string; drained: Promise<void> };
type UpdateCheck = { cancel: AbortController; finished: Promise<void>; worker?: ServiceWorker; attempt?: string };

const ready = 'Ready to open offline.';
const upToDate = 'Up to date. Ready to open offline.';
const backgroundInterval = 60_000;
const bookmarkNotice = 'Offline access is installed. Open the page below before saving your bookmark.';
const incomplete = 'Some offline files are missing. Connect to the internet and try again.';
const storageFull = 'There isn’t enough space to save the offline app. Free up device storage and try again.';
const incompleteUpdate = 'The update is missing files. Reconnect and retry the update. Your current version is still available.';
const offlineCheck = 'Connect to the internet to check for an update.';
const blocked = 'Close other csvTV tabs, then try the update again.';
const unavailable = 'Offline access could not be installed. Check your connection and available device storage, then try again.';
const incompatibleFile = 'The available build still cannot read this format. Update csvTV or repair the file in Dropbox.';

// The build marker is near the start of csvTV's head. A host can return a
// decorated page or an error document instead. Stop before keeping its body.
async function documentBuild(response: Response, doc: Document): Promise<string> {
  const mime = response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
  if (response.status !== 200 || response.redirected || mime !== 'text/html' || response.headers.has('Content-Range')) {
    void response.body?.cancel().catch(() => {});
    throw Error('The published app could not be checked.');
  }
  const reader = response.body?.getReader();
  if (!reader) throw Error('Missing published document.');
  const limit = 128 * 1024, decoder = new TextDecoder();
  let head = '', used = 0, complete = false;
  try {
    while (used < limit) {
      const {done,value} = await reader.read();
      if (done) { head += decoder.decode(); break; }
      const chunk = value.subarray(0,limit-used);
      used += chunk.byteLength;
      const searchFrom = Math.max(0, head.length - 6);
      head += decoder.decode(chunk,{stream:true});
      const end = head.slice(searchFrom).search(/<\/head>/i);
      if (end !== -1) { head = head.slice(0,searchFrom+end); complete = true; break; }
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (!complete) throw Error('Incomplete published document.');
  const template = doc.createElement('template');
  template.innerHTML = head;
  const markers = template.content.querySelectorAll<HTMLMetaElement>('meta[name="csvtv-build"]');
  const build = markers.length === 1 ? markers[0].content : '';
  if (!/^[a-f0-9]{64}$/.test(build)) throw Error('Missing published build number.');
  return build;
}

function documentAddress(win:Window) {
  const url = new URL(win.location.origin);
  url.pathname = win.location.pathname;
  return url;
}
// A query keeps this small document request outside the installed worker's offline routes.
async function publishedBuild(win: Window, scope: URL): Promise<string> {
  const url = new URL(scope);
  url.searchParams.set('csvtv-update', String(Date.now()));
  const response = await win.fetch(url, {cache:'no-store', mode:'same-origin', credentials:'same-origin', redirect:'error',
    referrerPolicy:'no-referrer', signal:AbortSignal.timeout(10_000)});
  return documentBuild(response,win.document);
}

function availableWorkers(win:Window):ServiceWorkerContainer|undefined {
  try { return win.navigator.serviceWorker; }
  catch { return undefined; } // Site permissions may deny the getter while IndexedDB still works.
}

/** A failed lazy import can retry the current document, including from the installed offline shell. */
export function moduleReloadButton(feedback: HTMLElement, store: DeviceStore, page?:string) {
  const doc = feedback.ownerDocument, win = doc.defaultView!;
  const button = doc.createElement('button');
  const label = 'Reload csvTV';
  button.type = 'button';
  button.textContent = label;
  button.onclick = async () => {
    if (button.disabled || !button.isConnected) return;
    const address = win.location.href;
    const current = () => button.isConnected && win.location.href === address && (store.role === 'writer' || store.role === 'reader');
    button.disabled = true;
    let checking = false, reloading = false;
    try {
      const startup = (win as Window & {csvTVStartup?:{checkPage?(page:string):Promise<boolean>}}).csvTVStartup;
      if (page && startup?.checkPage && !availableWorkers(win)?.controller) {
        checking = true;
        button.textContent = 'Checking app files…';
        const published = await publishedBuild(win,documentAddress(win));
        if (!current()) return;
        // Uncontrolled WebKit can reuse a successful modulepreload from a previous document.
        // A newer published document will verify its own modules when it starts.
        if (published === doc.querySelector<HTMLMetaElement>('meta[name="csvtv-build"]')?.content && !await startup.checkPage(page)) {
          if (current()) feedback.textContent = 'Could not verify this screen’s files. Reconnect and try again.';
          return;
        }
        checking = false;
      }
      if (!current()) return;
      button.textContent = 'Waiting for changes…';
      await store.afterPendingWrites(() => {
        if (current()) {
          reloading = true;
          button.textContent = 'Reloading…';
          win.location.reload();
        }
      });
    } catch {
      if (current()) feedback.textContent = checking ? 'Could not verify this screen’s files. Reconnect and try again.'
        : 'Could not reload safely. Check that your changes were saved and try again.';
    } finally {
      if (!reloading) { button.disabled = false; button.textContent = label; }
    }
  };
  return button;
}

/** An explicit compatibility check on a site without an installed offline copy. */
export async function reloadOnlineBuild(win: Window, active: () => boolean,
    options: {unchanged?: string; beforeReload?: () => Promise<void>} = {}): Promise<string | undefined> {
  if (!win.navigator.onLine) return 'Connect to the internet to check for a compatible build.';
  try {
    const response = await win.fetch(documentAddress(win), {cache:'reload', mode:'same-origin', credentials:'same-origin', redirect:'error',
      referrerPolicy:'no-referrer', signal:AbortSignal.timeout(10_000)});
    const latest = await documentBuild(response,win.document);
    if (!active()) return;
    const key = 'csvTV/compatibility-reload/' + win.location.pathname;
    const current = win.document.querySelector<HTMLMetaElement>('meta[name="csvtv-build"]')?.content;
    try {
      if (current === latest && win.sessionStorage.getItem(key) === latest) return options.unchanged ?? incompatibleFile;
    } catch { /* The user can still explicitly reload with tab storage disabled. */ }
    // Once a replacement is confirmed, finish admitted IndexedDB writes before
    // destroying this document. Failed or repeated checks keep the current writer.
    await options.beforeReload?.();
    if (!active()) return;
    try { win.sessionStorage.setItem(key, latest); } catch { /* Tab storage is optional. */ }
    win.location.reload();
  } catch { return 'Could not load an updated app. Your record is saved on this device.'; }
}

function request(worker: ServiceWorker, type: string, timeout: number, signal?: AbortSignal, retryAfter?: number): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const ports: MessagePort[] = [];
    let retry: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      clearTimeout(timer);
      clearTimeout(retry);
      for (const port of ports) port.close();
      signal?.removeEventListener('abort', cancel);
      worker.removeEventListener('statechange', changed);
    };
    const cancel = () => { finish(); reject(Error('This service worker request has ended.')); };
    const changed = () => { if (worker.state === 'redundant') cancel(); };
    const timer = setTimeout(() => { finish(); reject(Error('The service worker did not reply.')); }, timeout);
    if (signal?.aborted || worker.state === 'redundant') { cancel(); return; }
    signal?.addEventListener('abort', cancel);
    worker.addEventListener('statechange', changed);
    function send() {
      const channel = new MessageChannel();
      ports.push(channel.port1);
      channel.port1.onmessage = event => { finish(); resolve(event.data); };
      try { worker.postMessage({ type }, [channel.port2]); }
      catch (error) { finish(); reject(error); }
    }
    if (retryAfter !== undefined) retry = setTimeout(send, retryAfter);
    send();
  });
}

function installed(worker: ServiceWorker): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = () => { clearTimeout(timer); worker.removeEventListener('statechange', changed); };
    const changed = () => {
      if (worker.state === 'installing') return;
      finish();
      if (worker.state === 'redundant') reject(Error('Installation failed.'));
      else resolve();
    };
    // Installation has a three-minute whole-release limit in the worker. A
    // slow link can keep making progress on new files for more than a minute.
    const timer = setTimeout(() => { finish(); reject(Error('Installation took too long.')); }, 190_000);
    worker.addEventListener('statechange', changed);
    changed();
  });
}

/** The document owns its database connections. Only an installed waiting worker can ask it to release them. */
export class OfflineShell extends EventTarget {
  readonly build: string;
  readonly #win: Window;
  readonly #stop: (reason?: string) => Promise<void>;
  readonly #reopen: (message: string) => void;
  readonly #scope: URL;
  readonly #workers?: ServiceWorkerContainer;
  readonly canonical: boolean;
  #registration?: ServiceWorkerRegistration;
  #latestInstall?: ServiceWorker;
  #registrationJob?: Promise<ServiceWorkerRegistration>;
  #preparing?: Preparation;
  #recoveryTimer?: number;
  #messages: Promise<void> = Promise.resolve();
  #versionRead?: {worker: ServiceWorker; reply: Promise<Reply>};
  #verificationFailed = false;
  #reloading = false;
  #updating?: UpdateCheck;
  #lastDiscovery?: number;
  #refresh?: AbortController;
  #refreshWorker?: ServiceWorker;
  #statusRevision = 0;
  status = 'Preparing offline access…';
  action: OfflineAction = null;

  constructor(win: Window, stop: (reason?: string) => Promise<void>, reopen: (message: string) => void) {
    super();
    this.#win = win;
    this.#stop = stop;
    this.#reopen = reopen;
    this.#scope = new URL('./', win.location.href);
    this.canonical = [this.#scope.pathname, this.#scope.pathname + 'index.html'].includes(win.location.pathname);
    this.build = win.document.querySelector<HTMLMetaElement>('meta[name="csvtv-build"]')?.content ?? '';
    if (!this.canonical) return;
    this.#workers = availableWorkers(win);
    this.#workers?.addEventListener('message', event => {
      if (event.data?.type === 'csvtv:page-version') {
        if (this.#ours(event.source as ServiceWorker)) event.ports[0]?.postMessage({ type: 'csvtv:page-version', build: this.build });
      } else {
        // A delayed database open must not reorder a later release or a replacement worker's request.
        this.#messages = this.#messages.then(() => this.#message(event)).catch(() => {});
      }
    });
    this.#workers?.addEventListener('controllerchange', () => void this.#controllerChanged());
  }

  get paused() { return !!this.#preparing || this.#reloading; }
  get supported() { return !!this.#workers; }
  get installedCopy() {
    return this.#ours(this.#workers?.controller) || !!this.#registration?.active || !!this.#registration?.waiting;
  }
  get bookmarkHref() {
    const url = new URL(this.#win.location.href);
    if (url.hash.startsWith('#/')) url.hash = '';
    return url.href === this.#scope.href || url.href === new URL('index.html', this.#scope).href
      ? undefined : new URL('#/settings', this.#scope).href;
  }
  #ours(worker?: ServiceWorker | null) { return worker?.scriptURL === new URL('service-worker.js', this.#scope).href; }

  #set(status: string, action: OfflineAction) {
    this.#statusRevision++;
    this.status = (status === ready || status === upToDate) && this.bookmarkHref ? bookmarkNotice : status;
    this.action = action;
    this.dispatchEvent(new Event('change'));
  }
  #setAvailability(reply: Reply, available = ready) {
    if (reply.complete === false) this.#set(reply.storageFull ? storageFull : incomplete, 'install');
    else this.#set(available, 'check');
  }

  async #message(event: MessageEvent) {
    const port = event.ports[0];
    const worker = event.source;
    if (!(worker instanceof ServiceWorker) || !this.#ours(worker)) return;
    const attempt = event.data?.attempt;
    if (typeof attempt !== 'string') return;
    if (event.data.type === 'csvtv:resume') {
      const prepared = this.#preparing;
      if (prepared?.worker === worker && prepared.attempt === attempt) {
        const reason = event.data.reason;
        await this.#resume(prepared, reason === 'csvtv:incomplete' ? incompleteUpdate :
          reason === 'csvtv:deferred' ? 'Update available.' : blocked);
      }
      return;
    }
    if (event.data?.type !== 'csvtv:prepare' || !port) return;
    const registration = this.#registration ?? await this.#workers?.getRegistration(this.#scope.href);
    if (registration?.waiting !== worker) return;
    if (event.data.refresh && (this.#refreshWorker !== worker || !this.#canApplyOnRefresh() || this.#hasRestoredDraft())) {
      port.postMessage({type:'csvtv:deferred', attempt});
      return;
    }
    if (this.#updating?.worker === worker) this.#updating.attempt = attempt;
    const prepared = { worker, attempt, drained: this.#preparing?.drained ?? this.#stop() };
    this.#preparing = prepared;
    this.#scheduleRecovery(prepared);
    await prepared.drained;
    if (this.#preparing === prepared) port.postMessage({ type: 'csvtv:ready', pageBuild: this.build, attempt });
  }

  async #resume(prepared: Preparation, reason = blocked) {
    await prepared.drained;
    if (this.#preparing !== prepared || this.#reloading) return;
    const active = this.#registration?.active;
    if (active && this.#ours(active) && active !== this.#workers?.controller) {
      // Another worker may already be activating. Its claim will revalidate this document.
      const version = await request(active, 'csvtv:version', 3000);
      if (version.build !== this.build || this.#preparing !== prepared || this.#reloading) return;
    }
    this.#win.clearTimeout(this.#recoveryTimer);
    this.#preparing = undefined;
    if (this.#updating?.worker === prepared.worker && this.#updating.attempt === prepared.attempt) {
      this.#updating.cancel.abort();
      this.#updating = undefined;
    }
    this.#set(reason, 'activate');
    this.#reopen(reason === 'Update available.' ? '' : reason); // Verify the controller before reopening the database.
  }

  #scheduleRecovery(prepared: Preparation) {
    this.#win.clearTimeout(this.#recoveryTimer);
    this.#recoveryTimer = this.#win.setTimeout(() => void this.#recover(prepared), 4500);
  }

  async #recover(prepared: Preparation) {
    if (this.#preparing !== prepared || this.#reloading) return;
    try {
      const registration = await this.#workers?.getRegistration(this.#scope.href);
      if (registration?.active === prepared.worker) {
        await this.canOpen(); // Wait for this controller's claim, then reload once.
      } else if (registration?.waiting !== prepared.worker) {
        await this.#resume(prepared);
      } else {
        const reply = await request(prepared.worker, 'csvtv:activation-status', 3000);
        if (reply.type === 'csvtv:activation-status' && reply.attempt !== prepared.attempt &&
            registration.active !== prepared.worker) await this.#resume(prepared);
      }
    } catch { /* A sleeping browser worker can be contacted again once this tab is active. */ }
    if (this.#preparing === prepared && !this.#reloading) this.#scheduleRecovery(prepared);
  }

  async #version(worker: ServiceWorker): Promise<Reply> {
    if (this.#versionRead?.worker === worker) return this.#versionRead.reply;
    // Startup and registration can check the same cold worker together. Accept either
    // genuine reply if delivery is delayed, with one reminder and a bounded wait.
    const check = {worker, reply:request(worker, 'csvtv:version', 12_000, undefined, 4000)};
    this.#versionRead = check;
    try { return await check.reply; }
    finally { if (this.#versionRead === check) this.#versionRead = undefined; }
  }

  /** Check before opening a writer, including when returning from the browser's back/forward cache. */
  async canOpen(update?: UpdateCheck): Promise<boolean> {
    const statusRevision = this.#statusRevision;
    const controller = this.#workers?.controller;
    if (this.canonical && controller && this.#ours(controller)) {
      let reply: Reply;
      try {
        reply = await this.#version(controller);
        if (reply.type !== 'csvtv:version' || !reply.build) throw Error('Unknown app version.');
      } catch (error) {
        if (controller !== this.#workers?.controller) return this.canOpen(update);
        this.#verificationFailed = true;
        throw error;
      }
      if (controller !== this.#workers?.controller) return this.canOpen(update);
      const key = 'csvTV/shell-reload/' + this.#scope.pathname;
      if (reply.build !== this.build) {
        if (!this.#reloading) {
          let repeated = false;
          try {
            repeated = this.#win.sessionStorage.getItem(key) === reply.build;
            this.#win.sessionStorage.setItem(key, reply.build!);
          } catch { /* The installed shell can still serve its canonical URL. */ }
          if (repeated) throw Error('The updated app document could not be opened.');
          this.#reloading = true;
          await this.#stop();
          const url = new URL(this.#win.location.href);
          if (url.search) {
            url.search = '';
            this.#win.location.replace(url.href);
          } else this.#win.location.reload();
        }
        return false;
      }
      try { this.#win.sessionStorage.removeItem(key); } catch { /* Tab storage can be disabled. */ }
      if (statusRevision === this.#statusRevision && !this.#registration?.waiting && !this.#registration?.installing &&
          (!this.#updating || this.#updating === update) && !this.paused) this.#setAvailability(reply);
    }
    return !this.paused;
  }

  async #recheck() {
    if (await this.canOpen() && this.#verificationFailed) {
      this.#verificationFailed = false;
      this.#reopen('');
    }
  }

  checkAvailability() {
    if ([ready, bookmarkNotice, incomplete, offlineCheck].includes(this.status)) {
      const revision = this.#statusRevision;
      void this.#recheck().catch(() => {
        if (revision === this.#statusRevision) this.#set('Could not check offline access. Try again.', 'install');
      });
    }
  }

  discoverInBackground() {
    const registration = this.#registration;
    if (!registration?.active || registration.waiting || registration.installing || this.#updating || this.paused ||
        !this.#win.navigator.onLine || this.#win.document.visibilityState === 'hidden') return;
    const now = Date.now();
    if (this.#lastDiscovery !== undefined && now >= this.#lastDiscovery && now - this.#lastDiscovery < backgroundInterval) return;
    this.#lastDiscovery = now;
    if (this.#canApplyOnRefresh()) void this.#discover(registration, true).catch(() => {});
    else void registration.update().catch(() => {});
  }

  #canApplyOnRefresh() {
    return !!this.#refresh && !this.#refresh.signal.aborted && this.#win.navigator.onLine &&
      this.#win.document.visibilityState === 'visible' && !this.#win.document.querySelector('dialog[open]');
  }

  #hasRestoredDraft() {
    // Browser form restoration and password managers can populate an editor without dispatching input.
    const fields = this.#win.document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
      'textarea,input:not([type]),input:is([type=text],[type=search],[type=password],[type=file],[type=number],[type=url],[type=email])');
    return [...fields].some(field => field.value !== field.defaultValue);
  }

  #observeRefresh() {
    const win = this.#win;
    const navigation = win.performance?.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    if (navigation?.type !== 'reload' || win.location.search || win.document.visibilityState !== 'visible' ||
        !win.navigator.onLine || !this.#ours(this.#workers?.controller)) return;
    try {
      // canOpen clears this marker after the new document verifies its controller.
      if (win.sessionStorage.getItem('csvTV/shell-reload/' + this.#scope.pathname)) return;
    } catch { return; }
    const guard = this.#refresh = new AbortController();
    const cancel = () => guard.abort();
    const options = {capture:true, passive:true, signal:guard.signal};
    for (const event of ['pointerdown','click','keydown','wheel','compositionstart','beforeinput','input','change','submit','hashchange','popstate','pagehide']) {
      win.addEventListener(event, cancel, options);
    }
    win.document.addEventListener('visibilitychange', cancel, options);
    const deadline = win.setTimeout(cancel, 30_000);
    guard.signal.addEventListener('abort', () => win.clearTimeout(deadline), {once:true});
  }

  #offerWaiting(worker: ServiceWorker) {
    this.#set('Update available.', 'activate');
    if (!this.#canApplyOnRefresh() || this.#refreshWorker || this.#updating) return;
    this.#refreshWorker = worker;
    void this.#update(false, incompatibleFile, worker);
  }

  async #controllerChanged() {
    try {
      await this.#recheck();
    } catch {
      const reason = 'Could not verify the installed app. Reopen csvTV to try again.';
      this.#set(reason, 'install');
      await this.#stop(reason);
    }
  }

  #watch(worker: ServiceWorker) {
    this.#latestInstall = worker;
    const changed = () => {
      if (worker.state === 'installed' && this.#registration?.waiting === worker) this.#offerWaiting(worker);
      if (worker.state === 'redundant') {
        worker.removeEventListener('statechange', changed);
        if (this.paused || this.#updating || this.#latestInstall !== worker) return;
        if (this.#registration?.waiting && this.#registration.waiting !== worker) this.#set('Update available.', 'activate');
        else if (!this.#registration?.installing || this.#registration.installing === worker) this.#set(this.#registration?.active
          ? 'The update could not be installed. Try again when online.' : unavailable, 'install');
      }
      if (worker.state === 'activated') {
        worker.removeEventListener('statechange', changed);
        void this.#controllerChanged();
      }
    };
    worker.addEventListener('statechange', changed);
    changed();
  }

  async #register(): Promise<ServiceWorkerRegistration> {
    const workers = this.#workers;
    if (!workers) throw Error('Offline access is unavailable.');
    const existing = await workers.getRegistration(this.#scope.href);
    const same = existing?.scope === this.#scope.href && [existing.active, existing.waiting, existing.installing].some(worker => this.#ours(worker));
    const registration = same ? existing : await workers.register(
      new URL('service-worker.js', this.#scope), { scope: this.#scope.href, updateViaCache: 'none' });
    if (this.#registration !== registration) {
      this.#registration = registration;
      registration.addEventListener('updatefound', () => { if (registration.installing) this.#watch(registration.installing); });
      if (registration.installing) this.#watch(registration.installing);
    }
    if (registration.waiting) this.#offerWaiting(registration.waiting);
    return registration;
  }

  #registerOnce() {
    this.#registrationJob ??= this.#register().finally(() => { this.#registrationJob = undefined; });
    return this.#registrationJob;
  }

  start(allowRefreshUpdate = true) {
    if (!this.canonical) {
      this.#set('Open the csvTV home page to enable offline access.', null);
      return;
    }
    if (!this.supported) {
      this.#set('Offline access is unavailable in this browser. Check site permissions and open csvTV over HTTPS or localhost.', null);
      return;
    }
    if (allowRefreshUpdate) this.#observeRefresh();
    void this.#registerOnce().then(async registration => {
      if (registration.waiting || !registration.active) return;
      await this.#recheck();
      this.discoverInBackground();
    }).catch(() => this.#set(unavailable, 'install'));
  }

  async #discover(registration: ServiceWorkerRegistration, background = false) {
    const active = registration.active;
    const delays = [1000, 3000, 6000];
    for (let attempt = 0; ; attempt++) {
      if (registration.waiting || registration.active !== active) return;
      if (background && !this.#canApplyOnRefresh()) return;
      if (!this.#win.navigator.onLine) throw Error(offlineCheck);
      this.#lastDiscovery = Date.now();
      let failed = false;
      try {
        if (!registration.installing) await registration.update();
        const worker = registration.installing;
        if (worker) {
          if (active && !background) this.#set('Downloading update…', null);
          await installed(worker);
        }
      } catch (error) {
        if (!active) throw error;
        failed = true;
      }
      if (registration.waiting || registration.active !== active || !active) return;
      let latest: string | undefined;
      try { latest = await publishedBuild(this.#win, this.#scope); }
      catch (error) { if (attempt === delays.length) throw error; }
      if (registration.waiting || registration.active !== active) return;
      if (!failed && !registration.installing && latest === this.build) return;
      if (attempt === delays.length) return 'The update is still becoming available. Try again shortly.';
      if (!background) this.#set('Waiting for the published update…', null);
      await new Promise<void>(resolve => setTimeout(resolve, delays[attempt]));
    }
  }

  async update(compatibility = false, unchanged = incompatibleFile): Promise<string> {
    this.#refresh?.abort();
    return this.#update(compatibility, unchanged);
  }

  async #update(compatibility: boolean, unchanged: string, refreshWorker?: ServiceWorker): Promise<string> {
    const ongoing = this.#updating;
    if (ongoing) {
      // updatefound can offer Reload while the prior check is still awaiting its repair reply.
      if ((!ongoing.worker || ongoing.worker === this.#refreshWorker) && this.action === 'activate') {
        await ongoing.finished;
        if (this.action === 'activate') return this.update(compatibility, unchanged);
      }
      return this.status;
    }
    const activate = compatibility || this.action === 'activate';
    const repairing = this.action === 'install';
    let finish!: () => void;
    const finished = new Promise<void>(resolve => { finish = resolve; });
    const check: UpdateCheck = { cancel: new AbortController(), finished };
    this.#updating = check;
    let previousActive: ServiceWorker | null | undefined;
    try {
      const registration = refreshWorker ? this.#registration! : await this.#registerOnce();
      previousActive = registration.active;
      if (refreshWorker && (!registration.active || registration.waiting !== refreshWorker)) return this.status;
      if (!registration.waiting) {
        if (!this.#win.navigator.onLine) {
          if (compatibility) return 'Connect to the internet to check for a compatible build. No installed update is waiting.';
          this.#set(offlineCheck, this.action === 'install' ? 'install' : 'check');
          return this.status;
        }
        this.#set('Checking for an update…', null);
        const pending = await this.#discover(registration);
        if (pending) { this.#set(pending, 'check'); return pending; }
      }
      const waiting = registration.waiting;
      if (!registration.active && (waiting || registration.installing)) {
        this.#set('Preparing offline access…', null);
        return this.status;
      }
      if (!waiting) {
        if (!registration.active) throw Error('No installed shell.');
        const controller = this.#workers?.controller;
        if (!controller || !this.#ours(controller)) {
          this.#set('Preparing offline access…', null);
          return this.status;
        }
        if (registration.active !== previousActive) {
          if (controller === registration.active) await this.canOpen(check);
          else this.#set('Preparing offline access…', null);
          return this.status;
        }
        const reply = await request(controller, 'csvtv:repair', 190_000, check.cancel.signal);
        if (registration.waiting) {
          this.#set('Update available.', 'activate');
          return this.status;
        }
        if (registration.installing || controller !== this.#workers?.controller || registration.active !== controller) {
          this.#set('Preparing offline access…', null);
          if (!registration.installing && registration.active === this.#workers?.controller) await this.canOpen(check);
          return this.status;
        }
        if (reply.type !== 'csvtv:version' || reply.build !== this.build) throw Error('The installed version changed.');
        this.#setAvailability(reply, compatibility ? unchanged : repairing ? ready : upToDate);
        return this.status;
      }
      if (!activate) {
        this.#set('Update available.', 'activate');
        return this.status;
      }
      check.worker = waiting;
      if (refreshWorker) {
        // A rollback can install a worker that only understands manual activation.
        const features = await request(waiting, 'csvtv:activation-status', 3000, check.cancel.signal);
        if (!features.refreshActivation || !this.#canApplyOnRefresh() || registration.waiting !== waiting) return this.status;
      } else this.#set('Updating csvTV…', null);
      const reply = await request(waiting, refreshWorker ? 'csvtv:activate-on-refresh' : 'csvtv:activate', 60_000, check.cancel.signal);
      if (reply.type === 'csvtv:deferred') { this.#set('Update available.', 'activate'); return this.status; }
      if (reply.type !== 'csvtv:activating') {
        const reason = reply.type === 'csvtv:storage-full' ? storageFull : reply.type === 'csvtv:incomplete' ? incompleteUpdate : blocked;
        this.#set(reason, 'activate');
        return reason;
      }
      // controllerchange compares the new build before reloading, in every tab.
      return this.status;
    } catch {
      if (check.cancel.signal.aborted) return this.status;
      if (refreshWorker && this.#registration?.waiting === refreshWorker) {
        this.#set('Update available.', 'activate');
        return this.status;
      }
      if (this.#registration?.waiting && this.#registration.waiting !== check.worker) {
        this.#set('Update available.', 'activate');
        return this.status;
      }
      const active = this.#registration?.active;
      if (previousActive !== undefined && active && active !== previousActive && this.#ours(active)) {
        if (this.#workers?.controller !== active) {
          this.#set('Preparing offline access…', null);
          return this.status;
        }
        try { await this.canOpen(check); return this.status; }
        catch { /* A replacement must answer the version check before it is ready. */ }
      }
      const message = this.#registration?.active
        ? 'Could not complete the update. Try again when online.' : unavailable;
      this.#set(message, 'install');
      return message;
    } finally {
      if (this.#updating === check) this.#updating = undefined;
      finish();
    }
  }
}

export function mountOfflineSettings(content: HTMLElement, shell?: OfflineShell) {
  const section = content.ownerDocument.createElement('section');
  section.className = 'group offline-settings';
  content.append(section);
  if (!shell) {
    section.innerHTML = '<h2>Offline access</h2>';
    return () => {};
  }
  section.innerHTML = '<h2>Offline access</h2><p role="status" data-offline-status></p><div class="offline-actions">' +
    '<button type="button" data-offline-update></button><a data-offline-bookmark hidden>Open the page to bookmark</a></div>';
  const status = section.querySelector<HTMLElement>('[data-offline-status]')!;
  const button = section.querySelector<HTMLButtonElement>('[data-offline-update]')!;
  const bookmark = section.querySelector<HTMLAnchorElement>('[data-offline-bookmark]')!;
  bookmark.tabIndex = 0;
  const render = () => {
    status.textContent = shell.status;
    bookmark.hidden = shell.status !== bookmarkNotice;
    if (!bookmark.hidden) bookmark.href = shell.bookmarkHref!;
    button.hidden = shell.action === null;
    button.textContent = shell.action === 'activate' ? 'Reload to update' : shell.action === 'install' ? 'Try again' : 'Check for update';
  };
  button.onclick = () => void shell.update();
  const reconnected = () => { if (shell.status === offlineCheck) shell.checkAvailability(); shell.discoverInBackground(); };
  const discover = () => shell.discoverInBackground();
  const win = content.ownerDocument.defaultView;
  shell.addEventListener('change', render);
  win?.addEventListener('online', reconnected);
  content.ownerDocument.addEventListener('visibilitychange', discover);
  const timer = win?.setInterval(discover, backgroundInterval);
  render();
  shell.checkAvailability();
  discover();
  return () => {
    shell.removeEventListener('change', render);
    win?.removeEventListener('online', reconnected);
    content.ownerDocument.removeEventListener('visibilitychange', discover);
    win?.clearInterval(timer);
  };
}
