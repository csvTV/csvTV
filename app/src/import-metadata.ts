import { hasAired, localCalendarDate } from './progress.ts';
import type { WatchedRow } from './model.ts';
import { importSeasonBatchSize, TmdbError, tmdbResourceKey, type TmdbResource } from './tmdb-client.ts';
import type { CacheEntry, TmdbDataByKind, TmdbSeason, TmdbShow } from './tmdb-data.ts';
import { refreshDue, seasonWithCacheHistory } from './tmdb-refresh.ts';
import type { TmdbService } from './tmdb-service.ts';

export interface ImportMetadataOptions { signal?: AbortSignal; progress?: (completed: number) => void; current?: () => boolean }
export type ImportResource = Extract<TmdbResource, { kind: 'show' | 'season' | 'find' }>;
export type ImportLoad = <R extends ImportResource>(resource: R, parent?: TmdbShow) => Promise<TmdbDataByKind[R['kind']] | null>;
const maxEmptySeasonBatches = 3;
export const importLookupConcurrency = 10;

/** Manual season watches require a known air date. Identity checks include future and undated episodes too. */
export function reviewSeasonEpisodes(series: Pick<WatchedRow,'show_id'|'show'>, details: ReadonlyMap<number,TmdbSeason | null>, today: string) {
  const candidates: WatchedRow[] = [], seen = new Set<number>(), ambiguousIds = new Set<number>();
  for (const [season, detail] of details) {
    for (const ep of detail?.episodes ?? []) {
      if (seen.has(ep.episode_id)) ambiguousIds.add(ep.episode_id);
      seen.add(ep.episode_id);
      if (hasAired(ep,today)) candidates.push({show_id:series.show_id,show:series.show,season,episode:ep.episode,
        episode_id:ep.episode_id,title:ep.title,times_watched:0});
    }
  }
  return {candidates, ambiguousIds, loadedSeasons:new Set(details.keys())};
}

// Refill a free slot immediately. The shared TMDB client separately paces actual requests.
export async function forEachImportItem<T>(items: T[], work: (item: T) => Promise<void>, slots = importLookupConcurrency) {
  const remaining = items.values();
  let failed = false;
  async function run() {
    try {
      while (!failed) {
        const next = remaining.next();
        if (next.done) return;
        await work(next.value);
      }
    } catch (error) {
      failed = true;
      throw error;
    }
  }
  await Promise.all(Array.from({length: Math.min(importLookupConcurrency, slots, items.length)}, run));
}

