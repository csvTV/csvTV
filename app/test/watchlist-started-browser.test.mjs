import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {createRelease} from '../package-release.mjs';
import {readCsv,writeCsv} from '../dist/csv.js';
import {openChromium} from './offline-chromium.mjs';
import {linkFixture,offlineProviders} from './offline-providers.mjs';
import {listen,stop} from './offline-site.mjs';
import {releaseServer,unpack} from './release-site.mjs';

test('A previously planned and watched show stays off Watchlist when a new season airs', {timeout:90000}, async t => {
  const {bytes} = await createRelease(new URL('../dist/',import.meta.url));
  const server = releaseServer(await unpack(bytes)), origin = 'http://127.0.0.1:'+await listen(server);
  const directory = await mkdtemp(join(tmpdir(),'csvtv-started-show-'));
  const cloud = offlineProviders(origin), show = {show_id:45,show:'The Listening House'};
  const watched = [1,2].map(n => ({...show,season:1,episode:n,episode_id:45010+n,title:'Recording '+n,times_watched:n}));
  const ratings = [{...show,rating:8}];
  await cloud.settings({tmdb_key:'fictional-offline-key'});
  await cloud.upload('watched.csv',writeCsv('watched',watched));
  await cloud.upload('ratings.csv',writeCsv('ratings',ratings));
  await cloud.upload('lists.csv',writeCsv('lists',['Following upcoming','Favorites','Weekend viewing'].map(list=>({...show,list}))));

  let browser;
  t.after(async () => {
    try { await browser?.close(); }
    finally { await stop(server); await rm(directory,{recursive:true,force:true,maxRetries:6,retryDelay:150}); }
  });
  const visit = route => browser.navigate(origin+'/#/'+route);
  const synced = 'document.querySelector(".sync-state")?.dataset.synced === "true"';
  async function signIn(profile,respond) {
    browser = await openChromium(join(directory,profile),respond);
    await linkFixture(browser,origin,'/');
    await visit('settings'); await browser.waitFor(synced);
  }
  async function checkQueues(episodesLeft) {
    await visit('watchlist');
    const lead = 'document.querySelector(\'[data-section="more-to-watch"] .watch-lead\')?.textContent';
    await browser.waitFor(lead+' && '+lead+' !== "Loading…"');
    const ids = selector => browser.evaluate('Array.from(document.querySelectorAll('+JSON.stringify(selector)+'),a=>a.hash)');
    assert.deepEqual(await ids('.watchlist-screen [data-section="upcoming"] a,.watchlist-screen [data-section="available"] a,.watchlist-screen [data-pending-schedule] a'),[]);
    assert.deepEqual(await ids('[data-section="more-to-watch"] a'),episodesLeft ? ['#/show/45'] : []);
    if (episodesLeft) assert.equal(await browser.evaluate('document.querySelector(".more-watch-rows .watch-row-end").textContent'),'1 left');
    await visit('home');
    await browser.waitFor('document.querySelector("[data-more-count]")?.textContent === '+JSON.stringify(episodesLeft?'1 show':'0 shows'));
    assert.deepEqual(await ids('[data-home-watchlist] a'),[]);
    assert.deepEqual(await ids('[data-more] a'),episodesLeft ? ['#/show/45'] : []);
    assert.equal(await browser.evaluate('document.querySelector("[data-watchlist-count]").textContent'),'0 shows');
  }
  await signIn('one-season',cloud.respond);
  await visit('show/45');
  await browser.waitFor('document.querySelector(".show-actions .primary")?.textContent === "Watched again"');
  await checkQueues(false);
  await browser.close(); browser = undefined;

  // A fresh device receives the same personal files after an additional season has aired.
  const detail = {season_number:2,name:'Season 2',episodes:[{id:45021,episode_number:1,name:'New broadcast',air_date:'2021-10-01',runtime:30}]};
  await signIn('two-seasons',async (params,send) => {
    const {request,requestId} = params, url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/3/tv/45/season/2') {
      return send('Fetch.fulfillRequest',{requestId,responseCode:200,
        responseHeaders:[{name:'Access-Control-Allow-Origin',value:origin},{name:'Content-Type',value:'application/json'}],
        body:Buffer.from(JSON.stringify(detail)).toString('base64')});
    }
    return cloud.respond(params,async (command,reply) => {
      if (request.method === 'GET' && url.pathname === '/3/tv/45') {
        const header = JSON.parse(Buffer.from(reply.body,'base64'));
        header.seasons.push({season_number:2,name:detail.name,episode_count:1});
        header.last_episode_to_air = {season_number:2,episode_number:1,air_date:detail.episodes[0].air_date};
        if (url.searchParams.get('append_to_response')?.split(',').includes('season/2')) header['season/2'] = detail;
        reply = {...reply,body:Buffer.from(JSON.stringify(header)).toString('base64')};
      }
      return send(command,reply);
    });
  });
  await visit('show/45/season/2');
  await browser.waitFor('document.querySelector(".episode-name")?.textContent === "New broadcast"');
  await visit('show/45');
  await browser.waitFor('document.querySelector(".show-actions .primary")?.textContent === "Finish"');
  assert.equal(await browser.evaluate('!!document.querySelector(".show-watchlist")'),false);
  await checkQueues(true);
  await visit('show/45'); await browser.click('.show-actions .primary');
  await browser.waitFor('document.querySelector(".show-actions .primary")?.textContent === "Watched again"');
  await checkQueues(false);
  await visit('settings'); await browser.waitFor(synced);
  const remote = name => readCsv(name,cloud.files.get('/'+name+'.csv').bytes).rows;
  assert.deepEqual(remote('watched'),[...watched,{...show,season:2,episode:1,episode_id:45021,title:'New broadcast',times_watched:1}]);
  assert.deepEqual(remote('ratings'),ratings);
  for (const list of ['Favorites','Weekend viewing']) assert.ok(remote('lists').some(row=>row.show_id===45 && row.list===list));
});
