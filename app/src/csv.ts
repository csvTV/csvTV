import { decodeInput, quoteField, records } from "./csv-format.ts";
import { displayPreferences } from "./display-preferences.ts";
import { decodeSeasonBreaks, isSeasonOrderKey, nativeSeasonOrder } from './season-order.ts';
import { recentId, readRecentValue } from './recent-history.ts';
import { canonicalListName, canonicalListRows, foldListName, LIST_DECLARATION_ID, MAX_INTEGER, rowKey } from "./model.ts";
import { isAnimeClassification } from './anime.ts';
import { dropMembership, upcomingMembership } from './upcoming-preference.ts';
import type { ListRow, TableName, TableRows, WatchedRow } from "./model.ts";

export const csvColumns = {
  watched: ["show_id", "show", "season", "episode", "title", "times_watched", "episode_id"],
  ratings: ["show_id", "show", "rating"],
  lists: ["list", "show_id", "show"],
  shows: ["show_id", "show", "year", "imdb_id"],
  settings: ["setting", "value"],
} as const;

const required: Record<TableName, readonly string[]> = {
  watched: ["show_id", "season", "episode", "times_watched"],
  ratings: ["show_id", "rating"],
  lists: ["list", "show_id"],
  shows: ["show_id"],
  settings: ["setting", "value"],
};
const settingNames = new Set(["tmdb_key", "mdblist_key", "imdb_source", "omdb_key", "github_repo", "github_token", "mal_source",
  ...Object.values(displayPreferences).map(preference => preference.setting)]);
const maxDigits = String(MAX_INTEGER);
const maxCount = BigInt(MAX_INTEGER);

export interface CsvFinding {
  kind: "row" | "duplicate" | "unknown" | "fatal";
  line: number;
  reason: string;
  field?: string;
  setting?: string;
}

export interface CsvRead<K extends TableName> {
  /** Candidate hand-merge rows. A sync must check findings before using them. */
  rows: TableRows[K][];
  header: string[];
  findings: CsvFinding[];
  /** No rows are exposed after an unrecoverable error. */
  stopped: boolean;
  /** A restore can only replace damaged data after establishing a known schema. */
  schema: "known" | "unknown" | "unconfirmed";
  /** The raw list file contains a previous or alternate spelling of a built-in list. */
  normalizedListNames?: true;
}

class CellError extends Error {
  readonly field: string;
  readonly kind: "row" | "unknown";

  constructor(field: string, reason: string, kind: "row" | "unknown" = "row") {
    super(reason);
    this.field = field;
    this.kind = kind;
  }
}

function integer(value: string, field: string): number {
  if (!value || /[^0-9]/.test(value)) throw new CellError(field, "Expected ASCII digits");
  if (value.length < maxDigits.length) return Number(value);
  const digits = value.replace(/^0+(?=\d)/, "");
  if (digits.length > maxDigits.length || (digits.length === maxDigits.length && digits > maxDigits)) {
    throw new CellError(field, "Integer exceeds the supported range");
  }
  return Number(digits);
}

function rating(value: string): number {
  const match = /^([0-9]+)(?:\.(0+|50*))?$/.exec(value);
  if (!match) throw new CellError("rating", "Expected a whole or half-point rating");
  const whole = integer(match[1], "rating");
  const half = match[2]?.startsWith("5") ? 0.5 : 0;
  if (whole > 10 || (whole === 10 && half)) throw new CellError("rating", "Rating outside 0 to 10");
  return whole + half;
}

export function validGithubRepo(value: string): boolean {
  const parts = value.split("/");
  return parts.length === 2 && parts.every(part => part.length > 0 && !/[^A-Za-z0-9._-]/.test(part) && part !== "." && part !== "..");
}

function settingRow(setting: string, value: string): TableRows["settings"] {
  if (!setting) throw new CellError("setting", "Missing setting name");
  if (isSeasonOrderKey(setting)) {
    if (value !== nativeSeasonOrder && !decodeSeasonBreaks(value)) throw new CellError("value", "Invalid season order", "unknown");
    return {setting,value};
  }
  if (recentId(setting) !== null) {
    if (!readRecentValue(value)) throw new CellError("value", "Unsupported Recently marked entry", "unknown");
    return {setting,value};
  }
  if (!settingNames.has(setting)) throw new CellError("setting", "Unknown setting", "unknown");
  if (!value.replaceAll(" ", "")) throw new CellError("value", "Empty setting value");
  const display = Object.values(displayPreferences).find(preference => preference.setting === setting);
  if (display && !(display.values as readonly string[]).includes(value)) {
    throw new CellError("value", "Unsupported display preference", "unknown");
  }
  if ((setting === "imdb_source" && value !== "omdb" && value !== "github") ||
      (setting === "mal_source" && value !== "github")) {
    throw new CellError("value", "Unsupported source selection", "unknown");
  }
  if (setting === "github_repo" && !validGithubRepo(value)) {
    throw new CellError("value", "Expected a repository in owner/name form");
  }
  return { setting, value };
}

