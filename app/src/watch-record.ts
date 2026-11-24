import type { WatchDelta } from './marks.ts';
import { watchPosition, type WatchedRow } from './model.ts';
import { broadcastRangeAt, type BroadcastSeason } from './broadcast-seasons.ts';
import { hasRecentWatch, legacyRecentRows, nextRecentChange, readRecentValue, recentEntries, recentPrefix, recentSeasonKey, recentSource, recentWatches,
  type RecentScope } from './recent-history.ts';
import type { DeviceChanges, DeviceSnapshot, DeviceStore } from './storage.ts';

export type ShowRecord = Awaited<ReturnType<DeviceStore['tmdbRows']>>;
export interface RecentMarkUndo {
  revision: bigint;
  writes: { setting: string; priorRank: bigint; rank: bigint; changed: bigint }[];
}
interface UndoContext { original: RecentMarkUndo; revisions: ReadonlyMap<number, bigint> }
export interface WatchReceipt {
  changes: WatchDelta[];
  skipped: number;
  recent: RecentMarkUndo;
}

/** Save only the changed episode positions. A moved episode can occupy a different position during Undo. */
export function watchPatch(id: number, before: ShowRecord, rows: readonly WatchedRow[], skipped = 0, undo?: UndoContext,
    ranges: readonly BroadcastSeason[] | null = null) {
  const old = new Map(before.tables.watched.map(row => [watchPosition(row), row]));
  const remaining = new Map(rows.map(row => [watchPosition(row), row]));
  const changes: WatchDelta[] = [];
  const put: WatchedRow[] = [];
  const remove: [number, number, number][] = [];
  for (const [key, row] of remaining) {
    const prior = old.get(key);
    const change = BigInt(row.times_watched) - BigInt(prior?.times_watched ?? 0);
    if (change === 0n) continue;
    changes.push({ row: prior ?? row, change });
    put.push(row);
  }
  for (const [key, row] of old) {
    if (remaining.has(key)) continue;
    changes.push({ row, change: -BigInt(row.times_watched) });
    remove.push([id, row.season, row.episode]);
  }
  const receipt: WatchReceipt = { changes, skipped, recent: { revision: before.revision + 1n, writes: [] } };
  const patch: DeviceChanges = { put: { watched: put }, remove: { watched: remove } };
  updateRecentMark(id, before, rows, patch, receipt, ranges, undo);
  return { patch, receipt };
}

function scopeFor(row: WatchedRow, ranges: readonly BroadcastSeason[] | null): RecentScope {
  const part = ranges && broadcastRangeAt(ranges,row.season,row.episode);
  return {season:row.season,first:part?.first ?? 0,last:part?.last ?? 0};
}

function hasWatch(scope: RecentScope | null, rows: readonly WatchedRow[], ranges: readonly BroadcastSeason[] | null = null) {
  const part = scope?.first && ranges && broadcastRangeAt(ranges,scope.season,scope.first);
  return hasRecentWatch(scope && part && part.first === scope.first ? {...scope,last:part.last} : scope,rows);
}

