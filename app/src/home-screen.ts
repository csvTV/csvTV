import { dropMembership } from './upcoming-preference.ts';
import { createPosterRail, type RailItem } from './poster-rail.ts';
import type { TmdbConfiguration } from './tmdb-data.ts';
import { recentLimit } from './recent-history.ts';
import { createProgressActions } from './library-status-menu.ts';
import { isWatchlist, visibleListRows } from './personal-record.ts';
import { compareTitles, overviewFromRecord, watchlistSections } from './record-overview.ts';
import type { Screen, ScreenContext } from './screen-context.ts';
import { mountFirstUseCard, renderOmittedShows, renderTmdbState } from './tmdb-settings.ts';

const layout = `<div class="home-screen"><header class="screen-heading"><h1>Home</h1>
  <form class="home-search tv-search-field" role="search">
    <input type="search" aria-label="Search for a show" placeholder="Search for a show" enterkeyhint="search" autocomplete="off">
    <button class="home-search-submit" type="submit" aria-label="Search"><span class="search-glass" aria-hidden="true"></span></button>
  </form></header>
  <section aria-labelledby="totals-heading"><header class="tv-section-head"><h2 id="totals-heading">Your record</h2></header>
    <dl class="record-totals"></dl></section>
  <div data-setup></div>
  <section aria-labelledby="recent-heading"><header class="tv-section-head"><h2 id="recent-heading" tabindex="-1">Recently marked</h2></header><div data-recent></div></section>
  <section aria-labelledby="watchlist-heading"><header class="tv-section-head"><h2 id="watchlist-heading"><a href="#/watchlist">Watchlist <span aria-hidden="true">›</span></a></h2>
    <span data-watchlist-count></span></header><div data-home-watchlist></div></section>
  <section aria-labelledby="more-heading"><header class="tv-section-head"><h2 id="more-heading"><a href="#/watchlist/more-to-watch">More to watch <span aria-hidden="true">›</span></a></h2>
    <span data-more-count></span></header><div data-more></div><p class="tv-note" data-omitted></p></section></div>`;

const glyphs = [
  'M3 7h18v12H3zM8 22h8M8 2l4 5 4-5', 'M3 8l9-5 9 5-9 5zM3 13l9 5 9-5',
  'M4 12l5 5L20 6', 'M7 4l13 8-13 8z',
];

