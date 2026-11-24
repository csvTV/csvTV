import { choiceControl, rememberSort, type Choice } from './view-select.ts';
import { createProgressActions, type InitialMenuFocus } from './library-status-menu.ts';
import { canonicalListName } from './model.ts';
import { isAnimeClassification, libraryCategories as categories, matchesLibraryCategory, type LibraryCategory } from './anime.ts';
import type { ImdbService } from './imdb-service.ts';
import type { ImdbHeaders, RecordStamp } from './storage.ts';
import type { CriticScores, MdbListService } from './mdblist-service.ts';
import type { MalEntry } from './mal-file.ts';
import { dropMembership, upcomingMembership } from './upcoming-preference.ts';
import { poster } from './poster.ts';
import { compareTitles, malScoresForShows, overviewWithCache, readOverviewCache } from './record-overview.ts';
import type { createLibraryHistory, LibraryOverview, LibraryPreview, LibraryShow } from './library-history.ts';
import type { Screen, ScreenContext } from './screen-context.ts';
import { searchText } from './title-search.ts';
import type { TmdbConfiguration } from './tmdb-data.ts';
import { renderOmittedShows } from './tmdb-settings.ts';

export interface LibraryPreferences {
  page: 'library';
  query: string;
  category: LibraryCategory;
  dropped: boolean;
  group: 'all' | 'complete' | 'more';
  list: string | null;
  rating: string;
  sort: 'title' | 'rating' | 'episodes' | 'tomatoes' | 'metacritic' | 'imdb' | 'myanimelist';
  readerSort?: {scope:string; value:LibraryPreferences['sort']};
  position?: {id: number; top: number; y: number; keyboard: boolean};
}

const groups = { all: 'All', complete: 'Complete', more: 'More to watch' } as const;
const sortOptions = [
  { value: 'title', label: 'Title' },
  { value: 'rating', label: 'Rating' },
  { value: 'episodes', label: 'Episodes watched' },
  { value: 'tomatoes', label: 'Rotten Tomatoes' },
  { value: 'metacritic', label: 'Metacritic' },
  { value: 'imdb', label: 'IMDb rating' },
  { value: 'myanimelist', label: 'MyAnimeList score' },
] as const;
const ratingOptions: Choice[] = [
  { value: 'any', label: 'Any' }, { value: 'rated', label: 'Rated' }, { value: 'unrated', label: 'Unrated' },
  ...Array.from({ length: 10 }, (_, i) => ({ value: String(i + 1), label: i + 1 === 10 ? '10' : (i + 1) + ' and above' })),
];

function episodeCount({ progress }: LibraryShow) {
  return progress.aired ? progress.watchedAired : progress.recordedEpisodes;
}

function matchesRating(rating: number | null, filter: string) {
  if (filter === 'any') return true;
  if (filter === 'unrated') return rating === null;
  return rating !== null && (filter === 'rated' || rating >= Number(filter));
}

function matchesGroup(show: LibraryShow, group: LibraryPreferences['group']) {
  return group === 'all' || (group === 'complete' ? show.progress.complete : show.progress.moreToWatch);
}

