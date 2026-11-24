import test from 'node:test';
import assert from 'node:assert/strict';
import { readCsv, writeCsv, writeCsvWithRows } from '../dist/csv.js';
import { mergeRows } from '../dist/merge.js';
import { legacyRecentRows, nextRecentChange, orderedRecents, recentEntries, recentRow } from '../dist/recent-history.js';
import { DropboxSync, unsyncedCount } from '../dist/dropbox-sync.js';
import { SyncFiles, tableMatchesDropboxBase } from '../dist/dropbox-sync-file.js';
import { DropboxError } from '../dist/dropbox-client.js';
import { confirmSingleDelivery, credentials, count, edit, FictionalDropbox, memoryStore, sync, time, watch, watchCsv } from './dropbox-sync-fixture-cases.mjs';

const path = '/watched.csv';
const other = () => Object.assign(new Error('No reply'), { kind: 'unavailable' });
const acceptBoth = { doubleMarks: async review => ({ choice: review.delivery ? 'one' : 'two' }), guard: async q => q.decision.choices.includes('merge-anyway') ? 'merge-anyway' : 'cancel' };

test('a clean four-file check revalidates its record, grant and protected settings before accepting the folder listing',async()=>{
  const title={show_id:7,show:'Coastal Dial'}, key={setting:'omdb_key',value:'fictional-key'};
  for(const mode of ['no change','local edit','fresh sign-in','stale settings listing']){
    const store=memoryStore(),cloud=new FictionalDropbox(),theme={setting:'appearance',value:'dark'};
    for(const [table,rows] of Object.entries({watched:[watch(1)],ratings:[{...title,rating:7}],lists:[{...title,list:'Favorites'}],settings:[theme,key]}))
      await cloud.put('/'+table+'.csv',writeCsv(table,rows));
    const engine=()=>new DropboxSync(store,cloud,credentials,{},()=>time,async()=>{});
    assert.ok((await engine().run()).complete);
    const listing=await cloud.list('');
    if(mode==='stale settings listing'){
      await cloud.put('/settings.csv',writeCsv('settings',[{...theme,value:'light'},key]));
      cloud.list=async()=>listing;
    }
    let first=true,lookups=0;
    cloud.before=async(method,path)=>{
      if(method!=='download'||path!=='/settings.csv') return;
      lookups++;
      if(!first) return;
      first=false;
      const s=await store.snapshot();
      if(mode==='local edit') await store.commit(s.revision,{put:{ratings:[{...title,rating:9}]}});
      if(mode==='fresh sign-in') await store.commit(s.revision,{local:{dropboxSession:{...credentials,instanceId:'replacement'}}});
    };
    const writes=cloud.calls.filter(c=>c.method==='upload').length;
    if(mode==='fresh sign-in') await assert.rejects(engine().run({previouslySynced:true}),/sign-in changed/);
    else assert.ok((await engine().run({previouslySynced:true})).complete);
    assert.ok(lookups>0,'the protected Dropbox settings must still be read');
    const result=await store.snapshot();
    assert.equal(cloud.rows('ratings')[0].rating,mode==='local edit'?9:7);
    assert.equal(result.tables.settings[0].value,mode==='stale settings listing'?'light':'dark');
    assert.ok(cloud.rows('settings').some(r=>r.value===key.value));
    assert.equal(cloud.calls.filter(c=>c.method==='upload').length,writes+(mode==='local edit'?1:0));
  }
});

test('unrecognized Dropbox names are reported in discovery order just once across repeated syncs and reopens',async()=>{
  const store=memoryStore(),cloud=new FictionalDropbox(),notices=[];
  let names=[];
  cloud.list=async()=>names.map(name=>({name,path:'/'+name,kind:'folder'}));
  const run=()=>sync(store,cloud,{notice:message=>notices.push(message)}).run();
  assert.equal((await run()).complete,true);
  assert.equal((await store.snapshot()).local.dropboxUnknownFiles,undefined);
  const first='Fictional notes',second='Fictional plan',third='Fictional archive';
  names=['BACKUPS',first,first,second,'README.txt'];
  await run();
  names=[second,first];
  await run();
  names=[];
  await run();
  names=[third,second,third];
  await run();
  assert.deepEqual((await store.snapshot()).local.dropboxUnknownFiles,[first,second,third]);
  assert.deepEqual(notices,[first,second,third].map(name=>'Unrecognized Dropbox item: '+name));
});

test('rows retained by sync serialization exactly match reading its CSV bytes',()=>{
  const examples = {
    watched:[{...watch(3,2),title:'Two, "b"\r\n🍋',localAnnotation:'fictional'},watch(1,1)],
    ratings:[{show_id:2,show:'Ω',rating:0.5},{show_id:1,show:'A',rating:0,extra:'fictional'}],
    lists:[{list:'Favourites',show_id:1,show:'A'},{list:'Favorites',show_id:1,show:'A'},{list:'Stopped',show_id:2,show:'Ω'}],
    settings:[{setting:'imdb_source',value:'omdb',extra:true}],
  };
  for (const [table,rows] of Object.entries(examples)) {
    const {content,rows:retained} = writeCsvWithRows(table,rows);
    assert.deepEqual(retained,readCsv(table,content).rows,table);
    assert.equal(content,writeCsv(table,rows),table);
    assert.ok(retained.every(row=>!rows.includes(row)),table+' must own canonical copies');
  }
});

test('a merged record preserves quoted fields and keeps only CSV columns after reopening',async()=>{
  const {store,cloud} = await linked();
  const mine = {...watch(2),title:'Opening, "reprise"',deviceOnly:'fictional'};
  const theirs = {...watch(3,2),title:'Two\r\nlines'};
  await edit(store,mine);
  await cloud.put(path,writeCsv('watched',[watch(1),theirs]));
  assert.equal((await sync(store,cloud).run()).complete,true);
  const expected = readCsv('watched',writeCsv('watched',[mine,theirs])).rows;
  assert.deepEqual((await store.snapshot()).tables.watched,expected);
  const other = memoryStore();
  assert.equal((await sync(other,cloud).run()).complete,true);
  assert.deepEqual((await other.snapshot()).tables.watched,expected);
});

test('Two upgraded devices settle the old list receipt, canonicalize only memberships and preserve a remote deletion', async () => {
  const cloud = new FictionalDropbox(), a = memoryStore(), b = memoryStore(), path = '/lists.csv';
  const original = 'list,show_id,show\nFavourites,1,Signal North\nfAvOrItEs,1,Signal North\nSTOPPED,2,Second\n' +
    Array.from({length:10},(_,i)=>'My Favourites,'+(i+3)+',Fictional '+i+'\n').join('');
  const pendingContent = original+'favourites,12,Fictional 9\n';
  const before = await cloud.put(path,original);
  for (const table of ['watched','ratings','settings']) await cloud.put('/'+table+'.csv',writeCsv(table,[]));
  const clientModified = new Date(time).toISOString();
  const accepted = await cloud.put(path,pendingContent,clientModified);
  const pending = {content:pendingContent,targetContent:original,targetRevision:before.rev,
    targetModified:before.serverModified,clientModified,preparedAt:time};
  const base = {revision:before.rev,content:original}, submitted = {base,pending,lastClientModified:clientModified};
  const review = {guard:async q=>{throw Error('Unexpected guard '+q.decision.reason);}};
  await a.commit(1n,{replace:{lists:readCsv('lists',pendingContent).rows},sync:{lists:submitted}});
  await b.commit(1n,{replace:{lists:readCsv('lists',original).rows},sync:{lists:{base,pending:null}}});
  assert.equal((await sync(a,cloud,review).run()).complete,true);
  const current = new TextDecoder().decode(cloud.live.get(path).bytes);
  assert.equal(current,writeCsv('lists',readCsv('lists',pendingContent).rows));
  assert.match(current,/Dropped,2,Second/);
  assert.match(current,/Favorites,12,Fictional 9/);
  assert.equal(cloud.calls.filter(c=>c.method==='upload' && c.path!==path).length,0);
  const [replay,rewrite] = cloud.calls.filter(c=>c.method==='upload');
  assert.equal(replay.content,pendingContent); assert.equal(replay.options.revision,before.rev);
  assert.equal(rewrite.content,current); assert.equal(rewrite.options.revision,accepted.rev);
  const next = cloud.rows('lists').filter(row=>row.list!=='Dropped');
  await a.commit((await a.snapshot()).revision,{replace:{lists:next}});
  assert.equal((await sync(a,cloud,review).run()).complete,true);
  const updated = (await b.snapshot()).tables.lists;
  updated.push({show_id:50,show:'Later Show',list:'Other'});
  await b.commit((await b.snapshot()).revision,{replace:{lists:updated}});
  assert.equal((await sync(b,cloud,review).run()).complete,true);
  assert.equal((await sync(a,cloud,review).run()).complete,true);
  for (const store of [a,b]) {
    const saved = await store.snapshot();
    assert.equal(saved.tables.lists.some(row=>row.list==='Dropped'),false);
    assert.equal(saved.tables.lists.filter(row=>row.list==='Favorites').length,2);
    assert.equal(saved.tables.lists.filter(row=>row.list==='My Favourites').length,10);
    assert.equal(saved.sync.lists.base.content,writeCsv('lists',saved.tables.lists));
    assert.equal(saved.sync.lists.pending,null);
    assert.ok(saved.tables.lists.some(row=>row.show_id===50 && row.list==='Other'));
  }
  // Restoring old verified bytes should produce a canonical live lists.csv. Raw snapshots remain valid evidence.
  const engine = sync(a,cloud,review);
  assert.equal(await engine.replaceForRestore('lists',original,await cloud.download(path)),'restored');
  assert.equal(new TextDecoder().decode(cloud.live.get(path).bytes),writeCsv('lists',readCsv('lists',original).rows));
});

