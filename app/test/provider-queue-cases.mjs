import { openDeviceStore } from '../dist/storage.js';
import { TmdbClient } from '../dist/tmdb-client.js';
import { TmdbLibrary } from '../dist/tmdb-library.js';
import { TmdbService } from '../dist/tmdb-service.js';
import { MdbListService } from '../dist/mdblist-service.js';
import { MdbListClient } from '../dist/mdblist-client.js';
import { ImdbService } from '../dist/imdb-service.js';
import { OmdbClient } from '../dist/omdb-client.js';

async function connect(store,account,sources) {
  const now=Date.now(), deadline=now+7*86_400_000;
  const grant={accountId:'fictional-'+account,appKey:'fictional-registration',instanceId:crypto.randomUUID(),
    signInDeadline:deadline,providerExpiresAt:deadline,accessExpiresAt:now+3600_000,accessToken:'fictional-access',refreshToken:'fictional-refresh'};
  await store.storeExchangedSession(grant);
  store.connectProviderKeys(async()=>{throw Error('Unexpected key edit');},Date.now);
  const settings=sources.map(source=>({setting:source+'_key',value:'fictional-'+account+'-'+source}));
  await store.loadProviderKeys(grant,settings,()=>true);
}
const rating=id=>({show_id:id,show:'Fictional series '+id,rating:8});
const env={now:Date.now,online:()=>true,visible:()=>true};
async function removeDatabase(store,name) {
  await store.closeForUpdate();
  const remove=indexedDB.deleteDatabase(name);await new Promise((ok,no)=>{remove.onsuccess=ok;remove.onerror=()=>no(remove.error);});
}

async function replacement(phase) {
  const name='fictional-queue-'+crypto.randomUUID(), store=await openDeviceStore({name});
  const held=Promise.withResolvers(), started=Promise.withResolvers(), newShow=Promise.withResolvers();
  const calls=[], ids=Array.from({length:44},(_,i)=>501+i), originalRead=store.metadataTargets.bind(store);
  const access=store.tmdbState.bind(store);
  let service, library, firstRun, active='first', timer;
  const wait=async()=>{started.resolve();await held.promise;};
  try {
    await store.whenWriter(); await connect(store,'first',['tmdb']);
    await store.commit((await store.snapshot()).revision,{put:{ratings:ids.map(rating)}});
    service=new TmdbService(store,new TmdbClient({sleep:async()=>{},fetch:async(url,init)=>{
      const path=new URL(url).pathname, key=new Headers(init.headers).get('Authorization');
      if(path.endsWith('/configuration'))return Response.json({images:{secure_base_url:'https://image.tmdb.org/t/p/',
        poster_sizes:['w92'],backdrop_sizes:['w300'],still_sizes:['w45'],profile_sizes:['w45']}});
      const id=Number(path.match(/\/tv\/(\d+)$/)?.[1]);
      if(!id)throw Error('Unexpected fictional metadata request');
      const account=key==='Bearer fictional-first-tmdb'?'first':key==='Bearer fictional-second-tmdb'?'second':'unknown';
      calls.push({account,id});
      if(account==='first' && phase==='reply')await wait();
      if(account==='second' && id===801)newShow.resolve();
      return new Response(null,{status:404});
    }}),env);
    store.metadataTargets=async()=>{
      const snapshot=await originalRead();
      if(active==='first' && phase==='plan')await wait();
      return snapshot;
    };
    const read=service.read.bind(service);
    service.read=async resource=>{
      const value=await read(resource);
      if(active==='first' && phase==='title' && resource.kind==='show')await wait();
      return value;
    };
    store.tmdbState=async (...args)=>{
      if(active==='first' && phase==='grant' && args[0]==='access')await wait();
      return access(...args);
    };
    library=new TmdbLibrary(service);
    firstRun=library.run();
    await started.promise;
    await store.eraseDevice((await store.snapshot()).revision);
    active='second';
    await connect(store,'second',['tmdb']);
    await store.commit((await store.snapshot()).revision,{put:{ratings:[rating(801)]}});
    const next=library.run();
    await Promise.race([newShow.promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('The new record waited for the retired '+phase)),8000);})]);
    held.resolve(); await Promise.all([firstRun,next]);
    if(calls.some(call=>call.account==='unknown' || call.account==='second' && call.id!==801)) {
      throw Error('A retired '+phase+' used the new account for an old title');
    }
    for(const id of [501,502,543,544]){
      if(await read({kind:'show',id}))throw Error('A retired '+phase+' reached the new account cache');
    }
    if((await read({kind:'show',id:801}))?.value!==null)throw Error('The new record lost its own confirmed lookup');
  } finally {
    clearTimeout(timer);held.resolve();library?.close();service?.close();await firstRun?.catch(()=>{});
    await removeDatabase(store,name);
  }
}

