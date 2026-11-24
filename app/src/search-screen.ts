import { readDisplayRatings, type ShowRatings } from './critic-marks.ts';
import { createSearchResult } from './search-result.ts';
import { selectShowMalScores } from './mal-file.ts';
import { openMembershipSheet } from './personal-sheets.ts';
import { localCalendarDate, watchProgress, type ShowInfo } from './progress.ts';
import type { Screen, ScreenContext } from './screen-context.ts';
import { regularSeasonsCached, type TmdbTitle } from './tmdb-data.ts';
import type { MetadataView } from './tmdb-service.ts';
import { renderTmdbState } from './tmdb-settings.ts';
import { watchEditRunner } from './notices.ts';

const layout = `<div class="search-screen"><header class="screen-heading"><h1>Search</h1><form role="search">
  <label class="tv-search-field"><span class="search-glass" aria-hidden="true"></span>
  <span class="visually-hidden">Search for a show</span><input type="search" placeholder="Search for a show"
    enterkeyhint="search" autocomplete="off"></label></form></header>
  <header class="tv-section-head"><h2>Results</h2><span>From TMDB</span></header>
  <ul class="tv-results" aria-label="Search results"></ul><div data-state></div>
  <button type="button" class="next-results" hidden>Load more results</button></div>`;

export function mountSearchScreen(root: HTMLElement, ctx: ScreenContext, initialQuery = ''): Screen {
  const { service } = ctx;
  const doc = root.ownerDocument;
  root.innerHTML = layout;
  const field = root.querySelector('input')!;
  const list = root.querySelector('ul')!;
  const state = root.querySelector<HTMLElement>('[data-state]')!;
  const nextButton = root.querySelector<HTMLButtonElement>('.next-results')!;
  field.defaultValue = initialQuery;
  let query = field.value.trim();
  let titles: TmdbTitle[] = [];
  let page = 0;
  let totalPages = 0;
  let revision = 0, renderVersion = 0, sourceVersion = 0;
  let fetching = false, disposed = false;
  let composing = false;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let observer: IntersectionObserver | undefined;
  let lastStatus: MetadataView<'search'>['status'] = 'empty';
  let keyGeneration: bigint | undefined;
  let attemptAccess: string | undefined;
  let criticSource = '';
  let criticReady = false;
  let imdbSource = '';
  let imdbSelected = false;
  const busy = new Set<number>();
  const edits = watchEditRunner(ctx);
  const rows = new Map<number, ReturnType<typeof createSearchResult>>();
  const scoreShows = new Map<number, Pick<ShowInfo,'show_id'|'seasons'|'broadcastOrder'|'manualSeasonOrder'|'lastAired'|'nextEpisode'> | null | undefined>();
  let completedVersion = -1;
  let readingResults: AbortController | undefined;
  let completedContext = '';
  let previousRatings: ShowRatings | undefined;
  let closeSheet: (() => void) | undefined;

  function status(value: MetadataView<'search'>['status'] | 'loading', message?: string) {
    renderTmdbState(state, value, {
      onSettings: () => ctx.go({ page: 'settings' }),
      canAccessKeys: ctx.canAccessKeys,
      onRetry: () => void ctx.run(() => load(page + 1)),
      emptyMessage: value === 'empty' ? message : undefined,
      unavailableMessage: value === 'unavailable' ? message : undefined,
    });
  }

  function retryMessage(retryAt:number) {
    // Display the first eligible whole second, including the date for a later local day.
    const deadline = new Date(Math.ceil(retryAt / 1000) * 1000);
    if (!Number.isFinite(deadline.getTime())) return undefined;
    const today = new Date(service.environment.now());
    const dateStyle = localCalendarDate(deadline) === localCalendarDate(today) ? undefined : 'medium';
    return 'TMDB paused lookups until ' + deadline.toLocaleString(undefined,{dateStyle,timeStyle:'medium'}) + '.';
  }

  function pagination() {
    observer?.disconnect();
    nextButton.hidden = page === 0 || page >= totalPages || lastStatus !== 'ready' || (fetching && doc.activeElement !== nextButton);
    nextButton.setAttribute('aria-disabled',String(fetching));
    if (!fetching && !nextButton.hidden && doc.defaultView?.IntersectionObserver) {
      observer = new doc.defaultView.IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting)) void ctx.run(() => load(page + 1));
      });
      observer.observe(nextButton);
    }
  }

  function clearRows() {
    if (list.contains(doc.activeElement)) field.focus({preventScroll:true});
    rows.clear();
    scoreShows.clear();
    previousRatings = undefined;
    list.replaceChildren();
  }

  function editResult(id: number, action: 'watches' | 'dropped', button: HTMLButtonElement, edit: () => Promise<unknown>) {
    if (busy.has(id) || !list.contains(button) || service.store.role !== 'writer') return;
    const search = revision;
    void edits.run(id + '/' + action,async () => {
      if (disposed || search !== revision || !list.contains(button) || busy.has(id) || service.store.role !== 'writer') return;
      busy.add(id);
      rows.get(id)?.setBusy(true);
      try { await edit(); }
      finally {
        // If the edit committed, retrying an unavailable local read must only redraw the results.
        try { if (!disposed && page > 0) await ctx.run(() => drawRows()); }
        finally {
          busy.delete(id);
          rows.get(id)?.setBusy(false);
        }
      }
    });
  }

  function rowFor(t: TmdbTitle) {
    const id = t.show_id;
    let result = rows.get(id);
    if (!result) {
      result = createSearchResult(doc,t,{
        open: () => ctx.go({page:'show',id}),
        mark(button,action) {
          editResult(id,'watches',button,() => ctx.watch.bulk(id,{},action));
        },
        setDropped(button,title,dropped) {
          editResult(id,'dropped',button,() => ctx.watch.setDropped({show_id:id,show:title.show},dropped,
            () => !disposed && list.contains(button)));
        },
        lists(title) {
          closeSheet?.();
          closeSheet = openMembershipSheet(root,ctx,title,() =>
            list.querySelector<HTMLElement>('[data-show="' + id + '"] .result-list:not(:disabled)') ?? field);
        },
      });
      rows.set(id,result);
    }
    return result;
  }

  function placeRows(results: readonly TmdbTitle[]) {
    const focused = list.contains(doc.activeElement) ? doc.activeElement as HTMLElement : null;
    const wanted = new Set(results.map(t=>t.show_id));
    for (const [id,result] of rows) {
      if (wanted.has(id)) continue;
      result.row.remove();
      rows.delete(id);
      scoreShows.delete(id);
    }
    let position = list.firstElementChild;
    for (const t of results) {
      const {row} = rowFor(t);
      if (position !== row) list.insertBefore(row,position);
      position = row.nextElementSibling;
    }
    if (focused && doc.activeElement === doc.body) {
      (focused.isConnected ? focused : field).focus({preventScroll:true});
    }
  }

  function progressContext(today: string) {
    return [today,service.store.role,service.environment.online()].join('/');
  }

  async function drawRows(revealTitles = false, appendFrom = 0): Promise<void> {
    // A refresh already in flight may have fresher watches or metadata for the earlier pages.
    const todayAtStart = localCalendarDate(new Date(service.environment.now()));
    const first = completedVersion === renderVersion && progressContext(todayAtStart) === completedContext ? appendFrom : 0;
    const version = ++renderVersion;
    readingResults?.abort();
    const controller = readingResults = new AbortController();
    const results = [...titles];
    const changed = results.slice(first);
    const ids = results.map(t => t.show_id);
    const header = Promise.all([service.read({kind:'configuration'}).catch(() => null),service.keyStatus()]).then(([config,key]) => {
      if (revealTitles && !disposed && version === renderVersion && key.status === 'ready' && key.generation === keyGeneration) {
        // Titles can be opened as soon as the search returns. Personal actions wait for the committed record.
        for (const t of changed) rowFor(t).previewTitle(t,config?.value ?? null);
        placeRows(results);
      }
      return {config,key};
    });
    const ratings = readDisplayRatings(ctx,ids,previousRatings,{signal:controller.signal});
    const changedIds = ids.slice(first);
    const data = await Promise.all([
      header,service.store.searchRecords(changedIds,controller.signal),
      Promise.all(changedIds.map(async id => {
        const entry = await service.read({kind:'show',id},controller.signal);
        const detail = entry?.value && await service.showInfo(id,entry,controller.signal);
        return {detail,header:entry?.value};
      })),
    ]).catch(error => { if (!controller.signal.aborted) throw error; });
    if (!data || disposed || version !== renderVersion) return;
    const [{config,key},records,info] = data;
    if (key.status !== 'ready' || key.generation !== keyGeneration) { await refresh(); return; }
    const today = localCalendarDate(new Date(service.environment.now()));
    const context = progressContext(today);
    if (first && context !== completedContext) return drawRows(revealTitles);
    const writable = service.store.role === 'writer';
    placeRows(results);
    for (const [index,t] of changed.entries()) {
      const {detail,header} = info[index], result = rowFor(t);
      // Score lookup uses the season index and effective next airing, without retaining episode lists.
      scoreShows.set(t.show_id,header && detail ? {
        show_id:header.show_id,seasons:header.seasons,broadcastOrder:header.broadcastOrder,
        manualSeasonOrder:header.manualSeasonOrder,lastAired:header.lastAired,nextEpisode:detail.nextEpisode,
      } : header);
      const {watched,dropped} = records[index];
      const progress = watchProgress(t.show_id,watched,[],detail ?? null,today);
      const canMark = detail ? progress.aired > 0 :
        header !== null && !progress.recordedEpisodes && t.firstAirDate !== null && t.firstAirDate <= today;
      result.update(t,config?.value ?? null,progress,canMark && writable &&
        (service.environment.online() || regularSeasonsCached(detail)),dropped,busy.has(t.show_id),writable);
    }
    completedVersion = version;
    completedContext = context;
    ratings.render(scores => {
      if (disposed || version !== renderVersion) return;
      // A superseded provider read can still settle in its own copy.
      previousRatings = {...scores};
      for (const id of ids) {
        const mal = selectShowMalScores(scores.mal?.get(id),scoreShows.get(id)).score;
        rows.get(id)!.updateRatings(scores.critics?.get(id),scores.imdb?.get(id),mal);
      }
    });
  }

  function searchAccess() {
    return [keyGeneration, service.store.role, service.environment.online()].join('/');
  }

  async function load(next: number) {
    if (disposed || !query || fetching || next !== page + 1) return;
    const active = revision;
    const previousCount = titles.length;
    attemptAccess = searchAccess();
    fetching = true;
    pagination();
    status('loading');
    let beforePage: number | undefined;
    try {
      const reply = await service.search(query,next,() => !disposed && active === revision);
      if (disposed || active !== revision) return;
      lastStatus = reply.status;
      if (reply.value) {
        beforePage = titles.length;
        const ids = new Set(titles.map(t => t.show_id));
        const pageIds: number[] = [];
        for (const t of reply.value.results) {
          if (ids.has(t.show_id)) continue;
          ids.add(t.show_id);
          titles.push(t);
          pageIds.push(t.show_id);
        }
        await drawRows(true,beforePage);
        if (disposed || active !== revision) return;
        beforePage = undefined;
        page = next;
        totalPages = Math.min(500, reply.value.totalPages);
        if (page > 1 && lastStatus === 'empty') lastStatus = 'ready';
        // Keep pagination and the visible controls usable while the optional provider is busy.
        const critics = ctx.critics;
        if (critics && criticReady && pageIds.length) void ctx.run(() => critics.refresh(pageIds));
        const imdb = ctx.imdb;
        if (imdb && imdbSelected && pageIds.length) void ctx.run(() => imdb.refreshShows(pageIds));
      }
      if (next === 1 && !reply.value) clearRows();
      status(lastStatus, reply.retryAt !== undefined ? retryMessage(reply.retryAt) :
        lastStatus === 'empty' ? 'No shows found.' : undefined);
    } catch {
      if (!disposed && active === revision) {
        if (beforePage !== undefined) {
          renderVersion++;
          titles.length = beforePage;
          if (next > 1) placeRows(titles);
        }
        if (next === 1) clearRows();
        lastStatus = 'unavailable';
        status(lastStatus, beforePage === undefined ? undefined : 'Could not display these results on this device.');
      }
    } finally {
      if (!disposed && active === revision) {
        const focusedMore = doc.activeElement === nextButton;
        fetching = false;
        pagination();
        if (focusedMore) {
          const firstAdded = list.children[previousCount]?.querySelector('a');
          if (firstAdded) firstAdded.focus();
          else if (nextButton.hidden) (state.querySelector<HTMLElement>('button,a[href]') ?? list.lastElementChild?.querySelector('a') ?? field).focus();
        }
        if (shouldResumePage()) void ctx.run(() => load(next));
      }
    }
  }

  function shouldResumePage() {
    const failed = lastStatus === 'offline' || lastStatus === 'unavailable' || lastStatus === 'read-only';
    return failed && (page === 0 || page < totalPages) && attemptAccess !== searchAccess() &&
      service.store.role === 'writer' && service.environment.online();
  }

  function reset(keepResults = false) {
    edits.retire();
    readingResults?.abort();
    closeSheet?.();
    revision++;
    renderVersion++;
    clearTimeout(debounce);
    debounce = undefined;
    fetching = false;
    attemptAccess = undefined;
    titles = [];
    page = totalPages = 0;
    query = field.value.trim();
    if (!query || !keepResults) clearRows();
    pagination();
  }

  async function refresh() {
    if (disposed || composing) return;
    const active = revision;
    const key = await service.keyStatus();
    if (disposed || active !== revision) return;
    const changed = keyGeneration !== undefined && keyGeneration !== key.generation;
    keyGeneration = key.generation;
    if (changed || key.status !== 'ready') reset();
    if (key.status !== 'ready') { status(key.status); return; }
    if (!query) { status('empty', 'Enter a show title to search.'); return; }
    const sourceRead = ++sourceVersion, sourceQuery = revision;
    const current = () => !disposed && sourceQuery === revision && sourceRead === sourceVersion;
    const critics = ctx.critics, imdb = ctx.imdb;
    if (critics) void ctx.run(async () => {
      const key = await critics.keyStatus().catch(() => undefined);
      if (!current()) return;
      criticReady = key?.status === 'ready';
      const nextSource = key ? [key.generation, key.status, service.store.role, service.environment.online()].join('/') : '';
      const changed = nextSource !== criticSource;
      criticSource = nextSource;
      if (changed && criticReady && page > 0) await critics.refresh(titles.map(t => t.show_id));
    });
    if (imdb) void ctx.run(async () => {
      const state = await imdb.sourceStatus().catch(() => undefined);
      if (!current()) return;
      imdbSelected = !!state && state.source !== 'none';
      const nextSource = state ? [state.generation, state.refused, state.retryAt, service.store.role, service.environment.online()].join('/') : '';
      const changed = nextSource !== imdbSource;
      imdbSource = nextSource;
      if (changed && imdbSelected && page > 0) await imdb.refreshShows(titles.map(t => t.show_id));
    });
    if ((fetching || page > 0) && (service.store.role !== 'writer' || !service.environment.online())) attemptAccess = searchAccess();
    if (page > 0) {
      if (shouldResumePage()) {
        await load(page + 1);
      } else await drawRows();
      return;
    }
    if (debounce === undefined && attemptAccess !== searchAccess()) await load(1);
  }

  const onInput = () => {
    if (disposed || composing) return;
    reset(true);
    ctx.searchQuery(field.value);
    status('ready');
    if (!query) { void ctx.run(refresh); return; }
    debounce = setTimeout(() => { debounce = undefined; void ctx.run(refresh); }, 500);
  };
  field.oninput = onInput;
  field.addEventListener('compositionstart', () => { composing = true; reset(true); });
  field.addEventListener('compositionend', () => { composing = false; onInput(); });
  root.querySelector('form')!.onsubmit = event => {
    event.preventDefault();
    if (composing) return;
    clearTimeout(debounce);
    debounce = undefined;
    if (!fetching) attemptAccess = undefined;
    void ctx.run(refresh);
  };
  nextButton.onclick = () => void ctx.run(() => load(page + 1));
  field.focus();
  return { ready: refresh(), refresh, dispose() {
    disposed = true;
    readingResults?.abort();
    revision++;
    renderVersion++;
    clearTimeout(debounce);
    observer?.disconnect();
    closeSheet?.();
  } };
}
