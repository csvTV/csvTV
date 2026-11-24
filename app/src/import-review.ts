import { reviewList } from './review-list.ts';
import { isAnimeClassification } from './anime.ts';
import { dropMembership } from './upcoming-preference.ts';
import { compareTitles } from './record-overview.ts';
import { importEpisodeLabel, type ImportPlan } from './import-preview.ts';

function byShow(a: {show: string; show_id: number}, b: {show: string; show_id: number}) {
  return compareTitles({title:a.show, id:a.show_id}, {title:b.show, id:b.show_id});
}

export function renderImportPreview(host: HTMLElement, plan: ImportPlan, source: 'Trakt' | 'AniList', addReview: () => void) {
  const doc = host.ownerDocument;
  function reportList(label: string, length: number, item: (index: number) => string | Node, initiallyOpen = false) {
    const {details} = reviewList(doc, label, length, item);
    details.dataset.importReport = label;
    details.open = initiallyOpen;
    return details;
  }
  const shows = [...plan.shows].sort(byShow);
  const episodeOrder = (proposals: ImportPlan['watched']) => proposals.map((_,i) => i).sort((i,j) => {
    const a = proposals[i].row, b = proposals[j].row;
    return byShow(a,b) || a.season - b.season || a.episode - b.episode;
  });
  let watched = episodeOrder(plan.watched);
  const ratings = [...plan.ratings].sort((a,b) => byShow(a.row,b.row));
  const byList = (a: ImportPlan['lists'][number], b: ImportPlan['lists'][number]) => byShow(a.row,b.row) || a.row.list.localeCompare(b.row.list);
  const visibleMemberships = (items: ImportPlan['lists']) => items.filter(item => !isAnimeClassification(item.row.list) && !dropMembership(item.row.list)).sort(byList);
  let lists = visibleMemberships(plan.lists);
  host.replaceChildren();
  const totals = doc.createElement('dl'); totals.className = 'import-totals';
  const placedCount = doc.createElement('dd'), listCount = doc.createElement('dd');
  for (const [label, count] of [['Shows', shows.length], ['Episodes placed', watched.length],
      ['Ratings', ratings.length], ['List entries', lists.length]] as const) {
    const tile = doc.createElement('div'), term = doc.createElement('dt');
    const value = label === 'Episodes placed' ? placedCount : label === 'List entries' ? listCount : doc.createElement('dd');
    term.textContent = label; value.textContent = count.toLocaleString();
    tile.append(term,value); totals.append(tile);
  }
  host.append(totals);
  const sortedReasons = (reasons: string[]) => [...reasons].sort((a,b) => compareTitles({title:a,id:0},{title:b,id:0}));
  let skipped = sortedReasons(plan.skipped);
  const skippedLabel = source === 'AniList' ? 'Skipped record changes' : 'Skipped';
  const skippedReport = reviewList(doc, skippedLabel, skipped.length, i => skipped[i]);
  skippedReport.details.dataset.importReport = skippedLabel;
  skippedReport.details.open = true;
  if (skipped.length) host.append(skippedReport.details);
  addReview();
  const conflicts = ratings.filter(r => r.before !== null && r.before !== r.row.rating);
  function ratingLine(r: typeof ratings[number]) {
    return r.row.show + (r.before === null ? ' · Add ' + r.after + '/10' : ' · Keep ' + r.before + '/10 · ' + source + ' ' + r.row.rating + '/10');
  }
  if (conflicts.length) {
    host.append(reportList('Different ratings', conflicts.length, i => ratingLine(conflicts[i]), true));
  }
  const breakdown = doc.createElement('section'), heading = doc.createElement('h2');
  heading.textContent = 'Import details'; breakdown.append(heading);
  if (shows.length) breakdown.append(reportList('Matched shows', shows.length, i => {
    const row = shows[i];
    return row.show + (row.year !== null ? ' (' + row.year + ')' : '') + (row.imdb_id ? ' · ' + row.imdb_id : '');
  }));
  const beforePlacements = breakdown.lastElementChild!;
  const placements = reviewList(doc, 'Episode placements', watched.length, i => {
    const {row, previous, before, after} = plan.watched[watched[i]];
    const moved = previous && (previous.season !== row.season || previous.episode !== row.episode);
    return row.show + ' · ' + importEpisodeLabel(row,plan.broadcastByShow) + ' · ' + row.title +
      (moved ? ' (from ' + importEpisodeLabel(previous,plan.broadcastByShow) + ')' : '') + ' · ' + before + ' → ' + after + ' plays';
  });
  placements.details.dataset.importReport = 'Episode placements';
  if (watched.length) breakdown.append(placements.details);
  if (ratings.length) breakdown.append(reportList('Show ratings', ratings.length, i => ratingLine(ratings[i])));
  const dropStatuses = [...new Map(plan.lists.filter(item => dropMembership(item.row.list) === 'dropped')
    .map(item => [item.row.show_id,item])).values()].sort(byList);
  if (dropStatuses.length) breakdown.append(reportList('Dropped shows',dropStatuses.length,i => dropStatuses[i].row.show));
  const memberships = reviewList(doc, 'List memberships', lists.length, i =>
    lists[i].row.show + ' · ' + lists[i].label + (lists[i].present ? ' · Already on list' : ' · Add'));
  memberships.details.dataset.importReport = 'List memberships';
  if (lists.length) breakdown.append(memberships.details);
  if (breakdown.childElementCount > 1) host.append(breakdown);
  return (updated: ImportPlan) => {
    // Ordinary rewatch edits keep their original row order, even in a large export.
    if (updated.watched.length !== watched.length || updated.watched.some((p,i) => p.row !== plan.watched[i].row)) {
      watched = episodeOrder(updated.watched);
    }
    if (updated.skipped.length !== plan.skipped.length || updated.skipped.some((reason,i) => reason !== plan.skipped[i])) {
      skipped = sortedReasons(updated.skipped);
      skippedReport.refreshRows(skipped.length);
      if (!skipped.length) skippedReport.details.remove();
      else if (!skippedReport.details.parentNode) totals.after(skippedReport.details);
    }
    if (updated.lists.length !== plan.lists.length || updated.lists.some((item,i) => {
      const old = plan.lists[i];
      return item.row.show_id !== old.row.show_id || item.row.list !== old.row.list || item.present !== old.present;
    })) {
      lists = visibleMemberships(updated.lists);
      listCount.textContent = lists.length.toLocaleString();
      memberships.refreshRows(lists.length);
      if (!lists.length) memberships.details.remove();
      else if (!memberships.details.parentNode) breakdown.append(memberships.details);
    }
    plan = updated;
    placedCount.textContent = watched.length.toLocaleString();
    placements.refreshRows(watched.length);
    if (!watched.length) placements.details.remove();
    else if (!placements.details.parentNode) beforePlacements.after(placements.details);
  };
}
