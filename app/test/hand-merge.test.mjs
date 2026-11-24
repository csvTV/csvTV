import test from 'node:test';
import assert from 'node:assert/strict';
import { applyHandMerge, planHandMerge, readHandInputs } from '../dist/hand-merge.js';
import { memoryStore, credentials, count, watch, watchCsv, edit } from './dropbox-sync-fixture-cases.mjs';
import { writeCsv } from '../dist/csv.js';

const files = (...items) => items.map(([name,content])=>new File([content],name));
async function fixture(linked) {
  const store=memoryStore(); store.role='writer';
  const session={ ...credentials,signInDeadline:Date.now()+86400000 };
  await store.commit(1n,linked ? {local:{dropboxSession:session}} : {removeLocal:['syncAccountId','dropboxSession']});
  store.dropboxState=async()=>{const s=await store.snapshot();return {accountId:s.local.syncAccountId??null,session:s.local.dropboxSession??null,revision:s.revision};};
  return store;
}
const hooks={preflight:async()=>{},backup:async()=>{},confirm:async()=>true};
test('Hand merge describes a named empty list and applies it without creating a show', async () => {
  const store = await fixture(false);
  const input = await readHandInputs(files(['lists.csv','list,show_id,show\r\nWeekend picks,,\r\n']));
  const plan = await planHandMerge(input, await store.snapshot());
  assert.ok(plan.notes.includes('Keep list “Weekend picks” even when empty.'));
  assert.ok(await applyHandMerge(store,input,plan,hooks));
  const {tables} = await store.snapshot();
  assert.equal(writeCsv('lists',tables.lists),'list,show_id,show\r\nWeekend picks,,\r\n');
  assert.deepEqual(tables.shows,[]);
});
test('Hand merge names dropped and duplicate columns before accepting a partial file selection', async () => {
  const unknown = new File(['show_id,rating,comment\r\n0,0,Fictional note\r\n'], 'ratings.csv');
  const duplicate = new File(['list,show_id,list\r\nLater,0,Other\r\n'], 'lists.csv');
  const input = await readHandInputs([unknown, duplicate]);
  assert.deepEqual(input.tables, {ratings:[{show_id:0,show:'',rating:0}]});
  assert.ok(input.notes.some(note => note.includes('ratings.csv') && note.includes('comment') && note.includes('dropped')));
  assert.ok(input.notes.some(note => note.includes('lists.csv') && note.includes('Duplicate column') && note.includes('“list”')));
  assert.ok(input.notes.every(note => !note.includes('Fictional note')));
});
async function syncedWatches(store) {
  const snapshot = await store.snapshot();
  await store.commit(snapshot.revision, { sync: { watched: { pending:null, lastClientModified:null,
    base:{ revision:'fictional-base', content:writeCsv('watched', snapshot.tables.watched) } } } });
}
test('A recognized hand-merge header still identifies the table when a later record has invalid UTF-8', async () => {
  const damaged = new File(['show_id,rating\r\n1,8\r\n2,', Uint8Array.of(0xff)], 'damaged.csv');
  const good = new File(['show_id,rating\r\n3,7\r\n'], 'good.csv');
  const unrelated = new File(['list,show_id\r\nLater,3\r\n'], 'lists.csv');
  const single = await readHandInputs([damaged, unrelated]);
  assert.deepEqual(Object.keys(single.tables), ['lists']);
  assert.ok(single.notes.some(note => note.includes('damaged.csv') && note.includes('line 3') && note.includes('UTF-8')));
  for (const selection of [[damaged, good, unrelated], [good, damaged, unrelated]]) {
    const result = await readHandInputs(selection);
    assert.deepEqual(Object.keys(result.tables), ['lists']);
    assert.ok(result.notes.some(note => note.includes('damaged.csv') && note.includes('good.csv') && note.includes('Multiple files')));
  }
});
test('Hand merge names unavailable files and still previews and applies each readable selection', async () => {
  const missing = new File([], 'Unavailable.csv');
  missing.arrayBuffer = async () => { throw new DOMException('private device path', 'NotReadableError'); };
  const valid = new File(['show_id,rating\r\n3,0\r\n'], 'File with a rating.csv');
  for (const selection of [[missing, valid], [valid, missing], [missing]]) {
    const input = await readHandInputs(selection);
    assert.deepEqual(input.notes, ['Unavailable.csv · Could not read this file. It was left out.']);
    const store = await fixture(false);
    const plan = await planHandMerge(input, await store.snapshot());
    if (selection.length === 1) {
      await assert.rejects(applyHandMerge(store, input, plan, hooks), /Choose a readable record file/);
    } else {
      assert.ok(plan.notes.some(line => line.includes('Show 3 · rating 0')));
      await applyHandMerge(store, input, plan, hooks);
      assert.deepEqual((await store.snapshot()).tables.ratings, [{show_id:3, show:'', rating:0}]);
    }
  }
});
test('Hand merge identifies tables by headers and lists duplicate, unknown, malformed and conflicting inputs',async () => {
  const store=await fixture(false);
  const rating=v=>({show_id:7,show:'Coastal Dial',rating:v});
  await store.commit((await store.snapshot()).revision,{replace:{ratings:[rating(9)]}});
  const input=await readHandInputs(files(['names.csv',writeCsv('ratings',[rating(8)])],['left.csv',watchCsv(4)],['right.csv',watchCsv(2)],
    ['bad.csv','what,else\n'],['members','list,show_id,show\nMystery,4,One\nNow,invalid,Two\n']));
  assert.deepEqual(Object.keys(input.tables).sort(),['lists','ratings']);
  const plan=await planHandMerge(input,await store.snapshot());
  assert.ok(plan.notes.some(s=>s.includes('left.csv, right.csv')));
  assert.ok(plan.notes.some(s=>s.includes('bad.csv')));
  assert.ok(plan.notes.some(s=>s.includes('keep rating 9')));
  await applyHandMerge(store,input,plan,{...hooks,preflight:()=>assert.fail('unexpected sync'),backup:()=>assert.fail('unexpected Dropbox backup')});
  assert.equal((await store.snapshot()).tables.ratings[0].rating,9);
  assert.equal((await store.snapshot()).tables.lists.length,1);
});
test('A material post-sync change needs reconfirmation; cancel preserves that sync and omits the hand merge',async () => {
  const store=await fixture(true); await edit(store,watch(1));
  const input=await readHandInputs(files(['new',watchCsv(5)])); const preview=await planHandMerge(input,await store.snapshot());
  let reviewed=0;
  const result=await applyHandMerge(store,input,preview,{preflight:async()=>{await edit(store,watch(3)); await syncedWatches(store);},backup:()=>assert.fail('unapproved'),
    confirm:async actual=>{reviewed++; assert.ok(actual.notes.some(n=>n.includes('3 → 5'))); return false;}});
  assert.equal(result,false); assert.equal(reviewed,1); assert.equal(await count(store),3);
});
test('A hand merge previews newly identified episodes and the recorded positions vacated by a reviewed move', async () => {
  const store = await fixture(false);
  const blank = {...watch(2), episode_id:null}, identified = {...blank, episode_id:71};
  await edit(store, blank);
  const input = {tables:{watched:[identified]},notes:[]};
  const initial = await planHandMerge(input, await store.snapshot());
  assert.ok(initial.notes.some(note => note.includes('episode ID') && note.includes('71') && note.includes('S1 E1')));
  await applyHandMerge(store,input,initial,hooks);
  const changed = {...identified, episode:3};
  const movedInput = {tables:{watched:[changed]},notes:[]};
  const assign = () => [{show_id:identified.show_id, season:1,episode:3,episode_id:71,mine:0,theirs:0}];
  const before = await store.snapshot();
  const moved = await planHandMerge(movedInput,before,assign);
  assert.ok(moved.notes.some(note => note.includes('S1 E1') && note.includes('removed') && note.includes('71')));
  assert.ok(moved.notes.some(note => note.includes('S1 E3')));
  await applyHandMerge(store,movedInput,moved,{...hooks,resolve:assign});
  assert.deepEqual((await store.snapshot()).tables.watched, [changed]);
});
test('An edit during hand-merge confirmation is reviewed before creating any backup', async () => {
  const store = await fixture(true);
  await edit(store, watch(1));
  const input = await readHandInputs(files(['new.csv', watchCsv(5)]));
  const approved = await planHandMerge(input, await store.snapshot());
  await edit(store, watch(2));
  const shown = [];
  const result = await applyHandMerge(store, input, approved, {
    preflight: () => syncedWatches(store),
    backup: () => assert.fail('Backing up a superseded review consumes a backup slot'),
    confirm: async plan => {
      shown.push(plan.notes.find(note => note.includes('→')));
      if (shown.length > 1) return false;
      await edit(store, watch(3));
      return true;
    },
  });
  assert.equal(result, false);
  assert.match(shown[0], /2 → 5/);
  assert.match(shown[1], /3 → 5/);
  assert.equal(await count(store), 3);
});
test('A failed backup, late exchange and edit while the backup runs are settled before writing',async () => {
  const store=await fixture(true); await edit(store,watch(1));
  const input=await readHandInputs(files(['new',watchCsv(5)])); const preview=await planHandMerge(input,await store.snapshot());
  const linkedHooks = { ...hooks, preflight:()=>syncedWatches(store) };
  await assert.rejects(applyHandMerge(store,input,preview,{...linkedHooks,backup:async()=>{throw Error('Interrupted');}}), /Interrupted/); assert.equal(await count(store),1);
  let calls=0, reviews=0;
  await applyHandMerge(store,input,preview,{...linkedHooks,backup:async()=>{if (++calls===1) await edit(store,watch(2));},
    confirm:async()=>{reviews++;return true;}});
  assert.equal(calls,2); assert.equal(reviews,1); assert.equal(await count(store),5);
  const next=await readHandInputs(files(['new',watchCsv(7)]));const plan=await planHandMerge(next,await store.snapshot());
  await assert.rejects(applyHandMerge(store,next,plan,{...linkedHooks,backup:async()=>{await store.commit((await store.snapshot()).revision,
    {local:{dropboxSession:{...credentials,instanceId:'different'}}});}}));
  assert.equal(await count(store),5);
});
test('Leaving a hand merge during its final revision check cancels the pending backup', async () => {
  const store = await fixture(true);
  const input = await readHandInputs(files(['new.csv', watchCsv(5)]));
  const approved = await planHandMerge(input, await store.snapshot());
  const read = store.dropboxState.bind(store);
  let active = true, reads = 0;
  store.dropboxState = async () => {
    const state = await read();
    if (++reads === 2) active = false;
    return state;
  };
  assert.equal(await applyHandMerge(store, input, approved, { ...hooks, active: () => active,
    backup: () => assert.fail('An abandoned merge started a backup') }), false);
  assert.equal(await count(store), 0);
});

