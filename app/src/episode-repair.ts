import { MAX_INTEGER, type WatchedRow } from './model.ts';
import type { DeviceChanges } from './storage.ts';
import type { RepairObservation, TmdbSeason, TmdbShow } from './tmdb-data.ts';

type Destination = Pick<WatchedRow, 'season' | 'episode' | 'title'>;
export interface RepairMove {
  from: WatchedRow;
  to: Destination;
  occupied: WatchedRow | null;
  combinedCount: bigint;
}
export interface RepairPlan {
  showId: number;
  moves: RepairMove[];
  missing: WatchedRow[];
}
export interface RepairPreview extends RepairPlan {
  revision: bigint;
  generation: bigint;
  accountId: string | null;
}

const place = (row: Pick<WatchedRow, 'season' | 'episode'>) => row.season + '/' + row.episode;

export function observation(entry: { fetchedAt: number; repairScan?: RepairObservation }) {
  return entry.repairScan ?? { at: entry.fetchedAt };
}
export function covers(seen: RepairObservation | undefined, source: RepairObservation | undefined): boolean {
  return !source || Boolean(seen && (seen.at > source.at || (seen.at === source.at && seen.group === source.group)));
}

/** Only an observed stable ID can move a row. A 404 is a completed lookup;
 * a failed or unfetched season cannot establish that an episode disappeared. */
export function planEpisodeRepair(showId: number, rows: readonly WatchedRow[],
    show: TmdbShow | null | undefined, seasons: ReadonlyMap<number, TmdbSeason | null>,
    observed?: { parent?: RepairObservation; seasons: ReadonlyMap<number, RepairObservation> }): RepairPlan {
  const listed = show === undefined ? undefined : new Set(show?.seasons.map(s => s.season));
  const complete = listed !== undefined && [...listed].every(number => seasons.has(number));
  const locations = new Map<number, Destination | null>();
  for (const [number, season] of seasons) {
    if (listed && !listed.has(number)) continue;
    for (const episode of season?.episodes ?? []) {
      // A stale season and its replacement may both report the same ID.
      locations.set(episode.episode_id, locations.has(episode.episode_id) ? null :
        { season: number, episode: episode.episode, title: episode.title });
    }
  }

  const saved = rows.filter(row => row.show_id === showId);
  const positions = new Map(saved.map(row => [place(row), row]));
  const seen = new Set<number>(), duplicate = new Set<number>();
  for (const { episode_id } of saved) {
    if (episode_id === null) continue;
    if (seen.has(episode_id)) duplicate.add(episode_id);
    seen.add(episode_id);
  }

  const missing: WatchedRow[] = [];
  const checkedScans = new Map<RepairObservation,boolean>();
  const candidates = new Map<string, { from: WatchedRow; to: Destination }>();
  for (const row of saved) {
    if (row.episode_id === null || duplicate.has(row.episode_id)) continue;
    const target = locations.get(row.episode_id);
    const source = listed && !listed.has(row.season) ? observed?.parent : observed?.seasons.get(row.season);
    if (target && place(target) !== place(row) && covers(observed?.seasons.get(target.season), source)) {
      candidates.set(place(row), { from: row, to: target });
    }
    if (!complete || target !== undefined) continue;
    // All watches in the source season share the same freshness requirement.
    if (source && !checkedScans.has(source)) {
      checkedScans.set(source, covers(observed?.parent, source) &&
        [...listed].every(number => covers(observed?.seasons.get(number), source)));
    }
    if (!source || checkedScans.get(source)) missing.push(row);
  }

  // A chain can end at an empty place or a confirmed stationary row. If the
  // last occupant might move elsewhere, keep the entire chain for later review.
  const missingPlaces = new Set(missing.map(place));
  const preceding = new Map<string, string>();
  const blocked: string[] = [];
  for (const [source, move] of candidates) {
    const target = place(move.to);
    preceding.set(target, source);
    const occupant = positions.get(target);
    if (occupant && occupant.episode_id !== null && !missingPlaces.has(target) && !candidates.has(target)) {
      blocked.push(source);
    }
  }
  while (blocked.length) {
    const source = blocked.pop()!;
    if (!candidates.delete(source)) continue;
    const previous = preceding.get(source);
    if (previous) blocked.push(previous);
  }

  const moves: RepairMove[] = [];
  for (const { from, to } of candidates.values()) {
    const target = place(to);
    const occupied = candidates.has(target) ? null : positions.get(target) ?? null;
    moves.push({ from, to, occupied, combinedCount: BigInt(from.times_watched) + BigInt(occupied?.times_watched ?? 0) });
  }
  moves.sort((a, b) => a.from.season - b.from.season || a.from.episode - b.from.episode);
  return { showId, moves, missing };
}

/** Compare only the choices the owner authorized, independently of an unrelated
 * record edit or a provider refresh which returned the same episode positions. */
export function sameRepair(before: RepairPreview, now: RepairPreview): boolean {
  const describe = (move: RepairMove) => [move.from, move.to, move.occupied, String(move.combinedCount)];
  return before.showId === now.showId && before.generation === now.generation && before.accountId === now.accountId &&
    JSON.stringify(before.moves.map(describe)) === JSON.stringify(now.moves.map(describe));
}

export function repairPatch(plan: RepairPlan): DeviceChanges {
  const remove: [number, number, number][] = [], put: WatchedRow[] = [];
  for (const { from, to, combinedCount } of plan.moves) {
    if (combinedCount > BigInt(MAX_INTEGER)) {
      const show = from.show || 'Show ' + from.show_id;
      throw new RangeError(show + ' · Moving S' + from.season + ' E' + from.episode + ' to S' + to.season +
        ' E' + to.episode + ' would make the combined watch count too large to save.');
    }
    remove.push([plan.showId, from.season, from.episode]);
    put.push({ ...from, ...to, times_watched: Number(combinedCount) });
  }
  // DeviceStore removes all old positions before writing any of the new ones.
  return { remove: { watched: remove }, put: { watched: put } };
}
