import test from 'node:test';
import assert from 'node:assert/strict';
import { writeBackup, listBackups, openBackup } from '../dist/dropbox-backup.js';
import { restoreBackup } from '../dist/dropbox-restore.js';
import { DropboxError } from '../dist/dropbox-client.js';
import { DropboxLimitError } from '../dist/dropbox-limits.js';
import { DropboxSync } from '../dist/dropbox-sync.js';
import { SyncFiles } from '../dist/dropbox-sync-file.js';
import { readLocalRecord, previewLocalRecord } from '../dist/local-restore.js';
import { writeCsv } from '../dist/csv.js';
import { emptyTables } from '../dist/model.js';
import { credentials, FictionalDropbox, memoryStore, sync, time, watch, watchCsv, edit, count } from './dropbox-sync-fixture-cases.mjs';

const conflict = () => Object.assign(Error('Fictional folder exists'), { kind: 'conflict' });
const notFound = () => Object.assign(Error('Fictional path not found'), { kind: 'not-found' });
const rating = value => writeCsv('ratings', [{ show_id: 7, show: 'Coastal Dial', rating: value }]);
const d = new TextDecoder();

test('restore distinguishes local storage and Dropbox errors and preserves outcomes for each selected file',async () => {
  const privateMessage = 'fictional private provider response';
  const failures = [
    [Object.assign(new DropboxError('permission'),{message:privateMessage}),/denied permission/i],
    [new DropboxError('storage-full'),/Dropbox storage is full/],
    [new DOMException(privateMessage,'QuotaExceededError'),/This device is out of storage/],
    [new DOMException(privateMessage,'AbortError'),/check the connection and sign-in/i],
    [Object.assign(Error(privateMessage),{name:'QuotaExceededError'}),/check the connection and sign-in/i],
    [Object.assign(Error(privateMessage),{kind:'permission'}),/check the connection and sign-in/i],
  ];
  for (const [error,reason] of failures) {
    const engine = {async settleForRestore() { throw error; }};
    const files = new Map([['watched',watchCsv(2)],['ratings',rating(7)]]);
    const result = await restoreBackup({},engine,files);
    assert.match(result.issue,reason);
    assert.ok(!result.issue.includes(privateMessage));
    assert.deepEqual([...result.files],[['watched','untouched'],['ratings','untouched']]);
  }
});
class BackupDropbox extends FictionalDropbox {
  folders = new Set();
  async put(path, content, cm) {
    const meta = await super.put(path, content, cm);
    meta.name = path.split('/').pop();
    return meta;
  }
  async list(path = '',recursive = false) {
    await this.before('list', path);
    if (path && !this.folders.has(path)) throw notFound();
    const child = p => recursive ? p.startsWith(path+'/') : p.slice(0, p.lastIndexOf('/')) === path;
    return [...[...this.folders].filter(child).map(p => ({ path: p, name: p.split('/').pop(), kind: 'folder' })),
      ...[...this.live.entries()].filter(([p]) => child(p)).map(([, file]) => file.metadata)];
  }
  async createFolder(path) {
    if (this.folders.has(path)) throw conflict();
    this.folders.add(path);
  }
  async delete(path, revision) {
    await this.before('delete', path);
    if (revision !== undefined) {
      if (this.live.get(path)?.metadata.rev !== revision) throw conflict();
      this.live.delete(path);
      return;
    }
    this.folders.delete(path);
    for (const name of this.live.keys()) if (name.startsWith(path + '/')) this.live.delete(name);
  }
}
test('a sparse backup restore binds the changed rows and absolute upload to the reviewed device and cloud versions',async()=>{
  const api=new BackupDropbox(),store=memoryStore(),path='/watched.csv';
  const old=Array.from({length:96},(_,i)=>watch(1,i+1));
  const chosen=old.filter(row=>row.episode!==42).map(row=>row.episode===18?{...row,times_watched:3}:row);
  const previous=writeCsv('watched',old),content=writeCsv('watched',chosen);
  const live=await api.put(path,previous);await api.put('/ratings.csv',rating(7));await sync(store,api).run();
  const save=store.commit.bind(store);let prepared;
  store.commit=async(version,patch,options)=>{
    if(patch.sync?.watched?.pending)prepared=structuredClone(patch);
    return save(version,patch,options);
  };
  api.after=async(kind,name)=>{if(kind==='upload'&&name===path)throw Error('Fictional response went missing');};
  const result=await restoreBackup(api,sync(store,api),new Map([['watched',content]]),{reviewedLocal:new Map([['watched',previous]])});
  assert.equal(result.files.get('watched'),'unknown');assert.equal(prepared.replace?.watched,undefined);
  assert.deepEqual(prepared.put.watched,[watch(3,18)]);assert.deepEqual(prepared.remove.watched,[[7,1,42]]);
  const received=prepared.sync.watched.pending;
  assert.equal(received.absoluteWatches,true);assert.equal(received.targetRevision,live.rev);
  assert.equal(received.content,content);assert.equal(received.targetContent,previous);
  assert.equal(writeCsv('watched',(await store.snapshot()).tables.watched),content);
  api.after=async()=>{};await sync(store,api).run();const fresh=memoryStore();await sync(fresh,api).run();
  assert.equal(writeCsv('watched',(await fresh.snapshot()).tables.watched),content);
  assert.equal((await fresh.snapshot()).tables.ratings[0].rating,7);
});