type Cells = Record<string, string>;
const readers: { [K in TableName]: (cells: Cells) => TableRows[K] } = {
  watched(c) {
    const times_watched = integer(c.times_watched, "times_watched");
    if (!times_watched) throw new CellError("times_watched", "Watch count must be positive");
    return { show_id: integer(c.show_id, "show_id"), show: c.show ?? "", season: integer(c.season, "season"),
      episode: integer(c.episode, "episode"), title: c.title ?? "", times_watched,
      episode_id: c.episode_id ? integer(c.episode_id, "episode_id") : null };
  },
  ratings(c) {
    return { show_id: integer(c.show_id, "show_id"), show: c.show ?? "", rating: rating(c.rating) };
  },
  lists(c) {
    if (!c.list.replaceAll(" ", "")) throw new CellError("list", "Empty list name");
    if (c.show_id === '' && c.show === '' && !isAnimeClassification(c.list) && !dropMembership(c.list) && !upcomingMembership(c.list)) {
      return { list: c.list, show_id: LIST_DECLARATION_ID, show: '' };
    }
    return { list: c.list, show_id: integer(c.show_id, "show_id"), show: c.show ?? "" };
  },
  shows(c) {
    if (c.imdb_id && !/^tt[0-9]+$/.test(c.imdb_id)) throw new CellError("imdb_id", "Invalid IMDb title ID");
    return { show_id: integer(c.show_id, "show_id"), show: c.show ?? "", year: c.year ? integer(c.year, "year") : null,
      imdb_id: c.imdb_id ?? "" };
  },
  settings(c) { return settingRow(c.setting, c.value); },
};

function setSchemaUnconfirmed(result: CsvRead<TableName>): void {
  if (result.schema !== "unknown") result.schema = "unconfirmed";
}

function checkHeader(table: TableName, header: string[], line: number, result: CsvRead<TableName>): void {
  const known: readonly string[] = csvColumns[table];
  const seen = new Set<string>();
  for (const name of header) {
    if (!known.includes(name)) {
      result.findings.push({ kind: "unknown", line, field: name, reason: "Unknown column" });
      result.schema = "unknown";
    }
    if (seen.has(name)) {
      result.findings.push({ kind: "fatal", line, field: name, reason: "Duplicate column" });
      result.stopped = true;
    }
    seen.add(name);
  }
  for (const name of required[table]) {
    if (!seen.has(name)) {
      result.findings.push({ kind: "fatal", line, field: name, reason: "Missing required column" });
      result.stopped = true;
    }
  }
  if (result.stopped) setSchemaUnconfirmed(result);
}

export function readCsv<K extends TableName>(table: K, input: string | Uint8Array,
  limits?: { maxFields: number; countDataRow(): void }): CsvRead<K> {
  const result: CsvRead<K> = { rows: [], header: [], findings: [], stopped: false, schema: "known" };
  const decoded = decodeInput(input);
  const rows = new Map<string, TableRows[K]>();
  // The header is fixed and each reader copies primitive fields into a new row.
  const cells: Cells = Object.create(null);
  for (const record of records(decoded.text, !decoded.error, limits?.maxFields)) {
    const { line } = record;
    if ("reason" in record) {
      result.findings.push({ kind: "fatal", ...record });
      result.stopped = true;
      if (!result.header.length || table === "settings") setSchemaUnconfirmed(result);
      break;
    }
    const { fields } = record;
    if (!result.header.length) {
      result.header = fields;
      checkHeader(table, fields, line, result);
      if (result.stopped) break;
      continue;
    }
    limits?.countDataRow();
    if (fields.length !== result.header.length) {
      result.findings.push({ kind: "row", line, reason: "Field count differs from header" });
      if (table === "settings") setSchemaUnconfirmed(result);
      continue;
    }
    for (let i = 0; i < fields.length; i++) cells[result.header[i]] = fields[i];
    let row: TableRows[K];
    try {
      row = readers[table](cells);
    } catch (error) {
      if (!(error instanceof CellError)) throw error;
      const finding: CsvFinding = { kind: error.kind, line, reason: error.message, field: error.field };
      if (table === "settings" && cells.setting) finding.setting = cells.setting;
      result.findings.push(finding);
      if (error.kind === "unknown") result.schema = "unknown";
      if (table === "settings" && !cells.setting) setSchemaUnconfirmed(result);
      continue;
    }

    const key = rowKey(table, row);
    const previous = rows.get(key);
    if (previous) {
      if (table === "watched") {
        const before = previous as WatchedRow, next = row as WatchedRow;
        const total = BigInt(before.times_watched) + BigInt(next.times_watched);
        if (before.episode_id !== next.episode_id || total > maxCount) {
          const reason = before.episode_id !== next.episode_id ? "Conflicting episode identities" : "Combined count exceeds the supported range";
          result.findings.push({ kind: "fatal", line, reason: reason + " at " + key });
          result.stopped = true;
          break;
        }
        next.times_watched = Number(total);
      }
      const finding: CsvFinding = { kind: "duplicate", line, reason: "Duplicate row" };
      if (table === "settings") finding.setting = cells.setting;
      result.findings.push(finding);
    }
    rows.set(key, row);
  }
  if (decoded.error) {
    result.findings.push({ kind: "fatal", ...decoded.error });
    result.stopped = true;
    if (!result.header.length || table === "settings") setSchemaUnconfirmed(result);
  }
  if (!result.header.length && !result.stopped) {
    result.findings.push({ kind: "fatal", line: 1, reason: "Missing header" });
    result.stopped = true;
    setSchemaUnconfirmed(result);
  }
  if (!result.stopped) {
    result.rows = [...rows.values()];
    if (table === 'lists' && (result.rows as ListRow[]).some(row => canonicalListName(row.list) !== row.list)) {
      result.normalizedListNames = true;
      result.rows = canonicalListRows(result.rows as ListRow[]) as TableRows[K][];
    }
  }
  return result;
}

