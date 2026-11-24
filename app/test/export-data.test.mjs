import assert from 'node:assert/strict';
import test from 'node:test';
import { records } from '../src/csv-format.ts';
import { readCsv } from '../src/csv.ts';
import { readLocalRecord } from '../src/local-restore.ts';
import { decodeListNames, encodeListNames, prepareExport, resetSummary } from '../src/export-data.ts';
import { tmdbResourceKey } from '../src/tmdb-client.ts';

const header = 'show,year,season,episodes_watched,times_completed,rating,lists';
const now = new Date(2026, 10, 18, 12).getTime();
const watch = (show_id, show, season, episode, times_watched = 1) => ({
  show_id, show, season, episode, times_watched, title: 'Opening', episode_id: null,
});
const member = (show_id, show, list) => ({ show_id, show, list });
const index = (show_id, show, year, imdb_id = '') => ({ show_id, show, year, imdb_id });
const rate = (show_id, show, rating) => ({ show_id, show, rating });
const metadata = (id, name, counts, last, date = null) => ({
  show_id: id, show: name, firstAirDate: date, imdbId: null, lastAired: last, nextAirDate: null,
  seasons: counts.map(([season, episodeCount]) => ({ season, episodeCount })),
});
const seasonKey = (id, season) => tmdbResourceKey({ kind: 'season', id, season });
function fixture(tables = {}, metadata = [], seasons = [], externalIds = []) {
  return { tables: { watched: [], ratings: [], lists: [], shows: [], ...tables },
    showMetadata: new Map(metadata.map(s => [s.show_id, s])), seasons: new Map(seasons), externalIds: new Map(externalIds) };
}
function service(data, clock = now) {
  return { environment: { now: () => clock }, store: { exportSnapshot: async () => structuredClone(data) } };
}
function summaryFields(content) {
  return [...records(content)].slice(1).map(record => {
    assert.ok(record.fields);
    return record.fields;
  });
}

test('empty names survive four-file export and restore without creating a show or summary entry', async () => {
  const lists = readCsv('lists','list,show_id,show\n"Quiet, nights",,\nDaytime,,\nDaytime,0,Blue Tower').rows;
  const data = fixture({lists,shows:[index(0,'Blue Tower',null)]});
  const summary = await prepareExport(service(data),'summary');
  assert.deepEqual(summaryFields(await summary.files[0].text()).map(r=>[r[0],r[6]]),[['Blue Tower','Daytime']]);
  const record = await prepareExport(service(data),'record');
  const reopened = await readLocalRecord(record.files);
  assert.deepEqual(reopened.shows.map(s=>[s.show_id,s.show]),[[0,'Blue Tower']]);
  assert.deepEqual(reopened.lists.toSorted((a,b)=>a.list.localeCompare(b.list)||a.show_id-b.show_id),
    lists.toSorted((a,b)=>a.list.localeCompare(b.list)||a.show_id-b.show_id));
  assert.deepEqual(reopened.watched,[]);
  assert.deepEqual(reopened.ratings,[]);
});

test('Summary shows effective Watchlist membership while file export retains every original preference', async () => {
  const rows = [member(1,'Beacon','Following upcoming'),member(2,'Atlas','Watchlist'),member(2,'Atlas','Hidden from upcoming'),
    member(3,'Tower','HIDDEN FROM UPCOMING'),member(3,'Tower','Custom'),
    member(3,'Tower','AnImE'),member(4,'Marker alone','Anime'),
    member(5,'Quiet Lines','stOPPed'),member(5,'Quiet Lines','Following upcoming'),
    member(6,'Resumed','csvTV: picked up'),member(6,'Resumed','Watchlist'),
    member(7,'Started','watchLIST'),member(7,'Started','Favorites'),member(8,'Special','Following upcoming')];
  const data = fixture({lists:rows,watched:[watch(7,'Started',1,1),watch(8,'Special',0,1)]});
  const result = await prepareExport(service(data),'summary');
  assert.deepEqual(summaryFields(await result.files[0].text()).map(r=>[r[0],r[6]]),
    [['Beacon','Watchlist'],['Quiet Lines','Dropped'],['Resumed','Watchlist'],['Special',''],['Started','Favorites'],['Tower','Custom']]);
  const raw = await prepareExport(service(data),'record');
  const file = raw.files.find(f=>f.name==='lists.csv');
  assert.deepEqual(readCsv('lists',await file.text()).rows.map(r=>[r.show,r.list]).sort(),rows.map(r=>[r.show,r.list === 'stOPPed' ? 'Dropped' : r.list]).sort());
});

