import { compareFileText, csvColumns } from './csv.ts';
import { isAnimeClassification } from './anime.ts';
import { broadcastPosition, type BroadcastSeason } from './broadcast-seasons.ts';
import { canonicalListName, canonicalListRows, foldListName, rowKey, watchPosition, type ListRow, type RatingRow, type ShowRow, type TableName, type TableRows, type WatchedRow } from './model.ts';
import { episodeKey } from './watch-identity.ts';
import { dropMembership, upcomingMembership } from './upcoming-preference.ts';
import type { DeviceChanges, ImportPreviewSnapshot } from './storage.ts';

type ImportAction = {value: string; text: string} | {previous?: WatchedRow; next: WatchedRow};
interface WatchProposal { row: WatchedRow; before: number; after: number; previous?: WatchedRow }
interface RatingProposal { row: RatingRow; before: number | null; after: number }
interface ListProposal { row: ListRow; label: string; present: boolean }

export interface ImportPlan {
  broadcastByShow?: ReadonlyMap<number,readonly BroadcastSeason[]>;
  shows: ShowRow[];
  watched: WatchProposal[];
  ratings: RatingProposal[];
  lists: ListProposal[];
  skipped: string[];
  changes: DeviceChanges;
  actions: ReadonlyMap<string, ImportAction>;
  accountId: unknown;
  instanceId: string | null;
}

interface ImportRows {
  broadcastByShow?: ImportPlan['broadcastByShow'];
  shows: ShowRow[];
  watched: readonly WatchedRow[];
  ratings: RatingRow[];
  lists: ListRow[];
  skipped: string[];
  reviewNotes?: readonly string[];
  reusedPositions: ReadonlySet<string>;
}

function values<K extends TableName>(table: K, row?: TableRows[K]) {
  return row ? csvColumns[table].map(key => Reflect.get(row, key)) : null;
}
export function importEpisodeLabel(row: WatchedRow, byShow?: ImportPlan['broadcastByShow']) {
  const ranges = byShow?.get(row.show_id) ?? null;
  const position = broadcastPosition(ranges,row.season,row.episode);
  const range = ranges?.find(r=>r.number===position.season);
  return (range?.name ?? 'S' + position.season) + ' E' + (range?.unassigned ? row.episode : position.episode);
}
const episodeLabel = (row: WatchedRow, byShow?: ImportPlan['broadcastByShow']) =>
  (row.show || 'Show ' + row.show_id) + ' ' + importEpisodeLabel(row,byShow) + (row.title ? ' · ' + row.title : '');
const episodeIdLabel = (row: WatchedRow) => row.episode_id === null ? 'episode ID missing' : 'TMDB episode ' + row.episode_id;
const showDetails = (row: ShowRow) => [row.show || 'Untitled show', row.year ?? 'unknown year', row.imdb_id || 'no IMDb ID'].join(' · ');

/** A known ID may move, including a swap. Never overwrite an unrelated watch to make room. */
function placeAmongLocal(placement: ImportRows, existing: WatchedRow[], skipped: string[]) {
  type Candidate = { row: WatchedRow; previous?: WatchedRow; reason?: string };
  if (!placement.watched.length) return [];
  if (!existing.length) return placement.watched.map((row): Candidate => ({row}));
  const importedShows = new Set<number>();
  for (const row of placement.watched) importedShows.add(row.show_id);
  const bySlot = new Map<string, WatchedRow>();
  const byId = new Map<string, WatchedRow>();
  const repeated = new Set<string>();
  for (const row of existing) {
    if (!importedShows.has(row.show_id)) continue;
    bySlot.set(watchPosition(row),row);
    if (row.episode_id === null) continue;
    const id = episodeKey(row);
    if (byId.has(id)) repeated.add(id);
    byId.set(id, row);
  }
  const candidates: Candidate[] = [];
  const leaving = new Map<string, Candidate>();
  const waiting = new Map<string, Candidate>();
  const blocked: Candidate[] = [];
  for (const row of placement.watched) {
    const id = episodeKey(row), target = watchPosition(row);
    const occupant = bySlot.get(target);
    const item: Candidate = { row, previous: byId.get(id) };
    if (repeated.has(id)) item.reason = 'its episode ID occurs at several positions in your record';
    if (!item.previous && occupant?.episode_id === null) {
      if (placement.reusedPositions.has(target)) item.reason = 'the existing watch has no episode ID and TMDB reused this position';
      else item.previous = occupant;
    }
    if (item.previous && watchPosition(item.previous) !== target) leaving.set(watchPosition(item.previous), item);
    candidates.push(item);
  }
  for (const item of candidates) {
    const slot = watchPosition(item.row), occupant = bySlot.get(slot);
    if (occupant && occupant !== item.previous) {
      waiting.set(slot, item);
      if (!leaving.has(slot)) item.reason ??= 'another watched episode occupies this position in your record';
    }
    if (item.reason) blocked.push(item);
  }
  // If one move cannot happen, its old slot is still occupied for every dependent move.
  for (let index = 0; index < blocked.length; index++) {
    const previous = blocked[index].previous;
    const next = previous && waiting.get(watchPosition(previous));
    if (next && !next.reason) {
      next.reason = 'the existing watch could not move out of this position';
      blocked.push(next);
    }
  }
  for (const item of blocked) skipped.push(episodeLabel(item.row,placement.broadcastByShow) + ' (' + episodeIdLabel(item.row) + ') was skipped because ' + item.reason + '.');
  return candidates.filter(item => !item.reason);
}

