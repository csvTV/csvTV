import { GithubRatingsClient, type GithubClientOptions } from './github-ratings-client.ts';
import { GithubFileRefresh, githubBlocked, type FileUpdate, type GithubQuota } from './github-file-refresh.ts';
import { readMalFile } from './mal-file.ts';
import type { MalSetting, MalState, MalWrite } from './mal-store.ts';
import { StaleSnapshotError } from './storage.ts';
import type { TmdbService } from './tmdb-service.ts';

export type {MalSetting} from './mal-store.ts';
export type MalSource = 'github'|'mdblist';
export class MalGithubClient extends GithubRatingsClient<Awaited<ReturnType<typeof readMalFile>>> {
  constructor(options:GithubClientOptions = {}) { super('mal',readMalFile,options); }
}
type Download = Exclude<Awaited<ReturnType<MalGithubClient['download']>>, {unchanged:true}>;

export class MalService {
  readonly #tmdb:TmdbService;
  readonly #fileRefresh:GithubFileRefresh<MalState,Download>;
  #closed = false;
  #configurationEpoch = 0;
  readonly #configChanged = () => { this.#configurationEpoch++; };
  constructor(tmdb:TmdbService, github = new MalGithubClient()) {
    this.#tmdb = tmdb;
    this.#fileRefresh = new GithubFileRefresh({
      store:tmdb.store, environment:tmdb.environment, state:() => tmdb.store.malState(),
      enabled:state => state.config.mal_source === 'github', active:() => !this.#closed,
      download:(repo,token,current,digest) => github.download(repo,token,current,digest),
      save:(state,update,current,quota,result) => this.#save(state,update,current,quota,result),
    });
    tmdb.store.addEventListener('malconfigchange',this.#configChanged);
  }
  close() { this.#closed = true; this.#tmdb.store.removeEventListener('malconfigchange',this.#configChanged); }

  async status() {
    const state = await this.#tmdb.store.malState(), now = this.#tmdb.environment.now();
    const source:MalSource = state.config.mal_source === 'github' ? 'github' : 'mdblist';
    const pause = source === 'github' && githubBlocked(state.githubPause,now) ? state.githubPause : null;
    const file = source === 'github' ? state.file : null;
    return {source,generation:state.generation, repository:state.config.github_repo ?? '', hasToken:!!state.config.github_token,
      refused:pause?.kind === 'refused', message:pause?.message ?? (source === 'github' ? state.fileError : null),
      retryAt:pause?.until ?? undefined, fetchedAt:file?.fetchedAt ?? null, entryCount:file?.entryCount ?? 0,
      unchangedSince:file && file.fetchedAt-file.firstAt >= 7*86_400_000 ? file.firstAt : null};
  }

  async configure(name:MalSetting, value:string|null, expectedGeneration?:bigint, formCurrent = () => true) {
    if (name === 'github_token' && this.#tmdb.store.providerKeysAvailable === false) throw Error('Connect to Dropbox to change provider keys.');
    if (value && /[\r\n]/.test(value)) throw Error('Enter a single value.');
    const next = name === 'mal_source' && value === 'mdblist' ? null : value?.trim() || null;
    const epoch = this.#configurationEpoch;
    const current = () => !this.#closed && formCurrent() && this.#configurationEpoch === epoch;
    const store = this.#tmdb.store, expected = expectedGeneration ?? (await store.malState()).generation;
    for (;;) {
      const state = await store.malState();
      if (!current() || state.generation !== expected) throw Error('The MyAnimeList settings changed. Reopen this control.');
      if (state.config[name] === next) return;
      try {
        await store.commit(state.revision, next === null ? {remove:{settings:[name]}} :
          {put:{settings:[{setting:name,value:next}]}}, {current});
        return;
      } catch (error) { if (!(error instanceof StaleSnapshotError) || !current()) throw error; }
    }
  }

  read(ids:Iterable<number>, signal?:AbortSignal) {
    return this.#tmdb.store.malEntries([...new Set(ids)].filter(id=>Number.isSafeInteger(id) && id>0),signal);
  }
  refreshFile(force=false) { return this.#fileRefresh.refresh(force); }

  async #save(state:MalState, changes:FileUpdate<MalState['file']>, current:()=>boolean, quota?:GithubQuota, result?:Download) {
    const {githubPause,...update} = changes;
    const write:MalWrite = {update,githubPause,quota};
    if (result) {
      const same = result.digest === state.file?.digest, now = this.#tmdb.environment.now();
      write.update.file = {digest:result.digest, fetchedAt:now,firstAt:same ? Math.min(state.file!.firstAt,now) : now,entryCount:result.entryCount};
      if (!same) write.replacement = {bytes:result.bytes, shows:result.shows};
    }
    return this.#tmdb.store.writeMal(state.generation,write,current);
  }
}
