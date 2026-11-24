import {serveCacheLookup} from './read-worker-server.ts';
import {malShowKey} from './mal-store.ts';
import type {MalEntry} from './mal-file.ts';

interface Request {database:string;version:number;ids:number[]}
serveCacheLookup<Request,Map<number,MalEntry[]>>(['settings','cache'],(tx,{ids},progress) => {
  const found = new Map<number,MalEntry[]>(), cache = tx.objectStore('cache');
  const mode = tx.objectStore('settings').get('mal_source');
  let index = 0;
  function batch() {
    const end = Math.min(index+256,ids.length);
    while (index < end) {
      const id = ids[index++], request = cache.get(malShowKey(id)), last = index === end;
      request.onsuccess = () => {
        if (request.result) found.set(id,request.result);
        if (last && index < ids.length) { progress(index); batch(); }
      };
    }
  }
  mode.onsuccess = () => { if (mode.result?.value === 'github') batch(); };
  return () => found;
});