async function scoreReplacement(phase) {
  const name='fictional-score-queue-'+crypto.randomUUID(),store=await openDeviceStore({name});
  const entered={mdblist:Promise.withResolvers(),omdb:Promise.withResolvers()}, held=Promise.withResolvers();
  const second={mdblist:Promise.withResolvers(),omdb:Promise.withResolvers()},sent=[];
  let active='first',library,tmdb,critics,imdb,firstRun,timer;
  async function setup(owner,ids) {
    await connect(store,owner,['mdblist','omdb']);
    await store.commit((await store.snapshot()).revision,{put:{settings:[{setting:'imdb_source',value:'omdb'}],
      ratings:ids.map(rating),shows:ids.map(id=>({show_id:id,show:rating(id).show,year:2020,imdb_id:'tt'+String(id).padStart(7,'0')}))}});
  }
  function transport(source) {
    return async url=>{
      const id=source==='omdb'?Number(url.searchParams.get('i').slice(2)):Number(url.pathname.split('/').at(-1));
      const key=url.searchParams.get('apikey'), owner=key==='fictional-first-'+source?'first':key==='fictional-second-'+source?'second':'unknown';
      sent.push({source,id,owner});
      if(owner==='first' && phase==='reply'){entered[source].resolve();await held.promise;}
      if(owner==='second' && id===801)second[source].resolve();
      return Response.json(source==='mdblist'?{type:'show',ids:{tmdb:id},ratings:[{source:'tomatoes',value:81}]}:
        {Response:'True',Type:'series',imdbID:url.searchParams.get('i'),imdbRating:'8.1'});
    };
  }
  try {
    await store.whenWriter();await setup('first',[501,502,503]);
    tmdb=new TmdbService(store,new TmdbClient({fetch:()=>{throw Error('Unexpected TMDB request');}}),env);
    critics=new MdbListService(store,new MdbListClient({fetch:transport('mdblist')}),env);
    imdb=new ImdbService(tmdb,{omdb:new OmdbClient({fetch:transport('omdb')})});
    const targets=store.metadataTargets.bind(store);
    store.metadataTargets=async()=>{
      const record=await targets();
      if(active==='first' && phase==='plan'){entered.mdblist.resolve();entered.omdb.resolve();await held.promise;}
      return record;
    };
    library=new TmdbLibrary(tmdb,critics,imdb);
    firstRun=library.run();
    await Promise.all(Object.values(entered).map(g=>g.promise));
    await store.eraseDevice((await store.snapshot()).revision);
    active='second';await setup('second',[801]);
    const next=library.run();
    await Promise.race([Promise.all(Object.values(second).map(g=>g.promise)),new Promise((_,reject)=>{
      timer=setTimeout(()=>reject(Error('The replacement rating jobs waited for retired '+phase)),8000);
    })]);
    held.resolve();await Promise.all([firstRun,next]);
    if(sent.some(c=>c.owner==='unknown' || c.owner==='second' && c.id!==801))throw Error('A retired score job used the replacement credential');
    const [score,series]=await Promise.all([critics.read([501,502,503,801]),imdb.readShows([501,502,503,801])]);
    if(score.size!==1 || score.get(801)?.tomatoes!==81 || series.size!==1 || series.get(801)!==8.1)throw Error('New record received incorrect ratings');
  } finally {
    clearTimeout(timer);held.resolve();library?.close();critics?.close();imdb?.close();tmdb?.close();
    await firstRun?.catch(()=>{});await removeDatabase(store,name);
  }
}

