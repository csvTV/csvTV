import { openActionSheet, type SheetAction } from './action-sheet.ts';
import { recordedShowTitle } from './shows.ts';
import { StaleSnapshotError, type ShowRows } from './storage.ts';
import { poster } from './poster.ts';
import { createPosterRail } from './poster-rail.ts';
import { appendMalRating, appendShowRatings, readDisplayRatings } from './critic-marks.ts';
import { selectShowMalScores } from './mal-file.ts';
import { openMembershipSheet, openRatingSheet } from './personal-sheets.ts';
import { openPersonalDialog } from './personal-dialog.ts';
import { canonicalListName, favoritesList, MAX_INTEGER } from './model.ts';
import { dropMembership } from './upcoming-preference.ts';
import { localCalendarDate, watchProgress, type SeasonProgress } from './progress.ts';
import { broadcastSeasons, type BroadcastSeason } from './broadcast-seasons.ts';
import type { Screen, ScreenContext } from './screen-context.ts';
import { routeHref } from './navigation.ts';
import { regularSeasonsCached, tmdbImageUrl, type CacheEntry, type TmdbConfiguration, type TmdbDataByKind } from './tmdb-data.ts';
import { renderTmdbState } from './tmdb-settings.ts';
import { createRepairNotice } from './repair-review.ts';
import { cacheOnlyView, type MetadataView } from './tmdb-service.ts';
import { openSeasonOrderEditor } from './season-order-editor.ts';
import { openWatchCountEditor } from './watch-count-editor.ts';
import { watchEditRunner } from './notices.ts';

interface Details {
  show: MetadataView<'show'>;
  cast: MetadataView<'cast'> | null;
  recommendations: MetadataView<'recommendations'> | null;
}
const castBatchSize = 12;

function seasonName(number: number, name?: string) {
  return number === 0 ? 'Specials' : name?.trim() || 'Season ' + number;
}

function ordinal(number: number) {
  const remainder = number % 100;
  const suffix = remainder >= 11 && remainder <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][number % 10] ?? 'th';
  return number.toLocaleString() + suffix;
}

function episodeCount(number: number) {
  return number.toLocaleString() + (number === 1 ? ' episode' : ' episodes');
}

