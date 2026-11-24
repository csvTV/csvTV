import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {rehearsalFolder as fixture} from './dropbox-live/release-rehearsal.mjs';

const access = 'fixture-access', payload = Buffer.from('fictional-content');
const upload = (path,bytes=payload) => ({path,mode:'add',autorename:false,strict_conflict:true,
  content_hash:createHash('sha256').update(createHash('sha256').update(bytes).digest()).digest('hex')});

test('Revision pages preserve intervening writes with identical bytes and reject a cursor before file creation',async () => {
  const {folder} = fixture();
  const path = '/ratings.csv', revisions = [];
  await folder.prepare(access);
  try {
    for (const rating of [7,8,9,8,6]) {
      const bytes = Buffer.from(`tmdb_id,rating\r\n900001,${rating}\r\n`), args = upload(path,bytes);
      if (revisions.length) args.mode = {'.tag':'update',update:revisions.at(-1)};
      const reply = await folder.forward('upload',access,args,bytes);
      assert.equal(reply.status,200);
      revisions.push(JSON.parse(reply.bytes).rev);
    }
    const page = (i,limit) => folder.forward('revisions',access,{path,mode:'path',limit,before_rev:revisions[i]});
    for (const [cursor,expected,more] of [[4,[3,2,1],true],[3,[2],true],[1,[0],false]]) {
      const reply = await page(cursor,expected.length);
      assert.equal(reply.status,200);
      const body = JSON.parse(reply.bytes);
      assert.deepEqual(body.entries.map(entry => entry.rev),expected.map(i => revisions[i]));
      assert.equal(body.has_more,more);
    }
    assert.equal((await page(0,2)).status,409);
  } finally { await folder.cleanup(access); }
});

test('The live release transport requires strict folder ownership, scoped metadata and a matching second grant',async () => {
  const {folder,files,calls,deleted} = fixture();
  await assert.rejects(folder.forward('list',access,{path:'',recursive:false}), /Reserve/);
  await folder.prepare(access);
  assert.match(folder.path,/^\/csvtv-live-[0-9a-f-]{36}$/);
  const reserved = calls.length;
  for (const [endpoint,args] of [['token',{}],['list',{path:'',recursive:true}],['continue',{cursor:'unknown'}],
    ['download',{path:'/../settings.csv'}],['upload',upload('/real/settings.csv')],['delete',{path:''}]]) {
    await assert.rejects(folder.forward(endpoint,access,args,payload));
  }
  assert.equal(calls.length,reserved);
  assert.equal((await folder.forward('download',access,{path:'/csvtv-reset.json'})).status,409);
  await assert.rejects(folder.forward('upload',access,upload('/csvtv-reset.json'),payload));
  const args = upload('/settings.csv');
  const saved = JSON.parse((await folder.forward('upload',access,args,payload)).bytes);
  assert.equal(saved.path_lower,'/settings.csv');
  assert.ok(files.has(folder.path + '/settings.csv'));
  assert.deepEqual(await folder.read(access,'/settings.csv'),{bytes:payload,contentHash:args.content_hash,rev:saved.rev});
  const download = await folder.forward('download',access,{path:'/settings.csv'});
  assert.equal(JSON.parse(download.metadata).path_display,'/settings.csv');
  const second = 'second-real-grant-for-same-fictional-account';
  assert.equal((await folder.read(second,'/settings.csv')).rev,saved.rev);
  assert.ok(calls.some(call=>call.route==='get_metadata' && call.path === folder.path));
  await assert.rejects(folder.forward('upload','wrong-account',upload('/ratings.csv'),payload),/original test folder/);
  assert.equal(files.has(folder.path + '/ratings.csv'),false);
  await folder.forward('upload',access,{...args,mode:'overwrite'},Buffer.from('new content'));
  assert.deepEqual(calls.at(-1).mode,{'.tag':'update',update:saved.rev});
  await folder.cleanup(second);
  assert.deepEqual(deleted,[folder.path + '/settings.csv',folder.path]);
  assert.equal(files.size,0);
});

