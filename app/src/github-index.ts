import type {ImdbWrite} from './imdb-store.ts';
import type {MalWrite} from './mal-store.ts';
import {runRecordWorker,type WorkerDatabase} from './record-worker-client.ts';

export type GithubIndex = {source:'mal';write:MalWrite & {replacement:NonNullable<MalWrite['replacement']>}} |
  {source:'imdb';write:ImdbWrite & {replacement:NonNullable<ImdbWrite['replacement']>}};
export type GithubInstall = GithubIndex & {
  id:string;revision:bigint;erased:bigint;accountId:string;expiresAt:number;generation:bigint;
};
export interface GithubInstallation {id:string;pauseChanged:boolean}

export function installGithubIndex(database:WorkerDatabase, prepare:()=>Promise<GithubInstall>, closing:AbortSignal,
    current:()=>boolean, stale:()=>Error) {
  return runRecordWorker<GithubInstall,GithubInstallation>(
    () => new Worker(new URL('./github-index-worker.js',import.meta.url),{type:'module'}),database,prepare,closing,stale,current);
}
