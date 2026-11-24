import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { readMalFile, selectMalScores } from '../src/mal-file.ts';

const header = 'show,season,offset,mal_id,score';
const blob = data => new Blob([gzipSync(data)]);
const seasonList = (...seasons) => seasons.map(season => ({season}));

test('The first eligible regular entry is the show score, and season rows keep each score in offset and ID order', async () => {
  const rows = [
    '42,,0,1,9.97', '42,0,,2,9.96', '42,1,,3,9.95', '42,3,,4,9.94',
    '42,2,99,7,7.9', '42,2,4,12,8.04', '42,2,4,11,7.1', '42,2,,14,8.12', '42,2,0,13,8',
  ];
  for (const lines of [rows, [...rows].reverse()]) {
    const index = await readMalFile(blob([header, ...lines].join('\r\n')));
    assert.equal(index.entryCount, rows.length);
    assert.deepEqual(selectMalScores(index.shows.get(42), seasonList(0,2,3,4)), {
      score:8, seasons:new Map([[2,[8,8.12,7.1,8.04,7.9]], [3,[9.94]]]),
    });
    // A search result can be scored before opening or downloading the show.
    assert.equal(selectMalScores(index.shows.get(42)).score, 9.95);
  }
});

test('Missing regular seasons fall back to the lowest unseasoned MyAnimeList ID, and specials alone give no score', async () => {
  const {shows} = await readMalFile(blob([header, '8,,0,10,2', '8,,99,4,9.06',
    '8,0,1,1,7.21', '8,7,,11,8.75', '9,0,0,22,10.00'].join('\n') + '\n'));
  for (const known of [seasonList(), seasonList(1,2)]) {
    assert.deepEqual(selectMalScores(shows.get(8), known), {score:9.06,seasons:new Map()});
  }
  assert.deepEqual(selectMalScores(shows.get(9)), {score:null,seasons:new Map()});
  assert.deepEqual(selectMalScores(shows.get(10)), {score:null,seasons:new Map()});
});

test('An empty offset and an explicit zero for the same MAL entry display its score once', async () => {
  const rows = ['42,1,,12,8.25','42,1,0,12,8.25','42,1,0,13,8.25','42,1,6,12,8.25'];
  for (const records of [rows, [...rows].reverse()]) {
    const {shows} = await readMalFile(blob([header,...records].join('\n')));
    assert.deepEqual(selectMalScores(shows.get(42),seasonList(1)), {score:8.25,seasons:new Map([[1,[8.25,8.25,8.25]]])});
    for (const contradictory of ['42,1,0,12,8.26','99,3,,12,8.26']) {
      await assert.rejects(readMalFile(blob([header,...records,contradictory].join('\n'))), /invalid or incomplete/);
    }
  }
});

test('The entire compressed file is validated, including unrelated shows, row precision, UTF-8 and the gzip trailer', async () => {
  const csv = header + '\n1001,1,,14,8.66\n';
  const damaged = gzipSync(csv);
  damaged[damaged.length - 8] ^= 1;
  const large = await readMalFile(blob(header + '\n' + Array.from({length:6000}, (_, i) => (i+1) + ',1,,14,8.66').join('\n')));
  assert.equal(large.entryCount, 6000);
  assert.deepEqual(large.shows.get(6000), [{season:1,offset:0,malId:14,score:8.66}]);
  for (const invalid of ['',header,'other,header\n1,1,0,2,7',
    ...['0,1,,1,8','1,-1,,1,7','1,1,-1,1,7','1,1,,0,8','1,1,,2,','1,1,,2,10.01','1,1,,2,8.649',
      '1,1,,2,8.5,9','1,1,,2,7e0','1,1,9007199254740992,2,8','1,1,,9007199254740992,8',
      '9'.repeat(100_000)].map(row => csv + row)]) {
    await assert.rejects(readMalFile(blob(invalid)), /invalid or incomplete/);
  }
  for (const data of [damaged, gzipSync(csv).subarray(0,-1), Buffer.from(csv), gzipSync(Buffer.from([0xff,0xfe]))]) {
    await assert.rejects(readMalFile(new Blob([data])), /invalid or incomplete/);
  }
});
