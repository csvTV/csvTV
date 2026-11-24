import { connectFixtureProviders } from './provider-fixture-cases.mjs';
import { openDeviceStore } from '../dist/storage.js';
import { tmdbResourceKey, TmdbClient } from '../dist/tmdb-client.js';
import { TmdbService } from '../dist/tmdb-service.js';
import { WatchActions } from '../dist/watch-actions.js';
import { mountWatchlistScreen } from '../dist/watch-views.js';

function check(value, message) { if (!value) throw new Error(message); }
async function until(probe,message) {
  const end = performance.now()+4000;
  while (!probe()) {
    if (performance.now()>end) throw Error(message);
    await new Promise(resolve=>setTimeout(resolve,10));
  }
}
const day = n => new Date(2026, 10, n, 12).getTime();
const watched = (id, episode = 1, season = 1, count = 1) => ({
  show_id: id, show: 'Filed ' + id, season, episode, episode_id: null, title: 'Episode ' + episode, times_watched: count,
});
const member = (id, list) => ({ show_id: id, show: 'Filed ' + id, list });
function show(id, title, aired, nextAirDate = null) {
  return { show_id: id, show: title, firstAirDate: '2024-05-01', posterPath: null,
    seasons: [{ season: 0, episodeCount: 2, name: 'Specials' }, { season: 1, episodeCount: Math.max(8, aired), name: 'Season 1' }],
    lastAired: aired ? { season: 1, episode: aired, airDate: '2026-11-17' } : null,
    nextEpisode: nextAirDate ? { season: 2, episode: 5, airDate: nextAirDate } : null, nextAirDate };
}

// Each view runs against a committed fictional record and a local cache after removing the test key.
async function exercise(fixture, body, width = 320) {
  let now = day(18);
  const name = 'csvtv-watch-views-' + crypto.randomUUID();
  const store = await openDeviceStore({ name });
  let requests = 0;
  const service = new TmdbService(store, new TmdbClient({ fetch() { requests++; throw Error('Unexpected external call'); } }),
    { now: () => now, visible: () => true, online: () => false });
  const frame = document.createElement('iframe');
  frame.width = String(width);
  frame.height = '600';
  const loaded = new Promise(resolve => frame.addEventListener('load', resolve, { once: true }));
  frame.src = '/screen-fixture';
  document.body.append(frame);
  let screen;
  try {
    const initial = await connectFixtureProviders(store,name,[{setting:'tmdb_key',value:'fictional-view-key'}]);
    const titles = new Map(fixture.shows.map(show => [show.show_id, show.show]));
    const personal = {};
    for (const [table, rows] of Object.entries(fixture.tables)) {
      personal[table] = rows.map(row => ({ ...row, show: fixture.filedNames?.[row.show_id] ?? titles.get(row.show_id) ?? row.show }));
    }
    await store.commit(initial.revision, { put: { ...personal } });
    const entries = {};
    function cache(resource, value) { entries[tmdbResourceKey(resource)] = { value, fetchedAt: now }; }
    for (const item of fixture.shows) cache({ kind: 'show', id: item.show_id }, item);
    for (const id of fixture.missing ?? []) cache({ kind: 'show', id }, null);
    for (const season of fixture.seasons ?? []) cache({ kind: 'season', id: season.show_id, season: season.season }, season);
    const generation = (await store.tmdbState()).generation;
    check(await store.writeTmdb(generation, { entries }), 'Cache was not installed');
    await service.removeKey(generation);
    await loaded;
    const doc = frame.contentDocument, root = doc.querySelector('#app');
    const saved = [], routes = [];
    let pending;
    const watch = new WatchActions(service, async () => false, () => {}, () => {});
    const context = { service, watch, go: route => routes.push(route), saveView: state => saved.push(state),
      run(action) { pending = action(); return pending; } };
    async function open(sort) {
      screen?.dispose();
      screen = mountWatchlistScreen(root, context, sort);
      await screen.ready;
    }
    await open();
    const find = (selector, host = root) => host.querySelector(selector);
    const ids = (host = root) => Array.from(host.querySelectorAll('.watch-rows a'), link => Number(link.hash.split('/').at(-1))).join(',');
    const link = (id, host = root) => find('a[href="#/show/' + id + '"]',host);
    const refresh = () => screen.refresh();
    async function commit(patch) {
      await store.commit((await store.snapshot()).revision, patch);
      await refresh();
    }
    async function remove(id) {
      const button = find('[data-watchlist-remove="' + id + '"]');
      button.focus(); button.click(); await pending;
    }
    async function drop(id) {
      const button = find('[data-more-drop="' + id + '"]');
      button.focus(); button.click();
      const first = pending;
      button.click();
      await first;
    }
    async function undo() { await watch.undo(); await refresh(); }
    async function toggleDensity() { find('.watch-density').click(); await pending; }
    await body({ root, doc, frame, saved, routes, store, find, ids, link, open, commit, refresh, remove, drop, undo, toggleDensity,
      leave:() => { screen.dispose(); root.replaceChildren(); }, setDay: n => { now = day(n); } });
    check(requests === 0, 'A local view attempted to contact TMDB');
  } finally {
    screen?.dispose();
    frame.remove();
    service.close();
    store.close();
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = resolve;
      request.onerror = () => reject(request.error);
    });
  }
}

