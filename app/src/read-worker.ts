export type ReadWorkerResult<T> = {result:T} | {failure:'limit'|'invalid'|'unavailable'|'obsolete'};
export type ReadWorkerReply<T> = ReadWorkerResult<T> | {rows:number};

/** An unavailable reader gets one local fallback. Only actual forward progress extends its deadline. */
export function readWorkerResult<T>(worker:Worker, request:object, maxRows:number, signal?:AbortSignal, closing?:AbortSignal) {
  return new Promise<ReadWorkerResult<T>>(resolve => {
    let rows = -1, finished = false;
    const unavailable = () => finish({failure:'unavailable'});
    let timer = setTimeout(unavailable,5000);
    function finish(reply:ReadWorkerResult<T>) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort',unavailable);
      closing?.removeEventListener('abort',unavailable);
      worker.onmessage = worker.onmessageerror = worker.onerror = null;
      resolve(reply);
    }
    if (signal?.aborted || closing?.aborted) { unavailable(); return; }
    signal?.addEventListener('abort',unavailable,{once:true});
    closing?.addEventListener('abort',unavailable,{once:true});
    worker.onmessage = ({data}:MessageEvent<ReadWorkerReply<T>>) => {
      if (finished) return;
      if (!data || typeof data !== 'object') { unavailable(); return; }
      if (!('rows' in data)) {
        if ('result' in data && data.result !== undefined || 'failure' in data) finish(data);
        else unavailable();
        return;
      }
      if (Number.isSafeInteger(data.rows) && data.rows > rows && data.rows <= maxRows) {
        rows = data.rows;
        clearTimeout(timer);
        timer = setTimeout(unavailable,15_000);
      }
    };
    worker.onerror = event => { event.preventDefault(); unavailable(); };
    worker.onmessageerror = unavailable;
    try { worker.postMessage(request); } catch { unavailable(); }
  });
}
