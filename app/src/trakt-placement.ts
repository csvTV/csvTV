import { favoritesList, watchPosition, type ListRow, type RatingRow, type ShowRow, type WatchedRow } from './model.ts';
import { compareFileText } from './csv.ts';
import { broadcastSeasons, type BroadcastSeason } from './broadcast-seasons.ts';
import { localCalendarDate } from './progress.ts';
import { forEachImportItem, importLookupConcurrency, openImportMetadata, type ImportMetadataOptions, type ImportLoad as Load, type ImportResource as Resource } from './import-metadata.ts';
import { TmdbError } from './tmdb-client.ts';
import type { CacheEntry, TmdbEpisode, TmdbSeason, TmdbShow } from './tmdb-data.ts';
import type { TmdbService } from './tmdb-service.ts';
import type { TraktArchive, TraktEpisode, TraktIds, TraktShow } from './trakt-archive.ts';

export interface TraktCountCheck {
  show_id: number;
  show: string;
  total: number;
  listedPlays: number;
  listedEpisodes: number;
  multiple: number | null;
}
export interface TraktPlacement {
  broadcastByShow: Map<number,readonly BroadcastSeason[]>;
  archive: TraktArchive;
  shows: ShowRow[];
  watched: WatchedRow[];
  ratings: RatingRow[];
  lists: ListRow[];
  skipped: string[];
  counts: TraktCountCheck[];
  reusedPositions: Set<string>;
  generation: bigint;
  cache: Map<string, CacheEntry & { prior: CacheEntry | null }>;
  seasonOrders?: ReadonlyMap<number,string|undefined>;
  today: string;
  reviewShows: Map<number, TmdbShow>;
  reviewSeasons: Map<number, Map<number, TmdbSeason | null>>;
  prepareSeason(showId: number, season: number): Promise<void>;
}

interface Source {
  shows: TraktShow[];
  history: TraktEpisode[];
  ratings: Set<number>;
  totals: Set<number>;
  lists: Set<string>;
}
interface MatchedShow { show: TmdbShow; source: Source; playedSeasons: Map<number, TmdbSeason | null> }
function mayNeedLookup(match: MatchedShow) {
  const missing = new Set<number>();
  for (const {ids} of match.source.history) {
    if (ids.tmdb === null) return true;
    missing.add(ids.tmdb);
  }
  for (const detail of match.playedSeasons.values()) {
    if (!missing.size) return false;
    for (const episode of detail?.episodes ?? []) missing.delete(episode.episode_id);
  }
  return missing.size > 0;
}

function slotsForFallbacks(shows: readonly MatchedShow[]) {
  if (shows.length < 2) return importLookupConcurrency;
  let competing = 0;
  for (const match of shows) {
    if (!mayNeedLookup(match)) continue;
    if (++competing === importLookupConcurrency) return 1;
  }
  return Math.floor(importLookupConcurrency / Math.max(1,competing));
}

function newSource(): Source {
  return { shows: [], history: [], ratings: new Set(), totals: new Set(), lists: new Set() };
}
function appendSource(to: Source, from: Source) {
  for (const show of from.shows) to.shows.push(show);
  for (const episode of from.history) to.history.push(episode);
  for (const rating of from.ratings) to.ratings.add(rating);
  for (const total of from.totals) to.totals.add(total);
  for (const list of from.lists) to.lists.add(list);
}

/** Keep the export's distinct show references until their external IDs have been resolved. */
function sources(archive: TraktArchive) {
  const references = new Map<string, Source>();
  function source(show: TraktShow) {
    const { trakt, tmdb, tvdb, imdb } = show.ids;
    const key = JSON.stringify([trakt, tmdb, tvdb, imdb, show.title]);
    let found = references.get(key);
    if (!found) {
      found = newSource();
      found.shows.push(show);
      references.set(key, found);
    }
    return found;
  }
  for (const { show, episode } of archive.history) source(show).history.push(episode);
  for (const { show, plays } of archive.totals) source(show).totals.add(plays);
  for (const { show, rating } of archive.ratings) source(show).ratings.add(rating);
  for (const show of archive.favourites) source(show).lists.add(favoritesList);
  for (const show of archive.watchlist) source(show).lists.add('Watchlist');
  return [...references.values()];
}

