import {runRecordWorker,type WorkerDatabase} from './record-worker-client.ts';
import type {WatchedRow} from './model.ts';
import type {FileSyncState} from './storage.ts';
import type {PriorWatchDownload,WatchedResetAdoption} from './record-transaction.ts';

export interface WatchedRowChanges {
  put: readonly WatchedRow[];
  remove: readonly [number,number,number][];
}

export interface WatchDownload {
  revision: bigint;
  accountId: string;
  erased: bigint;
  expiresAt: number;
  rows: readonly WatchedRow[];
  remove?: WatchedRowChanges['remove'];
  receipt: FileSyncState;
  prior?: PriorWatchDownload;
  reset?: WatchedResetAdoption;
}

export async function writeWatchDownload(database:WorkerDatabase,prepare:()=>Promise<WatchDownload>,
    closing:AbortSignal,stale:()=>Error,current?:()=>boolean) {
  const outcome = await runRecordWorker(
    () => new Worker(new URL('./watch-download-worker.js',import.meta.url),{type:'module'}),database,prepare,closing,stale,current);
  return outcome.status;
}
