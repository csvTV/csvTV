import assert from 'node:assert/strict';
import test from 'node:test';
import { writeCsv } from '../dist/csv.js';
import { DropboxProviderSettings, DropboxSettingsFiles } from '../dist/dropbox-provider-settings.js';
import { adoptReset, resetMarker } from '../dist/dropbox-reset.js';
import { DropboxSync } from '../dist/dropbox-sync.js';
import { SyncFiles } from '../dist/dropbox-sync-file.js';
import { FictionalDropbox, credentials, memoryStore, time } from './dropbox-sync-fixture-cases.mjs';

const theme = value => ({setting:'appearance',value});
const recent = value => ({setting:'recently_marked.7',value});
const secret = {setting:'tmdb_key',value:'fictional-provider-token'};
const path = '/settings.csv', now = () => time;
const csv = rows => writeCsv('settings',rows);
const engine = (api,store,hooks={}) => new DropboxSync(store,api,credentials,hooks,now,async()=>{});
const commit = async (store,changes) => store.commit((await store.snapshot()).revision,changes);
async function clear(api,store,scope,remoteRows) {
  await api.put(path,csv(remoteRows));
  await api.put('/csvtv-reset.json',JSON.stringify({version:1,pending:[],generations:{[scope]:'new-generation'},backupsClearedAt:0}));
  return adoptReset(api,store,await resetMarker(api),credentials,now);
}
async function fixture(rows,cloudRows=rows) {
  const api = new FictionalDropbox(), store = memoryStore();
  store.clearProviderKeys = () => {};
  const base = await api.put(path,csv(cloudRows));
  await commit(store,{replace:{settings:rows},sync:{settings:{base:{revision:base.rev,content:csv(rows)},pending:null,lastClientModified:null}}});
  const settings = new DropboxSettingsFiles(api,hash=>store.providerContentTag(hash));
  const files = new SyncFiles(store,settings,credentials,now);
  async function prepare(next,accepted) {
    await commit(store,{replace:{settings:next}});
    const pending = await files.prepare('settings',await store.snapshot(),csv(next),base,csv(rows));
    assert.ok(pending);
    if (accepted) await settings.upload(path,pending.content,{mode:'update',revision:base.rev,clientModified:pending.clientModified});
    return pending;
  }
  return {api,store,prepare};
}

for (const accepted of [true,false]) test('watched clear retains a later preference edit when Dropbox '+
  (accepted ? 'accepted' : 'never received')+' the prior settings save',async()=>{
  const mark = recent('5/5'), dark = theme('dark'), light = theme('light');
  const {api,store,prepare} = await fixture([dark,mark],[dark,mark,secret]);
  const saved = await prepare([light,mark],accepted);
  // In the accepted case this returns the theme to its original value after the lost success reply.
  const latest = accepted ? dark : light;
  await commit(store,{replace:{settings:[latest,mark]}});
  await clear(api,store,'watched',[accepted ? light : dark,secret]);
  const after = await store.snapshot(), state = after.sync.settings;
  assert.deepEqual(after.tables.settings,[latest]);
  assert.equal(state.pending.settingsContentHash,saved.settingsContentHash);
  assert.ok(state.pending.inspectOnly);
  for (const text of [state.base.content,state.pending.content,state.pending.targetContent])
    assert.ok(!text.includes(mark.setting) && !text.includes(secret.value));
  const start = api.calls.length;
  const result = await engine(api,store).run();
  assert.ok(result.complete,result.reason);
  assert.deepEqual(api.rows('settings'),[latest,secret]);
  assert.equal((await store.snapshot()).sync.settings.pending,null);
  const writes = api.calls.slice(start).filter(call=>call.path===path && call.method==='upload');
  assert.equal(writes.length,1);
  assert.ok(!writes[0].content.includes(mark.setting));
  const fresh = memoryStore();
  assert.ok((await engine(api,fresh).run()).complete);
  assert.deepEqual((await fresh.snapshot()).tables.settings,[latest]);
});

test('choosing a copy after an unfamiliar settings clear also merges recent marks independently and carries live provider keys',async()=>{
  for (const choice of ['device','dropbox']) {
    const original = recent('5/5'), latest = recent('9/9'), dark = theme('dark'), light = theme('light');
    const {api,store} = await fixture([dark,original],[dark,original,secret]);
    await commit(store,{replace:{settings:[light,latest]}});
    await api.put(path,csv([original,secret]));
    await api.put('/csvtv-reset.json',JSON.stringify({version:1,pending:[],generations:{settings:'foreign'},backupsClearedAt:0}));
    await adoptReset(api,store,await resetMarker(api),credentials,now,undefined,async scopes=>{
      assert.deepEqual(scopes,['settings']); return choice;
    });
    const result = await engine(api,store).run(); assert.ok(result.complete,result.reason);
    assert.deepEqual(new Set(api.rows('settings').map(row=>row.setting+'='+row.value)),
      new Set((choice==='device' ? [light,latest,secret] : [latest,secret]).map(row=>row.setting+'='+row.value)));
  }
});