export async function openImportMetadata(service: TmdbService, name: 'Trakt' | 'AniList', options: ImportMetadataOptions = {}) {
  let stopped = false;
  function active() {
    if (stopped || options.signal?.aborted || options.current?.() === false || service.store.role !== 'writer') throw new TmdbError('superseded');
    if (!service.environment.online()) throw new TmdbError('unreachable');
  }
  active();
  const initial = await service.keyStatus();
  active();
  if (initial.status === 'missing-key') throw new Error('Add a TMDB API Read Access Token in Settings to import from ' + name + '.');
  if (initial.status !== 'ready') throw new TmdbError('refused');
  const cache = new Map<string, CacheEntry & { prior: CacheEntry | null }>();
  const seasonOrders = new Map<number,string|undefined>();
  const reads = new Map<string, Promise<{ entry: CacheEntry; prior?: CacheEntry | null }>>();
  const appended = new Map<string, { fetchedAt: number; value: TmdbSeason }>();
  const attempted = new Set<string>();
  const priorSeasons = new Map<string, CacheEntry<'season'> | null>();
  const canAppend = typeof service.client?.requestShowWithSeasons === 'function';
  const wanted = () => !stopped && !options.signal?.aborted && options.current?.() !== false;
  // A cached show needs no header request. Stop buying extra requests if this import's
  // combined replies repeatedly supply none of the requested seasons.
  let emptySeasonBatches = 0;
  let completed = 0;
  async function fetchCombined(id: number, numbers: number[], parent?: TmdbShow) {
    active();
    const resource = {kind:'show', id} as const;
    const request = {numbers, received:new Map<number, TmdbSeason>()};
    for (const season of numbers) attempted.add(tmdbResourceKey({kind:'season', id, season}));
    try {
      const entry = await service.fetchForImport(resource, initial.generation, wanted, request);
      active();
      let usable = false;
      for (const [season, value] of request.received) {
        const header = parent?.seasons.find(row => row.season === season);
        if (parent && (!header || header.episodeCount !== value.episodes.length ||
            header.name !== value.name || header.posterPath !== value.posterPath)) continue;
        appended.set(tmdbResourceKey({kind:'season', id, season}), {fetchedAt:entry.fetchedAt, value});
        usable = true;
      }
      if (usable) emptySeasonBatches = 0;
      else if (parent) emptySeasonBatches++;
      // A 404 for an optional combination still needs confirmation at the plain show endpoint.
      return entry.value ? entry : null;
    } catch (error) {
      if (error instanceof TmdbError && (error.httpStatus === 400 || error.httpStatus === 414 || error.kind === 'invalid-response')) {
        if (parent) emptySeasonBatches++;
        return null;
      }
      throw error;
    }
  }
  async function preloadSeasons(parent: TmdbShow, numbers: number[]) {
    if (!canAppend || numbers.length < 2 || emptySeasonBatches >= maxEmptySeasonBatches) return;
    const id = parent.show_id, now = service.environment.now();
    const parentEntry = (await reads.get(tmdbResourceKey({kind:'show', id})))?.entry;
    const stale = (await Promise.all(numbers.map(async season => {
      const resource = {kind:'season', id, season} as const;
      const key = tmdbResourceKey(resource);
      if (attempted.has(key) || reads.has(key)) return null;
      const entry = await service.read(resource);
      priorSeasons.set(key, entry);
      return !entry || (parentEntry && entry.fetchedAt < parentEntry.fetchedAt) ||
        refreshDue('season', entry, now, localCalendarDate(new Date(now)), parent) ? season : null;
    }))).filter((season): season is number => season !== null);
    for (let start = 0; start + 1 < stale.length && emptySeasonBatches < maxEmptySeasonBatches; start += importSeasonBatchSize) {
      await fetchCombined(id, stale.slice(start, start + importSeasonBatchSize), parent);
    }
  }
  async function load<R extends ImportResource>(resource: R, parent?: TmdbShow, seasonHints?: number[],
      forReview = false): Promise<TmdbDataByKind[R['kind']] | null> {
    active();
    const key = tmdbResourceKey(resource);
    let task = reads.get(key);
    const firstRead = !task;
    if (!task) {
      task = (async () => {
        const cached = priorSeasons.has(key) ? priorSeasons.get(key) ?? null : await service.read(resource);
        const now = service.environment.now();
        const show = resource.kind === 'show' ? cached?.value as TmdbShow | null : parent;
        const parentEntry = resource.kind === 'season' ? (await reads.get(tmdbResourceKey({ kind: 'show', id: resource.id })))?.entry : null;
        if (cached && !(parentEntry && cached.fetchedAt < parentEntry.fetchedAt) &&
            !refreshDue(resource.kind, cached, now, localCalendarDate(new Date(now)), show)) return {entry:cached};
        active();
        let entry: CacheEntry;
        const part = appended.get(key);
        try {
          if (resource.kind === 'season' && part) {
            entry = {fetchedAt:part.fetchedAt, value:seasonWithCacheHistory(part.value, cached as CacheEntry<'season'> | null)};
          } else {
            const combined = canAppend && resource.kind === 'show' && seasonHints?.length ?
              await fetchCombined(resource.id, seasonHints.slice(0, importSeasonBatchSize)) : null;
            entry = combined ?? await service.fetchForImport(resource, initial.generation, wanted);
          }
        }
        catch (error) {
          if (resource.kind !== 'find' || !(error instanceof TmdbError) || error.kind !== 'not-found') throw error;
          entry = { fetchedAt: now, value: null };
        }
        return resource.kind === 'find' ? {entry} : {entry, prior:cached};
      })();
      reads.set(key, task);
    }
    try {
      const {entry, prior} = await task;
      if (forReview) await verify();
      else active();
      if (prior !== undefined && !cache.has(key)) cache.set(key, {...entry, prior});
      if (resource.kind === 'show' && entry.value) seasonOrders.set(resource.id,(entry.value as TmdbShow).manualSeasonOrder);
      if (firstRead && !forReview) options.progress?.(++completed);
      return entry.value as TmdbDataByKind[R['kind']] | null;
    } catch (error) {
      // A failed season edit can be retried in the same preview.
      if (reads.get(key) === task) reads.delete(key);
      throw error;
    }
  }
  async function verify() {
    active();
    const final = await service.keyStatus();
    active();
    if (final.status !== 'ready' || final.generation !== initial.generation) throw new TmdbError('superseded');
  }
  async function reviewSeason(parent: TmdbShow, season: number): Promise<TmdbSeason | null> {
    await verify();
    if (!parent.seasons.some(row => row.season === season)) throw new TmdbError('bad-request');
    return load({kind:'season', id:parent.show_id, season}, parent, undefined, true);
  }
  function finishMatching(reviewShows: Iterable<TmdbShow>) {
    // A large warm import should retain only the show and season reads the open review can reuse.
    const keep = new Set<string>();
    for (const show of reviewShows) {
      const id = show.show_id;
      keep.add(tmdbResourceKey({kind:'show', id}));
      for (const {season} of show.seasons) keep.add(tmdbResourceKey({kind:'season', id, season}));
    }
    for (const key of reads.keys()) if (!keep.has(key)) reads.delete(key);
    priorSeasons.clear();
    appended.clear();
    attempted.clear();
    if (!keep.size) stopped = true;
  }
  return { generation: initial.generation, cache, seasonOrders, load, preloadSeasons, finishMatching, reviewSeason, verify, close() { stopped = true; } };
}
