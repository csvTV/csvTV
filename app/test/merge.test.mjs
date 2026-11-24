import assert from 'node:assert/strict';
import test from 'node:test';
import { answerDoubleMarks, episodeKey, mergeRows, mergeWatched } from '../src/merge.ts';
import { readCsv, writeCsv } from '../src/csv.ts';

const rating = (rating, show_id = 1, show = 'Fiction') => ({ show_id, show, rating });
const list = (list = 'Watchlist', show = 'Fiction', show_id = 1) => ({ list, show, show_id });
const watch = (episode_id, episode, times_watched = 1, options = {}) =>
  ({ show_id: 42, show: 'Fiction', season: 1, episode, title: 'Chapter', times_watched, episode_id, ...options });
const rows = value => value === undefined ? [] : [rating(value)];
const merged = r => { assert.equal(r.status, 'merged'); return r; };
const positions = rows => rows.map(r => [r.season, r.episode, r.episode_id, r.times_watched])
  .sort((a, b) => a[0] - b[0] || a[1] - b[1]);

test('two devices merge empty list names and independent membership edits without colliding with ID zero', () => {
  const rows = (...items) => readCsv('lists',['list,show_id,show',...items].join('\n')).rows;
  const base = rows('Stories,,','Stories,0,Beacon');
  const mine = rows('Stories,,','Weekend,,');
  const theirs = rows('Stories,,','Stories,0,Beacon','Stories,1,Reed');
  for (const [a,b] of [[mine,theirs],[theirs,mine]]) {
    const result = merged(mergeRows('lists',base,a,b));
    assert.deepEqual(result.clashes,[]);
    assert.equal(writeCsv('lists',result.rows),writeCsv('lists',rows('Stories,,','Stories,1,Reed','Weekend,,')));
  }
});

test('ratings cover every addition, deletion, unchanged, clash and change-versus-delete rule', () => {
  for (const [before, mine, theirs, expected, clash = false] of [
    [undefined, 0, undefined, 0], [undefined, undefined, 3, 3],
    [3, undefined, 3, undefined], [3, 3, undefined, undefined], [3, undefined, undefined, undefined],
    [3, 4, 3, 4], [3, 3, 4, 4], [3, 4, 4, 4], [3, 4, 5, 4, true],
    [undefined, 4, 5, 4, true], [undefined, 4, 4, 4], [3, undefined, 4, 4], [3, 4, undefined, 4],
  ]) {
    const result = merged(mergeRows('ratings', rows(before), rows(mine), rows(theirs)));
    assert.deepEqual(result.rows, rows(expected), JSON.stringify([before, mine, theirs]));
    assert.equal(result.clashes.length, Number(clash));
  }
});

test('separate value and description changes, pick local on description clashes, never resurrect for a rename', () => {
  const b = rating(5), m = rating(5, 1, 'Local title'), t = rating(7);
  const r = mergeRows('ratings', [b], [m], [t]);
  assert.deepEqual(r.rows, [rating(7, 1, m.show)]);
  assert.equal(r.impact.changedRatings, 1);
  assert.deepEqual(mergeRows('ratings', [b], [b], [rating(5, 1, 'Remote title')]).remoteChangedKeys, []);
  assert.deepEqual(mergeRows('ratings', [b], [m], []).rows, []);
  assert.deepEqual(mergeRows('lists', [list()], [], [list('Watchlist', 'New')]).rows, []);
  const conflict = mergeRows('lists', [list()], [list('Watchlist', 'Mine')], [list('Watchlist', 'Theirs')]);
  assert.deepEqual(conflict.rows, [list('Watchlist', 'Mine')]);
  assert.equal(conflict.clashes.length, 0);
});

test('settings use rating rules and report only the setting name; Undo sees equal concurrent changes', () => {
  const setting = value => ({ setting: 'tmdb_key', value });
  const merge = (b, m, t) => mergeRows('settings', [setting(b)], [setting(m)], [setting(t)]);
  const conflict = merge('fictional-base', 'fictional-local', 'fictional-remote');
  assert.deepEqual(conflict.rows, [setting('fictional-local')]);
  assert.deepEqual(conflict.clashes, [{ setting: 'tmdb_key' }]);
  assert.equal(merge('fictional-base', 'fictional-base', 'fictional-new').impact.changedSettings, 1);
  assert.deepEqual(mergeRows('ratings', rows(3), rows(4), rows(4)).remoteChangedKeys, ['1']);
  assert.deepEqual(mergeRows('ratings', rows(3), [], []).remoteChangedKeys, ['1']);
  assert.deepEqual(mergeRows('lists', [], [list()], [list()]).remoteChangedKeys, ['["Watchlist",1]']);
  assert.deepEqual(mergeRows('lists', [list()], [list()], [list('Watchlist', 'Renamed')]).remoteChangedKeys, []);
  assert.deepEqual(mergeRows('lists', [list()], [], []).remoteChangedKeys, ['["Watchlist",1]']);
});