test('only a sufficiently large, confirmed restore of the settled watched file qualifies for the dedicated worker',async()=>{
  const initial=Array.from({length:144},(_,i)=>watch(1,i+1)),old=writeCsv('watched',initial);
  const chosen=initial.map(row=>({...row,times_watched:2}));
  for(const mode of ['confirmed','sparse','sparse-31','sparse-32','remove-32','mixed','short','no-screen','no-base','other-revision','other-content','local-edit','pending',
      'canceled','new-recent-history','discarded-base']){
    const store=memoryStore(),api=new BackupDropbox(),meta=await api.put('/watched.csv',old);
    const file={base:mode==='no-base'?null:{revision:meta.rev,content:old},lastClientModified:null,pending:mode==='pending'?{
      content:old,targetRevision:meta.rev,targetContent:old,clientModified:'2026-10-01T00:00:00Z',preparedAt:time}:null};
    const target=mode==='other-revision'?await api.put('/watched.csv',old):meta;
    const targetContent=mode==='other-content'?writeCsv('watched',[watch(4)]):old;
    const local=mode==='local-edit'?[watch(8),...initial.slice(1)]:initial;
    let incoming=mode==='sparse'?[watch(3),...initial.slice(1)]:mode==='short'?chosen.slice(0,3):
      mode==='new-recent-history'?chosen.map(row=>({...row,show_id:8,show:'Coral Clock'})):chosen;
    let delta;
    if (mode==='sparse-31' || mode==='sparse-32') {
      const n=mode==='sparse-31'?31:32;
      delta={put:chosen.slice(0,n),remove:[]};
      incoming=[...delta.put,...initial.slice(n)];
    } else if (mode==='remove-32' || mode==='mixed') {
      const n=mode==='remove-32'?32:1;
      const put=mode==='mixed'?[...chosen.slice(n,32),watch(1,145)]:[];
      delta={put,remove:initial.slice(0,n).map(row=>[row.show_id,row.season,row.episode])};
      incoming=mode==='mixed'?[...chosen.slice(n,32),...initial.slice(32),watch(1,145)]:initial.slice(n);
    }
    const content=writeCsv('watched',incoming);
    const flags=mode==='new-recent-history'?{recentlyMarked:[7]}:mode==='canceled'?{'dropboxCanceled:watched':true}:{};
    await store.commit((await store.snapshot()).revision,{replace:{watched:local},sync:{watched:file},local:flags});
    const before=await store.snapshot();let worker=false;
    store.installWatchRestore=async(revision,watched,receipt,session,current,prior)=>{
      worker=true;assert.equal(revision,before.revision);assert.ok(current());assert.equal(session.accountId,credentials.accountId);
      assert.deepEqual(watched,delta??incoming);assert.equal(prior.base.revision,target.rev);assert.equal(prior.count,initial.length);
      assert.equal(receipt.pending.absoluteWatches,true);assert.equal(receipt.pending.content,content);
    };
    const files=new SyncFiles(store,api,credentials,()=>time);
    const pending=await files.prepare('watched',before,content,target,targetContent,undefined,mode==='discarded-base',
      mode==='no-screen'?undefined:()=>true);
    assert.equal(worker,['confirmed','sparse-32','remove-32','mixed'].includes(mode),mode);
    assert.equal(pending.content,content,mode);assert.equal(pending.absoluteWatches,true,mode);
    if(!worker){const next=await store.snapshot();assert.equal(writeCsv('watched',next.tables.watched),content,mode);
      assert.deepEqual(next.sync.watched.pending,pending,mode);}
  }
});

test('a reviewed backup preserves a selected file edited during restore and permits changes to unrelated files',async()=>{
  for (const edited of ['ratings','lists']) {
    const api=new BackupDropbox(),store=memoryStore();
    await api.put('/watched.csv',watchCsv(2));
    await api.put('/ratings.csv',rating(8));
    const engine=sync(store,api);
    await engine.run();
    const choice=new Map([['watched',watchCsv(1)],['ratings',rating(5)]]);
    const reviewedLocal=new Map([['watched',watchCsv(2)],['ratings',rating(8)]]);
    let changed=false;
    const outcome=await restoreBackup(api,engine,choice,{reviewedLocal,onSaved(){
      if(changed)return;
      changed=true;
    },onProgress(step){
      if(step!=='Restoring ratings.csv…')return;
      api.before=async(method,path)=>{
        if(method!=='download'||path!=='/ratings.csv')return;
        api.before=async()=>{};
        const row=edited==='ratings'?{show_id:7,show:'Coastal Dial',rating:9}:{show_id:7,show:'Coastal Dial',list:'Favorites'};
        await store.commit((await store.snapshot()).revision,{put:{[edited]:[row]}});
      };
    }});
    assert.ok(changed);
    assert.equal(outcome.files.get('watched'),'restored');
    assert.equal(await count(store),1);
    assert.equal(outcome.files.get('ratings'),edited==='ratings'?'untouched':'restored');
    const settled=await store.snapshot();
    assert.equal(settled.tables.ratings[0].rating,edited==='ratings'?9:5);
    assert.equal(api.rows('ratings')[0].rating,edited==='ratings'?8:5);
    if(edited==='ratings')assert.match(outcome.issue,/changed after confirmation/i);
    else {assert.equal(outcome.issue,null);assert.equal(settled.tables.lists[0].list,'Favorites');}
    await sync(store,api).run();
    const fresh=memoryStore();await sync(fresh,api).run();
    assert.deepEqual((await fresh.snapshot()).tables.ratings,settled.tables.ratings);
  }
});
for (const kind of ['unavailable','provider-unavailable','throttled']) test(`an acknowledged backup survives ${kind} during the retention listing`, async () => {
  const api = new BackupDropbox();
  await api.put('/watched.csv',watchCsv(2));
  let released = false, failedListing = false;
  api.reserveBackup = async () => async () => { released = true; };
  api.before = async (method,path) => {
    if (released && method === 'list' && path === '/backups' && !failedListing) {
      failedListing = true;
      throw new DropboxError(kind);
    }
  };
  const generation = await writeBackup(api,{now:time,id:()=>'retained'});
  assert.ok(failedListing);
  assert.equal(generation.status,'verified');
  assert.deepEqual((await listBackups(api)).map(item=>item.folder),[generation.folder]);
  assert.equal((await openBackup(api,generation.folder)).get('watched'),watchCsv(2));
});
test('browsing indexed backups overlaps only bounded manifest reads and stops the batch on cancellation or a changed account',async()=>{
  const api=new BackupDropbox();
  await api.put('/watched.csv',watchCsv(2));
  for(let i=0;i<8;i++)await writeBackup(api,{beforeRestore:true,now:time,id:()=>'read-'+i});
  const original=api.download.bind(api);
  let manifests=0,copies=0,peakManifests=0,peakCopies=0;
  api.download=async(path,signal)=>{
    const marker=path.endsWith('/completion.json');
    if(marker){peakManifests=Math.max(peakManifests,++manifests);assert.equal(copies,0);}
    else {peakCopies=Math.max(peakCopies,++copies);assert.equal(manifests,0);}
    try {await new Promise(resolve=>setImmediate(resolve));return await original(path,signal);}
    finally {if(marker)manifests--;else copies--;}
  };
  const results=await listBackups(api);
  assert.equal(results.length,8);assert.ok(results.every(g=>g.status==='verified'));
  assert.equal(peakManifests,3);assert.equal(peakCopies,1);
  for(const reason of ['changed account','leave page']){
    const close=new AbortController(),started=Promise.withResolvers(),paths=[];
    let canceled=0;
    api.download=async(path,signal)=>{
      const position=paths.push(path);
      if(position===3)started.resolve();
      if(position===1 && reason==='changed account'){await started.promise;throw new DropboxError('account-changed');}
      return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>{
        canceled++;reject(new DOMException('Closed','AbortError'));
      },{once:true}));
    };
    const pending=listBackups(api,close.signal);
    await started.promise;
    if(reason==='leave page')close.abort();
    await assert.rejects(pending,reason==='leave page'?{name:'AbortError'}:{kind:'account-changed'});
    assert.equal(canceled,reason==='leave page'?3:2);
    assert.equal(paths.length,3);assert.ok(paths.every(path=>path.endsWith('/completion.json')));
  }
});

