import { compareFileText } from './csv.ts';
import { selectShowMalScores, type MalEntry } from './mal-file.ts';
import type { RecordTables } from './model.ts';
import { isWatchlist, orderedListNames, visibleListRows } from './personal-record.ts';
import { dropMembership } from './upcoming-preference.ts';
import { observation } from './episode-repair.ts';
import { localCalendarDate, watchProgress } from './progress.ts';
import { broadcastRangeAt, broadcastSeasons } from './broadcast-seasons.ts';
import { tmdbResourceKey } from './tmdb-client.ts';
import { withSeasonDetails, type TmdbConfiguration, type TmdbSeason, type TmdbShow } from './tmdb-data.ts';
import type { TmdbService } from './tmdb-service.ts';
import type { TmdbCacheEntry } from './tmdb-store.ts';

export interface OverviewShow {
  id: number;
  title: string;
  posterPath: string | null;
  rating: number | null;
  lists: string[];
  metadata: TmdbShow | null;
  missing: boolean;
  progress: ReturnType<typeof watchProgress>;
}

export function malScoresForShows(entries: ReadonlyMap<number, MalEntry[]> | undefined, shows: readonly OverviewShow[]) {
  const scores = new Map<number, number>();
  if (!entries) return scores;
  for (const show of shows) {
    const rows = entries.get(show.id);
    if (!rows) continue;
    const { score } = selectShowMalScores(rows, show.metadata);
    if (score !== null) scores.set(show.id, score);
  }
  return scores;
}
const collator = new Intl.Collator(undefined, { sensitivity: 'base' });
export function compareTitles(a: Pick<OverviewShow, 'id' | 'title'>, b: Pick<OverviewShow, 'id' | 'title'>): number {
  return collator.compare(a.title, b.title) || compareFileText(a.title, b.title) || a.id - b.id;
}

export function watchlistNextEpisode(show: OverviewShow): (NonNullable<TmdbShow['nextEpisode']> & {nativeNumbering?:true}) | null {
  const next = show.metadata?.nextEpisode;
  if (!next || next.season === 0) return null;
  const ranges = broadcastSeasons(show.metadata);
  if (!ranges) return next;
  const range = broadcastRangeAt(ranges,next.season,next.episode);
  if (!range || range.unassigned) return {...next,nativeNumbering:true};
  return {...next,season:range.number,episode:next.episode-range.first+1};
}

function watchlistPremiere(show: OverviewShow) {
  const seasons = show.metadata?.seasons;
  // A show header containing only Specials can date an advance special before the regular series.
  return seasons?.length && !seasons.some(s => s.season > 0) ? null : show.metadata?.firstAirDate;
}

export function watchlistUpcomingDate(show: OverviewShow, today: string): string | null {
  const next = watchlistNextEpisode(show), premiere = watchlistPremiere(show);
  if (premiere && premiere > today && (!next?.airDate || premiere <= next.airDate)) return premiere;
  return next?.airDate && next.airDate > today ? next.airDate : null;
}

export function watchlistSections(shows: readonly OverviewShow[], today: string) {
  const upcoming: OverviewShow[] = [], available: OverviewShow[] = [];
  for (const show of shows) {
    if (!show.progress.upcoming) continue;
    const {metadata, progress} = show, next = watchlistNextEpisode(show);
    const premiere = watchlistPremiere(show);
    const hasAired = progress.aired > 0 || (premiere && premiere <= today) ||
      (next?.airDate && next.airDate <= today) ||
      (metadata?.lastAired?.airDate && metadata.lastAired.season > 0 && metadata.lastAired.airDate <= today);
    (hasAired ? available : upcoming).push(show);
  }
  available.sort(compareTitles);
  upcoming.sort((a,b) => {
    const left = watchlistUpcomingDate(a,today), right = watchlistUpcomingDate(b,today);
    if (left === right) return compareTitles(a,b);
    return !left ? 1 : !right ? -1 : left < right ? -1 : 1;
  });
  return {upcoming,available};
}

function groupRows<T extends { show_id: number }>(rows: readonly T[]) {
  const groups = new Map<number, T[]>();
  for (const row of rows) {
    const group = groups.get(row.show_id);
    if (group) group.push(row); else groups.set(row.show_id, [row]);
  }
  return groups;
}

export async function readOverview(service: TmdbService, ids?: readonly number[], signal?: AbortSignal) {
  const tables = await service.store.overviewRows(false,signal,ids);
  signal?.throwIfAborted();
  const referenced = new Set<number>();
  for (const rows of [tables.watched, tables.ratings, visibleListRows(tables.lists)]) {
    for (const row of rows) referenced.add(row.show_id);
  }
  return overviewFromRecord(service, tables, ids ? ids.filter(id => referenced.has(id)) : [...referenced],signal);
}

export async function overviewFromRecord(service: TmdbService, tables: Omit<RecordTables, 'settings'>, showIds: readonly number[], signal?: AbortSignal) {
  const now = service.environment.now();
  const ids = [...new Set(showIds)];
  return overviewWithCache(tables, ids, now, await readOverviewCache(service, tables, ids, now,undefined,signal));
}

export async function readOverviewCache(service: TmdbService, tables: Omit<RecordTables, 'settings'>, ids: readonly number[], now: number,
  headersReady?: (details: ShowCache['details']) => void, signal?: AbortSignal) {
  const [configuration, cache] = await Promise.all([
    service.store.tmdbEntries<TmdbConfiguration | null>(['configuration'], now, signal).catch(() => []),
    readShowCache(service, tables, ids, now, headersReady, signal),
  ]);
  return { ...cache, config: configuration[0]?.value ?? null, configFetchedAt:configuration[0]?.fetchedAt,
    readable:configuration.length === 1 && cache.readable };
}