/** Compare imported rows with the committed record, keeping identity conflicts out of the write. */
export function planImportRows(placement: ImportRows, snapshot: ImportPreviewSnapshot, source: 'Trakt' | 'AniList',
    adjustedCount?: (row: WatchedRow) => number): ImportPlan {
  const { tables } = snapshot;
  const actions = new Map<string, ImportAction>();
  const addAction = (key: string, value: unknown, text: string) => actions.set(key, { value: JSON.stringify(value), text });
  const skipped = [...placement.skipped];

  const watched: WatchProposal[] = [], ratings: RatingProposal[] = [], lists: ListProposal[] = [];
  const putWatched: WatchedRow[] = [], putRatings: RatingRow[] = [], putLists: ListRow[] = [], putShows: ShowRow[] = [];
  const remove: [number, number, number][] = [];
  for (const { row, previous } of placeAmongLocal(placement, tables.watched, skipped)) {
    const before = previous?.times_watched ?? 0;
    const after = Math.max(before, adjustedCount?.(row) ?? row.times_watched);
    const final = { ...row, times_watched: after, show: row.show || previous?.show || '', title: row.title || previous?.title || '' };
    const moved = previous && watchPosition(previous) !== watchPosition(row);
    if (moved) remove.push([previous.show_id, previous.season, previous.episode]);
    watched.push({ row, previous, before, after });
    if (!sameWatchRow(previous,final)) putWatched.push(final);
    // Keep immutable approval evidence. Only a revised import needs a human-readable episode description.
    actions.set('episode/' + episodeKey(row), {previous:previous && {...previous},next:{...final}});
  }
  const currentRatings = new Map(tables.ratings.map(row => [row.show_id, row.rating]));
  for (const row of placement.ratings) {
    const before = currentRatings.get(row.show_id) ?? null, after = before ?? row.rating;
    ratings.push({ row, before, after });
    if (before === null) putRatings.push(row);
    addAction('rating/' + row.show_id, [row.rating, before, after], row.show + ' · ' + (before === null
      ? 'add ' + source + ' rating ' + row.rating : 'keep your rating ' + before + ' (' + source + ' ' + row.rating + ')'));
  }
  const spellings = new Map<string, Set<string>>();
  const watchedIds = new Set<number>();
  for (const rows of [tables.watched, putWatched]) {
    for (const row of rows) watchedIds.add(row.show_id);
  }
  const memberships = canonicalListRows(tables.lists);
  const members = new Set(memberships.map(row => rowKey('lists', row)));
  const optedOut = new Set<number>(), legacyFollows = new Set<number>(), pickedUp = new Set<number>();
  for (const row of memberships) {
    if (dropMembership(row.list) === 'picked-up') pickedUp.add(row.show_id);
    const preference = upcomingMembership(row.list);
    if (preference === 'hidden') optedOut.add(row.show_id);
    if (preference === 'following') legacyFollows.add(row.show_id);
    const key = foldListName(row.list);
    if (!spellings.has(key)) spellings.set(key, new Set());
    spellings.get(key)!.add(row.list);
  }
  for (const entry of placement.lists) {
    if (dropMembership(entry.list) === 'dropped' && pickedUp.has(entry.show_id)) continue;
    const watchlist = upcomingMembership(entry.list) === 'watchlist';
    if (watchlist && (watchedIds.has(entry.show_id) || optedOut.has(entry.show_id))) continue;
    const canonical = canonicalListName(entry.list);
    const names = [...(spellings.get(foldListName(canonical)) ?? [canonical])].sort(compareFileText);
    for (const list of names) {
      const row = { ...entry, list }, key = rowKey('lists', row);
      if (actions.has('list/' + key)) continue;
      const present = members.has(key) || (watchlist && legacyFollows.has(entry.show_id));
      const label = list;
      lists.push({ row, label, present });
      if (!present) putLists.push(row);
      const description = isAnimeClassification(list) ? row.show + (present ? ' already matches the Anime filter' : ' will match the Anime filter')
        : dropMembership(list) === 'dropped' ? row.show + (present ? ' is already dropped' : ' will be marked Dropped')
        : row.show + (present ? ' already belongs to ' : ' will be added to ') + label;
      addAction('list/' + key, present, description);
    }
  }
  const referenced = new Set(watchedIds);
  for (const table of [tables.ratings, tables.lists, putRatings, putLists]) {
    for (const row of table) referenced.add(row.show_id);
  }
  const currentShows = new Map(tables.shows.map(row => [row.show_id, row]));
  for (const row of placement.shows) {
    if (!referenced.has(row.show_id)) continue;
    const old = currentShows.get(row.show_id);
    const next = { show_id: row.show_id, show: row.show || old?.show || '', year: row.year ?? old?.year ?? null,
      imdb_id: row.imdb_id || old?.imdb_id || '' };
    const prior = values('shows', old), nextValues = values('shows', next);
    if (JSON.stringify(prior) !== JSON.stringify(nextValues)) {
      putShows.push(next);
      addAction('show/' + row.show_id, [prior, nextValues], 'Show ' + row.show_id + ' · ' +
        (old ? showDetails(old) + ' → ' : 'add ') + showDetails(next));
    }
  }
  for (const reason of skipped) addAction('skip/' + reason, reason, reason);
  for (const note of placement.reviewNotes ?? []) addAction('note/' + note, note, note);
  const changes: DeviceChanges = { put: { watched: putWatched, ratings: putRatings, lists: putLists, shows: putShows },
    remove: { watched: remove } };
  const session = snapshot.local.dropboxSession;
  const broadcastByShow = placement.broadcastByShow && new Map([...placement.broadcastByShow].map(
    ([id,ranges]) => [id,ranges.map(range => ({...range}))]));
  return { shows: placement.shows, watched, ratings, lists, skipped, broadcastByShow,
    actions, changes, accountId: snapshot.local.syncAccountId ?? null, instanceId: session?.instanceId ?? null };
}

