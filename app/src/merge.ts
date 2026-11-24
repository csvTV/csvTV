import { canonicalListName, canonicalListRows, rowKey, type ListRow, type MergeTable, type TableRows } from './model.ts';
import { preferRecentValue, recentId } from './recent-history.ts';
import { initialImpact, type MergeImpact } from './guard.ts';
export { mergeWatched, answerDoubleMarks } from './watch-merge.ts';
export { episodeKey } from './watch-identity.ts';
export type { WatchVersions, WatchOptions, IdentityAssignment, IdentityReview } from './watch-merge.ts';

type ValueTable = Exclude<MergeTable, 'watched'>;
type ValueRow = TableRows[ValueTable];
type Clash = { setting: string } | { show_id: number; mine: number; theirs: number };

export interface MergedRows<Row> {
  status: 'merged';
  rows: Row[];
  noBase: boolean;
  clashes: Clash[];
  impact: MergeImpact;
  remoteChangedKeys: string[];
}

/** Prefer a changed side, with mine winning a simultaneous change. */
export function mergeField<T>(before: T | undefined, mine: T, theirs: T): T {
  return mine === before ? theirs : mine;
}

function value(row: ValueRow | undefined): string | number | undefined {
  if (row && 'rating' in row) return row.rating;
  if (row && 'value' in row) return row.value;
  return undefined;
}

function index<K extends ValueTable>(table: K, rows: readonly TableRows[K][]) {
  const result = new Map<string, TableRows[K]>();
  for (const row of rows) {
    const key = rowKey(table, row);
    if (result.has(key)) throw new Error('Merge requires unique row keys in ' + table);
    result.set(key, row);
  }
  if (table === 'lists' && (rows as readonly ListRow[]).some(row=>canonicalListName(row.list)!==row.list)) {
    result.clear();
    for (const row of canonicalListRows(rows as readonly ListRow[])) result.set(rowKey('lists',row),row as TableRows[K]);
  }
  return result;
}

export function mergeRows<K extends ValueTable>(table: K, before: readonly TableRows[K][] | null,
    mine: readonly TableRows[K][], theirs: readonly TableRows[K][]): MergedRows<TableRows[K]> {
  const base = index(table, before ?? []);
  const local = index(table, mine);
  const remote = index(table, theirs);
  const impact = initialImpact(before === null ? null : base.size, local.size, remote.size);
  const clashes: Clash[] = [];
  const rows: TableRows[K][] = [];
  const remoteChangedKeys: string[] = [];
  for (const key of new Set([...local.keys(), ...remote.keys(), ...base.keys()])) {
    const b = base.get(key), m = local.get(key), t = remote.get(key);
    if (Boolean(m) !== Boolean(t) || value(m) !== value(t)) impact.localToRemoteDifferences++;
    if (Boolean(m) !== Boolean(b) || value(m) !== value(b)) impact.localToBaseDifferences++;
    if (Boolean(b) !== Boolean(t) || value(b) !== value(t)) remoteChangedKeys.push(key);
    if (!m && !t) continue;
    if (!m || !t) {
      const survivor = m ?? t!;
      if (!b || value(survivor) !== value(b)) rows.push({ ...survivor });
      else if (m) impact.removedRows++;
      continue;
    }
    const baseValue = value(b), localValue = value(m), remoteValue = value(t);
    const sharedRecent = 'setting' in m && 'setting' in t && recentId(m.setting) !== null;
    const takeMine = sharedRecent ? preferRecentValue(m.value,t.value) : localValue !== baseValue;
    const chosen = { ...(takeMine ? m : t) };
    if ('show' in chosen && 'show' in m && 'show' in t) {
      chosen.show = mergeField(b && 'show' in b ? b.show : undefined, m.show, t.show);
    }
    if (localValue !== remoteValue && localValue !== baseValue && remoteValue !== baseValue) {
      if ('setting' in m && !sharedRecent) clashes.push({ setting: m.setting });
      if ('rating' in m && 'rating' in t) clashes.push({ show_id: m.show_id, mine: m.rating, theirs: t.rating });
    }
    if (value(chosen) !== localValue) {
      if (table === 'ratings') impact.changedRatings++;
      if (table === 'settings') impact.changedSettings++;
    }
    rows.push(chosen);
  }
  return { status: 'merged', rows, clashes, noBase: before === null, impact, remoteChangedKeys };
}
