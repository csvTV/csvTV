import assert from "node:assert/strict";
import test from "node:test";
import { emptyTables, MAX_INTEGER } from "../src/model.ts";
import { localCalendarDate, watchProgress } from "../src/progress.ts";
import { markEpisode, markAired, removeWatches, undoWatchEdit } from "../src/marks.ts";
import { deriveShows } from "../src/shows.ts";
import { episodeKey, mergeWatched } from "../src/merge.ts";
import {watchlistSections, watchlistUpcomingDate} from '../src/record-overview.ts';

const today = "2026-11-18";

test('Watchlist groups unstarted shows by schedule and excludes every show with a saved watch', () => {
  function series(id,title,header,watched = [],list = 'Watchlist') {
    const metadata = header && {show_id:id,show:title,seasons:[],lastAired:null,nextAirDate:null,...header};
    const rows = watched.map(([season,episode]) => ({show_id:id,show:title,season,episode,episode_id:null,title:'Chapter',times_watched:1}));
    return {id,title,metadata,progress:watchProgress(id,rows,[{list,show_id:id,show:title}],metadata,today)};
  }
  const episodeDate = airDate => ({season:1,episode:2,airDate});
  const shows = [
    series(1,'Future',{firstAirDate:'2026-11-19'}),
    series(2,'Returning',{nextEpisode:episodeDate('2026-11-20')}),
    series(3,'Backlog',{firstAirDate:'2025-01-01',seasons:[{season:1,episodeCount:3}],lastAired:episodeDate('2026-11-17')},[[1,1]]),
    series(4,'Finished single season',{status:'Ended',seasons:[{season:1,episodeCount:2}],lastAired:episodeDate('2026-11-17')},[[1,1],[1,2]]),
    series(5,'Unknown',null),
    series(6,'Aired',{firstAirDate:'2025-01-01'}),
    series(7,'Another returning',{nextEpisode:episodeDate(null)}),
    series(8,'Only a special',{lastAired:{season:0,episode:1,airDate:'2025-02-01'}}),
    series(9,'Early watch',{nextEpisode:episodeDate('2026-11-18')},[[1,2]]),
    series(10,'Opted out',{firstAirDate:'2026-11-18'},[],'Hidden from upcoming'),
    series(12,'Stored special',null,[[0,1]],'Following upcoming'),
  ];
  const groups = date => {
    const {upcoming,available}=watchlistSections(shows,date);
    return [upcoming.map(s=>s.id),available.map(s=>s.id)];
  };
  assert.deepEqual(groups(today),[[1,2,7,8,5],[6]]);
  assert.deepEqual(groups('2026-11-19'),[[2,7,8,5],[6,1]]);
  assert.deepEqual(groups('2026-11-20'),[[7,8,5],[6,1,2]]);
  const special = series(11,'Advance special',{seasons:[{season:0,episodeCount:2}],firstAirDate:'2026-11-10',
    lastAired:{season:0,episode:1,airDate:'2026-11-10'},nextEpisode:{season:0,episode:2,airDate:'2026-11-19'}});
  assert.equal(watchlistUpcomingDate(special,today),null);
  assert.deepEqual(watchlistSections([special],today),{upcoming:[special],available:[]});
});
const episode = (n, date = today) => ({ episode: n, episode_id: 100 + n, title: "Chapter " + n, airDate: date });
const show = {
  show_id: 7, show: "Fictional serial",
  seasons: [
    { season: 0, episodeCount: 1, episodes: [episode(1)] },
    { season: 1, episodeCount: 4, episodes: [episode(1), episode(2), episode(3, "2026-11-19"), episode(4, null)] },
  ],
  lastAired: { season: 1, episode: 2 }, nextAirDate: "2026-11-19",
};
const row = (season, n, count) => ({ show_id: 7, show: show.show, season, episode: n,
  title: "Chapter " + n, episode_id: season * 100 + n, times_watched: count });
const list = name => ({ list: name, show_id: 7, show: show.show });
const progress = (rows, lists = [], info = show, date = today) => watchProgress(7, rows, lists, info, date);

