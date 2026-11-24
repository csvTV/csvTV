import type {DeviceChanges} from './storage.ts';
import type {ImportCacheEntries} from './import-cache-storage.ts';
import {recentSource,readRecentValue} from './recent-history.ts';
import {runRecordWorker,type WorkerDatabase} from './record-worker-client.ts';
import {recordTransferWorkerMinimum} from './record-transaction.ts';

export {importReceiptKey} from './record-transaction.ts';
export interface SavedImport {id:string;expiry:number;exportChanged:boolean}
export interface ImportRecord {
  id:string;revision:bigint;erased:bigint;accountId:string;expiresAt:number;
  generation:bigint;entries:ImportCacheEntries;patch:DeviceChanges;
}

/** The importer can also retain or retire earlier recent marks. All other settings remain in the document. */
export function supportedImport(patch:DeviceChanges) {
  const watched = (patch.put?.watched?.length ?? 0)+(patch.remove?.watched?.length ?? 0);
  if (watched < recordTransferWorkerMinimum || Object.keys(patch).some(key=>!['put','remove','local','removeLocal'].includes(key))) return false;
  if (Object.keys(patch.put ?? {}).some(key=>!['watched','shows','ratings','lists','settings'].includes(key)) ||
      Object.keys(patch.remove ?? {}).some(key=>key !== 'watched')) return false;
  if (patch.put?.settings?.some(row=>!recentSource(row.setting) || !readRecentValue(row.value))) return false;
  if (patch.removeLocal?.some(key=>key !== 'displacedRecentMark') ||
      Object.keys(patch.local ?? {}).some(key=>key !== 'recentlyMarked')) return false;
  const recent = patch.local?.recentlyMarked;
  return recent === undefined || (Array.isArray(recent) && recent.every(id=>Number.isSafeInteger(id) && id > 0));
}

export function runImportRecord(database:WorkerDatabase,prepare:()=>Promise<ImportRecord>,closing:AbortSignal,
    stale:()=>Error,current:()=>boolean) {
  return runRecordWorker<ImportRecord,SavedImport>(
    () => new Worker(new URL('./import-record-worker.js',import.meta.url),{type:'module'}),database,prepare,closing,stale,current);
}
