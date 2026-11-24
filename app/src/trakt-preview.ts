import { reviewImportCounts, type ImportCountSeason, type ImportCountShow } from './import-counts.ts';
import { planImportRows, type ImportPlan } from './import-preview.ts';
import { reviewSeasonEpisodes } from './import-metadata.ts';
import type { WatchedRow } from './model.ts';
import type { ImportPreviewSnapshot } from './storage.ts';
import type { TraktPlacement } from './trakt-placement.ts';

export { describeImportChanges as describeTraktChanges } from './import-preview.ts';
export type TraktCountSeason = ImportCountSeason;
export type TraktSeasonExtras = ReadonlyMap<number, ReadonlyMap<number, number>>;

export interface TraktPlan extends ImportPlan {
  counts: TraktPlacement['counts'];
  selected: ReadonlySet<number>;
  countSeasons: ReadonlyMap<number, readonly TraktCountSeason[]>;
  seasonExtras: TraktSeasonExtras;
  wholeShowPasses: ReadonlyMap<number, number>;
  reviewShows: ImportCountShow[];
}

function countMetadata(placement: TraktPlacement) {
  const reviewSeasonNumbers = new Map<number,number[]>(), reviewLoadedSeasons = new Map<number,Set<number>>();
  const reviewCandidates = new Map<number,WatchedRow[]>(), reviewAmbiguousIds = new Map<number,Set<number>>();
  for (const {show_id,show} of placement.counts) {
    const seasons = placement.reviewShows?.get(show_id)?.seasons ?? [];
    reviewSeasonNumbers.set(show_id,seasons.map(s => s.season));
    const details = placement.reviewSeasons?.get(show_id);
    if (!details) continue;
    const {candidates, ambiguousIds, loadedSeasons} = reviewSeasonEpisodes({show_id,show}, details, placement.today);
    reviewLoadedSeasons.set(show_id,loadedSeasons);
    reviewAmbiguousIds.set(show_id,ambiguousIds);
    reviewCandidates.set(show_id,candidates);
  }
  return {reviewSeasonNumbers,reviewLoadedSeasons,reviewCandidates,reviewAmbiguousIds,broadcastByShow:placement.broadcastByShow};
}

export function planTraktImport(placement: TraktPlacement, snapshot: ImportPreviewSnapshot,
    selected: ReadonlySet<number> = new Set(), requestedExtras: TraktSeasonExtras = new Map(),
    requestedWhole: ReadonlyMap<number, number> = new Map()): TraktPlan {
  const multiples = new Map<number,number>();
  const seasonExtras = new Map(requestedExtras), wholeShowPasses = new Map(requestedWhole);
  for (const check of placement.counts) {
    if (!selected.has(check.show_id) || check.multiple === null) continue;
    multiples.set(check.show_id,check.multiple);
    seasonExtras.delete(check.show_id);
    wholeShowPasses.delete(check.show_id);
  }
  const review = reviewImportCounts(placement.counts,placement.watched,countMetadata(placement),{seasonExtras,wholeShowPasses});
  const rows = {...placement,watched:review.watched,skipped:placement.skipped.concat(review.skipped)};
  const plan = planImportRows(rows,snapshot,'Trakt',row => {
    const target = multiples.get(row.show_id);
    return target === undefined ? review.adjustedCount(row) : Math.max(row.times_watched,target);
  });
  review.finish(plan.watched);
  return {...plan,...review.choices,counts:placement.counts,selected:new Set(multiples.keys()),
    reviewShows:review.reviewShows,countSeasons:new Map(review.reviewShows.map(group => [group.show_id,group.seasons]))};
}
