import assert from 'node:assert/strict';
import test from 'node:test';
import { readCsv, writeCsv } from '../dist/csv.js';
import { adoptReset, checkResetHistory, performReset, resetMarker, reviewReset } from '../dist/dropbox-reset.js';
import { dropboxLimits } from '../dist/dropbox-limits.js';
import { FictionalDropbox, credentials, memoryStore, time, watch } from './dropbox-sync-fixture-cases.mjs';

const path = '/csvtv-reset.json', now = () => time;
const marker = (generations, ancestry) => ({version:ancestry ? 2 : 1, generations, pending:[],
  backupsClearedAt:0,...(ancestry ? {ancestry} : {})});
async function put(api, m) { await api.put(path,JSON.stringify(m)); return resetMarker(api); }
async function edit(store,patch) { await store.commit((await store.snapshot()).revision,patch); }
async function apply(api,store,choose) { return adoptReset(api,store,await resetMarker(api),credentials,now,undefined,choose); }
const row = rating => ({show_id:7,show:'Coastal Dial',rating});

test('the large watched-clear path admits only a settled watch table and identical unselected data',async()=>{
  const rows = Array.from({length:2050},(_,i)=>watch(2,i+1));
  const csv = writeCsv('watched',rows), initial = [watch(1)], base = {revision:'before',content:writeCsv('watched',initial)};
  const file = {base,pending:null,lastClientModified:null};
  const empty = {base:null,pending:null,lastClientModified:null};
  const setting = {setting:'appearance',value:'dark'}, recent = {setting:'recently_marked.7',value:'1/1'};
  const pending = {content:base.content,targetContent:base.content,targetRevision:base.revision,clientModified:'2026-01-01T00:00:00Z'};
  for (const mode of ['fresh','based','existing-settings','dirty-watch','pending-watch','pending-settings','local-recent',
      'remote-recent','orphan-show','mixed-clear','legacy-marker','quarantined-key','short-file','sparse']) {
    const api = new FictionalDropbox(), store = memoryStore();
    const original = mode==='fresh' ? [] : mode==='sparse' ? rows.map((r,i)=>i===0?{...r,times_watched:1}:r) : initial;
    const receipt = mode==='dirty-watch' ? {...file,base:{...base,content:writeCsv('watched',[watch(8)])}} :
      mode==='sparse' ? {...file,base:{...base,content:writeCsv('watched',original)}} : {...file,pending:mode==='pending-watch'?pending:null};
    const settings = mode==='local-recent' ? [recent] : [setting];
    const prefs = mode==='existing-settings' ? {...empty,base:{revision:'prefs',content:writeCsv('settings',settings)}} :
      mode==='pending-settings' ? {...empty,pending:{...pending,content:writeCsv('settings',settings),targetContent:null}} : undefined;
    await edit(store,{replace:{watched:original,ratings:[row(7)],settings,shows:mode==='orphan-show'?[{show_id:54,show:'Orphan'}]:[]},
      sync:{...(mode!=='fresh'&&{watched:receipt}),...(prefs&&{settings:prefs})}});
    if (mode==='quarantined-key') store.legacyProviderSettings=async()=>({migrated:false,rows:[{setting:'tmdb_key',value:'fictional'}]});
    const target=mode==='short-file'?rows.slice(0,8):rows;
    await api.put('/watched.csv',mode==='short-file'?writeCsv('watched',target):csv);
    await api.put('/settings.csv',writeCsv('settings',mode==='remote-recent'?[recent]:[setting]));
    const mixed=mode==='mixed-clear';
    await put(api,marker({watched:'cleared',...(mixed&&{lists:'cleared'})},
      mode==='legacy-marker'?undefined:{watched:[null],...(mixed&&{lists:[null]})}));
    let worker;
    store.installWatchDownload=async(_revision,watched,next,session,current,prior,reset)=>{
      assert.ok(current());assert.equal(session.accountId,credentials.accountId);assert.deepEqual(watched,target);
      assert.equal(next.base.content,csv);assert.equal(reset.after.generations.watched,'cleared');
      assert.equal(reset.initializeSettings,!prefs);worker={prior};
    };
    assert.equal(await apply(api,store,async()=> 'dropbox'),true,mode);
    assert.equal(!!worker,['fresh','based','existing-settings'].includes(mode),mode);
    if (worker) assert.equal(worker.prior?.base.revision,mode==='fresh'?undefined:'before',mode);
    else {
      const result=await store.snapshot();assert.equal(result.local.dropboxResetSeen.generations.watched,'cleared',mode);
      assert.equal(writeCsv('watched',result.tables.watched),writeCsv('watched',target),mode);
      assert.deepEqual(result.tables.ratings,[row(7)],mode);
    }
  }
});

