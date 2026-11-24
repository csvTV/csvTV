import { mountApplication } from '../dist/application.js';
import { connectFixtureProviders } from './provider-fixture-cases.mjs';
import { openDeviceStore } from '../dist/storage.js';
import { TmdbClient, tmdbResourceKey } from '../dist/tmdb-client.js';
import { TmdbService } from '../dist/tmdb-service.js';
import { WatchActions } from '../dist/watch-actions.js';
import { legacyRecentRows, recentId } from '../dist/recent-history.js';
import { episodeKey } from '../dist/watch-identity.js';
import { readOverview } from '../dist/record-overview.js';
import { readStatisticsInput } from '../dist/statistics-data.js';
import { TmdbLibrary } from '../dist/tmdb-library.js';
import { readRoute, routeHref } from '../dist/navigation.js';
import { prepareExport } from '../dist/export-data.js';
import { readCsv } from '../dist/csv.js';

function check(ok, message) { if (!ok) throw Error(message); }
async function until(test, message) {
  const end = performance.now() + 7000;
  while (performance.now() < end) {
    const result = await test();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 12));
  }
  throw Error(message);
}
function frameAt(url, width) {
  const frame = document.createElement('iframe');
  frame.width = width; frame.height = 680;
  return new Promise(resolve => {
    frame.onload = () => resolve(frame);
    frame.src = url;
    document.body.append(frame);
  });
}

function openPhoneEntry(url) {
  const win = window.open(url, '_blank', 'popup,width=320,height=680');
  if (!win) throw Error('Could not open the production phone window');
  return win;
}

async function entryDocument(win) {
  return until(() => win.location.pathname === '/dist/index.html' && win.document.readyState === 'complete' &&
    win.innerWidth === 320 && win.document.querySelector('#app') && win.document, 'The 320px production window did not load');
}

export async function exportApplicationCases(run) {
  await run('Phone Settings opens Export and replaces all four downloads when the committed record changes', () =>
    fixture(320, async ({ click, q, waitFor, doc, store, win }) => {
      await click('.settings-shortcut');
      await click('.settings-phone-export');
      await waitFor('a[download="summary.csv"]');
      check(win.location.hash === '#/export' && doc.title === 'Export · csvTV' &&
        q('.app-sidebar [href="#/export"]').getAttribute('aria-current') === 'page', 'Export route or active navigation was lost');
      await click('[value="record"]');
      const anchor = 'a[download="shows.csv"]';
      await waitFor(anchor);
      const names = () => [...doc.querySelectorAll('a[download]')].map(a => a.download);
      check(names().join() === 'watched.csv,ratings.csv,lists.csv,shows.csv', 'Incorrect four-file selection');
      const downloaded = async selector => (await fetch(q(selector).href)).text();
      const first = await downloaded(anchor);
      check(first.includes('45,Filed title,2018,tt0099999') && !first.includes('Unused'), 'Derived index lost imported information');
      const revision = (await store.snapshot()).revision;
      let invalidated = false;
      store.addEventListener('recordchange', () => { invalidated = !q('a[download]') && q('[data-share]').disabled; }, { once: true });
      await store.commit(revision, { remove: { watched: [[45, 1, 1]] }, put: { lists: [{ list: 'Watchlist', show_id: 62, show: 'Listed' }] } });
      check(invalidated, 'Old files could still be shared after a committed change');
      await waitFor(anchor);
      const fresh = await downloaded(anchor);
      check(!fresh.includes('45,') && fresh.includes('62,,,'), 'Final-reference removal or new reference did not rebuild the show index');
      check((await downloaded('a[download="lists.csv"]')).includes('Watchlist,62,Listed') &&
        (await store.snapshot()).revision === revision + 1n, 'Download mutated the record or used old memberships');
      await click('.phone-back');
      await waitFor('.settings-phone-export');
    }, { watched: [row(1, 1)], shows: [
      { show_id: 45, show: 'Filed title', year: 2018, imdb_id: 'tt0099999' },
      { show_id: 60, show: 'Unused', year: null, imdb_id: '' },
    ] }));

  await run('An export racing a title-and-record commit gets one complete IndexedDB snapshot', () =>
    fixture(1000, async ({ store, service }) => {
      const key = tmdbResourceKey({ kind: 'show', id: 45 });
      const generation = (await store.tmdbState()).generation;
      const old = { show_id: 45, show: 'First title', firstAirDate: '2019-02-03', imdbId: null };
      await store.writeTmdb(generation, { entries: { [key]: { value: old, fetchedAt: Date.now() } } });
      const revision = (await store.snapshot()).revision;
      const getAll = IDBObjectStore.prototype.getAll;
      let competing;
      IDBObjectStore.prototype.getAll = function (...args) {
        const request = getAll.apply(this, args);
        if (this.name === 'shows' && this.transaction.objectStoreNames.contains('tmdb')) {
          request.addEventListener('success', () => {
            competing = store.commit(revision, { put: { watched: [row(1, 1, 5)] } }, { tmdb: {
              generation, key, entry: { fetchedAt: Date.now(), value: { ...old, show: 'Second title' } },
            } });
          }, { once: true });
        }
        return request;
      };
      let initial;
      try { initial = await prepareExport(service, 'record'); }
      finally { IDBObjectStore.prototype.getAll = getAll; }
      check(competing, 'The test did not queue a competing commit while reading the record');
      await competing;
      const latest = await prepareExport(service, 'record');
      const watchCount = async result => readCsv('watched', await result.files[0].text()).rows[0].times_watched;
      check(await watchCount(initial) === 1 && (await initial.files[3].text()).includes('45,First title,2019,'),
        'The first export mixed revisions');
      check(await watchCount(latest) === 5 && (await latest.files[3].text()).includes('45,Second title,2019,'),
        'The next export missed part of a committed transaction');
    }, { watched: [row(1, 1)] }));

  await run('A reader exporting offline picks up writer edits and cached external IDs, including after reopening', () =>
    fixture(1000, async ({ name, store, env }) => {
      const frame = await frameAt('/screen-fixture#/export', 320);
      const root = frame.contentDocument.querySelector('#app');
      const reader = await openDeviceStore({ name });
      const service = new TmdbService(reader, fixtureClient(), { ...env, online: () => false });
      const app = mountApplication(root, service);
      try {
        await app.ready;
        check(reader.role === 'reader', 'Second connection was not read-only');
        root.querySelector('[value="record"]').click();
        const textWhen = (file, fragment) => until(async () => {
          const link = root.querySelector('a[download="' + file + '"]');
          if (!link) return false;
          try { return (await (await fetch(link.href)).text()).includes(fragment); } catch { return false; }
        }, 'Reader never received ' + file + ' with ' + fragment);
        await textWhen('ratings.csv', '45,Filed,2');
        await store.commit((await store.snapshot()).revision, { put: { ratings: [{ show_id: 45, show: 'Filed', rating: 8.5 }] } });
        await textWhen('ratings.csv', '45,Filed,8.5');
        await store.writeTmdb((await store.tmdbState()).generation, { entries: {
          [tmdbResourceKey({ kind: 'external-ids', id: 45 })]: { value: { imdbId: 'tt0009876' }, fetchedAt: Date.now() },
        } });
        await textWhen('shows.csv', '45,Filed,2015,tt0009876');
      } finally { app.dispose(); service.close(); reader.close(); frame.remove(); }
      const reopened = await openDeviceStore({ name });
      const offline = new TmdbService(reopened, fixtureClient(), { ...env, online: () => false });
      try {
        const result = await prepareExport(offline, 'record');
        const contents = await Promise.all(result.files.map(f => f.text()));
        check(contents[1].includes('45,Filed,8.5') && contents[3].includes('45,Filed,2015,tt0009876') &&
          contents.every(text => !text.includes('fictional-flow-key')), 'Reopening changed the bytes or exposed a setting');
      } finally { offline.close(); reopened.close(); }
    }, { ratings: [{ show_id: 45, show: 'Filed', rating: 2 }], shows: [{ show_id: 45, show: 'Filed', year: 2015, imdb_id: '' }] }));
}
const title = { id: 45, name: 'The Listening House', first_air_date: '2019-10-01' };
const seasons = [0, 1, 2].map(s => ({ season_number: s, name: s ? 'Season ' + s : 'Specials', episode_count: 2 }));
const row = (s, n, count = 1, id = 45) => ({ show_id: id, show: title.name, season: s, episode: n,
  episode_id: id * 1000 + s * 10 + n, title: 'Recording ' + n, times_watched: count });
const now = Date.now;
function fixtureClient() {
  return new TmdbClient({ fetch: async url => {
    const path = new URL(url).pathname.slice(3);
    if (path === 'configuration') return Response.json({ images: { secure_base_url: 'https://image.tmdb.org/t/p/',
      poster_sizes: ['w154'], backdrop_sizes: ['w300'], still_sizes: ['w92'], profile_sizes: ['w45'] } });
    if (path === 'configuration/countries') return Response.json([{ iso_3166_1: 'NZ', english_name: 'New Zealand' }]);
    if (path === 'search/tv') return Response.json({ page: 1, total_pages: 1, results: [title] });
    if (path === 'tv/45') return Response.json({ ...title, overview: 'A family hears forgotten broadcasts.', status: 'Ended', seasons,
      origin_country: ['NZ'], vote_average: 7.25, vote_count: 24,
      last_episode_to_air: { season_number: 2, episode_number: 2, air_date: '2020-10-01' },
      next_episode_to_air: null, keywords: { results: [] }, external_ids: { imdb_id: null } });
    if (path === 'tv/45/aggregate_credits') return Response.json({ id: 45, cast: [{
      id: 81, name: 'Mira Vale', roles: [{ character: 'The Announcer' }], total_episode_count: 4,
    }] });
    if (path === 'person/81/tv_credits') return Response.json({ id: 81, cast: [{ ...title, character: 'The Announcer' }], crew: [] });
    if (path === 'tv/45/recommendations') return Response.json({ page: 1, total_pages: 0, results: [] });
    const season = /^tv\/45\/season\/([012])$/.exec(path);
    if (season) {
      const s = Number(season[1]);
      return Response.json({ ...seasons[s], episodes: [1, 2].map(n => ({
        id: row(s, n).episode_id, episode_number: n, name: row(s, n).title, air_date: '2020-10-01', runtime: 30,
      })) });
    }
    throw Error('Unexpected fictional resource');
  } });
}