test('A receipt check revalidates its account, instance and earlier session deadline without loading the record', async () => {
  let local = {syncAccountId:credentials.accountId,dropboxSession:credentials}, clock = time;
  const store = {snapshot:()=>{ throw Error('Unexpected full record read'); },dropboxSyncCheck:async()=>({local,pending:null})};
  const files = new SyncFiles(store,{},credentials,()=>clock);
  assert.deepEqual(await files.settle('watched'),{});
  local = {...local,syncAccountId:'other'};
  await assert.rejects(files.check(),/sign-in changed/);
  local = {syncAccountId:credentials.accountId,dropboxSession:{...credentials,instanceId:'renewed'}};
  await assert.rejects(files.settle('ratings'),/sign-in changed/);
  local.dropboxSession = credentials; clock = credentials.signInDeadline;
  await assert.rejects(files.check(),/sign-in changed/);
});

test('Reusing a sync snapshot requires the same revision, account, grant and live deadline',async()=>{
  const store = memoryStore();
  let now = time, reads = 0;
  const original = store.snapshot;
  store.snapshot = () => { reads++; return original(); };
  const files = new SyncFiles(store,{},credentials,()=>now);
  const initial = await files.snapshot();
  assert.equal(await files.snapshot(initial),initial);
  assert.equal(reads,1);
  await store.commit(initial.revision,{replace:{watched:[watch(2)]}});
  const edited = await files.snapshot(initial);
  assert.equal(edited.tables.watched[0].times_watched,2);
  assert.equal(reads,2);
  // Even if a stale reader reports the same revision, a different grant cannot reuse its rows.
  const status = await store.dropboxState();
  for (const changed of [{...status,accountId:'other'},{...status,session:{...status.session,instanceId:'new-grant'}}]) {
    store.dropboxState = async () => changed;
    await assert.rejects(files.snapshot(edited),/sign-in changed/);
  }
  store.dropboxState = async () => status;
  now = credentials.signInDeadline;
  await assert.rejects(files.snapshot(edited),/sign-in changed/);
});

test('After yielding between files the settings merge reads the current revision and preserves pending watch edits', async () => {
  const store = memoryStore(), cloud = new FictionalDropbox();
  const settings = '/settings.csv';
  const repo = value => ({setting:'github_repo',value});
  await cloud.put(settings,writeCsv('settings',[repo('fictional/first')]));
  const engine = () => new DropboxSync(store,cloud,credentials,{},()=>time,async()=>{});
  assert.equal((await engine().run()).complete,true);
  await edit(store,watch(2));
  let yielded = false;
  const key = {setting:'github_token',value:'fictional-test-value'};
  const result = await engine().run({async beforeMerge() {
    if (yielded || cloud.rows('watched')[0]?.times_watched !== 2) return false;
    yielded = true;
    // The key save carries forward a repository preference just changed on another device.
    await cloud.put(settings,writeCsv('settings',[repo('fictional/current'),key]));
    return true;
  }});
  assert.equal(yielded,true); assert.equal(result.complete,true);
  assert.equal(await count(store),2);
  const snapshot = await store.snapshot();
  assert.deepEqual(snapshot.tables.settings,[repo('fictional/current')]);
  assert.equal(snapshot.sync.settings.base.revision,cloud.live.get(settings).metadata.rev);
  assert.ok(cloud.rows('settings').some(row=>row.setting===key.setting && row.value===key.value));
});

test('Recent settings retain a newer dismissal over an offline mark, merge independent shows and guard unknown representations', () => {
  const old = recentRow(3,100,100), changed = recentRow(3,200,200), removed = recentRow(3,200,0);
  const extra = recentRow(5,201,201), legacy = legacyRecentRows([5,8,3,8,-1],new Set([3,8]));
  assert.deepEqual(legacy,[recentRow(8,2,2),recentRow(3,1,1)]);
  for (const [local,remote] of [[[changed,extra],[removed]],[[removed],[changed,extra]]]) {
    const merged = mergeRows('settings',[old],local,remote);
    assert.deepEqual(merged.clashes,[]);
    assert.equal(writeCsv('settings',merged.rows),writeCsv('settings',[extra,removed]));
  }
  assert.equal(writeCsv('settings',mergeRows('settings',null,legacy,[removed]).rows),
    writeCsv('settings',[legacy[0],removed]));
  const large = 9007199254740991n;
  for (const changed of [large,large+1n,large*large]) {
    const parsed = readCsv('settings',writeCsv('settings',[recentRow(3,changed,1)]));
    assert.equal(parsed.schema,'known');
    const next = nextRecentChange(recentEntries(parsed.rows));
    assert.equal(next,changed+1n);
    assert.deepEqual(orderedRecents(recentEntries([...parsed.rows,recentRow(4,next,next)])),[4,3]);
  }
  for (const [setting,value] of [['recently_marked.03','1/1'],['recently_marked.3','v2'],['recently_marked.3','9/10'],
      ['recently_marked.3','9007199254740992.5/0']]) {
    assert.equal(readCsv('settings','setting,value\r\n'+setting+','+value+'\r\n').schema,'unknown');
  }
});

test('Dropbox drops a cleared show from device recents and later downloads cannot put it back', async () => {
  const store = memoryStore(), cloud = new FictionalDropbox();
  const kept = watch(2);
  const cleared = {...watch(1,1,82), show_id:8, show:'Archive'};
  const stale = {...watch(1,1,93), show_id:9, show:'Night desk'};
  const download = async rows => {
    await cloud.put(path,writeCsv('watched',rows));
    const result = await sync(store,cloud,{guard: async () => 'take-remote'}).run();
    assert.equal(result.complete,true);
    return store.snapshot();
  };
  await download([kept,cleared]);
  // A previous version could leave an unwatched title in local history.
  await store.commit((await store.snapshot()).revision,{local:{recentlyMarked:[9,8,7]}});
  const first = await download([kept,stale]);
  assert.deepEqual(first.tables.watched.map(row => row.show_id),[7,9]);
  assert.deepEqual(first.local.recentlyMarked,[7]);
  const next = await download([kept,cleared,stale]);
  assert.deepEqual(new Set(next.tables.watched.map(row => row.show_id)),new Set([7,8,9]));
  assert.deepEqual(next.local.recentlyMarked,[7]);
});

