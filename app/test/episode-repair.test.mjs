import assert from 'node:assert/strict';
import test from 'node:test';
import { planEpisodeRepair, repairPatch } from '../src/episode-repair.ts';
import { mergeWatched } from '../src/merge.ts';
import { markAired, markEpisode } from '../src/marks.ts';
import { watchProgress } from '../src/progress.ts';
import { withSeasonDetails } from '../src/tmdb-data.ts';

const id = 41;
const watch = (season, episode, episode_id, times_watched) => ({
  show_id: id, show: 'Stone Harbour', season, episode, title: 'Recorded ' + episode_id, episode_id, times_watched,
});
const catalog = (...lists) => new Map(lists.map(([season, ...episodes]) => [season, { season,
  episodes: episodes.map(([episode, episode_id]) => ({ episode, episode_id, title: 'Listed ' + episode_id })) }]));
const show = (...numbers) => ({ show_id: id, seasons: numbers.map(season => ({ season })) });
function apply(rows, patch) {
  const retained = new Map(rows.map(row => [[row.show_id, row.season, row.episode].join('/'), row]));
  for (const key of patch.remove.watched) retained.delete(key.join('/'));
  for (const row of patch.put.watched) retained.set([row.show_id, row.season, row.episode].join('/'), row);
  return [...retained.values()];
}
const figures = rows => rows.map(row => [row.season, row.episode, row.episode_id, row.times_watched])
  .sort((a, b) => a[0] - b[0] || a[1] - b[1]);

test('Individual and bulk marks preserve a moved episode until review and work at its new place after Update', () => {
  const original = [watch(1, 1, 11, 3)];
  const target = watch(2, 2, 11, 1);
  const another = watch(2, 1, 21, 1);
  const data = { show_id: id, show: target.show, seasons: [{ season: 2, episodeCount: 2,
    episodes: [another, target].map(row => ({ ...row, airDate: '2026-01-05' })) }] };
  for (const action of ['mark', 'again']) {
    assert.throws(() => markEpisode(original, target, action), /review/i);
    assert.throws(() => markAired(original, data, '2026-11-18', {}, action), /review/i);
  }
  assert.deepEqual(figures(original), [[1, 1, 11, 3]]);
  const plan = planEpisodeRepair(id, original, show(2), catalog([2, [1, 21], [2, 11]]));
  const repaired = apply(original, repairPatch(plan));
  assert.deepEqual(figures(markAired(repaired, data, '2026-11-18', {}, 'again').rows),
    [[2, 1, 21, 1], [2, 2, 11, 4]]);
  assert.deepEqual(figures(markEpisode(repaired, target, 'again').rows), [[2, 2, 11, 4]]);
});

test('An occupied slot with a different known episode ID cannot receive marks for its replacement', () => {
  const saved = [watch(1, 2, 11, 3)];
  const replacement = watch(1, 2, 22, 1);
  const data = { show_id: id, show: replacement.show, seasons: [{ season: 1, episodeCount: 2,
    episodes: [watch(1, 1, 21, 1), replacement].map(row => ({ ...row, airDate: '2026-01-05' })) }] };
  for (const action of ['mark', 'again']) {
    assert.throws(() => markEpisode(saved, replacement, action), /different episode/i);
    assert.throws(() => markAired(saved, data, '2026-11-18', {}, action), /different episode/i);
  }
  assert.deepEqual(figures(saved), [[1, 2, 11, 3]]);
  const legacy = [{ ...saved[0], episode_id: null }];
  assert.deepEqual(figures(markEpisode(legacy, replacement, 'again').rows), [[1, 2, null, 4]]);
});

test('A legacy watch at a reused position survives without counting towards the replacement or a custom season', () => {
  const saved = watch(1, 2, null, 3);
  const replacement = watch(1, 2, 22, 1);
  const detail = {episodes:[watch(1,1,21,1), replacement].map(row => ({...row,airDate:'2020-01-01'})),reusedPositions:[2]};
  const today = '2026-11-22';
  const info = withSeasonDetails({show_id:id,show:saved.show,seasons:[{season:1,episodeCount:2}]},() => detail);
  for (const show of [info, {...info,broadcastOrder:[{number:1,sourceSeason:1,first:1,last:1},
    {number:2,sourceSeason:1,first:2,last:2}]}]) {
    const result = watchProgress(id,[saved],[],show,today);
    assert.equal(result.aired,2);
    assert.equal(result.watchedAired,0);
    assert.equal(result.recordedEpisodes,1);
    assert.equal(result.plays,3n);
    assert.equal(result.moreToWatch,true);
  }
  for (const action of ['again','mark',{expectedCompleted:0,desiredCompleted:1}]) {
    assert.throws(() => markAired([saved],info,today,{season:1},action),/unidentified|unknown identity/i);
  }
  const other = watch(1,1,21,1);
  assert.throws(() => markAired([other,saved],info,today,{season:1},{expectedCompleted:0,desiredCompleted:1}),/unidentified/i);
  assert.throws(() => markEpisode([saved],replacement,'again',true),/unidentified|unknown identity/i);
  assert.deepEqual(figures(markEpisode([saved],saved,'remove-one').rows),[[1,2,null,2]]);
  const resolved = {...saved,episode_id:22};
  assert.equal(watchProgress(id,[resolved],[],info,today).watchedAired,1);
  assert.deepEqual(figures(markAired([resolved],info,today,{season:1},'again').rows),[[1,1,21,1],[1,2,22,4]]);
});

