import type {MalEntry} from './mal-file.ts';
import type {WorkerDatabase} from './record-worker-client.ts';
import {readWorkerResult} from './read-worker.ts';

let readers = 0;
let unavailable:{implementation:typeof Worker;until:number}|undefined;
export function malLookupAvailable(count:number) {
  return count >= 12 && readers < 2 && typeof Worker !== 'undefined' &&
    !(unavailable?.implementation === Worker && performance.now() < unavailable.until);
}
export async function lookupMalIndex(database:WorkerDatabase, ids:readonly number[], closing:AbortSignal, signal?:AbortSignal) {
  if (!malLookupAvailable(ids.length)) return undefined;
  let worker:Worker|undefined;
  readers++;
  try {
    try { worker = new Worker(new URL('./mal-lookup-worker.js',import.meta.url),{type:'module'}); }
    catch { unavailable = {implementation:Worker,until:performance.now()+30_000}; return undefined; }
    const reply = await readWorkerResult<Map<number,MalEntry[]>>(worker,{...database,ids},ids.length,signal,closing);
    closing.throwIfAborted();
    signal?.throwIfAborted();
    if ('result' in reply && reply.result instanceof Map) return reply.result;
    if ('failure' in reply && reply.failure === 'obsolete') throw new DOMException('The ratings cache changed.','InvalidStateError');
    unavailable = {implementation:Worker,until:performance.now()+30_000};
    return undefined;
  } finally { readers--; worker?.terminate(); }
}
