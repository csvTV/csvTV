import { MAX_INTEGER, watchPosition, type WatchedRow } from "./model.ts";
import { hasAired, type ShowInfo } from "./progress.ts";
import { episodeKey } from "./watch-identity.ts";
import { PersonalRecordError } from "./personal-record.ts";
import { broadcastSeasons, type BroadcastSeason } from './broadcast-seasons.ts';

type Episode = Omit<WatchedRow, "times_watched">;
export type WatchDelta = { row: WatchedRow; change: bigint };
export type WatchEdit = { rows: WatchedRow[]; changes: WatchDelta[] };
interface SeasonCountChange { expectedCompleted: number; desiredCompleted: number }
export type BulkWatchAction = "mark" | "again" | "rewatch-complete" | SeasonCountChange;
export type EpisodeWatchAction = "mark" | "again" | "remove-one" | {expectedCount: number; desiredCount: number};
type CountAction = BulkWatchAction | "remove-one" | "clear" | bigint;

function completionDelta(action: SeasonCountChange, targets: readonly Episode[], current: ReadonlyMap<string,WatchedRow>): bigint {
  if (![action.expectedCompleted,action.desiredCompleted].every(n => Number.isSafeInteger(n) && n >= 0))
    throw new RangeError("Enter a whole season watch count from 0 to " + MAX_INTEGER.toLocaleString() + ".");
  if (!targets.length) throw new PersonalRecordError("This season has no aired episodes to change.");
  const completed = targets.reduce((min, target) => Math.min(min, current.get(watchPosition(target))?.times_watched ?? 0), Infinity);
  if (completed !== action.expectedCompleted)
    throw new PersonalRecordError("The season watch count changed. Reopen the count to review it.");
  return BigInt(action.desiredCompleted) - BigInt(completed);
}

// Plan the entire edit in memory. A failed count or a missing season cannot
// leave a half-applied bulk mark in the caller's working record.
function changeCounts(rows: readonly WatchedRow[], targets: readonly Episode[], requested: CountAction,
    reused?: ReadonlySet<string>): WatchEdit {
  const current = new Map(rows.map(row => [watchPosition(row), row]));
  if (requested === "rewatch-complete") {
    // An estimated Complete label can change when the actual episode list arrives.
    if (!targets.length || targets.some(target => !current.has(watchPosition(target))))
      throw new PersonalRecordError("This show is no longer complete. Check its progress before watching again.");
  }
  const action = requested === "rewatch-complete" ? "again" : requested;
  const settingCount = typeof action === "object";
  // Check the identity before using a saved count to compute the season's completed watches.
  if (reused?.size && (settingCount || action === "mark" || action === "again" || typeof action === "bigint" && action > 0n)) {
    for (const target of targets) {
      const key = watchPosition(target);
      if (reused.has(key) && current.get(key)?.episode_id === null)
        throw new PersonalRecordError("An unidentified watch occupies a reused episode position. Review the saved episode on its season page.");
    }
  }
  const delta = typeof action === "bigint" ? action : settingCount ? completionDelta(action, targets, current) : 0n;
  const claimed = new Map<string,string | null>();
  const adding = action === "mark" || action === "again" || delta > 0n;
  if (adding || settingCount) {
    for (const row of rows) if (row.episode_id !== null) {
      const id = episodeKey(row);
      claimed.set(id, claimed.has(id) ? null : watchPosition(row));
    }
  }
  const changes: WatchDelta[] = [];
  for (const target of targets) {
    const key = watchPosition(target);
    const previous = current.get(key);
    if (previous?.episode_id != null && previous.episode_id !== target.episode_id && (settingCount || (adding && target.episode_id !== null))) {
      throw new PersonalRecordError("A different episode is recorded at this position. Review the saved episode on its season page before marking this one.");
    }
    const before = BigInt(previous?.times_watched ?? 0);
    let after: bigint;
    switch (action) {
      case "mark": after = before || 1n; break;
      case "again": after = before + 1n; break;
      case "remove-one": after = before > 0n ? before - 1n : 0n; break;
      case "clear": after = 0n; break;
      default: after = before + delta; break;
    }
    if (after === before) continue;
    if (after > BigInt(MAX_INTEGER)) throw new RangeError("This change would exceed the watch limit for " + (target.title || "episode " + target.episode) + ".");
    if (target.episode_id !== null && (settingCount || (after > before && target.episode_id !== previous?.episode_id))) {
      const identity = episodeKey(target);
      if (claimed.has(identity) && claimed.get(identity) !== key) {
        throw new PersonalRecordError("This episode is recorded at another position. Review the episode numbering on the show page before marking it.");
      }
      if (!previous) claimed.set(identity,key);
    }
    const updated = { ...(previous ?? target), times_watched: Number(after) };
    if (after === 0n) current.delete(key);
    else current.set(key, updated);
    changes.push({ row: previous ?? updated, change: after - before });
  }
  return { rows: Array.from(current.values()), changes };
}