test('A shift describes its stationary occupant and combined count separately from every moving episode', () => {
  const before = [watch(1, 1, 11, 2), watch(1, 2, 22, 3), watch(1, 3, 33, 4)];
  const plan = planEpisodeRepair(id, before, show(1), catalog([1, [1, 22], [2, 33]]));
  assert.deepEqual(plan.missing, [before[0]]);
  assert.deepEqual(plan.moves.map(m => [m.from.episode, m.to.episode, m.occupied?.episode, m.combinedCount]),
    [[2, 1, 1, 5n], [3, 2, undefined, 4n]]);
  const after = apply(before, repairPatch(plan));
  assert.deepEqual(figures(after), [[1, 1, 22, 5], [1, 2, 33, 4]]);
  assert.deepEqual(after.map(r => r.title), ['Listed 22', 'Listed 33']);
  assert.equal(before[0].times_watched, 2);
});

test('Equal-count swaps within and across seasons converge in both sync orders; a real rewatch follows its ID', () => {
  for (const otherSeason of [1, 2]) {
    const before = [watch(1, 1, 11, 1), watch(otherSeason, 2, 22, 1)];
    const known = otherSeason === 1 ? catalog([1, [1, 22], [2, 11]]) : catalog([1, [1, 22]], [2, [2, 11]]);
    const plan = planEpisodeRepair(id, before, show(...known.keys()), known);
    assert.ok(plan.moves.every(move => !move.occupied));
    const moved = apply(before, repairPatch(plan));
    const rewatch = [{ ...before[0], times_watched: 2 }, before[1]];
    for (const [mine, theirs, count] of [[moved, moved, 1], [moved, rewatch, 2], [rewatch, moved, 2]]) {
      const merged = mergeWatched(before, mine, theirs);
      assert.equal(merged.status, 'merged');
      assert.deepEqual(figures(merged.rows), [[1, 1, 22, 1], [otherSeason, 2, 11, count]]);
    }
  }
});

test('Missing, incomplete and conflicting identities stay separate; a former season listing cannot supersede the current show', () => {
  const unchanged = watch(1, 1, 11, 7), moving = watch(1, 2, 22, 2);
  const before = [unchanged, moving];
  const incomplete = catalog([1, [1, 22]]);
  assert.deepEqual(planEpisodeRepair(id, before, show(1, 2), incomplete).moves, []);
  assert.deepEqual(planEpisodeRepair(id, before, show(1, 2), incomplete).missing, []);
  incomplete.set(2, null);
  assert.deepEqual(planEpisodeRepair(id, before, show(1, 2), incomplete).missing, [unchanged]);
  const duplicate = catalog([1, [1, 22]], [2, [1, 22]]);
  assert.deepEqual(planEpisodeRepair(id, before, show(1, 2), duplicate).moves, []);
  assert.deepEqual(planEpisodeRepair(id, [moving, { ...moving, episode: 4 }], show(1, 2), incomplete).moves, []);
  const removedSeason = catalog([1, [3, 22]], [2, [2, 22]]);
  const fromRemoved = planEpisodeRepair(id, [watch(2, 2, 22, 2)], show(1), removedSeason);
  assert.deepEqual(figures(repairPatch(fromRemoved).put.watched), [[1, 3, 22, 2]]);
});

test('Blank IDs stay in place until an explicitly reviewed merge, and an overflowing total refuses the entire repair', () => {
  const absent = watch(1, 1, null, Number.MAX_SAFE_INTEGER), from = watch(1, 3, 8, 2);
  const plan = planEpisodeRepair(id, [absent, from], show(1), catalog([1, [1, 8]]));
  assert.deepEqual(plan.missing, []);
  assert.equal(plan.moves[0].combinedCount, BigInt(Number.MAX_SAFE_INTEGER) + 2n);
  assert.equal(plan.moves[0].occupied, absent);
  assert.throws(() => repairPatch(plan), /Stone Harbour · Moving S1 E3 to S1 E1 .*too large/);
  assert.equal(absent.episode_id, null);
});