function byCodePoint(left: string, right: string): number {
  let i = 0;
  while (i < left.length && i < right.length) {
    const a = left.codePointAt(i)!, b = right.codePointAt(i)!;
    if (a !== b) return a - b;
    i += a > 0xffff ? 2 : 1;
  }
  return left.length - right.length;
}

export function compareFileText(left: string, right: string): number {
  if (left === right) return 0;
  return byCodePoint(foldListName(left), foldListName(right)) || byCodePoint(left, right);
}

function compareRows(left: TableRows[TableName], right: TableRows[TableName]): number {
  if ("setting" in left && "setting" in right) return compareFileText(left.setting, right.setting);
  if ("list" in left && "list" in right) {
    const order = compareFileText(left.list, right.list);
    if (order) return order;
  }
  if ("show" in left && "show" in right) {
    const order = compareFileText(left.show, right.show) || left.show_id - right.show_id;
    if (order) return order;
  }
  if ("season" in left && "season" in right) return left.season - right.season || left.episode - right.episode;
  return 0;
}

function validatedCells<K extends TableName>(table: K, row: TableRows[K], writtenRows?: TableRows[K][]): Cells {
  const columns: readonly string[] = csvColumns[table];
  const cells: Cells = {};
  for (const column of columns) {
    const value: unknown = row[column as keyof typeof row];
    if (table === "lists" && column === "show_id" && value === LIST_DECLARATION_ID) cells[column] = "";
    else if (value === null && (column === "episode_id" || column === "year")) cells[column] = "";
    else if (typeof value === "number" && Number.isFinite(value)) cells[column] = String(value);
    else if (typeof value === "string" && !/[\uD800-\uDFFF]/u.test(value)) cells[column] = value;
    else throw new Error("Invalid value for " + column);
  }
  // Enforce the same numeric and schema rules for programmatically created rows.
  const checked = readers[table](cells);
  for (const column of columns) {
    const name = column as keyof typeof row;
    if (checked[name] !== row[name]) throw new Error("Invalid type for " + column);
  }
  writtenRows?.push(checked);
  return cells;
}

/** Validate a row at a local write boundary without sorting or serializing a table. */
export function validateRow<K extends TableName>(table: K, row: TableRows[K]): void {
  validatedCells(table, row);
}

function serialize<K extends TableName>(table: K, rows: readonly TableRows[K][], writtenRows?: TableRows[K][]): string {
  if (table === 'lists' && (rows as readonly ListRow[]).some(row => canonicalListName(row.list) !== row.list)) {
    const rawKeys = new Set<string>();
    for (const row of rows) {
      validateRow(table,row);
      const key = rowKey(table,row);
      if (rawKeys.has(key)) throw new Error('Duplicate row in lists');
      rawKeys.add(key);
    }
    rows = canonicalListRows(rows as readonly ListRow[]) as TableRows[K][];
  }
  const columns: readonly string[] = csvColumns[table];
  const seen = new Set<string>();
  const lines = [columns.join(",")];
  for (const row of [...rows].sort(compareRows)) {
    const cells = validatedCells(table, row, writtenRows);
    const key = rowKey(table, row);
    if (seen.has(key)) throw new Error("Duplicate row in " + table);
    seen.add(key);
    lines.push(columns.map(column => quoteField(cells[column])).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

export function writeCsv<K extends TableName>(table: K, rows: readonly TableRows[K][]): string {
  return serialize(table,rows);
}

/** Return the same validated, schema-only rows that reading the resulting file would produce. */
export function writeCsvWithRows<K extends TableName>(table: K, rows: readonly TableRows[K][]) {
  const written: TableRows[K][] = [];
  return {content:serialize(table,rows,written),rows:written};
}
