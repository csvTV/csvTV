import assert from 'node:assert/strict';
import test from 'node:test';
import { writeCsv } from '../dist/csv.js';
import { DropboxApi } from '../dist/dropbox-api.js';
import { checkResponse } from '../dist/dropbox-client.js';
import { adoptReset, checkResetEpoch, checkResetHistory, checkResetRevision, performReset, reserveBackupWriter, resetEpoch, resetLabels, resetMarker, reviewMergeDestination, reviewReset } from '../dist/dropbox-reset.js';
import { fictionalDropboxTransport } from './dropbox-roundtrip-cases.mjs';
import { FictionalDropbox, credentials, memoryStore, time, watch } from './dropbox-sync-fixture-cases.mjs';

const options = Object.keys(resetLabels);
const ratings = [{show_id:8,show:'Beacon',rating:8}], lists = [{show_id:8,show:'Beacon',list:'Dropped'}];
const recent = {setting:'recently_marked.7',value:'123/123'}, theme = {setting:'appearance',value:'dark'};
const secret = {setting:'github_token',value:'fictional-reset-key'};
const backup = '/backups/2026-01-10-56789abc-abcd-4abc-abc0-abcd12345678/watched.csv';
const protectedPaths = ['/a-note.csv','/backups/2026-01-10-my-copy/watched.csv','/backups/personal/watched.csv','/backups/2026-01-10-56789abc-abcd-4abc-abc0-abcd12345678/notes.txt',
  '/backups/2026-01-10-56789abc-abcd-4abc-abc0-abcd12345678/subfolder/ratings.csv'];
const now = () => time;
async function fixture() {
  const api = new FictionalDropbox();
  api.delete = async (path,rev) => {
    assert.ok(rev); if (api.live.get(path)?.metadata.rev !== rev) throw Error('Fictional deletion conflict');
    api.live.delete(path);
  };
  api.list = async (folder,recursive=false) => [...api.live.values()].map(f=>f.metadata)
    .filter(f=>recursive ? f.path.startsWith(folder+'/') : f.path.slice(0,f.path.lastIndexOf('/')) === folder)
    .map(f=>({...f,name:f.path.split('/').at(-1)}));
  const tables = {watched:[watch(2)],ratings,lists,settings:[recent,theme,secret],
    shows:[{show_id:7,show:'Coastal Dial',year:2020,imdb_id:''},{show_id:8,show:'Beacon',year:2013,imdb_id:'tt456'}]};
  for (const [table,rows] of Object.entries(tables)) await api.put('/'+table+'.csv',writeCsv(table,rows));
  await api.put('/summary.csv','Derived fictional record');
  for (const path of [backup,...protectedPaths]) await api.put(path,'fixture');
  return {api,tables};
}
test('every combination clears exactly the selected remote categories, retains unknown files and fences older writers',async () => {
  for (let bits=1; bits<2**options.length; bits++) {
    const {api,tables} = await fixture();
    const selected = options.filter((_,i)=>bits & 2**i), includes = key=>selected.includes(key);
    const review = await reviewReset(api,selected);
    const finished = await performReset(api,review,async()=>{},now);
    assert.deepEqual(finished.marker.pending,[]);
    assert.deepEqual(Object.keys(finished.marker.generations),selected);
    await assert.rejects(checkResetRevision(api,null),/changed/);
    for (const table of ['watched','ratings','lists']) assert.deepEqual(api.rows(table),includes(table) ? [] : tables[table]);
    assert.deepEqual(new Set(api.rows('settings').map(row=>row.setting)),
      new Set(tables.settings.filter(r=>r===recent ? !includes('watched') : !includes('settings')).map(r=>r.setting)));
    assert.deepEqual(api.rows('shows').map(r=>r.show_id).sort((a,b)=>a-b),
      [!includes('watched') ? 7 : null,!includes('ratings') || !includes('lists') ? 8 : null].filter(v=>v!==null));
    assert.equal(api.live.has(backup),!includes('backups'));
    for (const path of protectedPaths) assert.ok(api.live.has(path),path);
    assert.equal(JSON.stringify(finished).includes(secret.value),false);
    assert.equal(finished.marker.backupsClearedAt,includes('backups') ? time : 0);
  }
});

