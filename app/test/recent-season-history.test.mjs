import assert from 'node:assert/strict';
import test from 'node:test';
import {readCsv,writeCsv} from '../dist/csv.js';
import {mergeRows} from '../dist/merge.js';
import {orderedRecents,recentEntries,recentRow} from '../dist/recent-history.js';
import {retainRecentMarks,watchPatch} from '../dist/watch-record.js';

const ep = (id,season,episode,count = 1) => ({
  show_id:id,show:'Fictional '+id,season,episode,title:'Episode '+episode,episode_id:null,times_watched:count,
});
const recents = (settings,rows) => orderedRecents(recentEntries(settings,rows));
const combine = (old,put) => [...new Map([...old,...put].map(row => [row.setting,row])).values()];
function edit(settings,before,after,id,ranges = null) {
  const snapshot = {revision:1n,tables:{watched:before.filter(row => row.show_id === id),lists:[]},
    recentSettings:settings,recentlyMarked:recents(settings,before)};
  const {patch} = watchPatch(id,snapshot,after.filter(row => row.show_id === id),0,undefined,ranges);
  return combine(settings,patch.put?.settings ?? []);
}

test('Split season and whole-show additions revert to the surviving rank after subtraction and CSV round trip', () => {
  const ranges = [{number:1,sourceSeason:1,first:1,last:3},{number:2,sourceSeason:1,first:4,last:6}];
  let settings = [], rows = [];
  const advance = (id,next) => {settings = edit(settings,rows,next,id,ranges); rows = next;};
  advance(71,[ep(71,1,1)]);
  advance(82,[...rows,ep(82,1,1)]);
  advance(71,[...rows,ep(71,1,2)]);
  assert.deepEqual(recents(settings,rows),[82,71]);
  advance(71,[...rows,ep(71,1,4),ep(71,1,5),ep(71,2,1)]);
  settings = readCsv('settings',writeCsv('settings',settings)).rows;
  assert.deepEqual(recents(settings,rows),[71,82]);
  advance(71,rows.filter(row => row.episode !== 4 && row.season !== 2));
  assert.deepEqual(recents(settings,rows),[71,82],'the extra episode in the split season retains its rank');
  advance(71,rows.filter(row => row.episode !== 5));
  assert.deepEqual(recents(settings,rows),[82,71]);
  advance(71,[...rows,ep(71,0,1)]);
  assert.deepEqual(recents(settings,rows),[82,71],'a special on an existing show leaves its place alone');
  advance(71,rows.filter(row => row.season !== 0));
  assert.deepEqual(recents(settings,rows),[82,71]);
  advance(93,[...rows,ep(93,0,2)]);
  assert.deepEqual(recents(settings,rows),[93,82,71],'the first watch of an entirely new show can be a special');
  advance(93,rows.filter(row => row.show_id !== 93));
  assert.deepEqual(recents(settings,rows),[82,71]);
});

test('Independent offline season marks merge, wait for matching watches and withdraw separately', () => {
  const imported = [ep(15,1,1)], second = ep(15,2,1), third = ep(15,3,1);
  const a = edit([],imported,[...imported,second],15);
  const b = edit([],imported,[...imported,third],15);
  const merged = mergeRows('settings',[],a,b).rows;
  assert.equal(merged.length,2);
  assert.deepEqual(recents(merged,imported),[],'an unrelated prior season cannot satisfy a newly downloaded history row');
  const snapshot = {tables:{settings:merged,watched:imported},local:{recentlyMarked:[]}};
  const all = [...imported,second,third];
  assert.equal(retainRecentMarks(snapshot,{replace:{watched:all}},true).put,undefined,'settings can arrive before the watches');
  assert.deepEqual(recents([],all),[],'watches alone cannot mark the show');
  assert.deepEqual(recents(merged,all),[15]);
  const withoutSecond = edit(merged,all,[...imported,third],15);
  assert.deepEqual(recents(withoutSecond,[...imported,third]),[15]);
  const withdrawn = retainRecentMarks({tables:{settings:withoutSecond,watched:[...imported,third]},local:{recentlyMarked:[15]}},
    {replace:{watched:imported}},true);
  const final = combine(withoutSecond,withdrawn.put.settings);
  assert.deepEqual(recents(final,all),[],'a later import of the retired seasons must not revive them');
});

test('Unrelated imports and episode edits preserve incoming marks while their Dropbox watches are still missing', () => {
  const pending = ep(15,2,1), other = ep(21,1,1), history = [{setting:'recently_marked.15.2.0.0',value:'15/15'}];
  const before = {tables:{settings:history,watched:[]},local:{recentlyMarked:[]}};
  const imported = retainRecentMarks(before,{put:{watched:[other]}});
  const current = combine(history,imported.put.settings ?? []);
  assert.deepEqual(recents(current,[other]),[]);
  const received = retainRecentMarks({tables:{settings:current,watched:[other]},local:{recentlyMarked:[]}},
    {replace:{watched:[other,pending]}},true);
  assert.deepEqual(recents(combine(current,received.put?.settings ?? []),[other,pending]),[15]);
  const ownImport = retainRecentMarks(before,{put:{watched:[pending]}});
  assert.deepEqual(recents(combine(history,ownImport.put.settings ?? []),[pending]),[]);
  const seasonOne = ep(15,1,1);
  const rewatched = edit(history,[seasonOne],[{...seasonOne,times_watched:2}],15);
  assert.deepEqual(recents(rewatched,[seasonOne]),[]);
  assert.deepEqual(recents(rewatched,[seasonOne,pending]),[15],'a play in another season must leave the pending mark intact');
});

test('A growing custom season keeps its original rank and malformed inputs fail closed', () => {
  const old = [{number:1,sourceSeason:1,first:1,last:2},{number:2,sourceSeason:1,first:3,last:4}];
  const grown = [old[0],{...old[1],last:5}];
  const first = ep(7,1,3), next = ep(7,1,5);
  const a = edit([],[],[first],7,old);
  const rank = recentEntries(a).get(7).rank;
  const b = edit(a,[first],[first,next],7,grown);
  const c = edit(b,[first,next],[next],7,grown);
  assert.equal(recentEntries(c,[next]).get(7).rank,rank);
  for (const bad of ['recently_marked.7.1.5.3','recently_marked.7.01.0.0','recently_marked.7.1.0.8']) {
    assert.equal(readCsv('settings','setting,value\r\n'+bad+',11/11\r\n').schema,'unknown');
  }
  assert.doesNotThrow(() => edit([{setting:'recently_marked.7.1.0.0',value:'bad'}],[first],[first,next],7,grown));
  assert.deepEqual(recents(edit([recentRow(7,11,11)],[first],[first,next],7,grown),[first,next]),[7]);
});
