import assert from 'node:assert/strict';
import test from 'node:test';
import {planAniListImport} from '../src/anilist-preview.ts';
import {describeImportChanges, sameImportOutcome} from '../src/import-preview.ts';
import {emptyTables, rowKey} from '../src/model.ts';

const show = (id, title) => ({show_id:id, show:title, year:2020, imdb_id:''});
const coast = show(7, 'Festival Lights'), ridge = show(9, 'The Winter Gate');
const entry = (series, id, score, status = 2, favourite = false) => ({show_id:series.show_id, id, score, status, favourite});
const list = (series, name) => ({show_id:series.show_id, show:series.show, list:name});
const rating = (series, value) => ({show_id:series.show_id, show:series.show, rating:value});
const episode = (series, n, count, id = 500 + n) => ({show_id:series.show_id, show:series.show, season:1,
  episode:n, title:'Part ' + n, episode_id:id, times_watched:count});
const source = (changes = {}) => ({shows:[coast], watched:[], entries:[], notices:[], reusedPositions:new Set(), ...changes});
const local = (changes = {}) => ({local:{}, tables:{...emptyTables(), ...changes}});

test('AniList groups progressed entries by show and reports only importable episode ranges in each TMDB season', () => {
  const episodes = [1,2,3,5,6,7,8].map(n => episode(coast,n,1));
  const nextSeason = [1,2].map(n => ({...episode(coast,n,1,600+n),season:2}));
  const records = [[21,5],[22,3],[23,2],[24,1],[25,1]];
  const range = (entryId,season,first,last) => ({entryId,showId:7,season,first,last});
  const placed = source({shows:[coast,ridge], archive:{entries:records.map(([id,progress]) => ({id,progress}))},
    entries:[...records.slice(0,4).map(([id]) => ({...entry(coast,id,0),targetSeason:id === 24 ? 3 : 1})),entry(ridge,25,0)],
    watched:[...episodes,...nextSeason,episode(ridge,1,1,901)],
    entryRanges:[range(21,1,1,3),range(21,1,5,5),range(22,1,6,8),range(23,2,1,2),{entryId:25,showId:9,season:1,first:1,last:1}]});
  const record = local({watched:[episode(coast,1,4),episode(coast,2,3,999)]});
  const result = planAniListImport(placed,record);
  assert.deepEqual(result.entryGroups,[{show_id:7,show:coast.show,entries:[
    {id:21,progress:5,matched:3,seasons:[{season:1,ranges:[[1,1],[3,3],[5,5]]}]},
    {id:22,progress:3,matched:3,seasons:[{season:1,ranges:[[6,8]]}]},
    {id:23,progress:2,matched:2,seasons:[{season:2,ranges:[[1,2]]}]},
    {id:24,progress:1,matched:0,seasons:[{season:3,ranges:[]}]},
  ]}]);
  assert.equal(result.watched.find(proposal => proposal.row.episode_id === 501).after,4);
  assert.equal(result.reviewShows.length,0,'Two distinct entries can share a season without a watch conflict');

  const seriesWide = source({archive:{entries:[{id:31,progress:3}]},entries:[entry(coast,31,0)],
    watched:[episode(coast,1,1),...nextSeason],entryRanges:[range(31,1,1,1),range(31,2,1,2)]});
  assert.deepEqual(planAniListImport(seriesWide,local()).entryGroups[0].entries[0].seasons,
    [{season:1,ranges:[[1,1]]},{season:2,ranges:[[1,2]]}]);
  const specials = source({archive:{entries:[{id:31,progress:1},{id:32,progress:1}]},entries:[entry(coast,31,0),entry(coast,32,0)],
    watched:[{...episode(coast,1,1),season:0},{...episode(coast,2,1),season:0}],entryRanges:[range(31,0,1,1),range(32,0,2,2)]});
  assert.deepEqual(planAniListImport(specials,local()).entryGroups,[]);
});

test('A regular unplaced entry offers a manual regular season even when no exported episode could be matched', () => {
  const notice = {kind:'unplaced',entryId:32,showId:7,episodes:2,review:true,text:'Mapped season is unavailable.'};
  const candidates = [episode(coast,1,0),episode(coast,2,0)];
  const placed = source({archive:{entries:[{id:32,progress:2}]}, entries:[{...entry(coast,32,0),targetSeason:8}],
    entryRanges:[], notices:[notice], reviewSeasonNumbers:new Map([[7,[1]]]),reviewLoadedSeasons:new Map([[7,new Set([1])]]),
    reviewCandidates:new Map([[7,candidates]])});
  const base = planAniListImport(placed,local());
  assert.equal(base.reviewShows[0].seasons[0].canIncrease,true);
  assert.equal(base.reviewShows[0].canIncrease,false);
  assert.deepEqual(base.entryGroups[0].entries,[{id:32,progress:2,matched:0,seasons:[{season:8,ranges:[]}]}]);
  const manual = planAniListImport(placed,local(),{seasonExtras:new Map([[7,new Map([[1,1]])]])});
  assert.deepEqual(manual.watched.map(change => [change.row.season,change.row.episode,change.after]),[[1,1,1],[1,2,1]]);
  assert.deepEqual(manual.entryGroups,base.entryGroups,'Manual season passes must not be attributed to the source entry');
  placed.notices = [{...notice,review:false}];
  assert.deepEqual(planAniListImport(placed,local()).reviewShows,[]);
});