export function mountHomeScreen(root: HTMLElement, ctx: ScreenContext): Screen {
  const { service } = ctx;
  const doc = root.ownerDocument;
  root.innerHTML = layout;
  const search = root.querySelector<HTMLFormElement>('.home-search')!;
  const searchInput = search.querySelector('input')!;
  search.onsubmit = event => {
    event.preventDefault();
    const query = searchInput.value.trim();
    if (query) ctx.go({page:'search',query});
    else searchInput.focus();
  };
  const recentHost = root.querySelector<HTMLElement>('[data-recent]')!;
  const watchlistHost = root.querySelector<HTMLElement>('[data-home-watchlist]')!;
  const moreHost = root.querySelector<HTMLElement>('[data-more]')!;
  const setup = root.querySelector<HTMLElement>('[data-setup]')!;
  const showSetup = mountFirstUseCard(setup, {
    onKey: () => ctx.go({ page: 'settings' }),
    onTraktImport: ctx.openTraktImport,
    onAniListImport: ctx.openAniListImport,
    onDropbox: ctx.signInDropbox,
    onDismiss: () => void ctx.run(async () => {
      await service.dismissFirstUse();
      await ctx.run(refresh);
      if (!disposed) searchInput.focus();
    }),
  });
  renderTmdbState(recentHost, 'loading');
  renderTmdbState(watchlistHost, 'loading');
  renderTmdbState(moreHost, 'loading');
  const openShow = (id: number) => ctx.go({page:'show',id});
  const recentRail = createPosterRail(recentHost,root.querySelector('#recent-heading')!.parentElement!,'Recently marked',openShow);
  const watchlistRail = createPosterRail(watchlistHost,root.querySelector('#watchlist-heading')!.parentElement!,'Watchlist',openShow);
  const moreHeading = root.querySelector<HTMLAnchorElement>('#more-heading a')!;
  const desktop = doc.defaultView!.matchMedia('(min-width: 900px) and (pointer: fine)');
  const actions = createProgressActions(root,ctx,desktop,() => !disposed,button => button.isConnected && !button.disabled ? button : moreHeading);
  const moreChoices = ['Complete','Drop'];
  const moreRail = createPosterRail(moreHost,moreHeading.closest('header')!,'More to watch',openShow,false,{
    desktop,writable:() => service.store.role === 'writer',open:(item,button,focus) => actions.open(item,button,moreChoices,focus),
  });
  const refreshLayout = () => { actions.close(); void ctx.run(refresh); };
  desktop.addEventListener('change',refreshLayout);
  let generation = 0;
  let work: AbortController | undefined;
  let disposed = false;
  let recentData = new Map<number,RailItem>();
  let recentConfig: TmdbConfiguration | null = null;
  let watchlistItems: RailItem[] = [];
  const counts = ['Shows','Seasons','Episodes','Plays'].map((label,i) => {
    const tile = doc.createElement('div'), term = doc.createElement('dt'), count = doc.createElement('dd');
    term.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="' + glyphs[i] + '"/></svg>';
    term.append(label); count.textContent = '…'; tile.append(term,count);
    root.querySelector('dl')!.append(tile);
    return count;
  });
  function renderRecent(items: RailItem[]) {
    const active = doc.activeElement as HTMLElement | null;
    const dismissIndex = active?.hasAttribute('data-dismiss-recent') ?
      Array.from(recentHost.querySelectorAll('[data-dismiss-recent]')).indexOf(active) : -1;
    const activeLink = recentHost.contains(active) ? active?.closest('a')?.getAttribute('href') : null;
    const record = ctx.watch.recordGeneration;
    const current = () => ctx.watch.recordGeneration === record;
    recentRail.update(items.map(show=>({...show,dismiss:service.store.role === 'writer' ? () => void ctx.run(async () => {
      if (disposed || !current()) return;
      await service.store.dismissRecentMark(show.id,current);
      if (!disposed && current()) await ctx.run(refresh);
    }) : undefined})),recentConfig,'No recently marked shows.');
    if ((dismissIndex >= 0 || activeLink) && !active?.isConnected) {
      const links = [...recentHost.querySelectorAll<HTMLAnchorElement>('a')];
      const next = dismissIndex >= 0 ? links[Math.min(dismissIndex,links.length-1)] : links.find(link=>link.getAttribute('href')===activeLink);
      (next ?? root.querySelector<HTMLElement>('#recent-heading'))?.focus({preventScroll:true});
    }
  }
  async function refresh() {
    if (disposed) return;
    const current = ++generation;
    work?.abort();
    const controller = work = new AbortController();
    const snapshot = await service.store.homeRecord(controller.signal).catch(error=>{
      if (!controller.signal.aborted) throw error;
    });
    if (!snapshot || current !== generation) return;
    const { watched } = snapshot.tables;
    const watchedIds = new Set<number>();
    const watchNames = new Map<number,string>();
    let plays = 0n;
    for (const row of watched) {
      watchedIds.add(row.show_id);
      if (row.show && !watchNames.has(row.show_id)) watchNames.set(row.show_id,row.show);
      plays += BigInt(row.times_watched);
    }
    const recentIds: number[] = Array.isArray(snapshot.local.recentlyMarked) ?
      [...new Set<number>(snapshot.local.recentlyMarked.filter(id => watchedIds.has(id)))].slice(0,recentLimit) : [];
    const ids = new Set(watchedIds);
    const members = visibleListRows(snapshot.tables.lists,false,watchedIds).filter(row => isWatchlist(row.list));
    for (const row of members) ids.add(row.show_id);
    counts[0].textContent = watchedIds.size.toLocaleString();
    counts[2].textContent = watched.length.toLocaleString();
    counts[3].textContent = plays.toLocaleString();
    if (!watched.length) counts[1].textContent = '0';
    root.querySelector('[data-watchlist-count]')!.textContent = members.length.toLocaleString() + (members.length === 1 ? ' show' : ' shows');
    const memberIds = new Set(members.map(row => row.show_id));
    const retained = watchlistItems.filter(item => memberIds.has(item.id));
    if (!members.length || retained.length !== watchlistItems.length) {
      const focused = watchlistHost.contains(doc.activeElement) ? doc.activeElement : null;
      watchlistItems = retained;
      watchlistRail.update(retained,recentConfig,members.length ? 'Loading…' : 'Your Watchlist is empty.');
      if (focused && !focused.isConnected) root.querySelector<HTMLElement>('#watchlist-heading a')?.focus({preventScroll:true});
    }
    renderRecent(recentIds.map(id => ({id,posterPath:recentData.get(id)?.posterPath ?? null,
      title:watchNames.get(id) || recentData.get(id)?.title || snapshot.tables.shows.find(row=>row.show_id===id)?.show || 'Show '+id})));
    const [firstUse, overview] = await Promise.all([
      service.firstUse(snapshot), overviewFromRecord(service, snapshot.tables, [...ids],controller.signal).catch(error=>{
        if (!controller.signal.aborted) throw error;
      }),
    ]);
    if (!overview || current !== generation) return;
    const {shows,config,today} = overview;
    const cards = new Map(shows.map(show => [show.id, show]));
    const more = shows.filter(show => show.progress.moreToWatch)
      .map(show => ({ ...show, aired: show.progress.aired, watched: show.progress.watchedAired }))
      .sort((a, b) => (a.aired - a.watched) - (b.aired - b.watched) || compareTitles(a, b));
    const omitted = shows.filter(show => !show.metadata && watchedIds.has(show.id) &&
      !show.lists.some(name => dropMembership(name) === 'dropped')).map(show => show.id);
    const active = root.contains(doc.activeElement) ? doc.activeElement : null;
    const rail = active?.closest('[data-recent], [data-home-watchlist], [data-more]');
    const focusedLink = rail && active?.closest('a')?.getAttribute('href');
    const countIndex = active?.matches('.library-status-trigger') && rail === moreHost
      ? Array.from(moreHost.querySelectorAll('.library-status-trigger')).indexOf(active) : -1;
    const focusedSetup = setup.contains(active);
    recentConfig = config;
    recentData = new Map(recentIds.map(id => {
      const {title,posterPath} = cards.get(id)!;
      return [id,{id,title,posterPath}];
    }));
    renderRecent([...recentData.values()]);
    const { upcoming, available } = watchlistSections(shows, today);
    watchlistItems = [...upcoming,...available].map(({id,title,posterPath}) => ({id,title,posterPath}));
    watchlistRail.update(watchlistItems, config, 'Your Watchlist is empty.');
    moreRail.update(more, config, 'No shows with unwatched aired episodes.');
    actions.refresh();
    root.querySelector('[data-more-count]')!.textContent = more.length.toLocaleString() + (more.length === 1 ? ' show' : ' shows');
    renderOmittedShows(root.querySelector('[data-omitted]')!, { unfetched: omitted, missing: [] });
    let seasonCount = 0;
    const missingMetadata = new Set<string>();
    for (const show of shows) seasonCount += show.progress.seasons.filter(s => s.recordedEpisodes > 0).length;
    for (const row of watched) {
      if (!cards.get(row.show_id)?.metadata) missingMetadata.add(row.show_id + '/' + row.season);
    }
    counts[1].textContent = (seasonCount + missingMetadata.size).toLocaleString();
    showSetup(firstUse, {
      writable: service.store.role === 'writer',
      showSignIn: !snapshot.local.dropboxSession,
      canSignIn: ctx.canSignInDropbox?.() ?? true,
    });
    if (active && (!active.isConnected || focusedSetup && active.matches('[hidden], :disabled'))) {
      const link = focusedLink && Array.from(rail!.querySelectorAll('a')).find(a => a.getAttribute('href') === focusedLink);
      const buttons = moreHost.querySelectorAll<HTMLButtonElement>('.library-status-trigger');
      const next = countIndex >= 0 ? buttons[Math.min(countIndex,buttons.length - 1)] ?? moreHeading : null;
      (next || link || searchInput).focus({ preventScroll: true });
    }
  }
  return { ready: refresh(), refresh, dispose() {
    disposed = true;
    generation++;
    work?.abort();
    actions.close();
    desktop.removeEventListener('change',refreshLayout);
    recentRail.dispose();
    watchlistRail.dispose();
    moreRail.dispose();
  } };
}
