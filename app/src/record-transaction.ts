import type {MergeTable} from './model.ts';
import type {FileSyncState,PendingUpload} from './storage.ts';
import type {ObservedReset} from './dropbox-reset.ts';

export const canceledKey = (table: MergeTable) => 'dropboxCanceled:' + table;

export function sameReceipt(stored:PendingUpload|null, reviewed:PendingUpload):boolean {
  return !!stored && stored.clientModified === reviewed.clientModified && stored.preparedAt === reviewed.preparedAt &&
    stored.targetRevision === reviewed.targetRevision && stored.targetModified === reviewed.targetModified &&
    stored.content === reviewed.content && stored.targetContent === reviewed.targetContent && stored.absoluteWatches === reviewed.absoluteWatches &&
    stored.absoluteValues === reviewed.absoluteValues && stored.inspectOnly === reviewed.inspectOnly &&
    stored.settingsContentHash === reviewed.settingsContentHash &&
    (stored.targetRevision !== null || (stored.previousRevisions === undefined && reviewed.previousRevisions === undefined) ||
      (Array.isArray(stored.previousRevisions) && Array.isArray(reviewed.previousRevisions) &&
       stored.previousRevisions.length === reviewed.previousRevisions.length &&
       stored.previousRevisions.every((rev,i)=>rev===reviewed.previousRevisions![i])));
}

export const importReceiptKey = 'lastImportWrite';
export const watchEditReceiptKey = 'lastManualWatchWrite';
export const recordTransferWorkerMinimum = 32;

export interface PriorWatchDownload {
  count:number;
  base:NonNullable<FileSyncState['base']>;
  lastClientModified:string|null;
}

/** All other record rows already agree when a watched-only reset uses the download worker. */
export interface WatchedResetAdoption {
  before:ObservedReset|null;
  after:ObservedReset;
  initializeSettings:boolean;
}
export const resetWatchLocalKeys = ['recentlyMarked','displacedRecentMark','dropboxShowsHash'];

export function sameResetObservation(actual:unknown,expected:ObservedReset|null):boolean {
  try { return JSON.stringify(actual ?? null) === JSON.stringify(expected); }
  catch { return false; }
}

/** Queue the checks before the admission callback, in the same write transaction as the watches. */
export function watchResetGuard(tx:IDBTransaction,reset?:WatchedResetAdoption) {
  if (!reset) return () => true;
  const before = tx.objectStore('local').get('dropboxResetSeen');
  const settings = reset.initializeSettings && tx.objectStore('sync').getKey('settings');
  return () => sameResetObservation(before.result,reset.before) && (!settings || settings.result === undefined);
}

/** A large download must still be replacing the exact state its merge examined. */
export function matchesDownloadBase(count:number,receipt:FileSyncState|undefined,prior?:PriorWatchDownload) {
  if (receipt?.pending) return false;
  if (!prior) return !count && !receipt?.base;
  return count === prior.count && !!receipt?.base && receipt.base.revision === prior.base.revision &&
    receipt.base.content === prior.base.content && receipt.lastClientModified === prior.lastClientModified;
}

export interface StatisticsCacheVersions {metadataVersion?:string; scoresVersion?:string; writerLease?:string}
export interface StatisticsMetadataChange {key:string; previous?:string; version:string}

/** A reader can verify cached results even when the writer's advisory message
 * never arrives. The marker commits or rolls back with the public source. */
export function statisticsCacheChanged(tx:IDBTransaction,key:'metadataVersion'|'scoresVersion') {
  if (!tx.objectStoreNames.contains('statistics')) return;
  const version = crypto.randomUUID();
  tx.objectStore('statistics').put({key,value:version});
  return version;
}

// Statistics can read this small projection without waiting for unrelated settings or sync writes.
export function statisticsField(tx: IDBTransaction, key: 'revision'|'scope'|'legacyScope'|'opened', value: unknown) {
  if (!tx.objectStoreNames.contains('statistics')) return;
  if (key === 'scope' || key === 'legacyScope') {
    if (value == null) value = null;
    else value = value === 'anime' || value === 'tv' ? value : 'all';
  } else if (key === 'opened') value = value === true;
  tx.objectStore('statistics').put({key,value});
}

export function statisticsRevision(tx: IDBTransaction, revision: bigint) {
  tx.objectStore('meta').put(revision,'revision');
  statisticsField(tx,'revision',revision);
}