test('Hand merge waits for its local record to be synced before backing up or applying any changes', async () => {
  const store = await fixture(true);
  const input = await readHandInputs(files(['watched', watchCsv(4)]));
  const approved = await planHandMerge(input, await store.snapshot());
  let backedUp = false;
  await assert.rejects(applyHandMerge(store, input, approved, { ...hooks,
    preflight: () => edit(store, watch(2)), backup: async () => { backedUp = true; } }), /sync/i);
  assert.equal(backedUp, false);
  assert.equal(await count(store), 2);
});

test('Hand merge binds preflight and backup to the reviewed sign-in, even when the account remains the same', async () => {
  const input = await readHandInputs(files(['watched', watchCsv(2)]));
  for (const linked of [true, false]) {
    const store = await fixture(linked);
    const approved = await planHandMerge(input, await store.snapshot());
    const current = await store.snapshot();
    await store.commit(current.revision, { local: { syncAccountId: credentials.accountId,
      dropboxSession: { ...credentials, instanceId: 'new', signInDeadline: Date.now() + 86400000 } } });
    let calls = 0;
    await assert.rejects(applyHandMerge(store, input, approved, { ...hooks,
      preflight: async () => { calls++; }, backup: async () => { calls++; } }), /sign.in|account/i);
    assert.equal(calls, 0);
    assert.equal(await count(store), 0);
  }
  const store = await fixture(true);
  const expected = { accountId: credentials.accountId, instanceId: credentials.instanceId };
  const approved = await planHandMerge(input, await store.snapshot());
  const calls = [];
  assert.equal(await applyHandMerge(store, input, approved, { ...hooks,
    preflight: async binding => { calls.push(binding); }, backup: async binding => { calls.push(binding); } }), true);
  assert.deepEqual(calls, [expected, expected]);
});
