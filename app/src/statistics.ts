import { compareFileText } from './csv.ts';
import { isAnime } from './anime.ts';
import type { CriticScores } from './mdblist-service.ts';
import type { WatchedRow } from './model.ts';
import { compareTitles, type OverviewShow } from './record-overview.ts';

export interface StatisticsShow extends OverviewShow {
  episodes: readonly { row: WatchedRow; runtime: number | null }[];
  cast: readonly { id: number; name: string }[] | null;
}

export interface StatisticsInput {
  shows: readonly StatisticsShow[];
  countries: readonly { code: string; name: string }[];
  critics?: ReadonlyMap<number, CriticScores>;
  imdb?: ReadonlyMap<number, number>;
  mal?: ReadonlyMap<number, number>;
}

export type StatisticsScope = 'all' | 'tv' | 'anime';

export interface StatisticsRow {
  label: string;
  value: bigint | number;
  /** Horizontal coordinate on a score comparison. */
  rating?: number;
}

export interface StatisticsChart {
  id: string;
  title: string;
  kind: 'meter' | 'bar' | 'column' | 'dots';
  unit: 'plays' | 'minutes' | 'times' | 'shows' | 'tmdb' | 'tomatoes' | 'metacritic' | 'imdb' | 'myanimelist';
  decimals?: 2;
  rows: StatisticsRow[];
  /** Complete ranking when the plotted preview has fewer rows. */
  tableRows?: StatisticsRow[];
}

export interface StatisticsResult {
  totals: { shows: number; seasons: number; episodes: number; plays: bigint; minutes: bigint; runtimeEpisodes: number };
  omittedShows: number;
  missingCast: number;
  charts: StatisticsChart[];
}

interface RankedWatch {
  id: number;
  title: string;
  value: bigint;
  /** Most rewatched shows uses plays to break ties. */
  tiePlays?: bigint;
}

function descending(a: bigint, b: bigint): number {
  return a === b ? 0 : a > b ? -1 : 1;
}

function rankedWatches(watches: RankedWatch[]): StatisticsRow[] {
  watches.sort((a, b) => descending(a.value, b.value) || descending(a.tiePlays ?? 0n, b.tiePlays ?? 0n) || compareTitles(a, b));
  return watches.map(({ title, value }) => ({label:title,value}));
}

type NamedValue = { label: string; value: bigint };
type NamedTotals = Map<string | number, NamedValue>;

/** Different names can be cached for the same ID. Keep counts and ties independent of input order. */
function countNames(totals: NamedTotals, names: readonly { id: number | string; name: string }[], amount: bigint) {
  const counted = new Set<number | string>();
  for (const { id, name } of names) {
    const entry = totals.get(id) ?? { label: name, value: 0n };
    if (compareFileText(name, entry.label) < 0) entry.label = name;
    if (!counted.has(id)) entry.value += amount;
    totals.set(id, entry);
    counted.add(id);
  }
}

function rankedNames(totals: NamedTotals): StatisticsRow[] {
  return [...totals].sort(([idA, a], [idB, b]) => descending(a.value, b.value) || compareFileText(a.label, b.label) ||
    (typeof idA === 'number' && typeof idB === 'number' ? idA - idB : compareFileText(String(idA), String(idB))))
    .map(([, entry]) => entry);
}

function summarizeEpisodes(episodes: StatisticsShow['episodes']) {
  let minutes = 0n, knownRuntimes = 0;
  const seasons = new Set<number>();
  for (const {row, runtime} of episodes) {
    seasons.add(row.season);
    if (runtime !== null) {
      minutes += BigInt(runtime) * BigInt(row.times_watched);
      knownRuntimes++;
    }
  }
  return {minutes, knownRuntimes, seasons:seasons.size};
}

export type StatisticsEpisodeSummaries = WeakMap<StatisticsShow['episodes'], ReturnType<typeof summarizeEpisodes>>;

