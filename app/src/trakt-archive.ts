import { checkImportBytes, checkImportRows, checkTraktMemberBytes, ImportLimitError, importLimits, parseImportJson, readImportText } from './import-limits.ts';

/** Only these fields of a Trakt export are needed for matching and preview. */
export interface TraktIds { trakt: number | null; tmdb: number | null; tvdb: number | null; imdb: string | null }
export interface TraktShow { title: string; ids: TraktIds }
export interface TraktEpisode { title: string; season: number; number: number; ids: TraktIds }
export interface TraktArchive {
  history: { show: TraktShow; episode: TraktEpisode }[];
  totals: { show: TraktShow; plays: number }[];
  ratings: { show: TraktShow; rating: number }[];
  favourites: TraktShow[];
  watchlist: TraktShow[];
  issues: string[];
}

type JsonObject = Record<string, unknown>;
const historyPage = /^watched-history-[1-9][0-9]*\.json$/;
const tables = new Set(['watched-shows.json', 'ratings-shows.json', 'lists-favorites.json', 'lists-watchlist.json']);
const bufferedZipBytes = 2 * 1024 * 1024;
const unreadableArchive = () => Error('Could not read this Trakt export. Choose the ZIP downloaded from Trakt.');

function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function integer(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function ids(value: unknown): TraktIds {
  const source = object(value) ? value : {};
  return {
    trakt: integer(source.trakt, 1) ? source.trakt : null,
    tmdb: integer(source.tmdb, 1) ? source.tmdb : null,
    tvdb: integer(source.tvdb, 1) ? source.tvdb : null,
    imdb: typeof source.imdb === 'string' && /^tt[0-9]+$/.test(source.imdb) ? source.imdb : null,
  };
}

function showFrom(value: unknown): TraktShow | null {
  if (!object(value)) return null;
  const identifiers = ids(value.ids);
  const title = typeof value.title === 'string' ? value.title.trim() : '';
  if (!title && Object.values(identifiers).every(id => id === null)) return null;
  return { title: title || 'Untitled Trakt show', ids: identifiers };
}

function cannotRead(name: string): never {
  // Only recognized file names reach this message. The outer archive's name can identify its owner.
  throw Error('Could not read ' + name + ' in the Trakt export.');
}

type HistoryRow = TraktArchive['history'][number];
interface HistoryEvents {
  byId: Map<string, HistoryRow>;
  disputed: Set<HistoryRow>;
  repetitions: number;
}

function mergeEventIds(prior: TraktIds, next: TraktIds) {
  for (const key of ['trakt','tmdb','tvdb','imdb'] as const) {
    if (prior[key] !== null && next[key] !== null && prior[key] !== next[key]) return false;
  }
  prior.trakt ??= next.trakt;
  prior.tmdb ??= next.tmdb;
  prior.tvdb ??= next.tvdb;
  prior.imdb ??= next.imdb;
  return true;
}

function readRows(archive: TraktArchive, history: HistoryEvents, name: string, rows: unknown[]) {
  for (const [index, item] of rows.entries()) {
    const entry = object(item) ? item : {};
    if (entry.type === 'movie' || (!entry.type && entry.movie != null)) continue;
    const show = showFrom(entry.show);
    if (name === 'lists-watchlist.json') {
      if (show && (entry.type === 'show' || entry.type === 'season' || entry.type === 'episode')) {
        archive.watchlist.push(show);
      } else {
        archive.issues.push('Watchlist item ' + (index + 1) + (show ? ' (' + show.title + ')' : '') +
          ' could not be read as a show, season or episode.');
      }
      continue;
    }
    if (historyPage.test(name)) {
      if (typeof entry.type === 'string' && entry.type !== 'episode') continue;
      const episode = entry.episode;
      if (!show || !object(episode) || !integer(episode.season, 0) || !integer(episode.number, 0)) return cannotRead(name);
      const play = { show, episode: {
        title: typeof episode.title === 'string' ? episode.title : '',
        season: episode.season, number: episode.number, ids: ids(episode.ids),
      } };
      const eventId = integer(entry.id, 1) ? String(entry.id) :
        typeof entry.id === 'string' && /^[1-9][0-9]{0,19}$/.test(entry.id) ? entry.id : null;
      if (eventId !== null) {
        const prior = history.byId.get(eventId);
        if (prior) {
          history.repetitions++;
          if (prior.episode.season !== play.episode.season || prior.episode.number !== play.episode.number ||
              !mergeEventIds(prior.show.ids, play.show.ids) || !mergeEventIds(prior.episode.ids, play.episode.ids)) {
            history.disputed.add(prior);
          }
          continue;
        }
        history.byId.set(eventId, play);
      }
      archive.history.push(play);
      continue;
    }
    if (typeof entry.type === 'string' && entry.type !== 'show') continue;
    if (!show) return cannotRead(name);
    if (name === 'watched-shows.json') {
      if (!integer(entry.plays, 0)) return cannotRead(name);
      archive.totals.push({ show, plays: entry.plays });
    } else if (name === 'ratings-shows.json') {
      if (!integer(entry.rating, 1, 10)) return cannotRead(name);
      archive.ratings.push({ show, rating: entry.rating });
    } else archive.favourites.push(show);
  }
}

export async function readTraktArchive(file: Blob, signal?: AbortSignal): Promise<TraktArchive> {
  signal?.throwIfAborted();
  checkImportBytes(file.size, importLimits.traktZip, 'The Trakt ZIP');
  const { BlobReader, Uint8ArrayReader, ZipReader } = await import('./zip-native.js');
  signal?.throwIfAborted();
  // File slices can require a separate browser process round trip for each ZIP member.
  // Keep one bounded compressed buffer for small exports. Large files retain their streaming reader.
  const bytes = file.size <= bufferedZipBytes ? await file.arrayBuffer().catch(() => {
    signal?.throwIfAborted();
    throw unreadableArchive();
  }) : null;
  signal?.throwIfAborted();
  if (bytes && bytes.byteLength !== file.size) throw unreadableArchive();
  const input = bytes ? new Uint8ArrayReader(new Uint8Array(bytes)) : new BlobReader(file);
  const reader = new ZipReader(input, { useWebWorkers: false, checkCrc32: true, checkOverlappingEntry: true });
  const archive: TraktArchive = { history: [], totals: [], ratings: [], favourites: [], watchlist: [], issues: [] };
  const seen = new Set<string>();
  const history: HistoryEvents = { byId: new Map(), disputed: new Set(), repetitions: 0 };
  let reading = '';
  let entries = 0, decodedBytes = 0, rowCount = 0, historyPages = 0;
  let yieldAt = performance.now() + 8;
  try {
    for await (const entry of reader.getEntriesGenerator()) {
      signal?.throwIfAborted();
      if (++entries > importLimits.zipEntries) throw new ImportLimitError('The ZIP exceeds the ' + importLimits.zipEntries + '-entry import limit.');
      if (entry.directory || (!tables.has(entry.filename) && !historyPage.test(entry.filename))) continue;
      reading = entry.filename;
      if (seen.has(reading)) return cannotRead(reading);
      seen.add(reading);
      if (historyPage.test(reading)) historyPages++;
      const checkMemberBytes = (bytes: number) => checkTraktMemberBytes(decodedBytes, bytes);
      checkMemberBytes(entry.uncompressedSize);
      const member = await readImportText(sink => entry.getData(sink, { signal }), checkMemberBytes);
      decodedBytes += member.byteLength;
      signal?.throwIfAborted();
      const rows = parseImportJson(member.text, historyPage.test(reading));
      if (!Array.isArray(rows)) return cannotRead(reading);
      rowCount += rows.length;
      checkImportRows(rowCount);
      readRows(archive, history, reading, rows);
      if (bytes && performance.now() >= yieldAt) {
        // Memory-backed pages may otherwise all finish in the same browser task.
        await new Promise<void>(resolve => setTimeout(resolve,0));
        signal?.throwIfAborted();
        yieldAt = performance.now() + 8;
      }
    }
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof ImportLimitError) throw error;
    if (reading) return cannotRead(reading);
    throw unreadableArchive();
  } finally {
    await reader.close();
  }
  if (!seen.size) throw Error('This ZIP does not contain the history, ratings or list files of a Trakt export.');
  // Only report gaps proven by a later page. A ratings-only export is valid.
  for (let page = 1; page <= historyPages; page++) {
    if (!seen.has('watched-history-' + page + '.json')) {
      archive.issues.push('History page ' + page + ' is missing from the Trakt ZIP. Play counts use the pages present.');
      break;
    }
  }
  if (history.disputed.size) {
    archive.history = archive.history.filter(row => !history.disputed.has(row));
    archive.issues.push('Skipped conflicting history event IDs: ' + history.disputed.size + '.');
  }
  if (history.repetitions) archive.issues.push('Ignored repeated history rows with the same event ID: ' + history.repetitions + '.');
  return archive;
}
