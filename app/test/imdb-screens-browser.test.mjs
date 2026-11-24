import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { openChromium } from './offline-chromium.mjs';
import { linkFixture, offlineProviders } from './offline-providers.mjs';
import { listen, stop, testSite } from './offline-site.mjs';
import { exerciseProviderSort } from './library-provider-sort.mjs';

const titles = {45:'Zinc Avenue', 46:'Amber Quay', 47:'Cedar Pass', 49:'Unlisted Station', 50:'Quiet Crossing'};
const ratings = {45:'8.0',46:'8.0',49:'9.2',50:'7.6'};
const imdbId = id => 'tt' + String(id).padStart(7,'0');

// Seed only the watch record, synced settings and their IDs. The compiled app fetches all metadata and ratings.
async function prepare(titles, source) {
  const {openDeviceStore} = await import('/tracker/storage.js');
  const store = await openDeviceStore();
  try {
    const {revision} = await store.whenWriter();
    const settings = source ? [{setting:'imdb_source',value:source}] : [];
    if (source === 'github') settings.push({setting:'github_repo',value:'fictional/ratings'});
    const shows = [45,46,47].map(show_id => ({show_id,show:titles[show_id],year:2020,imdb_id:'tt' + String(show_id).padStart(7,'0')}));
    const watched = shows.map(({show_id,show}) => ({show_id,show,season:1,episode:1,episode_id:show_id*100 + 1,title:'Opening',times_watched:1}));
    await store.commit(revision,{replace:{settings, shows, watched, ratings:[
      {show_id:45,show:titles[45],rating:7.5}, {show_id:47,show:titles[47],rating:5},
    ]}});
  } finally { await store.closeForUpdate(); }
}

function mockTransport(origin) {
  const providers = offlineProviders(origin);
  const calls = {omdb:[], github:0, external:[]};
  const pending = Promise.withResolvers();
  const gzip = gzipSync('show,season,episode,rating\n45,,,8.0\n45,1,1,6.0\n45,1,1,7.2\n45,1,2,7.4\n46,,,8.0\n49,,,9.2\n50,,,7.6\n');
  async function respond(message, send) {
    const {request, requestId} = message;
    const url = new URL(request.url);
    let data;
    if (url.origin === 'https://api.themoviedb.org' && request.method === 'GET') {
      const show = /^\/3\/tv\/(\d+)(.*)$/.exec(url.pathname);
      if (url.pathname === '/3/search/tv') {
        const ids = url.searchParams.get('query') === 'crossing' ? [50] : [49,45,47];
        data = {page:1,total_pages:1,results:ids.map(id => ({id,name:titles[id],first_air_date:'2020-01-01'}))};
      } else if (show) {
        const id = Number(show[1]);
        assert.ok(titles[id]);
        switch (show[2]) {
          case '':
            data = {id, name:titles[id], status:'Ended', seasons:[{season_number:1,name:'Season 1',episode_count:2}],
              first_air_date:'2020-01-01', next_episode_to_air:null,last_episode_to_air:{season_number:1,episode_number:2,air_date:'2020-01-02'},
              keywords:{results:[]},external_ids:{imdb_id:imdbId(id)}};
            break;
          case '/external_ids':
            calls.external.push(id);
            data = {id,imdb_id:imdbId(id)};
            break;
          case '/season/1':
            data = {season_number:1,name:'Season 1',episodes:[1,2].map(n => ({id:id*100+n,episode_number:n,
              name:n === 1 ? 'Opening' : 'Return',runtime:30,air_date:'2020-01-01'}))};
            break;
          case '/aggregate_credits': data = {id,cast:[]}; break;
          case '/recommendations': data = {page:1,total_pages:0,results:[]}; break;
          default: throw Error('Unexpected TMDB resource');
        }
      }
    } else if (url.origin === 'https://api.mdblist.com') {
      assert.equal(request.method, 'GET');
      assert.equal(url.searchParams.get('apikey'), 'fictional-score-key');
      const id = Number(/^\/tmdb\/show\/(\d+)$/.exec(url.pathname)?.[1]);
      assert.ok(titles[id]);
      data = {ids:{tmdb:id}, type:'show', ratings:id === 45 ?
        [{source:'tomatoes',value:85}, {source:'metacritic',value:78}, {source:'myanimelist',value:8.3}] : []};
    } else if (url.origin === 'https://www.omdbapi.com') {
      assert.equal(request.method,'GET');
      assert.equal(url.searchParams.get('apikey'), 'fictional-imdb-key');
      const id = Number(url.searchParams.get('i')?.slice(2));
      const season = url.searchParams.get('Season');
      calls.omdb.push([id,season]);
      if (id === 49) await pending.promise;
      data = season ? {Title:titles[id],Season:season,Response:'True',Episodes:[
        {Episode:'1',imdbRating:'6.0'},{Episode:'1',imdbRating:'7.2'},{Episode:'2',imdbRating:'N/A'},
      ]} : {Title:titles[id],Type:'series',imdbID:imdbId(id),imdbRating:ratings[id] ?? 'N/A',Response:'True'};
    } else if (url.origin === 'https://api.github.com') {
      assert.equal(url.pathname,'/repos/fictional/ratings/contents/imdb-ratings.csv.gz');
      assert.equal(url.searchParams.get('ref'),'data');
      if (request.method === 'OPTIONS') {
        await send('Fetch.fulfillRequest',{requestId,responseCode:204,responseHeaders:[
          {name:'Access-Control-Allow-Origin',value:origin},{name:'Access-Control-Allow-Methods',value:'GET'},
          {name:'Access-Control-Allow-Headers',value:'Authorization, Accept'},
        ]});
        return;
      }
      assert.equal(request.method,'GET');
      const headers = new Headers(request.headers);
      assert.equal(headers.get('Authorization'),'Bearer fictional-file-token');
      assert.equal(headers.get('Accept'),'application/vnd.github.raw+json');
      calls.github++;
      await pending.promise;
      data = gzip;
    }
    if (data === undefined) return providers.respond(message,send);
    await send('Fetch.fulfillRequest',{requestId,responseCode:200,responseHeaders:[
      {name:'Content-Type',value:Buffer.isBuffer(data) ? 'application/octet-stream' : 'application/json'},
      {name:'Access-Control-Allow-Origin',value:origin},
    ],body:(Buffer.isBuffer(data) ? data : Buffer.from(JSON.stringify(data))).toString('base64')});
  }
  return {respond,calls,release:pending.resolve,providers};
}

