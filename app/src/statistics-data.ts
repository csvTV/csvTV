import type { WatchedRow } from './model.ts';
import type { StatisticsCacheVersions, StatisticsMetadataChange } from './record-transaction.ts';
import type { ShowRatings } from './critic-marks.ts';
import { projectShowRecords, seasonKeysForShows, watchedSeasonKeys } from './record-overview.ts';
import { localCalendarDate } from './progress.ts';
import type { StatisticsInput } from './statistics.ts';
import type { ImdbHeaders } from './storage.ts';
import { tmdbResourceKey } from './tmdb-client.ts';
import type { TmdbDataByKind, TmdbSeason, TmdbShow } from './tmdb-data.ts';
import { cacheExpired, cacheExpiresAt } from './tmdb-refresh.ts';
import type { TmdbService } from './tmdb-service.ts';
import type { TmdbCacheEntry } from './tmdb-store.ts';

export function affectsStatisticsScores(event:Event):boolean {
  return (event as CustomEvent<{statisticsUnchanged?:boolean}>).detail?.statisticsUnchanged !== true;
}

interface RecordValidity { from:number; until:number; day:string }
interface SavedStatistics extends RecordValidity, StatisticsCacheVersions {
  input:StatisticsInput;
  scores?:ShowRatings;
  scoresCurrent:boolean;
  revision:bigint;
  changedMetadata?:{version:string;keys:Set<string>};
}

function currentDay(period:RecordValidity, now:number) {
  return now >= period.from && now < period.until && localCalendarDate(new Date(now)) === period.day;
}

/** A single completed projection for this app instance. It contains display data only. */
export function createStatisticsHistory(service: TmdbService, signal: AbortSignal) {
  let generation = 0;
  let latestVisit = 0;
  let saved:SavedStatistics|undefined;
  function clear() { generation++; saved = undefined; }
  // exportchange also covers watch, rating and membership commits in another tab.
  for (const event of ['exportchange','cachechange','tmdbstatechange','rolechange','deviceerased','dropboxchange',
    'providerkeyschange','ratingscredentialschange','imdbconfigchange','malconfigchange']) {
    service.store.addEventListener(event,clear,{signal});
  }
  service.store.addEventListener('tmdbmetadata',event=>{
    const change = (event as CustomEvent<{statisticsChange?:StatisticsMetadataChange}>).detail?.statisticsChange;
    if (!saved || !change || service.store.role!=='writer' || (saved.changedMetadata?.version ?? saved.metadataVersion)!==change.previous) {
      clear();
      return;
    }
    const keys = new Set(saved.changedMetadata?.keys).add(change.key);
    if (keys.size>128) { clear(); return; }
    generation++;
    saved = {...saved,changedMetadata:{version:change.version,keys}};
  },{signal});
  // A background score refresh does not change watches, episode runtimes or cast.
  // Replace the entry so an in-flight revision check cannot accept its old scores.
  function scoresChanged(event:Event) {
    if (!affectsStatisticsScores(event)) return;
    generation++;
    if (saved) saved = {...saved,scores:undefined,scoresCurrent:false};
  }
  for (const event of ['mdblistchange','imdbchange','malchange']) service.store.addEventListener(event,scoresChanged,{signal});
  signal.addEventListener('abort',clear,{once:true});
  return {
    get generation() { return generation; },
    beginVisit() { return ++latestVisit; },
    read(now: number) {
      if (saved && !currentDay(saved,now)) clear();
      return saved;
    },
    applyCredits(prior:SavedStatistics, state:Awaited<ReturnType<TmdbService['store']['statisticsState']>>, cache:ReturnType<typeof createStatisticsCache>) {
      const changed = prior.changedMetadata, byKey = state.creditEntries;
      if (!changed || !byKey || saved!==prior || service.store.role!=='writer' || !state.writerLease || state.writerLease!==prior.writerLease ||
          state.revision!==prior.revision || state.metadataVersion!==changed.version || !currentDay(prior,service.environment.now()) ||
          byKey.size!==changed.keys.size || [...changed.keys].some(key=>!byKey.has(key))) return;
      const countryKey=tmdbResourceKey({kind:'countries'});
      const shows=prior.input.shows.map(show=>{
        const key=tmdbResourceKey({kind:'cast',id:show.id});
        return byKey.has(key) ? {...show,cast:(byKey.get(key)?.value as TmdbDataByKind['cast']|null) ?? null} : show;
      });
      const countries=byKey.has(countryKey) ? (byKey.get(countryKey)?.value as TmdbDataByKind['countries']|null) ?? [] : prior.input.countries;
      let until=prior.until;
      for (const [key,entry] of byKey) {
        if (entry) { until=Math.min(until,cacheExpiresAt(entry.fetchedAt)); cache.entries.set(key,entry); }
        else cache.entries.delete(key);
      }
      saved={...prior,input:{shows,countries},metadataVersion:changed.version,until,changedMetadata:undefined};
      return saved;
    },
    saveRecord(visit: number, expected: number, input: StatisticsInput, revision: bigint, period: RecordValidity,
      comparisons?: Pick<ShowRatings,'critics'|'mal'>, versions?:StatisticsCacheVersions) {
      if (visit === latestVisit && generation === expected && !signal.aborted &&
          (service.store.role === 'writer' || typeof BroadcastChannel !== 'undefined')) {
        saved = {input:{shows:input.shows,countries:input.countries},scores:comparisons,scoresCurrent:false,revision,...period,
          metadataVersion:versions?.metadataVersion,scoresVersion:versions?.scoresVersion,writerLease:versions?.writerLease};
        return saved.input;
      }
    },
    completeScores(visit: number, expected: number, input: StatisticsInput, scores: ShowRatings, until: number, now: number) {
      if (visit !== latestVisit || generation !== expected || signal.aborted || saved?.input !== input) return false;
      const deadline = Math.min(saved.until,until);
      if (!currentDay(saved,now) || now >= deadline) return false;
      saved = {...saved,scores,scoresCurrent:true,until:deadline};
      return true;
    },
    clear,
  };
}

