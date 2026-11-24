import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {createRelease} from '../package-release.mjs';
import {readCsv} from '../dist/csv.js';
import {openChromium} from './offline-chromium.mjs';
import {linkFixture, offlineProviders} from './offline-providers.mjs';
import {listen, stop} from './offline-site.mjs';
import {releaseServer, unpack} from './release-site.mjs';

test('AniList review corrections reach a fresh Library and repeating the import keeps every episode count', {timeout:90000}, async t => {
  const release = await createRelease(new URL('../dist/',import.meta.url));
  const server = releaseServer(await unpack(release.bytes));
  const origin = 'http://127.0.0.1:'+await listen(server);
  const folder = await mkdtemp(join(tmpdir(),'csvtv-anilist-review-'));
  let browser;
  t.after(async () => {
    try { await browser?.close(); }
    finally { await stop(server); await rm(folder,{recursive:true,force:true,maxRetries:5,retryDelay:100}); }
  });
  const file = join(folder,'fictional-anime.json'), provider = offlineProviders(origin);
  await provider.settings({tmdb_key:'fictional-offline-key'});
  const title = 'The Glass Orchard', showId=45;
  const correctedTitle = 'Windward Window', correctedId = 45845;
  const entry = (id,status,repeat) => ({series_id:id,series_type:0,progress:1,status,score:75,repeat});
  await writeFile(file, JSON.stringify({lists:[entry(9001,0,1),entry(9002,2,0),entry(9003,2,0),entry(9004,2,0),
    entry(9005,2,0),entry(9006,2,0),entry(9007,2,0),
    {...entry(9911,2,0),score:0}, {...entry(11741,2,1),progress:3,score:85}]}));
  const mapping = [[9001,1,0],[9002,1,0],[9003,2,0],[9005,1,3],[9006,0,0],[9007,1,2]].map(([id,season,offset]) =>
    ({anilist_id:id,themoviedb_id:{tv:showId},season:{tmdb:season},episode_offset:{tmdb:offset}}));
  mapping.push({anilist_id:9004,themoviedb_id:{movie:[300]}});
  // Use the published join keys and verified IDs. Every title, count and provider reply is fictional.
  mapping.push({anilist_id:9911,themoviedb_id:{tv:correctedId},season:{tmdb:1}},
    {anilist_id:11741,themoviedb_id:{tv:correctedId},season:{tmdb:1},episode_offset:{tmdb:13}});
  const dates = [['2013-01-01'],['2014-01-01','2014-01-08','2014-01-15','2099-01-01'],['2015-01-01'],['2016-01-01',null]];
  const fixtures = new Map([['raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-mini.json',mapping],
    ['api.themoviedb.org/3/tv/45',{id:showId,name:title,status:'Ended',keywords:{results:[]},external_ids:{},
      seasons:dates.map((episodes,n) => ({season_number:n,name:n ? 'Season '+n : 'Specials',episode_count:episodes.length})),
      last_episode_to_air:{season_number:3,episode_number:1,air_date:'2016-01-01'}}]]);
  for (const [n,season] of dates.entries()) {
    fixtures.set('api.themoviedb.org/3/tv/45/season/'+n,{season_number:n,name:'Season '+n,
      episodes:season.map((air_date,j) => ({id:n*100+j+1,name:'Episode '+(j+1),season_number:n,episode_number:j+1,air_date}))});
  }
  const firstRun = Array.from({length:16},(_,i)=>[79000+i,'First run '+(i+1)]);
  const secondRun = [[1061698,'A Door at Dusk'],[99000,'Unrelated broadcast'],[1061699,'West Window'],[1061700,'Before Sunrise']];
  const target = 'api.themoviedb.org/3/tv/'+correctedId;
  fixtures.set(target,{id:correctedId,name:correctedTitle,status:'Ended',keywords:{results:[]},external_ids:{},
    seasons:[firstRun,secondRun].map((eps,i)=>({season_number:i+1,name:'Season '+(i+1),episode_count:eps.length})),
    last_episode_to_air:{season_number:2,episode_number:4,air_date:'2016-01-01'}});
  fixtures.set(target+'/aggregate_credits',{id:correctedId,cast:[]});
  fixtures.set(target+'/recommendations',{page:1,total_pages:0,results:[]});
  for (const [i,episodes] of [firstRun,secondRun].entries()) {
    fixtures.set(target+'/season/'+(i+1),{season_number:i+1,name:'Season '+(i+1),
      episodes:episodes.map(([id,name],j)=>({id,name,season_number:i+1,episode_number:j+1,air_date:'2016-01-01'}))});
  }
  async function intercept(message,send) {
    const url = new URL(message.request.url), response = fixtures.get(url.hostname+url.pathname);
    if (response === undefined || message.request.method !== 'GET') return provider.respond(message,send);
    await send('Fetch.fulfillRequest',{requestId:message.requestId,responseCode:200,
      responseHeaders:[{name:'Content-Type',value:'application/json'},{name:'Access-Control-Allow-Origin',value:origin}],
      body:Buffer.from(JSON.stringify(response)).toString('base64')});
  }
  const editor = '[data-count-review="45"]', summary = editor+' [data-count-summary]';
  const q = selector => 'document.querySelector('+JSON.stringify(selector)+')';
  async function preview() {
    await browser.navigate(origin+'/#/anilist-import');
    const picker = 'input[type=file]:enabled';
    await browser.waitFor(q(picker));
    const {root} = await browser.send('DOM.getDocument');
    const {nodeId} = await browser.send('DOM.querySelector',{nodeId:root.nodeId,selector:picker});
    await browser.send('DOM.setFileInputFiles',{nodeId,files:[file]});
    await browser.waitFor(q(summary));
    assert.equal(await browser.evaluate(q(summary)+'.getAttribute("aria-expanded")'),'false');
    assert.equal(await browser.evaluate('document.querySelectorAll("[data-count-review]").length'),1);
    assert.equal(await browser.evaluate(q(editor)+' .querySelector(".count-season, [data-anilist-review-notice]") === null'),true);
    await browser.click(editor+' [data-whole-add]');
    await browser.evaluate(q(summary)+'.focus()');
    await browser.press('Enter');
    assert.equal(await browser.evaluate(q(editor+' [data-season-count="1"]')+'.textContent'),'2×');
    await browser.click(editor+' [data-whole-remove]');
    await browser.evaluate(q(summary)+'.focus()');
    await browser.press('Space');
    await browser.press('Enter');
    assert.equal(await browser.evaluate(q(editor+' [data-season-count="1"]')+'.textContent'),'1×');
    assert.equal(await browser.evaluate(q(editor+' [data-season-count="0"]')+' === null'),true);
    assert.equal(await browser.evaluate('document.querySelectorAll("[data-anilist-review-notice]").length'),2);
    assert.ok(await browser.evaluate('document.querySelector("[data-preview]").textContent.includes("Mapped to a film")'));
    const report = '[data-import-report="AniList season matches"]';
    await browser.click(report+' summary');
    await browser.waitFor(q(report)+'?.textContent.includes("AniList entry 11741")');
    const corrected = await browser.evaluate(`Array.from(document.querySelectorAll('${report} li > strong'))
      .find(el => el.textContent === ${JSON.stringify(correctedTitle)}).nextElementSibling.textContent`);
    assert.ok(corrected.includes('AniList entry 9911 · 1 of 1 reported episode placedTMDB season 1 · E1'),corrected);
    assert.ok(corrected.includes('AniList entry 11741 · 3 of 3 reported episodes placedTMDB season 2 · E1, E3–4'),corrected);
  }
  async function correctCounts() {
    const placed = q('.import-totals > div:nth-child(2) dd');
    const firstSeason = q(editor+' [data-season-count="1"]')+'.textContent';
    assert.equal(await browser.evaluate(placed+'.textContent'),'9');
    assert.equal(await browser.evaluate(firstSeason),'1×');
    await browser.click(editor+' [data-whole-add]');
    assert.equal(await browser.evaluate(firstSeason),'2×');
    await browser.click(editor+' [data-season-add="1"]');
    await browser.waitFor(placed+'.textContent === "10"');
    assert.equal(await browser.evaluate(firstSeason),'3×');
    await browser.click(editor+' [data-season-remove="1"]');
    await browser.waitFor(placed+'.textContent === "9"');
    assert.equal(await browser.evaluate(firstSeason),'2×');
    await browser.click(editor+' [data-season-add="1"]');
    await browser.click(editor+' [data-season-add="1"]');
    await browser.click(editor+' [data-season-remove="1"]');
    await browser.click(editor+' [data-whole-remove]');
    assert.equal(await browser.evaluate(q(editor+' [data-season-count="2"]')+'.textContent'),'1×');
    await browser.click(editor+' [data-whole-add]');
    await browser.click(editor+' [data-season-add="3"]');
    await browser.waitFor(q(editor+' [data-season-count="3"]')+'?.textContent === "1×"');
    assert.equal(await browser.evaluate(q(editor+' [data-season-count="2"]')+'.textContent'),'2×');
    assert.equal(await browser.evaluate(q(summary)+'.getAttribute("aria-expanded")'),'true');
  }
  const recordFiles = ['watched','ratings','lists'];
  async function waitForRecordSync(revisions) {
    await browser.waitFor(`(async () => {
      const {openDeviceStore} = await import('/storage.js');
      const {tableMatchesDropboxBase} = await import('/dropbox-sync-file.js');
      const store = await openDeviceStore();
      try {
        const snapshot = await store.snapshot(), expected = ${JSON.stringify(revisions ?? {})};
        return ${JSON.stringify(recordFiles)}.every(table => snapshot.sync[table]?.base?.revision &&
          tableMatchesDropboxBase(snapshot,table) &&
          (!expected[table] || snapshot.sync[table].base.revision === expected[table]));
      } finally { store.close(); }
    })()`, 'committed watch, rating and list files for this profile');
  }
  async function confirm() {
    await browser.click('[data-apply]');
    await browser.waitFor(q('[data-status]')+'?.textContent.includes("Import complete")');
    await browser.waitFor(q('.sync-state')+'?.dataset.synced === "true"');
    await waitForRecordSync();
    return provider.files.get('/watched.csv');
  }
  const counts = rows => rows.filter(r=>r.show_id===showId).map(r=>[r.episode_id,r.times_watched]).sort(([a],[b])=>a-b);
  const correctedWatches = rows => rows.filter(r=>r.show_id===correctedId)
    .map(r=>[r.season,r.episode,r.episode_id,r.title,r.times_watched]).sort((a,b)=>a[0]-b[0] || a[1]-b[1]);
  const expectedCorrection = [[1,1,79000,'First run 1',1],[2,1,1061698,'A Door at Dusk',2],
    [2,3,1061699,'West Window',2],[2,4,1061700,'Before Sunrise',2]];
  browser = await openChromium(join(folder,'importing'),intercept);
  await linkFixture(browser,origin,'/');
  await preview();
  await correctCounts();
  const first = await confirm();
  const expected = [[1,2],[101,4],[102,1],[103,3],[104,2],[201,2],[301,1]];
  const ratings = rows => rows.map(row=>[row.show_id,row.rating]).sort(([a],[b])=>a-b);
  const lists = rows => rows.map(row=>[row.show_id,row.list]).sort(([a],[b])=>a-b);
  const expectedRatings = [[showId,7.5],[correctedId,8.5]], expectedLists = [[showId,'Anime'],[correctedId,'Anime']];
  assert.deepEqual(counts(readCsv('watched',first.bytes).rows),expected);
  assert.deepEqual(correctedWatches(readCsv('watched',first.bytes).rows),expectedCorrection);
  assert.deepEqual(ratings(readCsv('ratings',provider.files.get('/ratings.csv').bytes).rows),expectedRatings);
  assert.deepEqual(lists(readCsv('lists',provider.files.get('/lists.csv').bytes).rows),expectedLists);
  const remoteRevisions = Object.fromEntries(recordFiles.map(table=>[table,provider.files.get('/'+table+'.csv').meta.rev]));
  await browser.close();
  browser = await openChromium(join(folder,'fresh'),intercept);
  await linkFixture(browser,origin,'/');
  await browser.navigate(origin+'/#/library');
  await browser.waitFor(q('.library-grid')+'?.textContent.includes('+JSON.stringify(correctedTitle)+') && '+
    q('.library-grid')+'.textContent.includes('+JSON.stringify(title)+')');
  // Watched rows can already be visible while the same sync is still downloading ratings and lists.
  await waitForRecordSync(remoteRevisions);
  const record = await browser.evaluate(`(async () => {
    const {openDeviceStore} = await import('/storage.js');
    const store = await openDeviceStore();
    try { return await store.overviewRows(); } finally { store.close(); }
  })()`);
  assert.deepEqual(counts(record.watched),expected);
  assert.deepEqual(correctedWatches(record.watched),expectedCorrection);
  assert.deepEqual(ratings(record.ratings),expectedRatings);
  assert.deepEqual(lists(record.lists),expectedLists);
  await browser.navigate(origin+'/#/show/'+correctedId+'/season/2');
  await browser.waitFor(q('[data-season-focus="episode-4-count"]')+'?.textContent === "2×"');
  const badges = await browser.evaluate('Array.from(document.querySelectorAll(".season-episodes .episode-count"),n=>n.textContent)');
  assert.deepEqual(badges,['2×','0×','2×','2×']);
  await preview();
  await correctCounts();
  const repeated = await confirm();
  assert.deepEqual(counts(readCsv('watched',repeated.bytes).rows),expected);
  assert.deepEqual(correctedWatches(readCsv('watched',repeated.bytes).rows),expectedCorrection);
  assert.equal(repeated.meta.rev,first.meta.rev);
});
