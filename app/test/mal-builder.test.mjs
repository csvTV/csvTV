import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readMalFile, selectMalScores } from '../src/mal-file.ts';

const builder = new URL('../../jobs/mal/mal-build.mjs', import.meta.url);

test('The canonical MyAnimeList job produces the app’s file from fictional inputs and retains it when a floor or score fails', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'csvtv-mal-builder-'));
  t.after(() => rm(directory, {recursive:true, force:true}));
  const output = join(directory, 'mal-ratings.csv.gz');
  const mapping = Array.from({length:30000}, (_, i) => i < 5002
    ? {mal_id:i+1, themoviedb_id:{tv:20+i}, season:{tmdb:1}}
    : {mal_id:i+1});
  // The first mapped entry has no published mean. The next entry supplies the mark.
  mapping[1].themoviedb_id.tv = mapping[0].themoviedb_id.tv;
  mapping[1].episode_offset = {tmdb:12};
  mapping[2].season = {tmdb:-2};
  const ranking = Array.from({length:15001}, (_, i) => i ? {node:{id:i+1, mean:8.06}} : {node:{id:1}});
  async function inputs(map, scores) {
    await Promise.all([writeFile(join(directory, 'anime-list-mini.json'), JSON.stringify(map)),
      writeFile(join(directory, 'ranking.json'), JSON.stringify(scores))]);
  }
  const run = () => spawnSync(process.execPath, [fileURLToPath(builder), output, directory], {encoding:'utf8'});
  await inputs(mapping, ranking);
  const success = run();
  assert.equal(success.status, 0, success.stderr);
  const previous = await readFile(output);
  const {shows, entryCount} = await readMalFile(new Blob([previous]));
  assert.equal(entryCount, 5001);
  assert.deepEqual(shows.get(20), [{season:1, offset:12, malId:2, score:8.06}]);
  assert.deepEqual(selectMalScores(shows.get(20)), {score:8.06, seasons:new Map([[1,[8.06]]])});
  assert.deepEqual(selectMalScores(shows.get(22)), {score:8.06, seasons:new Map()});
  // Simulate a disk that accepts the first few compressed bytes and then fills up.
  async function partialWrite() {
    const fs = (await import('node:fs')).default;
    const {syncBuiltinESMExports} = await import('node:module');
    const write = fs.writeFileSync;
    fs.writeFileSync = (path, bytes, options) => {
      write(path, bytes.subarray(0, 12), options);
      throw new Error('fictional disk full');
    };
    syncBuiltinESMExports();
    const job = process.argv[1];
    await import(job);
  }
  const interrupted = spawnSync(process.execPath, ['--input-type=module', '-e', '(' + partialWrite.toString() + ')()',
    builder.href, output, directory], {encoding:'utf8'});
  assert.notEqual(interrupted.status, 0);
  assert.match(interrupted.stderr, /fictional disk full/);
  assert.deepEqual(await readdir(directory).then(names => names.sort()), ['anime-list-mini.json', 'mal-ratings.csv.gz', 'ranking.json']);
  assert.ok(previous.equals(await readFile(output)), 'A partial write destroyed the previous ratings file');
  const occupied = output + '.fixture.tmp';
  await writeFile(occupied, 'another run');
  const fixedId = "import crypto from 'node:crypto'; import {syncBuiltinESMExports} from 'node:module'; crypto.randomUUID = () => 'fixture'; syncBuiltinESMExports();";
  const collision = spawnSync(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(fixedId),
    fileURLToPath(builder), output, directory], {encoding:'utf8'});
  assert.notEqual(collision.status, 0);
  assert.match(collision.stderr, /EEXIST/);
  assert.equal(await readFile(occupied, 'utf8'), 'another run');
  for (const [map, scores, reason] of [
    [mapping.slice(0,-1), ranking, /too few rows/],
    [mapping, ranking.slice(0,-1), /too few rows/],
    [mapping.map((row,i) => i > 4999 ? {} : row), ranking, /too few rows/],
    [mapping.map(row=>({...row,season:{tmdb:0}})), ranking, /only specials/],
    [mapping, [...ranking,{node:{id:2, mean:8.061}}], /invalid score/],
    [mapping, [...ranking,{node:{id:0, mean:8.25}}], /valid MyAnimeList ID/],
    [mapping, [...ranking,{node:{id:2, mean:8.07}}], /conflicting scores/],
    [mapping, [{node:{id:2, mean:8.07}},...ranking], /conflicting scores/],
  ]) {
    await inputs(map, scores);
    const failure = run();
    assert.notEqual(failure.status, 0);
    assert.match(failure.stderr, reason);
    assert.deepEqual(await readFile(output), previous);
  }
});