/** Stable IDs follow a known move. For older rows, only trust an unclaimed, unreused slot. */
function matchRuntimes(rows: readonly WatchedRow[], seasons: readonly (TmdbSeason | null | undefined)[]) {
  const byId = new Map<number, number | null>();
  const byPosition = new Map<string, number>();
  const claimed = new Set<number>();
  const ambiguous = new Set<number>();
  for (const { episode_id } of rows) {
    if (episode_id === null) continue;
    if (claimed.has(episode_id)) ambiguous.add(episode_id);
    claimed.add(episode_id);
  }
  for (const season of seasons) {
    if (!season) continue;
    const reused = new Set(season.reusedPositions);
    for (const episode of season.episodes) {
      const id = episode.episode_id;
      byId.set(id, byId.has(id) ? null : episode.runtime);
      if (!reused.has(episode.episode) && !claimed.has(id)) {
        byPosition.set(season.season + '/' + episode.episode, id);
      }
    }
  }
  return rows.map(row => {
    const id = row.episode_id ?? byPosition.get(row.season + '/' + row.episode);
    return { row, runtime: id === undefined || ambiguous.has(id) ? null : byId.get(id) ?? null };
  });
}

/** Kept by one mounted screen. Each record refresh supersedes older cache replies. */
export function createStatisticsCache() {
  let work: AbortController | undefined;
  return { entries: new Map<string,TmdbCacheEntry>(), generation: 0,
    begin() { this.generation++; work?.abort(); work = new AbortController(); return work.signal; },
    clear() { this.generation++; work?.abort(); work = undefined; this.entries.clear(); } };
}

