import { mountHomeScreen } from '../dist/home-screen.js';
import { mountSearchScreen } from '../dist/search-screen.js';
import { openDeviceStore } from '../dist/storage.js';
import { TmdbService } from '../dist/tmdb-service.js';
import { WatchActions } from '../dist/watch-actions.js';
import { dropMembership, upcomingReason } from '../dist/upcoming-preference.js';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function check(condition, message) { if (!condition) throw Error(message); }
async function until(predicate, message) {
  const start = performance.now();
  while (!predicate()) {
    if (performance.now() - start > 3000) throw Error(message);
    await wait(10);
  }
}
const title = (show_id, show, date = '2026-01-01') =>
  ({ show_id, show, firstAirDate: date, posterPath: null, backdropPath: null, overview: '' });
const ep = (episode, airDate) => ({ episode, episode_id: 100 + episode, title: 'Chapter ' + episode, airDate });
const row = (show_id, show, episode = 1, times_watched = 1, season = 1) =>
  ({ show_id, show, episode, times_watched, season, title: 'Chapter ' + episode, episode_id: 100 + episode });
const show = (id, name, seasons) => ({
  ...title(id, name), lastAired: null, nextAirDate: null, seasons: seasons.map(([season, dates]) => ({
    season, episodeCount: dates.length, episodes: dates.map((d, i) => ep(i + 1, d)),
  })),
});
const past = '2026-01-01', future = '2027-01-01';
function environment() {
  const tables = { watched: [], ratings: [], lists: [], shows: [], settings: [] };
  const snapshot = { tables, local: { recentlyMarked: [] } };
  const details = new Map();
  const calls = [], routes = [], queries = [], marks = [];
  const service = {
    store: { role: 'writer', homeRecord: async () => snapshot, snapshot: async () => snapshot,
      searchRecords:async ids => ids.map(id => ({watched:tables.watched.filter(row=>row.show_id===id),
        dropped:tables.lists.some(row=>row.show_id===id && dropMembership(row.list)==='dropped')})),
      tmdbEntries: async keys => keys.map(key => {
      const id = Number(/^tv\/(\d+)\?/.exec(key)?.[1]);
      return details.has(id) ? { value: details.get(id) } : undefined;
    }) },
    status: 'ready', firstUse: async () => !snapshot.local.firstUseDismissed,
    async dismissFirstUse() { snapshot.local.firstUseDismissed = true; },
    keyStatus: async () => ({ status: service.status, generation: 1n }),
    environment: { now: () => new Date(2026, 10, 18, 12).getTime(), online: () => true },
    async read(resource) {
      return resource.kind === 'show' && details.has(resource.id) ? { value: details.get(resource.id) } : null;
    },
    showInfo: async id => details.get(id) ?? null,
    async search(query,page,current) {
      const request = {kind:'search',query,page};
      calls.push(request);
      return this.reply(request,current);
    },
    reply: () => ({ status: 'empty', value: { page: 1, totalPages: 0, results: [] } }),
  };
  return { ctx: { service, go: r => routes.push(r), searchQuery: v => queries.push(v),
    run: action => action(), watch: { bulk: async (...args) => { marks.push(args); } } },
    tables, snapshot, details, service, calls, routes, queries, marks };
}

async function inViewport(test) {
  const frame = document.createElement('iframe');
  frame.width = '320';
  frame.height = '580';
  frame.srcdoc = '<!doctype html><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/settings.css"><link rel="stylesheet" href="/home-search.css"><main></main>';
  const loaded = new Promise(resolve => frame.addEventListener('load', resolve, { once: true }));
  document.body.append(frame);
  await loaded;
  const doc = frame.contentDocument;
  const root = doc.querySelector('main');
  let mounted;
  try {
    const mount = async (func, ctx, query) => {
      mounted?.dispose();
      mounted = func(root, ctx, query);
      await mounted.ready;
      return mounted;
    };
    await test({ root, doc, frame, mount });
  } finally {
    mounted?.dispose();
    frame.remove();
  }
}

