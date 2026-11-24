import {serveCacheLookup} from './read-worker-server.ts';
import {seasonOrderPrefix} from './season-order.ts';
import type {ExportMetadataRequest,ExportMetadataRows} from './export-metadata-reader.ts';

serveCacheLookup<ExportMetadataRequest,ExportMetadataRows|null>(['meta','tmdb','settings'],(tx,request,progress) => {
  const meta = tx.objectStore('meta'), revision = meta.get('revision'), erased = meta.get('deviceEraseRevision');
  let rows:ExportMetadataRows|null = null;
  erased.onsuccess = () => {
    if ((revision.result ?? 0n) !== request.revision || (erased.result ?? 0n) !== request.erased) return;
    const cache = tx.objectStore('tmdb');
    const snapshot:ExportMetadataRows = {entries:new Map(),orders:[]};
    rows = snapshot;
    // Read only season-order settings. The worker has no reason to open the local grant or any provider-key row.
    const orders = tx.objectStore('settings').getAll(IDBKeyRange.bound(seasonOrderPrefix,seasonOrderPrefix+'\uffff'));
    orders.onsuccess = () => { snapshot.orders = orders.result; };
    let offset = 0;
    function batch() {
      const end = Math.min(request.keys.length,offset+256);
      while (offset < end) {
        const key = request.keys[offset++], last = offset === end;
        const entry = cache.get(key);
        entry.onsuccess = () => {
          if (entry.result !== undefined) snapshot.entries.set(key,entry.result);
          if (last) { progress(end); if (end < request.keys.length) batch(); }
        };
      }
    }
    batch();
  };
  return () => rows;
});