test('adopting a watched clear writes only the changed rows and commits the reviewed generation and receipt together',async()=>{
  for(const variant of ['identical','one changed and one removed']){
    const api=new FictionalDropbox(),store=memoryStore(),all=Array.from({length:64},(_,i)=>watch(1,i+1));
    await edit(store,{replace:{watched:all,ratings:[row(7)]}});
    const expected=variant==='identical'?all:all.slice(0,-1).map((w,i)=>i===12?{...w,times_watched:3}:w);
    const remote=await api.put('/watched.csv',writeCsv('watched',expected));
    await put(api,marker({watched:'reset-1'},{watched:[null]}));
    const original=store.commit.bind(store),saves=[];
    store.commit=async(revision,changes,options)=>{saves.push(changes);return original(revision,changes,options);};
    assert.equal(await apply(api,store),true);
    assert.equal(saves.length,1);
    const change=saves[0],after=await store.snapshot();
    assert.equal(change.replace?.watched,undefined);
    assert.deepEqual(change.put?.watched??[],variant==='identical'?[]:[expected[12]]);
    assert.deepEqual(change.remove?.watched??[],variant==='identical'?[]:[[7,1,64]]);
    assert.equal(change.local.dropboxResetSeen.generations.watched,'reset-1');
    assert.equal(change.sync.watched.base.revision,remote.rev);
    assert.equal(writeCsv('watched',after.tables.watched),writeCsv('watched',expected));
    assert.deepEqual(after.tables.ratings,[row(7)]);
  }
});
test('acknowledging an unchanged reset marker avoids loading record rows and changed rows require the same device revision',async()=>{
  const api=new FictionalDropbox(),store=memoryStore(),snapshot=store.snapshot.bind(store);
  let recordReads=0;
  store.snapshot=async()=>{ recordReads++; return snapshot(); };
  await put(api,marker({},{}));
  await apply(api,store);
  await apply(api,store);
  assert.equal(recordReads,0);
  const state=await snapshot();
  await store.commit(state.revision,{replace:{ratings:[row(8)]}});
  await put(api,marker({ratings:'cleared'},{ratings:[null]}));
  const first=store.dropboxResetSnapshot.bind(store);
  store.dropboxResetSnapshot=async()=>{
    const header=await first();
    await store.commit(header.revision,{replace:{ratings:[row(9)]}});
    return header;
  };
  await assert.rejects(apply(api,store),{name:'StaleSnapshotError'});
  assert.deepEqual((await snapshot()).tables.ratings,[row(9)]);
  assert.equal(recordReads,1);
});

async function legacyFixture() {
  const api = new FictionalDropbox(), store = memoryStore();
  await api.put('/ratings.csv',writeCsv('ratings',[row(7)]));
  await put(api,marker({ratings:'known'}));
  await apply(api,store);
  await edit(store,{replace:{ratings:[row(8)],watched:[watch(3)]}});
  await api.put('/ratings.csv',writeCsv('ratings',[]));
  await put(api,marker({ratings:'unfamiliar'}));
  return {api,store};
}