async function fixture(width, body, seed = {}, prepare) {
  const name = 'csvtv-screen-flow-' + crypto.randomUUID();
  const frame = await frameAt('/screen-fixture', width);
  const doc = frame.contentDocument, win = frame.contentWindow;
  const store = await openDeviceStore({ name });
  const env = { now, online: () => true, visible: () => true };
  const service = new TmdbService(store, fixtureClient(), env);
  let app, libraryEvents;
  try {
    await connectFixtureProviders(store,name);
    await service.saveKey('fictional-flow-key');
    if (Object.keys(seed).length) await store.commit((await store.snapshot()).revision, { put: seed });
    const root = doc.querySelector('#app');
    libraryEvents = prepare?.({ env, win, service }) ?? new EventTarget();
    app = mountApplication(root, service, libraryEvents);
    await app.ready;
    const q = selector => root.querySelector(selector);
    const waitFor = selector => until(() => q(selector), 'Missing ' + selector);
    const click = async selector => (await waitFor(selector)).click();
    await body({ root, q, waitFor, click, store, service, app, doc, win, name, env, libraryEvents });
  } finally {
    app?.dispose(); libraryEvents?.close?.(); service.close(); store.close(); frame.remove();
    const deletion = indexedDB.deleteDatabase(name);
    await new Promise((resolve, reject) => { deletion.onsuccess = resolve; deletion.onerror = () => reject(deletion.error); });
  }
}

