import type { CachedCastMember } from './cast-cache.ts';
import { readWorkerResult } from './read-worker.ts';

let active = 0;
let unavailable: {implementation:typeof Worker; until:number} | undefined;

export function castWorkerAvailable() {
  return active < 2 && typeof Worker !== 'undefined' &&
    !(unavailable?.implementation === Worker && performance.now() < unavailable.until);
}

export async function lookupCastInWorker(db:IDBDatabase, person:number, now:number, sources:number, closing:AbortSignal, signal?:AbortSignal) {
  if (!castWorkerAvailable()) return undefined;
  let worker:Worker|undefined;
  active++;
  try {
    const request = {database:db.name,version:db.version,person,now};
    try { worker = new Worker(new URL('./cast-lookup-worker.js',import.meta.url),{type:'module'}); }
    catch { unavailable = {implementation:Worker,until:performance.now()+30_000}; return undefined; }
    const reply = await readWorkerResult<CachedCastMember|null>(worker,request,Math.max(128,sources*2),signal,closing);
    closing.throwIfAborted();
    signal?.throwIfAborted();
    if ('result' in reply && (reply.result === null || reply.result?.id === person && Number.isSafeInteger(reply.result.sourceShowId))) {
      return reply.result;
    }
    if ('failure' in reply && reply.failure === 'obsolete') throw new DOMException('The cache changed during the lookup.','InvalidStateError');
    unavailable = {implementation:Worker,until:performance.now()+30_000};
    return undefined;
  } finally { active--; worker?.terminate(); }
}