test('no base preserves additions, exact list names, zero ratings and the higher count', () => {
  const l = mergeRows('lists', null, [list('ANIME')], [list('Anime')]);
  assert.ok(l.noBase);
  assert.deepEqual(l.rows, [list('ANIME'), list('Anime')]);
  const ratings = mergeRows('ratings', null, [rating(0)], [rating(7), rating(3, 2)]);
  assert.deepEqual(ratings.rows, [rating(0), rating(3, 2)]);
  assert.deepEqual(ratings.clashes, [{ show_id: 1, mine: 0, theirs: 7 }]);
  const a = watch(10, 1, 3), b = watch(11, 2);
  const w = merged(mergeWatched(null, [a], [{ ...a, times_watched: 4 }, b]));
  assert.deepEqual(positions(w.rows), [[1, 1, 10, 4], [1, 2, 11, 1]]);
  assert.deepEqual(w.remoteChangedEpisodes.sort(), [episodeKey(a), episodeKey(b)].sort());
});

test('rewatches follow a stable ID through swaps in either sync order and between seasons', () => {
  const a = watch(10, 1), b = watch(11, 2);
  const base = [a, b], offline = [{ ...a, times_watched: 2 }, b];
  for (const season of [1, 2]) {
    const moved = [{ ...b, episode: 1 }, { ...a, season, episode: 2 }];
    for (const [m, t] of [[moved, offline], [offline, moved]]) {
      const result = merged(mergeWatched(base, m, t));
      assert.deepEqual(positions(result.rows), [[1, 1, 11, 1], [season, 2, 10, 2]]);
      assert.equal(result.impact.removedRows, 0);
      assert.equal(result.impact.loweredCounts, 0);
      assert.equal(result.impact.localToRemoteDifferences, 1);
    }
    const equal = merged(mergeWatched(base, moved, moved));
    assert.deepEqual(positions(equal.rows), positions(moved));
    assert.deepEqual(equal.remoteChangedEpisodes, []);
    assert.equal(equal.impact.localToBaseDifferences, 0);
  }
});

test('blank IDs align with an unambiguous stable ID and remain blank with no evidence', () => {
  const b = watch(null, 1), m = { ...b, title: 'New title' }, t = watch(77, 1, 2, { show: 'New show' });
  const result = merged(mergeWatched([b], [m], [t]));
  assert.deepEqual(result.rows, [{ ...t, title: m.title }]);
  assert.deepEqual(new Set(result.remoteChangedEpisodes), new Set([episodeKey(b), episodeKey(t)]));
  assert.deepEqual(merged(mergeWatched([b], [m], [b])).rows, [m]);
  assert.deepEqual(merged(mergeWatched([b], [m], [])).rows, []);
});

test('repeated IDs, moved blank rows, divergent moves and collisions preserve every input for review', () => {
  const a = watch(10, 1), b = watch(11, 2), moved = { ...a, episode: 2 }, blank = watch(null, 1);
  for (const [base, mine, theirs] of [
    [null, [], [a, moved]], [null, [a], [moved]], [[a], [moved], [{ ...a, episode: 3 }]],
    [[blank, b], [moved, { ...b, episode: 1 }], [blank, b]], [null, [a], [watch(11, 1)]],
    [[blank], [a], [watch(11, 1)]],
  ]) {
    const result = mergeWatched(base, mine, theirs);
    assert.equal(result.status, 'identity-review');
    assert.ok(result.conflicts.length >= 2);
    assert.deepEqual(result.inputs, { before: base ?? [], mine, theirs });
    assert.ok(!('rows' in result));
  }
  // Identical IDs in different shows identify independent episodes.
  const other = { ...a, show_id: 7 };
  assert.equal(merged(mergeWatched(null, [], [a, other])).rows.length, 2);
});

