import test from 'node:test';
import assert from 'node:assert/strict';
import { DropboxProviderSettings } from '../dist/dropbox-provider-settings.js';
import { DropboxSync } from '../dist/dropbox-sync.js';
import { writeCsv } from '../dist/csv.js';
import { credentials, FictionalDropbox, memoryStore, time, watch } from './dropbox-sync-fixture-cases.mjs';

const path = '/settings.csv';
const row = (setting, value) => ({setting, value});
const csv = (...rows) => writeCsv('settings', rows);
const key = row('omdb_key', 'fictional-old-key');
const rotated = row('omdb_key', 'fictional-rotated-key');
const other = row('github_token', 'fictional-private-token');
const choice = row('github_repo', 'fictional/shows');
const source = row('imdb_source', 'github');
const current = () => true;
const unexpected = async () => assert.fail('Unexpected migration decision');

function credentialDevice(legacy, api, decide = unexpected) {
  const store = Object.assign(memoryStore(), {
    legacyProviderSettings:async () => structuredClone(legacy),
    finishProviderMigration:async (revision, state) => {
      assert.equal(revision, legacy.revision);
      Object.assign(legacy, {migrated:true, sync:state, rows:legacy.rows.filter(r=>r.setting==='github_repo')});
    },
    loadProviderKeys:async (_session,rows) => { store.memory = rows; },
  });
  return {store, keys:new DropboxProviderSettings(store,api,credentials,()=>time,current,decide)};
}
const synced = {base:null, pending:null, lastClientModified:null};

test('Saving a credential uses one read and a verified conditional upload; a missing receipt requires a new read', async () => {
  const api = new FictionalDropbox();
  const keys = new DropboxProviderSettings(memoryStore(),api,credentials,()=>time,current,unexpected);
  await api.put(path,csv(choice));
  await keys.save(other.setting,null,other.value,current);
  assert.deepEqual(api.calls.map(call=>call.method),['download','upload']);
  assert.equal(api.calls[1].options.mode,'update');
  api.calls.length = 0;
  api.after = async () => { throw Error('Lost reply'); };
  await keys.save(other.setting,other.value,null,current);
  assert.deepEqual(api.calls.map(call=>call.method),['download','upload','download']);
  assert.deepEqual(api.rows('settings'),[choice]);
});

test('Dropbox key saves pin the displayed value, preserve concurrent edits, confirm lost replies and honor a closed form', async () => {
  const api = new FictionalDropbox();
  const keys = new DropboxProviderSettings(memoryStore(),api,credentials,()=>time,current,unexpected);
  await api.put(path,csv(choice,key));
  let raced = false;
  api.before = async (method,p) => {
    if (!raced && method==='upload' && p===path) {
      raced = true;
      await api.put(path,csv(choice,key,other));
    }
  };
  api.after = async () => { throw Error('Lost acknowledgement'); };
  await keys.save(key.setting,key.value,rotated.value,current);
  assert.deepEqual(api.rows('settings'),[choice,other,rotated]);
  await assert.rejects(keys.save(key.setting,key.value,null,current),/changed in Dropbox/);
  await assert.rejects(keys.save(key.setting,rotated.value,null,()=>false));
  assert.ok(api.rows('settings').some(r=>r.value===rotated.value));
  await keys.save(key.setting,rotated.value,null,current);
  assert.deepEqual(api.rows('settings'),[choice,other]);
});

test('An unrelated simultaneous change survives readback after a lost token upload reply', async () => {
  const api = new FictionalDropbox();
  const keys = new DropboxProviderSettings(memoryStore(),api,credentials,()=>time,current,unexpected);
  await api.put(path,csv(choice,key));
  api.after = async () => {
    await api.put(path,csv(choice,other,rotated));
    throw Error('Lost reply');
  };
  const confirmed = await keys.save(other.setting,null,other.value,current);
  assert.deepEqual(confirmed,api.rows('settings'));
  assert.deepEqual(confirmed,[choice,other,rotated]);
  assert.equal(api.calls.filter(call=>call.method === 'upload').length,1);
});

