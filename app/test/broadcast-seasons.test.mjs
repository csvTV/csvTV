import assert from 'node:assert/strict';
import test from 'node:test';
import { broadcastPosition, broadcastSeasons } from '../src/broadcast-seasons.ts';
import { markAired, removeWatches, undoWatchEdit } from '../src/marks.ts';
import { watchProgress } from '../src/progress.ts';
import { recordExportFiles, summary } from '../src/export-data.ts';
import { watchlistNextEpisode } from '../src/record-overview.ts';
import { tmdbResourceKey } from '../src/tmdb-client.ts';
import { selectShowMalScores } from '../src/mal-file.ts';

// Real public catalog ID with entirely fictional metadata and watch history.
const id = 237150, today = '2026-11-20', title = 'The Paper Observatory';
const episodes = Array.from({length:32}, (_, index) => ({
  episode:index + 1, episode_id:7700 + index, title:'Signal ' + (index + 1),
  airDate:index < 31 ? today : '2099-01-01',
}));
const show = {show_id:id, show:title, lastAired:{season:1,episode:31}, nextAirDate:null,
  seasons:[{season:0,episodeCount:1,episodes:[]}, {season:1,episodeCount:32,episodes}]};
const row = n => ({show_id:id,show:title,season:1,...episodes[n-1],times_watched:1});

test('Verified broadcast boundaries apply only to the known flat provider shape', () => {
  for (const [show_id, ends] of [[237150,[12,24,36]], [105009,[24,37,50,63]], [65942,[25,50,66,85]],
    [95479,[24,47,59]], [127532,[12,25]], [209867,[28,38]], [213402,[12,24]], [278043,[12,25]], [205050,[25,50,51]]]) {
    const season = episodeCount => ({season:1,episodeCount});
    const map = seasons => broadcastSeasons({show_id,seasons});
    const ranges = map([season(ends.at(-1))]);
    assert.deepEqual(ranges.map(r => r.last), ends);
    for (const range of ranges) {
      assert.deepEqual(broadcastPosition(ranges,1,range.first),{season:range.number,episode:1});
      assert.deepEqual(broadcastPosition(ranges,1,range.last),{season:range.number,episode:range.last - range.first + 1});
    }
    assert.equal(map([season(ends[0])]), null);
    const growing = map([season(ends.at(-1) + 1)]);
    assert.deepEqual(growing.slice(0,-1),ranges);
    assert.equal(growing.at(-1).unassigned,true);
    assert.equal(growing.at(-1).first,ends.at(-1)+1);
    const announced = map([season(ends[0]+1),{season:2,episodeCount:0}]);
    assert.deepEqual(broadcastPosition(announced,1,ends[0]+1),{season:2,episode:1},
      'Announcing an empty native season must preserve already placed episodes');
    assert.equal(map([season(ends[0] + 1), {season:2,episodeCount:12}]), null);
    assert.deepEqual(broadcastPosition(ranges,0,3),{season:0,episode:3});
  }
  assert.equal(broadcastSeasons({...show,show_id:999}),null);
  assert.deepEqual(watchlistNextEpisode({metadata:{...show,nextEpisode:{season:1,episode:32,airDate:'2099-01-01'}}}),
    {season:3,episode:8,airDate:'2099-01-01'});
  assert.deepEqual(watchlistNextEpisode({metadata:{...show,seasons:[...show.seasons,{season:2,episodeCount:0}],
    nextEpisode:{season:1,episode:32,airDate:'2099-01-01'}}}),{season:3,episode:8,airDate:'2099-01-01'});
});

test('Publisher-confirmed seasons survive a conflicting community split while a compatible new range can extend the order', () => {
  const head = {show_id:237150,seasons:[{season:1,episodeCount:37}]};
  const ranges = broadcastSeasons(head);
  const conflicting = ranges.slice(0,3).map(r => r.number===1 ? {...r,last:13} : r.number===2 ? {...r,first:14} : r);
  assert.deepEqual(broadcastSeasons({...head,broadcastOrder:conflicting}),ranges);
  const extension = [...ranges.slice(0,3),{number:4,sourceSeason:1,first:37,last:37}];
  assert.deepEqual(broadcastSeasons({...head,broadcastOrder:extension}),extension);
  const future = {season:1,episode:37,airDate:'2099-01-01'};
  assert.deepEqual(watchlistNextEpisode({metadata:{...head,nextEpisode:future}}),{...future,nativeNumbering:true});
  assert.deepEqual(watchlistNextEpisode({metadata:{...head,broadcastOrder:extension,nextEpisode:future}}),
    {...future,season:4,episode:1});
});

