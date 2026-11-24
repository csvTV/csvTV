import assert from 'node:assert/strict';
import test from 'node:test';
import { writeCsv } from '../dist/csv.js';
import { DropboxSync } from '../dist/dropbox-sync.js';
import { confirmSingleDelivery, credentials, FictionalDropbox, memoryStore, time } from './dropbox-sync-fixture-cases.mjs';

test('three devices converge after overlapping Dropbox writes, offline edits and lost acknowledgments', async () => {
  // Dropbox tests the revision and commits the new bytes as one server operation.
  class AtomicDropbox extends FictionalDropbox {
    turn = Promise.resolve();
    upload(...args) {
      const written = this.turn.then(() => super.upload(...args));
      this.turn = written.catch(() => {});
      return written;
    }
  }
  const cloud = new AtomicDropbox(), devices = [], expected = {watched:new Map(),ratings:new Map(),lists:new Map()};
  let lost = 0, conflicts = 0, clock = time;
  for (let device = 0; device < 3; device++) {
    const store = memoryStore(), session = {...credentials,instanceId:'fictional-device-'+device};
    await store.commit(1n,{local:{dropboxSession:session}});
    devices.push({store, run:() => new DropboxSync(store,cloud,session,confirmSingleDelivery,()=>clock).run()});
  }
  for (const table of Object.keys(expected)) await cloud.put('/'+table+'.csv',writeCsv(table,[]));
  async function change(device,round) {
    const store = devices[device].store, snapshot = await store.snapshot();
    const id = 10*device + round%4 + 1, show = 'Test series '+id;
    const plays = (round+device)%5, score = (round*2+device)%11;
    const values = {
      watched:plays ? {show_id:id,show,season:1,episode:1,title:'Opening',episode_id:1000+id,times_watched:plays} : null,
      ratings:score ? {show_id:id,show,rating:score} : null,
      lists:(device+round)%3 ? {show_id:id,show,list:'Round selections'} : null,
    };
    const replace = {};
    for (const [table,row] of Object.entries(values)) {
      replace[table] = snapshot.tables[table].filter(item => item.show_id !== id);
      if (row) { replace[table].push(row); expected[table].set(id,row); }
      else expected[table].delete(id);
    }
    await store.commit(snapshot.revision,{replace});
  }
  cloud.before = (method,path,{options} = {}) => {
    if (method === 'upload' && options.mode === 'update' && options.revision !== cloud.live.get(path)?.metadata.rev) conflicts++;
  };
  for (let round=0;round<12;round++) {
    clock += 10_000;
    await Promise.all(devices.map((_,device) => change(device,round)));
    let dropReceipt = round%3 === 1;
    cloud.after = () => {
      if (dropReceipt) { dropReceipt = false; lost++; throw Object.assign(Error('Lost fictional receipt'),{kind:'unavailable'}); }
    };
    // A rotating device stays offline. Reopening a sync engine uses its last durable base and pending state.
    const writes = await Promise.allSettled(devices.filter((_,i) => i !== round%3).map(device => device.run()));
    for (const write of writes) {
      if (write.status === 'rejected') assert.match(write.reason.message,/unknown outcome|Lost fictional receipt/);
      else assert.equal(write.value.complete,true,write.value.reason);
    }
  }
  cloud.after = () => {};
  for (let pass=0;pass<2;pass++) for (const device of devices) assert.equal((await device.run()).complete,true);
  assert.equal(lost,4);
  assert.ok(conflicts>0,'the scenario must exercise actual Dropbox revision conflicts');
  for (const [table,rows] of Object.entries(expected)) {
    const canonical = writeCsv(table,[...rows.values()]);
    assert.equal(writeCsv(table,cloud.rows(table)),canonical);
    for (const device of devices) {
      const state = await device.store.snapshot();
      assert.equal(writeCsv(table,state.tables[table]),canonical);
      assert.equal(state.sync[table].pending,null);
    }
  }
});