test('The daily job leaves the prior file in place after refused or exhausted requests and confines its Client ID to the ranking host', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'csvtv-mal-retry-'));
  t.after(() => rm(directory, {recursive:true, force:true}));
  const output = join(directory, 'mal-ratings.csv.gz');
  const previous = 'previous fictional file';
  await writeFile(output, previous);
  async function mockNetwork() {
    const assert = (await import('node:assert/strict')).default;
    const status = Number(process.argv[1]), path = process.argv[2], job = process.argv[3], retry = process.argv[4];
    const token = process.env.MAL_CLIENT_ID;
    let releases = 0;
    process.on('exit',()=>console.log('released '+releases));
    process.argv = [process.execPath, job, path];
    globalThis.setTimeout = (callback, ms) => { console.log('wait ' + ms); queueMicrotask(callback); };
    Date.now = () => Date.parse('2026-11-19T12:00:00Z');
    globalThis.fetch = async (address, options) => {
      assert.equal(options.redirect, 'error');
      const url = new URL(address), headers = new Headers(options.headers);
      if (url.hostname === 'raw.githubusercontent.com') {
        assert.deepEqual([...headers.keys()], []);
        return Response.json([]);
      }
      assert.equal(url.origin, 'https://api.myanimelist.net');
      assert.equal(headers.get('X-MAL-CLIENT-ID'), token);
      assert.ok(!address.includes(token));
      console.log('ranking request');
      const body = new ReadableStream({cancel() { releases++; return new Promise(()=>{}); }});
      return new Response(body, {status, headers:status===200 ? {'Content-Length':'2097153'} : retry ? {'Retry-After':retry} : {}});
    };
    await import(job);
  }
  for (const [status, count, retry, firstDelay] of [
    [200,1], [400,1], [401,1], [403,1], [502,4], [429,4,'12',12000], [503,4,'Thu, 19 Nov 2026 12:00:18 GMT',18000], [429,1,'3600'],
  ]) {
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', '('+mockNetwork.toString()+')()',
      String(status),output,builder.href,retry ?? ''], {encoding:'utf8', env:{...process.env,MAL_CLIENT_ID:'fictional-only-client'}});
    assert.notEqual(run.status, 0);
    assert.equal(run.stdout.match(/ranking request/g)?.length, count, run.stderr);
    if (firstDelay) assert.match(run.stdout, new RegExp('ranking request\\r?\\nwait ' + firstDelay + '\\r?\\nranking request'));
    assert.match(run.stdout,new RegExp('released ' + count));
    assert.match(run.stderr, status===200 ? /response exceeds its size limit/ : new RegExp('status ' + status));
    assert.ok(!run.stderr.includes('fictional-only-client'));
    assert.equal(await readFile(output, 'utf8'), previous);
  }
});

