import { connectFixtureProviders, replaceFixtureSettings } from './provider-fixture-cases.mjs';
import { mountStatisticsScreen } from '../dist/statistics-screen.js';
import { createStatisticsHistory } from '../dist/statistics-data.js';
import { renderChart } from '../dist/statistics-charts.js';
import { MdbListClient } from '../dist/mdblist-client.js';
import { MdbListService } from '../dist/mdblist-service.js';
import { openDeviceStore } from '../dist/storage.js';
import { tmdbResourceKey, TmdbClient } from '../dist/tmdb-client.js';
import { TmdbService } from '../dist/tmdb-service.js';

function check(condition, message) { if (!condition) throw Error(message); }
async function until(condition, message) {
  const end = performance.now() + 3000;
  while (!condition() && performance.now() < end) await new Promise(resolve => setTimeout(resolve,10));
  check(condition(),message);
}
const name = 'Night <em>Harbour</em>';
const watched = { show_id: 72, show: name, season: 1, episode: 1, episode_id: 7211, title: 'Outside', times_watched: 2 };
const series = { show_id: 72, show: name, firstAirDate: '1997-01-03', genres: [{ id: 3, name: 'Mystery' }],
  networks: [{ id: 1, name: 'Tide' }], originCountries: ['US'], voteAverage: 8.25, seasons: [{ season: 1, episodeCount: 1 }],
  lastAired: { season: 1, episode: 1 }, nextAirDate: null };

function equalSlots(card) {
  const slots = [...card.querySelectorAll('.stats-columns > div')];
  const widths = slots.map(slot => slot.getBoundingClientRect().width);
  return widths.every(width => width > 0 && Math.abs(width - widths[0]) < 1);
}

async function fixture(width, test, populated = true) {
  const dbName = 'statistics-screen-' + crypto.randomUUID();
  const store = await openDeviceStore({ name: dbName });
  const offline = { now: Date.now, online: () => false, visible: () => true };
  let calls = 0;
  const transport = { fetch() { calls++; throw Error('Unexpected provider call'); } };
  const service = new TmdbService(store, new TmdbClient(transport), offline);
  const critics = new MdbListService(store, new MdbListClient(transport), offline);
  const frame = document.createElement('iframe');
  frame.width = String(width);
  frame.height = '680';
  const loaded = new Promise(resolve => frame.addEventListener('load', resolve, { once: true }));
  frame.src = '/screen-fixture';
  document.body.append(frame);
  let screen;
  try {
    const snapshot = await connectFixtureProviders(store,dbName,populated ? [{setting:'tmdb_key',value:'fictional-stats-preview'}] : []);
    if (populated) {
      await store.commit(snapshot.revision, { put: { watched: [watched], ratings: [{ show_id: 72, show: name, rating: 0 }] } });
      const now = Date.now(), entries = {};
      function cache(resource, value) { entries[tmdbResourceKey(resource)] = { value, fetchedAt: now }; }
      cache({ kind: 'show', id: 72 }, series);
      cache({ kind: 'season', id: 72, season: 1 }, { show_id: 72, season: 1, episodes: [
        { episode: 1, episode_id: 7211, runtime: 45, airDate: '1997-01-03' },
      ] });
      cache({ kind: 'cast', id: 72 }, [{ id: 33, name: 'River Vale' }, { id: 33, name: 'River Vale' }]);
      cache({ kind: 'countries' }, [{ code: 'US', name: 'United States' }]);
      const { generation } = await store.tmdbState();
      await store.writeTmdb(generation, { entries });
      await service.removeKey(generation);
    }
    await loaded;
    const doc = frame.contentDocument, root = doc.querySelector('#app');
    const policy = doc.createElement('meta');
    policy.httpEquiv = 'Content-Security-Policy';
    policy.content = "style-src 'self'";
    doc.head.append(policy);
    const violations = [];
    doc.addEventListener('securitypolicyviolation', event => violations.push(event.violatedDirective));
    const ctx = { service, critics, run: action => action() };
    screen = mountStatisticsScreen(root, ctx);
    await screen.ready;
    if (populated) await until(() => root.querySelector('[data-chart="cast"]') &&
      root.querySelector('[data-stat="hours"] dd')?.textContent === '1.5', 'Optional fixture metadata did not appear');
    const card = id => root.querySelector('[data-chart="' + id + '"]');
    const toggle = id => root.querySelector('[data-table="' + id + '"]');
    const count = id => root.querySelector('[data-stat="' + id + '"] dd').textContent;
    await test({ root, doc, frame, screen, store, card, toggle, count, ctx, dbName });
    await new Promise(resolve => setTimeout(resolve, 0));
    check(!root.querySelector('[style]') && !violations.length, 'A Statistics chart uses an inline style blocked by the app policy');
    check(!calls, 'Statistics attempted a foreground provider request while offline');
  } finally {
    screen?.dispose(); frame.remove(); critics.close(); service.close(); store.close();
    const drop = indexedDB.deleteDatabase(dbName);
    await new Promise((resolve, reject) => { drop.onsuccess = resolve; drop.onerror = () => reject(drop.error); });
  }
}

