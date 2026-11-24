import { watchPosition, type WatchedRow } from './model.ts';
import { broadcastPosition, type BroadcastSeason } from './broadcast-seasons.ts';

export interface ImportCountChoices {
  wholeShowPasses?: ReadonlyMap<number,number>;
  seasonExtras?: ReadonlyMap<number,ReadonlyMap<number,number>>;
}
export interface ImportCountSeason {
  season: number;
  label?: string;
  matchedEpisodes: number;
  eligibleEpisodes: number;
  blockedEpisodes: number;
  listedPlays: number;
  minPlays: number;
  maxPlays: number;
  airedEpisodes: number | null;
  displayCount: number;
  canIncrease: boolean;
  canDecrease: boolean;
}
export interface ImportCountShow {
  show_id: number;
  show: string;
  seasons: ImportCountSeason[];
  canIncrease: boolean;
  canDecrease: boolean;
  playDelta: bigint;
}
export interface CountMetadata {
  broadcastByShow?: ReadonlyMap<number,readonly BroadcastSeason[]>;
  reviewSeasonNumbers?: ReadonlyMap<number,readonly number[]>;
  reviewLoadedSeasons?: ReadonlyMap<number,ReadonlySet<number>>;
  reviewCandidates?: ReadonlyMap<number,readonly WatchedRow[]>;
  reviewAmbiguousIds?: ReadonlyMap<number,ReadonlySet<number>>;
}
interface Episode {
  row: WatchedRow;
  exported: boolean;
  aired: boolean;
  ambiguous: boolean;
}

interface ReviewedSeason {
  season: ImportCountSeason;
  show: ImportCountShow;
  episodes: Episode[];
  proposed: Map<Episode,WatchedRow>;
  extra: number;
  whole: number;
}

function target(episode: Episode, extra: number, whole: number) {
  if (!episode.exported) return Math.max(0,extra);
  return episode.row.times_watched + (whole + (episode.aired ? extra : 0));
}
function validTargets(episodes: readonly Episode[], extra: number, whole: number) {
  if (!Number.isSafeInteger(extra) || !Number.isSafeInteger(whole) || whole < 0) return false;
  if (extra < 0 && !episodes.some(ep => ep.exported && ep.aired)) return false;
  if (extra && !episodes.some(ep => ep.aired)) return false;
  return episodes.every(ep => {
    const count = target(ep,extra,whole);
    return count >= (ep.exported ? 1 : 0) && Number.isSafeInteger(count);
  });
}

/** Collect exact positions and airing evidence, including later lookups that contradict earlier matches. */
function indexShow(id: number, matched: readonly WatchedRow[], metadata: CountMetadata) {
  const groups = new Map<number,Episode[]>();
  function season(number: number) {
    const existing = groups.get(number);
    if (existing) return existing;
    const rows: Episode[] = [];
    groups.set(number,rows);
    return rows;
  }
  const ranges = metadata.broadcastByShow?.get(id) ?? null;
  for (const number of metadata.reviewSeasonNumbers?.get(id) ?? []) {
    const partitions = ranges?.filter(range => range.sourceSeason === number);
    if (partitions?.length) for (const partition of partitions) season(partition.number);
    else season(number);
  }
  const positions = new Map<string,Episode>(), ids = new Map<number,string>();
  const ambiguous = new Set(metadata.reviewAmbiguousIds?.get(id));
  const loaded = metadata.reviewLoadedSeasons?.get(id);
  function observe(row: WatchedRow, exported: boolean) {
    const place = watchPosition(row), episodeId = row.episode_id;
    const previous = positions.get(place);
    if (previous && previous.row.episode_id === episodeId) {
      previous.aired ||= !exported;
      return;
    }
    if (previous) {
      if (previous.row.episode_id !== null) ambiguous.add(previous.row.episode_id);
      if (episodeId !== null) ambiguous.add(episodeId);
    }
    if (episodeId !== null) {
      if (ids.has(episodeId) && ids.get(episodeId) !== place) ambiguous.add(episodeId);
      ids.set(episodeId,place);
    }
    // Old in-memory placements without season details can still adjust documented matches.
    const ep = {row,exported,aired:!exported || !loaded?.has(row.season),ambiguous:false};
    positions.set(place,ep);
    season(broadcastPosition(ranges,row.season,row.episode).season).push(ep);
  }
  for (const row of matched) observe(row,true);
  for (const row of metadata.reviewCandidates?.get(id) ?? []) observe(row,false);
  for (const episodes of groups.values()) {
    for (const ep of episodes) ep.ambiguous = ep.row.episode_id === null || ambiguous.has(ep.row.episode_id);
  }
  return groups;
}

