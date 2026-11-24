import type { AniListArchive, AniListEntry, AniListNotice } from './anilist-archive.ts';
import { broadcastSeasons, type BroadcastSeason } from './broadcast-seasons.ts';
import { aniListCorrections, verifiedAniListSeries, type AniListCorrection } from './anilist-catalog-corrections.ts';
import { placeAniListRanges } from './anilist-episode-ranges.ts';
import { fetchAniListMapping, type AniListMapping } from './anilist-mapping.ts';
import { forEachImportItem, openImportMetadata, reviewSeasonEpisodes, type ImportLoad, type ImportMetadataOptions } from './import-metadata.ts';
import { watchPosition, type ShowRow, type WatchedRow } from './model.ts';
import { localCalendarDate } from './progress.ts';
import { TmdbError } from './tmdb-client.ts';
import type { CacheEntry, TmdbEpisode, TmdbSeason, TmdbShow } from './tmdb-data.ts';
import type { TmdbService } from './tmdb-service.ts';

export interface AniListPlacement {
  broadcastByShow: Map<number,readonly BroadcastSeason[]>;
  archive: AniListArchive;
  entryRanges: {entryId: number; showId: number; season: number; first: number; last: number}[];
  shows: ShowRow[];
  watched: WatchedRow[];
  entries: { show_id: number; id: number; score: number; status: number; favourite: boolean; targetSeason?: number | null }[];
  notices: AniListNotice[];
  reusedPositions: Set<string>;
  generation: bigint;
  cache: Map<string, CacheEntry & { prior: CacheEntry | null }>;
  seasonOrders?: ReadonlyMap<number,string|undefined>;
  reviewSeasonNumbers: Map<number, readonly number[]>;
  reviewLoadedSeasons: Map<number, ReadonlySet<number>>;
  reviewCandidates: Map<number, readonly WatchedRow[]>;
  reviewAmbiguousIds: Map<number, ReadonlySet<number>>;
  prepareSeason(showId: number, season: number): Promise<void>;
}
type Matched = { entry: AniListEntry; mapping: AniListMapping; correction?: AniListCorrection };
type Options = ImportMetadataOptions & { fetchMapping?: typeof fetch; corrections?: ReadonlyMap<number,AniListCorrection> };
function unavailable(target: AniListPlacement, entry: AniListEntry, kind: AniListNotice['kind'], reason: string) {
  target.notices.push({ kind, entryId: entry.id, anilistId: entry.id, episodes: entry.progress,
    text: 'AniList entry ' + entry.id + ' · ' + reason });
}
function episodeRange(first: number, last: number) {
  return first === last ? 'Episode ' + first : 'Episodes ' + first + '–' + last;
}

