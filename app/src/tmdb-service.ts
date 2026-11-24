import { DeviceStore, StaleSnapshotError, type PersonalSnapshot, type DeviceChanges, type ShowRows, type TmdbState } from './storage.ts';
import { TmdbClient, TmdbError, tmdbResourceKey, type RequestContext, type TmdbResource } from './tmdb-client.ts';
import { appendedTmdbSeasons, normalizeTmdb, withSeasonDetails, type CacheEntry, type RepairObservation, type TmdbDataByKind, type TmdbSeason, type TmdbShow } from './tmdb-data.ts';
import { cacheExpired, metadataRewrite, seasonWithCacheHistory } from './tmdb-refresh.ts';
import { localCalendarDate, type ShowInfo } from './progress.ts';
import { markAired, unresolvedAiringSeasons, type BulkWatchAction, type MarkScope } from './marks.ts';
import { broadcastSeasons } from './broadcast-seasons.ts';
import type { WatchedRow } from './model.ts';
import { recordedShowTitle } from './shows.ts';
import { watchPatch, type RecentMarkUndo, type ShowRecord, type WatchReceipt } from './watch-record.ts';
import { covers, observation, repairPatch, sameRepair, type RepairPreview } from './episode-repair.ts';
import {rateShow, type PersonalShow} from './personal-record.ts';

type Kind = TmdbResource['kind'];
type EpisodeResource = Extract<TmdbResource,{kind:'show'|'season'}>;
type RewriteRows = ShowRows & {tmdbKeyAccepted:boolean};
type SourceState = Omit<TmdbState,'cooldown'>;
interface ImportSeasonRequest { numbers: readonly number[]; received: Map<number, TmdbSeason> }
type KeyState = 'ready' | 'missing-key' | 'refused';
export type MetadataView<K extends Kind> = {
  status: KeyState | 'cached' | 'read-only' | 'offline' | 'unavailable' | 'not-found' | 'empty';
  value: TmdbDataByKind[K] | null;
  fetchedAt?: number;
  retryAt?: number;
  message?: string;
  reason?: 'missing-key' | 'refused' | 'read-only' | 'offline' | 'unavailable';
};

/** These outcomes only read the cache. A live reply or a newly refused key can change it. */
export function cacheOnlyView(view: {reason?: MetadataView<Kind>['reason']}) {
  return view.reason === 'missing-key' || view.reason === 'read-only' || view.reason === 'offline';
}

export interface MetadataEnvironment {
  now(): number;
  online(): boolean;
  visible(): boolean;
}

export const browserMetadataEnvironment: MetadataEnvironment = {
  now: Date.now,
  online: () => navigator.onLine,
  visible: () => document.visibilityState !== 'hidden',
};

function persistent(resource: TmdbResource): boolean {
  return resource.kind !== 'search' && resource.kind !== 'find';
}

function needsEpisodeScan(resource:EpisodeResource,entry:CacheEntry,watched:readonly WatchedRow[]):boolean {
  if (resource.kind === 'show') {
    const header = (entry as CacheEntry<'show'>).value;
    if (!header) return false;
    const listed = new Set(header.seasons.map(s=>s.season));
    return watched.some(row=>row.episode_id !== null && !listed.has(row.season));
  }
  const ids = new Set((entry as CacheEntry<'season'>).value?.episodes.map(e=>e.episode_id));
  return watched.some(row=>row.episode_id !== null && (row.season === resource.season) !== ids.has(row.episode_id));
}

function keyState(state: SourceState): KeyState {
  if (!state.token) return 'missing-key';
  return state.refused === null ? 'ready' : 'refused';
}

function empty(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0;
  if (value && typeof value === 'object' && 'results' in value) {
    return Array.isArray(value.results) && value.results.length === 0;
  }
  return false;
}

/** One service per device session. Only normalized public metadata enters the rebuildable cache. */
export class TmdbService {
  readonly store: DeviceStore;
  readonly environment: MetadataEnvironment;
  readonly client: TmdbClient;
  #requests = new Map<string, {request:Promise<CacheEntry>; priority:{background:boolean}}>();
  #responses = new Map<string, {request:Promise<unknown>; consumers:Map<()=>boolean,()=>boolean>}>();
  #backgroundSeasonScans = new Map<string, RepairObservation>();
  #writes?: Promise<{id:number;rows:RewriteRows}|undefined>;
  #episodeChecks = new WeakMap<CacheEntry,{revision:bigint;needed:boolean}>();
  #holds = new Set<() => void>();
  #resume = new EventTarget();
  #submission = 0;
  #closed = false;
  // Undo ends with this writer session and yields to later edits of the same show.
  #localWatchRevisions = new Map<number, bigint>();

