// Compare the prior CSV round trip to retaining validated rows on the first download.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {listen,stop,testSite} from './offline-site.mjs';

async function compareFirstSync({roundTrip,count,stageOnly}) {
  const [{openDeviceStore},{DropboxSync},{dropboxContentHash},{writeCsv},{SyncFiles},{emptyTables}] = await Promise.all([
    'storage','dropbox-sync','dropbox-api','csv','dropbox-sync-file','model',
  ].map(name=>import('/tracker/'+name+'.js')));
  const watched = Array.from({length:count},(_,i)=>({show_id:Math.floor(i/144)+1,show:'Fictional station '+Math.floor(i/144),
    season:1+Math.floor(i%144/12),episode:1+i%12,title:'Fictional episode '+i,episode_id:i+1,times_watched:1+i%4}));
  const storeName = 'csvtv-fictional-merge-'+crypto.randomUUID();
  const device = stageOnly ? null : await openDeviceStore({name:storeName});
  try {
    await device?.whenWriter();
    const session = {accountId:'fictional-owner',instanceId:'fictional-device',accessToken:'fictional-access',
      refreshToken:'fictional-refresh',accessExpiresAt:Date.now()+3600000,signInDeadline:Date.now()+86400000,providerExpiresAt:Date.now()+86400000};
    await device?.storeExchangedSession(session);
    const cloud = new Map();
    for (const table of ['watched','ratings','lists','settings']) {
      const path = '/'+table+'.csv', bytes = new TextEncoder().encode(writeCsv(table,table==='watched' ? watched : []));
      const stamp = '2026-10-01T12:00:00Z';
      cloud.set(path,{bytes,metadata:{path,name:path.slice(1),kind:'file',rev:'r1',size:bytes.length,
        clientModified:stamp,serverModified:stamp,contentHash:await dropboxContentHash(bytes)}});
    }
    const api = {list:async()=>[...cloud.values()].map(file=>file.metadata),download:async path=>cloud.get(path)??null,
      upload:async()=>{throw Error('First download unexpectedly changed cloud rows');},revisions:async()=>[]};
    if (stageOnly) {
      let saved;
      const store = {commit:async (_revision,patch)=>{saved=patch;}};
      const files = new SyncFiles(store,api,session,Date.now);
      const snapshot = {revision:1n,tables:emptyTables(),sync:{},local:{dropboxSession:session,syncAccountId:session.accountId}};
      const remote = cloud.get('/watched.csv'), text = new TextDecoder().decode(remote.bytes);
      const start = performance.now();
      await files.prepare('watched',snapshot,roundTrip ? writeCsv('watched',watched) : {rows:watched},remote.metadata,text);
      const prepareMs = Math.round(performance.now()-start);
      if (saved?.sync.watched.base.content!==text || saved.replace.watched.length!==count || writeCsv('watched',saved.replace.watched)!==text) {
        throw Error('Prepared rows differ');
      }
      return {prepareMs};
    }
    const engine = new DropboxSync(device,api,session);
    const prepare = engine.files.prepare.bind(engine.files);
    let prepareStart, preparationMs, persistence;
    function beginWrite(method) {
      if (prepareStart === undefined) return;
      preparationMs = performance.now()-prepareStart;
      persistence = method;
      prepareStart = undefined;
    }
    engine.files.prepare = (table,snapshot,source,...args) => {
      if (table==='watched') prepareStart = performance.now();
      if (roundTrip && typeof source !== 'string') source = writeCsv(table,source.rows);
      return prepare(table,snapshot,source,...args);
    };
    const commit = device.commit.bind(device), install = device.installWatchDownload.bind(device);
    device.commit = (...args)=>{
      if (args[1].replace?.watched) beginWrite('transaction');
      return commit(...args);
    };
    device.installWatchDownload = (...args)=>{
      beginWrite('watched-download');
      return install(...args);
    };
    const start = performance.now(), result = await engine.run(), elapsed = performance.now()-start;
    if (!result.complete) throw Error('Unfinished watched.csv merge');
    if (!Number.isFinite(preparationMs)) throw Error('No watched-file persistence measurement was recorded');
    const stored = await device.snapshot();
    if (stored.tables.watched.length!==count || stored.sync.watched.pending ||
        writeCsv('watched',stored.tables.watched)!==new TextDecoder().decode(cloud.get('/watched.csv').bytes)) throw Error('Saved rows differ');
    return {prepareMs:Math.round(preparationMs),syncMs:Math.round(elapsed),persistence};
  } finally {
    if (device) {
      await device.closeForUpdate();
      await new Promise((resolve,reject)=>{
        const request=indexedDB.deleteDatabase(storeName); request.onsuccess=resolve; request.onerror=()=>reject(request.error);
      });
    }
  }
}

const engine=process.argv[2], count=Number(process.argv[3]??43200);
const measurement=process.argv[4]??'storage';
assert.ok(['chromium','webkit'].includes(engine));
assert.ok(['stage','storage'].includes(measurement));
assert.ok(Number.isSafeInteger(count) && count>=100 && count<=50000);
const playwright=createRequire(import.meta.url)(process.env.CSVTV_PLAYWRIGHT_MODULE||'playwright-core');
const {server,manifest}=await testSite(), origin='http://127.0.0.1:'+await listen(server);
let browser;
try {
  browser=await playwright[engine].launch({headless:true,proxy:{server:origin,bypass:'127.0.0.1,localhost'},
    ...(engine==='chromium'?{channel:'chrome'}:{})});
  const page=await browser.newPage();
  await page.goto(origin+'/fixture');
  // Alternate the order in consecutive pairs. Each pass starts in its own empty database.
  for (const roundTrip of [true,false,false,true,true,false,false,true]) {
    const result=await page.evaluate(compareFirstSync,{roundTrip,count,stageOnly:measurement==='stage'});
    console.log(JSON.stringify({build:manifest.build,engine,count,measurement,method:roundTrip?'roundtrip':'retain',...result}));
  }
} finally { try {await browser?.close();} finally {await stop(server);} }
