import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { ImdbGithubClient, ImdbGithubError, validGithubRepo } from '../dist/imdb-github.js';
import { readImdbEpisodes, readImdbShows } from '../dist/imdb-file.js';
import { GithubFileRefresh } from '../src/github-file-refresh.ts';
import { readRatingsCsv, RatingsFileLimitError, RatingsIndexBusyError, ratingsFileLimits } from '../dist/ratings-csv.js';
import { GithubRatingsClient } from '../dist/github-ratings-client.js';

const header = 'show,season,episode,rating';
const lines = [header, '12,,,8.2', '17,1,5,7', '12,0,1,6.4', '12,1,1,5', '12,1,1,9.1', '90,,,10'];
const zipped = gzipSync(lines.join('\n') + '\n');
const repo = 'sample-owner/ratings_repo';
const token = 'fictional-repository-credential';
const clientFor = (send, options) => new ImdbGithubClient({fetch:send, ...options});

test('An overloaded or canceled score reader preserves the prior file and reports its actual status',async () => {
  for (const [error,kind] of [[new RatingsIndexBusyError(),'busy'],[new DOMException('View closed','AbortError'),'superseded']]) {
    let reads=0;
    const client=new GithubRatingsClient('imdb',async()=>{reads++; throw error;},{fetch:async()=>new Response(zipped)});
    await assert.rejects(client.download(repo,token,async()=>true,'previous-digest'),{kind});
    assert.equal(reads,1);
  }
});

test('An installed ratings digest reuses its validated index and a different digest still requires a complete valid gzip', async () => {
  let body = zipped, parses = 0;
  const client = new GithubRatingsClient('imdb',file => { parses++; return readImdbShows(file); },
    {fetch:async () => new Response(body)});
  const download = digest => client.download(repo,token,async () => true,digest);
  const first = await download();
  assert.equal(first.shows.get(12),8.2);
  assert.deepEqual(await download(first.digest),{digest:first.digest,unchanged:true});
  assert.equal(parses,1);
  body = gzipSync(header+'\n12,,,7.5\nnot a rating\n');
  await assert.rejects(download(first.digest),{kind:'invalid-file'});
  body = gzipSync(header+'\n12,,,7.5\n');
  const changed = await download(first.digest);
  assert.notEqual(changed.digest,first.digest);
  assert.equal(changed.shows.get(12),7.5);
  assert.equal(parses,3);
});

test('Job CSVs admit the exact compressed, decoded-byte and row limits, including a final row without a newline', async () => {
  const csv = header + '\n12,,,8\n14,,,7';
  const file = new Blob([gzipSync(csv)]);
  const limits = {compressedBytes:file.size, decodedBytes:Buffer.byteLength(csv), rows:2};
  const parse = async bounds => {
    const rows = [];
    await readRatingsCsv(file,header,bounds,() => Error('invalid CSV'),row => rows.push(row));
    return rows;
  };
  assert.deepEqual(await parse(limits), ['12,,,8','14,,,7']);
  for (const key of Object.keys(limits)) {
    await assert.rejects(parse({...limits,[key]:limits[key]-1}), RatingsFileLimitError);
  }
});

test('A buffered ratings file lets a pending page task run before the last row', async t => {
  // Feed one decoded chunk so unrelated I/O cannot give the task a turn.
  const count = 16_384;
  const chunk = new TextEncoder().encode(header + '\n' + '12,,,8\n'.repeat(count));
  const decoded = new ReadableStream({start(controller) { controller.enqueue(chunk); controller.close(); }});
  const file = {size:1, stream:() => ({pipeThrough:() => decoded})};
  let elapsed = 0, rows = 0, rowsAtTask;
  t.mock.method(performance,'now',() => elapsed += 15);
  const task = new MessageChannel();
  t.after(() => {task.port1.close(); task.port2.close();});
  task.port1.onmessage = () => { rowsAtTask = rows; };
  await readRatingsCsv(file,header,ratingsFileLimits.imdb,() => Error('invalid CSV'),() => {
    if (++rows === 1) task.port2.postMessage(null);
  });
  assert.equal(rows,count);
  assert.ok(rowsAtTask > 0 && rowsAtTask < count);
});

