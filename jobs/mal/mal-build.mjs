// Builds the MyAnimeList scores file: the public mapping file joined to MyAnimeList's ranking.
// Usage: node mal-build.mjs <output .csv.gz> [folder]
//   The Client ID is read from the environment variable MAL_CLIENT_ID.
//   With a folder: if it holds anime-list-mini.json and ranking.json they are used and nothing is fetched;
//   otherwise both are fetched and kept there, so a check can be repeated without calling MyAnimeList again.
// Output rows: show,season,offset,mal_id,score
//   show = TMDB's show ID; season and offset as the mapping file gives them, empty where it gives none; score = MyAnimeList's mean.
import { randomUUID } from 'node:crypto';
import { closeSync, createReadStream, existsSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';

const [out, dir] = process.argv.slice(2);
if (!out) { console.error('usage: node mal-build.mjs <output> [folder]'); process.exit(2); }

const MAPPING = 'https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-mini.json';
const RANKING = 'https://api.myanimelist.net/v2/anime/ranking?ranking_type=all&limit=500&fields=mean&offset=';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = bytes => JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(bytes));
const mappingBytes = 16 * 1024 * 1024;
const rankingPageBytes = 2 * 1024 * 1024;
const cachedRankingBytes = 32 * 1024 * 1024;

class InvalidReply extends Error {}
async function readReply(res, limit) {
  const reader = res.body?.getReader();
  if (!reader) throw new InvalidReply('the response is empty');
  const chunks = [];
  let bytes = 0;
  try {
    if (Number(res.headers.get('Content-Length')) > limit) throw new InvalidReply('the response exceeds its size limit');
    for (;;) {
      const {done,value} = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw new InvalidReply('the response exceeds its size limit');
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  try { return readJson(Buffer.concat(chunks, bytes)); }
  catch { throw new InvalidReply('the response is not valid UTF-8 JSON'); }
}

// Each attempt has a deadline. Only local messages and HTTP status codes reach the job log.
async function get(what, url, headers, limit) {
  let last = '';
  for (let attempt = 1; attempt <= 4; attempt++) {
    let delay = 5000 * attempt;
    try {
      const res = await fetch(url, { headers, redirect: 'error', signal:AbortSignal.timeout(60_000) });
      if (res.status === 200) return await readReply(res,limit);
      last = `status ${res.status}`;
      void res.body?.cancel().catch(() => {});
      if (res.ok || res.status === 400 || res.status === 401 || res.status === 403) break;
      if (res.status === 429 || res.status === 503) {
        const retry = res.headers.get('Retry-After')?.trim();
        if (retry) {
          const wait = /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
          // Leave the last publication in place if the provider asks for a longer pause than this job can wait.
          if (wait > 60_000) break;
          if (wait > delay) delay = wait;
        }
      }
    } catch (err) {
      if (err instanceof InvalidReply) { last = err.message; break; }
      last = 'the request or response was interrupted';
    }
    if (attempt < 4) await sleep(delay);
  }
  throw new Error(`could not fetch ${what}: ${last}`);
}

async function fetchRanking(clientId) {
  const items = [];
  const seen = new Set();
  let offset = 0;
  for (let pageNumber = 0; pageNumber < 200; pageNumber++) {
    const page = await get(`the ranking at offset ${offset}`, RANKING + offset, { 'X-MAL-CLIENT-ID': clientId }, rankingPageBytes);
    if (!Array.isArray(page?.data) || page.data.length > 500) throw new Error(`the ranking at offset ${offset} has an invalid page`);
    if (!page.data.length) return items;
    const previousSize = seen.size;
    for (const item of page.data) {
      const node = rankingNode(item);
      seen.add(node.id);
      items.push({ node: { id: node.id, mean: node.mean } });
    }
    if (seen.size === previousSize) throw new Error(`the ranking at offset ${offset} has no new MyAnimeList IDs`);
    offset += page.data.length;
    await sleep(1000);
  }
  throw new Error('the ranking did not end after 200 pages');
}

let mapping, ranking;
const saved = dir && existsSync(join(dir, 'anime-list-mini.json')) && existsSync(join(dir, 'ranking.json'));
if (saved) {
  async function readCached(file, limit) {
    const path = join(dir, file);
    try {
      const info = statSync(path);
      if (!info.isFile() || info.size > limit) throw new Error();
      const chunks = [];
      let bytes = 0;
      for await (const chunk of createReadStream(path, { end: limit })) {
        bytes += chunk.length;
        if (bytes > limit) throw new Error();
        chunks.push(chunk);
      }
      return readJson(Buffer.concat(chunks, bytes));
    } catch { throw inputError('could not read cached ' + file + ' within its size limit'); }
  }
  mapping = await readCached('anime-list-mini.json', mappingBytes);
  ranking = await readCached('ranking.json', cachedRankingBytes);
} else {
  const clientId = (process.env.MAL_CLIENT_ID || '').trim();
  if (!clientId) throw new Error('MAL_CLIENT_ID is not set');
  if (!/^[\x21-\x7e]+$/.test(clientId)) throw new Error('MAL_CLIENT_ID holds a space, a line break or a character a header cannot carry');
  mapping = await get('the mapping file', MAPPING, {}, mappingBytes);
  ranking = await fetchRanking(clientId);
}
function inputError(reason) {
  return new Error(reason + (saved ? '. To fetch fresh inputs, move ranking.json out of the cache directory and rerun with MAL_CLIENT_ID.' : ''));
}
function rankingNode(item) {
  const node = item?.node;
  if (!Number.isSafeInteger(node?.id) || node.id <= 0) throw inputError('the ranking contains an entry without a valid MyAnimeList ID');
  return node;
}
if (!Array.isArray(mapping) || !Array.isArray(ranking)) throw inputError('the mapping file or the ranking is not a list');
if (mapping.length > 250_000 || ranking.length > 100_000) throw inputError('the mapping file or the ranking exceeds its entry limit');

const mean = new Map();
for (const item of ranking) {
  const node = rankingNode(item);
  if (node.mean == null) continue;
  if (typeof node.mean !== 'number' || !/^(?:[1-9](?:\.\d{1,2})?|10)$/.test(String(node.mean))) {
    throw inputError('the ranking contains an invalid score');
  }
  if (mean.has(node.id) && mean.get(node.id) !== node.mean) {
    throw inputError('the ranking contains conflicting scores for one MyAnimeList ID');
  }
  mean.set(node.id, node.mean);
}

// A season or an offset that is not a whole number of 0 or more is written as empty.
const num = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : -1);
const seen = new Set(), rows = [];
let skipped = 0;
for (const m of mapping) {
  if (!m || typeof m !== 'object') { skipped++; continue; }
  const show = m.themoviedb_id && typeof m.themoviedb_id === 'object' ? m.themoviedb_id.tv : undefined;
  if (!Number.isSafeInteger(show) || show <= 0 || !mean.has(m.mal_id)) continue;
  const row = [show, num(m.season?.tmdb), num(m.episode_offset?.tmdb), m.mal_id, mean.get(m.mal_id)];
  const key = row.join(',');
  if (!seen.has(key)) { seen.add(key); rows.push(row); }
  if (rows.length > 100_000) throw inputError('the output exceeds the app row limit');
}
rows.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3]);

