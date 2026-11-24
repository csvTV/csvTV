import { openDeviceStore } from '../dist/storage.js';
import { TmdbService } from '../dist/tmdb-service.js';
import { prepareExport } from '../dist/export-data.js';
import { tmdbResourceKey } from '../dist/tmdb-client.js';
import { cacheExpiresAt } from '../dist/tmdb-refresh.js';
import { connectFixtureProviders } from './provider-fixture-cases.mjs';

const check=(value,message)=>{if(!value)throw Error(message);};
const show=id=>({id,name:'Fictional series '+id,status:'Ended',first_air_date:'2020-01-01',seasons:[],
  keywords:{results:[]},external_ids:{imdb_id:null}});
const row=id=>({show_id:id,show:'Fictional series '+id,season:1,episode:1,episode_id:100+id,title:'A visitor',times_watched:1});
async function fixture(run){
  const name='Fictional TMDB browsing '+crypto.randomUUID(),store=await openDeviceStore({name});
  const env={online:()=>true,visible:()=>true,now:Date.now};
  const service=new TmdbService(store,{request:async r=>r.kind==='show'?show(r.id):{id:r.id,cast:[]}},env);
  try{
    await connectFixtureProviders(store,name,[{setting:'tmdb_key',value:'fictional-cache-key'}]);
    await run(store,service,env,name);
  }finally{service.close();await store.closeForUpdate();indexedDB.deleteDatabase(name);}
}

