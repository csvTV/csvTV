import { isListDeclaration, type RecordTables, type ShowRow } from "./model.ts";

/** Personal rows for one show may have individually blank descriptive fields. */
export function recordedShowTitle(tables: Pick<RecordTables, "watched" | "ratings" | "lists" | "shows">): string {
  return tables.watched.find(row => row.show)?.show || tables.ratings[0]?.show ||
    tables.lists.find(row => row.show)?.show || tables.shows[0]?.show || "";
}

/** Build the fourth record table from one committed snapshot and its cached metadata. */
export function deriveShows(
  tables: Pick<RecordTables, "watched" | "ratings" | "lists" | "shows">,
  cachedShows: readonly ShowRow[],
): ShowRow[] {
  const ids = new Set<number>();
  for (const table of [tables.watched, tables.ratings, tables.lists]) {
    for (const row of table) if (!isListDeclaration(row)) ids.add(row.show_id);
  }
  const cached = new Map(cachedShows.map(row => [row.show_id, row]));
  const preserved = new Map(tables.shows.map(row => [row.show_id, row]));
  return Array.from(ids, show_id => {
    const fresh = cached.get(show_id);
    const old = preserved.get(show_id);
    return {
      show_id,
      show: fresh?.show || old?.show || "",
      year: fresh?.year ?? old?.year ?? null,
      imdb_id: fresh?.imdb_id || old?.imdb_id || "",
    };
  });
}