test("completion and rewatch use aired episodes; plays include future episodes and specials", () => {
  const rows = [row(0, 1, 9), row(1, 1, 3), row(1, 2, 2), row(1, 4, 5)];
  const p = progress(rows);
  assert.deepEqual([p.aired, p.watchedAired, p.completed, p.recordedEpisodes, p.plays], [2, 2, 2, 4, 19n]);
  assert.deepEqual(p.seasons[1].rewatch, { viewing: 3, watched: 1, total: 2 });
  assert.equal(p.seasons[0].completed, null);
  assert.equal(p.seasons[0].rewatch, null);
  assert.equal(p.complete, true);
  assert.equal(p.upcoming, null);
  const tomorrow = progress(rows, [], show, "2026-11-19");
  assert.equal(tomorrow.completed, 0);
  assert.equal(tomorrow.moreToWatch, true);
  assert.equal(tomorrow.seasons[1].rewatch, null);
  assert.equal(localCalendarDate(new Date(2026, 10, 18, 0, 1)), today);
});

test('a replaced episode keeps its recorded plays but cannot complete a different episode at the same position', () => {
  const rows = [{...row(1,1,4),episode_id:555}, {...row(1,2,1),episode_id:null}];
  const before = progress(rows);
  assert.deepEqual([before.plays,before.watchedAired,before.aired,before.complete],[5n,1,2,false]);
  const repaired = progress([{...rows[0],episode_id:101}, rows[1]]);
  assert.deepEqual([repaired.plays,repaired.watchedAired,repaired.aired,repaired.complete],[5n,2,2,true]);
});

test("show metadata estimates missing seasons, seasonal detail overrides the estimate", () => {
  const info = { ...show, seasons: [
    { season: 0, episodeCount: 8 }, { season: 1, episodeCount: 3 },
    { season: 2, episodeCount: 5 }, { season: 3, episodeCount: 4, episodes: [] },
  ], lastAired: { season: 2, episode: 1 } };
  const p = progress([row(1, 2, 1), row(2, 5, 10)], [], info);
  assert.deepEqual(p.seasons.map(s => s.aired), [0, 3, 1, 0]);
  assert.equal(p.watchedAired, 1);
  assert.equal(progress([], [], { ...info, lastAired: { season: 0, episode: 8 } }).aired, 0);
  const unknown = progress([row(1, 2, 3)], [list("Watchlist")], null);
  assert.deepEqual([unknown.recordedEpisodes, unknown.completed, unknown.moreToWatch, unknown.upcoming], [1, null, false, null]);
});

test('An announced regular episode crosses its local air date offline without crediting skipped, undated or special episodes', () => {
  const rows = [row(1,1,1), row(1,2,1), row(2,1,3)];
  const seasons = [{season:1,episodeCount:2}, {season:2,episodeCount:8}, {season:0,episodeCount:6}];
  const next = {season:2,episode:3,airDate:'2026-11-19'};
  const summary = (announced, date, knownSeasons = seasons, saved = rows) => {
    const value = progress(saved, [], {...show, seasons:knownSeasons, nextEpisode:announced}, date);
    return [value.watchedAired, value.aired, value.complete];
  };
  assert.deepEqual(summary(next, today), [2,2,true]);
  assert.deepEqual(summary(next, next.airDate), [2,3,false]);
  assert.deepEqual(summary(next, next.airDate, seasons, [...rows,row(2,3,1)]), [3,3,true]);
  assert.deepEqual(summary({...next,airDate:null}, next.airDate), [2,2,true]);
  assert.deepEqual(summary({...next,season:0}, next.airDate), [2,2,true]);
  assert.deepEqual(summary({...next,season:1,episode:2}, next.airDate), [2,2,true]);
  const postponed = [seasons[0], {...seasons[1], episodes:[episode(3,'2026-11-23')]}, seasons[2]];
  assert.deepEqual(summary(next, next.airDate, postponed), [2,2,true]);
  assert.deepEqual(summary(next, next.airDate, [seasons[0]]), [2,3,false]);
  const oldDetails = [seasons[0], {...postponed[1],newerHeader:true}, seasons[2]];
  assert.deepEqual(summary(next, next.airDate, oldDetails), [2,3,false]);
  assert.deepEqual(summary(next, next.airDate, [seasons[0],{...seasons[1],episodes:[]}]), [2,2,true]);
  const aired = {...show,seasons:oldDetails,lastAired:next,nextEpisode:null};
  assert.equal(progress(rows,[],aired,next.airDate).seasons[1].aired,1);
  const missingSeason = {...aired,seasons:[seasons[0]]};
  assert.deepEqual(progress(rows,[],missingSeason,next.airDate).seasons.map(s => [s.season,s.watchedAired,s.aired]),
    [[1,2,2],[2,0,1]]);
  const split = {...show, seasons:[{season:1,episodeCount:4}], nextEpisode:{...next,season:1},
    broadcastOrder:[{number:1,sourceSeason:1,first:1,last:2},{number:2,sourceSeason:1,first:3,last:4}]};
  assert.deepEqual(progress(rows,[],split,next.airDate).seasons.map(s => [s.season,s.watchedAired,s.aired]), [[1,2,2],[2,0,1]]);
  const futureLast = {...show,seasons:[{season:1,episodeCount:2}],lastAired:{season:1,episode:2,airDate:'2026-11-19'}};
  for (const date of [today,'2026-11-19']) {
    const result = progress(rows,[],futureLast,date), expected = date === today ? 1 : 2;
    assert.deepEqual([result.watchedAired,result.aired],[expected,expected]);
  }
});

