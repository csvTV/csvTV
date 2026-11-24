import { localCalendarDate } from './progress.ts';
import { TmdbDetailJob } from './tmdb-refresh.ts';
import { TmdbService } from './tmdb-service.ts';
import type { TableName } from './model.ts';
import type { MdbListService } from './mdblist-service.ts';
import type { ImdbService } from './imdb-service.ts';
import type { MalService } from './mal-service.ts';
import { RatingRefreshJob } from './rating-refresh-job.ts';

/** Connect the refresh policy to app-open, tab, network, and committed-record events. */
export class TmdbLibrary extends EventTarget {
  readonly service: TmdbService;
  readonly job: TmdbDetailJob;
  #closed = false;
  #ready = false;
  #active: Promise<void> | null = null;
  #again = false;
  #generation = 0;
  #runs = 0;
  #targets?: ReturnType<TmdbService['store']['metadataTargets']>;
  #hiddenAt: number | null = null;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #retry: ReturnType<typeof setTimeout> | undefined;
  #cacheTimer: ReturnType<typeof setTimeout> | undefined;
  readonly #critics?: RatingRefreshJob;
  readonly #imdb?: RatingRefreshJob;
  readonly #mal?: RatingRefreshJob;
  readonly #events = new AbortController();

  constructor(service: TmdbService, critics?: MdbListService, imdb?: ImdbService, mal?: MalService) {
    super();
    this.service = service;
    const { store, environment } = service;
    const targets = () => {
      if (!this.#runs) return store.metadataTargets();
      if (this.#targets) return this.#targets;
      const read = this.#targets = store.metadataTargets();
      void read.catch(()=>{ if (this.#targets === read) this.#targets = undefined; });
      return read;
    };
    const wake = (event: string) => { this.schedule(); store.dispatchEvent(new Event(event)); };
    if (critics) this.#critics = new RatingRefreshJob(service, {
      status: async () => { const state = await critics.keyStatus(); return {enabled:state.status === 'ready', retryAt:state.retryAt}; },
      refresh: ids => critics.refresh(ids, true), wake: () => wake('mdblistchange'),
    },targets);
    if (imdb) this.#imdb = new RatingRefreshJob(service, {
      status: async () => { const state = await imdb.sourceStatus(); return {enabled:state.source !== 'none', retryAt:state.retryAt}; },
      refresh: ids => imdb.refreshShows(ids, true), wake: () => wake('imdbchange'),
    },targets);
    const refreshMal = () => { void this.#mal?.run().catch(() => {}); };
    if (mal) this.#mal = new RatingRefreshJob(service, {
      status: async () => {
        const state = await mal.status();
        return {enabled:state.source === 'github' && !!state.repository && state.hasToken && !state.refused, retryAt:state.retryAt};
      },
      refreshFile: () => mal.refreshFile(),
      wake: refreshMal,
    });
    this.job = new TmdbDetailJob({
      active: () => !this.#closed && this.#ready && store.role === 'writer' && environment.online() && environment.visible(),
      now: () => environment.now(), today: () => localCalendarDate(new Date(environment.now())),
      read: resource => service.read(resource),
      refresh: async (resource,current) => {
        const entry = await service.refresh(resource,true,current);
        // Let open charts fill in during a large refresh, coalescing bursts of cache commits.
        if (current() && !this.#closed && this.#cacheTimer === undefined) {
          this.#cacheTimer = setTimeout(() => this.#notifyCache(), 250);
        }
        return entry;
      },
      record: targets,
    });
    const options = { signal: this.#events.signal };
    const changedGrant = () => {
      this.#generation++;
      this.#runs = 0;
      this.#targets = undefined;
      this.#active = null;
      this.#ready = this.#again = false;
      clearTimeout(this.#retry);
      clearTimeout(this.#cacheTimer);
      this.#cacheTimer=undefined;
      this.job.invalidate();
      this.#critics?.invalidate();
      this.#imdb?.invalidate();
      this.schedule();
    };
    store.addEventListener('providerkeyschange',changedGrant,options);
    store.addEventListener('deviceerased',changedGrant,options);
    store.addEventListener('rolechange', () => {
      this.#targets = undefined;
      if (store.role === 'writer') { this.schedule(); refreshMal(); }
      else if (store.role === 'obsolete' || store.role === 'closed') this.close();
    }, options);
    store.addEventListener('recordchange', evt => {
      const { tables, localKeys, settings, onlyDescriptions } = (evt as CustomEvent<{
        tables: TableName[]; localKeys: string[]; settings: string[] | 'all'; onlyDescriptions: boolean;
      }>).detail;
      if (onlyDescriptions) return;
      const criticsChanged = settings === 'all' || settings.includes('mdblist_key');
      if (criticsChanged) this.#critics?.invalidate();
      const sourceChanged = criticsChanged || settings.includes('tmdb_key');
      const targetsChanged = localKeys.includes('statisticsOpened') || tables.some(name => ['watched','ratings','lists'].includes(name));
      if (targetsChanged) this.#targets = undefined;
      if (sourceChanged || targetsChanged) this.schedule();
    }, options);
    store.addEventListener('tmdbstatechange', () => this.schedule(), options);
    store.addEventListener('imdbconfigchange', () => {
      this.#imdb?.invalidate();
      this.schedule();
    }, options);
    store.addEventListener('mdblistpausechange', () => {
      void this.#critics?.scheduleRetry().catch(() => {});
    }, options);
    store.addEventListener('imdbpausechange', () => { void this.#imdb?.scheduleRetry().catch(() => {}); }, options);
    store.addEventListener('malconfigchange', () => { this.#mal?.invalidate(); refreshMal(); }, options);
    store.addEventListener('malpausechange', () => { void this.#mal?.scheduleRetry().catch(() => {}); }, options);
    window.addEventListener('online', () => { this.schedule(); refreshMal(); }, options);
    document.addEventListener('visibilitychange', () => {
      if (!environment.visible()) {
        this.#hiddenAt = environment.now();
        this.#critics?.hidden(); this.#imdb?.hidden(); this.#mal?.hidden();
      }
      else {
        const reopened = this.#hiddenAt !== null && environment.now() - this.#hiddenAt >= 60_000;
        this.#hiddenAt = null;
        if (reopened || this.#active || this.job.paused || this.#critics?.interrupted || this.#imdb?.interrupted) this.schedule();
        if (reopened || this.#mal?.interrupted) refreshMal();
      }
    }, options);
    if (store.role === 'writer') { this.schedule(); refreshMal(); }
  }

  schedule(): void {
    if (this.#closed || this.#timer !== undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.run().catch(() => { /* A later app-open, edit or online event can retry. */ });
    }, 0);
  }

  run(): Promise<void> {
    const generation = this.#generation;
    this.#runs++;
    if (this.#active) this.#again = true;
    else this.#active = this.#drain(generation).finally(() => { if (generation === this.#generation) this.#active = null; });
    return Promise.all([this.#active, this.#critics?.run(), this.#imdb?.run()]).then(() => {}).finally(() => {
      if (generation === this.#generation && !--this.#runs) this.#targets = undefined;
    });
  }

  #notifyCache(): void {
    if (this.#cacheTimer === undefined) return;
    clearTimeout(this.#cacheTimer);
    this.#cacheTimer = undefined;
    this.dispatchEvent(new Event('cachechange'));
  }

  async #drain(generation:number): Promise<void> {
    const { store, environment } = this.service;
    const writer = () => !this.#closed && store.role === 'writer' && generation === this.#generation;
    do {
      this.#again = false;
      if (!writer()) return;
      await store.purgeTmdb(environment.now());
      if (!writer()) return;
      const state = await store.tmdbState();
      if (!writer()) return;
      this.#ready = !!state.token && state.refused === null;
      if (!this.#ready || !environment.online() || !environment.visible()) return;
      if (!state.cooldown || state.cooldown.until <= environment.now()) await this.job.run();
      if (!writer()) return;
      this.#notifyCache();
      const next = (await store.tmdbState()).cooldown;
      if (!writer()) return;
      clearTimeout(this.#retry);
      // Recheck the provider deadline after sleep, clock changes and long waits.
      if (next && next.until > environment.now() && writer()) this.#retry = setTimeout(() => this.schedule(),
        Math.min(2_147_483_647, Math.max(1, next.until - environment.now())));
    } while (this.#again);
  }

  close(): void {
    this.#closed = true;
    this.#targets = undefined;
    this.job.invalidate();
    this.#events.abort();
    clearTimeout(this.#timer);
    clearTimeout(this.#retry);
    clearTimeout(this.#cacheTimer);
    this.#critics?.close(); this.#imdb?.close(); this.#mal?.close();
  }
}
