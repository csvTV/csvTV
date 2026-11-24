import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createInterface} from 'node:readline/promises';
import {createRelease} from '../package-release.mjs';
import {connectFictionalDropbox,releaseWithDropbox} from './browser-dropbox-site.mjs';
import {linkFixture,offlineProviders} from './offline-providers.mjs';
import {listen,stop} from './offline-site.mjs';
import {seedRatedLibrary} from './populated-navigation-fixture.mjs';
import {measureLibrarySortToStatistics} from './library-sort-statistics-timing.mjs';
import {unpack} from './release-site.mjs';
import {readCsv} from '../dist/csv.js';

// Keep host automation and selector polling out of the measured interval. Require
// one frame after the visible state changes so the interval includes a paint.
async function painted({action,selector,value,ready,iteration,shows}) {
  const one = s => document.querySelector(s);
  const all = s => document.querySelectorAll(s);
  const field = one(selector);
  if (!field) throw Error('Missing control '+selector+' on '+location.hash);
  const chart = key => (one('[data-chart='+key+'] .stats-dots path')?.getAttribute('d')?.split('M').length ?? 1)-1;
  const start = performance.now();
  if (action === 'select' || action === 'input') {
    field.focus({preventScroll:true});
    field.value = value;
    field.dispatchEvent(new Event(action === 'select' ? 'change' : 'input',{bubbles:true}));
  } else if (action === 'rail') {
    field.dispatchEvent(new WheelEvent('wheel',{deltaY:280,cancelable:true,bubbles:true}));
  } else field.click();
  const frame = () => new Promise(resolve=>requestAnimationFrame(resolve));
  do {
    await frame();
    let done;
    switch (ready) {
      case 'library': done = all('.library-grid li').length === shows; break;
      case 'anime': done = all('.library-grid li').length === Math.floor(shows/3); break;
      case 'sorted': {
        const first = one('.library-grid li .library-rating')?.textContent;
        done = first?.includes('10/10') && all('.library-grid li').length === shows; break;
      }
      case 'query': done = all('.library-grid li').length === 1 && one('.library-grid li')?.textContent.includes(value); break;
      case 'ratings': done = all('.rating-edit').length === shows; break;
      case 'edit': done = field.value === value && !field.disabled && one('.undo-bar:not([hidden])'); break;
      case 'statistics': {
        const anime = Math.floor(shows/3), n = value === 'anime' ? anime : value === 'tv' ? shows-anime : shows;
        done = one('[data-stat=shows] dd')?.textContent === String(n) &&
          chart('imdb') === n && chart('myanimelist') === n; break;
      }
      case 'watchlist': done = all('.watchlist-screen .watch-rows li').length >= Math.floor(shows/5); break;
      case 'lists': done = all('.list-shows li').length === Math.floor(shows/4); break;
      case 'home': done = !!one('.record-totals dd') && all('[data-home-watchlist] .poster-rail li').length >= 8; break;
      case 'rail': done = field.scrollLeft > 0; break;
      case 'export': done = !!one('.export-downloads a[download="summary.csv"][href]'); break;
      case 'settings': done = !!one('.appearance-options input:checked') && !!one('[data-cloud-reason]'); break;
    }
    if (done) { await frame(); return Math.round(performance.now()-start); }
  } while (performance.now()-start<90000);
  throw Error('Did not paint '+ready+' on '+location.hash+' in iteration '+iteration+': '+one('main')?.innerText.slice(0,210));
}

const require = createRequire(import.meta.url);
const engines = require(process.env.CSVTV_PLAYWRIGHT_MODULE || 'playwright-core');
const bytes = process.env.CSVTV_ROUTE_COMPARISON_ZIP ? await readFile(process.env.CSVTV_ROUTE_COMPARISON_ZIP)
  : (await createRelease(new URL('../dist/',import.meta.url))).bytes;
