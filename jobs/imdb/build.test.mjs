import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { appendFile, mkdtemp, readFile, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createGzip, gunzipSync, gzipSync } from 'node:zlib';
import { readTable } from './build.mjs';

const builder = fileURLToPath(new URL('./build.mjs', import.meta.url));
const ratingsHeader = 'tconst\taverageRating\tnumVotes';
const episodesHeader = 'tconst\tparentTconst\tseasonNumber\tepisodeNumber';
const tt = n => 'tt' + String(n).padStart(7, '0');

test('the TSV reader enforces actual compressed, decoded, per-line and row limits', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'csvtv-tsv-limits-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'fictional.tsv.gz');
  const text = 'id\tvalue\r\n1\t0\r\n2\t1';
  const bytes = gzipSync(text);
  await writeFile(path, bytes);
  const exact = { compressed: bytes.length, decoded: text.length, line: 8, rows: 2 };
  const rows = [];
  await readTable(path, 'id\tvalue', exact, row => rows.push(row));
  assert.deepEqual(rows, [['1','0'],['2','1']]);
  for (const [name, reason] of [['compressed',/compressed input/],['decoded',/decoded input/],
    ['line',/line exceeds/],['rows',/row limit/]]) {
    await assert.rejects(readTable(path, 'id\tvalue', {...exact,[name]:exact[name] - 1}, () => {}), reason);
  }
  // End a gunzip chunk with CR and begin the next chunk with LF.
  const boundary = 'id\n' + '1\n'.repeat(8189) + '22\r\n3';
  await writeFile(path, gzipSync(boundary));
  const ids = [];
  await readTable(path, 'id', {compressed:1024, decoded:boundary.length, line:2, rows:8191}, ([id]) => ids.push(id));
  assert.equal(ids.length, 8191);
  assert.deepEqual(ids.slice(-2), ['22','3']);
});

async function* table(header, count, row) {
  yield header + '\n';
  for (let start = 0; start < count; start += 8192) {
    let chunk = '';
    for (let i = start; i < Math.min(start + 8192, count); i++) chunk += row(i) + '\n';
    yield chunk;
  }
}