test('manual identity review consumes each row once and expires on any input or revision change', () => {
  const base = [watch(10, 1)], mine = [watch(10, 2, 2)], theirs = [watch(10, 3)];
  const versions = { recordVersion: 1n, baseRevision: 'b1', remoteRevision: 't2' };
  const review = mergeWatched(base, mine, theirs, { versions });
  const group = { show_id: 42, season: 1, episode: 3, episode_id: 10, before: 0, mine: 0, theirs: 0 };
  const opts = assignments => ({ versions, resolution: { token: review.token, assignments } });
  assert.deepEqual(positions(merged(mergeWatched(base, mine, theirs, opts([group]))).rows), [[1, 3, 10, 2]]);
  for (const mapping of [[], [group, group], [{ ...group, mine: 1 }], [{ ...group, show_id: 999 }],
    [{ ...group, theirs: undefined }], [{ ...group, episode: -1 }]]) {
    assert.equal(mergeWatched(base, mine, theirs, opts(mapping)).status, 'identity-review');
  }
  for (const change of [{ remoteRevision: 't3' }, { baseRevision: 'b2' }, { recordVersion: 2n }]) {
    assert.equal(mergeWatched(base, mine, theirs, { ...opts([group]), versions: { ...versions, ...change } }).status,
      'identity-review');
  }
  assert.equal(mergeWatched(base, [{ ...mine[0], times_watched: 3 }], theirs, opts([group])).status, 'identity-review');
  const unversioned = mergeWatched(base, mine, theirs);
  assert.equal(mergeWatched(base, mine, theirs, { resolution: { token: unversioned.token, assignments: [group] } })
    .status, 'identity-review');
});

test('double-mark answers work per episode, with one default; held merges list new unanswered changes', () => {
  const b = [watch(10, 1, 2), watch(11, 2, 6)], m = [watch(10, 1, 3), watch(11, 2, 4)];
  const t = [watch(10, 1, 4), watch(11, 2, 3)];
  const review = mergeWatched(b, m, t);
  assert.equal(review.status, 'double-mark');
  assert.equal(review.episodes.length, 2);
  const answers = answerDoubleMarks(review, 'one', new Map([[episodeKey(b[0]), 'two']]));
  const result = merged(mergeWatched(b, m, t, { answers }));
  assert.deepEqual(result.rows.map(r => r.times_watched), [5, 3]);
  assert.equal(result.impact.loweredCounts, 1);
  assert.equal(result.impact.lostViewings, 1n);
  const held = merged(mergeWatched(b, m, t, { hold: true }));
  assert.deepEqual(held.rows.map(r => r.times_watched), [5, 1]);
  assert.equal(held.unansweredDoubleMarks.length, 2);
  const next = watch(12, 3);
  const afterAnswer = merged(mergeWatched(b, [...m, next], [...t, next], { answers }));
  assert.deepEqual(afterAnswer.rows.map(r => r.times_watched), [5, 3, 2]);
  assert.deepEqual(afterAnswer.unansweredDoubleMarks.map(d => d.key), [episodeKey(next)]);
  const changedBase = merged(mergeWatched(b, m, t, { answers,
    versions: { recordVersion: 1n, baseRevision: 'other', remoteRevision: 'current' } }));
  assert.equal(changedBase.unansweredDoubleMarks.length, 2);
});

test('watch deltas use exact intermediates, floor negative counts, and stop overflow before returning any rows', () => {
  const f = (id, count) => watch(id, id, count);
  const max = Number.MAX_SAFE_INTEGER;
  assert.equal(merged(mergeWatched([f(1, max)], [f(1, max)], [f(1, max - 1)])).rows[0].times_watched, max - 1);
  const over = mergeWatched([f(1, 1)], [f(1, max)], [f(1, 2)], { hold: true });
  assert.equal(over.status, 'overflow');
  assert.equal(over.episode.episode_id, 1);
  assert.ok(!('rows' in over));
  assert.deepEqual(merged(mergeWatched([f(1, 5)], [f(1, 1)], [], { hold: true })).rows, []);
  const mixed = merged(mergeWatched([f(1, 5)], [f(1, 7)], [f(1, 4)]));
  assert.equal(mixed.rows[0].times_watched, 6);
});

test('two devices converge after independent additions, removals and count changes in either sync order', () => {
  const a = watch(10, 1, 2), b = watch(11, 2), c = watch(12, 3), d = watch(13, 4);
  for (const order of [[0, 1, 0], [1, 0, 1]]) {
    const base = [a, b];
    let remote = base;
    const devices = [{ base, mine: [{ ...a, times_watched: 3 }, c] },
      { base, mine: [{ ...a, times_watched: 4 }, b, d] }];
    for (const i of order) {
      const device = devices[i];
      const result = merged(mergeWatched(device.base, device.mine, remote, { hold: true }));
      remote = device.base = device.mine = result.rows;
    }
    const expected = [[1, 1, 10, 5], [1, 3, 12, 1], [1, 4, 13, 1]];
    for (const d of devices) {
      assert.deepEqual(positions(d.mine), expected);
      assert.equal(writeCsv('watched', d.mine), writeCsv('watched', remote));
    }
    assert.deepEqual(positions(remote), expected);
  }
});
