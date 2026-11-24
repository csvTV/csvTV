import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { indexImdbEpisodes, indexImdbShows } from '../src/ratings-worker-client.ts';
import { RatingsFileLimitError } from '../src/ratings-csv.ts';

const header = 'show,season,episode,rating\n';
const data = header + '1,,,7.9\n8,1,1,6.4\n' + '18,1,1,5.6\n'.repeat(8000);
const large = new Blob([gzipSync(data,{level:0})]);
const small = new Blob([gzipSync(header+'8,1,1,6.4\n')]);

function provideWorker(t,implementation) {
  const previous = Object.getOwnPropertyDescriptor(globalThis,'Worker');
  Object.defineProperty(globalThis,'Worker',{value:implementation,configurable:true});
  t.after(()=>{if (previous) Object.defineProperty(globalThis,'Worker',previous); else delete globalThis.Worker;});
}

test('The ratings parser bounds simultaneous workers and every request contains only a file and optional title number',async t=>{
  const pending = [], indices = [];
  let started = 0, ended = 0, peak = 0;
  provideWorker(t,class {
    constructor(url,options) {
      assert.equal(url.pathname.split('/').at(-1),'ratings-worker.js');
      assert.deepEqual(options,{type:'module'});
      started++; peak = Math.max(peak,started-ended);
    }
    postMessage({file,show,...extra}) {
      assert.equal(file,large); assert.deepEqual(extra,{});
      pending.push(()=>this.onmessage({data:{result:indices[show]}}));
    }
    terminate() { ended++; }
  });
  for (let show=1;show<=6;show++) indices[show] = new Map([[1,new Map([[1,show]])]]);
  const results = Array.from({length:6},(_,i)=>indexImdbEpisodes(large,i+1));
  assert.equal(started,2);
  for (let i=0;i<results.length;i++) {
    pending.shift()();
    assert.deepEqual(await results[i],indices[i+1]);
  }
  assert.equal(started,6); assert.equal(ended,6); assert.equal(peak,2);
  assert.deepEqual(await indexImdbEpisodes(small,8),new Map([[1,new Map([[1,6.4]])]]));
  assert.equal(started,6);
});

test('A blocked or unavailable worker falls back while malformed or oversized data keeps its original failure',async t=>{
  let mode = 'blocked', ended = 0;
  let now = 0;
  t.mock.method(performance,'now',()=>now);
  provideWorker(t,class {
    constructor() { if(mode==='blocked') throw Error('Unavailable'); }
    postMessage() {
      if (mode==='load-error') this.onerror({preventDefault(){}});
      else if (mode==='decode-error') this.onmessageerror();
      else if (mode==='empty-reply') queueMicrotask(()=>this.onmessage({data:null}));
      else if (mode==='unknown-reply') queueMicrotask(()=>this.onmessage({data:{version:2}}));
      else this.onmessage({data:{failure:mode}});
    }
    terminate() { ended++; }
  });
  for (mode of ['blocked','unavailable','load-error','decode-error','empty-reply','unknown-reply']) {
    now += 31_000;
    const index = await indexImdbShows(large);
    assert.equal(index.shows.get(1),7.9); assert.equal(index.episodeCount,8001);
  }
  now += 31_000;
  mode='invalid';
  await assert.rejects(indexImdbShows(large),/invalid or incomplete/);
  mode='limit';
  await assert.rejects(indexImdbShows(large),RatingsFileLimitError);
  assert.equal(ended,7);
});

test('A slow worker can finish while advancing rows, and duplicate progress cannot stall a later request',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let instance, started=0, ended=0;
  provideWorker(t,class {
    constructor() { instance=this; started++; }
    postMessage() {}
    terminate() { ended++; }
  });
  const first = indexImdbEpisodes(large,8);
  const deliver = data=>instance.onmessage({data});
  t.mock.timers.tick(4900); deliver({rows:0});
  for (const rows of [1000,2000,3000,4000]) { t.mock.timers.tick(14_900); deliver({rows}); }
  const good = new Map([[1,new Map([[1,6.4]])]]);
  deliver({result:good}); assert.deepEqual(await first,good);
  const second = indexImdbEpisodes(large,8);
  deliver({rows:0});
  t.mock.timers.tick(14_900);
  deliver({rows:0}); deliver({rows:-3}); deliver({rows:Infinity});
  t.mock.timers.tick(100);
  assert.deepEqual(await second,good);
  assert.equal(started,2); assert.equal(ended,2);
});

test('Closing views releases running and queued work and excess requests can be retried',async t=>{
  const pending=[], controllers=[], stopped=Error('Fictional view closed');
  let ended=0;
  provideWorker(t,class {
    postMessage(data) {pending.push({data,reply:result=>this.onmessage({data:{result}})});}
    terminate() {ended++;}
  });
  const reads=[];
  for (let id=1;id<=10;id++) {
    const controller=new AbortController(); controllers.push(controller);
    reads.push(indexImdbEpisodes(large,id,controller.signal));
  }
  const results=Promise.allSettled(reads);
  for (let id=11;id<=40;id++) await assert.rejects(indexImdbEpisodes(large,id),/lookups are already waiting/);
  assert.equal(pending.length,2);
  for (const controller of controllers) controller.abort(stopped);
  assert.ok((await results).every(result=>result.status==='rejected' && result.reason===stopped));
  assert.equal(pending.length,2); assert.equal(ended,2);
  const recovered=indexImdbEpisodes(large,40);
  pending.at(-1).reply(new Map());
  assert.equal((await recovered).size,0); assert.equal(ended,3);
});

test('Two silent workers release their slots and the queued series can still finish locally',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let started = 0, ended = 0;
  provideWorker(t,class {
    constructor() { started++; }
    postMessage() {}
    terminate() { ended++; }
  });
  const requests = [1,8,18,20].map(id=>indexImdbEpisodes(large,id));
  await Promise.resolve();
  assert.equal(started,2);
  t.mock.timers.tick(60_000);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(ended,2,'A silent worker monopolized a parser slot');
  const result = await Promise.all(requests);
  assert.equal(result[1].get(1).get(1),6.4);
  assert.equal(result[2].get(1).get(1),5.6);
  assert.equal(started,2,'Queued reads immediately started more unavailable workers');
});
