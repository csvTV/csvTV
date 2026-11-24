import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { openChromium } from './offline-chromium.mjs';
import { linkFixture, offlineProviders } from './offline-providers.mjs';
import { listen, stop, testSite } from './offline-site.mjs';
import { malScoresForShows } from '../src/record-overview.ts';
import { exerciseProviderSort } from './library-provider-sort.mjs';

const titles = {45:'Amber Atlas', 46:'Winter Radio', 47:'Silver House', 75:'Hidden Coast'};
const file = gzipSync([
  'show,season,offset,mal_id,score',
  '45,1,9,51,7.20', '45,1,,9,8.06', '45,1,0,1,8.01', '45,2,,21,7.0', '45,0,,11,10', '45,3,,31,9.89',
  '46,,,71,9.95', '46,,,70,8.09', '46,0,0,72,9.90', '47,0,,15,9.50',
  '75,1,,10,9.13', '75,2,,116,6.4',
].join('\n') + '\n');

test('Library and Statistics can use an unseasoned score while a recorded show is waiting for TMDB data', () => {
  const entries = [{season:1,offset:0,malId:12,score:8.32},{season:null,offset:0,malId:13,score:7.45}];
  const byShow = new Map([[4,entries],[5,entries],[6,entries.slice(0,1)]]);
  const shows = [{id:4,metadata:null},{id:5,metadata:{seasons:[{season:1}]}},{id:6,metadata:null}];
  assert.deepEqual(malScoresForShows(byShow,shows),new Map([[4,7.45],[5,8.32]]));
});

async function seed(titles) {
  const {openDeviceStore} = await import('/tracker/storage.js');
  const store = await openDeviceStore();
  try {
    const {revision} = await store.whenWriter();
    const watched = [45,46,47].map(show_id => ({show_id,show:titles[show_id],season:1,episode:1,episode_id:show_id*100+11,title:'Opening',times_watched:1}));
    await store.commit(revision,{put:{watched, ratings:watched.map(({show_id,show}) => ({show_id,show,rating:7.5})),
      settings:[{setting:'mal_source',value:'github'}, {setting:'github_repo',value:'fictional/scores'}]}});
  } finally { await store.closeForUpdate(); }
}

