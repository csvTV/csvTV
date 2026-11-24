import assert from 'node:assert/strict';
import test from 'node:test';
import { providerDeadline } from '../src/provider-http.ts';

const now = Date.UTC(2026, 10, 19);
const deadline = (retry, reset) => providerDeadline(new Headers({
  'Retry-After': retry, ...(reset ? {'X-RateLimit-Reset': reset} : {}),
}), now);

test('all three HTTP date formats convey the same UTC instant, including two-digit years and leap seconds', () => {
  const until = Date.UTC(2068, 10, 20, 23, 59, 59);
  for (const value of ['Tue, 20 Nov 2068 23:59:59 GMT', 'Tuesday, 20-Nov-68 23:59:59 GMT',
    'Tue Nov 20 23:59:59 2068']) assert.equal(deadline(value), until, value);
  assert.equal(deadline('Sat Oct  3 04:05:06 2065'), Date.UTC(2065, 9, 3, 4, 5, 6));
  assert.equal(deadline('Thu, 31 Dec 2026 23:59:60 GMT'), Date.UTC(2027, 0, 1));
  assert.equal(deadline('Thursday, 19-Nov-76 00:00:00 GMT'), Date.UTC(2076, 10, 19));
  assert.equal(deadline('Friday, 19-Nov-76 00:00:01 GMT'), undefined);
});

test('invalid dates and unrepresentable rate-limit deadlines cannot indefinitely pause a provider', () => {
  const backup = Date.UTC(2026, 10, 20);
  for (const value of ['Mon, 31 Feb 2027 01:00:00 GMT', 'Monday, November 2029',
    'Sun, 31 Jan 2027 03:00:00 EST', 'Sun, 31 Jan 2027 03:00:00', 'Mon, 31 Jan 2027 03:00:00 GMT',
    'Sun, 31 Jan 2027 25:00:00 GMT', '8700000000000']) {
    assert.equal(deadline(value), undefined, value);
    assert.equal(deadline(value, String(backup / 1000)), backup, value);
  }
  assert.equal(deadline('10', '8700000000000'), now + 10_000);
});