test('restoring this device after an interrupted watch review preserves the original receipt until a verified replacement',async()=>{
  for(const race of ['none','local','remote','backup']) {
    const api=new BackupDropbox(),store=memoryStore(),path='/watched.csv';
    await api.put(path,watchCsv(3)); await sync(store,api).run();
    await edit(store,watch(1));
    api.after=async(method,file)=>{if(method==='upload' && file===path)throw Error('Fictional reply lost');};
    await assert.rejects(sync(store,api).run(),/unknown outcome/);
    api.after=async()=>{};
    const saved=(await store.snapshot()).sync.watched.pending,matched=api.live.get(path).metadata.rev;
    let questions=0;
    const engine=sync(store,api,{doubleMarks:async review=>{
      assert.equal(review.delivery,true); return {choice:'two'};
    },guard:async q=>{
      assert.equal(q.decision.reason,'all-local-rows-removed');questions++;return 'restore-device';
    },restoreDevice:async(table,content,instance,revision)=>{
      assert.equal(table,'watched'); assert.equal(content,watchCsv(1)); assert.equal(revision,matched);
      if(race==='local')await edit(store,watch(4));
      if(race==='remote')await api.put(path,watchCsv(7));
      if(race==='backup')api.createFolder=async()=>{throw new DropboxError('unavailable');};
      const outcome=await restoreBackup(api,instance,new Map([[table,content]]),{guardTarget:{table,content,revision}});
      if(outcome.issue)throw Error(outcome.issue);
      assert.equal(outcome.files.get(table),'restored');
    }});
    if(race==='none') {
      assert.equal((await engine.run()).complete,true); assert.equal((await store.snapshot()).sync.watched.pending,null);
      assert.equal(api.live.get(path).metadata.rev,matched);
      assert.ok([...api.live.keys()].some(name=>name.endsWith('/completion.json')));
    } else {
      await assert.rejects(engine.run(),race==='backup'?/could not be reached/i:/changed/i);
      assert.deepEqual((await store.snapshot()).sync.watched.pending,saved);
      assert.equal(await count(store),race==='local'?4:1);
      assert.equal(api.rows('watched')[0].times_watched,race==='remote'?7:1);
    }
    assert.equal(questions,1);
  }
});

test('an account change during backup retention still reaches the caller', async () => {
  const api = new BackupDropbox();
  let released = false;
  api.reserveBackup = async () => async () => { released = true; };
  api.before = async (method,path) => {
    if (released && method === 'list' && path === '/backups') {
      throw Object.assign(Error('Replacement account'),{kind:'account-changed'});
    }
  };
  await assert.rejects(writeBackup(api,{now:time,id:()=>'new-account'}),{kind:'account-changed'});
});

test('restore this device’s copy can finish after review of an interrupted initial file',async()=>{
  for(const keepTarget of [true,false]) {
    const store=memoryStore(),api=new BackupDropbox(),path='/watched.csv';
    await edit(store,watch(8));
    api.after=async(method,file)=>{if(method==='upload' && file===path)throw Error('Fictional lost creation reply');};
    await assert.rejects(sync(store,api).run(),/unknown outcome/); api.after=async()=>{};
    const initial=(await store.snapshot()).sync.watched.pending;
    await edit(store,watch(7)); const emptied=await api.put(path,watchCsv(0));
    let guards=0;
    const engine=sync(store,api,{doubleMarks:async review=>{
      assert.equal(review.firstCopy,true); assert.deepEqual(review.episodes[0].deliveryTotals,{one:'0',two:'7'});
      return {choice:'one'};
    },guard:async q=>{assert.equal(q.decision.reason,'all-local-rows-removed');guards++;return 'restore-device';},
    restoreDevice:async(table,content,instance,revision)=>{
      assert.equal(revision,emptied.rev);
      if(!keepTarget)api.live.delete(path);
      const result=await restoreBackup(api,instance,new Map([[table,content]]),{guardTarget:{table,content,revision}});
      if(result.issue)throw Error(result.issue);
      assert.equal(result.files.get(table),'restored');
    }});
    if(keepTarget) {
      assert.equal((await engine.run()).complete,true); assert.deepEqual(api.rows('watched'),[watch(7)]);
      assert.equal((await store.snapshot()).sync.watched.pending,null);
      assert.ok([...api.live.keys()].some(name=>name.endsWith('/completion.json')));
    } else {
      await assert.rejects(engine.run(),/changed/i); assert.equal(api.live.has(path),false);
      assert.deepEqual((await store.snapshot()).sync.watched.pending,initial);
    }
    assert.equal(guards,1);
  }
});
test('oversized backup input preserves older verified generations and bounded browsing reads no surplus folders',async()=>{
  const api=new BackupDropbox();
  await api.put('/watched.csv',watchCsv(1));
  await api.put('/ratings.csv',rating(5));
  const healthy=await writeBackup(api,{now:time,id:()=>'healthy'});
  const later=await writeBackup(api,{now:time,id:()=>'larger'});
  const oversizedDir='/backups/'+later.folder;
  for (const file of ['watched.csv','ratings.csv']) api.live.get(oversizedDir+'/'+file).metadata.size=60*1024*1024;
  assert.deepEqual((await listBackups(api)).map(g=>g.status),['verified','unverified']);
  await assert.rejects(openBackup(api,later.folder),{kind:'too-large'});
  assert.equal((await openBackup(api,healthy.folder)).get('watched'),watchCsv(1));
  await api.put('/ratings.csv',','.repeat(128));
  await assert.rejects(writeBackup(api,{now:time,id:()=>'unfinished'}),{kind:'too-large'});
  assert.ok((await listBackups(api)).some(g=>g.folder===healthy.folder&&g.status==='verified'));
  assert.ok(![...api.live.keys()].some(path=>path.endsWith('unfinished/completion.json')));
  for (let i=0;i<129;i++) {
    const dir='/backups/folder-'+i;
    api.folders.add(dir);
    await api.put(dir+'/ratings.csv',rating(1));
  }
  const calls=[];
  api.before=(method,path)=>{calls.push([method,path]);};
  await assert.rejects(listBackups(api),{kind:'too-large'});
  await assert.rejects(writeBackup(api,{now:time}),{kind:'too-large'});
  assert.deepEqual(calls,Array(4).fill(['list','/backups']));
});

test('backup verification checks the show index while Restore transfers only the files it can offer',async()=>{
  const api=new BackupDropbox();
  await api.put('/watched.csv',watchCsv(2));
  await api.put('/shows.csv',writeCsv('shows',[{show_id:7,show:'Coastal Dial',year:2020,imdb_id:''}]));
  const reads=[];
  api.before=(method,path)=>{ if (method==='download') reads.push(path); };
  const copy=await writeBackup(api,{now:time,beforeRestore:true,id:()=>'with-index'});
  const dir='/backups/'+copy.folder;
  assert.ok(reads.includes(dir+'/shows.csv'),'the new immutable index copy was verified');
  reads.length=0;
  api.live.get(dir+'/shows.csv').metadata.size=65*1024*1024;
  assert.equal((await listBackups(api))[0].status,'unverified');
  assert.deepEqual([...(await openBackup(api,copy.folder))],[['watched',watchCsv(2)]]);
  assert.ok(!reads.includes(dir+'/shows.csv'),'opening readable files does not fetch the derived index');
});

