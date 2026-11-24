import assert from 'node:assert/strict';
import test from 'node:test';
import { MdbListService } from '../src/mdblist-service.ts';
import { ImdbService } from '../src/imdb-service.ts';
import { GithubFileRefresh, inGithubLane } from '../src/github-file-refresh.ts';

test('Background ratings requests recheck visibility after asynchronous credential reads', async () => {
  for (const provider of ['mdblist', 'omdb', 'github']) {
    let visible = true, checking = false, admitted, admission;
    const environment = { online: () => true, visible: () => visible, now: () => 100 };
    const state = { generation: 1n, key: 'fictional', entries: new Map(),
      config: { imdb_source: 'omdb', omdb_key: 'fictional', github_repo: 'fictional/shows', github_token: 'fictional' } };
    const readState = async () => {
      assert.equal(store.role, 'writer', 'A late retry opened the closed database');
      if (checking) visible = false;
      return state;
    };
    const store = Object.assign(new EventTarget(), { role: 'writer', mdbListState: readState, imdbState: readState,
      imdbIdentities: async () => new Map([[1, 'tt0000001']]), imdbValues: async () => [] });
    async function checkAdmission(current) {
      checking = true;
      admission = current;
      admitted = await admission();
      throw new Error('admission checked');
    }
    let work;
    if (provider === 'mdblist') {
      work = new MdbListService(store, {lookup(id,key,current) {
        assert.deepEqual([id,key],[1,'fictional']);
        return checkAdmission(current);
      }}, environment).refresh([1], true);
    } else if (provider === 'omdb') {
      work = new ImdbService({store, environment}, {omdb: {lookup(id,season,key,current) {
        assert.deepEqual([id,season,key],['tt0000001',null,'fictional']);
        return checkAdmission(current);
      }}}).refreshShows([1], true);
    } else {
      work = new GithubFileRefresh({store, environment, state: readState, active: () => true,
        enabled: () => true, download(repo,token,current,savedDigest) {
          assert.deepEqual([repo,token,savedDigest],['fictional/shows','fictional',undefined]);
          return checkAdmission(current);
        }}).refresh();
    }
    await assert.rejects(work, /admission checked/);
    assert.equal(admitted, false, provider + ' admitted a hidden background request');
    store.role = 'closed';
    visible = true;
    assert.equal(await admission(), false, provider + ' reopened a retired store');
  }
});

test('Queued GitHub and OMDb jobs finish quietly when their device closes', async () => {
  const env = {now:() => 100, online:() => true, visible:() => true};
  const gate = Promise.withResolvers(), joined = Promise.withResolvers();
  const store = {role:'writer'};
  const preceding = inGithubLane(store,'fictional',() => gate.promise);
  let active = true;
  const github = new GithubFileRefresh({store,environment:env,active:()=>active,enabled:()=>true,
    state:async () => {
      assert.ok(active,'read from closed GitHub device');
      joined.resolve();
      return {generation:1n, config:{github_repo:'fixture/scores',github_token:'fictional'}};
    }, download:assert.fail,save:assert.fail});
  const work = github.refresh();
  await joined.promise;
  await Promise.resolve();
  active = false;
  gate.resolve();
  await Promise.all([preceding,work,github.refresh()]);

  const admitted = Promise.withResolvers(), response = Promise.withResolvers(), second = Promise.withResolvers();
  let hasSecond = false, reads = 0;
  const omdbStore = Object.assign(new EventTarget(),{role:'writer',
    imdbState:async () => {
      assert.equal(omdbStore.role, 'writer','read from closed OMDb device');
      if (hasSecond && ++reads === 2) second.resolve();
      return {generation:1n,config:{imdb_source:'omdb',omdb_key:'fictional'}};
    },
    imdbIdentities:async ids=>new Map(ids.map(id=>[id,'tt00'+id])),
    imdbValues:async()=>[], writeImdb:assert.fail});
  const imdb = new ImdbService({store:omdbStore, environment:env},{omdb:{lookup:async() => {
    admitted.resolve(); await response.promise; return {rating:7,episodes:new Map()};
  }}});
  const firstLookup = imdb.refreshShows([1]);
  await admitted.promise;
  hasSecond = true;
  const secondLookup = imdb.refreshShows([2]);
  await second.promise;
  await new Promise(resolve=>setImmediate(resolve));
  imdb.close(); omdbStore.role = 'closed'; response.resolve();
  await Promise.all([firstLookup,secondLookup]);
});
