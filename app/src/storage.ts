import { isProviderKey, providerKeys, publicSettings, publicSettingsSync, applyProviderHashes, type ProviderHashes, type ProviderKey, type ProviderKeySave, type ProviderSession } from './provider-credentials.ts';
import type { ObservedReset } from './dropbox-reset.ts';
import {announceMetadataClient,metadataPeers} from './metadata-peer-locks.ts';
import {importCacheWrites,type ImportCacheEntries} from './import-cache-storage.ts';
import {runImportRecord, importReceiptKey, supportedImport, type SavedImport} from './import-record.ts';
import {writeWatchDownload, type WatchedRowChanges} from './watch-download.ts';
import {largeWatchEdit,runManualWatchWrite} from './watch-edit-storage.ts';
import {savedVisits,updateVisits,visitSealKey,visitStoreKey,type StoredVisits,type VisitValue} from './navigation-history.ts';
import { canonicalListName, canonicalListRows, droppedList, emptyTables, isListDeclaration, rowKey, type ListRow, type SettingRow } from './model.ts';
import { isWatchlist, orderedListNames, PersonalRecordError, visibleListRows } from './personal-record.ts';
import { canceledKey, matchesDownloadBase, resetWatchLocalKeys, sameReceipt, sameResetObservation, statisticsCacheChanged, statisticsField, statisticsRevision, watchEditReceiptKey, watchResetGuard, type PriorWatchDownload, type WatchedResetAdoption } from './record-transaction.ts';
import { checkTmdbReportChange } from './tmdb-report-change.ts';
import { isSeasonOrderKey, seasonOrderKey, seasonOrderPrefix } from './season-order.ts';
import { hasRecentWatch, legacyRecentRows, nextRecentChange, orderedRecents, recentEntries, recentId, recentLimit, recentPrefix, recentRow, recentSources } from './recent-history.ts';
import type { DropboxCooldown } from './dropbox-rate-limit.ts';
import { changeMalConfig, malControl, malControlKey, malIndexRows, malRange, malShowKey, saveMalControl,
  type MalConfiguration, type MalControl, type MalState, type MalWrite } from './mal-store.ts';
import {lookupMalIndex,malLookupAvailable} from './mal-index-client.ts';
import {installGithubIndex,type GithubIndex,type GithubInstallation} from './github-index.ts';
import type { MalEntry } from './mal-file.ts';
import { changeImdbConfig, defaultImdbControl, githubInstallationKey, imdbCacheKey, imdbControlKey, imdbIndexRows, imdbQuotaKey, imdbRange, imdbSettings, imdbSource, saveImdbControl, sourcePause,
  type ImdbConfiguration, type ImdbDisplayState, type ImdbPause, type ImdbState, type ImdbWrite } from './imdb-store.ts';
import { mdbListControl, mdbListControlKey, quotaKey, scoreKey,
  type MdbListState, type MdbListWrite, type ScoreEntry } from './mdblist-store.ts';
import { validateRow } from './csv.ts';
import type { MergeTable, RecordTables, TableName, TableRows } from './model.ts';
import type { StatisticsScope } from './statistics.ts';
import { displayPreferences, displayPreferenceNames, LibrarySortRecovery, type DisplayPreference } from './display-preferences.ts';
import { affectsExport, retainedEntry, controlValue, credentialId, deleteExpiredEntries, invalidateTmdbWork, matchesTicket, TmdbReportInputs, tmdbControlKey, updateCooldown, withControl, writeEntry } from './tmdb-store.ts';
import type { TmdbCacheEntry, TmdbState, TmdbTicket, TmdbWrite, StoredTmdbCooldown } from './tmdb-store.ts';
import type {StatisticsMetadataChange} from './record-transaction.ts';
import { cacheExpiresAt } from './tmdb-refresh.ts';
import { withSeasonDetails, type TmdbDataByKind } from './tmdb-data.ts';
import { tmdbResourceKey } from './tmdb-client.ts';
import { findCastMember, type CachedCastMember } from './cast-cache.ts';
import { castWorkerAvailable, lookupCastInWorker } from './cast-lookup-client.ts';
import { observation, sameRepair, type RepairPreview } from './episode-repair.ts';
import { readShowEpisodes, type ShowEpisodeSnapshot } from './show-detail-storage.ts';
export type { TmdbCacheEntry, TmdbState, TmdbTicket, TmdbWrite, StoredTmdbCooldown } from './tmdb-store.ts';

const keys = {
  watched: ['show_id', 'season', 'episode'],
  ratings: 'show_id',
  lists: ['list', 'show_id'],
  shows: 'show_id',
  settings: 'setting',
} satisfies Record<TableName, string | string[]>;
const tables = Object.keys(keys) as TableName[];
const recordStores = [...tables, 'sync', 'local', 'meta'];
export {canceledKey};
const canceledFileKeys = new Set(tables.filter(name => name !== 'shows').map(canceledKey));
export interface NoticeEntry { id:string; time:number; message:string }
export const noticeLimit = 30;
const overviewStores = ['watched', 'ratings', 'lists', 'shows'];
const mappingGateKey = 'anonymous-github-file-gate';
interface MappingGate { epoch:bigint; until:number }

export interface PendingUpload {
  content: string;
  targetRevision: string | null;
  targetModified: string | null;
  targetContent: string | null; // null when the live file was unreadable.
  clientModified: string;
  preparedAt: number;
  previousRevisions?: readonly string[];
  settingsContentHash?: string;
  /** Restoring a backup sets absolute watch counts. Matching bytes fulfill that request. */
  absoluteWatches?: true;
  /** An explicit restore sets the contents of a ratings, list or settings file. */
  absoluteValues?: true;
  /** Selective clear projected these settings rows. Only revision history can confirm the original upload. */
  inspectOnly?: true;
}

export interface FileSyncState {
  base: { revision: string; content: string } | null;
  lastClientModified: string | null;
  pending: PendingUpload | null;
}

export interface ExchangedSession extends ProviderSession {
  /** Present on grants exchanged since the device began recording its public registration. */
  appKey?: string;
  /** Existing nonsecret attempt ID. A copied tab can recognize a sign-in that already finished. */
  completedAttempt?: string;
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  providerExpiresAt: number;
}

/** An older grant has no verified provider cutoff. Its identity remains available for revocation. */
export function effectiveDropboxDeadline({signInDeadline,providerExpiresAt}: ExchangedSession): number {
  return Number.isFinite(signInDeadline) && Number.isFinite(providerExpiresAt)
    ? Math.min(signInDeadline, providerExpiresAt) : 0;
}

export function dropboxSessionInfo(session: ExchangedSession): ProviderSession {
  return {accountId:session.accountId, instanceId:session.instanceId, signInDeadline:effectiveDropboxDeadline(session)};
}

interface DropboxRequestState {
  accountId: string | null;
  recordAppKey: string | null;
  session: ExchangedSession | null;
  cooldown: DropboxCooldown | null;
}
interface DropboxStoredState extends DropboxRequestState {
  revision: bigint;
  status: DropboxSyncStatus | null;
  dirty: boolean;
}

export interface DropboxDeviceState extends Omit<DropboxStoredState,'session'> {
  grantAppKey?: string;
  session: ProviderSession|null;
}

async function readDropboxRegistration(local: IDBObjectStore) {
  const [accountId,recordAppKey] = await Promise.all([result<string|undefined>(local.get('syncAccountId')),
    result<string|undefined>(local.get('syncAppKey'))]);
  return {accountId:accountId ?? null, recordAppKey:recordAppKey ?? null};
}

export interface DropboxSyncStatus {
  accountId: string;
  instanceId: string;
  synced: boolean;
  reason: string;
  day: string;
  notices: string[];
}

export interface DeviceSnapshot {
  revision: bigint;
  tmdbGeneration: bigint;
  tables: RecordTables;
  sync: Partial<Record<MergeTable, FileSyncState>>;
  local: Record<string, unknown> & {dropboxSession?: ProviderSession};
  /** Only the store which read this snapshot can use this handle for a subsequent publication. */
  exportRecord?: object;
}

export interface ImportPreviewSnapshot {
  tables:Omit<RecordTables,'settings'>;
  local:{syncAccountId?:unknown;dropboxSession?:Pick<ProviderSession,'instanceId'>};
}

export type ShowRows = Pick<DeviceSnapshot,'tables'|'revision'|'tmdbGeneration'>;
type ShowRowsWithRecent = ShowRows & {recentlyMarked:number[]; recentSettings:SettingRow[]; displacedRecentMark?:number};

export interface PersonalSnapshot {
  revision: bigint;
  ratings: RecordTables['ratings'];
  lists: RecordTables['lists'];
  watchedIds: Set<number>;
}

/** Public title headers read with the Statistics projection, keyed by the requested TMDB ID. */
export type ImdbHeaders = ReadonlyMap<number,TmdbCacheEntry<TmdbDataByKind['show'] | null> | undefined>;
type ImdbExternalEntry = TmdbCacheEntry<TmdbDataByKind['external-ids'] | null> & {expiresAt:number};
const imdbExternalKey = (id:number) => tmdbResourceKey({kind:'external-ids',id});

export interface ExportSnapshot {
  revision: bigint;
  missingShowIds: Set<number>;
  tables: Omit<RecordTables, 'settings'>;
  showMetadata: Map<number, TmdbDataByKind['show']>;
  externalIds: Map<number, string>;
  seasons: Map<string, TmdbDataByKind['season'] | null>;
  observationTimes?: Map<string, number>;
}

interface PublicationRecord {
  tables:ExportSnapshot['tables'];
  revision:bigint;
  erased:bigint;
  session:ProviderSession;
}

function exportMetadataKeys(rows:ExportSnapshot['tables'],includeSeasons:boolean,includeExternalIds:boolean) {
  const shows = new Map<number,string>(), external = new Map<number,string>(), seasons = new Set<string>();
  for (const table of [rows.watched,rows.ratings,rows.lists]) {
    for (const row of table) {
      const id = row.show_id;
      if (isListDeclaration(row) || shows.has(id)) continue;
      shows.set(id,tmdbResourceKey({kind:'show',id}));
      if (includeExternalIds) external.set(id,tmdbResourceKey({kind:'external-ids',id}));
    }
  }
  if (includeSeasons) for (const row of rows.watched) {
    if (row.season !== 0) seasons.add(tmdbResourceKey({kind:'season',id:row.show_id,season:row.season}));
  }
  return {shows,external,seasons};
}

function exportSeasonOrders(rows:SettingRow[]) {
  return new Map(rows.map(row => [tmdbResourceKey({kind:'show',id:Number(row.setting.slice(seasonOrderPrefix.length))}),row.value]));
}

function projectExportMetadata(tables:ExportSnapshot['tables'],revision:bigint,now:number,includeSeasons:boolean,
    keys:ReturnType<typeof exportMetadataKeys>,entries:ReturnType<typeof readTmdbEntries>,
    externalEntries:ReadonlyMap<string,TmdbCacheEntry & {expiresAt:number}>|undefined,orders:ReadonlyMap<string,string>):ExportSnapshot {
  const showMetadata:ExportSnapshot['showMetadata'] = new Map(), seasons:ExportSnapshot['seasons'] = new Map();
  const externalIds = new Map<number,string>(), missingShowIds = new Set<number>(), observationTimes = new Map<string,number>();
  function cached<K extends 'show'|'season'>(key:string) {
    const row = entries.get(key) as (TmdbCacheEntry<TmdbDataByKind[K]|null> & {expiresAt:number})|undefined;
    return retainedEntry(row,now);
  }
  for (const [id,key] of keys.shows) {
    const entry = cached<'show'>(key);
    if (entry && includeSeasons) observationTimes.set(key,observation(entry).at);
    if (entry?.value) {
      const order = orders.get(key);
      showMetadata.set(id,order ? {...entry.value,manualSeasonOrder:order} : entry.value);
    } else if (entry?.value === null) missingShowIds.add(id);
  }
  for (const [id,key] of keys.external) {
    const ids = retainedEntry(externalEntries?.get(key) as ImdbExternalEntry|undefined,now);
    if (ids?.value?.imdbId) externalIds.set(id,ids.value.imdbId);
  }
  for (const key of keys.seasons) {
    const entry = cached<'season'>(key);
    if (entry) { seasons.set(key,entry.value); observationTimes.set(key,observation(entry).at); }
  }
  return {tables,revision,missingShowIds,showMetadata,externalIds,seasons,observationTimes};
}

/** Schedule all grant checks inside the active transaction before its caller decides which rows to use. */
function checkPublication(tx:IDBTransaction,revision:IDBRequest,prior:PublicationRecord,now:()=>number,check:(matches:boolean)=>void) {
  const local = tx.objectStore('local'), erased = tx.objectStore('meta').get('deviceEraseRevision');
  const owner = local.get('syncAccountId'), grant = local.get('dropboxSession');
  grant.onsuccess = () => {
    const session = grant.result as ExchangedSession|undefined;
    check((revision.result ?? 0n) === prior.revision && (erased.result ?? 0n) === prior.erased && owner.result === prior.session.accountId &&
      session?.accountId === prior.session.accountId && session.instanceId === prior.session.instanceId &&
      effectiveDropboxDeadline(session) === prior.session.signInDeadline && prior.session.signInDeadline > now());
  };
}

/** Queue exact cache lookups in the caller's transaction, grouping only adjacent requested values. */
function readCacheValues<T>(cache: IDBObjectStore, keys: readonly IDBValidKey[], receive: (index:number,value:T)=>void,
  signal?: AbortSignal, smallRows?: 'external-ids' | 'omdb-series' | 'mdblist-scores') {
  function compare(a: IDBValidKey, b: IDBValidKey) {
    return typeof a === 'string' && typeof b === 'string' ? (a < b ? -1 : a > b ? 1 : 0) : indexedDB.cmp(a,b);
  }
  type Target = {key: IDBValidKey; positions:number[]};
  function accept(target:Target, value:T | undefined) {
    if (value !== undefined) for (const index of target.positions) receive(index,value);
  }
  function readOne(target:Target) {
    const request = cache.get(target.key);
    request.onsuccess = () => accept(target,request.result);
  }
  function readRun(run:Target[]) {
    if (!run.length) return;
    if (run.length === 1) { readOne(run[0]); return; }
    const request = cache.getAll(IDBKeyRange.bound(run[0].key,run[run.length-1].key),run.length);
    request.onsuccess = () => request.result.forEach((value,i) => accept(run[i],value));
  }
  const sorted: Target[] = [];
  for (const index of keys.map((_,i)=>i).sort((a,b)=>compare(keys[a],keys[b]))) {
    const key = keys[index], last = sorted.at(-1);
    if (last && compare(last.key,key) === 0) last.positions.push(index);
    else sorted.push({key,positions:[index]});
  }
  // Scores and external IDs are small. In a large batch use wider key-only
  // probes, including its last page; the value reads still exclude unrelated rows.
  const wide = smallRows && sorted.length >= (smallRows === 'mdblist-scores' ? 33 : 16);
  const pageSize = wide ? (smallRows === 'external-ids' ? 64 : 128) : 32;
  const probeLimit = wide ? 513 : 129;
  for (let i=0; i<sorted.length; i+=pageSize) {
    const page = sorted.slice(i,i+pageSize);
    if (page.length < (wide ? 2 : 16)) { page.forEach(readOne); continue; }
    const probe = cache.getAllKeys(IDBKeyRange.bound(page[0].key,page[page.length-1].key),probeLimit);
    // Keys and values share the same transaction. A range is safe to read only
    // when every stored key in it was requested, including across missing keys.
    probe.onsuccess = () => {
      if (signal?.aborted) return;
      const found = probe.result;
      let next = 0, run: Target[] = [];
      for (const key of found) {
        while (next < page.length && compare(page[next].key,key) < 0) next++;
        if (next < page.length && compare(page[next].key,key) === 0) run.push(page[next++]);
        else if (run.length) { readRun(run); run = []; }
      }
      readRun(run);
      if (found.length === probeLimit) {
        // A sparse range may exceed the key-only probe. Seek its remainder directly.
        for (; next < page.length; next++) readOne(page[next]);
      }
    };
  }
}

function readImdbExternalEntries(cache:IDBObjectStore, keys:readonly string[], signal?:AbortSignal) {
  const entries = new Map<string,ImdbExternalEntry>();
  readCacheValues<ImdbExternalEntry>(cache,keys,(i,row)=>entries.set(keys[i],row),signal,'external-ids');
  return entries;
}

async function readMdbListSource(tx:IDBTransaction):Promise<{configured:boolean;malSource:MdbListState['malSource']}> {
  const settings = tx.objectStore('settings');
  const [hashes,source,legacy] = await Promise.all([result(tx.objectStore('meta').get('providerHashes')),
    result(settings.get('mal_source')),result(settings.getKey('mdblist_key'))]);
  return {configured:Boolean(hashes?.mdblist_key || legacy),malSource:source?.value === 'github' ? 'github' : 'mdblist'};
}

function readTmdbEntries<T = unknown>(cache: IDBObjectStore, keys: readonly string[], signal?: AbortSignal) {
  const entries = new Map<string,TmdbCacheEntry<T> & {expiresAt:number}>();
  function readPrimary(remaining:readonly string[]) {
    readCacheValues<TmdbCacheEntry<T> & {expiresAt:number}>(cache,remaining,(i,row)=>entries.set(remaining[i],row),signal);
  }
  if (keys.length < 16 || !cache.indexNames.contains('showHeaders')) {
    readPrimary(keys);
    return entries;
  }
  const groups = new Map<number | 'header',{id:number; key:string}[]>(), remaining:string[] = [];
  for (const key of new Set(keys)) {
    const match = /^tv\/(\d+)(?:\?append_to_response=keywords,external_ids|\/season\/(\d+))$/.exec(key);
    // Mixed reads such as Statistics already form adjacent primary-key runs of
    // cast, seasons and titles. Splitting them would leave one cast read per show.
    if (!match) { readPrimary(keys); return entries; }
    const id = Number(match[1]), group = match[2] === undefined ? 'header' : Number(match[2]);
    if (!Number.isSafeInteger(id) || (group !== 'header' && !Number.isSafeInteger(group))) {
      remaining.push(key);
      continue;
    }
    const targets = groups.get(group) ?? [];
    targets.push({id,key});
    groups.set(group,targets);
  }
  let pending = 0, sawIndexedKey = false;
  for (const [group,targets] of groups) {
    if (targets.length < 16) { for (const target of targets) remaining.push(target.key); continue; }
    const index = cache.index(group === 'header' ? 'showHeaders' : 'seasonDetails');
    targets.sort((a,b)=>a.id-b.id);
    for (let start=0; start<targets.length; start+=128) {
      const page = targets.slice(start,start+128), wanted = new Set(page.map(t=>t.key));
      const low = page[0].id, high = page[page.length-1].id;
      const range = group === 'header' ? IDBKeyRange.bound([low],[high,[]]) : IDBKeyRange.bound([group,low],[group,high]);
      const probe = index.getAllKeys(range,wanted.size+1);
      pending++;
      probe.onsuccess = () => {
        if (signal?.aborted) return;
        const found = probe.result;
        if (found.length) sawIndexedKey = true;
        // The index returns primary keys in the same order as the values. Read a range
        // only if every value belongs to the caller, within this same transaction.
        if (found.length && found.every((key):key is string => typeof key === 'string' && wanted.has(key))) {
          const values = index.getAll(range,found.length);
          values.onsuccess = () => values.result.forEach((row,i)=>entries.set(found[i],row));
          for (const key of found) wanted.delete(key);
        }
        // Missing responses (including cached 404s) and legacy shapes can lack an
        // index key. Combine every hole and sparse range into one ordinary batch.
        for (const key of wanted) remaining.push(key);
        if (--pending !== 0) return;
        if (sawIndexedKey || remaining.length < 16) { readPrimary(remaining); return; }
        // A freshly restored record may have no title cache yet. A single key-only
        // check can prove the whole interval empty, even if configuration is cached.
        remaining.sort();
        const first = cache.getKey(IDBKeyRange.bound(remaining[0],remaining[remaining.length-1]));
        first.onsuccess = () => { if (!signal?.aborted && first.result !== undefined) readPrimary(remaining); };
      };
    }
  }
  if (!pending) readPrimary(remaining);
  return entries;
}

/** A cast member can have several credits for the same show. */
async function readSelectedWatches(store: IDBObjectStore, ids: readonly number[]): Promise<RecordTables['watched']> {
  const unique = new Set(ids);
  if (!unique.size) return [];
  let first = Infinity, last = -Infinity;
  for (const id of unique) { first = Math.min(first,id); last = Math.max(last,id); }
  if (unique.size <= 3 && last-first+1 > unique.size) {
    const sorted = [...unique].sort((a,b)=>a-b);
    const groups = sorted.map(id => result<RecordTables['watched']>(store.getAll(IDBKeyRange.bound([id], [id, []]))));
    return (await Promise.all(groups)).flat();
  }
  // A single range avoids hundreds of mostly empty requests for long filmographies.
  const rows = await result<RecordTables['watched']>(store.getAll(IDBKeyRange.bound([first], [last, []])));
  return unique.size === 1 ? rows : rows.filter(row => unique.has(row.show_id));
}

async function readOverviewRows(tx: IDBTransaction, watchIds?: readonly number[], knownRatings?: RecordTables['ratings']): Promise<Omit<RecordTables,'settings'>> {
  const watchStore = tx.objectStore('watched');
  const [watched,ratings,lists,shows] = await Promise.all([
    watchIds ? readSelectedWatches(watchStore,watchIds) : result<RecordTables['watched']>(watchStore.getAll()),
    knownRatings ?? result<RecordTables['ratings']>(tx.objectStore('ratings').getAll()),
    result(tx.objectStore('lists').getAll()),result(tx.objectStore('shows').getAll()),
  ]);
  return {watched,ratings,lists,shows};
}

async function readRatingsOverview(tx: IDBTransaction, signal?: AbortSignal) {
  const ratings = await result<RecordTables['ratings']>(tx.objectStore('ratings').getAll());
  signal?.throwIfAborted();
  if (!ratings.length) return {watched:[],ratings,lists:[],shows:[]};
  // A few ratings commonly occupy a small interval of the watch history. A broad
  // ratings library is cheaper to join with one unbounded read, particularly in WebKit.
  const watchIds = ratings.length <= 8 ? ratings.map(row => row.show_id) : undefined;
  return readOverviewRows(tx,watchIds,ratings);
}

export interface RatingRecordIdentity { account: string | undefined; erased: bigint }
export interface RecordStamp extends RatingRecordIdentity {revision:bigint}

async function readRecordIdentity(tx: IDBTransaction): Promise<RatingRecordIdentity> {
  const [account,erased] = await Promise.all([
    result<string|undefined>(tx.objectStore('local').get('syncAccountId')),
    result<bigint|undefined>(tx.objectStore('meta').get('deviceEraseRevision')),
  ]);
  return {account,erased:erased ?? 0n};
}

type RatingsProvider = 'mdblist'|'imdb'|'mal';
function scoreNotice(provider:RatingsProvider, statisticsChanged:boolean): Event {
  return statisticsChanged ? new Event(provider+'change') : new CustomEvent(provider+'change',{detail:{statisticsUnchanged:true}});
}

