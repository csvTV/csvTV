import assert from 'node:assert/strict';
import test from 'node:test';
import { isAnime } from '../src/anime.ts';
import { emptyTables } from '../src/model.ts';
import { normalizeTmdb, tmdbImageUrl } from '../src/tmdb-data.ts';
import { cacheExpired, cacheExpiresAt, carrySeasonHistory, metadataRewrite, refreshDue, TmdbDetailJob } from '../src/tmdb-refresh.ts';

const day = 86_400_000;
const now = Date.parse('2026-11-18T14:15:16Z');
const today = '2026-11-18';
const config = { images: { secure_base_url: 'https://image.tmdb.org/t/p/', poster_sizes: ['w500', 'original'],
  backdrop_sizes: ['w300'], profile_sizes: ['h632'], still_sizes: ['w185'] } };
const rawShow = (id = 1) => ({
  id, name: 'Fictional series ' + id, first_air_date: '2020-01-01', status: 'Returning Series',
  origin_country: ['NZ'], genres: [{ id: 4, name: 'Drama' }], networks: [{ id: 5, name: 'North' }],
  keywords: { results: [{ id: 7, name: 'anime' }] }, external_ids: { imdb_id: 'tt0000001' },
  last_episode_to_air: { season_number: 2, episode_number: 3, air_date: '2026-11-10' },
  next_episode_to_air: { season_number: 2, episode_number: 4, air_date: '2026-11-20' },
  seasons: [0, 1, 2].map(s => ({ season_number: s, episode_count: 4, name: 'Season ' + s })),
});
const rawEpisode = (n, epId) => ({ episode_number: n, id: epId, season_number: 1, show_id: 1,
  name: 'Episode ' + n, air_date: n === 2 ? null : today, runtime: n === 2 ? null : 25,
  still_path: n === 2 ? null : '/north.jpg' });
const rawSeason = (...episodes) => ({ season_number: 1, episodes });
const show = (id = 1) => normalizeTmdb({ kind: 'show', id }, rawShow(id));
const watch = (id, s, n, episode_id = null) => ({ show_id: id, show: 'Old name', season: s,
  episode: n, episode_id, title: 'Old name', times_watched: 3 });

test('Anime grouping follows the current user lists or the exact TMDB keyword in each show refresh', () => {
  const record = { lists: [], metadata: null, myanimelist: 8.7 };
  assert.equal(isAnime(record), false);
  for (const name of ['Anime', 'anime', 'ANIME', 'aNiMe']) assert.equal(isAnime({ ...record, lists: ['Later', name] }), true);
  for (const name of [' Anime', 'Anime ', 'Animé', 'Anıme', 'Anime series', 'Japanese animation']) {
    assert.equal(isAnime({ ...record, lists: [name] }), false);
  }
  assert.equal(isAnime({ lists: [], metadata: {} }), false); // A cached show with no keyword data.
  const tagged = show();
  assert.equal(isAnime({ lists: [], metadata: tagged }), true);
  const refreshed = normalizeTmdb({ kind: 'show', id: 1 }, { ...rawShow(), genres: [{ id: 4, name: 'Animation' }],
    original_language: 'ja', keywords: { results: [{ id: 15, name: 'anime convention' }] } });
  assert.equal(isAnime({ lists: [], metadata: refreshed }), false);
  assert.equal(isAnime({ lists: ['ANIME'], metadata: refreshed }), true);
});

test('normalize the requested show, numbered seasons and English episode data for the step 1 core', () => {
  const result = show();
  assert.equal(result.show_id, 1);
  assert.equal(result.show, 'Fictional series 1');
  assert.equal(result.nextAirDate, '2026-11-20');
  assert.deepEqual(result.lastAired, { season: 2, episode: 3, airDate: '2026-11-10' });
  assert.equal(result.imdbId, 'tt0000001');
  assert.deepEqual(result.keywords, [{ id: 7, name: 'anime' }]);
  const resource = { kind: 'season', id: 1, season: 1 };
  const s = normalizeTmdb(resource, rawSeason(rawEpisode(1, 101), rawEpisode(2, 102)));
  assert.deepEqual(s.episodes.map(e => [e.episode, e.episode_id, e.runtime, e.airDate, e.stillPath]),
    [[1, 101, 25, today, '/north.jpg'], [2, 102, null, null, null]]);
  for (const invalid of [
    rawSeason({ ...rawEpisode(1, 101), show_id: 41 }), rawSeason({ ...rawEpisode(1, 101), air_date: '2026-02-31' }),
    rawSeason(rawEpisode(1, 101), rawEpisode(1, 102)), rawSeason(rawEpisode(1, 101), rawEpisode(2, 101)),
    { ...rawSeason({ ...rawEpisode(1, 101), show_id: undefined }), show_id: 41 },
    { season_number: 2, episodes: [] }, { success: false }, null,
  ]) assert.throws(() => normalizeTmdb(resource, invalid), /invalid metadata/);
  assert.throws(() => normalizeTmdb({ kind: 'show', id: 9 }, rawShow()), /invalid metadata/);
  for (const field of ['next_episode_to_air','last_episode_to_air']) {
    const response = rawShow();
    response[field].show_id = 41;
    assert.throws(() => normalizeTmdb({kind:'show',id:1},response),/invalid metadata/);
    response[field].show_id = 1;
    assert.equal(normalizeTmdb({kind:'show',id:1},response).show_id,1);
  }
});