test('A sync receipt contains only preferences and proves a lost acknowledgement after a later key rotation', async () => {
  const api = new FictionalDropbox(), device = memoryStore();
  const sync = () => new DropboxSync(device,api,credentials,{},()=>time, async () => {});
  await api.put(path,csv(choice,key,other));
  assert.equal((await sync().run()).complete,true);
  let state = await device.snapshot();
  assert.deepEqual(state.tables.settings,[choice]);
  assert.equal(state.sync.settings.base.content,csv(choice));
  await device.commit(state.revision,{replace:{settings:[choice,source]}});
  api.after = async (method,p) => { if (method==='upload' && p===path) throw Error('Lost acknowledgement'); };
  await assert.rejects(sync().run(),/unknown outcome/);
  state = await device.snapshot();
  const receipt = state.sync.settings.pending;
  assert.equal(receipt.settingsContentHash,await device.providerContentTag(api.live.get(path).metadata.contentHash));
  assert.notEqual(receipt.settingsContentHash,api.live.get(path).metadata.contentHash);
  assert.equal(receipt.content,csv(choice,source));
  assert.equal(receipt.targetContent,csv(choice));
  assert.doesNotMatch(JSON.stringify(state.sync),/fictional-old-key|fictional-private-token/);
  api.after = async () => {};
  await api.put(path,csv(choice,source,other,rotated));
  assert.equal((await sync().run()).complete,true);
  state = await device.snapshot();
  assert.equal(state.sync.settings.pending,null);
  assert.equal(state.sync.settings.base.content,csv(choice,source));
  assert.equal(api.rows('settings').find(r=>r.setting===key.setting).value,rotated.value);
});

test('Unusable settings leave an independent watch edit syncable', async () => {
  const api = new FictionalDropbox(), device = memoryStore();
  await device.commit((await device.snapshot()).revision,{replace:{watched:[watch(2)]}});
  const sync = new DropboxSync(device,api,credentials,{},()=>time,async () => {throw Error('Repair settings.csv');});
  const result = await sync.run();
  assert.equal(result.complete,false);
  assert.match(result.reason,/Repair settings/);
  assert.ok(api.rows('watched').length);
  assert.ok(!api.calls.some(c=>c.method==='upload' && c.path===path));
});

test('a matching keyed receipt after an intervening settings revision preserves the peer preference without retaining credentials',async()=>{
  const api=new FictionalDropbox(),device=memoryStore();
  const run=()=>new DropboxSync(device,api,credentials,{guard:assert.fail},()=>time,async()=>{}).run();
  await api.put(path,csv(choice,key)); await run();
  const replace=async rows=>device.commit((await device.snapshot()).revision,{replace:{settings:rows}});
  await replace([choice,source]);
  api.before=async(method,file)=>{if(method==='upload' && file===path)throw Error('Fictional missing receipt');};
  await assert.rejects(run(),/unknown outcome/); api.before=async()=>{};
  const {pending}=(await device.snapshot()).sync.settings;
  await replace([choice]);
  await api.put(path,csv(choice,rotated));
  const peer=await api.put(path,csv(choice,source,key),pending.clientModified);
  assert.equal(await device.providerContentTag(peer.contentHash),pending.settingsContentHash);
  assert.equal((await run()).complete,true);
  assert.equal(api.live.get(path).metadata.rev,peer.rev);
  assert.deepEqual((await device.snapshot()).tables.settings,[choice,source]);
  assert.doesNotMatch(JSON.stringify((await device.snapshot()).sync),/fictional-old-key|fictional-private-token/);
});

test('Upgrade migrates only a local difference; a missing or changed cloud key survives a stale local copy', async () => {
  const api = new FictionalDropbox();
  const orig = await api.put(path,csv(choice,key,other));
  await api.put(path,csv(choice,rotated));
  const local = row('tmdb_key','fictional-unsynced-value');
  const legacy = {revision:1n,rows:[choice,key,other,local],migrated:false,
    sync:{...synced,base:{revision:orig.rev,content:csv(choice,key,other)}}};
  const {keys,store} = credentialDevice(legacy,api);
  await keys.load();
  assert.equal(legacy.migrated,true);
  assert.deepEqual(legacy.rows,[choice]);
  assert.equal(legacy.sync.base.content,csv(choice));
  assert.deepEqual(store.memory,api.rows('settings'));
  assert.deepEqual(api.rows('settings'),[choice,rotated,local]);
});