test("Stopped, Watchlist, missing dates, and shows with only specials", () => {
  assert.equal(progress([row(0, 1, 1)]).moreToWatch, true);
  assert.equal(progress([], [list("wAtChLiSt")]).upcoming, "watchlist");
  assert.equal(progress([], [list("WATCHLIST"), list("stOPped")]).upcoming, null);
  assert.equal(progress([], [list("Following upcoming")], null).upcoming, "watchlist");
  assert.equal(progress([], [list("watchlist"),list("Following upcoming"),list("HIDDEN FROM UPCOMING")]).upcoming, null);
  const partial = progress([row(1, 1, 1)], [list("STOPPED")]);
  assert.deepEqual([partial.complete, partial.moreToWatch, partial.upcoming], [false, false, null]);
  const complete = progress([row(1, 1, 1), row(1, 2, 1)], [list("Stopped")]);
  assert.deepEqual([complete.complete, complete.upcoming], [true, null]);
  const special = { ...show, seasons: [show.seasons[0]], nextAirDate: "2026-11-17" };
  const p = progress([row(0, 1, 2)], [], special);
  assert.deepEqual([p.complete, p.completed, p.moreToWatch, p.upcoming], [false, null, false, null]);
  assert.equal(progress([row(0, 1, 2)], [list("Watchlist")], special).upcoming, null);
  assert.equal(progress([row(0, 1, 2)], [], { ...special, nextAirDate: today }).upcoming, null);
});

test("Library rewatch rechecks an estimated completion against the actual aired episode set", () => {
  const rows = [row(1,1,3)];
  const headerOnly = {...show, seasons:[{season:1,episodeCount:1}],lastAired:{season:1,episode:1}};
  assert.equal(watchProgress(7,rows,[],headerOnly,today).complete,true);
  assert.throws(() => markAired(rows, show, today, {}, "rewatch-complete"), /no longer complete/);
  const completed = markAired(rows, show, today, {}, "mark").rows;
  assert.deepEqual(completed.map(r=>r.times_watched),[3,1]);
  assert.deepEqual(markAired(completed, show, today, {}, "rewatch-complete").rows.map(r=>r.times_watched),[4,2]);
});

test("watched controls use actual season detail, separate manual marks, and exclude specials for whole shows", () => {
  const rows = [row(0, 1, 3), row(1, 2, 4)];
  const marked = markAired(rows, show, today, {}, "mark");
  assert.deepEqual(marked.changes.map(d => d.change), [1n]);
  assert.equal(marked.rows.find(r => r.season === 1 && r.episode === 2).times_watched, 4);
  const again = markAired(rows, show, today, { season: 1 }, "again");
  assert.deepEqual(again.changes.map(d => d.change), [1n, 1n]);
  assert.equal(again.rows.find(r => r.season === 0).times_watched, 3);
  assert.equal(markAired([], show, today, { season: 1, through: 1 }, "mark").rows.length, 1);
  assert.equal(markAired([], show, today, { season: 0 }, "mark").rows.length, 1);
  const manual = markEpisode([], row(1, 3, 0), "mark");
  assert.equal(manual.rows[0].times_watched, 1);
  assert.deepEqual(markEpisode(manual.rows, manual.rows[0], "remove-one").rows, []);
  const cleared = removeWatches(again.rows, 7);
  assert.deepEqual(cleared.rows, [rows[0]]);
  assert.deepEqual(cleared.changes.map(d => d.change).sort(), [-1n, -5n]);
  assert.deepEqual(removeWatches(rows, 7, 0).rows, [rows[1]]);
  assert.throws(() => markAired(rows, { ...show, seasons: [...show.seasons, { season: 2, episodeCount: 5 }] }, today, {}, "mark"), /season 2/);
  assert.deepEqual(rows, [row(0, 1, 3), row(1, 2, 4)]);
});

