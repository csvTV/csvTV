// Optional owner-supplied credential. Only read public TV examples; keep the response and key out of logs.
import { TmdbClient } from '../src/tmdb-client.ts';
import { normalizeTmdb } from '../src/tmdb-data.ts';

const token = process.env.CSVTV_TMDB_TEST_TOKEN;
if (!token) {
  console.error('Set CSVTV_TMDB_TEST_TOKEN in the process environment for the live TMDB contract check.');
  process.exitCode = 2;
} else {
  const client = new TmdbClient();
  const context = { current: () => true };
  const checked = new Set();
  let tvdbId;
  let testing = 'configuration';
  async function read(resource) {
    testing = resource.kind;
    const raw = await client.request(resource, token, context);
    const value = normalizeTmdb(resource, raw);
    if (resource.kind === 'external-ids') tvdbId = raw.tvdb_id;
    checked.add(resource.kind === 'find' ? 'find/' + resource.source : resource.kind);
    return value;
  }
  try {
    await read({ kind: 'configuration' });
    await read({ kind: 'countries' });
    // Provider-owned examples from public search, independent of any personal watch record.
    const page = await read({ kind: 'search', query: 'Star Trek', page: 1 });
    const statuses = new Set();
    for (const result of page.results.slice(0, 5)) {
      const show = await read({ kind: 'show', id: result.show_id });
      statuses.add(show.status);
      const id = show.show_id;
      const regular = show.seasons.find(s => s.season > 0);
      if (!checked.has('season') && regular) await read({ kind: 'season', id, season: regular.season });
      if (!checked.has('recommendations')) await read({ kind: 'recommendations', id });
      if (!checked.has('person')) {
        const cast = await read({ kind: 'cast', id });
        if (cast.length) await read({ kind: 'person', id: cast[0].id });
      }
      if (!checked.has('find/imdb_id') || !checked.has('find/tvdb_id')) {
        const external = await read({ kind: 'external-ids', id });
        if (external.imdbId) {
          const found = await read({ kind: 'find', externalId: external.imdbId, source: 'imdb_id' });
          if (!found.shows.some(s => s.show_id === id)) throw new Error();
        }
        if (Number.isSafeInteger(tvdbId) && tvdbId > 0) {
          const found = await read({ kind: 'find', externalId: String(tvdbId), source: 'tvdb_id' });
          if (!found.shows.some(s => s.show_id === id)) throw new Error();
        }
      }
    }
    testing = 'endpoint-coverage';
    if (checked.size !== 11) throw new Error();
    const known = ['Returning Series', 'Planned', 'In Production', 'Ended', 'Canceled', 'Pilot'];
    console.log('Authenticated checks passed for 11 TMDB request forms, including IMDb and TheTVDB lookup. Observed statuses:', [...statuses].map(s => known.includes(s) ? s : 'other status').join(', '));
  } catch {
    console.error('Live TMDB check failed at ' + testing + '. Check the credential, network and current provider contract.');
    process.exitCode = 1;
  }
}