export async function readStatisticsRecord(service: TmdbService, cache = createStatisticsCache()) {
  const signal = cache.begin();
  const generation = cache.generation;
  const tables = await service.store.overviewRows('statistics',signal).catch(error => {
    if (generation === cache.generation) cache.clear();
    throw error;
  });
  const ids = [...new Set(tables.watched.map(row => row.show_id))];
  const now = service.environment.now();
  const today = localCalendarDate(new Date(now));
  const showKeys = ids.map(id => tmdbResourceKey({kind:'show',id}));
  const castKeys = ids.map(id => tmdbResourceKey({kind:'cast',id}));
  const countryKey = tmdbResourceKey({kind:'countries'});
  const entries = new Map<string,TmdbCacheEntry>();
  function retain(keys: readonly string[]) {
    for (const key of keys) {
      const prior = cache.entries.get(key);
      if (prior && !cacheExpired(prior.fetchedAt,now)) entries.set(key,prior);
    }
  }
  function entry<T>(key: string) { return entries.get(key) as TmdbCacheEntry<T> | undefined; }
  function titles() {
    return new Map(ids.map((id,i) => [id, entry<TmdbShow | null>(showKeys[i])]));
  }
  retain([...showKeys,...castKeys]);
  if (ids.length) retain([countryKey, ...seasonKeysForShows(titles())]);
  if (generation === cache.generation) cache.entries = entries;

  function project() {
    const details = titles();
    const seasons = new Map(seasonKeysForShows(details).map(key => [key,entry<TmdbSeason | null>(key)]));
    return projectShowRecords(tables,ids,today,{details,seasons}).map(({show,rows,seasonDetails}) => ({
      ...show, episodes:seasonDetails.some(Boolean) ? matchRuntimes(rows,seasonDetails) : rows.map(row => ({row,runtime:null})),
    }));
  }
  let shows = project();
  let publishHeaders: ((value: ImdbHeaders | undefined) => void) | undefined;
  const imdbHeaders = ids.length >= 16 ? new Promise<ImdbHeaders | undefined>(resolve=>{ publishHeaders = resolve; }) : undefined;
  function snapshot(): StatisticsInput {
    return {shows:shows.map((show,i) => ({...show,cast:entry<TmdbDataByKind['cast']>(castKeys[i])?.value ?? null})),
      countries:entry<TmdbDataByKind['countries']>(countryKey)?.value ?? []};
  }
  async function loadMetadata(publish: (input: StatisticsInput) => void) {
    let complete = true;
    if (!ids.length || generation !== cache.generation) { publishHeaders?.(undefined); return generation === cache.generation; }
    async function refresh(keys: string[], updateShows = false) {
      if (!keys.length) return;
      const latest = await service.store.tmdbEntries(keys,now,signal).catch(() => { complete = false; return []; });
      if (generation !== cache.generation) return;
      for (const [i,key] of keys.entries()) {
        const next = latest[i];
        if (next) entries.set(key,next); else entries.delete(key);
      }
      if (updateShows) shows = project();
      publish(snapshot());
    }
    async function refreshTitles() {
      await refresh(showKeys,true);
      if (generation === cache.generation) await refresh(seasonKeysForShows(titles()),true);
    }
    if (imdbHeaders) {
      // In a large record, one exact-key read can group each title with its
      // cast and watched seasons. New season headers can also name seasons
      // absent from the record; include those for completion and moved episodes.
      const known = watchedSeasonKeys(tables.watched);
      try { await refresh([...showKeys,...castKeys,countryKey,...known],true); }
      finally { publishHeaders?.(complete && generation === cache.generation ? titles() : undefined); }
      if (generation === cache.generation) {
        if (complete) await refresh(seasonKeysForShows(titles()).filter(key=>!known.has(key)),true);
        else await Promise.all([refreshTitles(),refresh(castKeys),refresh([countryKey])]);
      }
    } else await Promise.all([refreshTitles(),refresh(castKeys),refresh([countryKey])]);
    return complete && generation === cache.generation;
  }
  function validity():RecordValidity {
    const midnight = new Date(now);
    midnight.setHours(24,0,0,0);
    let deadline = midnight.getTime();
    for (const entry of entries.values()) deadline = Math.min(deadline,cacheExpiresAt(entry.fetchedAt));
    return {from:now,until:deadline,day:today};
  }
  return {input:snapshot(),loadMetadata,validity,revision:tables.revision,imdbHeaders:imdbHeaders && {ready:imdbHeaders,signal}};
}

export async function readStatisticsInput(service: TmdbService): Promise<StatisticsInput> {
  const {input,loadMetadata} = await readStatisticsRecord(service);
  let latest = input;
  await loadMetadata(enriched => { latest = enriched; });
  return latest;
}
