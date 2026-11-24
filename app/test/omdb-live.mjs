import { liveProviderBrowser } from './live-provider-browser.mjs';

async function probe(key) {
  const {OmdbClient, OmdbError} = await import('/omdb-client.js');
  const client = new OmdbClient();
  const id = 'tt0903747'; // Public series Breaking Bad, independent of the watch record.
  const show = await client.lookup(id, null, key);
  const season = await client.lookup(id, 1, key);
  const missingSeason = await client.lookup(id, 987, key);
  const missingShow = await client.lookup('tt99999998', null, key);
  let refused = false;
  try { await client.lookup(id, null, 'csvtv-invalid-key'); }
  catch (error) { refused = error instanceof OmdbError && error.kind === 'refused' && error.message === 'Invalid API key!'; }
  return {show:Number.isFinite(show.rating), season:season.episodes.size > 0,
    missingSeason:missingSeason.episodes.size === 0, missingShow:missingShow.rating === null, refused};
}
await liveProviderBrowser('OMDb', probe, result => {
  console.log(JSON.stringify(result));
  if (!Object.values(result).every(value => value === true)) throw Error('Unexpected contract');
  console.log('OMDb show, season, missing IDs and invalid-key checks passed.');
});