export async function applicationCases(run) {
  await run('Browser Back during a Dropbox decision preserves the previous screen and its history position', () =>
    fixture(360, async ({app, win, doc, waitFor}) => {
      win.location.hash = '#/library';
      await waitFor('.library-screen');
      app.go({page:'settings'});
      await waitFor('#settings-services');
      const decision = doc.createElement('dialog');
      decision.className = 'dropbox-dialog';
      doc.body.append(decision);
      decision.showModal();
      let events = 0;
      win.addEventListener('popstate', observed);
      win.history.back();
      await until(() => win.location.hash === '#/settings' && win.history.state.csvtvDepth === 2 &&
        events >= 2, 'Going Back consumed the previous history entry while the decision was open');
      decision.close(); decision.remove();
      win.history.back();
      await until(() => win.location.hash === '#/library' && win.history.state.csvtvDepth === 1,
        'Dismissing the decision lost the Library entry');
      win.removeEventListener('popstate', observed);
      await waitFor('.library-screen');
      const firstLibrary = doc.querySelector('.library-screen');
      app.go({page:'home'}); await waitFor('.home-screen');
      app.go({page:'library'}); await waitFor('.library-screen');
      const laterLibrary = doc.querySelector('.library-screen');
      check(laterLibrary !== firstLibrary, 'Library was not reopened');
      win.history.go(-2);
      await until(() => win.history.state.csvtvDepth === 1 && doc.querySelector('.library-screen') &&
        doc.querySelector('.library-screen') !== laterLibrary, 'Returning to an earlier Library entry retained the later view');
      function observed() { events++; }
    }));
  await run('An open reader follows watch totals, Watchlist membership, show metadata, and TMDB key changes from its writer', () =>
    fixture(320, async ({ store, service, name }) => {
      const frame = await frameAt('/screen-fixture#/home', 360);
      const root = frame.contentDocument.querySelector('#app');
      const reader = await openDeviceStore({name});
      const offline = new TmdbService(reader, fixtureClient(), {now, online:() => false, visible:() => true});
      const app = mountApplication(root, offline);
      const q = selector => root.querySelector(selector);
      try {
        await app.ready;
        const plays = () => q('.record-totals div:last-child dd')?.textContent;
        await until(() => plays() === '0', 'Reader did not open on an empty Home');
        await store.commit((await store.snapshot()).revision, {put:{watched:[row(1, 1, 3)]}});
        await until(() => plays() === '3', 'Home did not pick up watches saved in the writer');
        app.go({page:'watchlist'});
        await until(() => q('.watchlist-screen'), 'Reader could not open Watchlist');
        await store.commit((await store.snapshot()).revision, {put:{lists:[{list:'Watchlist', show_id:45, show:title.name},
          {list:'Watchlist', show_id:46, show:'New premiere'}]}});
        await until(() => q('[data-watchlist-remove="46"]') && !q('[data-watchlist-remove="45"]'), 'Reader did not separate started and unstarted Watchlist memberships');
        app.go({page:'show', id:45});
        await until(() => q('.show-hero h1')?.textContent === title.name, 'Reader did not open saved title');
        await until(() => frame.contentDocument.title === title.name + ' · csvTV', 'Initial bookmark title missing');
        const renamed = 'Corrected file title';
        await store.commit((await store.snapshot()).revision, {put:{watched:[{...row(1, 1, 3), show:renamed}]}});
        await until(() => q('.show-hero h1')?.textContent === renamed && frame.contentDocument.title === renamed + ' · csvTV'
          && q('main').getAttribute('aria-label') === renamed, 'A corrected show name left its tab and bookmark title stale');
        await service.openShow(45);
        await until(() => q('.show-overview p')?.textContent.includes('forgotten broadcasts') &&
          q('.show-cast-member')?.textContent.includes('Mira Vale') && frame.contentDocument.title === title.name + ' · csvTV',
          'An already-open Show missed new cached metadata or kept the old bookmark title');
        await store.writeTmdb((await service.keyStatus()).generation, {entries:{
          [tmdbResourceKey({kind:'show', id:45})]:{value:null, fetchedAt:Date.now()},
        }});
        await until(() => !q('.show-overview p') && !q('.show-cast-member') && q('.show-status')?.textContent.includes('Not on TMDB'),
          'Confirmed missing show retained its previous details');
        app.go({page:'settings'});
        await until(() => q('#settings-services'), 'Reader did not open Settings');
        await service.saveKey('another-fictional-key');
        await service.removeKey((await service.keyStatus()).generation);
        await until(() => q('#tmdb-key-label')?.closest('.key-row').querySelector('[data-key-status]').textContent === 'No key saved', 'Reader Settings retained an old key status');
      } finally { app.dispose(); offline.close(); reader.close(); frame.remove(); }
    }));

  await run('The shipped entry opens Home, links to real Settings, and restores Search with browser Back', async () => {
    const previous = await openDeviceStore();
    try {
      const {revision,local} = await previous.whenWriter();
      if (!local.syncAccountId) await previous.commit(revision,{local:{syncAccountId:'fictional-shipped-entry'}});
    } finally { await previous.closeForUpdate(); }
    const win = openPhoneEntry('/dist/index.html');
    try {
      const doc = await entryDocument(win);
      const home = await until(() => doc.querySelector('.home-search input'), 'Production Home did not open');
      home.focus();
      home.value = 'Signal Garden';
      home.form.requestSubmit();
      const settings = await until(() => doc.querySelector('[data-state] button'), 'Search did not offer Settings for the missing key');
      check(doc.activeElement?.matches('input[type=search]'), 'Navigated Search lost keyboard focus');
      settings.click();
      await until(() => doc.querySelector('[data-help]'), 'Settings did not mount');
      check(doc.querySelectorAll('main').length === 1, 'Settings nested a second main landmark');
      doc.querySelector('[data-help]').click();
      check(doc.querySelector('dialog[open] #sheet-title'), 'Settings key help did not open');
      doc.querySelector('[data-close]').click();
      win.history.back();
      await until(() => doc.querySelector('input[type=search]'), 'Back lost Search');
      check(!doc.documentElement.scrollWidth || doc.documentElement.scrollWidth <= 320, 'Phone layout overflowed');
    } finally { win.close(); }
    const direct = openPhoneEntry('/dist/index.html#/show/45/season/1');
    try {
      const doc = await entryDocument(direct);
      const page = () => doc.querySelector('#app').dataset.page;
      await until(() => page() === 'season', 'The direct Season link did not open');
      const length = direct.history.length;
      doc.querySelector('.phone-back').click();
      await until(() => page() === 'show', 'Back from a direct Season link did not open its show');
      doc.querySelector('.phone-back').click();
      await until(() => page() === 'home', 'Back from a direct link cycled between Season and Show');
      check(length === direct.history.length, 'Direct-link Back created artificial history entries');
    } finally { direct.close(); }
  });

  await run('The first watch hides a planned show from Watchlist, Undo restores it, and partial progress appears on Home', () =>
    fixture(320, async ({ q, click, waitFor, win, store, root }) => {
      await click('.home-search input');
      const input = await waitFor('input[type=search]');
      input.value = 'listening'; input.dispatchEvent(new Event('input', { bubbles: true }));
      input.form.requestSubmit();
      await click('.result-link');
      await click('[data-season="1"]');
      await click('[data-season-focus="episode-1-add"]');
      await waitFor('.undo-bar:not([hidden]) [data-undo]');
      check(!q('.undo-bar [data-watchlist]') && !(await store.watchlistMembers()).length, 'The first watch still needed a separate Watchlist removal');
      await click('[data-undo]');
      await until(() => q('.undo-bar').hidden, 'Watch Undo remained on screen');
      check((await store.watchlistMembers()).some(show => show.id === 45) && !(await store.tmdbRows(45)).tables.watched.length,
        'Undo lost the original plan or kept the undone watch');
      await until(() => q('[data-season-focus="episode-1-count"]')?.textContent === '0×', 'The undone episode did not redraw');
      await click('[data-season-focus="episode-1-add"]');
      await until(() => q('[data-season-focus="episode-1-count"]')?.textContent === '1×' &&
        q('[data-season-focus="episode-2-add"]')?.matches(':enabled'), 'The first episode did not finish saving');
      await click('[data-season-focus="episode-2-add"]');
      await until(() => q('[data-season-focus="episode-2-count"]')?.textContent === '1×' && !q('.undo-bar').hidden,
        'The second episode did not finish saving');
      win.history.back();
      await waitFor('.show-page [data-season="1"]');
      check(q('.undo-bar').hidden, 'Undo leaked to a different screen');
      win.history.back();
      await until(() => q('.result-link') && q('input')?.value === 'listening' &&
        q('.result-counts')?.textContent.includes('2 of 4'), 'Back lost query or new progress');
      win.history.back();
      await until(() => !q('[data-home-watchlist] a') && q('[data-watchlist-count]')?.textContent === '0 shows' &&
        q('[data-recent] a')?.textContent.includes(title.name) && q('[data-more] a')?.textContent.includes(title.name) &&
        q('[data-more] .library-status-trigger')?.textContent === '2 of 4',
        'Home rails did not reflect the committed record');
      await until(() => root.querySelectorAll('.record-totals dd')[3]?.textContent === '2', 'Home did not count both plays');
    }, { lists: [{ list: 'Watchlist', show_id: 45, show: title.name }] }));

  await run('Rewatch on a Search result adds one play across regular seasons and Undo restores the original counts', () =>
    fixture(320, async ({ app, store, q, waitFor, click, win }) => {
      app.go({page:'show',id:45});
      await until(() => q('.show-actions .primary')?.textContent === 'Watched again', 'The saved show was not complete');
      app.go({page:'search',query:'listening'});
      const mark = await waitFor('.result-mark');
      check(mark.textContent === 'Rewatch', 'A completed show did not offer Rewatch on Search');
      const route = win.location.hash;
      const counts = async () => (await store.snapshot()).tables.watched.map(row =>
        [row.season,row.episode,row.times_watched].join('/')).sort().join(',');
      const original = await counts();
      mark.click();
      mark.click();
      await until(() => q('.result-counts')?.textContent.includes('2 times') && q('.undo-bar:not([hidden])'),
        'Rewatch did not update Search and offer Undo');
      check(await counts() === '0/1/6,1/1/4,1/2/2,2/1/2,2/2/2',
        'Rewatch duplicated a pending click, included a special or lost an individual play count');
      await click('[data-undo]');
      await until(() => q('.undo-bar').hidden && !q('.result-counts').textContent.includes('times'),
        'Undo did not update the result');
      check(win.location.hash === route && q('input[type=search]').value === 'listening' &&
        q('.result-mark').textContent === 'Rewatch' && await counts() === original,
        'Rewatch or Undo changed the route, query or original record');
    }, {watched:[row(0,1,6),row(1,1,3),row(1,2),row(2,1),row(2,2)]}));

  await run('Whole-show Mark watched and Watched again skip every special when starting from an empty record', () =>
    fixture(320, async ({ app, store, q, click, waitFor }) => {
      app.go({page:'season', id:45, season:0});
      await waitFor('[data-episode="episode-2"]');
      check(!(await store.snapshot()).tables.watched.length, 'The specials preview changed an empty record');
      app.go({page:'show', id:45});
      const primary = '.show-actions .primary';
      await until(() => q(primary)?.textContent === 'Mark watched', 'An unwatched show has no primary mark');
      const rows = async () => (await store.snapshot()).tables.watched.map(row => [row.season,row.episode,row.times_watched].join('/')).sort().join(',');
      await click(primary);
      await until(() => q(primary)?.textContent === 'Watched again' && !q(primary).disabled, 'First whole-show mark did not finish');
      check(await rows() === '1/1/1,1/2/1,2/1/1,2/2/1', 'First whole-show mark changed Specials or omitted a regular episode');
      await click(primary);
      await until(async () => await rows() === '1/1/2,1/2/2,2/1/2,2/2/2', 'Whole-show rewatch changed Specials or missed a regular episode');
      app.go({page:'season', id:45, season:0});
      await waitFor('[data-episode="episode-2"]');
      const badges = [...q('.season-episodes').querySelectorAll('.episode-count')];
      check(badges.length === 2 && badges.every(count => count.textContent === '0×'), 'The two unwatched specials did not reopen with zero counts');
    }));

  await run('Desktop season links open a separate episode list, season watches stay on Show, and removal reconfirms changed counts', () =>
    fixture(1080, async ({ app, waitFor, q, click, store, win, doc }) => {
      app.go({ page: 'show', id: 45 });
      await waitFor('.show-season-row[data-season="2"]');
      const entries = win.history.length;
      const initial = JSON.stringify((await store.snapshot()).tables.watched);
      await click('[data-season="2"] .show-season-copy');
      await waitFor('.season-screen [data-episode="episode-2"]');
      check(entries + 1 === win.history.length && win.location.hash === '#/show/45/season/2' &&
        initial === JSON.stringify((await store.snapshot()).tables.watched), 'Opening Season changed watches or lost history');
      await click('.desktop-back');
      await click('[aria-label="More show actions"]');
      (await until(() => [...doc.querySelectorAll('dialog button')].find(b => b.textContent === 'Remove watches'), 'Missing show removal')).click();
      await waitFor('[data-cancel]');
      check(doc.activeElement.matches('[data-cancel]') && q('#remove-count').textContent.includes('3 plays from 2 episodes'),
        'Removal did not focus Cancel and give the original totals');
      await store.commit((await store.snapshot()).revision, { put: { watched: [row(1, 1, 5)] } });
      await click('[data-accept]');
      await until(() => q('#remove-count')?.textContent.includes('6 plays from 2 episodes'), 'Changed counts were not reconfirmed');
      await click('[data-accept]');
      await until(() => !q('.undo-bar').hidden, 'Removal failed to commit');
      const cleared = (await store.snapshot()).tables.watched;
      check(cleared.length === 1 && cleared[0].season === 0, 'Whole-show removal touched specials');
      await click('[data-undo]');
      await until(() => q('.undo-bar').hidden, 'Removal could not be undone');
      check((await store.snapshot()).tables.watched.map(r => r.times_watched).join() === '4,5,1', 'Undo lost original counts');
      const beforeMark = (await store.snapshot()).tables.watched;
      await click('[data-focus="watch-season-2"]');
      await click('.season-count-form [data-increase]');
      await click('.season-count-form [type=submit]');
      await until(() => !q('.undo-bar').hidden, 'Desktop season watch did not commit');
      const afterMark = (await store.snapshot()).tables.watched;
      check(win.location.hash === '#/show/45' && afterMark.filter(row => row.season === 2).length === 2 &&
        JSON.stringify(afterMark.filter(row => row.season !== 2)) === JSON.stringify(beforeMark.filter(row => row.season !== 2)),
        'The season watch control navigated or changed other seasons');
      await click('[data-season="2"] .show-season-copy');
      await until(() => q('.season-screen h1')?.textContent === 'Season 2', 'The season link did not open its episode list');
      check(win.location.hash === '#/show/45/season/2' && q('.undo-bar').hidden, 'Season navigation kept the old edit or lost the bookmark');
      const beforeResize = (await store.snapshot()).tables.watched;
      await click('[data-season-focus="episode-1-subtract"]');
      await until(() => !q('.undo-bar').hidden, 'The season edit did not offer Undo');
      win.frameElement.width = '360';
      await until(() => !win.matchMedia('(min-width:900px)').matches && q('.season-screen h1')?.textContent === 'Season 2', 'Switching layouts lost the linked season');
      check(!q('.undo-bar').hidden, 'Resizing the same season discarded Undo');
      await click('[data-undo]');
      await until(() => q('.undo-bar').hidden, 'Undo did not finish after resize');
      check(JSON.stringify((await store.snapshot()).tables.watched) === JSON.stringify(beforeResize), 'Undo after resize did not restore the original rows');
      await click('[data-season-focus="episode-1-count"][aria-haspopup="dialog"]:not(:disabled)');
      await until(() => q('dialog[open]'), 'Episode sheet did not open before the store closed');
      store.close();
      const reload = q('.tab-state button');
      check(reload?.textContent === 'Reload' && !q('dialog[open]') && doc.activeElement === reload,
        'A sheet from the old record kept Reload out of reach');
      app.go({page:'library'});
      check(win.location.hash === '#/show/45/season/2', 'Navigation reopened a screen on a closed record');
    }, { watched: [row(0, 1, 4), row(1, 1, 2), row(2, 1)] }));

  await run('Undo restores the previous Recent order for both imported watches and an already recent show', () =>
    fixture(320, async ({ service, store, name }) => {
      const episode = row(1, 1, 2);
      const previous = Array.from({ length: 20 }, (_, index) => index + 1);
      await store.commit((await store.snapshot()).revision, {
        put: { watched: [episode, ...previous.map(id => row(1, 1, 1, id))] },
      });
      await service.view({ kind: 'show', id: 45 });
      await service.view({ kind: 'season', id: 45, season: 1 });
      const watch = new WatchActions(service, async () => true, () => {}, () => {});
      const reader = await openDeviceStore({ name });
      try {
        await service.view({kind:'season',id:45,season:2});
        for (const order of [previous, [...previous.slice(0, 3), 45, ...previous.slice(3, 19)]]) {
          const visible = order.slice(0,8);
          const current = await store.snapshot();
          const otherSettings = current.tables.settings.filter(row => recentId(row.setting) === null);
          await store.commit(current.revision, {replace:{settings:[...otherSettings,...legacyRecentRows(order)]}});
          await watch.episode(row(2,1), 'mark');
          const marked = await reader.tmdbRows(45);
          check(marked.tables.watched.length === 2 &&
            marked.recentlyMarked.join() === [45, ...order.filter(id => id !== 45)].slice(0,8).join(),
            'A reader missed the new play or the show moving to the front');
          await watch.undo();
          const undone = await reader.tmdbRows(45);
          check(undone.tables.watched.length === 1 && undone.tables.watched[0].times_watched === 2 && undone.recentlyMarked.join() === visible.join(),
            'Undo lost the old position or the eighth show displaced by the mark');
          await watch.episode(episode, 'remove-one');
          const decreased = await reader.tmdbRows(45);
          check(decreased.tables.watched[0].times_watched === 1 && decreased.recentlyMarked.join() === visible.join(),
            'Removing an imported play added or promoted the show');
          await watch.undo();
          const restored = await reader.tmdbRows(45);
          check(restored.tables.watched[0].times_watched === 2 && restored.recentlyMarked.join() === visible.join(),
            'Undo of a removal counted its restored play as a new mark');
        }
        const prior = (await reader.tmdbRows(45)).recentlyMarked;
        await watch.episode(episode, 'again');
        await service.editWatches(11, ({ tables }) => ({
          rows: [...tables.watched,row(2,1,1,11)],
        }));
        await watch.undo();
        check((await reader.tmdbRows(45)).recentlyMarked.join() === [11, ...prior.filter(id => id !== 11)].slice(0,8).join(),
          'Undo moved a later local mark on another show back to its old position');
      } finally { reader.close(); }
    }));

  await run('An aborted watch edit preserves the prior Undo and recent order after reopen; recent shows stop at eight', () =>
    fixture(320, async ({ service, store, name }) => {
      let bar;
      const watch = new WatchActions(service, async () => true, value => { bar = value; }, () => {});
      const rows = Array.from({ length: 22 }, (_, i) => row(1, 1, i === 5 ? 3 : 2, i + 1));
      for (const r of rows) await service.editWatches(r.show_id, () => ({ rows: [r] }));
      await watch.episode(rows[5], 'remove-one');
      const before = await store.snapshot();
      check(before.local.recentlyMarked.join() === rows.slice(-8).reverse().map(r => r.show_id).join(),
        'Recent shows lost mark order or the eight-show limit after removing one play');
      const priorUndo = bar;
      const changed = { ...rows[0], episode_id: 908172, times_watched: 1 };
      await store.commit(before.revision, { put: { watched: [changed] } });
      const blank = { ...changed, episode_id:null };
      for (const [current, selected] of [[changed, rows[0]], [changed, blank], [blank, changed]]) {
        await store.commit((await store.snapshot()).revision, {put:{watched:[current]}});
        let stale = false;
        try { await watch.episode(selected, 'remove-one'); } catch (error) { stale = error.message.includes('position changed'); }
        check(stale && bar === priorUndo, 'A stale episode menu removed a replacement row at the same position');
        check((await store.tmdbRows(current.show_id)).tables.watched[0]?.times_watched === 1, 'The replacement was changed');
      }
      await store.commit((await store.snapshot()).revision, {put:{watched:[changed]}});
      const unchanged = await store.snapshot();
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function(...args) {
        const request = put.apply(this, args);
        if (this.name === 'settings' && recentId(args[0].setting) !== null) throw new DOMException('Fictional quota', 'QuotaExceededError');
        return request;
      };
      try {
        let failed = false;
        try { await watch.remove(rows[5].show_id); } catch (e) { failed = e.name === 'QuotaExceededError'; }
        check(failed && bar === priorUndo, 'An aborted watch edit replaced the prior Undo');
      } finally { IDBObjectStore.prototype.put = put; }
      const reader = await openDeviceStore({ name });
      try {
        const after = await reader.snapshot();
        check(after.revision === unchanged.revision && after.local.recentlyMarked.join() === before.local.recentlyMarked.join() &&
          after.tables.watched[0].times_watched === 1 && after.tables.watched.find(r => r.show_id === 6)?.times_watched === 2,
          'Reopening found a partial count or recent-list write');
      } finally { reader.close(); }
    }));

  await run('A pending season or show mark cannot change the record selected in a later Dropbox decision', () =>
    fixture(320, async ({app,service,store,name}) => {
      app.go({page:'settings'});
      const watch = new WatchActions(service,async () => true,() => {},() => {});
      const replacement = row(1,1,7);
      await service.refresh({kind:'season',id:45,season:1});
      for (const scope of [{season:1},{}]) {
        // First try a cached season whose parent has expired, then a whole show with its header.
        if (scope.season === undefined) await service.refresh({kind:'show',id:45});
        else check(await service.read({kind:'show',id:45}) === null, 'Expected the season cache alone');
        const resume = service.holdRecordChanges();
        const pending = watch.bulk(45,scope,'again').then(() => null,error => error);
        try {
          watch.clear();
          await store.commit((await store.snapshot()).revision,{replace:{watched:[replacement]}});
        } finally { resume(); }
        check((await pending)?.kind === 'superseded','An old watch action survived the record decision');
        const reopened = await openDeviceStore({name});
        try {
          check(JSON.stringify((await reopened.snapshot()).tables.watched) === JSON.stringify([replacement]),
            'The abandoned action modified the replacement watches');
        } finally { reopened.close(); }
      }
    },{ratings:[{show_id:45,show:title.name,rating:8}]}));

  await run('Failed watch retries and late failures stay with the watch record that started the edit', () =>
    fixture(1000, async ({app,service,store,name,waitFor,q}) => {
      app.go({page:'show',id:45});
      const primary = () => q('.show-actions .primary');
      const mark = await waitFor('.show-actions .primary:not(:disabled)');
      const submit = service.markWithReceipt.bind(service);
      let attempts = 0;
      service.markWithReceipt = async (...args) => {
        if (++attempts === 1) throw Error('Fictional save failure');
        return submit(...args);
      };
      mark.click();
      const retry = await waitFor('.report[data-retry] button');
      const replacement = row(1,1,7,97);
      await store.commit((await store.snapshot()).revision,{replace:{watched:[replacement]}});
      app.watch.clear();
      retry.click();
      check(attempts === 1,'An old Retry started a watch on the replacement record');
      const gate = Promise.withResolvers(), started = Promise.withResolvers();
      service.markWithReceipt = async (...args) => { started.resolve(); await gate.promise; return submit(...args); };
      primary().click();
      await started.promise;
      app.watch.clear();
      gate.resolve();
      await until(() => primary()?.getAttribute('aria-disabled') === 'false','Abandoned watch did not finish');
      check(!q('.report[data-retry]'),'A superseded watch offered a new Retry in the replacement record');
      const reader = await openDeviceStore({name});
      try {
        check(JSON.stringify((await reader.snapshot()).tables.watched) === JSON.stringify([replacement]),
          'Retry or a delayed failure changed the selected record');
      } finally { reader.close(); }
    }));

  await run('Undo keeps remote changes and removals, reverses descriptive-only changes, and reports protected rows', () =>
    fixture(320, async ({ service, store, name }) => {
      let bar, report;
      const watch = new WatchActions(service, async () => true, value => { bar = value; }, text => { report = text; });
      await watch.bulk(45, {}, 'mark');
      check(bar && (await store.snapshot()).tables.watched.length === 4, 'Cold bulk mark missed a regular season');
      await store.commit((await store.snapshot()).revision, { put: { watched: [row(1,1,3), { ...row(2,1), title:'New title' }] },
        remove: { watched: [[45,1,2]] } });
      watch.protect([episodeKey(row(1,1)), episodeKey(row(1,2))]);
      const commit = store.commit.bind(store);
      store.commit = async (...args) => {
        store.commit = commit;
        watch.protect([episodeKey(row(2,2))]);
        return commit(...args);
      };
      try { await watch.undo(); } finally { store.commit = commit; }
      const { tables, local } = await store.snapshot();
      const rows = tables.watched;
      check(rows.length === 2 && rows[0].times_watched === 3 && rows[1].season === 2 && rows[1].episode === 2 && !bar && report.includes('3 rows'),
        'Undo overwrote a merged count, restored a deletion, or mistook a title correction for a count change');
      check(local.recentlyMarked.join() === '45', 'A partial Undo removed the original mark despite protected remaining plays');
      store.commit = async (...args) => {
        store.commit = commit;
        watch.clear();
        return commit(...args);
      };
      try { await watch.remove(45); } finally { store.commit = commit; }
      const afterRemoval = await openDeviceStore({ name });
      try {
        check(JSON.stringify((await afterRemoval.snapshot()).tables.watched) === JSON.stringify(rows),
          'A removal committed after navigation abandoned its confirmation');
      } finally { afterRemoval.close(); }
      const firstSeason = await service.read({kind:'season', id:45, season:1});
      const secondSeason = await service.read({kind:'season', id:45, season:2});
      const repeated = firstSeason.value.episodes[0].episode_id;
      const season = {...secondSeason.value, episodes:secondSeason.value.episodes.map((ep, i) => i === 0 ? {...ep,episode_id:repeated} : ep)};
      const {generation} = await store.tmdbState();
      const key = tmdbResourceKey({kind:'season', id:45, season:2});
      await store.writeTmdb(generation,{entries:{[key]:{...secondSeason,value:season}}});
      const legacy = rows.map((r, i) => i === 0 ? {...r,episode_id:null} : r);
      await store.commit((await store.snapshot()).revision,{replace:{watched:legacy}});
      let refused = false;
      try { await watch.bulk(45, {}, 'again'); } catch (error) { refused = error.message.includes('multiple positions'); }
      check(refused, 'Repeated episode IDs across cached seasons were marked twice');
      const reopened = await openDeviceStore({ name });
      try {
        check(JSON.stringify((await reopened.snapshot()).tables.watched) === JSON.stringify(legacy),
          'A refused bulk mark changed the original counts after reopen');
      } finally { reopened.close(); }
    }));
}