const assets = await unpack(bytes);
function buildId(files) {
  const build = files.get('index.html').toString().match(/name="csvtv-build" content="([a-f0-9]+)"/)?.[1];
  assert.ok(build,'The release must identify its build');
  return build;
}
const profiles = [
  {engine:'chromium',width:1440,height:900,touch:false},
  {engine:'webkit',width:820,height:1180,touch:true},
];
const repeats = Number(process.env.CSVTV_ROUTE_REPEATS || 5);
assert.ok(Number.isSafeInteger(repeats) && repeats>=1);
const shows = Number(process.env.CSVTV_ROUTE_SHOWS || 300);
assert.ok(Number.isSafeInteger(shows) && shows>=60);
for (const {engine,width,height,touch} of profiles.filter(p=>!process.env.CSVTV_ROUTE_ENGINE || p.engine===process.env.CSVTV_ROUTE_ENGINE)) {
  let cloud,context;
  let build = buildId(assets);
  const server = releaseWithDropbox(assets,()=>cloud);
  const origin = 'http://127.0.0.1:'+await listen(server);
  const profile = await mkdtemp(join(tmpdir(),'csvtv-routes-'+engine+'-'));
  try {
    cloud = offlineProviders(origin);
    await cloud.settings({mdblist_key:'fictional-scores',imdb_source:'omdb'});
    context = await engines[engine].launchPersistentContext(profile,{headless:true,viewport:{width,height},
      ...(engine==='chromium' && process.env.CSVTV_ROUTE_CHROME ? {executablePath:process.env.CSVTV_ROUTE_CHROME} : {}),
      isMobile:touch,hasTouch:touch,proxy:{server:origin,bypass:'127.0.0.1,localhost'}});
    await connectFictionalDropbox(context);
    const page = await context.newPage();
    await linkFixture({navigate:url=>page.goto(url),evaluate:script=>page.evaluate(script)},origin,'/');
    console.log(engine+' setting up fictional record');
    const seed = page.evaluate(seedRatedLibrary,{withLists:true,showCount:shows,batchSize:engine==='webkit' ? 450 : 13500});
    let deadline;
    try {
      await Promise.race([seed,new Promise((_,reject)=>{
        deadline=setTimeout(()=>reject(Error('Timed out setting up the fictional '+engine+' record')),600000);
      })]);
    } finally { clearTimeout(deadline); }
    if (process.env.CSVTV_ROUTE_AWAIT_ZIP) {
      const prompt = createInterface({input:process.stdin,output:process.stdout});
      let path;
      try { path = (await prompt.question('Fixture ready. Enter the candidate ZIP path: ')).trim(); }
      finally { prompt.close(); }
      const candidate = await unpack(await readFile(path));
      build = buildId(candidate);
      const serveCandidate = releaseWithDropbox(candidate,()=>cloud).listeners('request')[0];
      server.removeAllListeners('request');
      server.on('request',serveCandidate);
    }
    console.log(engine+' opening the release');
    await page.goto(origin+'/#/settings');
    await page.waitForFunction(()=>document.querySelector('.sync-state')?.dataset.synced === 'true' && navigator.serviceWorker.controller,null,{timeout:150000});
    const results = {};
    const visibleNav = async name => {
      const links = page.locator('nav a[href="#/'+name+'"]:visible');
      // Phone Export is available in Settings. A direct link is also the normal
      // route on desktop. Some phone destinations live in the top header.
      if (await links.count()) {
        if (await page.locator('.app-sidebar a[href="#/'+name+'"]:visible').count()) return '.app-sidebar a[href="#/'+name+'"]';
        return '.phone-nav a[href="#/'+name+'"]';
      }
      if (name === 'settings') return '.settings-shortcut';
      if (name === 'export') return 'main a[href="#/export"]';
      throw Error('No visible link to '+name);
    };
    const routeCase = process.env.CSVTV_ROUTE_CASE;
    if (['library-sort-statistics','library-sort-statistics-reopen','library-sort-statistics-synced'].includes(routeCase)) {
      const afterSync = routeCase !== 'library-sort-statistics-reopen';
      const verifyUpload = routeCase === 'library-sort-statistics-synced';
      if (verifyUpload) await page.exposeFunction('fictionalLibrarySort',()=>{
        const file = cloud.files.get('/settings.csv');
        if (!file) return null;
        const row = readCsv('settings',file.bytes).rows.find(row=>row.setting==='library_sort');
        return {value:row?.value ?? 'title',revision:file.meta.rev};
      });
      const timings = await measureLibrarySortToStatistics(page,visibleNav,shows,repeats,afterSync,verifyUpload);
      console.log(JSON.stringify({build,engine,width,height,shows,afterSync,verifyUpload,timings}));
      continue;
    }
    for (let iteration=0;iteration<=repeats;iteration++) {
      const run = async (label,selector,ready,action='click',value) => {
        const time = await page.evaluate(painted,{selector,action,value,ready,iteration,shows});
        if (label) {
          (results[label] ??= []).push(time);
          if (!iteration) console.log(engine,label,time+' ms');
        }
      };
      const visit = async (name,ready=name) => run(name,await visibleNav(name),ready);
      if (process.env.CSVTV_ROUTE_CASE === 'statistics') {
        await visit('statistics');
        await run(null,await visibleNav('settings'),'settings');
        await run('Statistics unchanged',await visibleNav('statistics'),'statistics');
        await run(null,await visibleNav('settings'),'settings');
        continue;
      }
      if (process.env.CSVTV_ROUTE_CASE === 'watchlist') {
        await visit('library');
        await run(null,'.library-selects select[aria-label=Sort]','library','select','title');
        await run(null,'.library-selects select[aria-label=Sort]','sorted','select','rating');
        await run(null,'.library-selects input[type=search]','query','input','Station '+Math.min(233,shows));
        await run(null,'.library-selects input[type=search]','library','input','');
        await visit('watchlist');
        continue;
      }
      await visit('home');
      await run('scroll Home rail','[data-home-watchlist] .poster-rail','rail','rail');
      await visit('library');
      await run('filter Anime','[data-category=anime]','anime');
      await run(null,'[data-category=all]','library');
      await run(null,'.library-selects select[aria-label=Sort]','library','select','title');
      await run('sort by rating','.library-selects select[aria-label=Sort]','sorted','select','rating');
      await run('search Library','.library-selects input[type=search]','query','input','Station '+Math.min(233,shows));
      await run(null,'.library-selects input[type=search]','library','input','');
      await visit('watchlist');
      await visit('lists');
      await visit('statistics');
      for (const scope of ['tv','anime','all'])
        await run('Statistics '+scope,'.stats-scope input[value='+scope+']','statistics','click',scope);
      await run(null,await visibleNav('settings'),'settings');
      await run('Statistics unchanged',await visibleNav('statistics'),'statistics');
      await visit('ratings');
      await run('edit rating','.ratings-rows [data-show-id="1"] select','edit','select',iteration%2 ? '8' : '7');
      await visit('settings');
      await visit('export');
      if (iteration===0) console.log(engine+' first',JSON.stringify(results));
    }
    console.log(JSON.stringify({build,engine,width,height,shows,userAgent:await page.evaluate(()=>navigator.userAgent),results}));
  } finally {
    try { await context?.close(); }
    finally { await stop(server); await rm(profile,{recursive:true,force:true,maxRetries:8,retryDelay:150}); }
  }
}
