import assert from 'node:assert/strict';
import test from 'node:test';
import { readMergeInput } from '../src/core.ts';
import { guardFile, guardMerge } from '../src/guard.ts';
import { mergeRows, mergeWatched } from '../src/merge.ts';

const rating = i => ({ show_id: i, show: 'Fiction', rating: 7 });
const rows = n => Array.from({ length: n }, (_, i) => rating(i + 1));
const file = (remote, extra = {}) => guardFile({ remote, hasBase: true, localRows: 5, ...extra });

test('case 1 requires confirmed absence with a base; readable or previously absent files may merge', () => {
  assert.equal(file('missing').case, 1);
  assert.deepEqual(file('missing').choices, ['restore-device', 'take-remote', 'cancel']);
  assert.deepEqual(file('missing', { localRows: 0 }).choices, ['take-remote', 'cancel']);
  assert.equal(file('missing', { hasBase: false }), null);
  assert.equal(file('readable'), null);
});

test('case 1 blocks unreadable files without a base too; unknown formats take precedence over repair', () => {
  assert.deepEqual(file('damaged', { hasBase: false }).choices, ['restore-device', 'cancel']);
  assert.deepEqual(file('damaged', { localRows: 0 }).choices, ['cancel']);
  assert.deepEqual(file('unsupported').choices, ['reload', 'cancel']);
  assert.deepEqual(file('unidentifiable').choices, ['cancel']);
});

test('case 2 requires strictly over 20 percent at 50 or more local rows', () => {
  const base = rows(50);
  function guard(b, t) { return guardMerge(mergeRows('ratings', b, b, t).impact); }
  assert.equal(guard(base, base.slice(10)), null);
  assert.equal(guard(base.slice(1), base.slice(12)), null);
  const result = guard(base, base.slice(11));
  assert.equal(result.case, 2);
  assert.equal(result.reason, 'over-one-fifth-removed');
  assert.deepEqual(result.choices, ['restore-device', 'take-remote', 'merge-anyway', 'cancel']);
});

test('case 2 catches all original rows removed despite replacements, or an emptied remote despite local additions', () => {
  const base = rows(1), additions = [rating(2)];
  const removed = mergeRows('ratings', base, base, additions);
  assert.equal(removed.rows.length, 1);
  assert.equal(guardMerge(removed.impact).reason, 'all-local-rows-removed');
  const emptied = mergeRows('ratings', base, [...base, ...additions], []);
  assert.equal(guardMerge(emptied.impact).reason, 'remote-emptied');
  assert.equal(guardMerge(mergeRows('ratings', base, [], []).impact), null);
  assert.equal(guardMerge(mergeRows('ratings', [], additions, []).impact), null);
  assert.equal(guardMerge(mergeRows('ratings', null, additions, []).impact), null);
});

test('case 3 for either uncertain history or a missing target overrides ordinary missing-file handling', () => {
  for (const unresolvedPending of ['unknown-outcome', 'missing-target']) {
    for (const state of ['readable', 'missing']) {
      const decision = file(state, { unresolvedPending });
      assert.equal(decision.case, 3);
      assert.deepEqual(decision.choices, ['combine', 'take-remote', 'cancel']);
    }
    for (const state of ['damaged', 'unidentifiable']) {
      assert.deepEqual(file(state, { unresolvedPending }).choices, ['cancel']);
    }
    assert.deepEqual(file('unsupported', { unresolvedPending }).choices, ['reload', 'cancel']);
  }
});

test('case 2 figures follow stable episodes; exact lost-viewing totals exclude removed and renamed rows', () => {
  const max = Number.MAX_SAFE_INTEGER;
  const b = [1, 2, 3, 4].map(episode => ({ show_id: 8, show: 'Fiction', season: 1, episode,
    episode_id: episode, title: 'Chapter', times_watched: max }));
  const t = [
    { ...b[0], episode: 2, times_watched: 1 },
    { ...b[1], episode: 1, times_watched: 2 },
    { ...b[2], title: 'New chapter' },
  ];
  const merged = mergeWatched(b, b, t);
  assert.equal(merged.status, 'merged');
  assert.equal(merged.impact.removedRows, 1);
  assert.equal(merged.impact.loweredCounts, 2);
  assert.equal(merged.impact.lostViewings, 2n * BigInt(max) - 3n);
  assert.equal(guardMerge(merged.impact), null);
  const renamed = mergeRows('ratings', rows(1), rows(1), [{ ...rating(1), show: 'New name' }]);
  assert.equal(renamed.impact.changedRatings, 0);
  assert.equal(renamed.impact.removedRows, 0);
});
test('the download boundary withholds partial rows, never rewrites newer settings, and distinguishes absence', () => {
  const state = { hasBase: true, localRows: 2 };
  const cases = [
    ['ratings', 'show_id,rating\n1,8\n2,broken', 'damaged', ['restore-device', 'cancel']],
    ['settings', 'setting,value\nimdb_source,future\ngithub_token,"broken', 'unsupported', ['reload', 'cancel']],
    ['settings', 'setting,value\ngithub_token,"broken', 'unidentifiable', ['cancel']],
    ['ratings', null, 'missing', ['restore-device', 'take-remote', 'cancel']],
  ];
  for (const [table, content, reason, choices] of cases) {
    const checked = readMergeInput(table, content, state);
    assert.equal(checked.status, 'guard');
    assert.equal(checked.decision.reason, reason);
    assert.deepEqual(checked.decision.choices, choices);
    assert.ok(!('rows' in checked));
  }
  assert.deepEqual(readMergeInput('ratings', null, { ...state, hasBase: false }), { status: 'ready', rows: [] });
  assert.deepEqual(readMergeInput('ratings', 'show_id,rating\n1,0', state).rows, [{ show_id: 1, show: '', rating: 0 }]);
});