export async function discoveryApplicationCases(run) {
  await run('Library coalesces background metadata while a record read is in flight', () =>
    fixture(390, async ({app,store,q}) => {
      app.go({page:'library'});
      await until(() => q('.library-details'), 'Missing saved watch in Library');
      const read = store.overviewRows.bind(store), first = Promise.withResolvers();
      let reads = 0;
      store.overviewRows = async () => {
        if (++reads === 1) await first.promise;
        return read();
      };
      try {
        store.dispatchEvent(new Event('tmdbmetadata'));
        await until(() => reads === 1, 'Library did not pick up a cache write');
        for (let i=0; i<6; i++) {
          store.dispatchEvent(new Event('tmdbmetadata'));
          await new Promise(resolve => setTimeout(resolve,60));
        }
        check(reads === 1, 'Overlapping provider notifications restarted an unfinished Library read');
        first.resolve();
        await until(() => reads === 2, 'Library did not read the latest commits after the first read finished');
      } finally { first.resolve(); store.overviewRows = read; }
    }, {watched:[row(1,1)]}));
  await run('A failed artwork cache read keeps the saved record and navigation usable', () =>
    fixture(390, async ({q, click, app, store, service, waitFor}) => {
      await service.view({kind:'show',id:45});
      const entries = store.tmdbEntries.bind(store);
      const entry = store.tmdbEntry.bind(store);
      let titlesUnreadable = false;
      store.tmdbEntries = (keys, ...rest) => keys.includes('configuration') || titlesUnreadable && keys.some(key => key.startsWith('tv/'))
        ? Promise.reject(new Error('Fictional optional cache read failure')) : entries(keys,...rest);
      store.tmdbEntry = (key, ...rest) => key === 'configuration'
        ? Promise.reject(new Error('Fictional artwork read failure')) : entry(key,...rest);
      app.go({page:'home'});
      await until(() => q('[data-more] a')?.textContent.includes(title.name), 'Missing Home rail after artwork read failure');
      check(q('.record-totals dd').textContent === '1', 'Artwork hid saved Home figures');
      await click('#more-heading a');
      await until(() => q('[data-section=more-to-watch] .watch-row-end')?.textContent === '3 left', 'Artwork hid More to watch progress');
      app.go({page:'watchlist'});
      await until(() => q('[data-section=more-to-watch] .watch-rows')?.textContent.includes(title.name) &&
        !q('[data-watchlist-remove="45"]'), 'Artwork changed Watchlist eligibility');
      app.go({page:'library'});
      await until(() => q('.library-grid .library-status-caption')?.textContent === '1 of 4', 'Artwork hid Library progress');
      app.go({page:'lists'});
      await until(() => q('.list-shows')?.textContent.includes(title.name), 'Artwork hid a saved list member');
      app.go({page:'search',query:title.name});
      await until(() => q('.result-link')?.textContent.includes(title.name), 'Artwork hid search results');
      await click('.result-link');
      await until(() => q('.show-hero h1')?.textContent === title.name, 'Artwork prevented opening the show');
      app.go({page:'export'});
      await waitFor('.export-downloads a[download="summary.csv"]');
      const summaryFile = await fetch(q('.export-downloads a[download="summary.csv"]').href);
      check((await summaryFile.text()).includes(title.name), 'Export lost the saved show');
      titlesUnreadable = true;
      app.go({page:'lists'});
      await until(() => q('.list-shows')?.textContent.includes(title.name), 'List membership required the title cache');
      app.go({page:'home'});
      await until(() => q('[data-omitted]')?.textContent.includes('1 show omitted'), 'Missing metadata was not identified');
      check(q('.record-totals dd')?.textContent === '1', 'Missing title metadata hid the saved watch');
      titlesUnreadable = false;
      app.go({page:'watchlist',section:'more-to-watch'});
      await until(() => q('[data-section=more-to-watch] .watch-row-end')?.textContent === '3 left', 'More to watch did not recover');
    }, {watched:[row(1,1)],lists:['Watchlist','Favourites'].map(list=>({show_id:45,show:title.name,list}))}));

  await run('A zero show ID from CSV reopens its saved season and Show offline and stays in Recently marked', () =>
    fixture(320, async ({service, store, app, win, q, waitFor, click, name, env}) => {
      env.online = () => false;
      const filed = readCsv('watched', 'show_id,show,season,episode,title,times_watched\n0,,0,1,Pilot,2\n0,Before Dawn,1,1,First light,1').rows;
      const indexed = readCsv('shows', 'show_id,show,year\n0,,0').rows;
      await store.commit((await store.snapshot()).revision, {put:{shows:indexed}});
      await service.editWatches(0, () => ({rows:[filed[1]]}));
      await service.editWatches(0, () => ({ rows: filed }));
      win.location.hash = '#/show/0/season/0';
      await until(() => q('.season-episode')?.textContent.includes('Pilot'), 'A saved season bookmark returned Home');
      await app.watch.episode(filed[0], 'remove-one');
      const reader = await openDeviceStore({name});
      try {
        const saved = await reader.tmdbRows(0);
        check(saved.tables.watched[0].times_watched === 1 && saved.recentlyMarked.includes(0), 'Reopening lost the watch or recent ID');
      } finally { reader.close(); }
      app.go({page:'home'});
      await click('[data-recent] a[href="#/show/0"]');
      await until(() => q('.show-hero h1')?.textContent === 'Before Dawn', 'The recent show could not be opened');
      check(q('.show-facts')?.textContent === '0', 'The recorded year disappeared from the Show facts');
      win.location.hash = '#/home';
      await waitFor('.home-screen');
      win.location.hash = '#/show/0';
      await until(() => q('.show-hero h1')?.textContent === 'Before Dawn', 'The direct Show bookmark returned Home');
      const unnamed = readCsv('lists', 'list,show_id,show\nWatchlist,8,').rows;
      await store.commit((await store.snapshot()).revision, {put:{lists:unnamed}});
      app.go({page:'show', id:8});
      await until(() => q('.show-hero h1')?.textContent === 'Show 8', 'An unnamed record lost its ID on the Show screen');
      await click('.show-rating');
      check(q('.personal-show-name')?.textContent === 'Show 8', 'The rating sheet did not identify the selected record');
      await click('.rating-slider input');
      await click('.rating-commands button');
      await until(() => q('.show-rating')?.textContent === '5/10', 'Rating the unnamed show did not finish');
      check((await store.snapshot()).tables.ratings.find(r => r.show_id === 8)?.show === '', 'Saving the rating replaced the empty CSV title');
    }));
  await run('A phone can go from Home to More, Show and Cast, then back to its sort and into the Library and Watchlist tabs', () =>
    fixture(320, async ({ q, click, waitFor, doc, win, store, service, libraryEvents }) => {
      await service.view({ kind: 'show', id: 45 });
      libraryEvents.dispatchEvent(new Event('cachechange'));
      await waitFor('[data-more] a');
      check(q('#more-heading a').getAttribute('href') === '#/watchlist/more-to-watch', 'Home More link lacks its section destination');
      await click('#more-heading a');
      await until(() => doc.activeElement === q('[data-section=more-to-watch] h2') && q('[data-section=more-to-watch] h2'), 'Home More link did not focus its heading');
      await waitFor('[data-section=more-to-watch] .watch-rows a');
      check(q('[data-section=more-to-watch] .watch-row-end').textContent === '3 left' && win.location.hash === '#/watchlist/more-to-watch',
        'More lost its section bookmark or the progress shown on Home');
      q('.sort-trigger').value = 'title';
      q('.sort-trigger').dispatchEvent(new Event('change',{bubbles:true}));
      await click('[data-section=more-to-watch] a[href="#/show/45"]');
      await click('a[href="#/cast/81?show=45"]');
      await until(() => q('.cast-page h1')?.textContent === 'Mira Vale', 'Cast link lost its source identity');
      const credit = await waitFor('.cast-row');
      check(credit.textContent.includes('Part watched') && credit.textContent.includes('Announcer'), 'Cast lost a watch or a role');
      await service.removeKey((await service.keyStatus()).generation);
      await click('.cast-row');
      await waitFor('.show-page');
      win.history.back();
      await waitFor('.cast-row');
      win.history.back();
      await waitFor('.show-page');
      win.history.back();
      await until(() => q('.sort-trigger')?.value === 'title', 'Back lost More’s selected sort');
      win.history.back();
      await waitFor('#more-heading a');
      check(win.location.hash === '#/home' || win.location.hash === '', 'Back from the Watchlist section did not return Home');
      await click('.phone-nav [data-destination=library]');
      await waitFor('.library-grid li');
      const search = q('.library-screen input[type=search]');
      search.value = 'listening'; search.dispatchEvent(new Event('input', { bubbles: true }));
      await click('.library-grid a');
      await waitFor('.show-page');
      win.history.back();
      await waitFor('.library-grid a');
      check(q('.library-screen input[type=search]').value === 'listening' && q('.library-screen h1').textContent === 'Library' && q('.phone-title').hidden,
        'Browser Back dropped the Library search or phone title');
      await click('.phone-nav [data-destination=watchlist]');
      await waitFor('.watchlist-screen .watch-rows a');
      const current = q('.phone-nav [aria-current=page]');
      check(current.textContent === 'Watchlist' && q('.watchlist-screen h1').textContent === 'Watchlist' && q('.phone-title').hidden, 'Watchlist tab title or selection is wrong');
      await store.commit((await store.snapshot()).revision, { put: { lists: [{ list: 'Hidden from upcoming', show_id: 45, show: title.name }] } });
      await until(() => !q('[data-watchlist-remove="45"]') && q('.watch-lead')?.textContent.includes('Watchlist') &&
        q('[data-section=more-to-watch] a[href="#/show/45"]'), 'A Watchlist edit removed an independently eligible More to watch show');
      check(doc.documentElement.scrollWidth <= 320 && !q('.report'), 'Phone flow overflowed or reported an error');
    }, { watched: [row(1, 1)], lists:[{list:'Following upcoming', show_id:45, show:title.name}] }));

  await run('A direct cast link validates its IDs and returns to its source show without creating history', async () => {
    for (const path of ['#/cast/0', '#/cast/9007199254740992', '#/cast/-1', '#/cast/3/extra']) {
      check(readRoute(path).page === 'home', 'Invalid cast ID was accepted');
    }
    check(routeHref(readRoute('#/upcoming')) === '#/watchlist', 'An old Upcoming bookmark lost its destination');
    check(routeHref(readRoute('#/more-to-watch')) === '#/watchlist/more-to-watch', 'An old More to watch bookmark lost its section');
    for (const path of ['#/library', '#/watchlist', '#/watchlist/more-to-watch', '#/cast/81', '#/cast/81?show=45', '#/cast/81?show=0']) {
      check(routeHref(readRoute(path)) === path, 'Route failed to round trip: ' + path);
    }
    for (const source of ['-1','00','9007199254740992']) {
      check(!('showId' in readRoute('#/cast/81?show=' + source)), 'Invalid source show was accepted');
    }
    const win = openPhoneEntry('/dist/index.html#/cast/81?show=0');
    try {
      const doc = await entryDocument(win);
      await until(() => doc.querySelector('.cast-page'), 'Direct Cast link did not open');
      const length = win.history.length;
      doc.querySelector('.phone-back').click();
      await until(() => win.location.hash === '#/show/0' && doc.querySelector('.show-page'), 'Back did not resolve the local source show');
      doc.querySelector('.phone-back').click();
      await until(() => doc.querySelector('.home-screen'), 'Direct reachability created a Back loop');
      check(length === win.history.length, 'Direct-link Back added a history entry');
    } finally { win.close(); }
  });

  await run('A 300-show overview batches cache reads, preserves file titles, and leaves the saved record intact', () =>
    fixture(1080, async ({ service, store }) => {
      const ids = Array.from({ length: 300 }, (_, i) => 1000 + i);
      const watched = ids.map(id => ({ ...row(1, 1, 2, id), show: 'Filed ' + id }));
      const entries = {};
      for (const id of ids) {
        // Season 1 has only one aired episode. Season 2 still uses the show's last-aired estimate.
        const value = { show_id: id, show: 'Cached ' + id, seasons: [{ season: 1, episodeCount: 3 }, { season: 2, episodeCount: 2 }],
          lastAired: { season: 2, episode: 1 }, nextAirDate: null, firstAirDate: null, posterPath: null };
        entries['tv/' + id + '?append_to_response=keywords,external_ids'] = { value, fetchedAt: Date.now() };
        entries['tv/' + id + '/season/1'] = { value: { episodes: [{ episode: 1, airDate: '2020-02-02' }] }, fetchedAt: Date.now() };
      }
      await store.commit((await store.snapshot()).revision, { put: { watched } });
      await store.writeTmdb((await store.tmdbState()).generation, { entries });
      await service.removeKey((await store.tmdbState()).generation);
      const before = await store.snapshot();
      const sizes = [];
      // Keep this probe confined to the explicit overview; Home also listens for edits.
      let lastWatchCount;
      const isolated = { store: { async overviewRows(...args) {
        const tables = await store.overviewRows(...args);
        lastWatchCount = tables.watched.length;
        return tables;
      }, tmdbEntries(keys, now) {
        sizes.push(keys.length); return store.tmdbEntries(keys, now);
      } }, environment: service.environment };
      const { shows } = await readOverview(isolated);
      check(shows.length === ids.length && shows.every(s => s.title === 'Filed ' + s.id && s.progress.watchedAired === 1 &&
        s.progress.aired === 2 && s.progress.plays === 2n), 'Batched season details or saved titles crossed show boundaries');
      check(sizes.length <= 3, 'The overview did not batch its cache reads: ' + sizes);
      check(sizes.includes(600) && sizes.includes(300), 'Filed titles and watched seasons should be read together, followed by the other declared seasons');
      const metadata = isolated.store.tmdbEntries;
      let combinedFailed = false;
      isolated.store.tmdbEntries = function(keys,...args) {
        if (keys.length===600 && keys.some(key=>key.includes('?append_to_response'))) {
          combinedFailed=true; return Promise.reject(Error('Interrupted combined metadata read'));
        }
        return metadata(keys,...args);
      };
      const recovered = await readOverview(isolated);
      check(combinedFailed && recovered.shows.length===300 && recovered.shows.every(show=>show.progress.aired===2),
        'A failed combined cache lookup lost the individual season fallback');
      isolated.store.tmdbEntries = metadata;
      const limited = await readOverview(isolated, [ids[1], 1, ids[1]]);
      check(limited.shows.length === 1 && limited.shows[0].id === ids[1], 'A cast projection repeated a credit or invented a recorded show');
      check(lastWatchCount === 1, 'Opening a cast member copied unrelated episode histories');
      const after = await store.snapshot();
      check(after.revision === before.revision && after.tables.watched.length === ids.length, 'Reading the overview mutated the record');
    }));

  await run('Watchlist moves a premiere from Upcoming to Available to watch on its local air date without a record edit', async () => {
    const lastMinute = new Date();
    lastMinute.setHours(23, 59, 59, 940);
    let clock = lastMinute.getTime();
    let onMidnight;
    await fixture(1080, async ({ q, click, service, store }) => {
      const { localCalendarDate } = await import('../dist/progress.js');
      const original = await service.view({ kind: 'show', id: 45 });
      const premiere = localCalendarDate(new Date(clock + 100));
      const value = { ...original.value, firstAirDate:premiere, lastAired:null, seasons:[], status:'Planned',
        nextAirDate:premiere, nextEpisode:{season:1, episode:1, airDate:premiere} };
      await store.writeTmdb((await store.tmdbState()).generation, { entries: {
        'tv/45?append_to_response=keywords,external_ids': { value, fetchedAt: clock },
      } }, clock);
      await click('.app-sidebar [data-destination=watchlist]');
      await until(() => q('[data-section=upcoming] time')?.dateTime === premiere, 'Future premiere was hidden');
      const before = (await store.snapshot()).revision;
      clock += 100;
      check(typeof onMidnight === 'function', 'The app did not schedule the local-midnight refresh');
      onMidnight();
      await until(() => q('[data-section=available] a')?.textContent.includes(title.name), 'The premiere stayed in Upcoming on its air date');
      check(!q('[data-section=upcoming] a') &&
        before === (await store.snapshot()).revision, 'Midnight altered the record or lost the Watchlist show');
      clock += 200 * 86_400_000;
      await store.purgeTmdb(clock);
      await until(() => q('.watchlist-screen .watch-row-text')?.textContent.includes('Schedule unavailable'), 'Expired metadata was still shown');
      const projection = await readOverview(service);
      check(projection.shows.length === 1 && projection.shows[0].lists.includes('Watchlist'), 'Cache eviction removed the personal record');
    }, { lists: [{ show_id: 45, show: title.name, list: 'Watchlist' }] }, ({ env, win }) => {
      env.now = () => clock;
      const timeout = win.setTimeout.bind(win);
      win.setTimeout = (callback, delay, ...args) => {
        if (delay === 60) { onMidnight = callback; return 0; }
        return timeout(callback, delay, ...args);
      };
    });
  });
}