async function placeShow(show: TmdbShow, items: Matched[], result: AniListPlacement, load: ImportLoad) {
  const showId = show.show_id, title = show.show, series = { show_id: showId, show: title };
  result.shows.push({ ...series, year: show.firstAirDate ? Number(show.firstAirDate.slice(0, 4)) : null, imdb_id: show.imdbId ?? '' });
  const orderedSeasons = [...show.seasons].sort((a, b) => a.season - b.season);
  const hasRegularSeasons = orderedSeasons.some(s => s.season > 0);
  const seasonNumbers = new Set(orderedSeasons.map(s => s.season));
  const seasons = new Map<number, TmdbSeason | null>();
  let needsReview = false;
  const identities = new Set<number>();
  const repeatedIds = new Set<number>();
  async function seasonEpisodes(season: number) {
    if (!seasons.has(season)) {
      const detail = await load({ kind: 'season', id: showId, season }, show);
      const episodes = detail ? [...detail.episodes].sort((a, b) => a.episode - b.episode) : null;
      seasons.set(season, detail && episodes ? {...detail,episodes} : null);
      for (const episode of episodes ?? []) {
        if (identities.has(episode.episode_id)) repeatedIds.add(episode.episode_id);
        identities.add(episode.episode_id);
      }
      for (const episode of detail?.reusedPositions ?? []) result.reusedPositions.add(watchPosition({ show_id: showId, season, episode }));
    }
    return seasons.get(season)?.episodes ?? null;
  }
  const claims = new Map<string, { row: WatchedRow; sources: { entryId: number; index: number }[] }>();
  function claim(entry: AniListEntry, index: number, season: number, e: TmdbEpisode) {
    const place = watchPosition({ show_id: showId, season, episode: e.episode });
    const old = claims.get(place);
    const source = { entryId: entry.id, index };
    if (old) {
      old.sources.push(source);
      old.row.times_watched = Math.max(old.row.times_watched, entry.repeat + 1);
    } else {
      claims.set(place, { sources: [source], row: { ...series, season, episode: e.episode,
        title: e.title, episode_id: e.episode_id, times_watched: entry.repeat + 1 } });
    }
  }
  function note(entryId: number, kind: AniListNotice['kind'], message: string, episodes = 0, review = false) {
    if (review || kind === 'unknown-status' || kind === 'rewatching') needsReview = true;
    const notice: AniListNotice = {kind,showId,entryId,episodes,text:title + ' · AniList entry ' + entryId + ' · ' + message};
    if (review) notice.review = true;
    result.notices.push(notice);
  }
  for (const { entry, mapping, correction } of items) {
    const destinations = correction && new Set(correction.segments.map(s => s.season));
    const targetSeason = destinations ? (destinations.size === 1 ? correction!.segments[0].season : null) : mapping.season;
    result.entries.push({ show_id: showId, id: entry.id, score: entry.score, status: entry.status,
      favourite: result.archive.favourites.has(entry.id), targetSeason });
    if (entry.status < 0 || entry.status > 3) note(entry.id, 'unknown-status', 'Unrecognized status ' + entry.status + '.');
    if (entry.repeat > 0 && entry.status !== 2) note(entry.id, 'rewatching', 'This entry has repeats and is not marked completed. Progress may cover only the current viewing.');
    if (!entry.progress) continue;
    function gap(first: number, last: number, reason: string, season = targetSeason) {
      if (first > last) return;
      const review = hasRegularSeasons && season !== 0 && mapping.uncertainPlacement !== 'unanchored-supplement';
      note(entry.id, 'unplaced', episodeRange(first,last) + ' · ' + reason, last-first+1, review);
    }
    if (mapping.uncertainPlacement) {
      gap(1, entry.progress, mapping.uncertainPlacement === 'invalid-position' ? 'The mapping has an invalid TMDB season or offset.' :
        mapping.uncertainPlacement === 'series-only' ? 'The series is verified, but this sequel has no verified episode placement.' :
        mapping.uncertainPlacement === 'unanchored-supplement' ? 'The supplemental entry has no mapped TMDB season or episode position.' :
        'Multiple AniList entries share this TMDB show and the mapping gives no starting season for this entry.');
      continue;
    }
    if (correction) {
      await placeAniListRanges(correction.segments, entry.progress,
        async season => seasonNumbers.has(season) ? seasonEpisodes(season) : null,
        (index, season, episode) => claim(entry,index,season,episode), gap);
      continue;
    }
    if (mapping.season === null) {
      // Number by actual regular episodes. The export's offset has no meaning without a season.
      let index = 0;
      let missingSeason: number | undefined;
      for (const { season, episodeCount } of orderedSeasons) {
        if (index >= entry.progress) break;
        if (!season) continue;
        const episodes = (await seasonEpisodes(season))?.filter(e => e.episode > 0) ?? [];
        const incomplete = episodes.length < episodeCount;
        let position = 0;
        for (const e of episodes) {
          // A partial list establishes only its consecutive prefix. A gap must
          // not shift every later AniList position, including the next season.
          if (incomplete && e.episode !== position + 1) break;
          position++;
          claim(entry, ++index, season, e);
          if (index === entry.progress) break;
        }
        if (incomplete && index < entry.progress) {
          missingSeason = season;
          break;
        }
      }
      gap(index + 1, entry.progress, missingSeason === undefined ? 'Past the end of the show’s regular seasons.' :
        'Episode details for season ' + missingSeason + ' are missing. Later positions cannot be determined.');
      continue;
    }
    const season = mapping.season;
    if (!seasonNumbers.has(season)) { gap(1, entry.progress, 'TMDB has no season ' + season + ' for this show.'); continue; }
    if (season === 0 && mapping.offset === null) { gap(1, entry.progress, 'The specials entry has no episode offset.'); continue; }
    const episodes = await seasonEpisodes(season);
    if (!episodes) { gap(1, entry.progress, 'TMDB did not return season ' + season + '.'); continue; }
    const offset = mapping.offset ?? 0;
    let previous = 0;
    for (const episode of episodes) {
      const index = episode.episode - offset;
      if (index <= 0) continue;
      if (index > entry.progress) break;
      gap(previous + 1, index - 1, 'Missing from TMDB season ' + season + '.');
      claim(entry, index, season, episode);
      previous = index;
    }
    const lastInSeason = Math.min(entry.progress, (episodes.at(-1)?.episode ?? 0) - offset);
    gap(previous + 1, lastInSeason, 'Missing from TMDB season ' + season + '.');
    gap(Math.max(previous, lastInSeason) + 1, entry.progress, 'Past the end of season ' + season + '.');
  }
  const lastRange = new Map<number, AniListPlacement['entryRanges'][number]>();
  const orderedClaims = [...claims.values()].sort((a, b) => a.row.season - b.row.season || a.row.episode - b.row.episode);
  for (const { row, sources } of orderedClaims) {
    const position = 'S' + row.season + ' E' + row.episode;
    if (repeatedIds.has(row.episode_id!)) {
      for (const source of sources) note(source.entryId, 'unplaced',
        'Episode ' + source.index + ' · TMDB lists the episode ID for ' + position + ' in multiple seasons.', 1, row.season > 0);
      continue;
    }
    result.watched.push(row);
    for (const {entryId} of sources) {
      const range = lastRange.get(entryId);
      if (range && range.season === row.season && range.last === row.episode - 1) range.last = row.episode;
      else {
        const next = {entryId, showId, season:row.season, first:row.episode, last:row.episode};
        result.entryRanges.push(next);
        lastRange.set(entryId, next);
      }
    }
    if (sources.length > 1) {
      needsReview = true;
      result.notices.push({kind: 'overlap', showId, episodes: 1, text: title + ' · ' + position + ' is claimed by AniList entries ' +
        sources.map(source => source.entryId).join(', ') + '. Using the higher count, ' + row.times_watched + '×.'});
    }
  }
  return needsReview ? seasons : undefined;
}

