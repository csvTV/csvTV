import type { EpisodeInfo, SeasonInfo, ShowInfo } from './progress.ts';
import type { TmdbResource } from './tmdb-client.ts';

type Kind = TmdbResource['kind'];
type Named = { id: number; name: string };
type Airing = { season: number; episode: number; airDate: string | null };

export interface TmdbConfiguration {
  secureBaseUrl: string;
  posterSizes: string[];
  backdropSizes: string[];
  profileSizes: string[];
  stillSizes: string[];
}
export interface TmdbTitle {
  show_id: number;
  show: string;
  firstAirDate: string | null;
  overview: string;
  posterPath: string | null;
  backdropPath: string | null;
}
export interface TmdbShow extends ShowInfo, TmdbTitle {
  broadcastSource?: string;
  status: string;
  /** Older device caches predate this field. A known absence (including zero votes) is null. */
  voteAverage?: number | null;
  seasons: (SeasonInfo & { name: string; posterPath: string | null })[];
  nextEpisode: Airing | null;
  lastAired: Airing | null;
  genres: Named[];
  networks: Named[];
  keywords: Named[];
  originCountries: string[];
  imdbId: string | null;
}
export interface TmdbEpisode extends EpisodeInfo {
  episode_id: number;
  runtime: number | null;
  stillPath: string | null;
  overview: string;
}
export interface TmdbSeason {
  show_id: number;
  season: number;
  name: string;
  posterPath: string | null;
  episodes: TmdbEpisode[];
  /** Provider positions observed with different IDs in previous snapshots. */
  reusedPositions?: number[];
}
export interface TmdbPage { page: number; totalPages: number; results: TmdbTitle[] }

/** An unfetched season keeps its estimated range. A cached 404 has no aired episodes. */
export function withSeasonDetails(show: TmdbShow, lookup: (season: number, index: number) => TmdbSeason | null | undefined,
    newerHeader?: (season: number, index: number) => boolean): ShowInfo {
  let next = show.nextEpisode;
  const seasons = show.seasons.map((season, index) => {
    const detail = lookup(season.season, index);
    if (detail === undefined) return season;
    const episodes = detail?.episodes ?? [], headerWins = newerHeader?.(season.season,index);
    if (next && next.season === season.season && !headerWins) {
      const listed = episodes.find(episode => episode.episode === next!.episode);
      if (!listed) next = null;
      else if (listed.airDate !== next.airDate) next = {...next,airDate:listed.airDate};
    }
    return { ...season, episodes, newerHeader:headerWins, reusedPositions:detail?.reusedPositions };
  });
  return { ...show, seasons, nextEpisode:next, nextAirDate:show.nextEpisode ? next?.airDate ?? null : show.nextAirDate };
}

/** A whole-show mark needs episode identities for every regular season, even offline. */
export function regularSeasonsCached(show: ShowInfo | null | undefined): boolean {
  return !!show && show.seasons.every(season => season.season === 0 || season.episodes !== undefined);
}
export interface TmdbDataByKind {
  configuration: TmdbConfiguration;
  countries: { code: string; name: string }[];
  show: TmdbShow;
  season: TmdbSeason;
  search: TmdbPage;
  recommendations: TmdbPage;
  cast: { id: number; name: string; profilePath: string | null; roles: string[]; episodeCount: number }[];
  person: (TmdbTitle & { character?: string })[];
  'external-ids': { imdbId: string | null };
  find: { shows: TmdbTitle[]; episodes: { show_id: number; episode_id: number; season: number; episode: number }[] };
}
/** All season lookups triggered by one numbering change share this observation. */
export interface RepairObservation { at: number; group?: string }
export interface CacheEntry<K extends Kind = Kind> {
  fetchedAt: number;
  value: TmdbDataByKind[K] | null;
  repairScan?: RepairObservation;
  /** Previously occupied slots in a season that now returns 404. */
  vacatedPositions?: number[];
}