test('Verified and provider orders can split or retain portions of multiple native seasons', () => {
  const header = {show_id:91768, seasons:[{season:1,episodeCount:36},{season:2,episodeCount:24}]};
  const mixed = broadcastSeasons(header);
  assert.deepEqual(mixed.map(r=>[r.number,r.sourceSeason,r.first,r.last]),[[1,1,1,14],[2,1,15,26],[3,1,27,36],[4,2,1,24]]);
  const meta = {...show, show_id:777, seasons:[{season:1,episodeCount:6},{season:2,episodeCount:7}],
    lastAired:{season:2,episode:3}, broadcastOrder:[{number:1,sourceSeason:1,first:1,last:3},
      {number:2,sourceSeason:1,first:4,last:5},{number:3,sourceSeason:2,first:1,last:7}]};
  const order = broadcastSeasons(meta);
  assert.deepEqual(order.at(-1),{number:4,sourceSeason:1,first:6,last:6,name:'Unassigned episodes · TMDB Season 1',unassigned:true});
  const rows = [[1,3],[1,4],[1,6],[2,1],[2,2],[2,3]].map(([season,episode])=>({...row(episode),show_id:777,season,episode}));
  assert.deepEqual(watchProgress(777,rows,[],meta,today).seasons.map(s=>[s.season,s.aired,s.watchedAired]),
    [[1,3,1],[2,2,1],[3,3,3],[4,1,1]]);
  for (const invalid of [[{number:1,sourceSeason:2,first:2,last:3}],
    [meta.broadcastOrder[0],{number:2,sourceSeason:1,first:3,last:6}], [{number:1,sourceSeason:7,first:1,last:2}]]) {
    assert.equal(broadcastSeasons({...meta,broadcastOrder:invalid}),null);
  }
  assert.equal(broadcastSeasons({...meta,manualSeasonOrder:'native'}),null);
});

test('Per-season MAL scores keep distinct installments and resolve known bad catalog offsets by identity', () => {
  const header = (show_id,count) => ({show_id,seasons:[{season:1,episodeCount:count}]});
  const score = (malId,season,offset,value) => ({malId,season,offset,score:value});
  assert.deepEqual([...selectShowMalScores([score(54918,1,36,8.1),score(50608,1,24,8.3)],header(105009,50)).seasons],
    [[2,[8.3]],[3,[8.1]]]);
  assert.deepEqual([...selectShowMalScores([score(42203,1,38,8.6),score(39587,1,26,8.4)],header(65942,66)).seasons],
    [[2,[8.4,8.6]]]);
});

test('Old native watches project without migration, with matching estimates before season detail arrives', () => {
  const saved = [row(1), ...episodes.slice(12,24).map(e => row(e.episode)), row(32),
    {...row(20), season:2, episode:4}];
  const original = structuredClone(saved);
  for (const metadata of [show, {...show, seasons:show.seasons.map(({season,episodeCount}) => ({season,episodeCount}))}]) {
    const result = watchProgress(id,saved,[],metadata,today);
    assert.deepEqual(result.seasons.map(s => [s.season,s.aired,s.watchedAired,s.completed,s.recordedEpisodes]),
      [[0,0,0,null,0],[1,12,1,0,1],[2,12,12,1,13],[3,7,0,0,1]]);
    assert.deepEqual([result.recordedEpisodes,result.plays],[15,15n]);
  }
  assert.deepEqual(saved,original);
});