test('new clears prove ancestry across missed generations and keep unrelated legacy heads unanchored',async()=>{
  const {api,store} = await legacyFixture();
  await put(api,marker({ratings:'known',lists:'legacy-list'}));
  const clear = async scopes => performReset(api,await reviewReset(api,scopes),async()=>{},now);
  const one = await clear(['ratings']);
  const two = await clear(['ratings','watched']);
  const three = await clear(['ratings']);
  assert.deepEqual(three.marker.ancestry,{watched:[null],ratings:['known',one.marker.generations.ratings,two.marker.generations.ratings],lists:[]});
  let asked = false;
  await apply(api,store,async()=>{asked=true;return 'cancel';});
  assert.equal(asked,false);
  const after = await store.snapshot();
  assert.deepEqual(after.tables.ratings,[]); assert.deepEqual(after.tables.watched,[]);
  const previous = {seen:true,...after.local.dropboxResetSeen};
  assert.throws(()=>checkResetHistory(two,previous),/older clear/);
  // An older app refuses this version before it can upload or recreate the marker.
  assert.equal(three.marker.version,2);
  const fork = structuredClone(three.marker);
  fork.generations.ratings = 'different-future';
  assert.throws(()=>checkResetHistory({revision:'other',marker:fork},previous),/diverges/);
  const truncated = structuredClone(three.marker);
  truncated.ancestry.ratings = [];
  assert.throws(()=>checkResetHistory({revision:'other',marker:truncated},previous),/diverges/);
  const prepended = structuredClone(three.marker);
  prepended.ancestry.ratings.unshift('invented-predecessor');
  assert.throws(()=>checkResetHistory({revision:'other',marker:prepended},previous),/diverges/);
  const rewrittenAnchor = structuredClone(three.marker);
  rewrittenAnchor.ancestry.lists = ['invented-predecessor'];
  assert.throws(()=>checkResetHistory({revision:'other',marker:rewrittenAnchor},previous),/diverges/);
});

test('malformed ancestry pauses before any record write or clear, while a legacy marker is still readable',async()=>{
  const {api} = await legacyFixture();
  const saved = api.live.get('/ratings.csv').metadata.rev;
  for (const ancestry of [{}, {ratings:['new']}, {ratings:['a','a']}, {ratings:['a',null]},
      {ratings:[null,32]}, {toString:[]}, {ratings:'legacy'}]) {
    await api.put(path,JSON.stringify(marker({ratings:'new'},ancestry)));
    await assert.rejects(reviewReset(api,['ratings']),/unreadable/);
    assert.equal(api.live.get('/ratings.csv').metadata.rev,saved);
  }
  assert.equal((await put(api,marker({ratings:'legacy'}))).marker.version,1);
});

test('a returning v2 device refuses disjoint histories even with clean local rows or a previously absent category',async()=>{
  const {api,store} = await legacyFixture();
  await put(api,marker({ratings:'known'},{ratings:[]}));
  await apply(api,store);
  await edit(store,{replace:{ratings:[row(7)]}});
  const before = await store.snapshot();
  for (const foreign of [marker({ratings:'other'},{ratings:['unrelated']}),
      marker({ratings:'known',lists:'other'},{ratings:[],lists:['unrelated']})]) {
    await put(api,foreign);
    await assert.rejects(apply(api,store,async()=>{throw Error('Offered an impossible v2 choice');}),/diverges/);
    assert.deepEqual(await store.snapshot(),before);
  }
  // A real first clear of the absent category starts from the empty root.
  await put(api,marker({ratings:'known',lists:'first'},{ratings:[],lists:[null]}));
  assert.equal(await apply(api,store),true);
  assert.deepEqual((await store.snapshot()).tables.ratings,before.tables.ratings);
});

test('a v1 witness can review an unknown pre-v2 head when a valid upgraded chain has a different legacy anchor',async()=>{
  const {api,store} = await legacyFixture();
  await put(api,marker({ratings:'new-v2-head'},{ratings:['older-unknown']}));
  let asked = 0;
  await apply(api,store,async scopes=>{asked++;assert.deepEqual(scopes,['ratings']);return 'device';});
  assert.equal(asked,1); assert.deepEqual((await store.snapshot()).tables.ratings,[row(8)]);
});

test('witnessing v2 without a changed category fences a same-head downgrade on the next visit',async()=>{
  const {api,store} = await legacyFixture();
  await put(api,marker({ratings:'known'},{ratings:[]}));
  await apply(api,store);
  const before = await store.snapshot();
  assert.equal(before.local.dropboxResetSeen.format,2);
  await put(api,marker({ratings:'known'}));
  await assert.rejects(apply(api,store),/older version/);
  const stale = await resetMarker(api);
  assert.throws(()=>checkResetHistory(stale,{seen:true,...before.local.dropboxResetSeen}),/older version/);
  assert.deepEqual(await store.snapshot(),before);
});

