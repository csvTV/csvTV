import assert from 'node:assert/strict';
import test from 'node:test';
import {readCsv, writeCsv} from '../dist/csv.js';
import {DropboxSync} from '../dist/dropbox-sync.js';
import {SyncFiles} from '../dist/dropbox-sync-file.js';
import {recentSeasonKey} from '../dist/recent-history.js';
import {confirmSingleDelivery, credentials, FictionalDropbox, memoryStore, time} from './dropbox-sync-fixture-cases.mjs';

const path = '/watched.csv';
const csv = rows => writeCsv('watched',rows);
const rows = Array.from({length:96},(_,i)=>({
  show_id:i+1, show:'Fictional series '+(i+1), season:1, episode:1, episode_id:1000+i,
  title:i===9?'Quoted "opening", part one\r\nPart two':'Opening', times_watched:1,
}));
async function fixture() {
  const store = memoryStore(), cloud = new FictionalDropbox();
  await cloud.put(path,csv(rows));
  const run = (session=credentials,now=()=>time,hooks={}) => new DropboxSync(store,cloud,session,hooks,now).run();
  assert.equal((await run()).complete,true);
  return {store,cloud,run};
}
const watchWrite = patch => patch.replace?.watched || patch.put?.watched || patch.remove?.watched;
async function verified(store,cloud,expected) {
  const saved = await store.snapshot(), actual = csv(expected);
  assert.equal(csv(saved.tables.watched),actual);
  assert.equal(csv(cloud.rows('watched')),actual);
  assert.equal(saved.sync.watched.base.content,actual);
  assert.equal(saved.sync.watched.base.revision,cloud.live.get(path).metadata.rev);
  assert.equal(saved.sync.watched.pending,null);
  assert.ok(saved.tables.watched.every(row=>Object.keys(row).length===7));
}

test('a based watched merge writes changed positions, removes stale ones and keeps recency aligned with the full result',async()=>{
  const {store,cloud,run} = await fixture();
  const mark = recentSeasonKey(rows[0].show_id,{season:1,first:0,last:0});
  const snapshot = await store.snapshot();
  await store.commit(snapshot.revision,{
    put:{watched:[{...rows[6],oldDeviceField:'fictional'}],settings:[{setting:mark,value:'10/10'}]},
    local:{recentlyMarked:[rows[0].show_id,rows[1].show_id],displacedRecentMark:rows[0].show_id},
  });
  const target = rows.slice(2);
  target[0] = {...rows[2],times_watched:4,title:'Two parts, "revised"'};
  // Move an established identity to another season and reuse its old position for a new episode.
  target.push({...rows[1],season:2},{...rows[1],episode_id:9001,title:'The new opener'});
  await cloud.put(path,csv(target));
  const writes = [], original = store.commit.bind(store);
  store.commit = async (revision,patch,options) => {
    if (watchWrite(patch)) writes.push(structuredClone(patch));
    return original(revision,patch,options);
  };
  assert.equal((await run()).complete,true);
  await verified(store,cloud,target);
  assert.equal(writes.length,1);
  assert.ok(!writes[0].replace?.watched,'a based sparse merge should not replace every episode');
  assert.deepEqual(writes[0].remove.watched,[[1,1,1]]);
  assert.deepEqual(writes[0].put.watched.map(row=>row.episode_id).sort((a,b)=>a-b),[1001,1002,1006,9001]);
  assert.ok(writes[0].put.settings.some(row=>row.setting===mark&&row.value==='10/0'));
  assert.ok(writes[0].removeLocal.includes('displacedRecentMark'));
  assert.equal((await run()).complete,true);
  assert.equal(writes.length,1,'an unchanged reopen should not rewrite episodes');
});

