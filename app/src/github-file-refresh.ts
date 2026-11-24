import { GithubRatingsError, type UnchangedRatingsFile } from './github-ratings-client.ts';
import type { ImdbPause } from './imdb-store.ts';
import type { DeviceStore } from './storage.ts';
import { credentialId } from './tmdb-store.ts';
import type { MetadataEnvironment } from './tmdb-service.ts';

const week = 7 * 86_400_000;
export const githubBlocked = (pause:ImdbPause|null, now:number) => !!pause && (pause.until === null || pause.until > now);

interface State {
  generation:bigint;
  githubGeneration:bigint;
  config:{github_repo:string|null; github_token:string|null};
  file:{digest:string; fetchedAt:number; firstAt:number}|null;
  githubPause:ImdbPause|null;
  needsFile:boolean;
}
export interface FileUpdate<F> { fileError:string|null; needsFile?:boolean; githubPause?:ImdbPause|null; file?:F }
export interface GithubQuota { provider:'github'; hash:string; pause:ImdbPause|null }

// A device uses one GitHub token for both jobs. Settle an in-flight request's refusal
// or limit before either job can send another request with the same credential.
const lanes = new WeakMap<object,Map<string,Promise<void>>>();
export async function inGithubLane<T>(store:object, credential:string, work:()=>Promise<T>) {
  const key = credential ? await credentialId(credential) : '';
  let queue = lanes.get(store);
  if (!queue) { queue = new Map(); lanes.set(store,queue); }
  const next = (queue.get(key) ?? Promise.resolve()).then(work);
  const settled = next.then(()=>{},()=>{});
  queue.set(key,settled);
  return next.finally(()=>{ if (queue.get(key) === settled) queue.delete(key); });
}

interface Options<S extends State, D extends {digest:string;unchanged?:false}> {
  store:DeviceStore;
  environment:MetadataEnvironment;
  state:()=>Promise<S>;
  enabled:(state:S)=>boolean;
  active:()=>boolean;
  download:(repo:string,token:string,current:()=>Promise<boolean>,savedDigest?:string)=>Promise<D|UnchangedRatingsFile>;
  save:(state:S,update:FileUpdate<S['file']>,current:()=>boolean,quota?:GithubQuota,data?:D)=>Promise<boolean>;
}
export class GithubFileRefresh<S extends State,D extends {digest:string;unchanged?:false}> {
  readonly #options:Options<S,D>;
  readonly #running = new Map<bigint,{request:{force:boolean}; work:Promise<void>}>();
  constructor(options:Options<S,D>) { this.#options = options; }

  async refresh(force=false):Promise<void> {
    const o = this.#options;
    const writer = () => o.active() && o.store.role === 'writer';
    if (!writer()) return;
    const initial = await o.state();
    if (!o.active() || !o.enabled(initial) || !initial.config.github_repo || !initial.config.github_token || o.store.role !== 'writer') return;
    const generation = initial.generation;
    const existing = this.#running.get(generation);
    if (existing) {
      existing.request.force ||= force;
      return existing.work;
    }
    const request = {force};
    const work = inGithubLane(o.store, initial.config.github_token, async () => {
      try {
        if (!writer()) return;
        const state = await o.state();
        const {github_repo:repo, github_token:token} = state.config;
        if (!o.active() || state.generation !== generation || !repo || !token || o.store.role !== 'writer') return;
        const pause = state.githubPause, now = o.environment.now();
        if (githubBlocked(pause,now) && !(request.force && pause?.kind === 'refused')) return;
        if (!request.force && !state.needsFile && state.file && state.file.fetchedAt <= now && now-state.file.fetchedAt <= week && !pause) return;
        if (!o.environment.online()) {
          if (request.force) await o.save(state,{fileError:'Cannot reach GitHub while offline.'},writer);
          return;
        }
        if (!request.force && !o.environment.visible()) return;
        const owns = async () => {
          if (!writer()) return false;
          const live = await o.state();
          return writer() && live.generation === state.generation && live.config.github_token === token;
        };
        const permitted = () => writer() && o.environment.online() && (request.force || o.environment.visible());
        const current = async () => await owns() && permitted();
        let data:D|undefined;
        let update:FileUpdate<S['file']>;
        try {
          const received = await o.download(repo,token,current,state.file?.digest);
          update = {githubPause:null, fileError:null, needsFile:false};
          if (received.unchanged) {
            if (!state.file || state.file.digest !== received.digest) throw new GithubRatingsError('invalid-file',200);
            const checkedAt = o.environment.now();
            update.file = {...state.file, fetchedAt:checkedAt, firstAt:Math.min(state.file.firstAt,checkedAt)};
          } else data = received;
        } catch (error) {
          if (!(error instanceof GithubRatingsError)) throw error;
          if (error.kind === 'superseded') return;
          let nextPause:ImdbPause|null = null;
          if (error.kind === 'refused') nextPause = {kind:'refused',until:null,message:error.message};
          else if (error.kind === 'throttled' || (pause?.kind === 'throttled' && error.kind === 'unreachable')) {
            nextPause = {kind:'throttled', until:error.retryAt ?? o.environment.now()+60_000, message:error.message};
          }
          update = {githubPause:nextPause, fileError:error.message, needsFile:true};
        }
        const quota:GithubQuota|undefined = pause || update.githubPause ?
          {provider:'github',hash:await credentialId(token),pause:update.githubPause ?? null} : undefined;
        // A file can finish parsing or hashing after a background visit ends.
        // Keep refusing or throttling the credential even if its tab just hid.
        const admit = update.needsFile === false ? permitted : writer;
        if (await owns() && admit() && await o.save(state,update,admit,quota,data)) return;
        // A job can be disabled while a request for the shared token is in flight.
        if (o.active() && o.store.role === 'writer' && update.githubPause && quota) {
          await o.store.writeGithubGate(state.githubGeneration,quota.hash,update.githubPause,o.active);
        }
      } finally { this.#running.delete(generation); }
    });
    this.#running.set(generation,{request,work});
    return work;
  }
}