export async function homeSearchCases(run) {
  await run('Search reads only matched histories across a long season, duplicate results and a legacy Dropped alias', async () => {
    const name = 'fictional-search-ranges-'+crypto.randomUUID(), store = await openDeviceStore({name});
    try {
      const state = await store.whenWriter();
      const watched = [row(4,'Early station'),row(5,'Skipped station'),row(9,'Later station'),
        ...Array.from({length:280},(_,i)=>row(11,'Long season',i+1)),row(23,'More news'),row(31,'Last station')];
      await store.commit(state.revision,{put:{watched,lists:[{list:'Stopped',show_id:31,show:'Last station'}]}});
      const ids = [31,4,11,9,11,77], original = IDBObjectStore.prototype.getAll;
      const ranges = [];
      IDBObjectStore.prototype.getAll = function(...args) {
        if (this.name === 'watched') ranges.push(args[0]);
        return original.apply(this,args);
      };
      let found;
      try { found = await store.searchRecords(ids); }
      finally { IDBObjectStore.prototype.getAll = original; }
      check(ranges.length && ranges.every(range=>range && ![5,23].some(id=>range.includes([id,1,1]))),
        'Search copied the episode history of an unrelated show');
      check(found.every((r,i)=>r.watched.every(w=>w.show_id===ids[i]) && r.dropped === (ids[i]===31)) &&
        found.map(r=>r.watched.length).join() === '1,1,280,1,280,0','A long season crossed a search result or lost its last episodes');
      const canceled = new AbortController(); canceled.abort();
      let error;try { await store.searchRecords(ids,canceled.signal); } catch (cause) { error=cause; }
      check(error?.name==='AbortError','Canceled searches continued reading the record');
    } finally { await store.closeForUpdate(); indexedDB.deleteDatabase(name); }
  });
  await run('Home paints exact personal totals and recency before a single schedule read finishes', () => inViewport(async ({root,doc,mount}) => {
    const {ctx,tables,snapshot,details,service} = environment();
    tables.watched.push(row(1,'First',1,4),row(2,'Second'));
    tables.lists.push({show_id:2,show:'Second',list:'Watchlist'},{show_id:3,show:'Zinc Premiere',list:'Watchlist'},
      {show_id:4,show:'Unknown schedule',list:'Following upcoming'});
    snapshot.local.recentlyMarked = [2,1];
    details.set(1,show(1,'First',[[1,[past]]]));
    details.set(2,{...show(2,'Second',[[1,[past,past]]]),status:'Ended',lastAired:{season:1,episode:2,airDate:past}});
    details.set(3,{...show(3,'Zinc Premiere',[]),firstAirDate:future});
    const read = service.store.tmdbEntries.bind(service.store), gate = Promise.withResolvers();
    let headerReads = 0;
    service.store.tmdbEntries = async (keys,...args) => {
      if (keys.some(key=>/^tv\/\d+\?/.test(key))) { headerReads++; await gate.promise; }
      return read(keys,...args);
    };
    const ready = mount(mountHomeScreen,ctx);
    try {
      await until(() => headerReads === 1 && root.querySelector('[data-recent] a'),'Home withheld the personal record');
      const figures = [...root.querySelectorAll('.record-totals dd')].map(node=>node.textContent);
      const links = [...root.querySelectorAll('[data-recent] a')];
      check(figures.join('|') === '2|…|2|5' && links.map(link=>link.hash).join() === '#/show/2,#/show/1' &&
        root.querySelector('[data-watchlist-count]').textContent === '2 shows' && !root.querySelector('[data-home-watchlist] a'),
        'Home showed an estimated season count or ordering before it had the schedule');
      links[0].focus();
      gate.resolve(); const home = await ready;
      check(headerReads === 1 && doc.activeElement === links[0] && links.every(link=>link.isConnected) &&
        root.querySelectorAll('.record-totals dd')[1].textContent === '2' &&
        [...root.querySelectorAll('[data-home-watchlist] a')].map(link=>link.hash).join() === '#/show/3,#/show/4' &&
        root.querySelector('[data-more] a[href="#/show/2"]'),
        'Enriching Home refetched the titles, changed recency or failed to publish the final rail');
      const nextRead = Promise.withResolvers();
      service.store.tmdbEntries = async (...args) => { await nextRead.promise; return read(...args); };
      root.querySelector('[data-home-watchlist] a[href="#/show/3"]').focus();
      tables.watched.push(row(3,'Zinc Premiere'));
      const refreshing = home.refresh();
      try {
        await until(() => root.querySelector('[data-watchlist-count]').textContent === '1 show','Home kept a watched membership count');
        check(!root.querySelector('[data-home-watchlist] a[href="#/show/3"]') &&
          root.querySelector('[data-home-watchlist] a[href="#/show/4"]') && doc.activeElement === root.querySelector('#watchlist-heading a'),
          'Home kept a newly watched title or lost keyboard focus while schedules loaded');
      } finally { nextRead.resolve(); await refreshing; }
    } finally { gate.resolve(); await ready; }
  }));
  await run('Home rails, local totals, omissions, and first use on a narrow screen', () => inViewport(async ({ root, doc, frame, mount }) => {
    const { ctx, tables, snapshot, details, routes } = environment();
    tables.watched.push(row(4, 'Row only'), row(1, 'Distant Ash'), row(2, 'Tide Room', 1, 3),
      row(3, 'Stopped Story'), row(2, 'Tide Room', 1, 2, 0), row(5, 'Aster House'));
    tables.lists.push({ show_id: 3, show: 'Stopped Story', list: 'sToPpEd' });
    details.set(1, show(1, 'Distant Ash', [[1, [past, past, past]]]));
    details.set(2, show(2, 'Tide Room', [[1, [past, past]], [0, [past]]]));
    details.set(5, show(5, 'Aster House', [[1, [past, past]]]));
    // Older builds kept unwatched shows here even if a rating, list or cached poster remained.
    tables.ratings.push({show_id:90, show:'Rated only', rating:8});
    tables.lists.push({show_id:91, show:'Listed only', list:'Watchlist'});
    details.set(92, show(92, 'Cached only', [[1,[past]]]));
    snapshot.local.recentlyMarked = [90, 91, 92, 4, 2, 1];
    const home = await mount(mountHomeScreen, ctx);
    const texts = selector => [...root.querySelectorAll(selector)].map(el => el.textContent);
    check(root.querySelector('.home-search').closest('.screen-heading').nextElementSibling.getAttribute('aria-labelledby') === 'totals-heading' &&
      root.querySelector('[aria-labelledby="watchlist-heading"]').nextElementSibling.getAttribute('aria-labelledby') === 'more-heading' &&
      !root.querySelector('a[href="#/export"]'), 'Home misplaced Your record, Watchlist, or the Export shortcut');
    check(texts('[data-home-watchlist] strong').join() === 'Listed only' &&
      root.querySelector('[data-watchlist-count]').textContent === '1 show', 'An unwatched Watchlist show was missing');
    tables.lists.push({show_id:91, show:'Listed only', list:'Following upcoming'},
      {show_id:2, show:'Tide Room', list:'Following upcoming'}, {show_id:5, show:'Aster House', list:'Watchlist'});
    await home.refresh();
    check(texts('[data-home-watchlist] strong').join('|') === 'Listed only', 'Old Watchlist memberships duplicated started shows on Home');
    tables.lists = [{show_id:3,show:'Stopped Story',list:'Stopped'}, {show_id:2,show:'Tide Room',list:'Watchlist'},
      {show_id:2,show:'Tide Room',list:'Hidden from upcoming'}];
    await home.refresh();
    check(!root.querySelector('[data-home-watchlist] a') && root.querySelector('[data-home-watchlist] .tv-empty').textContent === 'Your Watchlist is empty.' &&
      root.querySelector('[data-watchlist-count]').textContent === '0 shows', 'The Home Watchlist retained removed or hidden shows');
    check(texts('[data-recent] strong').join('|') === 'Row only|Tide Room|Distant Ash', 'Recent order lost the device history or uncached title');
    check(texts('[data-more] strong').join('|') === 'Aster House|Tide Room|Distant Ash', 'More rail must sort by remaining episodes then title');
    check(root.querySelector('[data-more-count]').textContent === '3 shows' && root.querySelector('[data-omitted]').textContent.startsWith('1 show'), 'More count or omitted count is wrong');
    check(texts('dd').join('|') === '5|6|6|9', 'Home must count special seasons, rows and exact plays');
    check(root.querySelectorAll('[data-more] progress').length === 3, 'Incomplete posters need their progress lines');
    const reordered = root.querySelector('[data-recent] a[href="#/show/2"]');
    reordered.focus();
    snapshot.local.recentlyMarked = [2,4,1];
    await home.refresh();
    check(doc.activeElement === reordered && reordered === root.querySelector('[data-recent] a'),
      'A background reorder lost the focused recent show');
    root.querySelector('[data-recent] a').click();
    const search = root.querySelector('.home-search input');
    search.focus();
    search.value = '  ';
    search.form.requestSubmit();
    search.value = '  Signal Garden  ';
    search.dispatchEvent(new Event('input',{bubbles:true}));
    await home.refresh();
    check(routes.length === 1 && doc.activeElement === search && search.value.trim() === 'Signal Garden',
      'Focusing, typing, an empty submit or a Home refresh prematurely opened Search or lost the draft');
    search.form.requestSubmit();
    check(routes.at(-1)?.query === 'Signal Garden','Search did not receive the submitted title');
    root.querySelector('[data-setup] a[href="#/settings"]').click();
    check(routes.map(r => r.page).join('|') === 'show|search|settings', 'Home links must reach working screens');
    root.querySelector('[data-setup] button:last-child').click();
    await until(() => !root.querySelector('[data-setup] section'), 'Cannot dismiss setup');
    check(doc.documentElement.scrollWidth <= frame.clientWidth, 'Home overflows the 320px viewport');
  }));

  await run('Search result order, aired counts, repeats, and watch eligibility', () => inViewport(async ({ root, doc, mount }) => {
    const { ctx, tables, details, service, routes, marks } = environment();
    const results = ['Rewatch', 'Empty', 'Future', 'No date', 'Rows only', 'Specials', 'First viewing', 'Twice', 'Orphan', 'Absent']
      .map((s, i) => title(i + 1, s, i === 2 ? future : i === 3 ? null : past));
    tables.watched.push(row(1, 'Rewatch', 1, 3), row(1, 'Rewatch', 2, 2), row(5, 'Rows only'),
      row(7, 'First viewing'), row(7, 'First viewing', 3), row(8, 'Twice'), row(9, 'Orphan'));
    tables.lists.push({ show_id: 2, show: 'Empty', list: 'Watchlist' });
    details.set(1, show(1, 'Rewatch', [[1, [past, past]]]));
    details.set(6, show(6, 'Specials', [[0, [past]]]));
    details.set(7, show(7, 'First viewing', [[1, [past, past, future]]]));
    details.set(8, show(8, 'Twice', [[1, [past]]]));
    details.set(9, show(9, 'Orphan', [[1, [future]]]));
    details.set(10, null);
    service.reply = () => ({ status: 'ready', value: { page: 1, totalPages: 1, results } });
    ctx.watch.bulk = async (...args) => {
      marks.push(args);
      if (args[2] === 'mark') tables.watched.push(row(7, 'First viewing', 2));
    };
    const screen = await mount(mountSearchScreen, ctx, 'title');
    const items = [...root.querySelectorAll('li')];
    check(items.map(el => el.querySelector('strong').textContent).join('|') === results.map(t => t.show).join('|'), 'Search changed provider order');
    check(items[0].textContent.includes('2 of 2 episodes · 2 times') && items[0].querySelector('[aria-label=Complete]'), 'Repeat total missing');
    check(items[1].textContent.includes('Not watched') && items[4].textContent.includes('1 episode'), 'List-only and unknown titles need fallback counts');
    check(items[6].textContent.includes('1 of 2 episodes') && !items[7].textContent.includes('times'), 'Pre-aired mark or first completion inflated results');
    check(items[8].textContent.includes('1 episode') && !items[8].textContent.includes(' of '), 'No aired episodes should show the row count alone');
    const actions = () => [...root.querySelectorAll('.result-mark')].map(button =>
      button.closest('li').dataset.show + '/' + button.textContent).join(',');
    check(actions() === '1/Rewatch,2/Mark watched,7/Mark watched,8/Rewatch',
      'Eligibility used the wrong first air date, specials, missing show or recorded rows');
    const button = items[6].querySelector('.result-mark');
    button.focus(); button.click();
    await until(() => button.textContent === 'Rewatch', 'Completing a search result did not offer a rewatch');
    check(doc.activeElement === button && button.nextElementSibling === items[6].querySelector('.result-drop') &&
      button.nextElementSibling.nextElementSibling === items[6].querySelector('.result-list'),
      'Completing a result moved the watch button or lost keyboard focus');
    button.click();
    await until(() => marks.length === 2, 'Rewatch did not dispatch a second action');
    check(marks[1][0] === 7 && marks[1][2] === 'rewatch-complete' && !routes.length,
      'Rewatch must check the show is still complete and stay on Search');
    items[1].querySelector('a').click();
    check(marks[0]?.[0] === 7 && marks[0]?.[2] === 'mark' && routes[0]?.id === 2, 'Result actions targeted the wrong show');
    // Losing the connection preserves Search results already on screen.
    const partialCache = show(2, 'Empty', [[1,[past,past]]]);
    delete partialCache.seasons[0].episodes;
    partialCache.lastAired = {season:1, episode:2};
    details.set(2, partialCache);
    details.set(7, show(7, 'First viewing', [[1,[past,past,future,past]]]));
    details.set(8, {...details.get(8), seasons:[{season:1,episodeCount:1}], lastAired:{season:1,episode:1}});
    service.environment.online = () => false;
    await screen.refresh();
    check(actions() === '1/Rewatch,7/Mark watched', 'Offline Search offered a bulk watch without the required episodes, or hid a cached one');
    details.delete(2);
    await screen.refresh();
    check(actions() === '1/Rewatch,7/Mark watched', 'Offline Search offered a bulk watch for an uncached show');
    service.environment.online = () => true;
    await screen.refresh();
    check(actions() === '1/Rewatch,2/Mark watched,7/Mark watched,8/Rewatch', 'Reconnecting did not restore Search marking');
    service.store.role = 'reader';
    await screen.refresh();
    check(actions() === '', 'A read-only Search offered to record a watch');
  }));

  await run('Search drops and picks up watched or unwatched shows in place, including Undo and reader mode', () =>
    inViewport(async ({root,doc,frame,mount}) => {
      const {ctx,service,details,routes} = environment();
      const store = await openDeviceStore({name:'csvtv-search-drop-'+crypto.randomUUID()});
      const edits = new TmdbService(store);
      let bar;
      ctx.watch = new WatchActions(edits,async()=>false,value=>{ bar = value; },()=>{});
      try {
        const record = await store.whenWriter();
        await store.commit(record.revision,{put:{
          watched:[row(2,'Summer Signal',1,3)],
          lists:[{show_id:1,show:'Early Signal',list:'Watchlist'},
            {show_id:2,show:'Summer Signal',list:'sToPpEd'},{show_id:2,show:'Summer Signal',list:'Weekend'}],
        }});
        service.store.searchRecords = ids => store.searchRecords(ids);
        details.set(2,show(2,'Summer Signal',[[1,[past]]]));
        service.reply = () => ({status:'ready',value:{page:1,totalPages:1,
          results:[title(1,'Early Signal',future),title(2,'Summer Signal')]}});
        const screen = await mount(mountSearchScreen,ctx,'signal');
        const [early,summer] = [...root.querySelectorAll('.result-drop')];
        const watch = root.querySelector('[data-show="2"] .result-mark');
        check(early.textContent === 'Drop' && summer.textContent === 'Pick Up' && watch.textContent === 'Rewatch' &&
          !root.querySelector('[data-show="1"] .result-mark'),'Search confused dropped status, eligibility and watched status');
        for (const width of [320,1440]) {
          frame.width = String(width);
          check(doc.documentElement.scrollWidth <= frame.clientWidth,'Search result actions overflow at '+width+'px');
        }
        const membership = async id => (await store.tmdbRows(id)).tables.lists.map(r=>r.list);
        early.focus(); early.click(); early.click();
        await until(()=>early.textContent === 'Pick Up' && early.getAttribute('aria-disabled')==='false','Drop did not update in place');
        check(bar?.label === 'Show dropped' && !upcomingReason(await membership(1)) && doc.activeElement === early,
          'Dropping an unwatched result did not suppress Watchlist or preserve focus and Undo');
        await ctx.watch.undo(); await screen.refresh();
        check(early.textContent === 'Drop' && upcomingReason(await membership(1)) === 'watchlist','Undo lost the prior Watchlist membership');
        service.environment.online = () => false;
        await screen.refresh();
        summer.focus(); summer.click();
        await until(()=>summer.textContent === 'Drop' && summer.getAttribute('aria-disabled')==='false','Pick Up failed offline');
        check(bar?.label === 'Show picked up' && (await membership(2)).includes('Weekend') && doc.activeElement===summer &&
          (await store.tmdbRows(2)).tables.watched[0].times_watched === 3 && watch.textContent==='Rewatch' && !routes.length,
          'Picking up a result lost watches, list membership, focus or Search');
        await ctx.watch.undo(); await screen.refresh();
        check(summer.textContent === 'Pick Up' && watch.isConnected,'Undo did not restore the result or replaced its watch button');
        service.store.role = 'reader';
        await screen.refresh();
        check(early.disabled && summer.disabled && doc.activeElement === summer.closest('li').querySelector('a'),
          'A reader could edit a Search result or lost keyboard focus when the writer changed');
      } finally { edits.close(); store.close(); }
    }));

  await run('Search debounce, immediate submit, and ignoring an old response', () => inViewport(async ({ root, mount }) => {
    const { ctx, calls, service, queries } = environment();
    let finishOld;
    const answer = query => ({ status: 'ready', value: { page: 1, totalPages: 1, results: [title(3, query)] } });
    service.reply = request => request.query === 'slow' ? new Promise(resolve => { finishOld = resolve; }) : answer(request.query);
    await mount(mountSearchScreen, ctx);
    const input = root.querySelector('input');
    const type = value => { input.value = value; input.dispatchEvent(new Event('input')); };
    type('s'); await wait(100); type('slow');
    await wait(250);
    check(!calls.length, 'Search fired before typing stopped for half a second');
    await until(() => !!finishOld, 'Search did not run after typing stopped');
    type('immediate');
    root.querySelector('form').requestSubmit();
    await until(() => root.querySelector('strong')?.textContent === 'immediate', 'Submit did not send immediately');
    finishOld(answer('obsolete'));
    await wait(520);
    check(calls.map(r => r.query).join() === 'slow,immediate' && root.querySelector('strong').textContent === 'immediate', 'Stale result rendered or debounce resent a submitted query');
    type(' ');
    await until(() => root.textContent.includes('Enter a show title'), 'Blank search did not clear results');
    check(!root.querySelector('li') && queries.join('|') === 's|slow|immediate| ', 'Search URL/query updates lost the displayed input');
    const previousCalls = calls.length, previousQueries = queries.length;
    input.dispatchEvent(new Event('compositionstart'));
    type('ほし');
    root.querySelector('form').requestSubmit();
    await wait(550);
    check(calls.length === previousCalls && queries.length === previousQueries, 'Uncommitted IME text was searched or bookmarked');
    input.value = '星';
    input.dispatchEvent(new Event('compositionend'));
    await until(() => root.querySelector('strong')?.textContent === '星', 'Committed IME text did not reach Search');
    check(calls.length === previousCalls + 1 && queries.at(-1) === '星', 'Committed IME text did not produce exactly one request');
  }));

  await run('Search retries page one when reconnection precedes the original offline reply', () => inViewport(async ({ root, mount }) => {
    for (const initiallyOnline of [false, true]) {
      const { ctx, service, calls } = environment();
      const pending = Promise.withResolvers();
      let online = initiallyOnline;
      service.environment.online = () => online;
      service.reply = () => calls.length === 1 ? pending.promise : ({
        status:'ready', value:{page:1,totalPages:1,results:[title(7, 'Reconnected')]}
      });
      const screen = await mount(mountSearchScreen, ctx);
      const field = root.querySelector('input');
      field.value = 'show'; field.dispatchEvent(new Event('input'));
      root.querySelector('form').requestSubmit();
      await until(() => calls.length === 1, 'Search did not start');
      online = false;
      await screen.refresh();
      online = true;
      await screen.refresh();
      pending.resolve({status:'offline',value:null});
      await until(() => root.querySelector('.result-link')?.textContent.includes('Reconnected'), 'Reconnection lost the first page');
      check(calls.map(call => call.page).join() === '1,1', 'First page was requested more than once after reconnect');
    }
  }));

  await run('Rapid full search pages and leaving pending requests preserve the final results', () => inViewport(async ({root,mount}) => {
    const {ctx,service,calls} = environment(), pending = new Map(), activeQueries = new Map();
    const answer = query => ({status:'ready',value:{page:1,totalPages:1,results:
      Array.from({length:20},(_,i)=>title(i+1,query+' '+i))}});
    service.store.snapshot = () => { throw Error('Search should only read the record of its result IDs'); };
    service.reply = ({query},current) => {
      activeQueries.set(query,current);
      if (!query.startsWith('hold')) return answer(query);
      const gate = Promise.withResolvers();
      pending.set(query,gate);
      return gate.promise;
    };
    const mine = service.store.searchRecords.bind(service.store), hold = Promise.withResolvers();
    service.store.searchRecords = async ids => { await hold.promise; return mine(ids); };
    const mounted = mount(mountSearchScreen,ctx,'initial');
    await until(()=>root.querySelectorAll('.result-link').length === 20,'Titles waited for the watch history');
    const firstLink = root.querySelector('.result-link');
    check(firstLink.getAttribute('href') === '#/show/1' && !root.querySelector('.result-mark,.result-drop:not([hidden]),.result-list:enabled') &&
      !root.querySelector('.result-counts').textContent.includes('Not watched'), 'An incomplete record suggested a watch action');
    firstLink.focus();
    hold.resolve(); await mounted;
    check(firstLink === root.querySelector('.result-link') && firstLink === root.ownerDocument.activeElement &&
      !!root.querySelector('.result-list:enabled'), 'Completing personal data replaced or disabled the selected title');
    service.store.searchRecords = mine;
    const input = root.querySelector('input');
    const enter = query => {
      input.value = query; input.dispatchEvent(new Event('input')); root.querySelector('form').requestSubmit();
    };
    const read = service.read;
    let obsolete;
    const scoreSignals = new Map();
    const waitForCancel = (source,signal) => {
      scoreSignals.set(source,signal);
      return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
    };
    ctx.critics = {keyStatus:async()=>undefined,read:(_ids,signal)=>waitForCancel('critics',signal)};
    ctx.imdb = {sourceStatus:async()=>undefined,readShows:(_ids,_deadline,_headers,signal)=>waitForCancel('imdb',signal)};
    ctx.mal = {read:(_ids,signal)=>waitForCancel('mal',signal)};
    service.read = async function(resource,signal) {
      if (resource.kind !== 'show') return read.call(this,resource,signal);
      this.read = read;
      obsolete = signal;
      await new Promise(resolve => signal.addEventListener('abort',resolve,{once:true}));
      signal.throwIfAborted();
    };
    enter('delayed-local-metadata');
    await until(()=>obsolete,'Search did not start its local metadata read');
    for (let i=0; i<6; i++) {
      enter('hold'+i);
      await until(() => pending.has('hold'+i),'A submitted search did not start');
    }
    check(obsolete.aborted,'Changing the query left its previous record and season reads running');
    check(scoreSignals.size === 3 && [...scoreSignals.values()].every(signal=>signal === obsolete && signal.aborted),
      'Changing the query kept an optional score read alive');
    delete ctx.critics; delete ctx.imdb; delete ctx.mal;
    enter('latest');
    await until(() => root.querySelector('.result-link strong')?.textContent === 'latest 0','Missing latest search page');
    const finalRows = [...root.querySelectorAll('.tv-results li')];
    check(activeQueries.get('latest')() && [...pending.keys()].every(query => !activeQueries.get(query)()),
      'Changing the query kept obsolete provider requests eligible');
    for (const [query,gate] of [...pending].reverse()) gate.resolve(answer(query));
    await wait(20);
    check(finalRows.length === 20 && [...root.querySelectorAll('.tv-results li')].every((row,i) => row === finalRows[i] &&
      row.querySelector('strong').textContent === 'latest '+i),'A late full page repainted the current search');
    enter('hold-after-leaving');
    await until(() => pending.has('hold-after-leaving'),'Missing final held search');
    input.value = 'unsent'; input.dispatchEvent(new Event('input'));
    await mount(mountSearchScreen,ctx,'replacement');
    pending.get('hold-after-leaving').resolve(answer('stale'));
    check(!activeQueries.get('hold-after-leaving')() && activeQueries.get('replacement')(),
      'Leaving Search kept a former provider request eligible');
    await wait(550);
    check(root.querySelector('.result-link strong').textContent === 'replacement 0' && !calls.some(call=>call.query==='unsent'),
      'A disposed screen painted its late reply or sent its previous debounce');
  }));

  await run('Search keeps results, focus and row positions steady during slow score reads and query changes', () =>
    inViewport(async ({root,doc,frame,mount}) => {
      for (const width of [390,1440]) {
        frame.width = String(width);
        const {ctx,service,calls} = environment();
        let scores = Promise.withResolvers();
        const nextQuery = Promise.withResolvers();
        const cachedScores = new Map([[1,{tomatoes:80,metacritic:70,myanimelist:7.5}]]);
        ctx.critics = {keyStatus:async () => ({status:'ready',generation:1n}),
          read:() => scores.promise, refresh:async () => {}};
        const result = results => ({status:'ready',value:{page:1,totalPages:1,results}});
        service.reply = ({query}) => query === 'first' ? result([title(1,'First show'),title(2,'Second show')]) : nextQuery.promise;
        const screen = await mount(mountSearchScreen,ctx,'first');
        const first = root.querySelector('[data-show="1"]'), second = root.querySelector('[data-show="2"]');
        const poster = first.querySelector('.tv-poster'), listButton = first.querySelector('.result-list');
        listButton.focus({preventScroll:true});
        const offset = () => second.getBoundingClientRect().top - first.getBoundingClientRect().top;
        const y = offset();
        scores.resolve(cachedScores);
        await until(() => first.querySelector('.metacritic-score')?.textContent === '70','The first score never appeared');
        check(Math.abs(offset() - y) < 1, width+'px: the next row jumped when scores arrived');
        scores = Promise.withResolvers();
        await screen.refresh();
        check(first.isConnected && first.querySelector('.tv-poster') === poster && doc.activeElement === listButton,
          width+'px: refreshing rebuilt a result, poster or focused action');
        check(first.querySelector('.metacritic-score')?.textContent === '70','A pending score refresh erased the last known score');
        scores.resolve(cachedScores);
        const field = root.querySelector('input');
        field.focus(); field.value = 'refined'; field.dispatchEvent(new Event('input'));
        root.querySelector('form').requestSubmit();
        await until(() => calls.some(request => request.query === 'refined'),'The new query did not start');
        check(first.isConnected && second.isConnected, 'Typing a new title blanked the previous results');
        nextQuery.resolve(result([title(3,'New result')]));
        await until(() => root.querySelector('[data-show="3"]'), 'Replacement results did not appear');
        check(!first.isConnected && !second.isConnected && doc.activeElement === field, 'The ready query retained unrelated results or moved focus');
        field.value = ''; field.dispatchEvent(new Event('input'));
        await until(() => !root.querySelector('.tv-results li'), 'Clearing Search retained results');
      }
    }));

  await run('Search loads the next provider page on reaching the end', () => inViewport(async ({ root, mount }) => {
    const { ctx, calls, service } = environment();
    let online = true, recovering = false;
    service.environment.online = () => online;
    service.reply = ({ page }) => !online ? {status:'offline', value:null} :
      recovering ? {status:'unavailable', value:null} : ({
      status: 'ready', value: { page, totalPages: 2, results: page === 1 ?
        Array.from({ length: 20 }, (_, i) => title(i + 1, 'Series ' + (i + 1))) : [title(20, 'Series 20'), title(21, 'Series 21')] },
    });
    const screen = await mount(mountSearchScreen, ctx, 'series');
    const firstPage = [...root.querySelectorAll('li')];
    check(firstPage.length === 20 && calls.length === 1, 'Search prefetched beyond the first page');
    recovering = true; // The request fails before the browser reports that connectivity changed.
    root.querySelector('.next-results').scrollIntoView();
    await until(() => root.querySelector('[data-state] button')?.textContent === 'Try again', 'A failed second page had no recovery');
    online = false;
    await screen.refresh();
    check(calls.length === 2 && root.querySelectorAll('li').length === 20, 'An unrelated redraw dropped results or retried offline');
    online = true;
    await screen.refresh();
    check(calls.length === 3 && root.querySelector('[data-state] button')?.textContent === 'Try again',
      'Reconnecting did not retry the interrupted page');
    recovering = false;
    root.querySelector('form').requestSubmit();
    await until(() => root.querySelectorAll('li').length === 21, 'Reaching the end failed to fetch the second page');
    check(firstPage.every((row,i) => root.querySelector('.tv-results').children[i] === row), 'Appending a page repainted earlier results');
    check(calls.map(r => r.page).join() === '1,2,2,2' && root.querySelector('.next-results').hidden,
      'Retrying a page skipped results, refetched page one or exceeded the last page');
    const held = Promise.withResolvers(), env = environment();
    env.service.reply = ({page}) => page === 1 ? {status:'ready',value:{page,totalPages:2,
      results:Array.from({length:20},(_,i) => title(i+1,'Series '+(i+1)))}} : held.promise;
    await mount(mountSearchScreen,env.ctx,'series');
    const more = root.querySelector('.next-results'), doc = root.ownerDocument;
    more.focus({preventScroll:true}); more.click();
    check(doc.activeElement === more && !more.hidden, 'Loading another page discarded keyboard focus');
    held.resolve({status:'ready',value:{page:2,totalPages:2,results:[title(21,'New series')]}});
    await until(() => more.hidden,'Final search page still offered Load more');
    check(doc.activeElement === root.querySelector('[data-show="21"] a'), 'Keyboard loading skipped the first added result');
    const failed = environment(), failedCounts = Promise.withResolvers();
    const readProgress = failed.service.store.searchRecords;
    failed.service.store.searchRecords = ids => ids.includes(2) ? failedCounts.promise : readProgress(ids);
    failed.service.reply = ({page}) => ({status:'ready',value:{page,totalPages:2,results:[title(page,'Station '+page)]}});
    await mount(mountSearchScreen,failed.ctx,'station');
    const original = root.querySelector('.result-link');
    root.querySelector('.next-results').click();
    await until(()=>root.querySelector('[data-show="2"] a'),'An appended title waited for its personal counts');
    failedCounts.reject(Error('Fictional read failure'));
    await until(()=>root.querySelector('[data-state] button')?.textContent === 'Try again','A failed appended projection had no retry');
    check(!root.querySelector('[data-show="2"]') && root.querySelector('.result-link') === original,
      'A failed appended projection left an unusable result or replaced the previous page');

    const limited=environment(),now=new Date(2026,10,18,22,55,0,100).getTime();
    limited.service.environment.now=()=>now;
    const sameDay=new Date(2026,10,18,22,55,25,100),tomorrow=new Date(2026,10,19,2,10,15);
    let retryAt=sameDay.getTime();
    limited.service.reply=()=>({status:'unavailable',value:null,retryAt});
    await mount(mountSearchScreen,limited.ctx,'fictional');
    const message=()=>root.querySelector('[data-state] [role=status]')?.textContent;
    const retry=()=>root.querySelector('[data-state] button').click();
    const second=new Date(sameDay.getTime()+900);
    check(message()==='TMDB paused lookups until '+second.toLocaleTimeString(undefined,{timeStyle:'medium'})+'.',
      'Search omitted the local retry time or displayed an early second');
    retryAt=tomorrow.getTime();retry();
    await until(()=>message()==='TMDB paused lookups until '+tomorrow.toLocaleString(undefined,{dateStyle:'medium',timeStyle:'medium'})+'.',
      'A next-day retry omitted the date');
    retryAt=undefined;retry();
    await until(()=>message()==='Cannot reach TMDB.','An ordinary network failure inherited an old retry deadline');
    limited.service.reply=()=>({status:'ready',value:{page:1,totalPages:1,results:[title(17,'Recovered title')]}});
    retry();
    await until(()=>root.querySelector('[data-show="17"]'),'The deadline hint disabled the normal retry');
  }));

  await run('Search reuses settled watch counts on pagination and includes older pages when an edit is pending', () =>
    inViewport(async ({root,mount}) => {
      const {ctx,service,tables} = environment();
      const calls = [], watchRows = service.store.searchRecords;
      const pause = Promise.withResolvers();
      let slow = false;
      service.store.searchRecords = async ids => {
        calls.push([...ids]);
        const old = await watchRows(ids);
        if (slow) { slow = false; await pause.promise; }
        return old;
      };
      const makePage = n => Array.from({length:20},(_,i)=>title(20*(n-1)+i+1,'Series '+(20*(n-1)+i+1)));
      service.reply = ({page})=>({status:'ready',value:{page,totalPages:3,results:makePage(page)}});
      const screen = await mount(mountSearchScreen,ctx,'series');
      const more = root.querySelector('.next-results');
      more.click();
      await until(()=>root.querySelector('[data-show="40"] .result-list:enabled'),'Second page did not finish');
      check(calls.length===2 && calls[1].length===20 && calls[1][0]===21,'Second page reread existing watch counts');
      slow = true;
      const refresh = screen.refresh();
      await until(()=>calls.length===3,'Existing-page refresh did not start');
      tables.watched.push(row(1,'Series 1'));
      try {
        more.click();
        await until(()=>root.querySelector('[data-show="60"] .result-list:enabled'),'An older read blocked pagination');
        check(calls[3]?.length===60 && root.querySelector('[data-show="1"] .result-counts').textContent.includes('1 episode'),
          'Pagination skipped a previous page while its personal record was being refreshed');
      } finally { pause.resolve(); await refresh; }
      check(root.querySelector('[data-show="1"] .result-counts').textContent.includes('1 episode'),
        'A late refresh restored an older watch count');

      const later = environment(), readAgain = later.service.store.searchRecords;
      let day = 18, online = true;
      later.service.environment.now = () => new Date(2026,10,day,12).getTime();
      later.service.environment.online = () => online;
      later.service.reply = ({page})=>({status:'ready',value:{page,totalPages:4,results:makePage(page)}});
      later.details.set(1,show(1,'Series 1',[[1,['2026-11-19']]]));
      const rereads = [];
      later.service.store.searchRecords = ids=>{ rereads.push(ids.length); return readAgain(ids); };
      await mount(mountSearchScreen,later.ctx,'series');
      const next = root.querySelector('.next-results');
      check(!root.querySelector('[data-show="1"] .result-mark'),'A future episode was markable');
      day++; next.click();
      await until(()=>root.querySelector('[data-show="40"] .result-list:enabled'),'Second day did not finish');
      check(root.querySelector('[data-show="1"] .result-mark'),'Yesterday’s result did not notice the new airing');
      online = false; next.click();
      await until(()=>root.querySelector('[data-show="60"] .result-list:enabled'),'Offline page did not finish');
      check(!root.querySelector('[data-show="2"] .result-mark'),'An uncached result remained markable offline');
      later.service.store.role = 'reader'; next.click();
      await until(()=>next.hidden && next.getAttribute('aria-disabled')==='false' && root.querySelector('[data-show="80"]'),
        'Reader page did not finish');
      check(!root.querySelector('.result-list:enabled') && rereads.join() === '20,40,60,80',
        'Navigation to a new search page kept an earlier day, connection state or writer role');
    }));

  await run('Search requests just the new shows on each page and draws only the available critic scores', () => inViewport(async ({ root, frame, mount }) => {
    const { ctx, service } = environment();
    service.environment.online = () => true;
    const calls = [], scores = new Map([
      [1, { tomatoes: 60, metacritic: 61 }], [2, { tomatoes: 59, metacritic: 60 }],
      [3, { tomatoes: null, metacritic: 40 }], [4, { tomatoes: 0, metacritic: 39 }],
    ]);
    let status = 'ready', generation = 1n;
    let finish;
    const slow = new Promise(resolve => { finish = resolve; });
    ctx.critics = {
      keyStatus: async () => ({ status, generation }),
      read: async ids => new Map(ids.filter(id => status !== 'missing-key' && scores.has(id)).map(id => [id, scores.get(id)])),
      refresh: async ids => { calls.push([...ids]); await slow; },
    };
    service.reply = ({ page, query }) => ({ status: 'ready', value: { page, totalPages: query === 'new' ? 1 : 2,
      results: query === 'new' ? [title(22, 'New series')] : page === 1 ?
        Array.from({ length: 20 }, (_, i) => title(i + 1, 'Series ' + (i + 1))) : [title(20, 'Series 20'), title(21, 'Series 21')] } });
    const screen = await mount(mountSearchScreen, ctx, 'series');
    const bands = () => [...root.querySelectorAll('.metacritic-score')].map(mark =>
      [mark.textContent, mark.dataset.band, frame.contentWindow.getComputedStyle(mark).backgroundColor].join('/'));
    check(bands().join('|') === '61/green/rgb(12, 163, 12)|60/yellow/rgb(250, 178, 25)|40/yellow/rgb(250, 178, 25)|39/red/rgb(245, 69, 42)',
      'Metacritic thresholds or rendered colours differ from the score bands');
    check(root.querySelector('[data-show="1"] .tomatoes-score .score-red') && root.querySelector('[data-show="1"] .tomatoes-score').textContent === '60%' &&
      root.querySelector('[data-show="2"] .tomatoes-score circle') && root.querySelector('[data-show="4"] .tomatoes-score').textContent === '0%' &&
      !root.querySelector('[data-show="3"] .tomatoes-score') && !root.querySelector('[data-show="5"] .critic-marks'), 'Fresh/Rotten threshold, zero, or missing score');
    check(calls.length === 1 && calls[0].length === 20, 'A page did not submit its shows together');
    root.querySelector('.next-results').click();
    await until(() => calls.length === 2, 'A pending critic lookup blocked Search pagination');
    check(calls[1].join() === '21', 'The next results page requested old shows');
    const input = root.querySelector('input');
    input.value = 'new'; input.dispatchEvent(new Event('input')); root.querySelector('form').requestSubmit();
    await until(() => calls.length === 3, 'The next query waited for earlier scores');
    finish(); await screen.refresh();
    check(root.querySelectorAll('li').length === 1 && !root.querySelector('.critic-marks'), 'A finished old request painted the wrong result');
    scores.set(22, { tomatoes: null, metacritic: 0 }); await screen.refresh();
    check(root.querySelector('.metacritic-score').textContent === '0' && calls.length === 3, 'Cache update lost zero or refetched a page');
    status = 'missing-key'; generation++; await screen.refresh();
    check(!root.querySelector('.critic-marks') && calls.length === 3, 'Removing the key kept a mark or requested scores');
  }));

  await run('Search key, offline, loading, and empty states offer working controls', () => inViewport(async ({ root, mount }) => {
    const { ctx, service, calls, routes } = environment();
    service.status = 'missing-key';
    const screen = await mount(mountSearchScreen, ctx, 'query');
    check(root.textContent.includes('TMDB key is needed') && !calls.length, 'No-key search contacted TMDB');
    root.querySelector('[data-state] button').click();
    check(routes[0]?.page === 'settings', 'Missing-key control did not open Settings');
    service.status = 'refused'; await screen.refresh();
    check(root.textContent.includes('refused'), 'Refusal looked like a new installation');
    service.status = 'ready';
    service.reply = () => ({ status: 'unavailable', value: null });
    await screen.refresh();
    await screen.refresh();
    await screen.refresh();
    check(calls.length === 1, 'Unrelated refreshes retried a failed first results page');
    root.querySelector('form').requestSubmit();
    await until(() => calls.length === 2, 'Submitting the failed query did not retry');
    service.environment.online = () => false;
    service.reply = () => ({ status: 'offline', value: null });
    await screen.refresh();
    await screen.refresh();
    check(calls.length === 3, 'Offline transition or a later cache notification issued duplicate requests');
    service.environment.online = () => true;
    service.reply = () => ({ status: 'unavailable', value: null });
    await screen.refresh();
    check(calls.length === 4, 'A restored connection did not retry the failed query');
    const retry = root.querySelector('[data-state] button');
    check(retry?.textContent === 'Try again', 'Offline search lacks retry');
    let resolveReply;
    service.reply = () => new Promise(resolve => { resolveReply = resolve; });
    retry.click();
    check(root.querySelector('.skeleton'), 'Pending search lacks a loading state');
    resolveReply({ status: 'empty', value: { page: 1, totalPages: 0, results: [] } });
    await until(() => root.textContent.includes('No shows found.'), 'Empty search lacks a message');
  }));

  await run('A failed optional ratings read leaves Search usable, and a local read retries the same page', () => inViewport(async ({ root, mount }) => {
    const { ctx, service, calls } = environment();
    const unavailable = async () => { throw new DOMException('Fictional cache failure', 'UnknownError'); };
    ctx.imdb = { sourceStatus: unavailable, readShows: unavailable };
    ctx.critics = { keyStatus: async () => ({ status:'missing-key', generation:1n }), read: unavailable };
    ctx.mal = { read: unavailable };
    const readRecord = service.store.searchRecords;
    service.store.searchRecords = unavailable;
    service.reply = ({ page }) => {
      check(page === 1, 'Retry advanced past the last search page');
      return { status:'ready', value:{ page, totalPages:1, results:[title(81, 'Tide Signal')] } };
    };
    const screen = await mount(mountSearchScreen, ctx, 'tide');
    check(root.querySelector('[data-state]').textContent.includes('this device') &&
      !root.querySelector('li'), 'Could not distinguish a local record read failure from a TMDB failure');
    service.store.searchRecords = readRecord;
    root.querySelector('[data-state] button').click();
    await until(() => root.querySelector('.result-link strong')?.textContent === 'Tide Signal', 'A ratings cache hid the search result');
    check(calls.map(call => call.page).join() === '1,1' && root.querySelector('.next-results').hidden &&
      !root.querySelector('.outside-scores'), 'A failed optional score changed pagination or displayed a stale value');
    ctx.imdb = { sourceStatus:async () => ({ source:'omdb', generation:1n }), readShows:async () => new Map([[81,7.2]]),
      refreshShows:async () => {} };
    await screen.refresh();
    check(root.querySelector('.imdb-score')?.textContent === '7.2' && calls.length === 2, 'Recovered scores did not render from the existing TMDB page');
    const delayed = Promise.withResolvers();
    try {
      ctx.critics.keyStatus = () => delayed.promise.then(() => ({status:'missing-key'}));
      ctx.mal.read = () => delayed.promise;
      const search = root.querySelector('input');
      search.value = 'harbour'; search.dispatchEvent(new Event('input')); root.querySelector('form').requestSubmit();
      await until(() => calls.length === 3 && root.querySelector('.result-link strong')?.textContent === 'Tide Signal',
        'A suspended ratings source blocked the next TMDB search');
      check(root.querySelector('.imdb-score')?.textContent === '7.2', 'A suspended source hid an available score');
      delayed.resolve(new Map([[81,[{season:1,offset:0,malId:2,score:9.21}]]]));
      await until(() => root.querySelector('.myanimelist-score')?.textContent === '9.21', 'A late score never appeared');
    } finally { delayed.resolve(new Map()); }
  }));
}
