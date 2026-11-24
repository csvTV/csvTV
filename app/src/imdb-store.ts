import type { SettingRow } from './model.ts';

export const imdbSettings = ['imdb_source', 'omdb_key', 'github_repo', 'github_token'] as const;
export type ImdbSetting = typeof imdbSettings[number];
export type ImdbSource = 'none' | 'omdb' | 'github';
export type ImdbConfiguration = Record<ImdbSetting, string | null>;
export interface ImdbPause { kind:'refused'|'throttled'; until:number | null; message:string; strikes?:number }
export interface FileInfo { digest:string; fetchedAt:number; firstAt:number; showCount:number; episodeCount:number }
export interface ImdbControl {
  generation:bigint; configGeneration:bigint; githubGeneration:bigint; file:FileInfo | null; needsFile:boolean; fileError:string | null;
  omdbPause:ImdbPause | null; githubPause:ImdbPause | null;
}
export interface ImdbState extends ImdbControl { config:ImdbConfiguration; revision:bigint }
export interface ImdbDisplayState extends Pick<ImdbControl,'generation'|'configGeneration'|'file'> {
  source:ImdbSource; pause:ImdbPause|null; imdbId?:string|null;
}
export const sourcePause = (source:ImdbSource,control:Pick<ImdbControl,'githubPause'|'omdbPause'>) =>
  source === 'github' ? control.githubPause : source === 'omdb' ? control.omdbPause : null;
export interface ImdbWrite {
  entries?: [IDBValidKey, unknown][]; deleteFileData?:boolean; expectedDigest?:string;
  replacement?:{bytes:ArrayBuffer; buckets:Map<number,Map<number,number>>};
  removeLegacyEpisodesFor?: number;
  update?:Partial<Omit<ImdbControl,'generation'|'configGeneration'>>;
  quota?: { provider:'omdb'|'github'; hash:string; pause:ImdbPause | null };
  silent?:boolean;
}
export const imdbControlKey = 'imdb-control';
export const imdbCacheKey = (...parts:(string|number)[]): IDBValidKey => ['imdb',...parts];
export const imdbRange = (...parts:string[]) => IDBKeyRange.bound(['imdb',...parts], ['imdb',...parts,[]]);
export const imdbQuotaKey = (provider:string, hash:string):IDBValidKey => ['imdb-quota',provider,hash];
export const githubInstallationKey = (source:'mal'|'imdb'):IDBValidKey => ['github-index-installation',source];
export function* imdbIndexRows({bytes,buckets}:NonNullable<ImdbWrite['replacement']>):Generator<[IDBValidKey,unknown]> {
  yield [imdbCacheKey('github','file'),bytes];
  for (const [bucket,scores] of buckets) yield [imdbCacheKey('github','shows',bucket),scores];
}
export function saveRatingQuota(meta:IDBObjectStore, quota:NonNullable<ImdbWrite['quota']>) {
  const key = imdbQuotaKey(quota.provider,quota.hash);
  if (quota.pause?.kind === 'throttled') meta.put(quota.pause,key);
  else meta.delete(key);
}
export function saveImdbControl(meta:IDBObjectStore, control:ImdbControl, write:ImdbWrite) {
  if (write.update) meta.put({...control,...write.update},imdbControlKey);
  if (write.quota) saveRatingQuota(meta,write.quota);
  return write.update?.githubPause !== undefined && (!!control.githubPause || !!write.update.githubPause);
}
export const defaultImdbControl = (value?:ImdbControl):ImdbControl => value ?
  {...value,configGeneration:value.configGeneration ?? value.generation,githubGeneration:value.githubGeneration ?? 0n} :
  {generation:0n, configGeneration:0n, githubGeneration:0n, file:null, needsFile:true, fileError:null, omdbPause:null, githubPause:null};
export function imdbConfig(rows:SettingRow[]):ImdbConfiguration {
  const config:ImdbConfiguration = {imdb_source:null, omdb_key:null, github_repo:null, github_token:null};
  for (const row of rows) if (Object.hasOwn(config, row.setting)) config[row.setting as ImdbSetting] = row.value;
  return config;
}
export function imdbSource(config:Pick<ImdbConfiguration,'imdb_source'>):ImdbSource {
  return config.imdb_source === 'omdb' || config.imdb_source === 'github' ? config.imdb_source : 'none';
}

/** Enqueue the old settings read before any file replacement or individual edits.
 * All sync/restore/UI edits thus invalidate earlier requests in the same commit. */
export function changeImdbConfig(tx:IDBTransaction, edits:Partial<Pick<ImdbConfiguration,'github_repo'|'imdb_source'>>,
    changed:(activeChanged:boolean)=>void) {
  const meta = tx.objectStore('meta');
  const settings = tx.objectStore('settings').getAll();
  const request = meta.get(imdbControlKey);
  request.onsuccess = () => {
    const old = imdbConfig(settings.result);
    const next = {...old, ...edits};
    if (imdbSettings.every(name => old[name] === next[name])) return;
    const control = defaultImdbControl(request.result);
    const switched = old.imdb_source !== next.imdb_source;
    const source = imdbSource(next);
    const githubChanged = old.github_repo !== next.github_repo;
    const activeChanged = switched || (source === 'github' && githubChanged);
    // Edits always fence the Settings editor. Only changes to the active provider
    // can release its queue; a late 429 for an unchanged credential still applies.
    control.configGeneration++;
    if (githubChanged) control.githubGeneration++;
    if (activeChanged) control.generation++;
    if (switched) {
      tx.objectStore('cache').delete(imdbRange());
      control.file = null;
    }
    if (old.github_repo !== next.github_repo && control.githubPause?.kind === 'refused') control.githubPause = null;
    if (switched || githubChanged) {
      control.needsFile = true;
      control.fileError = null;
    }
    meta.put(control, imdbControlKey);
    changed(activeChanged);
  };
}
