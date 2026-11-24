import { connectFixtureProviders } from './provider-fixture-cases.mjs';
import { openDeviceStore } from '../dist/storage.js';
import { TmdbClient } from '../dist/tmdb-client.js';
import { TmdbLibrary } from '../dist/tmdb-library.js';
import { TmdbService } from '../dist/tmdb-service.js';

function check(value, message) { if (!value) throw Error(message); }
function gate() {
  let release;
  return { promise: new Promise(resolve => { release = resolve; }), release };
}
async function until(predicate, message) {
  const deadline = performance.now() + 5000;
  while (!await predicate()) {
    if (performance.now() >= deadline) throw Error(message);
    await new Promise(resolve => setTimeout(resolve, 15));
  }
}
const config = { images: { secure_base_url: 'https://image.tmdb.org/t/p/',
  poster_sizes: ['w92'], backdrop_sizes: ['w300'], still_sizes: ['w185'], profile_sizes: ['w45'] } };
const series = id => 'Fictional programme ' + id;
const watch = id => ({ show_id: id, show: series(id), season: 1, episode: 1, episode_id: id * 100,
  title: 'Opening', times_watched: 2 });
const member = id => ({ id, name: 'Fictional actor ' + id, roles: [{ character: 'Guide' }], total_episode_count: 1 });

function provider(intercept) {
  const calls = [];
  const client = new TmdbClient({ fetch: async url => {
    const path = new URL(url).pathname.slice('/3/'.length);
    calls.push(path);
    await intercept?.(path);
    if (path === 'configuration') return Response.json(config);
    if (path === 'configuration/countries') return Response.json([{ iso_3166_1: 'NZ', english_name: 'New Zealand' }]);
    const request = /^tv\/(\d+)(?:\/(aggregate_credits|season\/1))?$/.exec(path);
    if (!request || request[1] === '404') return new Response(null, { status: 404 });
    const id = Number(request[1]);
    if (request[2] === 'aggregate_credits') return Response.json({ id, cast: [member(id + 10)] });
    if (request[2] === 'season/1') return Response.json({ season_number: 1,
      episodes: [{ id: id * 100, episode_number: 1, name: 'Opening', air_date: '2020-01-01', runtime: 42 }] });
    return Response.json({ id, name: series(id), seasons: [{ season_number: 1, episode_count: 1 }],
      last_episode_to_air: { season_number: 1, episode_number: 1, air_date: '2020-01-01' }, status: 'Ended',
      keywords: { results: [] }, external_ids: {}, vote_average: 8.25, vote_count: 4 });
  } });
  return { calls, client };
}

async function removeDatabase(name) {
  const remove = indexedDB.deleteDatabase(name);
  await new Promise((resolve, reject) => { remove.onsuccess = resolve; remove.onerror = () => reject(remove.error); });
}