const more = {
  filedNames: { 1: 'Amber <em>Archive</em>' },
  shows: [show(1, 'Renamed in metadata', 6), show(2, 'Zinc Harbour', 3), show(3, 'Echo Post', 2),
    show(4, 'Already done', 1), show(5, 'Special alone', 0), show(6, 'On hold', 3)],
  seasons: [{ show_id: 1, season: 1, name: 'Season 1',
    episodes: ['2025-01-01', '2025-01-03', '2026-11-18', '2026-11-19', null].map((airDate, i) =>
      ({ episode: i + 1, episode_id: 6601 + i, title: 'Chapter ' + (i + 1), airDate })) }],
  missing: [7, 9, 11],
  tables: {
    watched: [watched(1, 1, 1, 9), watched(1, 4), watched(1, 1, 0), watched(2), watched(2, 2),
      watched(3), watched(4), watched(5, 1, 0), watched(6), watched(7), watched(8), watched(11)],
    lists: [member(6, 'sToPpEd'), member(9, 'WATCHLIST'), member(10, 'Saved for later'), member(11, 'STOPPED')],
    ratings: [{ show_id: 12, show: 'Rating only', rating: 8 }],
  },
};

export async function watchViewCases(run) {
  await run('Watchlist paints committed memberships before schedules and ignores older or disposed reads', () =>
    exercise({shows:[show(1,'Aired',2),{...show(2,'Future',0),firstAirDate:'2027-01-01'},show(3,'Dropped',2),show(4,'Hidden',1),
      {...show(5,'Finished serial',2),status:'Ended'}],
      tables:{watched:[watched(5),watched(5,2),watched(6,1,0)],lists:[member(1,'Watchlist'),member(2,'Following upcoming'),
        member(3,'Watchlist'),member(3,'Stopped'),member(4,'Watchlist'),member(4,'Hidden from upcoming'),
        member(5,'Watchlist'),member(6,'Following upcoming')]}},
    async ({root,store,doc,open,find,commit,leave}) => {
      const read = store.tmdbEntries.bind(store), gates = [];
      store.tmdbEntries = async (keys,...args) => {
        if (keys.some(key=>/^tv\/\d+\?/.test(key))) {
          const gate = Promise.withResolvers(); gates.push(gate); await gate.promise;
        }
        return read(keys,...args);
      };
      try {
        const first = open();
        await until(() => gates.length && find('[data-pending-schedule]'),'Membership was blocked by the season cache');
        check([...root.querySelectorAll('[data-watchlist-remove]')].map(b=>b.dataset.watchlistRemove).join() === '1,2' &&
          !find('[data-section=upcoming]') && !find('[data-section=available]') && !find('[data-section=more-to-watch] li'),
          'A watched, opted-out, or dropped title appeared in the interim Watchlist');
        find('[data-watchlist-remove="2"]').focus();
        const edit = commit({put:{watched:[watched(1)]}});
        await until(() => gates.length >= 2 && !find('[data-watchlist-remove="1"]'),'A first watch stayed visible behind the first schedule read');
        gates[0].resolve(); await first;
        check(!find('[data-watchlist-remove="1"]') && doc.activeElement === find('[data-watchlist-remove="2"]'),
          'The old schedule restored a removed show or lost keyboard focus');
        store.tmdbEntries = read;
        gates[1].resolve(); await edit;
        check(find('[data-section=upcoming] a')?.hash === '#/show/2' && !find('[data-pending-schedule]') && !find('[data-section=available]') &&
          find('[data-more-drop="1"]') && !find('a[href="#/show/5"]') && !find('a[href="#/show/6"]'),
          'The pending or completed show appeared in the wrong section after loading');
        check(doc.activeElement === find('[data-watchlist-remove="2"]'),'Moving a saved show into its final section lost focus');
        const hold = Promise.withResolvers();
        store.tmdbEntries = async (...args) => { await hold.promise; return read(...args); };
        const departing = open();
        try {
          await until(() => find('[data-pending-schedule]'),'Could not reopen the staged Watchlist');
          leave();
        } finally { hold.resolve(); await departing; }
        check(!root.querySelector('.watch-rows'),'A disposed Watchlist replaced the next page');
      } finally {
        store.tmdbEntries = read;
        for (const gate of gates) gate.resolve();
      }
    }));
  await run('Watchlist and More to watch share compact rows with readable dates, progress and phone-sized actions', async () => {
    const fixture = {
      shows:[show(50,'After the River',3), {...show(51,'Quiet Sky',0,'2026-12-01'),firstAirDate:'2026-12-01'}, show(52,'Later Waves',3),
        {...show(53,'Further East',0,'2026-12-02'),firstAirDate:'2026-12-02'},show(54,'Started serial',3),show(55,'Another season',2)],
      tables:{watched:[watched(54),watched(55)], lists:[member(50,'Watchlist'), member(51,'Following upcoming'),
        member(52,'Watchlist'), member(53,'Watchlist')]},
    };
    for (const width of [320,1080]) await exercise(fixture,async ({root,doc,frame,find,link,open,refresh,toggleDensity}) => {
      const rect = element => element.getBoundingClientRect();
      const normal = rect(link(50)).height;
      function rowsFit() {
        for (const section of root.querySelectorAll('[data-section]')) {
          const [first,second] = Array.from(section.querySelectorAll('.watch-rows li'), rect);
          check(width === 320 ? second.top >= first.bottom : second.top === first.top && second.left > first.right,
            'Incorrect card columns for ' + section.dataset.section + ' at ' + width);
        }
      }
      rowsFit();
      const button = find('.watch-density');
      check(button.getAttribute('aria-pressed') === 'false' && rect(find('.tv-poster',link(50))).width > 0,
        'The default Watchlist lost its posters');
      button.focus();
      await toggleDensity();
      rowsFit();
      check(button.getAttribute('aria-pressed') === 'true' && doc.activeElement === button, 'Compact toggle state or focus was lost');
      for (const id of [50,51]) {
        const row = link(id);
        const height = rect(row).height;
        check(height >= 44 && height <= normal - 14 && rect(find('.tv-poster',row)).width === 0, 'Compact row was not shorter');
        check(rect(find('[data-watchlist-remove="'+id+'"]')).height >= 44, 'Shrinking the row shrank its remove target');
      }
      check(link(50).textContent.includes('3 aired episodes to watch') && find('time',link(51)).dateTime === '2026-12-01',
        'Compact Watchlist dropped the episode count or air date');
      const moreRow = link(54,find('[data-section=more-to-watch]'));
      check(root.querySelectorAll('.watch-density').length === 1 && rect(moreRow).height < normal &&
        moreRow.textContent.includes('1 of 3 aired episodes') && moreRow.textContent.endsWith('2 left'),
        'More to watch lost the shared density or progress');
      const drop = find('[data-more-drop="54"]');
      check(drop.parentNode === moreRow.parentNode && !moreRow.contains(drop) && rect(drop).height >= 44 &&
        drop.getAttribute('aria-label') === 'Drop ' + find('strong',moreRow).textContent,
        'Compact More to watch lost the separate labelled Drop target');
      moreRow.focus();
      await refresh();
      check(doc.activeElement === link(54,find('[data-section=more-to-watch]')),
        'Refreshing lost the focused More to watch show');
      check(doc.documentElement.scrollWidth <= frame.clientWidth, 'The controls overflowed at ' + width);
      await toggleDensity();
      await open();
      check(find('.watch-density').getAttribute('aria-pressed') === 'false' && rect(link(50)).height === normal,
        'Returning to Watchlist did not restore comfortable rows');
    },width);
  });
  await run('Dropping a More to watch row keeps the watch record, focuses the next row and supports Undo', () =>
    exercise({shows:[show(1,'Amber',3),show(2,'Birch',3)],tables:{
      watched:[watched(1,1,1,4),watched(2)], ratings:[{show_id:1,show:'Amber',rating:8}],
      lists:[member(1,'Favorites'),member(1,'Watchlist'),member(1,'Weekends')],
    }}, async ({doc,find,ids,routes,store,drop,undo,leave}) => {
      const more = find('[data-section=more-to-watch]');
      const before = (await store.snapshot()).tables;
      const first = find('[data-more-drop="1"]');
      check(first.title === 'Drop Amber' && first.textContent === '×' && ids(more) === '1,2', 'Missing Drop control');
      await drop(1);
      const after = (await store.snapshot()).tables;
      check(!routes.length && ids(more) === '2' && !find('[data-watchlist-remove="1"]') &&
        doc.activeElement === find('[data-more-drop="2"]'), 'Dropping the first show navigated or lost the next control');
      check(after.lists.filter(r=>r.list==='Dropped' && r.show_id===1).length === 1 &&
        JSON.stringify(after.lists.filter(r=>r.list!=='Dropped')) === JSON.stringify(before.lists) &&
        JSON.stringify(after.ratings) === JSON.stringify(before.ratings) && JSON.stringify(after.watched) === JSON.stringify(before.watched),
        'A repeated Drop click changed more than the one Dropped membership');
      await undo();
      check(ids(more) === '1,2' && !find('[data-watchlist-remove="1"]') &&
        JSON.stringify((await store.snapshot()).tables.lists) === JSON.stringify(before.lists), 'Undo should restore a started show only to More to watch');
      await drop(2);
      await drop(1);
      check(!ids(more) && doc.activeElement === more.querySelector('h2'), 'Dropping the last show did not focus the section heading');
      await undo();
      const priorRead = store.personalRows.bind(store), entered = Promise.withResolvers(), gate = Promise.withResolvers();
      store.personalRows = async (...args) => { entered.resolve(); await gate.promise; return priorRead(...args); };
      const pending = drop(1);
      try { await entered.promise; leave(); }
      finally { gate.resolve(); await pending; store.personalRows = priorRead; }
      check(!(await store.snapshot()).tables.lists.some(r=>r.list==='Dropped' && r.show_id===1),
        'Leaving Watchlist still applied the delayed Drop');
    }));

  await run('More to watch counts aired regular episodes from cached seasons, orders ties and reports only eligible omissions', () =>
    exercise(more, async ({ doc, frame, find, ids, link, routes }) => {
      const section = find('[data-section=more-to-watch]');
      check(ids(section) === '3,2,1', 'Fewest left and title ties: ' + ids(section));
      check(find('.watch-lead',section).textContent === '3 shows with aired episodes you have not marked', 'Wrong count');
      check(link(1).textContent.includes('1 of 3 aired episodes') && link(1).textContent.endsWith('2 left'), 'Specials, future marks or repeat plays changed counts');
      const line = find('progress', link(1));
      check(line.max === 3 && line.value === 1, 'Progress fraction');
      check(find('strong', link(1)).textContent === 'Amber <em>Archive</em>' && !find('em'), 'With no key the literal filed title must win over the cached name');
      check(find('.tv-note').textContent === '2 shows omitted because their title data is unavailable.', 'Wrong omitted pool');
      check(doc.documentElement.scrollWidth <= frame.clientWidth && link(1).getBoundingClientRect().height >= 44, 'Phone sizing');
      check(find('select.sort-trigger').getBoundingClientRect().height >= 44, 'Phone sort target');
      link(2).click();
      check(routes.length === 1 && routes[0].page === 'show' && routes[0].id === 2, 'Row did not open the show');
    }));

  await run('More to watch applies its native sort, restores focus and the saved order, and refreshes after marking', () =>
    exercise(more, async ({ doc, find, ids, link, saved, open, commit, refresh }) => {
      const moreSection = () => find('[data-section=more-to-watch]');
      const trigger = find('.sort-trigger');
      const before = link(2,moreSection()), progress = before.querySelector('progress');
      check(trigger.tagName === 'SELECT' && trigger.value === 'left' &&
        [...trigger.options].map(option=>option.text).join('|') === 'Fewest episodes left|Title, A to Z', 'Native sort choices');
      trigger.focus(); trigger.value = 'title'; trigger.dispatchEvent(new Event('change',{bubbles:true}));
      check(!find('dialog') && doc.activeElement === trigger && saved.at(-1).moreSort === 'title' && ids(moreSection()) === '1,3,2', 'Title sort or focus');
      check(link(2,moreSection()) === before && before.querySelector('progress') === progress, 'Sorting rebuilt the existing show or progress control');
      await open(saved.at(-1).moreSort);
      check(ids(moreSection()) === '1,3,2' && find('.sort-trigger').value === 'title', 'Return lost selected sort');
      link(2).focus();
      await refresh();
      check(doc.activeElement === link(2), 'Refresh lost focused show');
      await commit({ put: { watched: [watched(2, 3)] } });
      check(ids(moreSection()) === '1,3' && doc.activeElement === find('h2',moreSection()), 'Completed show or focused link survived removal');
      find('.sort-trigger').focus();
      await commit({ replace: { watched: [] } });
      check(doc.activeElement === find('h2',moreSection()), 'Focus stayed on the hidden sort after the last row disappeared');
      check(!ids(moreSection()) && find('.watch-lead',moreSection()).textContent === 'No shows with more to watch.' && !find('.tv-note').textContent, 'More to watch empty state');
    }, 1080));

  await run('Watchlist groups available episodes and upcoming shows while retaining titles with an unknown schedule', () => {
    const fixture = {
      shows: [show(21, 'Zinc Hollow', 2, '2026-11-18'), show(22, 'Amber Station', 1, '2026-11-18'),
        show(23, 'Far Shore', 5, '2026-12-01'), {...show(24, 'Copper Hill', 0),firstAirDate:null}, show(25, 'East Junction', 2, '2026-11-17'),
        show(26, 'Birch Street', 3), show(27, 'Completed yesterday', 1, '2026-11-17'),
        show(28, 'Zero aired', 0), show(29, 'Stopped', 2, '2026-11-18'),
        {...show(30, 'Preview special', 0), firstAirDate:'2026-12-02',
          nextAirDate:'2026-12-02', nextEpisode:{season:1, episode:1, airDate:'2026-12-02'}}],
      missing: [31, 34],
      tables: { watched: [21, 22, 27, 31].map(id => watched(id)).concat([watched(28, 1, 0)]),
        lists: [21, 22, 23, 24, 26, 29, 32, 34].map(id => member(id, 'wAtChLiSt')).concat([member(29, 'Stopped'), member(34, 'Hidden from upcoming'), member(25, 'Following upcoming'), member(30, 'Following upcoming'), member(33, 'Elsewhere')]) },
    };
    return exercise(fixture, async ({ root, doc, frame, find, ids, link, routes }) => {
      check([...root.querySelectorAll('h2')].map(node => node.textContent).join('|') === 'Upcoming|Available to watch|More to watch', 'Watchlist section order changed');
      check(!link(29) && ids(find('[data-section="upcoming"]')) === '30,24,32' && ids(find('[data-section="available"]')) === '26,25,23' &&
        ids(find('[data-section=more-to-watch]')) === '22,27,21',
        'Unexpected membership or ordering: ' + ids());
      check(link(30).textContent.includes('S1 E1') && link(30).lastElementChild.dateTime === '2026-12-02' &&
        link(30).textContent.endsWith('2 Dec 2026'), 'Announced episode or date missing');
      check(link(25).textContent.endsWith('3 aired episodes to watch') && !find('time', link(25)), 'The published episode and both older episodes should count without a stale date');
      check(link(32).textContent.endsWith('Schedule unavailable'), 'Uncached followed show lacked its schedule state');
      check(doc.documentElement.scrollWidth <= frame.clientWidth, 'Upcoming overflowed at 320px');
      link(23).click();
      check(routes.at(-1)?.id === 23, 'Upcoming row navigation');
    });
  });

  await run('Watchlist moves episodes to Available on their local air date and updates after list edits', () =>
    exercise({
      shows: [41,42].map((id,i) => ({...show(id,['Daybreak','Long Weekend'][i],0,'2026-11-19'),firstAirDate:'2026-11-19'})),
      tables: { lists: [member(41, 'Following upcoming'), member(42, 'Watchlist')] },
    }, async ({ doc, find, link, ids, refresh, setDay, commit, remove, undo }) => {
      check(ids(find('[data-section="upcoming"]')) === '41,42' && find('time', link(41)).dateTime === '2026-11-19', 'Tomorrow’s episode was not upcoming');
      await remove(41);
      check(ids() === '42' && doc.activeElement === find('[data-watchlist-remove="42"]'), 'Removing a row lost the remaining show or keyboard focus');
      await undo();
      check(ids() === '41,42', 'Undo did not return the show to its section');
      setDay(19);
      await refresh();
      check(ids(find('[data-section="available"]')) === '41,42' && !find('[data-section="upcoming"]') && !find('time'), 'Today’s episodes stayed upcoming');
      find('[data-watchlist-remove="42"]').focus();
      await commit({ remove: { lists: [['Following upcoming',41]] }, put: { lists: [member(42, 'HIDDEN FROM UPCOMING')] } });
      check(!find('[data-section=upcoming]') && !find('[data-section=available]') &&
        !ids(find('[data-section=more-to-watch]')) && find('.watch-lead').textContent === 'Your Watchlist is empty.',
        'Removing Watchlist memberships should not start an unwatched series');
      check(doc.activeElement === find('h1'), 'Focus did not return to the Watchlist heading when the last row disappeared');
    }));
}
