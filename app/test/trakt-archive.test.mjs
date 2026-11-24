import test from 'node:test';
import assert from 'node:assert/strict';
import { readTraktArchive } from '../dist/trakt-archive.js';
import { traktMemberZip, traktZip } from './trakt-fixture-cases.mjs';

const show = { title: 'Tide Signal', ids: { trakt: 21, tmdb: 41, tvdb: 61, imdb: 'tt8100001' } };
const episode = { title: 'First Light', season: 0, number: 2, ids: { trakt: 31, tvdb: 71, imdb: 'tt8100002' } };
const play = { type: 'episode', show, episode, action: 'watch', watched_at: '2020-01-03T04:05:00Z' };
const movie = { type: 'movie', movie: { title: 'Fictional Film', ids: { tmdb: 41 } } };

test('A deflated export reads every history page, totals, show ratings and favourites, and discards unrelated account data', async () => {
  const archive = await readTraktArchive(await traktZip({
    'watched-history-2.json': [play, movie],
    'watched-history-1.json': [play],
    'watched-shows.json': [{ plays: 6, show }],
    'ratings-shows.json': [{ type: 'show', rating: 8, show }, movie],
    'lists-favorites.json': [{ rank: 1, type: 'show', show }, movie],
    'lists-watchlist.json': [],
    'user-settings.json': ['private fictional notes'],
  }));
  assert.deepEqual(archive.history, Array.from({ length: 2 }, () => ({
    show, episode: { ...episode, ids: { ...episode.ids, tmdb: null } },
  })));
  assert.deepEqual(archive.totals, [{ plays: 6, show }]);
  assert.deepEqual(archive.ratings, [{ rating: 8, show }]);
  assert.deepEqual(archive.favourites, [show]);
  assert.deepEqual(archive.watchlist, []);
  assert.deepEqual(archive.issues, []);
  assert.doesNotMatch(JSON.stringify(archive), /watched_at|private fictional notes|2020-01/);
});

test('A partial export reads stored and ZIP64 members, permits empty supported lists, and ignores unreadable unrelated files', async () => {
  for (const options of [{ level: 0 }, { zip64: true }]) {
    const zip = await traktMemberZip({ 'user-settings.json': 'not JSON', 'watched-history-0.json': 'not JSON',
      'hidden/ratings-shows.json': 'not JSON', 'lists-watchlist.json': '[]' }, options);
    assert.deepEqual(await readTraktArchive(zip), { history: [], totals: [], ratings: [], favourites: [], watchlist: [], issues: [] });
  }
});

test('A missing numbered history page is reported once while all available pages still import', async () => {
  const page = n => 'watched-history-' + n + '.json';
  for (const [pages,missing] of [[[3,1],2],[[9,4],1],[[1,2,4,6],3],[[4,3,1,2],null]]) {
    const archive = await readTraktArchive(await traktZip(Object.fromEntries(pages.map(n=>[page(n),[play]]))));
    assert.equal(archive.history.length,pages.length);
    assert.deepEqual(archive.issues,missing ? ['History page ' + missing + ' is missing from the Trakt ZIP. Play counts use the pages present.'] : []);
  }
});

test('Overlapping pages count distinct events even for one episode in the same minute, including adjacent 64-bit IDs', async () => {
  const raw = (id, row = play) => JSON.stringify({...row,id:'EVENT'}).replace('"EVENT"', id);
  const first = '9223372036854775806', second = '9223372036854775807';
  const third = {...play,episode:{...episode,number:3}};
  const pages = {
    'watched-history-1.json':'[' + [raw(first),raw(second),raw('42'),raw('33')].join(',') + ']',
    'watched-history-2.json':'[' + [raw(first,{...play,episode:{...episode,ids:{...episode.ids,tmdb:991}}}),
      raw('42',third),raw('"33"'),raw('44'),JSON.stringify(play)].join(',') + ']',
  };
  for (const members of [pages,Object.fromEntries(Object.entries(pages).reverse())]) {
    const archive = await readTraktArchive(await traktMemberZip(members));
    assert.equal(archive.history.length,5);
    assert.ok(archive.history.every(row => row.episode.number === episode.number));
    assert.equal(archive.history.filter(row => row.episode.ids.tmdb === 991).length,1);
    assert.deepEqual(archive.issues,['Skipped conflicting history event IDs: 1.','Ignored repeated history rows with the same event ID: 3.']);
    assert.doesNotMatch(JSON.stringify(archive),/922337203685477580|2020-01/);
  }
});

