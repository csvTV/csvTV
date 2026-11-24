import {openRecordWorker,workerAdmission,writeWorkerWatches} from './record-worker-server.ts';
import {canceledKey,statisticsRevision,watchEditReceiptKey} from './record-transaction.ts';
import {withControl} from './tmdb-store.ts';
import type {ManualWatchWrite} from './watch-edit-storage.ts';

function save(db:IDBDatabase, job:ManualWatchWrite) {
  const names = ['watched','settings','local','meta'];
  if (db.objectStoreNames.contains('statistics')) names.push('statistics');
  const tx = db.transaction(names,'readwrite',{durability:'strict'}), meta = tx.objectStore('meta'), local = tx.objectStore('local');
  const revision = meta.get('revision'), erased = meta.get('deviceEraseRevision'), owner = local.get('syncAccountId');
  let failure:string|undefined;
  function abort(reason:string) {
    try { tx.abort(); failure = reason; } catch { /* already settled */ }
  }
  const admit = workerAdmission(meta,()=>false,abort);
  tx.onabort = () => {
    db.close();
    self.postMessage(failure === 'stale' ? {type:'stale'} : {type:'error',name:failure ?? tx.error?.name});
  };
  tx.oncomplete = () => { db.close(); self.postMessage({type:'complete',result:job.id}); };
  function write() {
    if ((revision.result ?? 0n) !== job.revision || (erased.result ?? 0n) !== job.erased ||
        (owner.result ?? null) !== job.owner) return abort('stale');
    writeWorkerWatches(tx.objectStore('watched'),job.remove,job.put,()=>true,() => {
      if (job.recent.length) {
        const settings = tx.objectStore('settings');
        for (const row of job.recent) settings.put(row);
        local.delete(canceledKey('settings'));
      }
      local.delete(canceledKey('watched'));
      if (job.clearLegacy) local.delete('recentlyMarked');
      admit(() => {
        meta.put(job.id,watchEditReceiptKey);
        meta.put(true,'dropboxDirty');
        statisticsRevision(tx,job.revision+1n);
      });
    },abort);
  }
  if (job.generation === undefined) owner.onsuccess = write;
  else withControl(tx,control => {
    if (!control.credential || control.refused !== null || control.generation !== job.generation) abort('stale');
    else write();
  });
}
openRecordWorker(save);
