import { connectFixtureProviders, replaceFixtureSettings } from './provider-fixture-cases.mjs';
import {openDeviceStore} from '../dist/storage.js';
import {TmdbService} from '../dist/tmdb-service.js';
import {TmdbClient,tmdbResourceKey} from '../dist/tmdb-client.js';
import {cacheExpiresAt} from '../dist/tmdb-refresh.js';
import {ImdbService} from '../dist/imdb-service.js';
import {ImdbGithubClient} from '../dist/imdb-github.js';
import {indexImdbEpisodes} from '../dist/ratings-worker-client.js';
import {OmdbClient} from '../dist/omdb-client.js';
import {MdbListService} from '../dist/mdblist-service.js';

const day = 86_400_000;
const check = (ok,message) => { if (!ok) throw Error(message); };
const imdb = id => 'tt' + String(id).padStart(7,'0');
const show = id => ({show_id:id,show:'Fictional series '+id,year:2020,imdb_id:imdb(id)});
const gzip = async text => new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
const data = 'show,season,episode,rating\n1,,,8.2\n2,,,6.3\n3,1,1,7.5\n1,1,1,6.80\n1,1,1,6.8\n1,1,2,5.5\n1,1,2,9\n1,1,2,5.5\n1,2,1,7.9\n';
let largerFile;
function largeJobFile() {
  if (!largerFile) {
    const rows=[data.trimEnd()];
    for (let id=100;id<40_100;id++) rows.push(id+',,,7.2');
    largerFile=gzip(rows.join('\n')+'\n');
  }
  return largerFile;
}
async function fixture(exercise) {
  const name = 'IMDb fixture ' + crypto.randomUUID(), blob = await gzip(data);
  const env = {time:Date.now(),isOnline:true,isVisible:true, now(){return this.time;},online(){return this.isOnline;},visible(){return this.isVisible;}};
  const calls = {tmdb:[],omdb:[],github:[]};
  const response = {
    github:async()=>new Response(blob),
    tmdb:async id=>Response.json({id,imdb_id:imdb(id)}),
    sleep:ms=>new Promise(resolve=>setTimeout(resolve,ms)),
    omdb:async(id,season)=>Response.json(season === null ?
      {Response:'True',Type:'series',imdbID:id,imdbRating:'8.2'} :
      {Response:'True',Season:season,Episodes:[{Episode:'1',imdbRating:'8.7'},{Episode:'2',imdbRating:'N/A'}]}),
  };
  const target = {name,env,calls,response, async reopen() {
    this.service?.close(); this.tmdb?.close(); this.store?.close();
    const store = await openDeviceStore({name}); await connectFixtureProviders(store,name);
    const tmdb = new TmdbService(store,new TmdbClient({sleep:ms=>response.sleep(ms),fetch:async url=>{
      const path = url.pathname, number = Number(path.match(/\/tv\/(\d+)\/external_ids$/)?.[1]);
      check(!!number,'Unexpected title request');
      calls.tmdb.push(number); return response.tmdb(number);
    }}),env);
    const omdb = new OmdbClient({now:()=>env.time,fetch:async url=>{
      const id=url.searchParams.get('i'), season=url.searchParams.get('Season');
      calls.omdb.push([id,season]); return response.omdb(id,season);
    }});
    const github = new ImdbGithubClient({now:()=>env.time,fetch:async (url,init)=>{
      calls.github.push(url.pathname); return response.github(url,init);
    }});
    Object.assign(this,{store,tmdb,service:new ImdbService(tmdb,{omdb,github})});
  }, async set(settings) {
    await replaceFixtureSettings(this.store,name,Object.entries(settings).map(([setting,value])=>({setting,value})));
  }, async seed(ids) {
    await this.store.commit((await this.store.snapshot()).revision,{put:{shows:ids.map(show)}});
  }};
  try {await target.reopen(); await exercise(target);}
  finally {target.service?.close(); target.tmdb?.close(); target.store?.close(); indexedDB.deleteDatabase(name);}
}
export async function imdbStorageCases(run) {
  await run('A full IMDb bucket replacement rejects a hidden background write and confirms one complete file after a lost success reply',()=>fixture(async f=>{
    const token='fictional-wide-index-key';
    await f.seed([1,2]);await f.set({imdb_source:'github',github_token:token,github_repo:'fictional/wide'});
    await f.service.refreshFile(true);
    const prior=await f.store.imdbState(),before=(await f.store.snapshot()).revision;
    const outside=['mal','show',1];
    await f.store.cache(outside,[{season:1,score:8.5}]);
    const lines=['show,season,episode,rating'];
    for(let n=1;n<=512;n++)lines.push(n+',,,'+(n===1?'9.3':'7.5'));
    lines.push('1,1,1,8.7','1,1,2,9','1,1,2,4');
    const blob=await gzip(lines.join('\n')+'\n');f.response.github=async()=>new Response(blob);
    let mode='hidden',started=0,admitted=0;
    const Native=Worker;
    globalThis.Worker=class extends Native {
      constructor(url,options) {
        check(url.pathname.endsWith('/github-index-worker.js'),'Unexpected worker for a small compressed file and a wide IMDb index');
        super(url,options);started++;
        this.addEventListener('message',event=>{
          if(event.data.type==='admission'&&mode==='hidden')f.env.isVisible=false;
          if(event.data.type==='complete'&&mode==='lost'){
            event.stopImmediatePropagation();this.dispatchEvent(new ErrorEvent('error',{cancelable:true}));
          }
        });
      }
      postMessage(message,...rest) {
        if(message.type==='admit')admitted++;
        if(message.write)check(message.source==='imdb' && message.write.replacement.buckets.size===256 &&
          !JSON.stringify(message,(_,v)=>typeof v==='bigint'?String(v):v instanceof Map?[...v]:v).includes(token),'Unexpected worker payload');
        super.postMessage(message,...rest);
      }
    };
    try {
      f.env.time+=8*day;await f.service.refreshFile();
      check((await f.store.imdbState()).file.digest===prior.file.digest && (await f.service.readShows([1])).get(1)===8.2,
        'An interrupted installation changed the saved file');
      f.env.isVisible=true;mode='lost';
      f.response.github=async()=>new Response(null,{status:401});await f.service.refreshFile(true);
      check((await f.store.malState()).githubPause?.kind==='refused','The shared GitHub refusal was not recorded');
      f.response.github=async()=>new Response(blob);await f.service.refreshFile(true);
      check(admitted===1&&started===2,'A lost reply published more than once or an interrupted write was admitted');
      const state=await f.store.imdbState(), current=await f.store.cacheValue(['imdb','github','file']);
      check(state.file.digest!==prior.file.digest && state.file.showCount===512 && state.file.episodeCount===3 &&
        !state.githubPause && !(await f.store.malState()).githubPause &&
        String(new Uint8Array(current))===String(new Uint8Array(await blob.arrayBuffer())),'File identity, counts, bytes or shared pause differed');
      await f.reopen();
      const season=await f.service.readSeason(1,1);
      check((await f.store.snapshot()).revision===before && (await f.store.cacheValue(outside))[0].score===8.5 &&
        (await f.service.readShows([1])).get(1)===9.3 && season.get(1)===8.7 && !season.has(2),
        'Reopening lost a score, restored a conflict, touched MAL or changed the record');
    } finally { globalThis.Worker=Native; }
  }));
  await run('A native ratings worker validates a large job file and returns only the requested season index',async()=>{
    const file = await largeJobFile();
    check(file.size >= 64*1024,'The fixture did not exercise the large-file path');
    const NativeWorker = globalThis.Worker;
    let started = 0, ended = 0, replies = 0;
    globalThis.Worker = class extends NativeWorker {
      constructor(url,options) {
        super(url,options);
        check(url.pathname.endsWith('/ratings-worker.js'),'Unexpected worker module');
        started++;
        this.addEventListener('message',event=>{ if ('result' in event.data) replies++; });
      }
      terminate() { ended++; super.terminate(); }
    };
    try {
      const github = new ImdbGithubClient({fetch:async()=>new Response(file)});
      const download = await github.download('fictional/ratings','fictional-credential');
      check(download.shows.size===40_002 && download.episodeCount===7,'The full series index lost rows');
      const result = await indexImdbEpisodes(file,1);
      check(result.size===2 && result.get(1).get(1)===6.8 && !result.get(1).has(2) && result.get(2).get(1)===7.9,
        'The worker returned another series or resolved a disputed position');
      check(started===2 && replies===2 && ended===2,'The large-file reads fell back or left a worker active');
    } finally { globalThis.Worker = NativeWorker; }
  });
  await run('Leaving a season releases its score job only when its last viewer leaves',()=>fixture(async f=>{
    const file=await largeJobFile();
    f.response.github=async()=>new Response(file);
    await f.seed([1,3,4]); await f.set({imdb_source:'github',github_token:'fictional',github_repo:'fictional/ratings'});
    await f.service.refreshFile(true);
    const Native=globalThis.Worker, requests=new Map([1,3,4].map(id=>[id,Promise.withResolvers()]));
    let ended=0, lookups=0;
    globalThis.Worker=class {
      postMessage({show}) { requests.get(show).resolve(this); }
      terminate() { ended++; }
    };
    const values=f.store.imdbValues.bind(f.store), both=Promise.withResolvers();
    f.store.imdbValues=async(generation,keys,...rest)=>{
      const result=await values(generation,keys,...rest);
      if (keys[0]?.join('/')==='imdb/github/episodes/1/2' && ++lookups===2) both.resolve();
      return result;
    };
    try {
      const leaving=new AbortController(), reason=Error('Fictional route closed');
      const one=f.service.readSeason(1,1,leaving.signal), two=f.service.readSeason(1,2);
      const [worker]=await Promise.all([requests.get(1).promise,both.promise]);
      await new Promise(resolve=>setTimeout(resolve,0));
      leaving.abort(reason);
      const rejected=await one.then(()=>false,error=>error===reason);
      check(rejected && !ended,'One viewer canceled the shared worker for the other season');
      worker.onmessage({data:{result:new Map([[2,new Map([[1,7.9]])]])}});
      check((await two).get(1)===7.9 && ended===1,'The remaining viewer did not receive the completed index');
      const three=f.service.readSeason(3,1), four=f.service.readSeason(4,1);
      const [stale]=await Promise.all([requests.get(3).promise,requests.get(4).promise]);
      await f.service.configure('imdb_source','none');
      stale.onmessage({data:{result:new Map([[1,new Map([[1,7.5]])]])}});
      check(!(await three).size,'A score arrived after its source was removed');
      f.service.close();
      check(!(await four).size && ended===3,'Closing the service left a worker running');
      const {generation}=await f.store.imdbDisplayState();
      const cached=await f.store.imdbValues(generation,[3,4].map(id=>['imdb','github','episodes',id,2]));
      check(cached.every(row=>row===undefined),'An interrupted index reached storage');
    } finally { globalThis.Worker=Native; }
  }));
  await run('Displaying cached show and season scores leaves Dropbox sessions and provider credentials unopened',()=>fixture(async f=>{
    await f.set({imdb_source:'omdb',omdb_key:'fictional-omdb',mdblist_key:'fictional-critics'});
    await f.seed([7]);
    await f.service.refreshShows([7]);
    await f.service.refreshSeason(7,1);
    const critics=new MdbListService(f.store,undefined,f.env);
    const {generation}=await f.store.mdbListState();
    const scores={tomatoes:74,metacritic:null,myanimelist:null};
    check(await f.store.writeMdbList(generation,{entries:new Map([[7,{fetchedAt:f.env.time,scores}]])}),'Critic fixture was not saved');
    const original=IDBObjectStore.prototype.get, reads=[];
    try {
      IDBObjectStore.prototype.get=function(key) {
        if (this.name==='local' && key==='dropboxSession' || this.name==='settings' && ['github_repo','github_token','omdb_key','mdblist_key'].includes(key))
          reads.push([this.name,key]);
        return original.apply(this,arguments);
      };
      for (const offline of [false,true]) {
        if (offline) {f.store.clearProviderKeys(); f.env.isOnline=false;}
        const [series,season,other,status]=await Promise.all([f.service.readShows([7]),f.service.readSeason(7,1),critics.read([7]),f.service.sourceStatus()]);
        check(series.get(7)===8.2 && season.get(1)===8.7 && other.get(7)?.tomatoes===74,'An available cached score disappeared');
        check(status.source==='omdb' && !status.refused && !('repository' in status) && !('hasToken' in status),'A viewing screen received the private Settings status');
      }
      check(!reads.length,'Displaying ratings opened private settings or the Dropbox session: '+JSON.stringify(reads));
    } finally { IDBObjectStore.prototype.get=original; critics.close(); }
  }));
  await run('Large series score and external-ID lookups bound key probes and read only requested values',()=>fixture(async f=>{
    await f.set({imdb_source:'omdb',omdb_key:'fictional',tmdb_key:'fictional'});
    const all = IDBObjectStore.prototype.getAll, get = IDBObjectStore.prototype.get;
    const configReads = [];
    let configurations;
    try {
      IDBObjectStore.prototype.getAll = function(...args) {
        if (this.name==='settings') throw Error('A ratings status check requested all settings');
        return all.apply(this,args);
      };
      IDBObjectStore.prototype.get = function(...args) {
        if (this.name==='settings') configReads.push(args[0]);
        return get.apply(this,args);
      };
      configurations = await Promise.all([f.store.imdbState(),f.store.malState()]);
    } finally { IDBObjectStore.prototype.getAll=all; IDBObjectStore.prototype.get=get; }
    check(configReads.sort().join() === 'github_repo,github_repo,imdb_source,mal_source' &&
      configurations[0].config.omdb_key==='fictional' && configurations[1].config.github_token===null,
      'A provider status read opened unrelated settings or lost its relevant credential');
    const ids = Array.from({length:72},(_,i)=>i+1), now = f.env.time;
    const key = id => ['imdb','omdb',imdb(id)];
    const {generation} = await f.store.imdbState();
    check(await f.store.writeImdb(generation,{entries:ids.map(id=>[key(id),{id}])}),'Could not seed show scores');
    const entries = {};
    for (const id of ids) {
      for (let season=1;season<=5;season++) entries[tmdbResourceKey({kind:'season',id,season})] =
        {fetchedAt:now,value:{show_id:id,season,episodes:[]}};
      if (id===3 || id===70) entries[tmdbResourceKey({kind:'external-ids',id})] = {fetchedAt:now,value:{imdbId:imdb(id)}};
    }
    check(await f.store.writeTmdb((await f.store.tmdbState()).generation,{entries}),'Could not seed external-ID neighbours');
    const requested = [...ids].reverse().concat(500,3), calls = {tmdb:0,cache:0}, limits = [], returned = [];
    const methods = ['get','getAll','getAllKeys'], proto = IDBObjectStore.prototype, saved = new Map();
    try {
      for (const method of methods) {
        const original = proto[method];saved.set(method,original);
        proto[method] = function(...args) {
          const request = original.apply(this,args);
          if (Object.hasOwn(calls,this.name)) {
            calls[this.name]++;
            if (method==='getAllKeys') limits.push(args[1]);
            else if (this.name==='tmdb') request.addEventListener('success',()=>{
              for (const row of method==='get' ? [request.result] : request.result) if (row) returned.push(row.value);
            });
          }
          return request;
        };
      }
      const scores = await f.store.imdbValues(generation,requested.map(key));
      check(requested.every((id,i)=>scores[i]?.id===(id===500?undefined:id)) && calls.cache<=4,
        'Dense series scores should take a bounded set of reads and retain duplicate and missing positions');
      const external = await f.store.imdbExternalEntries(requested,new AbortController().signal);
      check(external.size===2 && returned.length===2 && returned.every(row=>row.imdbId===imdb(3)||row.imdbId===imdb(70)) && calls.tmdb<=8,
        'Searching for sparse external identities loaded an unrelated season or issued individual reads for missing IDs');
      check(limits.length>=2 && limits.every(n=>Number.isSafeInteger(n)&&n>0&&n<=513),'A cache key probe was unbounded');
    } finally { for (const [method,original] of saved) proto[method] = original; }
  }));
  await run('Batched score reads preserve duplicate, absent and mixed compound keys and exclude unrequested values',()=>fixture(async f=>{
    await f.set({imdb_source:'omdb',omdb_key:'fictional'});
    const {generation} = await f.store.imdbState();
    const key = value => ['imdb','omdb',value];
    const entries = Array.from({length:260},(_,i)=>[key(i),{id:i}]);
    entries.push([key('12'),{id:'12'}],[key(imdb(1)),{at:f.env.time,value:{rating:8}}]);
    check(await f.store.writeImdb(generation,{entries}),'Could not seed the fictional score cache');
    const ids = [250,0,'12',600,3,...Array.from({length:28},(_,i)=>230-i),0,250];
    const wanted = new Set(ids), seen = [], original = {};
    const prototype = IDBObjectStore.prototype;
    for (const method of ['get','getAll']) {
      original[method] = prototype[method];
      prototype[method] = function(...args) {
        const request = original[method].apply(this,args);
        if (this.name === 'cache') request.addEventListener('success',()=>{
          for (const row of method==='get' ? [request.result] : request.result) if (row) seen.push(row.id);
        });
        return request;
      };
    }
    let rows;
    try { rows = await f.store.imdbValues(generation,ids.map(key)); }
    finally { for (const [name,method] of Object.entries(original)) prototype[name] = method; }
    check(seen.length && seen.every(id=>wanted.has(id)),'A sparse range loaded an unrequested score value');
    check(rows.length===ids.length && ids.every((id,i)=>rows[i]?.id === (id===600 ? undefined : id)),
      'Missing, duplicate, mixed-type or unordered results changed position');
    check(!(await f.store.imdbValues(generation+1n,ids.map(key))).length,'A stale score generation returned results');
    const headers = new Map([[1,{fetchedAt:f.env.time,value:{show_id:1,imdbId:imdb(1)}}]]);
    check((await f.service.readShows([1],undefined,async()=>headers)).get(1)===8,'The original provider score was unavailable');
    let entered, release;
    const started = new Promise(resolve=>{ entered = resolve; }), held = new Promise(resolve=>{ release = resolve; });
    const pending = f.service.readShows([1],undefined,async () => {
      entered(); await held;
      return headers;
    });
    await started;
    await f.set({imdb_source:'github',github_repo:'fictional/change',github_token:'fictional'});
    release();
    check(!(await pending).size,'A delayed shared identity published a score from the previous provider source');
  }));
  await run('Known IMDb headers avoid index reads while retaining external-ID expiry and fallback precedence',()=>fixture(async f=>{
    await f.set({tmdb_key:'fictional'});
    const ids = Array.from({length:60},(_,i)=>i+1), now = f.env.time;
    await f.seed([...ids,91]);
    const entries = {};
    const cache = (kind,id,imdbId,age=0) => {
      entries[tmdbResourceKey({kind,id})] = {fetchedAt:now-age,value:imdbId===null ? null : {imdbId}};
    };
    for (const id of ids) cache('show',id,imdb(1000+id));
    cache('external-ids',1,imdb(3001),day);
    cache('show',91,null); cache('external-ids',91,imdb(3091));
    cache('show',92,imdb(1092),220*day); cache('external-ids',92,imdb(3092));
    cache('external-ids',93,null);
    cache('show',95,imdb(1095),-day);
    check(await f.store.writeTmdb((await f.store.tmdbState()).generation,{entries}),'Could not seed IMDb identities');
    const prototype = IDBObjectStore.prototype, previous = new Map();
    let indexReads = 0, total = 0;
    for (const name of ['get','getAll','getAllKeys']) {
      const original = prototype[name]; previous.set(name,original);
      prototype[name] = function(...args) {
        if (this.name === 'shows' || this.name === 'tmdb') total++;
        if (this.name === 'shows') indexReads++;
        return original.apply(this,args);
      };
    }
    const deadlines = [];
    try {
      const found = await f.store.imdbIdentities(ids,now,expiry=>deadlines.push(expiry));
      check(ids.every(id=>found.get(id) === imdb(1000+id)) && indexReads === 0 && total < 70,
        '60 known header identities reread the committed index or redundant external IDs: '+indexReads+' index, '+total+' total');
      check(deadlines.length === 61 && Math.min(...deadlines) === cacheExpiresAt(now-day),
        'An unused but retained external ID lost its earlier expiry');
      const header = (id,age=0) => ({fetchedAt:now-age,value:{show_id:id,imdbId:imdb(2000+id)}});
      const shared = new Map(ids.map(id=>[id,header(id)]));
      shared.delete(2);
      shared.set(3,header(3,220*day)); shared.set(4,header(4,-day)); shared.set(5,header(499));
      const reusedDeadlines = [];
      total = 0;
      const reused = await f.store.imdbIdentities(ids,now,at=>reusedDeadlines.push(at),shared);
      check(ids.every(id=>reused.get(id)===imdb((id>=2 && id<=5 ? 1000 : 2000)+id)) && total < 20,
        'Missing, expired, future or mismatched shared headers must fall back to the current TMDB identity');
      check(Math.min(...reusedDeadlines)===cacheExpiresAt(now-day),'Reused headers lost the external-ID expiry');
      const controller = new AbortController(), overlappedDeadlines = [];
      const external = await f.store.imdbExternalEntries(ids,controller.signal);
      total = 0;
      const overlapped = await f.store.imdbIdentities(ids,now,at=>overlappedDeadlines.push(at),shared,external);
      check(ids.every(id=>overlapped.get(id)===reused.get(id)) && total===4,
        'Shared external IDs should only reread the four missing or invalid title headers');
      check(overlappedDeadlines.length===reusedDeadlines.length && Math.min(...overlappedDeadlines)===cacheExpiresAt(now-day),
        'Parallel identity lookup lost a retained source deadline');
      controller.abort();
      check(await f.store.imdbExternalEntries(ids,controller.signal).then(()=>false,error=>error.name==='AbortError'),
        'A disposed report should not start an external-ID read');
      total = 0;
      await f.store.imdbIdentities(ids,now);
      check(indexReads === 0 && total === ids.length,'An identity lookup without a deadline read losing sources');
      total = 0;
      const disabled=await f.store.imdbDisplayState(undefined,{id:1,now});
      check(disabled.source==='none' && disabled.imdbId===null && total===0,'The disabled source opened show or external-ID rows');
    } finally { for (const [name,method] of previous) prototype[name] = method; }
    for (const observe of [undefined,()=>{}]) {
      const fallback = await f.store.imdbIdentities([91,92,93,94,95],now,observe);
      check(fallback.get(91) === imdb(91) && fallback.get(92) === imdb(3092) && fallback.get(93) === null &&
        !fallback.has(94) && !fallback.has(95),'Filed IDs, external IDs, known absence or expiry changed precedence');
    }
    await f.set({tmdb_key:'fictional',imdb_source:'github',github_repo:'fictional/private',github_token:'fictional'});
    const positions=[1,91,92,93,94,95];
    const identities=await f.store.imdbIdentities(positions,now);
    for (const id of positions) {
      const state=await f.store.imdbDisplayState(undefined,{id,now});
      check(state.source==='github' && state.imdbId===(identities.get(id)??null),
        'Season and series disagreed on the identity for '+id);
    }
  }));
  await run('A recorded show numbered zero keeps its linked IMDb score across a restart',()=>fixture(async f=>{
    await f.store.commit((await f.store.snapshot()).revision,{put:{shows:[{...show(0),imdb_id:imdb(1)}]}});
    await f.set({imdb_source:'omdb',omdb_key:'fictional',tmdb_key:'fictional'});
    await f.service.refreshShows([0]);
    check((await f.service.readShows([0])).get(0)===8.2 && !f.calls.tmdb.length,'OMDb missed the recorded identifier');
    await f.set({imdb_source:'github',github_token:'fictional',github_repo:'fictional/ratings'});
    await f.service.refreshFile(true);
    await f.reopen(); f.env.isOnline = false;
    check((await f.service.readShows([0])).get(0)===8.2 && (await f.service.readSeason(0,1)).get(1)===6.8,
      'Local show zero lost its offline show or episode score');
  }));
  await run('An IMDb ID outside the job’s integer range leaves other offline Library ratings readable',()=>fixture(async f=>{
    await f.seed([1]);
    const rows = [show(2),show(3)].map((row,index)=>({...row,imdb_id:'tt' + (index ? '9'.repeat(310) : '9007199254740992')}));
    await f.store.commit((await f.store.snapshot()).revision,{put:{shows:rows}});
    await f.set({imdb_source:'github',github_token:'fictional',github_repo:'fictional/ratings'});
    await f.service.refreshFile(true);
    await f.reopen(); f.env.isOnline = false;
    const scores = await f.service.readShows([2,1,3]);
    check(scores.size === 1 && scores.get(1) === 8.2,'An out-of-range ID prevented reading other scores');
    for (const row of rows) check(!(await f.service.readSeason(row.show_id,1)).size,'Unindexable season received ratings');
  }));
  await run('OMDb uses recorded IMDb IDs and caches external IDs, missing ratings and whole seasons across reopening',()=>fixture(async f=>{
    await f.seed([1]);
    await f.set({tmdb_key:'fictional'});
    await f.service.refreshShows([1,2]);
    check(!f.calls.tmdb.length && !f.calls.omdb.length,'None sent an outside request');
    await f.set({tmdb_key:'fictional',imdb_source:'omdb',omdb_key:'fictional-omdb'});
    const missing = f.response.omdb;
    f.response.omdb = (id,season) => id === imdb(3) ? Response.json({Response:'False',Error:'Movie not found!'}) : missing(id,season);
    await f.service.refreshShows([1,2,3]);
    await Promise.all([f.service.refreshSeason(1,1),f.service.refreshSeason(1,1)]);
    const scores = await f.service.readShows([1,2,3]), season = await f.service.readSeason(1,1);
    check(scores.size === 2 && scores.get(1) === 8.2 && season.size === 1 && season.get(1) === 8.7,'Wrong scores');
    check(f.calls.tmdb.join(',') === '2,3' && f.calls.omdb.length === 4,'Expected two ID-only lookups and four OMDb calls');
    await f.reopen(); f.env.time += 7*day;
    await f.service.refreshShows([1,2,3]); await f.service.refreshSeason(1,1);
    check(f.calls.omdb.length === 4 && f.calls.tmdb.length === 2,'Fresh scores or misses were retried');
    f.env.time++; await f.service.refreshShows([1,2,3]); await f.service.refreshSeason(1,1);
    check(f.calls.omdb.length === 8 && f.calls.tmdb.length === 2,'Stale scores or misses did not refresh correctly');
    await f.service.configure('omdb_key',null); await f.reopen();
    check(!(await f.service.readShows([1,2])).size && !(await f.service.readSeason(1,1)).size,'Rating survived key removal');
  }));
  await run('An older OMDb season stays available offline and revalidates episode identities on its next online visit',()=>fixture(async f=>{
    await f.seed([1]); await f.set({imdb_source:'omdb',omdb_key:'fictional'});
    const key=['imdb','omdb',imdb(1),1];
    const legacy={at:f.env.time,value:{rating:null,episodes:new Map([[1,9],[2,7.5]])}};
    check(await f.store.writeImdb((await f.store.imdbState()).generation,{entries:[[key,legacy]]}),'Legacy seed failed');
    f.env.isOnline=false; await f.reopen(); await f.service.refreshSeason(1,1);
    check((await f.service.readSeason(1,1)).get(2)===7.5&&!f.calls.omdb.length,'Legacy offline display or lookup changed');
    f.env.isOnline=true;
    f.response.omdb=async()=>{throw new TypeError('Fictional disconnected transfer');};
    await f.service.refreshSeason(1,1);
    f.response.omdb=async()=>new Response(null,{status:401});
    await f.service.refreshSeason(1,1);
    await f.reopen(); await f.service.refreshSeason(1,1);
    const [stillLegacy]=await f.store.imdbValues((await f.store.imdbState()).generation,[key]);
    check(!stillLegacy.checkedEpisodeIds && stillLegacy.at===legacy.at && f.calls.omdb.length===2 &&
      (await f.service.readSeason(1,1)).get(2)===7.5,'A failed transfer or refused key validated or replaced a legacy season');
    f.env.time+=day;
    f.response.omdb=async()=>Response.json({Response:'True',Season:'1',Episodes:[
      {Episode:'1',imdbID:imdb(901),imdbRating:'6.1'},{Episode:'1',imdbID:imdb(902),imdbRating:'9.0'},
      {Episode:'2',imdbID:imdb(903),imdbRating:'7.8'}]});
    await f.service.refreshSeason(1,1);
    const actual=await f.service.readSeason(1,1);
    check(actual.size===1&&actual.get(2)===7.8&&f.calls.omdb.length===3,'The successful online visit retained legacy episode assignments');
    await f.reopen(); await f.service.refreshSeason(1,1);
    check(f.calls.omdb.length===3&&!(await f.service.readSeason(1,1)).has(1),'A revalidated season was retried or lost its resolution');
  }));
  await run('OMDb discards an interrupted background score and retains the shared key’s quota response',()=>fixture(async f=>{
    await f.seed([1,2,3]); await f.set({imdb_source:'omdb',omdb_key:'fictional'});
    for(const [id,interruption] of [[1,'hidden'],[2,'offline'],[3,'quota']]){
      const started=Promise.withResolvers(),release=Promise.withResolvers();
      f.response.omdb=async()=>{started.resolve();await release.promise;
        if(interruption==='quota')return new Response(null,{status:429,headers:{'Retry-After':'12'}});
        return Response.json({Response:'True',Type:'series',imdbID:imdb(id),imdbRating:'8.1'});};
      const pending=f.service.refreshShows([id],true);await started.promise;
      if(interruption==='offline')f.env.isOnline=false;else f.env.isVisible=false;
      release.resolve(); await pending;
      check(!(await f.service.readShows([id])).has(id),'Accepted a background score after '+interruption);
      f.env.isOnline=f.env.isVisible=true;
      if(interruption==='quota')check((await f.service.status()).retryAt===f.env.time+12000,'Lost a quota response on hiding');
    }
    await f.reopen();
    check(!(await f.service.readShows([1,2,3])).size && (await f.service.status()).retryAt===f.env.time+12000,
      'Interrupted scores or quota changed on reopening');
  }));
  await run('OMDb persists refusal and quota holds and allows only one expiry probe across concurrent lookup queues',()=>fixture(async f=>{
    await f.seed([1,2]); await f.set({imdb_source:'omdb',omdb_key:'fictional-A'});
    f.response.omdb = async()=> Response.json({Response:'False',Error:'Invalid API key!'},{status:401});
    await Promise.all([f.service.refreshShows([1,2]),f.service.refreshSeason(1,0)]);
    check(f.calls.omdb.length===1 && (await f.service.status()).retryAt===f.env.time+day,'Refusal did not hold every request for a day');
    await f.reopen(); await f.service.refreshShows([1]);
    check(f.calls.omdb.length===1 && (await f.service.status()).message === 'Invalid API key!','Refusal lost on reload');
    await f.service.configure('omdb_key','fictional-B');
    f.response.omdb = async()=>new Response(null,{status:429,headers:{'Retry-After':'10'}});
    await f.service.refreshShows([1,2]); await f.service.configure('omdb_key','fictional-C'); await f.service.configure('omdb_key','fictional-B');
    check((await f.service.status()).retryAt===f.env.time+10000,'Reused key escaped its service deadline');
    f.env.time += 10000;
    const started = Promise.withResolvers(), finish = Promise.withResolvers();
    f.response.omdb = async()=>{started.resolve(); await finish.promise; throw Error('offline');};
    const queue = Promise.all([f.service.refreshShows([1,2]),f.service.refreshSeason(1,2)]);
    await started.promise; check(f.calls.omdb.length===3,'More than one probe admitted'); finish.resolve(); await queue;
    check(f.calls.omdb.length===3 && (await f.service.status()).retryAt>f.env.time,'Failed probe released the queue');
  }));
  await run('Disabling IMDb during a TMDB identity backoff cancels the retry and the pending OMDb show request',()=>fixture(async f=>{
    await f.set({tmdb_key:'fictional',imdb_source:'omdb',omdb_key:'fictional-key'});
    const started = Promise.withResolvers(), release = Promise.withResolvers();
    f.response.tmdb = async()=>new Response(null,{status:503});
    f.response.sleep = async()=>{started.resolve();await release.promise;};
    const load = f.service.refreshShows([31]);
    await started.promise;
    await f.service.configure('imdb_source',null);
    release.resolve();
    await load;
    check(f.calls.tmdb.length===1 && !f.calls.omdb.length,'An IMDb identity lookup retried after None was selected');
  }));
  await run('Changing an inactive credential fences old editors while preserving an in-flight quota for the active provider',()=>fixture(async f=>{
    await f.seed([1,2]);
    for (const source of ['omdb','github']) {
      await f.set({imdb_source:source,omdb_key:'fictional-A',github_token:'fictional-T',github_repo:'fictional/one'});
      const sending = Promise.withResolvers(), release = Promise.withResolvers();
      const before = f.calls[source].length;
      f.response[source] = async()=>{sending.resolve(); await release.promise;
        return new Response(null,{status:429,headers:{'Retry-After':'45'}});};
      const load = () => source === 'github' ? f.service.refreshFile(true) : f.service.refreshShows([1,2]);
      const first = load();
      await sending.promise;
      const editor = (await f.service.status()).generation;
      const inactive = source==='github' ? 'omdb_key' : 'github_repo';
      await f.service.configure(inactive, source==='github' ? 'fictional-B' : 'fictional/two');
      let stale = false;
      try {await f.service.configure(inactive,null,editor);} catch {stale=true;}
      check(stale,'An obsolete editor overwrote the changed credential');
      const concurrent = load();
      release.resolve(); await Promise.all([first,concurrent]); await load();
      check(f.calls[source].length===before+1 && (await f.service.status()).retryAt===f.env.time+45000,
        'Inactive credential changed the active '+source+' queue');
      f.env.time += day;
    }
  }));
  await run('A read-only tab reuses one series index, releases compressed bytes, and switches to the new file',()=>fixture(async f=>{
    await f.seed([1,3]); await f.set({imdb_source:'github',github_token:'fictional',github_repo:'fictional/ratings'});
    await f.service.refreshFile(true);
    const store = await openDeviceStore({name:f.name});
    const tmdb = new TmdbService(store,new TmdbClient({fetch:async()=>{throw Error('Unexpected TMDB lookup');}}),f.env);
    const service = new ImdbService(tmdb);
    const values = store.imdbValues.bind(store);
    let rawReads = 0;
    store.imdbValues = (generation,keys,...rest) => {
      if (keys.some(key=>Array.isArray(key) && key.join('/')==='imdb/github/file')) rawReads++;
      return values(generation,keys,...rest);
    };
    try {
      check(store.role === 'reader','The fixture did not acquire a read-only connection');
      const first = await service.readSeason(1,1);
      first.set(1,1);
      check((await service.readSeason(1,2)).get(1)===7.9 && (await service.readSeason(1,1)).get(1)===6.8 && rawReads===1,
        'Changing seasons reread the file, or a caller modified the shared index');
      const file = await gzip(data.replace('1,1,1,6.80','1,1,1,7').replace('1,1,1,6.8','1,1,1,7'));
      f.response.github = async()=>new Response(file);
      await f.service.refreshFile(true);
      const reads = rawReads;
      const [one,three] = await Promise.all([service.readSeason(1,1),service.readSeason(3,1)]);
      check(one.get(1)===7 && three.get(1)===7.5 && rawReads===reads+1,
        'Competing views cloned the same compressed file or returned a previous score');
      await f.service.configure('imdb_source','none');
      check((await service.readSeason(3,1)).size===0,'A previous read-only index survived a source change');
    } finally { service.close(); tmdb.close(); store.close(); }
  }));
  await run('A cold upgrade rebuilds old last-row episode indices offline and preserves unrelated cache entries',async()=>{
    for (const format of ['blob','bytes']) await fixture(async f=>{
      await f.seed([1,2,3]); await f.set({imdb_source:'github',github_token:'fictional',github_repo:'fictional/first'});
      await f.service.refreshFile(true);
      const state = await f.store.imdbState(), fileKey = ['imdb','github','file'], key = ['imdb','github','episodes',1];
      const other = ['imdb','github','episodes',3], [bytes] = await f.store.imdbValues(state.generation,[fileKey],state.file.digest);
      const previous = new Map([[1,new Map([[1,6.8],[2,5.5]])],[2,new Map([[1,7.9]])]]);
      await f.store.writeImdb(state.generation,{silent:true,entries:[
        [fileKey,format==='blob' ? new Blob([bytes]) : bytes],[key,previous],[other,new Map()],
      ]});
      const calls = f.calls.github.length;
      f.env.isOnline=false; await f.reopen();
      const scores = await f.service.readSeason(1,1);
      check(scores.get(1)===6.8 && !scores.has(2) && (await f.service.readSeason(1,2)).get(1)===7.9,'Offline reread used a disputed score');
      const [old,rebuilt,untouched] = await f.store.imdbValues(state.generation,[key,[...key,2],other],state.file.digest);
      check(old===undefined && rebuilt instanceof Map && !rebuilt.get(1).has(2) && untouched instanceof Map && !untouched.size,
        'The upgrade replaced another series or retained the superseded map');
      await f.reopen();
      check((await f.service.readShows([1])).get(1)===8.2 && !(await f.service.readSeason(1,1)).has(2) &&
        (await f.service.readSeason(3,1)).get(1)===7.5,'An old empty index or a second reopen lost valid scores');
      const after = (await f.store.imdbState()).file;
      check(after.digest===state.file.digest && after.firstAt===state.file.firstAt && after.fetchedAt===state.file.fetchedAt &&
        f.calls.github.length===calls,'The upgrade needed a download or changed the freshness of the feed');
    });
  });
  await run('The complete IMDb job file survives a restart and repository failures; later shows and selected seasons need no download',()=>fixture(async f=>{
    await f.seed([1]); await f.set({imdb_source:'github',github_token:'fictional',github_repo:'fictional/first'});
    await f.service.refreshShows([],true);
    check(f.calls.github.length === 1 && (await f.service.status()).showCount === 2,'No file on source selection');
    check((await f.service.readShows([1])).get(1) === 8.2,'Show index missing');
    await f.seed([2,3]); await f.reopen(); f.env.isOnline = false;
    const state = await f.store.imdbState(), fileKey = ['imdb','github','file'];
    const [compressed] = await f.store.imdbValues(state.generation,[fileKey],state.file.digest);
    check(compressed instanceof ArrayBuffer && (await f.service.readSeason(1,1)).get(1)===6.8,'New compressed file cannot supply offline episodes');
    // An earlier release persisted a Blob. An uncached series still has to open offline after upgrading.
    await f.store.writeImdb(state.generation,{entries:[[fileKey,new Blob([compressed])]],silent:true});
    check((await f.service.readShows([2])).get(2) === 6.3 && (await f.service.readSeason(1,1)).get(1) === 6.8 &&
      (await f.service.readSeason(1,2)).get(1) === 7.9 && (await f.service.readSeason(3,1)).get(1) === 7.5,'Offline file index lost ratings');
    f.env.isOnline = true; const before = await f.service.status();
    f.env.time+=7*day; await f.service.refreshFile(true);
    const verified = await f.service.status();
    check(verified.unchangedSince===before.fetchedAt && verified.fetchedAt===f.env.time && verified.showCount===before.showCount &&
      verified.episodeCount===before.episodeCount && f.calls.github.length===2,'Rechecking an identical file changed its counts or verification dates');
    const successful = f.response.github;
    f.response.github=async()=>new Response(null,{status:401});
    await f.service.configure('github_repo','fictional/unavailable'); await f.service.refreshFile();
    await f.reopen(); await f.service.refreshFile();
    check(f.calls.github.length===3 && (await f.service.status()).refused && (await f.service.readSeason(1,1)).get(1)===6.8,'Failed repo read lost old data or retried a 401');
    f.response.github=successful; await f.service.refreshFile(true);
    check(f.calls.github.length===4 && !(await f.service.status()).refused,'Manual retry did not clear 401');
    f.response.github=async()=>new Response(null,{status:429,headers:{'Retry-After':'15'}});
    await f.service.refreshFile(true);
    check((await f.service.status()).retryAt===f.env.time+15_000,'Known 15-second deadline was replaced by fallback');
    await f.service.configure('github_repo','fictional/next'); await f.service.refreshFile(true);
    check(f.calls.github.length===5,'Repository change or manual refresh escaped a token quota');
    await f.service.configure('github_token',null); await f.service.refreshFile(true);
    check(f.calls.github.length===5 && (await f.service.readShows([1])).get(1)===8.2,'Removing token lost readable file');
    await f.service.configure('imdb_source','omdb'); await f.service.configure('imdb_source','github');
    check(!(await f.service.readShows([1])).size && !(await f.service.readSeason(1,1)).size,'Source replacement kept prior ratings');
  }));
  await run('A stale download cannot cross a repository change, source switch, aborted settings transaction or device erasure',()=>fixture(async f=>{
    await f.seed([1]); await f.set({imdb_source:'github',github_token:'fictional-T',github_repo:'fictional/first'});
    await f.service.refreshFile();
    const old = (await f.service.status()).generation;
    const original = f.response.github;
    const newFile = await gzip(data.replace('1,,,8.2','1,,,9.1'));
    f.response.github=async()=>new Response(newFile);
    const put = IDBObjectStore.prototype.put;
    let failed = false;
    IDBObjectStore.prototype.put = function(value,key) {
      if (this.name === 'cache' && Array.isArray(key) && key[2] === 'shows') {
        throw new DOMException('Injected rating-index failure','QuotaExceededError');
      }
      return put.apply(this,arguments);
    };
    try {await f.service.refreshFile(true);}
    catch(error) {failed=error.name === 'QuotaExceededError';}
    finally { IDBObjectStore.prototype.put = put; f.response.github=original; }
    await f.reopen();
    check(failed && (await f.service.readShows([1])).get(1)===8.2 && (await f.service.readSeason(1,1)).get(1)===6.8,
      'A partial replacement removed the previous file or ratings after reopening');
    const duplicate = {setting:'github_repo',value:'fictional/ratings'};
    try {await f.store.commit((await f.store.snapshot()).revision,{replace:{settings:[duplicate,duplicate]}});}
    catch(error) {check(error.name==='ConstraintError','Unexpected abort');}
    check((await f.service.status()).generation===old && (await f.service.readShows([1])).get(1)===8.2,'Aborted settings edit erased the index');
    const started = Promise.withResolvers(), finish = Promise.withResolvers();
    f.response.github=async()=>{started.resolve(); await finish.promise; return new Response(null,{status:401});};
    const oldRequest = f.service.refreshFile(true); await started.promise;
    await f.service.configure('github_repo','fictional/other'); await f.service.configure('github_repo','fictional/first');
    finish.resolve(); await oldRequest;
    check(!(await f.service.status()).refused,'A→B→A restored a superseded failure');
    const generation = (await f.service.status()).generation;
    await f.store.eraseDevice((await f.store.snapshot()).revision);
    await f.set({imdb_source:'github',github_token:'fictional-T',github_repo:'fictional/first'});
    check(!await f.store.writeImdb(generation,{update:{fileError:'late'}}),'An old reply crossed erase');
    await f.reopen(); check(!(await f.service.status()).message && (await f.service.status()).fetchedAt===null,'Cleared file repopulated');
  }));
}