/** An individual episode can be marked before it airs. */
export function markEpisode(rows: readonly WatchedRow[], episode: Episode, action: EpisodeWatchAction, positionReused = false): WatchEdit {
  const reused = positionReused ? new Set([watchPosition(episode)]) : undefined;
  if (typeof action === "object") {
    const {expectedCount, desiredCount} = action;
    if (![expectedCount,desiredCount].every(n => Number.isSafeInteger(n) && n >= 0))
      throw new RangeError("Enter a whole episode watch count from 0 to " + MAX_INTEGER.toLocaleString() + ".");
    const saved = rows.find(row => watchPosition(row) === watchPosition(episode));
    if ((saved?.times_watched ?? 0) !== expectedCount)
      throw new PersonalRecordError("The episode watch count changed. Reopen the count to review it.");
    if (saved?.episode_id != null && saved.episode_id !== episode.episode_id)
      throw new PersonalRecordError("The episode at this position changed. Reopen its watch count.");
    return changeCounts(rows, [episode], BigInt(desiredCount) - BigInt(expectedCount), reused);
  }
  return changeCounts(rows, [episode], action, reused);
}

export type MarkScope = { season: number; through?: number; broadcast?: BroadcastSeason } | { season?: undefined; through?: never; broadcast?: never };

/** A bulk edit needs the identity and airing status of every target. A newer
 * header can report an episode that the cached season list cannot yet mark. */
export function unresolvedAiringSeasons(show: ShowInfo, scope: MarkScope, today: string): Set<number> {
  const unresolved = new Set<number>();
  for (const airing of [show.lastAired, show.nextEpisode]) {
    if (!airing?.airDate || airing.episode <= 0 || (scope.season === undefined ? !airing.season : airing.season !== scope.season) ||
        (scope.through !== undefined && airing.episode > scope.through) ||
        (scope.broadcast && (airing.episode < scope.broadcast.first || airing.episode > scope.broadcast.last))) continue;
    const season = show.seasons.find(s => s.season === airing.season);
    const aired = airing.airDate <= today;
    if (!season) {
      if (aired) unresolved.add(airing.season);
    } else if (season.newerHeader && season.episodes) {
      const episode = season.episodes.find(e => e.episode === airing.episode);
      if (aired !== (!!episode && hasAired(episode,today))) unresolved.add(season.season);
    }
  }
  return unresolved;
}

export function validateBroadcastScope(show: Pick<ShowInfo, 'show_id' | 'seasons'> | null | undefined, range: BroadcastSeason) {
  const current = broadcastSeasons(show)?.find(r => r.number === range.number);
  if (!current || current.sourceSeason !== range.sourceSeason || current.first !== range.first || current.last !== range.last) {
    throw new PersonalRecordError('The season listing changed. Reopen the season before editing its watches.');
  }
}