test('a full marker stops a new clear before claiming any revision or writing personal files',async()=>{
  const {api} = await legacyFixture();
  const history = [], full = marker({ratings:'known'},{ratings:history});
  let size = JSON.stringify(full).length;
  for (let i=0;;i++) {
    const value = i.toString()+ 'a'.repeat(40), extra = JSON.stringify(value).length + (i ? 1 : 0);
    if (size+extra > dropboxLimits.smallReply) break;
    history.push(value); size += extra;
  }
  await put(api,full);
  const baseline = api.calls.length, rev = api.live.get(path).metadata.rev;
  await assert.rejects(performReset(api,await reviewReset(api,['ratings','lists','watched']),async()=>{},now),/256 KiB limit/);
  assert.equal(api.live.get(path).metadata.rev,rev);
  assert.equal(api.calls.slice(baseline).some(call=>call.method === 'upload' || call.method === 'delete'),false);
});

test('an ambiguous legacy clear preserves all rows and receipts until a scoped review commits',async()=>{
  for (const decision of ['device','dropbox']) {
    const {api,store} = await legacyFixture();
    const before = await store.snapshot();
    await assert.rejects(apply(api,store),/review paused/);
    await assert.rejects(apply(api,store,async scopes=>{assert.deepEqual(scopes,['ratings']);return 'cancel';}),/review paused/);
    assert.deepEqual(await store.snapshot(),before);
    await apply(api,store,async scopes=>{assert.deepEqual(scopes,['ratings']);return decision;});
    const result = await store.snapshot();
    assert.deepEqual(result.tables.ratings,decision === 'device' ? [row(8)] : []);
    assert.deepEqual(readCsv('ratings',result.sync.ratings.base.content).rows,[]);
    assert.deepEqual(result.tables.watched,[watch(3)]);
    assert.equal(result.local.dropboxResetSeen.generations.ratings,'unfamiliar');
    assert.equal(await apply(api,store,async()=>{throw Error('Repeated finished review');}),false);
  }
});

test('a legacy answer is bound to marker and selected file revisions, local edits, and sign-in',async()=>{
  for (const change of ['marker','ratings','local','session','deadline']) {
    const {api,store} = await legacyFixture(), before = await store.snapshot();
    let clock = time;
    const review = async () => {
      if (change === 'marker') await put(api,marker({ratings:'unfamiliar'}));
      if (change === 'ratings') await api.put('/ratings.csv',writeCsv('ratings',[row(5)]));
      if (change === 'local') await edit(store,{replace:{ratings:[row(9)]}});
      if (change === 'session') await edit(store,{local:{dropboxSession:{...credentials,instanceId:'fresh'}}});
      if (change === 'deadline') clock = credentials.signInDeadline;
      return 'dropbox';
    };
    await assert.rejects(adoptReset(api,store,await resetMarker(api),credentials,()=>clock,undefined,review));
    const after = await store.snapshot();
    assert.deepEqual(after.local.dropboxResetSeen,before.local.dropboxResetSeen);
    assert.deepEqual(after.tables.ratings,change === 'local' ? [row(9)] : before.tables.ratings);
    assert.deepEqual(after.tables.watched,before.tables.watched);
  }
});

test('a pending upload by itself requires ambiguity review, and a clean legacy category can adopt silently',async()=>{
  const {api,store} = await legacyFixture();
  const before = await store.snapshot(), base = before.sync.ratings.base;
  await edit(store,{replace:{ratings:[row(7)]},sync:{ratings:{...before.sync.ratings,
    pending:{content:writeCsv('ratings',[row(8)]),targetRevision:base.revision}}}});
  const saved = await store.snapshot();
  await assert.rejects(apply(api,store,async()=> 'cancel'),/review paused/);
  assert.deepEqual((await store.snapshot()).sync.ratings.pending,saved.sync.ratings.pending);
  await edit(store,{sync:{ratings:{...saved.sync.ratings,pending:null}}});
  await apply(api,store,async()=>{throw Error('Prompted with no local ratings changes');});
  assert.deepEqual((await store.snapshot()).tables.ratings,[]);
});
