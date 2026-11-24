import { canonicalListName, canonicalListRows, droppedList, foldListName, isListDeclaration, type ListRow } from './model.ts';
export { droppedList } from './model.ts';

export const upcomingFollowList = 'Following upcoming';
export const upcomingHiddenList = 'Hidden from upcoming';
export const pickedUpList = 'csvTV: picked up';

export function dropMembership(name: string) {
  const key = foldListName(name);
  if (canonicalListName(name) === droppedList) return 'dropped';
  if (key === 'csvtv: picked up') return 'picked-up';
  return null;
}

export function upcomingMembership(name: string) {
  const folded = foldListName(name);
  if (folded === 'watchlist') return 'watchlist';
  if (folded === foldListName(upcomingFollowList)) return 'following';
  if (folded === foldListName(upcomingHiddenList)) return 'hidden';
  return null;
}

/** An explicit opt-out wins, including when conflicting list memberships arrive from two devices. */
export function upcomingReason(names: Iterable<string>) {
  let member = false;
  for (const name of names) {
    const choice = upcomingMembership(name);
    if (choice === 'hidden' || dropMembership(name) === 'dropped') return null;
    if (choice === 'watchlist' || choice === 'following') member = true;
  }
  return member ? 'watchlist' : null;
}

/** Resolve memberships from either generation without rewriting a synced file or its revision. */
export function visibleListRows(rows: readonly ListRow[], preserveFileSpellings = false, watchedIds?: Pick<ReadonlySet<number>, 'has'>): ListRow[] {
  const hidden = new Set(rows.filter(r => upcomingMembership(r.list) === 'hidden' || dropMembership(r.list) === 'dropped').map(r => r.show_id));
  const written = preserveFileSpellings && new Set(rows.filter(r => upcomingMembership(r.list) === 'watchlist').map(r => r.show_id));
  const included = new Set<number>();
  const result: ListRow[] = [];
  for (const row of canonicalListRows(rows)) {
    if (isListDeclaration(row) || dropMembership(row.list) === 'picked-up') continue;
    const membership = upcomingMembership(row.list);
    if (membership && watchedIds?.has(row.show_id)) continue;
    if (!membership) result.push(row);
    else if (written && written.has(row.show_id)) {
      if (membership === 'watchlist' && !hidden.has(row.show_id)) result.push(row);
    }
    else if (!hidden.has(row.show_id) && !included.has(row.show_id)) {
      result.push({...row, list:'Watchlist'});
      included.add(row.show_id);
    }
  }
  return result;
}