test('a sparse explicit Restore writes the changed episode; initial, discarded, empty and dense watch files use full replacement',async()=>{
  for (const kind of ['first','restore','discard','empty','dense']) {
    const {store,cloud} = await fixture();
    let snapshot = await store.snapshot();
    if (kind==='first') {
      await store.commit(snapshot.revision,{sync:{watched:null}});
      snapshot = await store.snapshot();
    }
    let target = rows.map((row,i)=>i===0?{...row,times_watched:2}:row);
    if (kind==='dense') target=rows.map(row=>({...row,times_watched:3}));
    if (kind==='empty') target=[];
    const content=csv(target), metadata=await cloud.put(path,content);
    let proposed;
    const original=store.commit.bind(store);
    store.commit=(revision,patch,options)=>{proposed=patch;return original(revision,patch,options);};
    await new SyncFiles(store,cloud,credentials,()=>time).prepare('watched',snapshot,kind==='restore'?content:{rows:target},
      metadata,content,undefined,kind==='discard');
    if (kind === 'restore') {
      assert.equal(proposed.replace?.watched,undefined);
      assert.deepEqual(proposed.put.watched,[target[0]]);
      assert.deepEqual(proposed.remove.watched,[]);
    } else assert.deepEqual(proposed.replace.watched,readCsv('watched',content).rows,kind);
    await verified(store,cloud,target);
  }
});

test('a sparse merge replans concurrent local edits and settles an interrupted upload on reopen',async()=>{
  const {store,cloud,run} = await fixture();
  const cloudRows=rows.map((row,i)=>i===0?{...row,times_watched:3}:row);
  await cloud.put(path,csv(cloudRows));
  const original=store.commit.bind(store);
  let raced=false,ackLost=false;
  store.commit=async (revision,patch,options)=>{
    if (!raced&&patch.put?.watched?.length&&options?.syncWrite) {
      raced=true;
      await original(revision,{put:{watched:[{...rows[1],times_watched:5}]}});
    }
    return original(revision,patch,options);
  };
  cloud.after=(method,file)=>{
    if (!ackLost&&file===path) {ackLost=true;throw Error('Lost fictional acknowledgement');}
  };
  await assert.rejects(run(),/unknown outcome/);
  assert.ok(raced&&ackLost);
  const pending=(await store.snapshot()).sync.watched.pending;
  assert.ok(pending?.targetRevision);
  const committed=cloud.live.get(path).metadata.rev;
  assert.equal((await run(credentials,()=>time,confirmSingleDelivery)).complete,true);
  const expected=cloudRows.map((row,i)=>i===1?{...row,times_watched:5}:row);
  await verified(store,cloud,expected);
  assert.equal(cloud.live.get(path).metadata.rev,committed,'the guarded replay must not create another revision');
});

test('replacing or expiring the session after a sparse plan preserves the local rows and receipt',async()=>{
  for (const change of ['replace','expire']) {
    const {store,cloud,run}=await fixture();
    const old=await store.snapshot(), target=rows.map((r,i)=>i===8?{...r,times_watched:4}:r);
    await cloud.put(path,csv(target));
    const original=store.commit.bind(store),replacement={...credentials,instanceId:'fictional-fresh-session'};
    let changed=false, at=time;
    store.commit=async(revision,patch,options)=>{
      if (!changed&&patch.put?.watched?.length&&options?.syncWrite) {
        changed=true;
        if(change==='replace')await original(revision,{local:{dropboxSession:replacement}});
        else at=credentials.signInDeadline;
      }
      return original(revision,patch,options);
    };
    await assert.rejects(run(credentials,()=>at));
    assert.ok(changed,change);
    const stopped=await store.snapshot();
    assert.deepEqual(stopped.tables.watched,old.tables.watched);
    assert.deepEqual(stopped.sync.watched,old.sync.watched);
    assert.equal((await run(change==='replace'?replacement:credentials)).complete,true);
    await verified(store,cloud,target);
  }
});

const listName = 'Saved, "for later" / weekend';
const ratingRows = rows.map(({show_id,show}) => ({show_id,show,rating:7}));
const listRows = rows.map(({show_id,show},i) => ({show_id,show,list:i%3 ? 'Favorites' : listName}));
const tabRows = {ratings:ratingRows,lists:listRows};
const tabFile = table => '/' + table + '.csv';

async function recordFixture() {
  const store=memoryStore(),cloud=new FictionalDropbox();
  for(const [table,records] of Object.entries(tabRows)) await cloud.put(tabFile(table),writeCsv(table,records));
  const run = () => new DropboxSync(store,cloud,credentials,{},()=>time).run();
  assert.equal((await run()).complete,true);
  return {store,cloud,run};
}

