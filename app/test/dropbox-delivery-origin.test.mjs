import assert from 'node:assert/strict';
import test from 'node:test';
import { writeCsv } from '../dist/csv.js';
import { SyncFiles } from '../dist/dropbox-sync-file.js';
import { compareValueDelivery } from '../dist/dropbox-delivery.js';
import { mergeRows,mergeWatched } from '../dist/merge.js';
import { LIST_DECLARATION_ID, watchPosition } from '../dist/model.js';
import { credentials,FictionalDropbox,memoryStore,sync,time,watch } from './dropbox-sync-fixture-cases.mjs';

const allowImpact = async q => q.decision.choices.includes('merge-anyway') ? 'merge-anyway' : 'cancel';
const show = {show_id:33,show:'Fictional Harbour'};
const score = rating => [{...show,rating}];
test('A Dropbox recovery choice identifies a list declaration by name and keeps its real show separate', () => {
  const list = 'Evening shows';
  const declaration = {list,show_id:LIST_DECLARATION_ID,show:''};
  const member = {list,show_id:0,show:''};
  assert.deepEqual(compareValueDelivery('lists',[declaration],[member],[]).rows,[
    {label:'List “Evening shows”',shared:'Included',independent:'Removed'},
    {label:'Show 0 · Evening shows',shared:'Removed',independent:'Included'}
  ]);
});
async function replace(store,table,rows) {
  await store.commit((await store.snapshot()).revision,{replace:{[table]:rows}});
}
async function interrupted(table,base,prepared,arrived=false) {
  const store = memoryStore(), cloud = new FictionalDropbox(), path = '/'+table+'.csv';
  if (base) {
    await cloud.put(path,writeCsv(table,base));
    assert.equal((await sync(store,cloud).run()).complete,true);
  }
  await replace(store,table,prepared);
  const phase = arrived ? 'after' : 'before';
  cloud[phase] = async(method,file)=>{if(method==='upload' && file===path)throw Error('Fictional connection closed');};
  await assert.rejects(sync(store,cloud).run(),/unknown outcome/);
  cloud[phase] = async()=>{};
  const pending = (await store.snapshot()).sync[table].pending;
  const peer = (rows,matching = false) => cloud.put(path,writeCsv(table,rows),matching ? pending.clientModified : undefined);
  return {store,cloud,path,peer,pending};
}

test('an update of an already existing file cannot acknowledge a first upload, even within the same server second',async()=>{
  for(const tied of [false,true]) {
    const {store,cloud,path,peer}=await interrupted('watched',null,[watch(8)]);
    await replace(store,'watched',[watch(7)]);
    const first=await peer([watch(9)]),second=await peer([watch(8)],true);
    if(tied)first.serverModified=second.serverModified;
    const result=await sync(store,cloud,{doubleMarks:()=>assert.fail('Older revision has the same file ID')}).run();
    assert.equal(result.complete,true);
    assert.deepEqual(cloud.rows('watched'),[watch(8)]);
    assert.equal(cloud.live.get(path).metadata.rev,second.rev);
  }
});

test('a replacement file at the same path cannot acknowledge a conditional update to the deleted file',async()=>{
  for(const laterRevision of [false,true]) {
    const {store,cloud,path,peer,pending}=await interrupted('ratings',score(7),score(8));
    await replace(store,'ratings',score(7));
    const original=cloud.live.get(path).metadata;
    cloud.live.delete(path);
    const created=await peer(score(8),true);
    assert.notEqual(created.id,original.id); created.serverModified=original.serverModified;
    if(laterRevision)await peer(score(9));
    const current=cloud.live.get(path).metadata;
    const run=await sync(store,cloud,{valueDelivery:()=>assert.fail('The new file has a different ID')}).run();
    assert.equal(run.complete,true); assert.equal(cloud.live.get(path).metadata.rev,current.rev);
    assert.deepEqual((await store.snapshot()).tables.ratings,score(laterRevision?9:8));
    assert.equal((await store.snapshot()).sync.ratings.pending,null);
    assert.equal(original.rev,pending.targetRevision);
  }
});