export async function statisticsApplicationCases(run) {
  await run('A read-only Statistics tab follows Anime membership edits and refreshed keywords while offline', () =>
    fixture(320, async ({ name, store, service, env }) => {
      const metadata = (await service.view({kind:'show', id:45})).value;
      await store.selectStatisticsScope('anime');
      const frame = await frameAt('/screen-fixture#/statistics', 320);
      const root = frame.contentDocument.querySelector('#app');
      const reader = await openDeviceStore({name});
      const offline = new TmdbService(reader, fixtureClient(), {...env, online:() => false});
      const app = mountApplication(root, offline);
      const shows = () => root.querySelector('[data-stat="shows"] dd')?.textContent;
      try {
        await app.ready;
        check(reader.role === 'reader' && shows() === '0', 'Reader did not open with the saved Anime selection');
        await store.commit((await store.snapshot()).revision, {put:{lists:[{list:'ANIME', show_id:45, show:title.name}]}});
        await until(() => shows() === '1', 'Reader missed a list addition');
        await store.commit((await store.snapshot()).revision, {remove:{lists:[['ANIME',45]]}});
        await until(() => shows() === '0', 'Reader retained a removed list member');
        const key = tmdbResourceKey({kind:'show', id:45});
        await store.writeTmdb((await store.tmdbState()).generation, {entries:{
          [key]: {fetchedAt:Date.now(), value:{...metadata, keywords:[{id:9, name:'anime'}]}},
        }});
        await until(() => shows() === '1', 'Reader missed the refreshed keyword');
        await store.clearRebuildableCaches();
        await until(() => shows() === '0', 'Reader retained a cleared keyword');
      } finally { app.dispose(); offline.close(); reader.close(); frame.remove(); }
    }, {watched:[row(1,1)]}));

  await run('A failed first-open write leaves saved Statistics readable and an explicit retry enables the detail job', () =>
    fixture(320, async ({ store, q, click }) => {
      const before = await store.snapshot();
      const open = store.openStatistics.bind(store);
      let attempts = 0;
      store.openStatistics = () => {
        if (++attempts === 1) return Promise.reject(new DOMException('Fictional interrupted save', 'AbortError'));
        return open();
      };
      await click('.phone-nav [data-destination=statistics]');
      await until(() => q('[data-stat=plays] dd')?.textContent === '3', 'A failed preference write hid the watch record');
      check(!(await store.snapshot()).local.statisticsOpened && q('.report [role=status]') && attempts === 1,
        'A failed activation was stored, silently ignored or retried in a loop');
      await click('.report[data-retry] button');
      await until(async () => (await store.snapshot()).local.statisticsOpened === true, 'Explicit retry did not enable Statistics');
      check(JSON.stringify((await store.snapshot()).tables) === JSON.stringify(before.tables) && q('[data-stat=plays] dd').textContent === '3',
        'Retry changed the saved record');
    }, { watched: [row(1, 1, 3)] }));

  await run('Opening Statistics reads the watch record once and switching scopes reuses it until a real edit', () =>
    fixture(1080, async ({ store, q, click }) => {
      const overview = store.overviewRows.bind(store);
      let reads = 0;
      store.overviewRows = () => { reads++; return overview(); };
      await click('.app-sidebar [data-destination=statistics]');
      const plays = () => q('[data-stat=plays] dd')?.textContent;
      await until(() => plays() === '3', 'Statistics did not read the watch record');
      for (const [scope, count] of [['tv','3'],['anime','0'],['all','3']]) {
        await click('.stats-scope input[value=' + scope + ']');
        await until(async () => plays() === count && (await store.devicePreference('statisticsScope')).preference === scope,
          'A scope did not update and persist');
      }
      await new Promise(resolve => setTimeout(resolve,0));
      check(reads === 1, 'Remembering a Statistics preference reread the watch history');
      await store.commit((await store.snapshot()).revision, {put:{watched:[row(1,1,5)]}});
      await until(() => plays() === '5', 'Real watch edits must still refresh Statistics');
      await click('.stats-scope input[value=tv]');
      check(plays() === '5', 'A previously viewed scope kept the old episode totals');
    }, {watched:[row(1,1,3)]}));

  await run('Opening Stats from Home fills the cast chart from the detail job and keeps it available after a keyless reopen', () =>
    fixture(390, async ({ q, click, waitFor, doc, win, store, service, env, libraryEvents }) => {
      await libraryEvents.run();
      check(!(await store.snapshot()).local.statisticsOpened && !(await service.read({ kind: 'cast', id: 45 })),
        'Statistics work started before visiting the page');
      await click('.phone-nav [data-destination=statistics]');
      await until(() => q('[data-stat=plays] dd')?.textContent === '2', 'The saved plays did not appear');
      check(q('.phone-title').textContent === 'Statistics' && q('.phone-nav [aria-current=page]').textContent === 'Stats',
        'Phone title or selected tab is wrong');
      await click('button[data-table=cast]');
      await until(() => q('[data-chart=cast] tbody')?.textContent.includes('Mira Vale'), 'Cast credits did not fill in from the background job');
      check((await service.read({ kind: 'countries' }))?.value[0].name === 'New Zealand', 'Country names did not arrive');
      check(q('[data-stat=hours] dd').textContent === '1', 'Hours did not include both 30-minute plays');
      await store.commit((await store.snapshot()).revision, { put: { watched: [row(1, 1, 4)] } });
      await until(() => q('[data-stat=hours] dd')?.textContent === '2', 'Runtime or plays did not update after a personal edit');
      check(q('[data-chart=cast] tbody tr') && q('[data-stat=episodes] dd').textContent === '1', 'The refresh lost the table or counted a rewatch twice');
      await click('.stats-table-dialog .stats-table-heading button');
      await service.removeKey((await service.keyStatus()).generation);
      env.online = () => false;
      await click('.phone-nav [data-destination=home]');
      await waitFor('.home-screen');
      win.history.back();
      await waitFor('button[data-table=cast]');
      check(doc.title === 'Statistics · csvTV' && q('[data-stat=plays] dd').textContent === '4' &&
        (await store.snapshot()).local.statisticsOpened, 'Back lost the cached chart, route title or device-local first-open flag');
    }, { watched: [row(1, 1, 2)], ratings: [{ show_id: 45, show: title.name, rating: 8 }] },
    ({ service }) => new TmdbLibrary(service)));

  await run('Statistics matches runtimes safely across moved episodes, reused positions, missing IDs and cache expiry', () =>
    fixture(1080, async ({ service, store, env }) => {
      const episode = (episode, episode_id, runtime) => ({ episode, episode_id, runtime, airDate: '2020-01-01', title: 'Part ' + episode });
      const details = (season, episodes, reusedPositions = []) => ({ show_id: 45, season, episodes, reusedPositions });
      await service.view({ kind: 'show', id: 45 });
      const fetchedAt = env.now();
      const entries = {};
      const seed = (resource, value) => { entries[tmdbResourceKey(resource)] = { fetchedAt, value }; };
      seed({ kind: 'season', id: 45, season: 1 }, details(1, [episode(1, 101, 12), episode(2, 102, 20),
        episode(3, 103, 30), episode(4, 104, 40), episode(5, 105, 18), episode(6, 106, 60), episode(7, 107, 15)], [3]));
      seed({ kind: 'season', id: 45, season: 2 }, details(2, [episode(1, 106, 70)]));
      seed({ kind: 'season', id: 45, season: 0 }, details(0, [episode(1, 120, 7)]));
      seed({ kind: 'show', id: 97 }, null);
      await store.writeTmdb((await store.tmdbState()).generation, { entries }, fetchedAt);
      await service.removeKey((await store.tmdbState()).generation);
      const before = await store.snapshot();
      const input = await readStatisticsInput(service);
      check(input.shows.length === 2, 'An unwatched listing or rating entered the calculations');
      const selected = input.shows.find(s => s.id === 45);
      const actual = selected.episodes.map(({ row, runtime }) => [row.season, row.episode, runtime]);
      check(JSON.stringify(actual) === JSON.stringify([[0,1,7],[1,1,40],[1,2,null],[1,3,null],[1,4,null],[1,5,18],[1,6,null],[1,7,null],[1,8,null]]),
        'Statistics credited a different episode runtime: ' + JSON.stringify(actual));
      const gone = input.shows.find(s => s.id === 97);
      check(gone.missing && gone.episodes[0].runtime === null && gone.progress.plays === 2n, 'A 404 lost personal figures or gained runtime');
      env.now = () => fetchedAt + 240 * 86400000;
      const expired = await readStatisticsInput(service);
      check(expired.shows.every(s => !s.metadata && s.episodes.every(e => e.runtime === null)), 'Expired seasons contributed hours');
      const after = await store.snapshot();
      check(before.revision === after.revision && JSON.stringify(before.tables) === JSON.stringify(after.tables), 'Reading statistics rewrote episode identities');
    }, { watched: [{ ...row(0, 1), episode_id: 120 }, ...[104, 999, null, null, null, 106, 107, 107]
      .map((episode_id, i) => ({ ...row(1, i + 1), episode_id })), row(1, 1, 2, 97)],
      lists: [{ show_id: 98, show: 'Future library', list: 'Watchlist' }], ratings: [{ show_id: 99, show: 'Only rated', rating: 8 }] }));
}

