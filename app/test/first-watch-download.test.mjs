import assert from 'node:assert/strict';
import test from 'node:test';
import {readCsv,writeCsv} from '../dist/csv.js';
import {SyncFiles} from '../dist/dropbox-sync-file.js';
import {credentials,FictionalDropbox,memoryStore,sync,time,watch} from './dropbox-sync-fixture-cases.mjs';

test('only an ordinary first download delegates its exact watched rows and public binding',async()=>{
  for(const kind of ['large','threshold','small','existing','based','pending','raw','discard','approval','recent']){
    const store=memoryStore(),cloud=new FictionalDropbox(),rows=Array.from({length:kind==='small'?31:kind==='threshold'?32:2051},(_,i)=>watch(1,i+1));
    const content=writeCsv('watched',rows),metadata=await cloud.put('/watched.csv',content);
    const initial=await store.snapshot();
    const empty=writeCsv('watched',[]), state={base:null,pending:null,lastClientModified:null};
    if(kind==='based')state.base={revision:'older',content:empty};
    if(kind==='pending')state.pending={content:empty,preparedAt:time,clientModified:new Date(time).toISOString(),targetRevision:null,
      targetModified:null,targetContent:null};
    if(kind==='existing')await store.commit(initial.revision,{put:{watched:[watch(3,1)]}});
    if(kind==='based'||kind==='pending')await store.commit(initial.revision,{sync:{watched:state}});
    if(kind==='recent')await store.commit(initial.revision,{local:{recentlyMarked:[7],displacedRecentMark:7}});
    const snapshot=await store.snapshot(), sync=new SyncFiles(store,cloud,credentials,()=>time);
    let installs=0;
    store.installWatchDownload=async(revision,placed,receipt,binding,current)=>{
      installs++;
      assert.deepEqual(binding,{accountId:credentials.accountId,instanceId:credentials.instanceId,signInDeadline:credentials.signInDeadline});
      assert.deepEqual(placed,readCsv('watched',content).rows);
      assert.equal(receipt.base.revision,metadata.rev);
      assert.equal(receipt.base.content,content);
      await store.commit(revision,{replace:{watched:placed},sync:{watched:receipt}},{syncWrite:true,current});
    };
    await sync.prepare('watched',snapshot,kind==='raw'?content:{rows},metadata,content,undefined,kind==='discard',kind==='approval'?()=>true:undefined);
    assert.equal(installs,Number(kind==='large'||kind==='threshold'),kind);
    const result=await store.snapshot();
    assert.equal(writeCsv('watched',result.tables.watched),content,kind);
    assert.equal(result.sync.watched.base.revision,metadata.rev,kind);
    if(kind==='recent')assert.equal(result.local.displacedRecentMark,undefined);
  }
});

test('a large first watch download keeps an intervening watch and stops on a changed grant',async()=>{
  const incoming=Array.from({length:4096},(_,i)=>watch(1,i+1));
  for(const interruption of ['edit after parse','replace grant after matching']){
    const store=memoryStore(),cloud=new FictionalDropbox();
    const remote=await cloud.put('/watched.csv',writeCsv('watched',incoming));
    let received=false,checks=0;
    cloud.before=async(method,path)=>{ if(method==='download' && path==='/watched.csv') received=true; };
    const status=store.dropboxState;
    store.dropboxState=async()=>{
      if(received && ++checks===(interruption==='edit after parse'?1:2)){
        const {revision}=await store.snapshot();
        if(interruption==='edit after parse') await store.commit(revision,{put:{watched:[watch(3,4097)]}});
        else await store.commit(revision,{local:{dropboxSession:{...credentials,instanceId:'replacement'}}});
      }
      return status();
    };
    const run=sync(store,cloud).run();
    if(interruption==='edit after parse'){
      assert.equal((await run).complete,true);
      const expected=writeCsv('watched',[...incoming,watch(3,4097)]);
      assert.equal(writeCsv('watched',(await store.snapshot()).tables.watched),expected);
      assert.equal(writeCsv('watched',cloud.rows('watched')),expected);
    }else{
      await assert.rejects(run,/sign-in changed or ended/);
      const local=await store.snapshot();
      assert.equal(local.tables.watched.length,0);
      assert.equal(local.sync.watched,undefined);
      assert.equal(cloud.live.get('/watched.csv').metadata.rev,remote.rev);
      assert.equal(cloud.calls.some(call=>call.method==='upload'),false);
    }
  }
});

