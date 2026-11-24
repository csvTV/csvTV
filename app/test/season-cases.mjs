import { connectFixtureProviders } from './provider-fixture-cases.mjs';
import { openDeviceStore } from '../dist/storage.js';
import { tmdbResourceKey, TmdbClient } from '../dist/tmdb-client.js';
import { TmdbService } from '../dist/tmdb-service.js';
import { WatchActions } from '../dist/watch-actions.js';
import { mountSeasonScreen } from '../dist/season-screen.js';
import { mountShowScreen } from '../dist/show-screen.js';

function check(value, message) { if (!value) throw new Error(message); }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const id = 95;
const title = 'Fictional signal tower';
const episode = (season, n, name, date) => ({
  episode: n, episode_id: 85000 + season * 100 + n, title: name, airDate: date,
  overview: '', stillPath: null, runtime: null,
});
const seasonEpisodes = [
  [episode(0, 1, 'Winter special', '2000-01-01')],
  [episode(1, 1, 'Sounding line', '2000-01-01'), episode(1, 2, 'Lanterns <em>lit</em>', '2000-01-02'),
    episode(1, 3, 'Low water', '2099-09-04'), episode(1, 4, 'Beyond the reef', null)],
  [episode(2, 1, 'High water', null)],
];
const watched = (s, n, count) => {
  const e = seasonEpisodes[s][n - 1];
  return { show_id: id, show: title, season: s, episode: n, episode_id: e.episode_id, title: e.title, times_watched: count };
};

async function exercise(options, body) {
  const id = options.showId ?? 95;
  const catalog = options.catalog ?? seasonEpisodes;
  const name = 'csvtv-season-' + crypto.randomUUID();
  const store = await openDeviceStore({ name });
  const service = new TmdbService(store, new TmdbClient({ fetch: () => { throw Error('Unexpected external call'); } }),
    { now: Date.now, visible: () => true, online: () => false });
  const frame = document.createElement('iframe');
  frame.width = options.desktop ? '1080' : '320';
  frame.height = '580';
  const loaded = new Promise(resolve => frame.addEventListener('load', resolve, { once: true }));
  frame.srcdoc = '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/settings.css"><link rel="stylesheet" href="/show.css"><link rel="stylesheet" href="/season.css"><section id="screen"></section>';
  document.body.append(frame);
  let mounted;
  try {
    await loaded;
    const doc = frame.contentDocument;
    const root = doc.querySelector('#screen');
    const initial = await connectFixtureProviders(store,name,[{setting:'tmdb_key',value:'fictional-screen-key'}]);
    await store.commit(initial.revision, { put: {
      watched: options.rows ?? [], lists: options.lists ?? [] } });
    const generation = (await store.tmdbState()).generation;
    const show = { show_id: id, show: title, lastAired: { season: 1, episode: options.lastAired ?? 2 }, nextAirDate: null,
      seasons: catalog.map((episodes, s) => ({ season: s, episodeCount: episodes.length, name: s ? 'Season ' + s : 'Specials' })) };
    const entries = {};
    const fetchedAt = Date.now();
    function cache(resource, value) { entries[tmdbResourceKey(resource)] = { value, fetchedAt }; }
    if (!options.parentExpired) cache({ kind: 'show', id }, options.missing ? null : show);
    catalog.forEach((episodes, s) => {
      if (s !== options.uncachedSeason) cache({ kind: 'season', id, season: s },
        { show_id: id, season: s, name: show.seasons[s].name, episodes });
    });
    check(await store.writeTmdb(generation, { entries, refused: options.refused ? 'Fictional rejection' : undefined }), 'Could not seed local metadata');
    if (options.noKey) await service.removeKey(generation);
    let question = null, confirmation = true, undo = null, lastRun = null;
    const watch = new WatchActions(service, async value => { question = value; return confirmation; },
      value => { undo = value; }, () => {});
    const ctx = { service, watch, go() {}, clearUndo: () => watch.clear(), run(operation) { lastRun = operation(); return lastRun; } };
    mounted = options.show ? mountShowScreen(root, ctx, id) : mountSeasonScreen(root, ctx, id, options.season ?? 1);
    await mounted.ready;
    const find = selector => root.querySelector(selector);
    function action(label) {
      return [...root.querySelectorAll('dialog button')].find(control => control.firstElementChild?.textContent === label || control.textContent === label);
    }
    function control(focus) { return find('[data-season-focus="' + focus + '"]'); }
    function label(episode) { return find('[data-episode="' + episode + '"] .season-episode'); }
    async function edit(node) {
      check(node && !node.disabled, 'Edit control is unavailable');
      lastRun = null;
      node.click();
      check(lastRun, 'Action did not start');
      await lastRun;
      await wait(0);
      await mounted.refresh();
    }
    async function changeSeasonCount(number, step) {
      find('[data-focus="watch-season-'+number+'"]').click();
      const form = find('.season-count-form');
      const dialog = form.closest('dialog');
      form.querySelector(step).click();
      await new Promise((resolve,reject) => {
        const timer = setTimeout(()=>reject(Error('Season watch editor did not finish')),5000);
        dialog.addEventListener('close',()=>{ clearTimeout(timer); resolve(); },{once:true});
        form.querySelector('[type=submit]').click();
      });
      await mounted.refresh();
    }
    const counts = async () => (await store.tmdbRows(id)).tables.watched.map(row => [row.season, row.episode, row.times_watched]);
    await body({ root, doc, frame, find, action, control, label, edit, changeSeasonCount, counts, watch, mounted, store, name, ctx,
      undo: () => undo, question: () => question, confirm: value => { confirmation = value; } });
  } finally {
    mounted?.dispose();
    frame.remove();
    service.close();
    store.close();
    await new Promise((resolve, reject) => {
      const removal = indexedDB.deleteDatabase(name);
      removal.onsuccess = resolve;
      removal.onerror = () => reject(removal.error);
    });
  }
}

