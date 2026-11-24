import { connectFixtureProviders, replaceFixtureSettings } from './provider-fixture-cases.mjs';
import { openDeviceStore } from '../dist/storage.js';
import { TmdbService } from '../dist/tmdb-service.js';
import { TmdbClient } from '../dist/tmdb-client.js';
import { TmdbLibrary } from '../dist/tmdb-library.js';
import { WatchActions } from '../dist/watch-actions.js';
import { isAnime } from '../dist/anime.js';
import { readOverview } from '../dist/record-overview.js';

function check(ok, reason) { if (!ok) throw new Error(reason); }
function barrier() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

export async function tmdbIntegration() {
  const name = 'csvtv-metadata-' + crypto.randomUUID();
  const config = { images: { secure_base_url: 'https://image.tmdb.org/t/p/', poster_sizes: ['w92'],
    backdrop_sizes: ['w300'], still_sizes: ['w185'], profile_sizes: ['w45'] } };
  const title = { id: 7, name: 'Fictional North', status: 'Ended', seasons: [{ season_number: 1, episode_count: 1 }],
    keywords: { results: [] }, external_ids: { imdb_id: null }, next_episode_to_air: null, last_episode_to_air: null };
  const season = { season_number: 1, episodes: [{ id: 501, episode_number: 1, name: 'Chapter one', air_date: '2020-01-01' }] };
  const env = { online: () => true, visible: () => true, now: Date.now };
  const log = [];
  let intercept;
  const fetcher = async (url, init) => {
    const path = new URL(url).pathname.replace('/3/', '');
    const token = new Headers(init.headers).get('Authorization');
    check(!String(url).includes('fixture-token'), 'A credential reached the URL');
    log.push(path);
    if (intercept) {
      const response = await intercept(path, token);
      if (response) return response;
    }
    if (token === 'Bearer fixture-token-invalid') return Response.json({ status_code: 7 }, { status: 401 });
    if (path === 'configuration') return Response.json(config);
    if (path === 'tv/7') return Response.json(title);
    if (path === 'tv/7/season/1') return Response.json(season);
    if (path === 'tv/7/aggregate_credits') return Response.json({ id: 7, cast: [] });
    if (path === 'tv/7/recommendations') return Response.json({ page: 1, results: [], total_pages: 0 });
    return new Response(null, { status: 404 });
  };
  const client = new TmdbClient({ fetch: fetcher });
  let store = await openDeviceStore({ name });
  let service = new TmdbService(store, client, env);
  let library;
  await connectFixtureProviders(store,name);
  try {
    check(await service.firstUse(), 'Fresh installation lost the first-use state');
    await service.dismissFirstUse();
    await store.commit((await store.snapshot()).revision, { put: { watched: [{
      show_id: 7, show: 'Previous label', season: 1, episode: 1, title: 'Old title', times_watched: 2, episode_id: 501,
    }], ratings: [{ show_id: 88, show: 'Removed title', rating: 0 }] } });
    check((await service.view({ kind: 'search', query: 'fiction' })).status === 'missing-key' && !log.length,
      'Missing credentials sent a request');
    await service.saveKey('fixture-token-A');
    const original = await service.keyStatus();
    try { await service.saveKey('fixture-token-invalid'); throw new Error('Invalid key accepted'); }
    catch (error) { check(error.kind === 'refused', 'Candidate should receive a rejection'); }
    check((await service.keyStatus()).generation === original.generation, 'Candidate replaced a working credential');

    const release = service.holdRecordChanges();
    const arrived = barrier();
    intercept = async path => { if (path === 'tv/7') arrived.resolve(); };
    const pending = service.refresh({ kind: 'show', id: 7 });
    await arrived.promise;
    const held = await store.snapshot();
    check(held.tables.watched[0].show === 'Previous label', 'Background reply rewrote the record during a hold');
    await store.commit(held.revision, { put: { watched: [{ ...held.tables.watched[0], times_watched: 4 }] } });
    release();
    await pending;
    await service.refresh({ kind: 'season', id: 7, season: 1 });
    const refreshed = (await store.snapshot()).tables.watched[0];
    check(refreshed.show === title.name && refreshed.title === 'Chapter one' && refreshed.times_watched === 4, 'Metadata overwrote a concurrent watch edit');

    const readGroup = async () => isAnime((await readOverview(service, [7])).shows[0]);
    check(!await readGroup(), 'An untagged show with no Anime membership was counted as anime');
    title.keywords.results = [{ id: 73, name: 'anime' }];
    const count = log.length;
    await Promise.all([service.view({ kind: 'show', id: 7 }), service.view({ kind: 'show', id: 7 })]);
    check(log.length === count + 1, 'Concurrent screen reads sent duplicate requests');
    check(await readGroup() && !(await store.personalRows()).lists.length, 'The refreshed keyword was missed or created a personal list');
    const opened = await service.openShow(7);
    check(opened.cast.status === 'empty' && opened.recommendations.status === 'empty', 'Opening a show omitted screen-only calls');
    await service.mark(7, {}, 'again');
    check((await store.snapshot()).tables.watched[0].times_watched === 5, 'Cached season could not be marked');

    let undoBar;
    const watch = new WatchActions(service, async () => false, bar => { undoBar = bar; }, () => {});
    await watch.setSeasonCount(7,{season:1},5,8);
    check(undoBar && (await store.snapshot()).tables.watched[0].times_watched === 8, 'Season count did not save in one undoable edit');
    await watch.undo();
    check(!undoBar && (await store.snapshot()).tables.watched[0].times_watched === 5, 'Undo did not restore the season count');
    const resumeCount = service.holdRecordChanges();
    let editorOpen = true;
    const abortedCount = watch.setSeasonCount(7,{season:1},5,3,()=>editorOpen).catch(error => error);
    editorOpen = false;
    resumeCount();
    check((await abortedCount)?.kind === 'superseded' && (await store.snapshot()).tables.watched[0].times_watched === 5,
      'A closed season count editor wrote to the watch record');

    const returning = { ...title, id:71, name:'Orbital Season', seasons:[{season_number:1,episode_count:2}],
      next_episode_to_air:{season_number:1,episode_number:2,air_date:'2020-02-01'} };
    const latestSeason = {...season, episodes:[...season.episodes,
      {id:7102,episode_number:2,name:'Second signal',air_date:'2020-02-01'}]};
    let publishEpisode = false;
    intercept = async path => {
      if (path === 'tv/71') return Response.json(returning);
      if (path === 'tv/71/season/1') return Response.json(publishEpisode ? latestSeason : season);
    };
    await service.refresh({kind:'season',id:71,season:1});
    await service.refresh({kind:'show',id:71});
    env.online = () => false;
    const incomplete = await service.mark(71,{},'mark').catch(error => error);
    check(incomplete.kind === 'unreachable' && !(await store.snapshot()).tables.watched.some(row => row.show_id === 71),
      'An offline whole-show mark wrote only the old episode list');
    env.online = () => true;
    publishEpisode = true;
    await service.mark(71,{},'mark');
    const verified = (await store.snapshot()).tables.watched.filter(row => row.show_id === 71);
    check(verified.length === 2 && verified.some(row => row.episode_id === 7102), 'Finish missed the aired episode after reconnecting');
    latestSeason.episodes[1].air_date = '2099-02-01';
    await service.refresh({kind:'season',id:71,season:1});
    const postponed = (await readOverview(service,[71])).shows[0];
    check(postponed.metadata.nextEpisode?.airDate === '2099-02-01' && postponed.progress.aired === 1,
      'Watchlist schedule and Library disagreed about a rescheduled episode');
    publishEpisode = false;
    await service.refresh({kind:'season',id:71,season:1});
    const revised = (await readOverview(service,[71])).shows[0];
    check(revised.metadata.nextEpisode === null && revised.progress.aired === 1 &&
      revised.progress.watchedAired === 1 && revised.progress.recordedEpisodes === 2,
      'A later correction to the season list must win while preserving both watch rows');
    await store.commit((await store.snapshot()).revision,{remove:{watched:verified.map(row => [row.show_id,row.season,row.episode])}});

    const sent = barrier(), deliver = barrier();
    intercept = async path => {
      if (path === 'tv/8') { sent.resolve(); await deliver.promise; return Response.json({ ...title, id: 8 }); }
    };
    const outdated = service.refresh({ kind: 'show', id: 8 }).catch(e => e);
    await sent.promise;
    await service.saveKey('fixture-token-B');
    await service.saveKey('fixture-token-A');
    deliver.resolve();
    check((await outdated).kind === 'superseded' && !await service.read({ kind: 'show', id: 8 }), 'An earlier A reply reached the new A session');
    intercept = undefined;
    library = new TmdbLibrary(service);
    await library.run();
    check((await service.read({ kind: 'show', id: 88 }))?.value === null &&
      (await store.snapshot()).tables.ratings.some(row => row.show_id === 88), 'A missing show lost its record or lacked a cache marker');
    const coverage = await service.coverage([88, 7, 111, 88]);
    check(coverage.available.join() === '7' && coverage.missing.join() === '88' && coverage.unfetched.join() === '111',
      'Missing and unfetched shows were counted incorrectly');
    library.close();
    intercept = async path => path === 'tv/99' ? Response.json({ status_code: 7 }, { status: 401 }) : undefined;
    check((await service.view({ kind: 'show', id: 99 })).status === 'refused', 'A rejected saved token was still usable');
    const calls = log.length;
    const cached = await service.view({ kind: 'show', id: 7 });
    check(cached.value.show === title.name && cached.reason === 'refused' && log.length === calls, 'Refusal did not preserve offline access or block new requests');
    service.close();
    store.close();
    store = await openDeviceStore({ name });
    await connectFixtureProviders(store,name);
    service = new TmdbService(store, client, env);
    check(!await service.firstUse(), 'Dismissing first use did not survive a reopen');
    check((await service.keyStatus()).status === 'refused', 'Refusal was lost on reopen');
    await service.saveKey('fixture-token-A');
    env.online = () => false;
    const offline = await service.view({ kind: 'show', id: 7 });
    check(offline.status === 'cached' && offline.reason === 'offline', 'Offline screen did not use persisted metadata');
    env.online = () => true;
    await service.removeKey((await service.keyStatus()).generation);
    check(await readGroup(), 'Offline classification lost the cached keyword on reopening or key removal');
    check((await service.keyStatus()).status === 'missing-key' && (await service.showInfo(7)).seasons[0].episodes.length === 1,
      'Removing a key damaged the local history or cached season');
  } finally {
    library?.close();
    service.close();
    store.close();
  }
}
