import test from 'node:test';
import assert from 'node:assert/strict';
import {writeCsv} from '../dist/csv.js';
import {DropboxSync} from '../dist/dropbox-sync.js';
import {answerDoubleMarks, mergeWatched, watchDeliveryChanges} from '../dist/watch-merge.js';
import {MAX_INTEGER} from '../dist/model.js';
import {credentials, edit, FictionalDropbox, memoryStore, sync, time, watch} from './dropbox-sync-fixture-cases.mjs';

const path='/watched.csv', csv=rows=>writeCsv('watched',rows);
const counts=rows=>rows.map(row=>[row.episode,row.times_watched]);
const at=n=>n ? [watch(n)] : [];
async function lost(target,prepared,{arrived=true}={}) {
  const cloud=new FictionalDropbox(),store=memoryStore();
  await cloud.put(path,csv(target));
  assert.equal((await sync(store,cloud).run()).complete,true);
  await edit(store,...prepared);
  const side=arrived?'after':'before';
  cloud[side]=async(method,file)=>{
    if (file===path && method==='upload') throw Error('Fictional connection closed');
  };
  await assert.rejects(sync(store,cloud).run(),/unknown outcome/);
  cloud[side]=async()=>{};
  const {pending}=(await store.snapshot()).sync.watched;
  if (!arrived) await cloud.put(path,pending.content,pending.clientModified);
  return {cloud,store,pending};
}

test('interrupted season updates ask once for consequential additions and removals and protect the independent edit from Undo',async()=>{
  const {store,cloud}=await lost([watch(2,1),watch(4,2),watch(1,3),watch(10,4)],
    [watch(3,1),watch(2,2),{...watch(10,4),title:'New label'}],{arrived:false});
  const protectedKeys=new Set();
  let questions=0;
  const result=await sync(store,cloud,{doubleMarks:async review=>{
    questions++;
    assert.equal(review.delivery,true);
    assert.deepEqual(review.episodes.map(row=>[row.episode,row.deliveryTotals]),
      [[1,{one:'3',two:'4'}],[2,{one:'2',two:'0'}]]);
    return {choice:'two',overrides:new Map([[review.episodes[0].key,'one']])};
  },protect:(table,keys)=>{if(table==='watched')for(const key of keys)protectedKeys.add(key);}}).run();
  assert.equal(result.complete,true); assert.equal(questions,1);
  assert.deepEqual(counts(cloud.rows('watched')),[[1,3],[4,10]]);
  assert.equal(protectedKeys.has('[7,"id",2]'),true); assert.equal(protectedKeys.has('[7,"id",1]'),false);
  const peer=memoryStore();
  assert.equal((await sync(peer,cloud).run()).complete,true);
  assert.deepEqual(counts((await peer.snapshot()).tables.watched),[[1,3],[4,10]]);
});

test('undo after the lost reply, cancellation, and changed local or remote inputs preserve the pending original',async()=>{
  const {store,cloud,pending}=await lost(at(1),at(2));
  await edit(store,...at(1)); // The owner undid the original mark while offline.
  let asked=0;
  assert.equal((await sync(store,cloud,{doubleMarks:async review=>{
    asked++; assert.deepEqual(review.episodes[0].deliveryTotals,{one:'1',two:'2'});
    return null;
  }}).run()).complete,false);
  assert.deepEqual((await store.snapshot()).sync.watched.pending,pending);
  assert.equal((await sync(store,cloud,{doubleMarks:assert.fail}).run()).complete,false);
  const seen=[];
  const result=await sync(store,cloud,{doubleMarks:async review=>{
    assert.equal(review.delivery,true);
    seen.push(review.episodes[0].deliveryTotals);
    if (seen.length===1) await cloud.put(path,csv(at(4)));
    if (seen.length===2) await edit(store,...at(0));
    return {choice:'two'};
  }}).run({retryCanceled:true});
  assert.equal(result.complete,true); assert.equal(asked,1);
  assert.deepEqual(seen,[{one:'1',two:'2'},{one:'3',two:'4'},{one:'2',two:'3'}]);
  assert.deepEqual(counts(cloud.rows('watched')),[[1,3]]);
  assert.equal((await store.snapshot()).sync.watched.pending,null);
});