test('An unrecognized file or different live revision halts all test cleanup before deletion',async () => {
  const {folder,files,deleted} = fixture();
  await folder.prepare(access);
  await folder.forward('upload',access,upload('/settings.csv'),payload);
  const outside = folder.path + '/owner.csv';
  files.set(outside,{entry:{'.tag':'file',id:'id:owner',name:'owner.csv',path_lower:outside,path_display:outside,rev:'other'}});
  await assert.rejects(folder.cleanup(access),/unrecognized/);
  assert.deepEqual(deleted,[]);
  files.delete(outside);
  files.get(folder.path + '/settings.csv').entry.rev = 'edited-elsewhere';
  await assert.rejects(folder.cleanup(access),/independently changed/);
  assert.deepEqual(deleted,[]);
});

test('Only owned backup reservations and scoped recursive reads reach the release test folder',async () => {
  const {folder,calls}=fixture();
  const name='2026-11-20-58cb45f7-94ce-4738-8c45-e6d379716916';
  const marker='/csvtv-reset.json', file='/backups/'+name+'/ratings.csv';
  const state={version:1,generations:{},pending:[],backupsClearedAt:0,reservations:[name]};
  const save = (contents,mode) => {
    const bytes=Buffer.from(JSON.stringify(contents));
    return folder.forward('upload',access,{...upload(marker,bytes),mode},bytes);
  };
  await folder.prepare(access);
  await assert.rejects(save(state,'add'),/Only backup reservations/);
  for (const path of ['/backups','/backups/'+name]) await folder.forward('create',access,{path,autorename:false});
  const reservation=JSON.parse((await save(state,'add')).bytes);
  await folder.forward('upload',access,upload(file),payload);
  const listed=JSON.parse((await folder.forward('list',access,{path:'/backups',recursive:true})).bytes);
  assert.ok(listed.entries.some(entry=>entry.path_lower==='/backups' && entry['.tag']==='folder'));
  assert.ok(listed.entries.some(entry=>entry.path_lower===file));
  const writeCount=calls.length;
  await assert.rejects(save({...state,pending:['backups']},{'.tag':'update',update:reservation.rev}),/Only backup reservations/);
  assert.equal(calls.length,writeCount);
  assert.equal((await save({...state,reservations:[]},{'.tag':'update',update:reservation.rev})).status,200);
  await folder.cleanup(access);
});

test('The release can publish its derived summary only at the fictional record root',async () => {
  const {folder,calls} = fixture();
  await folder.prepare(access);
  const args = {...upload('/summary.csv'), mode:'overwrite'};
  assert.equal((await folder.forward('upload',access,args,payload)).status,200);
  assert.equal(calls.at(-1).mode,'add');
  assert.deepEqual((await folder.read(access,'/summary.csv')).bytes,payload);
  const before = calls.length;
  const nested = '/backups/2026-01-12-52df7d12-8f22-4c07-867d-e28e86234868/summary.csv';
  await assert.rejects(folder.forward('upload',access,{...args,path:nested},payload),/Only csvTV test files/);
  assert.equal(calls.length,before);
  await folder.cleanup(access);
});

test('A real clear rehearsal requires explicit opt-in, valid reset scopes and exclusively owned write destinations',async () => {
  const id='58cb45f7-94ce-4738-8c45-e6d379716916';
  const state={version:2,generations:{ratings:id},ancestry:{ratings:[null]},pending:['ratings'],backupsClearedAt:0};
  const marker='/csvtv-reset.json';
  const send = (folder,body,mode='add')=>{
    const bytes=Buffer.from(JSON.stringify(body));
    return folder.forward('upload',access,{...upload(marker,bytes),mode},bytes);
  };
  for (const allowClear of [false,true]) {
    const {folder,calls,files}=fixture({allowClear});
    await folder.prepare(access);
    const previous=calls.length;
    if (allowClear) {
      for (const change of [{pending:['unknown']},{reservations:['unowned']},{ancestry:{}},{extra:'other'},{claim:'invalid'},{claim:id,pending:[]}])
        await assert.rejects(send(folder,{...state,...change}));
      await assert.rejects(send(folder,state,'overwrite'));
      assert.equal(calls.length,previous);
      const saved = JSON.parse((await send(folder,state)).bytes);
      const retry = JSON.parse((await send(folder,{...state,claim:id},{'.tag':'update',update:saved.rev})).bytes);
      assert.equal((await send(folder,{...state,pending:[]},{'.tag':'update',update:retry.rev})).status,200);
      assert.ok(files.has(folder.path+marker));
    } else {
      await assert.rejects(send(folder,state));
      assert.equal(calls.length,previous);
    }
    await folder.cleanup(access);
    assert.equal(files.size,0);
  }
});