// Refuse to publish a file that is plainly broken, so a bad day at MyAnimeList or a changed mapping file never replaces a good file.
// The first run, on 2026-11-12, read 39,745 mapping entries and 20,483 scored entries, and wrote 6,886 rows.
if (mapping.length < 30000 || mean.size < 15000 || rows.length < 5000) throw inputError(`too few rows: ${mapping.length} mapping entries, ${mean.size} scored entries in the ranking, ${rows.length} rows to write`);

if (rows.every(row => row[1] === 0)) throw inputError('the mapping contains only specials');

const csv = 'show,season,offset,mal_id,score\n' + rows.map(([p, s, o, id, r]) => `${p},${s < 0 ? '' : s},${o < 0 ? '' : o},${id},${r}`).join('\n') + '\n';
if (csv.length > 8 * 1024 * 1024) throw inputError('the output exceeds the app CSV byte limit');
const gz = gzipSync(csv, { level: 9 });
if (gz.length > 4 * 1024 * 1024) throw inputError('the output exceeds the app compressed byte limit');
function saveInputs(dir, mapping, ranking) {
  mkdirSync(dir, {recursive:true});
  const staged = join(dir,'.csvtv-inputs-pending');
  try { mkdirSync(staged); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new Error('The input cache has a pending writer. Retry after it finishes. If all builders have stopped, move .csvtv-inputs-pending aside first.');
  }
  try {
    const files = ['anime-list-mini.json','ranking.json'];
    if (files.every(name => existsSync(join(dir,name)))) {
      throw new Error('Another builder completed the input cache during this fetch. Rerun to use the saved pair offline.');
    }
    const contents = [JSON.stringify(mapping), JSON.stringify(ranking)];
    if (Buffer.byteLength(contents[0]) > mappingBytes || Buffer.byteLength(contents[1]) > cachedRankingBytes) {
      throw inputError('the input cache exceeds its byte limit');
    }
    for (const [index,name] of files.entries()) writeFileSync(join(staged,name), contents[index]);
    // Keep an incomplete pair ineligible for offline reuse until both complete files are ready.
    if (existsSync(join(dir,files[1]))) files.reverse();
    for (const name of files) renameSync(join(staged,name), join(dir,name));
  } finally { rmSync(staged,{recursive:true,force:true}); }
}
if (dir && !saved) saveInputs(dir, mapping, ranking);
const temporary = out + '.' + randomUUID() + '.tmp';
const descriptor = openSync(temporary, 'wx');
try {
  try { writeFileSync(descriptor, gz); }
  finally { closeSync(descriptor); }
  renameSync(temporary, out);
} catch (error) {
  rmSync(temporary, { force: true });
  throw error;
}
console.log(`${mapping.length} mapping entries read; ${ranking.length} ranking entries, ${mean.size} with a score; ${rows.length} rows written; ${csv.length} bytes, ${gz.length} compressed` + (skipped ? `; ${skipped} malformed entries skipped` : ''));