test('The scores job keeps the last output and input cache on partial or invalid replies and can retry offline', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'csvtv-mal-partial-'));
  t.after(() => rm(directory, {recursive:true,force:true}));
  const output = join(directory,'mal-ratings.csv.gz');
  await writeFile(output,'previous complete ranking');
  const mapping = join(directory,'anime-list-mini.json'), ranking = join(directory,'ranking.json');
  await writeFile(mapping,'["previous mapping"]');
  async function fixtureRanking() {
    const [job, output, directory, scenario] = process.argv.slice(1);
    process.argv = [process.execPath,job,output,directory];
    globalThis.setTimeout = callback => queueMicrotask(callback);
    globalThis.fetch = async address => {
      if (scenario === 'offline') throw Error('Unexpected network request');
      const url = new URL(address);
      if (url.hostname === 'raw.githubusercontent.com') return Response.json(
        Array.from({length:30000},(_,i) => ({mal_id:i+1,themoviedb_id:{tv:i+1}})));
      const offset = Number(url.searchParams.get('offset'));
      if (scenario === 'complete') {
        const length = Math.min(offset === 0 ? 497 : 500, Math.max(0, 15000 - offset));
        const data = Array.from({length}, (_,i) => ({node:{id:offset+i+1,mean:8.25}}));
        if (offset === 497) data[0].node.id = 497; // A ranking change can overlap adjacent pages.
        if (offset === 15000) data.push({node:{id:498,mean:8.25}});
        return Response.json({data});
      }
      if (scenario === 'encoding' && offset === 15000) {
        return new Response(Buffer.concat([Buffer.from('{"data":[],"'),Buffer.from([255]),Buffer.from('":true}')]));
      }
      if (scenario === 'malformed' && offset === 15000) return Response.json({data:[{ranking:{rank:15001}}]});
      if (scenario === 'malformed' && offset === 15001) return Response.json({data:[]});
      if (scenario === 'repeated' && offset === 15000) {
        return Response.json({data:[{node:{id:1,mean:8.25}},{node:{id:2,mean:8.25}}]});
      }
      if (scenario === 'repeated' && offset === 15002) return Response.json({data:[]});
      // Enough good rows to pass the publication floors before an incomplete reply looks like the end.
      if (scenario === 'race' && offset === 15000) {
        const {rename} = await import('node:fs/promises');
        const {join} = await import('node:path');
        await rename(join(directory,'other-ranking.json'),join(directory,'ranking.json'));
      }
      if (scenario === 'short' || offset === 15000) return Response.json({data:[]},{status:scenario === 'partial' ? 206 : 200});
      return Response.json({data:Array.from({length:500},(_,i) => ({node:{id:offset+i+1,mean:scenario === 'race' ? 6.25 : 8.25}}))});
    };
    await import(job);
  }
  const run = scenario => spawnSync(process.execPath,['--input-type=module','-e','('+fixtureRanking.toString()+')()',
    builder.href,output,directory,scenario],{encoding:'utf8',env:{...process.env,MAL_CLIENT_ID:'fictional-only-client'}});
  for (const [scenario,reason] of [['partial',/status 206/], ['short',/too few rows/], ['encoding',/UTF-8/i],
    ['malformed',/valid MyAnimeList ID/], ['repeated',/no new MyAnimeList IDs/]]) {
    const failed = run(scenario);
    assert.notEqual(failed.status,0);
    assert.match(failed.stderr,reason);
    assert.equal(await readFile(output,'utf8'),'previous complete ranking');
    assert.equal(await readFile(mapping,'utf8'),'["previous mapping"]');
    await assert.rejects(readFile(ranking),{code:'ENOENT'});
  }
  const pending = join(directory,'.csvtv-inputs-pending');
  await mkdir(pending);
  await writeFile(join(pending,'ranking.json'),'another writer');
  const concurrent = run('complete');
  assert.notEqual(concurrent.status,0);
  assert.match(concurrent.stderr,/pending writer/);
  assert.equal(await readFile(output,'utf8'),'previous complete ranking');
  assert.equal(await readFile(mapping,'utf8'),'["previous mapping"]');
  assert.equal(await readFile(join(pending,'ranking.json'),'utf8'),'another writer');
  await assert.rejects(readFile(ranking),{code:'ENOENT'});
  await rm(pending,{recursive:true});
  const result = run('complete');
  assert.equal(result.status,0,result.stderr);
  const complete = await readFile(output);
  assert.equal((await readMalFile(new Blob([complete]))).entryCount,15000);
  await rename(ranking,join(directory,'other-ranking.json'));
  const race = run('race');
  assert.notEqual(race.status,0);
  assert.match(race.stderr,/another builder completed the input cache/i);
  assert.deepEqual(await readFile(output),complete);
  assert.equal(run('offline').status,0);
  assert.deepEqual(await readFile(output),complete);
  const validMapping = await readFile(mapping);
  const corruptMapping = Buffer.from(validMapping);
  corruptMapping[corruptMapping.indexOf('themoviedb_id')] = 255;
  await writeFile(mapping,corruptMapping);
  const corrupt = run('offline');
  assert.notEqual(corrupt.status,0);
  assert.match(corrupt.stderr,/could not read cached anime-list-mini.json/);
  assert.deepEqual(await readFile(output),complete);
  await writeFile(mapping,validMapping);
  await writeFile(ranking,'[]'); // A rejected pair written by an older builder.
  const legacy = run('offline');
  assert.notEqual(legacy.status,0);
  assert.match(legacy.stderr,/move ranking\.json out of the cache directory/);
  assert.deepEqual(await readFile(output),complete);
});

test('The job bounds actual mapping and ranking bytes, withholds response text from logs and preserves the last snapshot', async t => {
  const directory = await mkdtemp(join(tmpdir(),'csvtv-mal-bounds-'));
  t.after(() => rm(directory,{recursive:true,force:true}));
  const output = join(directory,'mal-ratings.csv.gz');
  const previous = Buffer.from('last validated snapshot');
  await writeFile(output,previous);
  async function mockFetch() {
    const [job,out,mode] = process.argv.slice(1);
    process.argv = [process.execPath,job,out];
    globalThis.fetch = async (address,options) => {
      if (!options.signal) throw Error('The request lacks a deadline');
      const mapping = new URL(address).hostname === 'raw.githubusercontent.com';
      if (mapping && mode !== 'mapping-header') return Response.json([]);
      if (mode === 'ranking-text') return new Response('fictional-provider-diagnostic');
      if (mode === 'ranking-rows') return Response.json({data:Array(501).fill({})});
      if (mapping) return new Response('[]',{headers:{'Content-Length':String(16*1024*1024+1)}});
      return new Response(new ReadableStream({start(controller) {
        controller.enqueue(new Uint8Array(2*1024*1024));
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      }}),{headers:{'Content-Length':'2'}});
    };
    await import(job);
  }
  for (const [mode,message] of [['mapping-header',/size limit/],['ranking-bytes',/size limit/],
    ['ranking-text',/valid UTF-8 JSON/],['ranking-rows',/invalid page/]]) {
    const result = spawnSync(process.execPath,['--input-type=module','-e','('+mockFetch.toString()+')()',
      builder.href,output,mode],{encoding:'utf8',env:{...process.env,MAL_CLIENT_ID:'fictional-test-header'}});
    assert.notEqual(result.status,0);
    assert.match(result.stderr,message);
    assert.doesNotMatch(result.stderr,/fictional-provider-diagnostic|fictional-test-header/);
    assert.deepEqual(await readFile(output),previous);
  }
});
