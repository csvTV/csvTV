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
import {traktZip} from './trakt-fixture-cases.mjs';

test('Matched seasons can exceed the Trakt total and manual seasons survive reimport and recovery in a fresh Library', {timeout:90000}, async t => {
  const release = await createRelease(new URL('../dist/',import.meta.url));
  const server = releaseServer(await unpack(release.bytes));
  const origin = 'http://127.0.0.1:' + await listen(server);
  const folder = await mkdtemp(join(tmpdir(),'csvtv-season-release-'));
  let browser;
  t.after(async () => {
    try { await browser?.close(); }
    finally { await stop(server); await rm(folder,{recursive:true,force:true,maxRetries:5,retryDelay:100}); }
  });
  const provider = offlineProviders(origin);
  await provider.settings({tmdb_key:'fictional-offline-key'});
  const title = 'Midnight Greenhouse', series = {title,ids:{tmdb:45}};
  const history = [[1,1],[1,2],[1,2],[2,1]].map(([season,number]) =>
    ({type:'episode',show:series,episode:{season,number,ids:{tmdb:season*1000+number}}}));
  const zip = await traktZip({'watched-history-1.json':history,'watched-shows.json':[{show:series,plays:5}]});
  const path = join(folder,zip.name);
  await writeFile(path,Buffer.from(await zip.arrayBuffer()));
  let missingSeasonReads = 0;
  async function transport(message,send) {
    const uri = new URL(message.request.url);
    if(uri.hostname !== 'api.themoviedb.org' || message.request.method !== 'GET' ||
        !['/3/tv/45','/3/tv/45/season/1','/3/tv/45/season/2','/3/tv/45/season/4'].includes(uri.pathname)) {
      return provider.respond(message,send);
    }
    const n = Number(uri.pathname.split('/')[5]);
    if(n===4)missingSeasonReads++;
    const seasons = new Map([[1,{aired:3,total:5}],[2,{aired:1,total:1}],[4,{aired:52,total:54}]]);
    const season = seasons.get(n);
    const value = n ? {season_number:n,name:'Season '+n,poster_path:null,
      episodes:Array.from({length:season.total},(_,i)=>({show_id:45,season_number:n,episode_number:i+1,
        id:n*1000+i+1,name:'Episode '+(i+1),
        air_date:i<season.aired?'2001-01-01':i===season.aired?'2099-01-01':null}))}
      : {id:45,name:title,status:'Ended',last_episode_to_air:{season_number:4,episode_number:52,air_date:'2001-01-01'},
        seasons:Array.from(seasons,([number,info])=>({season_number:number,name:'Season '+number,episode_count:info.total})),
        keywords:{results:[]},external_ids:{}};
    await send('Fetch.fulfillRequest',{requestId:message.requestId,responseCode:200,
      responseHeaders:[{name:'Access-Control-Allow-Origin',value:origin},{name:'Content-Type',value:'application/json'}],
      body:Buffer.from(JSON.stringify(value)).toString('base64')});
  }
  const q = selector => 'document.querySelector('+JSON.stringify(selector)+')';
  const summary='[data-count-summary]', add='[data-season-add="4"]', remove='[data-season-remove="4"]';
  const report='[data-import-report="Episode placements"]', manual='[data-season-count="4"]';
  const seasonCount = n => browser.evaluate(q('[data-season-count="'+n+'"]')+'.innerText');
  const difference = () => browser.evaluate(q(summary+' .count-gap')+'.innerText');
  async function preview() {
    await browser.navigate(origin+'/#/trakt-import');
    await browser.waitFor(q('input[type=file]')+'?.disabled === false');
    const {root} = await browser.send('DOM.getDocument');
    const {nodeId} = await browser.send('DOM.querySelector',{nodeId:root.nodeId,selector:'input[type=file]'});
    await browser.send('DOM.setFileInputFiles',{nodeId,files:[path]});
    await browser.waitFor(q(summary));
    await browser.click(summary);
    assert.equal(await browser.evaluate(q(manual)+'.innerText'),'0×');
  }
  async function adjustMatchedSeason() {
    // The two matched episodes have one and two plays. A third aired episode is absent from history.
    // Its fourth and fifth episodes have future and unknown air dates.
    const increase = '[data-season-add="1"]';
    assert.equal(await seasonCount(1),'1×');
    await browser.click(increase);
    assert.equal(await seasonCount(1),'2×');
    assert.equal(await difference(),'2 plays above Trakt’s total of 5');
    await browser.click(increase);
    assert.equal(await seasonCount(1),'3×');
    assert.equal(await difference(),'5 plays above Trakt’s total of 5');
    await browser.click('[data-season-remove="1"]');
    assert.equal(await seasonCount(1),'2×');
    assert.equal(await seasonCount(2),'1×');
    assert.equal(await seasonCount(4),'0×');
  }
  async function confirm() {
    await browser.click('[data-apply]');
    await browser.waitFor(q('[data-status]')+'?.textContent.includes("Import complete")');
    await browser.waitFor(q('.sync-state')+'?.dataset.synced==="true"');
    return readCsv('watched',provider.files.get('/watched.csv').bytes).rows;
  }
  const waitRows = length => browser.waitFor('document.querySelectorAll('+JSON.stringify(report+' li')+').length === '+length);
  const proposedCount = () => browser.evaluate(q('.import-totals > div:nth-child(2) dd')+'.innerText');
  browser = await openChromium(join(folder,'importing'),transport);
  await linkFixture(browser,origin,'/');
  await preview();
  await adjustMatchedSeason();
  assert.equal(missingSeasonReads,0);
  await browser.click(report+' summary');
  await browser.click(add);
  await waitRows(50);
  assert.equal(missingSeasonReads,1);
  assert.equal(await proposedCount(),'56');
  await browser.click(report+' button');
  await waitRows(56);
  await browser.click(remove);
  await waitRows(4);
  assert.equal(await proposedCount(),'4');
  assert.ok(await browser.evaluate(q(report)+'.open'));
  await browser.click(add);
  await waitRows(56);
  await browser.click(add);
  await browser.click('[data-whole-add]');
  assert.equal(await browser.evaluate(q(manual)+'.innerText'),'2×');
  assert.equal(await difference(),'109 plays above Trakt’s total of 5');
  assert.equal(missingSeasonReads,1);
  const rows = await confirm();
  const expected = [[1,1,1001,3],[1,2,1002,4],[1,3,1003,1],[2,1,2001,2],...Array.from({length:52},(_,i)=>[4,i+1,4001+i,2])];
  const tuples = entries => entries.map(r=>[r.season,r.episode,r.episode_id,r.times_watched])
    .sort((a,b)=>a[0]-b[0] || a[1]-b[1]);
  assert.deepEqual(tuples(rows),expected);
  const watchedRevision = provider.files.get('/watched.csv').meta.rev;
  await browser.close();
  browser = await openChromium(join(folder,'fresh'),transport);
  await linkFixture(browser,origin,'/');
  await browser.navigate(origin+'/#/library');
  await browser.waitFor('document.querySelector("#app")?.innerText.includes('+JSON.stringify(title)+')');
  const reopened = await browser.evaluate(`(async () => {
    const {openDeviceStore} = await import('/storage.js');
    const store = await openDeviceStore();
    try { return (await store.overviewRows()).watched; } finally { store.close(); }
  })()`);
  assert.deepEqual(tuples(reopened),expected);
  await preview();
  await adjustMatchedSeason();
  await browser.click(add); await browser.waitFor(q(manual)+'.innerText==="1×"');
  await browser.click(add); await browser.click('[data-whole-add]');
  assert.deepEqual(tuples(await confirm()),expected);
  assert.equal(provider.files.get('/watched.csv').meta.rev,watchedRevision);
});