test("count edits are atomic at the per-row bound and play totals stay exact", () => {
  const rows = [row(1, 1, 1), row(1, 2, MAX_INTEGER)];
  assert.throws(() => markAired(rows, show, today, {}, "again"), /watch limit for Chapter 2/);
  assert.equal(progress(rows).plays, 9007199254740992n);
  assert.equal(rows[0].times_watched, 1);
  const removed = removeWatches(rows, 7);
  assert.deepEqual(undoWatchEdit([], removed.changes, new Set()).rows, rows);
});

test('An exact episode count changes only its original episode, rejects a stale edit and undoes every added play at once', () => {
  const rows = [row(1,1,3),row(1,2,2)], episode = rows[0];
  const set = (record, expectedCount, desiredCount) => markEpisode(record, episode, {expectedCount,desiredCount});
  const raised = set(rows,3,MAX_INTEGER);
  assert.deepEqual(raised.rows.map(r=>r.times_watched),[MAX_INTEGER,2]);
  assert.deepEqual(undoWatchEdit(raised.rows,raised.changes,new Set()).rows,rows);
  assert.throws(()=>set(raised.rows,3,0),/count changed/);
  assert.throws(()=>set([{...episode,episode_id:9999}],3,1),/episode at this position changed/);
  for (const value of [-1,1.5,MAX_INTEGER+1,NaN]) assert.throws(()=>set(rows,3,value),/whole episode watch count/);
  assert.deepEqual(set(rows,3,0).rows,[rows[1]]);
  assert.deepEqual(set([],0,4).rows,[{...episode,times_watched:4}]);
});

test('Changing a season count preserves episode-specific plays, scopes to aired episodes, and is one reversible edit', () => {
  const edit = (rows, expectedCompleted, desiredCompleted) =>
    markAired(rows, show, today, {season:1}, {expectedCompleted,desiredCompleted});
  const original = [row(0,1,2),row(1,1,1),row(1,2,3),row(1,3,6),row(1,4,4)];
  const raised = edit(original,1,4);
  assert.deepEqual(raised.rows.map(r=>r.times_watched),[2,4,6,6,4]);
  assert.deepEqual(raised.changes.map(c=>c.change),[3n,3n]);
  assert.deepEqual(undoWatchEdit(raised.rows,raised.changes,new Set()).rows,original);
  const lowered = edit(raised.rows,4,0);
  assert.deepEqual(lowered.rows,[original[0],row(1,2,2),original[3],original[4]]);
  const added = edit(lowered.rows,0,2);
  assert.equal(added.rows.find(r=>r.season===1 && r.episode===1).times_watched,2);
  assert.equal(added.rows.find(r=>r.season===1 && r.episode===2).times_watched,4);
  assert.throws(()=>edit(original,2,3),/count changed/);
  for (const value of [-1,2.5,Infinity,MAX_INTEGER+1]) assert.throws(()=>edit(original,1,value),/whole season watch count/);
  assert.throws(()=>edit(original,1,MAX_INTEGER),/watch limit for Chapter 2/);
  assert.deepEqual(original.map(r=>r.times_watched),[2,1,3,6,4]);
  for (const scope of [{},{season:0},{season:1,through:1}])
    assert.throws(()=>markAired(original,show,today,scope,{expectedCompleted:0,desiredCompleted:2}),/regular season/);
  assert.throws(()=>markAired(original,show,'1900-01-01',{season:1},{expectedCompleted:0,desiredCompleted:1}),/no aired episodes/);
});

