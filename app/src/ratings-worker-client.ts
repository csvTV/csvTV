import { readImdbEpisodes, readImdbShows } from './imdb-file.ts';
import { ratingsFileLimits, RatingsFileLimitError, RatingsIndexBusyError } from './ratings-csv.ts';
import { readWorkerResult, type ReadWorkerResult } from './read-worker.ts';

// A season view needs only its own small index. Limit simultaneous inflaters when
// several views ask for different series from the same installed file.
let active = 0;
const waiting = new Set<() => void>();
let unavailable: {implementation:typeof Worker; until:number} | undefined;

function waitForSlot(signal?:AbortSignal) {
  if (waiting.size >= 8) throw new RatingsIndexBusyError();
  return new Promise<void>((resolve,reject) => {
    const start = () => { signal?.removeEventListener('abort',abort); resolve(); };
    const abort = () => { waiting.delete(start); reject(signal!.reason); };
    waiting.add(start);
    signal?.addEventListener('abort',abort,{once:true});
  });
}

async function parseLarge<T>(file:Blob, show:number | undefined, local:() => Promise<T>, signal?:AbortSignal):Promise<T> {
  signal?.throwIfAborted();
  if (file.size < 64 * 1024 || file.size > ratingsFileLimits.imdb.compressedBytes) return local();
  if (active >= 2) await waitForSlot(signal);
  else active++;
  let worker:Worker | undefined;
  try {
    signal?.throwIfAborted();
    if (typeof Worker === 'undefined' || unavailable?.implementation === Worker && performance.now() < unavailable.until) return await local();
    let reply:ReadWorkerResult<T>;
    try {
      worker = new Worker(new URL('./ratings-worker.js', import.meta.url), {type:'module'});
      reply = await readWorkerResult<T>(worker,{file,show},ratingsFileLimits.imdb.rows+1,signal);
    } catch {
      reply = {failure:'unavailable'};
    } finally { worker?.terminate(); }
    signal?.throwIfAborted();
    if ('result' in reply) return reply.result;
    if (reply.failure === 'limit') throw new RatingsFileLimitError();
    if (reply.failure === 'invalid') throw new Error('The IMDb ratings file is invalid or incomplete.');
    unavailable = {implementation:Worker,until:performance.now()+30_000};
    return await local();
  } finally {
    const next = waiting.values().next().value;
    if (next) { waiting.delete(next); next(); }
    else active--;
  }
}

export const indexImdbShows = (file:Blob,signal?:AbortSignal) => parseLarge(file,undefined,() => readImdbShows(file,{signal}),signal);
export const indexImdbEpisodes = (file:Blob,show:number,signal?:AbortSignal) => parseLarge(file,show,() => readImdbEpisodes(file,show,{signal}),signal);
