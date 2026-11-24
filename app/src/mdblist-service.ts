import { DeviceStore, StaleSnapshotError } from './storage.ts';
import { credentialId } from './tmdb-store.ts';
import { MdbListClient, MdbListError } from './mdblist-client.ts';
import type { CriticScores, MdbListState, MdbListWrite, ScoreEntry } from './mdblist-store.ts';
import { browserMetadataEnvironment, type MetadataEnvironment } from './tmdb-service.ts';
export type { CriticScores } from './mdblist-store.ts';

const day = 86_400_000;
function showIds(values: Iterable<number>): number[] {
  return [...new Set(values)].filter(id => Number.isSafeInteger(id) && id > 0);
}
function stale(entry: ScoreEntry | undefined, now: number): boolean {
  return !entry || entry.fetchedAt > now || now - entry.fetchedAt > 7 * day;
}

export interface MdbListKeyStatus {
  status: 'missing-key' | 'ready' | 'refused' | 'throttled';
  malSource: MdbListState['malSource'];
  generation: bigint;
  message: string | null;
  retryAt?: number;
}

export class MdbListService {
  readonly #store: DeviceStore;
  readonly #client: MdbListClient;
  readonly #environment: MetadataEnvironment;
  #closed = false;

  // Requests for one key share one lane. A changed key can start immediately.
  #queues = new Map<bigint, Promise<void>>();

  constructor(store: DeviceStore, client = new MdbListClient(), environment = browserMetadataEnvironment) {
    this.#store = store;
    this.#client = client;
    this.#environment = environment;
  }

  close(): void { this.#closed = true; }
  displaySource(signal?:AbortSignal) { return this.#store.mdbListDisplayState(signal); }

  async keyStatus(): Promise<MdbListKeyStatus> {
    const { generation, key, malSource, pause } = await this.#store.mdbListState();
    if (!key) return { generation, malSource, status: 'missing-key', message: null };
    if (pause && pause.until > this.#environment.now()) {
      return { generation, malSource, status: pause.kind, message: pause.message, retryAt: pause.until };
    }
    return { generation, malSource, status: 'ready', message: null };
  }

  async saveKey(value: string, expectedGeneration?: bigint): Promise<void> {
    if (!value.trim() || /[\r\n]/.test(value)) throw new Error('Enter the MDBList key.');
    await this.#editKey(value.trim(), expectedGeneration);
  }
  removeKey(expectedGeneration: bigint): Promise<void> { return this.#editKey(null, expectedGeneration); }
  async #editKey(key: string | null, expectedGeneration?: bigint): Promise<void> {
    if (this.#store.providerKeysAvailable === false) throw new Error('Connect to Dropbox to change provider keys.');
    const initial = expectedGeneration ?? (await this.#store.mdbListState()).generation;
    for (;;) {
      const state = await this.#store.mdbListState();
      if (this.#closed || state.generation !== initial) throw new Error('The MDBList key changed. Open Settings again.');
      if (state.key === key) return;
      try {
        const patch = key === null ? { remove: { settings: ['mdblist_key'] } } :
          { put: { settings: [{ setting: 'mdblist_key', value: key }] } };
        await this.#store.commit(state.revision, patch, { current: () => !this.#closed });
        return;
      } catch (error) { if (!(error instanceof StaleSnapshotError)) throw error; }
    }
  }

  async read(ids: Iterable<number>, signal?: AbortSignal): Promise<Map<number, CriticScores>> {
    const state = await this.#store.mdbListScores(showIds(ids),signal);
    return new Map(Array.from(state.entries, ([id, { scores }]) =>
      [id, state.malSource === 'github' ? { ...scores, myanimelist: null } : scores]));
  }

  #canRun(background: boolean): boolean {
    return !this.#closed && this.#store.role === 'writer' && this.#environment.online() &&
      (!background || this.#environment.visible());
  }

  /** Foreground and background callers share the cache. Each queued lookup checks
   * freshness again after the previous request commits, including negative hits. */
  async refresh(values: Iterable<number>, background = false): Promise<void> {
    const ids = showIds(values);
    if (!ids.length || !this.#canRun(background)) return;
    const cacheGeneration = this.#store.providerCacheGeneration;
    const initial = await this.#store.mdbListState();
    if (!initial.key || initial.pause && initial.pause.until > this.#environment.now()) return;
    const generation = initial.generation;
    for (let offset = 0; offset < ids.length && this.#canRun(background); offset += 200) {
      const batch = ids.slice(offset, offset + 200);
      const snapshot = await this.#store.mdbListState(batch);
      if (snapshot.generation !== generation || this.#store.providerCacheGeneration !== cacheGeneration) return;
      const needed = batch.filter(id => stale(snapshot.entries.get(id), this.#environment.now()));
      // MDBList rejects repeated IDs in a browser form. Fetch each stale ID with a simple GET.
      // Returning to the queue between titles lets a screen join a long library refresh.
      for (const id of needed) {
        const previous = this.#queues.get(generation) ?? Promise.resolve();
        const work = previous.then(() => this.#refreshOne(id, generation, background,cacheGeneration));
        const settled = work.then(() => {}, () => {});
        this.#queues.set(generation, settled);
        try { if (!await work) return; }
        finally { if (this.#queues.get(generation) === settled) this.#queues.delete(generation); }
      }
    }
  }

  async #refreshOne(id: number, generation: bigint, background: boolean, cacheGeneration:number): Promise<boolean> {
    const eligible = () => this.#store.providerCacheGeneration === cacheGeneration && this.#canRun(background);
    if (!eligible()) return false;
    const state = await this.#store.mdbListState([id]);
    const now = this.#environment.now();
    if (!state.key || state.generation !== generation || state.pause && state.pause.until > now) return false;
    if (!stale(state.entries.get(id), now)) return true;
    const writer = () => !this.#closed && this.#store.role === 'writer';
    const ownsReply = async () => {
      if (!writer()) return false;
      const live = await this.#store.mdbListState();
      return writer() && live.key === state.key && live.generation === generation;
    };
    const canSend = async () => await ownsReply() && eligible();
    let write: MdbListWrite;
    try {
      const scores = await this.#client.lookup(id, state.key, canSend);
      const fetchedAt = this.#environment.now();
      write = { entries: new Map([[id, { fetchedAt, scores }]]) };
      if (state.pause) write.pause = null;
    } catch (error) {
      if (!(error instanceof MdbListError)) throw error;
      if (error.kind === 'superseded') return false;
      const now = this.#environment.now();
      if (error.kind === 'throttled' || error.kind === 'refused') {
        write = { pause: { kind: error.kind, message: error.message, until: error.retryAt ?? now + day } };
      } else if (state.pause) {
        // A network failure during the one probe keeps later items off the queue.
        write = { pause: { kind: 'throttled', message: 'Cannot reach MDBList. Retrying later.', until: now + 60_000 } };
      } else {
        // An isolated failure leaves these IDs stale and lets other queued titles run.
        return true;
      }
    }
    // A provider can throttle or refuse an admitted request just after the app
    // hides. That answer still applies to this key when the user returns.
    const current = () => writer() && (!write.entries || eligible());
    if (!await ownsReply() || !current()) return false;
    const hash = write.pause !== undefined ? await credentialId(state.key) : undefined;
    const applied = await this.#store.writeMdbList(state.generation, write, hash,current);
    return applied && !write.pause;
  }
}