test('an uncertain first watch file offers the exact shared and independent totals and Cancel keeps the receipt',async()=>{
  for(const original of ['arrived','peer','recreated']) for(const choice of ['one','two']) {
    const {store,cloud,path,peer,pending}=await interrupted('watched',null,[watch(8)],original==='arrived');
    if(original==='recreated') {await peer([watch(9)]);cloud.live.delete(path);}
    if(original!=='arrived')await peer([watch(8)],true);
    await replace(store,'watched',[watch(7)]);
    let questions=0;
    const hooks={doubleMarks:async q=>{
      questions++;
      assert.equal(q.firstCopy,true);
      assert.deepEqual(q.episodes.map(e=>e.deliveryTotals),[{one:'7',two:'8'}]);
      return questions===1 ? null : {choice};
    }};
    assert.equal((await sync(store,cloud,hooks).run()).complete,false);
    assert.deepEqual((await store.snapshot()).sync.watched.pending,pending);
    assert.deepEqual(cloud.rows('watched'),[watch(8)]);
    assert.equal((await sync(store,cloud,hooks).run({retryCanceled:true})).complete,true);
    assert.deepEqual(cloud.rows('watched'),[watch(choice==='one'?7:8)]);
    assert.equal((await store.snapshot()).sync.watched.pending,null);
    assert.equal(questions,2,original+' '+choice);
  }
});

test('agreeing first-copy totals and explicit acknowledgements complete without a recovery question',async()=>{
  const {store,cloud,peer}=await interrupted('watched',null,[watch(8)]);
  await peer([watch(8)],true); await replace(store,'watched',[watch(9)]);
  const hooks={doubleMarks:()=>assert.fail('Both histories give nine plays'),valueDelivery:()=>assert.fail('Unexpected question')};
  assert.equal((await sync(store,cloud,hooks).run()).complete,true);
  assert.deepEqual(cloud.rows('watched'),[watch(9)]);
  const direct=memoryStore(),other=new FictionalDropbox();
  await replace(direct,'watched',[watch(8)]); await sync(direct,other,hooks).run();
  await replace(direct,'watched',[watch(7)]); await sync(direct,other,hooks).run();
  assert.deepEqual(other.rows('watched'),[watch(7)]);
});

test('a second interrupted watch correction retains the remote count reviewed on the first recovery',async()=>{
  for(const answer of ['one','two']) {
    const {store,cloud,path,peer}=await interrupted('watched',null,[watch(8)]);
    await peer([watch(8)],true); await replace(store,'watched',[watch(7)]);
    cloud.after=async(method,file)=>{if(method==='upload' && file===path)throw Error('Reply lost again');};
    let first=0;
    await assert.rejects(sync(store,cloud,{doubleMarks:async q=>{
      first++; assert.equal(q.firstCopy,true);
      assert.deepEqual(q.episodes[0].deliveryTotals,{one:'7',two:'8'});
      return {choice:'one'};
    }}).run(),/unknown outcome/);
    assert.equal(first,1); assert.deepEqual(cloud.rows('watched'),[watch(7)]);
    cloud.after=async()=>{}; await replace(store,'watched',[watch(6)]);
    let second=0;
    await sync(store,cloud,{doubleMarks:async q=>{
      second++; assert.equal(q.firstCopy,undefined);
      assert.deepEqual(q.episodes[0].deliveryTotals,{one:'6',two:'5'});
      return {choice:answer};
    }}).run();
    assert.equal(second,1); assert.deepEqual(cloud.rows('watched'),[watch(answer==='one'?6:5)]);
  }
});

test('later last-watch removals need a second decision only when the earlier interrupted addition can still affect the result',()=>{
  const base=watch(2);
  for(const delta of [undefined,-1n,0n,2n]) {
    const delivery={token:'fictional-review',...(delta!==undefined && {changes:new Map([[watchPosition(base),delta]])})};
    const result=mergeWatched([base],[],[],{delivery});
    if(delta===2n) {
      assert.equal(result.status,'double-mark'); assert.equal(result.delivery,undefined);
    } else {
      assert.equal(result.status,'merged'); assert.deepEqual(result.rows,[]);
    }
  }
});