for (const reserved of [false,true]) test('a regular file named backups is preserved '+(reserved ?
  'and blocks a reserved backup clear before any write' : 'when clearing backup history'),async () => {
  const cloud = fictionalDropboxTransport();
  let writes = 0, backupLookups = 0;
  const api = new DropboxApi({async request(request) {
    if (request.endpoint === 'list' && JSON.parse(request.body).path === '/backups') {
      backupLookups++;
      assert.ok(cloud.files.has('/backups'));
      checkResponse({status:409,metadata:null,bytes:new TextEncoder().encode(JSON.stringify({
        error_summary:'path/not_folder/...',error:{'.tag':'path',path:{'.tag':'not_folder'}},
      }))});
    }
    if (['upload','delete','create'].includes(request.endpoint)) writes++;
    const reply = await cloud.transport({...request,headers:{...request.headers,Authorization:'Bearer example-access'}});
    checkResponse(reply);
    return reply;
  }});
  const add = {mode:'add'};
  await api.upload('/backups','Fictional owner’s ordinary file',add);
  await api.upload('/watched.csv',writeCsv('watched',[watch(2)]),add);
  if (reserved) await api.upload('/csvtv-reset.json',JSON.stringify({version:1,generations:{},pending:[],backupsClearedAt:0,
    reservations:['2026-01-12-12345678-abcd-4abc-9000-abcdef123456']}),add);
  const revisions = () => [...cloud.files].map(([path,file])=>[path,file.meta.rev]);
  const original = revisions(), before = writes;
  if (reserved) {
    await assert.rejects(reviewReset(api,['backups']),/file named backups blocks an unfinished csvTV backup/i);
    assert.deepEqual(revisions(),original);
    assert.equal(writes,before,'A refusal before confirmation must send zero writes');
  } else {
    const review = await reviewReset(api,['backups']);
    assert.deepEqual(review.backups,[]);
    assert.equal(writes,before);
    const finished = await performReset(api,review,async()=>{},now);
    assert.deepEqual(Object.keys(finished.marker.generations),['backups']);
    assert.deepEqual(finished.marker.pending,[]);
    assert.deepEqual(revisions().filter(([path])=>path!=='/csvtv-reset.json'),original);
  }
  assert.ok(backupLookups>0);
});
test('a signed-out device returning after two distinct clears adopts new remote rows and keeps unselected offline edits',async () => {
  const {api,tables} = await fixture(), store = memoryStore();
  const sync = Object.fromEntries(['watched','ratings','lists','settings'].map(t=>
    [t,{pending:null,lastClientModified:null,base:{content:writeCsv(t,tables[t].filter(r=>r!==secret)),
      revision:api.live.get('/'+t+'.csv').metadata.rev}}]));
  await store.commit((await store.snapshot()).revision,{replace:{...tables,settings:[recent,{...theme,value:'light'}],
    watched:[watch(7),watch(1,2)],ratings:[...ratings,{show_id:9,show:'Waves',rating:6}]},
    sync,local:{displacedRecentMark:7, recentlyMarked:[7]}});
  await performReset(api,await reviewReset(api,['watched']),async()=>{},now);
  await api.put('/watched.csv',writeCsv('watched',[watch(1,3)]));
  const final = await performReset(api,await reviewReset(api,['lists']),async()=>{},now);
  const count = await store.snapshot();
  await assert.rejects(adoptReset(api,store,final,{...credentials,instanceId:'different'},now));
  assert.equal((await store.snapshot()).revision,count.revision);
  await adoptReset(api,store,final,credentials,now);
  const after = await store.snapshot();
  assert.deepEqual(after.tables.watched,[watch(1,3)]);
  assert.equal(after.tables.lists.length,0); assert.equal(after.tables.ratings.length,2);
  assert.deepEqual(after.tables.settings,[{...theme,value:'light'}]);
  assert.equal(after.local.recentlyMarked,undefined); assert.equal(after.local.displacedRecentMark,undefined);
  assert.equal(after.local.dropboxSession.instanceId,credentials.instanceId);
  assert.equal(await adoptReset(api,store,final,credentials,now),false);
});
test('an interrupted or conflicting clear blocks ordinary sync and requires fresh review of the same scopes',async () => {
  const {api} = await fixture(), first = await reviewReset(api,['ratings','lists']);
  api.after = async (method,path) => { if (method==='upload' && path==='/ratings.csv') {
    api.after=async()=>{}; await api.put('/lists.csv',writeCsv('lists',[{...lists[0],list:'Keep for review'}]));
  } };
  await assert.rejects(performReset(api,first,async()=>{},now),/conflict/);
  const pending = await resetMarker(api);
  assert.deepEqual(pending.marker.pending,['ratings','lists']);
  assert.equal(api.rows('lists')[0].list,'Keep for review');
  await assert.rejects(adoptReset(api,memoryStore(),pending,credentials,now),/unfinished/);
  await assert.rejects(reviewReset(api,['watched']),/Ratings, Lists and Watchlist/);
  const retry = await reviewReset(api,['ratings','lists']);
  const resumed = await performReset(api,retry,async()=>{},now);
  assert.deepEqual(resumed.marker.generations,pending.marker.generations);
  assert.deepEqual(resumed.marker.ancestry,pending.marker.ancestry);
  await assert.rejects(performReset(api,retry,async()=>{},now),/changed|conflict/);
  assert.deepEqual(api.rows('lists'),[]);
});