test('Summary list names survive their own escaping and outer CSV quoting', async () => {
  const name = 'Árbol \\; "act, one"\nnext; line';
  const names = ['watchlist', name, 'solo\\', 'Watchlist; Drama', 'Semi;colon', ' Watch ', '\t', '🪐'];
  assert.equal(encodeListNames([]), '');
  assert.deepEqual(decodeListNames(''), []);
  assert.equal(encodeListNames(['Watchlist; Drama']), 'Watchlist\\; Drama');
  assert.equal(encodeListNames(['Watchlist', 'Drama']), 'Watchlist; Drama');
  assert.deepEqual(decodeListNames(encodeListNames(names)), names);
  assert.throws(() => decodeListNames('incomplete\\'));
  assert.throws(() => decodeListNames('A; '));
  assert.throws(() => encodeListNames(['']));
  const data = fixture({ lists: [name, 'watchlist', 'Revisit', 'revisit', 'Watchlist', 'solo\\']
    .map(list => member(1, 'Show "One"', list)) });
  const result = await prepareExport(service(data), 'summary');
  const [row] = summaryFields(await result.files[0].text());
  assert.deepEqual(row.slice(0, 6), ['Show "One"', '', '', '', '', '']);
  assert.deepEqual(decodeListNames(row[6]), ['Watchlist', 'watchlist', 'Revisit', 'revisit', 'solo\\', name]);
  assert.equal(result.rows, 1);
  assert.equal(result.missingShows, 0);
});

test('Interactive summary counts all recorded episodes and only completes aired regular seasons', async () => {
  const data = fixture({
    watched: [watch(1, 'Drift', 1, 4, 7), watch(1, 'Drift', 1, 1, 3), watch(1, 'Drift', 1, 2, 2),
      watch(1, 'Drift', 0, 1), watch(1, 'Drift', 2, 1), watch(1, 'Drift', 3, 2), watch(1, 'Drift', 4, 1),
      watch(1, 'Drift', 5, 1), watch(2, 'Filed, only', 1, 1), watch(2, 'Filed, only', 2, 2), watch(4, 'Special only', 0, 1)],
    ratings: [rate(1, 'Drift', 0), rate(3, 'Mystery', 7.5)],
    lists: [member(1, 'Drift', 'Weekend'), member(3, 'Mystery', 'Watchlist')],
  }, [metadata(1, 'Drift', [[0, 1], [1, 4], [2, 2], [3, 2], [4, 1]], { season: 4, episode: 1 }, '2021-12-10')], [
    [seasonKey(1, 1), { episodes: [
      { episode: 1, airDate: '2026-11-17' }, { episode: 2, airDate: '2026-11-18' },
      { episode: 3, airDate: null }, { episode: 4, airDate: '2026-12-18' }] }],
    [seasonKey(1, 2), null],
    [seasonKey(1, 4), { episodes: [{ episode: 1, airDate: '2027-01-01' }] }],
  ]);
  const result = await prepareExport(service(data), 'summary');
  const file = result.files[0];
  const fields = [
    ['Drift','2021','0','1','','0','Weekend'],
    ['Drift','2021','1','3','2','0','Weekend'],
    ['Drift','2021','2','1','','0','Weekend'],
    ['Drift','2021','3','1','0','0','Weekend'],
    ['Drift','2021','4','1','','0','Weekend'],
    ['Drift','2021','5','1','','0','Weekend'],
    ['Filed, only','','1','1','','',''], ['Filed, only','','2','1','','',''],
    ['Mystery','','','','','7.5','Watchlist'], ['Special only','','0','1','','',''],
  ];
  assert.equal(file.name, 'summary.csv');
  assert.equal(file.type, 'text/csv');
  assert.equal(file.lastModified, now);
  assert.deepEqual(summaryFields(await file.text()), fields);
  assert.equal(result.rows, fields.length);
  assert.equal(result.missingShows, 1);
});