type ExternalLookup = Extract<Resource, { kind: 'find' }>;
function externalIds(ids: TraktIds): ExternalLookup[] {
  const resources: ExternalLookup[] = [];
  if (ids.tvdb !== null) resources.push({ kind: 'find', source: 'tvdb_id', externalId: String(ids.tvdb) });
  if (ids.imdb) resources.push({ kind: 'find', source: 'imdb_id', externalId: ids.imdb });
  return resources;
}
function unique<T>(values: Iterable<T>): T | null {
  const distinct = new Set(values);
  return distinct.size === 1 ? [...distinct][0] : null;
}
async function matchShowId(source: TraktShow, load: Load) {
  let id = source.ids.tmdb;
  if (id === null) {
    for (const query of externalIds(source.ids)) {
      id = unique((await load(query))?.shows.map(show => show.show_id) ?? []);
      if (id !== null) break;
    }
  }
  return id;
}

interface Group { episode: TraktEpisode; traktId: number | null; count: number; refs: Map<string, TraktIds> }
function historyKeys(history: readonly TraktEpisode[]) {
  if (history.every(episode => episode.ids.trakt !== null)) {
    return (episode: TraktEpisode) => 'trakt/' + episode.ids.trakt;
  }
  // A lower-priority ID can connect plays before and after a direct ID was backfilled.
  const tmdbByTvdb = new Map<string, number | null>(), tmdbByImdb = new Map<string, number | null>();
  const tvdbByImdb = new Map<string, number | null>();
  function observe(ids: Map<string, number | null>, slot: string, alias: number | string | null, value: number | null) {
    if (alias === null || value === null) return;
    const key = slot + alias;
    ids.set(key, ids.has(key) && ids.get(key) !== value ? null : value);
  }
  const slotFor = (e: TraktEpisode) => e.season + '/' + e.number + '/';
  for (const e of history) {
    const slot = slotFor(e), {tmdb,tvdb,imdb} = e.ids;
    observe(tmdbByTvdb, slot, tvdb, tmdb);
    observe(tmdbByImdb, slot, imdb, tmdb);
    observe(tvdbByImdb, slot, imdb, tvdb);
  }
  function externalKey(e: TraktEpisode) {
    const slot = slotFor(e), ids = e.ids;
    if (ids.tmdb !== null) return slot + 'tmdb/' + ids.tmdb;
    const tvdb = ids.tvdb ?? (ids.imdb ? tvdbByImdb.get(slot + ids.imdb) : undefined);
    const viaTvdb = tvdb == null ? undefined : tmdbByTvdb.get(slot + tvdb);
    const viaImdb = ids.imdb ? tmdbByImdb.get(slot + ids.imdb) : undefined;
    // Null records conflicting observations. The ordinary external-ID lookup must resolve those.
    if (tvdb !== null && viaTvdb !== null && viaImdb !== null &&
        (viaTvdb === undefined || viaImdb === undefined || viaTvdb === viaImdb)) {
      const tmdb = viaTvdb ?? (ids.tvdb === null ? viaImdb : undefined);
      if (tmdb !== undefined) return slot + 'tmdb/' + tmdb;
    }
    return tvdb == null ? slot + 'imdb/' + (ids.imdb ?? '') : slot + 'tvdb/' + tvdb;
  }
  const traktByExternal = new Map<string, number | null>();
  for (const e of history) {
    const {trakt, tmdb, tvdb, imdb} = e.ids;
    if (trakt === null || (tmdb === null && tvdb === null && imdb === null)) continue;
    const key = externalKey(e);
    traktByExternal.set(key, traktByExternal.has(key) && traktByExternal.get(key) !== trakt ? null : trakt);
  }
  return (e: TraktEpisode) => {
    if (e.ids.trakt !== null) return 'trakt/' + e.ids.trakt;
    const key = externalKey(e);
    const trakt = traktByExternal.get(key);
    return trakt == null ? key : 'trakt/' + trakt;
  };
}
function groupHistory(history: TraktEpisode[]) {
  const groups = new Map<string, Group>();
  const historyKey = historyKeys(history);
  for (const e of history) {
    const key = historyKey(e);
    let group = groups.get(key);
    if (!group) {
      group = { episode: e, traktId: null, count: 0, refs: new Map() };
      groups.set(key, group);
    }
    group.count++;
    group.traktId ??= e.ids.trakt;
    group.refs.set(JSON.stringify([e.ids.tmdb, e.ids.tvdb, e.ids.imdb]), e.ids);
    const previous = group.episode;
    if (e.season < previous.season || (e.season === previous.season &&
        (e.number < previous.number || (e.number === previous.number && e.title < previous.title)))) group.episode = e;
  }
  return [...groups.values()];
}
function description(show: string, { episode: e, count }: Group) {
  return `${show} · ${e.season}×${e.number}${e.title ? ' ' + e.title : ''} (${count} ${count === 1 ? 'play' : 'plays'})`;
}
function missingShow(source: Source, skipped: string[]) {
  const show = source.shows[0].title || 'Unknown show';
  const groups = groupHistory(source.history);
  const parts = [
    ...groups.map(group => description(show, group)),
    ...[...source.ratings].map(rating => `${show} · rating ${rating}`),
    ...[...source.lists].map(list => `${show} · ${list}`),
    ...[...source.totals].map(total => `${show} · ${total} total plays, ${source.history.length} history entries`),
  ];
  for (const part of parts) skipped.push(part + ' — Show not found on TMDB.');
}
interface Candidate { group: Group; direct: boolean }
function priority(a: Candidate, b: Candidate) {
  const groupA = a.group, groupB = b.group;
  return Number(b.direct) - Number(a.direct) || groupB.count - groupA.count ||
    (groupA.traktId ?? Infinity) - (groupB.traktId ?? Infinity) ||
    groupA.episode.season - groupB.episode.season || groupA.episode.number - groupB.episode.number ||
    compareFileText(groupA.episode.title, groupB.episode.title);
}

