import { cacheExpiresAt } from './tmdb-refresh.ts';
import type { CacheEntry } from './tmdb-data.ts';

export interface TmdbCacheEntry<T = unknown> extends Pick<CacheEntry, 'repairScan' | 'vacatedPositions'> { fetchedAt: number; value: T }
export interface StoredTmdbCooldown { until: number; strikes: number }
export interface TmdbTicket { generation: bigint; submission: bigint }
export interface TmdbState {
  generation: bigint;
  token: string | null;
  cachedMarkAccount: string | null;
  refused: string | null;
  cooldown: StoredTmdbCooldown | null;
}
export interface TmdbWrite {
  entries?: Record<string, TmdbCacheEntry>;
  refused?: string;
  cooldown?: StoredTmdbCooldown | null;
}

export interface TmdbControl extends TmdbTicket { credential: string | null; refused: string | null }
export const tmdbControlKey = 'tmdb-control';
export function controlValue(value?: TmdbControl): TmdbControl {
  return value ?? { generation: 0n, submission: 0n, credential: null, refused: null };
}

// Queue each dependent request in an IndexedDB success handler. This keeps
// the check and its writes in the same active transaction across browsers.
export function withControl(tx: IDBTransaction, apply: (control: TmdbControl) => void): void {
  const request = tx.objectStore('meta').get(tmdbControlKey);
  request.onsuccess = () => apply(controlValue(request.result));
}

/** Pending metadata cannot update a record after its watches or settings have been reset. */
export function invalidateTmdbWork(tx:IDBTransaction):void {
  withControl(tx,control => {
    control.generation++;
    control.submission++;
    tx.objectStore('meta').put(control,tmdbControlKey);
  });
}

export async function credentialId(token: string): Promise<string> {
  const bytes = new TextEncoder().encode(token);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

export function retainedEntry<T>(entry: (TmdbCacheEntry<T> & { expiresAt: number }) | undefined, now: number) {
  return entry && entry.expiresAt > now && entry.fetchedAt <= now ? entry : undefined;
}

export function writeEntry(tx: IDBTransaction, key: string, entry: TmdbCacheEntry): void {
  const expiresAt = cacheExpiresAt(entry.fetchedAt);
  if (!Number.isFinite(expiresAt)) throw new RangeError('Invalid metadata fetch time');
  tx.objectStore('tmdb').put({ ...entry, expiresAt }, key);
}

const exportTitle = /^tv\/(\d+)(?:\?append_to_response=keywords,external_ids|\/external_ids|\/season\/\d+)$/;
export const affectsExport = (key:string) => exportTitle.test(key);

/** Seek directly between requested show IDs. The watched key starts with the
 * show ID, so this also skips every episode of an unrelated show in one seek. */
function hasAnyTitle(source:IDBObjectStore | IDBIndex, ids:number[], watched:boolean, done:(found:boolean)=>void) {
  const lower = (id:number) => watched ? [id] : id;
  const last = ids[ids.length-1];
  const range = IDBKeyRange.bound(lower(ids[0]),watched ? [last,[]] : last);
  if (ids.length === 1) {
    const read = source.getKey(range);
    read.onsuccess = () => done(read.result !== undefined);
    return;
  }
  const read = source.openKeyCursor(range);
  let next = 0;
  read.onsuccess = () => {
    const cursor = read.result;
    if (!cursor) { done(false); return; }
    const id = Number(watched ? (cursor.key as IDBValidKey[])[0] : cursor.key);
    while (next < ids.length && ids[next] < id) next++;
    if (ids[next] === id) done(true);
    else if (next === ids.length) done(false);
    else cursor.continue(lower(ids[next]));
  };
}

/** Decide whether changed TMDB resources feed the personal exports or charts
 * using the same IndexedDB transaction as the cache mutation. */
export class TmdbReportInputs {
  readonly #exportShows = new Set<number>();
  readonly #castShows = new Set<number>();
  #countries = false;
  includesConfiguration = false;
  get includesCast():boolean { return this.#castShows.size>0; }

  add(keys:Iterable<IDBValidKey>) {
    for (const key of keys) if (typeof key === 'string') {
      const file = exportTitle.exec(key);
      if (file) this.#exportShows.add(Number(file[1]));
      else if (key === 'configuration') this.includesConfiguration = true;
      else if (key === 'configuration/countries') this.#countries = true;
      else {
        const cast = /^tv\/(\d+)\/aggregate_credits$/.exec(key);
        if (cast) this.#castShows.add(Number(cast[1]));
      }
    }
  }

  stores() {
    return this.#exportShows.size ? ['watched','shows','ratings','lists'] : this.#castShows.size ? ['watched'] : [];
  }

  check(tx:IDBTransaction, done:(files:boolean,charts:boolean)=>void) {
    const fileIds = Array.from(this.#exportShows).sort((a,b)=>a-b);
    const castIds = this.#countries ? [] : Array.from(this.#castShows).sort((a,b)=>a-b);
    let left = (fileIds.length ? 4 : 0) + (castIds.length ? 1 : 0);
    let files = false, charts = this.#countries;
    const finish = () => { if (--left === 0) done(files,charts); };
    if (!left) { done(files,charts); return; }
    if (fileIds.length) {
      for (const name of ['watched','shows','ratings','lists']) {
        const table = tx.objectStore(name);
        hasAnyTitle(name === 'lists' ? table.index('show') : table,fileIds,name === 'watched',found => { files ||= found; finish(); });
      }
    }
    if (castIds.length) hasAnyTitle(tx.objectStore('watched'),castIds,true,found => { charts = found; finish(); });
  }
}

/** A single transaction proves every primary key in a deletion range has expired. */
export function deleteExpiredEntries(store:IDBObjectStore, keys:IDBValidKey[], queued:()=>void):void {
  if (keys.length < 8 || !keys.every((key):key is string => typeof key === 'string')) {
    for (const key of keys) store.delete(key);
    queued();
    return;
  }
  const sorted = keys.sort(), remaining = new Set(sorted);
  const probe = store.getAllKeys(IDBKeyRange.bound(sorted[0],sorted[sorted.length-1]),sorted.length*4+1);
  probe.onsuccess = () => {
    let first:string|undefined, last = '';
    function flush() {
      if (first !== undefined) store.delete(first === last ? first : IDBKeyRange.bound(first,last));
      first = undefined;
    }
    for (const key of probe.result) {
      if (typeof key === 'string' && remaining.delete(key)) {
        first ??= key;
        last = key;
      } else flush();
    }
    flush();
    // Widely separated expired entries can outlast the bounded primary-key probe.
    for (const key of remaining) store.delete(key);
    queued();
  };
}

export function updateCooldown(tx: IDBTransaction, hash: string, next: StoredTmdbCooldown | null, now: number): void {
  const store = tx.objectStore('tmdbGates');
  const read = store.get(hash);
  read.onsuccess = () => {
    const previous: StoredTmdbCooldown | undefined = read.result;
    if (next) {
      store.put({ until: Math.max(previous?.until ?? 0, next.until), strikes: Math.max(previous?.strikes ?? 0, next.strikes) }, hash);
    } else if (!previous || previous.until <= now) {
      store.delete(hash);
    }
  };
}

export function matchesTicket(control: TmdbControl, ticket: TmdbTicket): boolean {
  return control.generation === ticket.generation && control.submission === ticket.submission;
}