/** The shared import planner decides which proposed rows can safely enter the current record. */
function finishCounts(drafts: readonly ReviewedSeason[], accepted: ReadonlySet<WatchedRow>) {
  const eligibleShows = new Set<ImportCountShow>();
  for (const {season,show,episodes,proposed,extra,whole} of drafts) {
    const needsLookup = season.airedEpisodes === null && !season.matchedEpisodes;
    let hasEditableAired = false;
    let matchedCount: number | undefined;
    for (const ep of episodes) {
      const row = proposed.get(ep);
      if (!row) {
        if (!extra && !ep.exported && ep.aired && !ep.ambiguous) hasEditableAired = true;
        continue;
      }
      if (!accepted.has(row)) { season.blockedEpisodes++; continue; }
      season.eligibleEpisodes++;
      if (ep.exported) eligibleShows.add(show);
      const count = target(ep,extra,whole);
      if (ep.aired) {
        hasEditableAired = true;
        if (ep.exported) matchedCount = Math.min(matchedCount ?? count,count);
      }
      show.playDelta += BigInt(count) - BigInt(ep.exported ? ep.row.times_watched : 0);
    }
    // Count passes shared by the matched aired episodes, or manual passes for an unmatched season.
    season.displayCount = matchedCount ?? Math.max(0,extra);
    // The first selection can also reveal why none of the aired candidates can be placed.
    const offerCandidates = !extra && !season.matchedEpisodes && (season.airedEpisodes ?? 0) > 0;
    season.canIncrease = needsLookup || offerCandidates || ((hasEditableAired || extra < 0) && validTargets(episodes,extra+1,whole));
    season.canDecrease = (matchedCount !== undefined || extra > 0) && validTargets(episodes,extra-1,whole);
  }
  for (const {show} of drafts) show.canIncrease &&= eligibleShows.has(show);
}

export function reviewImportCounts(flags: readonly {show_id:number;show:string}[], watched: readonly WatchedRow[],
    metadata: CountMetadata, requested: ImportCountChoices) {
  const byShow = new Map(flags.map(check => [check.show_id,[] as WatchedRow[]]));
  for (const row of watched) byShow.get(row.show_id)?.push(row);
  const wholeShowPasses = new Map<number,number>(), seasonExtras = new Map<number,ReadonlyMap<number,number>>();
  const counts = new Map<WatchedRow,number>(), withheld = new Set<WatchedRow>(), added: WatchedRow[] = [];
  const skipped = new Set<string>();
  const reviewShows: ImportCountShow[] = [];
  const drafts: ReviewedSeason[] = [];
  for (const {show_id,show} of flags) {
    const matched = byShow.get(show_id)!;
    const groups = indexShow(show_id,matched,metadata);
    let whole = matched.length ? requested.wholeShowPasses?.get(show_id) ?? 0 : 0;
    const choices = requested.seasonExtras?.get(show_id) ?? new Map<number,number>();
    const extras = new Map([...choices].filter(([,value]) => value !== 0));
    if ([...extras.keys()].some(number => !groups.has(number)) ||
        [...groups].some(([number,eps]) => !validTargets(eps,extras.get(number) ?? 0,whole))) {
      whole = 0; extras.clear();
    }
    if (whole) wholeShowPasses.set(show_id,whole);
    if (extras.size) seasonExtras.set(show_id,extras);
    const group: ImportCountShow = {show_id,show,seasons:[],
      canIncrease:matched.length > 0 && whole < Number.MAX_SAFE_INTEGER,canDecrease:whole > 0,playDelta:0n};
    reviewShows.push(group);
    const ranges = metadata.broadcastByShow?.get(show_id) ?? null;
    for (const [number,episodes] of [...groups].sort(([a],[b]) => a-b)) {
      const range = ranges?.find(range => range.number === number);
      const sourceSeason = range?.sourceSeason ?? number;
      const extra = extras.get(number) ?? 0, loaded = metadata.reviewLoadedSeasons?.get(show_id)?.has(sourceSeason);
      const season: ImportCountSeason = {season:number,matchedEpisodes:0,eligibleEpisodes:0,blockedEpisodes:0,
        listedPlays:0,minPlays:0,maxPlays:0,airedEpisodes:loaded ? 0 : null,
        displayCount:0,canIncrease:false,canDecrease:false,...(range?.name && {label:range.name})};
      group.seasons.push(season);
      const proposed = new Map<Episode,WatchedRow>();
      for (const ep of episodes) {
        const {row} = ep, count = target(ep,extra,whole);
        if (ep.exported) {
          season.minPlays = season.matchedEpisodes ? Math.min(season.minPlays,row.times_watched) : row.times_watched;
          season.maxPlays = Math.max(season.maxPlays,row.times_watched);
          season.listedPlays += row.times_watched;
          season.matchedEpisodes++;
        }
        if (ep.aired && season.airedEpisodes !== null) season.airedEpisodes++;
        if (!ep.exported && !count) continue;
        if (ep.ambiguous) {
          if (ep.exported) withheld.add(row);
          season.blockedEpisodes++;
          const episodeNumber = range?.unassigned ? row.episode : broadcastPosition(ranges,row.season,row.episode).episode;
          skipped.add(show + ' · ' + (range?.name ?? 'S' + number) + ' E' + episodeNumber +
            (row.episode_id === null ? ' was skipped because its TMDB episode ID is missing.' :
              ' (TMDB episode ' + row.episode_id + ') was skipped because TMDB lists that ID in multiple seasons or positions.'));
        } else if (ep.exported) {
          proposed.set(ep,row);
          if (count !== row.times_watched) counts.set(row,count);
        } else {
          const manual = {...row,times_watched:count};
          added.push(manual);
          proposed.set(ep,manual);
        }
      }
      group.canIncrease &&= validTargets(episodes,extra,whole+1);
      group.canDecrease &&= validTargets(episodes,extra,whole-1);
      drafts.push({show:group,season,episodes,proposed,extra,whole});
    }
  }
  const kept = withheld.size ? watched.filter(row => !withheld.has(row)) : watched;
  return {reviewShows, watched:added.length ? kept.concat(added) : kept, skipped:[...skipped],
    choices:{wholeShowPasses,seasonExtras}, adjustedCount:(row: WatchedRow) => counts.get(row) ?? row.times_watched,
    finish(watched: readonly {row: WatchedRow}[]) {
      finishCounts(drafts,new Set(watched.map(p => p.row)));
    }};
}