test('configuration uses issued image sizes and only the allowed image host', () => {
  const settings = normalizeTmdb({ kind: 'configuration' }, config);
  assert.equal(tmdbImageUrl(settings, 'poster', 'w500', '/poster.jpg'), 'https://image.tmdb.org/t/p/w500/poster.jpg');
  for (const bad of [null, '//other.example/a.jpg', '/../secret.jpg', '/%2e%2e/secret.jpg', 'https://other.example/a.jpg']) {
    assert.equal(tmdbImageUrl(settings, 'poster', 'w500', bad), null);
  }
  assert.equal(tmdbImageUrl(settings, 'profile', 'w500', '/p.jpg'), null);
  assert.throws(() => normalizeTmdb({ kind: 'configuration' }, { images: { ...config.images, secure_base_url: 'https://other.example/' } }));
});

test('the cached TMDB average distinguishes zero, no votes, missing data and invalid values', () => {
  const average = fields => normalizeTmdb({ kind: 'show', id: 1 }, { ...rawShow(), ...fields }).voteAverage;
  assert.equal(average({ vote_average: 7.875, vote_count: 35 }), 7.875);
  assert.equal(average({ vote_average: 10.25, vote_count: 1 }), 10.25, 'The chart can extend its vertical axis');
  assert.equal(average({ vote_average: 0, vote_count: 2 }), 0);
  assert.equal(average({ vote_average: 0, vote_count: 0 }), null);
  assert.equal(average({}), null);
  for (const value of [-1, Infinity, NaN, '8.1']) assert.throws(() => average({ vote_average: value }), /invalid metadata/);
  assert.throws(() => average({ vote_average: 8, vote_count: -1 }), /invalid metadata/);
});

test('normalize TV results, paged recommendations, countries, cast-only credits, and external ID lookups', () => {
  const title = { id: 1, name: 'North', overview: '', poster_path: null, first_air_date: '' };
  for (const resource of [{ kind: 'search', query: 'north', page: 2 }, { kind: 'recommendations', id: 99, page: 2 }]) {
    assert.equal(normalizeTmdb(resource, { results: [title], page: 2, total_pages: 5 }).results[0].show, 'North');
    assert.throws(() => normalizeTmdb(resource, { results: [], page: 1, total_pages: 5 }));
  }
  assert.deepEqual(normalizeTmdb({ kind: 'countries' }, [{ iso_3166_1: 'NZ', english_name: 'New Zealand' }]),
    [{ code: 'NZ', name: 'New Zealand' }]);
  const cast = normalizeTmdb({ kind: 'cast', id: 1 }, { id: 1, cast: [{ id: 5, name: 'Fictional actor',
    total_episode_count: 12, roles: [{ character: 'Guide' }], profile_path: null }], crew: [{ id: 8 }] });
  assert.deepEqual(cast[0].roles, ['Guide']);
  assert.equal(cast[0].episodeCount, 12);
  assert.deepEqual(normalizeTmdb({ kind: 'person', id: 5 }, { id: 5, cast: [title], crew: [{ id: 9 }] }).map(r => r.show_id), [1]);
  assert.deepEqual(normalizeTmdb({ kind: 'external-ids', id: 1 }, { id: 1, imdb_id: null }), { imdbId: null });
  const found = normalizeTmdb({ kind: 'find', externalId: 'tt0000001', source: 'imdb_id' }, { tv_results: [title],
    movie_results: [{ id: 6 }], tv_episode_results: [{ show_id: 7, id: 33, season_number: 1, episode_number: 2 }] });
  assert.deepEqual(found.episodes, [{ show_id: 7, episode_id: 33, season: 1, episode: 2 }]);
  assert.equal(found.shows.length, 1);
});

