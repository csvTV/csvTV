import {openRecordWorker,workerAdmission,writeWorkerWatches} from './record-worker-server.ts';
import type {WatchDownload} from './watch-download.ts';
import {canceledKey,matchesDownloadBase,resetWatchLocalKeys,statisticsRevision,watchResetGuard} from './record-transaction.ts';
import {invalidateTmdbWork} from './tmdb-store.ts';

/** The reviewed watches, new remote receipt and report revisions change together. */
function install(db: IDBDatabase, download: WatchDownload) {
  const stores = ['watched','sync','local','meta'];
  if (db.objectStoreNames.contains('statistics')) stores.push('statistics');
  const tx = db.transaction(stores,'readwrite',{durability:'strict'});
  const watched = tx.objectStore('watched'), meta = tx.objectStore('meta'), local = tx.objectStore('local'), sync = tx.objectStore('sync');
  const revision = meta.get('revision'), erased = meta.get('deviceEraseRevision'), owner = local.get('syncAccountId');
  const grant = local.getKey('dropboxSession'), count = watched.count();
  const currentReset = watchResetGuard(tx,download.reset), receipt = sync.get('watched');
  let failure: string|undefined;
  function abort(reason:string) {
    try { tx.abort(); failure = reason; } catch { /* already settled */ }
  }
  const expired = () => Date.now() >= download.expiresAt;
  tx.onabort = () => {
    db.close();
    self.postMessage(failure === 'stale' ? {type:'stale'} : {type:'error',name:failure ?? tx.error?.name});
  };
  tx.oncomplete = () => { db.close(); self.postMessage({type:'complete'}); };
  receipt.onsuccess = () => {
    // Signing in or out advances the record revision. Erasure also has its own generation.
    if ((revision.result ?? 0n) !== download.revision || (erased.result ?? 0n) !== download.erased ||
        owner.result !== download.accountId || grant.result === undefined ||
        !matchesDownloadBase(count.result,receipt.result,download.prior) || !currentReset() || expired()) return abort('stale');
    const admit = (download.prior || download.reset) && workerAdmission(meta,expired,abort);
    function finish() {
      if (download.reset) {
        local.put(download.reset.after,'dropboxResetSeen');
        for (const name of resetWatchLocalKeys) local.delete(name);
        if (download.reset.initializeSettings) sync.put({base:null,pending:null,lastClientModified:null},'settings');
        invalidateTmdbWork(tx);
      }
      sync.put(download.receipt,'watched');
      local.delete(canceledKey('watched'));
      meta.put(true,'dropboxDirty');
      statisticsRevision(tx,download.revision+1n);
    }
    if (download.remove) {
      if (!download.prior || !admit) return abort('stale');
      writeWorkerWatches(watched,download.remove,download.rows,()=>!expired(),()=>admit(finish),abort);
      return;
    }
    if (download.prior) watched.clear();
    let index = 0;
    function batch() {
      try {
        if (expired()) return abort('stale');
        if (index === download.rows.length) {
          if (admit) admit(finish);
          else finish();
          return;
        }
        const end = Math.min(index+512,download.rows.length);
        let last: IDBRequest;
        while (index < end) last = watched.add(download.rows[index++]);
        last!.onsuccess = () => { self.postMessage({type:'progress'}); batch(); };
      } catch { tx.abort(); }
    }
    batch();
  };
}

openRecordWorker(install);