export async function personalApplicationCases(run) {
  const dialogButton = async (doc, text) => {
    const button = await until(() => [...doc.querySelectorAll('dialog[open] button')].find(b =>
      b.textContent.trim() === text && !b.disabled), 'Missing dialog action ' + text);
    button.click();
  };
  await run('Adding from Search, rating from Show and deleting a custom list update Lists and Home across navigation', () =>
    fixture(320, async ({ q, click, waitFor, doc, win, store }) => {
      await click('.home-search input');
      const text = await waitFor('input[type=search]');
      text.value = 'Listening'; text.dispatchEvent(new Event('input', { bubbles: true })); text.form.requestSubmit();
      await click('.result-list');
      await click('dialog[open] input[type=checkbox][value=Watchlist]');
      await until(async () => (await store.snapshot()).tables.lists.length === 1, 'Search did not add the Watchlist membership');
      await dialogButton(doc, 'Done');
      await click('.phone-nav [data-destination=watchlist]');
      await click('.watchlist-screen a[href="#/show/45"]');
      await click('.show-rating');
      const slider = await waitFor('dialog[open] input[type=range]');
      slider.value = '8.5'; slider.dispatchEvent(new Event('input', { bubbles: true }));
      await dialogButton(doc, 'Done');
      await until(() => q('.show-rating')?.textContent === '8.5/10', 'The recorded rating did not reach the Show page');
      await click('.show-list');
      await dialogButton(doc, 'New list');
      const name = await waitFor('dialog[open] input:not([type=checkbox]):not([type=range]):not([type=search])');
      name.value = '  Weekend  '; name.dispatchEvent(new Event('input', { bubbles: true }));
      await dialogButton(doc, 'Create list');
      await until(async () => (await store.snapshot()).tables.lists.some(r => r.list === 'Weekend'), 'Creating Weekend did not commit');
      // The list editor may return to the membership sheet after creation.
      const sheet = q('dialog[open]');
      if (sheet) sheet.dispatchEvent(new Event('cancel', { cancelable: true }));
      // A first episode arriving from another device makes the existing plan ineligible.
      await store.commit((await store.snapshot()).revision,{put:{watched:[row(1,1)]}});
      const drop = await waitFor('.show-drop');
      check(drop.textContent === 'Drop' && drop.previousElementSibling === q('.show-actions .primary') &&
        drop.nextElementSibling === q('.show-list'), 'Drop should sit between the watch action and List');
      drop.focus();
      drop.click();
      await until(() => q('.show-drop')?.textContent === 'Pick Up', 'Drop did not update the show action');
      check(q('.show-drop').nextElementSibling === q('.show-list'), 'Pick Up should keep the same position as Drop');
      check(!q('.show-watchlist') && !q('.show-list-tag')?.textContent.includes('Stopped'), 'Dropped show exposed a redundant action or status list');
      await click('.phone-nav [data-destination=home]');
      await until(() => q('[data-more-count]')?.textContent === '0 shows' && q('[data-watchlist-count]')?.textContent === '0 shows', 'Home retained a dropped show');
      await click('.phone-nav [data-destination=library]');
      await click('[data-filter=dropped]');
      await click('.library-grid a[href="#/show/45"]');
      await click('.show-drop');
      await until(() => q('.show-drop')?.textContent === 'Drop', 'Picking up a show did not restore its actions');
      await click('.phone-nav [data-destination=home]');
      await until(() => q('[data-more-count]')?.textContent === '1 show' && q('[data-watchlist-count]')?.textContent === '0 shows',
        'Pick Up should return a started show only to More to watch');
      await click('.phone-nav [data-destination=lists]');
      await until(() => q('#chosen-list')?.textContent === 'Weekend', 'Lists did not open on the custom list');
      check(!q('[data-list-focus="chip/Watchlist"]'), 'Watchlist was duplicated under Lists');
      await click('.list-shows a[href="#/show/45"]');
      await waitFor('.show-rating');
      win.history.back();
      await until(() => q('#chosen-list')?.textContent === 'Weekend', 'Browser Back forgot the previously selected list');
      await click('[data-list-focus="remove/45"]');
      await waitFor('.remove-question[open]');
      check(doc.activeElement?.matches('[data-cancel]') && q('#remove-count').textContent.includes('Weekend'),
        'Last-show confirmation did not name the list or focus Cancel');
      await click('[data-cancel]');
      check((await store.snapshot()).tables.lists.some(r => r.list === 'Weekend'), 'Cancel removed the last show');
      await click('[data-list-focus="remove/45"]');
      await click('[data-accept]');
      await until(() => rootEmpty(), 'Deleting the last custom list did not show its empty state');
      function rootEmpty() { return !q('[data-list-focus="chip/Weekend"]') && q('.lists-screen')?.textContent.includes('No custom lists yet.'); }
      check(q('.undo-bar').hidden, 'Deleting a custom list offered Undo');
      await click('.phone-nav [data-destination=home]');
      await until(() => q('[data-more-count]')?.textContent === '1 show', 'Deleting Weekend changed Home progress');
      const record = (await store.snapshot()).tables;
      check(record.watched.length === 1 && record.ratings[0].rating === 8.5 && record.lists.some(r => r.list === 'Watchlist'),
        'A personal edit touched unrelated parts of the record');
    }));

  await run('A read-only Lists tab can browse and takes over local rating edits offline when the writer closes', () =>
    fixture(1080, async ({ service, store, name }) => {
      await service.view({ kind: 'show', id: 45 });
      await service.removeKey((await service.keyStatus()).generation);
      const frame = await frameAt('/screen-fixture#/lists', 1080);
      const doc = frame.contentDocument, reader = await openDeviceStore({ name });
      const offline = new TmdbService(reader, fixtureClient(), { now, online: () => false, visible: () => true });
      const root = doc.querySelector('#app');
      const app = mountApplication(root, offline);
      const q = selector => root.querySelector(selector);
      try {
        await app.ready;
        check(reader.role === 'reader' && q('.tab-state').textContent.includes('read-only'), 'Second tab was writable');
        check(!q('[data-list-focus="new"]:not(:disabled)') && !q('[data-list-focus="remove/45"]:not(:disabled)'),
          'Reader could change a list');
        app.go({page:'watchlist'});
        (await until(() => q('.watchlist-screen a[href="#/show/45"]'), 'Reader cannot browse its Watchlist')).click();
        await until(() => q('.show-rating')?.textContent === '7.5/10', 'Reader could not see the saved rating offline');
        check(!q('button.show-rating:not(:disabled)') && !q('button.show-list:not(:disabled)'), 'Reader could edit a rating or list');
        service.close(); store.close();
        await reader.whenWriter();
        const rate = await until(() => q('button.show-rating:not(:disabled)'), 'Taking the writer lock did not enable the rating control');
        rate.click();
        const slider = await until(() => q('dialog input[type=range]'), 'Could not edit cached title with no key');
        slider.value = '0'; slider.dispatchEvent(new Event('input', { bubbles: true }));
        await dialogButton(doc, 'Done');
        await until(() => q('.show-rating')?.textContent === '0/10', 'Zero became unrated after an offline edit');
        await until(() => !q('.undo-bar').hidden, 'Offline change has no Undo');
        q('[data-undo]').click();
        await until(() => q('.show-rating')?.textContent === '7.5/10', 'Offline Undo did not restore the rating');
        const reopened = await openDeviceStore({ name });
        try {
          const { tables } = await reopened.snapshot();
          check(tables.ratings[0].rating === 7.5 && tables.lists.length === 1 && !tables.watched.length,
            'Reopening lost the rating, added a watch or changed Watchlist membership');
        } finally { reopened.close(); }
      } finally { app.dispose(); offline.close(); reader.close(); frame.remove(); }
    }, { lists: [{ list: 'Watchlist', show_id: 45, show: title.name }],
      ratings: [{ show_id: 45, show: title.name, rating: 7.5 }] }));

  await run('Leaving a screen during quota recovery cannot replay an old rating or publish its Undo on the new screen', () =>
    fixture(320, async ({ app, doc, q, waitFor, click, store, service }) => {
      app.go({ page: 'show', id: 45 });
      await click('.show-rating');
      const slider = await waitFor('dialog input[type=range]');
      slider.value = '9'; slider.dispatchEvent(new Event('input', { bubbles: true }));
      const originalCommit = store.commit.bind(store);
      store.commit = async (revision, patch, options) => {
        if (patch.put?.ratings?.length) throw new DOMException('Fictional storage limit', 'QuotaExceededError');
        return originalCommit(revision, patch, options);
      };
      try {
        await dialogButton(doc, 'Done');
        await until(() => q('.report button')?.textContent === 'Clear cached titles and retry', 'Quota failure had no explicit retry');
      } finally { store.commit = originalCommit; }
      let clearing = false, finish;
      const gate = new Promise(resolve => { finish = resolve; });
      const clear = store.clearRebuildableCaches.bind(store);
      const edit = service.editPersonalRecord.bind(service);
      let replayed = false;
      store.clearRebuildableCaches = async () => { clearing = true; await gate; };
      service.editPersonalRecord = (...args) => { replayed = true; return edit(...args); };
      try {
        await click('.report button');
        await until(() => clearing, 'Retry did not start cache cleanup');
        app.go({ page: 'lists' });
        await waitFor('#chosen-list');
        finish();
        await new Promise(resolve => setTimeout(resolve, 0));
        check(!replayed && q('.undo-bar').hidden && !(await store.personalRows()).ratings.length,
          'A discarded screen saved an old rating during recovery');
      } finally { finish(); store.clearRebuildableCaches = clear; service.editPersonalRecord = edit; }
    }));
}
