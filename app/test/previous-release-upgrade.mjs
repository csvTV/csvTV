import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {createRelease} from '../package-release.mjs';
import {openChromium} from './offline-chromium.mjs';
import {linkFixture, offlineProviders, waitForStoredGrant} from './offline-providers.mjs';
import {listen, stop} from './offline-site.mjs';
import {releaseServer, unpack} from './release-site.mjs';
import {readCsv} from '../dist/csv.js';

test('A database created by the previous release migrates an unsynced provider key and watch record', async t => {
  const prior = await unpack(await readFile(process.env.CSVTV_PREVIOUS_RELEASE));
  const next = await unpack((await createRelease(new URL('../dist/', import.meta.url))).bytes);
  const profile = await mkdtemp(join(tmpdir(),'csvtv-previous-release-'));
  let server = releaseServer(prior), browser;
  t.after(async () => {
    try { await browser?.close(); await stop(server); }
    finally { await rm(profile,{recursive:true,force:true,maxRetries:6,retryDelay:150}); }
  });
  const port = await listen(server), origin = 'http://127.0.0.1:' + port;
  const cloud = offlineProviders(origin);
  const oldKey = 'fictional-before-upgrade', newKey = 'fictional-unsynced-replacement';
  await cloud.settings({omdb_key:oldKey});
  const previous = cloud.files.get('/settings.csv');
  browser = await openChromium(profile,cloud.respond);
  await linkFixture(browser,origin,'/',true);
  await waitForStoredGrant(browser,true);
  await browser.evaluate('(' + (async function(input) {
    const {openDeviceStore} = await import('/storage.js');
    const store = await openDeviceStore();
    try {
      const {revision} = await store.whenWriter();
      await store.commit(revision,{
        put:{settings:[{setting:'omdb_key',value:input.key}],
          watched:[{show_id:45,show:'The Listening House',season:1,episode:1,episode_id:45011,title:'Recording 1',times_watched:2}]},
        sync:{settings:{base:input.base,pending:null,lastClientModified:null}},
      });
    } finally { await store.closeForUpdate(); }
  }).toString() + ')(' + JSON.stringify({key:newKey,base:{revision:previous.meta.rev,content:new TextDecoder().decode(previous.bytes)}}) + ')');

  async function rawDeviceContains(values) {
    return browser.evaluate('(' + (async function(values) {
      const db = await new Promise((resolve,reject) => {
        const req = indexedDB.open('csvTV');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      try {
        const stores = [...db.objectStoreNames];
        const tx = db.transaction(stores);
        const records = await Promise.all(stores.flatMap(name => {
          const store = tx.objectStore(name);
          return [store.getAllKeys(),store.getAll()].map(req => new Promise((resolve,reject) => {
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          }));
        }));
        const text = JSON.stringify(records,(_,value) => typeof value === 'bigint' ? value.toString() : value);
        return values.map(value => text.includes(value));
      } finally { db.close(); }
    }).toString() + ')(' + JSON.stringify(values) + ')');
  }
  assert.deepEqual(await rawDeviceContains([oldKey,newKey]),[true,true]);
  await browser.close();
  await stop(server);
  server = releaseServer(next);
  await listen(server,port);
  browser = await openChromium(profile,cloud.respond);
  await browser.navigate(origin + '/#/settings');
  await browser.waitFor('document.querySelector("[data-sign-in]")?.hidden === false','legacy grant cleared before migration');
  await waitForStoredGrant(browser,false);
  assert.equal(cloud.files.get('/settings.csv').meta.rev,previous.meta.rev);
  await linkFixture(browser,origin,'/');
  await browser.navigate(origin + '/#/library');
  await browser.waitFor('document.querySelector(".library-grid strong")?.textContent === "The Listening House" && document.querySelector(".sync-state")?.textContent === "Synced"');
  const rows = name => readCsv(name,cloud.files.get('/'+name+'.csv').bytes).rows;
  assert.equal(rows('watched')[0].times_watched,2);
  assert.deepEqual(rows('settings'),[{setting:'omdb_key',value:newKey}]);
  assert.deepEqual(await rawDeviceContains([oldKey,newKey]),[false,false]);
  for (const [path,file] of cloud.files) if (path.startsWith('/backups/')) {
    const text = new TextDecoder().decode(file.bytes);
    assert.ok(!text.includes(oldKey) && !text.includes(newKey),path);
  }
});
