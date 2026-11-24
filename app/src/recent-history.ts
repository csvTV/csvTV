import type { SettingRow, WatchedRow } from './model.ts';

export const recentPrefix = 'recently_marked.';
export const recentLimit = 8;

export interface RecentScope { season:number; first:number; last:number }

/** Whole-show rows hold legacy positions and dismissals. Season rows identify a native episode range. */
export function recentSource(key: string) {
  if (!key.startsWith(recentPrefix)) return null;
  const fields = key.slice(recentPrefix.length).split('.');
  if (fields.length !== 1 && fields.length !== 4) return null;
  const numbers = fields.map(Number);
  if (!numbers.every((n,i) => Number.isSafeInteger(n) && n >= 0 && String(n) === fields[i])) return null;
  const [id,season,first,last] = numbers;
  if (fields.length === 1) return {id,scope:null};
  if (first === 0 ? last !== 0 : last < first) return null;
  return {id,scope:{season,first,last}};
}

export const recentId = (key:string) => recentSource(key)?.id ?? null;
export const recentSeasonKey = (id:number, scope:RecentScope) =>
  [recentPrefix + id,scope.season,scope.first,scope.last].join('.');

export function recentWatches(rows: readonly WatchedRow[]) {
  const shows = new Map<number,WatchedRow[]>();
  for (const row of rows) {
    const list = shows.get(row.show_id);
    if (list) list.push(row); else shows.set(row.show_id,[row]);
  }
  return shows;
}

export function hasRecentWatch(scope: RecentScope | null, rows: readonly WatchedRow[]) {
  if (!scope) return rows.length > 0;
  return rows.some(row => row.season === scope.season && (!scope.first || row.episode >= scope.first && row.episode <= scope.last));
}

/** The change clock resolves concurrent edits. The rank restores the original position on Undo; zero means removed. */
export function readRecentValue(value: string) {
  const pair = /^([1-9]\d*)\/(0|[1-9]\d*)$/.exec(value);
  if (!pair) return null;
  const changed = BigInt(pair[1]), rank = BigInt(pair[2]);
  return rank <= changed ? {changed,rank} : null;
}

export function* recentSources(settings: readonly SettingRow[]) {
  const barriers = new Map<number,bigint>();
  for (const row of settings) {
    const source = recentSource(row.setting);
    if (source && !source.scope) {
      const entry = readRecentValue(row.value);
      if (entry?.rank === 0n) barriers.set(source.id,entry.changed);
    }
  }
  for (const {setting,value} of settings) {
    const source = recentSource(setting), entry = source && readRecentValue(value);
    if (!source || !entry) continue;
    const {id,scope} = source;
    const rank = scope && entry.rank <= (barriers.get(id) ?? 0n) ? 0n : entry.rank;
    yield {id, scope, rank, changed:entry.changed};
  }
}

export function recentEntries(settings: readonly SettingRow[], watched?: readonly WatchedRow[]) {
  const entries = new Map<number,{changed:bigint;rank:bigint}>();
  let byShow: ReturnType<typeof recentWatches> | undefined;
  for (const entry of recentSources(settings)) {
    const {id,scope} = entry;
    let rank = entry.rank;
    if (rank && watched) {
      byShow ??= recentWatches(watched);
      if (!hasRecentWatch(scope,byShow.get(id) ?? [])) rank = 0n;
    }
    const prior = entries.get(id);
    entries.set(id,{changed: prior && prior.changed > entry.changed ? prior.changed : entry.changed,
      rank: prior && prior.rank > rank ? prior.rank : rank});
  }
  return entries;
}

export function orderedRecents(entries: ReturnType<typeof recentEntries>) {
  return [...entries].filter(([,entry]) => entry.rank > 0)
    .sort(([a,x],[b,y]) => x.rank === y.rank ? a - b : x.rank > y.rank ? -1 : 1).slice(0,recentLimit).map(([id]) => id);
}

export function recentRow(id: number, changed: number | bigint, rank: number | bigint): SettingRow {
  return {setting:recentPrefix + id,value:changed + '/' + rank};
}

export function nextRecentChange(entries: ReturnType<typeof recentEntries>, now = Date.now()) {
  let changed = BigInt(now);
  for (const entry of entries.values()) if (entry.changed >= changed) changed = entry.changed + 1n;
  return changed;
}

/** A legacy device knows relative order, but cannot date its marks ahead of a verified shared edit. */
export function legacyRecentRows(value: unknown, watched?: ReadonlySet<number>) {
  if (!Array.isArray(value)) return [];
  // Earlier devices could save twenty. Retain their ranks so dismissing or undoing can reveal the next title.
  const ids = [...new Set<number>(value.filter(id => Number.isSafeInteger(id) && id >= 0 && (!watched || watched.has(id))))].slice(0,20);
  return ids.map((id,i) => recentRow(id,ids.length-i,ids.length-i));
}

export function preferRecentValue(a: string,b: string) {
  const left = readRecentValue(a)!, right = readRecentValue(b)!;
  if (left.changed !== right.changed) return left.changed > right.changed;
  // A dismissal must survive an equal clock, regardless of which device uploads last.
  return left.rank <= right.rank;
}
