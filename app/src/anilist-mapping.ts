import { fetchProviderJson } from './provider-http.ts';
import { githubThrottle } from './github-ratings-client.ts';
import { inGithubLane } from './github-file-refresh.ts';
import type { DeviceStore } from './storage.ts';

const mappingUrl = 'https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-mini.json';
const maxMappingBytes = 16 * 1024 * 1024;
const maxMappingRows = 100_000;
export interface AniListMapping {
  kind: 'show' | 'film' | 'unmapped' | 'ambiguous';
  showId: number | null;
  season: number | null;
  offset: number | null;
  uncertainPlacement?: 'regular-sibling' | 'unanchored-supplement' | 'invalid-position' | 'series-only';
  /** Public media format used to describe an entry with no TMDB placement. */
  format?: string;
}
const formatLabels = new Map([
  ['TV', 'TV series'], ['SPECIAL', 'Special'], ['OVA', 'OVA'], ['ONA', 'ONA'],
  ['MOVIE', 'Film'], ['MUSIC', 'Music'],
]);
function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function number(value: unknown, minimum: number): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum ? value : null;
}
const invalid = () => Error('The public AniList mapping file could not be read.');
export function readAniListMapping(data: unknown, ids: ReadonlySet<number>): Map<number, AniListMapping> {
  if (!Array.isArray(data) || data.length > maxMappingRows) throw invalid();
  const selected = new Map<number, AniListMapping>();
  // The export may contain only a sequel. Use the full catalog to see if an unanchored
  // entry can stand for the entire show. Zero means several distinct regular entries.
  const regularEntryByShow = new Map<number,number>();
  const supplementalEntries = new Set<number>();
  let recognized = false;
  for (const value of data) {
    const row = object(value);
    if (!row) throw invalid();
    const id = number(row.anilist_id, 1);
    if (id === null) continue;
    recognized = true;
    const tmdb = object(row.themoviedb_id);
    const showId = number(tmdb?.tv, 1);
    const movie = Array.isArray(tmdb?.movie) ? tmdb.movie.some(id => number(id, 1) !== null) : number(tmdb?.movie, 1) !== null;
    let kind: AniListMapping['kind'] = movie ? 'film' : 'unmapped';
    if (showId !== null) kind = movie ? 'ambiguous' : 'show';
    const seasonFields = object(row.season);
    const rawSeason = seasonFields?.tmdb;
    const season = kind === 'show' ? number(rawSeason, 0) : null;
    const supplemental = row.type === 'SPECIAL' || row.type === 'OVA' || row.type === 'MOVIE' || row.type === 'MUSIC';
    if (kind === 'show' && showId !== null && season !== 0 && !supplemental) {
      const first = regularEntryByShow.get(showId);
      if (first === undefined) regularEntryByShow.set(showId,id);
      else if (first !== id && first !== 0) regularEntryByShow.set(showId,0);
    }
    if (!ids.has(id)) continue;
    if (supplemental) supplementalEntries.add(id);
    const offsetFields = object(row.episode_offset);
    const rawOffset = offsetFields?.tmdb;
    const parsedOffset = number(rawOffset, 0);
    let offset = season === null ? null : parsedOffset;
    const invalidPosition = kind === 'show' && ((row.season != null && !seasonFields) ||
      (rawSeason != null && season === null) || (row.episode_offset != null && !offsetFields) ||
      (rawOffset != null && parsedOffset === null));
    if (season !== null && season > 0) offset ??= 0;
    const next: AniListMapping = { kind, showId, season, offset };
    if (invalidPosition) next.uncertainPlacement = 'invalid-position';
    const prior = selected.get(id);
    if (kind === 'unmapped' && typeof row.type === 'string') {
      const format = formatLabels.get(row.type);
      if (format && (!prior || prior.format === format)) next.format = format;
    }
    if (prior && (prior.kind !== kind || prior.showId !== showId || prior.season !== next.season || prior.offset !== next.offset ||
        prior.uncertainPlacement !== next.uncertainPlacement)) {
      selected.set(id, { kind: 'ambiguous', showId: null, season: null, offset: null });
    } else selected.set(id, next);
  }
  if (!recognized) throw invalid();
  for (const [id, placement] of selected) {
    if (placement.kind !== 'show' || placement.showId === null || placement.season !== null || placement.uncertainPlacement) continue;
    const other = regularEntryByShow.get(placement.showId);
    if (supplementalEntries.has(id)) placement.uncertainPlacement = 'unanchored-supplement';
    else if (other !== undefined && other !== id) placement.uncertainPlacement = 'regular-sibling';
  }
  return selected;
}

interface MappingOptions {
  verify?: () => Promise<void>;
  sleep?: (ms:number, signal?:AbortSignal) => Promise<void>;
  store?: Pick<DeviceStore,'mappingGate'|'saveMappingGate'>;
  now?: () => number;
}
function backoff(ms:number, signal?:AbortSignal):Promise<void> {
  return new Promise((resolve,reject) => {
    signal?.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal!.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort',abort); resolve(); },ms);
    signal?.addEventListener('abort',abort,{once:true});
  });
}

/** All selection by AniList ID happens on this device. */
export async function fetchAniListMapping(ids: ReadonlySet<number>, signal?: AbortSignal, send: typeof fetch = fetch,
    options: MappingOptions = {}) {
  signal?.throwIfAborted();
  if (!ids.size) return new Map<number,AniListMapping>();
  const download = () => downloadMapping(ids, signal, send, options);
  return options.store ? inGithubLane(options.store,'',download) : download();
}

async function downloadMapping(ids: ReadonlySet<number>, signal: AbortSignal|undefined, send: typeof fetch, options: MappingOptions) {
  const now = options.now ?? Date.now;
  signal?.throwIfAborted();
  const gate = await options.store?.mappingGate();
  const save = async (until:number) => { if (gate) await options.store!.saveMappingGate(gate.epoch,until); };
  const limited = (until:number) => Error('GitHub is limiting downloads of the public AniList mapping file. Try again after ' +
    new Date(until).toLocaleString() + '.');
  signal?.throwIfAborted();
  if (gate && gate.until > now()) throw limited(gate.until);
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    await options.verify?.();
    let reply;
    try {
      reply = await fetchProviderJson(new URL(mappingUrl), { method: 'GET', signal }, send, 60_000, status => status === 403,
        kind => kind === 'invalid-response' ? invalid() : Error('Could not download the public AniList mapping file. Check your connection and try again.'),
        maxMappingBytes);
    } catch (error) {
      if (gate?.until && !signal?.aborted) await save(now() + 60_000);
      throw error;
    }
    const detail = object(reply.value)?.message ?? reply.value;
    const quota = githubThrottle(reply,typeof detail === 'string' ? detail : '',now());
    if (quota?.retryAt !== undefined) {
      await save(quota.retryAt);
      throw limited(quota.retryAt);
    }
    if (reply.status === 200) {
      const selected = readAniListMapping(reply.value, ids);
      if (gate?.until) await save(0);
      return selected;
    }
    if (reply.status < 500 || reply.status >= 600 || attempt === 4) {
      if (gate?.until && reply.status >= 500) await save(now() + 60_000);
      throw Error('Could not download the public AniList mapping file (HTTP ' + reply.status + ').');
    }
    await (options.sleep ?? backoff)(1000 * 2 ** attempt, signal);
  }
}