test('GitHub score downloads enforce the compressed limit from both headers and actual streamed bytes', async () => {
  const limit = ratingsFileLimits.mal.compressedBytes;
  let parsed = false;
  for (const length of [String(limit+1), null, '1']) {
    const client = new GithubRatingsClient('mal',async () => { parsed = true; return {}; }, {
      fetch:async () => new Response(new ReadableStream({
        start(controller) {
          if (length !== String(limit+1)) {
            controller.enqueue(new Uint8Array(limit));
            controller.enqueue(new Uint8Array(1));
          }
          controller.close();
        },
      }), {headers:length === null ? {} : {'Content-Length':length}}),
    });
    await assert.rejects(client.download(repo,token), {kind:'file-too-large'});
  }
  assert.equal(parsed,false);
});

test('manual GitHub refresh takes precedence when another ratings job already occupies the shared download queue', async () => {
  for (const pause of [null, {kind:'refused',until:null}, {kind:'throttled',until:200}]) {
    let calls = 0;
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    const state = {generation:1n, githubGeneration:1n, config:{github_repo:repo,github_token:token},
      file:{digest:'A',fetchedAt:100,firstAt:100}, githubPause:null, needsFile:false};
    const options = {store:{role:'writer'}, environment:{now:()=>100, online:()=>true, visible:()=>true},
      state:async()=>state, enabled:()=>true, active:()=>true, save:async()=>true};
    const first = new GithubFileRefresh({...options, download:async()=>{
      entered.resolve(); await release.promise; return {digest:'A'};
    }});
    const second = new GithubFileRefresh({...options, state:async()=>({...state,githubPause:pause}),
      download:async()=>{ calls++; return {digest:'B'}; }});
    const held = first.refresh(true);
    await entered.promise;
    const automatic = second.refresh(), manual = second.refresh(true), repeated = second.refresh(true);
    release.resolve();
    await Promise.all([held,automatic,manual,repeated]);
    assert.equal(calls, pause?.kind === 'throttled' ? 0 : 1);
  }
});

test('GitHub scores respect the requesting job through parsing and the final cache write',async()=>{
  for(const [when,force,disconnect,expected] of [
    ['parse',false,false,false],['write',false,false,false],['write',true,false,true],['write',true,true,false],
  ]){
    const entered=Promise.withResolvers(),release=Promise.withResolvers();
    let online=true,visible=true,accepted=false;
    const state={generation:1n,githubGeneration:1n,config:{github_repo:repo,github_token:token},file:null,githubPause:null,needsFile:true};
    const client=new GithubRatingsClient('imdb',async file=>{
      if(when==='parse'){entered.resolve();await release.promise;}
      return readImdbShows(file);
    },{fetch:async()=>new Response(zipped)});
    const service=new GithubFileRefresh({store:{role:'writer'},environment:{now:()=>100,online:()=>online,visible:()=>visible},
      state:async()=>state,enabled:()=>true,active:()=>true,download:(...args)=>client.download(...args),
      save:async(_state,_update,current,_quota,data)=>{
        if(when==='write'){entered.resolve();await release.promise;}
        if(current()&&data?.shows.has(12))accepted=true;
        return accepted;
      }});
    const request=service.refresh(force);
    await entered.promise;
    if(disconnect)online=false;else visible=false;
    release.resolve();await request;
    assert.equal(accepted,expected,'Interrupted during '+when+' (force '+force+', offline '+disconnect+')');
  }
});

test('The streamed job file indexes shows and leaves a conflicting episode position unrated', async () => {
  // Compare against a whole-file reference while the production reader crosses many inflate chunks.
  const input = [header];
  for (let id = 1; id <= 120; id++) {
    input.push(id + ',,,8.1');
    for (let number = 1; number <= 35; number++) input.push(id + ',1,' + number + ',5.5');
  }
  input.push('12,0,1,2', '12,1,1,9', '12,,,7.4');
  const csv = input.join('\r\n');
  const all = csv.split('\r\n').slice(1).map(line => line.split(','));
  const expectedShows = new Map(all.filter(row => !row[1]).map(([show,,,score]) => [Number(show), Number(score)]));
  const expectedSeason = new Map(all.filter(row => row[0] === '12' && row[1] === '1')
    .map(([,,episode,score]) => [Number(episode), Number(score)]));
  expectedSeason.delete(1); // The original 5.5 and appended 9 refer to the same position.
  const file = new Blob([gzipSync(csv)]);
  assert.deepEqual(await readImdbShows(file), {shows:expectedShows, episodeCount:4202});
  assert.deepEqual(await readImdbEpisodes(file, 12), new Map([[1, expectedSeason],[0, new Map([[1,2]])]]));
  assert.deepEqual(await readImdbEpisodes(file, 555), new Map());
});

