const mib = 1024 * 1024;
export const ratingsFileLimits = {
  imdb: {compressedBytes:16 * mib, decodedBytes:64 * mib, rows:2_500_000},
  mal: {compressedBytes:4 * mib, decodedBytes:8 * mib, rows:100_000},
};
export const ratingsLimitMessage = 'The ratings file exceeds the supported size or row limit.';
export interface RatingsReadOptions { signal?:AbortSignal; progress?:(rows:number)=>void }
export class RatingsFileLimitError extends Error {
  constructor() { super(ratingsLimitMessage); }
}
export const ratingsBusyMessage = 'Several ratings lookups are already waiting. Try again shortly.';
export class RatingsIndexBusyError extends Error { constructor() { super(ratingsBusyMessage); } }

function yieldToPage():Promise<void> {
  return new Promise(resolve => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

/** Compare validated decimal scores without rounding away significant digits. */
export function normalizedRating(text:string):string {
  let start = 0, end = text.length;
  while (text[start] === '0' && start + 1 < end && text[start+1] !== '.') start++;
  if (text.includes('.')) {
    while (text[end-1] === '0') end--;
    if (text[end-1] === '.') end--;
  }
  return text.slice(start,end);
}

/** Validate the header, UTF-8 and gzip trailer before the caller publishes any rows. */
export async function readRatingsCsv(file: Blob, header: string, limits:typeof ratingsFileLimits.imdb,
    invalid: () => Error, accept: (line: string) => void, {signal,progress}:RatingsReadOptions={}) {
  signal?.throwIfAborted();
  if (file.size > limits.compressedBytes) throw new RatingsFileLimitError();
  const reader = file.stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const decoder = new TextDecoder('utf-8', {fatal:true, ignoreBOM:true});
  let remainder = '', lines = 0, decodedBytes = 0;
  let nextYield = 'WorkerGlobalScope' in globalThis ? Infinity : performance.now() + 12;
  let nextProgress = performance.now() + 500;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort',cancel,{once:true});
  const maxLine = 65_536;
  function consume(text: string) {
    if (text.endsWith('\r')) text = text.slice(0, -1);
    if (text.length > maxLine) throw invalid();
    if (lines > limits.rows) throw new RatingsFileLimitError();
    if (lines++ === 0) {
      if (text !== header) throw invalid();
    } else accept(text);
  }
  try {
    for (;;) {
      const {done, value} = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      decodedBytes += value.byteLength;
      if (decodedBytes > limits.decodedBytes) throw new RatingsFileLimitError();
      const text = remainder + decoder.decode(value, {stream:true});
      let start = 0;
      let end: number;
      while ((end = text.indexOf('\n', start)) !== -1) {
        consume(text.slice(start, end));
        start = end + 1;
        // Buffered inflate chunks can keep the microtask queue busy for an entire
        // file. Let input and rendering run even when a single chunk has many rows.
        if (lines % 1024 === 0) {
          const now = performance.now();
          if (progress && now >= nextProgress) { progress(lines); nextProgress = now + 500; }
          if (now >= nextYield) {
            await yieldToPage();
            signal?.throwIfAborted();
            nextYield = performance.now() + 12;
          }
        }
      }
      remainder = text.slice(start);
      if (remainder.length > maxLine && !(remainder.length === maxLine + 1 && remainder.endsWith('\r'))) throw invalid();
    }
    remainder += decoder.decode();
    if (remainder) consume(remainder);
    if (lines < 2) throw invalid();
  } catch (error) {
    void reader.cancel().catch(() => {});
    signal?.throwIfAborted();
    if (error instanceof RatingsFileLimitError) throw error;
    throw invalid();
  } finally { signal?.removeEventListener('abort',cancel); reader.releaseLock(); }
}
