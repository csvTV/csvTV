import type { RecordTables } from './model.ts';
import { visibleListRows } from './upcoming-preference.ts';
import type { DeviceChanges } from './storage.ts';
import type { TmdbResource } from './tmdb-client.ts';
import type { CacheEntry, TmdbDataByKind, TmdbSeason, TmdbShow } from './tmdb-data.ts';

const day = 86_400_000;

/** Use UTC calendar months. August 31 expires on the final day of February at the same time. */
export function cacheExpiresAt(fetchedAt: number): number {
  const target = new Date(fetchedAt);
  const originalDay = target.getUTCDate();
  target.setUTCDate(1);
  target.setUTCMonth(target.getUTCMonth() + 6);
  const finalDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(originalDay, finalDay));
  return target.getTime();
}
export function cacheExpired(fetchedAt: number, now: number): boolean {
  const deadline = cacheExpiresAt(fetchedAt);
  return !Number.isFinite(deadline) || fetchedAt > now || now >= deadline;
}
export function refreshDue(kind: TmdbResource['kind'], entry: CacheEntry | null, now: number,
    today: string, show?: TmdbShow | null): boolean {
  if (!entry || cacheExpired(entry.fetchedAt, now)) return true;
  let days = 7;
  if (kind === 'configuration' || kind === 'countries' || show?.status === 'Ended' || show?.status === 'Canceled') days = 60;
  else if (show?.nextAirDate && show.nextAirDate < today) days = 1;
  return now - entry.fetchedAt >= days * day;
}

export interface DetailJobPort {
  active(): boolean;
  record(): Promise<{tables:{
    watched: readonly {show_id:number; season:number}[];
    ratings: readonly {show_id:number}[];
    lists: RecordTables['lists'];
  }; statisticsOpened:boolean}>;
  read<R extends TmdbResource>(resource: R): Promise<CacheEntry<R['kind']> | null>;
  refresh<R extends TmdbResource>(resource: R, current:()=>boolean): Promise<CacheEntry<R['kind']>>;
  now(): number;
  today(): string;
}

type ShowTask = { kind: 'show'; id: number; watched: Set<number>; credits: boolean; needsAverage: boolean };
type ChildTask = { kind: 'child'; resource: TmdbResource; show?: TmdbShow; refreshBefore?: number };
type Task = ShowTask | ChildTask;

/** The transport spaces dispatches across foreground and background callers. The
 * worker keeps at most 20 resource requests in flight and never queues an entire
 * library of requests in the transport. Pausing retains its unfinished tasks. */
export class TmdbDetailJob {
  readonly #port: DetailJobPort;
  #work: Task[] = [];
  #running: Promise<void> | undefined;
  #requested = false;
  #retryAt: number | null = null;
  #membership = '';
  #generation = 0;