function sameWatchRow(a?: WatchedRow, b?: WatchedRow) {
  return a === b || !!a && !!b && csvColumns.watched.every(key => (a[key] ?? null) === (b[key] ?? null));
}

function sameAction(current: ImportAction, previous?: ImportAction) {
  if (!previous) return false;
  if ('value' in current) return 'value' in previous && current.value === previous.value;
  return 'next' in previous && sameWatchRow(current.previous,previous.previous) && sameWatchRow(current.next,previous.next);
}

function actionText(action: ImportAction, byShow?: ImportPlan['broadcastByShow']) {
  if ('text' in action) return action.text;
  const {previous,next} = action;
  const move = previous && watchPosition(previous) !== watchPosition(next) ? ' (moved from ' + importEpisodeLabel(previous,byShow) + ')' : '';
  const renamed = previous && (previous.show !== next.show || previous.title !== next.title) ? ' · previously ' + episodeLabel(previous,byShow) : '';
  const identified = previous && previous.episode_id === null ? ' · matched a previously blank episode ID' : '';
  return episodeLabel(next,byShow) + ' (' + episodeIdLabel(next) + ')' + move + renamed + identified + ' · ' +
    (previous?.times_watched ?? 0) + ' → ' + next.times_watched + ' plays';
}

/** An approval covers the same actions and row values regardless of their insertion order. */
export function sameImportOutcome(current: ImportPlan, previous: ImportPlan) {
  if (current.actions.size !== previous.actions.size) return false;
  for (const [key, entry] of current.actions) {
    if (!sameAction(entry,previous.actions.get(key))) return false;
  }
  return true;
}

/** Explain only the results that changed since the owner last approved the archive. */
export function describeImportChanges(current: ImportPlan, previous: ImportPlan): string[] {
  const differences: string[] = [];
  for (const [key, entry] of current.actions) {
    const old = previous.actions.get(key);
    if (!sameAction(entry,old)) differences.push((old ? actionText(old,previous.broadcastByShow) + ' → ' : '') + actionText(entry,current.broadcastByShow));
  }
  for (const [key, entry] of previous.actions) {
    if (!current.actions.has(key)) differences.push('Removed from this preview · ' + actionText(entry,previous.broadcastByShow));
  }
  return differences;
}
