import { calendarDate } from './calendar-date.ts';
import { choiceControl, compactControl, rememberSort } from './view-select.ts';
import { dropMembership } from './upcoming-preference.ts';
import { watchEditRunner } from './notices.ts';
import { poster } from './poster.ts';
import { compareTitles, readOverview, watchlistNextEpisode, watchlistSections, watchlistUpcomingDate, type OverviewShow } from './record-overview.ts';
import type { Screen, ScreenContext } from './screen-context.ts';
import { renderOmittedShows } from './tmdb-settings.ts';

type MoreSort = 'left' | 'title';
type Overview = Awaited<ReturnType<typeof readOverview>>;
const sortChoices = [{ value: 'left', label: 'Fewest episodes left' }, { value: 'title', label: 'Title, A to Z' }];

function episodesLeft(show: OverviewShow) { return show.progress.aired - show.progress.watchedAired; }

export function mountWatchlistScreen(root: HTMLElement, ctx: ScreenContext, sort: MoreSort = 'left', section?: 'more-to-watch'): Screen {
  const doc = root.ownerDocument;
  const edits = watchEditRunner(ctx);
  const page = doc.createElement('div');
  page.className = 'watch-view watchlist-screen';
  const heading = doc.createElement('h1');
  heading.textContent = 'Watchlist';
  heading.tabIndex = -1;
  const lead = doc.createElement('p');
  lead.className = 'watch-lead';
  const results = doc.createElement('div');
  const more = doc.createElement('section');
  more.dataset.section = 'more-to-watch';
  const moreHeader = doc.createElement('header');
  moreHeader.className = 'screen-heading';
  const moreHeading = doc.createElement('h2');
  moreHeading.textContent = 'More to watch';
  moreHeading.tabIndex = -1;
  const moreLead = doc.createElement('p');
  moreLead.className = 'watch-lead';
  const moreList = doc.createElement('ul');
  moreList.className = 'watch-rows more-watch-rows';
  const moreItems = new Map<number,HTMLLIElement>();
  const pendingEdits = new Set<number>();
  const note = doc.createElement('p');
  note.className = 'tv-note';
  const header = doc.createElement('header');
  header.className = 'screen-heading';
  const density = compactControl(page,ctx);
  let data: Overview | undefined;
  let generation = 0;
  let work: AbortController | undefined;
  let disposed = false;
  const preference = rememberSort(ctx,'moreSort',sort,
    (value): value is MoreSort => value === 'left' || value === 'title', value => {
      if (sort === value) return;
      sort = value;
      if (data) render(data,true);
    });
  const control = choiceControl(doc,'Sort',value => {
    if (value !== 'left' && value !== 'title') return;
    preference.choose(value);
    ctx.saveView({moreSort:value});
  });
  header.append(heading,density.button);
  lead.textContent = 'Loading…';
  moreLead.textContent = 'Loading…';
  control.root.hidden = true;
  moreHeader.append(moreHeading,control.root);
  more.append(moreHeader,moreLead,moreList,note);
  page.append(header,lead,results,more);
  root.replaceChildren(page);

  function showRow(show: Pick<OverviewShow,'id'|'title'|'posterPath'>, config: Overview['config']) {
    const item = doc.createElement('li');
    const link = doc.createElement('a');
    link.href = '#/show/' + show.id;
    link.onclick = event => {
      if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      ctx.go({ page: 'show', id: show.id });
    };
    const text = doc.createElement('span');
    text.className = 'watch-row-text';
    const name = doc.createElement('strong');
    name.textContent = show.title;
    const detail = doc.createElement('span');
    text.append(name, detail);
    link.append(poster(doc, show, config), text);
    item.append(link);
    return { item, link, text, detail };
  }

  function moreRows(overview: Overview, sortOnly: boolean) {
    const shows = overview.shows.filter(show => show.progress.moreToWatch);
    shows.sort((a, b) => (sort === 'left' ? episodesLeft(a) - episodesLeft(b) : 0) || compareTitles(a, b));
    moreLead.textContent = shows.length ? shows.length + (shows.length === 1 ? ' show' : ' shows') +
      ' with aired episodes you have not marked' : 'No shows with more to watch.';
    control.root.hidden = shows.length === 0;
    control.display(sortChoices,sort);
    if (sortOnly) {
      let position = moreList.firstElementChild;
      for (const show of shows) {
        const item = moreItems.get(show.id)!;
        if (item !== position) moreList.insertBefore(item,position);
        position = item.nextElementSibling;
      }
      return;
    }
    moreItems.clear();
    const items = doc.createDocumentFragment();
    for (const show of shows) {
      const { item, link, text, detail } = showRow(show, overview.config);
      const { aired, watchedAired } = show.progress;
      detail.textContent = watchedAired + ' of ' + aired + (aired === 1 ? ' aired episode' : ' aired episodes');
      const line = doc.createElement('progress');
      line.max = aired;
      line.value = watchedAired;
      line.setAttribute('aria-hidden', 'true');
      text.append(line);
      const left = doc.createElement('span');
      left.className = 'watch-row-end';
      left.textContent = episodesLeft(show) + ' left';
      link.append(left);
      item.append(removeButton(show,true));
      items.append(item);
      moreItems.set(show.id,item);
    }
    moreList.replaceChildren(items);
  }

  function watchlistRows(overview: Overview) {
    const groups = watchlistSections(overview.shows, overview.today);
    const sections = doc.createDocumentFragment();
    for (const group of ['upcoming','available'] as const) {
      if (!groups[group].length) continue;
      const section = doc.createElement('section');
      section.dataset.section = group;
      const label = doc.createElement('h2');
      label.textContent = group === 'upcoming' ? 'Upcoming' : 'Available to watch';
      const list = doc.createElement('ul');
      list.className = 'watch-rows';
      for (const show of groups[group]) {
        const row = showRow(show, overview.config);
        const metadata = show.metadata;
        const next = watchlistNextEpisode(show);
        const nextLabel = next ? (next.nativeNumbering ? 'TMDB ' : '') + 'S' + next.season + ' E' + next.episode : '';
        if (group === 'available') {
          const left = episodesLeft(show);
          row.detail.textContent = left > 0 ? left.toLocaleString() + (left === 1 ? ' aired episode to watch' : ' aired episodes to watch') :
            (metadata?.status === 'Ended' || metadata?.status === 'Canceled') ? metadata.status : 'Already aired';
        } else if (!metadata) {
          row.detail.textContent = 'Schedule unavailable';
        } else {
          const date = watchlistUpcomingDate(show, overview.today);
          if (date) {
            row.detail.textContent = next?.airDate === date ? nextLabel :
              metadata.firstAirDate === date ? 'Series premiere' : 'Next episode';
            const time = doc.createElement('time');
            time.className = 'watch-row-end';
            time.dateTime = date;
            time.textContent = calendarDate(date);
            row.link.append(time);
          } else {
            row.detail.textContent = next && !next.airDate ? nextLabel + ' · No date announced' : 'No date announced';
          }
        }
        row.item.append(removeButton(show));
        list.append(row.item);
      }
      section.append(label, list);
      sections.append(section);
    }
    lead.hidden = sections.childElementCount > 0;
    lead.textContent = lead.hidden ? '' : 'Your Watchlist is empty.';
    results.replaceChildren(sections);
  }

  function removeButton(show: Pick<OverviewShow,'id'|'title'>, drop = false) {
    const remove = doc.createElement('button');
    remove.type = 'button';
    remove.className = 'list-remove';
    remove.textContent = '×';
    remove.title = drop ? 'Drop ' + show.title : 'Remove ' + show.title + ' from Watchlist';
    remove.setAttribute('aria-label',remove.title);
    remove.disabled = ctx.service.store.role !== 'writer';
    const personal = {show_id:show.id,show:show.title};
    if (drop) remove.dataset.moreDrop = String(show.id);
    else remove.dataset.watchlistRemove = String(show.id);
    const current = () => !disposed && ctx.service.store.role === 'writer' &&
      (drop ? moreItems.has(show.id) : !!results.querySelector('[data-watchlist-remove="' + show.id + '"]'));
    remove.onclick = () => {
      if (!remove.isConnected || pendingEdits.has(show.id) || !current()) return;
      void edits.run(String(show.id),async () => {
        if (pendingEdits.has(show.id) || !current()) return;
        pendingEdits.add(show.id);
        remove.setAttribute('aria-busy','true');
        try {
          const changed = drop ? await ctx.watch.setDropped(personal,true,current) :
            await ctx.watch.setMembership(personal,'Watchlist',false);
          if (changed) await ctx.run(refresh);
        } finally { pendingEdits.delete(show.id); remove.removeAttribute('aria-busy'); }
      });
    };
    return remove;
  }

  function paintMembership(members: Pick<OverviewShow,'id'|'title'>[]) {
    const ids = new Set(members.map(show=>show.id)), present = new Set<number>();
    const previous = Array.from(results.querySelectorAll<HTMLButtonElement>('[data-watchlist-remove]'));
    const focused = doc.activeElement as HTMLElement | null;
    const focusedIndex = previous.findIndex(button => button.closest('li')?.contains(focused));
    for (const button of previous) {
      const id = Number(button.dataset.watchlistRemove);
      if (ids.has(id)) present.add(id);
      else button.closest('li')!.remove();
    }
    let pending = results.querySelector<HTMLUListElement>('[data-pending-schedule]');
    if (!pending) {
      pending = doc.createElement('ul'); pending.className = 'watch-rows';
      pending.dataset.pendingSchedule = ''; pending.setAttribute('aria-label','Checking schedules');
    }
    for (const show of members.sort(compareTitles)) {
      if (present.has(show.id)) continue;
      const row = showRow({...show,posterPath:null},null);
      row.item.append(removeButton(show)); pending.append(row.item);
    }
    if (pending.childElementCount) {
      if (!pending.parentElement) results.append(pending);
    } else pending.remove();
    for (const group of results.querySelectorAll('section')) if (!group.querySelector('li')) group.remove();
    lead.hidden = members.length > 0;
    lead.textContent = lead.hidden ? '' : 'Your Watchlist is empty.';
    if (focusedIndex >= 0 && !focused?.isConnected) {
      const buttons = results.querySelectorAll<HTMLButtonElement>('[data-watchlist-remove]');
      (buttons[Math.min(focusedIndex,buttons.length - 1)] ?? heading).focus({preventScroll:true});
    }
  }

  function render(overview: Overview, sortOnly = false) {
    const active = doc.activeElement as HTMLElement | null;
    const focusedList = moreList.contains(active) ? moreList : results;
    const href = focusedList.contains(active) ? active?.closest('a')?.getAttribute('href') : null;
    const removed = active?.dataset.moreDrop ?? active?.dataset.watchlistRemove;
    const rowIndex = removed === undefined ? -1 : Array.from(focusedList.querySelectorAll('.list-remove')).indexOf(active!);
    if (!sortOnly) watchlistRows(overview);
    moreRows(overview,sortOnly);
    if (!sortOnly) {
      const omitted = { unfetched: [] as number[], missing: [] as number[] };
      for (const show of overview.shows) {
        if (show.metadata) continue;
        if (show.lists.some(name => dropMembership(name) === 'dropped')) continue;
        if (show.progress.recordedEpisodes) {
          (show.missing ? omitted.missing : omitted.unfetched).push(show.id);
        }
      }
      renderOmittedShows(note, omitted);
    }
    if (href) {
      const link = Array.from(focusedList.querySelectorAll('a')).find(item => item.getAttribute('href') === href);
      (link ?? (focusedList === moreList ? moreHeading : heading)).focus({ preventScroll: true });
    } else if (removed !== undefined) {
      const buttons = Array.from(focusedList.querySelectorAll<HTMLButtonElement>('.list-remove'));
      const next = buttons.find(button => (button.dataset.moreDrop ?? button.dataset.watchlistRemove) === removed) ??
        buttons[Math.min(rowIndex,buttons.length - 1)];
      (next ?? (focusedList === moreList ? moreHeading : heading)).focus({preventScroll:true});
    } else if (active === control.select && control.root.hidden) moreHeading.focus({ preventScroll: true });
  }

  async function refresh() {
    if (disposed) return;
    const current = ++generation;
    work?.abort();
    const controller = work = new AbortController();
    const members = await ctx.service.store.watchlistMembers(controller.signal).catch(error=>{
      if (!controller.signal.aborted) throw error;
    });
    if (!members || current !== generation) return;
    paintMembership(members);
    const [overview] = await Promise.all([readOverview(ctx.service,undefined,controller.signal).catch(error=>{
      if (!controller.signal.aborted) throw error;
    }),displayReady]);
    if (!overview || current !== generation) return;
    data = overview;
    render(overview);
    if (section === 'more-to-watch') {
      section = undefined;
      moreHeading.focus({ preventScroll:true });
      moreHeading.scrollIntoView({ block:'start' });
    }
  }
  const displayReady = Promise.all([density.read(),preference.read()]);
  return {
    ready: refresh(),
    refresh,
    dispose() {
      disposed = true; generation++; work?.abort(); preference.dispose();
      density.dispose();
    },
  };
}
