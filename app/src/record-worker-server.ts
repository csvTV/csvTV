import type {WatchedRow} from './model.ts';

/** A worker opens only an existing compatible database. Schema changes remain with the application. */
export function openRecordWorker<Operation>(write:(db:IDBDatabase, operation:Operation)=>void) {
  self.onmessage = event => {
    self.onmessage = null;
    const {database,version} = event.data as {database:string;version:number};
    let open:IDBOpenDBRequest;
    try { open = indexedDB.open(database,version); }
    catch { self.postMessage({type:'unavailable'}); return; }
    open.onupgradeneeded = () => open.transaction!.abort();
    open.onerror = () => self.postMessage({type:open.error?.name === 'VersionError' ? 'stale' : 'unavailable'});
    open.onblocked = () => self.postMessage({type:'stale'});
    open.onsuccess = () => {
      const db = open.result;
      db.onversionchange = () => db.close();
      self.onmessage = event => {
        self.onmessage = null;
        try { write(db,event.data); }
        catch (error) { db.close(); self.postMessage({type:'error',name:error instanceof DOMException ? error.name : undefined}); }
      };
      self.postMessage({type:'opened'});
    };
  };
  self.postMessage({type:'ready'});
}

/** Keep an atomic write open for the owning document's final acceptance. */
export function workerAdmission(meta:IDBObjectStore, expired:()=>boolean, abort:(reason:string)=>void) {
  let waiting = false, admitted = false;
  self.onmessage = event => {
    if (event.data?.type === 'cancel') abort('stale');
    else if (event.data?.type === 'admit' && waiting) admitted = true;
  };
  return (finish:()=>void) => {
    meta.getKey('revision').onsuccess = () => {
      if (expired()) return abort('stale');
      waiting = true;
      const deadline = Date.now()+5_000;
      self.postMessage({type:'admission'});
      function check() {
        if (expired()) return abort('stale');
        if (admitted) {
          try { finish(); } catch (error) { abort(error instanceof DOMException ? error.name : 'UnknownError'); }
          return;
        }
        if (Date.now() >= deadline) return abort('TimeoutError');
        meta.getKey('revision').onsuccess = check;
      }
      check();
    };
  };
}

/** Yield between batches while keeping the watch changes in one transaction. */
export function writeWorkerWatches(store:IDBObjectStore, remove:readonly IDBValidKey[], put:readonly WatchedRow[],
    current:()=>boolean, finished:()=>void, abort:(reason:string)=>void) {
  const count = remove.length+put.length;
  let index = 0;
  function batch() {
    try {
      if (!current()) return abort('stale');
      if (index === count) { finished(); return; }
      let last:IDBRequest;
      const end = Math.min(index+512,count);
      while (index < end) {
        last = index < remove.length ? store.delete(remove[index]) : store.put(put[index-remove.length]);
        index++;
      }
      last!.onsuccess = () => { self.postMessage({type:'progress'}); batch(); };
    } catch(error) { abort(error instanceof DOMException ? error.name : 'UnknownError'); }
  }
  batch();
}
