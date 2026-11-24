import type { PersonalShow } from './personal-record.ts';
import type { ScreenContext } from './screen-context.ts';
import type { RecordChange } from './storage.ts';
import { searchText } from './title-search.ts';

interface Match extends PersonalShow { year: number | null }
const suggestionLimit = 20;

/** Search the saved record and the TMDB catalog without leaving the selected list. */
export function listSearch(doc: Document, ctx: ScreenContext,
    add: (show: PersonalShow, list: string, current: () => boolean) => Promise<void>) {
  const root = doc.createElement('div');
  root.className = 'list-search';
  root.innerHTML = '<label class="tv-search-field"><span class="search-glass" aria-hidden="true"></span>' +
    '<input type="search" role="combobox" aria-label="Search shows to add" aria-haspopup="dialog" aria-expanded="false" ' +
    'aria-controls="list-search-menu" placeholder="Search" autocomplete="off" enterkeyhint="search"></label>' +
    '<div class="list-search-menu" id="list-search-menu" role="dialog" aria-label="Shows to add" hidden>' +
    '<ul aria-label="Matching shows"></ul><p role="status"></p></div>';
  const field = root.querySelector('input')!;
  const menu = root.querySelector<HTMLElement>('.list-search-menu')!;
  const results = root.querySelector('ul')!, status = root.querySelector('p')!;
  let list: string | undefined, members: ReadonlySet<number> = new Set();
  let context = 0, request = 0, record = ctx.watch.recordGeneration;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let saved: Promise<(Match & {term:string})[]> | undefined;
  let refreshLocal: (() => void) | undefined;
  const events = new AbortController();
  const adding = new Set<number>();
  let matches: Match[] = [], note = '', rendered = '';
  let more = false;
  let composing = false;

  function close() {
    request++;
    clearTimeout(timer);
    menu.hidden = true;
    field.setAttribute('aria-expanded','false');
    matches = [];
    rendered = ''; more = false;
    refreshLocal = undefined;
    results.replaceChildren();
  }
  function draw() {
    if (menu.hidden || !list) return;
    const destination = list, generation = context;
    const current = () => !events.signal.aborted && context === generation && ctx.service.store.role === 'writer' &&
      record === ctx.watch.recordGeneration;
    const message = matches.length ? (more ? 'Type more to narrow the results.' : '') : note;
    const display = JSON.stringify([destination,message,matches.map(row =>
      [row.show_id,row.show,row.year,members.has(row.show_id),adding.has(row.show_id)])]);
    if (rendered === display) return;
    rendered = display;
    const activeId = results.contains(doc.activeElement) ? (doc.activeElement as HTMLElement).dataset.show : undefined;
    const scroll = menu.scrollTop;
    const fragment = doc.createDocumentFragment();
    for (const match of matches) {
      const item = doc.createElement('li'), title = doc.createElement('span'), button = doc.createElement('button');
      title.textContent = match.show;
      if (match.year !== null) {
        const year = doc.createElement('small');
        year.textContent = String(match.year);
        title.append(' ',year);
      }
      button.type = 'button';
      button.dataset.show = String(match.show_id);
      const included = members.has(match.show_id), busy = adding.has(match.show_id);
      button.textContent = included ? 'Added' : busy ? 'Adding…' : 'Add';
      button.setAttribute('aria-label',(included ? 'Added ' : 'Add ') + match.show + ' to ' + destination);
      button.disabled = included || busy;
      button.onclick = async () => {
        if (!current() || members.has(match.show_id) || adding.has(match.show_id)) return;
        if (doc.activeElement === button) field.focus({preventScroll:true});
        adding.add(match.show_id);
        draw();
        try { await add(match,destination,current); }
        finally { if (current()) { adding.delete(match.show_id); draw(); } }
      };
      item.append(title,button);
      fragment.append(item);
    }
    results.replaceChildren(fragment);
    menu.scrollTop = scroll;
    status.textContent = message;
    status.hidden = !message;
    if (activeId && doc.activeElement === doc.body) {
      (results.querySelector<HTMLButtonElement>('button[data-show="'+activeId+'"]:not(:disabled)') ?? field).focus({preventScroll:true});
    }
  }

  function search(now = false) {
    close();
    const query = field.value.trim();
    const term = searchText(query);
    if (!list || !term || composing || field.disabled) return;
    const turn = request, active = () => turn === request && record === ctx.watch.recordGeneration && !events.signal.aborted;
    let local: Match[] = [], remote: Match[] = [];
    let moreLocal = false, moreRemote = false;
    note = 'Searching…';
    menu.hidden = false;
    field.setAttribute('aria-expanded','true');
    draw();
    const rank = (title:string) => title === term ? 0 : title.startsWith(term) ? 1 : 2;
    function show() {
      if (!active()) return;
      const found = new Map<number,Match>();
      for (const row of [...local,...remote]) if (!found.has(row.show_id)) found.set(row.show_id,row);
      more = moreLocal || moreRemote || found.size > suggestionLimit;
      matches = [...found.values()].sort((a,b) => rank(searchText(a.show)) - rank(searchText(b.show))).slice(0,suggestionLimit);
      draw();
    }
    refreshLocal = () => {
      const reading = saved ??= ctx.service.store.listSearchTitles(events.signal).then(rows =>
        rows.sort((a,b) => a.show.localeCompare(b.show)).map(row => ({...row,term:searchText(row.show)})));
      void reading.then(rows => {
        if (!active() || reading !== saved) return;
        const byRank: Match[][] = [[],[],[]];
        let count = 0;
        for (const row of rows) {
          if (!row.term.includes(term)) continue;
          const bucket = byRank[rank(row.term)];
          if (bucket.length < suggestionLimit) bucket.push(row);
          count++;
        }
        moreLocal = count > suggestionLimit;
        local = byRank.flat().slice(0,suggestionLimit);
        show();
      }).catch(() => { if (saved === reading) saved = undefined; });
    };
    refreshLocal();
    async function lookup() {
      try {
        const view = await ctx.service.search(query,1,active);
        if (!active()) return;
        remote = (view.value?.results ?? []).map(row => ({show:row.show,show_id:row.show_id,
          year:row.firstAirDate ? Number(row.firstAirDate.slice(0,4)) : null}));
        moreRemote = (view.value?.totalPages ?? 0) > 1;
        const problem = view.reason ?? view.status;
        if (problem === 'missing-key' || problem === 'refused') note = 'No saved matches. Check the TMDB key in Settings to search more shows.';
        else if (problem === 'offline') note = 'No matches available offline.';
        else if (problem === 'unavailable') note = 'TMDB search is unavailable. Try again.';
        else note = 'No matching shows.';
      } catch {
        if (!active()) return;
        note = 'TMDB search is unavailable. Try again.';
      }
      show();
    }
    if (now) void lookup();
    else timer = setTimeout(() => void lookup(),300);
  }
  field.oninput = () => { if (!composing) search(); };
  field.onfocus = () => { if (menu.hidden && field.value.trim()) search(); };
  field.addEventListener('compositionstart',() => { composing = true; close(); });
  field.addEventListener('compositionend',() => { composing = false; search(); });
  root.onkeydown = event => {
    if (composing || event.isComposing) return;
    if (event.key === 'Escape' && !menu.hidden) {
      event.preventDefault(); event.stopPropagation(); field.focus(); close(); return;
    }
    if (event.key === 'Enter' && event.target === field) { event.preventDefault(); search(true); return; }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const controls = [...results.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    if (menu.hidden) { if (field.value.trim()) search(true); return; }
    if (!controls.length) return;
    event.preventDefault();
    const at = controls.indexOf(doc.activeElement as HTMLButtonElement);
    const next = event.key === 'ArrowDown' ? controls[at+1] : at < 0 ? controls.at(-1) : controls[at-1];
    (next ?? field).focus();
  };
  root.addEventListener('focusout',event => {
    if (event.relatedTarget && !root.contains(event.relatedTarget as Node)) close();
  });
  doc.addEventListener('pointerdown',event => { if (!menu.hidden && !root.contains(event.target as Node)) close(); },
    {capture:true,signal:events.signal});
  ctx.service.store.addEventListener('recordchange',event => {
    const change = (event as CustomEvent<RecordChange>).detail;
    if (change && !change.tables.some(table => table !== 'settings')) return;
    if (ctx.watch.recordGeneration !== record) { reset(); return; }
    saved = undefined;
    refreshLocal?.();
  },{signal:events.signal});
  function reset() {
    context++; close(); field.value = ''; saved = undefined; adding.clear();
  }
  return { root,field, reset, update(name: string | undefined, ids: ReadonlySet<number>, writable: boolean) {
    if (name !== list || ctx.watch.recordGeneration !== record || field.disabled !== !writable) reset();
    list = name; record = ctx.watch.recordGeneration; members = ids; field.disabled = !writable; draw();
  }, dispose() { reset(); events.abort(); } };
}
