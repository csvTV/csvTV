import { csvColumns, readCsv } from './csv.ts';
import { csvSelectionLimits } from './import-limits.ts';
import { isListDeclaration, rowKey, type RecordTables, type TableRows } from './model.ts';
import { hasRepeatedEpisode } from './watch-identity.ts';
import { recentId } from './recent-history.ts';
import type { DeviceSnapshot, DeviceStore } from './storage.ts';

export const localTables = ['watched', 'ratings', 'lists', 'shows'] as const;
type LocalTable = typeof localTables[number];
export type LocalRecord = Pick<RecordTables, LocalTable>;
export interface LocalPreview {
  record: LocalRecord;
  revision: bigint;
  recentSettings: string[];
  counts: { table: LocalTable; adds: number; replacements: number; removals: number }[];
}

function checkedRows<K extends LocalTable>(table: K, bytes: Uint8Array, limits: ReturnType<typeof csvSelectionLimits>): TableRows[K][] {
  const result = readCsv(table, bytes, limits), columns: readonly string[] = csvColumns[table];
  if (result.stopped || result.findings.length || result.header.length !== columns.length ||
      !columns.every(column => result.header.includes(column))) {
    const line = result.findings[0]?.line;
    throw Error('Select a valid ' + table + '.csv with its complete export header and unique rows.' + (line ? ' Check line ' + line + '.' : ''));
  }
  return result.rows;
}
export async function readLocalRecord(files: readonly File[]): Promise<LocalRecord> {
  if (files.length !== 4 || !localTables.every(t => files.filter(f => f.name === t + '.csv').length === 1)) {
    throw Error('Choose exactly one watched.csv, ratings.csv, lists.csv and shows.csv from the same export.');
  }
  const limits = csvSelectionLimits(files);
  async function read<K extends LocalTable>(table: K) {
    const file = files.find(item => item.name === table + '.csv')!;
    let bytes: ArrayBuffer;
    try { bytes = await file.arrayBuffer(); }
    catch { throw Error('Could not read ' + file.name + '. Check that the file is available and select the four files again.'); }
    return checkedRows(table, new Uint8Array(bytes), limits);
  }
  const watched = await read('watched'), ratings = await read('ratings');
  const lists = await read('lists'), shows = await read('shows');
  if (hasRepeatedEpisode(watched)) throw Error('watched.csv gives an episode more than one position.');
  const references = new Set([...watched, ...ratings, ...lists.filter(row => !isListDeclaration(row))].map(row => row.show_id));
  if (shows.length !== references.size || shows.some(row => !references.has(row.show_id))) {
    throw Error('shows.csv must contain exactly the shows referenced by the other three files.');
  }
  return { watched, ratings, lists, shows };
}

export function previewLocalRecord(current: DeviceSnapshot, record: LocalRecord): LocalPreview {
  if (current.local.syncAccountId != null || current.local.dropboxSession != null) throw Error('This device uses Dropbox backup recovery.');
  const counts = localTables.map(table => {
    const columns: readonly string[] = csvColumns[table];
    const old = new Map(current.tables[table].map(row => [rowKey(table, row), row]));
    let replacements = 0, adds = 0;
    for (const next of record[table]) {
      const key = rowKey(table, next), before = old.get(key);
      if (!before) adds++;
      else if (columns.some(col => Reflect.get(before, col) !== Reflect.get(next, col))) replacements++;
      old.delete(key);
    }
    return { table, adds, replacements, removals: old.size };
  });
  const recentSettings = current.tables.settings.map(row => row.setting).filter(key => recentId(key) !== null);
  return { revision: current.revision, record, counts, recentSettings };
}

export async function applyLocalRecord(store: DeviceStore, preview: LocalPreview, current?: () => boolean) {
  // A code exchange, edit, or other restore increments the very revision this transaction checks.
  await store.commit(preview.revision, { replace: preview.record, remove:{settings:preview.recentSettings},
    removeLocal: ['recentlyMarked', 'displacedRecentMark'] }, { invalidateTmdbWork: true, current });
}