  constructor(port: DetailJobPort) { this.#port = port; }
  get paused(): boolean { return !this.#running && this.#work.length > 0; }
  get retryAt(): number | null { return this.#retryAt; }

  invalidate() {
    this.#generation++;
    this.#running = undefined;
    this.#work = [];
    this.#requested = false;
    this.#retryAt = null;
    this.#membership = '';
  }

  run(): Promise<void> {
    if (!this.#port.active()) return this.#running ?? Promise.resolve();
    if (this.#running) {
      this.#requested = true;
      return this.#running;
    }
    this.#retryAt = null;
    const generation = this.#generation;
    const current = () => generation === this.#generation;
    this.#running = this.#drain(current).finally(() => { if (current()) this.#running = undefined; });
    return this.#running;
  }

  async #plan(current:()=>boolean): Promise<void> {
    const { tables, statisticsOpened } = await this.#port.record();
    if (!current()) return;
    const shows = new Map<number, Set<number>>();
    for (const row of tables.watched) {
      const seasons = shows.get(row.show_id) ?? new Set<number>();
      seasons.add(row.season);
      shows.set(row.show_id, seasons);
    }
    for (const rows of [tables.ratings, visibleListRows(tables.lists)]) {
      for (const row of rows) if (!shows.has(row.show_id)) shows.set(row.show_id, new Set());
    }
    // Resume the queue only when it still belongs to the same library. A restore
    // or import while hidden can remove a show or introduce a new watched season.
    const rated = new Set(tables.ratings.map(row => row.show_id));
    const tasks: Task[] = [{ kind: 'child', resource: { kind: 'configuration' } }];
    if (statisticsOpened) tasks.push({ kind: 'child', resource: { kind: 'countries' } });
    const members = [];
    for (const [id, watched] of shows) {
      const needsAverage = statisticsOpened && watched.size > 0 && rated.has(id);
      members.push([id, needsAverage, ...watched]);
      tasks.push({ kind: 'show', id, watched, credits: statisticsOpened, needsAverage });
    }
    const membership = JSON.stringify([statisticsOpened, members]);
    if (this.#work.length && this.#membership === membership) return;
    this.#membership = membership;
    this.#work = tasks;
  }

  async #drain(current:()=>boolean): Promise<void> {
    do {
      this.#requested = false;
      await this.#plan(current);
      while (current() && this.#work.length && this.#port.active()) {
        const batch = this.#work.splice(0, 20);
        const paused = await Promise.all(batch.map(async task => {
          if (!this.#port.active()) return task;
          try {
            if (task.kind === 'show') await this.#show(task,current);
            else await this.#child(task,current);
          } catch (error) {
            if (!current()) return null;
            // A suspended network request may settle after the tab becomes visible.
            if (error instanceof Error && 'kind' in error) {
              if (error.kind === 'throttled' && 'retryAt' in error && typeof error.retryAt === 'number') {
                this.#retryAt = Math.max(this.#retryAt ?? 0, error.retryAt);
              }
              if (['superseded', 'refused', 'throttled'].includes(String(error.kind))) return task;
            }
            if (!this.#port.active()) return task;
            // Leave a failed item for another run. Continue with the rest of this library.
          }
          return null;
        }));
        if (!current()) return;
        const interrupted = paused.filter(task => task !== null);
        if (interrupted.length) {
          this.#work.unshift(...interrupted);
          if (this.#retryAt !== null || !this.#requested || !this.#port.active()) return;
          this.#requested = false;
        }
      }
    } while (current() && this.#requested && this.#port.active());
  }

  async #show(task: ShowTask, current:()=>boolean): Promise<void> {
    const resource = { kind: 'show' as const, id: task.id };
    const old = await this.#port.read(resource);
    if (!current()) return;
    let entry = old;
    const due = refreshDue('show', old, this.#port.now(), this.#port.today(), old?.value);
    if (!this.#port.active()) throw new Error('Detail job paused');
    if (due || (task.needsAverage && old?.value && old.value.voteAverage === undefined)) {
      try { entry = await this.#port.refresh(resource,current); }
      catch (error) {
        if (!this.#port.active() || (error instanceof Error && 'kind' in error &&
            ['superseded', 'refused', 'throttled'].includes(String(error.kind)))) throw error;
        if (!old || cacheExpired(old.fetchedAt, this.#port.now())) entry = null;
      }
    }
    if (!current()) return;
    if (entry && entry.value === null) return;
    const show = entry?.value;
    const seasons = new Set(task.watched);
    if (show?.lastAired?.season === 0) for (const s of show.seasons) if (s.season !== 0) seasons.add(s.season);
    // Persisted parent time also covers a child request that failed during an earlier run.
    const refreshBefore = entry?.fetchedAt;
    for (const season of seasons) {
      if (!show || show.seasons.some(s => s.season === season)) {
        this.#work.push({ kind: 'child', resource: { kind: 'season', id: task.id, season }, show: show ?? undefined, refreshBefore });
      }
    }
    if (task.credits) this.#work.push({ kind: 'child', resource: { kind: 'cast', id: task.id },
      show: show ?? undefined, refreshBefore });
  }

  async #child(task: ChildTask, current:()=>boolean): Promise<void> {
    const entry = await this.#port.read(task.resource);
    if (!current()) return;
    if (!this.#port.active()) throw new Error('Detail job paused');
    if ((task.refreshBefore !== undefined && entry && entry.fetchedAt < task.refreshBefore) ||
        refreshDue(task.resource.kind, entry, this.#port.now(), this.#port.today(), task.show)) {
      await this.#port.refresh(task.resource,current);
    }
  }
}

/** Keep observations about a reused slot even if a later refresh reports the
 * same new ID again. A matching stable row can still accept its new title. */
export function seasonWithCacheHistory(season: TmdbSeason, prior: CacheEntry<'season'> | null): TmdbSeason {
  // Older devices stored only the 404. A returning slot cannot establish a saved watch's identity.
  const unsafe = prior?.value === null ? prior.vacatedPositions ?? season.episodes.map(row => row.episode) : undefined;
  return carrySeasonHistory(unsafe?.length ? {...season, reusedPositions:unsafe} : season, prior?.value ?? null);
}

export function carrySeasonHistory(next: TmdbSeason, prior: TmdbSeason | null): TmdbSeason {
  if (!prior || next.season !== prior.season || next.show_id !== prior.show_id) return next;
  const reused = new Set(prior.reusedPositions);
  const previousBySlot = new Map(prior.episodes.map(e => [e.episode, e.episode_id]));
  const previousById = new Map(prior.episodes.map(e => [e.episode_id, e.episode]));
  for (const episode of next.episodes) {
    const oldId = previousBySlot.get(episode.episode);
    const oldPosition = previousById.get(episode.episode_id);
    if (oldId !== undefined && oldId !== episode.episode_id) reused.add(episode.episode);
    if (oldPosition !== undefined && oldPosition !== episode.episode) {
      reused.add(episode.episode);
      reused.add(oldPosition);
    }
  }
  // A slot that disappears could later be filled by an unrelated episode.
  const surviving = new Set(next.episodes.map(e => e.episode));
  for (const slot of previousBySlot.keys()) if (!surviving.has(slot)) reused.add(slot);
  return reused.size ? { ...next, reusedPositions: [...reused].sort((a, b) => a - b) } : next;
}

/** Apply this patch to the current committed rows only after any UI hold ends.
 * A known episode moving to a new position needs explicit review at step 11. */
export function metadataRewrite(tables: RecordTables, resource: TmdbResource, value: TmdbDataByKind[keyof TmdbDataByKind] | null,
    previousSeason?: TmdbSeason | null): NonNullable<DeviceChanges['put']> {
  const patch: NonNullable<DeviceChanges['put']> = {};
  if (resource.kind === 'show' && value && 'show_id' in value && 'status' in value) {
    if (value.show_id !== resource.id || !value.show) return patch;
    for (const key of ['watched', 'ratings', 'lists'] as const) {
      const changed = tables[key].filter(row => row.show_id === resource.id && row.show !== value.show)
        .map(row => ({ ...row, show: value.show }));
      if (changed.length) Object.assign(patch, { [key]: changed });
    }
    return patch;
  }
  if (resource.kind !== 'season' || !value || !('episodes' in value) || !('season' in value) ||
      value.show_id !== resource.id || value.season !== resource.season) return patch;
  const episodes = new Map(value.episodes.map(e => [e.episode, e]));
  const reused = new Set(value.reusedPositions);
  const previous = new Map(previousSeason?.episodes.map(e => [e.episode, e.episode_id]));
  const watched = tables.watched.filter(row => row.show_id === resource.id);
  const claimed = new Set(watched.flatMap(r => r.episode_id === null ? [] : [r.episode_id]));
  const changes = [];
  for (const row of watched) {
    if (row.season !== resource.season) continue;
    const episode = episodes.get(row.episode);
    if (!episode) continue;
    if (row.episode_id !== null && row.episode_id !== episode.episode_id) continue;
    if (row.episode_id === null && (claimed.has(episode.episode_id) || reused.has(row.episode) ||
        (previous.has(row.episode) && previous.get(row.episode) !== episode.episode_id))) continue;
    const title = episode.title || row.title;
    if (row.episode_id !== episode.episode_id || row.title !== title) {
      changes.push({ ...row, title, episode_id: episode.episode_id });
    }
  }
  if (changes.length) patch.watched = changes;
  return patch;
}