export async function repairScreenCases(run) {
  const orphan = { ...watched(1, 3, 2), episode_id: 900001, title: 'Archive <signal>' };
  const moved = { ...watched(1, 3, 5), season: 3, episode: 5, title: 'Old tide' };
  const exchange = [{ ...watched(1, 1, 4), episode: 2 }, { ...watched(1, 2, 1), episode: 1 }];
  const rows = [orphan, moved, ...exchange];

  await run('Show lists the unlisted source season and reviews a swap and an occupied destination without changing the record', () =>
    exercise({ rows, show: true, desktop: true }, async ({ find, root, action, doc, counts, name, ctx, store, mounted }) => {
      const before = JSON.stringify(await counts());
      const review = find('.repair-notice button');
      check(review && root.querySelectorAll('.repair-notice:not([hidden])').length === 1 &&
        review.parentElement.textContent.includes('3 watched episodes'), 'Expected one show-wide repair notice on desktop.');
      check(find('.show-season-row[data-season="3"]'), 'The unlisted season with watched rows disappeared.');
      review.click();
      const dialog = find('dialog');
      check(dialog.matches(':modal') && dialog.getAttribute('aria-labelledby') === doc.activeElement.id, 'Review did not open as a named, focused dialog.');
      check(dialog.querySelectorAll('.repair-moves li').length === 3 && dialog.textContent.includes('Season 3, episode 5 to Season 1, episode 3') &&
        dialog.textContent.includes('Old tide') && dialog.textContent.includes('Low water') &&
        dialog.textContent.includes('Archive <signal>') && dialog.textContent.includes('7 plays') && !dialog.querySelector('signal'), 'Review lost positions, titles or combined count.');
      action('Update').focus();
      action('Update').dispatchEvent(new KeyboardEvent('keydown', { key:'Tab', bubbles:true, cancelable:true }));
      check(doc.activeElement === action('Cancel'), 'Tab left the review sheet.');
      dialog.dispatchEvent(new Event('cancel', { cancelable:true }));
      check(!find('dialog') && doc.activeElement === review && JSON.stringify(await counts()) === before, 'Cancel must restore Review focus and preserve every count.');

      const reader = await openDeviceStore({ name });
      const readerService = new TmdbService(reader, ctx.service.client, ctx.service.environment);
      const other = doc.createElement('section');
      root.append(other);
      const readScreen = mountSeasonScreen(other, { ...ctx, service: readerService }, id, 1);
      try {
        await readScreen.ready;
        check(!other.querySelector('.season-actions button'), 'A reader tab offered to edit the season watches.');
        other.querySelector('.repair-notice button').click();
        check(other.querySelector('[data-repair-update]').disabled, 'A reader tab offered to commit an episode move.');
      } finally { readScreen.dispose(); readerService.close(); reader.close(); other.remove(); }
      const generation = (await store.tmdbState()).generation;
      const key = tmdbResourceKey({ kind: 'show', id });
      await store.writeTmdb(generation, { entries: { [key]: { fetchedAt: Date.now(), value: null } } });
      await mounted.refresh();
      check(find('.show-season-row[data-season="3"]') && find('.repair-notice').hidden, 'A provider removal hid a recorded season or left the old move visible.');
    }));

  await run('Season can remove one orphan play, re-review changed counts, and atomically update the reviewed moves', () =>
    exercise({ rows }, async ({ control, label, action, edit, root, doc, store, find, counts, frame }) => {
      const orphanLabel = label('record-3');
      check(orphanLabel.textContent.includes('Not on TMDB') && orphanLabel.textContent.includes('Archive <signal>') &&
        control('record-3-count').textContent === '2×' && !control('record-3-subtract').disabled &&
        label('episode-3').textContent.includes('Low water') && control('episode-3-count').textContent === '0×' &&
        ['episode-3-count','episode-3-add','episode-3-subtract','record-3-add'].every(key => control(key).disabled),
        'The replacement must not inherit or edit the saved episode’s watches.');
      await edit(control('record-3-subtract'));
      const archived = (await store.tmdbRows(id)).tables.watched.find(row => row.episode_id === orphan.episode_id);
      check(archived.times_watched === 1 && control('record-3-count').textContent === '1×' && control('episode-3-count').textContent === '0×',
        'Decreasing the saved row must preserve its identity and leave the replacement unwatched.');
      control('episode-repair').click();
      check(find('dialog').textContent.includes('6 plays') && find('dialog').scrollWidth <= find('dialog').clientWidth, 'Adjusted sum or small-screen layout was incorrect.');
      const current = await store.tmdbRows(id);
      await store.commit(current.revision, { put: { watched: [{ ...moved, times_watched: 7 }] } });
      await edit(action('Update'));
      check(find('dialog')?.textContent.includes('8 plays') && find('dialog [role="status"]').textContent.includes('revised list') &&
        (await counts()).some(([s]) => s === 3), 'Stale approval moved rows or failed to show the revised count.');
      await edit(action('Update'));
      check(!find('dialog') && control('episode-repair').hidden && root.querySelector('.repair-notice [role="status"]').textContent === 'Updated 3 episodes.' && !label('record-3') &&
        JSON.stringify(await counts()) === '[[1,1,4],[1,2,1],[1,3,8]]', 'Updating lost a swap count or combined the wrong rows.');
      check(doc.activeElement === control('heading') && doc.documentElement.scrollWidth <= frame.clientWidth, 'Updated Season lost focus or overflowed the viewport.');
    }));

  await run('A reused position keeps unidentified saved plays separate from its new episode until the position is freed', async () => {
    const legacy = {...watched(1,1,2),episode_id:null,title:'Former episode'};
    for (const parentExpired of [false,true]) {
      await exercise({rows:[legacy],lists:[{show_id:id,show:title,list:'Watchlist'}],parentExpired}, async ({ctx,store,watch,mounted,control,label,edit,name}) => {
        const key = tmdbResourceKey({kind:'season',id,season:1});
        const entry = await ctx.service.read({kind:'season',id,season:1});
        const {generation} = await store.tmdbState();
        await store.writeTmdb(generation,{entries:{[key]:{...entry,value:{...entry.value,reusedPositions:[1]}}}});
        await mounted.refresh();
        check(label('record-1')?.textContent.includes('identity unknown') &&
          control('record-1-count').textContent === '2×' && control('episode-1-count').textContent === '0×' &&
          control('episode-1-add').disabled, 'Unidentified plays appeared under the replacement title');
        for (const action of [() => watch.episode(watched(1,1,1),'again'),() => watch.bulk(id,{season:1},'mark')]) {
          let denied = false;
          try { await action(); } catch (error) { denied = error.message.includes('unidentified'); }
          check(denied,'A stale control could change the unidentified plays');
        }
        await edit(control('record-1-subtract'));
        const reader = await openDeviceStore({name});
        try {
          const rows = (await reader.tmdbRows(id)).tables.watched;
          check(rows.length === 1 && rows[0].episode_id === null && rows[0].times_watched === 1 &&
            rows[0].title === legacy.title,'An unrelated watch was lost or relabeled after reopen');
        } finally { reader.close(); }
        await edit(control('record-1-subtract'));
        await edit(control('episode-1-add'));
        const [row] = (await store.tmdbRows(id)).tables.watched;
        check(row?.episode_id === watched(1,1,1).episode_id && row.times_watched === 1,
          'A deliberate watch failed to use the current episode after the slot was freed');
      });
    }
  });

  await run('Incomplete season coverage does not label an unmatched stable episode ID as absent from TMDB', () =>
    exercise({ rows: [orphan], uncachedSeason: 2 }, async ({ control, label, root, edit, store }) => {
      check(label('record-3').textContent.includes(orphan.title) && control('record-3-count').textContent === '2×' &&
        control('episode-3-count').disabled && !root.textContent.includes('Not on TMDB') && root.querySelector('.repair-notice').hidden,
        'Keep the separate saved episode available while another season has not been checked.');
      await edit(control('record-3-subtract'));
      await edit(control('record-3-subtract'));
      check(!label('record-3') && !control('episode-3-add').disabled, 'Removing the last displaced play should free the position.');
      await edit(control('episode-3-add'));
      const rows = (await store.tmdbRows(id)).tables.watched;
      check(rows.length === 1 && rows[0].episode_id === seasonEpisodes[1][2].episode_id && rows[0].times_watched === 1,
        'The next watch must belong to the replacement episode.');
    }));
}