async function placeShow({source, show, playedSeasons}: MatchedShow,
    session: Awaited<ReturnType<typeof openImportMetadata>>, result: TraktPlacement, availableSlots: () => number) {
  const {load, preloadSeasons} = session;
  const id = show.show_id;
  const ranges = broadcastSeasons(show);
  if (ranges) result.broadcastByShow.set(id,ranges);
  const name = show.show || source.shows.map(s => s.title).sort().find(Boolean) || '';
  const series = { show_id: id, show: name };
  const fallbackImdb = unique(source.shows.map(s => s.ids.imdb).filter((v): v is string => !!v));
  result.shows.push({ ...series, year: show.firstAirDate ? Number(show.firstAirDate.slice(0, 4)) : null,
    imdb_id: show.imdbId || fallbackImdb || '' });
  if (source.ratings.size === 1) result.ratings.push({ ...series, rating: [...source.ratings][0] });
  if (source.ratings.size > 1) result.skipped.push(name + ' — The export contains conflicting show ratings.');
  for (const list of source.lists) result.lists.push({ ...series, list });

  const groups = groupHistory(source.history);
  const externalSlots = groups.some(group => group.episode.ids.tmdb === null) ? availableSlots() : 0;
  if (externalSlots > 1) {
    const queries = new Map<string,ExternalLookup>();
    for (const group of groups) {
      if (group.episode.ids.tmdb !== null) continue;
      const refs = [...group.refs.values()];
      if (refs.some(ids => ids.tmdb !== null)) continue;
      const candidates = refs.flatMap(externalIds);
      const first = candidates.some(query => query.source === 'tvdb_id') ? 'tvdb_id' : 'imdb_id';
      for (const query of candidates) {
        if (query.source === first) queries.set(first + '/' + query.externalId,query);
      }
    }
    // Each of these preferred lookups is required. Defer lower-priority IDs until matching needs them.
    await forEachImportItem([...queries.values()],async query => { await load(query); },externalSlots);
  }
  const listedEpisodes = groups.length, listedPlays = source.history.length, total = unique(source.totals);
  if (total !== null && total !== listedPlays) {
    const target = listedEpisodes > 0 && total % listedEpisodes === 0 ? total / listedEpisodes : null;
    // A uniform target below even one source count would overshoot the show total.
    const multiple = target !== null && groups.every(group => group.count <= target) ? target : null;
    result.counts.push({ ...series, total, listedPlays, listedEpisodes, multiple });
    result.reviewShows.set(id, show);
    result.reviewSeasons.set(id, playedSeasons);
  } else if (source.totals.size > 1) result.skipped.push(name + ' — The export contains conflicting show totals.');

  const episodes = new Map<number, { season: number; episode: TmdbEpisode } | null>();
  function indexSeason(season: number, detail: TmdbSeason | null) {
    let invalidated = false;
    for (const position of detail?.reusedPositions ?? []) {
      result.reusedPositions.add(watchPosition({ show_id: id, season, episode: position }));
    }
    for (const episode of detail?.episodes ?? []) {
      // An inconsistent provider snapshot can list an ID in two fetched seasons.
      const previous = episodes.get(episode.episode_id);
      if (previous) invalidated = true;
      episodes.set(episode.episode_id, previous === undefined ? { season, episode } : null);
    }
    return invalidated;
  }
  for (const [season, detail] of playedSeasons) indexSeason(season, detail);
  let checkedOtherSeasons = false, placementsChanged = false;
  async function locate(episodeId: number) {
    if (!episodes.has(episodeId) && !checkedOtherSeasons) {
      const remaining = [...new Set(show.seasons.map(s => s.season))].filter(season => !playedSeasons.has(season));
      await preloadSeasons(show, remaining);
      const details = new Map<number,TmdbSeason | null>();
      await forEachImportItem(remaining,async season => {
        details.set(season,await load({kind:'season', id, season}, show));
      },availableSlots());
      // Preserve the header order through out-of-order replies and later duplicate-ID review.
      for (const season of remaining) {
        const detail = details.get(season)!;
        playedSeasons.set(season, detail);
        if (indexSeason(season, detail)) placementsChanged = true;
      }
      checkedOtherSeasons = true;
    }
    return episodes.get(episodeId) ?? null;
  }
  async function target(group: Group) {
    const refs = [...group.refs.values()];
    const ids = new Set(refs.flatMap(ref => ref.tmdb === null ? [] : [ref.tmdb]));
    if (ids.size) {
      const episodeId = unique(ids);
      return episodeId !== null && await locate(episodeId) ? { episodeId, direct: true } : null;
    }
    // Historic plays can carry different external IDs for the same Trakt episode.
    // A contradictory match must not be decided by ZIP order.
    const queries = refs.flatMap(externalIds);
    for (const source of ['tvdb_id', 'imdb_id'] as const) {
      const matches = new Set<number>();
      for (const query of queries.filter(q => q.source === source)) {
        const found = await load(query);
        for (const e of found?.episodes ?? []) {
          if (e.show_id === id && await locate(e.episode_id)) matches.add(e.episode_id);
        }
      }
      if (matches.size > 1) return null;
      const episodeId = unique(matches);
      if (episodeId !== null) return { episodeId, direct: false };
    }
    return null;
  }
  async function matchGroups() {
    const matches = new Map<number, Candidate[]>(), unplaced: Group[] = [];
    for (const group of groups) {
      // A single direct reference already in the season index needs no lookup.
      // Conflicting references and missing positions still take the full matching path.
      const direct = group.refs.size === 1 ? group.episode.ids.tmdb : null;
      const matched = direct !== null && episodes.has(direct)
        ? (episodes.get(direct) ? {episodeId:direct,direct:true} : null) : await target(group);
      if (!matched) {
        unplaced.push(group);
        continue;
      }
      const candidates = matches.get(matched.episodeId) ?? [];
      candidates.push({ group, direct: matched.direct });
      matches.set(matched.episodeId, candidates);
    }
    return {matches,unplaced};
  }
  let groupsByEpisode = await matchGroups();
  // A later season can expose a duplicate ID. Re-evaluate the external-ID fallback
  // against the complete index so ZIP order cannot change which plays are imported.
  if (placementsChanged) groupsByEpisode = await matchGroups();
  const {matches,unplaced} = groupsByEpisode;
  for (const group of unplaced) result.skipped.push(description(name, group) + ' — Episode could not be placed on TMDB.');
  for (const [episodeId, candidates] of matches) {
    const placement = episodes.get(episodeId);
    if (!placement) {
      for (const { group } of candidates) result.skipped.push(description(name, group) + ' — Ambiguous TMDB episode placement.');
      continue;
    }
    const [winner, ...duplicates] = candidates.sort(priority);
    const { episode, season } = placement;
    result.watched.push({ ...series, season, episode: episode.episode, episode_id: episodeId,
      title: episode.title, times_watched: winner.group.count });
    for (const { group } of duplicates) {
      result.skipped.push(description(name, group) + ` — Duplicate listing of TMDB episode ${season}×${episode.episode}.`);
    }
  }
}

