import { mountTraktImport } from '../dist/trakt-import-screen.js';
import { planTraktImport } from '../dist/trakt-preview.js';
import { renderTraktPreview } from '../dist/trakt-review-screen.js';
import { emptyTables } from '../dist/model.js';
import { DropboxController } from '../dist/dropbox-controller.js';
import { DropboxDialogs } from '../dist/dropbox-dialogs.js';
import { TmdbClient } from '../dist/tmdb-client.js';
import { TmdbService } from '../dist/tmdb-service.js';
import { traktZip } from './trakt-fixture-cases.mjs';
import { withTraktDevices } from './trakt-import-cases.mjs';

function check(value, message) { if (!value) throw Error(message); }
async function until(read, message) {
  const end = performance.now() + 6000;
  do {
    const result = read();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 12));
  } while (performance.now() < end);
  throw Error(message);
}

export async function traktReviewCases(run) {
  await run('A Trakt show with only a matched special keeps its whole-show control', () => {
    const host = document.createElement('section'), snapshot = {tables:emptyTables(),local:{}};
    const show = {show_id:7,show:'Midnight Relay',year:2020,imdb_id:null};
    const source = {shows:[show],watched:[{...show,season:0,episode:1,episode_id:71,title:'Prelude',times_watched:1}],
      counts:[{...show,total:2,listedPlays:1,listedEpisodes:1,multiple:2}], ratings:[],lists:[],skipped:[],reusedPositions:new Set()};
    let plan = planTraktImport(source,snapshot);
    renderTraktPreview(host,plan,(selected,seasons,whole) => plan = planTraktImport(source,snapshot,selected,seasons,whole));
    const q = selector => host.querySelector(selector);
    q('[data-count-summary]').click();
    check(!q('[data-season-count]') && q('[data-count-review]').textContent.includes('No regular seasons to adjust.'),
      'A specials-only show offered a season editor or claimed its documented watch was missing');
    q('[data-whole-add]').click();
    check(plan.watched.length === 1 && plan.watched[0].row.episode_id === 71 && plan.watched[0].after === 2,
      'The hidden special was lost during a whole-show pass');
    q('[data-whole-remove]').click();
    check(plan.watched[0].after === 1,'Undo did not restore the exported special count');
  });

  await run('A newly ambiguous last export episode leaves earlier season and whole-show corrections reversible', async () => {
    const host = document.createElement('section'), snapshot = {tables:emptyTables(),local:{}};
    const q = selector => host.querySelector(selector);
    const title = {show_id:7,show:'Silent Harbor',year:2020,imdb_id:null};
    for (const extra of [-2,1]) {
      const details = new Map();
      const source = {shows:[title],watched:[{...title,season:1,episode:1,episode_id:11,title:'Arrival',times_watched:2}],
        ratings:[],lists:[],skipped:[],reusedPositions:new Set(),cache:new Map(),today:'2026-11-20',
        counts:[{...title,total:3,listedPlays:2,listedEpisodes:1,multiple:null}],
        reviewShows:new Map([[7,{seasons:[{season:1},{season:2}]}]]), reviewSeasons:new Map([[7,details]])};
      let plan;
      const update = (selected,seasons,whole) => plan = planTraktImport(source,snapshot,selected,seasons,whole);
      update(new Set(),new Map([[7,new Map([[1,extra]])]]),new Map([[7,1]]));
      renderTraktPreview(host,plan,update,async () => {
        details.set(2,{episodes:[{episode:2,episode_id:11,title:'Arrival',airDate:'2020-01-01'}]});
        return true;
      });
      q('[data-count-summary]').click(); q('[data-season-add="2"]').click();
      await until(()=>!plan.watched.length && plan.skipped.length===2,'Ambiguous placements remained after loading the second season');
      check(q('[data-whole-add]').disabled,'Whole-show additions remained enabled without an eligible matched episode');
      const undo = q(extra < 0 ? '[data-season-add="1"]' : '[data-season-remove="1"]');
      document.body.append(host);
      try {
        undo.focus({preventScroll:true});
        const top = window.scrollY;
        for (let i=0;i<Math.abs(extra);i++) {
          check(!undo.disabled,'A prior season correction became stuck');
          undo.click();
        }
        check(undo.disabled && !q('[data-whole-remove]').disabled,'Blocked season allowed another correction or whole-show undo was disabled');
        check(document.activeElement===q('[data-count-summary]') && window.scrollY===top,'Undo of the blocked season lost its show or scroll position');
        q('[data-whole-remove]').click();
        check(document.activeElement===q('[data-count-summary]') && window.scrollY===top,'Undo of a blocked whole show lost its show or scroll position');
        q('[data-season-remove="2"]').click();
      } finally { host.remove(); }
      check(!plan.seasonExtras.size && !plan.wholeShowPasses.size && !plan.watched.length && plan.skipped.length===1,
        'Undo revived the ambiguous episode or retained a manual selection');
    }
  });

  await run('Trakt steppers preserve exact watches and disable unrepresentable edits at both integer limits', () => {
    const limit = Number.MAX_SAFE_INTEGER;
    const host = document.createElement('section');
    const snapshot = {revision:1n, tables:emptyTables(), local:{}};
    function render(base, extra) {
      const title = {show_id:7,show:'Silent Harbor',year:2020,imdb_id:null};
      const source = {shows:[title],watched:[{show_id:7,show:title.show,season:1,episode:1,episode_id:11,
        title:'Arrival',times_watched:base}],ratings:[],lists:[],skipped:[],reusedPositions:new Set(),cache:new Map(),
        counts:[{show_id:7,show:title.show,total:base+1,listedPlays:base,listedEpisodes:1,multiple:null}]};
      let plan = planTraktImport(source,snapshot,new Set(),new Map([[7,new Map([[1,extra]])]]),new Map([[7,limit]]));
      host.replaceChildren();
      renderTraktPreview(host,plan,(selected,seasons,whole) => plan = planTraktImport(source,snapshot,selected,seasons,whole));
      host.querySelector('[data-count-summary]').click();
      return () => plan.watched[0].after;
    }
    const button = name => host.querySelector('[data-' + name + ']');
    const checkCount = (read, expected) => check(read() === expected &&
      button('season-count').textContent === expected.toLocaleString() + '×','Displayed and planned watches differ');
    let count = render(3,-limit);
    checkCount(count,3);
    check(button('season-remove').disabled && button('whole-add').disabled, 'An unrepresentable edit was enabled');
    button('season-remove').click();
    checkCount(count,3);
    button('season-add').click();
    checkCount(count,4);
    check(!button('season-remove').disabled, 'A representable decrement was blocked');
    button('season-remove').click();
    checkCount(count,3);
    count = render(2,-2);
    checkCount(count,limit);
    check(button('season-add').disabled, 'Season could exceed the maximum episode count');
    button('whole-remove').click();
    checkCount(count,limit-1);
    check(!button('season-add').disabled && !button('whole-add').disabled, 'A legal increment at the upper limit was blocked');
    button('season-add').click();
    checkCount(count,limit);
    check(button('season-add').disabled && button('whole-add').disabled, 'A further increase could discard the selection');
  });

  await run('After sync, the import dialog compares individual outcomes, keeps the count choice and cancels without importing', () =>
    withTraktDevices(async ({ linked }) => {
      const a = await linked(), b = await linked();
      const cloud = new DropboxController(a.auth, window, new DropboxDialogs(document));
      await cloud.refresh(true);
      await until(() => cloud.synced && !cloud.busy && a.store.providerKeysAvailable,
        'The reviewing device did not finish initial Dropbox sync');
      const show = { title: 'Fictional Estuary', ids: { tmdb: 72, trakt: 7 } };
      const numbers = Array.from({ length: 55 }, (_, i) => i + 1);
      const watched = numbers.map(n => ({ show: show.title, show_id: 72, season: 1, episode: n, episode_id: 8000 + n,
        title: 'Tide', times_watched: 1 }));
      await b.store.commit((await b.store.snapshot()).revision, { put: { watched, ratings: [{ show: show.title, show_id: 72, rating: 9 }] } });
      await b.sync();
      const zip = await traktZip({
        'watched-history-1.json': numbers.map(n => ({ type: 'episode', show, episode: {
          season: 1, number: n, title: 'Tide', ids: { trakt: n, tmdb: 8000 + n } } })),
        'watched-shows.json': [{ show, plays: 110 }],
        'ratings-shows.json': [{ show, rating: 8 }],
        'lists-favorites.json': [{ type: 'show', show }],
        'lists-watchlist.json': [{ type: 'episode' }],
      });
      const fetcher = async input => {
        const path = new URL(input).pathname;
        if (path === '/3/tv/72') return Response.json({ id: 72, name: show.title, status: 'Ended', first_air_date:'0000-01-01',
          seasons: [{ season_number: 1, episode_count: 55, name: 'Season one' }], last_episode_to_air: null,
          next_episode_to_air: null, keywords: { results: [] }, external_ids: { imdb_id: null } });
        if (path === '/3/tv/72/season/1') return Response.json({ season_number: 1, episodes: numbers.map(n => ({
          id: 8000 + n, episode_number: n, name: 'Tide', air_date: '2024-01-01' })) });
        throw Error('Unexpected fictional TMDB call ' + path);
      };
      const service = new TmdbService(a.store, new TmdbClient({ fetch: fetcher }), { online: () => true, visible: () => true, now: Date.now });
      const host = document.createElement('main'); document.body.append(host);
      const screen = mountTraktImport(host, { service, clearUndo() { throw Error('Canceled import cleared Undo'); } }, cloud);
      try {
        await screen.ready;
        const files = new DataTransfer(); files.items.add(zip);
        const picker = host.querySelector('input');
        picker.files = files.files; picker.dispatchEvent(new Event('change', { bubbles: true }));
        await until(() => host.querySelector('[data-count-review]'), 'Count check did not open');
        const report = label => host.querySelector('[data-import-report="' + label + '"]');
        const placements = () => report('Episode placements'), skipped = () => report('Skipped');
        await until(() => skipped()?.querySelector('li'), 'The skipped item was not listed');
        skipped().open = false;
        placements().open = true;
        await until(() => placements().querySelectorAll('li').length === 50, 'The first placement page did not open');
        placements().querySelector('button').click();
        check(placements().querySelectorAll('li').length === 55, 'The second placement page was not shown');
        host.querySelector('[data-count-summary]').click();
        host.querySelector('[data-season-add]').click();
        await until(() => placements().open && placements().querySelectorAll('li').length === 55 &&
          placements().querySelector('li:last-child').textContent.endsWith('0 → 2 plays'),
          'Changing the season estimate closed the placements, lost its second page or showed an old count');
        check(!skipped().open && !skipped().querySelector('li'), 'A manually closed report reopened or loaded rows');
        placements().open = false;
        host.querySelector('[data-season-remove]').click();
        check(!placements().open && !placements().querySelector('li'), 'Closed placements were loaded eagerly');
        placements().open = true;
        await until(() => placements().querySelectorAll('li').length === 55 &&
          placements().querySelector('li:last-child').textContent.endsWith('0 → 1 plays'),
          'Reopening a report lost its previously loaded page or the revised counts');
        host.querySelector('[data-season-add]').click();
        host.querySelector('[data-season-add]').click();
        check(host.querySelector('[data-season-count]').textContent === '3×' &&
          host.querySelector('[data-count-summary]').textContent.includes('55 plays above Trakt’s total of 110'),
          'The above-total season choice was not kept before sync');
        const matched = [...host.querySelectorAll('details')].find(item => item.querySelector('summary')?.textContent.startsWith('Matched shows'));
        matched.open = true;
        await until(() => matched.querySelector('li')?.textContent.includes('Fictional Estuary (0)'), 'Import details hid a numeric year of zero');
        check(!(await a.store.snapshot()).tables.watched.length, 'Remote data entered the original preview');
        host.querySelector('[data-apply]').click();
        const dialog = await until(() => {
          const d = document.querySelector('dialog[open]');
          return d?.querySelector('h2')?.textContent === 'Review updated import' && d;
        }, 'Reconfirmation did not open after sync');
        const summary = dialog.querySelector('summary');
        const [cancel, confirm] = dialog.querySelectorAll('.actions button');
        const key = shiftKey => dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true, shiftKey }));
        check(document.activeElement === dialog.querySelector('h2'), 'Dialog did not announce the changed preview first');
        key(true); check(document.activeElement === confirm, 'Reverse Tab escaped the heading');
        key(false); check(document.activeElement === summary, 'Tab did not reach the first review control');
        key(true); check(document.activeElement === confirm, 'Reverse Tab escaped the review summary');
        await until(() => dialog.querySelectorAll('li').length === 50, 'First fifty changes were not presented');
        const more = dialog.querySelector('details button');
        more.focus(); more.click();
        check(more.hidden && document.activeElement === summary, 'Loading the final changes did not retain keyboard focus');
        const details = [...dialog.querySelectorAll('li')].map(el => el.textContent);
        check(details.some(line => line.includes('keep your rating 9 (Trakt 8)')), 'Modal omitted the changed rating');
        check(details.some(line => line.includes('TMDB episode 8001') && line.includes('1 → 3 plays')) &&
          details.some(line => line.includes('TMDB episode 8055') && line.includes('1 → 3 plays')),
          'Updated placements lost the selected count or their episode identities');
        cancel.click();
        await until(() => !cloud.busy && host.querySelector('[data-status]').textContent === 'Import canceled.', 'Cancel left the import running');
        const final = await a.store.snapshot();
        check(final.tables.watched.length === 55 && final.tables.watched.every(row => row.times_watched === 1) &&
          final.tables.ratings[0]?.rating === 9 && !final.tables.lists.length, 'Cancel applied proposed rows or rolled back the prerequisite sync');
      } finally { screen.dispose(); cloud.close(); service.close(); host.remove(); }
    }));
}