test('A disputed IMDb episode stays unrated in every input order and equal scores survive', async () => {
  for (const values of [[6,8,6],[8,6,8],[6,6,8],[8,8,6],[8,6,6],[6,8,8]]) {
    const file = new Blob([gzipSync([header,'12,,,8.0','13,1,12,4','12,0,12,2.1','12,2,12,4.9',
      ...values.flatMap(value=>['12,1,12,'+value,'12,1,13,7.5','12,1,13,7.50'])].join('\n'))]);
    const scores = await readImdbEpisodes(file,12);
    assert.deepEqual(scores.get(1),new Map([[13,7.5]]));
    assert.equal(scores.get(0).get(12),2.1);
    assert.equal(scores.get(2).get(12),4.9);
    assert.equal((await readImdbEpisodes(file,13)).get(1).get(12),4);
    assert.equal((await readImdbShows(file)).shows.get(12),8);
  }
  const precise = new Blob([gzipSync([header,'12,1,1,7.0000000000000001','12,1,1,7.0000000000000002',
    '12,1,2,7.00000000000000010','12,1,2,7.0000000000000001'].join('\n'))]);
  assert.deepEqual((await readImdbEpisodes(precise,12)).get(1),new Map([[2,7]]));
});

test('Partial gzip streams, malformed UTF-8, invalid CSV and an invalid row after a desired show all reject the file', async () => {
  const damaged = Buffer.from(zipped);
  damaged[damaged.length - 8] ^= 1;
  const bad = ['', header, 'wrong,header\n12,,,7', header + '\n1,,3,6', header + '\n1,0,,6',
    header + '\n1,2,1,10.9', header + '\n1,2,-1,8', header + '\n0,,,7', header + '\n1,2,3,8,extra',
    header + '\n9007199254740992,,,7', header + '\n1,9007199254740992,1,8',
    lines.join('\n') + '\n999,4,5,no', header + '\n' + '9'.repeat(100_000),
    header + '\n' + '0'.repeat(65_532) + '1,,,8\n'].map(csv => gzipSync(csv));
  for (const end of ['\n','\r\n','']) {
    const atLimit = new Blob([gzipSync(header + '\n' + '0'.repeat(65_531) + '1,,,8' + end)]);
    assert.equal((await readImdbShows(atLimit)).shows.get(1),8);
  }
  bad.push(damaged, zipped.subarray(0,-1), Buffer.from('not gzip'), gzipSync(Buffer.from([0xff,0xfe,0xff])));
  for (const bytes of bad) {
    const file = new Blob([bytes]);
    await assert.rejects(readImdbShows(file), /invalid or incomplete/);
    await assert.rejects(readImdbEpisodes(file, 12), /invalid or incomplete/);
  }
});

test('GitHub fetches the exact raw data branch file with its token in the header, validates it and preserves the original gzip', async () => {
  let calls = 0;
  const client = clientFor(async (url, init) => {
    calls++;
    assert.equal(String(url), 'https://api.github.com/repos/sample-owner/ratings_repo/contents/imdb-ratings.csv.gz?ref=data');
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'error');
    assert.equal(init.referrerPolicy, 'no-referrer');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.cache, 'no-store');
    assert.deepEqual(Object.fromEntries(new Headers(init.headers)), {
      accept:'application/vnd.github.raw+json', authorization:'Bearer ' + token,
    });
    return new Response(new ReadableStream({start(controller) {
      for (let i = 0; i < zipped.length; i += 5) controller.enqueue(zipped.subarray(i, i + 5));
      controller.close();
    }}));
  });
  const result = await client.download(repo, token);
  assert.equal(calls, 1);
  assert.deepEqual(Buffer.from(await result.file.arrayBuffer()), zipped);
  assert.deepEqual(Buffer.from(result.bytes), zipped);
  assert.equal(result.digest, createHash('sha256').update(zipped).digest('hex'));
  assert.equal(result.episodeCount, 4);
  assert.deepEqual(result.shows, new Map([[12,8.2],[90,10]]));
  for (const repository of ['https://evil.test/file','owner/..','./ratings','a/b/c','a/%2f','a/b?q=1','a/b\n','a b/c','a/']) {
    assert.equal(validGithubRepo(repository), false);
    await assert.rejects(client.download(repository, token), {kind:'configuration'});
  }
  await assert.rejects(client.download(repo, token + '\nvalue'), {kind:'configuration'});
  assert.equal(calls, 1);
});