for (const source of ['omdb','github']) {
  test('IMDb screens use the ' + source + ' source across Search, Show, Season, Library and Statistics', {timeout:80000}, async t => {
    const {server} = await testSite();
    const origin = 'http://127.0.0.1:' + await listen(server);
    const profile = await mkdtemp(join(tmpdir(),'csvtv-imdb-screens-'));
    const {respond,calls,release,providers} = mockTransport(origin);
    let browser;
    t.after(async () => {
      release();
      try { await browser?.close(); }
      finally { await stop(server); await rm(profile,{recursive:true,force:true,maxRetries:6,retryDelay:150}); }
    });
    browser = await openChromium(profile,respond);
    const route = path => browser.navigate(origin + '/tracker/#/' + path);
    const viewport = width => browser.send('Emulation.setDeviceMetricsOverride',{width,height:780,deviceScaleFactor:1,mobile:false});
    const configure = async choice => {
      await linkFixture(browser, origin);
      const settings = {tmdb_key:'fictional-offline-key'};
      if (choice === 'omdb') Object.assign(settings,{imdb_source:choice,omdb_key:'fictional-imdb-key'});
      if (choice === 'github') Object.assign(settings,{imdb_source:choice,github_repo:'fictional/ratings',github_token:'fictional-file-token',mdblist_key:'fictional-score-key'});
      await providers.settings(settings);
      await browser.evaluate('(' + prepare.toString() + ')(' + JSON.stringify(titles) + ',' + JSON.stringify(choice) + ')');
    };
    const visible = selector => browser.waitFor('document.querySelector(' + JSON.stringify(selector) + ')?.getClientRects().length',selector);
    const textIs = (selector,value) => browser.waitFor('document.querySelector(' + JSON.stringify(selector) + ')?.textContent === ' + JSON.stringify(value),selector);
    const scoredEpisode = source === 'github' ? 'episode-2' : 'episode-1';
    const blankEpisode = source === 'github' ? 'episode-1' : 'episode-2';
    async function checkEpisodeScores() {
      await textIs('[data-episode="'+scoredEpisode+'"] .imdb-score',source === 'github' ? '7.4' : '7.2');
      assert.equal(await browser.evaluate('!!document.querySelector('+JSON.stringify('[data-episode="'+blankEpisode+'"] .imdb-score')+')'),false);
    }
    const fits = () => browser.evaluate('document.documentElement.scrollWidth <= window.innerWidth');
    await viewport(320);
    await configure(null);
    await route('search?q=sample');
    await visible('[data-show="49"] a');
    assert.equal(await browser.evaluate('document.querySelector(".imdb-score")'),null);
    assert.deepEqual(calls,{omdb:[],github:0,external:[]});
    await configure(source);
    await route('search?q=sample');
    await visible('[data-show="49"] a');
    assert.equal(await browser.evaluate('document.querySelector(\'[data-show="49"] .imdb-score\')'),null);
    release();
    await textIs('[data-show="49"] .imdb-score','9.2');
    await textIs('[data-show="45"] .imdb-score','8.0');
    assert.ok(await fits());
    assert.equal(await browser.evaluate('!!document.querySelector(\'[data-show="47"] .imdb-score\')'),false);
    await browser.evaluate('document.querySelector(\'[data-show="45"] a\').focus()');
    await browser.press('Enter');
    await textIs('.show-labels .imdb-score','8.0');
    if (source === 'github') {
      await textIs('.show-labels .critic-marks + .imdb-score','8.0');
      assert.equal(await browser.evaluate('!!document.querySelector(".show-labels .myanimelist-score")'),false);
      assert.ok(await fits(), 'The show header with outside scores must fit the 320-pixel layout');
    }
    assert.equal(await browser.evaluate('document.querySelectorAll(".show-season-row .imdb-score").length'),0);
    await browser.click('.show-season-row[data-season="1"]');
    await checkEpisodeScores();
    await visible('[data-episode="'+scoredEpisode+'"]:has(.season-episode .imdb-score) .episode-controls .episode-count');
    assert.ok(await fits());
    await route('library');
    await visible('.sort-trigger');
    await exerciseProviderSort(browser,'imdb',[titles[46],titles[45],titles[47]]);
    await viewport(1152);
    await route('statistics');
    await visible('[data-table="imdb"]');
    await browser.evaluate('document.querySelector(\'[data-table="imdb"]\').focus()');
    await browser.press('Enter');
    await visible('[data-chart="imdb"] table tbody');
    assert.deepEqual(await browser.evaluate('Array.from(document.querySelectorAll(\'[data-chart="imdb"] tbody tr\'),r=>Array.from(r.cells,c=>c.textContent))'),
      [[titles[45],'7.5','8.0']]);
    assert.ok(await fits());
    await route('show/45');
    await textIs('.show-labels .imdb-score','8.0');
    await browser.click('.show-season-row[data-season="1"]');
    await checkEpisodeScores();
    // The job file is already on this device. Resolve a new result's identity after Search has drawn.
    await route('search?q=crossing');
    await textIs('[data-show="50"] .imdb-score','7.6');
    await route('settings');
    await browser.waitFor('document.querySelector("[data-offline-status]")?.textContent.includes("Ready to open offline")');
    await browser.close(); browser = null;
    browser = await openChromium(profile,respond);
    await browser.offline(true);
    await viewport(320);
    await route('show/45/season/1');
    await checkEpisodeScores();
    assert.deepEqual(calls.external,[49,50]);
    assert.equal(calls.github,source === 'github' ? 1 : 0);
    if (source === 'omdb') {
      assert.deepEqual(calls.omdb.filter(([,season]) => season),[[45,'1']]);
      assert.deepEqual(calls.omdb.filter(([,season]) => !season).map(([id])=>id).sort(),[45,46,47,49,50]);
    } else assert.deepEqual(calls.omdb,[]);
  });
}
