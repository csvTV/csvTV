import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openChromium } from './offline-chromium.mjs';
import { testSite, listen, stop } from './offline-site.mjs';

// Both example IDs are from the mapping project's README. They are matched locally.
async function checkMapping() {
  const { fetchAniListMapping } = await import('/tracker/anilist-mapping.js');
  const requests = [];
  const read = async (input, init) => {
    const request = new Request(input, init);
    const response = await fetch(request);
    requests.push({url:request.url, method:request.method, credentials:request.credentials,
      referrerPolicy:request.referrerPolicy, headers:[...request.headers.keys()], status:response.status});
    return response;
  };
  const matches = await fetchAniListMapping(new Set([3390, 164]), undefined, read);
  return {requests, tv:matches.get(3390)?.kind, film:matches.get(164)?.kind};
}

const {server} = await testSite();
const profile = await mkdtemp(join(tmpdir(), 'csvtv-anilist-mapping-'));
let browser;
try {
  const origin = 'http://127.0.0.1:' + await listen(server);
  browser = await openChromium(profile, async () => { throw Error('Unexpected provider request'); }, {liveProvider:'AniListMapping'});
  await browser.navigate(origin + '/tracker/');
  const {requests, tv, film} = await browser.evaluate('(' + checkMapping.toString() + ')()');
  assert.equal(requests.length, 1);
  const [request] = requests;
  assert.equal(request.url, 'https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-mini.json');
  assert.equal(request.method, 'GET');
  assert.equal(request.credentials, 'omit');
  assert.equal(request.referrerPolicy, 'no-referrer');
  assert.ok(request.headers.every(name => name === 'accept'));
  assert.equal(request.status, 200);
  assert.deepEqual([tv, film], ['show', 'film']);
  console.log('Live mapping passed. The compiled importer matched a series and a film using one anonymous GET.');
} finally {
  try { await browser?.close(); }
  finally { await stop(server); await rm(profile, {recursive:true, force:true, maxRetries:6, retryDelay:150}); }
}