test('An interrupted backup remains individually recoverable. A retry marks absence and records an unreadable settings revision without copying it', async () => {
  const api = new BackupDropbox();
  assert.deepEqual(await listBackups(api), []);
  const watched = await api.put('/watched.csv', watchCsv(2));
  const raw = Uint8Array.from([255, 1, 5]);
  const settings = await api.put('/settings.csv', raw); await api.put('/ratings.csv', rating(0));
  api.before = (method, path) => { if (method === 'upload' && path.endsWith('first/ratings.csv')) throw Error('Interruption'); };
  await assert.rejects(writeBackup(api, { now: time, id: () => 'first' }));
  assert.equal((await listBackups(api))[0].status, 'incomplete');
  api.before = async () => {};
  let tries = 0;
  const result = await writeBackup(api, { now: time, weekly: true, id: () => ++tries === 1 ? 'first' : 'second' });
  const base = '/backups/' + result.folder;
  assert.deepEqual(result.entries['watched.csv'], { rev: watched.rev, hash: watched.contentHash });
  assert.equal(result.entries['shows.csv'], null);
  assert.equal(await api.download(base + '/settings.csv'), null);
  assert.deepEqual(result.entries['settings.csv'], {rev:settings.rev, hash:settings.contentHash, omitted:true});
  assert.deepEqual([...(await openBackup(api, result.folder)).keys()], ['watched', 'ratings']);
  assert.equal(await writeBackup(api, { weekly: true, now: Date.parse(result.modified) + 7 * 86400000 }), null);
  assert.ok(await writeBackup(api, { weekly: true, now: Date.parse(result.modified) + 7 * 86400000 + 1 }));
});

test('An exact restore excludes a watched file that assigns the same episode ID twice and still recovers other files', async () => {
  const api = new BackupDropbox(), store = memoryStore(), engine = sync(store,api);
  const ambiguous = writeCsv('watched', [watch(2,1,1901), {...watch(3,2,1901), season:2}]);
  await api.put('/watched.csv',ambiguous);
  await api.put('/ratings.csv',rating(6));
  const generation = await writeBackup(api,{beforeRestore:true,now:time,id:()=>'ambiguous'});
  assert.equal(generation.status,'verified'); // Its bytes were faithfully copied.
  const offered = await openBackup(api,generation.folder);
  assert.deepEqual([...offered.keys()],['ratings']);
  const original = await api.put('/watched.csv',watchCsv(1));
  await api.put('/ratings.csv',rating(9));
  await edit(store,watch(1));

  const previous = await store.snapshot(), folders = api.folders.size;
  const live = await api.download('/watched.csv');
  const invalid = await restoreBackup(api,engine,new Map([['ratings',rating(6)],['watched',ambiguous]]));
  assert.match(invalid.issue,/episode more than one position/);
  assert.deepEqual([...invalid.files.values()],['untouched','untouched']);
  assert.equal(api.folders.size,folders);
  await assert.rejects(engine.replaceForRestore('watched',ambiguous,live),/episode more than one position/);
  assert.deepEqual(await store.snapshot(),previous);
  assert.equal((await api.download('/watched.csv')).metadata.rev,original.rev);
  assert.equal(api.rows('ratings')[0].rating,9);

  const recovered = await restoreBackup(api,engine,offered);
  assert.equal(recovered.issue,null);
  assert.equal(api.rows('ratings')[0].rating,6);
  assert.equal((await store.snapshot()).tables.ratings[0].rating,6);
  assert.equal((await api.download('/watched.csv')).metadata.rev,original.rev);
  assert.deepEqual((await store.snapshot()).tables.watched,[watch(1)]);

  const distinct = [watch(1,1,1901),{...watch(3,1,1901),show_id:8},watch(2,2,null),watch(3,3,null)];
  const corrected = await restoreBackup(api,engine,new Map([['watched',writeCsv('watched',distinct)]]));
  assert.equal(corrected.issue,null);
  assert.equal(writeCsv('watched',api.rows('watched')),writeCsv('watched',distinct));
});

test('A stale folder listing cannot verify a generation containing a settings copy marked omitted', async () => {
  const api = new BackupDropbox();
  await api.put('/watched.csv',watchCsv(2));
  await api.put('/settings.csv',Uint8Array.of(255));
  const backup = await writeBackup(api,{beforeRestore:true,now:time,id:()=>'first'});
  assert.equal(backup.entries['settings.csv'].omitted,true);
  const dir = '/backups/' + backup.folder;
  await api.put(dir + '/settings.csv',writeCsv('settings',[{setting:'imdb_source',value:'omdb'}]));
  const list = api.list.bind(api);
  api.list = async path => {
    const files = await list(path);
    return path === dir ? files.filter(file=>file.name !== 'settings.csv') : files;
  };
  assert.equal((await listBackups(api))[0].status,'unverified');
  assert.deepEqual([...(await openBackup(api,backup.folder)).keys()],['watched']);
  const next = await writeBackup(api,{weekly:true,now:Date.parse(backup.modified),id:()=>'retry'});
  assert.equal(next.status,'verified');
  const stale = await list(dir);
  api.live.delete(dir + '/settings.csv');
  api.list = path => path === dir ? stale : list(path);
  assert.equal((await listBackups(api)).find(item=>item.folder === backup.folder).status,'verified');
});

test('A lost marker acknowledgement is recovered only with the expected manifest and intact copies', async () => {
  for (const tamper of [false, true]) {
    const api = new BackupDropbox();
    await api.put('/watched.csv', watchCsv(3));
    api.after = async (method, path) => {
      if (path.endsWith('/completion.json')) {
        if (tamper) await api.put(path.replace('completion.json', 'watched.csv'), watchCsv(1));
        throw Error('Lost acknowledgement');
      }
    };
    if (tamper) await assert.rejects(writeBackup(api, { beforeRestore: true }));
    else assert.equal((await writeBackup(api, { beforeRestore: true })).status, 'verified');
  }
});

test('New backups exclude provider keys and restoring legacy preferences preserves the current Dropbox keys', async () => {
  const api = new BackupDropbox(), device = memoryStore();
  const old = {setting:'omdb_key',value:'fictional-retired-key'};
  const current = {setting:'tmdb_key',value:'fictional-current-key'};
  const repo = {setting:'github_repo',value:'fictional/restored'};
  const settings = rows => writeCsv('settings',rows);
  await api.put('/settings.csv',settings([current]));
  const backup = await writeBackup(api,{beforeRestore:true});
  const path = '/backups/'+backup.folder+'/settings.csv';
  assert.equal(d.decode((await api.download(path)).bytes),settings([]));
  const legacy = 'previous-device';
  await api.createFolder('/backups/'+legacy);
  const original = settings([old,repo]);
  await api.put('/backups/'+legacy+'/settings.csv',original);
  const selected = await openBackup(api,legacy);
  assert.equal(selected.get('settings'),settings([repo]));
  // A caller that supplies an unfiltered older selection receives the same protection.
  selected.set('settings',original);
  const engine = new DropboxSync(device,api,credentials,{},()=>time,async () => {});
  const result = await restoreBackup(api,engine,selected);
  assert.equal(result.issue,null);
  assert.equal(result.files.get('settings'),'restored');
  assert.deepEqual(api.rows('settings'),[repo,current]);
  const stored = await device.snapshot();
  assert.deepEqual(stored.tables.settings,[repo]);
  assert.equal(stored.sync.settings.base.content,settings([repo]));
  assert.equal(d.decode((await api.download('/backups/'+legacy+'/settings.csv')).bytes),original);
});