test('refresh thresholds distinguish active, overdue, ended, canceled and configuration data at the exact boundary', () => {
  const entry = age => ({ fetchedAt: now - age, value: null });
  for (const status of ['Ended', 'Canceled', 'In Production', 'Returning Series', 'Pilot', 'An unseen status']) {
    const s = { ...show(), status };
    const days = status === 'Ended' || status === 'Canceled' ? 60 : 7;
    for (const kind of ['show', 'season', 'cast']) {
      assert.equal(refreshDue(kind, entry(days * day - 1), now, today, s), false);
      assert.equal(refreshDue(kind, entry(days * day), now, today, s), true);
    }
  }
  const overdue = { ...show(), nextAirDate: '2026-11-17' };
  assert.equal(refreshDue('show', entry(day - 1), now, today, overdue), false);
  assert.equal(refreshDue('show', entry(day), now, today, overdue), true);
  for (const kind of ['countries', 'configuration']) {
    assert.equal(refreshDue(kind, entry(60 * day - 1), now, today), false);
    assert.equal(refreshDue(kind, entry(60 * day), now, today), true);
  }
  assert.equal(refreshDue('show', null, now, today), true);
  const august = Date.parse('2023-08-31T23:59:59Z');
  const expiry = Date.parse('2024-02-29T23:59:59Z');
  assert.equal(cacheExpiresAt(august), expiry);
  assert.equal(cacheExpired(august, expiry - 1), false);
  assert.equal(cacheExpired(august, expiry), true);
  assert.equal(cacheExpired(now + 1, now), true);
});

const key = r => [r.kind, r.id, r.season].filter(v => v !== undefined).join('/');
function library() {
  const tables = emptyTables();
  tables.watched = [watch(1, 1, 1), watch(1, 1, 2), watch(3, 1, 1)];
  tables.ratings = [{ show_id: 2, show: 'Rating only', rating: 8 }];
  tables.lists = [{ show_id: 1, list: 'Stopped', show: 'Both' }, { show_id: 4, list: 'Watchlist', show: 'List only' }];
  return tables;
}
function fixture(tables = library()) {
  const cache = new Map(), calls = [];
  let active = true, statisticsOpened = false;
  const port = {
    active: () => active, now: () => now, today: () => today,
    record: async () => ({ tables, statisticsOpened }),
    read: async r => cache.get(key(r)) ?? null,
    refresh: async r => {
      calls.push(key(r));
      let value = [];
      if (r.kind === 'show') {
        value = r.id === 3 ? null : show(r.id);
        if (r.id === 1) value.lastAired.season = 0;
      }
      const entry = { fetchedAt: now, value };
      cache.set(key(r), entry);
      return entry;
    },
  };
  const job = new TmdbDetailJob(port);
  return { job, port, calls, cache, setActive: v => { active = v; }, setStats: v => { statisticsOpened = v; } };
}

test('whole-library job fetches all referenced shows, deduplicates seasons and adds every regular season after a special', async () => {
  const tables = library();
  tables.lists.push({show_id:5,list:'Following upcoming',show:'Removed'}, {show_id:5,list:'Hidden from upcoming',show:'Removed'});
  const f = fixture(tables);
  await f.job.run();
  assert.deepEqual([...f.calls].sort(), ['configuration', 'season/1/1', 'season/1/2', 'show/1', 'show/2', 'show/3', 'show/4']);
  assert.deepEqual(f.cache.get('show/3'), { fetchedAt: now, value: null });
  f.calls.length = 0;
  await f.job.run();
  assert.deepEqual(f.calls, []);
  f.setStats(true);
  await f.job.run();
  assert.deepEqual([...f.calls].sort(), ['cast/1', 'cast/2', 'cast/4', 'countries']);
});

