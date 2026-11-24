import type { EpisodeInfo, SeasonInfo, ShowInfo } from './progress.ts';
import type { MalEntry } from './mal-file.ts';
import { manualSeasonRanges } from './season-order.ts';

export interface BroadcastSeason {
  number: number;
  sourceSeason: number;
  first: number;
  last: number;
  name?: string;
  unassigned?: true;
}

type SeasonHeader = Pick<ShowInfo, 'show_id' | 'seasons' | 'broadcastOrder' | 'manualSeasonOrder'> &
  Partial<Pick<ShowInfo, 'lastAired' | 'nextEpisode'>>;
type VerifiedRun = {end:number; sourceSeason?:number; mal?:number[]; open?:true};
// Ordered broadcast finales in their verified native TMDB season.
const series = new Map<number, readonly VerifiedRun[]>([
  [237150, [{end:12,mal:[55265]}, {end:24,mal:[59131]}, {end:36,mal:[60601]}]],
  [105009, [{end:24,mal:[42249]}, {end:37,mal:[50608]}, {end:50,mal:[54918]}, {end:63,mal:[59088]}]],
  [65942, [{end:25,mal:[31240]}, {end:50,mal:[39587,42203]}, {end:66,mal:[54857]}, {end:85,mal:[61316]}]],
  [95479, [{end:24,mal:[40748]}, {end:47,mal:[51009]}, {end:59,mal:[57658]}]],
  [127532, [{end:12,mal:[52299]}, {end:25,mal:[58567]}]],
  [209867, [{end:28}, {end:38}]],
  [213402, [{end:12}, {end:24}]],
  [278043, [{end:12}, {end:25}]],
  [205050, [{end:25}, {end:50}, {end:51,open:true}]],
  [91768, [{end:14}, {end:26}, {end:36}, {sourceSeason:2,end:24}]],
]);

function verifiedRanges(show: SeasonHeader): BroadcastSeason[] | null {
  const runs = series.get(show.show_id);
  if (!runs) return null;
  const native = new Map(show.seasons.map(s => [s.season,s.episodeCount]));
  const firstCount = native.get(1) ?? 0;
  if (firstCount <= runs[0].end) return null;
  // If TMDB has started numbering seasons separately, the evidence for a
  // merged first season only applies when the known first native run survives.
  const lastFirst = runs.filter(run => !run.sourceSeason || run.sourceSeason === 1).at(-1)!.end;
  if (show.seasons.some(s => s.season > 1 && s.episodeCount > 0) && firstCount < lastFirst) return null;
  const result: BroadcastSeason[] = [];
  for (const run of runs) {
    const sourceSeason = run.sourceSeason ?? 1;
    const first = (result.at(-1)?.sourceSeason === sourceSeason ? result.at(-1)!.last : 0) + 1;
    const count = native.get(sourceSeason) ?? 0;
    if (count < first) continue;
    result.push({ number:result.length + 1, sourceSeason, first, last: Math.min(run.end,count) });
  }
  return result;
}

// Only contiguous slices of one native season are eligible. Reordered,
// overlapping, truncated or mixed-source ranges must never own a mark action.
function completeRanges(show: SeasonHeader, ranges: readonly BroadcastSeason[]): readonly BroadcastSeason[] | null {
  if (!Array.isArray(ranges) || !ranges.length) return null;
  const regular = show.seasons.filter(s => s.season > 0);
  const sizes = new Map(regular.map(s => [s.season,s.episodeCount]));
  if (sizes.size !== regular.length || regular.some(s => !Number.isSafeInteger(s.episodeCount) || s.episodeCount < 0)) return null;
  const used = new Map<number,number>();
  const result: BroadcastSeason[] = [];
  let previousSource = 0;
  for (const range of ranges) {
    if (!range || typeof range !== 'object') return null;
    const size = sizes.get(range.sourceSeason);
    if (size === undefined || range.sourceSeason < previousSource || range.number !== result.length + 1 ||
        range.first !== (used.get(range.sourceSeason) ?? 0) + 1 || !Number.isSafeInteger(range.last) ||
        range.last < range.first || range.last > size) return null;
    previousSource = range.sourceSeason;
    used.set(range.sourceSeason,range.last);
    result.push(range);
  }
  // Keep previously verified season numbers stable as the catalog grows.
  // Unplaced episodes remain visible and editable without guessing a new season.
  for (const [number,size] of [...sizes].sort(([a],[b]) => a-b)) {
    const covered = used.get(number) ?? 0;
    if (covered >= size && used.has(number)) continue;
    const name = covered === 0 ? 'TMDB Season ' + number : 'Unassigned episodes · TMDB Season ' + number;
    result.push({number:result.length + 1, sourceSeason:number, first:covered + 1, last:size, name, unassigned:true});
  }
  return result;
}

