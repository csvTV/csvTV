import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { LibrarySortRecovery } from '../dist/display-preferences.js';

test('An interrupted Library sort recovers once on the same unchanged record and ignores stale, altered or unavailable hints', async t => {
  const entries = new Map(), key = 'csvTV/pending-library-sort';
  const events = new EventTarget();
  const storage = {getItem:k=>entries.get(k) ?? null, setItem:(k,v)=>entries.set(k,v), removeItem:k=>entries.delete(k)};
  for (const [name,value] of Object.entries({window:events,sessionStorage:storage})) {
    const previous=Object.getOwnPropertyDescriptor(globalThis,name);
    Object.defineProperty(globalThis,name,{value,configurable:true});
    t.after(()=>{if(previous)Object.defineProperty(globalThis,name,previous);else delete globalThis[name];});
  }
  const create = (device='fictional device') => new LibrarySortRecovery(async text =>
    createHmac('sha256',device).update(text).digest('hex'));
  const owner='fictional account', erased=0n, revision=22n, prior='episodes';
  const source=create(), saved=Promise.withResolvers();
  await source.observe(owner,erased,revision,prior);
  const first=Promise.withResolvers(), earlier=source.track('title',first.promise);
  const pending=source.track('rating',saved.promise);
  first.resolve(); await earlier;
  events.dispatchEvent(new Event('pagehide'));
  const raw=entries.get(key), receipt=JSON.parse(raw);
  assert.deepEqual(Object.keys(receipt).sort(),['expires','proof','value']);
  assert.equal(receipt.value,'rating');
  assert.ok(!raw.includes(owner) && !raw.includes(prior));
  assert.equal(create().needsRecovery,true);
  assert.equal(entries.get(key),raw,'a second refresh during verification retains the interrupted choice');
  async function reopen({device,account=owner,generation=erased,rev=revision,previous=prior,stored=raw}={}) {
    entries.set(key,stored);
    const instance=create(device), proofs=await instance.observe(account,generation,rev,previous);
    const result=instance.take(proofs);
    assert.equal(instance.take(proofs),undefined,'a tab consumes its hint once');
    assert.equal(entries.has(key),false);
    return result;
  }
  assert.equal(await reopen(),'rating');
  for (const other of [{account:'fictional peer'},{account:''},{generation:1n},{rev:revision+1n},
    {previous:'title'},{previous:'rating'},{device:'erased device'},{stored:'{'},{stored:'x'.repeat(1000)},
    {stored:JSON.stringify({...receipt,value:'title'})},{stored:JSON.stringify({...receipt,expires:Date.now()-1})},
    {stored:JSON.stringify({...receipt,expires:Date.now()+600000})}])
    assert.equal(await reopen(other),undefined);
  // A duplicated tab can read its copied receipt. After the first durable edit
  // advances the revision, the other copy cannot replay against it.
  assert.equal(await reopen({rev:revision+1n,previous:'rating'}),undefined);
  saved.resolve(); await pending; events.dispatchEvent(new Event('pagehide'));
  assert.equal(entries.has(key),false);
  const finishing=Promise.withResolvers(), afterHide=source.track('rating',finishing.promise);
  events.dispatchEvent(new Event('pagehide'));
  assert.equal(JSON.parse(entries.get(key)).value,'rating');
  finishing.resolve(); await afterHide;
  assert.equal(entries.has(key),false,'a commit that finishes in a suspended page retires its own hint');
  const older=Promise.withResolvers(), newerHandoff=source.track('title',older.promise);
  events.dispatchEvent(new Event('pagehide'));
  entries.set(key,raw);
  older.resolve(); await newerHandoff;
  assert.equal(entries.get(key),raw,'a late acknowledgement leaves a different handoff intact');
  entries.clear();
  const denied=Promise.withResolvers(), failed=source.track('title',denied.promise);
  denied.reject(Error('fictional rejected save')); await assert.rejects(failed);
  events.dispatchEvent(new Event('pagehide')); assert.equal(entries.has(key),false);
  const reset=Promise.withResolvers(), unresolved=source.track('rating',reset.promise);
  source.clear(); events.dispatchEvent(new Event('pagehide')); assert.equal(entries.has(key),false);
  reset.resolve(); await unresolved;
  const blocked=create(); await blocked.observe(owner,erased,revision,prior);
  t.mock.method(storage,'setItem',()=>{throw new Error('blocked');});
  t.mock.method(storage,'getItem',()=>{throw new Error('blocked');});
  const write=Promise.withResolvers(), saving=blocked.track('title',write.promise);
  events.dispatchEvent(new Event('pagehide')); write.resolve(); await saving;
  assert.equal(blocked.take(await blocked.observe(owner,erased,revision,prior)),undefined);
});