interface ShowCache {
  details: Map<number, TmdbCacheEntry<TmdbShow | null> | undefined>;
  seasons: Map<string, TmdbCacheEntry<TmdbSeason | null> | undefined>;
}

export function seasonKeysForShows(details: ShowCache['details'], watched?: ReadonlySet<number>) {
  const seasonKeys: string[] = [];
  for (const [id, entry] of details) {
    if (!entry?.value) continue;
    const readAll = !watched || watched.has(id);
    for (const { season } of entry.value.seasons) {
      if (readAll || season === entry.value.nextEpisode?.season) seasonKeys.push(tmdbResourceKey({ kind: 'season', id, season }));
    }
  }
  return seasonKeys;
}

export function watchedSeasonKeys(rows: RecordTables['watched'], ids?: ReadonlySet<number>) {
  const seasons = new Map<number,Set<number>>();
  for (const row of rows) {
    if (ids && !ids.has(row.show_id)) continue;
    let set = seasons.get(row.show_id);
    if (!set) seasons.set(row.show_id,set = new Set());
    set.add(row.season);
  }
  const keys = new Set<string>();
  for (const [id,numbers] of seasons) for (const season of numbers) keys.add(tmdbResourceKey({kind:'season',id,season}));
  return keys;
}

async function readShowCache(service: TmdbService, tables: Omit<RecordTables, 'settings'>, ids: readonly number[], now: number,
  headersReady?: (details: ShowCache['details']) => void, signal?: AbortSignal): Promise<ShowCache & {readable:boolean}> {
  const watched = new Set(tables.watched.map(row => row.show_id));
  for (const row of tables.lists) if (dropMembership(row.list) === 'dropped') watched.add(row.show_id);
  const headers = ids.map(id => tmdbResourceKey({kind:'show',id}));
  const known = !headersReady && ids.length >= 16 ? [...watchedSeasonKeys(tables.watched,new Set(ids))] : [];
  // A completed overview needs both headers and season rows. On a large
  // record most of these keys are already known and can share a transaction.
  const grouped = known.length ? await service.store.tmdbEntries<TmdbShow | TmdbSeason | null>([...headers,...known],now,signal)
    .catch(() => undefined) : undefined;
  signal?.throwIfAborted();
  const details = grouped ? grouped.slice(0,ids.length) as (TmdbCacheEntry<TmdbShow | null> | undefined)[] :
    await service.store.tmdbEntries<TmdbShow | null>(headers,now,signal).catch(() => []);
  signal?.throwIfAborted();
  const cache: ShowCache & {readable:boolean} = {details:new Map(ids.map((id,i) => [id,details[i]])), seasons:new Map(),readable:details.length === ids.length};
  if (grouped) known.forEach((key,i)=>cache.seasons.set(key,grouped[headers.length+i] as TmdbCacheEntry<TmdbSeason | null> | undefined));
  const seasonKeys = seasonKeysForShows(cache.details, watched).filter(key=>!cache.seasons.has(key));
  if (seasonKeys.length) {
    headersReady?.(cache.details);
    const seasonEntries = await service.store.tmdbEntries<TmdbSeason | null>(seasonKeys, now, signal).catch(() => []);
    signal?.throwIfAborted();
    cache.readable &&= seasonEntries.length === seasonKeys.length;
    for (const [index,key] of seasonKeys.entries()) cache.seasons.set(key,seasonEntries[index]);
  }
  return cache;
}

/** Project a single committed record with the cache that's currently available to this screen. */
export function overviewWithCache(tables: Omit<RecordTables, 'settings'>, ids: readonly number[], now: number,
  cache?: Awaited<ReturnType<typeof readOverviewCache>>) {
  const today = localCalendarDate(new Date(now));
  const records = projectShowRecords(tables, ids, today, cache);
  return { shows: records.map(record => record.show), listNames: orderedListNames(tables.lists).filter(name => !isWatchlist(name)), config: cache?.config ?? null, today };
}

export function projectShowRecords(tables: Omit<RecordTables, 'settings'>, ids: readonly number[], today: string, cache?: ShowCache) {
  const watched = groupRows(tables.watched);
  const lists = groupRows(visibleListRows(tables.lists,false,watched));
  const ratings = new Map(tables.ratings.map(row => [row.show_id, row]));
  const descriptions = new Map(tables.shows.map(row => [row.show_id, row]));
  return ids.map(id => {
    const entry = cache?.details.get(id);
    const metadata = entry?.value ?? null;
    const rows = watched.get(id) ?? [];
    const memberships = lists.get(id) ?? [];
    const rating = ratings.get(id);
    const description = descriptions.get(id);
    const seasonEntries = metadata?.seasons.map(({ season }) => cache?.seasons.get(tmdbResourceKey({ kind: 'season', id, season }))) ?? [];
    const seasonDetails = seasonEntries.map(detail => detail?.value);
    const info = metadata && withSeasonDetails(metadata, (_, index) => seasonDetails[index],
      (_, index) => !!seasonEntries[index] && observation(seasonEntries[index]).at < observation(entry!).at);
    const schedule = metadata && info && info.nextEpisode !== metadata.nextEpisode
      ? {...metadata,nextEpisode:info.nextEpisode ?? null,nextAirDate:info.nextAirDate} : metadata;
    const show: OverviewShow = { id, title: rows.find(row => row.show)?.show || rating?.show || memberships.find(row => row.show)?.show ||
        description?.show || metadata?.show || 'Show ' + id,
      posterPath: metadata?.posterPath ?? null,
      rating: rating?.rating ?? null, lists: memberships.map(row => row.list), metadata:schedule,
      missing: entry?.value === null, progress: watchProgress(id, rows, memberships, info, today) };
    return { show, rows, seasonDetails };
  });
}
