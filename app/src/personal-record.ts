import { compareFileText } from './csv.ts';
import { isAnimeClassification } from './anime.ts';
import { canonicalListName, foldListName, isListDeclaration, LIST_DECLARATION_ID, rowKey, type ListRow, type RatingRow } from './model.ts';
import type { DeviceChanges, PersonalSnapshot } from './storage.ts';
import { droppedList, dropMembership, pickedUpList, upcomingHiddenList, upcomingMembership, upcomingReason } from './upcoming-preference.ts';
export { visibleListRows } from './upcoming-preference.ts';

export type PersonalShow = Pick<RatingRow, 'show_id' | 'show'>;
export type ListQuestion = { kind: 'last-show' | 'delete' | 'rename'; name: string; count: number; newName?: string };
export class PersonalRecordError extends Error {}

export function isWatchlist(name: string): boolean {
  return foldListName(name) === 'watchlist';
}

export function orderedListNames(rows: readonly ListRow[]): string[] {
  const names = new Set(rows.filter(row => !upcomingMembership(row.list) && !dropMembership(row.list) && !isAnimeClassification(row.list)).map(row => canonicalListName(row.list)));
  return ['Watchlist', ...[...names].sort(compareFileText)];
}

export function validateListName(input: string, rows: readonly ListRow[], except?: string): string {
  const name = canonicalListName(input.replace(/^ +| +$/g, ''));
  if (!name) throw new PersonalRecordError('Enter a list name.');
  if (dropMembership(name)) throw new PersonalRecordError('This name is reserved for the Dropped filter.');
  if (isAnimeClassification(name)) throw new PersonalRecordError('Anime is a Library filter. Choose another list name.');
  const folded = foldListName(name);
  if (upcomingMembership(name) || rows.some(row => row.list !== except && foldListName(canonicalListName(row.list)) === folded)) {
    throw new PersonalRecordError('A list with this name already exists.');
  }
  return name;
}

export type PersonalUndo =
  | { kind: 'rating'; label: string; id: number; before: RatingRow | null }
  | { kind: 'membership'; label: string; added: ListRow[]; removed: ListRow[] };
export interface PersonalEdit {
  patch: DeviceChanges;
  undo: PersonalUndo | null;
  confirmation?: { question: ListQuestion; members: number[] };
}

function listKey(row: ListRow): [string, number] { return [row.list, row.show_id]; }

export function rateShow(before: RatingRow | null, show: PersonalShow, rating: number | null, expected?: number): PersonalEdit | undefined {
  if (expected !== undefined && before?.rating !== expected)
    throw new PersonalRecordError('This rating changed. Check its current score and try again.');
  if (rating !== null && (!Number.isInteger(rating * 2) || rating < 0 || rating > 10)) {
    throw new PersonalRecordError('Choose a rating from 0 to 10 in half steps.');
  }
  if ((before?.rating ?? null) === rating) return;
  const patch = rating === null ? { remove: { ratings: [show.show_id] } } :
    { put: { ratings: [{ show_id: show.show_id, show: before?.show || show.show, rating }] } };
  return { patch, undo: { kind: 'rating', id: show.show_id, before, label: rating === null ? 'Rating removed' : 'Rating saved' } };
}

function changeMembership(added: ListRow[], removed: ListRow[], label: string): PersonalEdit {
  return { patch: { put: { lists: added }, remove: { lists: removed.map(listKey) } },
    undo: { kind: 'membership', label, added, removed } };
}

export function setShowDropped(snapshot: PersonalSnapshot, show: PersonalShow, dropped: boolean): PersonalEdit | undefined {
  const prior = snapshot.lists.filter(row => row.show_id === show.show_id && dropMembership(row.list));
  if (prior.some(row => dropMembership(row.list) === 'dropped') === dropped) return;
  const status = dropped ? 'dropped' : 'picked-up';
  const removed = prior.filter(row => dropMembership(row.list) !== status);
  const added = prior.some(row => dropMembership(row.list) === status) ? [] : [{ ...show, list: dropped ? droppedList : pickedUpList }];
  return changeMembership(added, removed, dropped ? 'Show dropped' : 'Show picked up');
}

function setWatchlistMember(snapshot: PersonalSnapshot, show: PersonalShow, enabled: boolean, spelling = 'Watchlist'): PersonalEdit | undefined {
  if (enabled && snapshot.lists.some(row => row.show_id === show.show_id && dropMembership(row.list) === 'dropped'))
    throw new PersonalRecordError('Pick up this show before adding it to Watchlist.');
  if (enabled && snapshot.watchedIds.has(show.show_id))
    throw new PersonalRecordError('This show already has watched episodes.');
  const mine = snapshot.lists.filter(row => row.show_id === show.show_id && upcomingMembership(row.list));
  if (Boolean(upcomingReason(mine.map(row => row.list))) === enabled) return;
  const desired = enabled ? 'watchlist' : 'hidden';
  const removed = mine.filter(row => upcomingMembership(row.list) !== desired);
  // Keep existing file spellings on a hand-edited record. A removal suppresses repeat imports.
  const canonical = enabled ? spelling : upcomingHiddenList;
  const names = snapshot.lists.filter(row => upcomingMembership(row.list) === desired).map(row => row.list);
  const list = names.includes(canonical) ? canonical : names.sort(compareFileText)[0] ?? canonical;
  const title = enabled ? show.show : mine.find(row => row.show)?.show ?? mine[0]?.show ?? show.show;
  const added = mine.some(row => upcomingMembership(row.list) === desired) ? [] : [{show_id:show.show_id, show:title, list}];
  return changeMembership(added, removed, enabled ? 'Added to Watchlist' : 'Taken off Watchlist');
}