test('Three devices converge across all four files after an interrupted upload in each sync order', async () => {
  const tables=['watched','ratings','lists','settings'];
  const shared={show_id:7,show:'Coastal Dial'};
  const base={watched:[watch(2)],ratings:[{...shared,rating:6}],lists:[{...shared,list:'Watchlist'}],settings:[]};
  const additions=[0,1,2].map(i=>{
    const title={show_id:20+i,show:'Archive '+i};
    return {watched:{...watch(i+1),...title,episode_id:200+i},ratings:{...title,rating:i/2},
      lists:{...title,list:'Series "'+i+'",\r\nreplays'},settings:{setting:['tmdb_key','mdblist_key','omdb_key'][i],value:'fictional-setting-'+i}};
  });
  for (const order of ['012','021','102','120','201','210']) for (const table of tables) {
    for (const when of ['before','after']) {
      const cloud=new FictionalDropbox(), devices=Array.from({length:3},memoryStore);
      for (const t of tables) await cloud.put('/'+t+'.csv',writeCsv(t,base[t]));
      for (let i=0;i<3;i++) {
        await sync(devices[i],cloud).run();
        const patch=Object.fromEntries(tables.map(t=>[t,[...base[t],additions[i][t]]]));
        await devices[i].commit((await devices[i].snapshot()).revision,{replace:patch});
      }
      const first=devices[Number(order[0])];
      cloud[when]=async (method,p)=>{if(method==='upload' && p==='/'+table+'.csv') throw other();};
      await assert.rejects(sync(first,cloud).run(),/unknown outcome/);
      assert.ok((await first.snapshot()).sync[table].pending);
      cloud[when]=async()=>{};
      for (const n of order.slice(1)+order) assert.equal((await sync(devices[Number(n)],cloud,confirmSingleDelivery).run()).complete,true);
      for (const device of devices) {
        await sync(device,cloud).run();
        const snapshot=await device.snapshot();
        for (const t of tables) {
          const expected=writeCsv(t,[...base[t],...additions.map(group=>group[t])]);
          assert.equal(writeCsv(t,snapshot.tables[t]),expected,order+' '+t);
          assert.equal(writeCsv(t,cloud.rows(t)),expected,order+' '+t);
          assert.equal(snapshot.sync[t].pending,null);
        }
      }
    }
  }
});
async function linked(value = 1) {
  const store = memoryStore(), cloud = new FictionalDropbox();
  await cloud.put(path, watchCsv(value));
  assert.equal((await sync(store, cloud).run()).complete, true);
  return { store, cloud };
}

test('A device repairs its cached base from the same Dropbox revision before deciding a file is unchanged or damaged', async () => {
  for (const damaged of [watchCsv(2), watchCsv(1) + 'unreadable row']) {
    const {store, cloud} = await linked();
    const s = await store.snapshot(), state = s.sync.watched;
    await store.commit(s.revision, {sync:{watched:{...state,base:{...state.base,content:damaged}}}});
    await edit(store, watch(2));
    cloud.calls.length = 0;
    assert.equal((await sync(store,cloud,{guard:assert.fail}).run()).complete,true);
    assert.ok(cloud.calls.some(call=>call.method==='download' && call.path===path));
    assert.equal(cloud.rows('watched')[0].times_watched,2);
    assert.equal((await store.snapshot()).sync.watched.base.content,watchCsv(2));
    assert.equal((await sync(store,cloud).run()).complete,true);
  }
  const store=memoryStore(), cloud=new FictionalDropbox();
  const row={...watch(1),title:'Surviving \uFFFD replacement character'};
  await cloud.put(path,writeCsv('watched',[row]));
  await sync(store,cloud).run();
  const s=await store.snapshot(), state=s.sync.watched;
  const malformed=state.base.content.replace('\uFFFD','\uD800');
  await store.commit(s.revision,{replace:{watched:[{...row,times_watched:2}]},
    sync:{watched:{...state,base:{...state.base,content:malformed}}}});
  assert.equal((await sync(store,cloud,{guard:assert.fail}).run()).complete,true);
  assert.deepEqual(cloud.rows('watched'),[{...row,times_watched:2}]);
});

test('An unreadable historical base preserves both devices until an explicit no-base recovery after reopening', async () => {
  const {store,cloud} = await linked();
  const s = await store.snapshot(), state = s.sync.watched;
  const damaged = {...state.base,content:watchCsv(6)+'unreadable row'};
  await store.commit(s.revision,{replace:{watched:[watch(2)]},sync:{watched:{...state,base:damaged}}});
  await cloud.put(path,watchCsv(3));
  const ask = answer => question => {
    assert.equal(question.decision.reason,'damaged-base');
    assert.deepEqual(question.decision.choices,['combine','take-remote','cancel']);
    assert.equal(question.unsynced,null);
    return answer;
  };
  assert.equal((await sync(store,cloud,{guard:ask('cancel')}).run()).complete,false);
  assert.deepEqual((await store.snapshot()).sync.watched.base,damaged);
  assert.equal(await count(store),2);
  assert.equal(cloud.rows('watched')[0].times_watched,3);
  assert.equal((await sync(store,cloud,{guard:ask('combine')}).run({retryCanceled:true})).complete,true);
  assert.equal(await count(store),3);
  assert.equal((await store.snapshot()).sync.watched.base.content,watchCsv(3));
});
test('Taking Dropbox cannot copy the same episode ID into two positions after a damaged base', async () => {
  const {store,cloud} = await linked();
  const s = await store.snapshot(), state = s.sync.watched;
  const damaged = {...state.base, content:watchCsv(6) + 'unreadable row'};
  await store.commit(s.revision,{replace:{watched:[watch(2)]},sync:{watched:{...state,base:damaged}}});
  const ambiguous = [watch(2,1,1901), {...watch(3,2,1901),season:2}];
  await cloud.put(path,writeCsv('watched',ambiguous));
  const revision = (await cloud.download(path)).metadata.rev;
  const ask = answer => question => {
    assert.equal(question.ambiguousRemoteEpisodes,true);
    assert.deepEqual(question.decision.choices,['combine','cancel']);
    return answer;
  };
  await assert.rejects(sync(store,cloud,{guard:ask('take-remote')}).run(),/Invalid Dropbox guard choice/);
  let reviewed = false;
  const result = await sync(store,cloud,{guard:ask('combine'),identities:async review => {
    assert.deepEqual(review.inputs.theirs,ambiguous);
    reviewed = true;
    return null;
  }}).run();
  assert.equal(reviewed,true);
  assert.equal(result.complete,false);
  assert.deepEqual((await store.snapshot()).tables.watched,[watch(2)]);
  assert.deepEqual((await store.snapshot()).sync.watched.base,damaged);
  assert.equal((await cloud.download(path)).metadata.rev,revision);
  assert.deepEqual(cloud.rows('watched'),ambiguous);
});
async function interrupted({ creation = false, arrives = false } = {}) {
  const store = memoryStore(), cloud = new FictionalDropbox();
  if (!creation) { await cloud.put(path, watchCsv(1)); await sync(store, cloud).run(); }
  await edit(store, watch(2));
  const field = arrives ? 'after' : 'before';
  cloud[field] = async (method, name) => { if (method === 'upload' && name === path) throw other(); };
  await assert.rejects(sync(store, cloud).run(), /unknown outcome/);
  cloud[field] = async () => {};
  const state = (await store.snapshot()).sync.watched;
  assert.ok(state.pending);
  return { store, cloud, state };
}
async function modifyPending(store, patch) {
  const s = await store.snapshot(), state = s.sync.watched;
  await store.commit(s.revision, { sync: { watched: { ...state, pending: { ...state.pending, ...patch } } } });
}

test('Two and three writing devices converge in each sync order and preserve changes to moved episodes', async () => {
  for (const order of ['012','021','102','120','201','210']) {
    const cloud = new FictionalDropbox(), devices = [memoryStore(), memoryStore(), memoryStore()];
    await cloud.put(path, writeCsv('watched', [watch(1,1,77), watch(1,2,78)]));
    for (const device of devices) await sync(device, cloud).run();
    await edit(devices[0], watch(1,2,77), watch(1,1,78));
    await edit(devices[1], watch(2,1,77), watch(1,2,78));
    await edit(devices[2], watch(1,1,77), watch(3,2,78));
    for (const idx of order) assert.ok((await sync(devices[idx], cloud, acceptBoth).run()).complete);
    for (const device of devices) {
      assert.ok((await sync(device, cloud, acceptBoth).run()).complete);
      assert.deepEqual((await device.snapshot()).tables.watched.map(r => [r.episode,r.episode_id,r.times_watched]).sort(),
        [[1,78,3],[2,77,2]]);
    }
  }
});