export function mountShowScreen(root: HTMLElement, ctx: ScreenContext, id: number): Screen {
  const { service } = ctx;
  const doc = root.ownerDocument;
  function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string) {
    const node = doc.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  const page = el('article', 'show-page');
  const header = el('header', 'show-hero');
  const status = el('div', 'show-status');
  const columns = el('div', 'show-columns');
  const seasons = el('section', 'show-seasons');
  const overview = el('section', 'show-overview');
  const extras = el('div', 'show-extras');
  const castSection = el('section'), recommendations = el('section');
  const recHeader = el('header'), recHost = el('div'), recStatus = el('div');
  recHeader.append(el('h2','','More like this'));
  recommendations.append(recHeader,recHost,recStatus);
  extras.hidden = true;
  extras.append(castSection,recommendations);
  const recommendationRail = createPosterRail(recHost,recHeader,'More like this',id => ctx.go({page:'show',id}),true);
  const repair = createRepairNotice(page, ctx, draw);
  columns.hidden = true;
  columns.append(overview, seasons);
  page.append(header, status, repair.notice, columns, extras);
  root.replaceChildren(page);
  renderTmdbState(status, 'loading');

  let opened: Details | undefined;
  let loadingHeader = false;
  let heroArtwork = '';
  let relatedContent = '';
  let seasonContent = '';
  let seasonScoreContent = '';
  let castLimit = castBatchSize;
  let config: TmdbConfiguration | null = null;
  let fetching = 0;
  let drawing = 0;
  let closed = false;
  let source = '';
  let criticSource = '';
  let imdbSource = '';
  let closeSheet: (() => void) | undefined;
  let busy = false;
  const actions = { onSettings: () => ctx.go({ page: 'settings' }), onRetry: () => { void ctx.run(open); }, canAccessKeys:ctx.canAccessKeys };

  // The title keeps its natural width up to the available space. A wrapped
  // title fills that space, so it always sends the scores to the episode line.
  function placeSeasonScores(copy: HTMLElement) {
    const title = copy.querySelector<HTMLElement>('.show-season-title')!;
    const scores = copy.querySelector<HTMLElement>('.season-scores');
    if (!scores) return;
    const markWidth = Array.from(scores.children).reduce((sum,mark) => sum + mark.getBoundingClientRect().width,0);
    const fits = title.firstElementChild!.getBoundingClientRect().width + markWidth <= title.getBoundingClientRect().width;
    const host = fits ? title : copy.querySelector<HTMLElement>('.show-episode-count')!;
    if (scores.parentElement !== host) host.append(scores);
  }
  const scoreLayout = new ResizeObserver(entries => {
    const copies = new Set(entries.map(entry => entry.target.closest<HTMLElement>('.show-season-copy')));
    for (const copy of copies) if (copy?.isConnected) placeSeasonScores(copy);
  });

  function image(kind: 'poster' | 'backdrop' | 'profile', path: string | null | undefined, width: number) {
    if (kind === 'poster') {
      const frame = poster(doc, { posterPath: path ?? null }, config);
      frame.classList.add('show-art', 'show-art-poster');
      return frame;
    }
    const slot = el('span', 'show-art show-art-' + kind);
    slot.setAttribute('aria-hidden', 'true');
    if (!config || !path) return slot;
    const sizes = kind === 'backdrop' ? config.backdropSizes : config.profileSizes;
    const sized = sizes.filter(size => size.startsWith('w')).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
    const size = sized.find(item => Number(item.slice(1)) >= width) ?? sized.at(-1) ?? sizes[0];
    const url = tmdbImageUrl(config, kind, size, path);
    if (url) {
      const img = el('img');
      img.alt = '';
      img.loading = kind === 'backdrop' ? 'eager' : 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', () => img.remove(), { once: true });
      img.src = url;
      slot.append(img);
    }
    return slot;
  }

  function castCard(person: TmdbDataByKind['cast'][number], show: string) {
    const card = el('li', 'show-cast-card'), member = el('a', 'show-cast-member');
    member.href = '#/cast/' + person.id + '?show=' + id;
    member.onclick = event => {
      if (event.button || event.ctrlKey || event.shiftKey || event.metaKey || event.altKey) return;
      event.preventDefault();
      ctx.go({page:'cast', id:person.id, showId:id});
    };
    member.append(image('profile',person.profilePath,80), el('span','',person.name));
    card.append(member);
    const roles = person.roles?.filter(role => role.trim()) ?? [];
    if (!roles.length) return card;
    const preview = Array.from(roles.slice(0,2).join(', '));
    const truncated = roles.length > 2 || preview.length > 56;
    const button = el('button', 'show-cast-roles');
    button.type = 'button';
    button.dataset.focus = 'cast-roles-' + person.id;
    button.setAttribute('aria-label','View all roles for ' + person.name + ' in ' + show);
    button.setAttribute('aria-haspopup', 'dialog');
    button.append(el('span','',preview.slice(0,56).join('').trimEnd() + (truncated ? '…' : '')));
    button.onclick = () => {
      closeSheet?.();
      const panel = openPersonalDialog(page,person.name + '’s roles',() =>
        page.querySelector<HTMLElement>('[data-focus="cast-roles-' + person.id + '"]') ?? page.querySelector('h1'));
      closeSheet = panel.close;
      panel.dialog.classList.add('show-role-dialog');
      const list = el('ul','show-role-list');
      for (const role of roles) list.append(el('li','',role));
      const close = el('button','','Close');
      close.type = 'button'; close.onclick = panel.close;
      const actions = el('div', 'actions');
      actions.append(close);
      panel.body.append(el('p','show-role-context',show),list,actions);
    };
    card.append(button);
    return card;
  }

  function related(details: Details) {
    extras.hidden = !details.show.value;
    if (!details.show.value) {
      castSection.replaceChildren();
      recommendationRail.update([],config);
      recStatus.replaceChildren();
      return;
    }
    castSection.hidden = !details.cast;
    castSection.replaceChildren(el('h2', '', 'Cast'));
    const cast = details.cast?.value ?? [];
    if (cast.length) {
      const grid = el('ul','show-cast-grid'), more = el('button','show-more-cast','Show more cast');
      more.type = 'button'; more.dataset.focus = 'more-cast';
      const show = details.show.value.show;
      function appendBatch() {
        for (const person of cast.slice(grid.childElementCount,castLimit)) grid.append(castCard(person,show));
        more.hidden = grid.childElementCount >= cast.length;
      }
      more.onclick = () => {
        const firstNew = grid.childElementCount;
        const focused = doc.activeElement === more;
        castLimit += castBatchSize;
        appendBatch();
        if (focused) grid.children[firstNew]?.querySelector('a')?.focus();
      };
      appendBatch();
      castSection.append(grid,more);
    } else if (!details.cast?.value && details.cast?.reason && details.cast.reason === details.show.reason) {
      castSection.hidden = true;
    } else if (details.cast) {
      renderTmdbState(castSection.appendChild(el('div')), details.cast.status === 'cached' ? 'empty' : details.cast.status,
        { ...actions, emptyMessage: 'No cast listed.' });
    }
    const recs = details.recommendations;
    const titles = recs?.value?.results ?? [];
    recommendations.hidden = !recs || !!(!recs.value && recs.reason && recs.reason === details.show.reason);
    recommendationRail.update(titles.map(t => ({id:t.show_id,title:t.show,posterPath:t.posterPath})), config);
    recStatus.replaceChildren();
    if (!titles.length && recs && !recommendations.hidden) {
      renderTmdbState(recStatus, recs.status === 'cached' ? 'empty' : recs.status,
        { ...actions, emptyMessage: 'No recommendations.' });
    }
  }

  function seasonRow(progress: SeasonProgress, name: string | undefined, canMark: boolean, range?: BroadcastSeason) {
    const number = progress.season;
    const title = seasonName(number, name);
    const tile = el('div', 'show-season-tile');
    const row = el('a', 'show-season-row');
    const destination = { page:'season' as const, id, season:number };
    row.href = routeHref(destination);
    row.dataset.season = String(number);
    row.dataset.focus = 'season-' + number;
    row.onclick = event => {
      if (event.button || event.ctrlKey || event.shiftKey || event.metaKey || event.altKey) return;
      event.preventDefault();
      ctx.go(destination);
    };
    const description = el('span', 'show-season-copy');
    const rewatch = progress.rewatch;
    const countText = progress.aired ? progress.watchedAired.toLocaleString() + ' of ' + episodeCount(progress.aired) : episodeCount(progress.recordedEpisodes);
    const caption = el('small');
    caption.append(el('span','show-episode-count',countText));
    if (rewatch) caption.append(' · ' + ordinal(rewatch.viewing) + ' time ' + rewatch.watched + ' of ' + rewatch.total);
    const label = el('span', 'show-season-title');
    const heading = el('strong', '');
    for (const part of title.split(/(\bseason\s+\d+\b)/i)) {
      heading.append(/^season\s+\d+$/i.test(part) ? el('span', 'season-number-label', part) : part);
    }
    label.append(heading);
    description.append(label, caption);
    const completed = progress.completed;
    const badge = el('span', 'show-view-count', completed === null ? '' : completed.toLocaleString() + '×');
    if (rewatch) badge.classList.add('rewatching');
    const chevron = el('span', 'show-chevron', '›');
    chevron.setAttribute('aria-hidden', 'true');
    row.append(description);
    tile.append(row);
    if (canMark && completed !== null) {
      const scope = {season:range?.sourceSeason ?? number, broadcast:range};
      const retryScope = 'watches/' + number;
      const count = el('button', 'show-season-count');
      count.type = 'button';
      count.dataset.focus = 'watch-season-' + number;
      count.setAttribute('aria-label', 'Change ' + title + ' watches, ' + completed.toLocaleString() + ' completed');
      count.setAttribute('aria-haspopup', 'dialog');
      count.append(badge);
      count.onclick = () => {
        if (busy) return;
        closeSheet = openWatchCountEditor(page, title, completed,
          (value, current) => { edits.retire(retryScope); return ctx.watch.setSeasonCount(id, scope, completed, value, current); },
          () => seasons.querySelector<HTMLElement>('[data-focus="watch-season-' + number + '"]') ??
            seasons.querySelector<HTMLElement>('[data-season="' + number + '"]') ?? header.querySelector('h1'), 'season');
      };
      const add = el('button', 'show-season-add watch-step-plus');
      add.type = 'button';
      add.disabled = completed === MAX_INTEGER || !!progress.airedWatchLimitReached;
      add.dataset.focus = 'add-season-' + number;
      add.setAttribute('aria-label', 'Add one watch to ' + title);
      add.title = add.disabled ? 'An aired episode has reached the watch limit.' : 'Add one watch to ' + title;
      const icon = el('span', 'season-step-icon');
      icon.setAttribute('aria-hidden', 'true');
      add.append(icon);
      add.onclick = () => { void act(retryScope,async () => {
        await ctx.watch.setSeasonCount(id, scope, completed, completed + 1, () => !closed);
        await ctx.run(draw);
      }); };
      const controls = el('span','show-season-controls');
      controls.append(count,add);
      tile.append(controls);
    } else if (completed !== null) tile.append(badge);
    tile.append(chevron);
    return tile;
  }

  function tile(name: string, value: string, denominator?: number) {
    const tile = el('div', 'show-stat');
    const figure = el('strong', '', value);
    if (denominator !== undefined) figure.append(el('small', '', ' / ' + denominator.toLocaleString()));
    tile.append(el('span', '', name), figure);
    return tile;
  }

  function indicateBusy() {
    for (const button of header.querySelectorAll('button')) button.setAttribute('aria-disabled', String(busy || button.disabled));
    for (const button of seasons.querySelectorAll('button')) button.setAttribute('aria-disabled', String(busy || button.disabled));
  }

  const edits = watchEditRunner(ctx);
  async function act(scope: string, work: () => Promise<void>) {
    if (busy || closed) return;
    await edits.run(scope,async () => {
      if (busy || closed) return;
      busy = true;
      indicateBusy();
      try { await work(); }
      finally { busy = false; if (!closed) indicateBusy(); }
    });
  }

  let displayedRevision: bigint | undefined;
  let closeRecentMenu: (() => void) | undefined;
  let recentState: {revision:bigint; controller:AbortController; pending:Promise<boolean>; visible?:boolean} | undefined;
  function cancelRecentRead() {
    if (recentState && recentState.visible === undefined) {
      recentState.controller.abort();
      recentState = undefined;
    }
  }
  function recentFor(record: ShowRows) {
    if (recentState?.revision === record.revision) return recentState;
    cancelRecentRead();
    const controller = new AbortController();
    const state: NonNullable<typeof recentState> = {revision:record.revision,controller,
      pending:service.store.isOnRecentRail(id,record,controller.signal)};
    recentState = state;
    void state.pending.then(visible => { state.visible = visible; }, () => { if (recentState === state) recentState = undefined; });
    return state;
  }

  let activeRead:AbortController|undefined;
  type KeyDisplay = Awaited<ReturnType<typeof service.keyStatus>>;
  async function draw(checkSource=false,initialKey?:KeyDisplay) {
    if (!opened || closed) return;
    const ticket = ++drawing;
    activeRead?.abort();
    activeRead = new AbortController();
    const {signal} = activeRead;
    const displayRatings = readDisplayRatings(ctx,[id],undefined,{signal});
    const data = await Promise.all([
      service.store.showScreenState(id,'show',service.environment.now(),signal), initialKey ?? service.keyStatus(),
      service.read({kind:'cast', id},signal), service.read({kind:'recommendations', id},signal),
      service.read({kind:'configuration'},signal).catch(() => null),
    ]).catch(error=>{ if (!signal.aborted) throw error; });
    if (!data || ticket !== drawing || closed || !opened) return;
    const [{record,info,preview,header:latestShow},key,latestCast,latestRelated,images] = data;
    if (key.generation !== record.tmdbGeneration) { await open(); return; }
    if (checkSource) {
      if (signature(key) !== source) { await open(key); return; }
      if (ctx.critics) void ctx.run(refreshCritics);
      if (ctx.imdb) void ctx.run(refreshImdb);
    }
    if (recentState && recentState.revision !== record.revision) {
      if (recentState.visible) closeRecentMenu?.();
      cancelRecentRead();
    }
    displayedRevision = record.revision;
    const { tables } = record;
    repair.draw(preview);
    // A different tab or the detail job may populate, expire, or retire an open title.
    function current<K extends 'show' | 'cast' | 'recommendations'>(entry: CacheEntry<K> | null,
        initial: MetadataView<K> | null): MetadataView<K> {
      let reason = initial?.reason ?? opened?.show.reason;
      if (reason === 'unavailable' && entry && entry.fetchedAt !== initial?.fetchedAt) reason = undefined;
      const value = entry?.value ?? null;
      if (value === null) return { value, reason, status: entry ? 'not-found' : reason ?? 'unavailable' };
      const empty = Array.isArray(value) ? !value.length : 'results' in value && !value.results.length;
      return { value, reason, status: reason ? 'cached' : empty ? 'empty' : 'ready' };
    }
    const value = current<'show'>(latestShow, opened.show);
    const show = value.value;
    config = images?.value ?? null;
    const details = {show:value, cast:latestCast || opened.cast ? current<'cast'>(latestCast, opened.cast) : null,
      recommendations:latestRelated || opened.recommendations ? current<'recommendations'>(latestRelated, opened.recommendations) : null};
    const content = JSON.stringify([show?.show, show?.overview, value.reason, details.cast, details.recommendations, config]);
    if (relatedContent !== content) {
      const focusedElement = extras.contains(doc.activeElement) ? doc.activeElement as HTMLElement : null;
      const focusedLink = focusedElement?.closest('a')?.getAttribute('href');
      const focusedControl = focusedElement?.dataset.focus;
      relatedContent = content;
      overview.replaceChildren();
      if (show?.overview) overview.append(el('h2', '', 'Overview'), el('p', '', show.overview));
      related(details);
      if (focusedLink) extras.querySelector<HTMLElement>('a[href="' + CSS.escape(focusedLink) + '"]')?.focus({preventScroll:true});
      if (focusedControl) extras.querySelector<HTMLElement>('[data-focus="' + CSS.escape(focusedControl) + '"]:not([hidden])')?.focus({preventScroll:true});
    }
    const savedTitle = show?.show || recordedShowTitle(tables);
    const hasRecord = Boolean(tables.watched.length || tables.ratings.length || tables.lists.length || tables.shows.length);
    const title = savedTitle || (hasRecord ? 'Show ' + id : 'Show');
    const focused = (doc.activeElement as HTMLElement | null)?.dataset.focus;
    const figures = watchProgress(id, tables.watched, tables.lists, info,
      localCalendarDate(new Date(service.environment.now())));
    const canMark = !!show && service.store.role === 'writer' &&
      ((key.status === 'ready' && service.environment.online()) || (regularSeasonsCached(info) && (key.status === 'ready' || key.cachedMarkAccount)));
    const canRemove = service.store.role === 'writer' && tables.watched.some(row => row.season !== 0);
    const unknown = !show && !hasRecord && value.status !== 'not-found';
    columns.hidden = unknown;
    const primary = canMark && figures.aired > 0 ? figures.watchedAired < figures.aired ? 'mark' : 'again' : null;
    renderTmdbState(status, loadingHeader && !latestShow ? 'loading' :
      value.status === 'cached' ? value.reason ?? 'cached' : value.status, actions);
    header.classList.toggle('no-detail', unknown);
    const heading = el('h1', '', title);
    heading.tabIndex = -1;
    if (unknown) {
      scoreLayout.disconnect();
      seasonContent = seasonScoreContent = '';
      heroArtwork = '';
      header.replaceChildren(heading);
      seasons.replaceChildren();
      return;
    }

    const titleBlock = el('div', 'show-title-block');
    const year = show?.firstAirDate?.slice(0, 4) ?? tables.shows[0]?.year?.toString();
    const ranges = broadcastSeasons(show);
    const size = ranges?.filter(r => !r.unassigned).length ?? show?.seasons.filter(s => s.season !== 0).length;
    const line = [year, size === undefined ? null : size + (size === 1 ? ' season' : ' seasons'), show?.status].filter(Boolean).join(' · ');
    titleBlock.append(heading);
    if (line) titleBlock.append(el('p', 'show-facts', line));
    const personal = el('div', 'show-labels');
    const known = Boolean(show || hasRecord);
    const personalShow = { show_id: id, show: savedTitle };
    const writable = service.store.role === 'writer';
    function restoreFocus(selector: string) {
      if (closed) return null;
      return header.querySelector<HTMLElement>(selector + ':not(:disabled)') ?? header.querySelector<HTMLElement>('h1');
    }
    if (known) {
      const currentRating = tables.ratings[0]?.rating ?? null;
      const rating = el('button', 'show-rating', currentRating === null ? 'Rate' : String(currentRating));
      rating.type = 'button';
      rating.disabled = !writable;
      rating.dataset.focus = 'rating';
      rating.setAttribute('aria-haspopup', 'dialog');
      if (currentRating !== null) rating.append(el('small', '', '/10'));
      rating.setAttribute('aria-label', currentRating === null ? 'Rate ' + title : 'Personal rating ' + currentRating + ' out of 10');
      rating.onclick = () => {
        if (closed || busy) return;
        closeSheet?.();
        closeSheet = openRatingSheet(page, ctx, personalShow, currentRating, () => restoreFocus('.show-rating'));
      };
      personal.append(rating);
    }
    if (tables.lists.some(row => canonicalListName(row.list) === favoritesList)) {
      personal.append(el('span', 'show-list-tag', favoritesList));
    }
    if (personal.childElementCount) titleBlock.append(personal);
    const buttons = el('div', 'show-actions');
    if (primary) {
      const label = primary === 'again' ? 'Watched again' : figures.watchedAired > 0 ? 'Finish' : 'Mark watched';
      const mark = el('button', 'primary', label);
      mark.dataset.focus = 'mark';
      mark.onclick = () => { void act('watches',() => ctx.watch.bulk(id, {}, primary)); };
      buttons.append(mark);
    }
    const dropped = tables.lists.some(row => dropMembership(row.list) === 'dropped');
    if (known) {
      const drop = el('button', 'show-drop', dropped ? 'Pick Up' : 'Drop');
      drop.type = 'button';
      drop.dataset.focus = 'drop';
      drop.disabled = !writable;
      drop.onclick = () => void act('dropped',async () => {
        if (await ctx.watch.setDropped(personalShow, !dropped)) await ctx.run(draw);
      });
      buttons.append(drop);
      const list = el('button', 'show-list', 'List');
      list.type = 'button';
      list.dataset.focus = 'list';
      list.disabled = !writable;
      list.setAttribute('aria-haspopup', 'dialog');
      list.setAttribute('aria-label', 'Lists for ' + title);
      list.onclick = () => {
        if (closed || busy) return;
        closeSheet?.();
        closeSheet = openMembershipSheet(page, ctx, personalShow, () => restoreFocus('.show-list'), false);
      };
      buttons.append(list);
    }
    function changeWatchlist(member: boolean) {
      void act('watchlist',async () => {
        if (await ctx.watch.setMembership(personalShow, 'Watchlist', member)) await ctx.run(draw);
      });
    }
    if (known && !dropped && !tables.watched.length && !figures.upcoming) {
      const watchlist = el('button', 'show-watchlist', 'Add to Watchlist');
      watchlist.type = 'button';
      watchlist.disabled = !writable;
      watchlist.dataset.focus = 'watchlist';
      watchlist.onclick = () => changeWatchlist(true);
      buttons.append(watchlist);
    }
    const showActions: SheetAction[] = [];
    if (writable && show?.seasons.some(s => s.season > 0)) {
      showActions.push({label:'Season order', choose:() => {
        closeSheet = openSeasonOrderEditor(page,ctx,show,() => restoreFocus('.show-more'));
      }});
    }
    if (writable && figures.upcoming) showActions.push({label:'Remove from Watchlist', choose:() => changeWatchlist(false)});
    const canBeRecent = writable && tables.watched.length > 0;
    function menuActions(recent: boolean | Promise<boolean>) {
      const actions = [...showActions];
      if (recent) {
        const recordGeneration = ctx.watch.recordGeneration;
        actions.push({label:'Remove from Recently marked', when: typeof recent === 'boolean' ? undefined : recent, choose:() => {
          void act('recent',async () => {
            const current = () => ctx.watch.recordGeneration === recordGeneration;
            if (closed || !current()) return;
            await service.store.dismissRecentMark(id,current);
            if (!closed && current()) await ctx.run(draw);
          });
        }});
      }
      if (canRemove) actions.push({label:'Remove watches', destructive:true, choose:() => {
        void act('watches',() => ctx.watch.remove(id));
      }});
      return actions;
    }
    let hasMenu = showActions.length > 0 || canRemove;
    if (!hasMenu && canBeRecent) {
      // A watched special with no other actions only needs a menu when it is on the rail.
      try { hasMenu = await recentFor(record).pending; }
      catch (error) { if (closed || ticket !== drawing || error instanceof StaleSnapshotError) return; throw error; }
      if (ticket !== drawing || closed) return;
    }
    if (hasMenu) {
      const more = el('button', 'show-more', '•••');
      more.dataset.focus = 'more';
      more.setAttribute('aria-label', 'More show actions');
      more.setAttribute('aria-haspopup', 'dialog');
      more.onclick = () => {
        if (busy || closed || service.store.role !== 'writer') return;
        closeSheet?.();
        const state = canBeRecent ? recentFor(record) : undefined;
        const recent = state && state.visible === undefined
          ? state.pending.then(visible => visible && !closed && displayedRevision === record.revision && service.store.role === 'writer')
          : state?.visible === true;
        closeSheet = openActionSheet(page, () => {
          closeRecentMenu = undefined;
          if (state === recentState) cancelRecentRead();
          return restoreFocus('.show-more');
        }, { title: 'Show actions', eyebrow: title,
          actions: menuActions(recent) });
        if (state) closeRecentMenu = closeSheet;
      };
      buttons.append(more);
    }
    const stats = el('div', 'show-stats');
    stats.append(tile('Episodes', (figures.aired ? figures.watchedAired : figures.recordedEpisodes).toLocaleString(), figures.aired || undefined),
      tile('Completed', figures.completed === null ? '–' : figures.completed.toLocaleString() + '×'),
      tile('Plays', figures.plays.toLocaleString()));
    const artwork = JSON.stringify([show?.backdropPath,show?.posterPath,config?.backdropSizes,config?.posterSizes]);
    if (heroArtwork !== artwork) {
      heroArtwork = artwork;
      header.replaceChildren(image('backdrop',show?.backdropPath,1100),image('poster',show?.posterPath,185),titleBlock,buttons,stats);
    } else {
      header.querySelector('.show-title-block')!.replaceWith(titleBlock);
      header.querySelector('.show-actions')!.replaceWith(buttons);
      header.querySelector('.show-stats')!.replaceWith(stats);
    }

    const seasonDetails = new Map(show?.seasons.map(s => [s.season, s]));
    const progress = figures.seasons.slice();
    if (!info) {
      for (const number of new Set(tables.watched.map(row => row.season))) {
        progress.push({ season: number, aired: 0, watchedAired: 0, recordedEpisodes: tables.watched.filter(r => r.season === number).length,
          completed: null, rewatch: null });
      }
    }
    progress.sort((a, b) => Number(a.season === 0) - Number(b.season === 0) || a.season - b.season);
    const reachable = key.status === 'ready' && service.environment.online();
    const cachedSeasons = new Set(info?.seasons.filter(s => s.episodes !== undefined).map(s => s.season));
    const tiles = progress.map(row => {
      const range = ranges?.find(r => r.number === row.season);
      const native = range?.sourceSeason ?? row.season;
      const detail = seasonDetails.get(native);
      const allowed = !!detail && writable && (reachable || (cachedSeasons.has(native) &&
        (key.status === 'ready' || !!key.cachedMarkAccount)));
      return {row,name:range ? range.name : detail?.name,allowed,range};
    });
    // A background sync can finish between touchstart and click. Keep the
    // live link and its buttons when the season information did not change.
    const nextSeasons = JSON.stringify(tiles);
    if (nextSeasons !== seasonContent) {
      seasonContent = nextSeasons;
      seasonScoreContent = '';
      scoreLayout.disconnect();
      seasons.replaceChildren(el('h2','','Seasons'),...tiles.map(t=>seasonRow(t.row,t.name,t.allowed,t.range)));
      if (!tiles.length) seasons.append(el('p', 'secondary', 'No seasons listed.'));
    }
    displayRatings.render(scores => {
      if (closed || ticket !== drawing) return;
      const mal = selectShowMalScores(scores.mal?.get(id), info ?? show);
      personal.querySelector('.outside-scores')?.remove();
      appendShowRatings(personal, scores.critics?.get(id), scores.imdb?.get(id));
      if (personal.childElementCount && !personal.parentElement) titleBlock.append(personal);
      const nextScores = JSON.stringify([...mal.seasons]);
      if (seasonScoreContent === nextScores) return;
      seasonScoreContent = nextScores;
      scoreLayout.disconnect();
      for (const row of seasons.querySelectorAll<HTMLElement>('[data-season]')) {
        const copy = row.querySelector<HTMLElement>('.show-season-copy')!;
        copy.querySelector('.season-scores')?.remove();
        const values = mal.seasons.get(Number(row.dataset.season));
        if (!values?.length) continue;
        const label = copy.querySelector<HTMLElement>('.show-season-title')!;
        const marks = el('span','season-scores');
        for (const score of values) {
          const item = el('span','season-score-item');
          appendMalRating(item,score,2);
          marks.append(item);
        }
        label.append(marks);
        placeSeasonScores(copy);
        for (const element of [label,label.firstElementChild!,...marks.children]) scoreLayout.observe(element);
      }
    });
    indicateBusy();
    if (focused && doc.activeElement === doc.body) {
      const control = page.querySelector<HTMLElement>('[data-focus="' + CSS.escape(focused) + '"]');
      const alternate = focused === 'watchlist' ? header.querySelector<HTMLElement>('.show-more') :
        focused === 'more' ? header.querySelector<HTMLElement>('.show-watchlist') : null;
      const count = control?.matches('.show-season-controls button:disabled')
        ? control.parentElement?.querySelector<HTMLElement>('.show-season-count') : null;
      (count ?? control ?? alternate ?? heading).focus({ preventScroll: true });
    }
  }

  function signature(key:KeyDisplay) {
    return [key.generation, key.status, service.store.role, service.environment.online()].join('/');
  }

  async function refreshCritics() {
    const critics = ctx.critics;
    if (!critics) return;
    const key = await critics.keyStatus();
    const next = [key.generation, key.status, service.store.role, service.environment.online()].join('/');
    if (closed || next === criticSource) return;
    criticSource = next;
    if (key.status === 'ready') await critics.refresh([id]);
  }

  async function refreshImdb() {
    if (!ctx.imdb || !opened) return;
    const status = await ctx.imdb.sourceStatus();
    const next = [status.generation, status.refused, status.retryAt, source].join('/');
    if (closed || next === imdbSource) return;
    imdbSource = next;
    if (status.source !== 'none') await ctx.imdb.refreshShows([id]);
  }

  async function open(verifiedKey?:KeyDisplay) {
    const ticket = ++fetching;
    drawing++;
    activeRead?.abort();
    if (ctx.critics) void ctx.run(refreshCritics);
    const key = verifiedKey ?? await service.keyStatus();
    if (ticket !== fetching || closed) return;
    source = signature(key);
    try {
      loadingHeader = true;
      opened ??= {show:{status:'ready',value:null},cast:null,recommendations:null};
      // Paint the saved watch record and any cached title immediately. Cast and
      // recommendation lookups can finish independently of the first usable view.
      let painted = false;
      const firstPaint = ctx.run(()=>draw(false,key)).finally(() => { painted = true; });
      const details = await service.openShow(id, show => {
        if (ticket !== fetching || closed) return;
        loadingHeader = false;
        opened = {...opened!,show};
        if (painted || !cacheOnlyView(show)) void ctx.run(draw);
      }, () => !closed && ticket === fetching);
      if (ticket !== fetching || closed) return;
      loadingHeader = false;
      opened = details;
      // The show response already includes external IDs. Resolve the rating after it arrives.
      if (ctx.imdb) void ctx.run(refreshImdb);
      if (cacheOnlyView(details.show) && (!details.cast || cacheOnlyView(details.cast)) &&
          (!details.recommendations || cacheOnlyView(details.recommendations))) await firstPaint;
      if (ticket !== fetching || closed) return;
      await draw();
    } catch (error) {
      if (ticket === fetching && !closed) throw error;
    }
  }

  return {
    ready: open(),
    async refresh() {
      if (closed) return;
      if (!opened) return open();
      await draw(true);
    },
    dispose() {
      closed = true;
      activeRead?.abort();
      cancelRecentRead();
      scoreLayout.disconnect();
      recommendationRail.dispose();
      repair.dispose();
      closeSheet?.();
      page.remove();
    },
  };
}
