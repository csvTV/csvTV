import test from 'node:test';
import assert from 'node:assert/strict';
import { cloudFiles, publishDerived, recordReadme } from '../dist/dropbox-derived.js';
import { FictionalDropbox, watch, memoryStore, credentials, time } from './dropbox-sync-fixture-cases.mjs';
import { tmdbResourceKey } from '../dist/tmdb-client.js';
import { writeCsv } from '../dist/csv.js';
import { DropboxSync } from '../dist/dropbox-sync.js';
import { emptyTables } from '../dist/model.js';

const seasonKey = tmdbResourceKey({kind:'season',id:7,season:1});
const day = Date.UTC(2026,9,2,1);
test('a rejected shared show index preserves the last summary, Dropbox revision and local index',async()=>{
  const store=memoryStore(), cloud=new FictionalDropbox();
  const oldSummary=await cloud.put('/summary.csv','last complete summary');
  const oversized=await cloud.put('/shows.csv',','.repeat(128));
  const local=await store.snapshot();
  await assert.rejects(publishDerived(store,cloud,await cloud.list(''),credentials,time),{kind:'too-large'});
  assert.equal((await store.snapshot()).revision,local.revision);
  assert.equal((await cloud.download('/summary.csv')).metadata.rev,oldSummary.rev);
  assert.equal((await cloud.download('/shows.csv')).metadata.rev,oversized.rev);
  assert.deepEqual(cloud.calls.filter(call=>call.method==='upload'),[]);
});
function source() {
  return { revision:0n,tables:{...emptyTables(), watched:[watch(2)]},
    showMetadata:new Map([[7,{show_id:7,show:'Relay',firstAirDate:'2019-10-02',seasons:[{season:1,episodeCount:2}]}]]),
    seasons:new Map([[seasonKey,{episodes:[{episode:1,airDate:'2026-10-01'},{episode:2,airDate:'2026-10-02'}]}]]),
    missingShowIds:new Set(),externalIds:new Map() };
}
test('A cloud summary uses one UTC day and waits for every required record, including list-only shows',async () => {
  const s=source();
  assert.match(await cloudFiles(s,[],day).summary.text(), /Relay,2019,1,1,0,,/);
  assert.match(await cloudFiles(s,[],day-86400000).summary.text(), /Relay,2019,1,1,2,,/);
  s.tables.lists.push({show_id:10,show:'Unreturned',list:'Watchlist'});
  assert.equal(cloudFiles(s,[],day).summary,null);
  const previousIndex = [{show_id:10,show:'Unreturned',year:2024,imdb_id:''}];
  const restored = await cloudFiles(s,previousIndex,day).summary.text();
  assert.match(restored,/Unreturned,2024,,,,,Watchlist/);
  assert.match(restored,/Relay,2019,1,1,0,,/);
  s.tables.watched.push({...watch(1),show_id:10});
  assert.equal(cloudFiles(s,previousIndex,day).summary,null,'Watched seasons still require their show data');
  s.tables.watched.pop();
  s.missingShowIds.add(10);
  assert.match(await cloudFiles(s,[],day).summary.text(),/Unreturned,,,,,,Watchlist/);
  s.seasons.clear(); assert.equal(cloudFiles(s,[],day).summary,null);
  s.seasons.set(seasonKey,null);
  assert.match(await cloudFiles(s,[],day).summary.text(),/Relay,2019,1,1,,,/);
});

test('Remote show fields survive a second device, and the synced reader guide explains privacy, text import and list escaping',() => {
  const s=source();
  s.tables.shows=[{show_id:7,show:'Old',year:null,imdb_id:'tt100'},{show_id:89,show:'Unused',year:null,imdb_id:'tt77'}];
  s.showMetadata.clear();
  assert.deepEqual(cloudFiles(s,[{show_id:7,show:'Remote',year:2017,imdb_id:''}],day).index,
    [{show_id:7,show:'Remote',year:2017,imdb_id:'tt100'}]);
  for (const term of ['settings.csv','as text','formula','UTC','Watchlist\\; Drama','backups/']) assert.ok(recordReadme.includes(term));
});

test('A cloud summary includes watches from a season the retained show no longer lists',async () => {
  const s = source();
  s.tables.watched.push({...watch(1),season:2});
  const file = cloudFiles(s,[],day).summary;
  assert.ok(file,'A retired season cannot be fetched by the detail job');
  assert.match(await file.text(),/Relay,2019,2,1,,,\r\n/);
  s.seasons.clear();
  assert.equal(cloudFiles(s,[],day).summary,null,'An unfetched season still listed by the show must delay publication');
});

test('Publication preserves a previous shared summary while the cache fills and skips unchanged derived uploads',async () => {
  const cloud = new FictionalDropbox(), store=memoryStore(), s=source();
  const current={...credentials,signInDeadline:Date.now()+86400000};
  await store.commit(1n,{replace:{watched:s.tables.watched},local:{dropboxSession:current},sync:{
    watched:{base:{content:writeCsv('watched',s.tables.watched),revision:'a'},pending:null,lastClientModified:null},
  }});
  store.exportSnapshot=async()=>{const local=await store.snapshot(); return {...s,tables:local.tables,revision:local.revision};};
  s.seasons.clear();
  await cloud.put('/summary.csv','old summary'); await cloud.put('/shows.csv','show_id,show,year,imdb_id\r\n7,Remote,,tt100\r\n');
  // A listing can omit the hash. Fetch the authoritative file to preserve its hand-entered external ID.
  const listing = (await cloud.list('')).map(item => item.name === 'shows.csv' ? {...item,contentHash:null} : item);
  await publishDerived(store,cloud,listing,current,time);
  assert.equal(new TextDecoder().decode((await cloud.download('/summary.csv')).bytes),'old summary');
  assert.equal(cloud.rows('shows')[0].imdb_id,'tt100');
  s.seasons.set(seasonKey,null);
  await publishDerived(store,cloud,await cloud.list(''),current,time);
  const count = cloud.calls.filter(c=>c.method==='upload').length;
  await publishDerived(store,cloud,await cloud.list(''),current,time);
  assert.equal(cloud.calls.filter(c=>c.method==='upload').length,count);
  const before=(await store.snapshot()).revision;
  await store.commit(before,{replace:{watched:[]}});
  await assert.rejects(publishDerived(store,cloud,await cloud.list(''),current,time));
  assert.equal(cloud.calls.filter(c=>c.method==='upload').length,count);
});