test('The ordinary weekly check finds a verified recent marker without opening hundreds of retired folders', async () => {
  const api = new BackupDropbox();
  await api.put('/watched.csv',watchCsv(3));
  const recent = await writeBackup(api,{beforeRestore:true,now:time,id:()=>'recent'});
  for (let i=0;i<256;i++) await api.createFolder('/backups/2020-01-01-retired-'+i);
  await api.createFolder('/backups/2099-12-31-empty');
  const opened=[];
  api.before=async (method,path)=>{if (method==='list') opened.push(path);};
  assert.equal(await writeBackup(api,{weekly:true,now:Date.parse(recent.modified)}),null);
  assert.deepEqual(opened,['/backups','/backups','/backups/'+recent.folder]);
});

test('an overdue weekly check skips retired directories and still finds a recent marker in an older named generation',async()=>{
  const api=new BackupDropbox();
  await api.put('/watched.csv',watchCsv(2));
  const recent=await writeBackup(api,{beforeRestore:true,now:time,id:()=>'complete'});
  for(let i=0;i<60;i++) await api.createFolder('/backups/2099-01-01-retired-'+i);
  const lists=[];
  api.before=(method,path)=>{ if(method==='list') lists.push(path); };
  const fresh=Date.parse(recent.modified);
  assert.equal(await writeBackup(api,{weekly:true,now:fresh}),null);
  assert.deepEqual(lists,['/backups','/backups/2099-01-01-retired-9','/backups']);
  lists.length=0;
  let beforeReserve;
  const create=api.createFolder.bind(api);
  api.createFolder=async path=>{ beforeReserve??=lists.slice(); return create(path); };
  const next=await writeBackup(api,{weekly:true,now:fresh+7*86400000+1,id:()=>'due'});
  assert.equal(next.status,'verified');
  assert.deepEqual(beforeReserve,['/backups','/backups/2099-01-01-retired-9','/backups']);
});

test('Restore browses a retained history in two listings and keeps incomplete, legacy and damaged generations visible', async () => {
  const api = new BackupDropbox();
  for (const table of ['watched','ratings','lists','shows','settings']) {
    await api.put('/'+table+'.csv',table === 'watched' ? watchCsv(2) : writeCsv(table,[]));
  }
  const good = await writeBackup(api,{beforeRestore:true,now:time,id:()=>'good'});
  const bad = await writeBackup(api,{beforeRestore:true,now:time,id:()=>'bad'});
  await api.put('/backups/'+bad.folder+'/completion.json','{}');
  for (const folder of ['2026-09-30-partial','legacy','notes','notes/nested',...Array.from({length:9},(_,i)=>'retired-'+i)])
    await api.createFolder('/backups/'+folder);
  await api.put('/backups/2026-09-30-partial/ratings.csv',rating(3));
  await api.put('/backups/legacy/watched.csv',watchCsv(1));
  await api.put('/backups/notes/nested/ratings.csv',rating(9));
  const list = api.list.bind(api), listings = [];
  api.list = async (path,recursive) => { listings.push([path,recursive]); return list(path,recursive); };
  const statuses = async () => Object.fromEntries((await listBackups(api)).map(item=>[item.folder,item.status]));
  const expected = {[good.folder]:'verified',[bad.folder]:'unverified','2026-09-30-partial':'incomplete',legacy:'legacy'};
  assert.deepEqual(await statuses(),expected);
  assert.deepEqual(listings,[['/backups',false],['/backups',true]]);
  const missing='/backups/'+good.folder;
  listings.length=0;
  api.list=async(path,recursive)=>{
    listings.push(path);
    const rows=await list(path,recursive);
    return recursive ? rows.filter(row=>row.path!==missing && !row.path.startsWith(missing+'/')) : rows;
  };
  assert.deepEqual(await statuses(),expected);
  assert.deepEqual(listings,['/backups','/backups',missing]);
  for (const [failure,fallback] of [[new DropboxLimitError('Oversized nested files'),true],
    [new DropboxError('throttled'),false],[new DropboxError('permission'),false]]) {
    let direct=0;
    api.list=async(path,recursive)=>{
      if (recursive) throw failure;
      if (path!=='/backups') direct++;
      return list(path,recursive);
    };
    if (fallback) { assert.deepEqual(await statuses(),expected); assert.ok(direct>=4); }
    else { await assert.rejects(statuses(),error=>error===failure); assert.equal(direct,0); }
  }
});

test('canceling backup browsing stops further provider reads without interrupting a second reader', async () => {
  const api=new BackupDropbox();
  await api.put('/watched.csv',watchCsv(2));
  const copy=await writeBackup(api,{beforeRestore:true});
  for (const operation of [signal=>listBackups(api,signal),signal=>openBackup(api,copy.folder,signal)]) {
    const reader=new AbortController(),reads=[];
    api.before=(method,path)=>{
      reads.push([method,path]);
      if (method==='download') reader.abort();
    };
    await assert.rejects(operation(reader.signal),{name:'AbortError'});
    assert.deepEqual(reads.filter(([method])=>method==='download'),[['download','/backups/'+copy.folder+'/completion.json']]);
    api.before=()=>{};
    const fresh=await listBackups(api,new AbortController().signal);
    assert.deepEqual(fresh.map(g=>g.status),['verified']);
  }
});

test('a stale recursive page at the folder limit preserves an omitted backup and cannot admit a 129th generation',async()=>{
  const api=new BackupDropbox();
  await api.put('/watched.csv',watchCsv(2));
  const good=await writeBackup(api,{beforeRestore:true,now:time,id:()=>'kept'});
  const hidden='/backups/'+good.folder;
  for(let i=0;i<127;i++) await api.createFolder('/backups/legacy-'+i);
  const list=api.list.bind(api);
  api.list=async(path,recursive)=>{
    const entries=await list(path,recursive);
    return recursive ? entries.filter(r=>r.path!==hidden && !r.path.startsWith(hidden+'/')) : entries;
  };
  assert.deepEqual((await listBackups(api)).map(g=>g.folder),[good.folder]);
  for(let i=0;i<127;i++) await api.put('/backups/legacy-'+i+'/watched.csv',watchCsv(1));
  const before=api.folders.size;
  await assert.rejects(writeBackup(api,{now:time,id:()=>'refused'}),{kind:'too-large'});
  assert.equal(api.folders.size,before);
  await api.createFolder('/backups/extra');
  await api.put('/backups/extra/watched.csv',watchCsv(1));
  await assert.rejects(listBackups(api),{kind:'too-large'});
  api.list=async(path,recursive)=>{
    const entries=await list(path,recursive);
    return path==='/backups' ? entries.filter(row=>row.path!==hidden) : entries;
  };
  await assert.rejects(listBackups(api),{kind:'too-large'},'a child file alone is evidence of its backup folder');
  const requests=[];
  api.list=async(path,recursive)=>{
    requests.push(path);
    return recursive ? [] : list(path);
  };
  await assert.rejects(writeBackup(api,{now:time,id:()=>'refused'}),/listings disagree/);
  assert.deepEqual(requests,['/backups','/backups']);
});