test('Season count edits recheck display breaks and reject changed or duplicated episode identities in both directions', () => {
  const split = {...show,manualSeasonOrder:'1/4:1'};
  const range = {number:2,sourceSeason:1,first:2,last:4};
  const rows = [row(1,1,2),row(1,2,3),row(1,3,7)];
  const adjust = (records,info,scope,n) => markAired(records,info,today,scope,{expectedCompleted:3,desiredCompleted:n});
  assert.deepEqual(adjust(rows,split,{season:1,broadcast:range},1).rows,[rows[0],row(1,2,1),rows[2]]);
  assert.throws(()=>adjust(rows,split,{season:1},1),/listing changed/);
  assert.throws(()=>adjust(rows,show,{season:1,broadcast:range},1),/listing changed/);
  for (const n of [1,4]) {
    assert.throws(()=>adjust([rows[0],{...rows[1],episode_id:777}],split,{season:1,broadcast:range},n),/different episode/);
    const duplicate = {...rows[2],episode_id:rows[1].episode_id};
    assert.throws(()=>adjust([...rows.slice(0,2),duplicate],split,{season:1,broadcast:range},n),/another position/);
  }
});

test('Bulk marks reject two aired positions for one stable ID even if the earlier recorded position has no ID', () => {
  const details = {...show, seasons:[1, 2].map(season => ({season, episodeCount:1, episodes:[episode(1)]}))};
  const original = [{...row(1, 1, 3), episode_id:null}];
  for (const action of ['mark', 'again']) {
    assert.throws(() => markAired(original, details, today, {}, action), /multiple positions/);
    assert.equal(original[0].times_watched, 3);
  }
  assert.equal(markAired(original, details, today, {season:1}, 'again').rows[0].times_watched, 4);
});

test("a season removed from metadata stays visible until its record is empty", () => {
  const p = progress([row(9, 1, 2)]);
  const season = p.seasons.find(s => s.season === 9);
  assert.deepEqual([season.aired, season.recordedEpisodes, season.completed], [0, 1, null]);
  assert.equal(p.plays, 2n);
});

test("Undo follows the marked identity through a swap, and protects actual remote changes", () => {
  const before = [row(1, 1, 1), row(1, 2, 1)];
  const edit = markEpisode(before, before[0], "again");
  const remote = [{ ...before[0], episode: 2, title: "New title" },
    { ...before[1], episode: 1, times_watched: 3 }];
  const merged = mergeWatched(before, edit.rows, remote);
  assert.equal(merged.status, "merged");
  const undo = undoWatchEdit(merged.rows, edit.changes, new Set(merged.remoteChangedEpisodes));
  assert.equal(undo.skipped, 0);
  assert.deepEqual(undo.rows, remote);
  const missing = undoWatchEdit([], edit.changes, new Set([episodeKey(before[0])]));
  assert.deepEqual(missing, { rows: [], skipped: 1 });
});

test("Undo keeps a unique original position when an ID is repeated and refuses an ambiguous move", () => {
  const before = row(1, 1, 1);
  const edit = markEpisode([before], before, "again");
  const duplicate = { ...edit.rows[0], episode: 2 };
  const kept = undoWatchEdit([...edit.rows, duplicate], edit.changes, new Set());
  assert.deepEqual(kept.rows, [before, duplicate]);
  const moved = [duplicate, { ...duplicate, episode: 3 }];
  assert.deepEqual(undoWatchEdit(moved, edit.changes, new Set()), { rows: moved, skipped: 1 });
});

test("the show index is rebuilt from the three record tables and merges fallback fields independently", () => {
  const tables = emptyTables();
  tables.watched.push(row(1, 1, 1));
  tables.lists.push({ list: "Watchlist", show_id: 8, show: "" });
  tables.ratings.push({ show_id: 7, show: "Old", rating: 0 });
  tables.shows.push({ show_id: 7, show: "Imported", year: 2023, imdb_id: "tt0000001" },
    { show_id: 9, show: "Removed", year: null, imdb_id: "" });
  assert.deepEqual(deriveShows(tables, [{ show_id: 7, show: "Current", year: null, imdb_id: "" }]), [
    { show_id: 7, show: "Current", year: 2023, imdb_id: "tt0000001" },
    { show_id: 8, show: "", year: null, imdb_id: "" },
  ]);
  assert.equal(tables.shows[1].show_id, 9);
});