test('Migration never purges unconfirmed keys, prompts on divergent values, and retries with the original data', async () => {
  const api = new FictionalDropbox();
  await api.put(path,csv(choice,rotated));
  const legacy = {revision:1n,rows:[key],migrated:false,sync:synced};
  let answer = 'cancel';
  const {keys,store} = credentialDevice(legacy,api,async names => {assert.deepEqual(names,['omdb_key']); return answer;});
  await assert.rejects(keys.load(),/paused/);
  answer = 'device';
  api.before = async (method,p) => { if (method==='upload' && p===path) throw Error('Cloud unreachable'); };
  await assert.rejects(keys.load(),/unreachable/);
  assert.deepEqual(legacy.rows,[key]);
  assert.equal(legacy.migrated,false);
  assert.equal(store.memory,undefined);
  assert.deepEqual(api.rows('settings'),[choice,rotated]);
  api.before = async () => {};
  await keys.load();
  assert.deepEqual(api.rows('settings'),[choice,key]);
  assert.equal(legacy.migrated,true);
});

test('An outstanding legacy settings upload is reconciled before purging its key-bearing receipt', async () => {
  const api = new FictionalDropbox();
  const target = await api.put(path,csv(choice,key));
  const clientModified = new Date(time).toISOString().replace('.000Z','Z');
  const receipt = {targetRevision:target.rev,targetModified:target.serverModified,targetContent:csv(choice,key),
    content:csv(choice,rotated),preparedAt:time,clientModified};
  await api.put(path,receipt.content,clientModified);
  await api.put(path,csv(choice,rotated,other));
  const legacy = {revision:1n,rows:[choice,rotated],migrated:false,
    sync:{pending:receipt,base:{revision:target.rev,content:csv(choice,key)},lastClientModified:clientModified}};
  const {keys} = credentialDevice(legacy,api);
  await keys.load();
  assert.equal(legacy.migrated,true);
  assert.equal(legacy.sync.pending,null);
  assert.equal(legacy.sync.base.content,csv(choice));
  assert.ok(!JSON.stringify(legacy.sync).includes(rotated.value));
  assert.deepEqual(api.rows('settings'),[choice,other,rotated]);
});

test('an indistinguishable old credential change asks only about the differing key and preserves an unrelated cloud key',async()=>{
  for(const answer of ['device','dropbox','cancel']) {
    const api=new FictionalDropbox(),target=await api.put(path,csv(choice,key)),stamp=new Date(time).toISOString();
    const receipt={targetRevision:target.rev,targetModified:target.serverModified,targetContent:csv(choice,key),
      content:csv(choice,rotated),preparedAt:time,clientModified:stamp};
    await api.put(path,receipt.content,stamp);
    await api.put(path,csv(choice,rotated,other));
    const legacy={revision:1n,rows:[choice,key],migrated:false,
      sync:{pending:receipt,base:{revision:target.rev,content:csv(choice,key)},lastClientModified:stamp}};
    const {keys}=credentialDevice(legacy,api,(names,uncertain)=>{
      assert.deepEqual(names,['omdb_key']);assert.equal(uncertain,true);
      return answer;
    });
    if(answer==='cancel') {
      await assert.rejects(keys.load(),/migration paused/);assert.equal(legacy.migrated,false);
      assert.deepEqual(legacy.sync.pending,receipt);
    } else {
      await keys.load();assert.ok(legacy.migrated);assert.equal(legacy.sync.pending,null);
      assert.doesNotMatch(JSON.stringify(legacy.sync),/fictional-(?:old-key|rotated-key|private-token)/);
    }
    const rows=api.rows('settings');
    assert.ok(rows.some(r=>r.setting===other.setting&&r.value===other.value));
    assert.equal(rows.find(r=>r.setting==='omdb_key').value,answer==='device'?key.value:rotated.value);
  }
});

test('Resolving an uncertain legacy key does not acknowledge an unrelated pending preference change', async () => {
  const api = new FictionalDropbox();
  await api.put(path,csv(choice,rotated));
  const legacy = {revision:1n,rows:[choice,source,key],migrated:false,
    sync:{...synced,pending:{content:csv(choice,source,key),targetContent:csv(choice,key),
      targetRevision:'unprovable',targetModified:null,preparedAt:time,clientModified:'damaged'}}};
  const {keys} = credentialDevice(legacy,api,async (names,uncertain) => {
    assert.equal(uncertain,true);
    assert.deepEqual(names,['omdb_key']);
    return 'dropbox';
  });
  await keys.load();
  assert.equal(legacy.sync.pending.content,csv(choice,source));
  assert.equal(legacy.sync.pending.targetContent,csv(choice));
  assert.deepEqual(api.rows('settings'),[choice,rotated]);
});

