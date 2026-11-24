import { liveProviderBrowser } from './live-provider-browser.mjs';

// This function runs in a browser. Return only the shape and status, never provider text, keys or URLs.
async function probe(key) {
  const ids = [1399, 1396]; // Public TMDB pages for Game of Thrones and Breaking Bad.
  const missing = 2147483647;
  const url = new URL('https://api.mdblist.com/tmdb/show');
  url.searchParams.set('apikey', key);
  const response = await fetch(url, {method:'POST', redirect:'error', credentials:'omit',
    referrerPolicy:'no-referrer', signal:AbortSignal.timeout(15000),
    body:new URLSearchParams(ids.map(value => ['ids', String(value)]))});
  const data = await response.json().catch(() => null);
  const matches = ids.filter(id => Array.isArray(data) && data.some(row => row?.ids?.tmdb === id && Array.isArray(row.ratings)));
  const form = {status:response.status, matches:matches.length};
  const {MdbListClient, MdbListError} = await import('/mdblist-client.js');
  const client = new MdbListClient();
  const current = async () => true;
  const single = await client.lookup(ids[0], key, current);
  const anime = await client.lookup(1429, key, current); // Public TMDB series Attack on Titan.
  const partial = await client.lookup(2912, key, current);
  const miss = await client.lookup(missing, key, current);
  let refused = false;
  try { await client.lookup(ids[0], 'csvtv-deliberately-invalid', current); }
  catch (error) { refused = error instanceof MdbListError && error.kind === 'refused' && error.message === 'Invalid API key'; }
  return {form, knownCritics:[single.tomatoes,single.metacritic].filter(Number.isFinite).length,
    hasMyAnimeListScore:Number.isFinite(anime.myanimelist),
    absentCritics:[partial.tomatoes,partial.metacritic].filter(score => score === null).length,
    missingShow:miss.tomatoes === null && miss.metacritic === null && miss.myanimelist === null, refused};
}

await liveProviderBrowser('MDBList', probe, result => {
  console.log(JSON.stringify(result));
  const {form, knownCritics, hasMyAnimeListScore, missingShow, refused} = result;
  if (!knownCritics || !hasMyAnimeListScore || !missingShow || !refused || !(form.matches === 2 || [400,405,415,422].includes(form.status))) {
    throw Error('Unexpected contract');
  }
  console.log(form.matches === 2 ? 'Browser batch form accepted.' : 'Browser form declined. Individual lookups required.');
});