export async function statisticsScreenCases(run) {
  await run('A writer updates only changed cast and country rows and recovers from an interrupted change chain',()=>
    fixture(390,async({store,dbName,doc,ctx})=>{
      await replaceFixtureSettings(store,dbName,[{setting:'tmdb_key',value:'fictional-stats-preview'}]);
      const lifetime=new AbortController(), target=doc.body.appendChild(doc.createElement('main'));
      const overview=store.overviewRows.bind(store), state=store.statisticsState.bind(store);
      let reads=0, skip=false, hold, view;
      const selections=[];
      store.overviewRows=(...args)=>{reads++;return overview(...args);};
      store.statisticsState=async(keys,...args)=>{
        if(keys) selections.push([...keys].sort());
        const observed=await state(keys,...args);
        if(keys && hold){const current=hold;hold=undefined;current.started.resolve();await current.release.promise;}
        return observed;
      };
      store.addEventListener('tmdbmetadata',event=>{if(skip){skip=false;event.stopImmediatePropagation();}},{signal:lifetime.signal});
      const history=createStatisticsHistory(ctx.service,lifetime.signal);
      const castKey=tmdbResourceKey({kind:'cast',id:72}), countryKey=tmdbResourceKey({kind:'countries'});
      const generation=(await store.tmdbState()).generation;
      const put=(key,value)=>store.writeTmdb(generation,{entries:{[key]:{fetchedAt:Date.now(),value}}});
      const cast=label=>put(castKey,[{id:33,name:label}]), country=label=>put(countryKey,[{code:'US',name:label}]);
      function open(){view=mountStatisticsScreen(target,ctx,history);return view.ready;}
      function leave(){view.dispose();view=undefined;target.replaceChildren(doc.createElement('p'));}
      async function shown(actor,region,plays='2',complete=true){
        await until(()=>target.querySelector('[data-chart=cast]')?.textContent.includes(actor) &&
          target.querySelector('[data-chart=countries]')?.textContent.includes(region) &&
          target.querySelector('[data-stat=plays] dd')?.textContent===plays &&
          (!complete || history.read(Date.now())?.scoresCurrent && !history.read(Date.now()).changedMetadata),
          'The corrected credits or watch count did not appear for '+actor);
      }
      try{
        await open();await shown('River Vale','United States');leave();const initial=reads;
        await cast('Harbour Pilot');await country('Fictional region');await cast('Harbour Keeper');
        await open();await shown('Harbour Keeper','Fictional region');leave();
        check(reads===initial && selections.at(-1)?.join()===[countryKey,castKey].sort().join(),'One changed cast and country fetched unrelated record rows');
        skip=true;await cast('Unannounced credit');await country('Second region');
        await open();await shown('Unannounced credit','Second region');leave();
        check(reads===initial+1,'A missed intermediate version validated an incomplete set of changes');
        await cast('Pending credit');
        const blocked={started:Promise.withResolvers(),release:Promise.withResolvers()};hold=blocked;
        const updating=open();
        try{
          await blocked.started.promise;
          await store.commit(await store.recordRevision(),{put:{watched:[{...watched,times_watched:3}]}});
          await cast('Current credit');
        }finally{blocked.release.resolve();}
        await updating;await shown('Current credit','Second region','3',false);
        await view.refresh();await shown('Current credit','Second region','3');
        check(reads>initial+1,'A watch change during the credit read kept the old personal projection');
      }finally{hold?.release.resolve();view?.dispose();lifetime.abort();target.remove();store.overviewRows=overview;store.statisticsState=state;}
    }));
  await run('An older writer or an unavailable lock query cannot validate a current Statistics cache',()=>
    fixture(390,async({store,dbName,doc,ctx})=>{
      const previous=await store.statisticsState();check(previous.metadataVersion&&previous.writerLease,'The first writer did not establish its revision');
      const old=doc.defaultView,target=doc.body.appendChild(doc.createElement('main')),lifetime=new AbortController();
      const held=Promise.withResolvers(),leave=Promise.withResolvers();let reader,view,service,observer,queued;
      await store.closeForUpdate();
      const legacy=old.navigator.locks.request('csvTV/writer/'+dbName,()=>{held.resolve();return leave.promise;});
      await held.promise;
      try{
        reader=await openDeviceStore({name:dbName});service=new TmdbService(reader,undefined,ctx.service.environment);
        const history=createStatisticsHistory(service,lifetime.signal),proof=await reader.statisticsState();
        check(!proof.checksCacheVersions&&!proof.writerLease&&proof.metadataVersion===previous.metadataVersion,'An old writer inherited the previous writer’s proof');
        async function show(hours){
          view=mountStatisticsScreen(target,{service,run:action=>action()},history);await view.ready;
          await until(()=>target.querySelector('[data-stat=hours] dd')?.textContent===hours,'The reader reused obsolete hours');
        }
        await show('1.5');view.dispose();view=undefined;target.replaceChildren(doc.createElement('p'));
        // Earlier writers change cached runtimes without changing the newer source marker.
        const db=await new Promise((ok,no)=>{const q=old.indexedDB.open(dbName);q.onsuccess=()=>ok(q.result);q.onerror=no;});
        try{await new Promise((ok,no)=>{
          const tx=db.transaction('tmdb','readwrite'),items=tx.objectStore('tmdb'),key=tmdbResourceKey({kind:'season',id:72,season:1}),read=items.get(key);
          read.onsuccess=()=>{const entry=read.result;entry.value.episodes.forEach(row=>row.runtime=90);items.put(entry,key);};
          tx.oncomplete=ok;tx.onabort=()=>no(tx.error);
        });}finally{db.close();}
        await show('3');view.dispose();view=undefined;
        leave.resolve();await legacy;await reader.whenWriter();await replaceFixtureSettings(reader,dbName,[{setting:'tmdb_key',value:'fictional-stats-preview'}]);
        observer=await openDeviceStore({name:dbName});const promoted=await observer.statisticsState();
        check(!!promoted.writerLease&&promoted.writerLease!==previous.writerLease&&promoted.checksCacheVersions,'A new grant did not supply a new, distinct writer lease');
        const locks=Object.getPrototypeOf(navigator.locks),native=locks.query;
        try{
          for(const disabled of [()=>Promise.reject(Error('Disabled lock query')),()=>new Promise(()=>{})]){
            locks.query=disabled;const uncertain=await observer.statisticsState();
            check(!uncertain.checksCacheVersions&&!uncertain.writerLease,'An unanswered query reused an unknown writer’s totals');
          }
        }finally{locks.query=native;}
        const messages=[],channel=new old.BroadcastChannel('csvTV/exports/'+dbName);channel.onmessage=e=>messages.push(e.data);
        const deadline=Date.now()+4000;
        async function stillPending(){return (await navigator.locks.query()).pending.some(lock=>lock.name==='csvTV/writer/'+dbName&&lock.clientId!==undefined);}
        try{
          const generation=(await reader.tmdbState()).generation;
          async function cast(id){return reader.writeTmdb(generation,{entries:{[tmdbResourceKey({kind:'cast',id})]:{value:[{id:99,name:'Coastal Performer'}],fetchedAt:Date.now()}}});}
          await cast(960);await until(()=>messages.includes('tmdbbrowse'),'The current reader missed the new credit');
          await new Promise(ok=>setTimeout(ok,140));check(!messages.includes('tmdbmetadata'),'An ordinary reader received broad cast invalidation');messages.length=0;
          await observer.closeForUpdate();observer=undefined;
          await new Promise(ok=>setTimeout(ok,20));queued=new old.AbortController();
          void old.navigator.locks.request('csvTV/writer/'+dbName,{signal:queued.signal},()=>{}).catch(()=>{});
          while(!await stillPending()){if(Date.now()>deadline)throw Error('The older reader never waited for this record');await new Promise(ok=>setTimeout(ok,5));}
          await cast(961);await until(()=>messages.includes('tmdbmetadata'),'An older Cast reader kept its previous credited name');
        }finally{channel.close();}
      }finally{queued?.abort();leave.resolve();view?.dispose();lifetime.abort();target.remove();service?.close();await observer?.closeForUpdate();await reader?.closeForUpdate();await legacy;}
    }));
  await run('A reader recovers missed public metadata and score notifications without rereading watches for a score change',()=>
    fixture(390,async({store,dbName,doc,ctx})=>{
      await replaceFixtureSettings(store,dbName,[{setting:'tmdb_key',value:'fictional-stats-preview'},
        {setting:'mdblist_key',value:'fictional-critic'}]);
      const generation=(await store.mdbListState()).generation;
      const setScore=tomatoes=>store.writeMdbList(generation,{entries:new Map([[72,{fetchedAt:Date.now(),
        scores:{tomatoes,metacritic:null,myanimelist:null}}]])});
      await setScore(25);
      const reader=await openDeviceStore({name:dbName}),lifetime=new AbortController();
      const service=new TmdbService(reader,undefined,ctx.service.environment);
      const critics=new MdbListService(reader,undefined,ctx.service.environment);
      for(const type of ['exportchange','tmdbmetadata','mdblistchange'])reader.addEventListener(type,e=>e.stopImmediatePropagation(),{signal:lifetime.signal});
      const history=createStatisticsHistory(service,lifetime.signal),target=doc.body.appendChild(doc.createElement('main'));
      let reads=0,view;
      const overview=reader.overviewRows.bind(reader);
      reader.overviewRows=(...args)=>{reads++;return overview(...args);};
      const score=()=>history.read(Date.now())?.scores?.critics?.get(72)?.tomatoes;
      const open=async(hours,tomatoes)=>{
        view=mountStatisticsScreen(target,{service,critics,run:action=>action()},history);
        await view.ready;
        await until(()=>target.querySelector('[data-stat=hours] dd')?.textContent===hours &&
          history.read(Date.now())?.scoresCurrent && score()===tomatoes,'Reader displayed a stale runtime or score');
      };
      const leave=()=>{view.dispose();view=undefined;target.replaceChildren(doc.createElement('p'));};
      try{
        await open('1.5',25);leave();const start=reads;
        const resource={kind:'season',id:72,season:1},metadata=(await service.read(resource)).value;
        const revised={...metadata,episodes:metadata.episodes.map(e=>({...e,runtime:90}))};
        await store.writeTmdb((await store.tmdbState()).generation,{entries:{[tmdbResourceKey(resource)]:{fetchedAt:Date.now(),value:revised}}});
        await open('3',25);check(reads===start+1,'A lost runtime change did not reload the watched report exactly once');leave();
        await setScore(75);await open('3',75);check(reads===start+1,'A lost score change reloaded all watches');leave();
        await setScore(75);await open('3',75);check(reads===start+1,'An unchanged source discarded its report');
        const prior=await reader.statisticsState();
        await store.clearRebuildableCaches();
        const after=await reader.statisticsState();
        check(prior.metadataVersion!==after.metadataVersion && prior.scoresVersion!==after.scoresVersion,'A cache clear retained a prior reader proof');
      } finally{view?.dispose();lifetime.abort();target.remove();critics.close();service.close();await reader.closeForUpdate();}
    }));
  await run('A returning reader checks the current revision before attaching totals and releases a slow or abandoned view',()=>
    fixture(390,async ({doc,store,dbName,ctx})=>{
      const reader=await openDeviceStore({name:dbName});
      const service=new TmdbService(reader,undefined,ctx.service.environment), lifetime=new AbortController();
      const target=doc.body.appendChild(doc.createElement('main'));
      // Delay the writer's advisory event. The reader still has the committed revision.
      reader.addEventListener('exportchange',event=>event.stopImmediatePropagation(),{signal:lifetime.signal});
      const history=createStatisticsHistory(service,lifetime.signal), state=reader.statisticsState.bind(reader);
      let view, release;
      function mount() { view=mountStatisticsScreen(target,{service,run:action=>action()},history); return view; }
      function depart() {
        view?.dispose(); view=undefined;
        const old=doc.createElement('button'); old.textContent='Fictional preceding page';
        target.replaceChildren(old);
        return old;
      }
      const plays=()=>target.querySelector('[data-stat=plays] dd')?.textContent;
      try {
        await mount().ready;
        await until(()=>history.read(Date.now())?.scoresCurrent,'The first reader report was not retained');
        let held=depart();
        reader.statisticsState=()=>new Promise(resolve=>{release=async()=>resolve(await state());});
        const changed=mount().ready;
        check(held.inert && !plays(),'A warm return exposed its placeholder or kept the old button interactive');
        held.focus(); check(doc.activeElement!==held,'The keyboard reached an outgoing button');
        await store.commit((await store.snapshot()).revision,{put:{watched:[{...watched,times_watched:5}]}});
        await release(); await changed;
        check(plays()==='5' && !held.isConnected && !held.inert,'The reader used a stale total or retained its outgoing control');
        await until(()=>{
          const entry=history.read(Date.now());
          return entry?.scoresCurrent && entry.input.shows[0].episodes[0].row.times_watched===5;
        },'The revised report was not retained');
        held=depart();
        const abandoned=mount().ready;
        check(held.inert,'The pending view kept an outgoing control active');
        const next=depart(); next.textContent='Fictional next destination';
        await release(); await abandoned;
        check(target.firstElementChild===next && !held.inert && !next.inert && !plays(),'A canceled return replaced the new destination');
        held=next;
        const slow=mount().ready;
        await until(()=>plays()==='–','A slow revision check held the old route indefinitely');
        check(!held.isConnected && !held.inert,'The slow route did not release the preceding control');
        await release(); await slow;
        check(plays()==='5','The slow revision check did not recover');
      } finally {
        await release?.(); view?.dispose(); lifetime.abort(); service.close(); await reader.closeForUpdate(); target.remove();
      }
    }));
  await run('A previously displayed critic or season-score comparison returns with the record while IMDb is pending, until invalidated', () =>
    fixture(390, async ({doc,store,ctx}) => {
      const target = doc.body.appendChild(doc.createElement('div'));
      const exists = id => !!target.querySelector('[data-chart="'+id+'"]');
      for (const change of [null,'mdblistchange','ratingscredentialschange','exportchange']) {
        const life = new AbortController();
        const history = createStatisticsHistory(ctx.service,life.signal);
        const firstImdb = Promise.withResolvers(), nextImdb = Promise.withResolvers(), nextScores = Promise.withResolvers();
        let returning = false;
        const sources = {...ctx,
          critics:{read:async () => {
            if (returning) await nextScores.promise;
            return new Map([[72,{tomatoes:80,metacritic:71,myanimelist:null}]]);
          }},
          mal:{read:async () => {
            if (returning) await nextScores.promise;
            return new Map([[72,[{season:1,offset:0,malId:28,score:8.5}]]]);
          }},
          imdb:{readShows:async () => {
            await (returning ? nextImdb : firstImdb).promise;
            return new Map([[72,7.5]]);
          }}};
        let view = mountStatisticsScreen(target,sources,history);
        try {
          await view.ready;
          await until(() => history.read(Date.now())?.input && exists('tomatoes') && exists('myanimelist'),'The initial comparisons did not appear');
          view.dispose(); target.replaceChildren();
          if (change) store.dispatchEvent(new Event(change));
          returning = true;
          view = mountStatisticsScreen(target,sources,history);
          await view.ready;
          check(exists('tomatoes')===!change && exists('myanimelist')===!change && !exists('imdb'),
            'Before the new reads finished, the wrong comparisons were visible after '+(change ?? 'an ordinary return'));
          firstImdb.resolve();
          await new Promise(resolve => setTimeout(resolve,20));
          check(!exists('imdb'),'A superseded IMDb lookup appeared on a later visit');
          nextScores.resolve(); nextImdb.resolve();
          await until(() => exists('imdb') && exists('tomatoes') && exists('myanimelist'),'Fresh comparisons did not replace the partial report');
        } finally {
          firstImdb.resolve(); nextImdb.resolve(); nextScores.resolve();
          view.dispose(); life.abort(); target.replaceChildren();
        }
      }
      target.remove();
    }));

  await run('Reader tabs follow the saved Statistics group and erase, and a failed group change restores the prior report', () =>
    fixture(320, async ({ root, store, ctx, dbName, count }) => {
      const reader = await openDeviceStore({ name: dbName });
      const readerService = new TmdbService(reader);
      const other = document.createElement('div');
      document.body.append(other);
      let readImdb = async () => new Map([[72,8.1]]);
      const screen = mountStatisticsScreen(other, { service: readerService, imdb:{readShows:() => readImdb()}, run: action => action() });
      const selected = (within, value) => within.querySelector('.stats-scope input:checked')?.value === value;
      async function wait(condition) {
        const end = performance.now() + 3000;
        while (!condition() && performance.now() < end) await new Promise(resolve => setTimeout(resolve, 10));
        check(condition(), 'Statistics group did not follow the committed choice');
      }
      try {
        await screen.ready;
        check(selected(root, 'all') && selected(other, 'all') &&
          [...other.querySelectorAll('.stats-scope input')].every(radio => radio.disabled), 'Reader controls or defaults are wrong');
        const chart = () => other.querySelector('[data-chart="imdb"]');
        await until(chart, 'Reader did not display the confirmed comparison');
        const held = Promise.withResolvers(), started = Promise.withResolvers();
        readImdb = () => { started.resolve(); return held.promise; };
        const pendingRead = screen.refresh();
        await started.promise;
        try {
          check(chart(), 'An ordinary reader refresh withdrew the confirmed comparison');
          await store.commit((await store.snapshot()).revision, {put:{settings:[{setting:'imdb_source',value:'omdb'}]}});
          await until(() => !chart(), 'A source change in the writer left disabled scores visible in the reader');
          held.resolve(new Map([[72,9]]));
          await pendingRead;
          check(!chart(), 'A late reply restored the previous source in the reader');
        } finally { held.resolve(new Map()); }
        root.querySelector('.stats-scope input[value=anime]').click();
        await wait(() => selected(other, 'anime') && count('shows') === '0');
        check(other.querySelector('.stats-empty').textContent === 'No watched anime.', 'Reader still displays the TV show');
        let failure;
        ctx.run = async action => { try { await action(); } catch (error) { failure = error; } };
        const save = store.selectStatisticsScope;
        store.selectStatisticsScope = async () => { throw new DOMException('Fictional full disk', 'QuotaExceededError'); };
        try {
          root.querySelector('.stats-scope input[value=tv]').click();
          await wait(() => failure?.name === 'QuotaExceededError' && selected(root, 'anime') && count('shows') === '0');
          check(selected(other, 'anime'), 'Reader saw a failed save');
        } finally { store.selectStatisticsScope = save; }
        await store.eraseDevice((await store.snapshot()).revision);
        await wait(() => selected(root, 'all') && selected(other, 'all'));
        check((await store.devicePreference('statisticsScope')).preference === undefined, 'Erase retained the group');
      } finally { screen.dispose(); readerService.close(); reader.close(); other.remove(); }
    }));

  await run('Statistics fits the compact summary, ranked shows and scrollable charts at 320px', () =>
    fixture(320, async ({ root, doc, frame, count, card }) => {
      check(['shows','seasons','episodes','plays','hours'].map(count).join() === '1,1,1,2,1.5', 'Watch totals or runtime weighting is wrong');
      const hours = root.querySelector('[data-stat="hours"]');
      check(hours.textContent === 'Hours1.5' && frame.contentWindow.getComputedStyle(hours.querySelector('dd')).fontSize ===
        frame.contentWindow.getComputedStyle(root.querySelector('[data-stat="plays"] dd')).fontSize, 'Hours should show a single full-size total');
      const ids = [...root.querySelectorAll('[data-chart]')].map(el => el.dataset.chart);
      check(ids.join() === 'plays-by-show,hours-by-show,rewatches,rewatched-shows,ratings,decades,progress,genres,networks,countries,cast,tmdb', 'Charts are missing or out of order: ' + ids);
      check(!root.querySelector('.statistics-screen > header').textContent.includes('All time') &&
        card('rewatches').parentElement === card('rewatched-shows').parentElement &&
        card('rewatches').parentElement.classList.contains('stats-rewatch-stack') &&
        card('plays-by-show').textContent.includes('Top 10') && card('hours-by-show').textContent.includes('Top 10'), 'Summary or chart labels are outdated');
      check(card('rewatches').querySelector('progress').position === 0.5 && card('rewatches').textContent.includes('1 first watch · 1 rewatch'),
        'Rewatch meter or its supporting counts are wrong');
      const bar = card('plays-by-show').querySelector('rect');
      check(bar.getBoundingClientRect().width > 0 && frame.contentWindow.getComputedStyle(bar).fill === 'rgb(214, 48, 60)', 'Accent bars failed to draw under CSP');
      check(card('plays-by-show').textContent.includes(name) && !root.querySelector('em'), 'A saved title became markup');
      const bins = card('ratings').querySelectorAll('.stats-columns > div');
      check(bins.length === 21 && bins[0].title === '0 · 1 show' && bins[0].querySelector('rect') && !bins[1].querySelector('rect'), 'Zero score or half-step slots missing');
      check(equalSlots(card('ratings')) && equalSlots(card('progress')), 'Phone column widths distorted the scale');
      const ratingPlot = card('ratings').querySelector('.stats-rating-histogram');
      check(ratingPlot.scrollWidth <= ratingPlot.clientWidth + 1, 'A small histogram hid the end of the 0–10 scale');
      const dot = card('tmdb').querySelector('.stats-dots path');
      const point = dot.getPointAtLength(0);
      check(dot.isPointInStroke(point) && frame.contentWindow.getComputedStyle(dot).strokeWidth === '6px' &&
        point.x === 0 && Math.abs(point.y - 17.5) < 0.001,
        'TMDB comparison misplaced the point on its 0–10 axes');
      check(card('tmdb').querySelector('.stats-dots line')?.getAttribute('y2') === '0', 'The equal-score guide missed the top of the 0–10 scale');
      check(doc.documentElement.scrollWidth <= 320, 'Phone Statistics overflows the viewport');
      const chart = {id:'decades',title:'Shows by decade',kind:'column',unit:'shows',
        rows:Array.from({length:32},(_,i) => ({label:(1800 + i*10) + 's',value:i+1}))};
      const view = renderChart(doc,chart);
      root.querySelector('.stats-charts').append(view.card);
      const scroll = view.card.querySelector('.stats-column-scroll');
      scroll.scrollLeft = 100; scroll.focus({preventScroll:true});
      const offset = scroll.scrollLeft;
      view.update({...chart,rows:chart.rows.map(row => ({...row,value:row.value+1}))});
      check(offset > 0 && Math.abs(scroll.scrollLeft-offset) < 1 && scroll === doc.activeElement &&
        scroll.querySelector('b')?.textContent === '2','Column refresh lost scroll, focus or new chart values');
      const credits = renderChart(doc,{id:'tomatoes',title:'My rating against Rotten Tomatoes',kind:'dots',unit:'tomatoes',
        rows:[{label:'Unbroken'.repeat(50),rating:8,value:92},{label:'Amber Coast',rating:8,value:80}]});
      root.querySelector('.stats-comparisons').append(credits.card);
      const reference = credits.card.querySelector('.stats-dots line');
      check(reference && ['x1','y1','x2','y2'].map(key=>reference.getAttribute(key)).join(',') === '0,100,100,0' &&
        credits.card.querySelector('header p').textContent === 'At 8/10, the line marks 80% approval',
        'The Rotten Tomatoes chart must explain how a personal rating lines up with critic approval');
      check(credits.card.querySelector('.stats-dots path').getAttribute('d') === 'M80 8h0M80 20h0',
        'At 8/10 the 80% dot should sit on the line and 92% should sit above it');
      const caption = doc.createRange();
      caption.selectNodeContents(credits.card.querySelector('header p'));
      for (const width of [320,390,820,1440]) {
        frame.width = String(width);
        const lines = caption.getClientRects();
        const button = credits.card.querySelector('[data-table]').getBoundingClientRect();
        check(lines.length === 1 && lines[0].width > 0 && lines[0].right <= button.left &&
          doc.documentElement.scrollWidth <= width, 'The Rotten Tomatoes caption must fit on one line at ' + width + 'px');
      }
      frame.width = '320';
      credits.card.querySelector('[data-table]').click();
      const areas = [...credits.card.querySelectorAll('thead th')].map(cell => {
        const text = doc.createRange(); text.selectNodeContents(cell.querySelector('button').firstChild); return text.getClientRects().length;
      });
      check(areas.every(lines => lines === 1) && doc.documentElement.scrollWidth <= 320,
        'A long show title wrapped a short column heading or overflowed the page');
    }));

  await run('Every chart switches to its named table and back, with ordered rows, units and exact score pairs', () =>
    fixture(1080, async ({ root, card, toggle, doc, frame, store, screen }) => {
      const cards = [...root.querySelectorAll('[data-chart]')];
      check(equalSlots(card('ratings')) && equalSlots(card('progress')), 'Desktop histogram scale changed with bucket content');
      const buckets = Array.from({length:21},(_,i) => ({label:String(i/2),value:i === 16 ? 1234 : i+3}));
      const distribution = renderChart(doc,{id:'ratings',title:'My ratings',kind:'column',unit:'shows',rows:buckets});
      root.append(distribution.card);
      const histogram = distribution.card.querySelector('.stats-rating-histogram');
      for (const width of [230,280,320,500]) {
        frame.width = String(width);
        check(histogram.clientWidth > 0 && histogram.scrollWidth <= histogram.clientWidth+1 && equalSlots(distribution.card),
          'The 21 bins did not fit a '+width+'px tile containing a four-digit show count');
        check(histogram.querySelector('.stats-count-scale').firstChild.textContent === (1234).toLocaleString(),
          'The count scale omitted a large bucket');
      }
      frame.width = '1080';
      distribution.card.remove();
      const summary = [...root.querySelectorAll('.stats-summary [data-stat], .stats-summary [data-chart]')];
      check(summary.length === 5 && summary.at(-1).dataset.stat === 'hours' &&
        summary.every(tile => tile.offsetTop === summary[0].offsetTop), 'A wide summary should fit all five totals on one row');
      const hours = card('hours-by-show').getBoundingClientRect();
      check(Math.abs(card('rewatches').getBoundingClientRect().top - hours.top) < 1.5 &&
        Math.abs(card('rewatched-shows').getBoundingClientRect().bottom - hours.bottom) < 1.5,
        'The rewatch cards failed to fill the height of a one-show ranking');
      const captured = new Map();
      for (const section of cards) {
        const button = toggle(section.dataset.chart);
        check(button.getAttribute('aria-label').includes(section.querySelector('h2').textContent), 'Table switch lacks its chart name');
        button.focus(); button.click();
        const table = section.querySelector('table');
        check(table?.caption.textContent === section.querySelector('h2').textContent &&
          table.querySelectorAll('thead th[scope=col]').length >= 2 && table.querySelector('tbody th[scope=row]'), 'Table lacks labeled rows or column headers');
        const close = section.querySelector('dialog[open] .stats-table-heading button');
        check(doc.activeElement === close && button.getAttribute('aria-haspopup') === 'dialog', 'Table did not receive focus');
        captured.set(section.dataset.chart,[...table.tBodies[0].rows].map(row => [...row.cells].map(c => c.textContent).join('|')));
        close.click();
        check(doc.activeElement === button,'Close did not restore focus');
      }
      const rows = id => captured.get(id);
      check(rows('rewatches').join() === 'First watches|1|50%,Rewatches|1|50%' && rows('hours-by-show')[0] === name + '|1.5', 'Meter table or hour units disagree with chart');
      check(rows('ratings').length === 21 && rows('ratings')[0] === '0|1' && rows('ratings')[20] === '10|0', 'Table lost a half-step bucket');
      check(rows('tmdb')[0] === name + '|0|8.25' && rows('countries')[0] === 'United States|1' && rows('cast')[0] === 'River Vale|1',
        'Score table or cached identity labels are wrong');
      check(!root.querySelector('table') && card('tmdb').querySelector('.stats-dots path') && card('rewatches').querySelector('progress'), 'A table failed to return to its chart');
      await store.commit((await store.snapshot()).revision, { put: { watched: [{ ...watched, times_watched: 8 }] } });
      await screen.refresh();
      check(card('rewatches').querySelector('strong').textContent === (87.5).toLocaleString() + '%', 'The meter rounded away an exact half percentage');
      toggle('rewatches').click();
      const shares = [...card('rewatches').querySelectorAll('tbody td:last-child')].map(cell => cell.textContent);
      check(shares.join() === [12.5, 87.5].map(share => share.toLocaleString() + '%').join(), 'Complementary shares no longer sum to 100%');
    }));

  await run('Full rankings, rewatch cards and comparison charts align across desktop, narrow desktop and phone', () =>
    fixture(1600, async ({ root, doc, frame, screen, store, ctx, card, toggle, dbName }) => {
      const count = 24;
      const watchedRows = [], ratings = [], entries = {};
      const fetchedAt = Date.now();
      const cache = (resource, value) => { entries[tmdbResourceKey(resource)] = { value, fetchedAt }; };
      for (let i = 0; i < count; i++) {
        const id = 100 + i, show = 'Evening Train ' + (i + 1), episodeId = 1000 + i;
        watchedRows.push({ ...watched, show_id: id, show, episode_id: episodeId, times_watched: i + 2 });
        ratings.push({ show_id: id, show, rating: i % 10 });
        cache({ kind: 'show', id }, { ...series, show_id: id, show });
        cache({ kind: 'season', id, season: 1 }, { show_id: id, season: 1, episodes: [
          { episode: 1, episode_id: episodeId, runtime: 25, airDate: '1997-01-03' },
        ] });
        if (i < count - 1) cache({ kind: 'cast', id }, [{ id: 900 + i, name: 'Performer ' + (i + 1) }]);
      }
      const scores = ids => new Map(ids.map(id => [id, { tomatoes: 75, metacritic: 80, myanimelist: 7.5 }]));
      ctx.critics = { read: async ids => scores(ids) };
      ctx.imdb = { readShows: async ids => new Map(ids.map(id => [id, 8.5])) };
      await replaceFixtureSettings(store, dbName, [{ setting: 'tmdb_key', value: 'fictional-layout-key' }]);
      await store.commit((await store.snapshot()).revision, { replace: { watched: watchedRows, ratings } });
      check(await store.writeTmdb((await store.tmdbState()).generation, { entries }), 'Fictional chart metadata was not cached');
      await screen.refresh();
      check(root.querySelector('.stats-omissions').textContent === '', 'Missing credits should leave the available cast chart visible without a warning');

      doc.body.classList.add('app-frame');
      const sidebar = doc.createElement('aside');
      sidebar.className = 'app-sidebar';
      root.before(sidebar);
      root.classList.add('app-column');
      const bounds = id => card(id).getBoundingClientRect();
      const close = (a, b) => Math.abs(a - b) <= 1.5;
      const comparisons = [...root.querySelectorAll('.stats-comparisons [data-chart]')];
      const comparisonIds = comparisons.map(node => node.dataset.chart).join();
      check(comparisonIds === 'cast,tmdb,tomatoes,metacritic,imdb,myanimelist',
        'Expected cast and five comparisons in the same group, found ' + comparisonIds);
      check(['plays-by-show', 'hours-by-show', 'rewatched-shows', 'cast'].map(id =>
        card(id).querySelectorAll('.stats-bars > div').length).join() === '10,10,5,8',
        'The populated fixture must exercise the full height of every ranking');
      for (const [width, columns] of [[1600, 3], [1040, 2], [844, 1], [390, 1], [320, 1]]) {
        frame.width = String(width);
        await until(() => frame.contentWindow.innerWidth === width, 'The frame did not change width');
        const plays = bounds('plays-by-show'), hours = bounds('hours-by-show');
        const meter = bounds('rewatches'), ranking = bounds('rewatched-shows');
        const totals = [...root.querySelectorAll('.stats-totals > div')].map(tile=>tile.getBoundingClientRect());
        const gap = totals[1].left - totals[0].right;
        check(gap > 0 && close(gap, plays.top - Math.max(...totals.map(tile=>tile.bottom))),
          width + 'px: totals and the first ranking must have equal gutters');
        if (columns > 1) {
          const tableButton = toggle('rewatches');
          tableButton.focus({preventScroll:true});
          check(doc.activeElement === tableButton && tableButton.getBoundingClientRect().width >= 44,
            width + 'px: desktop Rewatches must retain its focusable table button');
          check(close(gap, ranking.top - meter.bottom) && close(meter.left, ranking.left) && close(meter.right, ranking.right),
            width + 'px: the meter must sit above the rewatched shows with a consistent gutter');
          check(hours.right < meter.left && close(hours.top, meter.top) && close(hours.bottom, ranking.bottom),
            width + 'px: the top and bottom of the rewatch pair should align with Hours');
          if (columns === 3) check(plays.right < hours.left && close(plays.top, hours.top) && close(plays.bottom, hours.bottom),
            'The two Top 10 lists should occupy adjacent columns of the same height');
          else check(plays.bottom < hours.top && close(plays.left, hours.left) && close(plays.right, meter.right),
            'A two-column report should place Plays across the row above Hours and Rewatches');
        } else {
          const tableButton = toggle('rewatches');
          const nextTable = toggle('plays-by-show');
          nextTable.focus({preventScroll:true});
          tableButton.focus({preventScroll:true});
          check(!tableButton.getClientRects().length && doc.activeElement === nextTable,
            width + 'px: the mobile Rewatches table must have no visible button or keyboard stop');
        }
        if (width <= 390) {
          const playsTile = totals[3], hoursTile = totals[4];
          check(close(meter.left, playsTile.left) && close(meter.right, playsTile.right) && close(meter.top - playsTile.bottom, gap) &&
            close(meter.top, hoursTile.top) && close(meter.bottom, hoursTile.bottom) && close(meter.left - hoursTile.right, gap),
            width + 'px: Rewatches must fill the summary cell beside Hours and below Plays');
          check(close(plays.top - meter.bottom, gap) && close(hours.top - plays.bottom, gap) && close(ranking.top - hours.bottom, gap),
            width + 'px: phone rankings must follow the complete summary without an empty row');
          check(/^Rewatches\s+[\d.,]+%$/.test(card('rewatches').innerText.trim()),
            width + 'px: the compact Rewatches tile must show just its title and percentage');
          const percent = card('rewatches').querySelector('.stats-rewatch strong').getBoundingClientRect();
          check(close(playsTile.height, meter.height) && percent.height > 0 && percent.bottom < meter.bottom,
            width + 'px: the percentage should fit inside a standard-height totals tile');
        }
        const first = comparisons[0].getBoundingClientRect();
        check(comparisons.every(node => close(node.getBoundingClientRect().height, first.height) &&
          node.scrollHeight <= node.clientHeight + 1), width + 'px: default comparison tiles must have equal heights without clipping');
        check(comparisons[columns].getBoundingClientRect().top > first.bottom, width + 'px: later comparison rows were not exercised');
        check(doc.documentElement.scrollWidth <= width, width + 'px: Statistics overflowed the viewport');
        toggle('imdb').click();
        const table = card('imdb').querySelector('table');
        const dialog = table.closest('dialog'), box = dialog.getBoundingClientRect();
        const scroller = table.parentElement, th = table.tHead.rows[0].cells[1];
        check(table.tBodies[0].rows.length === count && close(bounds('imdb').height,first.height) &&
          box.left >= 0 && box.right <= width + 1 && box.bottom <= frame.contentWindow.innerHeight+1,
          width + 'px: dialog overflow or chart geometry changed');
        const viewport = doc.documentElement;
        check(Math.abs((box.left+box.right)/2-viewport.clientWidth/2) < 2 && Math.abs((box.top+box.bottom)/2-viewport.clientHeight/2) < 2,
          width + 'px: table floated off center ' + JSON.stringify([box.toJSON(),viewport.clientWidth,viewport.clientHeight]));
        th.querySelector('button').click();
        check(th.getAttribute('aria-sort') === 'descending' && table.tBodies[0].rows[0].cells[1].textContent === '9', 'Descending personal scores');
        th.querySelector('button').click();
        check(th.getAttribute('aria-sort') === 'ascending' && table.tBodies[0].rows[0].cells[1].textContent === '0', 'Ascending personal scores lost zero');
        const headerTop=th.getBoundingClientRect().top;
        scroller.scrollTop = 200;
        check(scroller.scrollTop > 0 && close(th.getBoundingClientRect().top,headerTop), 'Scrolling moved the sticky table headers');
        dialog.querySelector('.stats-table-heading button').click();
        check(close(bounds('imdb').height, first.height), width + 'px: returning to the chart did not restore its height');
      }
      for (const [id,expected] of [['plays-by-show',count],['hours-by-show',count],['rewatched-shows',count],['cast',count-1]]) {
        toggle(id).click();
        const dialog = card(id).querySelector('dialog[open]'), table = dialog.querySelector('table');
        const search = dialog.querySelector('input[type=search]');
        check(search.getBoundingClientRect().height >= 44, 'The table filter needs a full-height touch target');
        check(table.tBodies[0].rows.length === expected, id + ': full table stopped at the chart limit');
        const filter = value => { search.value = value; search.dispatchEvent(new Event('input')); };
        const label = id === 'cast' ? 'Performer 9' : 'Evening Train 3';
        const original = [...table.tBodies[0].rows].find(row => row.cells[0].textContent === label);
        filter(id === 'cast' ? 'perFORMER 9' : 'TRAIN 3');
        const cells = () => [...table.tBodies[0].rows].map(row => [...row.cells].map(cell => cell.textContent));
        check(cells().length === 1 && cells()[0][0] === label, id + ': search missed a lower-ranked name');
        check(table.tBodies[0].rows[0] === original, id + ': filtering rebuilt an unchanged row');
        if (id === 'plays-by-show') {
          const byPlays = table.tHead.rows[0].cells[1];
          byPlays.querySelector('button').click();
          await store.commit((await store.snapshot()).revision, {put:{watched:[{...watchedRows[2],times_watched:5}]}});
          await screen.refresh();
          check(search.value === 'TRAIN 3' && byPlays.getAttribute('aria-sort') === 'descending' &&
            cells().length === 1 && cells()[0][1] === '5', 'An edit below the chart limit left the open table stale');
          filter('');
          byPlays.querySelector('button').click();
          check(cells().length === count && cells()[0][1] === '2', 'Full table sorting hid the least played show');
        }
        filter('unmatched fictional title');
        check(table.tBodies[0].textContent === 'No matches', 'Empty table search needs a result message');
        dialog.querySelector('.stats-table-heading button').click();
      }
    }, false));

  await run('Statistics keeps table choice and focus across a watch edit and explains missing chart inputs after cache removal', () =>
    fixture(390, async ({ doc, root, store, screen, card, toggle, count, ctx }) => {
      const key = 'plays-by-show';
      toggle(key).focus(); toggle(key).click();
      const unavailable = async () => { throw new DOMException('Fictional ratings cache failure','UnknownError'); };
      ctx.imdb = {readShows:unavailable};
      ctx.mal = {read:unavailable};
      ctx.critics = {read:unavailable};
      await store.commit((await store.snapshot()).revision, { put: { watched: [{ ...watched, times_watched: 3 }] } });
      await screen.refresh();
      check(card(key).querySelector('td')?.textContent === '3' && doc.activeElement.closest('dialog[open]') && count('hours') === '2.25',
        'A watch edit closed the table, lost focus or left the previous figures');
      card(key).querySelector('.stats-table-heading button').click();
      const late = Promise.withResolvers();
      try {
        ctx.imdb.readShows = () => late.promise;
        ctx.critics.read = async () => new Map([[72,{tomatoes:90,metacritic:null,myanimelist:null}]]);
        const updating = screen.refresh();
        await until(() => card('tomatoes'), 'An independent score never appeared');
        check(card('tomatoes') && !card('imdb') && count('plays') === '3',
          'A suspended ratings cache held up the personal totals or an independent chart');
        late.resolve(new Map([[72,8.2]]));
        await updating;
        check(card('imdb'), 'A late IMDb score failed to draw its chart');
      } finally { late.resolve(new Map()); }
      const stableToggle = toggle('imdb');
      stableToggle.focus();
      const suspended = Promise.withResolvers(), requested = Promise.withResolvers();
      ctx.imdb.readShows = () => { requested.resolve(); return suspended.promise; };
      const warm = screen.refresh();
      await requested.promise;
      try {
        check(toggle('imdb') === stableToggle && doc.activeElement === stableToggle,
          'A warm refresh detached the active comparison button before its read finished');
        stableToggle.click();
        suspended.resolve(new Map([[72,8.4]]));
        await warm;
        check(toggle('imdb') === stableToggle && doc.activeElement.closest('dialog[open]') &&
          card('imdb').querySelector('tbody td:last-child').textContent === '8.4',
          'An updated score replaced the focused button or lost the selected table');
      } finally { suspended.resolve(new Map()); }
      const obsolete = Promise.withResolvers(), reading = Promise.withResolvers();
      ctx.imdb.readShows = () => { reading.resolve(); return obsolete.promise; };
      const changedSource = screen.refresh();
      await reading.promise;
      try {
        store.dispatchEvent(new Event('imdbconfigchange'));
        check(!card('imdb'), 'Disabling a score source left its previous comparison visible');
        obsolete.resolve(new Map([[72,7]]));
        await changedSource;
        check(!card('imdb'), 'An old score reply restored a disabled comparison');
      } finally { obsolete.resolve(new Map()); }
      const readRows = store.overviewRows.bind(store);
      let entered, release;
      const started = new Promise(resolve => { entered = resolve; });
      const gate = new Promise(resolve => { release = resolve; });
      const followupStarted = Promise.withResolvers(), finishFollowup = Promise.withResolvers();
      let reads = 0;
      store.overviewRows = async () => {
        const first = ++reads === 1;
        const rows = await readRows();
        if (first) { entered(); await gate; }
        else { followupStarted.resolve(); await finishFollowup.promise; }
        return rows;
      };
      try {
        await store.commit((await store.snapshot()).revision, { put: { watched: [{ ...watched, times_watched: 4 }] } });
        const initial = screen.refresh();
        await started;
        await store.commit((await store.snapshot()).revision, { put: { watched: [{ ...watched, times_watched: 5 }] } });
        const updates = Array.from({ length: 20 }, () => screen.refresh());
        check(reads === 1, 'Concurrent notifications started overlapping full record reads');
        release();
        await followupStarted.promise;
        check(count('plays') === '4', 'Pending cache updates starved the completed report while the next one was loading');
        finishFollowup.resolve();
        await Promise.all([initial, ...updates]);
        check(reads === 2 && count('plays') === '5', 'The coalesced follow-up missed the newest record');
      } finally { release(); finishFollowup.resolve(); store.overviewRows = readRows; }
      const histogram = card('progress').querySelector('.stats-column-scroll');
      histogram.focus();
      check(doc.activeElement === histogram, 'The progress histogram did not receive keyboard focus');
      await store.clearRebuildableCaches();
      await screen.refresh();
      check(!card('cast') && !card('tmdb') && !card('progress') && card('ratings') && count('plays') === '5',
        'Metadata cleanup affected file-only figures or kept unavailable charts');
      check(root.querySelector('.stats-omissions').textContent.includes('omit 1 show') && doc.activeElement.matches('[data-table]'),
        'The report did not recover keyboard focus when its focused histogram disappeared');
      const oldScores = Promise.withResolvers(), readingScores = Promise.withResolvers();
      ctx.imdb.readShows = () => { readingScores.resolve(); return oldScores.promise; };
      const previous = screen.refresh();
      await readingScores.promise;
      try {
        store.overviewRows = async () => { throw new DOMException('Fictional record read failure', 'UnknownError'); };
        await screen.refresh();
        oldScores.resolve(new Map([[72,9]]));
        await previous;
        check(root.querySelector('.stats-empty').textContent.includes('Could not read') && count('plays') === '–' &&
          !root.querySelector('[data-chart]'), 'Old totals or late score replies hid the personal-record read failure');
        store.overviewRows = readRows;
        const retry = root.querySelector('.stats-empty + button');
        retry.focus(); retry.click();
        await until(() => count('plays') === '5' && retry.hidden, 'Retry did not restore the saved statistics');
      } finally { oldScores.resolve(new Map()); store.overviewRows = readRows; }
    }));

  await run('An empty watched record shows five zero totals and one empty state while rated-only and listed-only shows contribute nothing', () =>
    fixture(320, async ({ store, screen, root, count }) => {
      await store.commit((await store.snapshot()).revision, { put: { ratings: [{ show_id: 15, show: 'Quiet Signal', rating: 8 }],
        lists: [{ show_id: 16, show: 'Dawn Shift', list: 'Watchlist' }] } });
      await screen.refresh();
      check(['shows','seasons','episodes','plays','hours'].every(id => count(id) === '0') && !root.querySelector('[data-chart]'),
        'An unwatched show produced a chart or a nonzero total');
      check(root.querySelector('.stats-empty').textContent.includes('mark an episode') && !root.querySelector('.stats-omissions').textContent,
        'The empty state failed to explain how the record is populated');
    }, false));

  await run('Critic dots and tables use independent 0–100 scales, fill from cache offline, and disappear when the key is removed', () =>
    fixture(320, async ({ doc, root, store, screen, card, toggle, ctx }) => {
      check(!card('tomatoes') && !card('metacritic') && card('tmdb'), 'Missing critic scores changed the existing charts');
      await store.commit((await store.snapshot()).revision, {put:{settings:[{setting:'mdblist_key',value:'fictional-critic-key'}]}});
      await store.commit((await store.snapshot()).revision, { put: { ratings: [
        { show_id: 72, show: name, rating: 6.5 }, { show_id: 73, show: 'Unwatched', rating: 10 },
      ] } });
      const { generation } = await store.mdbListState();
      async function cache(tomatoes, metacritic) {
        const scores = { tomatoes, metacritic, myanimelist: null };
        await store.writeMdbList(generation, { entries: new Map([[72, { fetchedAt: Date.now(), scores }]]) });
      }
      await cache(null, 0);
      await screen.refresh();
      check(!card('tomatoes') && card('metacritic'), 'Missing Rotten Tomatoes score hid a real zero on Metacritic');
      await cache(59, 0);
      await screen.refresh();
      const ids = [...root.querySelectorAll('[data-chart]')].map(el => el.dataset.chart);
      check(ids.slice(-3).join() === 'tmdb,tomatoes,metacritic', 'Score charts arrived in the wrong order');
      for (const [id, label, value, ticks] of [
        ['tomatoes', 'Rotten Tomatoes', '59%', '100%,50%,0%'], ['metacritic', 'Metacritic', '0', '100,50,0'],
      ]) {
        const chart = card(id);
        const point = chart.querySelector('.stats-dots path').getPointAtLength(0);
        const readTicks = selector => [...chart.querySelectorAll(selector + ' span')].map(t => t.textContent).join();
        check(readTicks('.stats-y-ticks') === ticks && readTicks('.stats-x-ticks') === '0,5,10', 'Incorrect score axes');
        check(point.x === 65 && Math.abs(point.y - (100 - parseFloat(value))) < 0.001, 'Score dot used the wrong scale');
        check(chart.querySelector('.stats-dots line')?.getAttribute('y2') === '0',
          'Critic comparison used the wrong reference line');
        check(chart.querySelector('.stats-dots > span').textContent === (id === 'tomatoes' ? 'Critic approval' : label), 'Vertical axis has the wrong label');
        toggle(id).focus();
        toggle(id).click();
        const table = chart.querySelector('table');
        check([...table.tHead.rows[0].cells].map(c => c.textContent).join() === 'Show,My rating,' + label, 'Wrong score table headings');
        check([...table.tBodies[0].rows[0].cells].map(c => c.textContent).join('|') === [name, '6.5', value].join('|'), 'Wrong score pair or units');
        check(!table.querySelector('em') && doc.activeElement.closest('dialog[open]'), 'Unsafe title rendering or lost focus');
        if (id === 'tomatoes') chart.querySelector('.stats-table-heading button').click();
      }
      await cache(60, 40);
      await screen.refresh();
      check(card('metacritic').querySelector('td:last-child').textContent === '40' && doc.activeElement.closest('dialog[open]'),
        'A cache refresh lost table mode or focus');
      check(doc.documentElement.scrollWidth <= 320, 'Critic chart table overflows the phone');
      await store.commit((await store.snapshot()).revision, { remove: { settings: ['mdblist_key'] } });
      await screen.refresh();
      check(!card('tomatoes') && !card('metacritic') && card('tmdb') && root.contains(doc.activeElement), 'Removing scores lost focus or kept a critic chart');
      ctx.critics = {read:async () => new Map([[72, {myanimelist:8.5}]])};
      await screen.refresh();
      toggle('myanimelist').focus();
      toggle('myanimelist').click();
      const score = () => card('myanimelist').querySelector('td:last-child')?.textContent;
      check(score() === '8.5', 'MDBList score used the wrong precision');
      ctx.mal = {read:async () => new Map([[72, [{season:1,offset:0,malId:7201,score:8.5}]]])};
      await screen.refresh();
      check(score() === '8.50' && doc.activeElement.closest('dialog[open]'), 'An equal job score lost its precision or table focus');
      ctx.mal = undefined;
      await screen.refresh();
      check(score() === '8.5', 'Returning to MDBList retained job precision');
    }));
}