interface RowKeys {
  watched: [showId: number, season: number, episode: number];
  ratings: number;
  lists: [list: string, showId: number];
  shows: number;
  settings: string;
}

export interface DeviceChanges {
  replace?: Partial<RecordTables>;
  put?: { [K in TableName]?: readonly TableRows[K][] };
  remove?: { [K in TableName]?: readonly RowKeys[K][] };
  sync?: Partial<Record<MergeTable, FileSyncState | null>>;
  local?: Record<string, unknown>;
  removeLocal?: readonly string[];
}

function watchFilePatch(watched:RecordTables['watched'] | WatchedRowChanges,receipt:FileSyncState):DeviceChanges | null {
  const patch:DeviceChanges = {sync:{watched:receipt},removeLocal:[canceledKey('watched')]};
  if (Array.isArray(watched)) {
    if (!watched.length) return null;
    patch.replace = {watched};
  } else {
    if (!watched.put.length && !watched.remove.length) return null;
    patch.put = {watched:watched.put};
    patch.remove = {watched:watched.remove};
  }
  return patch;
}

/** A request handler may enqueue more writes, for example while removing old settings.
 * Keep one trailing admission check behind the queued work until the transaction goes idle. */
function guardSyncCommit(tx:IDBTransaction, current:()=>boolean, fail:(error:unknown)=>void) {
  let checking = false;
  tx.addEventListener('success',() => {
    if (checking) return;
    checking = true;
    tx.objectStore('meta').getKey('revision').onsuccess = () => {
      checking = false;
      if (!current()) fail(new StaleSnapshotError());
    };
  },true);
}

/** Admit large episode writes in groups so the browser can paint while the same transaction stays open. */
function writeLargeWatchChanges(store: IDBObjectStore, patch: DeviceChanges, fail: (error: unknown) => void, current?: () => boolean) {
  const batchSize = 2048;
  const replacement = patch.replace?.watched, updates = patch.put?.watched, removals = patch.remove?.watched;
  const addEnd = replacement?.length ?? 0, deleteEnd = addEnd + (removals?.length ?? 0);
  const total = deleteEnd + (updates?.length ?? 0);
  if (!total || (total <= batchSize && !current)) return false;

  // commit() already captured these values before opening the transaction.
  const add = replacement ?? [], remove = removals ?? [], put = updates ?? [];
  if (replacement) store.clear();
  let index = 0;
  function writeBatch() {
    try {
      if (current && !current()) throw new StaleSnapshotError();
      if (index === total) return;
      const end = Math.min(index + batchSize,total);
      let last: IDBRequest | undefined;
      while (index < end) {
        if (index < addEnd) last = store.add(add[index]);
        else if (index < deleteEnd) last = store.delete(remove[index - addEnd]);
        else last = store.put(put[index - deleteEnd]);
        index++;
      }
      if (index < total || current) last!.onsuccess = writeBatch;
    } catch (error) { fail(error); }
  }
  writeBatch();
  return true;
}

export interface RecordChange {
  /** Exact committed revision for an edit that cannot change the Statistics report. */
  statisticsUnchangedAt?: bigint;
  syncWrite?: boolean;
  tables: TableName[];
  settings: string[] | 'all';
  localKeys: string[];
  onlyDescriptions: boolean;
}

export interface CommitOptions {
  syncWrite?: boolean;
  /** A legacy registration can install credentials only against the access version it just read. */
  requireDropboxAccess?: Pick<ExchangedSession,'accessToken'|'accessExpiresAt'>;
  /** A confirmed account reset discards quarantined legacy keys together with its verified settings base. */
  clearResetCredentials?: boolean;
  invalidateTmdbWork?: boolean;
  onlyDescriptions?: boolean;
  current?: () => boolean;
  /** This patch came from the watch editor and may be applied to a linked offline record. */
  watchEdit?: true;
  /** Positive marks must still belong to the accepted credential when the transaction commits. */
  requireTmdbGeneration?: bigint;
  /** A linked record may use a previously accepted TMDB key's cached episode identities offline. */
  cachedMarkAccount?: string;
  /** Recompute the approved moves against the rows and TMDB cache locked by this write. */
  repair?: { reviewed: RepairPreview; now: () => number };
  /** untracked is established from this show's rows at the expected record revision. */
  tmdb?: { generation: bigint; key: string; entry: TmdbCacheEntry; untracked?: boolean };
  /** Retain a preview's metadata unless the cached response changed during review. */
  tmdbImport?: { generation: bigint; entries: ImportCacheEntries; session?: ProviderSession };
}

function editedKey(patch: DeviceChanges, setting: string): string | null | undefined {
  // Same precedence as commit: replace, remove, put.
  let value: string | null | undefined;
  if (patch.replace?.settings) value = patch.replace.settings.find(row => row.setting === setting)?.value ?? null;
  if (patch.remove?.settings?.includes(setting)) value = null;
  for (const row of patch.put?.settings ?? []) if (row.setting === setting) value = row.value;
  return value;
}

// Append migrations in version order. IndexedDB commits the entire upgrade or none of it.
export type Migration = (db: IDBDatabase, transaction: IDBTransaction) => void;
export const deviceMigrations: readonly Migration[] = [
  db => {
    for (const table of tables) db.createObjectStore(table, { keyPath: keys[table] });
    for (const name of ['sync', 'local', 'meta', 'cache']) db.createObjectStore(name);
  },
  (db, tx) => {
    db.createObjectStore('tmdb').createIndex('expiry', 'expiresAt');
    db.createObjectStore('tmdbGates');
    tx.objectStore('lists').createIndex('show', 'show_id');
  },
  // Close older writers before migrating their locally stored credentials.
  () => {},
  // Retire older clients that could refresh a grant without a verified provider cutoff.
  () => {},
  // Retire clients that can complete a sign-in started before this device was cleared.
  () => {},
  (_db,tx) => {
    const lists = tx.objectStore('lists');
    const read = lists.getAll();
    read.onsuccess = () => {
      const rows: ListRow[] = read.result;
      const aliases = rows.filter(row => canonicalListName(row.list) !== row.list);
      if (!aliases.length) return;
      const changedKeys = new Set(aliases.map(row => rowKey('lists',{...row,list:canonicalListName(row.list)})));
      for (const row of aliases) lists.delete([row.list,row.show_id]);
      for (const row of canonicalListRows(rows)) if (changedKeys.has(rowKey('lists',row))) lists.put(row);
      // Raw Dropbox bases, pending upload receipts and backup hashes still identify the original bytes.
      const meta = tx.objectStore('meta'), rev = meta.get('revision');
      meta.put(true,'dropboxDirty');
      rev.onsuccess = () => meta.put((rev.result ?? 0n) + 1n,'revision');
    };
  },
  (_db,tx) => {
    const cache = tx.objectStore('tmdb');
    cache.createIndex('showHeaders',['value.show_id','value.show']);
    cache.createIndex('seasonDetails',['value.season','value.show_id']);
  },
  (db,tx) => {
    db.createObjectStore('statistics',{keyPath:'key'});
    const settings = tx.objectStore('settings'), local = tx.objectStore('local');
    const scope = settings.get(displayPreferences.statisticsScope.setting), legacy = local.get('statisticsScope');
    const opened = local.get('statisticsOpened'), revision = tx.objectStore('meta').get('revision');
    revision.onsuccess = () => {
      statisticsField(tx,'scope',scope.result?.value);
      statisticsField(tx,'legacyScope',legacy.result);
      statisticsField(tx,'opened',opened.result);
      statisticsField(tx,'revision',revision.result ?? 0n);
    };
  },
  // Retire writers that could reconnect a linked record to a different app folder.
  () => {},
];

export interface StoreOptions {
  name?: string;
  migrations?: readonly Migration[];
  onBlocked?: (oldVersion: number, newVersion: number | null) => void;
  beforeReload?: () => Promise<unknown> | undefined;
}

/** A failed preference write can retry only against the same account, device and choice. */
export interface PreferenceAttempt {
  previous?: {account: string | undefined; erased: bigint; value: string | undefined};
  revision?: bigint;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function done(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new DOMException('The transaction was aborted.', 'AbortError'));
  });
}

async function finishRead(tx: IDBTransaction, signal?: AbortSignal, closing?:AbortSignal) {
  const abort = () => {
    try { tx.abort(); }
    // The read can finish before IndexedDB dispatches its completion event.
    catch (error) { if (!(error instanceof DOMException && error.name === 'InvalidStateError')) throw error; }
  };
  signal?.addEventListener('abort',abort);
  closing?.addEventListener('abort',abort);
  try { await done(tx); }
  finally { signal?.removeEventListener('abort',abort); closing?.removeEventListener('abort',abort); }
  signal?.throwIfAborted();
  closing?.throwIfAborted();
}

function writeError(error: unknown): DOMException {
  const name = error instanceof DOMException ? error.name : 'UnknownError';
  return new DOMException(name === 'QuotaExceededError'
    ? 'Storage is full. The change was not saved. Clear rebuildable caches and retry.'
    : 'The change was not saved.', name);
}

export class StaleSnapshotError extends Error {
  constructor() {
    super('The record changed. Read the current record before retrying.');
    this.name = 'StaleSnapshotError';
  }
}

export type StoreRole = 'reader' | 'writer' | 'obsolete' | 'closed';

