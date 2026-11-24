import test from 'node:test';
import assert from 'node:assert/strict';
import { readTraktArchive } from '../dist/trakt-archive.js';
import { readAniListArchive } from '../dist/anilist-archive.js';
import { readLocalRecord } from '../dist/local-restore.js';
import { readHandInputs } from '../dist/hand-merge.js';
import { readCsv } from '../dist/csv.js';
import { importLimits, csvSelectionLimits, checkImportRows, checkTraktMemberBytes, parseImportJson, readImportText } from '../dist/import-limits.js';
import { traktZip, traktMemberZip } from './trakt-fixture-cases.mjs';

test('Selected files exceeding the byte or file-count limits are rejected before a file read', async () => {
  let reads = 0;
  const unread = () => { reads++; throw Error('Unexpected file read'); };
  const file = (name, size) => ({name, size, arrayBuffer:unread, stream:unread, slice:unread});
  await assert.rejects(readTraktArchive(file('sample.zip',importLimits.traktZip + 1)), /32 MiB import limit/);
  await assert.rejects(readAniListArchive(file('sample.json',importLimits.aniListFile + 1)), /16 MiB import limit/);
  await assert.rejects(readHandInputs([file('small.csv',1), file('large.csv',importLimits.csvFile + 1)]), /16 MiB import limit/);
  const names = ['watched.csv','ratings.csv','lists.csv','shows.csv'];
  const selection = names.map(name => file(name, importLimits.csvTotal / 4));
  assert.doesNotThrow(() => csvSelectionLimits(selection));
  selection[3].size++;
  await assert.rejects(readLocalRecord(selection), /32 MiB import limit/);
  await assert.rejects(readHandInputs(Array.from({length:17},() => file('tiny.csv',1))), /up to 16 CSV/);
  assert.equal(reads,0);
});

test('The decoded-byte budget counts each chunk before UTF-8 decoding and accepts an exact boundary', async () => {
  assert.doesNotThrow(() => checkTraktMemberBytes(importLimits.traktTotal-importLimits.traktMember,importLimits.traktMember));
  assert.throws(() => checkTraktMemberBytes(0,importLimits.traktMember + 1),/16 MiB import limit/);
  assert.throws(() => checkTraktMemberBytes(importLimits.traktTotal,1),/64 MiB import limit/);
  const bytes = new TextEncoder().encode('Snow 雪');
  const writeTo = sink => new ReadableStream({ start(source) {
    source.enqueue(bytes.subarray(0,6)); source.enqueue(bytes.subarray(6)); source.close();
  }}).pipeTo(sink);
  const seen = [];
  const allowed = await readImportText(writeTo,count => {seen.push(count); assert.ok(count <= bytes.length);});
  assert.deepEqual(allowed,{text:'Snow 雪',byteLength:bytes.length});
  assert.deepEqual(seen,[6,bytes.length]);
  await assert.rejects(readImportText(writeTo,count => {
    if (count > bytes.length - 1) throw Error('sample byte budget exceeded');
  }), /sample byte budget exceeded/);
});

test('The Trakt ZIP entry limit counts ignored members, and the row limit counts all supported pages', async () => {
  const files = Object.fromEntries(Array.from({length:importLimits.zipEntries - 1},(_,i)=>['other-'+i+'.txt','']));
  files['ratings-shows.json'] = '[]';
  assert.deepEqual((await readTraktArchive(await traktMemberZip(files,{level:0}))).ratings,[]);
  files['one-more.txt'] = '';
  await assert.rejects(readTraktArchive(await traktMemberZip(files,{level:0})),/512-entry import limit/);
  const movies = Array(importLimits.rows / 2).fill({type:'movie'});
  const pages = {'watched-history-1.json':movies,'watched-history-2.json':movies};
  assert.deepEqual((await readTraktArchive(await traktZip(pages,{level:0}))).history,[]);
  await assert.rejects(readTraktArchive(await traktZip({...pages,'watched-history-3.json':[{type:'movie'}]},{level:0})),/100,000-row/);
});

test('AniList combines both arrays for the row limit before processing or allocating notices', async () => {
  const favourites = Array(importLimits.rows).fill(null);
  const make = lists => new Blob([JSON.stringify({lists,favourites})]);
  const parsed = await readAniListArchive(make([]));
  assert.deepEqual(parsed.entries,[]);
  assert.equal(parsed.favourites.size,0);
  assert.deepEqual(parsed.notices.map(n => n.text),['Favorite entries skipped because of an invalid type or ID: 100,000.']);
  await assert.rejects(readAniListArchive(make([{}])), /100,000-row/);
});

test('JSON preflight bounds nested imports and preserves quoted punctuation and escaped Unicode text', () => {
  const title = {name: 'Snow 雪 "[]{}", \\trail', labels:['[mountains]']};
  assert.deepEqual(parseImportJson(JSON.stringify(title)),title);
  let value = 1;
  for (let i=0;i<importLimits.jsonDepth;i++) value=[value];
  assert.deepEqual(parseImportJson(JSON.stringify(value)),value);
  assert.throws(() => parseImportJson(JSON.stringify([value])),/too deeply nested/);
});

test('CSV import budgets count logical data records across files and bound column allocation, including header reads', async () => {
  const budget = csvSelectionLimits([]);
  for (let i=0;i<importLimits.rows;i++) budget.countDataRow();
  assert.throws(budget.countDataRow,/100,000-row/);
  assert.doesNotThrow(() => checkImportRows(importLimits.rows));
  const file = new File(['list,show_id\r\n"A\r\nB",1\r\n'],'example.csv');
  assert.deepEqual((await readHandInputs([file])).tables.lists,[{list:'A\r\nB',show_id:1,show:''}]);
  let records = 0;
  const selection = {maxFields:128, countDataRow() { if (++records > 2) throw Error('sample row limit'); }};
  readCsv('lists',await file.text(),selection);
  readCsv('ratings','show_id,rating\r\n2,9\r\n',selection);
  assert.throws(() => readCsv('shows','show_id,show\r\n1,Sample\r\n',selection),/sample row limit/);
  const tooWide = Array(importLimits.csvColumns+1).fill('fictional').join(',');
  await assert.rejects(readHandInputs([new File([tooWide],'wide.csv')]),/128-column/);
  await assert.rejects(readHandInputs([new File(['show_id,rating\n'+tooWide],'wide.csv')]),/128-column/);
});