test('account replacement during review fences every subsequent transfer and retains the receipt for the original owner',async()=>{
  const {store,cloud,pending}=await lost(at(1),at(2));
  const other={...credentials,instanceId:'unrelated',accountId:'fictional-different-account'};
  let calls;
  await assert.rejects(sync(store,cloud,{doubleMarks:async()=>{
    await store.commit((await store.snapshot()).revision,{local:{dropboxSession:other}});
    calls=cloud.calls.length; return {choice:'two'};
  }}).run(),/sign-in changed/);
  assert.equal(cloud.calls.length,calls);
  assert.deepEqual((await store.snapshot()).sync.watched.pending,pending);
  await assert.rejects(new DropboxSync(store,cloud,other,{},()=>time).run(),/sign-in changed/);
  assert.equal(cloud.calls.length,calls);
  const signedBack={...credentials,instanceId:'owner-returned'};
  await store.commit((await store.snapshot()).revision,{local:{dropboxSession:signedBack}});
  const outcome=await new DropboxSync(store,cloud,signedBack,{doubleMarks:async()=>({choice:'one'})},()=>time).run();
  assert.equal(outcome.complete,true); assert.deepEqual(counts(cloud.rows('watched')),[[1,2]]);
});

test('a named backup replacement keeps absolute counts and a consequential ordinary receipt stops a restore before any writes',async()=>{
  const {store,cloud}=await lost(at(1),at(2));
  const current=cloud.live.get(path).metadata.rev;
  await assert.rejects(sync(store,cloud).settleForRestore(['watched']),/Sync now/);
  assert.equal(cloud.live.get(path).metadata.rev,current);
  assert.ok((await store.snapshot()).sync.watched.pending);
  assert.equal((await sync(store,cloud,{doubleMarks:async()=>({choice:'one'})}).run()).complete,true);
  cloud.after=async()=>{throw Error('Fictional restore acknowledgement lost');};
  assert.equal(await sync(store,cloud).replaceForRestore('watched',csv(at(5)),await cloud.download(path)),'unknown');
  assert.equal((await store.snapshot()).sync.watched.pending.absoluteWatches,true);
  cloud.after=async()=>{};
  assert.equal((await sync(store,cloud,{doubleMarks:assert.fail}).run()).complete,true);
  assert.deepEqual(counts(cloud.rows('watched')),[[1,5]]);
});

test('later decreases to zero, renumbered stable episodes and overflow use the actual chosen play count',async()=>{
  const cases=[
    {target:[watch(1)],prepared:[],later:[],expected:[]},
    {target:[watch(3)],prepared:[watch(1)],later:[],expected:[]},
    {target:[watch(3)],prepared:[watch(1)],later:[watch(2)],totals:{one:'2',two:'1'},expected:[[1,1]]},
    {target:[watch(1,1,51)],prepared:[watch(2,1,51)],later:[watch(3,2,51)],totals:{one:'3',two:'4'},expected:[[2,4]]},
  ];
  for (const {target,prepared,later,totals,expected} of cases) {
    const {store,cloud}=await lost(target,prepared);
    await edit(store,...later);
    let questions=0;
    const result=await sync(store,cloud,{doubleMarks:async review=>{
      questions++; assert.deepEqual(review.episodes[0].deliveryTotals,totals);
      return {choice:'two'};
    }}).run();
    assert.equal(result.complete,true); assert.equal(questions,Number(!!totals));
    assert.deepEqual(counts(cloud.rows('watched')),expected);
  }
  const {store,cloud}=await lost(at(MAX_INTEGER-1),at(MAX_INTEGER));
  let totals;
  await assert.rejects(sync(store,cloud,{doubleMarks:async review=>{
    totals=review.episodes[0].deliveryTotals; return {choice:'two'};
  }}).run(),/too large/);
  assert.deepEqual(totals,{one:String(MAX_INTEGER),two:String(BigInt(MAX_INTEGER)+1n)});
  assert.ok((await store.snapshot()).sync.watched.pending);
  assert.equal((await sync(store,cloud,{doubleMarks:async()=>({choice:'one'})}).run()).complete,true);
  assert.deepEqual(counts(cloud.rows('watched')),[[1,MAX_INTEGER]]);
});