export class DeviceStore extends EventTarget {
  #db: IDBDatabase;
  #beforeReload?: StoreOptions['beforeReload'];
  #exportRecords = new WeakMap<object,PublicationRecord>();
  #slowExportMetadata = false;
  #providerSave?:ProviderKeySave;
  #providerNow:()=>number = Date.now;
  #providerSession:ProviderSession|null = null;
  #providerValues = new Map<ProviderKey,string>();
  #providerHashes:ProviderHashes = {};
  #providerEpoch = 0;
  #providerCacheGeneration = 0;
  #providerLoad = 0;
  #lostProviderSession = false;
  #providerBusy = false;
  #tagKey?:CryptoKey;
  #librarySort = new LibrarySortRecovery(text => this.providerContentTag(text));
  async providerContentTag(text:string):Promise<string> {
    if (!this.#tagKey) throw new Error('The device has no active credential binding.');
    const digest = new Uint8Array(await crypto.subtle.sign('HMAC',this.#tagKey,new TextEncoder().encode(text)));
    return 'h1:'+Array.from(digest,byte=>byte.toString(16).padStart(2,'0')).join('');
  }
  async #providerHash(value:string):Promise<string> {
    return this.providerContentTag(await credentialId(value));
  }
  #tmdbSubmissionEpoch = 0;
  #checkProviderBinding(tx:IDBTransaction, next:()=>void, accountRead?: IDBRequest):void {
    const session = this.#providerSession;
    if (!session) return next();
    const local = tx.objectStore('local'), owner = accountRead ?? local.get('syncAccountId'), stored = local.get('dropboxSession');
    stored.onsuccess = () => {
      const live = stored.result as ExchangedSession|undefined;
      if (session === this.#providerSession && (session.signInDeadline <= this.#providerNow() ||
          owner.result !== session.accountId || live?.instanceId !== session.instanceId ||
          live.accountId !== session.accountId || effectiveDropboxDeadline(live) !== session.signInDeadline)) this.clearProviderKeys();
      next();
    };
  }
  connectProviderKeys(save:ProviderKeySave, now:()=>number):void {
    this.clearProviderKeys();
    this.#providerSave = save;
    this.#providerNow = now;
  }
  get providerKeysAvailable():boolean {
    if (this.#providerSession && this.#providerSession.signInDeadline <= this.#providerNow()) this.clearProviderKeys();
    return !!this.#providerSession;
  }
  /** Only the writer downloads scores and metadata; older replies yield to a quota cleanup. */
  get providerCacheGeneration():number { return this.#providerCacheGeneration; }
  hasProviderKey(name:ProviderKey):boolean { return !!this.#providerHashes[name]; }
  #providerValue(name:ProviderKey):string|null {
    return this.providerKeysAvailable ? this.#providerValues.get(name) ?? null : null;
  }
  clearProviderKeys():void {
    const loaded = !!this.#providerSession;
    this.#lostProviderSession ||= loaded;
    this.#providerEpoch++;
    this.#providerSession = null;
    this.#providerValues.clear();
    if (loaded) this.#notifyProviderKeys();
  }
  #notifyProviderKeys():void {
    this.dispatchEvent(new Event('providerkeyschange'));
    this.dispatchEvent(new Event('tmdbstatechange'));
    this.#scoresChanged('mdblist');
    this.#scoresChanged('imdb');
    this.#scoresChanged('mal');
  }
  async #readProviderPresence():Promise<void> {
    const tx = this.#db.transaction(['meta','settings']);
    const [hashes,legacy] = await Promise.all([result(tx.objectStore('meta').get('providerHashes')),
      result(tx.objectStore('settings').getAllKeys()),done(tx)]);
    this.#providerHashes = hashes ?? {};
    for (const name of legacy) if (typeof name === 'string' && isProviderKey(name)) this.#providerHashes[name] ||= 'legacy';
  }
  #binding(tx:IDBTransaction, session:ProviderSession, current:()=>boolean, fn:()=>void, fail:(error:unknown)=>void) {
    const local = tx.objectStore('local'), owner = local.get('syncAccountId'), live = local.get('dropboxSession');
    live.onsuccess = () => {
      const binding = live.result as ExchangedSession|undefined;
      if (owner.result !== session.accountId || binding?.accountId !== session.accountId ||
          binding.instanceId !== session.instanceId || effectiveDropboxDeadline(binding) !== session.signInDeadline ||
          session.signInDeadline <= this.#providerNow() || !current()) return fail(new StaleSnapshotError());
      fn();
    };
  }
  async legacyProviderSettings() {
    this.#compatible();
    const tx = this.#db.transaction(['settings','sync','meta']), meta = tx.objectStore('meta');
    const [rows,sync,revision,migrated] = await Promise.all([result<SettingRow[]>(tx.objectStore('settings').getAll()),
      result<FileSyncState|undefined>(tx.objectStore('sync').get('settings')),result(meta.get('revision')),
      result(meta.get('providerKeysMigrated')),done(tx)]);
    return {rows, sync:sync ?? null, revision:(revision ?? 0n) as bigint, migrated:!!migrated};
  }
  async finishProviderMigration(expectedRevision:bigint, cleanSync:FileSyncState|null, session:ProviderSession, current:()=>boolean) {
    this.#requireWriter();
    await this.#write(['settings','sync','meta','local','statistics'], (tx,fail) => {
      const meta = tx.objectStore('meta'), revision = meta.get('revision');
      this.#binding(tx,session,current,() => {
        if ((revision.result ?? 0n) !== expectedRevision) return fail(new StaleSnapshotError());
        for (const key of providerKeys) tx.objectStore('settings').delete(key);
        if (cleanSync) tx.objectStore('sync').put(publicSettingsSync(cleanSync),'settings');
        else tx.objectStore('sync').delete('settings');
        meta.put(true,'providerKeysMigrated');
        statisticsRevision(tx,expectedRevision+1n);
      },fail);
    });
  }
  async loadProviderKeys(session:ProviderSession, rows:readonly SettingRow[], current:()=>boolean):Promise<void> {
    await this.#installProviderKeys(session,rows,current);
    await this.#migrateDisplayPreferences(session,rows,current);
  }

  // An older device's theme and Statistics tab are still usable offline. Once the
  // account is verified, an existing Dropbox choice takes precedence over that legacy default.
  async #migrateDisplayPreferences(session:ProviderSession, rows:readonly SettingRow[], current:()=>boolean) {
    const migrated: string[] = [];
    await this.#write(['local','settings','meta','statistics'], (tx,fail) => {
      this.#binding(tx,session,current,() => {
        const local = tx.objectStore('local'), settings = tx.objectStore('settings'), meta = tx.objectStore('meta');
        for (const key of ['appearance','statisticsScope'] as const) {
          const definition = displayPreferences[key];
          const legacy = local.get(key), existing = settings.get(definition.setting);
          existing.onsuccess = () => {
            if (legacy.result === undefined) return;
            local.delete(key);
            if (key === 'statisticsScope') statisticsField(tx,'legacyScope',undefined);
            migrated.push(definition.setting);
            if (existing.result) return;
            const remote = rows.find(row => row.setting === definition.setting);
            const value = remote?.value ?? legacy.result;
            if (!(definition.values as readonly string[]).includes(value)) return;
            settings.put({setting:definition.setting,value});
            if (key === 'statisticsScope') statisticsField(tx,'scope',value);
            if (!remote) meta.put(true,'dropboxDirty');
          };
        }
        const revision = meta.get('revision');
        revision.onsuccess = () => {
          if (migrated.length) meta.put((revision.result ?? 0n) + 1n,'revision');
        };
      },fail);
    });
    if (migrated.length) {
      this.#statusChanged();
      this.#changed({tables:['settings'],settings:migrated,localKeys:[],onlyDescriptions:false,syncWrite:true});
    }
  }
  async #installProviderKeys(session:ProviderSession, rows:readonly SettingRow[], current:()=>boolean,
      configuration?:{key:string;entry:TmdbCacheEntry}):Promise<void> {
    this.#requireWriter();
    const previouslyAvailable = this.providerKeysAvailable;
    const epoch = this.#providerEpoch;
    if (!this.#providerSave) throw new Error('Connect to Dropbox to load provider keys.');
    const load = ++this.#providerLoad;
    const values = new Map<ProviderKey,string>();
    for (const row of rows) if (isProviderKey(row.setting)) {
      validateRow('settings',row);
      if (values.has(row.setting)) throw new Error('Duplicate credential in Dropbox settings.');
      values.set(row.setting,row.value);
    }
    const hashes:ProviderHashes = {};
    await Promise.all(Array.from(values,async ([name,value]) => {hashes[name] = await this.#providerHash(value);}));
    const valid = () => load === this.#providerLoad && epoch === this.#providerEpoch && current();
    const rebound = !previouslyAvailable || this.#providerSession?.instanceId !== session.instanceId ||
      this.#providerSession.accountId !== session.accountId;
    let changed = false;
    let activeImdb = rebound, activeMal = rebound;
    await this.#write(['local','meta','cache','settings','statistics',...(configuration ? ['tmdb'] : [])],(tx,fail) => {
      const meta = tx.objectStore('meta'), known = meta.get('providerHashes'), prior = meta.get('providerLease');
      this.#binding(tx,session,valid,() => {
        const old:ProviderHashes = known.result ?? {};
        const differences = providerKeys.filter(key => hashes[key] !== old[key]);
        changed = differences.length > 0;
        const newLease = this.#lostProviderSession || prior.result?.accountId !== session.accountId ||
          prior.result.instanceId !== session.instanceId || prior.result.signInDeadline !== session.signInDeadline;
        if (!newLease && !changed && !configuration) return;
        meta.put({accountId:session.accountId,instanceId:session.instanceId,signInDeadline:session.signInDeadline},'providerLease');
        const source = tx.objectStore('settings').get('imdb_source');
        source.onsuccess = () => {
          activeImdb ||= (source.result?.value === 'github' && differences.includes('github_token')) ||
            (source.result?.value === 'omdb' && differences.includes('omdb_key'));
        };
        activeMal ||= differences.includes('github_token');
        applyProviderHashes(tx, hashes, differences, newLease, !!configuration);
        if (configuration) writeEntry(tx,configuration.key,configuration.entry);
        if (changed || configuration) {
          const revision = meta.get('revision');
          revision.onsuccess = () => {
            try { statisticsRevision(tx,(revision.result ?? 0n)+1n); } catch(error) { fail(error); }
          };
        }
      },fail);
    });
    if (!valid() || session.signInDeadline <= this.#providerNow()) throw new StaleSnapshotError();
    this.#providerValues = values;
    this.#lostProviderSession = false;
    this.#providerHashes = hashes;
    this.#providerSession = {accountId:session.accountId,instanceId:session.instanceId,signInDeadline:session.signInDeadline};
    if (changed || rebound || configuration) this.#notifyProviderKeys();
    if (changed) this.#exportUpdates?.postMessage('provider-presence');
    if (activeImdb) this.#ratingConfigChanged('imdbconfigchange');
    if (activeMal) this.#ratingConfigChanged('malconfigchange');
  }
  async #saveProviderKey(key:ProviderKey, next:string|null, current:()=>boolean, configuration?:{key:string;entry:TmdbCacheEntry}):Promise<void> {
    const session = this.#providerSession, epoch = this.#providerEpoch;
    if (!this.#providerSave || !session || !this.providerKeysAvailable) throw new Error('Connect to Dropbox to change provider keys.');
    if (this.#providerBusy) throw new Error('Another provider key is being saved. Try again when it finishes.');
    this.#providerBusy = true;
    const installed = deferred<void>();
    try {
      const expected = this.#providerValue(key);
      const active = () => this.providerKeysAvailable && this.#providerEpoch === epoch &&
        this.#providerValue(key) === expected && current();
      if (!active()) throw new StaleSnapshotError();
      const rows = await this.#providerSave(key,expected,next,active,installed.promise);
      if (!active()) throw new StaleSnapshotError();
      if ((rows.find(row=>row.setting === key)?.value ?? null) !== next) throw Error('Dropbox returned a different provider key.');
      await this.#installProviderKeys(session,rows,active,configuration);
    } finally { this.#providerBusy = false; installed.resolve(); }
  }
  #role: StoreRole = 'reader';
  #waiting = new AbortController();
  readonly #metadataLease = crypto.randomUUID();
  #grant = deferred<void>();
  #release = deferred<void>();
  #writes = new Set<Promise<unknown>>();
  #exportUpdates?: BroadcastChannel;
  #pageHide = () => this.close();
  #expiryTimer?: ReturnType<typeof setTimeout>;
  #expiryDue = Infinity;
  readonly #persistence = deferred<boolean>();
  #readOnlyReason?:string;

  /** Resolves after the writer asks for persistent storage. Refusal still permits local use. */
  get persistent(): Promise<boolean> { return this.#persistence.promise; }
  get role(): StoreRole { return this.#role; }
  get readOnlyReason(): string | undefined { return this.#readOnlyReason; }

  private constructor(db: IDBDatabase) {
    super();
    this.#db = db;
    if (typeof BroadcastChannel !== 'undefined') {
      this.#exportUpdates = new BroadcastChannel('csvTV/exports/' + db.name);
      this.#exportUpdates.onmessage = event => {
        if (event.data === 'deviceerased') {
          this.#librarySort.clear();
          this.clearProviderKeys();
          this.dispatchEvent(new Event('deviceerased'));
          return;
        }
        if (event.data === 'provider-presence') {
          this.dispatchEvent(new Event('ratingscredentialschange'));
          void this.#readProviderPresence().then(()=>this.dispatchEvent(new Event('providerkeyschange'))).catch(()=>{});
          return;
        }
        const detail = event.data;
        if (detail === 'tmdb-detail-browse') {
          this.dispatchEvent(new CustomEvent('tmdbbrowse',{detail:{detailOnly:true,castChanged:false}}));
          return;
        }
        if (detail?.kind === 'score-display' && (detail.provider === 'mdblist' || detail.provider === 'imdb' || detail.provider === 'mal')) {
          this.dispatchEvent(scoreNotice(detail.provider,false));
          return;
        }
        if (event.data === 'imdbconfigchange' || event.data === 'malconfigchange' || event.data === 'recentmarkschange' || event.data === 'noticehistorychange') {
          this.dispatchEvent(new Event(event.data));
          return;
        }
        if (displayPreferenceNames.includes(event.data)) {
          this.dispatchEvent(new Event(event.data.toLowerCase() + 'change'));
          return;
        }
        this.dispatchEvent(new Event(event.data === 'dropbox' ? 'dropboxchange' :
        event.data === 'dropbox-status' ? 'dropboxstatus' : event.data === 'mdblist' ? 'mdblistchange' :
        event.data === 'imdb' ? 'imdbchange' : event.data === 'mal' ? 'malchange' :
        event.data === 'tmdbmetadata' || event.data === 'tmdbbrowse' ? event.data : event.data === 'tmdbstate' ? 'tmdbstatechange' :
        'exportchange'));
      };
    }
    db.onversionchange = () => this.#stop('obsolete');
    db.onclose = () => this.close();
    window.addEventListener('pagehide', this.#pageHide);
    // A read-only caller need not await a grant. Observe cancellation in that case too.
    void this.#grant.promise.catch(() => {});
    void this.#queueWriter();
  }

  static async open(options: StoreOptions = {}): Promise<DeviceStore> {
    const migrations = options.migrations ?? deviceMigrations;
    const request = indexedDB.open(options.name ?? 'csvTV', migrations.length);
    request.onblocked = event => options.onBlocked?.(event.oldVersion, event.newVersion);
    request.onupgradeneeded = event => {
      const transaction = request.transaction!;
      try {
        for (const migrate of migrations.slice(event.oldVersion)) migrate(request.result, transaction);
      } catch {
        transaction.abort();
      }
    };
    const store = new DeviceStore(await result(request));
    store.#beforeReload = options.beforeReload;
    try { await store.#readProviderPresence(); } catch(error) { store.close(); throw error; }
    return store;
  }

  async #queueWriter(): Promise<void> {
    try {
      const locks = navigator.locks;
      if (!locks) throw new DOMException('Web Locks are unavailable.', 'NotSupportedError');
      announceMetadataClient(this.#db.name,undefined,this.#waiting.signal,this.#release.promise);
      await locks.request('csvTV/writer/' + this.#db.name, {signal:this.#waiting.signal}, async () => {
        if (this.#role !== 'reader') return;
        try {
          await this.#prepareTmdb();
          await this.#migrateRecentHistory();
        } catch (error) {
          this.#grant.reject(error);
          if (error instanceof DOMException && error.name === 'QuotaExceededError') {
            this.#readOnlyReason = 'Browser storage is full. You can read and export your record. Free space and reload csvTV to edit.';
            this.#persistence.resolve(false);
            this.dispatchEvent(new Event('rolechange'));
            return;
          }
          this.close();
          return;
        }
        if (this.#role !== 'reader') return;
        this.#role = 'writer';
        announceMetadataClient(this.#db.name,this.#metadataLease,this.#waiting.signal,this.#release.promise);
        this.#grant.resolve();
        this.dispatchEvent(new Event('rolechange'));
        void this.#requestPersistence();
        await this.#release.promise;
      });
    } catch (error) {
      if (this.#role === 'reader' && !this.#waiting.signal.aborted) {
        this.#readOnlyReason = 'This browser cannot lock the record for editing. You can still read and export it.';
        this.dispatchEvent(new Event('rolechange'));
      }
      this.#grant.reject(error);
      this.#persistence.resolve(false);
    }
  }

  async #requestPersistence(): Promise<void> {
    try { this.#persistence.resolve(await navigator.storage.persist()); }
    catch { this.#persistence.resolve(false); }
  }

  /** A queued reader gets a fresh committed snapshot when the previous writer leaves. */
  async whenWriter(): Promise<DeviceSnapshot> {
    await this.#grant.promise;
    this.#requireWriter();
    return this.snapshot();
  }

  #requireWriter(): void {
    if (this.#role !== 'writer') throw new DOMException('This tab cannot write the record.', 'InvalidStateError');
  }

  #compatible(): void {
    if (this.#role === 'closed' || this.#role === 'obsolete') {
      throw new DOMException('This database connection has closed.', 'InvalidStateError');
    }
  }

  #stop(role: 'obsolete' | 'closed'): void {
    if (this.#role === 'obsolete' || this.#role === 'closed') return;
    this.clearProviderKeys();
    this.#providerSave = undefined;
    this.#role = role;
    this.#waiting.abort();
    this.#grant.reject(new DOMException('This tab no longer has a compatible connection.', 'InvalidStateError'));
    this.#persistence.resolve(false);
    clearTimeout(this.#expiryTimer);
    this.#expiryDue = Infinity;
    window.removeEventListener('pagehide', this.#pageHide);
    this.#db.close();
    this.#exportUpdates?.close();
    this.#exportUpdates = undefined;
    // IndexedDB finishes transactions already in flight before closing the connection.
    void Promise.allSettled(this.#writes).then(() => this.#release.resolve());
    this.dispatchEvent(new Event('rolechange'));
  }

  close(): void { this.#stop('closed'); }

  /** A submitted sign-in can still be waiting for the reply it must save before a reload. */
  async afterPendingWrites(action: () => void | Promise<void>): Promise<void> {
    const pending = this.#beforeReload?.();
    if (pending) await pending;
    while (this.#writes.size) await Promise.all(this.#writes);
    return action();
  }

  /** Fence new work and drain admitted writes. A manual reload can first finish a submitted sign-in. */
  async closeForUpdate(finishSignIn = false): Promise<void> {
    if (finishSignIn) {
      const pending = this.#beforeReload?.();
      if (pending) await pending;
    }
    this.#stop('obsolete');
    return this.#release.promise;
  }

  async snapshot(forPublication = false): Promise<DeviceSnapshot> {
    this.#compatible();
    const tx = this.#db.transaction(recordStores, 'readonly');
    const data = emptyTables();
    const sync = tx.objectStore('sync');
    const local = tx.objectStore('local');
    const [revision, syncKeys, syncValues, localKeys, localValues, control, erased] = await Promise.all([
      result(tx.objectStore('meta').get('revision')), result(sync.getAllKeys()), result(sync.getAll()),
      result(local.getAllKeys()), result(local.getAll()), result(tx.objectStore('meta').get(tmdbControlKey)),
      forPublication ? result<bigint|undefined>(tx.objectStore('meta').get('deviceEraseRevision')) : undefined,
      Promise.all(tables.map(async name => {
        Object.assign(data, { [name]: await result(tx.objectStore(name).getAll()) });
      })), done(tx),
    ]);
    data.settings = publicSettings(data.settings);
    const preferences = Object.fromEntries(localKeys.map((key, index) => {
      const value = localValues[index];
      return [key, key === 'dropboxSession' && value ? dropboxSessionInfo(value) : value];
    }));
    const recent = recentEntries(data.settings,data.watched);
    if (recent.size) preferences.recentlyMarked = orderedRecents(recent);
    const snapshot:DeviceSnapshot = {
      revision: revision ?? 0n, tmdbGeneration: controlValue(control).generation, tables: data,
      sync: Object.fromEntries(syncKeys.map((key, index) => [key, key === 'settings' ? publicSettingsSync(syncValues[index]) : syncValues[index]])),
      local: preferences,
    };
    const session = snapshot.local.dropboxSession;
    if (forPublication && session && snapshot.local.syncAccountId === session.accountId) {
      snapshot.exportRecord = {};
      const {watched,ratings,lists,shows} = data;
      const tables = {watched,ratings,lists,shows};
      for (const rows of Object.values(tables)) { for (const row of rows) Object.freeze(row); Object.freeze(rows); }
      this.#exportRecords.set(snapshot.exportRecord,{tables,revision:snapshot.revision,erased:erased ?? 0n,session:{...session}});
    }
    return snapshot;
  }

  /** Receipt recovery and the final session check do not need a copy of the watch record. */
  async dropboxSyncCheck(table?: MergeTable) {
    this.#compatible();
    const tx = this.#db.transaction(table ? ['local','sync'] : ['local']);
    const local = tx.objectStore('local');
    const [account,session,file] = await Promise.all([
      result<string|undefined>(local.get('syncAccountId')), result<ExchangedSession|undefined>(local.get('dropboxSession')),
      table ? result<FileSyncState|undefined>(tx.objectStore('sync').get(table)) : undefined, done(tx),
    ]);
    return {local:{syncAccountId:account,dropboxSession:session && dropboxSessionInfo(session)},
      pending:file?.pending && table === 'settings' ? publicSettingsSync(file).pending : file?.pending ?? null};
  }

  /** Compare only the recoverable files present in this backup against this device’s rows and receipts. */
  async dropboxRestorePreview(selected:readonly MergeTable[], signal?:AbortSignal):Promise<Pick<DeviceSnapshot,'revision'|'local'|'tables'|'sync'>> {
    this.#compatible();
    signal?.throwIfAborted();
    const names = [...new Set(selected)], tx = this.#db.transaction(['meta','local','sync',...names]);
    const local = tx.objectStore('local'), receipts = tx.objectStore('sync');
    const tables = emptyTables(), sync:DeviceSnapshot['sync'] = {};
    const [revision,account,session] = await Promise.all([
      result<bigint|undefined>(tx.objectStore('meta').get('revision')),
      result<string|undefined>(local.get('syncAccountId')),result<ExchangedSession|undefined>(local.get('dropboxSession')),
      Promise.all(names.map(async name => {
        const [rows,file] = await Promise.all([result(tx.objectStore(name).getAll()),result<FileSyncState|undefined>(receipts.get(name))]);
        Object.assign(tables,{[name]:name === 'settings' ? publicSettings(rows) : rows});
        if (file) sync[name] = name === 'settings' ? publicSettingsSync(file) : file;
      })),finishRead(tx,signal,this.#waiting.signal),
    ]);
    return {revision:revision ?? 0n,tables,sync,local:{syncAccountId:account,dropboxSession:session && dropboxSessionInfo(session)}};
  }

  /** The export reader already supplies the watch record. Read only the evidence needed to publish it. */
  async dropboxPublicationState() {
    this.#compatible();
    const tx = this.#db.transaction(['meta','local','sync','settings']);
    const sync = tx.objectStore('sync'), local = tx.objectStore('local');
    const [revision,hash,keys,values,settings] = await Promise.all([
      result<bigint|undefined>(tx.objectStore('meta').get('revision')),result<string|undefined>(local.get('dropboxShowsHash')),
      result(sync.getAllKeys()),result<FileSyncState[]>(sync.getAll()),result<SettingRow[]>(tx.objectStore('settings').getAll()),done(tx),
    ]);
    return {revision:revision ?? 0n,hash,settings:publicSettings(settings),
      sync:Object.fromEntries(keys.map((key,i)=>[key,key === 'settings' ? publicSettingsSync(values[i]) : values[i]]))};
  }

  /** Remember the first backup marker without changing a watch record or invalidating its reviewed revision. */
  async rememberDropboxMarker(session:ProviderSession, current:()=>boolean) {
    this.#requireWriter();
    await this.#write(['local'],(tx,fail) => {
      const local = tx.objectStore('local'), previous = local.get('dropboxResetSeen');
      this.#binding(tx,session,current,() => {
        if (previous.result?.accountId !== session.accountId) {
          local.put({accountId:session.accountId,generations:{}},'dropboxResetSeen');
        }
      },fail);
    });
  }

  async dropboxResetState(accountId:string) {
    this.#compatible();
    const tx = this.#db.transaction('local');
    const local = tx.objectStore('local');
    const [seen,merging] = await Promise.all([result<ObservedReset|undefined>(local.get('dropboxResetSeen')),
      result<string|undefined>(local.get('dropboxMergeDestination')),done(tx)]);
    const sameAccount = seen?.accountId === accountId;
    return {seen:sameAccount,generations:sameAccount ? seen.generations : undefined,
      retired:sameAccount ? seen.retired : undefined,ancestry:sameAccount ? seen.ancestry : undefined,
      format:sameAccount ? seen.format : undefined,entering:merging === accountId};
  }

  /** A reset marker can be acknowledged without reading any record rows. */
  async dropboxResetSnapshot(): Promise<Pick<DeviceSnapshot,'revision'|'local'>> {
    this.#compatible();
    const tx = this.#db.transaction(['meta','local']);
    const local = tx.objectStore('local');
    const [revision,account,session,seen] = await Promise.all([
      result<bigint|undefined>(tx.objectStore('meta').get('revision')),
      result<string|undefined>(local.get('syncAccountId')),
      result<ExchangedSession|undefined>(local.get('dropboxSession')),
      result<ObservedReset|undefined>(local.get('dropboxResetSeen')), done(tx),
    ]);
    return {revision:revision ?? 0n,local:{syncAccountId:account,
      dropboxSession:session && dropboxSessionInfo(session),dropboxResetSeen:seen}};
  }

  async navigationVisit(id?:string, useDraft=false) {
    this.#compatible();
    const tx = this.#db.transaction(['local','meta']);
    const meta = tx.objectStore('meta');
    const [identity,stored,savedKey] = await Promise.all([readRecordIdentity(tx),
      id ? result<StoredVisits|undefined>(meta.get(visitStoreKey)) : undefined,
      useDraft ? result<(RatingRecordIdentity & {key:CryptoKey})|undefined>(meta.get(visitSealKey)) : undefined, done(tx)]);
    const entry = id ? savedVisits(stored,identity).find(row=>row.id === id) : undefined;
    let key = savedKey?.erased === identity.erased && savedKey.account === identity.account ? savedKey.key : undefined;
    if (useDraft && !key) {
      const created = await this.#newVisitKey(identity);
      if (created === 'changed') return {identity,entry:undefined,key:undefined};
      key = created;
    }
    return {identity,entry,key};
  }

  async #newVisitKey(identity:RatingRecordIdentity):Promise<CryptoKey|'changed'|undefined> {
    try {
      const fresh = await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
      this.#compatible();
      const tx = this.#db.transaction(['local','meta'],'readwrite');
      const meta = tx.objectStore('meta'), owner = tx.objectStore('local').get('syncAccountId');
      const erased = meta.get('deviceEraseRevision'), previous = meta.get(visitSealKey);
      let key:CryptoKey|'changed'|undefined;
      previous.onsuccess = () => {
        if (owner.result !== identity.account || (erased.result ?? 0n) !== identity.erased) { key='changed'; return; }
        const saved = previous.result;
        key = saved?.erased === identity.erased && saved.account === identity.account ? saved.key : undefined;
        if (!key) { key = fresh; meta.put({...identity,key},visitSealKey); }
      };
      const saved = done(tx).then(()=>key,()=>undefined);
      this.#writes.add(saved);
      try { return await saved; } finally { this.#writes.delete(saved); }
    } catch { return undefined; }
  }

  async saveNavigationVisit(id:string, identity:RatingRecordIdentity, sequence:number, value:VisitValue) {
    this.#compatible();
    // Readers may remember their own visit. This optional write has no effect on record revisions, sync or update eligibility.
    const tx = this.#db.transaction(['local','meta'],'readwrite');
    let accepted = false;
    const saved = done(tx).then(()=>accepted,()=>false);
    this.#writes.add(saved);
    try {
      const meta = tx.objectStore('meta'), owner = tx.objectStore('local').get('syncAccountId');
      const current = meta.get(visitStoreKey), erased = meta.get('deviceEraseRevision');
      erased.onsuccess = () => {
        if (owner.result === identity.account && (erased.result ?? 0n) === identity.erased) {
          meta.put(updateVisits(current.result,identity,id,sequence,value),visitStoreKey);
          accepted = true;
        }
      };
      return await saved;
    } finally { this.#writes.delete(saved); }
  }

  async noticeHistory(account:string):Promise<NoticeEntry[]> {
    this.#compatible();
    const tx = this.#db.transaction(['meta','local']);
    const [owner,entries] = await Promise.all([result(tx.objectStore('local').get('syncAccountId')),
      result<NoticeEntry[]|undefined>(tx.objectStore('meta').get('noticeHistory')),done(tx)]);
    if (owner !== account || !Array.isArray(entries)) return [];
    return entries.slice(0,noticeLimit).filter(row=>row && typeof row.id === 'string' && typeof row.message === 'string'
      && Number.isSafeInteger(row.time) && Math.abs(row.time) <= 8.64e15);
  }

  async saveNotices(account:string, entries:readonly NoticeEntry[]) {
    this.#requireWriter();
    await this.#write(['meta'],tx=>{
      const meta = tx.objectStore('meta'), owner = tx.objectStore('local').get('syncAccountId');
      const previous = meta.get('noticeHistory');
      previous.onsuccess = () => {
        if (owner.result !== account) return;
        const rows:NoticeEntry[] = Array.isArray(previous.result) ? previous.result : [];
        const batch = entries.slice(0,noticeLimit);
        meta.put([...batch,...rows.slice(0,noticeLimit-batch.length)],'noticeHistory');
      };
    });
    this.#exportUpdates?.postMessage('noticehistorychange');
  }

  async devicePreference(key: DisplayPreference): Promise<{preference: unknown; revision: bigint; statisticsOpened?: boolean; record?:RecordStamp}> {
    this.#compatible();
    const tx = this.#db.transaction(['settings','local','meta']);
    const local = tx.objectStore('local');
    const library = key === 'librarySort';
    const [row, legacy, revision, opened, account, erased] = await Promise.all([
      result<SettingRow|undefined>(tx.objectStore('settings').get(displayPreferences[key].setting)),
      key === 'appearance' || key === 'statisticsScope' ? result(local.get(key)) : undefined,
      result(tx.objectStore('meta').get('revision')),
      key === 'statisticsScope' ? result(local.get('statisticsOpened')) : undefined,
      library ? result<string|undefined>(local.get('syncAccountId')) : undefined,
      library ? result<bigint|undefined>(tx.objectStore('meta').get('deviceEraseRevision')) : undefined, done(tx),
    ]);
    const state = {preference:row?.value ?? legacy,revision:revision ?? 0n};
    if (library && this.role === 'writer') {
      const generation = erased ?? 0n;
      const proofs = this.#librarySort.observe(account,generation,state.revision,state.preference);
      // Resolve the persisted order immediately on ordinary visits. Only a returning
      // tab with an interrupted edit needs to wait for its device's proof.
      const restored = this.#librarySort.needsRecovery ? this.#librarySort.take(await proofs) : undefined;
      if (restored && restored !== state.preference && this.role === 'writer') {
        await this.selectDisplayPreference(key,restored,{revision:state.revision,
          previous:{account,erased:generation,value:state.preference}});
        return this.devicePreference(key);
      }
    }
    if (library) return {...state,record:{account,erased:erased ?? 0n,revision:state.revision}};
    return key === 'statisticsScope' ? {...state,statisticsOpened:opened === true} : state;
  }

  async statisticsState(changedKeys?:ReadonlySet<string>, now = Date.now(), signal?:AbortSignal) {
    this.#compatible();
    const legacy = async () => ({...await this.devicePreference('statisticsScope'),checksCacheVersions:false,writerLease:undefined,
      metadataVersion:undefined,scoresVersion:undefined,creditEntries:undefined});
    if (!this.#db.objectStoreNames.contains('statistics')) return legacy();
    signal?.throwIfAborted();
    // Read the selected credits and the revision that describes them in one snapshot.
    const keys = changedKeys?.size && this.#role==='writer' ? [...changedKeys] : undefined;
    const tx = this.#db.transaction(keys ? ['statistics','tmdb'] : 'statistics');
    const entries = keys && readTmdbEntries(tx.objectStore('tmdb'),keys,signal);
    const [rows,writerLease] = await Promise.all([result<{key:string;value:unknown}[]>(tx.objectStore('statistics').getAll()),
      this.#role === 'writer' ? this.#metadataLease : metadataPeers(this.#db.name).then(info=>info.writerLease),finishRead(tx,signal)]);
    const state = new Map(rows.map(row=>[row.key,row.value]));
    const revision = state.get('revision');
    if (typeof revision !== 'bigint' || !state.has('scope') || !state.has('legacyScope') || !state.has('opened'))
      return legacy();
    const metadata = state.get('metadataVersion'), scores = state.get('scoresVersion');
    return {preference:state.get('scope') ?? state.get('legacyScope'),statisticsOpened:state.get('opened') === true,revision,
      metadataVersion:typeof metadata === 'string' ? metadata : undefined,scoresVersion:typeof scores === 'string' ? scores : undefined,
      checksCacheVersions:!!writerLease,writerLease,
      creditEntries:keys && entries && new Map(keys.map(key=>[key,retainedEntry(entries.get(key),now)]))};
  }

  appearanceState() { return this.devicePreference('appearance'); }

  async selectAppearance(preference: 'dark' | 'light' | 'device'): Promise<void> {
    await this.selectDisplayPreference('appearance', preference);
  }

  async selectWatchlistDensity(value: 'compact'|'comfortable') {
    await this.selectDisplayPreference('watchlistDensity',value);
  }

  async selectDisplayPreference(key: DisplayPreference, value: string, attempt?: PreferenceAttempt) {
    this.#requireWriter();
    const row = {setting:displayPreferences[key].setting,value};
    validateRow('settings',row);
    let displayRevision: bigint | undefined;
    if (key === 'librarySort') attempt ??= {};
    const stores = ['settings','local','meta'];
    if (key === 'statisticsScope') stores.push('statistics');
    const write = this.#write(stores, tx => {
      const settings = tx.objectStore('settings'), local = tx.objectStore('local'), meta = tx.objectStore('meta');
      const existing = settings.get(row.setting);
      const owner = attempt && local.get('syncAccountId'), erased = attempt && meta.get('deviceEraseRevision');
      const revision = meta.get('revision');
      revision.onsuccess = () => {
        if (attempt) {
          if (attempt.revision !== undefined && attempt.revision !== (revision.result ?? 0n)) return;
          const account = owner?.result, generation = erased?.result ?? 0n, priorValue = existing.result?.value;
          const previous = attempt.previous;
          if (previous && (previous.account !== account || previous.erased !== generation || previous.value !== priorValue)) return;
          attempt.previous ??= {account,erased:generation,value:priorValue};
        }
        if (existing.result?.value !== value) {
          settings.put(row);
          local.delete(key);
          if (key === 'statisticsScope') {
            statisticsField(tx,'scope',value);
            statisticsField(tx,'legacyScope',undefined);
          }
          local.delete(canceledKey('settings'));
          meta.put(true,'dropboxDirty');
          displayRevision = (revision.result ?? 0n) + 1n;
          meta.put(displayRevision,'revision');
        }
        // All checks and writes are queued. Let the next view read as soon as
        // the database commits, even if write-result events are still pending.
        tx.commit?.();
      };
    });
    if (key === 'librarySort') await this.#librarySort.track(value,write);
    else await write;
    if (displayRevision !== undefined) {
      if (key === 'librarySort' && attempt?.previous)
        void this.#librarySort.observe(attempt.previous.account,attempt.previous.erased,displayRevision,value);
      this.#statusChanged();
      this.#changed({statisticsUnchangedAt:displayRevision,tables:['settings'],settings:[row.setting],localKeys:[],onlyDescriptions:false});
    }
  }

  /** Read names, memberships, and ratings at one revision without loading the episode history. */
  async personalRows(checkWatched: readonly number[] = []): Promise<PersonalSnapshot> {
    this.#compatible();
    const tx = this.#db.transaction(['meta', 'ratings', 'lists', 'watched']);
    const seen = new Set<number>();
    const [revision, ratings, lists] = await Promise.all([
      result(tx.objectStore('meta').get('revision')), result(tx.objectStore('ratings').getAll()),
      result(tx.objectStore('lists').getAll()), Promise.all([...new Set(checkWatched)].map(async id => {
        const key = await result(tx.objectStore('watched').getKey(IDBKeyRange.bound([id], [id, []])));
        if (key !== undefined) seen.add(id);
      })), done(tx),
    ]);
    return { revision: revision ?? 0n, ratings, lists, watchedIds: seen };
  }

  /** Paint saved Watchlist titles before looking up seasons and schedules. */
  async watchlistMembers(signal?: AbortSignal): Promise<{id:number; title:string}[]> {
    this.#compatible();
    signal?.throwIfAborted();
    const tx = this.#db.transaction(['lists','shows','ratings','watched']);
    const members = result<RecordTables['lists']>(tx.objectStore('lists').getAll()).then(lists => {
      signal?.throwIfAborted();
      return Promise.all(visibleListRows(lists).filter(row => isWatchlist(row.list)).map(async row => {
        const id = row.show_id;
        const watched = await result(tx.objectStore('watched').getKey(IDBKeyRange.bound([id],[id,[]])));
        if (watched !== undefined) return null;
        if (row.show) return {id,title:row.show};
        const [description,rating] = await Promise.all([
          result<RecordTables['shows'][number]|undefined>(tx.objectStore('shows').get(id)),
          result<RecordTables['ratings'][number]|undefined>(tx.objectStore('ratings').get(id)),
        ]);
        return {id,title:rating?.show || description?.show || 'Show '+id};
      }));
    });
    const [rows] = await Promise.all([members,finishRead(tx,signal)]);
    return rows.filter(row => row !== null);
  }

  /** Look up episode history only for the chosen list's play totals or legacy unnamed members. */
  async listPageRows(selected?: string, signal?: AbortSignal, includePlays = false) {
    this.#compatible();
    signal?.throwIfAborted();
    const tx = this.#db.transaction(overviewStores);
    const members = result<RecordTables['lists']>(tx.objectStore('lists').getAll()).then(async lists => {
      signal?.throwIfAborted();
      const names = orderedListNames(lists).filter(list => !isWatchlist(list));
      const requested = selected !== undefined ? canonicalListName(selected) : undefined;
      const name = requested !== undefined && names.includes(requested) ? requested : names[0];
      const needsWatches = lists.filter(row => row.list === name && !isListDeclaration(row) && (includePlays || !row.show));
      const watched = await Promise.all(needsWatches.map(({show_id}) =>
        result<RecordTables['watched']>(tx.objectStore('watched').getAll(IDBKeyRange.bound([show_id],[show_id,[]])))));
      return {name,names,lists,watched:watched.flat()};
    });
    const [selection,ratings,shows] = await Promise.all([members,
      result<RecordTables['ratings']>(tx.objectStore('ratings').getAll()),
      result<RecordTables['shows']>(tx.objectStore('shows').getAll()),finishRead(tx,signal)]);
    return {name:selection.name,names:selection.names,
      tables:{lists:selection.lists,watched:selection.watched,ratings,shows}};
  }

  /** Look up saved titles for the list picker without copying a show's whole episode history. */
  async listSearchTitles(signal?: AbortSignal) {
    this.#compatible();
    signal?.throwIfAborted();
    const tx = this.#db.transaction(overviewStores);
    const titles = new Map<number,string>();
    const request = tx.objectStore('watched').openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || signal?.aborted) return;
      const row = cursor.value as TableRows['watched'];
      titles.set(row.show_id,row.show);
      if (row.show) cursor.continue([row.show_id,[]]);
      else cursor.continue();
    };
    const [shows,ratings,lists] = await Promise.all([
      result<RecordTables['shows']>(tx.objectStore('shows').getAll()),
      result<RecordTables['ratings']>(tx.objectStore('ratings').getAll()),
      result<RecordTables['lists']>(tx.objectStore('lists').getAll()),finishRead(tx,signal)]);
    const descriptions = new Map(shows.map(row => [row.show_id,row]));
    function add(id: number, title: string) {
      if (!titles.get(id)) titles.set(id,title);
    }
    for (const row of ratings) add(row.show_id,row.show);
    for (const row of lists) if (!isListDeclaration(row)) add(row.show_id,row.show);
    return [...titles].map(([show_id,title]) => {
      const held = descriptions.get(show_id);
      return {show_id,show:title || held?.show || '',year:held?.year ?? null};
    }).filter(row => row.show);
  }

  async #write(stores: string[], enqueue: (tx: IDBTransaction, fail: (error: unknown) => void) => void): Promise<void> {
    this.#compatible();
    const scope = new Set([...stores,'local']);
    if (!this.#db.objectStoreNames.contains('statistics')) scope.delete('statistics');
    const tx = this.#db.transaction([...scope], 'readwrite', { durability: 'strict' });
    let failure: unknown;
    const completion = done(tx).catch(error => {
      if (failure instanceof StaleSnapshotError) throw failure;
      throw writeError(failure ?? error);
    });
    this.#writes.add(completion);
    function abort(error: unknown) {
      failure = error;
      tx.abort();
    }
    try {
      this.#checkProviderBinding(tx,() => {
        try { enqueue(tx, abort); } catch (error) { abort(error); }
      });
      await completion;
    } finally {
      this.#writes.delete(completion);
    }
  }

  /** Install watches from an empty device or its exact base. A watched-only clear also commits its observed generation. */
  installWatchDownload(revision: bigint, watched: RecordTables['watched'] | WatchedRowChanges, receipt: FileSyncState,
      session: ProviderSession, current: () => boolean, prior?: PriorWatchDownload, reset?:WatchedResetAdoption): Promise<void> {
    const patch = watchFilePatch(watched,receipt);
    if (!receipt.base || receipt.pending || !patch || (!Array.isArray(watched) && (!prior || reset))) {
      return Promise.reject(new StaleSnapshotError());
    }
    const {accountId,instanceId,signInDeadline} = session;
    if (reset) {
      if (reset.after.accountId !== accountId || reset.after.format !== 2) return Promise.reject(new StaleSnapshotError());
      patch.local = {dropboxResetSeen:reset.after};
      patch.removeLocal = [canceledKey('watched'),...resetWatchLocalKeys];
      if (reset.initializeSettings) patch.sync!.settings = {base:null,pending:null,lastClientModified:null};
    }
    return this.#commit(revision,patch,{syncWrite:true,current,invalidateTmdbWork:!!reset},
      {accountId,instanceId,signInDeadline,prior:prior && structuredClone(prior),reset:reset && structuredClone(reset)});
  }

  /** Apply the approved watches to their exact local base and stage the absolute upload in one transaction. */
  installWatchRestore(revision:bigint,watched:RecordTables['watched'] | WatchedRowChanges,receipt:FileSyncState,
      session:ProviderSession,current:()=>boolean,prior:PriorWatchDownload):Promise<void> {
    const pending = receipt.pending, patch = watchFilePatch(watched,receipt);
    if (!patch || !receipt.base || pending?.absoluteWatches !== true ||
        pending.targetRevision !== prior.base.revision || pending.targetContent !== prior.base.content ||
        receipt.base.revision !== prior.base.revision || receipt.base.content !== prior.base.content ||
        pending.clientModified !== receipt.lastClientModified) return Promise.reject(new StaleSnapshotError());
    const {accountId,instanceId,signInDeadline} = session;
    return this.#commit(revision,patch,{syncWrite:true,current},{accountId,instanceId,signInDeadline,prior:structuredClone(prior)});
  }

  async #writeWatchDownload(revision: bigint, rows: WatchedRowChanges['put'], receipt: FileSyncState,
      session: ProviderSession & {prior?:PriorWatchDownload; reset?:WatchedResetAdoption}, current: () => boolean,
      remove?:WatchedRowChanges['remove']) {
    let erased = 0n;
    const resultKind = await writeWatchDownload({database:this.#db.name,version:this.#db.version},async () => {
      this.#requireWriter();
      await this.#write(['meta','local'],(tx,fail) => {
        const meta = tx.objectStore('meta'), record = meta.get('revision'), epoch = meta.get('deviceEraseRevision');
        this.#binding(tx,session,current,() => {
          if ((record.result ?? 0n) !== revision) return fail(new StaleSnapshotError());
          erased = epoch.result ?? 0n;
        },fail);
      });
      this.#requireWriter();
      if (!current()) throw new StaleSnapshotError();
      return {revision,rows,...(remove && {remove}),receipt,accountId:session.accountId,erased,
        expiresAt:Date.now() + (session.signInDeadline-this.#providerNow()),
        ...(session.prior && {prior:session.prior}),...(session.reset && {reset:session.reset})};
    },this.#waiting.signal,() => new StaleSnapshotError(),session.prior || session.reset ? () =>
      this.#role === 'writer' && current() && this.#providerNow() < session.signInDeadline : undefined);
    if (resultKind !== 'unconfirmed') return resultKind === 'written';
    // The worker has terminated. Wait for the old native transaction to settle before inspecting its receipt.
    this.#compatible();
    const tx = this.#db.transaction(['meta','sync','local']), meta = tx.objectStore('meta');
    const [record,epoch,account,stored,observation] = await Promise.all([result<bigint|undefined>(meta.get('revision')),
      result<bigint|undefined>(meta.get('deviceEraseRevision')),result<string|undefined>(tx.objectStore('local').get('syncAccountId')),
      result<FileSyncState|undefined>(tx.objectStore('sync').get('watched')),
      session.reset && result(tx.objectStore('local').get('dropboxResetSeen')),done(tx)]);
    const expectedPending = receipt.pending ? stored?.lastClientModified === receipt.lastClientModified &&
      sameReceipt(stored.pending,receipt.pending) : !stored?.pending;
    if (account === session.accountId && (epoch ?? 0n) === erased && (record ?? 0n) > revision &&
        stored?.base?.revision === receipt.base!.revision && stored.base.content === receipt.base!.content && expectedPending &&
        (!session.reset || sameResetObservation(observation,session.reset.after))) return true;
    throw new DOMException('The downloaded watches could not be confirmed. Sync again to check the record.','AbortError');
  }

  /** Only an approved import may write this multi-table patch in another context. */
  async #writeImport(revision:bigint, patch:DeviceChanges, imported:NonNullable<CommitOptions['tmdbImport']>,
      session:ProviderSession, current:()=>boolean) {
    const id = crypto.randomUUID();
    let erased = 0n;
    const valid = () => this.#role === 'writer' && current() && !!this.#providerValue('tmdb_key') &&
      this.#providerNow() < session.signInDeadline;
    const resultKind = await runImportRecord({database:this.#db.name,version:this.#db.version},async () => {
      this.#requireWriter();
      await this.#write(['meta','local'],(tx,fail) => {
        const meta = tx.objectStore('meta'), record = meta.get('revision'), epoch = meta.get('deviceEraseRevision');
        this.#binding(tx,session,valid,() => {
          if ((record.result ?? 0n) !== revision) return fail(new StaleSnapshotError());
          erased = epoch.result ?? 0n;
        },fail);
      });
      if (!valid()) throw new StaleSnapshotError();
      return {id,revision,erased,accountId:session.accountId,expiresAt:Date.now()+(session.signInDeadline-this.#providerNow()),
        generation:imported.generation,entries:imported.entries,patch};
    },this.#waiting.signal,() => new StaleSnapshotError(),valid);
    if (resultKind.status === 'written' && resultKind.result?.id === id) return resultKind.result;
    if (resultKind.status === 'unavailable') return null;
    this.#compatible();
    const tx = this.#db.transaction(['meta','local']), meta = tx.objectStore('meta');
    const [receipt,epoch,account] = await Promise.all([result<SavedImport|undefined>(meta.get(importReceiptKey)),
      result<bigint|undefined>(meta.get('deviceEraseRevision')),result<string|undefined>(tx.objectStore('local').get('syncAccountId')),done(tx)]);
    if (account === session.accountId && (epoch ?? 0n) === erased && receipt?.id === id) return receipt;
    throw new DOMException('The import could not be confirmed. Reopen the file to review the saved record.','AbortError');
  }

  async #writeWatchEdit(revision:bigint, changes:NonNullable<ReturnType<typeof largeWatchEdit>>,
      generation:bigint|undefined, cachedAccount:string|undefined, current:()=>boolean) {
    const id = crypto.randomUUID();
    let epoch = 0n, account:string|null = null;
    const outcome = await runManualWatchWrite({database:this.#db.name,version:this.#db.version},async () => {
      this.#requireWriter();
      const tx = this.#db.transaction(['meta','local']), meta = tx.objectStore('meta');
      const [record,erased,owner] = await Promise.all([result<bigint|undefined>(meta.get('revision')),
        result<bigint|undefined>(meta.get('deviceEraseRevision')),result<string|undefined>(tx.objectStore('local').get('syncAccountId')),done(tx)]);
      if ((record ?? 0n) !== revision || (cachedAccount && owner !== cachedAccount) || !current()) throw new StaleSnapshotError();
      epoch = erased ?? 0n;
      account = owner ?? null;
      return {...changes,id,revision,erased:epoch,owner:account,generation};
    },this.#waiting.signal,() => new StaleSnapshotError(),current);
    if (outcome.status === 'written' && outcome.result === id) return true;
    if (outcome.status === 'unavailable') return false;
    // Once rows have been dispatched, a missing reply is not permission to repeat a rewatch.
    try {
      const tx = this.#db.transaction(['meta','local']), meta = tx.objectStore('meta');
      const [receipt,erased,owner] = await Promise.all([result(meta.get(watchEditReceiptKey)),
        result<bigint|undefined>(meta.get('deviceEraseRevision')),result<string|undefined>(tx.objectStore('local').get('syncAccountId')),done(tx)]);
      if (receipt === id && (erased ?? 0n) === epoch && (owner ?? null) === account) return true;
    } catch { /* The writer may have closed after the transaction settled. */ }
    throw new PersonalRecordError('Could not confirm the watch change. Check the saved counts before editing again.');
  }

  /** Commit a patch against the exact snapshot that produced it. Resolves on transaction completion. */
  commit(expectedRevision: bigint, changes: DeviceChanges, options: CommitOptions = {}): Promise<void> {
    return this.#commit(expectedRevision,changes,options);
  }

  async #commit(expectedRevision: bigint, changes: DeviceChanges, options: CommitOptions,
      download?: ProviderSession & {prior?:PriorWatchDownload; reset?:WatchedResetAdoption}): Promise<void> {
    this.#requireWriter();
    // Freeze the submitted values at call time, before IDB reads its revision.
    const patch = structuredClone(changes);
    const metadata = options.tmdb && structuredClone(options.tmdb);
    const imported = options.tmdbImport && structuredClone(options.tmdbImport);
    const importCurrent = imported && options.current ? () => this.#role === 'writer' && !!this.#providerValue('tmdb_key') &&
      options.current!() && (!imported.session || this.#providerNow() < imported.session.signInDeadline) : undefined;
    const manual = options.watchEdit && options.current &&
      Object.keys(options).every(key => ['watchEdit','requireTmdbGeneration','cachedMarkAccount','current'].includes(key)) ? largeWatchEdit(patch) : undefined;
    const manualCurrent = manual && options.current ? () => this.#role === 'writer' && options.current!() &&
      (options.requireTmdbGeneration === undefined || !!options.cachedMarkAccount || !!this.#providerValue('tmdb_key')) : undefined;
    let importExpiry = Infinity;
    for (const name of tables) {
      for (const row of patch.replace?.[name] ?? []) validateRow(name, row);
      for (const row of patch.put?.[name] ?? []) validateRow(name, row);
    }
    if (patch.replace?.lists) {
      const raw = patch.replace.lists;
      if (new Set(raw.map(row => rowKey('lists',row))).size !== raw.length)
        throw new DOMException('Duplicate lists row.','ConstraintError');
      patch.replace.lists = canonicalListRows(raw);
    }
    if (patch.put?.lists) patch.put.lists = canonicalListRows(patch.put.lists);
    if (patch.remove?.lists) patch.remove.lists = patch.remove.lists.map(([name,id]) => [canonicalListName(name),id]);
    const explicit = [...(patch.put?.settings ?? []).map(row=>row.setting), ...(patch.remove?.settings ?? [])].filter(isProviderKey);
    if (patch.replace?.settings?.some(row=>isProviderKey(row.setting))) throw new Error('Provider keys require a verified Dropbox settings change.');
    if (explicit.length) {
      const put = patch.put?.settings, remove = patch.remove?.settings;
      if (explicit.length !== 1 || options.syncWrite || Object.keys(patch).length !== 1 ||
          (put ?? remove)?.length !== 1 || Object.keys(patch.put ?? patch.remove ?? {}).length !== 1)
        throw new Error('Save one provider key to Dropbox at a time.');
      if (await this.recordRevision() !== expectedRevision) throw new StaleSnapshotError();
      const key = explicit[0];
      await this.#saveProviderKey(key, put?.[0]?.value ?? null, options.current ?? (()=>true));
      this.#changed({tables:['settings'], settings:[key], localKeys:[], onlyDescriptions:false, syncWrite:true});
      return;
    }
    if (patch.sync?.settings) patch.sync.settings = publicSettingsSync(patch.sync.settings);
    const nextMalSource = editedKey(patch, 'mal_source');
    let mdbListChanged = false;
    const imdbEdits:Partial<ImdbConfiguration> = {};
    for (const name of imdbSettings) {
      if (isProviderKey(name)) continue;
      const value = editedKey(patch, name);
      if (value !== undefined) imdbEdits[name] = value;
    }
    const editImdb = Object.keys(imdbEdits).length > 0;
    const malEdits:Partial<MalConfiguration> = {};
    if (nextMalSource !== undefined) malEdits.mal_source = nextMalSource;
    if (imdbEdits.github_repo !== undefined) malEdits.github_repo = imdbEdits.github_repo;
    const editMal = Object.keys(malEdits).length > 0;
    let malChanged = false;
    let imdbChanged = false;
    let activeImdbChanged = false;
    const changedTables = tables.filter(name => patch.replace?.[name] || patch.remove?.[name]?.length || patch.put?.[name]?.length);
    const localKeys = [...new Set([...Object.keys(patch.local ?? {}), ...(patch.removeLocal ?? [])])];
    const recordChanged = (!metadata && !imported) || changedTables.length > 0 || localKeys.length > 0 || Object.keys(patch.sync ?? {}).length > 0;
    const syncInputsChanged = Boolean(changedTables.length || Object.keys(patch.sync ?? {}).length);
    let browseOnly = metadata?.untracked && !recordChanged;
    let exportMetadataChanged = Boolean(metadata && !browseOnly && affectsExport(metadata.key));
    let seasonOrderChanged = false;
    const editedOrders = patch.put?.settings?.filter(row => isSeasonOrderKey(row.setting)) ?? [];
    const removedOrders = patch.remove?.settings?.filter(isSeasonOrderKey) ?? [];
    const stores = [...recordStores];
    // A receipt can also set or clear a file’s canceled-review flag. Both changes still
    // advance the global sync revision without changing the data shown in Statistics.
    const syncBookkeeping = options.syncWrite && !changedTables.length && localKeys.every(key => canceledFileKeys.has(key)) &&
      !metadata && !imported && !options.invalidateTmdbWork && !options.clearResetCredentials && !options.repair &&
      (localKeys.length > 0 || Object.keys(patch.sync ?? {}).length > 0);
    const changedScope = editedKey(patch,displayPreferences.statisticsScope.setting);
    if (recordChanged && !syncBookkeeping || exportMetadataChanged || imported) stores.push('statistics');
    if (metadata || imported || options.repair) stores.push('tmdb');
    if (editImdb || editMal) stores.push('cache');
    const downloadedRows = patch.replace?.watched ?? patch.put?.watched, receipt = patch.sync?.watched;
    let installed = false;
    if (download && downloadedRows && receipt?.base && typeof Worker !== 'undefined') {
      const operation = this.#writeWatchDownload(expectedRevision,downloadedRows,receipt,download,options.current!,patch.remove?.watched);
      this.#writes.add(operation);
      try { installed = await operation; } finally { this.#writes.delete(operation); }
    }
    if (imported?.session && options.current && imported.generation === options.requireTmdbGeneration &&
        Object.keys(options).every(key => ['requireTmdbGeneration','tmdbImport','current'].includes(key)) &&
        supportedImport(patch) && typeof Worker !== 'undefined') {
      const operation = this.#writeImport(expectedRevision,patch,imported,imported.session,options.current);
      this.#writes.add(operation);
      try {
        const saved = await operation;
        if (saved) {
          installed = true;
          importExpiry = saved.expiry;
          exportMetadataChanged = saved.exportChanged;
        }
      } finally { this.#writes.delete(operation); }
    }
    if (manual && manualCurrent && typeof Worker !== 'undefined') {
      const operation = this.#writeWatchEdit(expectedRevision,manual,options.requireTmdbGeneration,options.cachedMarkAccount,manualCurrent);
      this.#writes.add(operation);
      try { installed = await operation; } finally { this.#writes.delete(operation); }
    }
    if (!installed) await this.#write(stores, (tx, fail) => {
      const meta = tx.objectStore('meta');
      if (options.syncWrite && options.current) guardSyncCommit(tx,options.current,fail);
      const access = options.requireDropboxAccess;
      const savedGrant = access && tx.objectStore('local').get('dropboxSession');
      const getRevision = meta.get('revision');
      const apply = () => {
        try {
          if ((getRevision.result ?? 0n) !== expectedRevision || (options.current && !options.current())) {
            throw new StaleSnapshotError();
          }
          if (access && (savedGrant?.result?.accessToken !== access.accessToken || savedGrant?.result?.accessExpiresAt !== access.accessExpiresAt))
            throw new StaleSnapshotError();
          if (options.clearResetCredentials) {
            for (const key of providerKeys) tx.objectStore('settings').delete(key);
            meta.put(true,'providerKeysMigrated');
          }
          if (nextMalSource !== undefined) {
            // Readers need to update the displayed source even when the MDBList key and cache stay valid.
            const previous = tx.objectStore('settings').get('mal_source');
            previous.onsuccess = () => { if ((previous.result?.value ?? null) !== nextMalSource) mdbListChanged = true; };
          }
          if (patch.replace?.settings || editedOrders.length || removedOrders.length) {
            const previous = tx.objectStore('settings').getAll(IDBKeyRange.bound(seasonOrderPrefix,seasonOrderPrefix+'\uffff'));
            previous.onsuccess = () => {
              const old = new Map((previous.result as SettingRow[]).map(row => [row.setting,row.value]));
              const next = patch.replace?.settings ? new Map(patch.replace.settings.filter(row => isSeasonOrderKey(row.setting)).map(row => [row.setting,row.value])) : new Map(old);
              for (const key of removedOrders) next.delete(key);
              for (const row of editedOrders) next.set(row.setting,row.value);
              seasonOrderChanged = old.size !== next.size || [...old].some(([key,value]) => next.get(key) !== value);
            };
          }
          if (editImdb) changeImdbConfig(tx, imdbEdits, active => { imdbChanged = true; activeImdbChanged = active; });
          if (editMal) changeMalConfig(tx, malEdits, () => { malChanged = true; });
          if (options.invalidateTmdbWork) invalidateTmdbWork(tx);
          const watchCurrent = download ? () => this.#providerNow() < download.signInDeadline && options.current!()
            : importCurrent ?? manualCurrent ?? (options.syncWrite ? options.current : undefined);
          for (const name of tables) {
            const store = tx.objectStore(name);
            if (name === 'watched' && writeLargeWatchChanges(store,patch,fail,watchCurrent)) continue;
            if (patch.replace?.[name]) {
              if (name === 'settings') {
                // Preserve quarantined legacy secrets until Dropbox confirms their migration.
                const replacement = new Set(patch.replace.settings!.map(row=>row.setting));
                if (replacement.size !== patch.replace.settings!.length) throw new DOMException('Duplicate settings row.','ConstraintError');
                for (const row of patch.put?.settings ?? []) replacement.add(row.setting);
                const keys = store.getAllKeys();
                keys.onsuccess = () => {
                  for (const key of keys.result) if (!isProviderKey(String(key)) && !replacement.has(String(key))) store.delete(key);
                };
                for (const row of patch.replace.settings!) store.put(row);
              } else {
                store.clear();
                for (const row of patch.replace[name]!) store.add(row);
              }
            }
            for (const key of patch.remove?.[name] ?? []) store.delete(key);
            for (const row of patch.put?.[name] ?? []) store.put(row);
          }
          const sync = tx.objectStore('sync');
          for (const [key, value] of Object.entries(patch.sync ?? {})) {
            if (key === 'settings') {
              const original = sync.get(key);
              original.onsuccess = () => {
                const raw = original.result as FileSyncState|undefined;
                const safe = raw && publicSettingsSync(raw);
                if (!options.clearResetCredentials && (raw?.base?.content !== safe?.base?.content || raw?.pending?.content !== safe?.pending?.content ||
                    raw?.pending?.targetContent !== safe?.pending?.targetContent)) {
                  return fail(new Error('Verify the earlier settings backup in Dropbox before editing it.'));
                }
                if (value === null) sync.delete(key); else sync.put(value,key);
              };
              continue;
            }
            if (value === null) sync.delete(key);
            else sync.put(value, key);
          }
          const local = tx.objectStore('local');
          if (patch.removeLocal?.includes('syncAccountId') || Object.hasOwn(patch.local ?? {},'syncAccountId')) {
            const oldOwner = local.get('syncAccountId');
            oldOwner.onsuccess = () => {
              if (oldOwner.result !== patch.local?.syncAccountId) {
                meta.delete('noticeHistory');
                meta.delete(visitStoreKey);
                meta.delete(visitSealKey);
              }
            };
          }
          if (!options.syncWrite) for (const name of changedTables) {
            if (name !== 'shows') local.delete(canceledKey(name));
          }
          for (const key of patch.removeLocal ?? []) local.delete(key);
          for (const [key, value] of Object.entries(patch.local ?? {})) local.put(value, key);
          if (changedScope !== undefined) statisticsField(tx,'scope',changedScope);
          if (localKeys.includes('statisticsScope')) statisticsField(tx,'legacyScope',patch.local?.statisticsScope);
          if (localKeys.includes('statisticsOpened')) statisticsField(tx,'opened',patch.local?.statisticsOpened);
          if (metadata) {
            writeEntry(tx,metadata.key,metadata.entry);
            if (!browseOnly) statisticsCacheChanged(tx,'metadataVersion');
          }
          let afterCache: ((ready:()=>void)=>void) | undefined;
          if (imported) {
            afterCache = importCacheWrites(tx,imported.entries,(expiresAt,partOfExport) => {
              if (!Number.isFinite(importExpiry)) statisticsCacheChanged(tx,'metadataVersion');
              importExpiry = Math.min(importExpiry,expiresAt);
              if (!exportMetadataChanged && partOfExport) {
                exportMetadataChanged = true;
                if (!syncInputsChanged) meta.put(true,'dropboxDirty');
              }
            },fail);
          }
          if (syncInputsChanged || exportMetadataChanged) meta.put(true, 'dropboxDirty');
          if (recordChanged) statisticsRevision(tx,expectedRevision + 1n);
          if (importCurrent && afterCache) {
            // Cache comparisons enqueue their own writes. Check again after their last write and
            // the original record requests have executed. Later watch batches carry the same guard.
            afterCache(() => {
              meta.getKey('revision').onsuccess = () => { if (!importCurrent()) fail(new StaleSnapshotError()); };
            });
          }
        } catch (error) { fail(error); }
      };
      getRevision.onsuccess = () => {
        if (download) {
          const count = tx.objectStore('watched').count(), prior = tx.objectStore('sync').get('watched');
          const currentReset = watchResetGuard(tx,download.reset);
          this.#binding(tx,download,options.current!,() => {
            if (!matchesDownloadBase(count.result,prior.result,download.prior) || !currentReset()) return fail(new StaleSnapshotError());
            apply();
          },fail);
          return;
        }
        const repair = options.repair;
        if (repair) {
          readShowEpisodes(tx,repair.reviewed.showId,repair.now(),'repair',({preview:live}) => {
            if (sameRepair(repair.reviewed, live)) apply();
            else fail(new StaleSnapshotError());
          });
          return;
        }
        const generation = metadata?.generation ?? imported?.generation ?? options.requireTmdbGeneration;
        if (generation === undefined) return apply();
        const checkGeneration = () => withControl(tx, control => {
          if (control.refused !== null || !control.credential || control.generation !== generation) return fail(new StaleSnapshotError());
          if (options.cachedMarkAccount && !metadata && !imported && options.requireTmdbGeneration !== undefined) {
            const owner = tx.objectStore('local').get('syncAccountId');
            owner.onsuccess = () => owner.result === options.cachedMarkAccount ? apply() : fail(new StaleSnapshotError());
          } else if (!this.#providerValue('tmdb_key')) fail(new StaleSnapshotError());
          else if (metadata && !recordChanged && exportMetadataChanged) {
            checkTmdbReportChange(tx,metadata.key,metadata.entry,metadata.entry.fetchedAt,changed=>{
              if (!this.#providerValue('tmdb_key')) return fail(new StaleSnapshotError());
              exportMetadataChanged = changed;
              browseOnly = !changed;
              apply();
            });
          } else apply();
        });
        if (imported?.session && importCurrent) this.#binding(tx,imported.session,importCurrent,checkGeneration,fail);
        else checkGeneration();
      };
    });
    if (metadata) this.#scheduleExpiry(cacheExpiresAt(metadata.entry.fetchedAt));
    if (metadata || Number.isFinite(importExpiry)) {
      this.#tmdbMetadataChanged(browseOnly ? 'tmdbbrowse' : 'tmdbmetadata',
        Number.isFinite(importExpiry) ? undefined : metadata?.key.endsWith('/aggregate_credits'),metadata?.key === 'configuration');
    }
    if (options.invalidateTmdbWork) this.#exportUpdates?.postMessage('tmdbstate');
    if (mdbListChanged) this.#scoresChanged('mdblist');
    if (malChanged) {
      this.#ratingConfigChanged('malconfigchange');
      this.#scoresChanged('mal');
    }
    if (imdbChanged) {
      if (activeImdbChanged) this.#ratingConfigChanged('imdbconfigchange');
      this.#scoresChanged('imdb');
    }
    if (Number.isFinite(importExpiry)) this.#scheduleExpiry(importExpiry);
    // Personal settings edits already schedule sync through recordchange. A downloaded
    // order is included when this same sync publishes its derived files.
    if (exportMetadataChanged) this.dispatchEvent(new Event('summarychange'));
    if (syncInputsChanged || exportMetadataChanged) this.#statusChanged();
    if (changedTables.some(name => name !== 'settings') || exportMetadataChanged || seasonOrderChanged) this.#exportChanged();
    if (!recordChanged) return;
    if (localKeys.some(key => key === 'dropboxSession' || key === 'syncAccountId' || key === 'syncAppKey')) this.#dropboxChanged();
    this.#changed({
      statisticsUnchangedAt: syncBookkeeping ? expectedRevision + 1n : undefined,
      syncWrite: options.syncWrite,
      tables: changedTables,
      settings: patch.replace?.settings ? 'all' : [...new Set([...(patch.remove?.settings ?? []), ...(patch.put?.settings ?? []).map(row => row.setting)])],
      localKeys,
      onlyDescriptions: Boolean(options.onlyDescriptions),
    });
  }

  #changed(detail: RecordChange): void {
    if (detail.settings === 'all' || detail.settings.some(key => recentId(key) !== null)) {
      this.#exportUpdates?.postMessage('recentmarkschange');
    }
    for (const key of displayPreferenceNames) {
      if (detail.settings === 'all' || detail.settings.includes(displayPreferences[key].setting) || detail.localKeys.includes(key)) {
        this.dispatchEvent(new Event(key.toLowerCase() + 'change'));
        this.#exportUpdates?.postMessage(key);
      }
    }
    this.dispatchEvent(new CustomEvent('recordchange', { detail }));
  }

  #exportChanged(): void {
    this.dispatchEvent(new Event('exportchange'));
    // A reader can share while another tab edits. Send only an invalidation.
    this.#exportUpdates?.postMessage(null);
  }

  #ratingConfigChanged(event: 'imdbconfigchange'|'malconfigchange'): void {
    this.dispatchEvent(new Event(event));
    this.#exportUpdates?.postMessage(event);
  }

  #tmdbMetadataChanged(event: 'tmdbmetadata'|'tmdbbrowse' = 'tmdbmetadata', castChanged?:boolean, configurationChanged = true,
      statisticsChange?:StatisticsMetadataChange): void {
    const detailOnly = event === 'tmdbbrowse' && castChanged !== undefined && !configurationChanged;
    this.dispatchEvent(new CustomEvent(event,{detail:{castChanged,detailOnly,statisticsChange}}));
    this.#exportUpdates?.postMessage(detailOnly && !castChanged ? 'tmdb-detail-browse' : event);
    if (detailOnly && castChanged) {
      // The earliest Cast screens discard a previously found name only on this legacy notification.
      void metadataPeers(this.#db.name).then(({olderReader})=>{
        if (olderReader && this.#role==='writer') this.#exportUpdates?.postMessage('tmdbmetadata');
      });
    }
  }

  #scoresChanged(provider:RatingsProvider, statisticsChanged = true):void {
    this.dispatchEvent(scoreNotice(provider,statisticsChanged));
    // Other tabs need only the display invalidation, never a title, score or account.
    this.#exportUpdates?.postMessage(statisticsChanged ? provider : {kind:'score-display',provider});
  }

  async malState():Promise<MalState> {
    this.#compatible();
    const tx = this.#db.transaction(['meta','settings','local']), meta = tx.objectStore('meta');
    this.#checkProviderBinding(tx,()=>{});
    const settings = tx.objectStore('settings');
    const [control,shared,revision,source,repo] = await Promise.all([result(meta.get(malControlKey)),
      result(meta.get(imdbControlKey)),result(meta.get('revision')),result(settings.get('mal_source')),result(settings.get('github_repo')),done(tx)]);
    const {githubPause,githubGeneration} = defaultImdbControl(shared);
    return {...malControl(control),githubPause,githubGeneration,revision:revision ?? 0n,
      config:{mal_source:source?.value ?? null,github_repo:repo?.value ?? null,github_token:this.#providerValue('github_token')}};
  }

  async malEntries(ids:readonly number[], signal?:AbortSignal):Promise<Map<number,MalEntry[]>> {
    this.#compatible();
    signal?.throwIfAborted();
    const matches = new Map<number,MalEntry[]>();
    if (malLookupAvailable(ids.length)) {
      const selection = this.#db.transaction(['settings','meta']);
      const [source,initial] = await Promise.all([result<SettingRow|undefined>(selection.objectStore('settings').get('mal_source')),
        result<MalControl|undefined>(selection.objectStore('meta').get(malControlKey)),finishRead(selection,signal,this.#waiting.signal)]);
      if (source?.value !== 'github') return matches;
      const found = await lookupMalIndex({database:this.#db.name,version:this.#db.version},ids,this.#waiting.signal,signal);
      this.#compatible();
      signal?.throwIfAborted();
      if (found) {
        const verify = this.#db.transaction('meta');
        const [live] = await Promise.all([result<MalControl|undefined>(verify.objectStore('meta').get(malControlKey)),
          finishRead(verify,signal,this.#waiting.signal)]);
        return initial?.generation === live?.generation && initial?.file?.digest === live?.file?.digest ? found : matches;
      }
    }
    if (!ids.length) return matches;
    const tx = this.#db.transaction(['settings','cache']), cache = tx.objectStore('cache');
    const source = tx.objectStore('settings').get('mal_source');
    source.onsuccess = () => {
      if (signal?.aborted || source.result?.value !== 'github') return;
      readCacheValues<MalEntry[]>(cache,ids.map(malShowKey),(index,row)=>matches.set(ids[index],row),signal);
    };
    await finishRead(tx,signal);
    return matches;
  }

  async writeGithubGate(generation:bigint, hash:string, pause:ImdbPause, current:()=>boolean):Promise<void> {
    this.#requireWriter();
    hash = await this.providerContentTag(hash);
    let changed = false;
    await this.#write(['meta'], tx => {
      const meta = tx.objectStore('meta'), request = meta.get(imdbControlKey);
      request.onsuccess = () => {
        const control = defaultImdbControl(request.result);
        if (!this.#providerValue('github_token') || control.githubGeneration !== generation || !current()) return;
        meta.put({...control,githubPause:pause},imdbControlKey);
        if (pause.kind === 'throttled') meta.put(pause,imdbQuotaKey('github',hash));
        changed = true;
      };
    });
    if (changed) {
      this.#scoresChanged('imdb',false); this.#scoresChanged('mal',false);
      this.dispatchEvent(new Event('imdbpausechange'));
      this.dispatchEvent(new Event('malpausechange'));
    }
  }

  async writeMal(generation:bigint, write:MalWrite, current?:()=>boolean):Promise<boolean> {
    this.#requireWriter();
    if (write.quota) write = {...write,quota:{...write.quota,hash:await this.providerContentTag(write.quota.hash)}};
    let applied = false, pauseChanged = false, statisticsChanged = Boolean(write.replacement);
    const replacement = write.replacement;
    if (replacement && replacement.shows.size >= 512) {
      const saved = await this.#writeGithubIndex(generation,{source:'mal',write:{...write,replacement}},current);
      if (saved === false) return false;
      if (saved) { applied = true; pauseChanged = saved.pauseChanged; }
    }
    const stores = ['meta','cache'];
    if (statisticsChanged || 'file' in write.update) stores.push('statistics');
    if (!applied) await this.#write(stores, (tx,fail) => {
      const meta = tx.objectStore('meta'), cache = tx.objectStore('cache');
      const shared = meta.get(imdbControlKey), request = meta.get(malControlKey);
      request.onsuccess = () => {
        const before = malControl(request.result);
        if (!this.#providerValue('github_token') || before.generation !== generation || current && !current()) return;
        if ('file' in write.update && before.file?.digest !== write.update.file?.digest) statisticsChanged = true;
        try {
          if (write.replacement) {
            cache.delete(malRange());
            for (const [key,value] of malIndexRows(write.replacement)) cache.put(value,key);
          }
          pauseChanged = saveMalControl(meta,before,shared.result,write);
          if (statisticsChanged) statisticsCacheChanged(tx,'scoresVersion');
          applied = true;
        } catch (error) { fail(error); }
      };
    });
    if (applied) this.#scoresChanged('mal',statisticsChanged);
    if (pauseChanged) {
      this.#scoresChanged('imdb',false);
      this.dispatchEvent(new Event('imdbpausechange'));
      this.dispatchEvent(new Event('malpausechange'));
    }
    return applied;
  }

  async #writeGithubIndex(generation:bigint, index:GithubIndex, current?:()=>boolean) {
    const session = this.#providerSession;
    if (!session || typeof Worker === 'undefined') return null;
    const operation = this.#installGithubIndex(generation,index,session,current ?? (()=>true));
    this.#writes.add(operation);
    try { return await operation; } finally { this.#writes.delete(operation); }
  }

  async #installGithubIndex(generation:bigint, index:GithubIndex, session:ProviderSession, current:()=>boolean,
      retryRevision=true):Promise<GithubInstallation|false|null> {
    const id = crypto.randomUUID();
    const hash = this.#providerHashes.github_token;
    const valid = () => this.#role === 'writer' && this.#providerSession?.instanceId === session.instanceId &&
      this.#providerSession.accountId === session.accountId && this.#providerSession.signInDeadline === session.signInDeadline &&
      this.#providerHashes.github_token === hash && !!this.#providerValue('github_token') && current();
    let preparedRevision:bigint|undefined;
    try {
      const outcome = await installGithubIndex({database:this.#db.name,version:this.#db.version},async () => {
        let revision = 0n, erased = 0n;
        await this.#write(['meta'],(tx,fail) => {
          const meta = tx.objectStore('meta'), record = meta.get('revision'), epoch = meta.get('deviceEraseRevision');
          const own = meta.get(index.source === 'mal' ? malControlKey : imdbControlKey);
          this.#binding(tx,session,valid,() => {
            if ((own.result?.generation ?? 0n) !== generation) return fail(new StaleSnapshotError());
            revision = record.result ?? 0n; erased = epoch.result ?? 0n;
          },fail);
        });
        if (!valid()) throw new StaleSnapshotError();
        preparedRevision = revision;
        return {id,revision,erased,accountId:session.accountId,expiresAt:Date.now()+(session.signInDeadline-this.#providerNow()),
          generation,...index};
      },this.#waiting.signal,valid,()=>new StaleSnapshotError());
      if (outcome.status === 'written' && outcome.result?.id === id) return outcome.result;
      if (outcome.status === 'unavailable') return null;
      // A reply can disappear after commit. Read the receipt before considering any retry.
      this.#compatible();
      const tx = this.#db.transaction('meta');
      const [saved] = await Promise.all([result<GithubInstallation|undefined>(tx.objectStore('meta').get(githubInstallationKey(index.source))),done(tx)]);
      return saved?.id === id && valid() ? saved : false;
    } catch (error) {
      if (!(error instanceof StaleSnapshotError)) throw error;
      if (retryRevision && preparedRevision !== undefined && valid()) {
        const live = index.source === 'mal' ? await this.malState() : await this.imdbState();
        if (live.generation === generation && live.revision !== preparedRevision && valid())
          return this.#installGithubIndex(generation,index,session,current,false);
      }
      return false;
    }
  }

  async imdbDisplayState(signal?:AbortSignal, title?:{id:number; now:number}):Promise<ImdbDisplayState> {
    this.#compatible();
    signal?.throwIfAborted();
    const tx = this.#db.transaction(title ? ['meta','settings','tmdb','shows'] : ['meta','settings']);
    const selected = result(tx.objectStore('settings').get('imdb_source')).then(row=>imdbSource({imdb_source:row?.value ?? null}));
    const identity = title && selected.then(async source => {
      signal?.throwIfAborted();
      if (source === 'none') return null;
      const cache = tx.objectStore('tmdb');
      const [show,index,external] = await Promise.all([
        result(cache.get(tmdbResourceKey({kind:'show',id:title.id}))),
        result<RecordTables['shows'][number]|undefined>(tx.objectStore('shows').get(title.id)),
        result(cache.get(imdbExternalKey(title.id))),
      ]);
      return retainedEntry<TmdbDataByKind['show']|null>(show,title.now)?.value?.imdbId || index?.imdb_id ||
        retainedEntry<TmdbDataByKind['external-ids']|null>(external,title.now)?.value?.imdbId || null;
    });
    const [value,source,imdbId] = await Promise.all([result(tx.objectStore('meta').get(imdbControlKey)),selected,identity,finishRead(tx,signal)]);
    const control = defaultImdbControl(value);
    return {generation:control.generation,configGeneration:control.configGeneration,file:control.file,source,pause:sourcePause(source,control),imdbId};
  }

  async imdbState(signal?:AbortSignal): Promise<ImdbState> {
    this.#compatible();
    signal?.throwIfAborted();
    const tx = this.#db.transaction(['meta','settings','local']);
    this.#checkProviderBinding(tx,()=>{});
    const meta = tx.objectStore('meta'), settings = tx.objectStore('settings');
    const [control,revision,source,repo] = await Promise.all([result(meta.get(imdbControlKey)),
      result(meta.get('revision')), result(settings.get('imdb_source')), result(settings.get('github_repo')), finishRead(tx,signal)]);
    return {...defaultImdbControl(control), revision:revision ?? 0n,config:{imdb_source:source?.value ?? null,
      github_repo:repo?.value ?? null,github_token:this.#providerValue('github_token'),omdb_key:this.#providerValue('omdb_key')}};
  }

  /** Start the exact external-ID reads while Statistics loads titles, seasons and cast. */
  async imdbExternalEntries(ids:readonly number[], signal:AbortSignal) {
    this.#compatible();
    signal.throwIfAborted();
    const tx = this.#db.transaction('tmdb');
    const entries = readImdbExternalEntries(tx.objectStore('tmdb'),ids.map(imdbExternalKey),signal);
    await finishRead(tx,signal);
    return entries;
  }

  /** An explicit null is a known absence. Only unmapped titles require a TMDB lookup. */
  async imdbIdentities(ids:readonly number[], now:number, validUntil?: (deadline:number) => void, headers?: ImdbHeaders,
    prefetched?:ReadonlyMap<string,ImdbExternalEntry>, signal?:AbortSignal): Promise<Map<number,string|null>> {
    this.#compatible();
    signal?.throwIfAborted();
    const tx = this.#db.transaction(['tmdb','shows']);
    const tmdb = tx.objectStore('tmdb'), shows = tx.objectStore('shows');
    const mapped = new Map<number,string|null>();
    const externalKeys = ids.map(imdbExternalKey);
    // Statistics also needs the expiry of a retained external-ID entry even
    // when the show header supplies its rating identity. Read those keys together.
    const externalEntries = validUntil ? prefetched ?? readImdbExternalEntries(tmdb,externalKeys,signal) : undefined;
    const [identities] = await Promise.all([Promise.all(ids.map(async (id,i) => {
      const shared = headers?.get(id);
      const canReuse = shared && (!shared.value || shared.value.show_id === id) &&
        shared.fetchedAt <= now && cacheExpiresAt(shared.fetchedAt) > now;
      const detail = canReuse ? {...shared,expiresAt:cacheExpiresAt(shared.fetchedAt)} :
        retainedEntry<TmdbDataByKind['show']|null>(await result(tmdb.get(tmdbResourceKey({kind:'show',id}))),now);
      const headerId = detail?.value?.imdbId;
      signal?.throwIfAborted();
      const index = headerId ? undefined : await result<RecordTables['shows'][number]|undefined>(shows.get(id));
      const identity = headerId || index?.imdb_id;
      signal?.throwIfAborted();
      const external = !externalEntries && !identity ? await result(tmdb.get(externalKeys[i])) : undefined;
      return {id,detail,identity,external};
    })),finishRead(tx,signal)]);
    for (const [i,{id,detail,identity,external}] of identities.entries()) {
      const other = retainedEntry<TmdbDataByKind['external-ids']|null>(externalEntries?.get(externalKeys[i]) ?? external,now);
      if (detail && validUntil) validUntil(detail.expiresAt);
      if (other && validUntil) validUntil(other.expiresAt);
      const imdbId = identity || other?.value?.imdbId;
      if (imdbId || detail || other) mapped.set(id, imdbId || null);
    }
    return mapped;
  }

  async imdbValues<T>(generation:bigint, keys:IDBValidKey[], expectedDigest?:string, signal?:AbortSignal):Promise<(T|undefined)[]> {
    this.#compatible();
    signal?.throwIfAborted();
    const tx = this.#db.transaction(['cache','meta']);
    const values = Array<T|undefined>(keys.length).fill(undefined);
    const series = keys.length >= 16 && keys.every(key=>Array.isArray(key) && key.length === 3 &&
      key[0] === 'imdb' && key[1] === 'omdb' && typeof key[2] === 'string');
    readCacheValues<T>(tx.objectStore('cache'),keys,(index,row)=>{ values[index] = row; },signal,series ? 'omdb-series' : undefined);
    const [control] = await Promise.all([result(tx.objectStore('meta').get(imdbControlKey)), finishRead(tx,signal)]);
    const current = defaultImdbControl(control);
    return current.generation === generation && (expectedDigest === undefined || current.file?.digest === expectedDigest) ? values : [];
  }

  async writeImdb(generation:bigint, write:ImdbWrite, current?:()=>boolean):Promise<boolean> {
    this.#requireWriter();
    if (write.quota) write = {...write,quota:{...write.quota,hash:await this.providerContentTag(write.quota.hash)}};
    let applied = false, githubGateChanged = false;
    // Episode detail has its own cache. Only series scores and the installed job
    // file can change the comparison on Statistics.
    let statisticsChanged = Boolean(write.deleteFileData || write.entries?.some(([key]) =>
      !(Array.isArray(key) && key.length === 4 && key[0] === 'imdb' && key[1] === 'omdb' && typeof key[3] === 'number')));
    const replacement = write.replacement;
    if (replacement && replacement.buckets.size >= 64 && write.deleteFileData && !write.entries &&
        write.expectedDigest === undefined && write.removeLegacyEpisodesFor === undefined) {
      const saved = await this.#writeGithubIndex(generation,{source:'imdb',write:{...write,replacement}},current);
      if (saved === false) return false;
      if (saved) { applied = true; githubGateChanged = saved.pauseChanged; }
    }
    const stores = ['meta','cache'];
    if (!write.silent && (statisticsChanged || write.update && 'file' in write.update)) stores.push('statistics');
    if (!applied) await this.#write(stores, (tx,fail) => {
      const meta = tx.objectStore('meta'), cache = tx.objectStore('cache');
      const request = meta.get(imdbControlKey);
      request.onsuccess = () => {
        const control = defaultImdbControl(request.result);
        if (!this.providerKeysAvailable || control.generation !== generation || current && !current() ||
            (write.expectedDigest !== undefined && control.file?.digest !== write.expectedDigest)) return;
        if (write.update && 'file' in write.update && control.file?.digest !== write.update.file?.digest) statisticsChanged = true;
        try {
          if (write.deleteFileData) cache.delete(imdbRange('github'));
          if (write.replacement) for (const [key,value] of imdbIndexRows(write.replacement)) cache.put(value,key);
          if (write.removeLegacyEpisodesFor !== undefined) cache.delete(imdbCacheKey('github','episodes',write.removeLegacyEpisodesFor));
          for (const [key,value] of write.entries ?? []) cache.put(value,key);
          githubGateChanged = saveImdbControl(meta,control,write);
          if (statisticsChanged && !write.silent) statisticsCacheChanged(tx,'scoresVersion');
          applied = true;
        } catch (error) { fail(error); }
      };
    });
    if (applied && !write.silent) {
      this.#scoresChanged('imdb',statisticsChanged);
      if (githubGateChanged) { this.#scoresChanged('mal',false); this.dispatchEvent(new Event('malpausechange')); }
      if (write.update && ('omdbPause' in write.update || 'githubPause' in write.update)) {
        this.dispatchEvent(new Event('imdbpausechange'));
      }
    }
    return applied;
  }

  /** Cached scores are available offline when this device has a configured key. */
  async #mdbListScores(tx:IDBTransaction, ids:readonly number[], signal?:AbortSignal):Promise<Pick<MdbListState,'malSource'|'entries'>> {
    const entries = new Map<number, ScoreEntry>();
    readCacheValues<ScoreEntry>(tx.objectStore('cache'),ids.map(scoreKey),(index,row)=>entries.set(ids[index],row),signal,'mdblist-scores');
    const [source] = await Promise.all([readMdbListSource(tx),finishRead(tx,signal)]);
    if (!source.configured) entries.clear();
    return {entries,malSource:source.malSource};
  }

  async mdbListDisplayState(signal?:AbortSignal) {
    this.#compatible();
    signal?.throwIfAborted();
    const tx = this.#db.transaction(['meta','settings']);
    const [source,control] = await Promise.all([readMdbListSource(tx),result(tx.objectStore('meta').get(mdbListControlKey)),finishRead(tx,signal)]);
    return {...source,generation:mdbListControl(control).generation};
  }

  async mdbListScores(ids:readonly number[], signal?:AbortSignal) {
    this.#compatible();
    signal?.throwIfAborted();
    return this.#mdbListScores(this.#db.transaction(['meta','settings','cache']),ids,signal);
  }

  async mdbListState(ids: readonly number[] = [], signal?:AbortSignal): Promise<MdbListState> {
    this.#compatible();
    signal?.throwIfAborted();
    const tx = this.#db.transaction(['meta','settings','cache','local']);
    this.#checkProviderBinding(tx,()=>{});
    const meta = tx.objectStore('meta');
    const [control,revision,scores] = await Promise.all([result(meta.get(mdbListControlKey)),
      result(meta.get('revision')),this.#mdbListScores(tx,ids,signal)]);
    return {...mdbListControl(control), key:this.#providerValue('mdblist_key'), revision:revision ?? 0n, ...scores};
  }

  async writeMdbList(generation: bigint, patch: MdbListWrite, hash?: string, current?:()=>boolean): Promise<boolean> {
    this.#requireWriter();
    if (hash) hash = await this.providerContentTag(hash);
    const write = structuredClone(patch);
    let applied = false, statisticsChanged = Boolean(write.entries?.size);
    // The service refreshes one show at a time. Compare in the same transaction as
    // the write, since a personal rating or its previous critic scores can change.
    const single = write.entries?.size === 1 ? write.entries.entries().next().value : undefined;
    const stores = ['settings','meta','cache'];
    if (write.entries?.size) stores.push('statistics');
    if (single) stores.push('ratings');
    await this.#write(stores, tx => {
      const meta = tx.objectStore('meta');
      const rated = single && tx.objectStore('ratings').getKey(single[0]);
      const before = single && tx.objectStore('cache').get(scoreKey(single[0]));
      const request = meta.get(mdbListControlKey);
      request.onsuccess = () => {
        const control = mdbListControl(request.result);
        if (!this.#providerValue('mdblist_key') || generation !== control.generation || current && !current()) return;
        if (single && before && rated) {
          const old = (before.result as ScoreEntry|undefined)?.scores, scores = single[1].scores;
          statisticsChanged = rated.result !== undefined && (scores.tomatoes !== (old?.tomatoes ?? null) ||
            scores.metacritic !== (old?.metacritic ?? null) || scores.myanimelist !== (old?.myanimelist ?? null));
        }
        for (const [id, entry] of write.entries ?? []) tx.objectStore('cache').put(entry, scoreKey(id));
        if (write.pause !== undefined) {
          if (hash) {
            if (write.pause?.kind === 'throttled') meta.put(write.pause, quotaKey(hash));
            else meta.delete(quotaKey(hash));
          }
          control.pause = write.pause;
          meta.put(control, mdbListControlKey);
        }
        if (statisticsChanged) statisticsCacheChanged(tx,'scoresVersion');
        applied = true;
      };
    });
    if (applied) {
      this.#scoresChanged('mdblist',statisticsChanged);
      if (write.pause !== undefined) this.dispatchEvent(new Event('mdblistpausechange'));
    }
    return applied;
  }

  /** First opening enables the extra detail job on this device. Concurrent opens share one change. */
  async openStatistics(): Promise<void> {
    this.#compatible();
    if (this.#role === 'reader') return;
    await this.#setDevicePreference('statisticsOpened', true);
  }

  async selectStatisticsScope(scope: StatisticsScope): Promise<void> {
    await this.selectDisplayPreference('statisticsScope',scope);
  }

  /** Home hides marks that arrive before their watches. Test competing marks by primary key
   * so opening a Show never has to load the Library's episode records to place its menu action. */
  async isOnRecentRail(id: number, record: ShowRows | ShowRowsWithRecent, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    if (!record.tables.watched.length) return false;
    let history: SettingRow[];
    if ('recentSettings' in record) history = record.recentSettings.length ? record.recentSettings : legacyRecentRows(record.recentlyMarked);
    else {
      const tx = this.#db.transaction(['settings','local','meta']);
      const [shared,legacy,revision] = await Promise.all([
        result<SettingRow[]>(tx.objectStore('settings').getAll(IDBKeyRange.bound(recentPrefix,recentPrefix+'\uffff'))),
        result(tx.objectStore('local').get('recentlyMarked')),result(tx.objectStore('meta').get('revision')),finishRead(tx,signal),
      ]);
      if ((revision ?? 0n) !== record.revision) throw new StaleSnapshotError();
      history = shared.length ? shared : legacyRecentRows(legacy);
    }
    const sources = [...recentSources(history)];
    let rank = 0n;
    for (const entry of sources) {
      if (entry.id === id && entry.rank > rank && hasRecentWatch(entry.scope,record.tables.watched)) rank = entry.rank;
    }
    if (!rank) return false;
    const ahead = sources.filter(entry => entry.id !== id && (entry.rank > rank || entry.rank === rank && entry.id < id));
    if (new Set(ahead.map(entry => entry.id)).size < recentLimit) return true;
    const watched = this.#db.transaction('watched').objectStore('watched'), seen = new Set<number>();
    for (const {id:other,scope} of ahead) {
      // Release the read transaction after its current request if the menu is no longer open.
      signal?.throwIfAborted();
      if (seen.has(other)) continue;
      const lower = scope ? [other,scope.season,scope.first] : [other];
      const upper = scope ? [other,scope.season,scope.last || []] : [other,[]];
      if (await result(watched.getKey(IDBKeyRange.bound(lower,upper))) !== undefined) seen.add(other);
      if (seen.size >= recentLimit) return false;
    }
    return true;
  }

  async dismissRecentMark(id: number, current: () => boolean = () => true): Promise<void> {
    this.#requireWriter();
    let submitted: (RatingRecordIdentity & {changed?: bigint; rank?: bigint; displaced:boolean}) | undefined;
    while (current()) {
      const tx = this.#db.transaction(['watched','settings','local','meta']);
      const local = tx.objectStore('local');
      const [watched,shared,legacy,displaced,owner,revision] = await Promise.all([
        result<RecordTables['watched']>(tx.objectStore('watched').getAll(IDBKeyRange.bound([id],[id,[]]))),
        result<SettingRow[]>(tx.objectStore('settings').getAll(IDBKeyRange.bound(recentPrefix,recentPrefix+'\uffff'))),
        result(local.get('recentlyMarked')),result(local.get('displacedRecentMark')),readRecordIdentity(tx),
        result<bigint|undefined>(tx.objectStore('meta').get('revision')),done(tx),
      ]);
      // Other shows' settings may have arrived before their watched.csv rows.
      // Check this show's own mark without applying the Home cutoff to unfinished downloads.
      const history = shared.length ? shared : legacyRecentRows(legacy);
      const entries = recentEntries(history,shared.length ? watched : undefined), entry = entries.get(id);
      const legacyOrder = shared.length ? [] : orderedRecents(entries);
      const visible = shared.length ? entry?.rank : legacyOrder.includes(id);
      if ((!visible && displaced !== id) || !current()) return;
      // A retry may outlive a device erase, account replacement or a new mark on the same show.
      if (submitted && (owner.account !== submitted.account || owner.erased !== submitted.erased ||
        entry?.changed !== submitted.changed || entry?.rank !== submitted.rank || (displaced === id) !== submitted.displaced)) return;
      submitted ??= {...owner,changed:entry?.changed,rank:entry?.rank,displaced:displaced === id};
      const rows = shared.length ? [] : legacyRecentRows(legacyOrder).filter(row => recentId(row.setting) !== id);
      const change = nextRecentChange(entries);
      try {
        await this.commit(revision ?? 0n, {put:{settings:[...rows,recentRow(id,change,0)]},
          removeLocal:displaced === id ? ['displacedRecentMark','recentlyMarked'] : ['recentlyMarked']},{current});
        return;
      } catch (error) { if (!(error instanceof StaleSnapshotError)) throw error; }
    }
  }

  async #migrateRecentHistory(): Promise<void> {
    const migrated: string[] = [];
    await this.#write(['local','settings','watched','meta'], tx => {
      const local = tx.objectStore('local'), settings = tx.objectStore('settings'), meta = tx.objectStore('meta');
      const legacy = local.get('recentlyMarked');
      legacy.onsuccess = () => {
        if (legacy.result === undefined) return;
        for (const row of legacyRecentRows(legacy.result)) {
          const id = recentId(row.setting)!;
          const existing = settings.getKey(row.setting);
          const watch = tx.objectStore('watched').getKey(IDBKeyRange.bound([id],[id,[]]));
          watch.onsuccess = () => {
            if (existing.result === undefined && watch.result !== undefined) {
              settings.put(row);
              migrated.push(row.setting);
            }
          };
        }
        const revision = meta.get('revision');
        revision.onsuccess = () => {
          local.delete('recentlyMarked');
          local.delete('displacedRecentMark');
          meta.put((revision.result ?? 0n) + 1n,'revision');
          if (migrated.length) meta.put(true,'dropboxDirty');
        };
      };
    });
    if (migrated.length) this.#changed({tables:['settings'],settings:migrated,localKeys:[],onlyDescriptions:false});
  }

  async #setDevicePreference(key: 'statisticsOpened', value: true): Promise<void> {
    let nextRevision: bigint | undefined;
    await this.#write(['local','meta','statistics'], (tx, fail) => {
      const local = tx.objectStore('local');
      const previous = local.get(key);
      const meta = tx.objectStore('meta');
      const revision = meta.get('revision');
      revision.onsuccess = () => {
        try {
          if (previous.result === value) return;
          local.put(value, key);
          statisticsField(tx,'opened',value);
          nextRevision = (revision.result ?? 0n) + 1n;
          meta.put(nextRevision,'revision');
        } catch (error) { fail(error); }
      };
    });
    if (nextRevision !== undefined) {
      this.#changed({ tables: [], localKeys: [key], settings: [], onlyDescriptions: false, statisticsUnchangedAt:nextRevision });
    }
  }

  /** Serialize registration changes with incoming OAuth callbacks, including those in reader tabs. */
  async saveDropboxRegistration(save: () => boolean): Promise<boolean> {
    this.#requireWriter();
    let saved = false;
    await this.#write(['local'], (tx, fail) => {
      const local = tx.objectStore('local'), pinned = local.get('syncAppKey'), session = local.get('dropboxSession');
      session.onsuccess = () => {
        if (session.result || pinned.result || this.role !== 'writer') return;
        try { saved = save(); } catch (error) { fail(error); }
      };
    });
    return saved;
  }

  async startDropboxAttempt(id: string): Promise<bigint> {
    this.#requireWriter();
    let erased = 0n;
    await this.#write(['meta'], (tx,fail) => {
      const meta = tx.objectStore('meta'), revision = meta.get('deviceEraseRevision');
      revision.onsuccess = () => {
        if (this.role !== 'writer') return fail(new StaleSnapshotError());
        erased = revision.result ?? 0n;
        meta.put(id,'dropboxSignInAttempt');
      };
    });
    return erased;
  }

  /** Only a nonsecret attempt ID is shared across tabs. The verifier and code stay in the originating tab. */
  async dropboxAttemptFence(): Promise<{erased:bigint; attempt:string|null}> {
    this.#compatible();
    const tx = this.#db.transaction('meta'), meta = tx.objectStore('meta');
    const [erased,attempt] = await Promise.all([result<bigint|undefined>(meta.get('deviceEraseRevision')),
      result<string|undefined>(meta.get('dropboxSignInAttempt')),done(tx)]);
    return {erased:erased ?? 0n, attempt:attempt ?? null};
  }

  /** A duplicated tab can inherit a verified return. Claim its one-use code before contacting Dropbox. */
  async claimDropboxAttempt(id:string|null, erased:string, current:()=>boolean): Promise<{id:string; erased:bigint}|'completed'|'replaced'|null> {
    const claim = 'submitted:'+(id ?? 'legacy');
    let admitted:{id:string; erased:bigint}|'completed'|'replaced'|null = null;
    await this.#write(['meta'],(tx,fail) => {
      const meta = tx.objectStore('meta'), generation = meta.get('deviceEraseRevision'), attempt = meta.get('dropboxSignInAttempt');
      attempt.onsuccess = () => {
        try {
          const observed:bigint = generation.result ?? 0n, waiting = attempt.result ?? null;
          if (!current() || String(observed) !== erased) return fail(new StaleSnapshotError());
          if (waiting === claim) return;
          if (waiting === 'consumed') {
            const session = tx.objectStore('local').get('dropboxSession');
            session.onsuccess = () => {
              const grant:ExchangedSession|undefined = session.result;
              if (!grant) return fail(new StaleSnapshotError());
              admitted = id && grant.completedAttempt === id ? 'completed' : 'replaced';
            };
            return;
          }
          if (waiting !== id) return fail(new StaleSnapshotError());
          meta.put(claim,'dropboxSignInAttempt');
          admitted = {id:claim,erased:observed};
        } catch (error) { fail(error); }
      };
    });
    return admitted;
  }

  /** Only the compatible tab which completed the OAuth exchange may use this reader exception. */
  async storeExchangedSession(session: ExchangedSession & {appKey:string}, current?: () => boolean, eraseGeneration?: bigint, attemptId: string|null = null): Promise<void> {
    const credentials = structuredClone(session);
    await this.#write(['meta','local','statistics'], (tx, fail) => {
      const local = tx.objectStore('local');
      const meta = tx.objectStore('meta'), erased = meta.get('deviceEraseRevision');
      const attempt = eraseGeneration !== undefined ? meta.get('dropboxSignInAttempt') : undefined;
      const registration = local.get('syncAppKey'), binding = local.get('syncAccountId');
      binding.onsuccess = () => {
        try {
          if ((current && !current()) || (eraseGeneration !== undefined && (erased.result ?? 0n) !== eraseGeneration) ||
              (attempt && (attempt.result ?? null) !== attemptId) ||
              (registration.result && registration.result !== credentials.appKey)) {
            return fail(new StaleSnapshotError());
          }
          if (binding.result == null) {
            meta.delete(visitStoreKey);
            meta.delete(visitSealKey);
            local.put(credentials.accountId, 'syncAccountId');
            if (credentials.appKey) local.put(credentials.appKey, 'syncAppKey');
          }
          local.put(credentials, 'dropboxSession');
          if (attempt) meta.put('consumed','dropboxSignInAttempt');
        } catch (error) { fail(error); }
      };
      const revision = meta.get('revision');
      revision.onsuccess = () => {
        try { statisticsRevision(tx,(revision.result ?? 0n) + 1n); } catch (error) { fail(error); }
      };
    });
    this.#dropboxChanged();
  }

  #dropboxChanged(): void {
    this.#exportRecords = new WeakMap();
    this.dispatchEvent(new Event('dropboxchange'));
    this.#exportUpdates?.postMessage('dropbox');
  }

  #statusChanged(): void {
    this.#exportUpdates?.postMessage('dropbox-status');
  }

  /** Read session identity and sync status for screens and record operations. */
  dropboxState(fields:'registration'): Promise<Pick<DropboxRequestState,'accountId'|'recordAppKey'>>;
  dropboxState(): Promise<DropboxDeviceState>;
  async dropboxState(fields?:'registration') {
    if (fields === 'registration') {
      this.#compatible();
      const tx = this.#db.transaction('local');
      const [registration] = await Promise.all([readDropboxRegistration(tx.objectStore('local')),done(tx)]);
      return registration;
    }
    const state = await this.dropboxAuthState();
    return {...state, grantAppKey:state.session?.appKey, session:state.session && dropboxSessionInfo(state.session)};
  }

  /** Only revision identifiers and their original paths are needed to verify an older link. */
  async dropboxRegistrationEvidence() {
    this.#compatible();
    const tx = this.#db.transaction(['meta','sync']), sync = tx.objectStore('sync');
    const [revision,files] = await Promise.all([result<bigint|undefined>(tx.objectStore('meta').get('revision')),
      Promise.all((['watched','ratings','lists','settings'] as const).map(async table => {
        const file = await result<FileSyncState|undefined>(sync.get(table));
        return {path:'/' + table + '.csv', revisions:[file?.base?.revision,file?.pending?.targetRevision].filter(
          (rev):rev is string => typeof rev === 'string' && !!rev)};
      })), done(tx)]);
    return {revision:revision ?? 0n,files:files.filter(file=>file.revisions.length)};
  }

  /** Credential access for the OAuth transport, including revocation of legacy grants. */
  dropboxAuthState(quotaAccount?: string): Promise<DropboxStoredState>;
  dropboxAuthState(quotaAccount: string | undefined, fields: 'request'): Promise<DropboxRequestState>;
  async dropboxAuthState(quotaAccount?: string, fields?: 'request'): Promise<DropboxRequestState | DropboxStoredState> {
    this.#compatible();
    const tx = this.#db.transaction(fields === 'request' && !quotaAccount ? 'local' : ['meta','local']);
    const local = tx.objectStore('local');
    const registration = readDropboxRegistration(local);
    const grant = result<ExchangedSession | undefined>(local.get('dropboxSession'));
    const quota = quotaAccount ? result<DropboxCooldown | undefined>(tx.objectStore('meta').get(['dropboxCooldown',quotaAccount])) : null;
    const meta = fields === 'request' ? null : tx.objectStore('meta');
    const summary = meta && Promise.all([result<bigint | undefined>(meta.get('revision')),
      result<DropboxSyncStatus | undefined>(meta.get('dropboxStatus')), result(meta.get('dropboxDirty'))]);
    const [identity,session,cooldown,overview] = await Promise.all([registration,grant,quota,summary,done(tx)]);
    const binding = {...identity,session:session ?? null,cooldown:cooldown ?? null};
    if (!overview) return binding;
    const [revision,status,dirty] = overview;
    return {...binding,revision:revision ?? 0n,status:status ?? null,dirty:!!dirty};
  }

  /** Renew transport credentials without invalidating a review of the unchanged watch record. */
  async saveDropboxRenewal(expected:ExchangedSession, accessToken:string, accessExpiresAt:number, erased:bigint,
      current:()=>boolean):Promise<boolean> {
    this.#requireWriter();
    let accepted = false;
    await this.#write(['meta','local'], tx => {
      const local = tx.objectStore('local'), generation = tx.objectStore('meta').get('deviceEraseRevision');
      const owner = local.get('syncAccountId'), saved = local.get('dropboxSession');
      saved.onsuccess = () => {
        const grant:ExchangedSession|undefined = saved.result;
        if (!current() || this.#role !== 'writer' || (generation.result ?? 0n) !== erased || owner.result !== expected.accountId ||
            !grant || grant.accountId !== expected.accountId || grant.instanceId !== expected.instanceId ||
            grant.refreshToken !== expected.refreshToken || grant.appKey !== expected.appKey ||
            effectiveDropboxDeadline(grant) !== effectiveDropboxDeadline(expected)) return;
        accepted = true;
        // A later successful renewal for this same grant wins, including when the provider reused its token string.
        if (grant.accessToken === expected.accessToken && grant.accessExpiresAt === expected.accessExpiresAt)
          local.put({...grant,accessToken,accessExpiresAt},'dropboxSession');
      };
    });
    return accepted;
  }

  async saveDropboxCooldown(binding: {accountId:string; instanceId:string}, value: DropboxCooldown | null,
      current: () => boolean, revoking: boolean): Promise<void> {
    this.#requireWriter();
    await this.#write(['meta', 'local'], (tx, fail) => {
      const local = tx.objectStore('local'), meta = tx.objectStore('meta');
      const owner = local.get('syncAccountId'), session = local.get('dropboxSession');
      session.onsuccess = () => {
        const active = session.result as ExchangedSession | undefined;
        // A detached revocation may complete after expiry removed its session, but cannot change a newer grant's gate.
        if (!current() || (active ? active.instanceId !== binding.instanceId || active.accountId !== binding.accountId : !revoking) ||
            ((!active || !revoking) && owner.result !== binding.accountId)) return fail(new StaleSnapshotError());
        const key = ['dropboxCooldown', binding.accountId];
        if (value) meta.put(value, key);
        else meta.delete(key);
      };
    });
  }

  /** Store an operation result only for the session that produced it. This is bookkeeping, not a record edit. */
  async saveDropboxStatus(status: DropboxSyncStatus, current: () => boolean): Promise<void> {
    this.#requireWriter();
    const value = structuredClone(status);
    await this.#write(['meta', 'local'], (tx, fail) => {
      const local = tx.objectStore('local'), meta = tx.objectStore('meta');
      const owner = local.get('syncAccountId'), session = local.get('dropboxSession');
      session.onsuccess = () => {
        const s = session.result as ExchangedSession | undefined;
        if (owner.result !== value.accountId || s?.accountId !== value.accountId ||
            s.instanceId !== value.instanceId || !current()) return fail(new StaleSnapshotError());
        meta.put(value, 'dropboxStatus');
        meta.put(false, 'dropboxDirty');
      };
    });
    this.#statusChanged();
  }

  /** Keep both generation counters monotonic so pending provider replies cannot repopulate an erased device. */
  async eraseDevice(expectedRevision: bigint, current?: () => boolean): Promise<void> {
    this.#requireWriter();
    const freshTagKey = await crypto.subtle.generateKey({name:'HMAC',hash:'SHA-256'},false,['sign']);
    await this.#write(Array.from(this.#db.objectStoreNames), (tx, fail) => {
      const meta = tx.objectStore('meta');
      const revision = meta.get('revision');
      const scores = meta.get(mdbListControlKey);
      const imdb = meta.get(imdbControlKey);
      const mal = meta.get(malControlKey);
      const control = meta.get(tmdbControlKey);
      control.onsuccess = () => {
        if ((revision.result ?? 0n) !== expectedRevision || (current && !current())) return fail(new StaleSnapshotError());
        const previous = controlValue(control.result);
        for (const name of Array.from(tx.objectStoreNames)) tx.objectStore(name).clear();
        meta.put(freshTagKey,'providerTagKey');
        statisticsRevision(tx,expectedRevision + 1n);
        statisticsField(tx,'scope',null);
        statisticsField(tx,'legacyScope',null);
        statisticsField(tx,'opened',false);
        meta.put(expectedRevision + 1n, 'deviceEraseRevision');
        meta.put({epoch:expectedRevision + 1n,until:0},mappingGateKey);
        meta.put({ generation: mdbListControl(scores.result).generation + 1n, pause: null }, mdbListControlKey);
        const imdbBefore = defaultImdbControl(imdb.result);
        meta.put({...malControl(),generation:malControl(mal.result).generation+1n},malControlKey);
        meta.put({...defaultImdbControl(), generation:imdbBefore.generation + 1n,
          configGeneration:imdbBefore.configGeneration + 1n,githubGeneration:imdbBefore.githubGeneration+1n}, imdbControlKey);
        meta.put({ generation: previous.generation + 1n, submission: previous.submission + 1n, credential:null, refused:null }, tmdbControlKey);
      };
    });
    this.clearProviderKeys();
    this.#tagKey = freshTagKey;
    this.#librarySort.clear();
    this.dispatchEvent(new Event('deviceerased'));
    this.#exportUpdates?.postMessage('deviceerased');
    this.#providerHashes = {};
    this.#exportUpdates?.postMessage('provider-presence');
    this.#dropboxChanged();
    this.#exportChanged();
    this.#exportUpdates?.postMessage('tmdbstate');
    this.#scoresChanged('mdblist');
    this.#ratingConfigChanged('imdbconfigchange');
    this.#scoresChanged('imdb');
    this.#ratingConfigChanged('malconfigchange');
    this.#scoresChanged('mal');
    this.#changed({ tables: [...tables], settings:'all', localKeys:['statisticsScope'], onlyDescriptions:false, syncWrite:true });
    this.dispatchEvent(new Event('cachechange'));
  }

  async mappingGate():Promise<MappingGate> {
    this.#compatible();
    const tx = this.#db.transaction('meta');
    const [gate] = await Promise.all([result(tx.objectStore('meta').get(mappingGateKey)),done(tx)]);
    return gate ?? {epoch:0n,until:0};
  }

  /** File-host limits are anonymous and survive key changes. An erasure retires any pending replies. */
  async saveMappingGate(epoch:bigint, until:number):Promise<void> {
    this.#requireWriter();
    await this.#write(['meta'],tx=>{
      const meta = tx.objectStore('meta'), previous = meta.get(mappingGateKey);
      previous.onsuccess = () => {
        if ((previous.result?.epoch ?? 0n) === epoch) meta.put({epoch,until},mappingGateKey);
      };
    });
  }

  async cacheValue(key: string): Promise<unknown> {
    this.#compatible();
    const tx = this.#db.transaction('cache');
    const [value] = await Promise.all([result(tx.objectStore('cache').get(key)), done(tx)]);
    return value;
  }

  async cache(key: string, value: unknown): Promise<void> {
    this.#requireWriter();
    await this.#write(['cache'], tx => { tx.objectStore('cache').put(value, key); });
  }

  async clearRebuildableCaches(): Promise<void> {
    this.#requireWriter();
    this.#providerCacheGeneration++;
    await this.#write(['cache', 'tmdb', 'meta','statistics'], tx => {
      statisticsCacheChanged(tx,'metadataVersion');
      statisticsCacheChanged(tx,'scoresVersion');
      tx.objectStore('cache').clear();
      tx.objectStore('tmdb').clear();
      tx.objectStore('meta').put(true, 'dropboxDirty');
      const meta = tx.objectStore('meta');
      meta.delete(githubInstallationKey('mal'));
      meta.delete(githubInstallationKey('imdb'));
      const mal = meta.get(malControlKey);
      mal.onsuccess = () => meta.put({...malControl(),generation:malControl(mal.result).generation+1n},malControlKey);
      const request = meta.get(imdbControlKey);
      request.onsuccess = () => {
        const previous = defaultImdbControl(request.result);
        meta.put({...previous, generation:previous.generation + 1n, configGeneration:previous.configGeneration + 1n,
          githubGeneration:previous.githubGeneration+1n,file:null, fileError:null, needsFile:true}, imdbControlKey);
      };
    });
    this.#statusChanged();
    this.#exportChanged();
    this.#scoresChanged('mdblist');
    this.dispatchEvent(new Event('cachechange'));
    this.#ratingConfigChanged('imdbconfigchange');
    this.#scoresChanged('imdb');
    this.#ratingConfigChanged('malconfigchange');
    this.#scoresChanged('mal');
  }

  async #prepareTmdb(): Promise<void> {
    const tx = this.#db.transaction('meta'), meta = tx.objectStore('meta');
    const [hashes,key] = await Promise.all([result(meta.get('providerHashes')),result(meta.get('providerTagKey')),done(tx)]);
    this.#providerHashes = hashes ?? {};
    this.#tagKey = key ?? await crypto.subtle.generateKey({name:'HMAC',hash:'SHA-256'},false,['sign']);
    if (!key) {
      const before = this.#db.transaction(['meta','tmdbGates','settings']);
      const [tmdb,quotas,control,legacy] = await Promise.all([result(before.objectStore('tmdbGates').getAllKeys()),
        result(before.objectStore('meta').getAllKeys()),result(before.objectStore('meta').get(tmdbControlKey)),
        result<SettingRow[]>(before.objectStore('settings').getAll()),done(before)]);
      for (const row of legacy) if (isProviderKey(row.setting)) this.#providerHashes[row.setting] = await this.#providerHash(row.value);
      const gates = tmdb.filter((k):k is string=>typeof k === 'string');
      const oldQuotas = quotas.filter((k):k is string[]=>Array.isArray(k) && (k[0] === 'imdb-quota' || k[0] === 'mdblist-quota'));
      const names = new Set([...gates,...oldQuotas.map(k=>k[k.length-1]),control?.credential].filter((s):s is string=>!!s));
      const tags = new Map(await Promise.all(Array.from(names,async s=>[s,await this.providerContentTag(s)] as const)));
      await this.#write(['meta','tmdbGates'], write=>{
        const meta = write.objectStore('meta');
        meta.put(this.#tagKey,'providerTagKey');
        meta.put(this.#providerHashes,'providerHashes');
        const move = (store:IDBObjectStore, old:IDBValidKey, next:IDBValidKey) => {
          const read = store.get(old);
          read.onsuccess = () => { store.put(read.result,next); store.delete(old); };
        };
        for (const old of gates) move(write.objectStore('tmdbGates'),old,tags.get(old)!);
        for (const old of oldQuotas) move(meta,old,[...old.slice(0,-1),tags.get(old[old.length-1])!]);
        if (control?.credential) meta.put({...control,credential:tags.get(control.credential)},tmdbControlKey);
      });
    }
    // Each cache read checks expiry. A failed background purge can be retried
    // without blocking access to the user's watch record.
    try { await this.#sweepTmdb(Date.now()); }
    catch { this.#scheduleExpiry(Date.now() + 60_000); }
  }

  /** A retained page can validate its record after a slow cache read without reopening credentials. */
  async currentTmdbGeneration(generation:bigint):Promise<boolean> {
    this.#compatible();
    const tx=this.#db.transaction('meta');
    const [control]=await Promise.all([result(tx.objectStore('meta').get(tmdbControlKey)),done(tx)]);
    return controlValue(control).generation===generation;
  }

  async firstUseState() {
    this.#compatible();
    const tx = this.#db.transaction('local'), local = tx.objectStore('local');
    const [firstUseDismissed,syncAccountId] = await Promise.all([
      result(local.get('firstUseDismissed')),result(local.get('syncAccountId')),done(tx),
    ]);
    return {firstUseDismissed,syncAccountId};
  }

  /** Small consistent read for an API call, independent of the size of the record. */
  async tmdbState(fields: 'access'): Promise<Omit<TmdbState,'cooldown'>>;
  async tmdbState(): Promise<TmdbState>;
  async tmdbState(fields?: 'access') {
    this.#compatible();
    const tx = this.#db.transaction(fields === 'access' ? ['meta','local'] : ['meta','local','tmdbGates']);
    const owner = tx.objectStore('local').get('syncAccountId');
    this.#checkProviderBinding(tx,()=>{},owner);
    let configured = false;
    const info = new Promise<Omit<TmdbState, 'token' | 'cachedMarkAccount'>>(resolve => withControl(tx, control => {
      const state = { generation: control.generation, refused: control.refused, cooldown: null };
      if (!control.credential) return resolve(state);
      configured = true;
      if (fields === 'access') return resolve(state);
      const gate = tx.objectStore('tmdbGates').get(control.credential);
      gate.onsuccess = () => resolve({ ...state, cooldown: gate.result ?? null });
    }));
    const [control,account] = await Promise.all([info,result(owner),done(tx)]);
    const access = {generation:control.generation,refused:control.refused,token:this.#providerValue('tmdb_key'),
      cachedMarkAccount:!this.providerKeysAvailable && configured && control.refused === null ? account ?? null : null};
    return fields === 'access' ? access : {...access,cooldown:control.cooldown};
  }

  /** Read the review against one committed copy of the record and provider cache. */
  async repairPreview(showId: number, now: number): Promise<RepairPreview> {
    this.#compatible();
    const tx = this.#db.transaction(['watched', 'meta', 'local', 'tmdb']);
    let plan!: RepairPreview;
    readShowEpisodes(tx,showId,now,'repair',({preview})=>{ plan = preview; });
    await done(tx);
    return plan;
  }

  /** Share the record and native season cache between the screen and its repair notice. */
  async showScreenState(id:number, scope:'show'|number, now:number, signal?:AbortSignal) {
    this.#compatible();
    signal?.throwIfAborted();
    const read = (together:boolean) => {
      const episodeStores = ['watched','meta','local','tmdb'], titleStores = ['ratings','lists','shows','settings'];
      const tx = this.#db.transaction(together ? [...episodeStores,...titleStores] : episodeStores);
      const other = together ? tx : this.#db.transaction([...titleStores,'meta']);
      const current = () => !signal?.aborted && !this.#waiting.signal.aborted;
      const episodes = new Promise<ShowEpisodeSnapshot>(receive=>readShowEpisodes(tx,id,now,scope,receive,current));
      return Promise.all([episodes,result<RecordTables['ratings']>(other.objectStore('ratings').getAll(id)),
        result<RecordTables['lists']>(other.objectStore('lists').index('show').getAll(id)),
        result<RecordTables['shows']>(other.objectStore('shows').getAll(id)),
        result<SettingRow|undefined>(other.objectStore('settings').get(seasonOrderKey(id))),
        together ? undefined : result<bigint|undefined>(other.objectStore('meta').get('revision')),
        finishRead(tx,signal,this.#waiting.signal),together ? undefined : finishRead(other,signal,this.#waiting.signal)]);
    };
    // A large season read can proceed alongside these four short record lookups.
    // If a write landed between them, reread under one native transaction.
    let data = await read(false);
    if (data[0].preview.revision !== (data[5] ?? 0n)) data = await read(true);
    const [snapshot,ratings,lists,shows,order] = data;
    const {watched,preview,seasons} = snapshot;
    const header = snapshot.header?.value && order?.value ?
      {...snapshot.header,value:{...snapshot.header.value,manualSeasonOrder:order.value}} : snapshot.header;
    const record:ShowRows = {tables:{watched,ratings,lists,shows,settings:[]},revision:preview.revision,tmdbGeneration:preview.generation};
    const info = scope==='show' && header?.value ? withSeasonDetails(header.value,
      number=>seasons.get(number)?.value,number=>{
        const entry = seasons.get(number);
        return !!entry && observation(entry).at<observation(header).at;
      }) : null;
    return {record,preview,header,info,season:typeof scope==='number' ? seasons.get(scope) ?? null : null};
  }

  /** Show edits and its menu need the shared history. Season display and metadata replies only need the record. */
  tmdbRows(showId: number, includeRecent: false): Promise<ShowRows & {tmdbKeyAccepted:boolean}>;
  tmdbRows(showId: number): Promise<ShowRowsWithRecent>;
  async tmdbRows(showId: number, includeRecent = true): Promise<(ShowRows & {tmdbKeyAccepted:boolean}) | ShowRowsWithRecent> {
    this.#compatible();
    const stores = ['watched', 'ratings', 'lists', 'shows', 'meta'];
    if (includeRecent) stores.push('settings','local');
    const tx = this.#db.transaction(stores);
    const meta = tx.objectStore('meta');
    // IDB orders a nested array above every numeric season in the compound key.
    const range = IDBKeyRange.bound([showId], [showId, []]);
    const local = includeRecent ? tx.objectStore('local') : undefined;
    const [watched, ratings, lists, shows, revision, control, recent, displaced, recentSettings] = await Promise.all([
      result(tx.objectStore('watched').getAll(range)), result(tx.objectStore('ratings').getAll(showId)),
      result(tx.objectStore('lists').index('show').getAll(showId)), result(tx.objectStore('shows').getAll(showId)),
      result(meta.get('revision')), result(meta.get(tmdbControlKey)), local && result(local.get('recentlyMarked')),
      local && result(local.get('displacedRecentMark')),
      includeRecent ? result<SettingRow[]>(tx.objectStore('settings').getAll(IDBKeyRange.bound(recentPrefix,recentPrefix + '\uffff'))) : [], done(tx),
    ]);
    const state = controlValue(control);
    const record = { tables: { watched, ratings, lists, shows, settings: [] }, revision: revision ?? 0n,tmdbGeneration:state.generation };
    if (!includeRecent) return {...record,tmdbKeyAccepted:state.credential !== null && state.refused === null};
    return { ...record, displacedRecentMark: Number.isSafeInteger(displaced) && displaced >= 0 ? displaced : undefined,
      recentSettings, recentlyMarked: orderedRecents(recentEntries(recentSettings.length ? recentSettings : legacyRecentRows(recent))) };
  }

  async tmdbEntry<T = unknown>(key: string, now = Date.now(), signal?: AbortSignal): Promise<TmdbCacheEntry<T> | undefined> {
    const [entry] = await this.tmdbEntries<T>([key], now,signal);
    return entry;
  }

  /** Refresh jobs need one reference per watched season, rated show and membership. */
  async metadataTargets() {
    this.#compatible();
    const tx = this.#db.transaction(['watched','ratings','lists','local']);
    const [positions,rated,lists,opened] = await Promise.all([
      result(tx.objectStore('watched').getAllKeys()), result(tx.objectStore('ratings').getAllKeys()),
      result<ListRow[]>(tx.objectStore('lists').getAll()), result(tx.objectStore('local').get('statisticsOpened')), done(tx),
    ]);
    const watched: {show_id:number; season:number}[] = [];
    // The compound primary key orders each show's episodes together by season.
    for (const key of positions) {
      const [show_id,season] = key as number[];
      const prior = watched.at(-1);
      if (prior?.show_id !== show_id || prior.season !== season) watched.push({show_id,season});
    }
    return {tables:{watched,ratings:rated.map(id=>({show_id:id as number})),lists},statisticsOpened:opened === true};
  }

  /** Initial import review needs the matched watches, global list spellings and the sign-in that owns them. */
  async importPreviewSnapshot(ids:readonly number[], signal?:AbortSignal):Promise<ImportPreviewSnapshot> {
    this.#compatible();
    signal?.throwIfAborted();
    const tx = this.#db.transaction(ids.length ? [...overviewStores,'local'] : ['local']), local = tx.objectStore('local');
    const record = ids.length ? readOverviewRows(tx,ids) : {watched:[],ratings:[],lists:[],shows:[]};
    const [tables,account,session] = await Promise.all([record,
      result<string|undefined>(local.get('syncAccountId')),result<ExchangedSession|undefined>(local.get('dropboxSession')),finishRead(tx,signal)]);
    return {tables,local:{syncAccountId:account,dropboxSession:session && {instanceId:session.instanceId}}};
  }

  /** Read the four public record tables together without loading settings or sync files. */
  async overviewRows(withRevision: true, signal?: AbortSignal): Promise<Omit<RecordTables,'settings'> & {revision:bigint}>;
  async overviewRows(withRevision: 'statistics', signal?: AbortSignal): Promise<Omit<RecordTables,'settings'> & {revision:bigint}>;
  async overviewRows(withRevision: 'ratings', signal?: AbortSignal): Promise<Omit<RecordTables,'settings'> & {record:RatingRecordIdentity}>;
  async overviewRows(withRevision?: false, signal?: AbortSignal, creditedIds?: readonly number[]): Promise<Omit<RecordTables,'settings'>>;
  async overviewRows(withRevision: boolean | 'statistics' | 'ratings' = false, signal?: AbortSignal, creditedIds?: readonly number[]) {
    this.#compatible();
    signal?.throwIfAborted();
    if (withRevision === 'ratings') {
      const tx = this.#db.transaction([...overviewStores,'local','meta']);
      const [tables,record] = await Promise.all([readRatingsOverview(tx,signal),readRecordIdentity(tx),finishRead(tx,signal)]);
      return {...tables,record};
    }
    const statistics = withRevision === 'statistics' && this.#db.objectStoreNames.contains('statistics');
    const tx = this.#db.transaction(withRevision ? [...overviewStores,statistics ? 'statistics' : 'meta'] : overviewStores);
    const version = statistics
      ? result<{value:bigint}|undefined>(tx.objectStore('statistics').get('revision')).then(row=>row?.value)
      : withRevision ? result<bigint|undefined>(tx.objectStore('meta').get('revision')) : undefined;
    const [tables,revision] = await Promise.all([readOverviewRows(tx,creditedIds),
      version,finishRead(tx,signal)]);
    if (statistics && typeof revision !== 'bigint') return this.overviewRows(true,signal);
    return withRevision ? {...tables,revision:revision ?? 0n} : tables;
  }

  /** Compare independently admitted reads without making watch tables wait for a settings writer. */
  async recordRevision(signal?:AbortSignal) {
    this.#compatible();
    signal?.throwIfAborted();
    const tx = this.#db.transaction('meta');
    const [revision] = await Promise.all([result<bigint|undefined>(tx.objectStore('meta').get('revision')),finishRead(tx,signal)]);
    return revision ?? 0n;
  }

  /** At sign-in, one key per table is enough to decide whether to offer a legacy export. */
  async hasRecordRows(): Promise<boolean> {
    this.#compatible();
    const tx = this.#db.transaction(overviewStores);
    const [keys] = await Promise.all([
      Promise.all(overviewStores.map(table => result(tx.objectStore(table).getAllKeys(undefined,1)))),
      done(tx),
    ]);
    return keys.some(page => page.length > 0);
  }

  async ratingRows(): Promise<RecordTables['ratings']> {
    this.#compatible();
    const tx = this.#db.transaction('ratings');
    const [rows] = await Promise.all([result<RecordTables['ratings']>(tx.objectStore('ratings').getAll()),done(tx)]);
    return rows;
  }

  /** Capture the edited score and its record identity in the same committed read. */
  async ratingState(id: number) {
    this.#compatible();
    const tx = this.#db.transaction(['ratings','local','meta']), meta = tx.objectStore('meta');
    const [rating,record,revision] = await Promise.all([
      result<TableRows['ratings']|undefined>(tx.objectStore('ratings').get(id)),
      readRecordIdentity(tx),result<bigint|undefined>(meta.get('revision')),done(tx),
    ]);
    return {rating:rating ?? null,...record,revision:revision ?? 0n};
  }

  /** Read just the visible shows' watches and membership keys from the same committed record. */
  async searchRecords(ids: readonly number[], signal?: AbortSignal) {
    this.#compatible();
    signal?.throwIfAborted();
    if (!ids.length) return [];
    const tx = this.#db.transaction(['watched','lists']);
    const watches = tx.objectStore('watched');
    const wanted = new Set(ids), sorted = [...wanted].sort((a,b)=>a-b);
    const first = sorted[0], last = sorted[sorted.length-1];
    const range = (low:number, high:number) => IDBKeyRange.bound([low],[high,[]]);
    const read = (low:number, high:number) => result<RecordTables['watched']>(watches.getAll(range(low,high)));
    // Most search results have no history. Inspect a bounded page of keys so a
    // whole stretch of unrecorded titles costs one request. Only read episode
    // values from runs known to consist entirely of the selected shows.
    async function matchingWatches() {
      if (first === last) return [await read(first,last)];
      const limit = 256;
      const keys = await result(watches.getAllKeys(range(first,last),limit));
      signal?.throwIfAborted();
      const batches: Promise<RecordTables['watched']>[] = [];
      let start: number | undefined, end = first;
      for (const key of keys) {
        const id = (key as number[])[0];
        if (wanted.has(id)) { start ??= id; end = id; }
        else if (start !== undefined) { batches.push(read(start,end)); start = undefined; }
      }
      if (start !== undefined) batches.push(read(start,end));
      if (keys.length === limit) {
        const through = (keys[limit-1] as number[])[0];
        for (const id of sorted) if (id > through) batches.push(read(id,id));
      }
      return Promise.all(batches);
    }
    const [batches, dropped] = await Promise.all([matchingWatches(),
      result(tx.objectStore('lists').getAllKeys(IDBKeyRange.bound([droppedList,first],[droppedList,last]))),
      finishRead(tx,signal)]);
    const droppedIds = new Set(dropped.map(key => (key as [string,number])[1]));
    const grouped = new Map<number,RecordTables['watched']>();
    for (const batch of batches) for (const row of batch) {
      const group = grouped.get(row.show_id);
      if (group) group.push(row); else grouped.set(row.show_id,[row]);
    }
    return ids.map(id => ({watched:grouped.get(id) ?? [],dropped:droppedIds.has(id)}));
  }

  /** Home needs committed watches and recency in the same read, plus a few first-use flags. */
  async homeRecord(signal?: AbortSignal) {
    this.#compatible();
    signal?.throwIfAborted();
    const tx = this.#db.transaction([...overviewStores,'settings','local']);
    const local = tx.objectStore('local');
    const [tables,shared,legacy,firstUseDismissed,syncAccountId,sessionKey] = await Promise.all([
      readOverviewRows(tx),result<SettingRow[]>(tx.objectStore('settings').getAll(IDBKeyRange.bound(recentPrefix,recentPrefix+'\uffff'))),
      result(local.get('recentlyMarked')),result(local.get('firstUseDismissed')),result(local.get('syncAccountId')),
      result(local.getKey('dropboxSession')),finishRead(tx,signal),
    ]);
    const entries = recentEntries(shared,tables.watched);
    const recentlyMarked: number[] = entries.size ? orderedRecents(entries) : Array.isArray(legacy) ? legacy : [];
    return {tables,local:{recentlyMarked,firstUseDismissed,syncAccountId,dropboxSession:sessionKey !== undefined}};
  }

  /** Read a page's metadata entries in one transaction at one retention cutoff. */
  async tmdbEntries<T>(keys: string[], now = Date.now(), signal?: AbortSignal, options: {seasonOrders?:boolean} = {}): Promise<(TmdbCacheEntry<T> | undefined)[]> {
    this.#compatible();
    signal?.throwIfAborted();
    if (!keys.length) return [];
    const hasShows = options.seasonOrders !== false && keys.some(key => /^tv\/\d+(?:\?|$)/.test(key));
    const tx = this.#db.transaction(hasShows ? ['tmdb','settings'] : ['tmdb']);
    const entries = readTmdbEntries<T>(tx.objectStore('tmdb'),keys,signal);
    const [orders] = await Promise.all([hasShows ? this.#seasonOrders(tx,keys) : undefined,finishRead(tx,signal)]);
    return keys.map(key => {
      const entry = retainedEntry(entries.get(key),now);
      if (!entry) return undefined;
      const order = orders?.get(key);
      return {value:entry.value && order ? {...entry.value,manualSeasonOrder:order} : entry.value, fetchedAt:entry.fetchedAt,
        ...(entry.vacatedPositions && {vacatedPositions:entry.vacatedPositions}),
        ...(entry.repairScan && {repairScan:entry.repairScan})};
    });
  }

  async #seasonOrders(tx: IDBTransaction, keys?: string[]) {
    const settings = tx.objectStore('settings');
    if (keys?.length === 1) {
      const id = Number(/^tv\/(\d+)/.exec(keys[0])![1]);
      const row = await result<SettingRow|undefined>(settings.get(seasonOrderKey(id)));
      return new Map(row ? [[keys[0],row.value]] : []);
    }
    const rows = await result<SettingRow[]>(settings.getAll(IDBKeyRange.bound(seasonOrderPrefix,seasonOrderPrefix+'\uffff')));
    return exportSeasonOrders(rows);
  }

  async seasonOrderState(id: number) {
    this.#compatible();
    const tx = this.#db.transaction(['settings','local','meta']);
    const [row,accountId,revision] = await Promise.all([
      result<SettingRow|undefined>(tx.objectStore('settings').get(seasonOrderKey(id))),
      result<string|undefined>(tx.objectStore('local').get('syncAccountId')),
      result<bigint|undefined>(tx.objectStore('meta').get('revision')),done(tx),
    ]);
    return {value:row?.value,accountId,revision:revision ?? 0n};
  }

  async #readSlowExport(prior:PublicationRecord,now:number,includeSeasons:boolean,includeExternalIds:boolean,signal?:AbortSignal) {
    const keys = exportMetadataKeys(prior.tables,includeSeasons,includeExternalIds);
    if (keys.shows.size < 64) return;
    let changed = false;
    const invalidate = () => { changed = true; };
    this.addEventListener('exportchange',invalidate);
    this.addEventListener('dropboxchange',invalidate);
    try {
      const reader = await import('./export-metadata-reader.ts').catch(() => undefined);
      if (!reader || changed) return;
      const rows = await reader.readExportMetadata({database:this.#db.name,version:this.#db.version,
        revision:prior.revision,erased:prior.erased,keys:[...keys.shows.values(),...keys.external.values(),...keys.seasons]},
      this.#waiting.signal,signal);
      if (!rows || changed) return;
      // The worker only reads public metadata at the pinned revision. Check the actual
      // grant here, including a renewal, account change or erase while its reply was in flight.
      const tx = this.#db.transaction(['meta','local']);
      let matches = false;
      checkPublication(tx,tx.objectStore('meta').get('revision'),prior,() => Math.max(now,this.#providerNow()),value => { matches = value; });
      await finishRead(tx,signal,this.#waiting.signal);
      if (matches && !changed) return projectExportMetadata(prior.tables,prior.revision,now,includeSeasons,keys,
        rows.entries,rows.entries,exportSeasonOrders(rows.orders));
    } finally {
      this.removeEventListener('exportchange',invalidate);
      this.removeEventListener('dropboxchange',invalidate);
    }
  }

  /** Freeze the four export tables and the cache entries they reference at the same committed revision. */
  async exportSnapshot(includeSeasons: boolean, now: number, includeExternalIds = !includeSeasons, signal?: AbortSignal,
      exportRecord?:object): Promise<ExportSnapshot> {
    this.#compatible();
    signal?.throwIfAborted();
    const prior = exportRecord && this.#exportRecords.get(exportRecord);
    if (exportRecord) this.#exportRecords.delete(exportRecord);
    if (prior && this.#slowExportMetadata && prior.tables.watched.length >= 2048 && typeof Worker !== 'undefined') {
      const fromWorker = await this.#readSlowExport(prior,now,includeSeasons,includeExternalIds,signal);
      if (fromWorker) return fromWorker;
      this.#compatible();
      signal?.throwIfAborted();
    }
    const stores = ['meta','watched','ratings','lists','shows','tmdb','settings'];
    if (prior) stores.push('local');
    const tx = this.#db.transaction(stores);
    const orders = this.#seasonOrders(tx);
    const meta = tx.objectStore('meta'), revision = meta.get('revision');
    let record!:ExportSnapshot['tables'];
    const cache = tx.objectStore('tmdb');
    // A newly linked device can have thousands of watched episodes before it
    // has any TV metadata. One bounded key probe avoids checking each title and season.
    const hasTvMetadata = prior && prior.tables.watched.length >= 2048
      ? cache.getAllKeys(IDBKeyRange.bound('tv/','tv0',false,true),1) : undefined;
    let keys:ReturnType<typeof exportMetadataKeys> = {shows:new Map(),external:new Map(),seasons:new Set()};
    let metadataStarted:number|undefined;
    let entries!: ReturnType<typeof readTmdbEntries>;
    let externalEntries: ReturnType<typeof readImdbExternalEntries> | undefined;
    const readMetadata = (rows:ExportSnapshot['tables']) => {
      record = rows;
      if (signal?.aborted) return;
      if (hasTvMetadata && !hasTvMetadata.result.length) { entries = new Map(); return; }
      keys = exportMetadataKeys(rows,includeSeasons,includeExternalIds);
      if (rows.watched.length >= 2048 && keys.shows.size >= 64) metadataStarted = performance.now();
      // Standalone IDs use different keys from indexed titles and seasons. Keep
      // both reads in this transaction so an export observes one record revision.
      entries = readTmdbEntries(cache,[...keys.shows.values(),...keys.seasons],signal);
      if (keys.external.size) externalEntries = readImdbExternalEntries(cache,[...keys.external.values()],signal);
    };
    const readRecord = () => {
      const watched = tx.objectStore('watched').getAll(), ratings = tx.objectStore('ratings').getAll();
      const lists = tx.objectStore('lists').getAll(), shows = tx.objectStore('shows').getAll();
      shows.onsuccess = () => readMetadata({watched:watched.result,ratings:ratings.result,lists:lists.result,shows:shows.result});
    };
    if (prior) {
      // Metadata and season order always come from this live transaction. Reuse
      // the four large record tables only under the same device, owner and sign-in.
      checkPublication(tx,revision,prior,() => Math.max(now,this.#providerNow()),matches => {
        if (matches) readMetadata(prior.tables); else readRecord();
      });
    } else readRecord();
    const [seasonOrders] = await Promise.all([orders,finishRead(tx,signal)]);
    if (metadataStarted !== undefined) this.#slowExportMetadata = performance.now()-metadataStarted >= 250;
    return projectExportMetadata(record,revision.result ?? 0n,now,includeSeasons,keys,entries,externalEntries,seasonOrders);
  }

  /** A direct cast link may have no originating show. Only load valid aggregate cast entries. */
  async cachedCastMember(personId:number, now=Date.now(), signal?:AbortSignal):Promise<CachedCastMember|null> {
    this.#compatible();
    signal?.throwIfAborted();
    const closing = this.#waiting.signal;
    let member:CachedCastMember|null|undefined, sources = 0;
    const scan = async (limit:number) => {
      const tx = this.#db.transaction('tmdb');
      findCastMember(tx.objectStore('tmdb'),personId,now,(value,count)=>{member=value; sources=count;},limit,undefined,
        ()=>!signal?.aborted && !closing.aborted);
      await finishRead(tx,signal,closing);
    };
    await scan(castWorkerAvailable() ? 32 : Infinity);
    if (member === undefined) {
      member = await lookupCastInWorker(this.#db,personId,now,sources,closing,signal);
      if (member === undefined) await scan(Infinity);
    }
    return member ?? null;
  }

  async purgeTmdb(now = Date.now()): Promise<void> {
    this.#requireWriter();
    await this.#sweepTmdb(now);
  }

  async #sweepTmdb(now: number): Promise<void> {
    if (typeof now !== 'number' || Number.isNaN(now)) throw new TypeError('Invalid metadata retention time.');
    const read = this.#db.transaction('tmdb');
    const [first] = await Promise.all([result(read.objectStore('tmdb').index('expiry').openKeyCursor()),done(read)]);
    if (!first) return;
    if (Number(first.key) > now) {
      this.#scheduleExpiry(Number(first.key));
      return;
    }
    let removed = false;
    let affectsFiles = false, affectsCharts = false;
    let nextExpiry: number | undefined;
    const inputs = new TmdbReportInputs();
    await this.#write(['tmdb','meta','watched','shows','ratings','lists','statistics'], tx => {
      const store = tx.objectStore('tmdb');
      const expiry = store.index('expiry');
      function classify() {
        inputs.check(tx,(files,charts) => {
          affectsFiles = files;
          affectsCharts = charts;
          if (files || charts) statisticsCacheChanged(tx,'metadataVersion');
          if (files) tx.objectStore('meta').put(true,'dropboxDirty');
        });
      }
      const next = expiry.openKeyCursor(IDBKeyRange.lowerBound(now,true));
      next.onsuccess = () => { if (next.result) nextExpiry = Number(next.result.key); };
      const batchSize = 256;
      function sweep() {
        const expired = expiry.getAllKeys(IDBKeyRange.upperBound(now),batchSize);
        expired.onsuccess = () => {
          const keys = expired.result;
          if (!keys.length) { classify(); return; }
          removed = true;
          inputs.add(keys);
          deleteExpiredEntries(store,keys,() => { if (keys.length === batchSize) sweep(); else classify(); });
        };
      }
      sweep();
    });
    if (removed) {
      this.#tmdbMetadataChanged(affectsFiles || affectsCharts ? 'tmdbmetadata' : 'tmdbbrowse',inputs.includesCast,inputs.includesConfiguration);
      if (affectsFiles) {
        this.#statusChanged();
        this.#exportChanged();
        this.dispatchEvent(new Event('summarychange'));
      }
    }
    if (nextExpiry !== undefined) this.#scheduleExpiry(nextExpiry);
  }

  #scheduleExpiry(deadline: number): void {
    if (this.#role === 'obsolete' || this.#role === 'closed' || deadline >= this.#expiryDue) return;
    clearTimeout(this.#expiryTimer);
    this.#expiryDue = deadline;
    // Browser timers accept a signed 32-bit delay. A checkpoint below that
    // limit also handles a long-running tab whose system clock has changed.
    const delay = Math.min(2_000_000_000, Math.max(0, deadline - Date.now()));
    this.#expiryTimer = setTimeout(() => {
      this.#expiryDue = Infinity;
      if (this.#role !== 'writer') return;
      void this.#sweepTmdb(Date.now()).catch(() => {
        if (this.#role === 'writer') this.#scheduleExpiry(Date.now() + 60_000);
      });
    }, delay);
  }

  async beginTmdbSubmission(): Promise<TmdbTicket> {
    this.#requireWriter();
    this.#tmdbSubmissionEpoch++;
    let ticket!: TmdbTicket;
    await this.#write(['meta'], tx => withControl(tx, control => {
      control.submission++;
      tx.objectStore('meta').put(control, tmdbControlKey);
      ticket = { generation: control.generation, submission: control.submission };
    }));
    return ticket;
  }

  async isTmdbSubmissionCurrent(ticket: TmdbTicket): Promise<boolean> {
    if (this.role !== 'writer') return false;
    const tx = this.#db.transaction(['meta','local']);
    this.#checkProviderBinding(tx,()=>{});
    const [control] = await Promise.all([result(tx.objectStore('meta').get(tmdbControlKey)), done(tx)]);
    return this.providerKeysAvailable && matchesTicket(controlValue(control), ticket);
  }

  async tmdbSubmissionCooldown(ticket: TmdbTicket, token: string): Promise<StoredTmdbCooldown | null> {
    const hash = await this.#providerHash(token);
    this.#compatible();
    const tx = this.#db.transaction(['meta', 'tmdbGates']);
    const [control, gate] = await Promise.all([result(tx.objectStore('meta').get(tmdbControlKey)),
      result(tx.objectStore('tmdbGates').get(hash)), done(tx)]);
    return matchesTicket(controlValue(control), ticket) ? gate ?? null : null;
  }

  async writeTmdbSubmissionCooldown(ticket: TmdbTicket, token: string, next: StoredTmdbCooldown | null, now = Date.now()): Promise<boolean> {
    const captured = { ...ticket };
    const cooldown = next && { ...next };
    const hash = await this.#providerHash(token);
    this.#requireWriter();
    let applied = false;
    await this.#write(['meta', 'tmdbGates'], tx => withControl(tx, control => {
      if (!this.providerKeysAvailable || !matchesTicket(control, captured)) return;
      updateCooldown(tx, hash, cooldown, now);
      applied = true;
    }));
    return applied;
  }

  /** One commit for the checked key, configuration, refusal reset and sync-visible revision. */
  async acceptTmdbSubmission(ticket: TmdbTicket, token: string, cacheKey: string, configuration: TmdbCacheEntry,
      current?: () => boolean): Promise<boolean> {
    this.#requireWriter();
    validateRow('settings', { setting: 'tmdb_key', value: token });
    const epoch = this.#tmdbSubmissionEpoch;
    const active = () => epoch === this.#tmdbSubmissionEpoch && (!current || current());
    if (!await this.isTmdbSubmissionCurrent(ticket) || !active()) return false;
    const entry = structuredClone(configuration);
    await this.#saveProviderKey('tmdb_key',token,active,{key:cacheKey,entry});
    this.#scheduleExpiry(cacheExpiresAt(entry.fetchedAt));
    this.#exportUpdates?.postMessage('tmdbstate');
    this.#changed({ tables:['settings'], localKeys:[], settings:['tmdb_key'], onlyDescriptions:false, syncWrite:true });
    return true;
  }

  /** Replies may affect metadata only while the dispatch generation is still current. */
  async writeTmdb(generation: bigint, changes: TmdbWrite, now = Date.now(), current?:()=>boolean): Promise<boolean> {
    this.#requireWriter();
    const patch = structuredClone(changes);
    const keys = Object.keys(patch.entries ?? {});
    const inputs = new TmdbReportInputs();
    inputs.add(keys);
    let syncInputsChanged = false, affectsCharts = false;
    let statisticsChange:StatisticsMetadataChange|undefined;
    let applied = false;
    const stores = ['meta','tmdb','tmdbGates'];
    if (patch.refused !== undefined || keys.some(key=>affectsExport(key) || key === 'configuration/countries' || key.endsWith('/aggregate_credits')))
      stores.push('statistics');
    stores.push(...inputs.stores());
    await this.#write(stores, (tx, fail) => {
      const write = (files:boolean,charts:boolean) => withControl(tx, control => {
        if (!this.#providerValue('tmdb_key') || control.generation !== generation || !control.credential || control.refused !== null || current && !current()) return;
        try {
          syncInputsChanged = files;
          affectsCharts = charts;
          if (files || charts) {
            const isolated = !files && keys.length === 1 && (keys[0] === 'configuration/countries' || /^tv\/\d+\/aggregate_credits$/.test(keys[0]));
            const previous = isolated && tx.objectStoreNames.contains('statistics') ? tx.objectStore('statistics').get('metadataVersion') : undefined;
            const version = statisticsCacheChanged(tx,'metadataVersion');
            if (previous && version) previous.onsuccess = () => {
              statisticsChange = {key:keys[0],previous:previous.result?.value,version};
            };
          }
          for (const [key, entry] of Object.entries(patch.entries ?? {})) writeEntry(tx, key, entry);
          if (syncInputsChanged) tx.objectStore('meta').put(true, 'dropboxDirty');
          if (patch.refused !== undefined) {
            control.refused = patch.refused;
            const meta = tx.objectStore('meta');
            meta.put(control, tmdbControlKey);
            const revision = meta.get('revision');
            revision.onsuccess = () => statisticsRevision(tx,(revision.result ?? 0n) + 1n);
          }
          if (patch.cooldown !== undefined) updateCooldown(tx, control.credential, patch.cooldown, now);
          applied = true;
        } catch (error) { fail(error); }
      });
      inputs.check(tx,(files,charts)=>{
        if ((files || charts) && keys.length === 1) {
          const key = keys[0];
          checkTmdbReportChange(tx,key,patch.entries![key],now,changed=>write(files && changed,charts && changed));
        } else write(files,charts);
      });
    });
    if (applied && patch.refused !== undefined) {
      this.dispatchEvent(new Event('tmdbstatechange'));
      this.#exportUpdates?.postMessage('tmdbstate');
    }
    if (applied) {
      if (keys.length) {
        // Queries, images and browsing results are independent of the personal report.
        const affectsStatistics = syncInputsChanged || affectsCharts;
        this.#tmdbMetadataChanged(affectsStatistics ? 'tmdbmetadata' : 'tmdbbrowse',inputs.includesCast,inputs.includesConfiguration,statisticsChange);
      }
      for (const entry of Object.values(patch.entries ?? {})) this.#scheduleExpiry(cacheExpiresAt(entry.fetchedAt));
      // A search title can now match a previously indexed GitHub rating.
      if (keys.some(key => key.endsWith('/external_ids'))) this.#scoresChanged('imdb',syncInputsChanged);
      if (syncInputsChanged) {
        this.#statusChanged();
        this.#exportChanged();
        this.dispatchEvent(new Event('summarychange'));
      }
    }
    return applied;
  }

  /** An erase invalidates replies and key-check tickets even if their token is later reused. */
  async invalidateTmdb(): Promise<void> {
    this.#requireWriter();
    await this.#write(['meta','tmdb','tmdbGates','statistics'], tx => withControl(tx, control => {
      control.generation++;
      control.refused = null;
      const meta = tx.objectStore('meta');
      meta.put(control, tmdbControlKey);
      meta.put(true, 'dropboxDirty');
      const revision = meta.get('revision');
      revision.onsuccess = () => statisticsRevision(tx,(revision.result ?? 0n) + 1n);
      tx.objectStore('tmdb').clear();
      tx.objectStore('tmdbGates').clear();
    }));
    this.#exportChanged();
    this.#statusChanged();
    this.#exportUpdates?.postMessage('tmdbstate');
    this.dispatchEvent(new Event('cachechange'));
  }
}

export const openDeviceStore = DeviceStore.open;