test('AniList uses every positive entry score once and rounds only the final mean, with decimal ties going up', () => {
  for (const [scores, expected] of [
    [[80, 90], 8.5], [[70, 70, 80], 7.5], [[75, 80], 8], [[33.3, 99.6, 99.6], 8],
    [[0, 72.49], 7], [[0, 72.5], 7.5], [[1e-7, 1e-7], 0], [[100], 10], [[0, 0], null],
  ]) {
    const entries = scores.map((score, i) => entry(coast, i + 1, score)).reverse();
    const plan = planAniListImport(source({entries}), local());
    assert.equal(plan.ratings[0]?.after ?? null, expected);
    const positive = scores.flatMap((score, i) => score ? [{id:i + 1, score}] : []);
    assert.deepEqual(plan.scoreGroups, new Set(positive.map(row => row.score)).size > 1
      ? [{...rating(coast, expected), scores:positive}] : []);
  }
});

test('Matched entries retain Anime, other memberships and ratings even when all their episodes were unplaceable', () => {
  const notices = [{text:'Festival Lights · season 2 is unavailable.', kind:'unplaced'},
    {text:'AniList 200 is a film.', anilistId:200, kind:'film'}];
  const matched = source({shows:[coast, ridge], notices, entries:[
    entry(coast, 11, 90, 1, true), entry(coast, 12, 80, 3, true), entry(ridge, 13, 0, 12),
  ]});
  const plan = planAniListImport(matched, local({ratings:[rating(coast, 0)],
    lists:[list(ridge, 'Anime'), list(ridge, 'anime'), list(ridge, 'favourites'), list(ridge, 'WATCHLIST')]}));
  assert.deepEqual(plan.ratings, [{row:rating(coast, 8.5), before:0, after:0}]);
  assert.deepEqual(plan.changes.put.ratings, []);
  assert.deepEqual(plan.changes.put.lists, ['Anime','anime','Favorites','Dropped','WATCHLIST'].map(name => list(coast, name)));
  assert.deepEqual(plan.changes.put.watched, []);
  assert.deepEqual(plan.notices, notices);
  assert.deepEqual(plan.skipped, []);
});

test('Planning proposes only unstarted shows and drops the proposal when a peer watches the show', () => {
  const matched = source({shows:[coast,ridge], watched:[episode(coast, 1, 2)], entries:[
    entry(coast, 12, 0, 1), entry(ridge, 13, 80, 1),
  ]});
  const approved = planAniListImport(matched, local({lists:[list(coast, 'Watchlist')]}));
  assert.deepEqual(approved.lists.filter(item => item.row.list === 'Watchlist').map(item => item.row), [list(ridge,'Watchlist')]);
  const afterSync = planAniListImport(matched, local({watched:[episode(ridge, 1, 1)], ratings:[rating(ridge, 9)],
    lists:[list(coast, 'Watchlist')]}));
  assert.deepEqual(afterSync.lists.filter(item => item.row.list === 'Watchlist'), []);
  assert.equal(afterSync.changes.remove.lists, undefined);
  assert.equal(sameImportOutcome(approved,afterSync),false);
  const changes = describeImportChanges(afterSync, approved).join('\n');
  assert.match(changes, /keep your rating 9 \(AniList 8\)/);
  assert.match(changes, /Removed from this preview .*Watchlist/);
  for (const preference of ['HIDDEN FROM UPCOMING','Following UPCOMING','watchList']) {
    const record = local({watched:[episode(ridge, 1, 1)],lists:[list(ridge,preference)]});
    const retained = planAniListImport(matched,record);
    assert.deepEqual(retained.changes.put.lists.filter(row => row.show_id === ridge.show_id).map(row => row.list),['Anime']);
  }
  const existingSpelling = planAniListImport(matched,local({lists:[list(ridge,'FOLLOWING UPCOMING')]}));
  assert.ok(existingSpelling.lists.some(item => item.row.show_id === ridge.show_id && item.row.list === 'Watchlist' && item.present));
  assert.ok(!existingSpelling.changes.put.lists.some(row => row.list === 'Watchlist'));
  const unwatchedOptOut = planAniListImport(matched,local({lists:[list(ridge,'Hidden from upcoming')]}));
  assert.ok(!unwatchedOptOut.changes.put.lists.some(row => row.show_id === ridge.show_id && row.list === 'Watchlist'));
});

test('An explicit Pick Up survives repeat import of older Dropped and Planning entries', () => {
  const placed=source({entries:[entry(coast,31,0,3),entry(coast,32,0,1)]});
  const plan=planAniListImport(placed,local({lists:[list(coast,'CSvtv: picked UP'),list(coast,'Watchlist')]}));
  assert.deepEqual(plan.changes.put.lists,[list(coast,'Anime')]);
  assert.equal(plan.lists.some(({row}) => row.list === 'Dropped'),false);
});