export function broadcastSeasons(show: SeasonHeader | null | undefined): readonly BroadcastSeason[] | null {
  if (!show || (!show.manualSeasonOrder && !show.broadcastOrder && !series.has(show.show_id))) return null;
  // Dated positions can arrive before TMDB updates a season's size. Extend
  // the numbering lookup only; progress still uses the original count.
  for (const airing of [show.lastAired, show.nextEpisode]) {
    if (!airing?.airDate || airing.season <= 0 || !Number.isSafeInteger(airing.episode)) continue;
    const source: SeasonInfo | undefined = show.seasons.find(s => s.season === airing.season);
    if (source && airing.episode > source.episodeCount) {
      show = {...show,seasons:show.seasons.map(s => s === source ? {...s,episodeCount:airing.episode} : s)};
    }
  }
  const manual = manualSeasonRanges(show);
  if (manual !== undefined) return manual;
  const supplied = show.broadcastOrder && completeRanges(show,show.broadcastOrder);
  const verified = verifiedRanges(show);
  if (supplied && (!verified || verified.every(range => {
    const match = supplied[range.number - 1];
    return match && !match.unassigned && match.sourceSeason === range.sourceSeason && match.first === range.first &&
      (match.last === range.last || (series.get(show.show_id)?.[range.number - 1].open && match.last >= range.last));
  }))) return supplied;
  return verified && completeRanges(show,verified);
}

// Fribb sometimes maps a sequel to the previous season's last episode. Use
// each verified MAL installment's identity and preserve separate cour scores.
export function broadcastMalEntries(show: SeasonHeader, ranges: readonly BroadcastSeason[], entries: readonly MalEntry[] | undefined) {
  const runs = series.get(show.show_id);
  const known = runs && verifiedRanges(show);
  const result: MalEntry[] = [];
  for (const entry of entries ?? []) {
    if (entry.season === null) { result.push(entry); continue; }
    const index = runs?.findIndex(run => run.mal?.includes(entry.malId)) ?? -1;
    const verified = index >= 0 ? known?.find(r => r.number === index + 1) : null;
    const sourceSeason = verified?.sourceSeason ?? entry.season, episode = verified?.first ?? entry.offset + 1;
    const range = broadcastRangeAt(ranges, sourceSeason, episode);
    if (!range || range.unassigned) continue;
    const part = verified ? runs![index].mal!.indexOf(entry.malId) : 0;
    result.push({ ...entry, season:range.number, offset:episode - range.first + part });
  }
  return result;
}

const byNativeSeason = new WeakMap<readonly BroadcastSeason[], Map<number,BroadcastSeason[]>>();

export function broadcastRangeAt(ranges: readonly BroadcastSeason[], season:number, episode:number) {
  let bySource = byNativeSeason.get(ranges);
  if (!bySource) {
    bySource = new Map();
    for (const range of ranges) {
      const group = bySource.get(range.sourceSeason);
      if (group) group.push(range); else bySource.set(range.sourceSeason,[range]);
    }
    byNativeSeason.set(ranges,bySource);
  }
  const group = bySource.get(season);
  if (!group) return undefined;
  let low = 0, high = group.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2), range = group[mid];
    if (episode < range.first) high = mid - 1;
    else if (episode > range.last) low = mid + 1;
    else return range;
  }
  return undefined;
}

export function broadcastPosition(ranges: readonly BroadcastSeason[] | null, season: number, episode: number): { season: number; episode: number } {
  const range = ranges && broadcastRangeAt(ranges,season,episode);
  return range ? { season: range.number, episode: episode - range.first + 1 } : { season, episode };
}

export function broadcastInfo(show: ShowInfo, ranges: readonly BroadcastSeason[]): ShowInfo {
  const native = new Map(show.seasons.map(s => [s.season,s]));
  const last = show.lastAired;
  const next = show.nextEpisode;
  const nextRange = next && broadcastRangeAt(ranges, next.season, next.episode);
  const lastRange = last && broadcastRangeAt(ranges, last.season, last.episode);
  const episodes = new Map<number,EpisodeInfo[]>();
  for (const source of native.values()) {
    if (!source.season) continue;
    for (const e of source.episodes ?? []) {
      const range = broadcastRangeAt(ranges, source.season, e.episode);
      if (!range) continue;
      const projected = {...e,episode:e.episode - range.first + 1};
      const list = episodes.get(range.number);
      if (list) list.push(projected); else episodes.set(range.number,[projected]);
    }
  }
  return {
    ...show,
    seasons: [...show.seasons.filter(s => s.season === 0), ...ranges.map(range => {
      const source = native.get(range.sourceSeason)!;
      const through = source.estimatedAired ?? (!last || last.season < source.season ? 0 :
        last.season === source.season ? Math.min(last.episode,source.episodeCount) : source.episodeCount);
      return {season:range.number, episodeCount:range.last - range.first + 1, newerHeader:source.newerHeader,
        reusedPositions:source.reusedPositions?.filter(n => n >= range.first && n <= range.last).map(n => n - range.first + 1),
        estimatedAired:Math.max(0,Math.min(through,range.last) - range.first + 1),
        episodes:source.episodes === undefined ? undefined : episodes.get(range.number) ?? []};
    })],
    lastAired: last && lastRange ? {...last,season:lastRange.number,episode:last.episode - lastRange.first + 1} : null,
    nextEpisode: next && nextRange ? { ...next, season: nextRange.number, episode: next.episode - nextRange.first + 1 } : null,
  };
}