test('Small and large Trakt ZIPs produce the same items with bounded compressed reads', async () => {
  const items = {'watched-history-1.json':[play],'ratings-shows.json':[{type:'show',show,rating:8}]};
  const small = await traktZip(items);
  const padded = length => traktZip({...items,'unused.json':'a'.repeat(length)},{level:0});
  const padding = 2 * 1024 * 1024 - (await padded(0)).size;
  const boundary=await padded(padding), large=await padded(padding+1);
  assert.equal(boundary.size,2*1024*1024);
  assert.equal(large.size,boundary.size+1);
  let sampled=0, slices=0;
  class MeasuredFile extends Blob {
    arrayBuffer() { sampled++; return super.arrayBuffer(); }
    slice(...args) { slices++; return super.slice(...args); }
  }
  const result=await readTraktArchive(new MeasuredFile([small]));
  assert.equal(sampled,1,'Read the compressed bytes of a small selection once');
  assert.equal(slices,0,'Reading every small ZIP member should reuse that buffer');
  assert.deepEqual(await readTraktArchive(new MeasuredFile([boundary])),result);
  assert.equal(sampled,2);
  assert.equal(slices,0);
  assert.deepEqual(await readTraktArchive(new MeasuredFile([large])),result);
  assert.equal(sampled,2,'A large selection should keep using bounded slices');
  assert.ok(slices>0);
});

test('Canceling a pending small ZIP read preserves the reason before parsing', async () => {
  const file=await traktZip({'watched-history-1.json':[play]});
  const controller=new AbortController(),started=Promise.withResolvers(),release=Promise.withResolvers();
  class HeldFile extends Blob {
    async arrayBuffer(){ started.resolve(); await release.promise; return super.arrayBuffer(); }
  }
  const reading=readTraktArchive(new HeldFile([file]),controller.signal);
  await started.promise;
  const reason=new DOMException('Selection replaced','AbortError');
  controller.abort(reason);release.resolve();
  await assert.rejects(reading,error=>error===reason);
  class UnavailableFile extends Blob { async arrayBuffer() { throw Error('Private file detail'); } }
  class IncompleteFile extends Blob { async arrayBuffer() { return new ArrayBuffer(this.size-1); } }
  for (const Broken of [UnavailableFile,IncompleteFile]) {
    await assert.rejects(readTraktArchive(new Broken([file])),{message:'Could not read this Trakt export. Choose the ZIP downloaded from Trakt.'});
  }
});

test('Canceling while the browser streams a large ZIP stops before the next history page', async () => {
  const file = await traktZip({ 'watched-history-1.json': [play], 'watched-history-2.json': [play],
    'unused.json':'a'.repeat(2*1024*1024) },{level:0});
  const controller = new AbortController();
  const reason = new DOMException('Selection replaced', 'AbortError');
  let sliced = false;
  class InterruptedFile extends Blob {
    slice(...args) {
      if (!sliced) { sliced = true; controller.abort(reason); }
      return super.slice(...args);
    }
  }
  await assert.rejects(readTraktArchive(new InterruptedFile([file]), controller.signal), error => error === reason);
  assert.ok(sliced);
});