export function calculateStatistics(input: StatisticsInput, scope: StatisticsScope = 'all', summaries?: StatisticsEpisodeSummaries): StatisticsResult {
  const totals = { shows: 0, seasons: 0, episodes: 0, plays: 0n, minutes: 0n, runtimeEpisodes: 0 };
  let omittedShows = 0;
  let missingCast = 0;
  const byPlays: RankedWatch[] = [], byMinutes: RankedWatch[] = [];
  const repeatShows: RankedWatch[] = [];
  const ratings = Array.from({ length: 21 }, (_, i) => ({ label: String(i / 2), value: 0 }));
  const bands = ['Under 25%', '25% to under 50%', '50% to under 75%', '75% to under 100%', '100%']
    .map(label => ({ label, value: 0 }));
  const decades = new Map<number, number>();
  const genres: NamedTotals = new Map(), networks: NamedTotals = new Map();
  const countries: NamedTotals = new Map(), cast: NamedTotals = new Map();
  const countryNames = new Map(input.countries.map(country => [country.code, country.name]));
  const rated: { id: number; title: string; rating: number; tmdb: number | null }[] = [];

  for (const show of input.shows) {
    if (!show.episodes.length) continue;
    if (scope !== 'all' && isAnime(show) !== (scope === 'anime')) continue;
    const { id, title, metadata, progress } = show;
    const plays = progress.plays;
    let summary = summaries?.get(show.episodes);
    if (!summary) {
      summary = summarizeEpisodes(show.episodes);
      summaries?.set(show.episodes,summary);
    }
    const minutes = metadata ? summary.minutes : 0n, knownRuntimes = metadata ? summary.knownRuntimes : 0;
    totals.shows++;
    totals.seasons += metadata ? progress.seasons.filter(s => s.recordedEpisodes > 0).length : summary.seasons;
    totals.episodes += show.episodes.length;
    totals.plays += plays;
    totals.minutes += minutes;
    totals.runtimeEpisodes += knownRuntimes;
    byPlays.push({ id, title, value: plays });
    if (show.rating !== null) {
      ratings[show.rating * 2].value++;
      rated.push({ id, title, rating: show.rating, tmdb: metadata?.voteAverage ?? null });
    }
    if (!metadata) { omittedShows++; continue; }

    if (knownRuntimes > 0) {
      byMinutes.push({ id, title, value: minutes });
      countNames(genres, metadata.genres, minutes);
      countNames(networks, metadata.networks, minutes);
    }
    if (progress.completed !== null && progress.completed > 1) {
      repeatShows.push({ id, title, value: BigInt(progress.completed), tiePlays: plays });
    }
    if (progress.aired) {
      const band = Number(4n * BigInt(progress.watchedAired) / BigInt(progress.aired));
      bands[band].value++;
    }
    if (metadata.firstAirDate) {
      const decade = 10 * Math.floor(Number(metadata.firstAirDate.slice(0, 4)) / 10);
      decades.set(decade, (decades.get(decade) ?? 0) + 1);
    }
    countNames(countries, metadata.originCountries.map(code => ({ id: code, name: countryNames.get(code) || code })), 1n);
    if (show.cast) countNames(cast, show.cast, 1n);
    else missingCast++;
  }

  const charts: StatisticsChart[] = [];
  function add(id: string, title: string, kind: StatisticsChart['kind'], unit: StatisticsChart['unit'], rows: StatisticsRow[], limit?:number) {
    if (rows.length) charts.push({ id, title, kind, unit, rows,
      ...(limit !== undefined && rows.length > limit ? {rows:rows.slice(0,limit), tableRows:rows} : {}),
      ...(unit === 'myanimelist' && input.mal?.size ? {decimals:2} as const : {}) });
  }
  add('plays-by-show', 'Plays by show', 'bar', 'plays', rankedWatches(byPlays), 10);
  add('hours-by-show', 'Hours by show', 'bar', 'minutes', rankedWatches(byMinutes), 10);
  if (totals.plays) add('rewatches', 'Rewatches', 'meter', 'plays', [
    { label: 'First watches', value: BigInt(totals.episodes) }, { label: 'Rewatches', value: totals.plays - BigInt(totals.episodes) },
  ]);
  add('rewatched-shows', 'Most rewatched shows', 'bar', 'times', rankedWatches(repeatShows), 5);
  if (ratings.some(row => row.value)) add('ratings', 'My ratings', 'column', 'shows', ratings);
  if (decades.size) {
    const years = [...decades.keys()];
    const last = Math.max(...years);
    const distribution = [];
    for (let decade = Math.min(...years); decade <= last; decade += 10) {
      distribution.push({ label: decade + 's', value: decades.get(decade) ?? 0 });
    }
    add('decades', 'Shows by decade', 'column', 'shows', distribution);
  }
  if (bands.some(row => row.value)) add('progress', 'Shows by how much has been watched', 'column', 'shows', bands);
  add('genres', 'By genre', 'bar', 'minutes', rankedNames(genres), 8);
  add('networks', 'By network', 'bar', 'minutes', rankedNames(networks), 8);
  add('countries', 'By country of origin', 'bar', 'shows', rankedNames(countries), 8);
  add('cast', 'Cast members seen most', 'bar', 'shows', rankedNames(cast), 8);
  rated.sort(compareTitles);
  for (const [source, name] of [
    ['tmdb', 'TMDB’s average'], ['tomatoes', 'Rotten Tomatoes'], ['metacritic', 'Metacritic'], ['imdb', 'IMDb'],
    ['myanimelist', 'MyAnimeList'],
  ] as const) {
    const rows: StatisticsRow[] = [];
    for (const show of rated) {
      const value = source === 'tmdb' ? show.tmdb : source === 'imdb' ? input.imdb?.get(show.id) :
        source === 'myanimelist' ? input.mal?.get(show.id) ?? input.critics?.get(show.id)?.myanimelist : input.critics?.get(show.id)?.[source];
      if (value != null) rows.push({ label: show.title, value, rating: show.rating });
    }
    add(source, 'My rating against ' + name, 'dots', source, rows);
  }
  return { totals, omittedShows, missingCast, charts };
}