export async function resolveTrakt(archive: TraktArchive, service: TmdbService, options: ImportMetadataOptions = {}): Promise<TraktPlacement> {
  const session = await openImportMetadata(service, 'Trakt', options);
  const {load, cache, generation} = session;
  const result: TraktPlacement = { archive, shows: [], watched: [], ratings: [], lists: [], counts: [], skipped: [...archive.issues],
    generation, cache, seasonOrders:session.seasonOrders, reusedPositions: new Set(), today: localCalendarDate(new Date(service.environment.now())),
    reviewShows: new Map(), reviewSeasons: new Map(), broadcastByShow: new Map(),
    async prepareSeason(showId, displaySeason) {
      const season = result.broadcastByShow.get(showId)?.find(r => r.number === displaySeason)?.sourceSeason ?? displaySeason;
      const parent = result.reviewShows.get(showId), seasons = result.reviewSeasons.get(showId);
      if (!parent?.seasons.some(s => s.season === season) || !seasons) throw Error('Season unavailable for this import.');
      const detail = await session.reviewSeason(parent, season);
      seasons.set(season, detail);
      for (const episode of detail?.reusedPositions ?? []) {
        result.reusedPositions.add(watchPosition({show_id:showId, season, episode}));
      }
    } };
  try {
    const matched = new Map<number, MatchedShow>();
    await forEachImportItem(sources(archive), async source => {
      const id = await matchShowId(source.shows[0], load);
      const seasons = [...new Set(source.history.map(episode => episode.season))].sort((a, b) => a - b);
      const show = id === null ? null : await load({ kind: 'show', id }, undefined, seasons);
      if (!show) { missingShow(source, result.skipped); return; }
      const group = matched.get(show.show_id) ?? { show, source: newSource(), playedSeasons: new Map() };
      appendSource(group.source, source);
      matched.set(show.show_id, group);
    });
    const shows = [...matched.values()];
    await forEachImportItem(shows, async match => {
      const played = new Set(match.source.history.map(episode => episode.season));
      await session.preloadSeasons(match.show, match.show.seasons.map(s => s.season).filter(n => played.has(n)));
    });
    // Schedule watched seasons across the entire export. A long series can use idle
    // slots even when it is the only show left. Unplayed seasons are only needed to find missing IDs.
    const playedSeasons = shows.flatMap(match => {
      const played = new Set(match.source.history.map(episode => episode.season));
      return match.show.seasons.filter(({season}) => played.has(season)).map(({season}) => ({match, season}));
    });
    await forEachImportItem(playedSeasons, async ({match, season}) => {
      const detail = await load({kind:'season', id:match.show.show_id, season}, match.show);
      match.playedSeasons.set(season, detail);
    });
    // Most shows already have all their episode IDs. Share the remaining slots only when a fallback is needed.
    let slots: number | undefined;
    const availableSlots = () => slots ??= slotsForFallbacks(shows);
    await forEachImportItem(shows, match => placeShow(match, session, result, availableSlots));
    await session.verify();
    result.shows.sort((a, b) => a.show_id - b.show_id);
    result.watched.sort((a, b) => a.show_id - b.show_id || a.season - b.season || a.episode - b.episode);
    result.ratings.sort((a, b) => a.show_id - b.show_id);
    result.lists.sort((a, b) => a.list.localeCompare(b.list) || a.show_id - b.show_id);
    result.counts.sort((a, b) => a.show.localeCompare(b.show) || a.show_id - b.show_id);
    result.skipped.sort();
    session.finishMatching(result.reviewShows.values());
    return result;
  } catch (error) {
    session.close();
    if (!service.environment.online()) throw new TmdbError('unreachable');
    throw error;
  }
}
