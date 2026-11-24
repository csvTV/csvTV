import { openActionSheet } from './action-sheet.ts';
import { compareFileText } from './csv.ts';
import { openListEditor } from './lists-editor.ts';
import { listSearch } from './list-search.ts';
import { isListDeclaration, type RecordTables, type WatchedRow } from './model.ts';
import type { PersonalShow } from './personal-record.ts';
import { poster } from './poster.ts';
import type { Screen, ScreenContext } from './screen-context.ts';
import { compareShowOrder, isShowSort, showSortOptions, type ShowSort } from './show-sort.ts';
import { tmdbResourceKey } from './tmdb-client.ts';
import type { TmdbShow } from './tmdb-data.ts';
import { choiceControl, compactControl, rememberSort } from './view-select.ts';
import { watchEditRunner } from './notices.ts';

interface ListedShow extends PersonalShow {
  label: string;
  posterPath: string | null;
  year: number | null;
  rating: number | null;
  plays: bigint;
  missing: boolean;
}

const collator = new Intl.Collator(undefined, {sensitivity:'base'});
function byTitle(a: ListedShow, b: ListedShow) {
  return collator.compare(a.label,b.label) || compareFileText(a.label,b.label) || a.show_id-b.show_id;
}

function playTotals(watched: readonly WatchedRow[]) {
  const totals = new Map<number,bigint>();
  for (const row of watched) totals.set(row.show_id,(totals.get(row.show_id) ?? 0n) + BigInt(row.times_watched));
  return totals;
}

function listShows(tables: Omit<RecordTables,'settings'>, rows: readonly PersonalShow[], plays?: ReadonlyMap<number,bigint>): ListedShow[] {
  const titles = new Map<number, string>();
  for (const row of rows) if (!titles.has(row.show_id) || row.show) titles.set(row.show_id, row.show);
  const ids = [...titles.keys()];
  // Older files may have an empty title in just one of the record tables.
  for (const records of [tables.watched, tables.lists, tables.ratings]) {
    for (const row of records) if (row.show && titles.get(row.show_id) === '') titles.set(row.show_id, row.show);
  }
  const preserved = new Map(tables.shows.map(row => [row.show_id, row]));
  const ratings = new Map(tables.ratings.map(row => [row.show_id, row]));
  return ids.map(id => {
    const saved = preserved.get(id);
    const title = titles.get(id) || saved?.show || ratings.get(id)?.show || '';
    return { show_id: id, show: title, label: title || 'Show ' + id,
      year:saved?.year ?? null, posterPath:null, missing:false, rating:ratings.get(id)?.rating ?? null, plays:plays?.get(id) ?? 0n };
  });
}

async function readListDetails(ctx: ScreenContext, shows: ListedShow[], signal?: AbortSignal) {
  if (!shows.length) return;
  const keys = shows.map(row => tmdbResourceKey({kind:'show',id:row.show_id}));
  const entries = await ctx.service.store.tmdbEntries<TmdbShow | null>(keys,ctx.service.environment.now(),signal,{seasonOrders:false}).catch(()=>[]);
  if (signal?.aborted) return;
  for (const [i,entry] of entries.entries()) {
    const show = shows[i], cached = entry?.value;
    if (cached?.show) { show.label = cached.show; show.show = cached.show; }
    if (cached?.firstAirDate) show.year = Number(cached.firstAirDate.slice(0,4));
    show.missing = cached === null;
    show.posterPath = cached?.posterPath ?? null;
  }
}

