import type {SettingRow,WatchedRow} from './model.ts';
import {readRecentValue,recentSource} from './recent-history.ts';
import {runRecordWorker,type WorkerDatabase} from './record-worker-client.ts';
import type {DeviceChanges} from './storage.ts';

interface WatchEditRows {
  put:readonly WatchedRow[]; remove:readonly [number,number,number][]; recent:readonly SettingRow[]; clearLegacy:boolean;
}
export interface ManualWatchWrite extends WatchEditRows {
  id:string; revision:bigint; erased:bigint; owner:string|null; generation?:bigint;
}
const watchFields = new Set(['show_id','show','season','episode','episode_id','title','times_watched']);

/** Only an ordinary watch edit and its matching recency changes use this writer. */
export function largeWatchEdit(patch:DeviceChanges):WatchEditRows|undefined {
  const put = patch.put?.watched ?? [], remove = patch.remove?.watched ?? [];
  if (put.length+remove.length < 16) return;
  if (Object.keys(patch).some(key=>!['put','remove','removeLocal'].includes(key)) ||
      Object.keys(patch.put ?? {}).some(key=>key !== 'watched' && key !== 'settings') ||
      Object.keys(patch.remove ?? {}).some(key=>key !== 'watched') ||
      patch.removeLocal?.some(key=>key !== 'recentlyMarked')) return;
  const recent = patch.put?.settings ?? [];
  if (recent.some(row=>!recentSource(row.setting) || !readRecentValue(row.value) || Object.keys(row).length !== 2) ||
      put.some(row=>Object.keys(row).some(key=>!watchFields.has(key))) ||
      remove.some(key=>!Array.isArray(key) || key.length !== 3 || !key.every(Number.isSafeInteger))) return;
  return {put,remove,recent,clearLegacy:!!patch.removeLocal?.length};
}

export function runManualWatchWrite(database:WorkerDatabase,prepare:()=>Promise<ManualWatchWrite>,closing:AbortSignal,
    stale:()=>Error,current:()=>boolean) {
  return runRecordWorker<ManualWatchWrite,string>(
    () => new Worker(new URL('./watch-edit-worker.js',import.meta.url),{type:'module'}),database,prepare,closing,stale,current);
}