test('At 01:00 UTC identical records use the local date on each device for an interactive summary', async () => {
  const instant = Date.parse('2026-11-19T01:00:00Z');
  const data = fixture({ watched: [watch(8, 'Threshold', 1, 1)] },
    [metadata(8, 'Threshold', [[1, 2]], { season: 1, episode: 2 })],
    [[seasonKey(8, 1), { episodes: [{ episode: 1, airDate: '2026-11-18' }, { episode: 2, airDate: '2026-11-19' }] }]]);
  const original = process.env.TZ;
  try {
    for (const [zone, completed] of [['America/New_York', '1'], ['UTC', '0']]) {
      process.env.TZ = zone;
      const { files } = await prepareExport(service(data, instant), 'summary');
      assert.equal(summaryFields(await files[0].text())[0][4], completed);
    }
  } finally {
    if (original === undefined) delete process.env.TZ; else process.env.TZ = original;
  }
});

test('a selective clear publishes retained rows with verified completions and fences a missing season order', async () => {
  const data = fixture({watched:[watch(1,'Relay',1,1,3),watch(1,'Relay',2,1,4)],
    ratings:[rate(2,'Harbour',7)]}, [metadata(1,'Relay',[[1,1],[2,1]],{season:2,episode:1})],
    [[seasonKey(1,1),{episodes:[{episode:1,airDate:'2020-01-01'}]}]]);
  data.missingShowIds = new Set();
  const rows = [index(1,'Relay',2020),index(2,'Harbour',2021)];
  assert.deepEqual(summaryFields(await resetSummary(data,rows,now).text()),[
    ['Harbour','2021','','','','7',''], ['Relay','2020','1','1','3','',''], ['Relay','2020','2','1','','',''],
  ]);
  data.showMetadata.clear();
  assert.equal(await resetSummary(data,rows,now).text(),header+'\r\n');
  data.missingShowIds.add(1);
  assert.deepEqual(summaryFields(await resetSummary(data,rows,now).text()).map(row=>row.slice(2,5)),
    [['','',''],['1','1',''],['2','1','']]);
});

