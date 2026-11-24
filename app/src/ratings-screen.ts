import { compareTitles } from './record-overview.ts';
import { libraryCategories, matchesLibraryCategory, type LibraryCategory } from './anime.ts';
import { observation } from './episode-repair.ts';
import type { WatchedRow } from './model.ts';
import { poster } from './poster.ts';
import { localCalendarDate, watchProgress } from './progress.ts';
import { searchText } from './title-search.ts';
import { tmdbResourceKey } from './tmdb-client.ts';
import { withSeasonDetails, type TmdbConfiguration, type TmdbSeason, type TmdbShow } from './tmdb-data.ts';
import { dropMembership } from './upcoming-preference.ts';
import type { Screen, ScreenContext } from './screen-context.ts';
import type { RatingRecordIdentity } from './storage.ts';
import { choiceControl, rememberSort } from './view-select.ts';
import { compareShowOrder, isShowSort, showSortOptions, type ShowSort } from './show-sort.ts';
interface RatedShow {
  id:number; title:string; knownTitle:string; year:number|null; rating:number; plays:bigint; status:string; posterPath:string|null;
  lists:string[]; metadata:Pick<TmdbShow,'originCountries'|'keywords'>|null;
}

function recordedStatus(count: number) {
  return count ? count.toLocaleString() + (count === 1 ? ' episode' : ' episodes') : 'Not watched';
}

export function compareRatings(a: RatedShow, b: RatedShow, sort: ShowSort) {
  return compareShowOrder(a,b,sort,compareTitles);
}