  constructor(store: DeviceStore, client = new TmdbClient(), environment = browserMetadataEnvironment) {
    this.store = store;
    this.client = client;
    this.environment = environment;
  }

  /** Counted holds let a later guard or account dialog keep record mutations paused. */
  holdRecordChanges(): () => void {
    const release = () => {
      this.#holds.delete(release);
      if (!this.#holds.size) this.#resume.dispatchEvent(new Event('resume'));
    };
    this.#holds.add(release);
    return release;
  }

  async #writable(): Promise<void> {
    while (!this.#closed && this.#holds.size) {
      await new Promise<void>(resolve => this.#resume.addEventListener('resume', () => resolve(), { once: true }));
    }
    if (this.#closed || this.store.role !== 'writer') throw new TmdbError('superseded');
  }

  close(): void {
    this.#closed = true;
    this.cancelKeyCheck();
    for (const release of this.#holds) release();
  }

  keyStatus() {
    return this.store.tmdbState('access').then(state => ({
      status: keyState(state), message: state.refused, generation: state.generation,
      cachedMarkAccount: state.cachedMarkAccount,
    }));
  }

  cancelKeyCheck(): void { this.#submission++; }

  async saveKey(token: string): Promise<void> {
    const submission = ++this.#submission;
    if (!token.trim() || /[\r\n]/.test(token)) throw new Error('Enter the TMDB API Read Access Token.');
    await this.#writable();
    if (submission !== this.#submission) throw new TmdbError('superseded');
    if (!this.environment.online()) throw new TmdbError('unreachable');
    const ticket = await this.store.beginTmdbSubmission();
    const state = await this.store.tmdbState('access');
    const candidateActive = () => !this.#closed && submission === this.#submission && this.store.role === 'writer';
    const current = async () => candidateActive() && await this.store.isTmdbSubmissionCurrent(ticket) && candidateActive();
    const hooks: RequestContext = {
      current, generation: state.generation,
      readCooldown: () => this.store.tmdbSubmissionCooldown(ticket, token),
      writeCooldown: async cooldown => {
        if (!await this.store.writeTmdbSubmissionCooldown(ticket, token, cooldown, this.environment.now())) throw new TmdbError('superseded');
      },
    };
    const raw = await this.client.request({ kind: 'configuration' }, token, hooks);
    const value = normalizeTmdb({ kind: 'configuration' }, raw);
    const checked = { fetchedAt: this.environment.now(), value };
    const canCommit = () => !this.#closed && submission === this.#submission && this.#holds.size === 0;
    do {
      await this.#writable();
      if (!await current()) throw new TmdbError('superseded');
      if (await this.store.acceptTmdbSubmission(ticket, token, tmdbResourceKey({ kind: 'configuration' }), checked, canCommit)) return;
    } while (this.#holds.size);
    throw new TmdbError('superseded');
  }

  /** Called only after the owner confirms removing the displayed credential. */
  async removeKey(displayedGeneration: bigint): Promise<void> {
    this.cancelKeyCheck();
    for (;;) {
      await this.#writable();
      const [revision,current] = await Promise.all([this.store.recordRevision(),this.store.currentTmdbGeneration(displayedGeneration)]);
      if (!current) throw new TmdbError('superseded');
      try {
        await this.store.commit(revision, { remove: { settings: ['tmdb_key'] } },
          {current: () => !this.#closed && this.#holds.size === 0});
        return;
      } catch (error) { if (!(error instanceof StaleSnapshotError)) throw error; }
    }
  }

  #cooldownHooks(generation: bigint): Pick<RequestContext, 'readCooldown' | 'writeCooldown'> {
    return {
      readCooldown: async () => {
        const state = await this.store.tmdbState();
        if (state.generation !== generation) throw new TmdbError('superseded');
        return state.cooldown;
      },
      writeCooldown: async cooldown => {
        if (!await this.store.writeTmdb(generation, { cooldown }, this.environment.now())) throw new TmdbError('superseded');
      },
    };
  }

  async read<R extends TmdbResource>(resource: R, signal?: AbortSignal): Promise<CacheEntry<R['kind']> | null> {
    if (!persistent(resource)) return null;
    return await this.store.tmdbEntry<TmdbDataByKind[R['kind']] | null>(tmdbResourceKey(resource), this.environment.now(),signal) ?? null;
  }

  async refresh<R extends TmdbResource>(resource: R, background = false, current?:()=>boolean): Promise<CacheEntry<R['kind']>> {
    if (current && !current()) throw new TmdbError('superseded');
    const state = await this.store.tmdbState('access');
    if (current && !current()) throw new TmdbError('superseded');
    return this.#refreshWithState(resource,state,background);
  }

  async #refreshWithState<R extends TmdbResource>(resource:R, state:SourceState, background:boolean):Promise<CacheEntry<R['kind']>> {
    const entry = await this.#refreshOne(resource, state, background);
    if (resource.kind === 'season' || resource.kind === 'show') {
      await this.#locateEpisodes(resource, entry, state, background);
    }
    return entry;
  }

  async #refreshOne<R extends TmdbResource>(resource: R, state: SourceState, background: boolean,
      scan?: RepairObservation): Promise<CacheEntry<R['kind']>> {
    if (this.#closed || this.store.role !== 'writer') throw new TmdbError('superseded');
    if (!state.token || state.refused !== null) throw new TmdbError('refused');
    if (!this.environment.online() || (background && !this.environment.visible())) throw new TmdbError('unreachable');
    const key = tmdbResourceKey(resource);
    const id = this.#resourceId(state.generation,key);
    const pending = this.#requests.get(id);
    if (pending) {
      if (!background) pending.priority.background = false;
      return pending.request as Promise<CacheEntry<R['kind']>>;
    }
    const priority = {background};
    const request = this.#fetch(resource, key, state, state.token, background, true, undefined, scan, undefined, () => priority.background);
    this.#requests.set(id, {request,priority});
    try { return await request; }
    finally { this.#requests.delete(id); }
  }

  /** Search other seasons only when a reply moves a recorded ID, loses one,
   * or drops a recorded season. Internal lookups share transport requests
   * with screens and the detail job without recursively waiting on each other. */
  async #locateEpisodes(resource:EpisodeResource, entry: CacheEntry,
      state: SourceState, background: boolean): Promise<void> {
    const { id } = resource;
    if (resource.kind === 'show' && !entry.value) return;
    const checked = this.#episodeChecks.get(entry);
    const needed = checked && await this.store.recordRevision() === checked.revision ? checked.needed :
      needsEpisodeScan(resource,entry,(await this.store.tmdbRows(id,false)).tables.watched);
    if (!needed) return;
    let parent = resource.kind === 'show' ? entry as CacheEntry<'show'> : await this.read({ kind:'show',id });
    const scan = observation(entry);
    try {
      // The destination may be in a newly added season absent from the older show listing.
      if (!parent || !covers(observation(parent), scan)) parent = await this.#refreshOne({ kind: 'show', id }, state, background, scan);
    } catch (error) {
      if (error instanceof TmdbError && error.kind === 'superseded') throw error;
      return;
    }
    for (const { season } of parent.value?.seasons ?? []) {
      if (resource.kind === 'season' && resource.season === season) continue;
      const other = { kind: 'season' as const, id, season };
      const cached = await this.read(other);
      if (cached && covers(observation(cached), scan)) continue;
      try { await this.#refreshOne(other, state, background, scan); }
      catch (error) {
        if (error instanceof TmdbError && error.kind === 'superseded') throw error;
        if (!this.environment.online() || (background && !this.environment.visible()) ||
            (error instanceof TmdbError && ['refused', 'throttled'].includes(error.kind))) return;
        // One failed response cannot confirm an absence or hide a move found in a later season.
      }
    }
  }

  repairPreview(id: number): Promise<RepairPreview> {
    return this.store.repairPreview(id, this.environment.now());
  }

  /** Return false when the displayed moves must be reviewed again. A count or
   * metadata change after the second read is checked inside the same IDB write. */
  async updateRepair(reviewed: RepairPreview): Promise<boolean> {
    const approved = structuredClone(reviewed);
    for (;;) {
      await this.#writable();
      const live = await this.repairPreview(approved.showId);
      if (!live.moves.length || !sameRepair(approved, live)) return false;
      try {
        await this.store.commit(live.revision, repairPatch(live), {
          repair: { reviewed: live, now: () => this.environment.now() },
          current: () => !this.#closed && !this.#holds.size,
        });
        return true;
      } catch (error) { if (!(error instanceof StaleSnapshotError)) throw error; }
    }
  }

  /** An import may be canceled. Give its preview the normalized metadata without
   * rewriting a recorded title or publishing cache entries before confirmation. */
  async fetchForImport<R extends TmdbResource>(resource: R, generation: bigint,
      wanted: () => boolean, seasons?: ImportSeasonRequest): Promise<CacheEntry<R['kind']>> {
    const state = await this.store.tmdbState('access');
    if (this.#closed || this.store.role !== 'writer' || state.generation !== generation) throw new TmdbError('superseded');
    if (!state.token || state.refused !== null) throw new TmdbError('refused');
    if (!this.environment.online()) throw new TmdbError('unreachable');
    return this.#fetch(resource, tmdbResourceKey(resource), state, state.token, false, false, wanted, undefined, seasons);
  }

  /** Recheck the IMDb source before a queued TMDB identity request or its retry. */
  async imdbIdentity(id:number, background:boolean, wanted:()=>boolean):Promise<string|null> {
    const state = await this.store.tmdbState('access');
    if (this.#closed || !wanted() || this.store.role !== 'writer') throw new TmdbError('superseded');
    if (!state.token || state.refused !== null) throw new TmdbError('refused');
    if (!this.environment.online() || (background && !this.environment.visible())) throw new TmdbError('unreachable');
    const resource = {kind:'external-ids', id} as const;
    const result = await this.#fetch(resource,tmdbResourceKey(resource),state,state.token,background,true,wanted);
    return result.value?.imdbId ?? null;
  }

  #resourceId(generation:RequestContext['generation'], key:string) {
    return String(generation)+'/'+this.store.providerCacheGeneration+'/'+key;
  }
  async #response(resource: TmdbResource, key: string, token: string, hooks:RequestContext & {background():boolean}, wanted: () => boolean,
      seasons?: readonly number[]) {
    const id = this.#resourceId(hooks.generation,key) + (seasons ? ',' + seasons.join(',') : '');
    const pending = this.#responses.get(id);
    if (pending) {
      pending.consumers.set(wanted,hooks.background);
      return pending.request;
    }
    // A queued dispatch or retry belongs to every remaining caller of this resource.
    const consumers = new Map([[wanted,hooks.background]]);
    const context = {
      ...hooks, credentialCurrent: hooks.current,
      current: async () => await hooks.current() && [...consumers.keys()].some(current => current()),
      background: () => [...consumers.values()].every(isBackground => isBackground()),
    };
    const request = seasons && resource.kind === 'show' ? this.client.requestShowWithSeasons(resource.id, seasons, token, context) :
      this.client.request(resource, token, context);
    this.#responses.set(id, { request, consumers });
    try { return await request; }
    finally { this.#responses.delete(id); }
  }

  async #fetch<R extends TmdbResource>(resource: R, key: string, original: SourceState,
      token: string, background: boolean, save = true, wanted?: () => boolean,
      repairScan?: RepairObservation, seasons?: ImportSeasonRequest, isBackground = () => background): Promise<CacheEntry<R['kind']>> {
    const cacheGeneration = this.store.providerCacheGeneration;
    const writer = () => !this.#closed && this.store.role === 'writer';
    const currentCredential = async () => {
      if (!writer()) return false;
      const active = await this.store.tmdbState('access');
      return writer() && active.token === token && active.generation === original.generation && active.refused === null;
    };
    const consumer = () => (!save || this.store.providerCacheGeneration === cacheGeneration) && this.environment.online() &&
      (!background || this.environment.visible()) && (!wanted || wanted());
    const current = async () => await currentCredential() && consumer();
    const hooks = { current: currentCredential, background:isBackground, generation: original.generation, ...this.#cooldownHooks(original.generation) };
    let groupKey: string | undefined;
    if (save && !repairScan && (resource.kind === 'season' || resource.kind === 'show')) {
      // Sibling reads started before the first reply form one observation for a cross-season swap.
      // A request already in progress for another consumer keeps independent evidence.
      if (background && resource.kind === 'season' && !this.#responses.has(this.#resourceId(original.generation,key))) {
        groupKey = this.#resourceId(original.generation,String(resource.id));
      }
      repairScan = (groupKey ? this.#backgroundSeasonScans.get(groupKey) : undefined) ??
        { at: this.environment.now(), group: crypto.randomUUID() };
      if (groupKey) this.#backgroundSeasonScans.set(groupKey, repairScan);
    }
    let value: TmdbDataByKind[R['kind']] | null;
    try {
      let raw: unknown;
      try { raw = await this.#response(resource, key, token, hooks, consumer, seasons?.numbers); }
      finally {
        if (groupKey && this.#backgroundSeasonScans.get(groupKey) === repairScan) this.#backgroundSeasonScans.delete(groupKey);
      }
      try {
        value = normalizeTmdb(resource, raw);
        if (seasons && resource.kind === 'show') {
          seasons.received = appendedTmdbSeasons(raw, value as TmdbShow, seasons.numbers);
        }
      }
      catch { throw new TmdbError('invalid-response'); }
      if (resource.kind === 'show' && this.client.broadcastOrder) {
        const show = value as TmdbShow;
        const found = await this.client.broadcastOrder(raw,show,token,{...hooks,credentialCurrent:currentCredential,current});
        if (found.order) {
          show.broadcastOrder = found.order;
          show.broadcastSource = found.source;
        } else if (found.retrySource) {
          const prior = (await this.read({kind:'show',id:show.show_id}))?.value;
          if (prior?.broadcastSource === found.retrySource) {
            show.broadcastOrder = prior.broadcastOrder;
            show.broadcastSource = prior.broadcastSource;
          }
        }
      }
    } catch (error) {
      if (error instanceof TmdbError && error.kind === 'refused') {
        if (!await currentCredential() || !await this.store.writeTmdb(original.generation, { refused: error.message }) ||
            !consumer()) throw new TmdbError('superseded');
        throw error;
      }
      if (!await current()) throw new TmdbError('superseded');
      if (!(error instanceof TmdbError && error.kind === 'not-found' && (resource.kind === 'show' || resource.kind === 'season'))) throw error;
      value = null;
    }
    let previousSeason: TmdbSeason | null = null;
    let vacatedPositions: number[] | undefined;
    if (resource.kind === 'season') {
      const previous = await this.read({ kind: 'season', id: resource.id, season: resource.season });
      previousSeason = previous?.value ?? null;
      if (value === null) {
        vacatedPositions = previousSeason ? [...new Set([...(previousSeason.reusedPositions ?? []),
          ...previousSeason.episodes.map(row => row.episode)])].sort((a, b) => a - b) : previous?.vacatedPositions;
      } else {
        value = seasonWithCacheHistory(value as TmdbSeason, previous) as TmdbDataByKind[R['kind']];
      }
    }
    const entry = { fetchedAt: this.environment.now(), value, ...(repairScan && { repairScan }),
      ...(vacatedPositions && { vacatedPositions }) };
    if (!await current()) throw new TmdbError('superseded');
    if (!save) return this.#withSeasonOrder(resource,entry);
    if (value !== null && (resource.kind === 'show' || resource.kind === 'season')) {
      // Sibling renewals already waiting for this show can use the same watch rows.
      // The commit checks their revision and grant again. The last write releases the rows.
      const rewrite = (this.#writes ?? Promise.resolve(undefined)).then(previous =>
        this.#rewrite(resource,entry,original.generation,previousSeason,consumer,
          previous?.id === resource.id ? previous.rows : undefined));
      const tail = this.#writes = rewrite.then(({rows})=>rows && {id:resource.id,rows},()=>undefined);
      let check;
      try { ({check} = await rewrite); }
      finally { if (this.#writes === tail) this.#writes = undefined; }
      const saved = await this.#withSeasonOrder(resource,entry);
      this.#episodeChecks.set(saved,check);
      return saved;
    } else if (persistent(resource) && !await this.store.writeTmdb(original.generation, { entries: { [key]: entry } },
        this.environment.now(),()=>writer() && consumer())) {
      throw new TmdbError('superseded');
    }
    return this.#withSeasonOrder(resource,entry);
  }

  async #withSeasonOrder<R extends TmdbResource>(resource: R, entry: CacheEntry<R['kind']>): Promise<CacheEntry<R['kind']>> {
    if (resource.kind !== 'show' || !entry.value) return entry;
    const {value} = await this.store.seasonOrderState(resource.id);
    return value ? {...entry,value:{...entry.value,manualSeasonOrder:value}} : entry;
  }

  async #rewrite(resource:EpisodeResource, entry: CacheEntry, generation: bigint, prior: TmdbSeason | null,
      consumer:()=>boolean,previous?:RewriteRows) {
    for (;;) {
      if (this.#holds.size) previous = undefined;
      await this.#writable();
      if (!consumer() || !this.store.providerKeysAvailable) throw new TmdbError('superseded');
      const snapshot = previous?.tmdbGeneration === generation ? previous : await this.store.tmdbRows(resource.id,false);
      previous = undefined;
      if (!this.store.providerKeysAvailable || snapshot.tmdbGeneration !== generation || !snapshot.tmdbKeyAccepted) throw new TmdbError('superseded');
      const put = metadataRewrite(snapshot.tables, resource, entry.value, prior);
      if (this.#holds.size) continue;
      try {
        await this.store.commit(snapshot.revision, { put }, {
          onlyDescriptions: true, current: () => !this.#closed && this.#holds.size === 0 && consumer(),
          tmdb: { generation, key: tmdbResourceKey(resource), entry,
            untracked: Object.values(snapshot.tables).every(rows => !rows.length) },
        });
        // Keep only the result of the repair check. A concurrent personal edit
        // invalidates this proof before the caller can skip its second row scan.
        const check = {revision:snapshot.revision,needed:needsEpisodeScan(resource,entry,snapshot.tables.watched)};
        return {check,rows:Object.keys(put).length ? undefined : snapshot};
      }
      catch (error) { if (!(error instanceof StaleSnapshotError)) throw error; }
    }
  }

  view<R extends TmdbResource>(resource: R, onRefreshingCached?: (entry: CacheEntry<R['kind']>) => void): Promise<MetadataView<R['kind']>> {
    return this.#view(resource,this.store.tmdbState('access'),onRefreshingCached);
  }
  search(query:string,page:number,current:()=>boolean):Promise<MetadataView<'search'>> {
    return this.#view({kind:'search',query,page},this.store.tmdbState('access'),undefined,current);
  }
  async #view<R extends TmdbResource>(resource:R, authority:Promise<SourceState>,
      onRefreshingCached?: (entry:CacheEntry<R['kind']>)=>void, searchCurrent?:()=>boolean):Promise<MetadataView<R['kind']>> {
    // Capture the request's authority when it starts. A cached title or season
    // can finish reading after the owner has connected a different record.
    const [state,cached,parent] = await Promise.all([
      authority,this.read(resource),
      resource.kind === 'season' ? this.read({kind:'show',id:resource.id}) : null,
    ]);
    const checkCache = async () => {
      if (this.#closed) throw new TmdbError('superseded');
      const current = await this.store.currentTmdbGeneration(state.generation);
      if (this.#closed || !current) throw new TmdbError('superseded');
    };
    if (resource.kind === 'season' && parent && !parent.value?.seasons.some(s => s.season === resource.season)) {
      await checkCache();
      return {status:'not-found',value:null};
    }
    const retained = () => cached && !cacheExpired(cached.fetchedAt, this.environment.now()) ? cached : null;
    const fallback = async (reason: NonNullable<MetadataView<R['kind']>['reason']>, message?: string): Promise<MetadataView<R['kind']>> => {
      if (cached) await checkCache();
      const entry = retained();
      return { status: entry?.value != null ? 'cached' : entry ? 'not-found' : reason, value: entry?.value ?? null,
        fetchedAt:entry?.fetchedAt, reason, message };
    };
    const key = keyState(state);
    if (key !== 'ready') return fallback(key, state.refused ?? 'A TMDB key is needed.');
    if (this.store.role !== 'writer') return fallback('read-only');
    if (!this.environment.online()) return fallback('offline', 'Cannot reach TMDB.');
    if (onRefreshingCached) {
      if (cached?.value != null) await checkCache();
      const entry = retained();
      if (entry?.value != null) onRefreshingCached(entry);
    }
    try {
      // Search has no persistent cache. Submit each visit as a transport consumer so a new
      // visit can share the same query and retire its predecessor independently.
      const {value} = searchCurrent && state.token
        ? await this.#fetch(resource,tmdbResourceKey(resource),state,state.token,false,true,searchCurrent)
        : await this.#refreshWithState(resource,state,false);
      return { status: value === null ? 'not-found' : empty(value) ? 'empty' : 'ready', value };
    } catch (error) {
      if (error instanceof TmdbError && error.kind === 'superseded') throw error;
      if (error instanceof TmdbError && error.kind === 'refused') return fallback('refused', error.message);
      if (resource.kind === 'search' && error instanceof TmdbError && error.kind === 'throttled') {
        return {status:'unavailable',value:null,reason:'unavailable',retryAt:error.retryAt};
      }
      return fallback('unavailable', 'Cannot reach TMDB.');
    }
  }

  /** Opening a show refreshes its screen-only resources even if the detail job ran recently. */
  async openShow(id: number, onHeader?: (show: MetadataView<'show'>) => void, active = () => true) {
    const authority = this.store.tmdbState('access');
    const show = await this.#view({kind:'show',id},authority);
    onHeader?.(show);
    if (!show.value || !active()) return { show, cast: null, recommendations: null };
    const [cast, recommendations] = await Promise.all([
      this.#view({kind:'cast',id},authority), this.#view({kind:'recommendations',id},authority),
      ...show.value.seasons.filter(s => show.value?.lastAired?.season === 0 && s.season > 0).map(async s => {
        const resource = { kind: 'season' as const, id, season: s.season };
        if (!await this.read(resource) && active()) await this.#view(resource,authority);
      }),
    ] as const);
    return { show, cast, recommendations };
  }

  /** Compose cached provider data with the step 1 progress and marking model. */
  async showInfo(id: number, knownEntry?: CacheEntry<'show'>, signal?: AbortSignal, watchScope?: MarkScope): Promise<ShowInfo | null> {
    const header = knownEntry ?? await this.read({ kind: 'show', id },signal);
    signal?.throwIfAborted();
    const show = header?.value;
    if (!show) return null;
    // A mark needs identities only in its selected seasons. A newer detail can also
    // correct the next episode used to validate a broadcast season's boundaries.
    const selected = watchScope ? show.seasons.filter(s => s.season === show.nextEpisode?.season ||
      (watchScope.season === undefined ? s.season !== 0 : s.season === watchScope.season)) : show.seasons;
    const keys = selected.map(s => tmdbResourceKey({ kind: 'season', id, season: s.season }));
    const entries = await this.store.tmdbEntries<TmdbSeason | null>(keys, this.environment.now(),signal);
    const bySeason = selected.length === show.seasons.length ? undefined : new Map(selected.map((s,i) => [s.season,entries[i]]));
    const entryAt = (season:number,index:number) => bySeason ? bySeason.get(season) : entries[index];
    return withSeasonDetails(show, (season,i) => entryAt(season,i)?.value, (season,i) => {
      const entry = entryAt(season,i);
      return !!entry && observation(entry).at < observation(header).at;
    });
  }

  /** Figures which require TMDB omit both unfetched and confirmed missing shows. */
  async coverage(showIds: Iterable<number>) {
    const ids = [...new Set(showIds)];
    const entries = await Promise.all(ids.map(id => this.read({ kind: 'show', id })));
    return {
      available: ids.filter((_, i) => entries[i]?.value != null),
      unfetched: ids.filter((_, i) => entries[i] === null),
      missing: ids.filter((_, i) => entries[i]?.value === null),
    };
  }

  async firstUse(snapshot?: {local:Record<string,unknown>}): Promise<boolean> {
    const local = snapshot?.local ?? await this.store.firstUseState();
    return local.firstUseDismissed !== true && (!local.syncAccountId || !this.store.hasProviderKey('tmdb_key'));
  }

  async dismissFirstUse(): Promise<void> {
    for (;;) {
      await this.#writable();
      const revision = await this.store.recordRevision();
      try {
        await this.store.commit(revision,{local:{firstUseDismissed:true}},{current:()=>!this.#closed});
        return;
      } catch (error) { if (!(error instanceof StaleSnapshotError)) throw error; }
    }
  }

  /** Load every required season before a bulk mark. Counts and Undo are based on the record at commit. */
  async markWithReceipt(id: number, scope: MarkScope, action: BulkWatchAction, current: () => boolean = () => true) {
    const initial = await this.store.tmdbState('access');
    const cachedOnly = keyState(initial) !== 'ready';
    if (cachedOnly && !initial.cachedMarkAccount) throw new TmdbError('refused');
    const generation = initial.cachedMarkAccount ? {generation:initial.generation,accountId:initial.cachedMarkAccount} : initial.generation;
    const descriptor = { kind: 'show' as const, id };
    const cached = await this.read(descriptor);
    // A recently opened season can outlive its parent in the cache. Its actual
    // episode list plus a recorded show title suffice for this season's marks.
    if (cached === null && typeof action === 'string' && scope.season !== undefined && !scope.broadcast) {
      const resource = { kind: 'season' as const, id, season: scope.season };
      if ((await this.read(resource))?.value && recordedShowTitle((await this.store.tmdbRows(id,false)).tables)) {
        return this.editWatches(id, async snapshot => {
          if (!current()) throw new TmdbError('superseded');
          const [parent, detail] = await Promise.all([this.read(descriptor), this.read(resource)]);
          const title = parent?.value?.show || recordedShowTitle(snapshot.tables);
          if (!title || !detail?.value || (parent && !parent.value?.seasons.some(s => s.season === resource.season))) {
            throw new TmdbError('not-found');
          }
          const episodes = detail.value.episodes;
          const info = { show_id: id, show: title, lastAired: null, nextAirDate: null,
            seasons: [{ season: resource.season, episodeCount: episodes.length, episodes, reusedPositions:detail.value.reusedPositions }] };
          return markAired(snapshot.tables.watched, info, localCalendarDate(new Date(this.environment.now())), scope, action);
        }, generation, current);
      }
    }
    if (cachedOnly && !cached) throw new TmdbError('unreachable', 'Connect Dropbox to load the missing episode details.');
    let header = cached ?? await this.#refreshWithState(descriptor,initial,false);
    let show = await this.showInfo(id,header,undefined,scope);
    if (!show) throw new TmdbError('not-found');
    const today = localCalendarDate(new Date(this.environment.now()));
    let unresolved = unresolvedAiringSeasons(show,scope,today);
    const hasUnlistedSeason = () => [...unresolved].some(number => !show!.seasons.some(s => s.season === number));
    if (hasUnlistedSeason()) {
      if (!cachedOnly && this.environment.online() && cached) {
        header = await this.#refreshWithState(descriptor,initial,false);
        show = await this.showInfo(id,header,undefined,scope);
        if (!show) throw new TmdbError('not-found');
        unresolved = unresolvedAiringSeasons(show,scope,today);
      }
      if (hasUnlistedSeason()) throw new TmdbError('unreachable','The new season’s episode list is unavailable. Try again online later.');
    }
    const target = show.seasons.filter(s => scope.season === undefined ? s.season !== 0 : s.season === scope.season);
    await Promise.all(target.map(async s => {
      const season = { kind: 'season' as const, id, season: s.season };
      if (!s.episodes || unresolved.has(s.season)) {
        if (cachedOnly) throw new TmdbError('unreachable', 'Connect Dropbox to load the missing episode details.');
        if (!this.environment.online()) throw new TmdbError('unreachable', 'Go online to load the missing episode details.');
        await this.#refreshWithState(season,initial,false);
      }
    }));
    return this.editWatches(id, async snapshot => {
      if (!current()) throw new TmdbError('superseded');
      const info = await this.showInfo(id,undefined,undefined,scope);
      if (!info) throw new TmdbError('not-found');
      return markAired(snapshot.tables.watched, info, localCalendarDate(new Date(this.environment.now())), scope, action);
    }, generation, current);
  }

  async mark(id: number, scope: MarkScope, action: 'mark' | 'again') {
    return (await this.markWithReceipt(id, scope, action)).changes;
  }

  /** A selected score belongs to this record even when its editor is no longer on screen. */
  async editRating(show: PersonalShow, rating: number | null, expected: number | undefined,
      submitted: Awaited<ReturnType<DeviceStore['ratingState']>>, current: () => boolean) {
    let state = submitted;
    while (current() && state.account === submitted.account && state.erased === submitted.erased) {
      await this.#writable();
      if (!current()) return;
      const edit = rateShow(state.rating,show,rating,expected);
      if (!edit) return;
      try {
        await this.store.commit(state.revision,edit.patch,{current:() => !this.#closed && !this.#holds.size && current()});
        return edit.undo;
      } catch (error) { if (!(error instanceof StaleSnapshotError)) throw error; }
      state = await this.store.ratingState(show.show_id);
    }
  }

  /** Local ratings and lists share the writer and guard with watches; they do not require a provider key. */
  async editPersonalRecord<T>(plan: (snapshot: PersonalSnapshot) =>
      Promise<{ patch?: DeviceChanges; value: T } | undefined>, current: () => boolean,
      checkWatched?: readonly number[]): Promise<T | undefined> {
    while (current()) {
      await this.#writable();
      if (!current()) return;
      const snapshot = await this.store.personalRows(checkWatched);
      const edit = await plan(snapshot);
      if (!edit || !current()) return;
      if (this.#holds.size) continue;
      if (!edit.patch) return edit.value;
      try {
        await this.store.commit(snapshot.revision, edit.patch, {
          current: () => !this.#closed && !this.#holds.size && current(),
        });
        return edit.value;
      } catch (error) { if (!(error instanceof StaleSnapshotError)) throw error; }
    }
  }

  /** Plan against the latest local rows. Counts and Recently marked share one durable transaction. */
  async editWatches(id: number, plan: (snapshot: ShowRecord) =>
      Promise<{ rows: WatchedRow[]; skipped?: number }> | { rows: WatchedRow[]; skipped?: number },
      credential?: bigint | {generation:bigint;accountId:string}, current: () => boolean = () => true,
      undo?: RecentMarkUndo): Promise<WatchReceipt> {
    const generation = typeof credential === 'object' ? credential.generation : credential;
    const cachedMarkAccount = typeof credential === 'object' ? credential.accountId : undefined;
    for (;;) {
      await this.#writable();
      const [snapshot,header] = await Promise.all([this.store.tmdbRows(id),this.read({kind:'show',id})]);
      if (generation !== undefined) {
        const state = await this.keyStatus();
        // A cold-start tap can begin with cached authorization and finish after Dropbox restores the same key.
        const accepted = state.status === 'ready'
          ? !cachedMarkAccount || (await this.store.dropboxState('registration')).accountId === cachedMarkAccount
          : !!cachedMarkAccount && state.cachedMarkAccount === cachedMarkAccount;
        if (!accepted || state.generation !== generation) throw new TmdbError('superseded');
      }
      const edit = await plan(snapshot);
      const { patch, receipt } = watchPatch(id, snapshot, edit.rows, edit.skipped,
        undo && { original: undo, revisions: this.#localWatchRevisions },broadcastSeasons(header?.value));
      if (this.#holds.size) continue;
      if (!receipt.changes.length) return receipt;
      try {
        await this.store.commit(snapshot.revision, patch, { watchEdit:true,requireTmdbGeneration: generation, cachedMarkAccount,
          current: () => !this.#closed && this.#holds.size === 0 && current() });
        this.#localWatchRevisions.set(id, receipt.recent.revision);
        return receipt;
      } catch (error) { if (!(error instanceof StaleSnapshotError)) throw error; }
    }
  }
}