test('a legacy absolute restore cannot prove its source and a malformed purpose cannot bypass review',async()=>{
  for(const marker of [undefined,'yes',false]) {
    const {store,cloud,pending}=await lost(at(1),at(5));
    const snapshot=await store.snapshot();
    await store.commit(snapshot.revision,{sync:{watched:{...snapshot.sync.watched,pending:{...pending,absoluteWatches:marker}}}});
    let guarded=0,delivery=0;
    const result=await sync(store,cloud,{guard:async review=>{
      guarded++; assert.equal(review.decision.reason,'unknown-outcome'); return 'cancel';
    },doubleMarks:async review=>{
      delivery++; assert.equal(review.delivery,true); return {choice:'one'};
    }}).run();
    assert.equal(result.complete,marker===undefined);
    assert.equal(guarded,Number(marker!==undefined)); assert.equal(delivery,Number(marker===undefined));
    assert.deepEqual(counts(cloud.rows('watched')),[[1,5]]);
    assert.equal(!!(await store.snapshot()).sync.watched.pending,marker!==undefined);
  }
});

test('every small positive or negative later edit asks only if the two possible histories differ',()=>{
  let reviewed=0, automatic=0;
  for (let target=0;target<=4;target++) for(let prepared=0;prepared<=4;prepared++) {
    if (target===prepared) continue;
    for(let local=0;local<=4;local++) for(let remote=0;remote<=4;remote++) for(const laterChoice of ['one','two']) {
      const sameDirection=(local-prepared)*(remote-prepared)>0;
      let resultAfterLater=local+remote-prepared;
      if (sameDirection && laterChoice==='one') resultAfterLater=local>prepared?Math.max(local,remote):Math.min(local,remote);
      const expected={one:Math.max(0,resultAfterLater),two:Math.max(0,resultAfterLater+Math.max(0,2*prepared-target)-prepared)};
      const options={delivery:{changes:watchDeliveryChanges(at(target),at(prepared)),token:'fictional-receipt'}};
      const merge=()=>mergeWatched(at(prepared),at(local),at(remote),options);
      let result=merge();
      const independentShift=Math.max(0,2*prepared-target)-prepared;
      const separateLater=local+remote-prepared;
      const sameLater=local>prepared?Math.max(local,remote):Math.min(local,remote);
      const laterMatters=sameDirection && (Math.max(0,sameLater)!==Math.max(0,separateLater) ||
        Math.max(0,sameLater+independentShift)!==Math.max(0,separateLater+independentShift));
      if (laterMatters) {
        assert.equal(result.status,'double-mark'); assert.equal(result.delivery,undefined);
        options.answers=answerDoubleMarks(result,laterChoice); result=merge();
      }
      const label=JSON.stringify({target,prepared,local,remote,laterChoice});
      if(expected.one===expected.two) {
        automatic++; assert.equal(result.status,'merged',label);
        assert.equal(result.rows[0]?.times_watched??0,expected.one,label);
      } else {
        reviewed++; assert.equal(result.delivery,true,label);
        assert.deepEqual(result.episodes[0].deliveryTotals,{one:String(expected.one),two:String(expected.two)},label);
        for(const choice of ['one','two']) {
          options.delivery.answers=answerDoubleMarks(result,choice);
          const confirmed=merge(); assert.equal(confirmed.status,'merged',label);
          assert.equal(confirmed.rows[0]?.times_watched??0,expected[choice],label);
        }
      }
    }
  }
  assert.equal(reviewed+automatic,1000); assert.ok(reviewed&&automatic);
});