test('ratings, memberships and settings review show only the rows whose outcomes differ and never expose credential values',async()=>{
  const member=[{...show,list:'Weekend'}], preference=value=>[{setting:'github_token',value}];
  const cases=[
    ['ratings',score(7),score(8),score(7),'7/10','8/10'],
    ['ratings',null,score(8),[],'Unrated','8/10'],
    ['lists',[],member,[],'Removed','Included'],
    ['settings',preference('fictional-local-only'),preference('fictional-remote-only'),preference('fictional-local-only'),
      'Use this device’s value','Use Dropbox’s value'],
  ];
  for(const [table,base,prepared,local,shared,independent] of cases) for(const choice of ['shared','independent']) {
    const {store,cloud,peer,pending}=await interrupted(table,base,prepared);
    await peer(prepared,true); await replace(store,table,local);
    let asks=0;
    const hooks={guard:allowImpact,valueDelivery:async q=>{
      asks++;
      assert.equal(q.table,table); assert.equal(q.rows.length,1);
      assert.equal(q.rows[0].shared,shared); assert.equal(q.rows[0].independent,independent);
      assert.doesNotMatch(JSON.stringify(q),/fictional-(?:local|remote)-only/);
      return asks===1 ? null : choice;
    }};
    assert.equal((await sync(store,cloud,hooks).run()).complete,false);
    assert.deepEqual((await store.snapshot()).sync[table].pending,pending);
    assert.deepEqual(cloud.rows(table),prepared);
    assert.equal((await sync(store,cloud,hooks).run({retryCanceled:true})).complete,true);
    const expected=choice==='shared' ? local : prepared;
    assert.deepEqual(cloud.rows(table),expected);
    const fresh=memoryStore(); await sync(fresh,cloud).run();
    assert.deepEqual((await fresh.snapshot()).tables[table],expected);
    assert.equal(asks,2);
  }
});

test('a revised peer score invalidates the displayed alternatives before confirmation',async()=>{
  const {store,cloud,peer}=await interrupted('ratings',score(7),score(8));
  await peer(score(8),true); await replace(store,'ratings',score(7));
  const alternatives=[];
  const result=await sync(store,cloud,{valueDelivery:async q=>{
    alternatives.push(q.rows[0].independent);
    if(alternatives.length===1) {await peer(score(9));return 'shared';}
    return 'independent';
  }}).run();
  assert.equal(result.complete,true);
  assert.deepEqual(alternatives,['8/10','9/10']);
  assert.deepEqual(cloud.rows('ratings'),score(9));
});

test('a conditional refusal followed by its old target cannot silently acknowledge an interrupted change',async()=>{
  for(const staleReads of [1,2]) {
    const {store,cloud,path,pending}=await interrupted('watched',[watch(7)],[watch(8)],true);
    await replace(store,'watched',[watch(7)]);
    const original=cloud.history.get(path).at(-1),read=cloud.download.bind(cloud);
    let stale=staleReads,questions=0;
    cloud.download=async name=>{
      if(name===path && stale>0){stale--;return structuredClone(original);}
      return read(name);
    };
    const run=()=>sync(store,cloud,{doubleMarks:async q=>{
      assert.deepEqual(q.episodes[0].deliveryTotals,{one:'7',two:'8'});
      questions++;return {choice:'one'};
    }}).run();
    if(staleReads===2) {
      await assert.rejects(run(),/old revision.*pending/);
      assert.equal(questions,0);assert.deepEqual((await store.snapshot()).sync.watched.pending,pending);
      assert.deepEqual(cloud.rows('watched'),[watch(8)]);
    }
    assert.equal((await run()).complete,true);
    assert.equal(questions,1);assert.deepEqual(cloud.rows('watched'),[watch(7)]);
  }
});

test('a damaged inspection-only field preserves the pending file without replay',async()=>{
  const {store,cloud,path,pending}=await interrupted('ratings',score(7),score(8));
  for(const mode of [false,true,1,'false']) {
    const s=await store.snapshot(),damaged={...pending,inspectOnly:mode};
    await store.commit(s.revision,{sync:{ratings:{...s.sync.ratings,pending:damaged}}});
    cloud.calls.length=0;
    const run=await sync(store,cloud,{guard:async q=>{assert.equal(q.decision.reason,'unknown-outcome');return 'cancel';}})
      .run({retryCanceled:true});
    assert.equal(run.complete,false);
    assert.ok(!cloud.calls.some(call=>call.path===path && call.method==='upload'));
    assert.deepEqual((await store.snapshot()).sync.ratings.pending,damaged);
  }
});

