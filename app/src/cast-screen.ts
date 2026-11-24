import { poster } from './poster.ts';
import { compareTitles, readOverview, type OverviewShow } from './record-overview.ts';
import type { Screen, ScreenContext } from './screen-context.ts';
import { searchText } from './title-search.ts';
import { tmdbImageUrl, type CacheEntry, type TmdbConfiguration, type TmdbDataByKind } from './tmdb-data.ts';
import type { MetadataView } from './tmdb-service.ts';
import { cacheExpired } from './tmdb-refresh.ts';
import { renderTmdbState } from './tmdb-settings.ts';

type Credit = TmdbDataByKind['person'][number];

function creditedShows(credits: readonly Credit[], personal: ReadonlyMap<number, OverviewShow>) {
  const shows = new Map<number, { credit: Credit; roles: Set<string> }>();
  for (const raw of credits) {
    const show = personal.get(raw.show_id);
    const credit = show?.missing ? { ...raw, show: show.title, posterPath: null } : raw;
    const existing = shows.get(credit.show_id) ?? { credit, roles: new Set<string>() };
    if (!existing.credit.firstAirDate && credit.firstAirDate) existing.credit = credit;
    if (credit.character) existing.roles.add(credit.character);
    shows.set(credit.show_id, existing);
  }
  return [...shows.values()].sort(({ credit: a }, { credit: b }) => {
    const firstDate = a.firstAirDate ?? '';
    const secondDate = b.firstAirDate ?? '';
    return firstDate > secondDate ? -1 : firstDate < secondDate ? 1 :
      compareTitles({ title: a.show, id: a.show_id }, { title: b.show, id: b.show_id });
  });
}

function watchLabel(show: OverviewShow | undefined) {
  if (!show?.progress.recordedEpisodes) return 'Not watched';
  if (!show.metadata) return 'Watched';
  return show.progress.complete ? 'Complete' : 'Part watched';
}

function portrait(doc: Document, config: TmdbConfiguration | null, profile: string | null) {
  const slot = doc.createElement('span');
  slot.className = 'cast-portrait';
  slot.setAttribute('aria-hidden', 'true');
  const size = config && (['w185', 'w154', 'w92'].find(s => config.profileSizes.includes(s)) ?? config.profileSizes[0]);
  const url = config && size && tmdbImageUrl(config, 'profile', size, profile);
  if (url) {
    const img = doc.createElement('img');
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', () => img.remove(), { once: true });
    img.src = url;
    slot.append(img);
  }
  return slot;
}

