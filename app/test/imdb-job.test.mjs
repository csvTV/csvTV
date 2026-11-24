import assert from 'node:assert/strict';
import test from 'node:test';
import { TmdbLibrary } from '../dist/tmdb-library.js';
import { ImdbService } from '../dist/imdb-service.js';

test('A warm IMDb background job checks all resolved titles together and fences a key change before stale work', async () => {
  const now = Date.UTC(2026,10,22), ids = Array.from({length:280},(_,i)=>i+1);
  for (const source of ['github','omdb']) {
    let reads = 0, scoreReads = 0, files = 0, changed = false, generation = 1n;
    const store = Object.assign(new EventTarget(),{
      role:'writer',
      async imdbState() {
        reads++;
        return {generation,config:{imdb_source:source,github_token:'fictional-token',omdb_key:'fictional-key'}};
      },
      async imdbIdentities(wanted) {
        return new Map(wanted.map(id=>[id,id%7 ? 'tt'+id : null]));
      },
      async imdbValues(expected,keys) {
        scoreReads++;
        if (changed) { generation++; return []; }
        assert.equal(expected,generation);
        // Fresh absences and values are equally valid for the seven-day cache.
        return keys.map((_,i)=>({at:now-7*86400000,value:{rating:i%2 ? 5 : null}}));
      },
    });
    const service = new ImdbService({store,environment:{now:()=>now,visible:()=>true,online:()=>true},imdbIdentity:assert.fail},
      {omdb:{lookup:assert.fail}});
    service.refreshFile = async () => { files++; };
    try {
      await service.refreshShows(ids,true);
      assert.equal(reads,1);
      assert.equal(files,source==='github' ? 1 : 0);
      assert.equal(scoreReads,source==='omdb' ? 1 : 0);
      if (source==='omdb') {
        changed = true;
        await service.refreshShows(ids,true);
        assert.equal(reads,3, 'A revoked snapshot must stop before dispatching');
      }
    } finally { service.close(); }
  }
});

test('Changing the IMDb source starts the new job while the previous provider is still pending', {timeout:5000}, async t => {
  globalThis.window = new EventTarget();
  globalThis.document = new EventTarget();
  t.after(() => { delete globalThis.window; delete globalThis.document; });
  const store = Object.assign(new EventTarget(), {
    role:'reader',
    async metadataTargets() { return {tables:{watched:[], ratings:[], lists:[]}, statisticsOpened:false}; },
    async purgeTmdb() {},
    async tmdbState() { return {token:null, refused:null, cooldown:null}; },
  });
  const tmdb = {store, environment:{now:Date.now, online:() => true, visible:() => true}};
  let source = 'omdb';
  const calls = [], started = Promise.withResolvers(), oldRequest = Promise.withResolvers(), newRequest = Promise.withResolvers();
  const imdb = {
    async sourceStatus() { return {source}; },
    async refreshShows(ids, background) {
      calls.push({source, ids:[...ids], background});
      if (source === 'omdb') { started.resolve(); await oldRequest.promise; }
      else newRequest.resolve();
    },
  };
  const library = new TmdbLibrary(tmdb, undefined, imdb);
  t.after(() => { oldRequest.resolve(); library.close(); });
  store.role = 'writer';
  const firstRun = library.run();
  await started.promise;
  source = 'github';
  store.dispatchEvent(new Event('imdbconfigchange'));
  await newRequest.promise;
  oldRequest.resolve();
  await firstRun;
  assert.deepEqual(calls, [{source:'omdb', ids:[], background:true}, {source:'github', ids:[], background:true}]);
});
