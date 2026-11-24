import { connectFixtureProviders, replaceFixtureSettings } from './provider-fixture-cases.mjs';
import { openDeviceStore } from '../dist/storage.js';
import { MalGithubClient, MalService } from '../dist/mal-service.js';
import { ImdbGithubClient } from '../dist/imdb-github.js';
import { ImdbService } from '../dist/imdb-service.js';
import { TmdbService } from '../dist/tmdb-service.js';
import { tmdbResourceKey } from '../dist/tmdb-client.js';
import { fetchAniListMapping } from '../dist/anilist-mapping.js';

const check = (ok,message) => { if (!ok) throw Error(message); };
const day = 86_400_000;
const csv = 'show,season,offset,mal_id,score\n25,1,,1,8.26\n25,1,10,2,7.50\n26,,,3,6.98\n';
const gzip = text => new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
const config = {mal_source:'github',imdb_source:'github',github_token:'fictional-shared-token',github_repo:'sample/ratings'};

async function fixture(exercise) {
  const name = 'MyAnimeList fixture '+crypto.randomUUID();
  const files = {mal:await gzip(csv), imdb:await gzip('show,season,episode,rating\n1,,,8.1\n')};
  const log = [];
  const env = {time:Date.now(), isOnline:true,isVisible:true,now(){return this.time;},online(){return this.isOnline;},visible(){return this.isVisible;}};
  const f = {env,files,log, respond:async job=>new Response(files[job]), name,
    async open() {
      this.close();
      this.store = await openDeviceStore({name}); await connectFixtureProviders(this.store,name);
      this.tmdb = new TmdbService(this.store,undefined,env);
      const options = {now:()=>env.time, fetch:async (url,init) => {
        const job = url.searchParams.get('ref') === 'mal-data' ? 'mal' : 'imdb';
        log.push([job,String(url),init]);
        return this.respond(job);
      }};
      this.mal = new MalService(this.tmdb,new MalGithubClient(options));
      this.imdb = new ImdbService(this.tmdb,{github:new ImdbGithubClient(options)});
    },
    close() {this.mal?.close(); this.imdb?.close(); this.tmdb?.close(); this.store?.close();},
    async settings(values=config) {
      await replaceFixtureSettings(this.store,name,Object.entries(values).map(([setting,value])=>({setting,value})));
    }};
  try {await f.open(); await exercise(f);}
  finally {f.close(); indexedDB.deleteDatabase(name);}
}

