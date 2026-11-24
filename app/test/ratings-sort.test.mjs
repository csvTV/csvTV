import assert from 'node:assert/strict';
import test from 'node:test';
import { compareRatings } from '../src/ratings-screen.ts';

test('Most played uses exact play totals and breaks ties by title', () => {
  const rows = [
    {id:5,title:'North',plays:0n}, {id:1,title:'Red',plays:9007199254740993n},
    {id:2,title:'Dawn',plays:9007199254740992n}, {id:3,title:'South',plays:10n},
    {id:4,title:'After',plays:10n},
  ];
  assert.deepEqual(rows.toSorted((a,b)=>compareRatings(a,b,'plays')).map(row=>row.id),[1,2,4,3,5]);
});