test('The weekly boundary follows the completion time and a colliding generation name never replaces a previous backup', async () => {
  const api=new BackupDropbox();
  await api.put('/watched.csv',watchCsv(1));
  const first=await writeBackup(api,{now:time,id:()=>'unchanged',beforeRestore:true});
  const cutoff=Date.parse(first.modified)+7*86400_000;
  assert.equal(await writeBackup(api,{now:cutoff,weekly:true}),null);
  await api.put('/watched.csv',watchCsv(2));
  const collision=new Date(cutoff+1).toISOString().slice(0,10)+'-existing';
  await api.createFolder('/backups/'+collision);
  await api.put('/backups/'+collision+'/watched.csv',watchCsv(9));
  let attempts=0;
  const next=await writeBackup(api,{now:cutoff+1,weekly:true,id:()=>++attempts===1?'existing':'fresh'});
  assert.equal(attempts,2);
  for(const [folder,value] of [[first.folder,1],[collision,9],[next.folder,2]]) {
    assert.equal((await openBackup(api,folder)).get('watched'),watchCsv(value));
  }
});

test('A replaced sign-in after a restore upload leaves its acknowledgement for the owner and stops later files', async () => {
  for(const otherAccount of [false,true]){
    const api=new BackupDropbox(), store=memoryStore();
    await api.put('/watched.csv',watchCsv(1)); await api.put('/ratings.csv',rating(5));
    const original=(await store.snapshot()).local.dropboxSession;
    const next={...original,instanceId:'returning',accountId:otherAccount?'other-record':original.accountId};
    const chosen=new Map([['watched',watchCsv(2)],['ratings',rating(9)]]);
    api.after=async(method,path)=>{
      if(method==='upload' && path==='/watched.csv') {
        const state=await store.snapshot();
        await store.commit(state.revision,{local:{dropboxSession:next}});
      }
    };
    const result=await restoreBackup(api,sync(store,api),chosen,{onProgress:message=>{
      if(message.startsWith('Settling')) {chosen.clear();chosen.set('watched',watchCsv(80));}
    }});
    assert.deepEqual([...result.files.values()],['accepted-unacknowledged','untouched']);
    const saved=await store.snapshot();
    assert.equal(saved.sync.watched.pending.content,watchCsv(2));
    assert.equal(api.rows('watched')[0].times_watched,2);
    assert.equal(api.rows('ratings')[0].rating,5);
    const nextEngine = session => new DropboxSync(store,api,session,{},()=>time);
    if(otherAccount){
      const transfers=api.calls.length;
      await assert.rejects(nextEngine(next).run(),/sign-in changed/);
      assert.equal(api.calls.length,transfers);
    }
    const returning={...original,instanceId:'reopened'};
    await store.commit(saved.revision,{local:{dropboxSession:returning}});
    api.after=async()=>{};
    assert.equal((await nextEngine(returning).run()).complete,true);
    assert.equal((await store.snapshot()).sync.watched.pending,null);
    assert.equal(await count(store),2);
  }
});

test('Manifest validation checks duplicate names, format, contradicting copies and damaged contents', async () => {
  const api = new BackupDropbox();
  await api.put('/watched.csv', watchCsv(1));
  const result = await writeBackup(api, { beforeRestore: true });
  const dir = '/backups/' + result.folder, path = dir + '/completion.json';
  const marker = d.decode((await api.download(path)).bytes);
  for (const bad of [marker.replace('"version":1', '"version":2'), marker.replace('"ratings.csv":null', '"ratings.csv":null,"ratings.csv":null'),
    marker.replace('"ratings.csv"', '"unknown.csv"'), marker.replace(/"hash":"[a-f0-9]+"/, '"hash":"short"')]) {
    await api.put(path, bad);
    assert.equal((await listBackups(api))[0].status, 'unverified');
  }
  await api.put(path, marker.replace('"ratings.csv":null', '"ratings.csv":{"rev":"damaged","hash":"short"}'));
  await api.put(dir + '/ratings.csv', rating(7));
  assert.deepEqual([...(await openBackup(api, result.folder)).keys()], ['watched'],
    'A malformed ratings entry hid a separately verified watched copy');
  await api.put(path, marker);
  await api.put(dir + '/ratings.csv', rating(5));
  assert.equal((await listBackups(api))[0].status, 'unverified');
  assert.deepEqual([...(await openBackup(api, result.folder)).keys()], ['watched']);
  await api.put(dir + '/watched.csv', watchCsv(2));
  assert.deepEqual([...(await openBackup(api, result.folder)).keys()], []);
});

test('Retention uses completion time, keeps ten verified generations, and retries failed pruning on a later backup', async () => {
  const api = new BackupDropbox(), backups = [];
  for (let i = 0; i < 11; i++) backups.push(await writeBackup(api, { beforeRestore: true, now: time - i * 86400000, id: () => 'only' }));
  assert.equal((await listBackups(api))[0].folder, backups.at(-1).folder);
  await api.createFolder('/backups/abandoned');
  api.before = (method) => { if (method === 'delete') throw Error('Interrupted prune'); };
  await writeBackup(api);
  assert.equal((await listBackups(api)).filter(v => v.status === 'verified').length, 12);
  api.before = async () => {};
  await writeBackup(api);
  assert.equal((await listBackups(api)).filter(v => v.status === 'verified').length, 10);
  assert.ok(api.folders.has('/backups/abandoned'));
  assert.deepEqual(await api.list('/backups/' + backups[0].folder), []);
});

test('A second device refreshing an old completion marker during pruning protects its new retention rank', async () => {
  const api = new BackupDropbox(), folders = [];
  for (let i = 0; i < 10; i++) {
    folders.push((await writeBackup(api, {beforeRestore:true, now:time, id:()=>String(i)})).folder);
  }
  const old = '/backups/' + folders[0], marker = old + '/completion.json';
  let reads = 0;
  api.before = async (method, path) => {
    if (method === 'list' && path === old && ++reads === 2) {
      await api.put(marker, api.live.get(marker).bytes);
    }
  };
  await writeBackup(api, {now:time, id:()=>'new'});
  assert.equal((await listBackups(api))[0].folder, folders[0], 'The refreshed generation should now rank first');
  api.before = async () => {};
  await writeBackup(api, {now:time, id:()=>'later'});
  const retained = await listBackups(api);
  assert.equal(retained.length,10);
  assert.ok(retained.some(g => g.folder === folders[0]));
  assert.ok(!retained.some(g => g.folder === folders[1]));
});

