import { connectFixtureProviders } from './provider-fixture-cases.mjs';
import { checkCachedCastWorkers } from './cast-lookup-cases.mjs';
import { mountCastScreen } from '../dist/cast-screen.js';
import { mountShowScreen } from '../dist/show-screen.js';
import { openDeviceStore } from '../dist/storage.js';
import { TmdbClient } from '../dist/tmdb-client.js';
import { cacheExpiresAt } from '../dist/tmdb-refresh.js';
import { TmdbService } from '../dist/tmdb-service.js';

function check(value, message) { if (!value) throw new Error(message); }

export async function castCases(run) {
  const person = 311;
  const source = 50;
  const actor = 'Joss <Vale>';
  const names = { 50: 'Glass Span', 60: 'Juniper Day', 801: 'Last Light', 802: '<b>Wren</b>', 803: 'Aster', 804: 'Áster', 805: 'Slate', 806: 'Aster' };
  const credit = (id, date, character) => ({ id, name: names[id], first_air_date: date, character });
  const credits = [{ ...credit(805, null), name: 'Outdated title on a credit', poster_path: '/discarded.jpg' },
    credit(801, '2019-01-02'), credit(806, '2021-01-02'),
    credit(804, '2021-01-02'), credit(802, '2024-02-03', 'Guide'), credit(803, '2021-01-02'),
    credit(802, '2024-02-03', '<b>Pilot</b>'), credit(802, '2024-02-03', 'Guide')];
  const show = id => ({ id, name: names[id], status: 'Ended', keywords: { results: [] }, external_ids: {},
    seasons: [{ season_number: 1, episode_count: 2 }],
    last_episode_to_air: { season_number: 1, episode_number: 2, air_date: '2024-03-01' } });
  const watched = (id, episode) => ({ show_id: id, show: names[id], season: 1, episode,
    episode_id: id * 10 + episode, title: 'Bell ' + episode, times_watched: 2 });
  const name = 'csvTV-cast-' + crypto.randomUUID();
  const requests = [];
  let refusePerson = false;
  let personRequest;
  const client = new TmdbClient({ fetch: async url => {
    const path = new URL(url).pathname.replace('/3/', '');
    requests.push(path);
    if (path === 'configuration') return Response.json({ images: { secure_base_url: 'https://image.tmdb.org/t/p/',
      poster_sizes: ['w185'], profile_sizes: ['w185'], backdrop_sizes: ['w780'], still_sizes: ['w185'] } });
    if (path === 'tv/50/aggregate_credits') return Response.json({ id: source, cast: [
      { id: person, name: actor, profile_path: '/joss-vale.jpg', roles: [{ character: 'Guide' }], total_episode_count: 2 }] });
    if (path === 'tv/50/recommendations') return Response.json({ page: 1, total_pages: 0, results: [] });
    if (path === 'tv/60/aggregate_credits') return Response.json({ id: 60, cast: [
      { id: 314, name: 'Nira Fern', roles: [{ character: 'Piper' }], total_episode_count: 2 }] });
    if (path === 'tv/61/aggregate_credits') return Response.json({ id: 61, cast: [] });
    if (path.startsWith('person/')) {
      if (refusePerson) return new Response(null, { status: 401 });
      const id = Number(path.split('/')[1]);
      if (id === person && personRequest) return personRequest();
      const cast = id === person ? credits : [314, 315].includes(id) ? [credit(60, '2024-02-01', 'Piper')] : [];
      return Response.json({ id, cast, crew: [{ id: 900, name: 'Crew credit' }] });
    }
    const detail = /^tv\/(50|801|802)$/.exec(path);
    if (detail) return Response.json(show(Number(detail[1])));
    if (path === 'tv/805') return new Response(null, { status: 404 });
    throw new Error('Unexpected request for cast fixture data.');
  } });
  let online = true;
  let now = Date.now();
  const env = { online: () => online, now: () => now, visible: () => true };
  const frame = document.createElement('iframe');
  frame.width = '320';
  frame.height = '600';
  const loaded = new Promise(resolve => frame.addEventListener('load', resolve, { once: true }));
  frame.src = '/screen-fixture';
  document.body.append(frame);
  await loaded;
  const doc = frame.contentDocument;
  const imagePolicy = doc.createElement('meta');
  imagePolicy.httpEquiv = 'Content-Security-Policy';
  imagePolicy.content = "img-src 'none'";
  doc.head.append(imagePolicy);
  const root = doc.createElement('main');
  doc.body.replaceChildren(root);
  const text = selector => root.querySelector(selector)?.textContent;
  const rows = () => Array.from(root.querySelectorAll('.cast-row'));
  const calls = () => requests.filter(path => path === 'person/' + person + '/tv_credits').length;
  let store, service, screen, pending;
  const routes = [];
  const ctx = { get service() { return service; }, go(route) { routes.push(route); },
    run(action) { pending = action(); return pending; }, clearUndo() {} };
  async function openDevice() {
    screen?.dispose();
    service?.close();
    store?.close();
    store = await openDeviceStore({ name });
    await connectFixtureProviders(store,name);
    service = new TmdbService(store, client, env);
  }
  function cast(id = person, showId) {
    screen?.dispose();
    screen = mountCastScreen(root, ctx, id, showId);
    return screen.ready;
  }
  try {
    await openDevice();
    await service.saveKey('fictional-cast-screen');
    await store.commit((await store.snapshot()).revision, { put: {
      watched: [watched(801, 1), watched(802, 1), watched(802, 2), watched(803, 1)],
      ratings: [{ show_id: 804, show: names[804], rating: 0 }],
      lists: [{ show_id: 805, show: names[805], list: 'Watchlist' }],
    } });
    await service.view({ kind: 'show', id: 801 });
    await service.view({ kind: 'show', id: 802 });
    await service.view({ kind: 'show', id: 805 });

    await run('Show cast links open a named member with sorted TV cast credits and four personal watch states at 320px', async () => {
      screen = mountShowScreen(root, ctx, source);
      await screen.ready;
      const member = root.querySelector('a.show-cast-member');
      check(member?.hash === '#/cast/311?show=50' && member.tabIndex === 0 && member.textContent.includes(actor), 'Cast link lost its source or accessible name.');
      member.focus();
      member.click();
      const route = routes.at(-1);
      check(route.page === 'cast' && route.id === person && route.showId === source, 'Cast link opened the wrong member.');
      const ready = cast(route.id, route.showId);
      check(root.querySelector('.skeleton'), 'Missing opening credits skeleton.');
      await ready;
      check(text('h1') === actor && text('header p') === 'In 3 shows you have watched', 'Wrong actor or unique watched-show count.');
      check([...root.querySelectorAll('section h2')].map(el => el.textContent).join('|') === 'Shows you’ve seen|Other shows',
        'The seen credits must come before other roles.');
      check(rows().map(link => link.hash).join('|') === [802, 803, 801, 806, 804, 805].map(id => '#/show/' + id).join('|'),
        'Credits mixed in crew, duplicated a show, or mishandled dates and tied titles.');
      check(rows().map(row => row.querySelector('.cast-watch').textContent).join('|') === '✓Complete|✓Watched|✓Part watched|Not watched|Not watched|Not watched',
        'Credits misreported personal watch status.');
      check(text('.cast-title strong') === names[802] && text('.cast-title small') === '2024 · Guide, <b>Pilot</b>' && !root.querySelector('.cast-title b'),
        'Date, role aggregation, or safe text rendering failed.');
      const missing = rows().at(-1);
      check(missing.querySelector('strong').textContent === names[805] && !missing.querySelector('img') && missing.textContent.includes('Not on TMDB'),
        'A confirmed missing credited show lost its retained title, plain artwork or explanation.');
      check(doc.documentElement.scrollWidth <= 320, 'Cast credits overflow their phone viewport.');
      const search = root.querySelector('input[type="search"]');
      const heading = root.querySelector('h1').getBoundingClientRect();
      const field = search.getBoundingClientRect();
      check(field.left > heading.right && heading.top < field.bottom && field.top < heading.bottom,
        'Cast search should share the row with the name on a phone.');
      const filter = value => { search.value = value; search.dispatchEvent(new Event('input')); };
      const visibleRows = () => rows().filter(row => !row.closest('[hidden]'));
      const before = requests.length;
      search.focus();
      filter(' Åstér ');
      check(visibleRows().map(row => row.hash).join() === '#/show/803,#/show/806,#/show/804',
        'Local search must fold accents and keep each credit in its group.');
      await screen.refresh();
      check(doc.activeElement === search && search.value === ' Åstér ' && visibleRows().length === 3,
        'Refresh replaced the search input or discarded the query.');
      filter('<b>pilot');
      check(visibleRows().length === 1 && visibleRows()[0].hash === '#/show/802', 'A search for an aggregated role lost its show.');
      filter('no match');
      check(visibleRows().length === 0 && [...root.querySelectorAll('p')].some(el => !el.closest('[hidden]') && el.textContent === 'No matching credits.'),
        'A search with no results failed to show the empty state.');
      search.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
      check(!search.value && visibleRows().length === 6 && doc.activeElement === search && requests.length === before,
        'Clearing a search changed focus, lost credits or made another lookup.');
    });

    await run('Cast credit links retain keyboard focus across record updates and credits refresh once per screen opening', async () => {
      const before = calls();
      const link = rows().find(row => row.hash === '#/show/801');
      link.focus();
      await store.commit((await store.snapshot()).revision, { put: { watched: [watched(801, 2)] } });
      await screen.refresh();
      check(calls() === before && doc.activeElement?.hash === link.hash && doc.activeElement.textContent.includes('✓Complete'),
        'Local changes refetched credits, removed keyboard focus or left a stale status.');
      doc.activeElement.click();
      check(routes.at(-1).page === 'show' && routes.at(-1).id === 801, 'Credit link opened a different show.');
      const movedHash = '#/show/804';
      rows().find(row => row.hash === movedHash).focus();
      await store.commit((await store.snapshot()).revision, { put: { watched: [watched(804, 1)] } });
      await screen.refresh();
      check(doc.activeElement.hash === movedHash && doc.activeElement.closest('section').querySelector('h2').textContent === 'Shows you’ve seen',
        'Recording a first watch must move a focused credit into seen shows.');
      await store.commit((await store.snapshot()).revision, { remove: { watched: [[804, 1, 1]] } });
      await screen.refresh();
      check(doc.activeElement.hash === movedHash && doc.activeElement.closest('section').querySelector('h2').textContent === 'Other shows',
        'Removing a final watch must return the focused credit to the remaining shows.');
      await cast();
      check(calls() === before + 1 && text('h1') === actor, 'Reopening a direct cast URL lost its cached name or reused the previous response.');
      const previousTime=now, {generation}=await store.tmdbState('access');
      const browsedCast='tv/777/aggregate_credits';
      const lookup=store.cachedCastMember;let scans=0;
      store.cachedCastMember=function(...args){scans++;return lookup.apply(this,args);};
      now+=1000;
      try {
        await store.writeTmdb(generation,{entries:{'person/876/tv_credits':{fetchedAt:now,value:[]}}});
        await screen.refresh();
        check(scans===0,'An unrelated browsing update rescanned every cast');
        check(await store.writeTmdb(generation,{entries:{[browsedCast]:{fetchedAt:now,value:[
          {id:person,name:'Joss Vale, updated',profilePath:null,characters:['Guide'],episodeCount:1},
        ]}}}),'Could not add a more recent credit for the direct link');
        await screen.refresh();
        check(scans===1 && text('h1')==='Joss Vale, updated','A more recent untracked cast left the old name on the direct cast page');
      } finally {
        store.cachedCastMember=lookup;
        await store.writeTmdb(generation,{entries:{[browsedCast]:{fetchedAt:now,value:null}}});
        now=previousTime;
      }
      const cold = requests.length;
      await cast(314, 0);
      await screen.refresh();
      check(text('h1') === 'Nira Fern' && text('.cast-title strong') === 'Juniper Day' &&
        requests.slice(cold).join('|') === 'person/314/tv_credits|tv/60/aggregate_credits',
        'An unseen direct cast link failed to resolve its name once from a credited show.');
      const unknown = requests.length;
      await cast(315, 61);
      await screen.refresh();
      check(text('h1') === 'Cast member' && text('.cast-title strong') === 'Juniper Day' &&
        requests.slice(unknown).join('|') === 'person/315/tv_credits|tv/61/aggregate_credits',
        'An unsuccessful source-show identity lookup hid credits or retried on a local redraw.');
    });

    await run('A slow credit refresh keeps a cached cast page searchable and reconciles changes without stealing focus', async () => {
      const started = Promise.withResolvers(), reply = Promise.withResolvers();
      personRequest = () => { started.resolve(); return reply.promise; };
      const opening = cast(person, source);
      try {
        await started.promise;
        const deadline = performance.now() + 2500;
        while ((rows().length !== 6 || text('h1') !== actor) && performance.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        check(rows().length === 6 && text('h1') === actor, 'Retained cast credits stayed blank until the provider replied.');
        const search = root.querySelector('input[type=search]');
        search.focus();
        search.value = 'Guide';
        search.dispatchEvent(new Event('input'));
        check(rows().filter(row => !row.closest('[hidden]')).length === 1, 'The cached credit list could not be searched.');
        reply.resolve(Response.json({id:person,cast:[credit(803,'2021-01-02','Guide')]}));
        await opening;
        check(doc.activeElement === search && search.value === 'Guide' && rows().length === 1 &&
          rows()[0].hash === '#/show/803' && !rows()[0].closest('[hidden]'), 'The provider reply lost focus, filters or canonical credits.');
      } finally {
        reply.resolve(Response.json({id:person,cast:credits}));
        await opening;
        personRequest = undefined;
        await cast(person,source);
      }
    });

    await run('A removed cast credit list clears its search and returns focus to the heading', async () => {
      try {
        personRequest = () => new Response(null, {status:404});
        await cast(person,source);
        check(rows().length === 6, 'A failed credits endpoint discarded the retained cast list.');
        const empty = Promise.withResolvers(), started = Promise.withResolvers();
        personRequest = () => { started.resolve(); return empty.promise; };
        const reopening = cast(person,source);
        try {
          await started.promise;
          await pending;
          root.querySelector('input').focus();
        } finally { empty.resolve(Response.json({id:person,cast:[]})); await reopening; }
        check(!rows().length && root.textContent.includes('No TV shows listed.') && root.querySelector('input').parentElement.hidden,
          'An authoritative empty credit list left old links or a search control on screen.');
        check(doc.activeElement === root.querySelector('h1'), 'Hiding the focused credit search dropped keyboard focus.');
      } finally {
        personRequest = undefined;
        await cast(person,source);
      }
    });

    await run('Cast credits expire even when the cutoff falls during an in-flight read', async () => {
      const before = now, expires = cacheExpiresAt((await service.read({kind:'person',id:person})).fetchedAt);
      const overview = store.overviewRows, drawing = Promise.withResolvers(), resume = Promise.withResolvers(), failure = Promise.withResolvers();
      store.overviewRows = async (...args) => { drawing.resolve(); await resume.promise; return overview.apply(store,args); };
      personRequest = () => failure.promise;
      now = expires-1;
      const expiring = cast(person, source);
      try {
        await drawing.promise;
        now = expires;
        resume.resolve();
        await pending;
        check(!rows().length, 'A retained credit list crossed its retention deadline while the record was being read.');
        failure.resolve(new Response(null,{status:400}));
        await expiring;
        check(!rows().length && root.textContent.includes('Cannot reach TMDB.'), 'A late provider failure resurrected expired credits.');
      } finally {
        resume.resolve(); failure.resolve(new Response(null,{status:400})); await expiring;
        store.overviewRows = overview;
        now = before;
        personRequest = undefined;
        await cast(person,source);
      }
    });

    await run('Three hundred cast credits keep their rows and artwork through a search and an unrelated refresh', async () => {
      const prior = credits.length;
      for (let i=0; i<294; i++) credits.push({id:9000+i,name:'Credit '+i,first_air_date:'2021-01-01',character:'Role '+i});
      try {
        await cast(person,source);
        const initial = rows();
        const portrait = root.querySelector('.cast-portrait');
        const art = initial.map(row => row.querySelector('.tv-poster'));
        const count = requests.length;
        const filter = root.querySelector('input');
        filter.value = 'Credit 293'; filter.dispatchEvent(new Event('input'));
        await screen.refresh();
        const next = rows();
        check(initial.length === 300 && next.length === 300 && next.every((row,i)=>row === initial[i] && row.querySelector('.tv-poster') === art[i]) &&
          root.querySelector('.cast-portrait') === portrait, 'Refreshing a long filmography rebuilt its links or artwork');
        check(next.filter(row => !row.closest('li').hidden).length === 1 && requests.length === count,
          'Searching the filmography refetched or lost its matching credit');
      } finally { credits.splice(prior); await cast(person,source); }
    });

    await run('Cast credits and identity survive reopening without a key, including key setup and the retention cutoff', async () => {
      await service.removeKey((await service.keyStatus()).generation);
      await openDevice();
      const before = requests.length;
      await cast(person, 999);
      check(text('h1') === actor && rows().length === 6 && text('header p') === 'In 3 shows you have watched',
        'Reopened keyless cast screen failed to use persisted credits, record or fallback cast identity.');
      check((await store.cachedCastMember(person, now))?.profilePath === '/joss-vale.jpg' && root.querySelector('.cast-portrait[aria-hidden="true"]'),
        'Reopened cast identity lost its cached profile path or artwork fallback.');
      await cast(312);
      check(text('h1') === 'Cast member' && root.textContent.includes('A TMDB key is needed.') && !text('header p'), 'Uncached direct link invented data or hid key setup.');
      root.querySelector('button').click();
      check(routes.at(-1).page === 'settings', 'Missing-key action did not open Settings.');
      now += 200 * 86400000;
      await cast();
      check(text('h1') === 'Cast member' && !rows().length && root.textContent.includes('A TMDB key is needed.'), 'Expired cast data appeared on the screen.');
      check(before === requests.length, 'Reading a keyless cast screen contacted the provider.');
      now = Date.now();
    });

    await run('Cast identity reads only retained cast lists and picks the newest matching credit across batches', async () => {
      const original = store.cachedCastMember, release = Promise.withResolvers();
      let scans = 0;
      store.cachedCastMember = async (...args) => { scans++; await release.promise; return original.apply(store,args); };
      const opening = cast(person);
      try {
        const deadline = performance.now()+3000;
        while (!rows().length && performance.now()<deadline) await new Promise(resolve=>setTimeout(resolve,10));
        const search = root.querySelector('input[type=search]');
        check(rows().length === 6 && search && !search.parentElement.hidden, 'Cast credits waited for the fallback name lookup');
        search.value = 'Guide'; search.dispatchEvent(new Event('input'));
        check(rows().filter(row=>!row.closest('li').hidden).length === 1, 'Credit search waited for the name lookup');
        release.resolve();
        await opening;
        await screen.refresh();
        check(scans === 1 && text('h1') === actor, 'A personal redraw scanned every cached cast list again');
      } finally { release.resolve(); await opening; store.cachedCastMember = original; }
      await checkCachedCastWorkers();
    });

    await run('Cast pages distinguish offline retry, empty credits and refusal with or without a cached response', async () => {
      await service.saveKey('fictional-cast-screen-new');
      online = false;
      await cast();
      check(rows().length === 6 && text('h1') === actor, 'Offline cast screen lost cached shows.');
      await cast(312);
      check(root.textContent.includes('Cannot reach TMDB.') && text('button') === 'Try again', 'Uncached offline credits lacked retry.');
      online = true;
      root.querySelector('button').click();
      await pending;
      check(root.textContent.includes('No TV shows listed.') && !root.textContent.includes('Crew credit'), 'Successful retry lost the empty TV cast state.');
      refusePerson = true;
      await cast();
      check(root.textContent.includes('TMDB refused the key.') && rows().length === 6, 'A refused key hid previously cached credits.');
      await cast(313);
      check(root.textContent.includes('TMDB refused the key.') && text('button') === 'Settings' && !rows().length, 'Refused, uncached cast credits lost their Settings action.');
    });
  } finally {
    screen?.dispose();
    service?.close();
    store?.close();
    frame.remove();
  }
}
