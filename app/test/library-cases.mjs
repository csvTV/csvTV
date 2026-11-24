import { connectFixtureProviders } from './provider-fixture-cases.mjs';
import { mountApplication } from '../dist/application.js';
import { mountLibraryScreen } from '../dist/library-screen.js';
import { MdbListService } from '../dist/mdblist-service.js';
import { localCalendarDate } from '../dist/progress.js';
import { openDeviceStore } from '../dist/storage.js';
import { TmdbClient, tmdbResourceKey } from '../dist/tmdb-client.js';
import { TmdbService } from '../dist/tmdb-service.js';

const titles = ['', 'École', 'E\u0301cole', 'Zebra', 'Straße', 'Tide <b>Night</b>', 'Straße', 'Listed only', 'Rated only'];
function watch(id, season, episode, times = 1) {
  return { show_id: id, show: titles[id], season, episode, episode_id: null, title: 'Episode ' + episode, times_watched: times };
}
function member(list, id) { return { show_id: id, show: titles[id], list }; }
const tables = {
  watched: [watch(1, 1, 1, 12), watch(1, 1, 3), watch(1, 0, 1), watch(2, 1, 1), watch(2, 1, 2),
    watch(3, 1, 1), watch(3, 1, 2), watch(3, 0, 1), watch(4, 0, 1), watch(5, 1, 1), watch(6, 1, 1)],
  lists: [member('Cycle', 1), member('Cycle', 2), member('cycle', 5), member('Any', 3),
    member('sToPped', 2), member('sToPped', 5), member('Watchlist', 7), member('STOPPED', 7), member('aNiMe', 3)],
  ratings: [[1, 8.5], [2, 8.5], [3, 0], [8, 10]].map(([show_id, rating]) => ({ show_id, show: titles[show_id], rating })),
};
function show(id, aired) {
  return { show_id: id, show: titles[id], status: 'Returning Series', seasons: [
    { season: 0, name: 'Specials', episodeCount: 1, posterPath: null }, { season: 1, name: 'Season 1', episodeCount: 3, posterPath: null }],
    firstAirDate: null, overview: '', posterPath: null, backdropPath: null, networks: [], imdbId: null,
    genres: id === 1 ? [{id:10764,name:'Reality'}] : [],
    originCountries: id === 1 || id === 4 ? ['KR'] : [], keywords: id === 4 || id === 5 ? [{id:90,name:'anime'}] : [],
    lastAired: aired ? { season: 1, episode: aired, airDate: '2020-01-01' } : null,
    nextAirDate: null, nextEpisode: null };
}
function check(ok, message) { if (!ok) throw Error(message); }
async function until(test, message) {
  const deadline = performance.now() + 4500;
  while (!await test()) {
    if (performance.now() > deadline) throw Error(message);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function fixture(test, useShell = false) {
  const name = 'library-' + crypto.randomUUID();
  const store = await openDeviceStore({ name });
  let requests = 0;
  const client = new TmdbClient({ fetch: async () => { requests++; throw Error('Unexpected Library request'); } });
  const service = new TmdbService(store, client, { online: () => false, visible: () => true, now: Date.now });
  const frame = document.createElement('iframe');
  frame.width = '390'; frame.height = '700';
  const loaded = new Promise(resolve => { frame.onload = resolve; });
  frame.src = '/screen-fixture'; document.body.append(frame);
  let screen;
  try {
    await store.commit((await connectFixtureProviders(store,name,[{setting:'tmdb_key',value:'fictional-key'}])).revision, { put: { ...tables } });
    const { generation } = await store.tmdbState();
    const now = Date.now();
    const premiere = new Date(now);
    premiere.setHours(24, 0, 0, 0);
    const returning = show(2, 2);
    returning.seasons[1].episodeCount = 2;
    returning.seasons.push({season:2,name:'Season 2',episodeCount:12,posterPath:null});
    returning.nextAirDate = localCalendarDate(premiere);
    returning.nextEpisode = {season:2,episode:1,airDate:returning.nextAirDate};
    const entries = Object.fromEntries([[1, show(1, 2)], [2, returning], [3, null], [4, show(4, 0)], [5, show(5, 3)]]
      .map(([id, value]) => [tmdbResourceKey({ kind: 'show', id }), { fetchedAt: now, value }]));
    entries[tmdbResourceKey({kind:'season', id:2, season:2})] = {fetchedAt:now-1,
      value:{show_id:2,season:2,name:'Season 2',posterPath:null,episodes:[]}};
    check(await store.writeTmdb(generation, { entries }, now), 'Could not seed the title cache');
    await service.removeKey(generation);
    await loaded;
    const doc = frame.contentDocument, win = frame.contentWindow;
    const root = doc.querySelector('#app');
    const q = selector => root.querySelector(selector);
    const all = selector => [...root.querySelectorAll(selector)];
    const ctx = { service, saveView() {}, go() {}, run: action => action() };
    if (useShell) {
      win.history.replaceState(null, '', '#/library');
      screen = mountApplication(root, service);
    } else screen = mountLibraryScreen(root, ctx);
    await screen.ready;
    await until(() => q('[data-library-show="1"] progress'), 'Library did not read the seeded title cache');
    const ids = () => all('.library-grid a').map(a => a.dataset.showId).join();
    const groups = () => all('[data-filter=progress] option').map(option => option.textContent).join('|');
    function choose(trigger, value) {
      const select = q(trigger);
      select.focus();
      check([...select.options].some(option => option.value === value), 'Missing choice ' + value);
      select.value = value;
      select.dispatchEvent(new Event('change',{bubbles:true}));
    }
    function search(value) {
      const input = q('.library-screen input[type=search]');
      input.focus(); input.value = value; input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    await test({ name, doc, win, root, q, all, frame, store, screen, ctx, ids, groups, choose, search, premiere });
    check(requests === 0, 'The offline Library called the provider');
  } finally {
    screen?.dispose(); frame.remove(); service.close(); store.close();
    const deletion = indexedDB.deleteDatabase(name);
    await new Promise((resolve, reject) => { deletion.onsuccess = resolve; deletion.onerror = () => reject(deletion.error); });
  }
}

const list = '[data-filter=list]', rating = '[data-filter=rating]', sort = '.sort-trigger', progress = '[data-filter=progress]';
export async function libraryCases(run) {
  await run('Library can sort cached critic scores in a reader and after sign-out without looking up a credential',()=>
    fixture(async({name,store,screen,ctx,root,q,ids,choose})=>{
      screen.dispose();
      const critics = new MdbListService(store);
      await critics.saveKey('fictional-library-critics');
      const {generation} = await critics.keyStatus();
      const entries = new Map([[3,89],[4,73]].map(([id,metacritic])=>[id,{
        fetchedAt:Date.now(), scores:{metacritic,tomatoes:null,myanimelist:null},
      }]));
      check(await store.writeMdbList(generation,{entries}),'Could not seed critic scores');
      const peer = await openDeviceStore({name}), reader = new MdbListService(peer);
      const readOnly = new TmdbService(peer,undefined,ctx.service.environment);
      let view;
      const failures=[];
      try {
        for(const [mode,service,scores] of [['writer',ctx.service,critics],['reader',readOnly,reader],['signed-out',ctx.service,critics]]){
          if(mode==='signed-out')store.clearProviderKeys();
          const privateReads=[];
          const original=IDBObjectStore.prototype.get;
          IDBObjectStore.prototype.get=function(key){
            if(this.name==='local' && key==='dropboxSession' || this.name==='settings' && key==='mdblist_key')privateReads.push(key);
            return original.apply(this,arguments);
          };
          try{
            view=mountLibraryScreen(root,{...ctx,service,critics:scores});
            await view.ready;
            await view.refresh();
            if(privateReads.length)failures.push('Listing score sorts read a credential for '+mode+': '+privateReads.join(','));
            if(q(sort+' option[value=metacritic]')){
              choose(sort,'metacritic');
              if(ids().split(',').slice(0,2).join()!=='3,4')failures.push('Wrong cached sort for '+mode);
            }else failures.push('Cached Metacritic sort disappeared for '+mode);
          }finally{view?.dispose();IDBObjectStore.prototype.get=original;}
        }
        await connectFixtureProviders(store,name);
        await critics.removeKey((await critics.keyStatus()).generation);
        view=mountLibraryScreen(root,{...ctx,service:readOnly,critics:reader});
        await view.ready;
        await view.refresh();
        check(!q(sort+' option[value=metacritic]'),'Removing the key retained its sort in another tab');
        check(!failures.length,failures.join('. '));
      }finally{view?.dispose();reader.close();critics.close();readOnly.close();await peer.closeForUpdate();}
    }));

  await run('Returning Library controls stay usable and stale cards disappear after newer rows or a failed read', () =>
    fixture(async ({q,root,ctx,store,screen,search,choose,premiere}) => {
      const {createLibraryHistory} = await import('../dist/library-history.js');
      const lifetime = new AbortController(), history = createLibraryHistory(store,lifetime.signal);
      const read = store.overviewRows.bind(store), extra = store.tmdbEntries.bind(store);
      screen.dispose();
      const mount = () => mountLibraryScreen(root,ctx,undefined,false,undefined,'fictional-visit',history);
      let active = mount();
      async function prime() {
        await active.ready;
        await until(()=>history.available && q('[data-library-show="1"] .library-status-caption')?.textContent==='1 of 2','The first complete Library was not available');
        active.dispose();
      }
      function holdRead() {
        const started=Promise.withResolvers(), release=Promise.withResolvers();
        store.overviewRows=(...args)=>{started.resolve();return release.promise.then(()=>read(...args));};
        active=mount();
        return {started:started.promise,release,ready:active.ready};
      }
      try {
        await prime();
        let held=holdRead();await held.started;
        await until(()=>q('[data-library-show="1"] .library-status-caption')?.textContent==='1 of 2','A verified progress count waited for the episode table');
        q('[data-category="k-drama"]').click();search('École');
        check([...root.querySelectorAll('.library-grid a')].map(a=>a.dataset.showId).join()==='1','The retained Korean classification or search was wrong');
        await store.commit((await store.snapshot()).revision,{put:{ratings:[{show_id:1,show:titles[1],rating:9.5}]}});
        held.release.resolve();await held.ready;
        await until(()=>q('[data-library-show="1"] .library-rating')?.textContent==='9.5/10','A newer offline score did not supersede the preview');
        check(q('.library-screen input').value==='École' && q('[data-category="k-drama"]').getAttribute('aria-pressed')==='true','Hydration reset the search or category');
        active.dispose();store.overviewRows=read;active=mount();await prime();
        held=holdRead();await held.started;const failure=held.ready.then(()=>false,()=>true);
        await until(()=>q('[data-library-show="2"]'),'The second valid preview was not displayed');held.release.reject(Error('Fictional record read failed'));
        check(await failure,'A rejected record read reported success');
        check(!q('.library-grid li') && !q('.library-count').textContent && q('.tv-empty').textContent.includes('Could not read'),'A failed read left old titles or counts visible');
        active.dispose();store.overviewRows=read;active=mount();await prime();
        held=holdRead();await held.started;
        await until(()=>q('[data-library-show="1"] .library-status-caption')?.textContent==='1 of 2','The third valid preview was not displayed');
        store.tmdbEntries=async()=>{throw Error('Fictional metadata read failed');};
        held.release.resolve();await held.ready;
        await until(()=>q('[data-library-show="1"] .library-status-caption')?.textContent!=='1 of 2','Failed metadata kept the cached completion action');
        check(!history.available,'A failed metadata read was retained');
        active.dispose(); store.tmdbEntries=extra; store.overviewRows=read;active=mount(); await prime();
        const pref = store.devicePreference.bind(store), blockedSort=Promise.withResolvers();
        store.devicePreference=async key=>{const value=await pref(key);if(key==='librarySort')await blockedSort.promise;return value;};
        try {
          active=mount();
          await until(()=>q('[data-library-show="1"]'),'An optional sort read blocked the fresh personal record');
        } finally {blockedSort.resolve();store.devicePreference=pref;}
        await active.ready;active.dispose();active=mount();await prime();
        const revision = store.recordRevision.bind(store);
        const delayedProof = Promise.withResolvers(), delayedSeasons = Promise.withResolvers(), seasonRead = Promise.withResolvers();
        store.recordRevision = async () => {const current=await revision(); await delayedProof.promise; return current;};
        store.tmdbEntries = async (keys,...args) => {
          if (keys.some(key=>key.includes('/season/'))) {seasonRead.resolve(); await delayedSeasons.promise;}
          return extra(keys,...args);
        };
        try {
          active=mount();await seasonRead.promise;
          check(q('[data-library-show="1"]') && !q('select[aria-label=Sort]').disabled,'Fresh rows waited for the optional proof');
          delayedProof.resolve();
          await until(()=>q('[data-library-show="1"] .library-status-caption')?.textContent==='1 of 2',
            'A verified progress count waited for the complete episode read after the personal rows arrived');
          q('[data-library-show="1"] .library-status-trigger').click();
          check(q('dialog[open], [role=menu]'),'The verified progress did not open its status actions');
          store.overviewRows=async()=>{throw Error('Fictional unreadable replacement record');};
          const unreadable=await active.refresh().then(()=>false,()=>true);
          check(unreadable && !q('.library-grid li') && !q('.library-count').textContent &&
            !q('dialog[open], [role=menu]') && q('[data-filter=list]').options.length===1 &&
            q('select[aria-label=Sort]').disabled && q('.tv-empty').textContent.includes('Could not read'),
            'A failed replacement read left earlier Library titles, filters or actions on screen');
          delayedSeasons.resolve();await active.ready;
          await new Promise(resolve=>setTimeout(resolve,0));
          check(!q('.library-grid li') && !history.available,'An abandoned episode read restored the failed view');
        } finally {delayedProof.resolve(); delayedSeasons.resolve(); store.recordRevision=revision; store.tmdbEntries=extra; store.overviewRows=read; active.dispose();}
        active=mount();await prime();
        const afterFailure = Promise.withResolvers();
        store.recordRevision = async () => {const current=await revision(); await afterFailure.promise; return current;};
        store.tmdbEntries = async () => {throw Error('Fictional metadata read failed before revision verification');};
        try {
          active=mount(); await active.ready;
          await until(()=>!history.available,'Unreadable episode metadata kept an earlier complete Library');
          afterFailure.resolve();
          await new Promise(resolve=>setTimeout(resolve,0));
          check(q('[data-library-show="1"]') && q('[data-library-show="1"] .library-status-caption')?.textContent!=='1 of 2',
            'An old verified count returned after the new metadata read failed');
        } finally {afterFailure.resolve(); store.recordRevision=revision; store.tmdbEntries=extra; active.dispose();}
        active=mount();await prime();
        const lateRevision = Promise.withResolvers();
        const proofSeen = Promise.withResolvers();
        store.recordRevision = async () => {const value=await revision(); proofSeen.resolve(); return value+1n;};
        held=holdRead(); await held.started; await proofSeen.promise;
        await new Promise(resolve=>setTimeout(resolve,0));
        check(!q('.library-grid li'),'A later record revision still displayed the old verified cards');
        held.release.resolve(); await held.ready;
        await until(()=>q('[data-library-show="1"] .library-status-caption')?.textContent === '1 of 2',
          'The mismatched optional proof hid the real Library');
        active.dispose(); store.overviewRows=read;
        history.clear();
        store.recordRevision = () => lateRevision.promise;
        try {
          active = mount();
          await active.ready;
          await until(()=>q('[data-library-show="1"] .library-status-caption')?.textContent === '1 of 2',
            'The optional revision check blocked real titles or progress');
          check(!q('select[aria-label=Sort]').disabled,'The optional revision check disabled live sorting');
          lateRevision.resolve((await revision())+1n);
          await new Promise(resolve=>setTimeout(resolve,0));
          check(!history.available,'The screen retained cards with mismatched record revisions');
        } finally {lateRevision.resolve(0n); active.dispose(); store.recordRevision = revision;}
        active=mount();await prime();
        ctx.service.environment.now=()=>premiere.getTime();
        held=holdRead();await held.started;await until(()=>!history.available,'A previous-day preview stayed eligible');
        check(!q('.library-grid li'),'Last night’s completion was painted before checking today’s episode');
        held.release.resolve();await held.ready;
        await until(()=>q('[data-library-show="1"] progress'),'The new day’s cached season did not hydrate');
        choose('[data-filter=progress]','complete');
        check(!q('[data-library-show="2"]'),'The date change left last night’s completed show in the Complete group');
      } finally {active.dispose();lifetime.abort();store.overviewRows=read;store.tmdbEntries=extra;}
    }));

  await run('Erasing a Library while an old sort proof is in flight cannot reveal the previous record', () =>
    fixture(async ({q,root,ctx,store,screen}) => {
      const {createLibraryHistory} = await import('../dist/library-history.js');
      const lifetime=new AbortController(), history=createLibraryHistory(store,lifetime.signal);
      const pref=store.devicePreference.bind(store),read=store.overviewRows.bind(store);
      const stampTaken=Promise.withResolvers(),finishSort=Promise.withResolvers(),started=Promise.withResolvers(),getRows=Promise.withResolvers();
      screen.dispose();
      const mount=()=>mountLibraryScreen(root,ctx,undefined,false,undefined,'fictional-visit',history);
      let active=mount();
      try {
        await active.ready;await until(()=>history.available,'The old record did not prime the preview');active.dispose();
        store.devicePreference=async key=>{const result=await pref(key);if(key==='librarySort'){stampTaken.resolve();await finishSort.promise;}return result;};
        store.overviewRows=(...args)=>{started.resolve();return getRows.promise.then(()=>read(...args));};
        active=mount();await stampTaken.promise;
        await store.eraseDevice((await store.snapshot()).revision);
        await store.commit((await store.snapshot()).revision,{put:{watched:[{show_id:91,show:'New fictional record',season:1,episode:1,episode_id:9101,title:'Opening',times_watched:1}]},local:{syncAccountId:'next-fixture'}});
        finishSort.resolve();await started.promise;
        check(!q('.library-grid li') && !history.available,'The previous account appeared while loading the new record');
        getRows.resolve();await active.ready;
        await until(()=>q('.library-grid a')?.dataset.showId==='91','The new record did not appear');
        check(root.querySelectorAll('.library-grid li').length===1,'Two different records were mixed into the Library');
      } finally {finishSort.resolve();getRows.resolve();active.dispose();lifetime.abort();store.overviewRows=read;store.devicePreference=pref;}
    }));


  await run('Library categories intersect with watch progress, include Korean variety and retain offline AniList classification', () =>
    fixture(async ({q,all,ids,choose,groups,store,ctx,root,screen}) => {
      const category = value => q('[data-category="'+value+'"]');
      check(all('[data-category]').map(b=>b.textContent).join('|') === 'All 6|TV 1|Anime 3|Korean 2',
        'Incorrect category totals for a Korean reality show, Korean anime, an older AniList member or unavailable metadata');
      check(!all(list+' option').some(o => ['=anime','=watchlist'].includes(o.value.toLowerCase())),
        'Library offered a classification or unstarted Watchlist as a list filter');
      const drop = q('[data-filter=dropped]');
      check(drop.textContent === 'Dropped 3' && !all(list+' option').some(o => ['=dropped','=stopped'].includes(o.value.toLowerCase())),
        'The previous Stopped spellings were miscounted or still exposed as custom lists');
      drop.click();
      check(ids() === '2,7,5' && drop.getAttribute('aria-pressed') === 'true','Dropped omitted an unwatched or completed dropped series');
      check(all('.library-episode-count').map(label => label.textContent).join('|') === '2 of 2|0 episodes|1 of 3' &&
        !q('.library-grid progress'), 'Dropped should show watched counts for complete, uncached and partial series without progress lines');
      category('anime').click();
      check(ids() === '5' && drop.textContent === 'Dropped 1','The category and Dropped toggle did not combine');
      drop.click();
      category('k-drama').click();
      check(ids()==='1,4' && groups()==='All (2)|Complete (0)|More to watch (1)','K-drama scope or progress totals');
      choose(progress,'more');
      check(ids()==='1' && category('k-drama').getAttribute('aria-pressed')==='true','Korean variety with more to watch disappeared');
      category('anime').click();
      check(!ids() && q('.tv-empty').textContent==='No matching shows.','A stale progress filter leaked Korean titles');
      choose(progress,'all');
      check(ids()==='4,5,3','Anime missed an existing AniList classification, TMDB keyword or a Korean anime');
      category('tv').click();
      check(ids()==='2','TV misclassified a show with missing title data');
      category('all').click();
      check(ids().split(',').includes('6'),'An unclassified record disappeared from All');

      screen.dispose();
      const entries = store.tmdbEntries.bind(store);
      const headers = Promise.withResolvers(), seasons = Promise.withResolvers(), reads = [];
      store.tmdbEntries = async (keys,...args) => {
        reads.push(...keys);
        await (keys.some(key => key.includes('/season/')) ? seasons.promise : headers.promise);
        return entries(keys,...args);
      };
      const fresh = mountLibraryScreen(root,ctx,{list:'aNiMe'});
      try {
        await fresh.ready;
        check(ids()==='3' && category('anime').getAttribute('aria-pressed')==='true' && q(list).value==='',
          'An old Library history entry lost its Anime selection before metadata arrived');
        category('k-drama').click();
        check(!ids() && q('.tv-empty').textContent==='Loading…' && !category('k-drama').querySelector('span').textContent,
          'Pending metadata reported an empty K-drama category');
        headers.resolve();
        await until(()=>ids()==='1,4','Korean classification waited for the season details');
        check(category('k-drama').querySelector('span').textContent==='2' && !q('.library-grid progress'),
          'Show headers should identify both Korean series without offering estimated watch actions');
        category('anime').click();
        check(ids()==='4,5,3','Keyword and AniList classifications must coexist while seasons are pending');
        category('k-drama').click();
        choose(progress,'more');
        check(!ids() && q('.tv-empty').textContent==='Loading…','The unfinished-season count was treated as settled');
        seasons.resolve();
        await until(()=>ids()==='1' && q('.library-status-caption').textContent==='1 of 2','Final progress did not use season data');
        check(reads.length===new Set(reads).size,'First Library hydration read the same metadata twice');
      } finally {headers.resolve(); seasons.resolve(); fresh.dispose(); store.tmdbEntries=entries;}
    }));
  await run('Library shows every watched title offline with its aired count, rating and progress', () =>
    fixture(async ({ q, choose, ids, groups, doc, frame, store, screen, ctx, premiere }) => {
      check(ids() === '2,1,4,6,5,3' && groups() === 'All (6)|Complete (1)|More to watch (1)' &&
        q('.library-count').textContent === '6 shows', 'Wrong membership, collation, or Library counts');
      const card = id => q(`[data-library-show="${id}"]`);
      const partial = card(1).querySelector('progress');
      const firstLink = card(1).querySelector('a'), poster = firstLink.querySelector('.tv-poster');
      firstLink.focus();
      await screen.refresh();
      check(card(1).querySelector('a') === firstLink && firstLink.querySelector('.tv-poster') === poster && doc.activeElement === firstLink &&
        card(1).querySelector('progress') === partial, 'Refreshing a Library card replaced its artwork, focus or progress control');
      check(partial.max === 2 && partial.value === 1 && card(1).textContent.includes('1 of 2') &&
        card(1).textContent.includes('8.5/10'), 'Specials, early marks, or plays entered aired progress');
      for (const id of [2,5]) check(!card(id).querySelector('progress') &&
        card(id).querySelector('.library-status-caption').textContent === 'Dropped', 'Dropped must take priority over progress');
      check(card(3).textContent.includes('3 episodes') && card(3).textContent.includes('0/10') &&
        card(3).textContent.includes('Not on TMDB') && !card(3).querySelector('img,progress'), 'Missing title or zero rating lost');
      check(card(4).textContent.includes('1 episode') && !card(4).querySelector('progress'), 'No aired denominator must use recorded episodes');
      check(card(6).textContent.includes('1 episode') && !card(6).textContent.includes('Not on TMDB'), 'Unfetched title was treated as a 404');
      check(card(5).querySelector('strong').textContent === titles[5] && !card(5).querySelector('b'), 'Saved title became HTML');
      check(q('[data-omitted]').textContent.includes('2 shows'), 'Coverage for incomplete progress figures was hidden');
      check(frame.contentWindow.getComputedStyle(q('.library-grid')).gridTemplateColumns.split(' ').length === 3 &&
        doc.documentElement.scrollWidth <= frame.clientWidth, 'Phone grid size or overflow');
      const search = q('.tv-search-field');
      check(search.previousElementSibling.contains(q(sort)) && search.getBoundingClientRect().top >= q(sort).getBoundingClientRect().bottom,
        'On a phone Library search should follow Sort on its own row');
      frame.width = '1600';
      await until(() => q(sort).getBoundingClientRect().right <= search.getBoundingClientRect().left &&
        q(sort).getBoundingClientRect().bottom > search.getBoundingClientRect().top, 'Desktop Library search did not fit beside Sort');
      const trigger = card(1).querySelector('.library-status-trigger');
      await until(()=>trigger.getAttribute('aria-haspopup') === 'menu','Desktop count menu missing');
      trigger.scrollIntoView({block:'center'});
      trigger.click();
      const activeChoice = q('.library-status-menu [role=menuitem]');
      await store.selectDisplayPreference('librarySort','rating');
      await until(()=>q(sort).value==='rating','Sort while the count menu is open');
      check(doc.activeElement===activeChoice && trigger.getAttribute('aria-expanded')==='true',
        'Moving the card closed its count menu or lost the focused action');
      check(activeChoice && doc.activeElement === activeChoice,'Desktop menu did not focus its first action');
      await store.commit((await store.snapshot()).revision,{put:{ratings:[{show_id:1,show:titles[1],rating:7}]}});
      await screen.refresh();
      check(doc.activeElement === activeChoice && card(1).querySelector('.library-rating').textContent === '7/10',
        'An incoming rating closed the menu or moved focus from its selected action');
      await store.commit((await store.snapshot()).revision,{put:{watched:[watch(1,1,2)]}});
      await screen.refresh();
      check(!q('.library-status-menu') && doc.activeElement === trigger && trigger.textContent === 'Complete',
        'An incoming completion retained obsolete menu actions or lost focus');
      await store.commit((await store.snapshot()).revision,{remove:{watched:[[1,1,2]]}});
      await screen.refresh();
      frame.width = '390';
      choose(progress,'more');
      check(ids() === '1' && q('[data-omitted]').textContent.includes('2 shows omitted'), 'Missing, special-only, or Stopped show entered More');
      choose(progress,'complete');
      check(ids() === '2' && q(progress).value === 'complete', 'A complete Stopped show disappeared');
      await store.commit((await store.snapshot()).revision, {remove:{lists:[['sToPped',2]]}});
      await screen.refresh();
      check(card(2).querySelector('.library-status-caption').textContent === 'Complete' && !card(2).querySelector('progress'),
        'Picking up a finished show should restore its Complete label');
      const revision = (await store.snapshot()).revision;
      ctx.service.environment.now = () => premiere.getTime();
      await screen.refresh();
      check(!card(2) && q(progress).value === 'complete', 'The cached season premiere left the show in the Complete filter');
      choose(progress,'more');
      check(card(2).querySelector('.library-status-caption').textContent === '2 of 3' && card(2).querySelector('progress').value === 2 &&
        (await store.snapshot()).revision === revision, 'An offline premiere should update Library progress without a watch edit');
    }));

  await run('Library publishes each committed record while optional caches are suspended and ignores obsolete replies', () =>
    fixture(async ({ root, ctx, store, screen, q, groups, choose, ids }) => {
      screen.dispose();
      const readEntries = store.tmdbEntries.bind(store);
      let release, keyAvailable = false, malSource = 'mdblist';
      const suspend = new Promise(resolve => { release = resolve; });
      store.tmdbEntries = async (...args) => { await suspend; return readEntries(...args); };
      ctx.critics = { displaySource: async () => {
        if (!keyAvailable) throw new DOMException('Fictional optional cache failure', 'UnknownError');
        return { configured:false, malSource };
      } };
      const mal = (season, score) => ({season, score, offset:0, malId:1});
      ctx.mal = {read:async () => new Map([[1,[mal(null,4),mal(1,9)]],[2,[mal(null,8)]]])};
      const fresh = mountLibraryScreen(root, ctx, {sort:'tomatoes'}, true);
      try {
        await fresh.ready;
        check(groups() === 'All (6)|Complete|More to watch' && q('[data-library-show="3"]').textContent.includes('0/10') &&
          !q('[data-library-show="3"]').textContent.includes('Not on TMDB') && q('.library-recovery').hidden,
          'Unsettled metadata produced a progress total, hid a saved rating, or implied a confirmed 404');
        choose(list, '=Cycle');
        const queued = [];
        for (let rating = 6; rating <= 8; rating++) {
          await store.commit((await store.snapshot()).revision, {put:{ratings:[{show_id:1,show:titles[1],rating}]}});
          queued.push(fresh.refresh());
          await until(() => q('[data-library-show="1"] .library-rating')?.textContent === rating + '/10',
            'A pending cache read blocked a newer committed rating');
        }
        check(ids() === '2,1' && q(sort).value === 'title',
          'An unreadable source erased a saved preference or the active list');
        keyAvailable = true; malSource = 'github';
        await store.commit((await store.snapshot()).revision, {replace:{watched:[watch(1,1,1),watch(2,1,1)]}});
        queued.push(fresh.refresh());
        await until(() => groups().startsWith('All (2)|'), 'Older watch rows survived the latest commit');
        q(sort).focus();
        await until(() => q(sort + ' option[value="myanimelist"]'), 'A stalled TMDB cache hid cached MyAnimeList sorting');
        choose(sort,'myanimelist');
        check(ids() === '2,1', 'A waiting TMDB season incorrectly displaced the unseasoned score');
        release();
        await Promise.all(queued);
        check(ids() === '1,2' && groups().startsWith('All (2)|') && q(sort).value === 'myanimelist' &&
          q('[data-library-show="1"] progress') && q('[data-library-show="1"] .library-rating').textContent === '8/10',
          'Late metadata failed to apply season scores or an obsolete completion replaced a newer record or filter');
        malSource = 'mdblist'; await fresh.refresh();
        check(q(sort).value === 'title', 'A removed score source kept the saved sort');
        const snapshot = await store.snapshot();
        await store.commit(snapshot.revision, {replace:{watched:[]}});
        await fresh.refresh();
        check(q('.library-recovery').hidden, 'The empty-record hint appeared while a list filter was active');
        choose(list, '');
        check(!q('.library-recovery').hidden && q('.library-recovery a')?.hash === '#/recovery',
          'A genuinely empty, unfiltered Library did not offer recovery');
        const readRecord = store.overviewRows.bind(store);
        let rejectOlder;
        store.overviewRows = () => new Promise((_, reject) => { rejectOlder = reject; });
        const obsolete = fresh.refresh();
        store.overviewRows = readRecord;
        await fresh.refresh();
        rejectOlder(new DOMException('Fictional obsolete read failure', 'UnknownError'));
        await obsolete;
        check(!q('.library-recovery').hidden, 'A failed obsolete read overrode a newer successful read');
        store.overviewRows = async () => { throw new DOMException('Fictional personal read failure', 'UnknownError'); };
        let failed;
        try { await fresh.refresh(); } catch (error) { failed = error; }
        check(failed?.name === 'UnknownError' && q('.library-recovery').hidden && !q('.library-count').textContent &&
          !q('[data-category=all] span').textContent && q('.tv-empty').textContent.includes('Could not read your Library'),
          'A failed personal read claimed there were zero shows or displayed empty-record guidance');
      } finally { release(); fresh.dispose(); }
    }));

  await run('Library combines exact list, rating, progress and Unicode substring filters while keeping chip counts fixed', () =>
    fixture(async ({ q, all, doc, ids, groups, choose, search, screen, ctx, root, store }) => {
      const one = '[data-library-show="1"]', held = q(one);
      search('no matching series'); search('');
      check(q(one) === held && doc.activeElement === q('input[type=search]'), 'Clearing a search rebuilt an unchanged card or moved focus');
      choose(list, '=Cycle'); choose(rating, '8'); choose(progress,'more'); search('cOlE');
      check(ids() === '1' && groups() === 'All (6)|Complete (1)|More to watch (1)' &&
        q('.library-count').textContent === '1 show', 'Combined filters or unfiltered counts');
      await screen.refresh();
      check(ids() === '1' && doc.activeElement === q('input[type=search]') && q(rating).value === '8',
        'Background refresh changed search focus or active filters');
      choose(rating, '9'); check(!ids() && q('.tv-empty').textContent === 'No matching shows.', 'Threshold below the next integer was rounded');
      choose(rating, 'any'); choose(list, '=cycle'); choose(progress,'all'); search('');
      check(ids() === '5', 'Case variants of a saved list were merged');
      q(list).focus();
      check(all(list+' option').some(l => l.textContent === '“Any”'), 'The list named Any and the reset choice look identical');
      choose(list,'=Any');
      choose(rating, 'rated'); check(ids() === '3', 'List named Any collided with clearing the filter, or 0 became unrated');
      choose(rating, '1'); check(!ids(), 'Threshold of one accepted zero');
      choose(list, ''); choose(rating, 'unrated');
      check(ids() === '4,6,5' && q(list).value === '', 'Unrated or cleared list filter');
      search('TRASSE'); check(ids() === '4,6', 'Case folding or substring search');
      search('traẞe'); check(ids() === '4,6', 'Capital sharp S did not match a lowercase sharp S');
      search('tıde'); check(!ids(), 'Default case folding incorrectly matched dotless ı with i');
      choose(rating, 'any'); search('E\u0301cOL'); check(ids() === '2,1', 'Composed and decomposed titles matched differently');
      q(rating).focus();
      check(all(rating+' option').map(n => n.value).join() === 'any,rated,unrated,1,2,3,4,5,6,7,8,9,10' &&
        q(rating).value === 'any', 'Rating choices or active radio are incorrect');
      search('no matching series');
      await store.commit((await store.snapshot()).revision,{put:{
        watched:[watch(1,1,2)],ratings:[{show_id:1,show:titles[1],rating:9}],
      }});
      await screen.refresh(); search('');
      check(q(one+' .library-status-caption').textContent==='Complete' && q(one+' .library-rating').textContent==='9/10',
        'A card hidden during an edit restored its previous watch count or rating');
      screen.dispose();
      const fresh = mountLibraryScreen(root, ctx);
      try {
        q(list).focus();
        check(q(list).disabled && !q('dialog[open]'), 'List filter opened before the names were known');
        await fresh.ready;
        q(list).focus();
        const snapshot = await store.snapshot();
        await store.commit(snapshot.revision, { put:{ lists:[member('New arrival', 1), member('Any (list)', 5)] } });
        await fresh.refresh();
        check(!q('dialog[open]') && doc.activeElement === q(list), 'A changed list menu retained obsolete choices or lost focus');
        choose(list, '=New arrival');
        check(ids() === '1', 'The new list was missing from the reopened filter');
        q(list).focus();
        const captions = all(list+' option').map(label => label.textContent);
        check(new Set(captions).size === captions.length, 'A list name duplicated another displayed filter choice');
        choose(list,'=Any (list)');
        check(ids() === '5', 'A literal Any (list) name did not filter its own members');
      } finally { fresh.dispose(); }
    }));

  await run('Library sorts by displayed episodes or rating, breaks ties in title order, and restores keyboard focus', () =>
    fixture(async ({ q, all, doc, ids, choose, win, frame, screen,store,ctx,root,search }) => {
      q(sort).focus();
      check(q(sort).tagName === 'SELECT' && all(sort+' option').map(i=>i.value).join() === 'title,rating,episodes' &&
        q(sort).value === 'title' && !q('dialog[open]'), 'Wrong native sort choices');
      const status = q('[data-library-show="1"] .library-status-trigger');
      let labelReads = 0;
      status.getAttribute = function(name) {
        if (name === 'aria-label') labelReads++;
        return Element.prototype.getAttribute.call(this,name);
      };
      choose(sort, 'episodes');
      check(ids() === '3,2,1,4,6,5' && q(sort).value === 'episodes', 'Episode sort used plays, all recorded rows, or the wrong tie-breaker');
      choose(sort, 'rating');
      check(ids() === '2,1,3,4,6,5' && doc.activeElement === q(sort), 'Rating sort lost zero, missing ratings, or tied titles');
      delete status.getAttribute;
      check(!labelReads,'Reordering a retained card repeated its status content update');
      q('[data-show-id="3"]').focus(); await screen.refresh();
      check(doc.activeElement.dataset.showId === '3', 'Refreshing the grid lost the focused show');
      frame.width = '1100';
      await until(() => win.innerWidth > 900,'desktop sort area');
      check(q(sort).getBoundingClientRect().width > 0 && q(sort).value === 'rating' &&
        doc.documentElement.scrollWidth <= frame.clientWidth, 'Desktop sort selection or overflow');
      await until(async () => (await store.devicePreference('librarySort')).preference === 'rating','rapid choices saved in order');
      choose(list,'=Cycle'); choose(rating,'rated'); search('éco');
      await store.selectDisplayPreference('librarySort','episodes');
      await until(() => q(sort).value === 'episodes','open Library reflects a settings change');
      check(q(list).value === '=Cycle' && q(rating).value === 'rated' && q('input[type=search]').value === 'éco' &&
        doc.activeElement === q('input[type=search]'), 'Incoming sort disturbed filters, query or focus');
      screen.dispose();
      const readPreference = store.devicePreference.bind(store);
      let release, delayFirstRead = true;
      store.devicePreference = async key => {
        const result = await readPreference(key);
        if (key === 'librarySort' && delayFirstRead) {
          delayFirstRead = false;
          await new Promise(resolve => { release = resolve; });
        }
        return result;
      };
      const fresh = mountLibraryScreen(root,ctx);
      try {
        await until(() => release && !q(sort).disabled, 'Sort control while a saved preference read is held');
        choose(sort,'title'); choose(sort,'episodes'); choose(sort,'rating');
        await until(async () => (await readPreference('librarySort')).preference === 'rating','persist latest local choice');
        release();
        await fresh.ready;
        check(q(sort).value === 'rating' && q(list).value === '' && q(rating).value === 'any' && !q('input[type=search]').value,
          'A late preference read reverted the new selection or a new visit kept filters');
      } finally { release?.(); fresh.dispose(); store.devicePreference = readPreference; }
      const reopened = mountLibraryScreen(root,ctx);
      try {
        await reopened.ready;
        check(q(sort).value === 'rating','A new Library visit failed to restore the saved sort');
      } finally { reopened.dispose(); }
    }));

  await run('Library retries a failed sort once and ignores older Retry actions after a new selection or navigation', () =>
    fixture(async ({q,all,screen,store,choose}) => {
      const saved = async () => (await store.devicePreference('librarySort')).preference;
      async function failChoice(value) {
        const before = new Set(all('.report button'));
        let aborted = false, retry;
        const commit = IDBTransaction.prototype.commit;
        IDBTransaction.prototype.commit = function() {
          if (!aborted && this.objectStoreNames.contains('settings')) { aborted = true; this.abort(); }
          else commit.call(this);
        };
        try {
          choose(sort,value);
          await until(() => {
            retry = all('.report button').find(b=>!before.has(b) && b.textContent==='Try again');
            return aborted && retry;
          },'Failed sort did not offer a fresh Retry');
        } finally { IDBTransaction.prototype.commit = commit; }
        return retry;
      }
      const retry = await failChoice('rating');
      check(q(sort).value==='title' && await saved()!=='rating','Failed sort was shown as saved');
      retry.click();
      await until(async () => await saved()==='rating' && q(sort).value==='rating','Retry did not commit a new sort write');
      const superseded = await failChoice('title');
      choose(sort,'episodes');
      await until(async () => await saved()==='episodes','Newer selection did not save');
      superseded.click();
      check(await saved()==='episodes','Retry overwrote a newer choice on the same screen');
      const beforeLeaving = await failChoice('rating');
      screen.go({page:'statistics'});
      await until(()=>q('.statistics-screen'),'Statistics did not open');
      screen.go({page:'library'});
      await until(()=>q(sort)?.value==='episodes','Library did not reopen with the correct sort');
      choose(sort,'title');
      await until(async () => await saved()==='title','The new Library choice did not commit');
      beforeLeaving.click();
      check(await saved()==='title','Retry from a previous visit overwrote the current preference');
      const visible = new Set(all('.report button'));
      const commit = IDBTransaction.prototype.commit;
      let failedFirst = false;
      IDBTransaction.prototype.commit = function() {
        if (!failedFirst && this.objectStoreNames.contains('settings')) { failedFirst = true; this.abort(); }
        else commit.call(this);
      };
      try {
        choose(sort,'episodes');
        choose(sort,'rating');
        await until(async () => failedFirst && await saved()==='rating' && q(sort).value==='rating',
          'A failure from the earlier choice rolled back the latest selection');
        check(!all('.report button').some(b=>!visible.has(b) && b.textContent==='Try again'),
          'An obsolete failed selection offered to overwrite the latest sort');
      } finally { IDBTransaction.prototype.commit = commit; }
    },true));

  await run('Browser Back restores the Library selection and removing the last list membership recovers to Any', () =>
    fixture(async ({ q, win, all, ids, store, choose, search }) => {
      q('[data-category=tv]').click();
      choose(list, '=Cycle'); choose(rating, 'rated'); choose(sort, 'rating'); search('éco'); choose(progress,'complete');
      check(ids() === '2', 'Filtered Library did not find the complete show');
      q('[data-show-id="2"]').click();
      await until(() => win.location.hash === '#/show/2' && !q('.library-screen'), 'Card did not open its show');
      win.history.back();
      await until(() => q('[data-show-id="2"]') && q('.library-screen'), 'Back did not return to the Library');
      check(ids() === '2' && q('input[type=search]').value === 'éco' && q(progress).value === 'complete' && q('[data-category=tv]').getAttribute('aria-pressed') === 'true' &&
        q(list).value === '=Cycle' && q(rating).value === 'rated' && q(sort).value === 'rating',
      'Browser Back lost the query, progress group, filters, or order');
      const snapshot = await store.snapshot();
      const cycleKeys = snapshot.tables.lists.filter(r => r.list === 'Cycle').map(r => [r.list, r.show_id]);
      await store.commit(snapshot.revision, { remove: { lists: cycleKeys } });
      await until(() => q(list).value === '', 'Deleted list remained selected after a refresh');
      check(ids() === '2' && q(rating).value === 'rated', 'Other filters changed after the list disappeared');
      const current = await store.snapshot();
      await store.commit(current.revision, { replace: { watched: [] } });
      await until(() => !all('.library-grid li').length && q('.tv-empty'), 'Cleared record did not refresh');
      check(q('.tv-empty').textContent.includes('mark an episode watched') && !q('[data-omitted]').textContent, 'Empty Library lacks first-watch guidance');
    }, true));

  await run('Library orders MDBList scores with ties and missing scores and drops unavailable sorts on source or key changes', () =>
    fixture(async ({ q, ids, ctx, screen, choose, doc }) => {
      const scores = new Map([
        [1, { tomatoes: 70, metacritic: null, myanimelist: 8.2 }], [2, { tomatoes: 70, metacritic: 0, myanimelist: 8.2 }],
        [3, { tomatoes: 0, metacritic: 88, myanimelist: 0 }], [4, { tomatoes: 90, metacritic: 38, myanimelist: null }],
      ]);
      let status = 'refused', malSource = 'mdblist', saved;
      ctx.critics = { displaySource: async () => ({ configured:status!=='missing-key', malSource }), read: async () => malSource === 'github' ?
        new Map(Array.from(scores, ([id, score]) => [id, { ...score, myanimelist: null }])) : scores,
        refresh() { throw new Error('The Library should sort the local cache.'); } };
      ctx.saveView = value => { saved = value; };
      await screen.refresh();
      choose(sort, 'tomatoes');
      check(ids() === '4,2,1,3,6,5' && q(sort).value === 'tomatoes',
        'Tomatoes sort lost tied titles, zero, or missing scores while the configured key was refused');
      choose(sort, 'myanimelist');
      check(ids() === '2,1,3,4,6,5' && q(sort).value === 'myanimelist',
        'MyAnimeList sort lost the title tie, zero score or missing scores');
      malSource = 'github'; await screen.refresh();
      check(ids() === '2,1,4,6,5,3' && saved.sort === 'myanimelist', 'The GitHub preference lost the sort or used MDBList’s scores');
      status = 'missing-key'; await screen.refresh();
      q(sort).focus();
      check(q(sort+' option[value=myanimelist]').selected && !q(sort+' option[value=metacritic]'), 'Wrong sorts for a saved GitHub preference with no key');
      malSource = 'mdblist'; status = 'ready'; await screen.refresh();
      choose(sort, 'metacritic');
      check(ids() === '3,4,2,1,6,5' && doc.activeElement === q(sort), 'Metacritic sort or returned focus');
      scores.set(5, { tomatoes: null, metacritic: 100 }); await screen.refresh();
      check(ids() === '5,3,4,2,1,6', 'The displayed order did not reflect a cache update');
      let releaseMal;
      ctx.mal = { read:() => new Promise(resolve => { releaseMal = () => resolve(new Map()); }) };
      q(sort).focus(); status = 'missing-key'; malSource = 'github';
      const changing = screen.refresh();
      await until(() => releaseMal && !q('dialog[open]'), 'A pending GitHub file hid the confirmed removal of the critic key');
      check(!q('dialog[open]') && saved.sort === 'metacritic' && q(sort).value === 'title',
        'Removing the key left a stale sort sheet or preference');
      q(sort).focus();
      check(!q(sort+' option[value=tomatoes]') && q(sort+' option[value=myanimelist]'), 'The picker kept revoked sorts during a held file read');
      releaseMal(); await changing;
      malSource = 'mdblist'; await screen.refresh();
      q(sort).focus();
      check(!q(sort+' option[value=tomatoes]') && !q(sort+' option[value=metacritic]') && !q(sort+' option[value=myanimelist]') && q(sort+' option[value=title]').selected,
        'Library still offered the removed scores');
      status = 'ready';
      await screen.refresh();
      check(q(sort+' option[value=tomatoes]') && doc.activeElement === q(sort) && q(sort).value === 'metacritic',
        'Adding newly discovered sort options moved keyboard focus or failed to restore Metacritic');
    }));

  await run('Library offers IMDb sorting for either selected source and falls back without overwriting that sort when None is selected', () =>
    fixture(async ({q,ids,ctx,screen,choose,doc}) => {
      let source = 'omdb', generation = 1n, saved;
      const values = new Map([[1,7.8],[2,7.8],[3,0],[4,9.2]]);
      ctx.imdb = { sourceStatus:async () => ({source, generation}), readShows:async () => new Map(values) };
      ctx.saveView = value => { saved = value; };
      await screen.refresh();
      choose(sort,'imdb');
      check(ids() === '4,2,1,3,6,5', 'IMDb sort lost a tie, zero, or unrated show');
      async function changeSource(change) {
        let release;
        ctx.imdb.readShows = () => new Promise(resolve => { release = () => resolve(new Map(values)); });
        change();
        const changing = screen.refresh();
        await until(() => release, 'The replacement IMDb cache was not read');
        check(ids() === '2,1,4,6,5,3' && q(sort).value === 'imdb',
          'A replaced source still supplied scores while its successor was loading');
        release(); await changing;
      }
      await changeSource(() => { source = 'github'; values.set(5,9.5); });
      check(ids() === '5,4,2,1,3,6' && q(sort).value === 'imdb',
        'Replacing the IMDb source lost the sort or kept a stale rating');
      await changeSource(() => { generation++; });
      q(sort).focus();
      source = 'none'; await screen.refresh();
      check(!q('dialog[open]') && saved.sort === 'imdb' && q(sort).value === 'title' && doc.activeElement === q(sort), 'Removed IMDb sort lost focus or selection');
      q(sort).focus();
      check(q(sort+' option[value=title]').selected && !q(sort+' option[value=imdb]'), 'Library offered IMDb with None chosen');
    }));

  await run('Library shares fresh IMDb identities with its category read before season details finish', () =>
    fixture(async ({root,ctx,store,screen,ids,q}) => {
      screen.dispose();
      const members = Array.from({length:18},(_,i)=>i+1);
      await store.commit((await store.snapshot()).revision,{replace:{watched:members.map(id=>({...watch(id,1,1),show:'Station '+id}))}});
      const gate = Promise.withResolvers();
      let lead = 5, reads = 0;
      const read = store.tmdbEntries.bind(store);
      store.tmdbEntries = async (keys,now,signal) => {
        if (keys.some(key=>key.includes('/season/'))) await gate.promise;
        return keys.map(key=>{
          const id = Number(/^tv\/(\d+)\?/.exec(key)?.[1]);
          return id ? {fetchedAt:now,value:{...show(id,1),imdbId:id === lead ? 'tt1234567' : null}} : undefined;
        });
      };
      ctx.imdb = {sourceStatus:async()=>({source:'omdb',generation:1n}),readShows:async (ids,deadline,readHeaders) => {
        const headers = await readHeaders();
        reads++;
        return new Map(ids.filter(id=>headers.get(id)?.value?.imdbId === 'tt1234567').map(id=>[id,10]));
      }};
      const fresh = mountLibraryScreen(root,ctx,{sort:'imdb'});
      try {
        await fresh.ready;
        await until(()=>ids().split(',')[0] === '5' && q(sort).value === 'imdb','The IMDb sort waited for unrelated seasons');
        gate.resolve(); lead = 14;
        await fresh.refresh();
        check(reads === 2 && ids().split(',')[0] === '14','A Library refresh reused the previous title identity or lost the IMDb sort');
      } finally { gate.resolve(); fresh.dispose(); store.tmdbEntries = read; }
    }));
}
