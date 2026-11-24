import { watchPosition, type WatchedRow } from './model.ts';

export const sides = ['before', 'mine', 'theirs'] as const;
type Side = typeof sides[number];
export type WatchInputs = Record<Side, readonly WatchedRow[]>;
export interface Place {
  show_id: number;
  season: number;
  episode: number;
  episode_id: number | null;
}
export interface EpisodeGroup {
  place: Place;
  before?: WatchedRow;
  mine?: WatchedRow;
  theirs?: WatchedRow;
}
export interface IdentityProblem {
  reason: string;
  places: readonly Place[];
}

/** Each number is an index in that side's displayed input, including deleted rows in before. */
export interface IdentityAssignment extends Place {
  before?: number;
  mine?: number;
  theirs?: number;
}

export function episodeKey(place: Place): string {
  return place.episode_id === null
    ? JSON.stringify([place.show_id, 'slot', place.season, place.episode])
    : JSON.stringify([place.show_id, 'id', place.episode_id]);
}

/** Exact replacements must identify each episode once. Blank IDs retain their CSV positions. */
export function hasRepeatedEpisode(rows: readonly Place[]): boolean {
  const seen = new Set<string>();
  for (const row of rows) {
    const key = episodeKey(row);
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

function placeOf(row: Place, episode_id = row.episode_id): Place {
  return { show_id: row.show_id, season: row.season, episode: row.episode, episode_id };
}

function positionOf(group: EpisodeGroup): WatchedRow | undefined {
  const { before, mine, theirs } = group;
  if (!mine || !theirs) return mine ?? theirs ?? before;
  const local = watchPosition(mine), remote = watchPosition(theirs);
  if (local === remote) return mine;
  if (before && watchPosition(before) === local) return theirs;
  if (before && watchPosition(before) === remote) return mine;
  return undefined;
}

export function alignEpisodes(inputs: WatchInputs, collectAllConflicts = false): EpisodeGroup[] | IdentityProblem {
  const idsAtSlot = new Map<string, Set<number>>();
  const firstSlot = new Map<string, string>();
  const moved = new Set<string>();
  for (const side of sides) {
    for (const row of inputs[side]) {
      if (row.episode_id === null) continue;
      const slot = watchPosition(row);
      const id = episodeKey(row);
      const ids = idsAtSlot.get(slot) ?? new Set<number>();
      ids.add(row.episode_id);
      idsAtSlot.set(slot, ids);
      if (firstSlot.has(id) && firstSlot.get(id) !== slot) moved.add(id);
      else firstSlot.set(id, slot);
    }
  }

  const groups = new Map<string, EpisodeGroup>();
  let problem:{reason:string;places:Place[]}|undefined;
  const conflict = (reason:string,place:Place) => {
    problem ??= {reason,places:[]};
    problem.places.push(place);
    return problem;
  };
  for (const side of sides) {
    for (const row of inputs[side]) {
      let id = row.episode_id;
      if (id === null) {
        const candidates = idsAtSlot.get(watchPosition(row));
        if (candidates?.size === 1) id = candidates.values().next().value!;
        if ((candidates && candidates.size > 1) || (id !== null && moved.has(episodeKey(placeOf(row, id))))) {
          const issue = conflict('An unidentified row occupies a moved or reused position.',row);
          if (!collectAllConflicts) return issue;
          continue;
        }
      }
      const place = placeOf(row, id);
      const key = episodeKey(place);
      const group = groups.get(key) ?? { place };
      if (group[side]) {
        const issue = conflict('One input assigns multiple rows to the same episode.',row);
        if (!collectAllConflicts) return issue;
        continue;
      }
      group[side] = row;
      groups.set(key, group);
    }
  }
  for (const group of groups.values()) {
    const destination = positionOf(group);
    if (!destination) {
      const issue = conflict('The same episode has conflicting destination positions.',group.place);
      if (!collectAllConflicts) return issue;
      continue;
    }
    group.place = placeOf(destination, group.place.episode_id);
  }
  return problem ?? [...groups.values()];
}

export function competingRows(inputs: WatchInputs, places: readonly Place[]) {
  const slots = new Set(places.map(watchPosition));
  const ids = new Set(places.filter(p => p.episode_id !== null).map(episodeKey));
  // Include a known occupant of an ambiguous blank slot wherever that ID appears.
  for (const side of sides) {
    for (const row of inputs[side]) {
      if (row.episode_id !== null && slots.has(watchPosition(row))) ids.add(episodeKey(row));
    }
  }
  const conflicts: { side: Side; index: number; row: WatchedRow }[] = [];
  for (const side of sides) {
    inputs[side].forEach((row, index) => {
      if (slots.has(watchPosition(row)) || ids.has(episodeKey(row))) conflicts.push({ side, index, row });
    });
  }
  return conflicts;
}

export function applyAssignments(inputs: WatchInputs, assignments: readonly IdentityAssignment[]): EpisodeGroup[] | string {
  const seen = { before: new Set<number>(), mine: new Set<number>(), theirs: new Set<number>() };
  const groups: EpisodeGroup[] = [];
  const ids = new Set<string>();
  for (const entry of assignments) {
    const fields = [entry.show_id, entry.season, entry.episode];
    if (entry.episode_id !== null) fields.push(entry.episode_id);
    if (!fields.every(n => Number.isSafeInteger(n) && n >= 0)) return 'Invalid destination or episode ID.';
    const place = placeOf(entry);
    const key = episodeKey(place);
    if (place.episode_id !== null && ids.has(key)) return 'A stable ID was assigned twice.';
    ids.add(key);
    const group: EpisodeGroup = { place };
    for (const side of sides) {
      const index = entry[side];
      if (index === undefined) continue;
      if (!Number.isSafeInteger(index) || index < 0 || index >= inputs[side].length || seen[side].has(index)) {
        return 'Each input row must contribute exactly once.';
      }
      const row = inputs[side][index]!;
      if (row.show_id !== place.show_id) return 'An episode cannot move to another show.';
      seen[side].add(index);
      group[side] = row;
    }
    if (!group.before && !group.mine && !group.theirs) return 'A mapped episode has no input rows.';
    groups.push(group);
  }
  if (sides.some(side => seen[side].size !== inputs[side].length)) return 'The mapping omitted an input row.';
  return groups;
}
