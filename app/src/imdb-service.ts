import { ImdbGithubClient, type ImdbDownload } from './imdb-github.ts';
import { GithubFileRefresh, type FileUpdate, type GithubQuota } from './github-file-refresh.ts';
import { indexImdbEpisodes } from './ratings-worker-client.ts';
import { abortableProviderRead } from './provider-http.ts';
import { imdbCacheKey, imdbSource, sourcePause, type ImdbDisplayState, type ImdbPause, type ImdbSetting, type ImdbState, type ImdbWrite } from './imdb-store.ts';
import { OmdbClient, OmdbError, type OmdbRatings } from './omdb-client.ts';
import { credentialId } from './tmdb-store.ts';
import { isProviderKey } from './provider-credentials.ts';
import { StaleSnapshotError, type ImdbHeaders } from './storage.ts';
import type { TmdbService } from './tmdb-service.ts';
export type {ImdbSource, ImdbSetting} from './imdb-store.ts';

const day = 86_400_000;
const uniqueIds = (ids:Iterable<number>) => [...new Set(ids)].filter(id => Number.isSafeInteger(id) && id >= 0);
const fresh = (at:number, now:number) => at <= now && now - at <= 7 * day;
const blocked = (pause:ImdbPause|null, now:number) => !!pause && (pause.until === null || pause.until > now);
function imdbNumber(id:string):number|null {
  const number = Number(id.slice(2));
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}
const bucket = (id:number) => id % 256;
const showBucket = (index:number) => imdbCacheKey('github','shows',index);
const fileKey = () => imdbCacheKey('github','file');
const omdbKey = (id:string, season:number|null) => season === null ?
  imdbCacheKey('omdb',id) : imdbCacheKey('omdb',id,season);
interface OmdbEntry { at:number; value:OmdbRatings; checkedEpisodeIds?:boolean }
type Episodes = Map<number,Map<number,number>>;
interface EpisodeFileRead { ticket:string; file:Promise<Blob | null>; using:number }
interface EpisodeIndexRead { controller:AbortController; work:Promise<Episodes>; readers:number }