test('clearing settings retains a later recent mark and never re-uploads the cleared keys or preferences',async()=>{
  const old = recent('5/5'), sent = recent('8/0'), local = recent('9/9'), dark = theme('dark');
  const {api,store,prepare} = await fixture([old,dark],[old,dark,secret]);
  await prepare([sent,dark],true);
  await commit(store,{replace:{settings:[local,dark]}});
  await clear(api,store,'settings',[sent]);
  const start = api.calls.length;
  assert.ok((await engine(api,store).run()).complete);
  assert.deepEqual(api.rows('settings'),[local]);
  const writes = api.calls.slice(start).filter(call=>call.path===path && call.method==='upload');
  assert.equal(writes.length,1);
  assert.ok(!writes[0].content.includes(secret.value) && !writes[0].content.includes(dark.setting));
});

test('missing upload history after a selective clear keeps the ordinary guard and cancellation across reopening',async()=>{
  const mark = recent('5/5'), dark = theme('dark'), light = theme('light');
  const {api,store,prepare} = await fixture([dark,mark],[dark,mark,secret]);
  await prepare([light,mark],true);
  await commit(store,{replace:{settings:[dark,mark]},local:{'dropboxCanceled:settings':true}});
  await clear(api,store,'watched',[light,secret]);
  api.history.set(path,[api.live.get(path)]);
  const start = api.calls.length, questions = [];
  const hooks = {guard:async ({table,decision})=>{questions.push([table,decision.reason]);return 'cancel';}};
  assert.equal((await engine(api,store,hooks).run()).complete,false);
  assert.deepEqual(questions,[]);
  assert.equal((await engine(api,store,hooks).run({retryCanceled:true})).complete,false);
  assert.deepEqual(questions,[['settings','unknown-outcome']]);
  assert.ok((await store.snapshot()).sync.settings.pending.inspectOnly);
  assert.deepEqual((await store.snapshot()).tables.settings,[dark]);
  assert.equal(api.calls.slice(start).some(c=>c.path===path && c.method==='upload'),false);
  assert.equal((await engine(api,store,{guard:async()=> 'take-remote'}).run({retryCanceled:true})).complete,true);
  assert.deepEqual((await store.snapshot()).tables.settings,[light]);
  assert.equal((await store.snapshot()).sync.settings.pending,null);
});

test('a watched clear does not silently accept an unrelated removal of every preference',async()=>{
  const dark = theme('dark'), mark = recent('5/5'), {api,store} = await fixture([dark,mark]);
  await clear(api,store,'watched',[]);
  const questions = [];
  assert.equal((await engine(api,store,{guard:async ({table,decision})=>{
    questions.push([table,decision.reason]); return 'cancel';
  }}).run()).complete,false);
  assert.deepEqual(questions,[['settings','all-local-rows-removed']]);
  assert.deepEqual((await store.snapshot()).tables.settings,[dark]);
  assert.deepEqual(api.rows('settings'),[]);
});

test('migration after a watched clear inspects the old key-bearing upload without replaying it',async()=>{
  const api = new FictionalDropbox(), store = memoryStore();
  const mark = recent('5/5'), dark = theme('dark'), light = theme('light');
  const original = csv([mark,dark,secret]), prior = await api.put(path,original);
  const clientModified = new Date(time).toISOString(), submitted = csv([mark,light,secret]);
  const seen = await api.put(path,submitted,clientModified);
  await api.put(path,csv([light,secret]));
  const state = {base:{revision:prior.rev,content:original},lastClientModified:clientModified,pending:{
    content:submitted,targetContent:original,preparedAt:time,clientModified,
    targetRevision:prior.rev,targetModified:prior.serverModified}};
  const legacy = {revision:1n,sync:state,migrated:false,rows:[dark,mark,secret]};
  Object.assign(store,{
    legacyProviderSettings:async()=>legacy,
    finishProviderMigration:async (_rev,clean)=>{legacy.migrated=true;legacy.sync=clean;},
    loadProviderKeys:async()=>{},
  });
  const provider = new DropboxProviderSettings(store,api,credentials,now,()=>true,()=>assert.fail('Unexpected migration choice'));
  await provider.load(true);
  assert.ok(legacy.migrated);
  assert.equal(legacy.sync.base.revision,prior.rev);
  assert.equal(legacy.sync.pending.inspectOnly,true);
  assert.equal(legacy.sync.pending.settingsContentHash,await store.providerContentTag(seen.contentHash));
  assert.ok(!JSON.stringify(legacy.sync).includes(secret.value));
  assert.equal(api.calls.some(call=>call.method==='upload'),false);
  assert.deepEqual(api.rows('settings'),[light,secret]);
  await store.commit((await store.snapshot()).revision,{replace:{settings:[dark]},sync:{settings:legacy.sync}});
  let choices=0;
  const engine=new DropboxSync(store,api,credentials,{valueDelivery:async q=>{
    choices++;
    assert.deepEqual(q.rows,[{label:'appearance',shared:'Use this device’s value',independent:'Use Dropbox’s value'}]);
    return 'independent';
  }},now,async()=>{});
  assert.equal((await engine.run()).complete,true);
  assert.equal(choices,1); assert.equal((await store.snapshot()).sync.settings.pending,null);
  assert.deepEqual((await store.snapshot()).tables.settings,[light]);
  assert.deepEqual(api.rows('settings'),[light,secret]);
});
