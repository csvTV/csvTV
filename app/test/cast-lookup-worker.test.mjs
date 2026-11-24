import assert from 'node:assert/strict';
import test from 'node:test';
import { castWorkerAvailable, lookupCastInWorker } from '../src/cast-lookup-client.ts';

const db={name:'fictional-cast-cache',version:3};
test('A silent cast worker releases its slot, backs off and preserves the distinction between no match and a changed database',async t=>{
  const previous=Object.getOwnPropertyDescriptor(globalThis,'Worker'), pending=[];
  let ended=0,now=0;
  t.mock.timers.enable({apis:['setTimeout']});
  t.mock.method(performance,'now',()=>now);
  Object.defineProperty(globalThis,'Worker',{configurable:true,value:class {
    postMessage(data){pending.push(this); assert.deepEqual(data,{database:db.name,version:3,person:5,now:100});}
    terminate(){ended++;}
  }});
  t.after(()=>{if(previous)Object.defineProperty(globalThis,'Worker',previous);else delete globalThis.Worker;});
  const closing=new AbortController();
  const read=()=>lookupCastInWorker(db,5,100,40,closing.signal);
  const silent=read(),slow=read();
  assert.equal(castWorkerAvailable(),false);
  assert.equal(await read(),undefined);
  t.mock.timers.tick(4900);
  pending[1].onmessage({data:{rows:0}});
  t.mock.timers.tick(100);
  assert.equal(await silent,undefined); assert.equal(ended,1);
  pending[1].onmessage({data:{rows:12}});
  t.mock.timers.tick(14_900);
  pending[1].onmessage({data:{rows:12}});
  pending[1].onmessage({data:{rows:1_000_000}});
  t.mock.timers.tick(100);
  assert.equal(await slow,undefined); assert.equal(ended,2);
  assert.equal(await read(),undefined); assert.equal(pending.length,2);
  now+=31_000;
  const missing=read();
  pending.at(-1).onmessage({data:{result:null}});
  assert.equal(await missing,null,'An empty result should not start the local fallback');
  const stale=read();
  pending.at(-1).onmessage({data:{failure:'obsolete'}});
  await assert.rejects(stale,{name:'InvalidStateError'});
  assert.equal(ended,4);
});