test('Watchlist seasons and episodes use the parent show IDs. Unreadable items appear individually and films add nothing', async () => {
  const season = { ids: { tmdb: 12001 } };
  const archive = await readTraktArchive(await traktZip({ 'lists-watchlist.json': [
    { type: 'show', show }, { type: 'season', season, show }, { type: 'episode', episode, show },
    { type: 'episode', episode }, { show }, null, movie,
  ] }));
  assert.deepEqual(archive.watchlist, [show, show, show]);
  assert.equal(archive.issues.length, 3);
  for (const [index, issue] of archive.issues.entries()) assert.match(issue, new RegExp('Watchlist item ' + (4 + index)));
  assert.match(archive.issues[1], /Tide Signal/);
});

test('External TV IDs remain nullable and typed for matching. A title-only entry is available for the skipped list', async () => {
  const missingIds = { title: 'Fictional Unknown' };
  const byTvdb = { title: 'Second Channel', ids: { tmdb: null, tvdb: 77, trakt: 4, imdb: 'tt1009' } };
  const archive = await readTraktArchive(await traktZip({ 'ratings-shows.json': [
    { show: missingIds, rating: 1 }, { show: byTvdb, rating: 10 },
    { show: { title: 'Invalid IDs', ids: { tmdb: -1, tvdb: 2.5, trakt: '41', imdb: 'not a title ID' } }, rating: 7 },
  ] }));
  assert.deepEqual(archive.ratings[1].show, byTvdb);
  for (const i of [0, 2]) assert.deepEqual(archive.ratings[i].show.ids, { trakt: null, tmdb: null, tvdb: null, imdb: null });
});

test('A non-ZIP, missing recognized files, invalid UTF-8 or unreadable supported JSON rejects the entire import', async () => {
  await assert.rejects(readTraktArchive(new File(['[]'], 'fake.zip')), /Could not read this Trakt export/);
  await assert.rejects(readTraktArchive(await traktZip({ 'user-stats.json': {}, 'notes/ratings-shows.json': [] })), /does not contain/);
  for (const bad of ['[', '{}', new Uint8Array([0x5b, 0x22, 0xff, 0x22, 0x5d])]) {
    const file = await traktMemberZip({ 'lists-watchlist.json': '[]', 'ratings-shows.json': bad });
    await assert.rejects(readTraktArchive(file), /Could not read ratings-shows\.json/);
  }
  const normal = await traktZip({ 'watched-history-1.json': [play] });
  await assert.rejects(readTraktArchive(normal.slice(0, normal.size - 24)), /Could not read/);
});

test('An unrecognizable TV history row, invalid total or invalid rating rejects the import before preview', async () => {
  for (const [name, row] of [
    ['watched-history-1.json', { type: 'episode', show, episode: { ...episode, number: null } }],
    ['watched-history-1.json', { type: 'episode', episode }],
    ['watched-shows.json', { show, plays: -1 }], ['ratings-shows.json', { show, rating: 11 }],
    ['ratings-shows.json', { show, rating: 4.5 }],
  ]) await assert.rejects(readTraktArchive(await traktZip({ [name]: [row] })), /Could not read/);
});

test('CRC catches corruption that still spells valid JSON, and duplicate recognized members never double-count plays', async () => {
  const source = await traktZip({ 'ratings-shows.json': [{ show, rating: 8 }] }, { level: 0 });
  const bytes = new Uint8Array(await source.arrayBuffer());
  const contentStart = new TextDecoder('latin1').decode(bytes).indexOf('"rating":8');
  assert.ok(contentStart > 0);
  bytes[contentStart + 9] = '9'.charCodeAt(0);
  await assert.rejects(readTraktArchive(new Blob([bytes])), /Could not read ratings-shows/);

  const duplicate = await traktZip({ 'watched-history-1.json': [play], 'watched-history-2.json': [play] });
  const repeated = new Uint8Array(await duplicate.arrayBuffer());
  const raw = new TextDecoder('latin1').decode(repeated);
  const occurrences = [...raw.matchAll(/watched-history-2\.json/g)];
  assert.equal(occurrences.length, 2);
  for (const match of occurrences) repeated[match.index + 'watched-history-'.length] = '1'.charCodeAt(0);
  await assert.rejects(readTraktArchive(new Blob([repeated])), /Could not read/);
});