function invalid(): never {
  // Never quote an untrusted response, URL, or a user-supplied token in an error.
  throw new Error('TMDB returned an invalid metadata response.');
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : invalid();
}
function text(value: unknown): string {
  return typeof value === 'string' ? value : invalid();
}
function id(value: unknown, minimum = 1): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum ? value : invalid();
}
function date(value: unknown): string | null {
  if (value == null || value === '') return null;
  const valueText = text(value);
  if (!/^\d{4}-\d\d-\d\d$/.test(valueText)) return invalid();
  const timestamp = Date.parse(valueText + 'T00:00:00Z');
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === valueText ? valueText : invalid();
}
function path(value: unknown): string | null {
  if (value == null || value === '') return null;
  return typeof value === 'string' && /^\/[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/.test(value) ? value : invalid();
}
function imdb(value: unknown): string | null {
  if (value == null || value === '') return null;
  return typeof value === 'string' && /^tt[0-9]+$/.test(value) ? value : invalid();
}
function named(value: unknown): Named {
  const r = object(value);
  return { id: id(r.id), name: text(r.name) };
}
function airing(value: unknown, showId: number): Airing | null {
  if (value == null) return null;
  const r = object(value);
  if (r.show_id != null && r.show_id !== showId) return invalid();
  return { season: id(r.season_number, 0), episode: id(r.episode_number, 0), airDate: date(r.air_date) };
}
function title(value: unknown): TmdbTitle {
  const r = object(value);
  return { show_id: id(r.id), show: text(r.name), overview: text(r.overview ?? ''), posterPath: path(r.poster_path),
    backdropPath: path(r.backdrop_path), firstAirDate: date(r.first_air_date) };
}
function sizes(value: unknown): string[] {
  return array(value).map(v => typeof v === 'string' && /^(original|[wh][1-9][0-9]*)$/.test(v) ? v : invalid());
}
function configuration(value: unknown): TmdbConfiguration {
  const r = object(object(value).images);
  if (r.secure_base_url !== 'https://image.tmdb.org/t/p/') return invalid();
  return { secureBaseUrl: r.secure_base_url, posterSizes: sizes(r.poster_sizes),
    backdropSizes: sizes(r.backdrop_sizes), stillSizes: sizes(r.still_sizes), profileSizes: sizes(r.profile_sizes) };
}
/** Only emit image URLs at the approved HTTPS host, using a size offered for the given image type. */
export function tmdbImageUrl(config: TmdbConfiguration, kind: 'poster' | 'backdrop' | 'profile' | 'still',
    size: string, file: string | null): string | null {
  if (!file || !/^\/[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/.test(file) ||
      !/^(original|[wh][1-9][0-9]*)$/.test(size) || !config[`${kind}Sizes`].includes(size) ||
      config.secureBaseUrl !== 'https://image.tmdb.org/t/p/') return null;
  return config.secureBaseUrl + size + file;
}
function show(value: unknown, expected: number): TmdbShow {
  const r = object(value);
  const basic = title(r);
  if (basic.show_id !== expected) return invalid();
  const seasons = array(r.seasons).map(entry => {
    const s = object(entry);
    return { season: id(s.season_number, 0), episodeCount: id(s.episode_count, 0),
      name: text(s.name ?? ''), posterPath: path(s.poster_path) };
  });
  if (new Set(seasons.map(s => s.season)).size !== seasons.length) return invalid();
  const average = r.vote_average;
  if (average != null && (typeof average !== 'number' || !Number.isFinite(average) || average < 0)) return invalid();
  const hasVotes = r.vote_count == null || id(r.vote_count, 0) > 0;
  const nextEpisode = airing(r.next_episode_to_air, expected);
  return { ...basic, seasons, status: text(r.status), voteAverage: hasVotes ? average ?? null : null, lastAired: airing(r.last_episode_to_air, expected),
    nextEpisode, nextAirDate: nextEpisode?.airDate ?? null, genres: array(r.genres ?? []).map(named),
    networks: array(r.networks ?? []).map(named), originCountries: array(r.origin_country ?? []).map(text),
    keywords: array(object(r.keywords).results).map(named), imdbId: imdb(object(r.external_ids).imdb_id) };
}
function season(value: unknown, showId: number, number: number): TmdbSeason {
  const r = object(value);
  if (id(r.season_number, 0) !== number || (r.show_id != null && r.show_id !== showId)) return invalid();
  const episodes = array(r.episodes).map(item => {
    const e = object(item);
    if ((e.season_number != null && e.season_number !== number) ||
        (e.show_id != null && e.show_id !== showId)) return invalid();
    return { episode: id(e.episode_number, 0), episode_id: id(e.id), title: text(e.name),
      airDate: date(e.air_date), runtime: e.runtime == null ? null : id(e.runtime, 0),
      overview: text(e.overview ?? ''), stillPath: path(e.still_path) };
  });
  if (new Set(episodes.map(e => e.episode)).size !== episodes.length ||
      new Set(episodes.map(e => e.episode_id)).size !== episodes.length) return invalid();
  return { show_id: showId, season: number, name: text(r.name ?? ''), posterPath: path(r.poster_path), episodes };
}
/** Appended resources have no independent URL identifying the season or show. */
export function appendedTmdbSeasons(raw: unknown, parent: TmdbShow, numbers: readonly number[]): Map<number, TmdbSeason> {
  const payload = object(raw), found = new Map<number, TmdbSeason>();
  const sourceHeaders = array(payload.seasons).map(object);
  for (const number of numbers) {
    const header = parent.seasons.find(s => s.season === number);
    if (!header) continue;
    try {
      const part = object(payload['season/' + number]);
      const episodes = array(part.episodes);
      const source = sourceHeaders.find(s => s.season_number === number);
      if ((part.id != null && part.id !== source?.id) || (part.show_id != null && part.show_id !== parent.show_id) ||
          episodes.length !== header.episodeCount || typeof part.name !== 'string' ||
          !('poster_path' in part) || episodes.some(row => {
            const episode = object(row);
            return episode.show_id !== parent.show_id || episode.season_number !== number;
          })) continue;
      const detail = season(part, parent.show_id, number);
      if (detail.name === header.name && detail.posterPath === header.posterPath) found.set(number, detail);
    } catch { /* The ordinary season endpoint can supply an absent or incomplete component. */ }
  }
  return found;
}

function normalize(resource: TmdbResource, raw: unknown): TmdbDataByKind[Kind] {
  if (resource.kind === 'countries') return array(raw).map(c => {
    const r = object(c);
    return { code: text(r.iso_3166_1), name: text(r.english_name) };
  });
  const r = object(raw);
  switch (resource.kind) {
    case 'configuration': return configuration(r);
    case 'show': return show(r, resource.id);
    case 'season': return season(r, resource.id, resource.season);
    case 'search':
    case 'recommendations':
      if (id(r.page) !== (resource.page ?? 1)) return invalid();
      return { page: resource.page ?? 1, totalPages: id(r.total_pages, 0), results: array(r.results).map(title) };
    case 'cast':
      if (id(r.id) !== resource.id) return invalid();
      return array(r.cast).map(c => {
        const member = object(c);
        return { ...named(member), profilePath: path(member.profile_path), episodeCount: id(member.total_episode_count, 0),
          roles: array(member.roles).map(role => text(object(role).character)) };
      });
    case 'person':
      if (id(r.id) !== resource.id) return invalid();
      return array(r.cast).map(credit => {
        const character = text(object(credit).character ?? '').trim();
        return character ? { ...title(credit), character } : title(credit);
      });
    case 'external-ids':
      if (id(r.id) !== resource.id) return invalid();
      return { imdbId: imdb(r.imdb_id) };
    case 'find':
      return { shows: array(r.tv_results).map(title), episodes: array(r.tv_episode_results).map(item => {
        const e = object(item);
        return { show_id: id(e.show_id), episode_id: id(e.id), season: id(e.season_number, 0), episode: id(e.episode_number, 0) };
      }) };
  }
}
export function normalizeTmdb<R extends TmdbResource>(resource: R, raw: unknown): TmdbDataByKind[R['kind']] {
  return normalize(resource, raw) as TmdbDataByKind[R['kind']];
}
