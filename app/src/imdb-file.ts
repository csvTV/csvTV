import { normalizedRating, ratingsFileLimits, readRatingsCsv, type RatingsReadOptions } from './ratings-csv.ts';

const columns = 'show,season,episode,rating';
const ratingRow = /^(\d+),(\d*),(\d*),([1-9](?:\.\d+)?|10(?:\.0+)?)$/;
const invalid = () => new Error('The IMDb ratings file is invalid or incomplete.');

async function readRatings(file: Blob, options:RatingsReadOptions, accept: (show: number, season: number | null, episode: number | null, rating: string) => void) {
  await readRatingsCsv(file, columns, ratingsFileLimits.imdb, invalid, text => {
    const match = ratingRow.exec(text);
    if (!match || Boolean(match[2]) !== Boolean(match[3])) throw invalid();
    const show = Number(match[1]), season = match[2] ? Number(match[2]) : null, episode = match[3] ? Number(match[3]) : null;
    if (show <= 0 || !Number.isSafeInteger(show) || (season !== null && !Number.isSafeInteger(season)) ||
        (episode !== null && !Number.isSafeInteger(episode))) throw invalid();
    accept(show, season, episode, match[4]);
  },options);
}

export async function readImdbShows(file: Blob, options:RatingsReadOptions={}): Promise<{shows: Map<number, number>; episodeCount: number}> {
  const shows = new Map<number, number>();
  let episodeCount = 0;
  await readRatings(file, options, (id, season, _episode, rating) => {
    if (season === null) shows.set(id, Number(rating));
    else episodeCount++;
  });
  return {shows, episodeCount};
}

export async function readImdbEpisodes(file: Blob, show: number, options:RatingsReadOptions={}): Promise<Map<number, Map<number, number>>> {
  const seasons = new Map<number, Map<number, number>>();
  const ambiguous = new Set<string>();
  const precise = new Map<string,string>();
  await readRatings(file, options, (id, season, episode, text) => {
    if (id !== show || season === null || episode === null) return;
    const position = season + '/' + episode;
    if (ambiguous.has(position)) return;
    let entries = seasons.get(season);
    if (!entries) { entries = new Map(); seasons.set(season, entries); }
    const decimal = normalizedRating(text), rating = Number(decimal), previous = entries.get(episode);
    if (previous !== undefined && (precise.get(position) ?? String(previous)) !== decimal) {
      ambiguous.add(position);
      precise.delete(position);
      entries.delete(episode);
      if (!entries.size) seasons.delete(season);
    } else {
      entries.set(episode,rating);
      // Keep extra digits only when Number cannot distinguish them from another accepted score.
      if (String(rating) !== decimal) precise.set(position,decimal);
    }
  });
  return seasons;
}