export async function tmdbBrowseCases(run){
  await run('Only queued renewals for the same show and grant reuse its checked watches',async()=>{
    for(const mode of ['unchanged','edit','another-show','refused','grant']) await fixture(async(store,_base,env,name)=>{
      const first={kind:'season',id:82,season:1},second={kind:'season',id:mode==='another-show'?83:82,season:2};
      const watch=r=>({...row(r.id),season:r.season,episode_id:r.id*10+r.season,title:'Chapter '+r.season});
      const saved=[watch(first),watch(second)];
      await store.commit(await store.recordRevision(),{put:{watched:saved}});
      const service=new TmdbService(store,{request:async r=>({show_id:r.id,season_number:r.season,episodes:[{
        id:r.id*10+r.season,episode_number:1,season_number:r.season,name:'Chapter '+r.season,air_date:'2020-02-03'}]})},env);
      const read=store.tmdbRows.bind(store),access=store.tmdbState.bind(store),commit=store.commit.bind(store),cached=service.read.bind(service);
      const prepared=Promise.withResolvers(),siblingReady=Promise.withResolvers(),release=Promise.withResolvers();
      let scans=0,started=false,readSibling=false;
      const generation=(await access()).generation;
      store.tmdbRows=async(...args)=>{scans++;return read(...args);};
      service.read=async(resource,...args)=>{
        const value=await cached(resource,...args);
        if(resource.kind==='season'&&resource.season===2)readSibling=true;
        return value;
      };
      store.tmdbState=async(...args)=>{
        const result=await access(...args);
        // The season's final access check queues its write in the current task's microtasks.
        if(readSibling && args[0]==='access')setTimeout(siblingReady.resolve,0);
        return result;
      };
      store.commit=async(revision,patch,options)=>{
        const hold=!started && options?.tmdb?.key===tmdbResourceKey(first);
        if(hold){started=true;prepared.resolve();await release.promise;}
        const value=await commit(revision,patch,options);
        if(hold){
          if(mode==='edit')await commit(await store.recordRevision(),{put:{watched:[{...saved[1],title:'An older title',times_watched:7}]}});
          if(mode==='refused')check(await store.writeTmdb(generation,{refused:'Fictional refusal'}),'Refusal was lost');
          if(mode==='grant'){
            const {session}=await store.dropboxState(),deadline=Date.now()+7*86400000;
            await store.storeExchangedSession({accountId:session.accountId,instanceId:crypto.randomUUID(),signInDeadline:deadline,
              accessExpiresAt:deadline,providerExpiresAt:deadline,appKey:'fictional-registration',accessToken:'fictional-access',refreshToken:'fictional-refresh'});
            await connectFixtureProviders(store,name);
          }
        }
        return value;
      };
      try{
        const a=service.refresh(first);await prepared.promise;
        const b=service.refresh(second);await siblingReady.promise;release.resolve();
        const [one,two]=await Promise.allSettled([a,b]);
        check(one.status==='fulfilled','The first valid season was lost in '+mode);
        const denied=mode==='refused'||mode==='grant';
        check(denied ? two.status==='rejected'&&two.reason?.kind==='superseded' : two.status==='fulfilled','Wrong sibling outcome after '+mode);
        const stored=(await read(second.id,false)).tables.watched.find(r=>r.season===2);
        check(stored.episode_id===saved[1].episode_id && stored.times_watched===(mode==='edit'?7:1) && stored.title==='Chapter 2','The sibling review lost the current owner, count or title');
        check(Boolean(await cached(second))!==denied,'An obsolete season reached the cache');
        if(mode==='unchanged'){
          check(scans===1,'Two pending seasons made '+scans+' watch reads');
          await service.refresh(second);check(scans===2,'An idle service retained the personal rows');
        }
        if(mode==='another-show')check(scans===2,'One show received the previous show’s private rows');
        if(mode==='refused'||mode==='edit')check(scans>=2&&scans<=5,'The rejected snapshot was not replaced within a bounded number of reads');
      }finally{release.resolve();store.tmdbRows=read;store.tmdbState=access;store.commit=commit;service.close();}
    });
  });
  await run('A revoked or refused TMDB binding ends a pending title rewrite without retrying the record',async()=>{
    for(const mode of ['signout','refusal','fresh-lease','switch-account','valid']) await fixture(async(store,service,_env,name)=>{
      const id=72,original={...row(id),show:'Old fictional title',times_watched:3};
      const replacement={...original,show:'Replacement account title',times_watched:7};
      await store.commit(await store.recordRevision(),{put:{watched:[original]}});
      const before=(await store.dropboxState()).session,generation=(await store.tmdbState('access')).generation;
      function grant(accountId=before.accountId) {
        const deadline=Date.now()+7*86400000;
        return {accountId,instanceId:crypto.randomUUID(),appKey:'fictional-registration',signInDeadline:deadline,
          providerExpiresAt:deadline,accessExpiresAt:Date.now()+3600000,accessToken:'fictional-access',refreshToken:'fictional-refresh'};
      }
      const read=store.tmdbRows.bind(store);
      let scans=0,capped=false,cut=false,failure;
      store.tmdbRows=async(...args)=>{
        const saved=await read(...args);
        scans++;
        if(scans===1){
          if(mode==='signout')store.clearProviderKeys();
          if(mode==='refusal')check(await store.writeTmdb(generation,{refused:'Fictional credential refused'}),'Refusal was not saved');
          if(mode==='fresh-lease'){
            await store.storeExchangedSession(grant());
            await connectFixtureProviders(store,name);
            check((await store.tmdbState('access')).generation!==generation,'The new lease was not installed');
          }
          if(mode==='switch-account'){
            await store.eraseDevice(await store.recordRevision());
            await store.storeExchangedSession(grant('new-fictional-metadata-owner'));
            await connectFixtureProviders(store,name+' replacement',[{setting:'tmdb_key',value:'fictional-cache-key'}]);
            await store.commit(await store.recordRevision(),{put:{watched:[replacement]}});
          }
          cut=true;
        }
        if(scans===5){capped=true;service.close();}
        return saved;
      };
      try{await service.refresh({kind:'show',id});}catch(error){failure=error.kind??error.name;}
      finally{store.tmdbRows=read;}
      const after=(await read(id,false)).tables.watched[0],cached=await service.read({kind:'show',id});
      check(cut && !capped && scans<=2,'The obsolete write kept retrying after '+mode);
      const ownerRow=mode==='switch-account'?replacement:original;
      check(after.times_watched===ownerRow.times_watched&&after.episode_id===ownerRow.episode_id,'A title response altered a personal watch');
      if(mode==='valid')check(!failure && after.show===show(id).name && cached?.value.show===after.show,'A current rewrite was lost');
      else check(failure==='superseded' && after.show===ownerRow.show && !cached,'An old response crossed '+mode+' · '+failure);
      if(mode==='signout'){
        await store.storeExchangedSession(grant());
        await connectFixtureProviders(store,name);
      }
      if(['signout','fresh-lease','switch-account'].includes(mode)){
        await service.refresh({kind:'show',id});
        const current=(await read(id,false)).tables.watched[0];
        check(current.show===show(id).name && current.times_watched===ownerRow.times_watched,'The new queue did not serve its current record');
      }
    });
  });
  await run('Setup and TMDB key removal avoid complete watch, sync and local tables',()=>fixture(async(store,service)=>{
    const generation=(await store.tmdbState()).generation;
    await store.commit(await store.recordRevision(),{put:{watched:[row(90)]}});
    const all=IDBObjectStore.prototype.getAll,seen=[];
    IDBObjectStore.prototype.getAll=function(...args){
      if(args[0]===undefined && ['watched','sync','local'].includes(this.name))seen.push(this.name);
      return all.apply(this,args);
    };
    try{
      check(!await service.firstUse(),'A linked setup still offered its completed first-use steps');
      await service.dismissFirstUse();
      let stale=false;try{await service.removeKey(generation+1n);}catch(e){stale=e.kind==='superseded';}
      check(stale && (await service.keyStatus()).status==='ready','Stale confirmation removed an unreviewed key');
      const commit=store.commit.bind(store);
      let replaced=false;
      store.commit=async function(revision,patch,options){
        if(!replaced && patch.remove?.settings?.includes('tmdb_key')){
          replaced=true;
          await commit(revision,{put:{settings:[{setting:'tmdb_key',value:'fictional-replacement-after-review'}]}});
        }
        return commit(revision,patch,options);
      };
      try{
        stale=false;try{await service.removeKey(generation);}catch(e){stale=e.kind==='superseded';}
        check(replaced && stale && (await service.keyStatus()).status==='ready','A concurrent replacement lost its unreviewed key');
      }finally{store.commit=commit;}
      await service.removeKey((await service.keyStatus()).generation);
      check((await service.keyStatus()).status==='missing-key' && !await service.firstUse(),'Key removal or saved dismissal was lost');
      check(!seen.length,'Setup or key removal read complete personal tables · '+seen.join(','));
    }finally{IDBObjectStore.prototype.getAll=all;}
    check((await store.tmdbRows(90,false)).tables.watched[0].times_watched===1,'Changing the provider altered a watch');
  }));
  await run('A metadata refresh scans watches once and rechecks an episode search after a competing watch edit',()=>fixture(async(store,base,env)=>{
    const id=83, requests=[];
    let clock=Date.now();env.now=()=>clock;
    const client={request:async r=>{
      requests.push(r.kind);
      if(r.kind==='show')return {...show(id),seasons:[{season_number:1,episode_count:2,name:'Season 1'}]};
      if(r.kind==='season')return {season_number:1,episodes:[501,502].map((stable,i)=>({id:stable,episode_number:i+1,
        name:'Signal '+stable,air_date:'2020-02-01',runtime:24}))};
      throw Error('Unexpected resource');
    }};
    const service=new TmdbService(store,client,env),header={kind:'show',id},season={kind:'season',id,season:1};
    const first={show_id:id,show:show(id).name,season:1,episode:1,episode_id:501,title:'Signal 501',times_watched:1};
    const later={...first,season:2,episode_id:502,title:'Signal 502'};
    try{
      await store.commit((await store.snapshot()).revision,{put:{watched:[first]}});
      await service.refresh(header);await service.refresh(season);
      const read=IDBObjectStore.prototype.getAll,commit=store.commit.bind(store);
      let scans=0,interleave=false,inserted=false;
      IDBObjectStore.prototype.getAll=function(...args){if(this.name==='watched')scans++;return read.apply(this,args);};
      store.commit=async function(revision,patch,options){
        const result=await commit(revision,patch,options);
        if(interleave && !inserted && options?.tmdb?.key===tmdbResourceKey(header)){
          inserted=true;await commit(await store.recordRevision(),{put:{watched:[later]}});
        }
        return result;
      };
      try{
        for(const resource of [header,season]){
          clock+=100;scans=0;requests.length=0;await service.refresh(resource);
          check(scans===1 && requests.join()===resource.kind,'An unchanged '+resource.kind+' reread the watch rows or launched an unnecessary repair lookup');
        }
        clock+=100;interleave=true;requests.length=0;await service.refresh(header);
        check(inserted && requests.join()==='show,season','An overlapping watch did not launch its required destination lookup');
      }finally{IDBObjectStore.prototype.getAll=read;store.commit=commit;}
      const review=await service.repairPreview(id);
      check(review.moves.some(m=>m.from.episode_id===502 && m.from.season===2 && m.to.season===1 && m.to.episode===2),
        'The repair missed the episode of the newly watched season');
    }finally{service.close();}
  }));
  await run('Identical report metadata renews its cache while changed airings, casts and expiries refresh the report',()=>fixture(async(store,service,env)=>{
    const id=77,start=Date.now(),gen=(await store.tmdbState()).generation,{session}=await store.dropboxState();
    let now=start;env.now=()=>now;
    const events=[];for(const n of ['tmdbmetadata','tmdbbrowse','exportchange'])store.addEventListener(n,()=>events.push(n));
    const reset=async()=>{await store.saveDropboxStatus({accountId:session.accountId,instanceId:session.instanceId,synced:true,
      reason:'Fictional receipt',day:'2026-11-23'},()=>true);events.length=0;};
    const persist=async(kind,value,at=++now,repairScan)=>{const key=tmdbResourceKey({kind,id,season:1});
      check(await store.writeTmdb(gen,{entries:{[key]:{value,fetchedAt:at,repairScan}}},now),'Cache write failed');};
    const expected=async(report,dirty,label)=>check(events.includes(report?'tmdbmetadata':'tmdbbrowse') &&
      !events.includes(report?'tmdbbrowse':'tmdbmetadata') && (await store.dropboxState()).dirty===dirty &&
      events.includes('exportchange')===dirty,'Incorrect notifications after '+label+' · '+events.join(','));
    const header={show_id:id,show:show(id).name,firstAirDate:'2020-01-01',seasons:[{season:1,episodeCount:2}],
      lastAired:{season:1,episode:2,airDate:'2020-01-01'},nextEpisode:null};
    const season={show_id:id,season:1,episodes:[{episode:1,episode_id:100+id,airDate:'2020-01-01',title:'A visitor'},
      {episode:2,episode_id:999,airDate:'2099-01-01',title:'A return'}]};
    await store.commit((await store.snapshot()).revision,{put:{watched:[{...row(id),times_watched:2}]}});
    await persist('show',header);await persist('season',season);
    const summary=async()=>(await prepareExport(service,'summary')).files[0].text();
    const newerSeason=await summary();
    await reset();await persist('season',season);await expected(false,false,'identical season already newer than its header');
    check(await summary()===newerSeason,'An unchanged season altered the export');
    await reset();await persist('show',header);await expected(true,true,'header becoming newer than a disagreeing season');
    const newerHeader=await summary();
    check(newerHeader!==newerSeason,'Header and season precedence had no effect in the fixture');
    await reset();await persist('show',header);await expected(false,false,'identical newest header');
    check(await summary()===newerHeader,'The latest header lost its precedence');
    await reset();await persist('season',season);await expected(true,true,'season becoming newer than a disagreeing header');
    check(await summary()===newerSeason,'The renewed season did not restore its exported completions');
    const cast=[{id:15,name:'Fictional Fern',roles:['Visitor']}];
    for(const [kind,value] of [['cast',cast],['countries',[{code:'XX',name:'Fictional region'}]]]){
      await reset();await persist(kind,value);await expected(true,false,'first '+kind);
      await reset();await persist(kind,structuredClone(value));await expected(false,false,'renewed '+kind);
      await reset();await persist(kind,[{...value[0],name:'Changed name'}]);await expected(true,false,'changed '+kind);
    }
    await reset();await persist('cast',cast,now-365*86400000);await expected(true,false,'old replacement');
    await reset();await persist('cast',cast);await expected(true,false,'renewal after retention expired');
    // A newer last-of-month request can expire earlier after a calendar-month clamp.
    const earlier=Date.UTC(2025,7,30,18),later=Date.UTC(2025,7,31,12);
    now=later+100;await persist('cast',cast,earlier);await reset();await persist('cast',cast,later);
    await expected(true,false,'shortened retention');
    now=start+20000;
    await store.commit((await store.snapshot()).revision,{put:{ratings:[{show_id:29,show:show(29).name,rating:8}]}});
    await service.refresh({kind:'show',id:29});await reset();now++;
    await service.refresh({kind:'show',id:29});await expected(false,false,'normal tracked title refresh');
  }));
  await run('Show and Season share one committed watch and episode read for progress and repair',()=>fixture(async(store,service,env)=>{
    const id=71, now=Date.now(), at=now-1000;
    env.now=()=>now;
    const episode=(position,stable)=>({episode:position,episode_id:stable,title:'Fictional episode '+stable,airDate:'2020-02-03',runtime:24});
    const resource=(kind,season)=>({kind,id,season});
    const header={show_id:id,show:'Fictional series 71',seasons:[1,2,3,4].map(season=>({season,episodeCount:3})),
      lastAired:{season:4,episode:3,airDate:'2020-02-03'},nextEpisode:null,nextAirDate:null};
    const season=(number,episodes)=>({show_id:id,season:number,name:'Season '+number,episodes});
    const entries={
      [tmdbResourceKey(resource('show'))]:{fetchedAt:at,value:header},
      [tmdbResourceKey(resource('season',1))]:{fetchedAt:at,value:season(1,[episode(2,501),episode(3,503)])},
      [tmdbResourceKey(resource('season',2))]:{fetchedAt:at,value:null},
      [tmdbResourceKey(resource('season',3))]:{fetchedAt:at-366*86400000,value:season(3,[episode(1,502)])},
      [tmdbResourceKey(resource('season',4))]:{fetchedAt:now+86400000,value:season(4,[episode(1,503)])},
    };
    const base={show_id:id,show:header.show,season:1,title:'Earlier name',times_watched:4};
    const watched=[{...base,episode:1,episode_id:501},{...base,season:2,episode:1,episode_id:502}];
    const order={setting:'season_order.'+id,value:'1/3:1'};
    await store.commit((await store.snapshot()).revision,{put:{watched,ratings:[{show_id:id,show:header.show,rating:8}],
      lists:[{show_id:id,show:header.show,list:'Favorites'}],shows:[{show_id:id,show:header.show,year:2020,imdb_id:''}],settings:[order]}});
    const generation=(await store.tmdbState()).generation;
    check(await store.writeTmdb(generation,{entries},now),'Could not seed retained, missing and expired season data');
    const canonical=value=>JSON.stringify(value,(_,v)=>typeof v==='bigint'?String(v):v);
    const [metadata,info,preview]=await Promise.all([store.tmdbRows(id,false),service.showInfo(id),service.repairPreview(id)]);
    const {tmdbKeyAccepted,...record}=metadata;
    check(tmdbKeyAccepted,'The metadata writer should see the fixture’s accepted grant');
    check(preview.moves.length===1 && preview.moves[0].from.episode_id===501 && preview.moves[0].to.episode===2 &&
      !preview.missing.length,'Wrong fixture before sharing its read');
    const original=IDBObjectStore.prototype.getAll, get=IDBObjectStore.prototype.get, reads=[];
    IDBObjectStore.prototype.getAll=function(...args){reads.push(this.name);return original.apply(this,args);};
    IDBObjectStore.prototype.get=function(key){if(this.name==='local')reads.push('local/'+String(key));return get.apply(this,arguments);};
    try{
      for(const scope of ['show',1,2,3,4]){
        reads.length=0;
        const result=await store.showScreenState(id,scope,now);
        check(reads.filter(x=>x==='watched').length===1 && reads.filter(x=>x==='tmdb').length===1,'Duplicate watched or season scans for '+scope);
        check(reads.filter(x=>x.startsWith('local/')).every(x=>x==='local/syncAccountId'),'Details retrieved other local data');
        check(!('tmdbKeyAccepted' in result.record),'The detail screen received metadata-write admission state');
        check(canonical(result.record)===canonical(record) && canonical(result.preview)===canonical(preview),'Inconsistent repair or record for '+scope);
        check(result.header.value.manualSeasonOrder===order.value,'Custom order was not applied');
        if(scope==='show')check(canonical(result.info)===canonical(info),'Shared info differed from native progress data');
        if(scope===1)check(result.season?.value?.episodes[0].episode_id===501,'The requested season lost its episodes');
        if(scope===2)check(result.season?.value===null,'The retained 404 was lost');
        if(scope===3 || scope===4)check(result.season===null,'The season should be outside its retention window');
      }
    }finally{IDBObjectStore.prototype.getAll=original;IDBObjectStore.prototype.get=get;}
    const old=store.showScreenState(id,'show',now);
    await store.commit(record.revision,{put:{watched:[{...watched[0],times_watched:6}],settings:[{...order,value:'native'}]}});
    const [before,after]=await Promise.all([old,store.showScreenState(id,'show',now)]);
    check(before.header.value.manualSeasonOrder===order.value && before.preview.moves[0].from.times_watched===4 &&
      after.header.value.manualSeasonOrder==='native' && after.preview.moves[0].from.times_watched===6 &&
      before.record.revision<after.record.revision,'Overlapping reads mixed two revisions');
    // Queue a native write between the two readonly groups, including its own revision.
    const transaction=IDBDatabase.prototype.transaction;
    let inserted=false, retries=0, interleaved;
    IDBDatabase.prototype.transaction=function(names,mode,...rest){
      if(!mode && Array.isArray(names) && names.includes('ratings')){
        if(names.includes('watched')) retries++;
        else if(!inserted){
          inserted=true;
          const writer=transaction.call(this,['watched','settings','meta'],'readwrite');
          writer.objectStore('watched').put({...watched[0],times_watched:7});
          writer.objectStore('settings').put(order);
          writer.objectStore('meta').put(after.record.revision+1n,'revision');
        }
      }
      return transaction.call(this,names,mode,...rest);
    };
    try{interleaved=await store.showScreenState(id,'show',now);}
    finally{IDBDatabase.prototype.transaction=transaction;}
    check(inserted && retries===1 && interleaved.record.revision===after.record.revision+1n &&
      interleaved.preview.moves[0].from.times_watched===7 && interleaved.header.value.manualSeasonOrder===order.value,
      'A writer between the two detail reads left a mixture of old and new data');
    for(const first of [true,false]){
      const controller=new AbortController();
      if(first)controller.abort();
      const pending=store.showScreenState(id,'show',now,controller.signal);
      if(!first)controller.abort();
      let failure;
      try{await pending;}catch(error){failure=error.name;}
      check(failure==='AbortError','A canceled detail scan did not release the native read');
    }
    const getOne=IDBObjectStore.prototype.get, canceled=new AbortController(), uncaught=[];
    const capture=event=>{uncaught.push(event.error?.name ?? event.message);event.preventDefault();};
    window.addEventListener('error',capture);
    IDBObjectStore.prototype.get=function(key){
      const request=getOne.apply(this,arguments);
      if(this.name==='tmdb' && key===tmdbResourceKey(resource('show')))
        request.addEventListener('success',()=>canceled.abort(),{once:true});
      return request;
    };
    try{
      let failure;
      try{await store.showScreenState(id,'show',now,canceled.signal);}catch(error){failure=error.name;}
      await new Promise(resolve=>setTimeout(resolve,0));
      check(failure==='AbortError' && !uncaught.length,'A canceled title success callback queued another native read · '+uncaught.join(','));
    }finally{IDBObjectStore.prototype.get=getOne;window.removeEventListener('error',capture);}
    await store.commit(interleaved.record.revision,{remove:{watched:watched.map(r=>[id,r.season,r.episode])}});
    const empty=await store.showScreenState(id,1,now);
    check(!empty.record.tables.watched.length && !empty.preview.moves.length && empty.season.value.episodes.length===2,
      'A show without identified watches lost its requested season');
  }));
  await run('Browsing reads the current record association before invalidating exports or the cast chart',()=>fixture(async(store,service)=>{
    const events=[];
    for(const type of ['tmdbmetadata','tmdbbrowse','exportchange','summarychange'])store.addEventListener(type,()=>events.push(type));
    const reset=async()=>{const {session}=await store.dropboxState();
      await store.saveDropboxStatus({accountId:session.accountId,instanceId:session.instanceId,synced:true,reason:'Fictional reset',day:'2026-11-23'},()=>true);
      events.length=0;};
    const commit=store.commit.bind(store);
    for(const [id,table,record] of [[1,'watched',row(1)],[2,'ratings',{show_id:2,show:'Fictional series 2',rating:7}],
      [3,'lists',{list:'Favorites',show_id:3,show:'Fictional series 3'}],[4,'shows',{show_id:4,show:'Fictional series 4',year:null,imdb_id:''}]]){
      await commit((await store.snapshot()).revision,{put:{[table]:[record]}});
      await reset();await service.refresh({kind:'show',id});
      check(events.includes('exportchange') && (await store.dropboxState()).dirty,'Tracked '+table+' did not invalidate its export');
      await reset();await service.refresh({kind:'cast',id});
      check(events.includes(table==='watched'?'tmdbmetadata':'tmdbbrowse') && !(await store.dropboxState()).dirty,'Wrong cast relevance for '+table);
    }
    // Insert the first watch after the optimistic read, before its cache commit.
    let inserted=false;
    store.commit=async(revision,patch,options)=>{
      if(options?.tmdb&&!inserted){inserted=true;await commit(revision,{put:{watched:[row(5)]}});await reset();}
      return commit(revision,patch,options);
    };
    await service.refresh({kind:'show',id:5});
    check(inserted&&events.includes('exportchange')&&(await store.dropboxState()).dirty,'A competing first watch was classified as untracked');
    await reset();await service.refresh({kind:'show',id:6});await service.refresh({kind:'cast',id:6});
    check(events.join()==='tmdbbrowse,tmdbbrowse'&&!(await store.dropboxState()).dirty,'Untracked metadata dirtied Dropbox or invalidated Statistics');
  }));
  await run('Queued TMDB show rewrites and cast cache writes recheck the original background visit',()=>fixture(async(store,service,env)=>{
    for(const [kind,method] of [['show','commit'],['cast','writeTmdb']]){
      const original=store[method].bind(store);
      let visible=true;
      env.visible=()=>visible;
      store[method]=(...args)=>{visible=false;return original(...args);};
      let canceled=false;
      try{await service.refresh({kind,id:8},true);}catch(error){canceled=error.kind==='superseded';}
      finally{store[method]=original;}
      check(canceled && !await store.tmdbEntry(tmdbResourceKey({kind,id:8}),Date.now()),'An interrupted '+kind+' was cached');
      visible=true;await service.refresh({kind,id:8},true);
      check(!!await store.tmdbEntry(tmdbResourceKey({kind,id:8}),Date.now()),'A visible '+kind+' retry did not install the metadata');
    }
  }));
  await run('A mixed TMDB browsing cache expires only due keys across sparse, adjacent and partial batches',()=>fixture(async(store)=>{
    const now=Date.now(),old=now-4*86_400_000,entries={},wanted=[],retained=new Set();
    for(let i=0;i<2200;i++){
      const key=tmdbResourceKey({kind:'person',id:10_000+i});
      // The first expiry batch spans over 1,700 primary keys. Later keys
      // include adjacent runs, healthy gaps and a short final batch.
      const fetchedAt=i%7===0?old-1000:i>=1750&&i%23!==0?old:now;
      entries[key]={fetchedAt,value:[]};wanted.push(key);
      if(fetchedAt===now)retained.add(key);
    }
    await store.writeTmdb((await store.tmdbState()).generation,{entries});
    const events=[];
    for(const name of ['tmdbbrowse','tmdbmetadata','exportchange'])store.addEventListener(name,()=>events.push(name));
    await store.purgeTmdb(cacheExpiresAt(old));
    // Reading at the earlier clock also detects expired items that were never physically removed.
    const values=await store.tmdbEntries(wanted,now);
    check(values.every((entry,i)=>Boolean(entry)===retained.has(wanted[i])),'Expiry erased a live value or left a due value behind');
    await store.purgeTmdb(cacheExpiresAt(old));
    check(events.join()==='tmdbbrowse','One browsing eviction should publish exactly one notice');
  }));
  await run('Bulk metadata and later expiry consult the current watch, rating, title and list memberships',()=>fixture(async(store)=>{
    const now=Date.now(), generation=(await store.tmdbState()).generation, events=[];
    for(const type of ['tmdbmetadata','tmdbbrowse','exportchange'])store.addEventListener(type,()=>events.push(type));
    const {session}=await store.dropboxState();
    const reset=async()=>{
      await store.saveDropboxStatus({accountId:session.accountId,instanceId:session.instanceId,synced:true,reason:'Fictional reset',day:'2026-11-23'},()=>true);
      events.length=0;
    };
    let tick=0;
    async function exercise(ids,kind,expected,beforeExpiry) {
      const fetchedAt=now-86_400_000+ ++tick, entries={};
      for(const id of ids) entries[tmdbResourceKey({id,kind})]={fetchedAt,value:null};
      await reset();
      await store.writeTmdb(generation,{entries});
      const dirty=expected==='exportchange';
      check(Boolean((await store.dropboxState()).dirty)===dirty && events.includes(expected),'Unexpected notification during bulk '+kind+' write');
      if(beforeExpiry)await beforeExpiry();
      await reset();
      await store.purgeTmdb(cacheExpiresAt(fetchedAt));
      const after=beforeExpiry?'tmdbbrowse':expected;
      check(Boolean((await store.dropboxState()).dirty)===(after==='exportchange') && events.includes(after),'Unexpected notification expiring '+kind);
    }
    // Include a watched show whose high episode numbers and multiple positions
    // must be skipped by a show-ID-only membership lookup.
    await store.commit((await store.snapshot()).revision,{put:{watched:[row(5),{...row(5),episode:100,episode_id:9005}]}});
    await exercise([1,4,6,11],'external-ids','tmdbbrowse');
    await exercise([4,5,6],'cast','tmdbmetadata');
    await exercise([1,4,6,11],'cast','tmdbbrowse');
    for(const [id,table,record,key] of [[2,'ratings',{show_id:2,show:'Fictional series 2',rating:8},2],
      [3,'lists',{list:'Favorites',show_id:3,show:'Fictional series 3'},['Favorites',3]],
      [7,'shows',{show_id:7,show:'Fictional series 7',year:null,imdb_id:''},7]]) {
      await store.commit((await store.snapshot()).revision,{put:{[table]:[record]}});
      await exercise([1,id,9],'external-ids','exportchange',async()=>{
        await store.commit((await store.snapshot()).revision,{remove:{[table]:[key]}});
      });
    }
    await exercise([1,5,9],'external-ids','exportchange');
  }));
}