/** Use actual season detail for every targeted season. Whole-show actions skip specials. */
export function markAired(
  rows: readonly WatchedRow[], show: ShowInfo, today: string,
  scope: MarkScope, action: BulkWatchAction,
): WatchEdit {
  if (typeof action === "object") {
    if (!Number.isSafeInteger(scope.season) || !scope.season || scope.season < 0 || scope.through !== undefined)
      throw new PersonalRecordError("Select a regular season to change its watch count.");
    if (scope.broadcast ? scope.broadcast.sourceSeason !== scope.season : broadcastSeasons(show) !== null)
      throw new PersonalRecordError("The season listing changed. Reopen the season before editing its watches.");
  }
  if (scope.broadcast) validateBroadcastScope(show, scope.broadcast);
  if (unresolvedAiringSeasons(show,scope,today).size)
    throw new PersonalRecordError('The episode list has changed. Connect to TMDB and try again.');
  const seasons = show.seasons.filter(s => scope.season === undefined ? s.season !== 0 : s.season === scope.season);
  if (scope.season !== undefined && !seasons.length) throw new Error("Unknown season " + scope.season);
  const targets: Episode[] = [];
  const targetedIds = new Set<number>();
  const countPositions = typeof action === "object" ? new Set<number>() : null;
  let reused: Set<string> | undefined;
  for (const season of seasons) {
    if (!season.episodes) throw new Error("Episode detail is required for season " + season.season);
    for (const episode of season.reusedPositions ?? []) {
      (reused ??= new Set()).add(watchPosition({show_id:show.show_id,season:season.season,episode}));
    }
    for (const episode of season.episodes) {
      if (!hasAired(episode, today) || (scope.through !== undefined && episode.episode > scope.through)) continue;
      if (scope.broadcast && (scope.season !== scope.broadcast.sourceSeason || episode.episode < scope.broadcast.first || episode.episode > scope.broadcast.last)) continue;
      if (countPositions?.has(episode.episode)) throw new PersonalRecordError("Several episodes have the same number. Review the season before editing its watches.");
      countPositions?.add(episode.episode);
      if (episode.episode_id !== null) {
        if (targetedIds.has(episode.episode_id)) {
          throw new PersonalRecordError("The same episode appears at multiple positions. Review the season numbering before marking the show.");
        }
        targetedIds.add(episode.episode_id);
      }
      targets.push({ show_id: show.show_id, show: show.show, season: season.season,
        episode: episode.episode, episode_id: episode.episode_id, title: episode.title });
    }
  }
  return changeCounts(rows, targets, action, reused);
}

export function removeWatches(rows: readonly WatchedRow[], showId: number, season?: number, range?: BroadcastSeason): WatchEdit {
  const targets = rows.filter(r => r.show_id === showId && (season === undefined ? r.season !== 0 : r.season === season)
    && (!range || (r.season === range.sourceSeason && r.episode >= range.first && r.episode <= range.last)));
  return changeCounts(rows, targets, "clear");
}

/** Pass the union of remoteChangedEpisodes from merges since this edit. */
export function undoWatchEdit(rows: readonly WatchedRow[], changes: readonly WatchDelta[], protectedKeys: ReadonlySet<string>) {
  const current = new Map(rows.map(row => [watchPosition(row), row]));
  const known = new Map<string, WatchedRow | null>();
  for (const row of rows) {
    if (row.episode_id === null) continue;
    const id = episodeKey(row);
    known.set(id, known.has(id) ? null : row);
  }
  let skipped = 0;
  for (const { row, change } of changes) {
    const oldKey = watchPosition(row);
    const atPosition = current.get(oldKey);
    let matched = atPosition;
    if (row.episode_id !== null && atPosition?.episode_id !== row.episode_id) {
      const moved = known.get(episodeKey(row));
      if (moved === null) {
        skipped++;
        continue;
      }
      matched = moved ?? atPosition;
    }
    const key = matched ? watchPosition(matched) : oldKey;
    if (protectedKeys.has(episodeKey(row)) || (matched && protectedKeys.has(episodeKey(matched))) ||
        (row.episode_id !== null && matched?.episode_id != null && matched.episode_id !== row.episode_id)) {
      skipped++;
      continue;
    }
    const next = BigInt(matched?.times_watched ?? 0) - change;
    if (next > BigInt(MAX_INTEGER)) throw new RangeError("Undo exceeds the supported count for " + key);
    if (next <= 0n) current.delete(key);
    else current.set(key, { ...(matched ?? row), times_watched: Number(next) });
  }
  return { rows: Array.from(current.values()), skipped };
}