test('Four CSVs share one snapshot, preserving exact bytes, imported fields and only currently referenced IDs', async () => {
  const data = fixture({
    watched: [{ ...watch(1, 'Filed 1', 1, 2), title: 'A "part",\r\ntwo' }],
    ratings: [rate(2, 'Filed 2', 8.5)],
    lists: [member(3, 'Shelved', 'A; B'), member(1, 'Filed 1', 'Watchlist')],
    shows: [index(1, 'Pre-refresh', 1993, 'tt0123000'), index(2, 'Saved "Two"', 2001, 'tt0000099'),
      index(4, 'Removed last reference', 1999)],
    settings: [{ setting: 'tmdb_key', value: 'fictional-sensitive-value' }],
  }, [metadata(1, 'Cached, One', [], null, '2005-02-01')]);
  const source = service(data);
  const calls = [];
  source.store.exportSnapshot = async (includeSeasons, time) => {
    calls.push([includeSeasons, time]);
    return structuredClone(data);
  };
  const before = structuredClone(data);
  const first = await prepareExport(source, 'record');
  assert.deepEqual(calls, [[false, now]]);
  assert.deepEqual(data, before);
  assert.deepEqual(first.files.map(file => file.name), ['watched.csv', 'ratings.csv', 'lists.csv', 'shows.csv']);
  const expected = [
    'show_id,show,season,episode,title,times_watched,episode_id\r\n1,Filed 1,1,2,"A ""part"",\r\ntwo",1,\r\n',
    'show_id,show,rating\r\n2,Filed 2,8.5\r\n',
    'list,show_id,show\r\nA; B,3,Shelved\r\nWatchlist,1,Filed 1\r\n',
    'show_id,show,year,imdb_id\r\n3,,,\r\n1,"Cached, One",2005,tt0123000\r\n2,"Saved ""Two""",2001,tt0000099\r\n',
  ];
  data.tables.watched[0].times_watched++;
  data.tables.lists = data.tables.lists.filter(row => row.show_id !== 3);
  for (const [i, file] of first.files.entries()) {
    assert.deepEqual(new Uint8Array(await file.arrayBuffer()), new TextEncoder().encode(expected[i]));
    const parsed = readCsv(file.name.slice(0, -4), await file.text());
    assert.equal(parsed.stopped, false);
    assert.deepEqual(parsed.findings, []);
  }
  const second = await prepareExport(source, 'record');
  assert.equal(readCsv('watched', await second.files[0].text()).rows[0].times_watched, 2);
  assert.deepEqual(readCsv('shows', await second.files[3].text()).rows.map(show => show.show_id), [1, 2]);
});

test('The four-file export uses cached external IDs even for a show with no cached show detail', async () => {
  const data = fixture({
    lists: [member(1, 'One', 'Weekend'), member(2, 'Two', 'Weekend'), member(3, 'Three', 'Weekend')],
    shows: [index(1, 'One', 2000, 'tt0000010'), index(2, 'Two', null, 'tt0000020')],
  }, [metadata(1, 'Current One', [], null), { ...metadata(3, 'Three', [], null), imdbId: 'tt0000033' }],
  [], [[1, 'tt0000011'], [2, 'tt0000022'], [4, 'tt0000044']]);
  const { files } = await prepareExport(service(data), 'record');
  assert.deepEqual(readCsv('shows', await files[3].text()).rows, [
    index(1, 'Current One', 2000, 'tt0000011'), index(3, 'Three', null, 'tt0000033'), index(2, 'Two', null, 'tt0000022'),
  ]);
});

test('Summary uses file text, numeric ID and season order independent of input order; empty selections have just their headers', async () => {
  const data = fixture({ watched: [watch(10, 'Same', 10, 1), watch(2, 'Same', 0, 1), watch(10, 'Same', 2, 1)],
    ratings: [rate(2, 'Same', 2), rate(10, 'Same', 10), rate(3, 'SAME', 3), rate(4, '𐀀', 4), rate(5, '\ue000', 5)] });
  const first = await prepareExport(service(data), 'summary');
  const expected = [header, 'SAME,,,,,3,', 'Same,,0,1,,2,', 'Same,,2,1,,10,', 'Same,,10,1,,10,',
    '\ue000,,,,,5,', '𐀀,,,,,4,'].join('\r\n') + '\r\n';
  assert.equal(await first.files[0].text(), expected);
  for (const table of Object.values(data.tables)) table.reverse();
  const second = await prepareExport(service(data), 'summary');
  assert.deepEqual(new Uint8Array(await second.files[0].arrayBuffer()), new TextEncoder().encode(expected));
  const empty = service(fixture());
  const summary = await prepareExport(empty, 'summary');
  assert.equal(summary.rows, 0);
  assert.equal(await summary.files[0].text(), header + '\r\n');
  const { files } = await prepareExport(empty, 'record');
  for (const file of files) assert.equal((await file.text()).split('\r\n').length, 2);
});
