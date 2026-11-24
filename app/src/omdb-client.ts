import { fetchProviderJson, providerDeadline, serviceRetryAt } from './provider-http.ts';
import { normalizedRating } from './ratings-csv.ts';

export interface OmdbRatings { rating:number | null; episodes:Map<number,number> }
type Failure = 'refused'|'throttled'|'unreachable'|'invalid-response'|'superseded';
const messages:Record<Failure,string> = {refused:'OMDb refused the request.', throttled:'OMDb is limiting requests.',
  unreachable:'Cannot reach OMDb.', 'invalid-response':'OMDb returned an unreadable response.',
  superseded:'The OMDb request is no longer current.'};
export class OmdbError extends Error {
  readonly kind:Failure;
  readonly retryAt?:number;
  constructor(kind:Failure, message=messages[kind], retryAt?:number) {
    super(message); this.name = 'OmdbError'; this.kind = kind; this.retryAt = retryAt;
  }
}
const missing = ():OmdbRatings => ({rating:null, episodes:new Map()});
const record = (value:unknown):value is Record<string,unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function numberField(value:unknown, field:'position'|'score'):number|null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  // Check the exact decimal text before conversion can round an invalid position or score into range.
  const format = field === 'position' ? /^\d+(?:\.0+)?$/ : /^0*(?:\d(?:\.\d+)?|10(?:\.0+)?)$/;
  if (!format.test(String(value))) return null;
  const n = Number(value);
  return field === 'position' && !Number.isSafeInteger(n) ? null : n;
}
function parseResult(value:unknown, imdbId:string, season:number|null):OmdbRatings {
  if (!record(value) || value.Response !== 'True' ||
    (value.imdbID !== undefined && value.imdbID !== imdbId)) throw new OmdbError('invalid-response');
  if (season === null) {
    if (value.Type !== 'series' || value.imdbID !== imdbId) throw new OmdbError('invalid-response');
    return {rating:numberField(value.imdbRating,'score'), episodes:new Map()};
  }
  if (numberField(value.Season,'position') !== season || !Array.isArray(value.Episodes)) {
    throw new OmdbError('invalid-response');
  }
  const episodes = new Map<number,number>();
  const identified = new Map<number,Map<string,string>>();
  for (const entry of value.Episodes) {
    if (!record(entry)) throw new OmdbError('invalid-response');
    const number = numberField(entry.Episode,'position');
    if (number === null) continue;
    const score = numberField(entry.imdbRating,'score');
    if (score === null) episodes.delete(number);
    else episodes.set(number,score);
    const title = typeof entry.imdbID === 'string' ? /^tt0*([1-9]\d*)$/.exec(entry.imdbID)?.[1] : undefined;
    if (title) {
      const byTitle = identified.get(number) ?? new Map<string,string>();
      identified.set(number,byTitle);
      if (score === null) byTitle.delete(title);
      else byTitle.set(title,normalizedRating(String(entry.imdbRating)));
    }
  }
  // The final report for each title wins. Two titles with incompatible scores
  // cannot both identify the episode csvTV displays at the shared position.
  for (const [number,byTitle] of identified) {
    if (byTitle.size > 1 && new Set(byTitle.values()).size > 1) episodes.delete(number);
  }
  return {rating:null,episodes};
}

interface Options { fetch?:typeof fetch; now?:()=>number; sleep?:(ms:number)=>Promise<void>; inactivityMs?:number }
export class OmdbClient {
  readonly #options:Options;
  constructor(options:Options={}) { this.#options = options; }
  async lookup(imdbId:string, season:number|null, key:string, current=async()=>true):Promise<OmdbRatings> {
    if (!/^tt\d+$/.test(imdbId) || (season !== null && (!Number.isSafeInteger(season) || season < 0))) {
      throw new OmdbError('invalid-response');
    }
    const url = new URL('https://www.omdbapi.com/');
    url.searchParams.set('i',imdbId);
    if (season !== null) url.searchParams.set('Season', String(season));
    url.searchParams.set('apikey',key);
    const sleep = this.#options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve,ms)));
    for (let attempt=0; attempt<5; attempt++) {
      if (!await current()) throw new OmdbError('superseded');
      const {status,headers,value} = await fetchProviderJson(url,{method:'GET'},this.#options.fetch ?? globalThis.fetch,
        this.#options.inactivityMs ?? 60_000, status => status < 500, kind => new OmdbError(kind), 4 * 1024 * 1024);
      if (status >= 500 && status < 600) {
        const maintenance = serviceRetryAt({status,headers},(this.#options.now ?? Date.now)());
        if (maintenance !== undefined) throw new OmdbError('throttled','OMDb is temporarily unavailable.',maintenance);
        if (!await current()) throw new OmdbError('superseded');
        if (attempt < 4) await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (status === 429) throw new OmdbError('throttled',undefined,providerDeadline(headers,(this.#options.now ?? Date.now)()));
      if (status === 404) return missing();
      if (status < 200 || status >= 300 || (record(value) && value.Response === 'False')) {
        const error = record(value) && typeof value.Error === 'string' ? value.Error : '';
        if (status === 200 && /^(?:(?:Movie|Series|Season|Episode) not found|Incorrect IMDb ID|Series or season not found)[.!]?$/i.test(error)) {
          return missing();
        }
        // Free-form replies may contain a credential-bearing URL; show only known provider messages.
        const safe = ['Invalid API key!', 'No API key provided.', 'Request limit reached!'].find(text =>
          text.toLowerCase() === error.toLowerCase());
        throw new OmdbError('refused',safe);
      }
      return parseResult(value,imdbId,season);
    }
    throw new OmdbError('unreachable');
  }
}