test('a based peer download delegates only an ordinary large replacement of an unchanged table',async()=>{
  for (const kind of ['normal','small','threshold','unsynced','sparse','pending','guard','canceled','recent','raw','discard','callback','delivery']) {
    const store=memoryStore(),cloud=new FictionalDropbox(),size=kind==='small'?31:kind==='threshold'?32:2150;
    const local=Array.from({length:kind==='sparse'?size:48},(_,i)=>watch(1,i+1));
    const remote=Array.from({length:size},(_,i)=>watch(2,i+1));
    if(kind==='sparse') for(let i=1;i<size;i++)remote[i]=local[i];
    if(kind==='recent')for(const row of remote)row.show_id++;
    const stored={base:{revision:'last-existing',content:writeCsv('watched',local)},lastClientModified:null,pending:null};
    if(kind==='unsynced')local[0]={...local[0],times_watched:3};
    if(kind==='pending')stored.pending={content:stored.base.content,targetRevision:'pending',clientModified:null};
    const prior=await store.snapshot();
    await store.commit(prior.revision,{replace:{watched:local},sync:{watched:stored},
      local:kind==='canceled'?{'dropboxCanceled:watched':true}:kind==='recent'?{recentlyMarked:[7],displacedRecentMark:7}:{}});
    const state=await store.snapshot(), api=new SyncFiles(store,cloud,credentials,()=>time);
    const content=writeCsv('watched',remote),metadata=await cloud.put('/watched.csv',content);
    let delegated=0;
    store.installWatchDownload=async(revision,rows,receipt,owner,current,previous)=>{
      delegated++;assert.deepEqual(previous,{count:local.length,base:stored.base,lastClientModified:null});
      assert.equal(owner.instanceId,credentials.instanceId);assert.equal(current(),true);
      await store.commit(revision,{replace:{watched:rows},sync:{watched:receipt}});
    };
    const source=kind==='raw'?content:{rows:remote,ordinaryWatchDownload:kind!=='guard',reviewedWatchTarget:kind==='delivery'};
    await api.prepare('watched',state,source,metadata,content,undefined,kind==='discard',kind==='callback'?()=>true:undefined);
    assert.equal(delegated,Number(kind==='normal'||kind==='threshold'),kind);
    const final=await store.snapshot();
    assert.equal(writeCsv('watched',final.tables.watched),content,kind);
    assert.equal(final.sync.watched.base.revision,metadata.rev,kind);
    if(kind==='recent')assert.equal(final.local.displacedRecentMark,undefined);
  }
});

test('ordinary sparse peer downloads delegate by changed rows and preserve unchanged episodes and old recent marks',async()=>{
  for(const kind of ['31 edits','32 edits','removals','updates','obsolete recent','dirty base','duplicate']){
    const store=memoryStore(),cloud=new FictionalDropbox(),local=Array.from({length:240},(_,i)=>watch(1,i+1));
    if(kind==='obsolete recent')local[239]={...local[239],show_id:8};
    const previous={base:{revision:'saved-watch-base',content:writeCsv('watched',local)},lastClientModified:null,pending:null};
    if(kind==='dirty base')local[120]={...local[120],times_watched:4};
    const count=kind==='31 edits'?31:32;
    let remote=local.map((r,i)=>i<count?{...r,times_watched:3}:r);
    if(kind==='removals')remote=local.slice(count);
    if(kind==='32 edits')remote=[...local.slice(1).map((r,i)=>i<count-2?{...r,times_watched:4}:r),watch(2,241)];
    if(kind==='obsolete recent')remote=remote.filter(row=>row.show_id!==8);
    await store.commit((await store.snapshot()).revision,{replace:{watched:local},sync:{watched:previous},
      local:kind==='obsolete recent'?{recentlyMarked:[8],displacedRecentMark:8}:{}});
    const snapshot=await store.snapshot(),api=new SyncFiles(store,cloud,credentials,()=>time);
    const content=writeCsv('watched',remote),metadata=await cloud.put('/watched.csv',content);
    let delegated=0;
    store.installWatchDownload=async(revision,delta,receipt,owner,current,prior)=>{
      delegated++;assert.equal(delta.put.length+delta.remove.length,count);assert.equal(owner.instanceId,credentials.instanceId);
      assert.equal(current(),true);assert.deepEqual(prior,{count:240,base:previous.base,lastClientModified:null});
      assert.equal(delta.put.some(row=>row.episode===120),false);
      if(kind==='removals')assert.equal(delta.put.length,0);
      if(kind==='updates')assert.equal(delta.remove.length,0);
      await store.commit(revision,{put:{watched:delta.put},remove:{watched:delta.remove},sync:{watched:receipt}});
    };
    if(kind==='duplicate'){
      await assert.rejects(api.prepare('watched',snapshot,{rows:[...remote,remote[0]],ordinaryWatchDownload:true},metadata,content),/duplicate/i);
      assert.deepEqual((await store.snapshot()).sync.watched,previous);assert.equal(delegated,0);continue;
    }
    await api.prepare('watched',snapshot,{rows:remote,ordinaryWatchDownload:true},metadata,content);
    assert.equal(delegated,Number(['32 edits','removals','updates'].includes(kind)),kind);
    const after=await store.snapshot();
    assert.equal(writeCsv('watched',after.tables.watched),content,kind);
    assert.equal(after.sync.watched.base.revision,metadata.rev,kind);
    if(kind==='obsolete recent')assert.equal(after.local.displacedRecentMark,undefined);
  }
});
