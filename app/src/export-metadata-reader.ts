import {readWorkerResult} from './read-worker.ts';
import type {SettingRow} from './model.ts';
import type {TmdbCacheEntry} from './tmdb-store.ts';

export interface ExportMetadataRequest {
  database:string;
  version:number;
  revision:bigint;
  erased:bigint;
  keys:string[];
}

export interface ExportMetadataRows {
  entries:Map<string,TmdbCacheEntry & {expiresAt:number}>;
  orders:SettingRow[];
}

let unavailable:{implementation:typeof Worker;until:number}|undefined;

/** The caller checks the publication grant before accepting a public catalog snapshot. */
export async function readExportMetadata(request:ExportMetadataRequest,closing:AbortSignal,signal?:AbortSignal) {
  if (typeof Worker === 'undefined' || unavailable?.implementation === Worker && performance.now() < unavailable.until) return;
  let worker:Worker|undefined;
  try {
    try { worker = new Worker(new URL('./export-metadata-worker.js',import.meta.url),{type:'module'}); }
    catch { unavailable = {implementation:Worker,until:performance.now()+30_000}; return; }
    const reply = await readWorkerResult<ExportMetadataRows|null>(worker,request,request.keys.length,signal,closing);
    closing.throwIfAborted();
    signal?.throwIfAborted();
    if ('result' in reply && reply.result === null) return; // The local record changed before the transaction opened.
    if ('result' in reply && reply.result?.entries instanceof Map && Array.isArray(reply.result.orders)) return reply.result;
    unavailable = {implementation:Worker,until:performance.now()+30_000};
  } finally { worker?.terminate(); }
}