test('a peer rating and membership move update only the changed keys and preserve the matching remote revisions',async()=>{
  const {store,cloud,run}=await recordFixture(), original=store.commit.bind(store),patches=[];
  const changedRating={...ratingRows[2],rating:8.5,show:''};
  const newMember={...listRows[0],list:'Winter / specials, "later"'};
  const ratings=[changedRating,...ratingRows.slice(3)];
  const lists=[newMember,...listRows.slice(1)];
  await cloud.put(tabFile('ratings'),writeCsv('ratings',ratings));
  await cloud.put(tabFile('lists'),writeCsv('lists',lists));
  store.commit=(rev,patch,opts)=>{patches.push(patch);return original(rev,patch,opts);};
  assert.equal((await run()).complete,true);
  for(const [table,expected,puts,removed] of [
    ['ratings',ratings,[changedRating],[1,2]],
    ['lists',lists,[newMember],[[listName,1]]],
  ]) {
    const patch=patches.find(p=>p.replace?.[table]||p.put?.[table]);
    assert.ok(patch,table);
    assert.ok(!patch.replace?.[table],'a few changed '+table+' should use individual writes');
    assert.deepEqual(patch.put[table],puts);
    assert.deepEqual(patch.remove[table],removed);
    const current=await store.snapshot(),csv=writeCsv(table,expected);
    assert.equal(writeCsv(table,current.tables[table]),csv);
    assert.equal(current.sync[table].base.content,csv);
    assert.equal(current.sync[table].base.revision,cloud.live.get(tabFile(table)).metadata.rev);
    assert.equal(current.sync[table].pending,null);
  }
  const checkpoint=cloud.calls.length;
  assert.equal((await run()).complete,true);
  assert.equal(cloud.calls.slice(checkpoint).filter(c=>c.method==='download'&&['/ratings.csv','/lists.csv'].includes(c.path)).length,0);
});

test('legacy built-in list names are removed physically even when current and old spellings coexist',async()=>{
  const {store,cloud,run}=await recordFixture(), base=await store.snapshot();
  // Model a device predating list migrations. Its old keys and an unrelated peer edit must both survive normalization correctly.
  const [a,b]=listRows.slice(1,3);
  await store.commit(base.revision,{put:{lists:[{...a,list:'Favourites'},{...b,list:'Stopped'}]}});
  const expected=[{...listRows[0],show:'Changed by a peer'},...listRows.slice(1),{...b,list:'Dropped'}];
  await cloud.put('/lists.csv',writeCsv('lists',expected));
  let proposed;
  const original=store.commit.bind(store);
  store.commit=(rev,patch,opts)=>{if(patch.replace?.lists||patch.put?.lists)proposed=patch;return original(rev,patch,opts);};
  assert.equal((await run()).complete,true);
  assert.ok(proposed.replace?.lists,'raw legacy keys require full canonical replacement');
  const current=await store.snapshot();
  assert.ok(current.tables.lists.every(row=>!['Favourites','Stopped'].includes(row.list)));
  assert.equal(writeCsv('lists',current.tables.lists),writeCsv('lists',expected));
});

test('a sparse explicit Restore writes one rating or membership; initial, dense and empty files use full replacement',async()=>{
  for(const table of ['ratings','lists'])for(const kind of ['raw','initial','dense','empty']) {
    const {store,cloud}=await recordFixture();
    let snapshot=await store.snapshot();
    if(kind==='initial') {
      await store.commit(snapshot.revision,{sync:{[table]:null}});
      snapshot=await store.snapshot();
    }
    const target=kind==='empty'?[]:tabRows[table].map((r,i)=>kind==='dense'||i===0 ? {...r,show:'Renamed '+i}:r);
    const content=writeCsv(table,target), metadata=await cloud.put(tabFile(table),content);
    const original=store.commit.bind(store);
    let patch;
    store.commit=(rev,changes,opts)=>{patch=changes;return original(rev,changes,opts);};
    await new SyncFiles(store,cloud,credentials,()=>time).prepare(table,snapshot,kind==='raw'?content:{rows:target},metadata,content);
    if (kind === 'raw') {
      assert.equal(patch.replace?.[table],undefined);
      assert.deepEqual(patch.put[table],[target[0]]);
      assert.deepEqual(patch.remove[table],[]);
    } else assert.deepEqual(patch.replace[table],readCsv(table,content).rows,table+' '+kind);
    const current=await store.snapshot();
    assert.equal(writeCsv(table,current.tables[table]),content);
    assert.equal(current.sync[table].base.revision,metadata.rev);
    assert.equal(current.sync[table].base.content,content);
    assert.equal(current.sync[table].pending,null);
  }
});