test('A lost creation or update reply is settled with the original bytes and timestamp, even after an intervening edit', async () => {
  for (const creation of [true,false]) for (const arrives of [true,false]) {
    const { store, cloud, state } = await interrupted({ creation, arrives });
    if (arrives) await cloud.put(path, watchCsv(4)); // supersede the accepted reply
    await edit(store, watch(3));
    cloud.calls.length = 0;
    await sync(store, cloud, acceptBoth).run();
    const firstUpload = cloud.calls.find(c => c.method === 'upload' && c.path === path);
    if (!(creation && arrives)) {
      assert.equal(firstUpload.content, state.pending.content);
      assert.equal(firstUpload.options.clientModified, state.pending.clientModified);
    }
    assert.equal(cloud.rows('watched')[0].times_watched, arrives ? 5 : 3);
    assert.equal((await store.snapshot()).sync.watched.pending, null);
  }
});

test('A creating retry consults deleted path history, leaves a later deletion alone, and excludes matching old revisions', async () => {
  for (const prior of [false, true]) {
    const store = memoryStore(), cloud = new FictionalDropbox();
    const cm = new Date(time).toISOString().replace('.000Z', 'Z');
    if (prior) { await cloud.put(path, watchCsv(2), cm); cloud.live.delete(path); }
    await edit(store, watch(2));
    cloud.before = async method => { if (method === 'upload') throw other(); };
    await assert.rejects(sync(store, cloud).run(), /unknown outcome/);
    cloud.before = async () => {};
    const state = (await store.snapshot()).sync.watched;
    assert.equal(state.pending.previousRevisions.length, Number(prior));
    await cloud.put(path, watchCsv(8)); cloud.live.delete(path);
    cloud.calls.length = 0;
    // Settle without starting a new no-base merge that could legitimately create the path.
    await sync(store, cloud).settleForRestore(['watched']);
    assert.equal(cloud.calls.filter(c => c.method === 'upload').length, 0);
    assert.equal((await store.snapshot()).sync.watched.base, null);
    assert.equal(cloud.live.has(path), false);
  }
});

test('Settlement recognizes the exact current or historical revision, and excludes Rt and an older timestamp', async () => {
  for (const mode of ['current','historical','equal-offset','old-time','same-target','different-fraction','earlier-fraction']) {
    const arrived = ['current','historical','equal-offset'].includes(mode);
    const { store, cloud, state } = await interrupted({ arrives: arrived });
    const accepted = cloud.live.get(path).metadata;
    if (mode === 'equal-offset') accepted.clientModified = state.pending.clientModified.replace('T12','T13').replace('Z','.0000000+01:00');
    if (mode === 'different-fraction') await cloud.put(path,state.pending.content,state.pending.clientModified.replace('Z','.0000001Z'));
    if (mode === 'earlier-fraction') {
      const other=await cloud.put(path,state.pending.content,state.pending.clientModified);
      other.serverModified=state.pending.targetModified.replace('.000Z','.0000001Z');
      await modifyPending(store,{targetModified:state.pending.targetModified.replace('.000Z','.0000002Z')});
    }
    if (mode === 'historical') await cloud.put(path, watchCsv(7));
    if (mode === 'old-time') {
      const impostor = await cloud.put(path, state.pending.content, state.pending.clientModified);
      impostor.serverModified = '2001-01-01T00:00:00Z';
    }
    if (mode === 'same-target') {
      const base = cloud.live.get(path).metadata;
      // A previous upload of identical bytes/time cannot be evidence of this pending write.
      base.contentHash = (await cloud.put(path, state.pending.content, '2002-02-02T00:00:00Z')).contentHash;
      base.clientModified = state.pending.clientModified;
    }
    cloud.calls.length = 0;
    if (arrived) {
      const match = await new SyncFiles(store,cloud,credentials,()=>time).settle('watched');
      assert.equal(match.delivery.revision,accepted.rev);
      assert.deepEqual((await store.snapshot()).sync.watched.pending,state.pending);
    } else {
      await sync(store, cloud).settleForRestore(['watched']);
      const after = (await store.snapshot()).sync.watched;
      assert.equal(after.base.revision,state.pending.targetRevision);
      assert.equal(after.pending,null);
    }
    if (mode === 'current') {
      const reads=cloud.calls.filter(c=>c.method==='revisions');
      assert.equal(reads.length,1); assert.equal(reads[0].before,accepted.rev); assert.equal(reads[0].maximum,1);
    }
  }
});

test('After refusal, 24 days can disprove arrival; 25 days, a backwards clock, and missing history require review', async () => {
  for (const [days, lostHistory, guarded] of [[24,false,false],[25,false,true],[-1,false,true],[1,true,true]]) {
    const { store, cloud } = await interrupted();
    await modifyPending(store, { preparedAt: time - days * 86400000 });
    await cloud.put(path, watchCsv(6));
    if (lostHistory) cloud.history.set(path, [cloud.live.get(path)]);
    let seen = 0;
    const outcome = await sync(store, cloud, { ...acceptBoth, guard: async q => {
      seen++; assert.equal(q.decision.case, 3); assert.equal(q.unsynced, 1); return 'cancel';
    } }).run();
    assert.equal(Boolean(seen), guarded); assert.equal(outcome.complete, !guarded);
    assert.equal(Boolean((await store.snapshot()).sync.watched.pending), guarded);
    assert.equal(await count(store), guarded ? 2 : 7);
  }
});

test('a missing initial file with expired or backwards history is never recreated before review',async()=>{
  const day=86_400_000;
  for (const [age,crosses,resend] of [[24*day,false,true],[25*day,false,false],[32*day,false,false],[-1,false,false],[25*day-1,true,false]]) {
    const {store,cloud}=await interrupted({creation:true,arrives:true});
    // The owner deleted the first file and the provider no longer lists that version.
    cloud.live.delete(path); cloud.history.delete(path);
    await modifyPending(store,{preparedAt:time-age});
    const prior=(await store.snapshot()).sync.watched.pending;
    let clock=time,question;
    cloud.before=async(method,name)=>{if(crosses && method==='revisions' && name===path)clock=time+2;};
    cloud.calls.length=0;
    const result=await sync(store,cloud,{guard:async q=>{question=q;return 'cancel';}},()=>clock).run();
    assert.equal(result.complete,resend);
    assert.equal(cloud.calls.some(call=>call.method==='upload'&&call.path===path),resend);
    assert.equal(cloud.live.has(path),resend);
    if (!resend) {
      assert.equal(question.decision.reason,'unknown-outcome');
      assert.deepEqual((await store.snapshot()).sync.watched.pending,prior);
      assert.equal(await count(store),2);
    }
  }
  // A retained matching first file can also be a peer’s copy. Its subsequent deletion needs review.
  const {store,cloud}=await interrupted({creation:true,arrives:true});
  const original=cloud.live.get(path).metadata.rev;
  cloud.live.delete(path); await modifyPending(store,{preparedAt:time-31*day});
  cloud.calls.length=0;
  await assert.rejects(sync(store,cloud).settleForRestore(['watched']),/needs review/);
  assert.equal(cloud.calls.some(call=>call.method==='upload'),false);
  const state=(await store.snapshot()).sync.watched;
  assert.equal(state.base,null); assert.ok(state.pending);
  assert.equal(cloud.history.get(path)[0].metadata.rev,original);
});