async function previousBuildPendingClear() {
  const {api,tables} = await fixture();
  const path = '/csvtv-reset.json', selected = ['ratings'];
  // The previous build keeps just the category generation on an interrupted version-2 clear.
  const marker = {version:2,generations:{ratings:'first-clear'},pending:selected,backupsClearedAt:0,ancestry:{ratings:[null]}};
  const previous = await api.put(path,JSON.stringify(marker));
  const upload = api.upload.bind(api);
  api.upload = async (name,content,options) => {
    const current = api.live.get(name);
    if (options.mode === 'update' && current?.metadata.rev === options.revision &&
        new TextDecoder().decode(current.bytes) === content) return current.metadata;
    return upload(name,content,options);
  };
  return {api,tables,path,selected,previous,marker};
}

test('a lost resume reply can be retried from a previous build’s pending clear even when identical uploads keep their revision',async () => {
  const {api,tables,path,selected,previous,marker} = await previousBuildPendingClear();
  const upload = api.upload.bind(api);
  let loseReply = true;
  api.upload = async (name,content,options) => {
    const saved = await upload(name,content,options);
    if (name === path && loseReply) {
      loseReply = false;
      throw Error('Resume reply lost after Dropbox accepted the request');
    }
    return saved;
  };
  await assert.rejects(performReset(api,await reviewReset(api,selected),async()=>{},now),/reply lost/);
  const interrupted = await resetMarker(api);
  assert.notEqual(interrupted.revision,previous.rev,'An old writer could still proceed at the prior pending revision');
  assert.deepEqual(interrupted.marker.pending,selected);
  assert.deepEqual(api.rows('ratings'),tables.ratings,'The lost claim reply should stop file writes');
  const final = await performReset(api,await reviewReset(api,selected),async()=>{},now);
  assert.deepEqual(final.marker.pending,[]);
  assert.deepEqual(final.marker.generations,marker.generations);
  assert.deepEqual(final.marker.ancestry,marker.ancestry);
  assert.deepEqual(api.rows('ratings'),[]);
  assert.deepEqual(api.rows('watched'),tables.watched);
});

