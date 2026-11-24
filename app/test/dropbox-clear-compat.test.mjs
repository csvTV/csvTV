import assert from 'node:assert/strict';
import test from 'node:test';
import { DropboxApi } from '../src/dropbox-api.ts';
import { checkResponse } from '../src/dropbox-client.ts';
import { adoptReset, resetEpoch, resetMarker, reviewReset } from '../src/dropbox-reset.ts';
import { credentials, FictionalDropbox, memoryStore, time } from './dropbox-sync-fixture-cases.mjs';

test('a previous build can finish a pending clear and leave its claim on the completed marker', async () => {
  const api = new FictionalDropbox(), store = memoryStore(), path = '/csvtv-reset.json';
  const prior = {version:2,generations:{ratings:'first-clear'},ancestry:{ratings:[null]},
    pending:['ratings'],claim:'first-claim',backupsClearedAt:0};
  await api.put(path,JSON.stringify(prior));
  // The previous build spreads the marker and empties pending, retaining unknown properties.
  const completed = {...prior,pending:[]};
  await api.put(path,JSON.stringify(completed));
  const fence = await resetMarker(api);
  assert.equal(await adoptReset(api,store,fence,credentials,()=>time),true);
  assert.deepEqual((await store.snapshot()).local.dropboxResetSeen.generations,{ratings:'first-clear'});
  delete completed.claim;
  await api.put(path,JSON.stringify(completed));
  const withoutClaim = await resetMarker(api);
  assert.equal(resetEpoch(fence),resetEpoch(withoutClaim));
  assert.equal(await adoptReset(api,store,withoutClaim,credentials,()=>time),false);
});

test('Clear Dropbox retries a server failure once per review read and names a persistent failure without writing',async () => {
  const bytes = value => new TextEncoder().encode(JSON.stringify(value));
  for (const [step,message] of [['marker','read the Dropbox clear history'],['root','list the csvTV app folder'],['backups','list the csvTV backups']]) {
    for (const failures of [[503],[503,502],[400]]) {
      const calls = [];
      const api = new DropboxApi({async request(request) {
        assert.ok(['download','list'].includes(request.endpoint),'Review must only read Dropbox');
        const current = request.endpoint === 'download' ? 'marker' : JSON.parse(request.body).path === '' ? 'root' : 'backups';
        const attempt = calls.filter(call=>call===current).length;
        calls.push(current);
        const status = current === step && attempt < failures.length ? failures[attempt] : current === 'marker' ? 409 : 200;
        const reply = {status,metadata:null,bytes:bytes(status===200 ? {entries:[],has_more:false}
          : status===409 ? {error_summary:'path/not_found/'} : {error_summary:'fictional-private-provider-detail'})};
        checkResponse(reply);
        return reply;
      }});
      const review = reviewReset(api,['backups']);
      if (failures.length === 1 && failures[0]===503) {
        assert.deepEqual((await review).backups,[]);
      } else {
        await assert.rejects(review,error=>error.message.includes(message) && error.message.includes('This review made no changes.') &&
          error.message.includes(failures[0]===400 ? 'HTTP 400' : 'server error') && !error.message.includes('fictional-private-provider-detail'));
      }
      assert.equal(calls.filter(call=>call===step).length,failures[0]===400 ? 1 : 2);
    }
  }
});
