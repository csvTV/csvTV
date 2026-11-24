import { connectFixtureProviders } from './provider-fixture-cases.mjs';
import { mountShowScreen } from '../dist/show-screen.js';
import { mountSeasonScreen } from '../dist/season-screen.js';
import { openDeviceStore } from '../dist/storage.js';
import { TmdbClient } from '../dist/tmdb-client.js';
import { TmdbService } from '../dist/tmdb-service.js';
import { WatchActions } from '../dist/watch-actions.js';

function check(value, message) { if (!value) throw new Error(message); }
async function until(predicate, message = 'Show screen did not settle.') {
  const end = performance.now() + 4000;
  while (!await predicate()) {
    if (performance.now() > end) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

export async function showCases(run) {
  const id = 17;
  const title = 'Sable <Harbour>';
  const show = { id, name: title, status: 'Returning Series', first_air_date: '2017-01-01',
    overview: 'Two signal keepers hear a train under the sea.', keywords: { results: [] }, external_ids: {},
    seasons: [{ season_number: 0, episode_count: 2 }, { season_number: 2, episode_count: 1 }, { season_number: 1, episode_count: 3 }],
    last_episode_to_air: { season_number: 1, episode_number: 2, air_date: '2021-01-04' } };
  const episode = (season, number, date) => ({ id: 1700 + season * 10 + number, episode_number: number,
    name: 'Signal ' + season + '.' + number, air_date: date });
  const seasonEpisodes = [
    [episode(0, 1, '2018-01-03'), episode(0, 2, '2019-01-03')],
    [episode(1, 1, '2021-01-03'), episode(1, 2, '2021-01-04'), episode(1, 3, '2099-05-01')],
    [episode(2, 1, null)],
  ];
  const watched = (season, number, count) => ({ show_id: id, show: title, season, episode: number,
    episode_id: 1700 + season * 10 + number, title: 'Signal ' + season + '.' + number, times_watched: count });
  const config = { images: { secure_base_url: 'https://image.tmdb.org/t/p/', poster_sizes: ['w185'],
    backdrop_sizes: ['w780'], profile_sizes: ['w185'], still_sizes: ['w185'] } };
  const requests = [];
  const regularCast = ['Zoë Vale', '<b>Kit</b>'].map((name, i) =>
    ({ id: 88 + i, name, total_episode_count: 1, roles: [{ character: 'Conductor' }] }));
  let cast = regularCast;
  let unavailable = false;
  let hold;
  const client = new TmdbClient({ sleep:async () => {}, fetch: async url => {
    const path = new URL(url).pathname.replace('/3/', '');
    requests.push(path);
    if (hold?.path === path) await hold.gate.promise;
    if (path === 'configuration') return Response.json(config);
    if (path === 'tv/17') return unavailable ? new Response(null,{status:503}) : Response.json(show);
    if (path === 'tv/17/aggregate_credits') return Response.json({ id, cast });
    if (path === 'tv/17/recommendations') return Response.json({ page: 1, total_pages: 1, results: [
      { id: 19, name: 'North Reel' }, { id: 18, name: 'Aster Semaphore' }] });
    const season = /^tv\/17\/season\/([012])$/.exec(path);
    if (season) return Response.json({ season_number: Number(season[1]), episodes: seasonEpisodes[season[1]] });
    return new Response(null, { status: 404 });
  } });
  const name = 'csvTV-show-' + crypto.randomUUID();
  const store = await openDeviceStore({ name });
  const environment = { online: () => true, visible: () => true, now: Date.now };
  const service = new TmdbService(store, client, environment);
  const personal = new WatchActions(service, async () => false, () => {}, () => {});
  const frame = document.createElement('iframe');
  frame.width = '320';
  frame.height = '600';
  const loaded = new Promise(resolve => frame.addEventListener('load', resolve, { once: true }));
  frame.srcdoc = '<!doctype html><link rel="stylesheet" href="/settings.css"><link rel="stylesheet" href="/home-search.css"><link rel="stylesheet" href="/show.css"><link rel="stylesheet" href="/season.css"><link rel="stylesheet" href="/personal-sheets.css"><main></main>';
  document.body.append(frame);
  await loaded;
  const doc = frame.contentDocument;
  const root = doc.querySelector('main');
  const click = selector => root.querySelector(selector).click();
  const values = selector => Array.from(root.querySelectorAll(selector), node => node.textContent);
  let screen;
  const navigation = [];
  const removals = [];
  let pending;
  const ctx = {
    service, go(route) { navigation.push(route); }, clearUndo() {},
    run(action) { pending = action(); return pending; },
    watch: {
      setMembership: (show,list,enabled) => personal.setMembership(show,list,enabled),
      async bulk(showId, scope, kind) { await service.mark(showId, scope, kind); await screen.refresh(); },
      async remove(...args) { removals.push(args); },
    },
  };
  function mount(showId = id) {
    screen?.dispose();
    screen = mountShowScreen(root, ctx, showId);
    return screen.ready;
  }
  function mountSeason(number) {
    screen?.dispose();
    screen = mountSeasonScreen(root,ctx,id,number);
    return screen.ready;
  }
  try {
    await connectFixtureProviders(store,name);
    await service.saveKey('fictional-show-screen');
    const { revision } = await store.snapshot();
    await store.commit(revision, { put: { watched: [watched(1, 1, 2), watched(1, 3, 4), watched(0, 1, 2), watched(4, 3, 1),
      { ...watched(1, 2, 5), show_id: 42, show: 'Paper Lighthouse' }],
      ratings: [{ show_id: id, show: title, rating: 0 }, { show_id: 40, show: 'Lost Film', rating: 4 }],
      lists: ['Favorites', 'Weekend mysteries', 'watchlist', 'WATCHLIST'].map(list => ({ show_id: id, show: title, list })) } });
    await service.view({ kind: 'season', id, season: 1 });
    await run('Show renders aired progress, literal provider text, ordered cast and recommendation links at 320px', async () => {
      const ready = mount();
      check(root.querySelector('.skeleton'), 'Missing initial show skeleton.');
      await ready;
      check(root.querySelector('h1').textContent === title && root.querySelector('.show-overview').textContent.includes(show.overview), 'Title or overview missing.');
      check(values('.show-stat strong').join('|') === '1 / 2|0×|9', 'Aired, completion or all-time plays wrong.');
      check(values('.show-season-copy strong').join('|') === 'Season 1|Season 2|Season 4|Specials', 'Season ordering lost a recorded season or misplaced specials.');
      check(root.querySelector('.show-rating').textContent === '0/10' && values('.show-list-tag').join('|') === 'Favorites' &&
        !root.querySelector('.show-watchlist'), 'Show should display the personal rating and only the Favorites badge.');
      click('.show-list');
      await until(() => root.querySelector('dialog input[value=Favorites]:checked'), 'Show list sheet did not load');
      check(root.querySelector('dialog input[value="Weekend mysteries"]:checked'), 'The custom list is missing from the membership editor');
      check(![...root.querySelectorAll('dialog input[type=checkbox]')].some(input => input.value.toLowerCase() === 'watchlist'),
        'The Show page offers the same Watchlist action twice');
      root.querySelector('dialog').dispatchEvent(new Event('cancel', {cancelable:true}));
      check(values('.show-cast-member > span:not(.show-art)').join('|') === 'Zoë Vale|<b>Kit</b>' && !root.querySelector('.show-cast-member b'), 'Cast was sorted, truncated or interpreted as markup.');
      check(values('.show-recommendation').join('|') === 'North Reel|Aster Semaphore', 'Recommendations lost provider order.');
      click('.show-recommendation');
      check(navigation.at(-1)?.id === 19, 'Recommendation did not navigate to the selected show.');
      click('[data-season="2"]');
      check(navigation.at(-1)?.page === 'season' && navigation.at(-1)?.season === 2, 'Phone season row did not open its own screen.');
      check(doc.documentElement.scrollWidth <= 320, 'Show overflowed its 320px viewport.');
    });
    await run('A delayed provider refresh keeps cached show artwork and season episodes usable', async () => {
      const {generation} = await store.tmdbState();
      await store.writeTmdb(generation,{entries:{'tv/17/aggregate_credits':{
        fetchedAt:Date.now(),value:[{id:88,name:'Zoë Vale',profilePath:null,episodeCount:1}],
      }}});
      for (const [path,start,selector] of [
        ['tv/17',() => mount(),'.show-season-row'],
        ['tv/17/season/1',() => mountSeason(1),'.season-episode'],
      ]) {
        hold = {path,gate:Promise.withResolvers()};
        const ready = start();
        try {
          await until(() => root.querySelector(selector));
          const art = root.querySelector('.show-hero > .show-art-poster');
          if (art) {
            check(root.querySelector('.show-cast-member')?.textContent.includes('Zoë Vale') &&
              !root.querySelector('.show-cast-roles'),'A cached credit with missing roles blocked the Show or invented a role');
            await screen.refresh();
            check(root.querySelector('.show-hero > .show-art-poster') === art,'Cached artwork was replaced during refresh');
          }
          check(!root.querySelector('.skeleton'),'Cached detail went back to its loading screen');
        } finally {
          hold.gate.resolve(); hold = undefined;
          await ready;
        }
      }
      const start = requests.length;
      hold = {path:'tv/17',gate:Promise.withResolvers()};
      const ready = mount();
      try {
        await until(() => requests.length > start);
        screen.dispose();
      } finally { hold.gate.resolve(); hold = undefined; await ready; }
      const afterLeaving = requests.slice(start);
      // A shared header refresh can still check cached episode identities.
      check(afterLeaving[0] === 'tv/17' && !afterLeaving.some(path => /aggregate_credits|recommendations/.test(path)) &&
        !root.querySelector('.show-hero'),'Leaving an opening show loaded secondary panels or restored the disposed page');
    });
    await run('A cached Show refresh checks its source once and discards an older overlapping reply',async()=>{
      const online=environment.online,read=service.keyStatus.bind(service);
      environment.online=()=>false;
      const old=Promise.withResolvers(),blocked=Promise.withResolvers();
      let calls=0,hold=false;
      try{
        await mount();
        service.keyStatus=async()=>{
          const value=await read();
          calls++;
          if(hold){hold=false;blocked.resolve();await old.promise;return {...value,generation:value.generation+1n};}
          return value;
        };
        await screen.refresh();
        check(calls===1 && root.querySelector('.show-season-row'),'An unchanged Show refresh repeated its permission read');
        hold=true;const pending=screen.refresh();await blocked.promise;
        await screen.refresh();old.resolve();await pending;
        check(calls===3 && root.querySelector('h1')?.textContent===title,'An obsolete source check reopened the current title');
      }finally{old.resolve();service.keyStatus=read;environment.online=online;}
    });
    await run('Cached Show and Season paint their first saved record while the next read is still pending', async () => {
      const read = store.showScreenState, view = service.view, openShow = service.openShow, online = environment.online;
      environment.online = () => false;
      try {
        for (const [start,selector,lastResource] of [
          [() => mount(),'.show-season-row','recommendations'],
          [() => mountSeason(1),'.episode-row','season'],
        ]) {
          const first = Promise.withResolvers(), later = Promise.withResolvers(), lookup = Promise.withResolvers();
          let reads = 0;
          store.showScreenState = async function(...args) {
            const gate = ++reads === 1 ? first : later;
            const record = await read.apply(this,args);
            await gate.promise;
            return record;
          };
          service.view = async function(resource) {
            const result = await view.call(this,resource);
            if (resource.kind === lastResource) lookup.resolve();
            return result;
          };
          service.openShow = async function(...args) {
            const result=await openShow.apply(this,args);
            if(lastResource==='recommendations')lookup.resolve();
            return result;
          };
          const ready = start();
          try {
            await lookup.promise;
            await new Promise(resolve => setTimeout(resolve,0));
            first.resolve();
            await until(() => root.querySelector(selector),'An unchanged offline lookup discarded the first usable record');
            check(!!root.querySelector('h1'),'A saved record painted without its heading');
          } finally {
            first.resolve(); later.resolve(); await ready;
          }
          check(reads>=2,'Opening must still reread the current record after the first paint');
          const started=Promise.withResolvers(), release=Promise.withResolvers();
          store.showScreenState=async function(...args){
            started.resolve(args[3]);
            await release.promise;
            return read.apply(this,args);
          };
          const pendingDraw=screen.refresh();
          try {
            const signal=await started.promise;
            screen.dispose();
            check(signal?.aborted,'Leaving the detail screen kept its watch and episode scan active');
          } finally { release.resolve(); await pendingDraw; }
          check(!root.querySelector(selector),'The departed screen painted again after cancellation');
        }
      } finally { store.showScreenState = read; service.view = view; service.openShow=openShow; environment.online = online; }
    });
    await run('Shows render while Recently marked checks are pending and canceled or stale menus cannot take focus', async () => {
      const original = store.isOnRecentRail.bind(store), mark = 'recently_marked.'+id+'.1.0.0';
      const specialId = 71, specialMark = 'recently_marked.'+specialId+'.0.0.0';
      let gate = Promise.withResolvers();
      await store.commit((await store.snapshot()).revision,{put:{settings:[{setting:mark,value:'900/900'}]}});
      const signals = [];
      store.isOnRecentRail = async (...args) => { signals.push(args[2]); await gate.promise; return original(...args); };
      const action = label => [...root.querySelectorAll('dialog .watch-sheet-action')].find(button => button.textContent === label);
      try {
        const opening = mount();
        await until(() => root.querySelector('.show-more') && root.querySelector('.show-season-row'), 'The page waited for a menu history check');
        await opening;
        await new Promise(resolve => doc.defaultView.requestAnimationFrame(() => doc.defaultView.requestAnimationFrame(resolve)));
        check(!signals.length,'A Show visit started an unused rank scan before its menu opened');
        click('.show-more');
        check(root.querySelector('dialog[aria-busy=true]') && action('Remove watches') && !action('Remove from Recently marked'),
          'An early menu blocked standard actions or offered an unverified dismissal');
        click('.watch-sheet-cancel');
        check(signals.at(-1)?.aborted && !root.querySelector('dialog') && doc.activeElement === root.querySelector('.show-more'),
          'Cancel left the rank check running or lost the Show action trigger');
        click('.show-more');
        await mountSeason(1);
        check(signals.at(-1)?.aborted,'The previous Show kept checking ranks after navigation');
        gate.resolve();
        await until(() => root.querySelector('.episode-row'));
        check(!root.querySelector('dialog') && !root.querySelector('.show-more'), 'A late Show menu returned on the Season page');
        gate = Promise.withResolvers();
        await mount();
        click('.show-more');
        const removal = action('Remove watches');
        removal.focus();
        gate.resolve();
        await until(() => action('Remove from Recently marked'), 'A verified rank was missing from the menu');
        check([...root.querySelectorAll('dialog .watch-sheet-action')].at(-1) === removal && doc.activeElement === removal,
          'Adding the verified dismissal moved focus or changed the final action');
        await store.commit((await store.snapshot()).revision,{remove:{settings:[mark]}});
        await screen.refresh();
        check(!root.querySelector('dialog') && doc.activeElement === root.querySelector('.show-more'),
          'A resolved menu kept its old dismissal or lost focus after the record changed');
        click('.show-more');
        await until(() => root.querySelector('dialog:not([aria-busy])'));
        check(!action('Remove from Recently marked'),'Reopening offered an outdated dismissal');
        click('.watch-sheet-cancel');
        await store.commit((await store.snapshot()).revision,{put:{settings:[{setting:mark,value:'910/910'}]}});
        check(signals.length >= 2, 'A new Show reused the old screen’s pending check');
        gate = Promise.withResolvers();
        await mount();
        click('.show-more');
        action('Remove watches').focus();
        await store.commit((await store.snapshot()).revision,{remove:{settings:[mark]}});
        await screen.refresh();
        gate.resolve();
        await until(() => root.querySelector('dialog:not([aria-busy])'), 'The changed record left the optional action pending');
        check(!action('Remove from Recently marked') && doc.activeElement === action('Remove watches'),
          'An invalidated result inserted a stale dismissal or moved focus');
        click('.watch-sheet-cancel');
        await store.commit((await store.snapshot()).revision,{put:{watched:[{...watched(0,1,1),show_id:specialId,show:'A single special'}]}});
        await mount(specialId);
        check(!root.querySelector('.show-more'), 'A special without a recent mark had an empty menu');
        await store.commit((await store.snapshot()).revision,{put:{settings:[{setting:specialMark,value:'901/901'}]}});
        await screen.refresh();
        click('.show-more');
        check(values('dialog button').join('|') === 'Remove from Recently marked|Cancel',
          'A watched special lost its only legitimate menu action');
        action('Remove from Recently marked').click();
        await pending;
        check(!root.querySelector('.show-more') && (await store.tmdbRows(specialId,false)).tables.watched[0]?.times_watched === 1,
          'Dismissing a special left an empty menu or removed its watch');
      } finally {
        gate.resolve(); store.isOnRecentRail = original;
        await store.commit((await store.snapshot()).revision,{remove:{settings:[mark,specialMark],watched:[[specialId,0,1]]}});
        await mount();
      }
    });
    await run('Show wraps a large cast in rows and opens the complete role list for an individual actor', async () => {
      const voices = ['Tower keeper', 'Train driver', ...Array.from({length:58}, (_, i) => 'Harbour voice ' + (i + 1))];
      const longRole = 'Keeper' + 'ofthesea'.repeat(35);
      cast = Array.from({length:29}, (_,i) => ({
        id:9000 + i, name:'Signal Player ' + (i + 1), total_episode_count:2,
        roles:(i === 0 ? voices : i === 1 ? [longRole] : i === 2 ? [] : ['Conductor']).map(character => ({character})),
      }));
      try {
        for (const width of [320,1440]) {
          frame.width = String(width);
          await until(() => frame.contentWindow.innerWidth === width);
          await mount();
          const grid = root.querySelector('.show-cast-grid');
          check(grid?.children.length === 12, width + 'px: should start with twelve cast members');
          const rects = [...grid.children].map(item => item.getBoundingClientRect());
          check(rects[1].left > rects[0].left && rects.some(rect => rect.top > rects[0].bottom),
            width + 'px: cast did not wrap into rows');
          check(grid.scrollWidth <= grid.clientWidth + 1 && doc.documentElement.scrollWidth <= width + 1,
            width + 'px: cast needs horizontal scrolling');
          const roleButton = grid.children[0].querySelector('.show-cast-roles');
          check(roleButton.textContent.includes('…') && !roleButton.textContent.includes(voices[2]) &&
            grid.children[1].querySelector('.show-cast-roles').textContent.includes('…') &&
            !grid.children[2].querySelector('.show-cast-roles'), 'Role previews leaked, missed a long role, or invented a role');
          const label = roleButton.firstElementChild;
          check(label.offsetHeight <= parseFloat(frame.contentWindow.getComputedStyle(label).lineHeight) * 2 + 1,
            'Role preview exceeded two lines');
          roleButton.focus();
          roleButton.click();
          const dialog = root.querySelector('.show-role-dialog');
          check(dialog?.open && dialog.contains(doc.activeElement) && dialog.textContent.includes(title) &&
            dialog.querySelector('h2').textContent.includes(cast[0].name), 'Full roles lost show, actor, or dialog focus');
          check(values('.show-role-list li').join('|') === voices.join('|'), 'Full credits lost roles or changed the provider order');
          dialog.dispatchEvent(new Event('cancel', {cancelable:true}));
          check(doc.activeElement === roleButton && !root.querySelector('.show-role-dialog'), 'Closing did not return to the actor');
          grid.children[1].querySelector('.show-cast-roles').click();
          const longDialog = root.querySelector('.show-role-dialog');
          check(longDialog.querySelector('li').textContent === longRole &&
            longDialog.scrollWidth <= longDialog.clientWidth + 1, 'A single long role overflows or is unavailable in full');
          longDialog.querySelector('button').click();
          const more = root.querySelector('.show-more-cast');
          more.focus(); more.click();
          check(grid.children.length === 24 && doc.activeElement === grid.children[12].querySelector('a'), 'Loading more cast lost the next actor');
          await screen.refresh();
          check(root.querySelectorAll('.show-cast-member').length === 24, 'A background refresh collapsed the cast');
          check(root.querySelector('.show-cast-grid') === grid && grid.children[0].querySelector('.show-cast-roles') === roleButton,
            'An unchanged background update replaced the expanded cast or actor controls');
          click('.show-more-cast');
          const links = [...root.querySelectorAll('.show-cast-member')];
          check(links.map(a => a.textContent).join('|') === cast.map(person => person.name).join('|') &&
            !root.querySelector('.show-more-cast')?.getClientRects().length, 'Full cast lost its order or kept an empty next batch');
          links.at(-1).click();
          check(navigation.at(-1)?.page === 'cast' && navigation.at(-1)?.id === cast.at(-1).id &&
            navigation.at(-1)?.showId === id, 'Actor link lost the person or the source show');
          if (width === 320) {
            show.name = 'Sable Harbour Revised';
            await service.refresh({kind:'show', id});
            await screen.refresh();
            click('.show-cast-roles');
            check(root.querySelector('.show-role-context')?.textContent === show.name,
              'Role dialog kept the old title after a metadata correction');
            root.querySelector('.show-role-dialog button').click();
            show.name = title;
          }
        }
      } finally {
        show.name = title;
        cast = regularCast;
        frame.width = '320';
        await until(() => frame.contentWindow.innerWidth === 320);
        await mount();
      }
    });
    await run('Show marks missing episodes first, rewatches from its main button and keeps removal in More', async () => {
      click('.show-more');
      const dialog = root.querySelector('dialog');
      check(dialog.open && dialog.contains(doc.activeElement) && dialog.querySelector('h2').textContent === 'Show actions', 'Show menu lacked its name or focus.');
      check(values('dialog button').join('|') === 'Season order|Remove watches|Cancel', 'Partial show menu should offer season order and watch removal.');
      dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
      check(doc.activeElement.matches('.show-more'), 'Dismissed menu lost focus.');
      check(root.querySelector('.show-actions .primary').textContent === 'Finish', 'Missing Finish button on a partial show.');
      click('.show-actions .primary');
      click('.show-actions .primary');
      click('.show-more');
      check(!root.querySelector('dialog'), 'A second submission opened the show menu before saving finished.');
      await pending;
      check(root.querySelector('.show-actions .primary').textContent === 'Watched again' &&
        values('.show-stat strong').join('|') === '2 / 2|1×|10', 'Filling the missing aired episode repeated an existing play or failed to switch the button.');
      click('.show-actions .primary');
      await pending;
      const rows = (await store.tmdbRows(id)).tables.watched;
      const count = (s, e) => rows.find(r => r.season === s && r.episode === e)?.times_watched;
      check(count(1, 1) === 3 && count(1, 2) === 2 && count(1, 3) === 4 && count(0, 1) === 2 && count(0, 2) === undefined, 'Whole-show rewatch changed the wrong episodes.');
      check(values('.show-stat strong').join('|') === '2 / 2|2×|12' &&
        root.querySelector('[data-focus="watch-season-1"] .rewatching')?.textContent === '2×' &&
        root.querySelector('[data-season="1"] small').textContent.includes('3rd time 1 of 2'),
        'Season count should show completed watches and the caption should retain partial rewatch progress.');
      click('.show-more');
      check(values('dialog button').join('|') === 'Season order|Remove watches|Cancel', 'Completed show offered Watchlist changes or a duplicate rewatch.');
      [...root.querySelectorAll('dialog button')].find(b => b.textContent === 'Remove watches').click();
      await pending;
      check(removals.at(-1)?.length === 1 && removals.at(-1)[0] === id, 'Removal did not request a whole-show confirmation.');
    });
    await run('Desktop season rows link to their own episodes without opening a season or changing watches on Show', async () => {
      screen.dispose();
      frame.width = '1080';
      await until(() => frame.contentWindow.matchMedia('(min-width:900px)').matches);
      await mount();
      check(!root.querySelector('.season-episodes'), 'Show opened an unselected season');
      const before = JSON.stringify((await store.tmdbRows(id)).tables.watched);
      for (const number of [1,2]) {
        const link = root.querySelector('a[data-season="' + number + '"]');
        check(link.hash === '#/show/17/season/' + number && !link.querySelector('button'), 'Season link is not independently navigable');
        link.querySelector('.show-season-copy').click();
        check(navigation.at(-1)?.season === number && navigation.at(-1)?.id === id, 'Season link opened a different season');
      }
      check(before === JSON.stringify((await store.tmdbRows(id)).tables.watched), 'Opening a season changed watches');
      await mountSeason(99);
      check(root.querySelector('.season-status')?.textContent.includes('Not on TMDB') &&
        root.querySelector('.season-screen h1').textContent === 'Season 99' && !root.querySelector('[data-season-focus="bulk"]'),
        'A missing season link offered another season’s marks');
    });
    await run('Show keeps personal figures and removals for missing titles and offers key setup and retry when uncached', async () => {
      frame.width = '320';
      await until(() => !frame.contentWindow.matchMedia('(min-width:900px)').matches);
      unavailable = true;
      await mount();
      check(root.querySelector('.show-status').textContent.includes('Cannot reach TMDB.'), 'Missing transient provider status');
      unavailable = false;
      await service.refresh({kind:'show', id});
      await screen.refresh();
      check(!root.querySelector('.show-status').textContent.includes('Cannot reach TMDB.'), 'Recovered metadata kept an expired provider warning');
      await mount(40);
      check(root.querySelector('h1').textContent === 'Lost Film' && root.textContent.includes('Not on TMDB') &&
        values('.show-stat strong').join('|') === '0|–|0', 'Confirmed missing show lost its title, dash or counts.');
      environment.online = () => false;
      await mount(41);
      check(root.textContent.includes('Cannot reach TMDB.') && values('.show-status button').includes('Try again'), 'Offline uncached title lacked retry.');
      await service.removeKey((await service.keyStatus()).generation);
      await mount(id);
      check(!root.querySelector('.show-actions .primary') && root.querySelector('.show-more') && root.textContent.includes('A TMDB key is needed.'), 'Cached show lost removal or still offered marking without a key.');
      click('.show-more');
      check(values('dialog button').join('|') === 'Season order|Remove watches|Cancel', 'Cached keyless watched show offered a Watchlist change or a positive mark.');
      root.querySelector('dialog').dispatchEvent(new Event('cancel', { cancelable: true }));
      await mount(42);
      check(root.querySelector('h1').textContent === 'Paper Lighthouse' &&
        values('.show-stat strong').join('|') === '1|–|5', 'Unfetched show did not display its saved episode and play totals.');
      const follow = () => root.querySelector('.show-watchlist');
      check(!follow(), 'An offline show with watches could be added to the Watchlist');
      await mount(40);
      check(follow().textContent === 'Add to Watchlist', 'An unwatched saved show could not be planned offline');
      follow().focus(); follow().click();
      await pending;
      check(!follow() && doc.activeElement === root.querySelector('.show-more') &&
        (await store.tmdbRows(40)).tables.lists.some(row => row.show === 'Lost Film' && row.list.toLowerCase() === 'watchlist'),
        'The offline saved title could not be added to Watchlist or lost keyboard focus');
      const reader = await openDeviceStore({name}), other = doc.createElement('section');
      const readerService = new TmdbService(reader,client,environment);
      root.after(other);
      const readOnly = mountShowScreen(other,{...ctx,service:readerService},40);
      try {
        await readOnly.ready;
        check(!other.querySelector('.show-watchlist, .show-more'),
          'A read-only tab offered to change the saved Watchlist');
      } finally { readOnly.dispose(); other.remove(); readerService.close(); reader.close(); }
      click('.show-more');
      [...root.querySelectorAll('dialog button')].find(b => b.textContent === 'Remove from Watchlist').click();
      await pending;
      check(follow().textContent === 'Add to Watchlist' && !(await store.tmdbRows(40)).tables.lists.some(row => row.list.toLowerCase() === 'watchlist'),
        'Removing an offline show left it on the Watchlist');
      await mount(41);
      click('.show-status button');
      check(navigation.at(-1)?.page === 'settings', 'Uncached show did not lead to key setup.');
    });
    await run('Show displays cached critics beside or below the personal rating and fetches only the opened title', async () => {
      environment.online = () => true;
      const calls = [];
      let status = 'ready', generation = 1n;
      const cache = new Map([[id, { tomatoes: 91, metacritic: 0 }]]);
      ctx.critics = { keyStatus: async () => ({ status, generation }),
        read: async ids => new Map(ids.filter(i => status !== 'missing-key' && cache.has(i)).map(i => [i, cache.get(i)])),
        refresh: async ids => { if (environment.online()) calls.push([...ids]); } };
      await mount();
      const rating = () => root.querySelector('.show-rating').getBoundingClientRect();
      const marks = () => root.querySelector('.critic-marks').getBoundingClientRect();
      check(calls.length === 1 && calls[0].join() === String(id) && values('.critic-marks').join() === '91%0',
        'Opening a show looked up related titles, required TMDB, or hid a zero');
      check(marks().top >= rating().bottom && doc.documentElement.scrollWidth <= frame.clientWidth, 'Phone scores do not fit below the rating');
      environment.online = () => false;
      await screen.refresh();
      check(calls.length === 1 && values('.critic-marks').join() === '91%0', 'Offline refresh lost the cached scores');
      frame.width = '1100';
      await until(() => frame.contentWindow.matchMedia('(min-width:900px)').matches);
      check(marks().left >= rating().right && marks().top < rating().bottom, 'Desktop scores are separated from the rating');
      status = 'missing-key'; generation++;
      await screen.refresh();
      check(!root.querySelector('.critic-marks') && root.querySelector('.show-rating') && calls.length === 1,
        'Removing the key kept outside scores or removed the personal rating');
      const unavailable = async () => { throw new DOMException('Fictional ratings cache failure','UnknownError'); };
      ctx.critics.read = unavailable;
      ctx.imdb = {sourceStatus:async () => ({source:'none'}), readShows:unavailable, readSeason:unavailable};
      ctx.mal = {read:unavailable};
      await mount();
      check(root.querySelector('h1')?.textContent === title && root.querySelector('.show-rating') && !root.querySelector('.outside-scores'),
        'An optional ratings cache hid the show or its personal rating');
      await mountSeason(1);
      check(root.querySelector('.season-episode') && !root.querySelector('.imdb-score'), 'An optional ratings cache hid the season');
      const delayed = Promise.withResolvers();
      try {
        ctx.imdb.readShows = () => delayed.promise.then(() => new Map([[id,8.4]]));
        ctx.imdb.readSeason = () => delayed.promise.then(() => new Map([[1,7.2]]));
        ctx.mal.read = () => delayed.promise.then(() => new Map());
        const opening = mount();
        await until(() => root.querySelector('.show-rating'));
        check(!root.querySelector('.imdb-score'), 'A fresh show reused an unrelated score while waiting');
        delayed.resolve();
        await opening;
        await until(() => root.querySelector('.show-labels .imdb-score')?.textContent === '8.4');
        await mountSeason(1);
        await until(() => root.querySelector('.season-episode .imdb-score')?.textContent === '7.2');
      } finally { delayed.resolve(); }
    });
  } finally {
    screen?.dispose();
    service.close();
    store.close();
    frame.remove();
  }
}