const partialActions = ['Complete','Drop'], completedActions = ['Watch again'], droppedActions = ['Pick up'], unseenTotalActions = ['Drop'];
function libraryCard(doc: Document, id: number, openShow: (id: number, item: HTMLElement) => void,
    openStatus: (show: LibraryShow, control: HTMLButtonElement, choices: readonly string[], focus: InitialMenuFocus) => void) {
  const item = doc.createElement('li');
  item.dataset.libraryShow = String(id);
  const link = doc.createElement('a');
  link.href = '#/show/' + id;
  link.dataset.showId = String(id);
  link.onclick = event => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    openShow(id,item);
  };
  const title = doc.createElement('strong');
  const details = doc.createElement('div');
  details.className = 'library-details';
  const field = doc.createElement('div');
  field.className = 'library-status';
  const control = doc.createElement('button');
  control.className = 'library-status-trigger';
  control.type = 'button';
  const captionText = doc.createElement('span');
  captionText.className = 'library-status-caption';
  control.append(captionText);
  field.append(control);
  const count = doc.createElement('span');
  count.className = 'library-episode-count';
  const bar = doc.createElement('progress');
  const rating = doc.createElement('span'), score = doc.createTextNode(''), scale = doc.createElement('small');
  rating.className = 'library-rating';
  scale.textContent = '/10';
  rating.append(score,scale);
  const note = doc.createElement('small');
  note.textContent = 'Not on TMDB';
  details.append(field);
  link.append(title);
  item.append(link,details);
  let art: HTMLElement | undefined, imageKey = '';
  let current: LibraryShow, choices: readonly string[];
  let desktopPicker: boolean | undefined;
  control.onclick = event => openStatus(current,control,choices,event.detail === 0 ? 'first' : 'menu');
  control.onkeydown = e => {
    if (desktopPicker && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      openStatus(current,control,choices,e.key === 'ArrowUp' ? 'last' : 'first');
    }
  };
  return {item, update(show: LibraryShow, config: TmdbConfiguration | null, sizes: string, droppedView: boolean, writable: boolean, desktop: boolean) {
    current = show;
    const key = (show.posterPath ?? '') + '|' + sizes;
    if (!art || imageKey !== key) {
      const next = poster(doc,show,config);
      if (art) art.replaceWith(next); else link.prepend(next);
      art = next; imageKey = key;
    }
    if (link.title !== show.title) title.textContent = link.title = show.title;
    const {progress} = show, n = episodeCount(show);
    const dropped = show.lists.some(name => dropMembership(name) === 'dropped');
    const episodes = n.toLocaleString() + (progress.aired ? ' of ' + progress.aired.toLocaleString() :
      n === 1 ? ' episode' : ' episodes');
    const caption = dropped ? 'Dropped' : progress.complete ? 'Complete' : episodes;
    choices = dropped ? droppedActions : progress.complete ? completedActions : progress.aired ? partialActions : unseenTotalActions;
    if (desktopPicker !== desktop) {
      desktopPicker = desktop;
      control.setAttribute('aria-haspopup',desktop ? 'menu' : 'dialog');
      if (desktop) control.setAttribute('aria-expanded','false');
      else control.removeAttribute('aria-expanded');
    }
    if (captionText.textContent !== caption) captionText.textContent = caption;
    const label = caption + ', ' + show.title;
    if (control.getAttribute('aria-label') !== label) control.setAttribute('aria-label',label);
    if (control.disabled === writable) control.disabled = !writable;
    if (droppedView && dropped) {
      if (count.textContent !== episodes) count.textContent = episodes;
      if (!count.parentElement) details.append(count);
    } else count.remove();
    if (progress.aired && !progress.complete && !dropped) {
      if (bar.max !== progress.aired) bar.max = progress.aired;
      if (bar.value !== n || !bar.hasAttribute('value')) bar.value = n;
      if (bar.parentElement !== art) art.append(bar);
    } else bar.remove();
    if (show.rating !== null) {
      if (score.data !== String(show.rating)) score.data = String(show.rating);
      if (!rating.parentElement) details.append(rating);
    } else rating.remove();
    if (show.missing) {
      if (!note.parentElement) item.append(note);
    } else note.remove();
  }};
}

