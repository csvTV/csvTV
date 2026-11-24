import type { AniListCorrection } from './anilist-catalog-corrections.ts';
import type { TmdbEpisode } from './tmdb-data.ts';

/** Resolve reviewed broadcast episode IDs against the current TMDB season lists. */
export async function placeAniListRanges(segments: AniListCorrection['segments'], progress: number,
    load: (season: number) => Promise<readonly TmdbEpisode[] | null>,
    claim: (index: number, season: number, episode: TmdbEpisode) => void,
    gap: (first: number, last: number, reason: string, season: number | null) => void) {
  const positions = new Map<number, {season:number; id:number} | null>();
  const seen = new Set<number>(), repeated = new Set<number>();
  for (const {from, season, ids} of segments) {
    for (const [offset, id] of ids.entries()) {
      if (seen.has(id)) repeated.add(id);
      seen.add(id);
      const index = from + offset;
      if (index <= progress) positions.set(index, positions.has(index) ? null : {season, id});
    }
  }
  const details = new Map<number, Map<number, TmdbEpisode | null>>();
  const missing: {first:number; last:number; season:number | null}[] = [];
  function unplaced(first: number, last: number, season: number | null) {
    if (last < first) return;
    const prior = missing.at(-1);
    if (prior && prior.season === season && prior.last === first - 1) prior.last = last;
    else missing.push({first,last,season});
  }
  let next = 1;
  for (const [index, target] of [...positions].sort(([a], [b]) => a - b)) {
    unplaced(next, index - 1, null);
    next = index + 1;
    if (!target || repeated.has(target.id)) {
      unplaced(index, index, target?.season ?? null);
      continue;
    }
    let season = details.get(target.season);
    if (!season) {
      season = new Map();
      for (const episode of await load(target.season) ?? []) {
        season.set(episode.episode_id, season.has(episode.episode_id) ? null : episode);
      }
      details.set(target.season,season);
    }
    const episode = season.get(target.id);
    if (episode) claim(index, target.season, episode);
    else unplaced(index, index, target.season);
  }
  unplaced(next, progress, null);
  for (const {first, last, season} of missing) {
    gap(first, last, season === null ? 'No verified TMDB placement for this part of the entry.' :
      'The mapped episode IDs could not be verified in TMDB season ' + season + '.', season);
  }
}