test('An exact native airing beyond a stale season size respects custom breaks, fixed orders and the local day', () => {
  const original = Array.from({length:4},(_,i) => ({...row(i+1),show_id:777}));
  const saved = structuredClone(original);
  const dates = ['2026-11-19','2026-11-20','2026-11-21'];
  const base = {show_id:777,show:'Paper Observatory',seasons:[{season:1,episodeCount:4}],nextAirDate:null};
  const choices = [
    {manualSeasonOrder:'1/4:2'},
    {broadcastOrder:[{number:1,sourceSeason:1,first:1,last:2},{number:2,sourceSeason:1,first:3,last:4}]},
  ];
  for (const order of choices) for (const field of ['nextEpisode','lastAired']) for (const airDate of dates) {
    const airing = {season:1,episode:5,airDate};
    const show = {...base,...order,lastAired:{season:1,episode:4},[field]:airing};
    const result = watchProgress(777,saved,[],show,today), due = airDate <= today;
    assert.deepEqual([result.watchedAired,result.aired,result.complete],[4,due ? 5 : 4,!due]);
    const counts = result.seasons.map(s => [s.aired,s.watchedAired]);
    assert.deepEqual(counts,order.manualSeasonOrder ? [[2,2],[due ? 3 : 2,2]] : [[2,2],[2,2],[due ? 1 : 0,0]]);
    const early = [...saved,{...row(5),show_id:777}];
    assert.equal(watchProgress(777,early,[],show,today).watchedAired,due ? 5 : 4);
  }
  const gap = {...base,...choices[0],lastAired:{season:1,episode:8,airDate:today}};
  assert.deepEqual(watchProgress(777,saved,[],gap,today).seasons.map(s => s.aired),[2,3]);
  assert.equal(watchProgress(777,[...saved,{...row(6),show_id:777}],[],gap,today).watchedAired,4);
  const future = {...base,...choices[0],lastAired:{season:1,episode:4,airDate:'2026-11-21'}};
  assert.deepEqual(watchProgress(777,saved,[],future,today).seasons.map(s => [s.aired,s.watchedAired]),[[2,2],[1,1]]);
  const announced = {...show,seasons:[{season:1,episodeCount:32}],lastAired:{season:1,episode:32},
    nextEpisode:{season:1,episode:33,airDate:today}};
  assert.deepEqual(watchlistNextEpisode({metadata:announced}),{season:3,episode:9,airDate:today});
  assert.deepEqual(watchProgress(id,episodes.map(e=>row(e.episode)),[],announced,today).seasons.map(s => [s.aired,s.watchedAired]),
    [[12,12],[12,12],[9,8]]);
  assert.deepEqual(saved,original);
});

test('Season marks, removal and undo target native identities within the selected broadcast range', () => {
  const range = broadcastSeasons(show)[1], scope = {season:1,broadcast:range};
  const initial = [row(1),row(15),row(30)];
  const through = markAired(initial,show,today,{...scope,through:15},'mark');
  assert.deepEqual(through.changes.map(c => c.row.episode),[13,14]);
  const again = markAired(through.rows,show,today,scope,'again');
  assert.deepEqual(again.changes.map(c => c.row.episode),episodes.slice(12,24).map(e=>e.episode));
  assert.ok(again.changes.every(c => c.row.season === 1 && c.row.episode_id === episodes[c.row.episode-1].episode_id));
  const removed = removeWatches(again.rows,id,1,range);
  assert.deepEqual(removed.rows,[initial[0],initial[2]]);
  const undo = undoWatchEdit(removed.rows,removed.changes,new Set());
  assert.deepEqual([...undo.rows].sort((a,b)=>a.episode-b.episode), [...again.rows].sort((a,b)=>a.episode-b.episode));
  const changed = {...show,seasons:[...show.seasons,{season:2,episodeCount:12,episodes:[]}]};
  assert.throws(() => markAired(initial,changed,today,scope,'again'),/listing changed/);
});

test('Human summary reports broadcast seasons while the portable record retains native CSV identities', async () => {
  const index = [{show_id:id,show:title,year:2000,imdb_id:''}];
  const watched = [row(1),row(13),row(31)];
  const snap = {tables:{watched,lists:[],ratings:[],shows:index},showMetadata:new Map([[id,show]]), externalIds:new Map(),
    seasons:new Map([[tmdbResourceKey({kind:'season',id,season:1}),{episodes}]])};
  const human = await summary(snap,index,0,today).files[0].text();
  assert.deepEqual(human.trim().split('\r\n').slice(1).map(r => r.split(',').slice(2,5)),[['1','1','0'],['2','1','0'],['3','1','0']]);
  const raw = await recordExportFiles(snap,0)[0].text();
  assert.deepEqual(raw.trim().split('\r\n').slice(1).map(r => r.split(',').slice(2,4)),[['1','1'],['1','13'],['1','31']]);
});