export async function providerQueueCases(run) {
  await run('Freeing rebuildable storage retires old title and critic results while a new lookup can fill the cache',async()=>{
    const name='fictional-clean-cache-'+crypto.randomUUID(),store=await openDeviceStore({name});
    const held=Promise.withResolvers(),started=[Promise.withResolvers(),Promise.withResolvers()];
    let tmdb,mdblist,old,timer,round=0;
    try {
      await store.whenWriter();await connect(store,'first',['tmdb','mdblist']);
      tmdb=new TmdbService(store,new TmdbClient({sleep:async()=>{},fetch:async()=>{
        const first=round===0;
        if(first){started[0].resolve();await held.promise;}
        return Response.json({id:51,cast:[{id:31,name:first?'Old fictional name':'New fictional name',roles:[],total_episode_count:2}]});
      }}),env);
      mdblist=new MdbListService(store,new MdbListClient({sleep:async()=>{},fetch:async()=>{
        const first=round===0;
        if(first){started[1].resolve();await held.promise;}
        return Response.json({type:'show',ids:{tmdb:51},ratings:[{source:'metacritic',value:first?66:88}]});
      }}),env);
      const resource={kind:'cast',id:51};
      old=Promise.all([tmdb.refresh(resource).catch(e=>{if(e.kind!=='superseded')throw e;}),mdblist.refresh([51])]);
      await Promise.all(started.map(x=>x.promise));
      await store.clearRebuildableCaches();round=1;
      const newTitle=await Promise.race([tmdb.refresh(resource),new Promise((_,reject)=>{
        timer=setTimeout(()=>reject(Error('The fresh title request still depended on a discarded request')),6000);
      })]);
      if(newTitle.value?.[0]?.name!=='New fictional name')throw Error('The fresh title request joined the discarded response');
      held.resolve();await old;
      if((await tmdb.read(resource))?.value?.[0]?.name!=='New fictional name' || (await mdblist.read([51])).size)
        throw Error('A pre-cleanup reply replaced a newer title or consumed the space just freed');
      await mdblist.refresh([51]);
      if((await tmdb.read(resource))?.value?.[0]?.name!=='New fictional name' || (await mdblist.read([51])).get(51)?.metacritic!==88)
        throw Error('A new lookup could not refill the cleared cache');
    } finally {clearTimeout(timer);held.resolve();tmdb?.close();mdblist?.close();await old?.catch(()=>{});await removeDatabase(store,name);}
  });
  await run('A refusal or quota reply still protects its existing TMDB and MDBList key after the cache is freed',async()=>{
    for(const status of [401,429]){
      const name='fictional-clean-cache-gate-'+crypto.randomUUID(),store=await openDeviceStore({name});
      const entered=[Promise.withResolvers(),Promise.withResolvers()],hold=Promise.withResolvers();
      let tmdb,critics,reading;
      try {
        await store.whenWriter();await connect(store,'first',['tmdb','mdblist']);
        const reply=which=>async()=>{entered[which].resolve();await hold.promise;
          return new Response(null,{status,headers:{'Retry-After':'600'}});};
        tmdb=new TmdbService(store,new TmdbClient({fetch:reply(0)}),env);
        critics=new MdbListService(store,new MdbListClient({fetch:reply(1)}),env);
        reading=Promise.all([tmdb.refresh({kind:'cast',id:42}).catch(error=>{
          if(!['superseded','throttled','refused'].includes(error.kind))throw error;
        }),critics.refresh([42])]);
        await Promise.all(entered.map(x=>x.promise));await store.clearRebuildableCaches();hold.resolve();await reading;
        const state=await store.tmdbState(),score=await critics.keyStatus();
        if(status===401 ? !state.refused || score.status!=='refused' : !(state.cooldown?.until>Date.now()) || score.status!=='throttled')
          throw Error('Clearing score data discarded the provider’s '+status+' response');
      } finally {hold.resolve();critics?.close();tmdb?.close();await reading?.catch(()=>{});await removeDatabase(store,name);}
    }
  });
  await run('A new Dropbox record immediately starts its own TMDB job and retires old plans, cache reads, grant reads and replies',async()=>{
    for(const phase of ['plan','title','grant','reply'])await replacement(phase);
  });
  await run('A new record launches independent MDBList and OMDb jobs without carrying over old plans, responses or caches',async()=>{
    for(const phase of ['plan','reply'])await scoreReplacement(phase);
  });
  await run('A show lookup started before account replacement cannot send its title using the new TMDB credential',async()=>{
    for(const action of ['open','mark']){
    const name='fictional-foreground-'+crypto.randomUUID(),store=await openDeviceStore({name});
    const held=Promise.withResolvers(),entered=Promise.withResolvers(),sent=[];
    let service,first;
    try {
      await store.whenWriter();await connect(store,'first',['tmdb']);
      service=new TmdbService(store,new TmdbClient({sleep:async()=>{},fetch:async(url,init)=>{
        const id=Number(url.pathname.split('/').at(-1));
        sent.push({id,second:new Headers(init.headers).get('Authorization')==='Bearer fictional-second-tmdb'});
        return new Response(null,{status:404});
      }}),env);
      const read=service.read.bind(service);
      service.read=async resource=>{
        const entry=await read(resource);
        if(resource.kind==='show' && resource.id===501){entered.resolve();await held.promise;}
        return entry;
      };
      first=(action==='open'?service.openShow(501):service.markWithReceipt(501,{},'mark'))
        .then(()=>true,error=>{if(error.kind==='superseded')return false;throw error;});
      await entered.promise;
      await store.eraseDevice((await store.snapshot()).revision);await connect(store,'second',['tmdb']);
      const current=await service.openShow(801);
      held.resolve();await first;
      if(!sent.some(c=>c.second && c.id===801) || current.show.status!=='not-found')throw Error('The new foreground page lost its own lookup');
      if(sent.some(c=>c.second && c.id===501))throw Error('The old foreground show used the new TMDB credential');
      if(await read({kind:'show',id:501}))throw Error('The new account cached a retired foreground show');
      if((await store.snapshot()).tables.watched.length)throw Error('An old mark escaped to a new record');
    } finally {held.resolve();service?.close();await first?.catch(()=>{});await removeDatabase(store,name);}
    }
  });
  await run('A show whose last airing was a Special keeps its original authority for later regular-season lookups',async()=>{
    const name='fictional-secondary-show-'+crypto.randomUUID(),store=await openDeviceStore({name});
    const entered=Promise.withResolvers(),release=Promise.withResolvers(),calls=[];
    let service,work;
    try {
      await store.whenWriter();await connect(store,'first',['tmdb']);
      service=new TmdbService(store,new TmdbClient({sleep:async()=>{},fetch:async(url,init)=>{
        const key=new Headers(init.headers).get('Authorization'),path=url.pathname;
        calls.push([path,key==='Bearer fictional-second-tmdb']);
        if(path.endsWith('/aggregate_credits'))return Response.json({id:501,cast:[]});
        if(path.endsWith('/recommendations'))return Response.json({page:1,total_pages:0,results:[]});
        if(path.endsWith('/season/1'))return Response.json({season_number:1,episodes:[]});
        if(!path.endsWith('/501'))throw Error('Unexpected show lookup');
        return Response.json({id:501,name:'Fictional Final Special',status:'Ended',keywords:{results:[]},external_ids:{},
          seasons:[{season_number:1,episode_count:5,name:'Season 1'}],last_episode_to_air:{season_number:0,episode_number:1,air_date:'2022-06-01'}});
      }}),env);
      const read=service.read.bind(service);
      let held=false;
      service.read=async resource=>{
        const value=await read(resource);
        if(!held && resource.kind==='season'){held=true;entered.resolve();await release.promise;}
        return value;
      };
      work=service.openShow(501).catch(error=>{if(error.kind!=='superseded')throw error;});
      await entered.promise;
      await store.eraseDevice((await store.snapshot()).revision);await connect(store,'second',['tmdb']);
      release.resolve();await work;
      if(calls.some(([,replacement])=>replacement) || await read({kind:'season',id:501,season:1}))
        throw Error('An earlier show page fetched regular seasons under its replacement record');
    } finally {release.resolve();service?.close();await work?.catch(()=>{});await removeDatabase(store,name);}
  });
  await run('Cached credits cannot be shown after a device erasure during a writer or reader lookup',async()=>{
    for(const mode of ['writer','reader']){
      const name='fictional-retired-credits-'+crypto.randomUUID(),writer=await openDeviceStore({name});
      let reader,tmdb,pending,cachedCallback=0;
      const held=Promise.withResolvers(),entered=Promise.withResolvers();
      try {
        await writer.whenWriter();await connect(writer,'first',['tmdb']);
        const {generation}=await writer.tmdbState('access'),id=31;
        await writer.writeTmdb(generation,{entries:{'person/31/tv_credits':{fetchedAt:Date.now(),value:[{show_id:501,show:'Retired fictional series'}]}}});
        if(mode==='reader')reader=await openDeviceStore({name});
        const store=reader??writer;
        tmdb=new TmdbService(store,new TmdbClient({fetch:()=>{throw Error('Unexpected cached-only request');}}),env);
        const native=tmdb.read.bind(tmdb);
        tmdb.read=async resource=>{
          const cached=await native(resource);
          if(resource.kind==='person'){entered.resolve();await held.promise;}
          return cached;
        };
        pending=tmdb.view({kind:'person',id},()=>cachedCallback++).then(value=>value,error=>{
          if(error.kind==='superseded')return null;throw error;
        });
        await entered.promise;
        await writer.eraseDevice((await writer.snapshot()).revision);await connect(writer,'second',['tmdb']);
        held.resolve();const result=await pending;
        if(cachedCallback || result?.value)throw Error('A retired record appeared in the '+mode+' cast view');
      } finally {held.resolve();tmdb?.close();await pending?.catch(()=>{});await reader?.closeForUpdate();await removeDatabase(writer,name);}
    }
  });
}