export function mountListsScreen(root: HTMLElement, ctx: ScreenContext, initialName?: string): Screen {
  const doc = root.ownerDocument;
  const edits = watchEditRunner(ctx);
  const page = doc.createElement('div');
  page.className = 'lists-screen';
  page.innerHTML = '<header class="screen-heading"><h1>Lists</h1></header><div class="list-chips" role="group" aria-label="Choose a list"></div>' +
    '<section aria-labelledby="chosen-list" hidden><header><h2 id="chosen-list" tabindex="-1"></h2><div class="list-tools"></div></header>' +
    '<ul class="list-shows"></ul></section><p class="list-empty" hidden></p>';
  root.replaceChildren(page);
  const chips = page.querySelector<HTMLDivElement>('.list-chips')!;
  const heading = page.querySelector<HTMLElement>('h2')!;
  const density = compactControl(page,ctx);
  page.querySelector('.screen-heading')!.append(density.button);
  const items = page.querySelector<HTMLUListElement>('.list-shows')!;
  const empty = page.querySelector<HTMLElement>('.list-empty')!;
  let selected = initialName;
  let version = 0;
  let disposed = false;
  let reading: AbortController | undefined;
  let displayedList: string | undefined;
  let focusAfterSave: { name: string; from: 'new' | 'manage' } | undefined;
  let closePopup: (() => void) | undefined;
  let sort: ShowSort = 'title';
  let orderCards: (() => Promise<void>) | undefined;
  const preference = rememberSort(ctx,'listsSort','title',isShowSort,value => {
    sorting.display(showSortOptions,value);
    if (value === sort) return;
    sort = value;
    if (orderCards) void ctx.run(orderCards);
  });
  const sorting = choiceControl(doc,'Sort',value => { if (isShowSort(value)) preference.choose(value); });
  sorting.display(showSortOptions,sort);
  const search = listSearch(doc,ctx,(show,list,current) => edits.run('members/' + show.show_id,async () => {
    if (!current() || selected !== list) return;
    await ctx.watch.setMembership(show,list,true,current);
    if (current()) await ctx.run(refresh);
  }));
  const menu = button('•••','manage');
  menu.className = 'list-more';
  menu.setAttribute('aria-haspopup','dialog');
  menu.onclick = () => { if (displayedList !== undefined) manage(displayedList,displayedList); };
  page.querySelector('.list-tools')!.append(search.root,sorting.root,menu);

  function button(label: string, key: string) {
    const node = doc.createElement('button');
    node.type = 'button'; node.textContent = label; node.dataset.listFocus = key;
    return node;
  }
  function focusKey(key: string) {
    const nodes = page.querySelectorAll<HTMLElement>('[data-list-focus]');
    const fallback = selected ? heading : page.querySelector<HTMLElement>('.list-new')!;
    return Array.from(nodes).find(node => node.dataset.listFocus === key && !node.matches(':disabled')) ?? fallback;
  }
  function edit(name?: string) {
    closePopup?.();
    const key = name === undefined ? 'new' : 'manage';
    closePopup = openListEditor(page, ctx, {
      name, returnFocus: () => focusKey(key),
      saved: async newName => {
        if (disposed) return;
        edits.retire();
        selected = newName;
        focusAfterSave = {name:newName,from:key};
        ctx.selectList(newName);
        await ctx.run(refresh);
      },
    });
  }
  function manage(name: string, label:string) {
    closePopup?.();
    closePopup = openActionSheet(page, () => focusKey('manage'), { title: label, actions: [
      { label: 'Rename list', choose: () => edit(name) },
      { label: 'Delete list', destructive: true, choose: () => { void edits.run('members',async () => {
        if (await ctx.watch.deleteList(name) && !disposed) { await ctx.run(refresh); if (!disposed) focusKey('manage').focus(); }
      }); } },
    ] });
  }
  async function refresh() {
    if (disposed) return;
    const tick = ++version;
    reading?.abort();
    const controller = new AbortController();
    reading = controller;
    const includePlays = sort === 'plays';
    const saved = await Promise.all([
      ctx.service.store.listPageRows(selected,controller.signal,includePlays), ctx.service.read({ kind: 'configuration' }).catch(() => null),
    ]).catch(error => { if (!controller.signal.aborted) throw error; });
    if (!saved || tick !== version) return;
    const [{tables,names,name}, configuration] = saved;
    let totals = includePlays ? playTotals(tables.watched) : undefined;
    let readingTotals: Promise<void> | undefined;
    const memberships = tables.lists.filter(row => !isListDeclaration(row));
    const members = listShows(tables,memberships.filter(row => row.list === name),totals);
    const details = readListDetails(ctx,members,controller.signal);
    const early = name !== displayedList;
    if (!early) await details;
    if (tick !== version) return;
    displayedList = name;
    if (selected !== name) { edits.retire(); selected = name; if (name !== undefined) ctx.selectList(name); }
    const writable = ctx.service.store.role === 'writer';
    const focus = page.contains(doc.activeElement) ? (doc.activeElement as HTMLElement).dataset.listFocus : undefined;
    const sizes = new Map<string, number>();
    for (const row of memberships) sizes.set(row.list, (sizes.get(row.list) ?? 0) + 1);
    chips.replaceChildren();
    for (const list of names) {
      const chip = button(list, 'chip/' + list);
      chip.setAttribute('aria-pressed', String(list === name));
      const size = doc.createElement('span');
      size.textContent = String(sizes.get(list) ?? 0);
      chip.append(size);
      chip.setAttribute('aria-label', list + ', ' + size.textContent + (size.textContent === '1' ? ' show' : ' shows'));
      chip.onclick = () => {
        if (list === selected) return;
        edits.retire();
        focusAfterSave = undefined;
        search.reset();
        selected = list;
        ctx.selectList(list);
        void ctx.run(refresh);
      };
      chips.append(chip);
    }
    const add = button('New list', 'new');
    add.className = 'list-new'; add.disabled = !writable;
    add.setAttribute('aria-haspopup', 'dialog');
    add.onclick = () => edit();
    chips.append(add);
    const listLabel = name ?? '';
    heading.textContent = listLabel;
    page.querySelector('section')!.hidden = name === undefined;
    menu.disabled = !writable;
    menu.setAttribute('aria-label','Manage ' + listLabel);
    search.update(name,new Set(members.map(show => show.show_id)),writable);
    const fragment = doc.createDocumentFragment();
    const cards = new Map<number,{item:HTMLLIElement; update:()=>void}>();
    const inOrder = () => [...members].sort((a,b) => compareShowOrder(a,b,sort,byTitle));
    for (const show of inOrder()) {
      const item = doc.createElement('li');
      const link = doc.createElement('a');
      link.href = '#/show/' + show.show_id;
      link.dataset.listFocus = 'show/' + show.show_id;
      link.onclick = event => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault(); ctx.go({ page: 'show', id: show.show_id });
      };
      const description = doc.createElement('span');
      const label = doc.createElement('strong');
      label.textContent = show.label;
      description.append(label);
      link.append(poster(doc, show, configuration?.value ?? null), description);
      item.append(link);
      if (show.rating !== null) {
        const rating = doc.createElement('span');
        rating.className = 'list-rating'; rating.textContent = String(show.rating);
        const denominator = doc.createElement('small');
        denominator.textContent = '/10'; rating.append(denominator);
        item.append(rating);
      }
      const remove = button('×', 'remove/' + show.show_id);
      remove.className = 'list-remove'; remove.disabled = !writable;
      remove.setAttribute('aria-label', 'Remove ' + show.label + ' from ' + listLabel);
      remove.onclick = () => { void edits.run('members/' + show.show_id,async () => {
        const current = () => !disposed && selected === name;
        if (current() && await ctx.watch.setMembership(show, name, false,current) && current()) await ctx.run(refresh);
      }); };
      let art = show.posterPath;
      function update() {
        if (art !== show.posterPath) { link.firstChild!.replaceWith(poster(doc,show,configuration?.value ?? null)); art = show.posterPath; }
        if (label.textContent !== show.label) {
          label.textContent = show.label;
          remove.setAttribute('aria-label','Remove ' + show.label + ' from ' + listLabel);
        }
        const plays = sort === 'plays' && totals ? show.plays.toLocaleString() + (show.plays === 1n ? ' play' : ' plays') : '';
        const facts = [show.year?.toString(),plays,show.missing ? 'Not on TMDB' : ''].filter(Boolean).join(' · ');
        const subtitle = description.querySelector('small');
        if (facts && facts !== subtitle?.textContent) {
          const next = subtitle ?? doc.createElement('small');
          next.textContent = facts;
          if (!subtitle) description.append(next);
        } else if (!facts) subtitle?.remove();
      }
      update();
      cards.set(show.show_id,{item,update});
      item.append(remove); fragment.append(item);
    }
    items.replaceChildren(fragment);
    empty.textContent = name === undefined ? 'No custom lists yet.' : 'No shows in this list yet.';
    empty.hidden = members.length > 0;
    // The shell also refreshes on commit. Only the render that actually opens the
    // saved list can focus its field; a superseded render may still see it hidden.
    const afterSave = focusAfterSave;
    focusAfterSave = undefined;
    if (afterSave && afterSave.name === name && focus === afterSave.from) {
      (afterSave.from === 'new' ? search.field : focusKey('chip/' + name)).focus({preventScroll:true});
    } else if (focus) focusKey(focus).focus({ preventScroll: true });
    orderCards = async () => {
      if (sort === 'plays' && !totals) {
        // A new sort can arrive before artwork. Update the visible cards from
        // the local watch record without restarting their metadata lookup.
        readingTotals ??= ctx.service.store.listPageRows(name,controller.signal,true).then(snapshot => {
          if (tick !== version || snapshot.name !== name) return;
          totals = playTotals(snapshot.tables.watched);
          for (const show of members) show.plays = totals.get(show.show_id) ?? 0n;
        }).catch(error => { if (!controller.signal.aborted) throw error; }).finally(() => { readingTotals = undefined; });
        await readingTotals;
      }
      if (tick !== version) return;
      const active = doc.activeElement;
      inOrder().forEach((show,i) => {
        const card = cards.get(show.show_id)!;
        card.update();
        if (items.children[i] !== card.item) items.insertBefore(card.item,items.children[i] ?? null);
      });
      if (active instanceof doc.defaultView!.HTMLElement && items.contains(active) && doc.activeElement !== active)
        active.focus({preventScroll:true});
    };
    if (sort === 'plays' && !totals) await orderCards();
    if (early) {
      await details;
      if (tick === version) await orderCards();
    }
  }
  function roleChanged() {
    if (ctx.service.store.role !== 'writer') { closePopup?.(); search.update(undefined,new Set(),false); }
  }
  ctx.service.store.addEventListener('rolechange', roleChanged);
  return { ready: Promise.all([preference.read().then(refresh),density.read()]).then(() => {}), refresh, dispose() {
    preference.dispose();
    density.dispose();
    search.dispose();
    edits.retire();
    reading?.abort();
    disposed = true; version++; closePopup?.(); page.remove();
    ctx.service.store.removeEventListener('rolechange', roleChanged);
  } };
}
