import { observation, planEpisodeRepair, type RepairPreview } from './episode-repair.ts';
import type { WatchedRow } from './model.ts';
import { tmdbResourceKey } from './tmdb-client.ts';
import type { CacheEntry, RepairObservation, TmdbSeason } from './tmdb-data.ts';
import { controlValue, retainedEntry, tmdbControlKey } from './tmdb-store.ts';

export interface ShowEpisodeSnapshot {
  watched:WatchedRow[];
  header:CacheEntry<'show'>|null;
  seasons:Map<number,CacheEntry<'season'>>;
  preview:RepairPreview;
}

/** Repair confirmation and screen progress must see the same episode identities.
 * The callback also runs inside a repair write's active IndexedDB transaction. */
export function readShowEpisodes(tx:IDBTransaction, id:number, now:number, scope:'repair'|'show'|number,
    receive:(snapshot:ShowEpisodeSnapshot)=>void, current?:()=>boolean) {
  const cache = tx.objectStore('tmdb'), meta = tx.objectStore('meta');
  const rows = tx.objectStore('watched').getAll(IDBKeyRange.bound([id],[id,[]]));
  const control = meta.get(tmdbControlKey), revision = meta.get('revision');
  const owner = tx.objectStore('local').get('syncAccountId');
  const parent = cache.get(tmdbResourceKey({kind:'show',id}));
  parent.onsuccess = () => {
    // WebKit can deliver an already queued success after navigation aborted
    // this transaction. Its remaining native requests must not be enqueued.
    if (current && !current()) return;
    const watched:WatchedRow[] = rows.result;
    const header = retainedEntry<CacheEntry<'show'>['value']>(parent.result,now) ?? null;
    const seasons = new Map<number,CacheEntry<'season'>>();
    const identified = watched.some(row=>row.episode_id !== null);
    function finish() {
      const context = {revision:revision.result ?? 0n,generation:controlValue(control.result).generation,accountId:owner.result ?? null};
      if (!identified) {
        receive({watched,header,seasons,preview:{...context,showId:id,moves:[],missing:[]}});
        return;
      }
      const detail = new Map<number,TmdbSeason|null>(), seen = new Map<number,RepairObservation>();
      for (const [number,entry] of seasons) {
        detail.set(number,entry.value);
        seen.set(number,observation(entry));
      }
      const plan = planEpisodeRepair(id,watched,header?.value,detail,{parent:header ? observation(header) : undefined,seasons:seen});
      receive({watched,header,seasons,preview:{...context,...plan}});
    }
    if (identified || scope === 'show' && header?.value?.seasons.length) {
      const prefix = 'tv/'+id+'/season/', range = IDBKeyRange.bound(prefix,prefix+'\uffff');
      const keys = cache.getAllKeys(range), entries = cache.getAll(range);
      entries.onsuccess = () => {
        entries.result.forEach((row,i) => {
          const entry = retainedEntry<TmdbSeason|null>(row,now);
          if (entry) seasons.set(Number(String(keys.result[i]).slice(prefix.length)),entry);
        });
        finish();
      };
    } else if (typeof scope === 'number') {
      const season = cache.get(tmdbResourceKey({kind:'season',id,season:scope}));
      season.onsuccess = () => {
        const entry = retainedEntry<TmdbSeason|null>(season.result,now);
        if (entry) seasons.set(scope,entry);
        finish();
      };
    } else finish();
  };
}
