import assert from 'node:assert/strict';
import test from 'node:test';
import { openImportMetadata } from '../src/import-metadata.ts';
import { TmdbService } from '../src/tmdb-service.ts';
import { TmdbError, tmdbResourceKey } from '../src/tmdb-client.ts';

test('Closing an import discards pending cache reads and provider replies, including their progress', async () => {
  for (const fresh of [true, false]) {
    const started = Promise.withResolvers(), release = Promise.withResolvers();
    let progress = 0;
    const entry = {fetchedAt:1000, value:{show_id:17, status:'Ended'}};
    const service = {
      store:{role:'writer'}, environment:{online:() => true, now:() => 1000},
      async keyStatus() { return {generation:1n, status:'ready'}; },
      async read() { if (!fresh) return null; started.resolve(); await release.promise; return entry; },
      async fetchForImport() { started.resolve(); await release.promise; return entry; },
    };
    const session = await openImportMetadata(service, 'Trakt', {progress:() => progress++});
    const work = session.load({kind:'show', id:17});
    await started.promise;
    session.close(); release.resolve();
    await assert.rejects(work, {kind:'superseded'});
    await assert.rejects(session.verify(), {kind:'superseded'});
    assert.equal(session.cache.size, 0);
    assert.equal(progress, 0);
  }
});

test('Trakt season edits use held details or fetch only the selected season, retaining numbering history for confirmation', async t => {
  const now = Date.UTC(2026,6,5);
  const show = {show_id:17, status:'Ended', seasons:[{season:0},{season:1},{season:2}]};
  const resource = number => ({kind:'season', id:17, season:number});
  const showResource = {kind:'show', id:17};
  const prior = {fetchedAt:now-1, value:null, vacatedPositions:[3]};
  const local = new Map([
    [tmdbResourceKey(showResource), {fetchedAt:now, value:show}],
    [tmdbResourceKey(resource(0)), {fetchedAt:now, value:{show_id:17, season:0, episodes:[]}}],
    [tmdbResourceKey(resource(2)), prior],
  ]);
  const calls = [], progress = [];
  const service = new TmdbService({
    role:'writer', async tmdbState() { return {generation:11n, token:'fictional', refused:null, cooldown:null}; },
    async tmdbEntry(key) { return local.get(key); },
    async writeTmdb() { assert.fail('Review wrote metadata before confirmation'); },
  }, {async request(r) {
    calls.push(r.season);
    if (calls.length === 1) throw new TmdbError('unreachable');
    return {season_number:2, episodes:[{episode_number:3, id:173, name:'Signal', air_date:'2021-02-01'}]};
  }}, {online:()=>true, now:()=>now, visible:()=>true});
  t.after(() => service.close());
  const session = await openImportMetadata(service,'Trakt',{progress:n=>progress.push(n)});
  t.after(()=>session.close());
  const parent = await session.load(showResource);
  await session.load(resource(0), parent);
  session.finishMatching([parent]);
  assert.deepEqual(calls, []);
  assert.strictEqual(await session.reviewSeason(parent,0), local.get(tmdbResourceKey(resource(0))).value);
  await assert.rejects(session.reviewSeason(parent,9),{kind:'bad-request'});
  await assert.rejects(session.reviewSeason(parent,2),{kind:'unreachable'});
  assert.equal(session.cache.size,0);
  const [a,b] = await Promise.all([session.reviewSeason(parent,2),session.reviewSeason(parent,2)]);
  assert.strictEqual(a,b);
  assert.deepEqual(a.reusedPositions,[3]);
  assert.equal(a.episodes[0].episode_id,173);
  assert.deepEqual(calls,[2,2]);
  assert.deepEqual(progress,[1,2]);
  assert.equal(session.cache.size,1);
  assert.deepEqual(session.cache.get(tmdbResourceKey(resource(2))),{fetchedAt:now,value:a,prior});
  assert.strictEqual(local.get(tmdbResourceKey(resource(2))),prior);
  session.finishMatching([]);
  await assert.rejects(session.reviewSeason(parent,2),{kind:'superseded'});
  assert.equal(session.cache.size,1,'Completed preview keeps staged metadata for confirmation');
});

test('A late manual-season cache hit or provider reply cannot update a superseded Trakt preview', async () => {
  for (const cached of [true,false]) {
    for (const changed of ['generation','selection','abort','writer','offline']) {
      const started=Promise.withResolvers(), release=Promise.withResolvers(), controller=new AbortController();
      const parent={show_id:17,status:'Ended',seasons:[{season:2}]};
      const result={fetchedAt:1000,value:{show_id:17,season:2,episodes:[]}};
      const delayed=async()=>{started.resolve();await release.promise;return result;};
      let generation=4n,current=true,online=true;
      const store={role:'writer'};
      const service={store,environment:{now:()=>1000,online:()=>online},
        keyStatus:async()=>({status:'ready',generation}), read:cached?delayed:async()=>null,
        fetchForImport:cached?assert.fail:delayed};
      const session=await openImportMetadata(service,'Trakt',{signal:controller.signal,current:()=>current,progress:assert.fail});
      const work=session.reviewSeason(parent,2);
      await started.promise;
      if(changed==='generation')generation++;
      if(changed==='selection')current=false;
      if(changed==='abort')controller.abort();
      if(changed==='writer')store.role='reader';
      if(changed==='offline')online=false;
      release.resolve();
      await assert.rejects(work,{kind:changed==='offline'?'unreachable':'superseded'});
      assert.equal(session.cache.size,0);
      session.close();
    }
  }
});
