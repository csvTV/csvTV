import assert from 'node:assert/strict';
import test from 'node:test';
import {createNoticeHistory} from '../dist/notice-history.js';
import {noticeLimit} from '../dist/storage.js';

test('a burst saves the latest notices once, and stale account or writer batches never reach storage',async () => {
  let account = 'fictional-first';
  const writes = [];
  const store = {role:'writer',async saveNotices(owner,entries) {
    writes.push([owner,entries.map(entry=>entry.message)]);
  }};
  const history = createNoticeHistory(store,()=>account);
  for (let i=1;i<=500;i++) history.add('Message '+i);
  await Promise.resolve();
  assert.deepEqual(writes,[[account,Array.from({length:noticeLimit},(_,i)=>'Message '+(500-i))]]);

  history.add('Previous account');
  account = 'fictional-second';
  await Promise.resolve();
  history.add('Before erase');
  history.reset();
  history.add('After erase');
  await Promise.resolve();
  history.add('Released writer');
  store.role = 'reader';
  await Promise.resolve();
  history.add('Reader only');
  await Promise.resolve();
  assert.deepEqual(writes.slice(1),[['fictional-second',['After erase']]]);
});