test('a known absolute score restore completes, a legacy restore compares the outcomes, and an invalid mode cannot replay',async()=>{
  for(const mode of ['absolute','legacy','invalid']) {
    const store=memoryStore(),cloud=new FictionalDropbox(),path='/ratings.csv';
    await cloud.put(path,writeCsv('ratings',score(7))); await sync(store,cloud).run();
    const files=new SyncFiles(store,cloud,credentials,()=>time),snapshot=await store.snapshot(),live=await cloud.download(path);
    const pending=await files.prepare('ratings',snapshot,writeCsv('ratings',score(8)),live.metadata,writeCsv('ratings',score(7)));
    assert.equal(pending.absoluteValues,true); assert.equal(pending.absoluteWatches,undefined);
    cloud.after=async()=>{throw Error('Fictional lost reply');};
    assert.equal((await files.send('ratings',pending)).status,'unknown');
    cloud.after=async()=>{};
    if(mode!=='absolute') {
      const s=await store.snapshot(),copy={...s.sync.ratings.pending};
      if(mode==='legacy')delete copy.absoluteValues; else copy.absoluteValues='true';
      await store.commit(s.revision,{sync:{ratings:{...s.sync.ratings,pending:copy}}});
    }
    await replace(store,'ratings',score(7));
    let asked=0,guards=0;
    cloud.calls.length=0;
    const result=await sync(store,cloud,{valueDelivery:async()=>{asked++;return 'independent';},
      guard:async q=>{assert.equal(q.decision.reason,'unknown-outcome');guards++;return 'cancel';}}).run();
    assert.equal(asked,mode==='legacy'?1:0);
    assert.equal(guards,mode==='invalid'?1:0);
    assert.equal(result.complete,mode!=='invalid');
    assert.deepEqual(cloud.rows('ratings'),score(mode==='absolute'?7:8));
    if(mode==='invalid') {
      assert.ok((await store.snapshot()).sync.ratings.pending);
      assert.ok(!cloud.calls.some(call=>call.method==='upload' && call.path===path));
    }
  }
});

test('a different active sign-in cannot apply a displayed score decision to the old pending record',async()=>{
  const {store,cloud,peer,pending}=await interrupted('ratings',score(7),score(8));
  await peer(score(8),true); await replace(store,'ratings',score(7));
  await assert.rejects(sync(store,cloud,{valueDelivery:async()=>{
    const s=await store.snapshot();
    await store.commit(s.revision,{local:{dropboxSession:{...credentials,instanceId:'fictional-next-grant'}}});
    return 'shared';
  }}).run());
  assert.deepEqual((await store.snapshot()).sync.ratings.pending,pending);
  assert.deepEqual(cloud.rows('ratings'),score(8));
});

test('the review detects every material value-row difference independently of labels, absence and row order',()=>{
  const alternatives={
    ratings:[[],score(7),score(8),[{...show,show:'',rating:7}],[{...show,show:'Show 33',rating:7}]],
    lists:[[],[{...show,list:'Weekend'}],[{...show,show:'',list:'Weekend'}],[{...show,show:'Show 33',list:'Weekend'}]],
    settings:[[],[{setting:'github_token',value:'fictional-value-a'}],[{setting:'github_token',value:'fictional-value-b'}]],
  };
  let compared=0;
  for(const [table,states] of Object.entries(alternatives)) {
    for(const sharedBase of states)for(const independentBase of [null,...states])for(const local of states)for(const cloud of states) {
      const first=mergeRows(table,sharedBase,local,cloud).rows,separate=mergeRows(table,independentBase,local,cloud).rows;
      const different=writeCsv(table,first)!==writeCsv(table,separate);
      const review=compareValueDelivery(table,first,separate,local);
      assert.equal(!!review.rows.length,different);
      for(const row of review.rows)assert.notEqual(row.shared,row.independent,JSON.stringify({table,sharedBase,independentBase,local,cloud}));
      assert.doesNotMatch(JSON.stringify(review),/fictional-value-/);
      compared++;
    }
  }
  assert.ok(compared>1000);
  const values=[...score(7),{...show,show_id:89,rating:2}];
  assert.deepEqual(compareValueDelivery('ratings',values,[...values].reverse(),values).rows,[]);
});