export function mountLibraryScreen(root: HTMLElement, ctx: ScreenContext, preferences?: LibraryPreferences, canOpenRecovery = false,
    previousShow?: number, visitScope: string = crypto.randomUUID(), history?:ReturnType<typeof createLibraryHistory>): Screen {
  const doc = root.ownerDocument;
  const win = doc.defaultView!;
  const desktopPicker = win.matchMedia('(min-width: 900px) and (pointer: fine)');
  const oldAnimeList = typeof preferences?.list === 'string' && isAnimeClassification(preferences.list);
  const oldStoppedList = typeof preferences?.list === 'string' && dropMembership(preferences.list) === 'dropped';
  const previousReaderSort = preferences?.readerSort;
  const readerSort = previousReaderSort?.scope === visitScope && sortOptions.some(o => o.value === previousReaderSort.value)
    ? previousReaderSort : undefined;
  const restoredSort = previousReaderSort ? readerSort?.value : preferences?.sort;
  const state: LibraryPreferences = {
    page: 'library', query: typeof preferences?.query === 'string' ? preferences.query : '',
    category: preferences?.category && Object.hasOwn(categories,preferences.category) ? preferences.category : oldAnimeList ? 'anime' : 'all',
    dropped: preferences?.dropped === true || oldStoppedList,
    group: preferences?.group === 'complete' || preferences?.group === 'more' ? preferences.group : 'all',
    list: typeof preferences?.list === 'string' && !oldAnimeList && !oldStoppedList && !upcomingMembership(preferences.list)
      ? canonicalListName(preferences.list) : null,
    rating: ratingOptions.find(o => o.value === preferences?.rating)?.value ?? 'any',
    sort: sortOptions.find(o => o.value === restoredSort)?.value ?? 'title',
    ...(readerSort && {readerSort}),
  };
  root.innerHTML = `<section class="library-screen"><header class="screen-heading"><div class="library-heading"><h1>Library</h1><p class="library-count" role="status"></p></div></header>
    <div class="library-controls"><div class="library-chips list-chips" role="group" aria-label="Library filters"></div>
    <div class="library-selects"><label class="tv-search-field"><span class="search-glass" aria-hidden="true"></span>
    <input type="search" autocomplete="off" placeholder="Search Library" aria-label="Search your shows"></label></div></div>
    <p class="tv-note" data-omitted></p><p class="tv-empty">Loading…</p>
    <details class="library-recovery" hidden><summary>Looking for your shows?</summary>
    <p>Check the site address and browser profile you used to save them.</p></details>
    <ul class="library-grid" aria-label="Shows in your Library"></ul></section>`;
  const input = root.querySelector('input')!;
  input.defaultValue = state.query;
  const chips = root.querySelector<HTMLElement>('.library-chips')!;
  const grid = root.querySelector<HTMLUListElement>('.library-grid')!;
  const summary = root.querySelector<HTMLElement>('.library-count')!;
  const empty = root.querySelector<HTMLElement>('.tv-empty')!;
  const readError = 'Could not read your Library on this device.';
  const recovery = root.querySelector<HTMLDetailsElement>('.library-recovery')!;
  if (canOpenRecovery) {
    const link = doc.createElement('a');
    link.href = '#/recovery';
    link.tabIndex = 0;
    link.textContent = 'Backups and restore';
    recovery.append(link);
  }
  const omission = root.querySelector<HTMLElement>('[data-omitted]')!;
  let overview: LibraryOverview | undefined;
  let painted: {overview: NonNullable<typeof overview>; dropped: boolean; writable: boolean; desktop: boolean} | undefined;
  let cache: Awaited<ReturnType<typeof readOverviewCache>> | undefined;
  let categoryHeaders: NonNullable<typeof cache>['details'] | undefined;
  let readingFirstCache = false;
  let recordReadable = false;
  let watched: LibraryShow[] = [];
  const cards = new Map<number,ReturnType<typeof libraryCard>>();
  let dropped: LibraryShow[] = [];
  let scores = new Map<number, CriticScores>();
  let hasCriticKey = false;
  let hasMalScores = false;
  let criticConfig: Awaited<ReturnType<MdbListService['displaySource']>> | undefined;
  let imdbRatings = new Map<number, number>();
  let malRatings = new Map<number, number>();
  let hasImdbSource = false;
  let imdbConfig: Awaited<ReturnType<ImdbService['sourceStatus']>> | undefined;
  let generation = 0;
  let metadataRead: AbortController | undefined;
  let disposed = false;
  const statusActions = createProgressActions(root,ctx,desktopPicker,() => !disposed && recordReadable,focusTarget);
  let preferredSort = state.sort;
  function openShow(id: number, item: HTMLElement) {
    const y = win.scrollY;
    const keyboard = item.querySelector('a')?.matches(':focus-visible') === true && !doc.documentElement.hasAttribute('data-touch-input');
    if (y > 0 || keyboard) ctx.saveView({...state,position:{id,top:item.getBoundingClientRect().top,y,keyboard}});
    else if (preferences?.position) ctx.saveView({...state});
    ctx.go({page:'show',id});
  }
  let position = preferences?.position;
  if (!position || position.id !== previousShow || !Number.isSafeInteger(position.id) || !Number.isFinite(position.top) ||
      !Number.isFinite(position.y) || position.y < 0) position = undefined;
  const scrollEvents = new AbortController();
  let restoredY: number | undefined;
  function stopRestoring() {
    position = undefined;
    scrollEvents.abort();
  }
  function respectNewScroll() {
    if (position && restoredY !== undefined && Math.abs(win.scrollY - restoredY) > 1) stopRestoring();
  }
  if (position) {
    // The same Library/Show history pair may be traversed several times.
    const options = {capture:true,passive:true,signal:scrollEvents.signal};
    for (const event of ['pointerdown','wheel','touchstart','keydown']) win.addEventListener(event,stopRestoring,options);
    win.addEventListener('scroll',respectNewScroll,{passive:true,signal:scrollEvents.signal});
  }
  // Keep the opened card in place through the initial record, metadata and sort paints.
  function restorePosition() {
    if (!position || !grid.childElementCount) return;
    const item = cards.get(position.id)?.item;
    if (item?.parentElement === grid) {
      const rect = item.getBoundingClientRect();
      const layout = win.getComputedStyle(doc.documentElement);
      const viewport = win.visualViewport;
      const usableTop = (viewport?.offsetTop ?? 0) + (parseFloat(layout.scrollPaddingTop) || 0);
      const usableBottom = (viewport?.offsetTop ?? 0) + (viewport?.height ?? win.innerHeight) -
        (parseFloat(layout.scrollPaddingBottom) || 0);
      const visible = Math.min(position.top + rect.height, usableBottom) - Math.max(position.top, usableTop);
      // Rotation or a shorter window can leave the old position underneath fixed navigation.
      const top = visible >= Math.min(44, rect.height, usableBottom - usableTop) ? position.top :
        usableTop + Math.max(0, (usableBottom - usableTop - rect.height) / 2);
      const delta = rect.top - top;
      if (Math.abs(delta) > 1) win.scrollBy(0,delta);
      if (position.keyboard && doc.activeElement === root && !doc.documentElement.hasAttribute('data-touch-input')) {
        item.querySelector('a')?.focus({preventScroll:true});
      }
    } else win.scrollTo(0,position.y);
    restoredY = win.scrollY;
  }
  function focusTarget(control: HTMLElement) {
    if (!grid.contains(control)) return input;
    return control.matches(':disabled') ? control.closest('li')?.querySelector('a') ?? input : control;
  }
  function update(changes: Partial<LibraryPreferences>) {
    Object.assign(state, changes);
    ctx.saveView({ ...state });
    render();
  }
  input.oninput = () => update({ query: input.value });
  const categoryButtons = (Object.keys(categories) as LibraryCategory[]).map(category => {
    const button = doc.createElement('button');
    const count = doc.createElement('span');
    button.type = 'button';
    button.dataset.category = category;
    button.append(categories[category], ' ', count);
    button.onclick = () => update({ category });
    chips.append(button);
    return { button, count, category };
  });
  const dropButton = doc.createElement('button');
  dropButton.type = 'button';
  dropButton.dataset.filter = 'dropped';
  const dropCount = doc.createElement('span');
  dropButton.append('Dropped ', dropCount);
  dropButton.onclick = () => update({ dropped: !state.dropped });
  chips.append(dropButton);
  const progress = choiceControl(doc,'Progress',value => {
    if (value === 'all' || value === 'complete' || value === 'more') update({group:value});
  });
  progress.select.dataset.filter = 'progress';
  const lists = choiceControl(doc,'List',value =>
    update({list:value && overview?.listNames.includes(value.slice(1)) ? value.slice(1) : null}));
  const ratings = choiceControl(doc,'Rating',rating => update({rating}));
  lists.select.dataset.filter = 'list';
  ratings.select.dataset.filter = 'rating';
  ratings.display(ratingOptions,state.rating);
  const fields = root.querySelector<HTMLElement>('.library-selects')!;
  function availableSorts() {
    return sortOptions.filter(({value}) => value === 'imdb' ? hasImdbSource
      : value === 'myanimelist' ? hasMalScores
      : value === 'tomatoes' || value === 'metacritic' ? hasCriticKey : true);
  }
  const preference = rememberSort(ctx,'librarySort',preferredSort,
    (value): value is LibraryPreferences['sort'] => sortOptions.some(item => item.value === value), saved => {
      const visible = state.readerSort?.value ?? saved;
      if (preferredSort !== visible) {
        preferredSort = visible;
        render();
      }
    });
  const sorting = choiceControl(doc,'Sort', value => {
    const selected = availableSorts().find(choice => choice.value === value);
    if (selected) {
      // A reader can sort this visit. Gaining the writer lock does not turn it into a saved preference.
      if (ctx.service.store.role === 'reader') state.readerSort = {scope:visitScope,value:selected.value};
      else delete state.readerSort;
      preference.choose(selected.value);
      ctx.saveView({...state,sort:selected.value});
    }
  });
  fields.prepend(progress.root,lists.root,ratings.root,sorting.root);

  function inCategory(show: LibraryShow, category: LibraryCategory) {
    if (!categoryHeaders || category === 'all') return matchesLibraryCategory(show,category);
    return matchesLibraryCategory({lists:show.lists,metadata:categoryHeaders.get(show.id)?.value},category);
  }
  function categoryCounts(pool: LibraryShow[]) {
    for (const {button,count,category} of categoryButtons) {
      button.setAttribute('aria-pressed',String(category === state.category));
      count.textContent = overview && recordReadable && (!readingFirstCache || categoryHeaders || category === 'all')
        ? pool.filter(show => inCategory(show,category)).length.toLocaleString() : '';
    }
    dropButton.setAttribute('aria-pressed',String(state.dropped));
    dropCount.textContent = overview && recordReadable && (!readingFirstCache || categoryHeaders || state.category === 'all')
      ? dropped.filter(show => inCategory(show,state.category)).length.toLocaleString() : '';
  }
  function render() {
    // A pending scroll event can arrive after this paint. Honor its new position before moving any cards.
    respectNewScroll();
    // The list and sort choices depend on this device's record and sources.
    lists.select.disabled = sorting.select.disabled = !overview;
    const names = overview?.listNames ?? [];
    const quote = names.includes('Any');
    lists.display([{value:'',label:'Any'},...names.map(name => ({value:'='+name,label:quote ? '“'+name+'”' : name}))],
      state.list === null ? '' : '='+state.list);
    ratings.select.value = state.rating;
    const choices = availableSorts();
    state.sort = choices.some(choice => choice.value === preferredSort) ? preferredSort : 'title';
    sorting.display(choices,state.sort);
    const mdbSort = state.sort === 'tomatoes' || state.sort === 'metacritic' || state.sort === 'myanimelist' ? state.sort : null;
    const pool = state.dropped ? dropped : watched;
    categoryCounts(pool);
    const categoryShows = pool.filter(show => inCategory(show,state.category));
    progress.display((Object.keys(groups) as LibraryPreferences['group'][]).map(value => ({
      value,label:groups[value] + (overview && recordReadable && (!readingFirstCache || value === 'all' && (categoryHeaders || state.category === 'all'))
        ? ' (' + categoryShows.filter(show => matchesGroup(show,value)).length.toLocaleString() + ')' : ''),
    })),state.group);
    if (!overview) return;
    const query = searchText(state.query);
    const candidates = categoryShows.filter(show => (state.list === null || show.lists.includes(state.list)) &&
      matchesRating(show.rating, state.rating) && (!query || searchText(show.title).includes(query)));
    const shows = candidates.filter(show => matchesGroup(show, state.group));
    shows.sort((a, b) => {
      if (state.sort === 'myanimelist') {
        const score = (id: number) => (criticConfig?.malSource === 'github' ? malRatings.get(id) : scores.get(id)?.myanimelist) ?? -1;
        return score(b.id) - score(a.id) || compareTitles(a, b);
      }
      if (mdbSort) return (scores.get(b.id)?.[mdbSort] ?? -1) - (scores.get(a.id)?.[mdbSort] ?? -1) || compareTitles(a, b);
      if (state.sort === 'imdb') return (imdbRatings.get(b.id) ?? -1) - (imdbRatings.get(a.id) ?? -1) || compareTitles(a, b);
      if (state.sort === 'rating') return (b.rating ?? -1) - (a.rating ?? -1) || compareTitles(a, b);
      if (state.sort === 'episodes') return episodeCount(b) - episodeCount(a) || compareTitles(a, b);
      return compareTitles(a, b);
    });
    if (readingFirstCache) omission.textContent = '';
    else if (state.group === 'all') {
      const count = categoryShows.filter(show => !show.metadata).length;
      omission.textContent = count ? 'Progress counts omit ' + count.toLocaleString() +
        (count === 1 ? ' show' : ' shows') + ' with unavailable title data.' : '';
    } else {
      const skipped = candidates.filter(show => !show.metadata &&
        (state.group !== 'more' || !show.lists.some(name => dropMembership(name) === 'dropped')));
      renderOmittedShows(omission, { unfetched: skipped.map(show => show.id), missing: [] });
    }
    const active = grid.contains(doc.activeElement) ? doc.activeElement as HTMLElement : null;
    const keep = new Set(shows.map(show => show.id));
    const sizes = overview.config?.posterSizes.join(',') ?? '';
    const writable = recordReadable && ctx.service.store.role === 'writer';
    const desktop = desktopPicker.matches;
    // Each record or metadata refresh creates a new overview. A new sort only moves existing cards.
    const cardsChanged = painted?.overview !== overview || painted.dropped !== state.dropped ||
      painted.writable !== writable || painted.desktop !== desktop;
    if (cardsChanged) painted = {overview,dropped:state.dropped,writable,desktop};
    // Narrowing a search can hide most of the Library. Reuse hidden cards only
    // while their record, status actions and responsive layout are still current.
    for (const [id,card] of cards) if (!keep.has(id)) {
      if (card.item.parentElement === grid) card.item.remove();
      if (cardsChanged) cards.delete(id);
    }
    let position = grid.firstElementChild;
    const target = position ? grid : doc.createDocumentFragment();
    for (const show of shows) {
      const existing = cards.get(show.id);
      const card = existing ?? libraryCard(doc,show.id,openShow,statusActions.open);
      if (!existing) cards.set(show.id,card);
      if (!existing || cardsChanged) card.update(show,overview.config,sizes,state.dropped,writable,desktop);
      if (card.item !== position) target.insertBefore(card.item,position);
      position = card.item.nextElementSibling;
    }
    if (target !== grid && target.childElementCount) grid.append(target);
    const waitingForCategory = readingFirstCache && pool.length > 0 && (state.group !== 'all' || state.category !== 'all' && !categoryHeaders);
    summary.textContent = recordReadable && !waitingForCategory ? shows.length.toLocaleString() + (shows.length === 1 ? ' show' : ' shows') : '';
    empty.textContent = !recordReadable ? readError : shows.length ? '' : waitingForCategory ? 'Loading…' :
      state.dropped && !dropped.length ? 'No dropped shows.' : state.dropped || watched.length ? 'No matching shows.' : 'Shows appear here when you mark an episode watched.';
    recovery.hidden = !recordReadable || watched.length > 0 || state.dropped || state.category !== 'all' || state.group !== 'all' || !!state.query || state.list !== null || state.rating !== 'any';
    if (recovery.hidden) recovery.open = false;
    statusActions.refresh();
    if (active && doc.activeElement === doc.body) focusTarget(active).focus({preventScroll:true});
    restorePosition();
  }
  function showRecord(result: NonNullable<typeof overview>) {
    overview = result;
    watched = result.shows.filter(show => show.progress.recordedEpisodes > 0);
    dropped = result.shows.filter(show => show.lists.some(name => dropMembership(name) === 'dropped'));
    if (state.list !== null && !result.listNames.includes(state.list)) update({ list: null });
    else render();
  }
  let visitStamp:RecordStamp|undefined;
  async function refresh(waitForCache = true, savedSort?:Promise<void>) {
    if (disposed) return;
    const current = ++generation;
    metadataRead?.abort();
    const {signal} = metadataRead = new AbortController();
    const {service} = ctx;
    const historyGeneration = history?.generation ?? 0;
    let preview:LibraryPreview|undefined;
    let settled = false;
    // The live cards need only the four personal tables. The separate revision read is admitted
    // after theirs, so a queued settings writer can delay verification without hiding those cards.
    const pending = service.store.overviewRows(false,signal);
    let revision:bigint|undefined;
    const verified = history && service.store.role === 'writer'
      ? service.store.recordRevision(signal).then(value => {revision = value;},() => {}) : undefined;
    // A verified view can fill in progress while fresh episodes load, even after the personal rows arrive.
    if (savedSort && verified) void Promise.all([savedSort,verified]).then(() => {
      if (settled || signal.aborted || current !== generation || !visitStamp || visitStamp.revision !== revision ||
          (preferredSort !== 'title' && preferredSort !== 'rating' && preferredSort !== 'episodes')) return;
      preview = history?.read(service.environment.now(),visitStamp);
      if (preview) {
        recordReadable = true;
        readingFirstCache = false;
        showRecord(preview.overview);
      }
    },() => {});
    const tables = await pending.catch(error => {
      settled = true;
      if (current !== generation) return;
      recordReadable = false;
      history?.clear();
      const lostFocus = grid.contains(doc.activeElement);
      summary.textContent = omission.textContent = '';
      overview = undefined;
      painted = undefined;
      cache = undefined;
      categoryHeaders = undefined;
      readingFirstCache = false;
      watched = [];
      dropped = [];
      scores = new Map();
      imdbRatings = new Map();
      malRatings = new Map();
      cards.clear();
      grid.replaceChildren();
      statusActions.close();
      if (lostFocus && doc.activeElement === doc.body) input.focus({preventScroll:true});
      recovery.open = false;
      recovery.hidden = true;
      empty.textContent = readError;
      render();
      throw error;
    });
    if (!tables || current !== generation) return;
    recordReadable = true;
    const ids = [...new Set([...tables.watched, ...tables.lists.filter(row => dropMembership(row.list) === 'dropped')].map(row => row.show_id))];
    const reuse = preview && revision === preview.stamp.revision && history?.generation === historyGeneration;
    readingFirstCache = !reuse && !cache && ids.length > 0;
    categoryHeaders = undefined;
    const now = service.environment.now();
    let result = overviewWithCache(tables, ids, now, cache);
    let malEntries: Map<number, MalEntry[]> | undefined;
    if (!reuse) showRecord(result);
    // IMDb and the category filter use the same title headers. Share this refresh's
    // read on large records; missing or expired identities still use the normal fallback.
    let publishHeaders: ((headers:ImdbHeaders | undefined)=>void) | undefined;
    const imdbHeaders = ctx.imdb && ids.length >= 16 ? new Promise<ImdbHeaders | undefined>(resolve=>{ publishHeaders = resolve; }) : undefined;
    const readHeaders = imdbHeaders ? async () => {
      const headers = await imdbHeaders;
      signal.throwIfAborted();
      return headers;
    } : undefined;
    const metadata = readOverviewCache(service, tables, ids, now, headers => {
      publishHeaders?.(headers);
      if (current !== generation || !readingFirstCache) return;
      // Countries and keywords need only a show header. Watch status still uses the full season projection.
      categoryHeaders = headers;
      if (state.category === 'all') categoryCounts(state.dropped ? dropped : watched);
      else render();
    }, signal).then(value => {
      publishHeaders?.(value.details);
      settled = true;
      if (current !== generation) return;
      readingFirstCache = false;
      categoryHeaders = undefined;
      result = overviewWithCache(tables, ids, now, value);
      if (malEntries) malRatings = malScoresForShows(malEntries, result.shows);
      cache = value;
      showRecord(result);
      // The sort transaction was admitted first. Equal revisions on both sides identify the same
      // account and watch rows even when an unrelated settings transaction makes either proof late.
      if (!value.readable) history?.clear();
      else if (verified) void Promise.all([initialSort,verified]).then(() => {
        if (current === generation && visitStamp && visitStamp.revision === revision)
          history?.save(historyGeneration,visitStamp,result,value,now);
      },() => {});
    }).catch(() => {
      publishHeaders?.(undefined);
      settled = true;
      if (current !== generation) return;
      readingFirstCache = false;
      categoryHeaders = undefined;
      history?.clear();
      if (preview) showRecord(overviewWithCache(tables,ids,now));
      else render();
    });
    async function criticScores() {
      const key = await ctx.critics?.displaySource(signal).catch(() => null);
      if (key === null || current !== generation) return;
      const enabled = !!key?.configured;
      const github = key?.malSource === 'github';
      const malEnabled = enabled || github;
      const keyChanged = criticConfig?.generation !== key?.generation || hasCriticKey !== enabled;
      const malChanged = keyChanged || criticConfig?.malSource !== key?.malSource;
      if (keyChanged) scores = new Map();
      if (malChanged) malRatings = new Map();
      criticConfig = key;
      hasCriticKey = enabled;
      hasMalScores = malEnabled;
      const mdbSort = () => state.sort === 'tomatoes' || state.sort === 'metacritic' || !github && state.sort === 'myanimelist';
      if (keyChanged || malChanged) render();
      await Promise.all([
        enabled ? ctx.critics?.read(ids).catch(() => undefined).then(next => {
          if (current !== generation) return;
          scores = next ?? new Map();
          if (mdbSort()) render();
        }) : undefined,
        github ? ctx.mal?.read(ids).catch(() => undefined).then(next => {
          if (current !== generation) return;
          malEntries = next;
          malRatings = malScoresForShows(next, result.shows);
          if (state.sort === 'myanimelist') render();
        }) : undefined,
      ]);
    }
    async function imdbScores() {
      const source = await ctx.imdb?.sourceStatus().catch(() => null);
      if (source === null || current !== generation) return;
      const enabled = !!source && source.source !== 'none';
      const changed = imdbConfig?.source !== source?.source || imdbConfig?.generation !== source?.generation;
      if (changed) imdbRatings = new Map();
      imdbConfig = source;
      hasImdbSource = enabled;
      if (changed) render();
      if (!enabled) return;
      const next = await ctx.imdb?.readShows(ids,undefined,readHeaders).catch(() => undefined);
      if (current !== generation) return;
      imdbRatings = next ?? new Map();
      if (state.sort === 'imdb') render();
    }
    const enrich = Promise.all([metadata, criticScores(), imdbScores()]).then(async () => {
      if (position && current === generation) {
        await initialSort;
        if (current === generation) { restorePosition(); stopRestoring(); }
      }
    });
    if (waitForCache) await enrich;
    else void ctx.run(() => enrich);
  }
  desktopPicker.addEventListener('change',render);
  render();
  const readSort = () => preference.read(stamp => { visitStamp = stamp; });
  const initialSort = readSort();
  const firstRefresh = refresh(false, history?.available ? initialSort : undefined);
  return { ready: Promise.all([firstRefresh,initialSort]).then(() => {}), refresh,
    dispose() { disposed = true; generation++; stopRestoring(); metadataRead?.abort(); statusActions.close(); desktopPicker.removeEventListener('change',render); preference.dispose(); } };
}
