import { MAX_INTEGER, type ListRow, type WatchedRow } from "./model.ts";
import { dropMembership, upcomingReason } from './upcoming-preference.ts';
import { broadcastInfo, broadcastRangeAt, broadcastSeasons, type BroadcastSeason } from './broadcast-seasons.ts';

/** Dates from the metadata cache are ISO calendar dates, with no time or offset. */
export interface EpisodeInfo {
  episode: number;
  episode_id: number | null;
  title: string;
  airDate: string | null;
}

export interface SeasonInfo {
  season: number;
  episodeCount: number;
  /** Absent until fetched. An empty array means the fetch found no episodes. */
  episodes?: readonly EpisodeInfo[];
  /** A blank saved ID cannot identify the current episode at one of these positions. */
  reusedPositions?: readonly number[];
  /** A display slice of an unfetched native season uses that native season's estimate. */
  estimatedAired?: number;
  /** The cached show header is newer than this season detail. */
  newerHeader?: boolean;
}

export interface ShowInfo {
  show_id: number;
  show: string;
  seasons: readonly SeasonInfo[];
  lastAired: { season: number; episode: number; airDate?: string | null } | null;
  nextAirDate: string | null;
  nextEpisode?: { season: number; episode: number; airDate: string | null } | null;
  broadcastOrder?: readonly BroadcastSeason[];
  manualSeasonOrder?: string;
}