test('A folder listing omission is checked by download; a listed file disappearing stops without sending anything', async () => {
  for (const gone of [false,true]) {
    const cloud = new FictionalDropbox(), store = memoryStore();
    const remote = await cloud.put(path, watchCsv(3));
    if (gone) cloud.live.delete(path);
    cloud.list = async () => gone ? [remote] : [];
    if (gone) {
      await assert.rejects(sync(store, cloud).run(), /listed.*did not find/);
      assert.equal(await count(store), 0);
    } else {
      await sync(store, cloud).run();
      assert.equal(await count(store), 3);
      assert.equal((await store.snapshot()).sync.watched.base.revision, remote.rev);
    }
    assert.equal(cloud.calls.filter(c => c.method === 'upload').length, 0);
  }
});

test('A creation recomputes the merge after local edits during revision listing; consecutive cm values strictly increase', async () => {
  const store = memoryStore(), cloud = new FictionalDropbox();
  await edit(store, watch(1));
  cloud.before = async (method, p) => {
    if (method === 'revisions' && p === path) { cloud.before = async () => {}; await edit(store, watch(5)); }
  };
  await sync(store, cloud).run();
  assert.equal(cloud.rows('watched')[0].times_watched, 5);
  await edit(store, watch(6)); await sync(store, cloud).run();
  const sent = cloud.calls.filter(c => c.method === 'upload').map(c => c.options.clientModified);
  assert.equal(sent.length, 2);
  assert.equal(Date.parse(sent[1]) - Date.parse(sent[0]), 1000);
});

test('A fifth definitive refusal ends a sync and a later sync starts from a fresh folder listing', async () => {
  const { store, cloud } = await linked();
  await edit(store, watch(2));
  let external = 10;
  cloud.before = async (method, p) => { if (method === 'upload' && p === path) await cloud.put(path, watchCsv(external++)); };
  await assert.rejects(sync(store, cloud, acceptBoth).run(), /five conditional uploads/);
  assert.equal(cloud.calls.filter(c => c.method === 'upload').length, 5);
  assert.equal((await store.snapshot()).sync.watched.pending, null);
  cloud.before = async () => {};
  assert.equal((await sync(store, cloud, acceptBoth).run()).complete, true);
  assert.equal(await count(store), 15);
});

test('Cancel suppresses the pending file on automatic runs until an explicit retry or a save to that table', async () => {
  for (const action of ['explicit','local-edit']) {
    const { store, cloud } = await interrupted();
    cloud.live.delete(path);
    let asked = 0;
    const hooks = { guard: async q => { assert.equal(q.decision.case, 3); asked++; return 'cancel'; } };
    assert.equal((await sync(store, cloud, hooks).run()).complete, false);
    cloud.calls.length = 0;
    assert.equal((await sync(store, cloud, hooks).run()).complete, false);
    assert.equal(cloud.calls.some(c => c.path === path), false);
    if (action === 'local-edit') await edit(store, watch(5));
    await sync(store, cloud, hooks).run({ retryCanceled: action === 'explicit' });
    assert.equal(asked, 2);
    assert.ok((await store.snapshot()).sync.watched.pending);
  }
});

test('a queued open respects Cancel for the displayed revision, while a new revision, a table edit, and Sync now each retry', async () => {
  for (const reason of ['peer','local','explicit','changed during review']) {
    const {store,cloud} = await linked();
    await cloud.put(path,watchCsv(0));
    const postponed = new Map();
    let questions = 0;
    const hooks = {
      guard:async() => {
        questions++;
        if (reason === 'changed during review' && questions === 1) await edit(store,watch(3));
        return 'cancel';
      },
      postponed:(table,revision)=>postponed.set(table,revision),
    };
    const engine = () => sync(store,cloud,hooks);
    await engine().run();
    assert.equal(questions,1);
    await engine().run({retryCanceled:true,postponed});
    if (reason === 'changed during review') {
      assert.equal(questions,2,'Cancel suppressed a change it never displayed');
      continue;
    }
    assert.equal(questions,1,'Automatic open asked about the same record again');
    if (reason === 'peer') await cloud.put(path,watchCsv(0));
    if (reason === 'local') await edit(store,watch(2));
    await engine().run(reason === 'explicit' ? {retryCanceled:true} : {postponed});
    assert.equal(questions,2,reason);
  }
});

test('Take Dropbox revalidates the remote revision and releases its hold after the correct save or failed call', async () => {
  for (const failed of [false,true]) {
    const { store, cloud } = await linked();
    await cloud.put(path, watchCsv(0));
    const holds = [];
    let asked = 0;
    const fn = () => sync(store, cloud, { hold: f => holds.push(f), guard: async q => {
      asked++;
      assert.equal(q.decision.case, 2); assert.equal(q.different, 1); assert.equal(q.unsynced, 0);
      if (failed) cloud.before = async method => { if (method === 'download') throw other(); };
      else await cloud.put(path, watchCsv(3));
      return 'take-remote';
    } }).run();
    if (failed) await assert.rejects(fn(), /No reply/);
    else assert.equal((await fn()).complete, true);
    assert.equal(await count(store), failed ? 1 : 3);
    assert.equal(asked, 1); assert.equal(holds.at(-1), null); assert.ok(holds.includes('watched'));
  }
});

test('Combine prepares a new no-base merge atomically; a failed history read preserves the old base and pending upload', async () => {
  for (const interruptedAgain of [true,false]) {
    const { store, cloud, state } = await interrupted(); cloud.live.delete(path);
    const hooks = { guard: async q => {
      assert.equal(q.decision.case, 3);
      if (interruptedAgain) cloud.before = async method => { if (method === 'revisions') throw other(); };
      return 'combine';
    } };
    if (interruptedAgain) {
      await assert.rejects(sync(store, cloud, hooks).run(), /No reply/);
      assert.deepEqual((await store.snapshot()).sync.watched, state);
    } else {
      await sync(store, cloud, hooks).run();
      assert.equal(cloud.rows('watched')[0].times_watched, 2);
      assert.equal((await store.snapshot()).sync.watched.pending, null);
    }
  }
});

test('A newer or damaged settings file reports only names and preserves the local value on Cancel', async () => {
  for (const [header, expected] of [['setting,value,newer','reload'],['setting,value','restore-device']]) {
    const cloud = new FictionalDropbox(), store = memoryStore();
    await store.commit(1n, { replace: { settings: [{ setting:'tmdb_key', value:'fictional-private-local' }] } });
    await cloud.put('/settings.csv', header + '\r\nimdb_source,fictional-private-source' + (expected === 'reload' ? ',value' : '') + '\r\n');
    let question;
    await sync(store, cloud, { guard: async q => { question = q; return 'cancel'; } }).run();
    assert.equal(question.table, 'settings');
    // Unsupported source variants and newer columns both require a compatible build.
    assert.ok(question.decision.choices.includes('reload'));
    assert.equal(JSON.stringify(question).includes('fictional-private'), false);
    assert.equal((await store.snapshot()).tables.settings[0].value, 'fictional-private-local');
  }
});

test('Taking a file reopens the guard if another device writes an unreadable revision during the decision', async () => {
  const {store,cloud} = await linked();
  await cloud.put(path,watchCsv(0));
  const initial = (await store.snapshot()).sync.watched, reasons=[];
  const result = await sync(store,cloud,{guard:async question=>{
    reasons.push(question.decision.reason);
    if (reasons.length === 1) {
      await cloud.put(path,'show_id,season,episode,times_watched,new_column\r\n7,1,1,2,a\r\n');
      return 'take-remote';
    }
    return 'cancel';
  }}).run();
  assert.deepEqual(reasons,['all-local-rows-removed','unsupported']);
  assert.equal(result.complete,false);
  assert.equal(await count(store),1);
  assert.deepEqual((await store.snapshot()).sync.watched,initial);
});

test('An expired or different session cannot apply an already accepted reply, and a fresh session settles it', async () => {
  const { store, cloud } = await linked();
  await edit(store, watch(2));
  const newer = { ...credentials, instanceId: 'new-sign-in' };
  cloud.after = async () => {
    await store.commit((await store.snapshot()).revision, { local: { dropboxSession: newer } });
    cloud.after = async () => {};
  };
  await assert.rejects(sync(store, cloud).run(), /accepted.*reconciliation/);
  assert.ok((await store.snapshot()).sync.watched.pending);
  const fresh = new DropboxSync(store, cloud, newer, confirmSingleDelivery, () => time);
  await fresh.run(); assert.equal(await count(store), 2);
  assert.equal((await store.snapshot()).sync.watched.pending, null);
  const expired = new DropboxSync(store, cloud, newer, {}, () => credentials.signInDeadline);
  await assert.rejects(expired.run(), /sign-in changed/);
});

