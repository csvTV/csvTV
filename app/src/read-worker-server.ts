import type {ReadWorkerReply} from './read-worker.ts';

/** Open public cache stores at the document's schema version. Upgrades always belong to the app. */
export function serveCacheLookup<Request extends {database:string;version:number},Value>(stores:string|string[],
    read:(tx:IDBTransaction,request:Request,progress:(count:number)=>void)=>()=>Value) {
  const scope = globalThis as unknown as {
    onmessage:((event:MessageEvent<Request>)=>void)|null;
    postMessage:(reply:ReadWorkerReply<Value>)=>void;
  };
  scope.onmessage = ({data}) => {
    scope.onmessage = null;
    const progress = (rows:number) => scope.postMessage({rows});
    progress(0);
    const open = indexedDB.open(data.database,data.version);
    open.onupgradeneeded = () => open.transaction!.abort();
    open.onblocked = () => scope.postMessage({failure:'obsolete'});
    open.onerror = () => scope.postMessage({failure:open.error?.name === 'VersionError' ? 'obsolete' : 'unavailable'});
    open.onsuccess = () => {
      const db = open.result;
      db.onversionchange = () => { db.close(); scope.postMessage({failure:'obsolete'}); };
      try {
        const tx = db.transaction(stores);
        tx.onabort = () => { db.close(); scope.postMessage({failure:'unavailable'}); };
        const result = read(tx,data,progress);
        tx.oncomplete = () => { db.close(); scope.postMessage({result:result()}); };
      } catch { db.close(); scope.postMessage({failure:'unavailable'}); }
    };
  };
}