test('GitHub distinguishes 401, missing files, invalid files and denied requests without disclosing upstream content', async () => {
  let response;
  const client = clientFor(() => Promise.resolve(response));
  const download = () => client.download(repo, token);
  for (const [kind, status] of [['refused',401], ['http',404], ['http',403], ['invalid-file',200], ['http',206]]) {
    response = Response.json({message:'message containing ' + token}, {status,headers:{'X-RateLimit-Remaining':'1200'}});
    await assert.rejects(download(), error => error instanceof ImdbGithubError && error.kind === kind &&
      error.status === status && !error.message.includes(token));
  }
});

test('GitHub reads primary and secondary deadlines, applies the fallback and still reports a late refusal after visibility changes', async () => {
  const now = Date.UTC(2026, 10, 18);
  const reset = String((now + 120_000) / 1000);
  let response, active = true;
  const client = clientFor(async () => { active = false; return response; }, {now:() => now});
  for (const [status, message, headers, delay] of [
    [403, 'Primary rate limit exceeded', {'X-RateLimit-Remaining':'0','X-RateLimit-Reset':reset,'Retry-After':'15'}, 120_000],
    [403, '', {'X-RateLimit-Remaining':'000','X-RateLimit-Reset':reset}, 120_000],
    [403, 'Secondary rate limit', {'X-RateLimit-Remaining':'900','X-RateLimit-Reset':reset}, 60_000],
    [429, '', {'Retry-After':new Date(now + 300_000).toUTCString()}, 300_000],
    [429, '', {'Retry-After':'15'}, 15_000],
    [503, '', {'Retry-After':'90','X-RateLimit-Reset':reset}, 90_000],
    [429, '', {}, 60_000],
  ]) {
    active = true;
    response = Response.json({message}, {status, headers});
    await assert.rejects(client.download(repo, token, async () => active), {kind:'throttled', retryAt:now + delay, status});
  }
  active = true;
  response = new Response(null, {status:401});
  await assert.rejects(client.download(repo, token, async () => active), {kind:'refused', status:401});
});

test('GitHub retries transient server failures with bounded backoff, stops obsolete retries and aborts a stalled file', async () => {
  let calls = 0, active = true;
  const waits = [];
  const client = clientFor(async () => { calls++; return new Response(null, {status:502}); },
    {sleep:async ms => { waits.push(ms); if (calls > 5) active = false; }});
  await assert.rejects(client.download(repo, token), {kind:'http', status:502});
  assert.equal(calls, 5);
  assert.deepEqual(waits, [1000,2000,4000,8000]);
  await assert.rejects(client.download(repo, token, async () => active), {kind:'superseded'});
  assert.equal(calls, 6);
  for (const retiresAt of [1, 5]) {
    const obsoleteWaits = [];
    let attempts = 0;
    const obsolete = clientFor(async () => { attempts++; return new Response(null, {status:503}); },
      {sleep:async delay => { obsoleteWaits.push(delay); }});
    await assert.rejects(obsolete.download(repo, token, async () => attempts < retiresAt), {kind:'superseded'});
    assert.deepEqual(obsoleteWaits, [1000, 2000, 4000, 8000].slice(0, retiresAt - 1));
  }
  let signal;
  const stalled = clientFor(async (_,init) => {
    signal = init.signal;
    return new Response(new ReadableStream({start(controller) { controller.enqueue(zipped.subarray(0,5)); }}));
  }, {inactivityMs:20});
  await assert.rejects(stalled.download(repo, token), {kind:'unreachable'});
  assert.equal(signal.aborted, true);
});