export async function resolveAniList(archive: AniListArchive, service: TmdbService, options: Options = {}): Promise<AniListPlacement> {
  const session = await openImportMetadata(service, 'AniList', options);
  const today = localCalendarDate(new Date(service.environment.now()));
  const review = new Map<number, {show: TmdbShow; seasons: Map<number, TmdbSeason | null>}>();
  function indexReview(show: TmdbShow, seasons: Map<number, TmdbSeason | null>) {
    const id = show.show_id, {candidates, ambiguousIds, loadedSeasons} = reviewSeasonEpisodes(show,seasons,today);
    result.reviewLoadedSeasons.set(id, loadedSeasons);
    result.reviewCandidates.set(id, candidates);
    result.reviewAmbiguousIds.set(id, ambiguousIds);
  }
  const result: AniListPlacement = { archive, entryRanges: [], shows: [], watched: [], entries: [], notices: [...archive.notices],
    generation: session.generation, cache: session.cache, seasonOrders:session.seasonOrders, reusedPositions: new Set(), reviewSeasonNumbers:new Map(),
    reviewLoadedSeasons:new Map(), reviewCandidates:new Map(), reviewAmbiguousIds:new Map(), broadcastByShow:new Map(),
    async prepareSeason(id, displaySeason) {
      const season = result.broadcastByShow.get(id)?.find(r => r.number === displaySeason)?.sourceSeason ?? displaySeason;
      const entry = review.get(id);
      if (!entry) throw Error('Season unavailable for this import.');
      const detail = await session.reviewSeason(entry.show, season);
      entry.seasons.set(season, detail);
      for (const episode of detail?.reusedPositions ?? []) result.reusedPositions.add(watchPosition({show_id:id, season, episode}));
      indexReview(entry.show, entry.seasons);
    } };
  try {
    const ids = new Set(archive.entries.map(entry => entry.id));
    for (const entry of archive.entries) {
      const link = verifiedAniListSeries.get(entry.id);
      if (link) ids.add(link.related);
    }
    const mappings = await fetchAniListMapping(ids, options.signal, options.fetchMapping,
      {verify:session.verify, store:service.store, now:()=>service.environment.now()});
    await session.verify();
    const groups = new Map<number, Matched[]>();
    const corrections = options.corrections ?? aniListCorrections;
    for (const entry of archive.entries) {
      let mapping = mappings.get(entry.id);
      const link = verifiedAniListSeries.get(entry.id);
      if (link && mapping?.kind === 'unmapped' && mapping.format === link.format) {
        const related = mappings.get(link.related);
        if (related?.kind === 'show' && related.showId === link.showId) {
          mapping = {kind:'show', showId:link.showId, season:link.season, offset:null,
            uncertainPlacement:link.season === null ? 'series-only' : undefined};
        }
      }
      if (mapping?.kind === 'film') unavailable(result, entry, 'film', 'Mapped to a film.');
      else if (mapping?.kind !== 'show' || mapping.showId === null) unavailable(result, entry, 'unmapped',
        mapping?.kind === 'ambiguous' ? 'The mapping gives conflicting placements.' :
          (mapping?.format ? mapping.format + ' · ' : '') + 'No TMDB show in the mapping file.');
      else {
        const items = groups.get(mapping.showId) ?? [];
        const candidate = corrections.get(entry.id);
        const correction = candidate?.showId === mapping.showId && candidate.publishedSeason === mapping.season &&
          candidate.publishedOffset === mapping.offset && !mapping.uncertainPlacement ? candidate : undefined;
        items.push({ entry, mapping, correction });
        groups.set(mapping.showId, items);
      }
    }
    await forEachImportItem([...groups], async ([id, items]) => {
      // Explicit mappings identify the seasons needed before downloading the show.
      // Uncertain and corrected placements still follow their own identity checks.
      const hints = new Set<number>();
      for (const {entry,mapping,correction} of items) {
        if (entry.progress && !correction && !mapping.uncertainPlacement && mapping.season !== null &&
            (mapping.season !== 0 || mapping.offset !== null)) hints.add(mapping.season);
      }
      const show = await session.load({ kind: 'show', id },undefined,[...hints]);
      if (!show) {
        for (const {entry} of items) unavailable(result, entry, 'missing-show', 'TMDB did not return mapped show ' + id + '.');
        return;
      }
      const ranges = broadcastSeasons(show);
      if (ranges) result.broadcastByShow.set(id,ranges);
      await session.preloadSeasons(show,show.seasons.map(s => s.season).filter(n => hints.has(n)));
      const seasons = await placeShow(show, items, result, session.load);
      if (seasons) {
        review.set(id,{show,seasons});
        result.reviewSeasonNumbers.set(id,show.seasons.map(s => s.season).sort((a,b) => a-b));
        indexReview(show,seasons);
      }
    });
    await session.verify();
    result.shows.sort((a, b) => a.show_id - b.show_id);
    result.entryRanges.sort((a, b) => a.showId - b.showId || a.entryId - b.entryId || a.season - b.season || a.first - b.first);
    result.entries.sort((a, b) => a.show_id - b.show_id || a.id - b.id);
    result.watched.sort((a, b) => a.show_id - b.show_id || a.season - b.season || a.episode - b.episode);
    result.notices.sort((a, b) => (a.showId ?? 0) - (b.showId ?? 0) || (a.entryId ?? 0) - (b.entryId ?? 0) || a.text.localeCompare(b.text));
    session.finishMatching(Array.from(review.values(), entry => entry.show));
    return result;
  } catch (error) {
    session.close();
    if (!service.environment.online()) throw new TmdbError('unreachable');
    throw error;
  }
}