export async function statisticsJobCases(run) {
  await run('First Statistics opening is device-local and atomic through a failed write, reader handoff, and restart', async () => {
    const name = 'statistics-open-' + crypto.randomUUID();
    const first = await openDeviceStore({ name });
    let second, reopened;
    try {
      const initial = await first.whenWriter();
      second = await openDeviceStore({ name });
      await second.openStatistics();
      check(!(await first.snapshot()).local.statisticsOpened, 'A read-only tab enabled background requests');
      first.close();
      await second.whenWriter();
      const changes = [];
      second.addEventListener('recordchange', e => changes.push(e.detail));
      const put = IDBObjectStore.prototype.put;
      let failed = false;
      try {
        IDBObjectStore.prototype.put = function(...args) {
          if (this.name === 'meta' && args[1] === 'revision') throw new DOMException('Injected failure', 'QuotaExceededError');
          return put.apply(this, args);
        };
        try { await second.openStatistics(); } catch (error) { failed = error.name === 'QuotaExceededError'; }
      } finally { IDBObjectStore.prototype.put = put; }
      const afterFailure = await second.snapshot();
      check(failed && !changes.length && afterFailure.revision === initial.revision && !afterFailure.local.statisticsOpened,
        'The failed first-open transaction changed the flag, revision or listeners');
      await Promise.all([second.openStatistics(), second.openStatistics(), second.openStatistics()]);
      check(changes.length === 1 && changes[0].localKeys.join() === 'statisticsOpened' && !changes[0].tables.length,
        'Repeated openings produced extra changes or wrote a CSV table');
      second.close();
      reopened = await openDeviceStore({ name });
      const snapshot = await reopened.whenWriter();
      check(snapshot.local.statisticsOpened === true && snapshot.revision === initial.revision + 1n &&
        !snapshot.tables.settings.length && !Object.keys(snapshot.sync).length, 'Reopening lost the local-only first-open flag');
    } finally { reopened?.close(); second?.close(); first.close(); await removeDatabase(name); }
  });

  await run('The first Statistics opening queues cast and countries and publishes committed credits while another request is pending', async () => {
    const name = 'statistics-arrival-' + crypto.randomUUID();
    const store = await openDeviceStore({ name });
    const slow = gate();
    const { client, calls } = provider(path => path === 'tv/2/aggregate_credits' ? slow.promise : undefined);
    const service = new TmdbService(store, client, { online: () => true, visible: () => true, now: Date.now });
    let library;
    try {
      const snapshot = await connectFixtureProviders(store,name);
      await store.commit(snapshot.revision, { put: { watched: [watch(1), watch(2)],
        ratings: [{ show_id: 3, show: series(3), rating: 3 }, { show_id: 404, show: series(404), rating: 0 }] } });
      await service.saveKey('fictional-statistics');
      library = new TmdbLibrary(service);
      await library.run();
      check(!calls.some(path => path.includes('credits') || path.includes('countries')), 'Cast or countries fetched before Statistics opened');
      const warmed = calls.length;
      let updates = 0, earlyCredit = false;
      let inspected = Promise.resolve();
      library.addEventListener('cachechange', () => {
        updates++;
        inspected = Promise.all([service.read({ kind: 'cast', id: 1 }), service.read({ kind: 'cast', id: 2 })]).then(([a, b]) => {
          if (a?.value?.[0].id === 11 && b === null) earlyCredit = true;
        });
      });
      await store.openStatistics();
      await until(() => calls.includes('tv/2/aggregate_credits') && earlyCredit,
        'First opening did not publish available cast data before the blocked request finished');
      slow.release();
      await library.run();
      await inspected;
      const fetched = calls.slice(warmed).sort();
      check(fetched.join('|') === ['configuration/countries', 'tv/1/aggregate_credits', 'tv/2/aggregate_credits', 'tv/3/aggregate_credits'].join('|'),
        'Unneeded or missing first-open requests: ' + fetched.join());
      check((await service.read({ kind: 'countries' })).value[0].name === 'New Zealand' &&
        (await service.read({ kind: 'cast', id: 2 })).value[0].id === 12 && updates > 1, 'The final chart data did not publish');
      await store.openStatistics();
      await library.run();
      check(calls.length === warmed + fetched.length, 'Revisiting Statistics refetched fresh credits');
    } finally { slow.release(); library?.close(); service.close(); store.close(); await removeDatabase(name); }
  });

  await run('Statistics opened without a key is remembered at startup and cast and country data follow their refresh ages', async () => {
    const name = 'statistics-reopen-' + crypto.randomUUID();
    const { client, calls } = provider();
    let now = Date.now(), online = false;
    const env = { online: () => online, visible: () => true, now: () => now };
    let store = await openDeviceStore({ name });
    let service = new TmdbService(store, client, env);
    let library;
    try {
      const snapshot = await connectFixtureProviders(store,name);
      await store.commit(snapshot.revision, { put: { watched: [watch(1)] } });
      library = new TmdbLibrary(service);
      await store.openStatistics();
      await library.run();
      check(!calls.length, 'Offline Statistics attempted a request');
      library.close(); service.close(); store.close();
      store = await openDeviceStore({ name });
      await connectFixtureProviders(store,name);
      service = new TmdbService(store, client, env);
      library = new TmdbLibrary(service);
      online = true;
      await library.run();
      check(!calls.length, 'Keyless startup attempted a request');
      await service.saveKey('fictional-statistics-reopened');
      await library.run();
      check((await service.read({ kind: 'show', id: 1 })).value.voteAverage === 8.25 &&
        (await service.read({ kind: 'cast', id: 1 })).value.length && (await service.read({ kind: 'countries' })).value.length,
        'A key saved after a restart did not fill the Statistics metadata');
      calls.length = 0;
      now += 60 * 86_400_000 - 1;
      await library.run();
      check(!calls.length, 'An ended show or countries refreshed too early');
      now++;
      await library.run();
      check(calls.sort().join('|') === ['configuration','configuration/countries','tv/1','tv/1/aggregate_credits','tv/1/season/1'].join('|'),
        'Cast and countries did not refresh with the ended show at 60 days');
    } finally { library?.close(); service.close(); store.close(); await removeDatabase(name); }
  });
}
