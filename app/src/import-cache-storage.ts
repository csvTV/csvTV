import {affectsExport,retainedEntry,writeEntry,type TmdbCacheEntry} from './tmdb-store.ts';
import {cacheExpiresAt} from './tmdb-refresh.ts';
import {withoutManualOrder} from './season-order.ts';

export type ImportCacheEntries = ReadonlyMap<string,TmdbCacheEntry & {prior?:TmdbCacheEntry|null}>;

/** Keep any newer metadata fetched since the owner reviewed this import. */
export function importCacheWrites(tx:IDBTransaction, entries:ImportCacheEntries,
    written:(expiry:number,partOfExport:boolean)=>void, fail:(error:unknown)=>void) {
  const cache = tx.objectStore('tmdb'), now = Date.now();
  let last:IDBRequest|undefined;
  let failed = false;
  for (const [key,entry] of entries) {
    const expiry = cacheExpiresAt(entry.fetchedAt);
    if (entry.fetchedAt > now || !(expiry > now)) continue;
    const existing = cache.get(key);
    last = existing;
    existing.onsuccess = () => {
      if (failed) return;
      try {
        const current = retainedEntry(existing.result,now);
        if (current && (!entry.prior || current.fetchedAt !== entry.prior.fetchedAt ||
            JSON.stringify(current.value) !== JSON.stringify(withoutManualOrder(entry.prior.value)) ||
            JSON.stringify(current.vacatedPositions) !== JSON.stringify(entry.prior.vacatedPositions))) return;
        writeEntry(tx,key,{fetchedAt:entry.fetchedAt,value:withoutManualOrder(entry.value),
          ...(entry.vacatedPositions && {vacatedPositions:entry.vacatedPositions})});
        written(expiry,affectsExport(key));
      } catch (error) { failed = true; fail(error); }
    };
  }
  return (afterComparisons:()=>void) => {
    if (last) last.addEventListener('success',() => { if (!failed) afterComparisons(); },{once:true});
    else afterComparisons();
  };
}