test('Unsynced counts include removals and preserve unknown remote content', async () => {
  const { store } = await linked();
  await edit(store);
  assert.equal(unsyncedCount(await store.snapshot(), 'watched'), 1);
  const s = await store.snapshot();
  s.sync.watched.pending = { targetContent: null };
  assert.equal(unsyncedCount(s, 'watched'), null);
  for (const bad of [undefined,null,{},42,'',watchCsv(1) + 'broken row\r\n',watchCsv(1).replace('episode_id','new_column')]) {
    s.sync.watched.pending = {targetContent:bad};
    assert.equal(unsyncedCount(s,'watched'),null,'Pending comparison used damaged or incomplete rows');
    s.sync.watched.pending = null;
    s.sync.watched.base.content = bad;
    assert.equal(unsyncedCount(s,'watched'),null,'Base comparison used damaged or incomplete rows');
    assert.equal(tableMatchesDropboxBase(s,'watched'),false,'Import and publication require a verified base');
  }
});

test('A reopened device holds damaged pending CSV for review before sending it to Dropbox', async () => {
  for (const content of ['not a watch record', watchCsv(2).replace('times_watched', 'future_count')]) {
    const {store,cloud} = await interrupted();
    await modifyPending(store, {content});
    cloud.calls.length = 0;
    const blocked = await sync(store,cloud,{guard:async q => {
      assert.equal(q.decision.reason,'unknown-outcome');
      return 'cancel';
    }}).run();
    assert.equal(blocked.complete,false);
    assert.equal(cloud.calls.some(c => c.method === 'upload'),false);
    assert.equal(cloud.rows('watched')[0].times_watched,1);
    assert.equal(await count(store),2);
    assert.ok((await store.snapshot()).sync.watched.pending);
    const recovered = await sync(store,cloud,{guard:async () => 'take-remote'}).run({retryCanceled:true});
    assert.equal(recovered.complete,true);
    assert.equal(await count(store),1);
    assert.equal((await store.snapshot()).sync.watched.pending,null);
  }
});

test('An older creation receipt without its starting revision list cannot resend or claim somebody else’s identical bytes', async () => {
  const {store,cloud,state} = await interrupted({creation:true});
  await modifyPending(store,{previousRevisions:undefined});
  await cloud.put(path,state.pending.content,state.pending.clientModified);
  cloud.calls.length=0;
  const result=await sync(store,cloud,{guard:async q=>{assert.equal(q.decision.case,3);return 'cancel';}}).run();
  assert.equal(result.complete,false);
  assert.equal(cloud.calls.some(c=>c.method==='upload'),false);
  assert.ok((await store.snapshot()).sync.watched.pending);
});

test('A damaged target snapshot or invalid revision in a creation receipt cannot authorize a Dropbox replay', async () => {
  for (const [creation,patch] of [[false,{targetContent:'bad header'}],[false,{targetModified:42}],
    [false,{clientModified:'0'}],[false,{targetModified:'2026-02-30T00:00:00Z'}],
    [true,{clientModified:'2026-11-18T15:30:00'}],
    [true,{previousRevisions:['old',null]}],[true,{previousRevisions:new Array(2)}],
    [true,{targetModified:new Date(time).toISOString()}]]) {
    const {store,cloud} = await interrupted({creation});
    await modifyPending(store,patch);
    cloud.calls.length=0;
    const result=await sync(store,cloud,{guard:async q=>{assert.equal(q.decision.reason,'unknown-outcome');return 'cancel';}}).run();
    assert.equal(result.complete,false);
    assert.equal(cloud.calls.some(c=>c.method==='upload'),false);
    assert.ok((await store.snapshot()).sync.watched.pending);
  }
  const {store,cloud}=await interrupted();
  await modifyPending(store,{previousRevisions:42});
  assert.equal((await sync(store,cloud).run()).complete,true,'Update receipts do not use a creation history');
  assert.equal(cloud.rows('watched')[0].times_watched,2);
});

test('Taking Dropbox across repeated third-case revision changes re-settles each time and stops on the fifth refusal', async () => {
  const {store,cloud} = await interrupted();
  await modifyPending(store,{preparedAt:time - 26 * 86400000});
  await cloud.put(path,watchCsv(8));
  let questions = 0;
  await assert.rejects(sync(store,cloud,{guard:async q => {
    assert.equal(q.decision.case,3);
    // A new external revision arrives while each question is open.
    await cloud.put(path,watchCsv(9 + questions++));
    return 'take-remote';
  }}).run(), /five conditional uploads/);
  assert.equal(questions,4);
  assert.ok((await store.snapshot()).sync.watched.pending);
  assert.equal(await count(store),2);
});

test('The originating answer covers known double marks after remerge; a new same-direction change uses both and is reported', async () => {
  const {store,cloud} = await linked();
  await edit(store,watch(1),watch(1,2));
  await sync(store,cloud).run();
  await edit(store,watch(2),watch(1,2));
  await cloud.put(path,writeCsv('watched',[watch(3),watch(2,2)]));
  let asks=0;
  const result = await sync(store,cloud,{doubleMarks: async review => {
    asks++; assert.equal(review.episodes.length,1);
    await edit(store,watch(3),watch(2,2));
    return {choice:'one'};
  }}).run();
  assert.equal(asks,1); assert.equal(result.complete,true);
  assert.deepEqual(cloud.rows('watched').map(r=>r.times_watched),[3,3]);
  assert.match(result.notices.join(' '),/episode 2/);
});

test('A Take confirmation cannot discard unreviewed local edits and Merge anyway recalculates its removal impact', async () => {
  for (const answer of ['take-remote','merge-anyway']) {
    const {store,cloud} = await linked();
    await cloud.put(path,watchCsv(0));
    let asks=0;
    const result = await sync(store,cloud,{guard: async q=>{
      asks++;
      if (asks === 1) { await edit(store,watch(1),watch(3,2)); return answer; }
      assert.equal(q.unsynced,1);
      return 'cancel';
    }}).run();
    assert.equal(asks,2); assert.equal(result.complete,false);
    assert.deepEqual((await store.snapshot()).tables.watched.map(r=>r.times_watched),[1,3]);
  }
});

test('Ambiguous identities pause before upload, bind to all three versions, and revalidate a mapping after a remote revision changes', async () => {
  const {store,cloud} = await linked();
  await edit(store,watch(2,1,1));
  await cloud.put(path,writeCsv('watched',[watch(2,1,1),watch(3,2,1)]));
  let asked=0;
  const first = (await store.snapshot()).sync.watched.base;
  const result = await sync(store,cloud,{identities:async review=>{
    asked++;
    if (asked === 1) {
      assert.equal(review.inputs.theirs.length,2);
      await cloud.put(path,writeCsv('watched',[watch(3,1,1),watch(3,2,1)]));
      return [{show_id:7,season:1,episode:1,episode_id:1,before:0,mine:0,theirs:0},
        {show_id:7,season:1,episode:2,episode_id:2,theirs:1}];
    }
    return null;
  }}).run();
  assert.equal(asked,2); assert.equal(result.complete,false);
  assert.deepEqual((await store.snapshot()).sync.watched.base,first); assert.equal(await count(store),2);
});

test('A refusal followed by local acknowledgement failure reports exactly which half of the restore completed', async () => {
  const {store,cloud} = await linked();
  const live = await cloud.download(path), original = store.commit.bind(store);
  store.commit = async (...args) => {
    if (args[1].sync?.watched && !args[1].sync.watched.pending) throw new Error('Injected acknowledgement abort');
    return original(...args);
  };
  cloud.before = async (method,p) => { if (method === 'upload') await cloud.put(p,watchCsv(7)); };
  const status = await sync(store,cloud).replaceForRestore('watched',watchCsv(4),live);
  assert.equal(status,'conflict-unacknowledged'); assert.ok((await store.snapshot()).sync.watched.pending);
  assert.equal(await count(store),4); assert.equal(cloud.rows('watched')[0].times_watched,7);
});