test('Statistics upgrades legacy show averages only for watched and rated shows and reuses fresh dependent entries', async () => {
  const tables = library();
  tables.ratings.push({ show_id: 1, show: 'Rated and watched', rating: 0 });
  const f = fixture(tables);
  await f.job.run();
  for (const id of [1, 2, 4]) delete f.cache.get('show/' + id).value.voteAverage;
  f.calls.length = 0;
  await f.job.run();
  assert.deepEqual(f.calls, []);
  f.setStats(true);
  await f.job.run();
  assert.deepEqual(f.calls.sort(), ['cast/1', 'cast/2', 'cast/4', 'countries', 'show/1']);
  f.calls.length = 0;
  await f.job.run();
  assert.deepEqual(f.calls, [], 'A confirmed absence of votes triggered a repeated title refresh');
  // A cached credit may be younger than the series and still due when the series is refreshed.
  f.cache.get('show/1').fetchedAt = now - 8 * day;
  f.cache.get('cast/1').fetchedAt = now - day;
  const refresh = f.port.refresh;
  f.port.refresh = async resource => {
    if (key(resource) !== 'cast/1') return refresh(resource);
    f.calls.push('cast/1');
    throw Error('Interrupted credits fetch');
  };
  await f.job.run();
  assert.ok(f.calls.includes('show/1') && f.calls.includes('cast/1'));
  f.port.refresh = refresh;
  f.calls.length = 0;
  await f.job.run();
  assert.deepEqual(f.calls, ['cast/1'], 'A stale cast survived a failed refresh because the show was already fresh');
});

test('a restarted detail job retries an interrupted season refresh after its show was saved', async () => {
  const f = fixture();
  await f.job.run();
  f.cache.get('show/1').fetchedAt = now - 8 * day;
  f.cache.get('season/1/1').fetchedAt = now - day;
  const refresh = f.port.refresh;
  f.port.refresh = async resource => {
    if (key(resource) !== 'season/1/1') return refresh(resource);
    f.calls.push(key(resource));
    throw Error('Interrupted season fetch');
  };
  f.calls.length = 0;
  await f.job.run();
  assert.deepEqual(f.calls, ['show/1', 'season/1/1']);
  f.calls.length = 0;
  f.port.refresh = refresh;
  await new TmdbDetailJob(f.port).run();
  assert.deepEqual(f.calls, ['season/1/1']);
  assert.equal(f.cache.get('season/1/1').fetchedAt, now);
});

test('a large fictional library fetches each show and watched season once, then fetches cast and countries for Statistics', async () => {
  const showCount = 320, watchedShowCount = 280, fourSeasonShows = 80;
  const watchedSeasonCount = watchedShowCount * 3 + fourSeasonShows;
  const tables = emptyTables();
  for (let id = 1; id <= showCount; id++) {
    if (id > watchedShowCount) tables.lists.push({ show_id: id, show: 'List only', list: 'Watchlist' });
    else for (let season = 1; season <= (id <= fourSeasonShows ? 4 : 3); season++) tables.watched.push(watch(id, season, 1));
  }
  const f = fixture(tables);
  f.cache.set('configuration', { value: normalizeTmdb({ kind: 'configuration' }, config), fetchedAt: now });
  const refresh = f.port.refresh;
  f.port.refresh = async r => {
    if (r.kind !== 'show') return refresh(r);
    const value = show(r.id);
    value.seasons = [1, 2, 3, 4].map(season => ({ season, name: '', episodeCount: 5, posterPath: null }));
    const entry = { fetchedAt: now, value };
    f.calls.push(key(r));
    f.cache.set(key(r), entry);
    return entry;
  };
  await f.job.run();
  assert.equal(f.calls.length, showCount + watchedSeasonCount);
  assert.equal(new Set(f.calls).size, showCount + watchedSeasonCount);
  f.calls.length = 0;
  f.setStats(true);
  await f.job.run();
  assert.equal(f.calls.length, showCount + 1);
  assert.equal(f.calls.filter(call => call.startsWith('cast/')).length, showCount);
  assert.ok(f.calls.includes('countries'));
});

test('a cold offline or hidden job sends nothing and a suspended job resumes its unfinished work', async () => {
  const f = fixture();
  f.setActive(false);
  await f.job.run();
  assert.deepEqual(f.calls, []);
  f.setActive(true);
  let first = true;
  const refresh = f.port.refresh;
  f.port.refresh = async r => {
    if (first) { first = false; f.setActive(false); }
    return refresh(r);
  };
  await f.job.run();
  assert.deepEqual(f.calls, ['configuration']);
  assert.equal(f.job.paused, true);
  f.setActive(true);
  await f.job.run();
  assert.equal(f.calls.filter(c => c === 'configuration').length, 1);
  assert.ok(f.calls.includes('season/1/2') && f.calls.includes('show/4'));
  assert.equal(f.job.paused, false);
});

