import type { AniListPlacement } from './anilist-placement.ts';
import { animeClassification } from './anime.ts';
import { droppedList } from './upcoming-preference.ts';
import { broadcastPosition } from './broadcast-seasons.ts';
import { reviewImportCounts, type ImportCountChoices, type ImportCountShow } from './import-counts.ts';
import { planImportRows, type ImportPlan } from './import-preview.ts';
import { favoritesList, type ListRow, type RatingRow } from './model.ts';
import type { ImportPreviewSnapshot } from './storage.ts';

interface EntryScore {id: number; score: number}
interface ScoreGroup extends RatingRow { scores: EntryScore[] }
interface SeasonMatches { season: number; ranges: [number,number][] }
interface EntryMatches { id: number; progress: number; matched: number; seasons: SeasonMatches[] }
interface ShowMatches { show_id: number; show: string; entries: EntryMatches[] }
export type AniListChoices = ImportCountChoices;

export interface AniListPlan extends ImportPlan {
  notices: AniListPlacement['notices'];
  scoreGroups: ScoreGroup[];
  choices: Required<AniListChoices>;
  reviewShows: ImportCountShow[];
  entryGroups: ShowMatches[];
}

/** Explain shared or incomplete mappings in terms of the TMDB positions allowed by the final plan. */
function describeEntryMatches(placement: AniListPlacement, byShow: ReadonlyMap<number,AniListPlacement['entries']>,
    plan: ImportPlan): ShowMatches[] {
  if (!placement.entryRanges) return [];
  const progress = new Map(placement.archive.entries.map(entry => [entry.id,entry.progress]));
  const sourceRanges = new Map<number,AniListPlacement['entryRanges']>();
  for (const range of placement.entryRanges) {
    const existing = sourceRanges.get(range.entryId);
    if (existing) existing.push(range); else sourceRanges.set(range.entryId,[range]);
  }
  let accepted: Set<string> | undefined;
  const incomplete = new Set(placement.notices.filter(note => note.kind === 'unplaced' && note.review).map(note => note.showId));
  const groups: ShowMatches[] = [];
  for (const {show_id,show} of placement.shows) {
    const broadcast = placement.broadcastByShow?.get(show_id) ?? null;
    const entries = (byShow.get(show_id) ?? []).filter(entry => progress.get(entry.id));
    let explain = incomplete.has(show_id);
    if (!entries.length) continue;
    // A single entry in one native-season range cannot produce a split or shared placement.
    if (!explain && !broadcast && entries.length === 1 && (sourceRanges.get(entries[0].id)?.length ?? 0) <= 1) continue;
    accepted ??= new Set(plan.watched.map(({row}) => row.show_id + '/' + row.season + '/' + row.episode));
    const matches: EntryMatches[] = [];
    let regularEntries = 0;
    for (const entry of entries) {
      const seasons = new Map<number,SeasonMatches>();
      const seasonMatches = (season: number) => {
        let match = seasons.get(season);
        if (!match) {
          match = {season,ranges:[]};
          seasons.set(season,match);
        }
        return match;
      };
      let matched = 0;
      const rangesForEntry = sourceRanges.get(entry.id) ?? [];
      if (!rangesForEntry.length && entry.targetSeason != null && !broadcast?.some(r => r.sourceSeason === entry.targetSeason)) seasonMatches(entry.targetSeason);
      for (const source of rangesForEntry) {
        for (let episode = source.first; episode <= source.last; episode++) {
          const display = broadcastPosition(broadcast,source.season,episode);
          const {ranges} = seasonMatches(display.season);
          if (!accepted.has(show_id + '/' + source.season + '/' + episode)) continue;
          const ordinal = broadcast?.find(r => r.number === display.season)?.unassigned ? episode : display.episode;
          const last = ranges.at(-1);
          if (last && last[1] + 1 === ordinal) last[1] = ordinal;
          else ranges.push([ordinal,ordinal]);
          matched++;
        }
      }
      const regularSeasons = [...seasons.keys()].filter(number => number > 0).length;
      if (regularSeasons) regularEntries++;
      if (regularSeasons > 1) explain = true;
      matches.push({id:entry.id,progress:progress.get(entry.id)!,matched,seasons:[...seasons.values()].sort((a,b) => a.season-b.season)});
    }
    if ((explain || regularEntries > 1) && matches.length) groups.push({show_id,show,entries:matches.sort((a,b) => a.id-b.id)});
  }
  return groups;
}

