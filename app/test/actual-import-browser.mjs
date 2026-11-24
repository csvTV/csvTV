import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {importActualFile} from './dropbox-live/actual-import-screen.mjs';
import {verifyActualPreview} from './dropbox-live/actual-import-preview.mjs';
import {readPageRecord,verifyRecordScreens} from './dropbox-live/actual-import-verify.mjs';
import {linkFixture,offlineProviders} from './offline-providers.mjs';
import {listen,stop} from './offline-site.mjs';
import {releaseServer,unpack} from './release-site.mjs';
import {traktZip} from './trakt-fixture-cases.mjs';

// This optional rehearsal uses Playwright Core like the live-export probe.
// Chrome loads the release ZIP from localhost. Every provider reply is fictional.
test('The actual-export driver checks every preview page, retained ratings and a repeat import', {timeout:120000}, async t=>{
  const {chromium}=createRequire(import.meta.url)(process.env.CSVTV_PLAYWRIGHT_MODULE || 'playwright-core');
  const directory=await mkdtemp(join(tmpdir(),'csvtv-import-rehearsal-'));
  const server=releaseServer(await unpack(await readFile(new URL('../release/csvTV.zip',import.meta.url))));
  const origin='http://127.0.0.1:'+await listen(server);
  let browser;
  t.after(async()=>{
    try { await browser?.close(); }
    finally { await stop(server); await rm(directory,{recursive:true,force:true}); }
  });
  browser=await chromium.launch({headless:true,...(process.env.CSVTV_BROWSER?{executablePath:process.env.CSVTV_BROWSER}:{channel:'chrome'}),
    args:['--disable-background-networking','--disable-sync','--no-proxy-server','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost']});
  const page=await browser.newPage(), cdp=await page.context().newCDPSession(page);
  const cloud=offlineProviders(origin);
  await cloud.settings({tmdb_key:'fictional-offline-key'});
  const episodes=Array.from({length:1002},(_,i)=>({id:70000+i,episode_number:i+1,season_number:1,
    name:'Fictional episode '+(i+1),runtime:24,air_date:'2014-02-03'}));
  const responses=new Map([
    ['api.themoviedb.org/3/tv/45/season/1',{season_number:1,name:'Season 1',episodes}],
    ['raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-mini.json',
      [{anilist_id:9001,themoviedb_id:{tv:45},season:{tmdb:1},episode_offset:{tmdb:0}}]],
  ]);
  await cdp.send('Fetch.enable',{patterns:['*.dropboxapi.com','api.themoviedb.org','raw.githubusercontent.com'].map(h=>({urlPattern:'https://'+h+'/*'}))});
  const errors=[];
  cdp.on('Fetch.requestPaused',message=>{
    const url=new URL(message.request.url), fixture=responses.get(url.hostname+url.pathname);
    const task=fixture && message.request.method==='GET' ? cdp.send('Fetch.fulfillRequest',{requestId:message.requestId,responseCode:200,
      responseHeaders:[{name:'Access-Control-Allow-Origin',value:origin},{name:'Content-Type',value:'application/json'}],
      body:Buffer.from(JSON.stringify(fixture)).toString('base64')}) : cloud.respond(message,(m,p)=>cdp.send(m,p));
    task.catch(error=>{if (!String(error.message).includes('Invalid InterceptionId')) errors.push(error);});
  });
  await linkFixture({navigate:href=>page.goto(href),evaluate:expr=>page.evaluate(expr)},origin,'/');
  const show={title:'The Listening House',ids:{tmdb:45}};
  const history=episodes.map(e=>({type:'episode',id:e.id,show,episode:{ids:{tmdb:e.id},season:1,number:e.episode_number,title:e.name}}));
  const zip=await traktZip({'watched-history-1.json':history,'watched-shows.json':[{show,plays:2004}],
    'ratings-shows.json':[{type:'show',show,rating:8}],'lists-watchlist.json':[{type:'show',show}]});
  const paths={Trakt:join(directory,'fictional.zip'),AniList:join(directory,'fictional.json')};
  await writeFile(paths.Trakt,new Uint8Array(await zip.arrayBuffer()));
  await writeFile(paths.AniList,JSON.stringify({lists:[{series_type:0,series_id:9001,status:3,score:70,progress:2,repeat:1}],
    favourites:[{favourite_id:9001,favourite_type:1}]}));
  async function run(source) {
    await page.goto(origin+'/#/settings');
    await page.waitForFunction(()=>document.querySelector('[data-cloud-reason]')?.textContent==='Synced');
    return (await importActualFile(page,{source,file:paths[source]})).summary;
  }
  const trakt=await run('Trakt');
  assert.equal(trakt.newEpisodes,1002); assert.equal(trakt.playsAdded,'1002');
  assert.equal(trakt.optionalCountCorrections,1); assert.equal(trakt.addedRatings,1);
  const ani=await run('AniList');
  assert.equal(ani.droppedShows,1);
  assert.equal(ani.placedEpisodes,2); assert.equal(ani.playsAdded,'2');
  assert.equal(ani.reviewNotices,1); assert.equal(ani.countDiscrepancies,0); assert.equal(ani.optionalCountCorrections,1);
  assert.equal(ani.differingRatings,1); assert.equal(ani.keptRatings,1); assert.equal(ani.addedMemberships,1);
  const again=await run('AniList');
  assert.equal(again.droppedShows,1);
  assert.equal(again.newEpisodes,0); assert.equal(again.playsAdded,'0'); assert.equal(again.addedMemberships,0);
  assert.equal(again.existingMemberships,1); assert.equal(again.addedRatings,0);
  await verifyRecordScreens(page,await readPageRecord(page));
  assert.deepEqual(errors,[]);
});

test('Mismatched private preview values fail without printing the details',()=>{
  const preview={expected:{shows:[],episodes:[],ratings:['Private fixture title · Add 7/10'],lists:[]},
    summary:{newEpisodes:0,playsAdded:'0',addedRatings:1,addedMemberships:0}};
  const before={watched:[],ratings:[],lists:[],shows:[]};
  const after={...before,ratings:[{show_id:1,show:'Private fixture title',rating:9}]};
  assert.throws(()=>verifyActualPreview(preview,before,after),e=>e.message==='A reviewed rating did not match the committed record.');
});