export async function malStorageCases(run) {
  await run('Leaving while an optional score lookup is reading stops all follow-up requests and preserves the next visit',()=>fixture(async f=>{
    await f.settings({...config,tmdb_key:'fictional-index-key'}); await f.mal.refreshFile();
    await f.store.commit((await f.store.snapshot()).revision,{put:{shows:[
      {show_id:25,show:'Fictional Orchard',year:null,imdb_id:'tt0000025'},
    ]}});
    const now=f.env.time, external=tmdbResourceKey({kind:'external-ids',id:26});
    check(await f.store.writeTmdb((await f.store.tmdbState()).generation,{entries:{
      [external]:{fetchedAt:now,value:{imdbId:'tt0000026'}},
    }}),'Could not seed the fallback IMDb identity');
    const lookup=(id,signal)=>f.store.imdbIdentities([id],now,undefined,undefined,undefined,signal);
    async function cancelAt(storeName,key,read) {
      const controller=new AbortController(), get=IDBObjectStore.prototype.get;
      let selected=false, late=0, outcome;
      IDBObjectStore.prototype.get=function(requestKey) {
        if (this.transaction.db.name!==f.name) return get.call(this,requestKey);
        if (controller.signal.aborted) late++;
        const request=get.call(this,requestKey);
        if (!selected && this.name===storeName && requestKey===key) {
          selected=true;
          request.addEventListener('success',()=>controller.abort(),{once:true});
        }
        return request;
      };
      try {
        try {await read(controller.signal);} catch (error) {outcome=error.name;}
        await new Promise(resolve=>setTimeout(resolve,0));
      } finally {IDBObjectStore.prototype.get=get;}
      check(selected && outcome==='AbortError' && !late,'Cancellation at '+storeName+' '+key+' issued '+late+' late reads and returned '+outcome);
    }
    await cancelAt('settings','mal_source',signal=>f.store.malEntries([25],signal));
    await cancelAt('settings','imdb_source',signal=>f.store.imdbDisplayState(signal,{id:25,now}));
    await cancelAt('tmdb',tmdbResourceKey({kind:'show',id:25}),signal=>lookup(25,signal));
    await cancelAt('shows',26,signal=>lookup(26,signal));
    const identities=await f.store.imdbIdentities([25,26],now);
    check((await f.store.malEntries([25])).get(25)?.[0].score===8.26 &&
      (await f.store.imdbDisplayState(undefined,{id:25,now})).imdbId==='tt0000025' &&
      identities.get(25)==='tt0000025' && identities.get(26)==='tt0000026','A canceled read affected the next visit');
  }));
  await run('Both ratings jobs preserve their earliest matching file observation after a clock correction and restart',()=>fixture(async f=>{
    await f.settings();
    const correctedTime = f.env.time;
    f.env.time += 30*day;
    await f.imdb.refreshFile(); await f.mal.refreshFile();
    f.env.time = correctedTime;
    await f.open();
    await f.imdb.refreshFile(); await f.mal.refreshFile();
    for (const service of [f.imdb,f.mal]) {
      check((await service.status()).fetchedAt === correctedTime,'A file dated in the future was treated as fresh');
    }
    f.env.time += 7*day+1;
    await f.open();
    for (const service of [f.imdb,f.mal]) {
      await service.refreshFile();
      check((await service.status()).unchangedSince === correctedTime,'An unchanged file retained a future first date');
    }
  }));
  await run('The MAL job reads one fixed raw file, persists its bytes and entry index atomically, and refreshes after seven days',()=>fixture(async f=>{
    await f.mal.refreshFile(true);
    let lookups=0;
    const get=IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get=function(key) {
      if (this.name==='cache' && Array.isArray(key) && key[0]==='mal') lookups++;
      return get.apply(this,arguments);
    };
    try {
      check(!f.log.length && !(await f.mal.read([25,26])).size && !lookups,'Default source queried the job or showed job data');
    } finally {IDBObjectStore.prototype.get=get;}
    await f.settings();
    const revision = (await f.store.snapshot()).revision;
    await Promise.all([f.mal.refreshFile(), f.mal.refreshFile()]);
    const [[job,url,init]] = f.log;
    check(job === 'mal' && f.log.length === 1 && url === 'https://api.github.com/repos/sample/ratings/contents/mal-ratings.csv.gz?ref=mal-data' &&
      init.method === 'GET' && init.redirect === 'error' && init.credentials === 'omit' && init.cache === 'no-store' &&
      init.referrerPolicy === 'no-referrer' && new Headers(init.headers).get('Authorization') === 'Bearer '+config.github_token &&
      new Headers(init.headers).get('Accept') === 'application/vnd.github.raw+json' && !init.body,'Unexpected GitHub request');
    const original = await f.mal.status(), [entry] = (await f.mal.read([26])).get(26);
    check(original.entryCount === 3 && original.fetchedAt === f.env.time && entry.score === 6.98 &&
      (await f.store.snapshot()).revision === revision,'File metadata or personal revision changed unexpectedly');
    const persisted = await f.store.cacheValue(['mal','file']);
    check(persisted instanceof ArrayBuffer && new Uint8Array(persisted).toString() === new Uint8Array(await f.files.mal.arrayBuffer()).toString(),'Raw gzip changed');
    await f.open(); f.env.isOnline = false;
    await f.mal.refreshFile(true);
    check((await f.mal.status()).message.includes('offline') && (await f.mal.read([25])).get(25)[1].score === 7.5 &&
      f.log.length===1,'Offline restart lost data or sent another request');
    f.env.isOnline = true; f.env.time += 7*day; await f.mal.refreshFile();
    check(f.log.length===1,'A file exactly seven days old was fetched again');
    f.env.time++; await f.mal.refreshFile();
    const checked = await f.mal.status();
    check(f.log.length===2 && checked.unchangedSince===original.fetchedAt && checked.entryCount===3 &&
      checked.fetchedAt===f.env.time && (await f.mal.read([26])).get(26)[0].score===6.98,
      'Rechecking an identical file changed the saved index, count or verification dates');
    await f.mal.configure('github_repo','sample/missing'); f.respond=async()=>new Response(null,{status:404});
    await f.mal.refreshFile();
    check(f.log[2][1].includes('/sample/missing/') && (await f.mal.status()).message.includes('404') &&
      (await f.mal.read([25])).get(25).length===2,'A repository failure deleted the last good index');
    f.respond=async()=>new Response('invalid-file'); await f.mal.refreshFile(true);
    check((await f.mal.status()).message.includes('200') && (await f.mal.status()).entryCount===3,'Invalid data replaced the last file');
    await f.mal.configure('github_token',null); await f.mal.refreshFile(true);
    check(f.log.length===4 && (await f.mal.read([25])).size===1,'Removing token deleted the prior index or sent a request');
    await f.mal.configure('mal_source',null); await f.open();
    check(!(await f.mal.read([25])).size && !await f.store.cacheValue(['mal','file']) && !await f.store.cacheValue(['mal','show',25]),
      'Returning to MDBList left file bytes or scores behind');
  }));

  await run('A refused or limited GitHub token pauses both jobs through restart, and a manual retry or elapsed quota resumes the shared queue',()=>fixture(async f=>{
    await f.settings();
    const began=Promise.withResolvers(), release=Promise.withResolvers();
    f.respond=async()=>{began.resolve();await release.promise;return new Response(null,{status:401});};
    const mal=f.mal.refreshFile(); await began.promise;
    const imdb=f.imdb.refreshFile();
    release.resolve(); await Promise.all([mal,imdb]);
    check(f.log.map(([job])=>job).join() === 'mal' && (await f.mal.status()).refused && (await f.imdb.status()).refused,
      'A second request escaped the 401');
    await f.open(); await Promise.all([f.mal.refreshFile(),f.imdb.refreshFile()]);
    check(f.log.length===1,'Opening the app cleared a refusal');
    f.respond=async job=>new Response(f.files[job]); await f.imdb.refreshFile(true); await f.mal.refreshFile();
    check(f.log.map(([job])=>job).join() === 'mal,imdb,mal' && !(await f.mal.status()).refused && (await f.mal.status()).entryCount===3,
      'Manual IMDb refresh did not clear the shared refusal');
    f.respond=async()=>new Response(null,{status:429,headers:{'Retry-After':'45'}});
    await f.imdb.refreshFile(true); await f.mal.refreshFile(true);
    const deadline=f.env.time+45_000;
    check(f.log.length===4 && (await f.mal.status()).retryAt===deadline && (await f.imdb.status()).retryAt===deadline,
      'Refresh now escaped a live shared rate limit');
    const map = response => fetchAniListMapping(new Set([9]),undefined,async()=>response,{store:f.store,now:()=>f.env.time});
    const mapping = await map(Response.json([{anilist_id:9,themoviedb_id:{tv:25}}]));
    check(mapping.get(9)?.showId===25,'Authenticated quota blocked the anonymous file host');
    let limited = false;
    try {await map(new Response(null,{status:429,headers:{'Retry-After':'120'}}));}
    catch(error) {limited=error.message.includes('limiting downloads');}
    check(limited && (await f.imdb.status()).retryAt===deadline,'Anonymous file limit changed the credential quota');
    await f.mal.configure('github_repo','sample/second'); await f.open(); await f.mal.refreshFile(true);
    check(f.log.length===4,'Changing repository reset the shared token quota');
    f.env.time=deadline; f.respond=async job=>new Response(f.files[job]); await f.mal.refreshFile(true);
    check(f.log.length===5 && !(await f.imdb.status()).retryAt,'A successful MAL probe left the IMDb queue blocked');
    check((await f.store.mappingGate()).until > f.env.time,'An authenticated success cleared the anonymous limit');
  }));

  await run('Obsolete downloads cannot restore removed MAL data or refuse replacement credentials, while both jobs honor a still-current shared token',()=>fixture(async f=>{
    await f.settings();
    for (const action of ['switch','repo','erase']) {
      const began=Promise.withResolvers(), release=Promise.withResolvers();
      f.respond=async()=>{began.resolve();await release.promise;return new Response(null,{status:401});};
      const work=f.mal.refreshFile(true); await began.promise;
      const old=(await f.mal.status()).generation;
      if (action==='switch') await f.mal.configure('mal_source',null);
      if (action==='repo') {
        await f.imdb.configure('github_repo','sample/change');
        await f.imdb.configure('github_repo',config.github_repo);
      }
      if (action==='erase') {await f.store.eraseDevice((await f.store.snapshot()).revision);await f.settings();}
      let stale=false;
      try {await f.mal.configure('github_token','stale-editor',old);} catch {stale=true;}
      check(stale,'Obsolete settings editor remained valid');
      release.resolve(); await work;
      check((await f.imdb.status()).refused === (action==='switch') && !(await f.mal.read([25])).size,
        'Source, repository or device change accepted the wrong scope of a late refusal');
      if (action==='switch') {
        f.respond=async job=>new Response(f.files[job]); await f.imdb.refreshFile(true);
        await f.mal.configure('mal_source','github');
      }
    }
  }));

  await run('A failed MAL index write rolls back the complete replacement after reopening, and clearing rebuildable storage fences a late success',()=>fixture(async f=>{
    await f.settings(); await f.mal.refreshFile();
    const original=await f.mal.status(), newer=await gzip(csv.replace('8.26','9.91'));
    f.env.time+=day; f.respond=async()=>new Response(newer);
    const put=IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put=function(value,key) {
      if (this.name==='cache' && Array.isArray(key) && key[0]==='mal' && key[2]===26) throw new DOMException('Fictional full disk','QuotaExceededError');
      return put.apply(this,arguments);
    };
    let failed=false; try {await f.mal.refreshFile(true);} catch (error) {failed=error.name==='QuotaExceededError';}
    finally {IDBObjectStore.prototype.put=put;}
    await f.open();
    check(failed && (await f.mal.status()).fetchedAt===original.fetchedAt && (await f.mal.read([25])).get(25)[0].score===8.26,
      'An incomplete transaction changed the file after reopening');
    await f.mal.refreshFile(true);
    check((await f.mal.read([25])).get(25)[0].score===9.91 && !(await f.mal.status()).unchangedSince,'Retry failed to replace the old file');
    const began=Promise.withResolvers(),release=Promise.withResolvers();
    f.respond=async()=>{began.resolve();await release.promise;return new Response(newer);};
    const work=f.mal.refreshFile(true); await began.promise; await f.store.clearRebuildableCaches(); release.resolve(); await work;
    check(!(await f.mal.read([25])).size && !(await f.mal.status()).fetchedAt && (await f.mal.status()).source==='github',
      'A pending download crossed cache cleanup, or cleanup deleted the configured source');
  }));
}