export function mountCastScreen(root: HTMLElement, ctx: ScreenContext, id: number, showId?: number): Screen {
  const { service } = ctx;
  const doc = root.ownerDocument;
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
    const element = doc.createElement(tag);
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const page = node('article');
  page.className = 'cast-page';
  const header = node('header');
  const status = node('div');
  const results = node('div');
  const heading = node('h1', 'Cast member');
  heading.tabIndex = -1;
  const count = node('p');
  count.hidden = true;
  const identityText = node('div');
  identityText.append(heading, count);
  const searchField = node('label');
  searchField.className = 'tv-search-field';
  searchField.hidden = true;
  const search = node('input');
  search.type = 'search';
  search.placeholder = 'Search';
  search.setAttribute('aria-label', 'Search credits by show or role');
  searchField.append(search);
  header.append(portrait(doc, null, null), identityText, searchField);
  function creditGroup(title: string) {
    const section = node('section');
    const list = node('ul');
    section.setAttribute('aria-label', title);
    section.append(node('h2', title), list);
    return { section, list };
  }
  const seen = creditGroup('Shows you’ve seen');
  const other = creditGroup('Other shows');
  const noneSeen = node('p', 'None watched yet.');
  seen.section.append(noneSeen);
  const message = node('p');
  results.hidden = true;
  results.append(seen.section, other.section, message);
  page.append(header, status, results);
  root.replaceChildren(page);
  renderTmdbState(status, 'loading');

  let closed = false;
  let fetchId = 0;
  let drawId = 0;
  let drawing: AbortController | undefined;
  let fallbackCast: {id:number; ready:Promise<unknown>} | undefined;
  let rememberedCast: number | undefined;
  const lifetime = new AbortController();
  for (const event of ['tmdbmetadata','tmdbbrowse','cachechange','deviceerased']) {
    service.store.addEventListener(event,notice => {
      if ((notice as CustomEvent<{castChanged?:boolean}>).detail?.castChanged !== false) rememberedCast = undefined;
    },{signal:lifetime.signal});
  }
  let source = '';
  let view: Pick<MetadataView<'person'>, 'status' | 'reason'> | undefined;
  type CreditRow = {item: HTMLLIElement; watched: boolean; searchable: string; signature: string};
  let creditRows = new Map<number,CreditRow>();
  let portraitKey = '';
  const actions = { onSettings: () => ctx.go({ page: 'settings' }), onRetry: () => { void ctx.run(open); }, canAccessKeys:ctx.canAccessKeys };

  async function identity(signal: AbortSignal) {
    for (const candidate of new Set([showId,rememberedCast])) {
      if (candidate === undefined) continue;
      const cast = await service.read({kind:'cast',id:candidate});
      signal.throwIfAborted();
      const member = cast?.value?.find(person => person.id === id);
      if (member) return member;
    }
    const member = await service.store.cachedCastMember(id, service.environment.now(), signal);
    signal.throwIfAborted();
    rememberedCast = member?.sourceShowId;
    return member;
  }

  function filterCredits() {
    const query = searchText(search.value.trim());
    let seenCount = 0;
    let otherCount = 0;
    for (const row of creditRows.values()) {
      const hidden = !row.searchable.includes(query);
      if (row.item.hidden !== hidden) row.item.hidden = hidden;
      if (!row.item.hidden) {
        if (row.watched) seenCount++;
        else otherCount++;
      }
    }
    noneSeen.hidden = seenCount > 0 || !!query;
    seen.section.hidden = !seenCount && (!!query || !creditRows.size);
    other.section.hidden = !otherCount;
    message.hidden = seenCount + otherCount > 0;
    message.textContent = query && creditRows.size ? 'No matching credits.' : 'No TV shows listed.';
  }
  search.oninput = filterCredits;
  search.onkeydown = event => {
    if (event.key === 'Escape' && search.value) {
      event.preventDefault();
      search.value = '';
      filterCredits();
    }
  };

  async function drawCredits(state: NonNullable<typeof view>, signal: AbortSignal, retained?: CacheEntry<'person'>) {
    let entry = retained ?? await service.read({ kind: 'person', id });
    signal.throwIfAborted();
    const overview = entry?.value?.length ? await readOverview(service, entry.value.map(credit => credit.show_id), signal)
      : {shows:[],config:(await service.read({kind:'configuration'}))?.value ?? null};
    signal.throwIfAborted();
    if (entry && cacheExpired(entry.fetchedAt, service.environment.now())) entry = null;
    const personal = new Map(overview.shows.map(show => [show.id, show]));
    const credits = creditedShows(entry?.value ?? [], personal);
    const focused = (doc.activeElement as HTMLElement | null)?.closest<HTMLAnchorElement>('.cast-row')?.hash;
    const statusFocused = status.contains(doc.activeElement);
    const searchFocused = doc.activeElement === search;
    const seenItems: HTMLLIElement[] = [], otherItems: HTMLLIElement[] = [];
    const nextRows = new Map<number,CreditRow>();
    const sizes = overview.config?.posterSizes.join(',') ?? '';
    let watched = 0;
    for (const { credit, roles } of credits) {
      const label = watchLabel(personal.get(credit.show_id));
      const seenShow = label !== 'Not watched';
      if (seenShow) watched++;
      const target = seenShow ? seenItems : otherItems;
      const detail = [credit.firstAirDate?.slice(0, 4), [...roles].join(', ')].filter(Boolean).join(' · ');
      const missing = personal.get(credit.show_id)?.missing;
      const signature = JSON.stringify([credit.show,detail,[...roles],missing,label,credit.posterPath,sizes]);
      const previous = creditRows.get(credit.show_id);
      if (previous?.signature === signature) {
        nextRows.set(credit.show_id,previous);
        target.push(previous.item);
        continue;
      }
      const link = node('a');
      link.className = 'cast-row';
      link.href = '#/show/' + credit.show_id;
      link.onclick = event => {
        if (event.button || event.ctrlKey || event.shiftKey || event.metaKey || event.altKey) return;
        event.preventDefault();
        ctx.go({ page: 'show', id: credit.show_id });
      };
      const title = node('span');
      title.className = 'cast-title';
      title.append(node('strong', credit.show));
      if (detail) title.append(node('small', detail));
      if (missing) title.append(node('small', 'Not on TMDB'));
      const mark = node('span');
      mark.className = 'cast-watch';
      if (seenShow) {
        const tick = node('span', '✓');
        tick.setAttribute('aria-hidden', 'true');
        mark.append(tick);
      }
      mark.append(label);
      link.append(poster(doc, credit, overview.config), title, mark);
      const item = node('li');
      item.append(link);
      target.push(item);
      nextRows.set(credit.show_id,{item,watched:seenShow,signature,searchable:searchText([credit.show,...roles].join(' '))});
    }
    for (const [id,row] of creditRows) if (nextRows.get(id) !== row) row.item.remove();
    creditRows = nextRows;
    for (const [list,items] of [[seen.list,seenItems],[other.list,otherItems]] as const) {
      let position = list.firstElementChild;
      for (const item of items) {
        if (position !== item) list.insertBefore(item,position);
        position = item.nextElementSibling;
      }
    }
    results.hidden = !entry?.value;
    count.hidden = !entry?.value;
    searchField.hidden = !credits.length;
    if (entry?.value) {
      count.textContent = 'In ' + watched.toLocaleString() + (watched === 1 ? ' show' : ' shows') + ' you have watched';
      filterCredits();
      renderTmdbState(status, state.reason === 'refused' ? 'refused' : 'ready', actions);
    } else if (retained) {
      count.textContent = '';
      renderTmdbState(status, 'loading');
    } else {
      count.textContent = '';
      const reason = state.reason ?? state.status;
      renderTmdbState(status, reason === 'ready' || reason === 'empty' || reason === 'cached' ? 'unavailable' : reason, actions);
    }
    if (searchFocused && searchField.hidden) heading.focus({preventScroll:true});
    else if ((focused || statusFocused) && doc.activeElement === doc.body) {
      const control = focused ? results.querySelector<HTMLAnchorElement>('li:not([hidden]) a[href="' + CSS.escape(focused) + '"]') : status.querySelector('button');
      (control ?? heading).focus({ preventScroll: true });
    }
    return {config:overview.config, creditedId:credits.find(({credit}) => !personal.get(credit.show_id)?.missing)?.credit.show_id ?? null};
  }

  async function draw(retained?: CacheEntry<'person'>) {
    if (!view || closed) return;
    drawing?.abort();
    const controller = drawing = new AbortController(), ticket = ++drawId;
    try {
      // A direct link may need to search other shows for this person's name.
      // Their credit links, watch states and search can paint independently.
      const [cachedPerson, credits] = await Promise.all([identity(controller.signal), drawCredits(view,controller.signal,retained)]);
      if (ticket !== drawId || closed) return;
      let person = cachedPerson;
      // Zero is a local show ID. A direct link can use a credited TMDB show to find a missing name.
      const candidate = showId || credits.creditedId;
      if (!person && view.status === 'ready' && candidate) {
        const resource = {kind:'cast' as const,id:candidate};
        if (fallbackCast?.id !== candidate) {
          fallbackCast = {id:candidate,ready:service.view(resource).catch(() => null)};
        }
        await fallbackCast.ready;
        controller.signal.throwIfAborted();
        person = (await service.read(resource))?.value?.find(item => item.id === id) ?? null;
        controller.signal.throwIfAborted();
      }
      heading.textContent = person?.name || 'Cast member';
      const nextPortrait = JSON.stringify([person?.profilePath,credits.config?.profileSizes]);
      if (portraitKey !== nextPortrait) {
        portraitKey = nextPortrait;
        header.firstElementChild!.replaceWith(portrait(doc, credits.config, person?.profilePath ?? null));
      }
    } catch (error) { if (!controller.signal.aborted) throw error; }
  }

  async function signature() {
    const key = await service.keyStatus();
    return [key.generation, key.status, service.store.role, service.environment.online()].join('/');
  }

  async function open() {
    const ticket = ++fetchId;
    drawing?.abort();
    fallbackCast = undefined;
    drawId++;
    const signatureAtOpen = await signature();
    if (closed || ticket !== fetchId) return;
    source = signatureAtOpen;
    try {
      const response = await service.view({ kind: 'person', id }, cached => {
        if (closed || ticket !== fetchId) return;
        view = {status:'cached'};
        void ctx.run(() => draw(cached));
      });
      if (closed || ticket !== fetchId) return;
      view = { status: response.status, reason: response.reason };
      await draw();
    } catch (error) {
      if (!closed && ticket === fetchId) throw error;
    }
  }
  return {
    ready: open(),
    async refresh() {
      if (closed) return;
      if (await signature() !== source) return open();
      await draw();
    },
    dispose() { closed = true; lifetime.abort(); drawing?.abort(); page.remove(); },
  };
}