export class ImdbService {
  readonly #tmdb:TmdbService;
  readonly #omdb:OmdbClient;
  readonly #fileRefresh:GithubFileRefresh<ImdbState,ImdbDownload>;
  #closed = false;
  #configurationEpoch = 0;
  readonly #configChanged = () => { this.#configurationEpoch++; this.#readerIndex = undefined; };
  #work = new Map<bigint,Promise<void>>();
  #episodes = new Map<string,EpisodeIndexRead>();
  readonly #lifetime = new AbortController();
  #fileRead?:EpisodeFileRead;
  #readerIndex?:{ticket:string; episodes:Episodes};
  constructor(tmdb:TmdbService, clients:{omdb?:OmdbClient; github?:ImdbGithubClient}={}) {
    this.#tmdb = tmdb;
    this.#omdb = clients.omdb ?? new OmdbClient();
    const github = clients.github ?? new ImdbGithubClient({},this.#lifetime.signal);
    this.#fileRefresh = new GithubFileRefresh({
      store:tmdb.store, environment:tmdb.environment, state:() => this.#store.imdbState(),
      enabled:state => imdbSource(state.config) === 'github', active:() => !this.#closed,
      download:(repo,token,current,digest) => github.download(repo,token,current,digest),
      save:(state,update,current,quota,file) => this.#saveFile(state,update,current,quota,file),
    });
    tmdb.store.addEventListener('imdbconfigchange',this.#configChanged);
  }
  close() {
    this.#closed = true;
    this.#lifetime.abort();
    for (const job of this.#episodes.values()) job.controller.abort();
    this.#readerIndex = undefined;
    this.#store.removeEventListener('imdbconfigchange',this.#configChanged);
  }
  get #store() { return this.#tmdb.store; }
  get #now() { return this.#tmdb.environment.now(); }
  #writer() { return !this.#closed && this.#store.role === 'writer'; }
  #canSend(background:boolean) {
    return this.#writer() && this.#tmdb.environment.online() &&
      (!background || this.#tmdb.environment.visible());
  }
  async #owns(generation:bigint) {
    if (!this.#writer()) return false;
    const state = await this.#store.imdbState();
    return state.generation === generation && this.#writer() &&
      !!(imdbSource(state.config) === 'omdb' ? state.config.omdb_key : state.config.github_token);
  }
  async status() {
    const state = await this.#store.imdbState();
    const source = imdbSource(state.config);
    const pause = sourcePause(source,state);
    const active = blocked(pause,this.#now) ? pause : null;
    const file = source === 'github' ? state.file : null;
    return {source, generation:state.configGeneration, hasOmdbKey:!!state.config.omdb_key, hasToken:!!state.config.github_token,
      repository:state.config.github_repo ?? '', refused:active?.kind === 'refused',
      message:active?.message ?? (source === 'github' ? state.fileError : null), retryAt:active?.until ?? undefined,
      fetchedAt:file?.fetchedAt ?? null, unchangedSince:file && file.fetchedAt - file.firstAt >= 7*day ? file.firstAt : null,
      showCount:file?.showCount ?? 0, episodeCount:file?.episodeCount ?? 0};
  }
  async sourceStatus() {
    const state = await this.#store.imdbDisplayState();
    const pause = blocked(state.pause,this.#now) ? state.pause : null;
    return {source:state.source,generation:state.configGeneration,refused:pause?.kind==='refused',retryAt:pause?.until ?? undefined};
  }
  async configure(name:ImdbSetting, value:string|null, expectedGeneration?:bigint, formCurrent = () => true) {
    if (isProviderKey(name) && this.#store.providerKeysAvailable === false) throw new Error('Connect to Dropbox to change provider keys.');
    if (value && /[\r\n]/.test(value)) throw new Error('Enter a single value.');
    const cleaned = value?.trim() || null;
    const next = name === 'imdb_source' && cleaned === 'none' ? null : cleaned;
    const epoch = this.#configurationEpoch;
    const current = () => !this.#closed && formCurrent() && this.#configurationEpoch === epoch;
    const expected = expectedGeneration ?? (await this.#store.imdbState()).configGeneration;
    for (;;) {
      const state = await this.#store.imdbState();
      if (!current() || state.configGeneration !== expected) throw new Error('The IMDb settings changed. Reopen this control.');
      if (state.config[name] === next) return;
      try {
        await this.#store.commit(state.revision, next === null ? {remove:{settings:[name]}} :
          {put:{settings:[{setting:name,value:next}]}}, {current});
        return;
      } catch (error) { if (!(error instanceof StaleSnapshotError) || !current()) throw error; }
    }
  }

  /** Read once per bucket, even when a chart or Library sort spans hundreds of shows. */
  async readShows(values:Iterable<number>, validUntil?: (deadline:number) => void,
    readHeaders?: () => Promise<ImdbHeaders | undefined>, signal?:AbortSignal):Promise<Map<number,number>> {
    const state = await this.#store.imdbDisplayState(signal), {source} = state;
    const result = new Map<number,number>();
    if (source === 'none' || (source === 'github' && !state.file)) return result;
    const wanted = uniqueIds(values);
    const external = readHeaders && validUntil && signal && wanted.length >= 16
      ? await this.#store.imdbExternalEntries(wanted,signal).catch(()=>undefined) : undefined;
    signal?.throwIfAborted();
    // Validate the report generation after both independent reads. A replaced
    // report must resolve identities from current storage, including external IDs.
    const headers = readHeaders ? await readHeaders() : undefined;
    signal?.throwIfAborted();
    const ids = await this.#store.imdbIdentities(wanted,this.#now,validUntil,headers,headers ? external : undefined,signal);
    const mapped = [...ids].filter((item):item is [number,string] => !!item[1]);
    if (source === 'omdb') {
      const entries = await this.#store.imdbValues<OmdbEntry>(state.generation,mapped.map(([,id]) => omdbKey(id,null)),undefined,signal);
      mapped.forEach(([show],i) => { const rating = entries[i]?.value.rating; if (rating != null) result.set(show,rating); });
    } else {
      // The record keeps IMDb IDs as text. The job only indexes safe integers.
      const indexed = new Map<number,number>();
      for (const [show,id] of mapped) {
        const number = imdbNumber(id);
        if (number !== null) indexed.set(show, number);
      }
      const buckets = [...new Set(Array.from(indexed.values(), bucket))];
      const entries = await this.#store.imdbValues<Map<number,number>>(state.generation,buckets.map(showBucket),state.file!.digest,signal);
      const lookup = new Map(buckets.map((b,i) => [b,entries[i]]));
      for (const [show,number] of indexed) {
        const rating = lookup.get(bucket(number))?.get(number);
        if (rating !== undefined) result.set(show,rating);
      }
    }
    return result;
  }
  async readSeason(show:number, season:number, signal?:AbortSignal):Promise<Map<number,number>> {
    const state = await this.#store.imdbDisplayState(signal,{id:show,now:this.#now}), {source,imdbId:id} = state;
    if (source === 'none') return new Map();
    if (!id) return new Map();
    if (source === 'omdb') {
      const [entry] = await this.#store.imdbValues<OmdbEntry>(state.generation,[omdbKey(id,season)],undefined,signal);
      return entry?.value.episodes ?? new Map();
    }
    const file = state.file;
    if (!file) return new Map();
    const number = imdbNumber(id);
    if (number === null) return new Map();
    // Older indices retained the last score at each position, including conflicting IMDb titles.
    const key = imdbCacheKey('github','episodes',number,2);
    const ticket = [state.generation,file.digest,number].join('/');
    const remembered = this.#readerIndex;
    if (remembered?.ticket === ticket && this.#store.role === 'reader') {
      if (this.#closed) return new Map();
      return new Map(remembered.episodes.get(season));
    }
    const [cached] = await this.#store.imdbValues<Episodes>(state.generation,[key],file.digest,signal);
    if (cached) return cached.get(season) ?? new Map();
    if (this.#closed) return new Map();
    signal?.throwIfAborted();
    let job = this.#episodes.get(ticket);
    if (!job || job.controller.signal.aborted) {
      const controller = new AbortController();
      const work = this.#indexEpisodes(state,number,key,ticket,controller.signal).finally(() => {
        if (this.#episodes.get(ticket)?.controller === controller) this.#episodes.delete(ticket);
      });
      job = {controller,work,readers:0};
      this.#episodes.set(ticket,job);
    }
    job.readers++;
    try {
      const episodes = await (signal ? abortableProviderRead(signal,job.work) : job.work);
      return new Map(episodes.get(season));
    } catch (error) {
      if (this.#closed) return new Map();
      throw error;
    } finally { if (--job.readers === 0) job.controller.abort(); }
  }
  async #readEpisodeFile(state:ImdbDisplayState, show:number, signal:AbortSignal):Promise<Episodes | null> {
    const digest = state.file!.digest;
    const ticket = state.generation + '/' + digest;
    let reading = this.#fileRead;
    if (!reading || reading.ticket !== ticket) {
      const file = this.#store.imdbValues<Blob | ArrayBuffer>(state.generation,[fileKey()],digest)
        .then(([bytes]) => bytes instanceof Blob ? bytes : bytes ? new Blob([bytes]) : null);
      this.#fileRead = reading = {ticket,file,using:0};
    }
    reading.using++;
    try {
      const file = await reading.file;
      return file && !this.#closed ? await indexImdbEpisodes(file,show,signal) : null;
    } finally {
      if (--reading.using === 0 && this.#fileRead === reading) this.#fileRead = undefined;
    }
  }
  async #indexEpisodes(state:ImdbDisplayState, show:number, key:IDBValidKey, ticket:string, signal:AbortSignal):Promise<Episodes> {
    const digest = state.file!.digest;
    const episodes = await this.#readEpisodeFile(state,show,signal);
    if (!episodes || signal.aborted || this.#closed) return new Map();
    if (this.#store.role === 'writer' && this.#store.providerKeysAvailable !== false) {
      const saved = await this.#store.writeImdb(state.generation,{expectedDigest:digest,entries:[[key,episodes]],
        removeLegacyEpisodesFor:show,silent:true},()=>!this.#closed && !signal.aborted);
      if (!saved) return new Map();
    } else {
      const latest = await this.#store.imdbDisplayState(signal);
      if (this.#closed || latest.generation !== state.generation || latest.file?.digest !== digest) return new Map();
      if (this.#store.role === 'reader') {
        let rows = 0;
        for (const season of episodes.values()) rows += season.size;
        // A read-only tab cannot persist this index. Keep one ordinary-sized
        // series in memory so moving between its seasons needs no second scan.
        this.#readerIndex = rows <= 4096 ? {ticket,episodes} : undefined;
      }
    }
    return episodes;
  }
  async refreshShows(ids:Iterable<number>, background=false) { await this.#refresh(uniqueIds(ids),null,background); }
  async refreshSeason(show:number, season:number) {
    if (Number.isSafeInteger(season) && season >= 0) await this.#refresh(uniqueIds([show]),season,false);
  }
  async #refresh(shows:number[], season:number|null, background:boolean) {
    if (!this.#canSend(background)) return;
    const epoch = this.#configurationEpoch;
    const state = await this.#store.imdbState(), source = imdbSource(state.config);
    if (source === 'none' || (source === 'omdb' && !state.config.omdb_key)) return;
    if (source === 'github' && background) await this.refreshFile(false);
    if (!this.#canSend(background) || !shows.length || (source === 'omdb' && blocked(state.omdbPause,this.#now))) return;
    const known = await this.#store.imdbIdentities(shows,this.#now);
    if (!this.#canSend(background)) return;
    const checked = new Map<string,number>();
    if (source === 'omdb' && shows.length > 1) {
      const ids = [...new Set(known.values())].filter((id):id is string=>!!id);
      if (ids.length) {
        const entries = await this.#store.imdbValues<OmdbEntry>(state.generation,ids.map(id=>omdbKey(id,season)));
        entries.forEach((entry,i)=>{ if (entry) checked.set(ids[i],entry.at); });
      }
    }
    for (const show of shows) {
      let imdb = known.get(show);
      const at = imdb ? checked.get(imdb) : undefined;
      if (imdb === null || (imdb && source === 'github') || (at !== undefined && fresh(at,this.#now))) continue;
      if (!await this.#owns(state.generation) || !this.#canSend(background)) return;
      if (imdb === undefined && show > 0) {
        try { imdb = await this.#tmdb.imdbIdentity(show,background,()=>!this.#closed && this.#configurationEpoch === epoch); }
        catch { continue; } // TMDB's own gate and credential are independent of OMDb/GitHub.
      }
      if (!imdb || source !== 'omdb') continue;
      const id = imdb;
      const previous = this.#work.get(state.generation) ?? Promise.resolve();
      const work = previous.then(() => this.#refreshOmdb(id,season,state.generation,background));
      const settled = work.then(() => {},() => {});
      this.#work.set(state.generation,settled);
      try { if (!await work) return; }
      finally { if (this.#work.get(state.generation) === settled) this.#work.delete(state.generation); }
    }
  }
  async #refreshOmdb(id:string, season:number|null, generation:bigint, background:boolean) {
    if (!this.#canSend(background)) return false;
    const state = await this.#store.imdbState(), key = state.config.omdb_key;
    if (!key || state.generation !== generation || !this.#canSend(background) || blocked(state.omdbPause,this.#now)) return false;
    const cacheKey = omdbKey(id,season);
    const [previous] = await this.#store.imdbValues<OmdbEntry>(generation,[cacheKey]);
    if (previous && fresh(previous.at,this.#now) && (season === null || previous.checkedEpisodeIds)) return true;
    let write:ImdbWrite;
    try {
      const value = await this.#omdb.lookup(id,season,key,async()=>await this.#owns(generation) && this.#canSend(background));
      write = {entries:[[cacheKey,{at:this.#now,value,checkedEpisodeIds:season !== null}]]};
      if (state.omdbPause) write.update = {omdbPause:null};
    } catch (error) {
      if (!(error instanceof OmdbError)) throw error;
      if (error.kind === 'superseded') return false;
      let pause:ImdbPause;
      if (error.kind === 'refused') pause = {kind:'refused',until:this.#now+day,message:error.message};
      else if (error.kind === 'throttled') {
        const strikes = (state.omdbPause?.strikes ?? 0) + 1;
        const delay = strikes >= 5 ? 15*60_000 : 1000 * 2 ** (strikes-1);
        pause = {kind:'throttled',until:error.retryAt ?? this.#now+delay,strikes,message:error.message};
      } else if (state.omdbPause) pause = {kind:'throttled',until:this.#now+60_000,message:error.message};
      else return true; // Continue with other independent titles after a failed lookup.
      write = {update:{omdbPause:pause}};
    }
    if (!await this.#owns(generation)) return false;
    if (write.update) write.quota = {provider:'omdb',hash:await credentialId(key),pause:write.update.omdbPause ?? null};
    // A quota reply governs the next request even if the background job just
    // stopped. Admit a successful score only while its original job can run.
    const current = () => !this.#closed && (!write.entries || this.#canSend(background));
    return current() && await this.#store.writeImdb(generation,write,current) && !write.update?.omdbPause;
  }

  refreshFile(force=false) { return this.#fileRefresh.refresh(force); }

  async #saveFile(state:ImdbState, update:FileUpdate<ImdbState['file']>, current:()=>boolean, quota?:GithubQuota, result?:ImdbDownload) {
    const write:ImdbWrite = {update,quota};
    if (result) {
      const now = this.#now, same = result.digest === state.file?.digest;
      write.update = {...update,file:{fetchedAt:now,firstAt:same ? Math.min(state.file!.firstAt,now) : now,digest:result.digest,
        showCount:result.shows.size,episodeCount:result.episodeCount}};
      if (!same) {
        const index = new Map<number,Map<number,number>>();
        for (const [id,score] of result.shows) {
          const b = bucket(id);
          let values = index.get(b);
          if (!values) { values = new Map(); index.set(b,values); }
          values.set(id,score);
        }
        write.deleteFileData = true;
        write.replacement = {bytes:result.bytes,buckets:index};
      }
    }
    return this.#store.writeImdb(state.generation,write,current);
  }
}
