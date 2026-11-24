export interface WatchedRow {
  show_id: number;
  show: string;
  season: number;
  episode: number;
  title: string;
  times_watched: number;
  episode_id: number | null;
}

export interface RatingRow {
  show_id: number;
  show: string;
  rating: number;
}

export interface ListRow {
  list: string;
  show_id: number;
  show: string;
}

// IndexedDB requires a key for each list row. Real show IDs are nonnegative.
// A named list without a show uses two empty show fields in its CSV.
export const LIST_DECLARATION_ID = -1;
export function isListDeclaration(row: { show_id: number }): boolean {
  return row.show_id === LIST_DECLARATION_ID;
}

export interface ShowRow {
  show_id: number;
  show: string;
  year: number | null;
  imdb_id: string;
}

export interface SettingRow {
  setting: string;
  value: string;
}

export interface TableRows {
  watched: WatchedRow;
  ratings: RatingRow;
  lists: ListRow;
  shows: ShowRow;
  settings: SettingRow;
}

export type TableName = keyof TableRows;
export type MergeTable = Exclude<TableName, "shows">;
export type RecordTables = { [K in TableName]: TableRows[K][] };
export const MAX_INTEGER = Number.MAX_SAFE_INTEGER;

export function emptyTables(): RecordTables {
  return { watched: [], ratings: [], lists: [], shows: [], settings: [] };
}

export function watchPosition(row: Pick<WatchedRow, "show_id" | "season" | "episode">): string {
  return JSON.stringify([row.show_id, row.season, row.episode]);
}

// Tuple keys preserve a list's exact spelling, including punctuation.
export function rowKey<K extends TableName>(table: K, row: TableRows[K]): string {
  switch (table) {
    case "watched": return watchPosition(row as WatchedRow);
    case "lists": {
      const { list, show_id } = row as ListRow;
      return JSON.stringify([list, show_id]);
    }
    case "settings": return (row as SettingRow).setting;
    default: return String((row as ShowRow | RatingRow).show_id);
  }
}

export function foldListName(name: string): string {
  return name.replace(/[A-Z]/g, letter => letter.toLowerCase());
}

export const favoritesList = 'Favorites';
export const droppedList = 'Dropped';

export function canonicalListName(name: string): string {
  if (/^favou?rites$/i.test(name)) return favoritesList;
  if (/^(stopped|dropped)$/i.test(name)) return droppedList;
  return name;
}

/** Collapse only aliases of the same built-in membership. A nonempty title and the current spelling win ties. */
export function canonicalListRows(rows: readonly ListRow[]): ListRow[] {
  if (!rows.some(row => canonicalListName(row.list) !== row.list)) return [...rows];
  const chosen = new Map<string,number>(), result: ListRow[] = [];
  for (const row of rows) {
    const list = canonicalListName(row.list);
    if (list !== favoritesList && list !== droppedList) { result.push(row); continue; }
    const key = JSON.stringify([list,row.show_id]);
    const index = chosen.get(key);
    if (index === undefined) { chosen.set(key,result.length); result.push(row); continue; }
    const prior = result[index];
    if ((row.show && !prior.show) || Boolean(row.show) === Boolean(prior.show) &&
      (row.list === list || prior.list !== list && row.list < prior.list)) result[index] = row;
  }
  return result.map(row => {
    const list = canonicalListName(row.list);
    return list === row.list ? row : {...row,list};
  });
}