export async function seasonCases(run) {
  await run('A pre-update flat cache opens broadcast seasons offline, keeps episode IDs on edits and recovers after reopening', async () => {
    const showId = 237150;
    const catalog = [[], Array.from({length:32}, (_, i) => episode(1,i+1,'Beacon ' + (i+1),'2001-01-01'))];
    const row = n => ({show_id:showId, show:title, season:1, episode:n, episode_id:catalog[1][n-1].episode_id,
      title:'Beacon ' + n, times_watched:1});
    const options = {showId,catalog,lastAired:32, rows:[row(12),row(13),row(25)]};
    await exercise({...options,show:true,desktop:true}, async ({root,ctx,mounted,counts,changeSeasonCount}) => {
      const rows = [...root.querySelectorAll('.show-season-row')];
      check(rows.slice(0,3).map(r=>r.querySelector('small').textContent).join('/') === '1 of 12 episodes/1 of 12 episodes/1 of 8 episodes',
        'Show miscounted native Season 1 as a single run');
      let destination;
      ctx.go = route => {destination = route;};
      rows[1].click();
      check(destination?.season === 2 && destination.id === showId,'Season tile did not link to the broadcast season');
      await changeSeasonCount(3,'[data-increase]');
      const after = await counts();
      check(after.filter(([s,n])=>s===1 && n>=25).length === 8 && after.find(([,n])=>n===25)?.[2] === 2 &&
        JSON.stringify(after.filter(([,n])=>n<25)) === '[[1,12,1],[1,13,1]]',
        'Editing the broadcast season changed another season or discarded its partial watch');
      mounted.dispose();
    });
    await exercise({...options,season:2}, async ({root,find,ctx,store,name,control,edit,action,counts,watch,mounted}) => {
      check(find('h1').textContent === 'Season 2' && root.querySelectorAll('.season-episode').length === 12 &&
        control('episode-13-count').getAttribute('aria-label').includes('Episode 1, Beacon 13'), 'Deep link did not open the correct episode list');
      await edit(control('bulk'));
      check((await counts()).length === 14,'Mark touched another season');
      await edit(control('remove'));
      check(JSON.stringify(await counts()) === '[[1,12,1],[1,25,1]]','Removal crossed a broadcast boundary');
      await watch.undo();
      await mounted.refresh();
      const reader = await openDeviceStore({name});
      const other = document.createElement('main');
      root.append(other);
      const readerService = new TmdbService(reader,ctx.service.client,ctx.service.environment);
      const reopened = mountSeasonScreen(other,{...ctx,service:readerService},showId,2);
      try {
        await reopened.ready;
        check(other.querySelector('.season-summary').textContent.includes('12 of 12') &&
          (await store.tmdbRows(showId)).tables.watched.every(r=>r.season===1 && r.episode_id===catalog[1][r.episode-1].episode_id),
          'Reopening lost counts or rewrote the provider episode identities');
      } finally { reopened.dispose(); readerService.close(); reader.close(); other.remove(); }
    });
  });
  await run('Episode titles stay plain text at zero and after a watch, while the row controls can mark and undo future episodes', () =>
    exercise({}, async ({ control, label, root, find, edit, doc, frame, counts, undo, mounted, watch, store }) => {
      check(label('episode-3').textContent.includes('4 Sep 2099') && label('episode-4').textContent.includes('No date'), 'Future and undated labels');
      check(!root.querySelector('em') && label('episode-2').textContent.includes('<em>lit</em>'), 'Episode titles must stay text');
      check(control('bulk').textContent === 'Mark watched' && !control('remove') && !find('progress'), 'An unwatched season should have only its first-watch action');
      check(doc.documentElement.scrollWidth <= frame.clientWidth, 'Season overflowed at 320px');
      const historyReads = [], read = store.tmdbRows.bind(store);
      store.tmdbRows = (id, includeRecent) => { historyReads.push(includeRecent !== false); return read(id,includeRecent); };
      const privateReads=[], get=IDBObjectStore.prototype.get;
      IDBObjectStore.prototype.get=function(key){
        if(this.name==='local' && (key==='recentlyMarked' || key==='displacedRecentMark'))privateReads.push(key);
        return get.apply(this,arguments);
      };
      try{await mounted.refresh();}finally{IDBObjectStore.prototype.get=get;}
      check(!privateReads.length && !historyReads.includes(true), 'Displaying one season loaded the account’s Recently marked history');
      const tapTitle = () => {
        const title = label('episode-3').querySelector('.episode-name');
        check(!title.closest('.episode-row').contains(title.closest('button,a,[role=button],[tabindex]')), 'The title became a focusable control');
        title.click();
      };
      tapTitle(); await wait(0);
      check(!find('dialog') && !(await counts()).length && !undo(), 'Tapping an unwatched title edited the record');
      historyReads.length = 0;
      await edit(control('episode-3-add'));
      check(historyReads.includes(true), 'An explicit watch missed its Recently marked context');
      check(control('episode-3-count').textContent === '1×' && root.textContent.includes('0 watched · 2 left'), 'Future watch changed aired progress');
      tapTitle(); await wait(0);
      check(!find('dialog') && JSON.stringify(await counts()) === '[[1,3,1]]', 'Tapping a watched title opened a menu or edited the record');
      control('episode-3-count').click();
      const dialog = find('dialog');
      check(dialog.matches(':modal') && dialog.querySelector('input').value === '1', 'The count opens the exact episode editor');
      const previousCount = control('episode-3-count');
      await mounted.refresh();
      check(!previousCount.isConnected && dialog.open, 'The background redraw should preserve the open count editor');
      dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
      check(!find('dialog') && doc.activeElement === control('episode-3-count'), 'Escape must restore the invoking count control');
      await edit(control('episode-3-add'));
      check(control('episode-3-count').textContent === '2×' && undo(), 'Future episode can be rewatched');
      await watch.undo(); await mounted.refresh();
      check(control('episode-3-count').textContent === '1×' && !undo(), 'Undo returns to the prior count and clears itself');
      await edit(control('episode-4-add'));
      check(JSON.stringify(await counts()) === '[[1,3,1],[1,4,1]]', 'Dates must not prevent an explicit watch');
    }));

  await run('Season bulk mark, rewatch, confirmed removal and Undo preserve the exact episode scopes', () =>
    exercise({ rows: [watched(0, 1, 4), watched(1, 2, 2), watched(1, 3, 1)] },
      async ({ control, edit, action, counts, undo, question, confirm, watch, mounted, find }) => {
        check(control('bulk').textContent === 'Mark watched' && control('bulk').nextElementSibling === control('remove') &&
          control('remove').textContent === 'Remove watches', 'Partial season should have adjacent watch and removal actions');
        await edit(control('bulk'));
        check(JSON.stringify(await counts()) === '[[0,1,4],[1,1,1],[1,2,2],[1,3,1]]', 'Mark watched should fill only unwatched aired rows');
        check(control('bulk').textContent === 'Watched again' && find('progress').value === 1 && find('progress').max === 2, 'Rewatch progress');
        await edit(control('bulk'));
        check(JSON.stringify(await counts()) === '[[0,1,4],[1,1,2],[1,2,3],[1,3,1]]', 'Bulk again touched unaired episodes or specials');
        confirm(false); await edit(control('remove'));
        check(question().episodes === 3 && question().plays === 6n && (await counts()).length === 4, 'Confirmation must count all season plays and respect Cancel');
        confirm(true); await edit(control('remove'));
        check(JSON.stringify(await counts()) === '[[0,1,4]]' && undo() && !control('remove') &&
          control('bulk').textContent === 'Mark watched', 'Removal should restore the untouched controls and leave other seasons');
        await watch.undo(); await mounted.refresh();
        check(JSON.stringify(await counts()) === '[[0,1,4],[1,1,2],[1,2,3],[1,3,1]]', 'Removal undo restored the wrong counts');
      }));

  await run('Season with no aired episode hides its bulk action, and desktop and Specials retain the correct controls', async () => {
    await exercise({ show:true, desktop:true, rows:[watched(0,1,3)] }, async ({ find, edit, action, counts }) => {
      const mark = () => find('.show-actions .primary');
      const markSeason = () => find('[data-focus=watch-season-1]');
      find('.show-more').click();
      check(action('Season order') && !action('Remove watches') && mark()?.textContent === 'Mark watched' && markSeason()?.textContent === '0×' &&
        !find('button[data-focus="watch-season-0"]:enabled') && !find('button[data-focus="watch-season-2"]:enabled'),
        'A special-only watch must not expose removal for the whole show or regular season');
      action('Cancel').click();
      await edit(mark());
      check(mark()?.textContent === 'Watched again' && find('.show-more') && markSeason()?.textContent === '1×',
        'After the first pass, the show should switch to rewatch and its season should display 1×');
      find('.show-more').click(); await edit(action('Remove watches'));
      find('.show-more').click();
      check(action('Season order') && !action('Remove watches') && mark()?.textContent === 'Mark watched' && markSeason()?.textContent === '0×' &&
        JSON.stringify(await counts()) === '[[0,1,3]]', 'Removing regular watches left a stale menu or changed Specials');
      action('Cancel').click();
    });
    await exercise({show:true,rows:[watched(0,1,4),watched(1,1,2),watched(1,2,1),watched(1,3,5)]},
      async ({root,ctx,name,find,counts,changeSeasonCount,watch,mounted,edit}) => {
        const initial = JSON.stringify(await counts());
        const badge = () => find('[data-focus=watch-season-1]');
        check(badge().textContent === '1×','Partial rewatches obscured the completed season count');
        const link = find('a[data-season="1"]'), button = find('[data-focus=add-season-1]');
        await mounted.refresh();
        check(link === find('a[data-season="1"]') && button === find('[data-focus=add-season-1]'),
          'An unrelated refresh detached the touch targets on an unchanged season');
        await edit(find('[data-focus=add-season-1]'));
        check(badge().textContent === '2×' && !find('dialog') && JSON.stringify(await counts()) === '[[0,1,4],[1,1,3],[1,2,2],[1,3,5]]',
          'A quick season watch must add one play to each aired episode and preserve extras');
        check(!find('[data-focus=add-season-0], [data-focus=add-season-2]'),'Specials or unaired season offered a quick watch');
        await watch.undo(); await mounted.refresh();
        check(JSON.stringify(await counts()) === initial,'Undo after a quick watch lost episode-specific plays');
        await changeSeasonCount(1,'[data-decrease]');
        check(badge().textContent === '0×' && JSON.stringify(await counts()) === '[[0,1,4],[1,1,1],[1,3,5]]',
          'Lowering completed watches discarded partial rewatches or changed a future episode or special');
        await watch.undo(); await mounted.refresh();
        check(badge().textContent === '1×' && JSON.stringify(await counts()) === initial,'Undo lost uneven per-episode counts');
        const reader = await openDeviceStore({name});
        const readerService = new TmdbService(reader,ctx.service.client,ctx.service.environment);
        const section = root.ownerDocument.createElement('section');
        root.append(section);
        const viewer = mountShowScreen(section,{...ctx,service:readerService},id);
        try {
          await viewer.ready;
          const tile = section.querySelector('[data-season="1"]').closest('.show-season-tile');
          check(tile.querySelector('.show-view-count')?.textContent === '1×' && !tile.querySelector('button'),
            'Read-only tab should show a completed count with no editing control');
        } finally { viewer.dispose(); readerService.close(); reader.close(); section.remove(); }
      });
    await exercise({show:true,rows:[watched(1,1,1),watched(1,2,Number.MAX_SAFE_INTEGER)]},async ({find,watch,mounted,counts})=>{
      const before = await counts();
      check(find('[data-focus=watch-season-1]').textContent==='1×' && find('[data-focus=add-season-1]').disabled,
        'Quick add should be disabled when a single aired episode has reached the watch limit');
      const result = await watch.setSeasonCount(id,{season:1},1,2).then(()=>null,e=>e);
      check(result instanceof RangeError && result.message.includes('watch limit') && JSON.stringify(await counts())===JSON.stringify(before),
        'Overflow must explain the episode limit and leave the record untouched');
      await watch.setSeasonCount(id,{season:1},1,0); await mounted.refresh();
      check(!find('[data-focus=add-season-1]').disabled,'Lowering the season count should re-enable quick add');
    });
    await exercise({ season: 2, desktop: true }, async ({ control, edit, find }) => {
      check(!control('bulk') && !control('remove') && !find('progress'), 'Empty removal or marking control should be absent');
      await edit(control('episode-1-add'));
      check(!control('bulk') && control('remove')?.closest('.season-heading'), 'Desktop Season should expose removal for the individual watch');
    });
    await exercise({ season: 0, rows: [watched(0, 1, 3)] }, async ({ control, find, edit }) => {
      check(find('h1').textContent === 'Specials' && !find('progress') && !find('.rewatched'), 'Specials do not have completed or rewatch states');
      await edit(control('bulk'));
      check(control('episode-1-count').textContent === '4×' && !find('.rewatched'), 'A specials season should be markable on its own');
    });
  });

  await run('Season respects missing shows and credentials, and can use its own cache after the parent entry expires', async () => {
    for (const option of [{ missing: true }, { noKey: true }, { refused: true }]) {
      await exercise({ ...option, rows: [watched(1, 1, 1)] }, async ({ control, action, edit, counts, root }) => {
        const message = option.missing ? 'Not on TMDB' : option.refused ? 'TMDB refused the key.' : 'A TMDB key is needed.';
        check(root.textContent.includes(message) && !control('bulk'), 'Missing-show or credential state');
        check(control('remove') && !control('bulk'), 'Missing season should allow removal of saved watches');
        check(control('episode-1-add').disabled, 'Adding to the unavailable episode must be disabled');
        await edit(control('episode-1-subtract'));
        check(!(await counts()).length, 'Remove one must delete the final row without metadata or a key');
      });
    }
    // A later visit can leave a valid season entry after the show's older
    // entry expires. Its saved title and complete episode list suffice offline.
    await exercise({ parentExpired: true, rows: [{...watched(0, 1, 2), show:''}],
      lists: [{show_id:id, show:'', list:'First'}, {show_id:id, show:title, list:'Later'}] },
    async ({ control, edit, counts, action, watch, mounted }) => {
      await edit(control('bulk'));
      await watch.undo();
      await mounted.refresh();
      check(JSON.stringify(await counts()) === '[[0,1,2]]', 'The cached season lost its saved title or failed to undo the bulk mark');
      await edit(control('episode-3-add'));
      check(JSON.stringify(await counts()) === '[[0,1,2],[1,3,1]]', 'An exact cached episode should be markable after parent expiry');
      await edit(control('bulk'));
      check(JSON.stringify(await counts()) === '[[0,1,2],[1,1,1],[1,2,1],[1,3,1]]', 'The cached season can fill unwatched aired episodes');
      await edit(control('bulk'));
      check(JSON.stringify(await counts()) === '[[0,1,2],[1,1,2],[1,2,2],[1,3,1]]', 'A season rewatch used the wrong scope after parent expiry');
      const failure = await watch.bulk(id, {}, 'again').then(() => null, error => error.kind);
      check(failure === 'unreachable', 'A whole-show mark still requires the full set of seasons');
    });
  });
}