export function localCalendarDate(date: Date): string {
  return [String(date.getFullYear()).padStart(4, "0"),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")].join("-");
}

export function hasAired(episode: EpisodeInfo, today: string): boolean {
  return Boolean(episode.airDate && episode.airDate <= today);
}

export interface SeasonProgress {
  season: number;
  aired: number;
  watchedAired: number;
  recordedEpisodes: number;
  completed: number | null;
  airedWatchLimitReached?: true;
  rewatch: { viewing: number; watched: number; total: number } | null;
}

// An unfetched season has only an estimated contiguous range. Avoid allocating
// a synthetic episode for every position and never use the estimate for marks.
function estimatedAired(season: SeasonInfo, last: ShowInfo["lastAired"]): number {
  if (season.estimatedAired !== undefined) return season.estimatedAired;
  if (!last || last.season === 0 || season.season === 0 || season.season > last.season) return 0;
  return season.season === last.season ? Math.min(season.episodeCount, last.episode) : season.episodeCount;
}

export function seasonProgress(
  season: SeasonInfo, last: ShowInfo["lastAired"], rows: readonly WatchedRow[], today: string,
  next?: ShowInfo['nextEpisode'],
): SeasonProgress {
  const airedIds = season.episodes && new Map(season.episodes.filter(e => hasAired(e, today)).map(e => [e.episode, e.episode_id ?? null]));
  const estimated = airedIds ? 0 : estimatedAired(season, last);
  let extra: Set<number> | undefined;
  let future: Set<number> | undefined;
  if (season.season > 0 && (!airedIds || season.newerHeader)) {
    for (const airing of [last, next]) {
      if (!airing || airing.season !== season.season || airing.episode <= 0 || !airing.airDate) continue;
      if (airedIds) {
        if (airing.airDate <= today && !airedIds.has(airing.episode)) {
          airedIds.set(airing.episode, season.episodes?.find(e => e.episode === airing.episode)?.episode_id ?? null);
        } else if (airing.airDate > today) airedIds.delete(airing.episode);
      } else if (airing.airDate <= today && airing.episode > estimated) {
        // A header proves its own position, including across gaps in numbering.
        (extra ??= new Set()).add(airing.episode);
      } else if (airing.airDate > today && airing.episode <= estimated) {
        (future ??= new Set()).add(airing.episode);
      }
    }
  }
  const aired = airedIds?.size ?? estimated + (extra?.size ?? 0) - (future?.size ?? 0);
  const reused = season.reusedPositions?.length ? new Set(season.reusedPositions) : undefined;
  const watched = rows.filter(r => {
    if (r.episode_id === null && reused?.has(r.episode)) return false;
    if (!airedIds) return (r.episode >= 1 && r.episode <= estimated && !future?.has(r.episode)) || extra?.has(r.episode);
    const listedId = airedIds.get(r.episode);
    return listedId !== undefined && (listedId === null || r.episode_id === null || listedId === r.episode_id);
  });
  let completed = null;
  let rewatch = null;
  if (season.season !== 0 && aired > 0) {
    const minimum = watched.length < aired ? 0 : watched.reduce((low, r) => Math.min(low, r.times_watched), Infinity);
    completed = minimum;
    const ahead = minimum > 0 ? watched.filter(r => r.times_watched > minimum).length : 0;
    if (ahead) rewatch = { viewing: minimum + 1, watched: ahead, total: aired };
  }
  const result: SeasonProgress = { season: season.season, aired, watchedAired: watched.length, recordedEpisodes: rows.length, completed, rewatch };
  if (airedIds && watched.some(row => row.times_watched === MAX_INTEGER)) result.airedWatchLimitReached = true;
  return result;
}

/** All-time row and play totals include future episodes, specials and orphaned rows. */
export function watchProgress(
  showId: number, record: readonly WatchedRow[], lists: readonly ListRow[],
  metadata: ShowInfo | null, today: string,
) {
  if (metadata && metadata.show_id !== showId) throw new Error("Metadata belongs to a different show");
  if (metadata) {
    // Airings sometimes reach the header before the season index. Project
    // their exact positions for progress only. Marking needs actual identities.
    const airings = [metadata.nextEpisode,metadata.lastAired];
    for (const airing of airings) {
      if (!airing?.airDate || airing.airDate > today || airing.season <= 0 || airing.episode <= 0 ||
          metadata.seasons.some(s => s.season === airing.season)) continue;
      const episodeCount = Math.max(...airings.map(e => e?.season === airing.season ? e.episode : 0));
      metadata = { ...metadata, seasons: [...metadata.seasons, {season:airing.season, episodeCount, estimatedAired:0}] };
    }
  }
  const ranges = broadcastSeasons(metadata);
  if (ranges && metadata) metadata = broadcastInfo(metadata, ranges);
  const rowsBySeason = new Map<number, WatchedRow[]>();
  const displayNumbers = ranges && new Set(ranges.map(r => r.number));
  const unlisted = new Map<number, number>();
  let plays = 0n;
  let recordedEpisodes = 0;
  for (const row of record) {
    if (row.show_id !== showId) continue;
    plays += BigInt(row.times_watched);
    recordedEpisodes++;
    // A saved row from a retired native season can share a number with a
    // broadcast season. Keep its all-time count without crediting the new slot.
    const range = ranges && broadcastRangeAt(ranges,row.season,row.episode);
    if (!range && displayNumbers?.has(row.season)) {
      unlisted.set(row.season, (unlisted.get(row.season) ?? 0) + 1);
      continue;
    }
    const position = range ? {season:range.number, episode:row.episode - range.first + 1} : row;
    let seasonRows = rowsBySeason.get(position.season);
    if (!seasonRows) {
      seasonRows = [];
      rowsBySeason.set(position.season, seasonRows);
    }
    seasonRows.push(position === row ? row : { ...row, season: position.season, episode: position.episode });
  }
  const seasons = metadata?.seasons.map(s => seasonProgress(s, metadata.lastAired, rowsBySeason.get(s.season) ?? [], today,
    metadata.nextEpisode)) ?? [];
  for (const s of seasons) s.recordedEpisodes += unlisted.get(s.season) ?? 0;
  if (metadata) {
    const listed = new Set(seasons.map(s => s.season));
    for (const [season, rows] of rowsBySeason) {
      if (!listed.has(season)) {
        seasons.push(seasonProgress({ season, episodeCount: 0, episodes: [] }, null, rows, today));
      }
    }
  }
  let aired = 0;
  let watchedAired = 0;
  let completed: number | null = null;
  for (const season of seasons) {
    if (season.completed === null) continue;
    aired += season.aired;
    watchedAired += season.watchedAired;
    completed = completed === null ? season.completed : Math.min(completed, season.completed);
  }
  const memberships = lists.filter(row => row.show_id === showId).map(row => row.list);
  const stopped = memberships.some(name => dropMembership(name) === 'dropped');
  const complete = completed !== null && completed > 0;
  const moreToWatch = !stopped && recordedEpisodes > 0 && watchedAired < aired;
  const upcoming = recordedEpisodes ? null : upcomingReason(memberships);
  return { seasons, aired, watchedAired, completed, complete, moreToWatch, upcoming, recordedEpisodes, plays };
}