test('Derived publication checks the record, settings receipts and account after export',async()=>{
  for (const change of ['concurrent edit','new grant','pending settings']) {
    const cloud = new FictionalDropbox(), store = memoryStore();
    const current = {...credentials,signInDeadline:Date.now()+86400000};
    await store.commit(1n,{local:{dropboxSession:current},...(change === 'pending settings' ?
      {sync:{settings:{base:null,pending:{content:'setting,value\r\n'},lastClientModified:null}}} : {})});
    store.exportSnapshot = async () => {
      const local = await store.snapshot();
      if (change === 'concurrent edit') await store.commit(local.revision,{replace:{watched:[watch(2)]}});
      if (change === 'new grant') await store.commit(local.revision,{local:{dropboxSession:{...current,instanceId:'other'}}});
      return {...source(),tables:local.tables,revision:local.revision};
    };
    await assert.rejects(publishDerived(store,cloud,[],current,Date.now()),{name:'StaleSnapshotError'});
    assert.equal(cloud.calls.length,0);
  }
});

test('A shows index edited or deleted after listing is repaired using the newer download', async () => {
  for (const change of ['edit', 'delete']) {
    const cloud = new FictionalDropbox(), store = memoryStore();
    const current = {...credentials, signInDeadline:Date.now()+86400000};
    await store.commit(1n, {local:{dropboxSession:current}});
    store.exportSnapshot = async () => ({...source(), ...await store.snapshot()});
    const expected = writeCsv('shows', []);
    await cloud.put('/shows.csv', expected);
    const listing = await cloud.list('');
    if (change === 'delete') cloud.live.delete('/shows.csv');
    else await cloud.put('/shows.csv',writeCsv('shows',[{show_id:8, show:'Obsolete', year:null, imdb_id:''}]));
    await publishDerived(store, cloud, listing, current, Date.now());
    const restored = await cloud.download('/shows.csv');
    assert.equal(restored && new TextDecoder().decode(restored.bytes), expected, change);
  }
});

test('reusing a local record never authorizes publication over a peer summary changed after the folder listing',async()=>{
  const cloud=new FictionalDropbox(), store=memoryStore(), data=source(), now=Date.now();
  const session={...credentials,signInDeadline:now+86400000}, reference={};
  const merged=await cloud.put('/watched.csv',writeCsv('watched',data.tables.watched));
  await store.commit(1n,{replace:{watched:data.tables.watched},local:{dropboxSession:session},sync:{
    watched:{base:{revision:merged.rev,content:writeCsv('watched',data.tables.watched)},pending:null,lastClientModified:null}}});
  store.exportSnapshot=async(_seasons,_now,_ids,_signal,prior)=>{
    assert.equal(prior,reference);
    const record=await store.snapshot();
    return {...data,tables:record.tables,revision:record.revision};
  };
  const before=await cloud.put('/summary.csv','previous shared summary');
  const listing=await cloud.list('');
  const peer=await cloud.put('/summary.csv','newer completed peer summary');
  await assert.rejects(publishDerived(store,cloud,listing,session,now,reference),{kind:'conflict'});
  assert.equal(cloud.calls.find(call=>call.path==='/summary.csv' && call.method==='upload').options.revision,before.rev);
  assert.equal(cloud.live.get('/summary.csv').metadata.rev,peer.rev);
  assert.equal(new TextDecoder().decode(cloud.live.get('/summary.csv').bytes),'newer completed peer summary');
});

test('Taking a valid hand-edited Dropbox CSV publishes the derived files in that same sync', async () => {
  const cloud = new FictionalDropbox(), store = memoryStore(), s = source();
  const current = { ...credentials, signInDeadline: Date.now() + 86400000 };
  const original = writeCsv('watched', s.tables.watched);
  const base = await cloud.put('/watched.csv', original);
  await store.commit(1n, { replace: { watched: s.tables.watched }, local: { dropboxSession: current },
    sync: { watched: { base: { content: original, revision: base.rev }, pending: null, lastClientModified: null } } });
  // A hand-edited file removed the only episode and uses LF, triggering the deletion guard.
  const empty = writeCsv('watched', []).replaceAll('\r\n', '\n');
  await cloud.put('/watched.csv', empty);
  const engine = new DropboxSync(store, cloud, current, { guard: async () => 'take-remote' });
  const run = await engine.run();
  assert.equal(run.complete, true);
  assert.equal((await store.snapshot()).sync.watched.base.content, empty);
  store.exportSnapshot = async () => {
    const local = await store.snapshot();
    return { ...s, tables: local.tables, revision: local.revision };
  };
  await publishDerived(store, cloud, run.listing, current, Date.now());
  assert.ok(await cloud.download('/summary.csv'));
  assert.equal(new TextDecoder().decode((await cloud.download('/watched.csv')).bytes), empty);
});
