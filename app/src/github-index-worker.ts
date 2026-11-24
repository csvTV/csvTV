import {openRecordWorker,workerAdmission} from './record-worker-server.ts';
import {statisticsCacheChanged} from './record-transaction.ts';
import {defaultImdbControl,githubInstallationKey,imdbControlKey,imdbIndexRows,imdbRange,saveImdbControl} from './imdb-store.ts';
import {malControl,malControlKey,malIndexRows,malRange,saveMalControl} from './mal-store.ts';
import type {GithubInstall} from './github-index.ts';

function install(db:IDBDatabase, job:GithubInstall) {
  const stores = ['cache','meta','local'];
  if (db.objectStoreNames.contains('statistics')) stores.push('statistics');
  const tx = db.transaction(stores,'readwrite',{durability:'strict'});
  const meta = tx.objectStore('meta'), local = tx.objectStore('local'), cache = tx.objectStore('cache');
  const revision = meta.get('revision'), erased = meta.get('deviceEraseRevision'), owner = local.get('syncAccountId');
  const grant = local.getKey('dropboxSession'), shared = meta.get(imdbControlKey);
  const own = job.source === 'mal' ? meta.get(malControlKey) : shared;
  const saved = {id:job.id,pauseChanged:false}, expired = () => Date.now() >= job.expiresAt;
  let failure:string|undefined;
  function abort(reason:string) { try { tx.abort(); failure = reason; } catch { /* already closed */ } }
  const beforeCommit = workerAdmission(meta,expired,abort);
  tx.onabort = () => {
    db.close();
    self.postMessage(failure === 'stale' ? {type:'stale'} : {type:'error',name:failure ?? tx.error?.name});
  };
  tx.oncomplete = () => { db.close(); self.postMessage({type:'complete',result:saved}); };
  own.onsuccess = () => {
    if ((own.result?.generation ?? 0n) !== job.generation || (erased.result ?? 0n) !== job.erased || (revision.result ?? 0n) !== job.revision ||
        grant.result === undefined || owner.result !== job.accountId || expired()) return abort('stale');
    const rows = job.source === 'mal' ? malIndexRows(job.write.replacement) : imdbIndexRows(job.write.replacement);
    cache.delete(job.source === 'mal' ? malRange() : imdbRange('github'));
    function batch() {
      try {
        if (expired()) return abort('stale');
        let pending:IDBRequest|undefined;
        for (let i=0;i<512;i++) {
          const next = rows.next();
          if (next.done) break;
          pending = cache.put(next.value[1],next.value[0]);
        }
        if (pending) pending.onsuccess = () => { self.postMessage({type:'progress'}); batch(); };
        else beforeCommit(() => {
          saved.pauseChanged = job.source === 'mal' ? saveMalControl(meta,malControl(own.result),shared.result,job.write) :
            saveImdbControl(meta,defaultImdbControl(shared.result),job.write);
          meta.put(saved,githubInstallationKey(job.source));
          statisticsCacheChanged(tx,'scoresVersion');
        });
      } catch (error) { abort(error instanceof DOMException ? error.name : 'UnknownError'); }
    }
    batch();
  };
}
openRecordWorker(install);
