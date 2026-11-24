import { checkImportBytes, checkImportRows, ImportLimitError, importLimits, parseImportJson, readImportText } from './import-limits.ts';

export interface AniListEntry { id: number; status: number; score: number; progress: number; repeat: number }
export interface AniListNotice {
  kind: 'film' | 'unmapped' | 'missing-show' | 'unplaced' | 'unknown-status' | 'rewatching' | 'overlap' | 'invalid';
  text: string;
  episodes: number;
  entryId?: number;
  showId?: number;
  anilistId?: number;
  /** A regular-season placement can be corrected in the import preview. */
  review?: true;
}
/** Only the fields used to prepare the import survive parsing. */
export interface AniListArchive { entries: AniListEntry[]; favourites: Set<number>; notices: AniListNotice[] }

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function integer(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}
const invalidFile = () => Error('Could not read the AniList export. Choose a JSON file containing a lists array.');

export async function readAniListArchive(file: Blob, signal?: AbortSignal): Promise<AniListArchive> {
  signal?.throwIfAborted();
  const checkBytes = (size: number) => checkImportBytes(size, importLimits.aniListFile, 'The AniList JSON');
  checkBytes(file.size);
  let data: unknown;
  try {
    const {text} = await readImportText(sink => file.stream().pipeTo(sink, {signal}), checkBytes);
    data = parseImportJson(text);
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof ImportLimitError) throw error;
    throw invalidFile();
  }
  signal?.throwIfAborted();
  if (!object(data) || !Array.isArray(data.lists) || (data.favourites != null && !Array.isArray(data.favourites))) throw invalidFile();
  checkImportRows(data.lists.length + (data.favourites?.length ?? 0));
  const notices: AniListNotice[] = [], favourites = new Set<number>();
  const entries = new Map<number, AniListEntry>(), conflicting = new Set<number>();
  for (const [index, item] of data.lists.entries()) {
    if (object(item) && integer(item.series_type, 1)) continue;
    if (!object(item) || item.series_type !== 0 || !integer(item.series_id, 1) || !integer(item.progress, 0) ||
        !integer(item.repeat, 0) || !Number.isSafeInteger(item.repeat + 1) || !Number.isSafeInteger(item.status) ||
        typeof item.score !== 'number' || !Number.isFinite(item.score) || item.score < 0 || item.score > 100) {
      notices.push({ kind: 'invalid', episodes: 0, text: 'List entry ' + (index + 1) + ' contains an invalid type, ID, status, score or count and was skipped.' });
      continue;
    }
    const entry: AniListEntry = { id: item.series_id, progress: item.progress, repeat: item.repeat, score: item.score, status: item.status as number };
    if (conflicting.has(entry.id)) continue;
    const old = entries.get(entry.id);
    if (old && (old.progress !== entry.progress || old.repeat !== entry.repeat || old.score !== entry.score || old.status !== entry.status)) {
      conflicting.add(entry.id);
      entries.delete(entry.id);
      notices.push({ kind: 'invalid', entryId: entry.id, episodes: 0, text: 'AniList entry ' + entry.id + ' has conflicting records and was skipped.' });
    } else entries.set(entry.id, entry);
  }
  let unreadableFavourites = 0;
  for (const item of data.favourites ?? []) {
    if (object(item) && integer(item.favourite_type, 0) && item.favourite_type !== 1) continue;
    if (object(item) && item.favourite_type === 1 && integer(item.favourite_id, 1)) favourites.add(item.favourite_id);
    else unreadableFavourites++;
  }
  if (unreadableFavourites) notices.push({kind:'invalid', episodes:0,
    text:'Favorite entries skipped because of an invalid type or ID: ' + unreadableFavourites.toLocaleString('en-US') + '.'});
  return { entries: [...entries.values()].sort((a, b) => a.id - b.id), favourites, notices };
}