test('MyAnimeList job scores follow TMDB seasons across Search, Show, Library and Statistics and reopen offline', {timeout:90000}, async t => {
  const {server} = await testSite();
  const origin = 'http://127.0.0.1:' + await listen(server);
  const profile = await mkdtemp(join(tmpdir(),'csvtv-mal-screens-'));
  const providers = offlineProviders(origin), release = Promise.withResolvers();
  let browser, downloads = 0, hiddenShowReads = 0;
  t.after(async () => {
    release.resolve();
    try { await browser?.close(); }
    finally { await stop(server); await rm(profile,{recursive:true,force:true,maxRetries:6,retryDelay:150}); }
  });
  async function respond(message, send) {
    const {request,requestId} = message, url = new URL(request.url), headers = new Headers(request.headers);
    assert.ok(!headers.has('X-MAL-CLIENT-ID'));
    if (new URL(request.url).hostname.endsWith('.dropboxapi.com')) return providers.respond(message,send);
    if (request.method === 'OPTIONS') return providers.respond(message,send);
    assert.equal(request.method,'GET');
    let data;
    if (url.hostname === 'api.github.com') {
      assert.equal(request.url,'https://api.github.com/repos/fictional/scores/contents/mal-ratings.csv.gz?ref=mal-data');
      assert.equal(headers.get('Authorization'),'Bearer fictional-read-token');
      downloads++;
      await release.promise;
      data = file;
    } else if (url.hostname === 'api.mdblist.com') {
      const id = Number(url.pathname.split('/').at(-1));
      data = {ids:{tmdb:id},type:'show',ratings:[{source:'myanimelist',value:9.9},{source:'tomatoes',value:75}]};
    } else if (url.hostname === 'api.themoviedb.org') {
      const path = url.pathname;
      if (path === '/3/search/tv') data = {page:1,total_pages:1,results:[75,45,46,47].map(id => ({id,name:titles[id],first_air_date:'2020-01-01'}))};
      const match = /^\/3\/tv\/(\d+)(.*)$/.exec(path);
      if (match) {
        const id = Number(match[1]), tail = match[2], numbers = id === 75 ? [2] : id === 45 ? [0,1,2] : [1];
        assert.ok(titles[id]);
        if (!tail) {
          if (id === 75) hiddenShowReads++;
          data = {id,name:titles[id],first_air_date:'2020-01-01',status:'Ended',
            seasons:numbers.map(n => ({season_number:n,name:id === 45 && n === 2 ? 'The Observatory at Daybreak' :
              n ? 'Season ' + n : 'Specials',episode_count:1})),
            external_ids:{},keywords:{results:[]},last_episode_to_air:{season_number:numbers.at(-1),episode_number:1,air_date:'2020-02-01'}};
        } else if (tail.startsWith('/season/')) {
          const n = Number(tail.split('/').at(-1));
          data = {season_number:n,episodes:[{id:id*100+n*10+1,episode_number:1,name:'Opening',runtime:24,air_date:'2020-02-01'}]};
        } else if (tail === '/aggregate_credits') data = {id,cast:[]};
        else if (tail === '/recommendations') data = {page:1,total_pages:0,results:[]};
      }
    }
    if (!data) return providers.respond(message,send);
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(JSON.stringify(data));
    await send('Fetch.fulfillRequest',{requestId,responseCode:200,responseHeaders:[
      {name:'Access-Control-Allow-Origin',value:origin},{name:'Content-Type',value:Buffer.isBuffer(data) ? 'application/octet-stream' : 'application/json'},
    ],body:bytes.toString('base64')});
  }
  browser = await openChromium(profile,respond);
  const route = path => browser.navigate(origin + '/tracker/#/' + path);
  const viewport = width => browser.send('Emulation.setDeviceMetricsOverride',{width,height:820,deviceScaleFactor:1,mobile:false});
  const markIs = (selector,figure) => browser.waitFor('document.querySelector(' + JSON.stringify(selector) + ')?.textContent === ' + JSON.stringify(figure),selector);
  const marks = selector => browser.evaluate('Array.from(document.querySelectorAll(' + JSON.stringify(selector + ' .myanimelist-score') + '), el => el.textContent)');
  await linkFixture(browser, origin);
  await providers.settings({tmdb_key:'fictional-offline-key',mdblist_key:'fictional-critic-key',mal_source:'github',github_repo:'fictional/scores',github_token:'fictional-read-token'});
  await browser.evaluate('(' + seed.toString() + ')(' + JSON.stringify(titles) + ')');
  await viewport(320);
  await route('search?q=coast');
  await markIs('[data-show="75"] .tomatoes-score','75%');
  assert.deepEqual(await marks('.tv-results'),[], 'The selected job must suppress the cached MDBList figure while loading');
  release.resolve();
  await markIs('[data-show="75"] .myanimelist-score','9.13');
  await markIs('[data-show="46"] .myanimelist-score','8.09');
  assert.equal(hiddenShowReads,0);
  assert.deepEqual(await marks('[data-show="47"]'),[]);
  await browser.evaluate('document.querySelector(\'[data-show="75"] a\').focus()');
  await browser.press('Enter');
  await markIs('[data-season="2"] .myanimelist-score','6.40');
  assert.deepEqual(await marks('.show-labels'),[]);
  await route('search?q=coast');
  await markIs('[data-show="75"] .myanimelist-score','6.40');
  await route('show/45');
  const split = '.show-season-row[data-season="1"]';
  await markIs(split+' .myanimelist-score','8.01');
  assert.deepEqual(await marks('.show-labels'),[]);
  assert.deepEqual(await marks(split),['8.01','8.06','7.20']);
  assert.deepEqual(await marks('.show-season-row[data-season="0"]'),[]);
  assert.deepEqual(await marks('.show-season-row[data-season="2"]'),['7.00']);
  assert.ok(await browser.evaluate('document.documentElement.scrollWidth <= innerWidth'));
  const seasonTwo = '.show-season-row[data-season="2"]';
  async function scorePosition(host) {
    await browser.waitFor('!!document.querySelector('+JSON.stringify(seasonTwo+' '+host+' .myanimelist-score')+')',host+' receives the score after resize');
    return browser.evaluate(`(() => {
      const row=document.querySelector('${seasonTwo}'), title=row.querySelector('.show-season-title'), name=title.querySelector('strong');
      const box = name.getBoundingClientRect(), score = row.querySelector('.season-scores').getBoundingClientRect();
      const controls = row.closest('.show-season-tile').querySelector('.show-season-controls').getBoundingClientRect();
      return {lines:Math.round(box.height / parseFloat(getComputedStyle(name).lineHeight)), name:box.width, available:title.getBoundingClientRect().width,
        score:score.width, clear:score.right <= controls.left && box.right <= controls.left};
    })()`);
  }
  const narrow = await scorePosition('.show-episode-count');
  assert.ok(narrow.lines > 1 && narrow.clear,'A wrapped season name must move MAL to the episode count');
  // Measure the unwrapped title in the active font. Both target widths stay within the single-column layout.
  const naturalName = await browser.evaluate(`(() => {
    const title = document.querySelector('${seasonTwo} .show-season-title');
    const probe = title.querySelector('strong').cloneNode(true);
    probe.style.position = 'absolute'; probe.style.maxWidth = 'none';
    title.append(probe);
    const width = probe.getBoundingClientRect().width;
    probe.remove();
    return width;
  })()`);
  const fitWidth = Math.ceil(320 - narrow.available + naturalName + narrow.score + 8);
  await viewport(fitWidth);
  const wide = await scorePosition('.show-season-title');
  assert.ok(wide.lines === 1 && wide.available >= wide.name + wide.score && wide.clear,
    'A fitting title should keep MAL next to its name and clear of the quick +');
  // Leave room for the complete name and only half of the badge.
  await viewport(fitWidth - Math.round(wide.available - wide.name - wide.score / 2));
  const edge = await scorePosition('.show-episode-count');
  assert.ok(edge.lines === 1 && edge.available < edge.name + edge.score && edge.clear,
    'A single-line name with insufficient space should move MAL after the episode count');
  await viewport(fitWidth);
  await scorePosition('.show-season-title');
  await viewport(2160);
  await browser.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  await browser.waitFor('!!document.querySelector(\'.show-season-row[data-season="1"] .myanimelist-score\')');
  const wideTile = await browser.evaluate(`(() => {
    const tile=document.querySelector('.show-season-row[data-season="1"]').closest('.show-season-tile');
    const box=selector=>tile.querySelector(selector).getBoundingClientRect();
    return {scores:box('.season-scores').right, controls:box('.show-season-controls').left,
      plus:box('.show-season-add').left, count:box('.show-season-count').right,
      caption:box('.show-episode-count').top, title:box('.show-season-title').bottom};
  })()`);
  assert.ok(wideTile.scores<=wideTile.controls+1 && wideTile.plus+1>=wideTile.count && wideTile.title<=wideTile.caption+1,
    'Desktop watch controls should share a row and leave room for the scores');
  await viewport(1152);
  await browser.click(split);
  await browser.waitFor('document.querySelector(".season-screen [data-season-focus]")');
  assert.deepEqual(await marks('.season-screen'),[]);
  assert.ok(await browser.evaluate('document.documentElement.scrollWidth <= innerWidth'));
  await route('library');
  await exerciseProviderSort(browser,'myanimelist',[titles[46],titles[45],titles[47]]);
  await route('statistics');
  await browser.click('[data-table="myanimelist"]');
  await browser.waitFor('document.querySelector(\'[data-chart="myanimelist"] tbody tr\')');
  assert.deepEqual(await browser.evaluate('Array.from(document.querySelectorAll(\'[data-chart="myanimelist"] tbody tr\'), r=>Array.from(r.cells,c=>c.textContent))'),[
    [titles[45],'7.5','8.01'],[titles[46],'7.5','8.09'],
  ]);
  await route('settings');
  await browser.waitFor('document.querySelector("[data-offline-status]")?.textContent.includes("Ready to open offline")');
  const firstClose = browser.close();
  await browser.close();
  await firstClose;
  browser = undefined;
  browser = await openChromium(profile,respond);
  await browser.offline(true);
  await viewport(320);
  await route('show/45');
  await markIs(split+' .myanimelist-score','8.01');
  assert.deepEqual(await marks('.show-labels'),[]);
  assert.deepEqual(await marks(split),['8.01','8.06','7.20']);
  assert.equal(downloads,1);

  const chooseSource = async source => {
    await route('mal-scores');
    const radio = 'input[name="mal-source"][value="' + source + '"]';
    await browser.click(radio);
    await browser.waitFor('document.querySelector(' + JSON.stringify(radio) + ')?.checked && ' +
      'document.querySelector("[data-mal-section=github]").hidden === ' + (source === 'mdblist'));
  };
  await chooseSource('mdblist');
  await route('show/45');
  await markIs('.show-labels .tomatoes-score','75%');
  assert.deepEqual(await marks('.show-labels'),[]);
  assert.deepEqual(await marks(split),[]);
  await route('settings');
  await browser.waitFor('document.querySelector("[data-mdblist-edit]")?.disabled');
  await browser.offline(false);
  await browser.click('[data-mdblist-edit]');
  await browser.click('dialog button[type="submit"]');
  await browser.click('dialog [data-remove]');
  await browser.waitFor('document.querySelector("[data-mdblist-status]")?.textContent.includes("No key saved")');
  await browser.offline(true);
  await chooseSource('github');
  await route('show/45');
  await markIs('.show-title-block h1',titles[45]);
  assert.deepEqual(await marks('.show-labels'),[]);
  await browser.offline(false);
  await markIs(split+' .myanimelist-score','8.01');
  assert.deepEqual(await marks('.show-labels'),[]);
  assert.deepEqual(await marks(split),['8.01','8.06','7.20']);
  assert.equal(downloads,2);
  await browser.close(); browser = undefined;
  browser = await openChromium(profile,respond);
  await browser.send('Page.addScriptToEvaluateOnNewDocument',{source:'const realNow = Date.now; Date.now = () => realNow() + 8 * 86400000;'});
  await linkFixture(browser, origin);
  await route('mal-scores');
  await browser.waitFor('document.querySelector("[data-fetched]")?.textContent.includes("Unchanged since")');
  assert.equal(downloads,3,'A new session after eight days should check the same job once');
});