test('a simultaneous retry with the same reviewed pending marker cannot take over an accepted claim',async () => {
  const {api,tables,path,selected,marker} = await previousBuildPendingClear();
  const originalReview = await reviewReset(api,selected), rivalReview = await reviewReset(api,selected);
  const claimed = Promise.withResolvers(), release = Promise.withResolvers();
  const upload = api.upload.bind(api);
  let firstClaim = true;
  api.upload = async (name,content,options) => {
    const saved = await upload(name,content,options);
    if (name === path && firstClaim) {
      firstClaim = false;
      claimed.resolve();
      await release.promise; // Dropbox accepted the first claim, but its browser has not received the reply.
    }
    return saved;
  };
  const first = performReset(api,originalReview,async()=>{},now);
  await Promise.race([claimed.promise,first.then(()=>{throw Error('Clear finished before claiming the marker');})]);
  let rival, whilePending;
  try {
    [rival] = await Promise.allSettled([performReset(api,rivalReview,async()=>{},now)]);
    whilePending = api.rows('ratings');
  } finally { release.resolve(); }
  const [winner] = await Promise.allSettled([first]);
  assert.equal(rival.status,'rejected','A stale resume received permission to clear');
  assert.deepEqual(whilePending,tables.ratings,'The stale reviewer changed the record');
  assert.equal(winner.status,'fulfilled',winner.reason?.message);
  assert.deepEqual(winner.value.marker.generations,marker.generations);
  assert.deepEqual(winner.value.marker.pending,[]);
  assert.deepEqual(api.rows('ratings'),[]);
  assert.deepEqual(api.rows('lists'),tables.lists);
});
test('an obsolete review, a malformed marker or missing consent causes no deletion',async () => {
  const {api} = await fixture();
  await assert.rejects(reviewReset(api,[]),/Choose/);
  const review = await reviewReset(api,['backups']);
  await assert.rejects(performReset(api,review,async()=>{throw Error('Sign-in changed');},now),/changed/);
  assert.equal(api.live.has('/csvtv-reset.json'),false); assert.equal(api.live.has(backup),true);
  await api.put('/csvtv-reset.json','{"version":2}');
  await assert.rejects(reviewReset(api,['watched']),/newer format/);
  assert.equal(api.rows('watched').length,1);
});
test('contradictory fields or an incomplete pending generation pause a Dropbox clear before touching the record',async () => {
  const {api} = await fixture();
  const original = api.live.get('/watched.csv').metadata.rev;
  const fields = [
    '"generations":{"watched":"first","\\u0077atched":"second"},"pending":[]',
    '"generations":{"watched":"first"},"pending":["watched"],"pending":[]',
    '"generations":{"watched":"first"},"pending":["watched","ratings"]',
    '"generations":{"watched":"first","ratings":"other"},"pending":["watched","ratings"]',
    '"generations":{"watched":"first","ratings":"first"},"pending":["watched"]',
    '"generations":{"watched":"first","ratings":"first"},"pending":["ratings"]',
  ];
  for (const content of fields) {
    await api.put('/csvtv-reset.json','{"version":1,"backupsClearedAt":0,' + content + '}');
    await assert.rejects(reviewReset(api,['watched']),/reset marker.*unreadable/);
    assert.equal(api.live.get('/watched.csv').metadata.rev,original);
  }
});
test('an older marker missing an acknowledged clear category preserves offline edits and waits for the complete marker', async () => {
  const {api} = await fixture(), store = memoryStore();
  const first = await performReset(api,await reviewReset(api,['watched']),async()=>{},now);
  await adoptReset(api,store,first,credentials,now);
  await store.commit((await store.snapshot()).revision,{replace:{watched:[watch(4)]}});
  const second = await performReset(api,await reviewReset(api,['ratings']),async()=>{},now);
  const {marker} = second;
  await api.put('/csvtv-reset.json',JSON.stringify({...marker,generations:{ratings:marker.generations.ratings},ancestry:{ratings:marker.ancestry.ratings}}));
  const old = await resetMarker(api), revision = (await store.snapshot()).revision;
  await assert.rejects(adoptReset(api,store,old,credentials,now),/missing a previously cleared category/);
  assert.equal((await store.snapshot()).revision,revision);
  await api.put('/csvtv-reset.json',JSON.stringify(marker));
  await adoptReset(api,store,await resetMarker(api),credentials,now);
  assert.deepEqual((await store.snapshot()).tables.watched,[watch(4)]);
});

test('a first backup durably witnesses its marker without invalidating a reviewed record, even before any clears',async () => {
  const {api} = await fixture(), store = memoryStore(), initial = await resetMarker(api);
  const epoch = resetEpoch(initial), revision = (await store.snapshot()).revision;
  const folder = '2026-01-12-12345678-abcd-4abc-9000-abcdef123456';
  const release = await reserveBackupWriter(api,epoch,folder,false,async fence => {
    assert.equal(await adoptReset(api,store,fence,credentials,now),false);
  });
  const saved = await store.snapshot();
  assert.equal(saved.revision,revision);
  assert.deepEqual(saved.local.dropboxResetSeen,{accountId:credentials.accountId,generations:{}});
  const observed = await api.download('/csvtv-reset.json');
  api.live.delete('/csvtv-reset.json');
  assert.throws(()=>checkResetHistory(initial,{seen:saved.local.dropboxResetSeen.accountId===credentials.accountId}),/marker is missing/);
  await assert.rejects(checkResetEpoch(api,epoch,true),/marker is missing/);
  await assert.rejects(release(),/marker is missing/);
  assert.equal(api.live.has('/csvtv-reset.json'),false);
  await api.put('/csvtv-reset.json',observed.bytes); await release();
  assert.equal((await resetMarker(api)).marker.reservations.length,0);
  // Another device deletes the first marker after the reservation read but before its conditional update.
  api.before = async (method,path) => {
    if (method === 'upload' && path === '/csvtv-reset.json') { api.before = async()=>{}; api.live.delete(path); }
  };
  await assert.rejects(reserveBackupWriter(api,epoch,folder),/marker is missing/);
  assert.equal(api.live.has('/csvtv-reset.json'),false);
});