export function mountRatingsScreen(root: HTMLElement, ctx: ScreenContext): Screen {
  const doc = root.ownerDocument, store = ctx.service.store;
  root.innerHTML = '<section class="ratings-screen"><header class="ratings-header">' +
    '<div class="ratings-heading"><h1>Ratings</h1><span class="ratings-total"></span></div>' +
    '<label class="tv-search-field"><input type="search" aria-label="Search your ratings" placeholder="Search ratings"></label>' +
    '<div class="ratings-tools"></div></header><p class="tv-empty"></p>' +
    '<ul class="ratings-rows" aria-label="Rated shows"></ul></section>';
  const input = root.querySelector('input')!, tools = root.querySelector<HTMLElement>('.ratings-tools')!;
  const tally = root.querySelector<HTMLElement>('.ratings-total')!, empty = root.querySelector<HTMLElement>('.tv-empty')!, list = root.querySelector('ul')!;
  let rows: RatedShow[] = [], sort: ShowSort = 'high', version = 0, closed = false, loaded = false;
  let category: LibraryCategory = 'all';
  let config: TmdbConfiguration | null = null, posterSizes = '';
  let reading: Promise<void> | undefined;
  const reads = new AbortController();
  let metadataVersion = 0, readingCategories = false;
  let needsOverview = true;
  let ratingTitles = new Map<number,string>();
  let record: RatingRecordIdentity;
  const pending = new Map<number,Promise<boolean>>();
  const elements = new Map<number,ReturnType<typeof makeRow>>();
  const waitingStatus = new Map<number,{row:RatedShow; header:TmdbShow; observedAt:number; watched:WatchedRow[]}>();
  // Only rows near the viewport need the potentially large cached episode lists.
  const Observer = doc.defaultView?.IntersectionObserver;
  const visibility = Observer && new Observer(entries => {
    const ids = entries.filter(entry => entry.isIntersecting).map(entry => Number((entry.target as HTMLElement).dataset.showId));
    if (ids.length) void ctx.run(() => readStatuses(ids));
  }, {rootMargin:'250px 0px'});

  async function readStatuses(ids: number[]) {
    const generation = metadataVersion, current = () => !closed && generation === metadataVersion;
    const batch = ids.flatMap(id => {
      const data = waitingStatus.get(id);
      if (!data) return [];
      waitingStatus.delete(id);
      const item = elements.get(id)?.item;
      if (item) visibility?.unobserve(item);
      return [data];
    });
    if (!batch.length) return;
    while (pending.size && current()) await Promise.allSettled(pending.values());
    if (!current()) return;
    const now = ctx.service.environment.now(), today = localCalendarDate(new Date(now));
    const keys = batch.flatMap(({row,header}) => header.seasons.filter(s => s.season > 0)
      .map(s => tmdbResourceKey({kind:'season',id:row.id,season:s.season})));
    const details = keys.length ? await store.tmdbEntries<TmdbSeason|null>(keys,now,reads.signal).catch(() => undefined) : [];
    if (!current() || !details) return;
    const seasons = new Map(keys.map((key,i) => [key,details[i]]));
    for (const {row,header,observedAt,watched} of batch) {
      const local = header.seasons.map(s => seasons.get(tmdbResourceKey({kind:'season',id:row.id,season:s.season})));
      const show = withSeasonDetails(header,(_,i) => local[i]?.value,(_,i) => !!local[i] && observation(local[i]).at < observedAt);
      const progress = watchProgress(row.id,watched,[],show,today);
      const status = progress.complete ? 'Completed' : progress.aired
        ? progress.watchedAired.toLocaleString() + ' of ' + progress.aired.toLocaleString() : recordedStatus(watched.length);
      if (row.status !== status) { row.status = status; elements.get(row.id)?.updateCaption(row); }
    }
  }
  const preference = rememberSort(ctx,'ratingsSort','high',isShowSort,value => { sort = value; render(false); });
  const sorting = choiceControl(doc,'Sort',value => { if (isShowSort(value)) preference.choose(value); });
  const categoryChoice = choiceControl(doc,'Category',value => {
    if (Object.hasOwn(libraryCategories,value)) { category = value as LibraryCategory; render(false); }
  });
  categoryChoice.display(Object.entries(libraryCategories).map(([value,label]) => ({value,label})),category);
  tools.append(categoryChoice.root,sorting.root);
  function visible() {
    const query = searchText(input.value.trim());
    return rows.filter(show => matchesLibraryCategory(show,category) && (!query || searchText(show.title).includes(query)))
      .sort((a,b) => compareRatings(a,b,sort));
  }
  input.oninput = () => render(false);

  function makeRow(id:number) {
    const item = doc.createElement('li'), link = doc.createElement('a');
    item.dataset.showId = String(id);
    link.href = '#/show/' + id;
    link.onclick = e => {
      if (e.button || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      e.preventDefault(); ctx.go({page:'show', id});
    };
    let artwork: HTMLElement = doc.createElement('span'), lastArtwork: string | undefined;
    const copy = doc.createElement('span'), title = doc.createElement('strong'), details = doc.createElement('small');
    copy.className = 'rating-show-copy';
    copy.append(title,details);
    link.append(artwork,copy);
    const score = doc.createElement('select'); score.className = 'rating-edit';
    const editor = doc.createElement('span'); editor.className = 'rating-editor'; editor.append(score);
    let shown: RatedShow, openedAt: {rating:number;record:RatingRecordIdentity} | undefined, selection = 0;
    // Most rows are only read. Build the native menu on first use, before it opens.
    const prepare = () => {
      openedAt = {rating:shown.rating,record};
      if (score.options.length > 1) return;
      score.replaceChildren(...Array.from({length:21},(_,i) => new Option(i / 2 + '/10',String(i / 2))),
        new Option('Remove rating','remove'));
      score.value = String(shown.rating);
    };
    // A themed select moves focus into its options. Keep the rating that was on
    // screen when it opened, even if a sync arrives before an option is chosen.
    score.onfocus = event => { if (!score.contains(event.relatedTarget as Node | null)) prepare(); };
    score.onpointerdown = event => { if (event.target === score) prepare(); };
    score.addEventListener('focusout',event => { if (!score.contains(event.relatedTarget as Node | null)) openedAt = undefined; });
    score.onkeydown = event => {
      if ((event.key !== 'ArrowUp' && event.key !== 'ArrowDown') || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
        getComputedStyle(score).appearance !== 'base-select' || score.matches(':open')) return;
      // Preserve the closed editor's one-key half-step. Space or Enter opens the picker.
      event.preventDefault();
      const next = score.selectedIndex + (event.key === 'ArrowUp' ? -1 : 1);
      if (next < 0 || next >= score.options.length) return;
      score.selectedIndex = next;
      score.dispatchEvent(new Event('change',{bubbles:true}));
    };
    score.onchange = () => {
      if (pending.has(id) || closed || store.role !== 'writer') return;
      if (score.selectedIndex < 0) {
        score.value = String(shown.rating);
        return;
      }
      const value = score.value === 'remove' ? null : Number(score.value);
      const expected = openedAt ?? {rating:shown.rating,record};
      openedAt = undefined;
      const show = {show_id:id,show:shown.knownTitle}, ticket = ++selection;
      void ctx.run(async () => {
        // The notification's Retry is a new admission of this exact choice.
        if (closed || ticket !== selection || !item.isConnected || pending.has(id) || store.role !== 'writer') return;
        const restoreFocus = doc.activeElement === score;
        const neighbor = item.nextElementSibling?.querySelector('select') ?? item.previousElementSibling?.querySelector('select');
        score.disabled = true; score.setAttribute('aria-busy','true');
        const saving = ctx.watch.setRating(show,value,expected.rating,expected.record);
        pending.set(id,saving);
        try { await saving; }
        finally {
          pending.delete(id); score.removeAttribute('aria-busy');
          // Report the write outcome immediately, even if its visual refresh is slow.
          if (!closed) void ctx.run(async () => {
            await (reading ?? refreshRatings());
            if (restoreFocus && !closed && doc.activeElement === doc.body) {
              const surviving = elements.get(id)?.score;
              (surviving && !surviving.disabled ? surviving : neighbor?.isConnected ? neighbor : input).focus({preventScroll:true});
            }
          });
        }
      });
    };
    item.append(link,editor);
    function updateCaption(show: RatedShow) {
      const plays = show.plays.toLocaleString() + (show.plays === 1n ? ' play' : ' plays');
      const caption = (show.year === null ? '' : show.year + ' · ') + plays + ' · ' + show.status;
      if (details.textContent !== caption) details.textContent = caption;
    }
    return {item,score,updateCaption,update(show:RatedShow) {
      shown = show;
      // Keep the loaded image in place while the score changes or the list reorders.
      const nextArtwork = (show.posterPath ?? '') + '|' + posterSizes;
      if (nextArtwork !== lastArtwork) {
        const next = poster(doc,show,config);
        artwork.replaceWith(next); artwork = next; lastArtwork = nextArtwork;
      }
      if (title.textContent !== show.title) title.textContent = show.title;
      updateCaption(show);
      const label = 'Rating for ' + show.title + ' out of 10';
      if (score.getAttribute('aria-label') !== label) score.setAttribute('aria-label',label);
      score.disabled = store.role !== 'writer' || pending.has(id);
      if (!pending.has(id)) {
        const value = String(show.rating);
        if (score.options.length < 2 && score.options[0]?.value !== value) score.replaceChildren(new Option(value + '/10',value));
        score.value = value;
      }
    }};
  }

  function render(updateRows = true) {
    const showing = visible();
    sorting.display(showSortOptions,sort);
    const waiting = !loaded || (readingCategories && rows.length > 0 && category !== 'all' && !showing.length);
    tally.textContent = waiting ? '' : showing.length.toLocaleString() + (showing.length === 1 ? ' show' : ' shows');
    empty.textContent = waiting ? 'Loading…' : !rows.length ? 'Shows you rate will appear here.' : !showing.length ? 'No matching ratings.' : '';
    empty.hidden = !empty.textContent;
    const focus = doc.activeElement instanceof HTMLElement && list.contains(doc.activeElement) ? doc.activeElement : null;
    const nextFocus = focus?.closest('li')?.nextElementSibling?.querySelector('select') ?? focus?.closest('li')?.previousElementSibling?.querySelector('select');
    const keep = new Set(showing.map(s => s.id));
    // Filtering can hide hundreds of editors for a single keystroke. Keep each editor
    // until the rating is actually removed, and update its data even while detached.
    if (updateRows) for (const show of rows) elements.get(show.id)?.update(show);
    for (const [id,row] of elements) if (!keep.has(id)) {
      row.item.remove();
      if (!ratingTitles.has(id)) {
        visibility?.unobserve(row.item);
        waitingStatus.delete(id);
        elements.delete(id);
      }
    }
    let position = list.firstElementChild;
    for (const show of showing) {
      let row = elements.get(show.id);
      if (!row) {
        row = makeRow(show.id);
        row.update(show);
        elements.set(show.id,row);
        if (waitingStatus.has(show.id)) visibility?.observe(row.item);
      }
      if (row.item !== position) list.insertBefore(row.item,position);
      position = row.item.nextElementSibling;
    }
    if (focus && !list.contains(doc.activeElement)) {
      (focus.isConnected ? focus : nextFocus?.isConnected ? nextFocus : input).focus({preventScroll:true});
    }
    return showing;
  }
  async function readRecord(request: number) {
    const tables = await store.overviewRows('ratings',reads.signal);
    if (closed || version !== request) return;
    record = tables.record;
    const now = ctx.service.environment.now();
    const totals = new Map<number,bigint>(), titles = new Map<number,string>();
    const watched = new Map<number,WatchedRow[]>(tables.ratings.map(row => [row.show_id,[]]));
    const lists = new Map<number,string[]>();
    for (const row of tables.lists) {
      if (!watched.has(row.show_id)) continue;
      const group = lists.get(row.show_id);
      if (group) group.push(row.list); else lists.set(row.show_id,[row.list]);
    }
    for (const row of tables.watched) {
      const group = watched.get(row.show_id);
      if (!group) continue;
      group.push(row);
      totals.set(row.show_id,(totals.get(row.show_id) ?? 0n) + BigInt(row.times_watched));
      if (row.show && !titles.has(row.show_id)) titles.set(row.show_id,row.show);
    }
    const shows = new Map(tables.shows.map(show => [show.show_id,show]));
    const listTitles = new Map(tables.lists.filter(row => row.show).map(row => [row.show_id,row.show]));
    ratingTitles = new Map(tables.ratings.map(row => [row.show_id,row.show]));
    const previous = new Map(rows.map(show => [show.id,show]));
    rows = tables.ratings.map(row => {
      const id = row.show_id, description = shows.get(id), held = previous.get(id);
      const savedTitle = titles.get(id) || row.show || listTitles.get(id) || description?.show || '';
      titles.set(id,savedTitle);
      const knownTitle = savedTitle || held?.knownTitle || '';
      const count = watched.get(id)!.length;
      const plays = totals.get(id) ?? 0n;
      const memberships = lists.get(id) ?? [];
      const dropped = memberships.some(name => dropMembership(name) === 'dropped');
      const status = dropped ? 'Dropped' : held && held.status !== 'Dropped' && held.plays === plays ? held.status : recordedStatus(count);
      return {id,knownTitle,title:knownTitle || 'Show ' + id,
        year:held?.year ?? description?.year ?? null,
        plays,rating:row.rating,status,lists:memberships,metadata:held?.metadata ?? null,
        posterPath:held?.posterPath ?? null};
    });
    loaded = true;
    readingCategories = rows.length > 0;
    const priority = render().slice(0,8);
    if (!rows.length) return;
    const generation = metadataVersion;
    void ctx.run(async () => {
      const queue = rows;
      const current = () => !closed && generation === metadataVersion;
      const configuration = await store.tmdbEntries<TmdbConfiguration|null>(['configuration'],now,reads.signal).catch(() => []);
      if (!current()) return;
      config = configuration[0]?.value ?? null;
      const sizes = config ? [config.secureBaseUrl,...config.posterSizes].join('|') : '';
      const configurationChanged = posterSizes !== sizes;
      posterSizes = sizes;
      // Paint the visible titles first, then keep consecutive IDs together for the
      // cache index. An already displayed title can sit between two remaining IDs.
      const batches = priority.length ? [priority] : [];
      const scheduled = new Set<number>();
      const painted = new Set(priority), firstOther = queue.findIndex(row => !painted.has(row));
      if (firstOther >= 0) {
        for (let i=firstOther; i<queue.length; i+=32) batches.push(queue.slice(i,i+32));
      }
      for (const batch of batches) {
        while (pending.size && current()) await Promise.allSettled(pending.values());
        if (!current()) return;
        const keys = batch.map(row=>tmdbResourceKey({kind:'show',id:row.id}));
        const metadata = await store.tmdbEntries<TmdbShow|null>(keys,now,reads.signal).catch(()=>[]);
        if (!current()) return;
        let visibilityChanged = false;
        for (const [index,row] of batch.entries()) {
          if (!ratingTitles.has(row.id)) continue;
          const header = metadata[index], cached = header?.value;
          let status = row.status;
          if (row.status !== 'Dropped' && !scheduled.has(row.id)) {
            scheduled.add(row.id);
            if (header && cached?.seasons) {
              waitingStatus.set(row.id,{row,header:cached,observedAt:observation(header).at,watched:watched.get(row.id)!});
              const item = elements.get(row.id)?.item;
              if (item) visibility?.observe(item);
            } else status = recordedStatus(watched.get(row.id)!.length);
          }
          const knownTitle = titles.get(row.id) || cached?.show || '';
          const title = knownTitle || 'Show ' + row.id;
          const year = cached?.firstAirDate ? Number(cached.firstAirDate.slice(0,4)) : shows.get(row.id)?.year ?? null;
          const posterPath = cached?.posterPath ?? null;
          const included = matchesLibraryCategory(row,category);
          row.metadata = cached ? {keywords:cached.keywords,originCountries:cached.originCountries} : null;
          visibilityChanged ||= row.title !== title || included !== matchesLibraryCategory(row,category);
          if (configurationChanged || row.knownTitle !== knownTitle || row.year !== year || row.posterPath !== posterPath || row.status !== status) {
            Object.assign(row,{title,knownTitle,year,posterPath,status});
            elements.get(row.id)?.update(row);
          }
        }
        // Newly identified shows can move in title order or enter the selected category.
        if (visibilityChanged) render(false);
        if (!visibility) await readStatuses(batch.map(row => row.id));
      }
      if (current()) {
        readingCategories = false;
        if (category !== 'all' && !list.childElementCount) render(false);
      }
    });
  }
  async function readPending() {
    try {
      let request;
      do {
        request = version;
        if (loaded && !needsOverview) {
          const ratings = await store.ratingRows();
          if (closed || version !== request) continue;
          // Score edits and removals preserve a show's title, artwork and play
          // total. A new rating or a changed source title needs the full join.
          if (ratings.every(row => ratingTitles.get(row.show_id) === row.show)) {
            const scores = new Map(ratings.map(row => [row.show_id,row.rating]));
            rows = rows.filter(show => scores.has(show.id));
            for (const show of rows) {
              const rating = scores.get(show.id)!, row = elements.get(show.id);
              const disabled = store.role !== 'writer' || pending.has(show.id);
              if (show.rating !== rating || (row && row.score.disabled !== disabled)) {
                show.rating = rating;
                row?.update(show);
              }
            }
            for (const id of ratingTitles.keys()) if (!scores.has(id)) ratingTitles.delete(id);
            render(false);
            continue;
          }
          invalidateOverview();
        }
        await readRecord(request);
        if (version === request) needsOverview = false;
      }
      while (!closed && request !== version);
    } catch (error) {
      if (!closed) throw error;
    } finally { reading = undefined; }
  }
  function refreshRatings() {
    version++;
    return reading ??= readPending();
  }
  function invalidateOverview() { metadataVersion++; waitingStatus.clear(); visibility?.disconnect(); needsOverview = true; }
  function refresh() { invalidateOverview(); return refreshRatings(); }
  render();
  return {ready:Promise.all([refresh(),preference.read()]).then(() => {}),refresh,refreshRatings,dispose() {
    closed = true; version++; reads.abort(); visibility?.disconnect(); waitingStatus.clear(); preference.dispose();
  }};
}