test('an aged-out key-only upload preserves offline preference deletions and another device’s newly added key',async()=>{
  for (const localKey of [rotated,key]) {
    const api = new FictionalDropbox(), ago = time - 31 * 86_400_000, stamp = new Date(ago).toISOString();
    const previous = await api.put(path,csv(choice,source,key));
    previous.serverModified = new Date(ago-1000).toISOString();
    const receipt = {targetRevision:previous.rev,targetModified:previous.serverModified,targetContent:csv(choice,source,key),
      content:csv(choice,source,rotated),clientModified:stamp,preparedAt:ago};
    const accepted = await api.put(path,receipt.content,stamp);
    accepted.serverModified = stamp;
    await api.put(path,csv(choice,source,rotated,other));
    api.history.set(path,[api.live.get(path)]);
    const legacy = {revision:1n,migrated:false,rows:[choice,localKey],sync:{
      base:{revision:previous.rev,content:receipt.targetContent},pending:receipt,lastClientModified:stamp}};
    let answer = 'cancel';
    const questions = [];
    const {store,keys} = credentialDevice(legacy,api,async names=>{questions.push(names);return answer;});
    if (localKey === key) {
      await assert.rejects(keys.load(),/migration paused/);
      assert.deepEqual(legacy.sync.pending,receipt);
      answer = 'device';
    }
    await keys.load();
    assert.deepEqual(questions,localKey === key ? [['omdb_key'],['omdb_key']] : []);
    assert.deepEqual(legacy.sync.base,{revision:previous.rev,content:csv(choice,source)});
    assert.equal(legacy.sync.pending,null);
    assert.doesNotMatch(JSON.stringify(legacy.sync),/fictional-(?:old-key|rotated-key|private-token)/);
    await store.commit(1n,{replace:{settings:[choice]},sync:{settings:legacy.sync}});
    const run = device=>new DropboxSync(device,api,credentials,{},()=>time,async()=>{}).run();
    assert.equal((await run(store)).complete,true);
    assert.deepEqual(api.rows('settings'),[choice,other,localKey]);
    const fresh = memoryStore();
    assert.equal((await run(fresh)).complete,true);
    assert.deepEqual((await fresh.snapshot()).tables.settings,[choice]);
  }
});

test('missing historical preference evidence still enters the ordinary guard after matching keys migrate',async()=>{
  const api = new FictionalDropbox(), ago = time - 31 * 86_400_000, stamp = new Date(ago).toISOString();
  const previous = await api.put(path,csv(choice,key)); previous.serverModified = new Date(ago-1000).toISOString();
  const receipt = {targetRevision:previous.rev,targetModified:previous.serverModified,targetContent:csv(choice,key),
    content:csv(choice,source,rotated),clientModified:stamp,preparedAt:ago};
  const accepted = await api.put(path,receipt.content,stamp); accepted.serverModified = stamp;
  api.history.set(path,[api.live.get(path)]);
  const legacy = {revision:1n,migrated:false,rows:[choice,rotated],sync:{
    base:{revision:previous.rev,content:receipt.targetContent},pending:receipt,lastClientModified:stamp}};
  const {store,keys} = credentialDevice(legacy,api);
  await keys.load();
  assert.equal(legacy.sync.base,null);
  assert.equal(legacy.sync.pending.content,csv(choice,source));
  assert.doesNotMatch(JSON.stringify(legacy.sync),/fictional-(?:old-key|rotated-key)/);
  await store.commit(1n,{replace:{settings:[choice]},sync:{settings:legacy.sync}});
  const questions = [];
  const run = await new DropboxSync(store,api,credentials,{guard:async q=>{
    questions.push([q.table,q.decision.reason]);return 'cancel';
  }},()=>time,async()=>{}).run();
  assert.equal(run.complete,false);
  assert.deepEqual(questions,[['settings','unknown-outcome']]);
  assert.equal((await store.snapshot()).sync.settings.pending.content,csv(choice,source));
  assert.deepEqual(api.rows('settings'),[choice,source,rotated]);
});
