import type { SettingRow } from './model.ts';
import type { FileSyncState } from './storage.ts';
import { readCsv, writeCsv } from './csv.ts';
import { withControl, tmdbControlKey } from './tmdb-store.ts';
import { mdbListControl, mdbListControlKey, quotaKey } from './mdblist-store.ts';
import { defaultImdbControl, imdbControlKey, imdbQuotaKey, imdbRange } from './imdb-store.ts';
import { malControl, malControlKey } from './mal-store.ts';

export const providerKeys = ['tmdb_key', 'mdblist_key', 'omdb_key', 'github_token'] as const;
export type ProviderKey = typeof providerKeys[number];
export type ProviderHashes = Partial<Record<ProviderKey,string>>;
export interface ProviderSession { accountId:string; instanceId:string; signInDeadline:number }
export type ProviderKeySave = (key:ProviderKey, expected:string|null, next:string|null, current:()=>boolean,
  installed:Promise<void>)=>Promise<readonly SettingRow[]>;
export function isProviderKey(name:string):name is ProviderKey {
  return providerKeys.some(key => key === name);
}

export function publicSettings(rows:readonly SettingRow[]):SettingRow[] {
  return rows.filter(row => !isProviderKey(row.setting));
}

/** A malformed legacy snapshot may contain a credential in any column. Only expose canonical known rows. */
function publicContent(content:string):string {
  const parsed = readCsv('settings',content);
  if (!parsed.stopped && !parsed.findings.length && parsed.rows.every(row=>!isProviderKey(row.setting))) return content;
  return writeCsv('settings', publicSettings(parsed.rows));
}

export function publicSettingsSync(file:FileSyncState):FileSyncState {
  const { base, pending, lastClientModified } = file;
  return { lastClientModified, base:base && {revision:base.revision, content:publicContent(base.content)},
    pending:pending && {...pending, content:publicContent(pending.content),
      targetContent:pending.targetContent === null ? null : publicContent(pending.targetContent)} };
}

/** A fresh account lease fences delayed replies even when Dropbox holds the same keys. */
export function applyProviderHashes(tx:IDBTransaction, hashes:ProviderHashes, changed:ProviderKey[], rebound:boolean, checkedTmdb=false):void {
  const meta = tx.objectStore('meta');
  meta.put(hashes,'providerHashes');
  if (rebound || changed.includes('tmdb_key') || checkedTmdb) withControl(tx,c => {
    c.generation++; c.submission++;
    if (checkedTmdb || c.credential !== (hashes.tmdb_key ?? null)) c.refused = null;
    c.credential = hashes.tmdb_key ?? null;
    meta.put(c,tmdbControlKey);
  });
  if (rebound || changed.includes('mdblist_key')) {
    const mdb = meta.get(mdbListControlKey);
    const quota = hashes.mdblist_key ? meta.get(quotaKey(hashes.mdblist_key)) : null;
    (quota ?? mdb).onsuccess = () => {
      const c = mdbListControl(mdb.result);
      c.generation++;
      if (changed.includes('mdblist_key')) {
        c.pause = quota?.result ?? null;
        if (!hashes.mdblist_key) tx.objectStore('cache').delete(IDBKeyRange.bound(['mdblist'],['mdblist',[]]));
      }
      meta.put(c,mdbListControlKey);
    };
  }
  const omdb = changed.includes('omdb_key'), github = changed.includes('github_token');
  if (!rebound && !omdb && !github) return;
  const imdb = meta.get(imdbControlKey), mal = meta.get(malControlKey);
  const omdbQuota = hashes.omdb_key ? meta.get(imdbQuotaKey('omdb',hashes.omdb_key)) : null;
  const githubQuota = hashes.github_token ? meta.get(imdbQuotaKey('github',hashes.github_token)) : null;
  const source = tx.objectStore('settings').get('imdb_source');
  source.onsuccess = () => {
    const c = defaultImdbControl(imdb.result);
    c.configGeneration++;
    if (rebound || source.result?.value === 'github' && github || source.result?.value === 'omdb' && omdb) c.generation++;
    if (omdb) {
      c.omdbPause = omdbQuota?.result ?? null;
      if (!hashes.omdb_key && source.result?.value === 'omdb') tx.objectStore('cache').delete(imdbRange('omdb'));
    }
    if (rebound || github) {
      c.githubGeneration++;
      const m = malControl(mal.result);
      m.generation++;
      if (github) {
        c.githubPause = githubQuota?.result ?? null;
        c.fileError = null; c.needsFile = true;
        m.fileError = null; m.needsFile = true;
      }
      meta.put(m,malControlKey);
    }
    meta.put(c,imdbControlKey);
  };
}