test('publish only validated full-size input, leaving the previous output on error', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'csvtv-imdb-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ratings = join(dir, 'title.ratings.tsv.gz');
  const episodes = join(dir, 'title.episode.tsv.gz');
  const output = join(dir, 'ratings.csv.gz');
  const run = () => spawnSync(process.execPath, [builder, dir, output], { encoding: 'utf8' });
  async function writeEpisodes(reverse,parent=1) {
    await pipeline(table(episodesHeader,500_002,i => {
      const position = i + 1, ids = [i + 2];
      if (position === 12) ids.push(999998); // A second ID has the same numeric score.
      if (position === 13) ids.push(999997,999996); // Two 7.5s and a 6.0 cannot identify one episode score.
      if (position === 19) ids.push(999995);
      if (position === 20) ids.push(999994);
      if (reverse) ids.reverse();
      return ids.map(id=>[tt(id),tt(parent),0,position].join('\t')).join('\n');
    }),createGzip({level:1}),createWriteStream(episodes));
    // IMDb can omit a position. The parent may still supply a show rating.
    await appendFile(episodes,gzipSync('tt0999999\t'+tt(parent)+'\t\\N\t\\N\n'));
  }
  const fixtureRatings = new Map([[999998,'7.50'],[999997,'6.0'],[20,'7.0000000000000001'],
    [999995,'7.0000000000000002'],[21,'7.0000000000000001'],[999994,'7.00000000000000010'],[999993,'6.5']]);
  await Promise.all([
    pipeline(table(ratingsHeader, 1_000_000, i => tt(i+1) + '\t' + (fixtureRatings.get(i+1) ?? '7.5') + '\t20'),
      createGzip({ level: 1 }), createWriteStream(ratings)),
    writeEpisodes(false),
  ]);
  const success = run();
  assert.equal(success.status, 0, success.stderr);
  const good = await readFile(output);
  const csv = gunzipSync(good).toString();
  assert.ok(csv.startsWith('show,season,episode,rating\n1,,,7.5\n1,0,1,7.5\n'));
  assert.ok(csv.endsWith('1,0,500002,7.5\n'));
  assert.equal(csv.split('\n').length,500_003); // One series, exactly 500,000 resolved episode scores.
  assert.deepEqual(csv.match(/^1,0,12,[\d.]+$/gm),['1,0,12,7.5']);
  assert.doesNotMatch(csv,/^1,0,13,/m);
  assert.match(csv,/^1,0,14,7\.5$/m);
  assert.doesNotMatch(csv,/^1,0,19,/m);
  assert.match(csv,/^1,0,20,7\.0000000000000001$/m);
  await writeEpisodes(false,1_000_001);
  const noSeries = run();
  assert.notEqual(noSeries.status,0);
  assert.match(noSeries.stderr,/no rated series/);
  assert.deepEqual(await readFile(output),good);
  await writeEpisodes(true);
  const reversed = run();
  assert.equal(reversed.status,0,reversed.stderr);
  assert.deepEqual(await readFile(output),good,'Conflicting input order changed the published file');

  const occupied = output + '.fixture.tmp';
  await writeFile(occupied, 'another run');
  const fixedId = "import crypto from 'node:crypto'; import {syncBuiltinESMExports} from 'node:module'; crypto.randomUUID = () => 'fixture'; syncBuiltinESMExports();";
  const collision = spawnSync(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(fixedId),
    builder, dir, output], {encoding:'utf8'});
  assert.notEqual(collision.status, 0);
  assert.match(collision.stderr, /EEXIST/);
  assert.equal(await readFile(occupied, 'utf8'), 'another run');

  const originalSize = (await stat(episodes)).size;
  await appendFile(episodes,gzipSync(tt(999993)+'\t'+tt(1)+'\t0\t1\n'));
  const justUnder = run();
  assert.notEqual(justUnder.status,0);
  assert.match(justUnder.stderr,/too few resolved episode scores: 499999/);
  assert.deepEqual(await readFile(output),good);
  await truncate(episodes,originalSize);
  for (const extra of ['tt0000002\ttt0000001\t0\t1\n','tt0000002\ttt0000003\t1\t5\n']) {
    await appendFile(episodes, gzipSync(extra));
    const duplicate = run();
    assert.notEqual(duplicate.status, 0);
    assert.match(duplicate.stderr, /duplicate rated episode ID/);
    assert.deepEqual(await readFile(output), good);
    await truncate(episodes, originalSize);
  }

  // Keep the valid-size input in the failure case: the row floor alone passes.
  await appendFile(episodes, gzipSync('tt0000002\ttt0000001\t0\n'));
  const broken = run();
  assert.notEqual(broken.status, 0);
  assert.match(broken.stderr, /unexpected field count/);
  assert.deepEqual(await readFile(output), good);

  await pipeline(table(episodesHeader,500_000,i=>[tt(i+2),tt(1),1,1].join('\t')),
    createGzip({level:1}),createWriteStream(episodes));
  const collapsed = run();
  assert.notEqual(collapsed.status,0);
  assert.match(collapsed.stderr,/too few resolved episode scores: 0 from 500000/);
  assert.deepEqual(await readFile(output),good);

  await writeFile(ratings, gzipSync(ratingsHeader + '\ntt0000001\t7\t' + '0'.repeat(256) + '\n'));
  const longRow = run();
  assert.notEqual(longRow.status, 0);
  assert.match(longRow.stderr, /line exceeds/);
  assert.deepEqual(await readFile(output), good);

  // Each invalid field fails before the volume check, even if its row is unrated.
  for (const [file, header, row, reason] of [
    [ratings, ratingsHeader, 'xx0000001\t7.5\t20', /invalid title ID/],
    [ratings, ratingsHeader, 'tt0000001\t10.0000000000000001\t20', /rating must be/],
    [ratings, ratingsHeader, 'tt0000001\tunknown\t20', /rating must be/],
    [ratings, ratingsHeader, 'tt0000001\t7.5\t1e3', /invalid vote count/],
    [episodes, episodesHeader, 'tt0000002\ttt0000001\t1\t', /invalid episode number/],
    [episodes, episodesHeader, 'tt0000002\ttt0000001\t-1\t1', /invalid season number/],
  ]) {
    if (file === episodes) await writeFile(ratings, gzipSync(ratingsHeader + '\ntt0000001\t10.0\t1\n'));
    await writeFile(file, gzipSync(header + '\n' + row + '\n'));
    const result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, reason);
  }
  await writeFile(ratings, gzipSync(ratingsHeader + '\ntt0000001\t10\t1\n').subarray(0, -4));
  const truncated = run();
  assert.notEqual(truncated.status, 0);
  assert.match(truncated.stderr, /unexpected end/i);
  assert.deepEqual(await readFile(output), good);
});