test('restoring a superseded same-category generation preserves unsynced local plays and their receipt',async () => {
  const {api} = await fixture(), store = memoryStore(), clear = async () => {
    const finished = await performReset(api,await reviewReset(api,['watched']),async()=>{},now);
    await adoptReset(api,store,finished,credentials,now); return finished.marker;
  };
  const first = await clear(), newest = await clear();
  await store.commit((await store.snapshot()).revision,{replace:{watched:[watch(4)]},
    sync:{watched:{base:null,pending:{content:'fictional outstanding upload'},lastClientModified:null}}});
  const before = await store.snapshot();
  await api.put('/csvtv-reset.json',JSON.stringify(first));
  const stale = await resetMarker(api), local = before.local.dropboxResetSeen;
  assert.throws(()=>checkResetHistory(stale,{seen:true,generations:local.generations,retired:local.retired}),/older clear/);
  await assert.rejects(adoptReset(api,store,stale,credentials,now),/older clear/);
  assert.deepEqual(await store.snapshot(),before);
  await api.put('/csvtv-reset.json',JSON.stringify(newest));
  assert.equal(await adoptReset(api,store,await resetMarker(api),credentials,now),false);
  assert.deepEqual(await store.snapshot(),before);
});
test('a selective clear replaces a stale summary while retained aired episode metadata is unavailable',async () => {
  const {api,tables} = await fixture();
  await performReset(api,await reviewReset(api,['ratings']),async()=>{},now,async()=>({
    tables,revision:3n,missingShowIds:new Set(),showMetadata:new Map([[7,{show_id:7,show:'Coastal Dial',seasons:[{season:1,episodeCount:4}],
      firstAirDate:'2020-01-01',lastEpisode:{season:1,episode:1}}]]),externalIds:new Map(),seasons:new Map(),
  }));
  const summary = new TextDecoder().decode(api.live.get('/summary.csv').bytes);
  assert.match(summary,/episodes_watched,times_completed/);
  assert.doesNotMatch(summary,/Derived fictional record|Coastal Dial,2020,1,1,[1-9]/);
  assert.deepEqual(api.rows('watched'),tables.watched);
  assert.equal(api.rows('shows').find(row=>row.show_id===8).year,2013);
});
test('a pre-existing unreadable retained file refuses all mutations before the reset marker is claimed',async () => {
  for (const [selected,broken] of [[['ratings'],'shows'],[['lists'],'watched'],[['watched'],'settings']]) {
    const {api} = await fixture();
    await api.put('/'+broken+'.csv','not,a,record\r\n1,2,3\r\n');
    const before=new Map([...api.live].map(([path,file])=>[path,file.metadata.rev]));
    const review=await reviewReset(api,selected);
    await assert.rejects(performReset(api,review,async()=>{},now));
    assert.deepEqual(new Map([...api.live].map(([path,file])=>[path,file.metadata.rev])),before);
  }
});
test('clearing backups fences a delayed first add in a new generation through two clears and a restarted writer',async () => {
  const {api} = await fixture(), initial = await resetMarker(api);
  const folder='2026-01-12-12345678-abcd-4abc-9000-abcdef123456';
  const release=await reserveBackupWriter(api,resetEpoch(initial),folder);
  const target='/backups/'+folder+'/watched.csv', pause=Promise.withResolvers(), sent=Promise.withResolvers();
  api.before=async(method,path,args)=>{ if(method==='upload' && path===target && args.content==='fictional personal watch') {
    sent.resolve(); await pause.promise;
  } };
  await checkResetEpoch(api,resetEpoch(initial));
  const late=api.upload(target,'fictional personal watch',{mode:'add'});
  await sent.promise;
  for (let i=0;i<2;i++) {
    const review=await reviewReset(api,['backups']);
    await performReset(api,review,async()=>{},now);
  }
  pause.resolve(); await assert.rejects(late,/conflict/);
  assert.equal(api.live.get(target).bytes.length,0);
  await assert.rejects(release(),/changed.*Sync again/);
  await assert.rejects(reserveBackupWriter(api,resetEpoch(initial),'2026-01-12-12345678-abcd-4abc-9000-abcdef123457'),/changed.*Sync again/);
  for(const name of ['watched.csv','ratings.csv','lists.csv','shows.csv','settings.csv','completion.json'])
    assert.equal(api.live.get('/backups/'+folder+'/'+name)?.bytes.length,0);
});
test('a delayed update of an already-empty watched file and a delayed first summary add both lose to the reviewed clear',async () => {
  const {api} = await fixture(), empty=writeCsv('watched',[]);
  const before=await api.put('/watched.csv',empty);
  api.live.delete('/summary.csv');
  const upload=api.upload.bind(api), pause=Promise.withResolvers(), sent=[];
  api.upload=async(path,content,options)=>{
    if (content==='late private bytes') { sent.push(path); await pause.promise; }
    const existing=api.live.get(path);
    if (options.mode==='update' && existing?.metadata.rev===options.revision && new TextDecoder().decode(existing.bytes)===content)
      return existing.metadata; // Dropbox can acknowledge identical content without advancing its revision.
    return upload(path,content,options);
  };
  const lateWatch=api.upload('/watched.csv','late private bytes',{mode:'update',revision:before.rev});
  const lateSummary=api.upload('/summary.csv','late private bytes',{mode:'add'});
  assert.deepEqual(sent,['/watched.csv','/summary.csv']);
  await performReset(api,await reviewReset(api,['watched']),async()=>{},now);
  pause.resolve();
  await Promise.all([assert.rejects(lateWatch,/conflict/),assert.rejects(lateSummary,/conflict/)]);
  assert.deepEqual(api.rows('watched'),[]);
  assert.match(new TextDecoder().decode(api.live.get('/summary.csv').bytes),/^show,year,season/);
});
test('losing the completion reply leaves a finished operation that a restarted device can adopt once',async () => {
  const {api,tables} = await fixture(), store = memoryStore();
  await store.commit((await store.snapshot()).revision,{replace:{watched:tables.watched}});
  const review = await reviewReset(api,['watched']);
  let writes = 0;
  api.after = async (method,path) => { if (method==='upload' && path==='/csvtv-reset.json' && ++writes===2) throw Error('Lost reply'); };
  await assert.rejects(performReset(api,review,async()=>{},now),/Lost reply/);
  const fence = await resetMarker(api);
  assert.deepEqual(fence.marker.pending,[]); assert.equal((await store.snapshot()).tables.watched.length,1);
  assert.ok(await adoptReset(api,store,fence,credentials,now));
  assert.equal((await store.snapshot()).tables.watched.length,0);
  assert.equal(await adoptReset(api,store,fence,credentials,now),false);
});
test('a deliberate transfer into a different account reviews its past clears and fences a new sign-in or newer clear',async () => {
  for (const decision of ['cancel','include','dropbox','newer clear','new session']) {
    const {api,tables} = await fixture(), store = memoryStore();
    const fence = await performReset(api,await reviewReset(api,['watched']),async()=>{},now);
    await store.commit((await store.snapshot()).revision,{replace:{watched:tables.watched},local:{dropboxMergeDestination:credentials.accountId}});
    const review = reviewMergeDestination(api,store,fence,credentials,now,async categories=>{
      assert.deepEqual(categories,['watched']);
      if (decision==='newer clear') { await performReset(api,await reviewReset(api,['ratings']),async()=>{},now); return 'include'; }
      if (decision==='new session') {
        await store.commit((await store.snapshot()).revision,{local:{dropboxSession:{...credentials,instanceId:'other'}}}); return 'include';
      }
      return decision;
    });
    if (['include','dropbox'].includes(decision)) {
      await review; await adoptReset(api,store,fence,credentials,now);
      assert.equal((await store.snapshot()).tables.watched.length,decision==='include' ? 1 : 0);
    } else {
      await assert.rejects(review);
      assert.equal((await store.snapshot()).local.dropboxMergeDestination,credentials.accountId);
      assert.deepEqual((await store.snapshot()).tables.watched,tables.watched);
    }
  }
});