test('Pruning protects an interleaved file creation, renamed folder and rewritten marker or copy at dispatch', async () => {
  for (const change of ['extra','renamed','marker','copy','interruption']) {
    const api = new BackupDropbox();
    await api.put('/watched.csv',watchCsv(1));
    await api.put('/ratings.csv',rating(2));
    const old = '/backups/' + (await writeBackup(api,{beforeRestore:true})).folder;
    for (let i=1;i<10;i++) await writeBackup(api,{beforeRestore:true});
    const deletions=[];
    api.before = async (method,path) => {
      if (method !== 'delete' || !path.startsWith(old)) return;
      deletions.push(path);
      if (deletions.length === 1 && change === 'extra') await api.put(old + '/my-notes.txt','Keep my notes');
      if (deletions.length === 1 && change === 'renamed') {
        for (const name of [...api.live.keys()]) if (name.startsWith(old + '/')) api.live.delete(name);
        await api.put(old + '/my-notes.txt','New folder at the old path');
      }
      if (deletions.length === 1 && change === 'marker') await api.put(path,api.live.get(path).bytes);
      if (path === old + '/watched.csv' && change === 'copy') await api.put(path,watchCsv(9));
      if (path === old + '/ratings.csv' && change === 'interruption') throw Error('Offline');
    };
    await writeBackup(api);
    assert.equal(deletions[0],old + '/completion.json');
    assert.equal(api.folders.has(old),true);
    if (change === 'marker') {
      assert.equal(deletions.length,1);
      assert.equal((await listBackups(api)).find(g=>old.endsWith(g.folder)).status,'verified');
    } else if (change === 'copy' || change === 'interruption') {
      const files=await openBackup(api,old.slice('/backups/'.length));
      assert.equal(files.get('ratings'),rating(2));
      if (change === 'copy') assert.equal(files.get('watched'),watchCsv(9));
    } else {
      assert.deepEqual((await api.list(old)).map(file=>file.name),['my-notes.txt']);
    }
  }
});

test('A marker change, edited copy or extra file during the final backup reads defers pruning', async () => {
  for (const changed of ['completion.json', 'watched.csv', 'personal.txt']) {
    const api = new BackupDropbox();
    await api.put('/watched.csv',watchCsv(1));
    for (let i=0; i<10; i++) await writeBackup(api,{beforeRestore:true, now:time, id:()=>String(i)});
    const old = '/backups/2026-10-01-0', target = old + '/' + changed;
    const contents = changed === 'watched.csv' ? watchCsv(3) : changed === 'personal.txt' ? 'A personal note' :
      d.decode(api.live.get(target).bytes);
    let markerReads = 0;
    api.before = async (method,path) => {
      if (method === 'download' && path === old + '/completion.json') markerReads++;
      if (markerReads === 2 && method === 'download' && path === old + '/settings.csv') await api.put(target, contents);
    };
    await writeBackup(api,{now:time,id:()=>'new'});
    assert.ok(api.folders.has(old), changed + ' was removed');
    assert.equal(d.decode(api.live.get(target).bytes), contents);
  }
});

test('A folder in a backup file slot leaves the other generations and readable files available', async () => {
  const api = new BackupDropbox();
  await api.put('/watched.csv', watchCsv(2));
  const healthy = await writeBackup(api, { beforeRestore: true, id: () => 'healthy' });
  const damaged = await writeBackup(api, { beforeRestore: true, id: () => 'damaged' });
  const dir = '/backups/' + damaged.folder;
  // An owner moved the copy out of the way and put a folder in its place.
  api.live.delete(dir + '/watched.csv');
  await api.createFolder(dir + '/watched.csv');
  await api.createFolder('/backups/partial');
  await api.createFolder('/backups/partial/completion.json');
  await api.put('/backups/partial/ratings.csv', rating(5));
  api.before = (method, path) => {
    if (method === 'download' && api.folders.has(path)) throw Error('Dropbox cannot download a directory as a file.');
  };
  const generations = await listBackups(api);
  assert.equal(generations[0].folder, healthy.folder);
  assert.equal(generations.filter(g => g.status === 'verified').length, 1);
  assert.deepEqual([...(await openBackup(api, damaged.folder)).keys()], []);
  assert.deepEqual([...(await openBackup(api, 'partial')).keys()], ['ratings']);
  assert.equal(await writeBackup(api, { weekly: true, now: Date.parse(healthy.modified) }), null);
});

test('A backup restore checks every live format and revision against its backup before its first local save', async () => {
  const chosen = new Map([['watched', watchCsv(1)], ['settings', writeCsv('settings', [])]]);
  for (const blocked of ['unknown setting', 'malformed settings header', 'changed since backup', 'read failed']) {
    const api = new BackupDropbox(), local = memoryStore();
    await edit(local, watch(5));
    await api.put('/watched.csv', watchCsv(2));
    await api.put('/settings.csv', blocked === 'unknown setting' ? 'setting,value\r\nfuture_provider,1\r\n' :
      blocked === 'malformed settings header' ? 'setting,setting\r\nomdb_key,x\r\n' : writeCsv('settings', []));
    let reads = 0;
    api.before = async (method, path) => {
      if (method === 'download' && path === '/settings.csv' && ++reads === 2) {
        if (blocked === 'changed since backup') await api.put(path, writeCsv('settings', []));
        if (blocked === 'read failed') throw Error('Provider read failed');
      }
    };
    const result = await restoreBackup(api, sync(local, api), chosen);
    assert.ok(result.issue, blocked);
    assert.equal(result.compatibility, blocked === 'unknown setting');
    assert.deepEqual([...result.files.values()], ['untouched', 'untouched']);
    assert.equal(await count(local), 5);
    assert.equal(api.rows('watched')[0].times_watched, 2);
  }
});

test('Restore retains the approved bytes, captures the remote rows in its backup and distinguishes changed later files', async () => {
  const api = new BackupDropbox(), local = memoryStore();
  await api.put('/watched.csv', watchCsv(1)); await api.put('/ratings.csv', rating(5));
  const selected = await writeBackup(api), chosen = await openBackup(api, selected.folder);
  await api.delete('/backups/' + selected.folder);
  await api.put('/watched.csv', watchCsv(3)); await api.put('/ratings.csv', rating(7));
  await edit(local, watch(8));
  let reads = 0, saves = 0;
  api.before = async (method, path) => {
    if (method === 'download' && path === '/ratings.csv' && ++reads === 3) await api.put(path, rating(9));
  };
  const result = await restoreBackup(api, sync(local, api), chosen, { onSaved: () => saves++ });
  assert.deepEqual([...result.files.values()], ['restored', 'untouched']);
  assert.equal(saves, 1);
  assert.equal(await count(local), 1);
  assert.equal(api.rows('ratings')[0].rating, 9);
  const [prior] = await listBackups(api);
  assert.equal((await openBackup(api, prior.folder)).get('watched'), watchCsv(3));
});