test('Stopping before and after every network reply and local commit preserves both devices’ independent watches', async () => {
  async function atBoundary(stop) {
    const {store,cloud} = await linked(), second = memoryStore();
    await sync(second,cloud).run();
    await edit(store,watch(2)); await edit(second,watch(3));
    let countSteps = 0;
    function checkpoint() { if (++countSteps === stop) throw other(); }
    const restore = [];
    for (const [target,name] of [[store,'commit'],[cloud,'list'],[cloud,'download'],[cloud,'upload'],[cloud,'revisions']]) {
      const original = target[name].bind(target);
      target[name] = async (...args) => {
        checkpoint(); const result = await original(...args); checkpoint(); return result;
      };
      restore.push(() => { target[name] = original; });
    }
    let finished = false;
    try { await sync(store,cloud,acceptBoth).run(); finished = true; }
    catch (error) { if (stop === Infinity) throw error; }
    finally { for (const undo of restore) undo(); }
    // Release another device while the stopped device still has its last committed state.
    await sync(second,cloud,acceptBoth).run();
    await sync(store,cloud,acceptBoth).run();
    await sync(second,cloud,acceptBoth).run();
    assert.equal(await count(store),4,'first device, boundary ' + stop);
    assert.equal(await count(second),4,'second device, boundary ' + stop);
    assert.equal(cloud.rows('watched')[0].times_watched,4);
    assert.equal(finished,stop === Infinity);
    return countSteps;
  }
  const total = await atBoundary(Infinity);
  for (let n = 1; n <= total; n++) await atBoundary(n);
});

test('A separately recorded viewing with identical bytes and timestamp is counted after review', async () => {
  const {store,cloud} = await linked(), second=memoryStore();
  await sync(second,cloud).run(); await edit(store,watch(2)); await edit(second,watch(2));
  cloud.before = async method => { if (method === 'upload') throw other(); };
  await assert.rejects(sync(store,cloud).run(),/unknown outcome/);
  cloud.before = async () => {};
  await sync(second,cloud).run();
  const pending = (await store.snapshot()).sync.watched.pending;
  const theirs = cloud.live.get(path).metadata;
  assert.equal(theirs.clientModified,pending.clientModified);
  let asked = 0;
  assert.equal((await sync(store,cloud,{doubleMarks:async review=>{
    asked++;
    assert.equal(review.delivery,true);
    assert.deepEqual(review.episodes.map(row=>row.deliveryTotals),[{one:'2',two:'3'}]);
    return {choice:'two'};
  }}).run()).complete,true);
  assert.equal(asked,1); assert.equal(await count(store),3);
  assert.equal(cloud.rows('watched')[0].times_watched,3);
  assert.equal((await store.snapshot()).sync.watched.pending,null);
});

test('a missing upload and a missing acknowledgement can give the writer identical durable evidence',async()=>{
  const delivered = await interrupted({arrives:true}), missing = await interrupted({arrives:false});
  const pending = missing.state.pending;
  await missing.cloud.put(path,pending.content,pending.clientModified);
  assert.deepEqual(await delivered.store.snapshot(),await missing.store.snapshot());
  assert.deepEqual(await delivered.cloud.download(path),await missing.cloud.download(path));
  assert.deepEqual(await delivered.cloud.revisions(path),await missing.cloud.revisions(path));
  for (const {store,cloud} of [delivered,missing]) {
    assert.equal((await sync(store,cloud).run()).complete,false);
    assert.ok((await store.snapshot()).sync.watched.pending);
    const single=store===delivered.store;
    assert.equal((await sync(store,cloud,{doubleMarks:async review=>{
      assert.equal(review.delivery,true); return {choice:single?'one':'two'};
    }}).run({retryCanceled:true})).complete,true);
    assert.equal(await count(store),single?2:3);
  }
});

test('A definite revision conflict keeps independent same-second rewatches available for review', async () => {
  for (const [choice, expected] of [['one', 2], ['two', 3]]) {
    const {store, cloud} = await linked();
    await edit(store, watch(2));
    let questions = 0;
    cloud.before = async (method, file, request) => {
      if (method !== 'upload' || file !== path) return;
      cloud.before = async () => {};
      await cloud.put(path, request.content, request.options.clientModified);
    };
    const result = await sync(store, cloud, {doubleMarks: async review => {
      questions++;
      assert.equal(review.episodes.length, 1);
      return {choice};
    }}).run();
    assert.equal(result.complete, true);
    assert.equal(questions, 1);
    assert.equal(await count(store), expected);
    assert.equal(cloud.rows('watched')[0].times_watched, expected);
    assert.equal((await store.snapshot()).sync.watched.pending, null);
  }
});

test('a historical receipt from the target’s server second must have been written after the target',async()=>{
  for (const arrived of [false,true]) {
    const cloud = new FictionalDropbox(), store = memoryStore();
    const stamp = new Date(time).toISOString().replace('.000Z','Z');
    const older = await cloud.put(path,watchCsv(2),stamp);
    const target = await cloud.put(path,watchCsv(1));
    older.serverModified = target.serverModified;
    await sync(store,cloud).run();
    await edit(store,watch(2));
    if (arrived) cloud.after = async (method,file,accepted) => {
      if (file === path) { accepted.serverModified = target.serverModified; throw other(); }
    };
    else cloud.before = async (method,file) => { if (method === 'upload' && file === path) throw other(); };
    await assert.rejects(sync(store,cloud).run(),/unknown outcome/);
    cloud.before = cloud.after = async () => {};
    await cloud.put(path,watchCsv(4));
    assert.equal((await sync(store,cloud,acceptBoth).run()).complete,true);
    const expected = arrived ? 4 : 5;
    assert.equal(await count(store),expected);
    assert.equal(cloud.rows('watched')[0].times_watched,expected);
  }
});

test('a same-second historical candidate without a retained target requests review and preserves the pending write',async()=>{
  const {store,cloud,state} = await interrupted({arrives:true});
  cloud.live.get(path).metadata.serverModified = state.pending.targetModified;
  await cloud.put(path,watchCsv(4));
  cloud.history.set(path,cloud.history.get(path).filter(entry=>entry.metadata.rev!==state.pending.targetRevision));
  let asked = 0;
  const result = await sync(store,cloud,{guard:async review=>{
    asked++; assert.equal(review.decision.case,3); return 'cancel';
  }}).run();
  assert.equal(result.complete,false);
  assert.equal(asked,1);
  assert.deepEqual((await store.snapshot()).sync.watched.pending,state.pending);
  assert.equal(await count(store),2);
  assert.equal(cloud.rows('watched')[0].times_watched,4);
});

test('a matching revision after another writer changed the target cannot turn a local Undo into a new edit',async()=>{
  const rating=value=>[{show_id:7,show:'Coastal Dial',rating:value}];
  const list=name=>[{show_id:7,show:'Coastal Dial',list:'Collection'},...(name?[{show_id:7,show:'Coastal Dial',list:name}]:[])];
  const theme=value=>[{setting:'appearance',value}];
  const cases=[
    ['watched',[watch(1)],[watch(2)],[watch(3)]],
    ['ratings',rating(7),rating(8),rating(9)],
    ['lists',list(),list('Favorites'),list('Other')],
    ['settings',theme('light'),theme('dark'),theme('device')],
  ];
  for (const [table,original,prepared,intervening] of cases) for (const sameSecond of [false,true]) {
    const cloud=new FictionalDropbox(), store=memoryStore(), path='/'+table+'.csv';
    const putLocal=async rows=>store.commit((await store.snapshot()).revision,{replace:{[table]:rows}});
    const run=()=>sync(store,cloud,{guard:assert.fail,doubleMarks:assert.fail}).run();
    const target=await cloud.put(path,writeCsv(table,original));
    await run(); await putLocal(prepared);
    cloud.before=async(method,file)=>{if(method==='upload' && file===path)throw other();};
    await assert.rejects(run(),/unknown outcome/); cloud.before=async()=>{};
    const {pending}=(await store.snapshot()).sync[table];
    await putLocal(original);
    const first=await cloud.put(path,writeCsv(table,intervening));
    const second=await cloud.put(path,pending.content,pending.clientModified);
    // Return to the exact same bytes a second time. The first writer's stale conditional upload
    // cannot account for either later revision, even when all timestamps fall in one second.
    const third=await cloud.put(path,writeCsv(table,intervening));
    const final=await cloud.put(path,pending.content,pending.clientModified);
    if (sameSecond) for (const file of [first,second,third,final]) file.serverModified=target.serverModified;
    cloud.calls=[];
    assert.equal((await run()).complete,true,table);
    assert.equal(cloud.live.get(path).metadata.rev,final.rev,table+' changed a peer revision');
    const expected=readCsv(table,pending.content).rows;
    assert.deepEqual(cloud.rows(table),expected);
    assert.deepEqual((await store.snapshot()).tables[table],expected);
    assert.equal((await store.snapshot()).sync[table].pending,null);
    if (sameSecond) assert.ok(cloud.calls.some(call=>call.method==='revisions' && call.before===first.rev && call.maximum===1),
      'The suspected successor must be adjacent to the actual target');
    const fresh=memoryStore();
    assert.equal((await sync(fresh,cloud).run()).complete,true);
    assert.deepEqual((await fresh.snapshot()).tables[table],expected);
  }
});

