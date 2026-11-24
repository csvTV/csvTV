import {openRecordWorker,workerAdmission,writeWorkerWatches} from './record-worker-server.ts';
import {canceledKey,importReceiptKey,statisticsRevision} from './record-transaction.ts';
import {importCacheWrites} from './import-cache-storage.ts';
import {withControl} from './tmdb-store.ts';
import type {ImportRecord,SavedImport} from './import-record.ts';

function save(db:IDBDatabase, job:ImportRecord) {
  const names = ['watched','ratings','lists','shows','settings','local','meta','tmdb'];
  if (db.objectStoreNames.contains('statistics')) names.push('statistics');
  const tx = db.transaction(names,'readwrite',{durability:'strict'}), meta = tx.objectStore('meta'), local = tx.objectStore('local');
  const record = meta.get('revision'), erase = meta.get('deviceEraseRevision'), owner = local.get('syncAccountId');
  const grant = local.getKey('dropboxSession'), {patch} = job;
  const saved:SavedImport = {id:job.id,expiry:Infinity,exportChanged:false};
  let failure:string|undefined;
  function abort(reason?:string) {
    try { tx.abort(); failure = reason; } catch { /* already settled */ }
  }
  function fail(error:unknown) { abort(error instanceof DOMException ? error.name : undefined); }
  function expired() { return Date.now() >= job.expiresAt; }
  const askToFinish = workerAdmission(meta,expired,abort);
  tx.onabort = () => {
    db.close();
    self.postMessage(failure === 'stale' ? {type:'stale'} : {type:'error',name:failure ?? tx.error?.name});
  };
  tx.oncomplete = () => { db.close(); self.postMessage({type:'complete',result:saved}); };

  function otherRows() {
    for (const table of ['ratings','lists','shows','settings'] as const) {
      const rows = patch.put?.[table] ?? [];
      if (!rows.length) continue;
      const store = tx.objectStore(table);
      for (const row of rows) store.put(row);
      if (table !== 'shows') local.delete(canceledKey(table));
    }
    local.delete(canceledKey('watched'));
    for (const key of patch.removeLocal ?? []) local.delete(key);
    for (const [key,value] of Object.entries(patch.local ?? {})) local.put(value,key);
    const afterCache = importCacheWrites(tx,job.entries,(expiry,partOfExport) => {
      saved.expiry = Math.min(saved.expiry,expiry);
      saved.exportChanged ||= partOfExport;
    },fail);
    afterCache(() => askToFinish(() => {
      meta.put(saved,importReceiptKey);
      meta.put(true,'dropboxDirty');
      statisticsRevision(tx,job.revision+1n);
    }));
  }

  withControl(tx,control => {
    if ((record.result ?? 0n) !== job.revision || (erase.result ?? 0n) !== job.erased || owner.result !== job.accountId ||
        grant.result === undefined || !control.credential || control.refused !== null || control.generation !== job.generation || expired()) return abort('stale');
    writeWorkerWatches(tx.objectStore('watched'),patch.remove?.watched ?? [],patch.put?.watched ?? [],() => !expired(),otherRows,abort);
  });
}
openRecordWorker(save);