test('After a partial restore the local state and report distinguish conflicts, unknown delivery and failed acknowledgements', async () => {
  for (const expected of ['local-only', 'conflict-unacknowledged', 'unknown', 'accepted-unacknowledged', 'restored']) {
    const api = new BackupDropbox(), local = memoryStore();
    await api.put('/watched.csv', watchCsv(2)); await edit(local, watch(5));
    api.before = async (method, path) => {
      if (method === 'upload' && path === '/watched.csv') {
        if (expected === 'local-only' || expected === 'conflict-unacknowledged') await api.put(path, watchCsv(3));
        if (expected === 'unknown') throw Error('No reply');
      }
    };
    const original = local.commit;
    local.commit = (...args) => {
      const change = args[1].sync?.watched;
      if (change && !change.pending && expected.endsWith('unacknowledged')) throw Error('Acknowledgement write aborted');
      return original(...args);
    };
    const chosen = new Map([['watched', watchCsv(1)], ['ratings', rating(5)]]);
    const report = await restoreBackup(api, sync(local, api), chosen);
    assert.equal(report.files.get('watched'), expected);
    assert.equal(report.files.get('ratings'), expected === 'restored' ? 'restored' : 'untouched');
    assert.equal(await count(local), 1);
    const pending = (await local.snapshot()).sync.watched.pending;
    assert.equal(Boolean(pending), ['unknown', 'accepted-unacknowledged', 'conflict-unacknowledged'].includes(expected));
  }
});

test('A failure to settle every selected file or finish the prerequisite backup leaves all replacements untouched', async () => {
  for (const stage of ['settlement', 'backup']) {
    const api = new BackupDropbox(), local = memoryStore(), engine = sync(local, api);
    await edit(local, watch(7));
    await api.put('/watched.csv', watchCsv(2));
    if (stage === 'settlement') engine.settleForRestore = async () => { throw Error('The pending record needs a guard choice'); };
    else api.before = async (method, path) => { if (method === 'upload' && path.endsWith('/completion.json')) throw Error('Backup failed'); };
    const report = await restoreBackup(api, engine, new Map([['watched', watchCsv(1)]]));
    assert.equal(report.files.get('watched'), 'untouched'); assert.equal(await count(local), 7);
    assert.equal(api.rows('watched')[0].times_watched, 2);
  }
});

test('A guard restore cannot replace a newer remote revision or discard an edit made while its backup was being written', async () => {
  for (const changed of ['remote', 'local']) {
    const api = new BackupDropbox(), local = memoryStore();
    await edit(local, watch(6));
    const live = await api.put('/watched.csv', 'show_id,season,episode,times_watched\r\n7,1,1,broken\r\n');
    const selected = new Map([['watched', watchCsv(6)]]);
    const guard = { table: 'watched', revision: live.rev, content: watchCsv(6) };
    if (changed === 'remote') await api.put('/watched.csv', watchCsv(4));
    else api.before = async (method, path) => {
      if (method === 'upload' && path.endsWith('/completion.json')) await edit(local, watch(7));
    };
    const result = await restoreBackup(api, sync(local, api), selected, { guardTarget: guard });
    assert.ok(result.issue, changed);
    assert.equal(result.files.get('watched'), 'untouched');
    assert.equal(await count(local), changed === 'remote' ? 6 : 7);
    assert.equal(api.calls.filter(c => c.method === 'upload' && c.path === '/watched.csv').length, 0);
  }
});

test('Closing a restore between files leaves the later files untouched and queues no replacement to replay', async () => {
  const api = new BackupDropbox(), local = memoryStore();
  await api.put('/watched.csv', watchCsv(2)); await api.put('/ratings.csv', rating(3));
  let active = true;
  api.after = async (method, path) => { if (method === 'upload' && path === '/watched.csv') active = false; };
  const chosen = new Map([['watched', watchCsv(1)], ['ratings', rating(5)]]);
  const result = await restoreBackup(api, sync(local, api), chosen, { current: () => active });
  assert.deepEqual([...result.files.values()], ['restored', 'untouched']);
  assert.equal((await local.snapshot()).sync.ratings, undefined);
  assert.equal(api.rows('ratings')[0].rating, 3);
});

test('Leaving during the last revision lookup keeps a missing restore target untouched on this device and in Dropbox', async () => {
  const api = new BackupDropbox(), local = memoryStore();
  let active = true;
  api.before = (method, path) => { if (method === 'revisions' && path === '/watched.csv') active = false; };
  const chosen = new Map([['watched', watchCsv(5)]]);
  const result = await restoreBackup(api, sync(local, api), chosen, { current: () => active });
  assert.equal(result.files.get('watched'), 'untouched');
  assert.match(result.issue, /closed/);
  assert.equal(await count(local), 0);
  assert.equal((await local.snapshot()).sync.watched?.pending ?? null, null);
  const next = sync(local, api);
  assert.equal((await next.run()).complete, true);
  assert.equal(await api.download('/watched.csv'), null);
});

const recordFiles = (tables = emptyTables()) => ['watched', 'ratings', 'lists', 'shows'].map(t => new File([writeCsv(t, tables[t])], t + '.csv'));
test('Exact local restore accepts an empty set of four headers and rejects missing tables, duplicate rows, mismatched coverage and ambiguous IDs', async () => {
  const empty = await readLocalRecord(recordFiles());
  assert.deepEqual(empty, { watched: [], ratings: [], lists: [], shows: [] });
  const current = { revision: 7n, tables: { ...emptyTables(), watched: [watch(2)] }, local: {} };
  assert.equal(previewLocalRecord(current, empty).counts[0].removals, 1);
  assert.throws(() => previewLocalRecord({ ...current, local: { syncAccountId: 'linked' } }, empty));
  const files = recordFiles();
  const unavailable = {name:'ratings.csv', async arrayBuffer() { throw new DOMException('OS read failed', 'NotReadableError'); }};
  await assert.rejects(readLocalRecord([files[0], unavailable, ...files.slice(2)]), /could not read ratings\.csv/i);
  for (const invalid of [files.slice(0, 3), [files[0], files[0], ...files.slice(2)],
    [new File([watchCsv(1)], 'watched.csv'), ...files.slice(1)],
    [files[0], new File(['show_id,show,rating\r\n7,A,7\r\n7,A,9\r\n'], 'ratings.csv'), ...files.slice(2)],
    [files[0], new File(['show_id,rating\r\n7,7\r\n'], 'ratings.csv'), ...files.slice(2)],
    [files[0], files[1], files[2], new File(['show_id,show,year,imdb_id\r\n7,A,bad,\r\n'], 'shows.csv')],
    recordFiles({ ...emptyTables(), watched: [watch(1, 1, 40), watch(2, 2, 40)], shows: [{ show_id: 7, show: 'A', year: 2019, imdb_id: '' }] }),
  ]) await assert.rejects(readLocalRecord(invalid));
});