test('A repeated AniList import preserves the record, and a fresh placement cannot overwrite a different watched episode', () => {
  const placed = source({watched:[episode(coast, 1, 2), episode(coast, 2, 1)], entries:[entry(coast, 11, 75, 0, true)]});
  const old = local({watched:[episode(coast, 1, 5)]});
  const first = planAniListImport(placed, old);
  assert.deepEqual(first.watched.map(item => item.after), [5, 1]);
  const saved = local();
  for (const name of ['shows', 'watched', 'ratings', 'lists']) {
    const merged = new Map(old.tables[name].map(row => [rowKey(name, row), row]));
    for (const row of first.changes.put[name]) merged.set(rowKey(name, row), row);
    saved.tables[name] = [...merged.values()];
  }
  const again = planAniListImport(placed, saved);
  assert.ok(Object.values(again.changes.put).every(rows => rows.length === 0));
  assert.deepEqual(again.changes.remove.watched, []);
  saved.tables.watched[1] = episode(coast, 2, 4, 999);
  const conflict = planAniListImport(placed, saved);
  assert.equal(conflict.watched.length, 1);
  assert.deepEqual(conflict.changes.put.watched, []);
  assert.match(conflict.skipped[0], /S1 E2.*another watched episode occupies/);
  assert.equal(sameImportOutcome(again,conflict),false);
});

test('AniList season passes cover every aired episode, whole-show passes cover only export matches and undo restores the baseline', () => {
  const aired = Array.from({length:12},(_,i) => episode(coast,i+1,0));
  const seen = [episode(coast,1,2),episode(coast,2,2),episode(coast,3,1),episode(coast,13,1)];
  const archive = source({watched:seen,entries:[entry(coast,23,80)],
    notices:[{kind:'rewatching',text:'Current viewing',showId:7,episodes:0}],
    reviewSeasonNumbers:new Map([[7,[0,1,2]]]),reviewLoadedSeasons:new Map([[7,new Set([1,2])]]),
    reviewCandidates:new Map([[7,aired]])});
  const choices = (passes, whole) => ({seasonExtras:new Map([[7,new Map([[1,passes]])]]),wholeShowPasses:new Map([[7,whole]])});
  const plan = (passes, whole, snapshot=local()) => planAniListImport(archive,snapshot,choices(passes,whole));
  const base = plan(0,0);
  assert.deepEqual(base.watched.map(p => p.after),[2,2,1,1]);
  const seasonCount = result => result.reviewShows[0].seasons.find(s => s.season === 1).displayCount;
  assert.deepEqual(base.reviewShows[0].seasons.map(s => [s.season,s.displayCount,s.canIncrease,s.canDecrease]),
    [[0,0,true,false],[1,1,true,false],[2,0,false,false]]);
  assert.equal(seasonCount(plan(1,0)),2);
  assert.deepEqual(plan(1,0).watched.slice(0,4).map(p => p.after),[3,3,2,1]);
  const reviewed = plan(2,3);
  const counts = new Map(reviewed.watched.map(p => [p.row.episode,p.after]));
  assert.deepEqual(Array.from({length:13},(_,i) => counts.get(i+1)),[7,7,6,...Array(9).fill(2),4]);
  assert.equal(reviewed.reviewShows[0].playDelta,36n);
  assert.deepEqual(reviewed.ratings,base.ratings);
  assert.deepEqual(reviewed.lists,base.lists);
  assert.deepEqual(plan(0,3).watched.map(p => p.after),[5,5,4,4]);
  assert.ok(sameImportOutcome(plan(0,0),base));
  assert.deepEqual(plan(-1,1).watched.map(p => p.after),[2,2,1,2]);
  assert.equal(seasonCount(plan(-1,1)),1);
  assert.deepEqual(plan(-2,1).choices.seasonExtras,new Map());
  const saved = local({watched:reviewed.changes.put.watched,shows:[coast],
    ratings:reviewed.changes.put.ratings,lists:reviewed.changes.put.lists});
  assert.ok(Object.values(plan(2,3,saved).changes.put).every(rows => !rows.length));

  // A newly occupied slot cannot receive a season pass or inflate the show correction.
  const conflict = plan(1,1,local({watched:[episode(coast,1,10,999),episode(coast,4,3,998),episode(coast,3,8)]}));
  assert.equal(conflict.reviewShows[0].playDelta,13n);
  assert.equal(conflict.reviewShows[0].seasons[1].blockedEpisodes,2);
  assert.equal(conflict.watched.find(p => p.row.episode === 3).after,8);
  assert.deepEqual(conflict.changes.remove.watched,[]);
  archive.notices = [{kind:'unplaced',text:'Report',showId:7,episodes:1}];
  assert.deepEqual(plan(2,3).watched.map(p => p.after),[2,2,1,1]);
  assert.deepEqual(plan(2,3).reviewShows,[]);
});
