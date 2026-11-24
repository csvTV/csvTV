import { ratingsFileLimits, readRatingsCsv } from './ratings-csv.ts';
import { broadcastMalEntries, broadcastSeasons } from './broadcast-seasons.ts';
import type { ShowInfo } from './progress.ts';

export interface MalEntry { season: number | null; offset: number; malId: number; score: number }
const columns = 'show,season,offset,mal_id,score';
const ratingRow = /^(\d+),(\d*),(\d*),(\d+),([1-9](?:\.\d{1,2})?|10(?:\.0{1,2})?)$/;
const invalid = () => new Error('The MyAnimeList scores file is invalid or incomplete.');

export async function readMalFile(file: Blob) {
  const shows = new Map<number, MalEntry[]>();
  const scoreById = new Map<number, number>();
  let entryCount = 0;
  await readRatingsCsv(file, columns, ratingsFileLimits.mal, invalid, text => {
    const match = ratingRow.exec(text);
    if (!match) throw invalid();
    const show = Number(match[1]), season = match[2] ? Number(match[2]) : null;
    const offset = Number(match[3]), malId = Number(match[4]), score = Number(match[5]);
    if (show <= 0 || !Number.isSafeInteger(show) || malId <= 0 || !Number.isSafeInteger(malId) ||
        (season !== null && !Number.isSafeInteger(season)) || !Number.isSafeInteger(offset)) throw invalid();
    if (scoreById.has(malId) && scoreById.get(malId) !== score) throw invalid();
    scoreById.set(malId, score);
    const entries = shows.get(show) ?? [];
    entries.push({season, offset, malId, score});
    shows.set(show, entries);
    entryCount++;
  });
  return {shows, entryCount};
}

/** Omit availableSeasons when the device has no TMDB show details yet. */
export function selectMalScores(entries: readonly MalEntry[] | undefined, availableSeasons?: readonly {season:number}[]) {
  const seasons = new Map<number, number[]>();
  if (!entries?.length) return {score:null, seasons};
  const available = availableSeasons && new Set(availableSeasons.map(row => row.season));
  let first: MalEntry | undefined, unseasoned: MalEntry | undefined;
  const ordered = [...entries].sort((a, b) =>
    (a.season ?? 0) - (b.season ?? 0) || a.offset - b.offset || a.malId - b.malId);
  let previous: MalEntry | undefined;
  for (const entry of ordered) {
    if (entry.season === null) {
      if (!unseasoned || entry.malId < unseasoned.malId) unseasoned = entry;
      continue;
    }
    if (entry.season === 0 || (available && !available.has(entry.season))) continue;
    // A blank offset and zero can describe the same placement in an existing file.
    if (previous?.season === entry.season && previous.offset === entry.offset && previous.malId === entry.malId) continue;
    previous = entry;
    first ??= entry;
    const scores = seasons.get(entry.season) ?? [];
    scores.push(entry.score);
    seasons.set(entry.season, scores);
  }
  return {score:first?.score ?? unseasoned?.score ?? null, seasons};
}

export function selectShowMalScores(entries: readonly MalEntry[] | undefined, show: Pick<ShowInfo,'show_id'|'seasons'> | null | undefined) {
  const ranges = broadcastSeasons(show);
  if (show && ranges) return selectMalScores(broadcastMalEntries(show,ranges,entries));
  return selectMalScores(entries, show?.seasons ?? (show === null ? [] : undefined));
}