test('a service-wide cooldown pauses the library after its in-flight batch and exposes its deadline', async () => {
  const tables = emptyTables();
  for (let id = 1; id <= 100; id++) tables.ratings.push({ show_id: id, show: 'Fiction', rating: 3 });
  const f = fixture(tables);
  const refresh = f.port.refresh;
  let attempted = 0;
  f.port.refresh = async () => {
    attempted++;
    throw Object.assign(new Error('throttle'), { kind: 'throttled', retryAt: now + day });
  };
  await f.job.run();
  assert.ok(attempted > 0 && attempted <= 20);
  assert.equal(f.job.retryAt, now + day);
  assert.equal(f.job.paused, true);
  f.port.refresh = refresh;
  await f.job.run();
  assert.equal(f.job.retryAt, null);
  assert.equal(f.job.paused, false);
  assert.equal(f.calls.filter(s => s.startsWith('show/')).length, 100);
});

test('a resumed job honors shows added or removed while the device was offline', async () => {
  const tables = library();
  const f = fixture(tables);
  const refresh = f.port.refresh;
  f.port.refresh = async r => {
    if (r.kind === 'configuration') f.setActive(false);
    return refresh(r);
  };
  await f.job.run();
  tables.ratings = [{ show_id: 41, show: 'New fictional series', rating: 0 }];
  f.setActive(true);
  await f.job.run();
  assert.ok(f.calls.includes('show/41'));
  assert.ok(!f.calls.includes('show/2'));
});

test('an online error preserves its previous data, permits other items, and is retried on the next run', async () => {
  const f = fixture();
  const refresh = f.port.refresh;
  let fail = true, calls = 0;
  f.port.refresh = async r => {
    if (key(r) === 'show/2') {
      calls++;
      if (fail) throw new Error('unreachable');
    }
    return refresh(r);
  };
  const old = { fetchedAt: now - 8 * day, value: show(2) };
  f.cache.set('show/2', old);
  await f.job.run();
  assert.equal(calls, 1);
  assert.equal(f.cache.get('show/2'), old);
  assert.ok(f.calls.includes('show/4') && f.calls.includes('season/1/2'));
  fail = false;
  await f.job.run();
  assert.equal(calls, 2);
  assert.equal(f.cache.get('show/2').fetchedAt, now);
});

test('rewrites use current record rows, preserve counts and settings, and defer moved or ambiguous episode identities', () => {
  const tables = library();
  tables.watched = [watch(1, 1, 1, 101), watch(1, 1, 2, null), watch(1, 1, 3, 104), watch(1, 1, 4, null),
    watch(1, 1, 5, null), watch(99, 1, 1, 101)];
  const res = { kind: 'season', id: 1, season: 1 };
  const current = normalizeTmdb(res, rawSeason(...[101, 102, 103, 104, 105].map((e, n) => rawEpisode(n + 1, e))));
  const prior = normalizeTmdb(res, rawSeason(rawEpisode(5, 1005)));
  const put = metadataRewrite(tables, res, current, prior);
  assert.deepEqual(put.watched.map(r => [r.episode, r.episode_id, r.times_watched]), [[1, 101, 3], [2, 102, 3]]);
  const named = metadataRewrite(tables, { kind: 'show', id: 1 }, show(1));
  assert.deepEqual(Object.keys(named).sort(), ['lists', 'watched']);
  assert.equal(named.watched[0].show, 'Fictional series 1');
  assert.ok(named.watched.every(r => r.show_id === 1 && r.times_watched === 3));
  assert.equal(tables.watched[0].title, 'Old name');
  assert.deepEqual(metadataRewrite(tables, { kind: 'show', id: 3 }, null), {});
});

test('repeated refreshes never claim an unidentified watch at an observed reused or vacated slot', () => {
  const res = { kind: 'season', id: 1, season: 1 };
  const first = normalizeTmdb(res, rawSeason(rawEpisode(1, 201), rawEpisode(2, 202)));
  const latest = normalizeTmdb(res, rawSeason(rawEpisode(1, 202), rawEpisode(3, 201)));
  const changed = carrySeasonHistory(latest, first);
  const refreshed = carrySeasonHistory(latest, changed);
  const tables = emptyTables();
  tables.watched = [watch(1, 1, 1), watch(1, 1, 2), watch(1, 1, 3)];
  assert.deepEqual(refreshed.reusedPositions, [1, 2, 3]);
  assert.deepEqual(metadataRewrite(tables, res, refreshed), {});
  tables.watched[0].episode_id = 202;
  assert.equal(metadataRewrite(tables, res, refreshed).watched[0].title, 'Episode 1');
});
