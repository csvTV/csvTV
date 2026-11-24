import { compareFileText, writeCsv } from './csv.ts';
import { isAnimeClassification } from './anime.ts';
import { quoteField } from './csv-format.ts';
import type { ShowRow, WatchedRow } from './model.ts';
import { isWatchlist, visibleListRows } from './personal-record.ts';
import { localCalendarDate, watchProgress } from './progress.ts';
import { deriveShows } from './shows.ts';
import type { ExportSnapshot } from './storage.ts';
import { tmdbResourceKey } from './tmdb-client.ts';
import { withSeasonDetails } from './tmdb-data.ts';
import { broadcastPosition, broadcastSeasons } from './broadcast-seasons.ts';
import type { TmdbService } from './tmdb-service.ts';

export type ExportSelection = 'summary' | 'record';
export interface PreparedExport {
  files: File[];
  rows: number;
  missingShows: number;
}
const summaryHeader = 'show,year,season,episodes_watched,times_completed,rating,lists';

/** Encode one summary field before applying ordinary CSV quoting. */
export function encodeListNames(names: readonly string[]): string {
  return names.map(name => {
    if (!name.length) throw new Error('A list name cannot be empty');
    return name.replaceAll('\\', '\\\\').replaceAll(';', '\\;');
  }).join('; ');
}

/** Decode a field after the outer CSV parser has removed its quotes. */
export function decodeListNames(field: string): string[] {
  if (!field) return [];
  const names: string[] = [];
  let name = '';
  for (let i = 0; i < field.length; i++) {
    const character = field[i];
    if (character === '\\') {
      const escaped = field[++i];
      if (escaped !== '\\' && escaped !== ';') throw new Error('Invalid escape in the lists field');
      name += escaped;
    } else if (character === ';') {
      if (!name.length || field[++i] !== ' ') throw new Error('Invalid separator in the lists field');
      names.push(name);
      name = '';
    } else {
      name += character;
    }
  }
  if (!name.length) throw new Error('A list name cannot be empty');
  names.push(name);
  return names;
}

function csvFile(name: string, text: string, now: number) {
  return new File([text], name + '.csv', { type: 'text/csv', lastModified: now });
}

interface SummaryShow {
  index: ShowRow;
  title: string;
  watched: WatchedRow[];
  lists: string[];
  rating: number | null;
}

export function summary(snapshot: ExportSnapshot, index: ShowRow[], now: number, today = localCalendarDate(new Date(now)),
    allowEstimatedCompletions = true): PreparedExport {
  const { tables, showMetadata, seasons } = snapshot;
  const groups = new Map<number, SummaryShow>(index.map(row => [row.show_id, {
    index: row, title: row.show, watched: [], lists: [], rating: null,
  }]));
  // A newly referenced ID can have a file title but no entry in the retained show index.
  // Choose consistently if a hand-edited record uses multiple titles for one ID.
  function groupFor(row: { show_id: number; show: string }) {
    const group = groups.get(row.show_id)!;
    if (!group.index.show && row.show && (!group.title || compareFileText(row.show, group.title) < 0)) group.title = row.show;
    return group;
  }
  const watchedIds = new Set<number>();
  for (const row of tables.watched) {
    groupFor(row).watched.push(row);
    watchedIds.add(row.show_id);
  }
  for (const row of tables.ratings) groupFor(row).rating = row.rating;
  for (const row of visibleListRows(tables.lists,true,watchedIds)) {
    const group = groupFor(row);
    if (!isAnimeClassification(row.list)) group.lists.push(row.list);
  }
  const sorted = [...groups.values()].sort((a, b) => compareFileText(a.title, b.title) || a.index.show_id - b.index.show_id);
  let missingShows = 0;
  const lines = [summaryHeader];
  for (const group of sorted) {
    const { show_id: id, year } = group.index;
    const prefix = [quoteField(group.title), year ?? ''];
    const names = group.lists.sort((a,b) => Number(isWatchlist(b)) - Number(isWatchlist(a)) || compareFileText(a,b));
    const suffix = [group.rating ?? '', quoteField(encodeListNames(names))];
    if (!group.watched.length) {
      if (!names.length && group.rating === null) continue;
      lines.push([...prefix, '', '', '', ...suffix].join(','));
      continue;
    }
    const show = showMetadata.get(id);
    const counts = new Map<number, number>();
    const ranges = broadcastSeasons(show);
    for (const row of group.watched) {
      const season = ranges ? broadcastPosition(ranges, row.season, row.episode).season : row.season;
      counts.set(season, (counts.get(season) ?? 0) + 1);
    }
    const headerAt = snapshot.observationTimes?.get(tmdbResourceKey({ kind: 'show', id }));
    const info = show && withSeasonDetails(show, season => {
      const detail = seasons.get(tmdbResourceKey({ kind: 'season', id, season }));
      return allowEstimatedCompletions ? detail : detail ?? null;
    }, season => {
      const seasonAt = snapshot.observationTimes?.get(tmdbResourceKey({kind:'season', id, season}));
      return headerAt !== undefined && seasonAt !== undefined && seasonAt < headerAt;
    });
    const progress = watchProgress(id, group.watched, [], info ?? null, today);
    const completions = new Map(progress.seasons.map(s => [s.season, s.completed]));
    if (!show && group.watched.some(row => row.season > 0)) missingShows++;
    for (const [season, count] of [...counts].sort(([a], [b]) => a - b)) {
      lines.push([...prefix, season, count, completions.get(season) ?? '', ...suffix].join(','));
    }
  }
  return { files: [csvFile('summary', lines.join('\r\n') + '\r\n', now)],
    rows: lines.length - 1, missingShows };
}

/** A clear must retire the previous summary even when this device is still fetching metadata. */
export function resetSummary(snapshot: ExportSnapshot, index: ShowRow[], now: number): File {
  const unknownOrder = snapshot.tables.watched.some(row => row.season > 0 &&
    !snapshot.showMetadata.has(row.show_id) && !snapshot.missingShowIds.has(row.show_id));
  if (unknownOrder) return csvFile('summary', summaryHeader + '\r\n', now);
  return summary(snapshot, index, now, new Date(now).toISOString().slice(0,10), false).files[0];
}

export function exportShowIndex(snapshot: ExportSnapshot) {
  const { tables, showMetadata, externalIds } = snapshot;
  const cached = [...new Set([...showMetadata.keys(), ...externalIds.keys()])].map(id => {
    const show = showMetadata.get(id);
    return { show_id: id, show: show?.show ?? '',
      year: show?.firstAirDate ? Number(show.firstAirDate.slice(0, 4)) : null,
      imdb_id: show?.imdbId || externalIds.get(id) || '' };
  });
  return deriveShows(tables, cached);
}

export function recordExportFiles(snapshot: ExportSnapshot, now: number): File[] {
  const { tables } = snapshot;
  return [csvFile('watched', writeCsv('watched', tables.watched), now),
    csvFile('ratings', writeCsv('ratings', tables.ratings), now), csvFile('lists', writeCsv('lists', tables.lists), now),
    csvFile('shows', writeCsv('shows', exportShowIndex(snapshot)), now)];
}

export async function prepareExport(service: TmdbService, selection: ExportSelection, signal?: AbortSignal): Promise<PreparedExport> {
  const now = service.environment.now();
  const snapshot = await service.store.exportSnapshot(selection === 'summary', now,undefined,signal);
  signal?.throwIfAborted();
  if (selection === 'summary') return summary(snapshot, exportShowIndex(snapshot), now);
  return { files: recordExportFiles(snapshot, now), rows: 0, missingShows: 0 };
}