/** One half-step is five AniList points. Sum decimal scores exactly and round the mean once. */
function meanRating(scores: readonly EntryScore[]): number {
  let sum = 0n, scale = 1n;
  for (const {score} of scores) {
    const [mantissa, exponent = '0'] = String(score).split('e');
    const [whole, fraction = ''] = mantissa.split('.');
    const places = fraction.length - Number(exponent);
    const entryScale = 10n ** BigInt(places);
    if (entryScale > scale) {
      sum *= entryScale / scale;
      scale = entryScale;
    }
    sum += BigInt(whole + fraction) * (scale / entryScale);
  }
  const pointsPerStep = 5n * scale * BigInt(scores.length);
  const steps = (2n * sum + pointsPerStep) / (2n * pointsPerStep);
  return Number(steps) / 2;
}

/** Recompute list membership and rating conflicts for each reviewed snapshot. */
export function planAniListImport(placement: AniListPlacement, snapshot: ImportPreviewSnapshot, choices: AniListChoices = {}): AniListPlan {
  const byShow = new Map<number, AniListPlacement['entries']>();
  for (const entry of placement.entries) {
    const members = byShow.get(entry.show_id);
    if (members) members.push(entry);
    else byShow.set(entry.show_id, [entry]);
  }
  const lists: ListRow[] = [], ratings: RatingRow[] = [];
  const scoreGroups: ScoreGroup[] = [];
  const reviewNotes = placement.notices.map(note => note.text);
  for (const {show_id, show} of placement.shows) {
    const entries = byShow.get(show_id);
    if (!entries) continue;
    const series = {show_id, show};
    lists.push({...series, list:animeClassification});
    if (entries.some(entry => entry.favourite)) lists.push({...series, list:favoritesList});
    if (entries.some(entry => entry.status === 3)) lists.push({...series, list:droppedList});
    if (entries.some(entry => entry.status === 1)) lists.push({...series, list:'Watchlist'});
    const scores = entries.filter(entry => entry.score > 0).map(({id, score}) => ({id, score})).sort((a, b) => a.id - b.id);
    if (!scores.length) continue;
    const row = {...series, rating:meanRating(scores)};
    ratings.push(row);
    if (scores.some(entry => entry.score !== scores[0].score)) {
      scoreGroups.push({...row, scores});
      reviewNotes.push(show + ' · AniList scores ' + scores.map(entry => entry.score / 10).join(', ') + ' → ' + row.rating);
    }
  }
  const flagged = new Set(placement.notices.filter(note =>
    note.kind === 'rewatching' || note.kind === 'overlap' || note.kind === 'unknown-status' ||
    (note.kind === 'unplaced' && note.review)).map(note => note.showId));
  const review = reviewImportCounts(placement.shows.filter(row => flagged.has(row.show_id)),placement.watched,placement,choices);
  const rows = {shows:placement.shows, watched:review.watched, ratings, lists,
    skipped:review.skipped, reviewNotes, reusedPositions:placement.reusedPositions, broadcastByShow:placement.broadcastByShow};
  const plan = planImportRows(rows,snapshot,'AniList',review.adjustedCount);
  review.finish(plan.watched);
  return {...plan, notices:placement.notices, scoreGroups, choices:review.choices, reviewShows:review.reviewShows,
    entryGroups:describeEntryMatches(placement,byShow,plan)};
}