test('an actual conditional successor is recognized before later duplicate receipt fingerprints',async()=>{
  const {store,cloud,state}=await interrupted({arrives:true});
  const {pending}=state, first=cloud.live.get(path).metadata;
  const changed=await cloud.put(path,watchCsv(6));
  const repeated=await cloud.put(path,pending.content,pending.clientModified);
  const last=await cloud.put(path,watchCsv(4));
  for (const file of [first,changed,repeated,last]) file.serverModified=pending.targetModified;
  const result=await new SyncFiles(store,cloud,credentials,()=>time).settle('watched');
  assert.equal(result.delivery.revision,first.rev);
  assert.equal((await store.snapshot()).sync.watched.pending.clientModified,pending.clientModified);
});

test('an aged-out intervening revision cannot authorize Undo even if both surrounding revisions still match',async()=>{
  for (const crosses of [false,true]) {
    const rating=rating=>[{show_id:7,show:'Coastal Dial',rating}];
    const cloud=new FictionalDropbox(), store=memoryStore(), path='/ratings.csv';
    await cloud.put(path,writeCsv('ratings',rating(7))); await sync(store,cloud).run();
    await store.commit((await store.snapshot()).revision,{replace:{ratings:rating(8)}});
    cloud.before=async(method,file)=>{if(method==='upload' && file===path)throw other();};
    await assert.rejects(sync(store,cloud).run(),/unknown outcome/); cloud.before=async()=>{};
    const snapshot=await store.snapshot(),state=snapshot.sync.ratings,day=86_400_000;
    const pending={...state.pending,preparedAt:time-(crosses?25:31)*day+(crosses ? 1 : 0)};
    await store.commit(snapshot.revision,{replace:{ratings:rating(7)},sync:{ratings:{...state,pending}}});
    const skipped=await cloud.put(path,writeCsv('ratings',rating(9)));
    const final=await cloud.put(path,pending.content,pending.clientModified);
    cloud.history.set(path,cloud.history.get(path).filter(file=>file.metadata.rev!==skipped.rev));
    let at=time,reason;
    cloud.before=async(method,file)=>{if(crosses && method==='revisions' && file===path)at+=2;};
    const outcome=await sync(store,cloud,{guard:async question=>{reason=question.decision.reason;return 'cancel';}},()=>at).run();
    assert.equal(outcome.complete,false); assert.equal(reason,'unknown-outcome');
    assert.equal(cloud.live.get(path).metadata.rev,final.rev);
    assert.deepEqual((await store.snapshot()).sync.ratings.pending,pending);
    assert.deepEqual((await store.snapshot()).tables.ratings,rating(7));
  }
});

test('losing a predecessor lookup preserves the pending receipt for the next sync',async()=>{
  const {store,cloud,state} = await interrupted({arrives:true});
  cloud.live.get(path).metadata.serverModified = state.pending.targetModified;
  const current=await cloud.put(path,watchCsv(4));
  cloud.before = async (method,file,request) => {
    if (method==='revisions' && file===path && request.before===current.rev) throw other();
  };
  await assert.rejects(sync(store,cloud).run(),/No reply/);
  assert.deepEqual((await store.snapshot()).sync.watched.pending,state.pending);
  cloud.before = async()=>{};
  assert.equal((await sync(store,cloud,confirmSingleDelivery).run()).complete,true);
  assert.equal(await count(store),4);
  assert.equal((await store.snapshot()).sync.watched.pending,null);
});

test('the first revision may refuse before_rev; other cursor refusals preserve the pending original',async()=>{
  for (const refused of ['first only','arbitrary cursor']) {
    const {store,cloud,state}=await interrupted({arrives:true});
    const prior=state.pending, first=cloud.history.get(path).at(-1).metadata;
    assert.equal(first.rev,prior.targetRevision);
    const accepted=cloud.live.get(path).metadata;
    const changed=await cloud.put(path,watchCsv(9));
    const repeated=await cloud.put(path,prior.content,prior.clientModified);
    for (const file of [accepted,changed,repeated]) file.serverModified=first.serverModified;
    let lookedBeforeFirst=0,asked=0;
    cloud.before=async(method,file,{before})=>{
      if (file!==path || method!=='revisions' || !before) return;
      if (before===first.rev) lookedBeforeFirst++;
      if (before===first.rev || refused==='arbitrary cursor') throw new DropboxError('failed',409);
    };
    const result=await sync(store,cloud,{doubleMarks:async review=>{
      assert.equal(review.delivery,true); return {choice:'one'};
    },guard:async question=>{asked++;assert.equal(question.decision.reason,'unknown-outcome');return 'cancel';}}).run();
    assert.equal(lookedBeforeFirst,0);
    assert.equal(result.complete,refused==='first only');
    assert.equal(asked,Number(refused==='arbitrary cursor'));
    assert.deepEqual((await store.snapshot()).sync.watched.pending,refused==='first only'?null:prior);
    assert.equal(cloud.live.get(path).metadata.rev,repeated.rev);
  }
});

test('large histories confirm the immediate successor even when entries inside each cursor page are permuted',async()=>{
  for(const depth of [17,320]) for(const arrived of [true,false]) for(const scatter of [true,false]) {
    const {store,cloud,state}=await interrupted({arrives:arrived}), pending=state.pending;
    const expected=arrived?cloud.live.get(path).metadata:await cloud.put(path,watchCsv(3));
    for(let i=0;i<depth;i++) {
      if(i%7===3) await cloud.put(path,pending.content,pending.clientModified);
      else await cloud.put(path,watchCsv(4+i%3));
    }
    // Put the target in the interior. Older rows in the same path do not change its successor.
    const history=cloud.history.get(path),target=history.at(-1);
    for(let i=0;i<13;i++)history.push({...target,metadata:{...target.metadata,rev:'fictional-older-'+i}});
    const oldest=history.at(-1).metadata.rev, read=cloud.revisions.bind(cloud);
    const historyCalls=[];
    cloud.revisions=async(name,before,limit)=>{
      assert.notEqual(before,oldest);
      const rows=await read(name,before,limit); historyCalls.push(rows.length);
      if(!scatter || rows.length<3)return rows;
      // Full pages retain their last pagination cursor and exactly their chronological membership.
      const mixed=[];
      for(let n=0;n<rows.length;n+=100){const page=rows.slice(n,n+100);mixed.push(...page.slice(0,-1).reverse(),page.at(-1));}
      return mixed;
    };
    const result=await new SyncFiles(store,cloud,credentials,()=>time).settle('watched');
    assert.ok(!result.unresolved);
    assert.equal(result.delivery?.revision,arrived?expected.rev:undefined);
    if(!scatter)assert.ok(historyCalls.filter(n=>n>1).length===1,'ordered history is fetched once');
    assert.ok(historyCalls.length<=2*Math.ceil(Math.log2(history.length))+3);
  }
});
