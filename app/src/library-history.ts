import { isAnime } from './anime.ts';
import type { OverviewShow, overviewWithCache, readOverviewCache } from './record-overview.ts';
import type { DeviceStore, RecordStamp } from './storage.ts';
import { cacheExpiresAt } from './tmdb-refresh.ts';
import { localCalendarDate } from './progress.ts';

type CardProgress = Pick<OverviewShow['progress'],'recordedEpisodes'|'watchedAired'|'aired'|'complete'|'moreToWatch'>;
export type LibraryShow = Pick<OverviewShow,'id'|'title'|'posterPath'|'rating'|'lists'|'missing'> & {
  progress: CardProgress;
  metadata: { keywords?: readonly { name:string }[]; originCountries?: readonly string[] } | null;
};
export type LibraryOverview = Omit<ReturnType<typeof overviewWithCache>,'shows'> & {shows:LibraryShow[]};
export interface LibraryPreview {stamp:RecordStamp; overview:LibraryOverview; from:number; until:number}
type Metadata = Awaited<ReturnType<typeof readOverviewCache>>;

// Only these two public metadata facts affect Library category membership.
const animeKeywords = [{name:'anime'}];
const koreanOrigin = ['KR'];

function displayCards(overview: ReturnType<typeof overviewWithCache>): LibraryOverview | undefined {
  if (overview.shows.length > 1024) return;
  const {config,listNames} = overview;
  let labels = listNames.length + (config?.posterSizes.length ?? 0);
  if (labels > 4096) return;
  let text = listNames.reduce((total,name)=>total+name.length,0) + (config?.secureBaseUrl.length ?? 0);
  for (const size of config?.posterSizes ?? []) text += size.length;
  const shows:LibraryShow[] = [];
  for (const {id,title,posterPath,rating,lists,missing,metadata,progress} of overview.shows) {
    labels += lists.length;
    if (labels > 4096) return;
    text += title.length + (posterPath?.length ?? 0);
    for (const name of lists) text += name.length;
    if (text > 262144) return;
    const {recordedEpisodes,watchedAired,aired,complete,moreToWatch} = progress;
    shows.push({id,title,posterPath,rating,lists,missing,progress:{recordedEpisodes,watchedAired,aired,complete,moreToWatch},
      metadata:metadata && {keywords:isAnime({metadata,lists}) ? animeKeywords : undefined,
        originCountries:metadata.originCountries?.includes('KR') ? koreanOrigin : undefined}});
  }
  if (text > 262144) return;
  return {...overview,shows,config:config && {secureBaseUrl:config.secureBaseUrl,posterSizes:config.posterSizes,
    backdropSizes:[],profileSizes:[],stillSizes:[]}};
}

function validUntil(now:number, cache:Metadata) {
  const day = new Date(now);
  day.setHours(24,0,0,0);
  let until = day.getTime();
  const times = new Set<number>();
  if (cache.configFetchedAt !== undefined) times.add(cache.configFetchedAt);
  for (const rows of [cache.details,cache.seasons]) for (const entry of rows.values()) if (entry) times.add(entry.fetchedAt);
  for (const fetched of times) until = Math.min(until,cacheExpiresAt(fetched));
  return until;
}

function sameRecord(a:RecordStamp,b:RecordStamp) {
  return a.revision === b.revision && a.account === b.account && a.erased === b.erased;
}

/** One completed Library visit supplies a bounded card preview while the new visit rereads its inputs. */
export function createLibraryHistory(store:DeviceStore, signal:AbortSignal) {
  let generation = 0;
  let saved:LibraryPreview|undefined;
  function clear() { generation++; saved = undefined; }
  for (const event of ['recordchange','exportchange','cachechange','tmdbmetadata','tmdbstatechange','dropboxchange',
    'deviceerased','rolechange','providerkeyschange']) store.addEventListener(event,clear,{signal});
  signal.addEventListener('abort',clear,{once:true});
  return {
    get generation() { return generation; },
    get available() { return saved !== undefined; },
    read(now:number, stamp:RecordStamp|undefined) {
      const prior = saved;
      if (!prior) return;
      if (stamp && store.role === 'writer' && !signal.aborted && prior.from <= now && now < prior.until &&
          prior.overview.today === localCalendarDate(new Date(now)) && sameRecord(stamp,prior.stamp)) return prior;
      clear();
    },
    save(expected:number, stamp:RecordStamp, view:ReturnType<typeof overviewWithCache>, cache:Metadata, now:number) {
      if (generation !== expected || store.role !== 'writer' || signal.aborted) return;
      saved = undefined;
      if (!cache.readable || !view.shows.length) return;
      const overview = displayCards(view);
      if (overview) saved = {stamp,overview,from:now,until:validUntil(now,cache)};
    },
    clear,
  };
}
