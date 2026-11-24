import type { SettingRow } from './model.ts';
import { defaultImdbControl, imdbControlKey, saveRatingQuota, type ImdbControl, type ImdbPause } from './imdb-store.ts';
import type { GithubQuota } from './github-file-refresh.ts';
import type { MalEntry } from './mal-file.ts';

export const malSettings = ['mal_source','github_repo','github_token'] as const;
export type MalSetting = typeof malSettings[number];
export type MalConfiguration = Record<MalSetting,string|null>;
export interface MalFileInfo { digest:string; fetchedAt:number; firstAt:number; entryCount:number }
export interface MalControl {
  generation:bigint; file:MalFileInfo|null; fileError:string|null; needsFile:boolean;
}
export interface MalState extends MalControl { config:MalConfiguration; revision:bigint; githubGeneration:bigint; githubPause:ImdbPause|null }
export interface MalWrite {
  update:Partial<Omit<MalControl,'generation'>>;
  replacement?:{bytes:ArrayBuffer; shows:Map<number,MalEntry[]>};
  githubPause?:ImdbPause|null;
  quota?:GithubQuota;
}
export const malControlKey = 'mal-control';
export const malFileKey = ['mal','file'];
export const malShowKey = (show:number) => ['mal','show',show];
export const malRange = () => IDBKeyRange.bound(['mal'],['mal',[]]);
export function* malIndexRows({bytes,shows}:NonNullable<MalWrite['replacement']>):Generator<[IDBValidKey,unknown]> {
  yield [malFileKey,bytes];
  for (const [show,entries] of shows) yield [malShowKey(show),entries];
}
export const malControl = (value?:MalControl):MalControl => value ??
  {generation:0n, file:null, needsFile:true, fileError:null};
/** File metadata and shared GitHub quota settle in the same transaction as the index. */
export function saveMalControl(meta:IDBObjectStore, before:MalControl, shared:ImdbControl|undefined, write:MalWrite) {
  meta.put({...before,...write.update},malControlKey);
  let pauseChanged = false;
  if (write.githubPause !== undefined) {
    const control = defaultImdbControl(shared);
    pauseChanged = !!control.githubPause || !!write.githubPause;
    if (pauseChanged) meta.put({...control,githubPause:write.githubPause},imdbControlKey);
  }
  if (write.quota) saveRatingQuota(meta,write.quota);
  return pauseChanged;
}
export function malConfig(settings:SettingRow[]):MalConfiguration {
  const config:MalConfiguration = {mal_source:null,github_repo:null,github_token:null};
  for (const row of settings) if (Object.hasOwn(config,row.setting)) config[row.setting as MalSetting] = row.value;
  return config;
}
export function changeMalConfig(tx:IDBTransaction, edits:Partial<Pick<MalConfiguration,'github_repo'|'mal_source'>>, changed:()=>void) {
  const meta = tx.objectStore('meta');
  const rows = tx.objectStore('settings').getAll();
  const request = meta.get(malControlKey);
  request.onsuccess = () => {
    const old = malConfig(rows.result), next = {...old,...edits};
    if (malSettings.every(name => old[name] === next[name])) return;
    const control = malControl(request.result);
    if (old.mal_source !== next.mal_source) {
      tx.objectStore('cache').delete(malRange());
      control.file = null;
    }
    meta.put({...control, generation:control.generation+1n, fileError:null, needsFile:true}, malControlKey);
    changed();
  };
}