function confirmListChange(kind: ListQuestion['kind'], name: string, rows: ListRow[], newName?: string): PersonalEdit {
  return {
    patch: { remove: { lists: rows.map(listKey) }, put: newName === undefined ? undefined :
      { lists: rows.map(row => ({ ...row, list: newName })) } },
    undo: null,
    confirmation: { question: { kind, name, count: rows.filter(row => !isListDeclaration(row)).length, newName }, members: rows.map(row => row.show_id) },
  };
}

export function setListMember(snapshot: PersonalSnapshot, show: PersonalShow, name: string, member: boolean): PersonalEdit | undefined {
  name = canonicalListName(name);
  if (dropMembership(name)) throw new PersonalRecordError('Use Drop or Pick Up on the show page.');
  if (isAnimeClassification(name)) throw new PersonalRecordError('Anime is a Library filter.');
  if (isWatchlist(name)) return setWatchlistMember(snapshot,show,member,name);
  if (upcomingMembership(name)) throw new PersonalRecordError('Use the Watchlist to change this membership.');
  const rows = snapshot.lists.filter(r => canonicalListName(r.list) === name);
  const before = rows.find(row => row.show_id === show.show_id);
  if (Boolean(before) === member) return;
  const names = orderedListNames(snapshot.lists);
  if (before) {
    if (rows.length === 1) return confirmListChange('last-show', name, rows);
    return changeMembership([], [before], 'Removed from ' + name);
  }
  if (!names.includes(name)) throw new PersonalRecordError('This list no longer exists.');
  return changeMembership([{ show_id: show.show_id, show: show.show, list: name }], [], 'Added to ' + name);
}

export function createPersonalList(snapshot: PersonalSnapshot, input: string, shows: readonly PersonalShow[]): PersonalEdit | undefined {
  const name = validateListName(input, snapshot.lists);
  const members = Array.from(new Map(shows.map(show => [show.show_id, show])).values());
  if (!members.length) return changeMembership([{list:name,show_id:LIST_DECLARATION_ID,show:''}], [], 'Created ' + name);
  return changeMembership(members.map(({ show_id, show }) => ({ list: name, show_id, show })), [], 'Created ' + name);
}

export function editList(snapshot: PersonalSnapshot, name: string, renameTo?: string): PersonalEdit | undefined {
  name = canonicalListName(name);
  if (dropMembership(name)) throw new PersonalRecordError('Use Drop or Pick Up on the show page.');
  if (isAnimeClassification(name)) throw new PersonalRecordError('Anime is a Library filter.');
  if (upcomingMembership(name)) throw new PersonalRecordError('The Watchlist always keeps its name and place.');
  const members = snapshot.lists.filter(row => canonicalListName(row.list) === name);
  if (!members.length) throw new PersonalRecordError('This list no longer exists.');
  if (renameTo === undefined) return confirmListChange('delete', name, members);
  const newName = validateListName(renameTo, snapshot.lists, name);
  if (newName === name) return;
  return confirmListChange('rename', name, members, newName);
}

/** Reverse only the edited keys. Descriptive rewrites and independently added members survive. */
export function undoPersonal(snapshot: PersonalSnapshot, undo: PersonalUndo,
    protectedLists: ReadonlySet<string>, protectedRatings: ReadonlySet<string>): { patch?: DeviceChanges; value: number } {
  if (undo.kind === 'rating') {
    const id = undo.id;
    if (protectedRatings.has(String(id))) return { value: 1 };
    const current = snapshot.ratings.find(row => row.show_id === id);
    const before = undo.before;
    if ((before?.rating ?? null) === (current?.rating ?? null)) return { value: 0 };
    return { value: 0, patch: before ? { put: { ratings: [{ ...before, show: current?.show ?? before.show }] } }
      : { remove: { ratings: [id] } } };
  }
  const current = new Set(snapshot.lists.map(row => rowKey('lists', row)));
  const put: ListRow[] = [];
  const remove: [string, number][] = [];
  let skipped = 0;
  for (const row of undo.added) {
    const key = rowKey('lists', row);
    if (protectedLists.has(key)) skipped++;
    else if (current.has(key)) remove.push(listKey(row));
  }
  for (const row of undo.removed) {
    const key = rowKey('lists', row);
    if (protectedLists.has(key)) skipped++;
    else if (!current.has(key)) put.push(row);
  }
  return { value: skipped, patch: put.length || remove.length ? { put: { lists: put }, remove: { lists: remove } } : undefined };
}
