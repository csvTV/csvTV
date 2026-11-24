import type { TmdbDataByKind } from './tmdb-data.ts';

export type CachedCastMember = TmdbDataByKind['cast'][number] & {sourceShowId:number};

/** Read retained cast bodies in small batches, preserving index order for equal fetch times.
 * An undefined result asks the caller to continue a large lookup in a worker. */
export function findCastMember(cache:IDBObjectStore, id:number, now:number, receive:(value:CachedCastMember|null|undefined,sources:number)=>void,
    maxSources:number, progress?:(count:number)=>void, active:()=>boolean=()=>true) {
  const request = cache.index('expiry').getAllKeys(IDBKeyRange.lowerBound(now,true));
  request.onsuccess = () => {
    if (!active()) return;
    const keys = request.result.filter((key):key is string => typeof key === 'string' && /^tv\/\d+\/aggregate_credits$/.test(key));
    if (keys.length > maxSources) { receive(undefined,keys.length); return; }
    if (!keys.length) { receive(null,0); return; }
    let member:CachedCastMember|null = null, newest = -Infinity;
    function batch(start:number) {
      if (!active()) return;
      const end = Math.min(keys.length,start+24);
      for (let i=start;i<end;i++) {
        const read = cache.get(keys[i]);
        read.onsuccess = () => {
          const row = read.result as {fetchedAt:number;value:TmdbDataByKind['cast']|null};
          if (row.fetchedAt > newest && row.fetchedAt <= now) {
            const match = row.value?.find(person => person.id === id);
            if (match) {
              member = {...match,sourceShowId:Number(keys[i].split('/')[1])};
              newest = row.fetchedAt;
            }
          }
          if (i+1 === end) {
            if (end === keys.length) receive(member,keys.length);
            else { progress?.(end); batch(end); }
          }
        };
      }
    }
    batch(0);
  };
}