function updateRecentMark(id: number, before: ShowRecord, watched: readonly WatchedRow[], patch: DeviceChanges,
    receipt: WatchReceipt, ranges: readonly BroadcastSeason[] | null, undo?: UndoContext) {
  if (!receipt.changes.length) return;
  const legacy = !before.recentSettings.length ? legacyRecentRows(before.recentlyMarked) : [];
  const settings = legacy.length ? legacy : before.recentSettings;
  const changed = nextRecentChange(recentEntries(settings));
  const entries = new Map<string,{changed:bigint;rank:bigint}>();
  for (const {setting,value} of settings) {
    if (recentSource(setting)?.id !== id) continue;
    const entry = readRecentValue(value);
    if (entry) entries.set(setting,entry);
  }
  const rows = new Map(legacy.map(row => [row.setting,row]));
  const written = new Set<string>();
  function write(setting: string, rank: bigint) {
    written.add(setting);
    receipt.recent.writes.push({setting,priorRank:entries.get(setting)?.rank ?? 0n,rank,changed});
    rows.set(setting,{setting,value:changed + '/' + rank});
  }
  const showKey = recentPrefix + id;
  const dismissal = entries.get(showKey);
  if (undo) {
    if (!receipt.skipped && undo.revisions.get(id) === undo.original.revision) {
      for (const original of undo.original.writes) {
        // A newer synced mark or dismissal owns this spot, even if counts can still be undone.
        const current = entries.get(original.setting);
        if (current?.changed !== original.changed || current.rank !== original.rank) continue;
        if (dismissal?.rank === 0n && dismissal.changed > original.changed) continue;
        const scope = recentSource(original.setting)!.scope;
        write(original.setting,hasWatch(scope,watched,ranges) ? original.priorRank : 0n);
      }
    }
  } else {
    const additions = new Map<string,RecentScope>();
    for (const {row,change} of receipt.changes) {
      if (change <= 0n || row.season === 0 && before.tables.watched.length) continue;
      const scope = scopeFor(row,ranges);
      additions.set(recentSeasonKey(id,scope),scope);
    }
    for (const [key,scope] of additions) if (!hasWatch(scope,before.tables.watched)) write(key,changed);
  }
  for (const [key,entry] of entries) {
    if (!entry.rank || written.has(key)) continue;
    const scope = recentSource(key)!.scope;
    if (!hasWatch(scope,watched,ranges)) {
      if (hasWatch(scope,before.tables.watched,ranges)) write(key,0n);
      continue;
    }
    // Keep a growing broadcast season's original rank when only newly aired episodes remain.
    const current = scope?.first && ranges && broadcastRangeAt(ranges,scope.season,scope.first);
    if (!undo && scope && current && current.first === scope.first && current.last !== scope.last) {
      const revisedKey = recentSeasonKey(id,{...scope,last:current.last});
      if (!written.has(revisedKey) && (entries.get(revisedKey)?.rank ?? 0n) < entry.rank) write(revisedKey,entry.rank);
      write(key,0n);
    }
  }
  if (rows.size) patch.put = {...patch.put,settings:[...rows.values()]};
  if (legacy.length) patch.removeLocal = ['recentlyMarked'];
}

/** Importing a watch never creates a recent mark; Dropbox transmits explicit marks separately in settings.csv. */
export function retainRecentMarks(snapshot: DeviceSnapshot, patch: DeviceChanges, fromDropbox = false): DeviceChanges {
  const recent = snapshot.local.recentlyMarked;
  const displaced = snapshot.local.displacedRecentMark;
  if (!Array.isArray(recent)) return patch;
  const replacement = patch.replace?.watched;
  if (!replacement && !patch.put?.watched?.length && !patch.remove?.watched?.length) return patch;
  const before = recentWatches(snapshot.tables.watched);
  const removed = new Set(patch.remove?.watched?.map(key => JSON.stringify(key)));
  const kept = replacement ?? snapshot.tables.watched;
  const after = recentWatches([...(removed.size ? kept.filter(row => !removed.has(watchPosition(row))) : kept),...patch.put?.watched ?? []]);
  const continuous = (id: number) => before.has(id) && after.has(id);
  const retained = recent.filter(continuous);
  if (typeof displaced === 'number' && (!before.has(displaced) || !after.has(displaced))) {
    patch = { ...patch, removeLocal: [...patch.removeLocal ?? [], 'displacedRecentMark'] };
  }
  const shared = snapshot.tables.settings.filter(row => recentSource(row.setting));
  if (shared.length) {
    // Dropbox may deliver watched.csv before or after settings.csv on a fresh device.
    // Only the loss of an existing watch invalidates a shared mark in that case.
    if (patch.replace?.settings) return patch;
    const rows = [];
    for (const {setting,value} of shared) {
      const {id,scope} = recentSource(setting)!;
      const entry = readRecentValue(value);
      if (!entry?.rank) continue;
      const previouslyWatched = hasWatch(scope,before.get(id) ?? []);
      const nowWatched = hasWatch(scope,after.get(id) ?? []);
      // An unrelated import leaves a mark waiting for Dropbox's copy of its watches.
      if (previouslyWatched !== nowWatched && (previouslyWatched || !fromDropbox)) {
        rows.push({setting,value:entry.changed + '/0'});
      }
    }
    if (!rows.length) return patch;
    return {...patch,put:{...patch.put,settings:[...patch.put?.settings ?? [],...rows]}};
  }
  return retained.length === recent.length ? patch : { ...patch, local: { ...patch.local, recentlyMarked: retained } };
}
