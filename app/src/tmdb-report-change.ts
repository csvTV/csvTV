import { observation } from './episode-repair.ts';
import { tmdbResourceKey } from './tmdb-client.ts';
import { cacheExpiresAt } from './tmdb-refresh.ts';
import type { TmdbSeason, TmdbShow } from './tmdb-data.ts';
import { retainedEntry, type TmdbCacheEntry } from './tmdb-store.ts';

// The provider normalizes public metadata into plain values. Bound the comparison
// so an unusually large response can simply take the ordinary report refresh path.
function sameValue(before:unknown,after:unknown):boolean {
  let remaining = 16_384;
  function equal(a:unknown,b:unknown,depth:number):boolean {
    if (--remaining < 0 || depth > 32) return false;
    if (a === b) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
    if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.length <= remaining &&
      a.every((value,index)=>equal(value,b[index],depth+1));
    if (Object.getPrototypeOf(a) !== Object.prototype || Object.getPrototypeOf(b) !== Object.prototype) return false;
    const keys = Object.keys(a);
    return keys.length <= remaining && keys.length === Object.keys(b).length && keys.every(key=>
      Object.hasOwn(b,key) && equal((a as Record<string,unknown>)[key],(b as Record<string,unknown>)[key],depth+1));
  }
  return equal(before,after,0);
}

function agreeOnAirings(show:TmdbShow,season:number,detail:TmdbSeason|null):boolean {
  return [show.lastAired,show.nextEpisode].every(airing=>{
    if (!airing || airing.season !== season) return true;
    const matches = detail?.episodes?.filter(row=>row.episode === airing.episode);
    return matches?.length === 1 && matches[0].airDate === airing.airDate;
  });
}

/** A timestamp renewal still matters when it changes which observation of an
 * airing wins. All lookups share the same transaction as the replacement. */
export function checkTmdbReportChange(tx:IDBTransaction,key:string,next:TmdbCacheEntry,now:number,
    done:(changed:boolean)=>void):void {
  const cache = tx.objectStore('tmdb');
  const prior = cache.get(key);
  prior.onsuccess = () => {
    const old = retainedEntry(prior.result,now);
    if (!old || next.fetchedAt < old.fetchedAt || next.fetchedAt > now || cacheExpiresAt(next.fetchedAt) < old.expiresAt ||
        !sameValue(old.value,next.value)) return done(true);
    const before = observation(old).at, after = observation(next).at;
    if (before === after) return done(false);
    const tv = /^tv\/(\d+)(?:\/season\/(\d+)|\?append_to_response=keywords,external_ids)$/.exec(key);
    if (!tv) return done(false);
    const id = Number(tv[1]);
    if (tv[2] !== undefined) {
      const number = Number(tv[2]), parent = cache.get(tmdbResourceKey({kind:'show',id}));
      parent.onsuccess = () => {
        const header = retainedEntry<TmdbShow|null>(parent.result,now);
        if (!header?.value || (header.value.lastAired?.season !== number && header.value.nextEpisode?.season !== number)) return done(false);
        const at = observation(header).at;
        done((before < at) !== (after < at) && !agreeOnAirings(header.value,number,next.value as TmdbSeason|null));
      };
      return;
    }
    const show = next.value as TmdbShow|null;
    if (!show) return done(false);
    const numbers = new Set([show.lastAired?.season,show.nextEpisode?.season]
      .filter((n):n is number=>n !== undefined && Number.isSafeInteger(n) && n >= 0));
    let left = numbers.size, changed = false;
    if (!left) return done(false);
    for (const season of numbers) {
      const saved = cache.get(tmdbResourceKey({kind:'season',id,season}));
      saved.onsuccess = () => {
        const entry = retainedEntry<TmdbSeason|null>(saved.result,now);
        if (entry) {
          const at = observation(entry).at;
          changed ||= (at < before) !== (at < after) && !agreeOnAirings(show,season,entry.value);
        }
        if (!--left) done(changed);
      };
    }
  };
}
