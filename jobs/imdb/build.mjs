// Join IMDb's two gzipped TSV datasets into the CSV used by the app.
import { randomUUID } from 'node:crypto';
import { closeSync, createReadStream, openSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { createGunzip, gzipSync } from 'node:zlib';

const mib = 1024 * 1024;
const ratingsLimit = { compressed: 32 * mib, decoded: 96 * mib, line: 256, rows: 4_000_000 };
const episodeLimit = { compressed: 192 * mib, decoded: 768 * mib, line: 256, rows: 30_000_000 };
// The browser reads at most this many data rows and bytes from the resulting CSV.
const outputLimit = { compressed: 16 * mib, decoded: 64 * mib, rows: 2_500_000 };
const minimumEpisodeCount = 500_000;

const missing = '\\N';
function integer(value, field) {
  if (value === missing) return null;
  if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error('invalid ' + field);
  }
  return Number(value);
}

function titleId(value) {
  if (value === missing) return null;
  if (!/^tt[0-9]+$/.test(value)) throw new Error('invalid title ID');
  const id = integer(value.slice(2), 'title ID');
  if (id === 0) throw new Error('invalid title ID');
  return id;
}

function decimalRating(text) {
  if (!text.includes('.')) return text;
  let end = text.length;
  while (text[end-1] === '0') end--;
  if (text[end-1] === '.') end--;
  return text.slice(0,end);
}

export async function readTable(path, header, limit, consume) {
  const width = header.split('\t').length;
  let lineNumber = 0;
  function readLine(line) {
    if (line.length > limit.line) throw new Error('line exceeds its byte limit');
    lineNumber++;
    if (lineNumber > limit.rows + 1) throw new Error('table exceeds its row limit');
    if (lineNumber === 1) {
      if (line !== header) throw new Error('unexpected header');
      return;
    }
    const fields = line.split('\t');
    if (fields.length !== width) throw new Error('unexpected field count');
    consume(fields);
  }
  try {
    if (statSync(path).size > limit.compressed) throw new Error('compressed input exceeds its byte limit');
    // Read at most one extra byte even if a local file grows after the size check.
    const source = createReadStream(path, { end: limit.compressed });
    await pipeline(source, createGunzip(), async chunks => {
      let bytes = 0, pending = '', endedAtCR = false;
      for await (const chunk of chunks) {
        bytes += chunk.length;
        if (bytes > limit.decoded) throw new Error('decoded input exceeds its byte limit');
        // Both tables contain ASCII identifiers and numbers. One character here is exactly one input byte.
        let text = chunk.toString('latin1');
        if (endedAtCR && text.startsWith('\n')) text = text.slice(1);
        endedAtCR = chunk.at(-1) === 13;
        const lines = text.split(/\r\n|[\r\n]/);
        lines[0] = pending + lines[0];
        pending = lines.pop();
        if (pending.length > limit.line) throw new Error('line exceeds its byte limit');
        for (const line of lines) readLine(line);
      }
      if (pending) readLine(pending);
    });
    if (source.bytesRead > limit.compressed) throw new Error('compressed input exceeds its byte limit');
    if (!lineNumber) throw new Error('missing header');
  } catch (error) {
    throw new Error(basename(path) + ', line ' + lineNumber + ': ' + error.message);
  }
}

async function build(dir, output) {
  const ratings = new Map();
  await readTable(join(dir, 'title.ratings.tsv.gz'), 'tconst\taverageRating\tnumVotes', ratingsLimit, ([title, rating, votes]) => {
    const id = titleId(title);
    integer(votes, 'vote count');
    if (rating !== missing && !/^(?:[1-9](?:\.[0-9]+)?|10(?:\.0+)?)$/.test(rating)) {
      throw new Error('rating must be a decimal from 1 to 10');
    }
    if (id !== null && rating !== missing) {
      if (ratings.has(id)) throw new Error('duplicate rating for a title');
      ratings.set(id, rating);
    }
  });

  const shows = new Set();
  const rows = [];
  const ratedEpisodeIds = new Set();
  await readTable(join(dir, 'title.episode.tsv.gz'), 'tconst\tparentTconst\tseasonNumber\tepisodeNumber', episodeLimit, fields => {
    const [title, parent, seasonText, episodeText] = fields;
    const episodeId = titleId(title);
    const show = titleId(parent);
    const season = integer(seasonText, 'season number');
    const episode = integer(episodeText, 'episode number');
    if (show === null) return;
    if (ratings.has(show)) shows.add(show);
    const rating = ratings.get(episodeId);
    if (rating !== undefined && season !== null && episode !== null) {
      if (ratedEpisodeIds.has(episodeId)) throw new Error('duplicate rated episode ID');
      ratedEpisodeIds.add(episodeId);
      rows.push([show, season, episode, rating]);
    }
    if (rows.length + shows.size > outputLimit.rows) throw new Error('output exceeds the app row limit');
  });

  const episodeCount = rows.length;
  if (ratings.size < 1_000_000 || episodeCount < minimumEpisodeCount) {
    throw new Error('too few rows: ' + ratings.size + ' ratings, ' + episodeCount + ' rated episodes');
  }
  if (!shows.size) throw new Error('no rated series matched the episode dataset');
  for (const show of shows) {
    rows.push([show, -1, -1, ratings.get(show)]);
  }
  rows.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  const header = 'show,season,episode,rating\n';
  let csvBytes = header.length;
  const records = [];
  for (let i = 0; i < rows.length;) {
    const [show, season, episode, firstRating] = rows[i++];
    let duplicateRating;
    let agreed = true;
    while (i < rows.length && rows[i][0] === show && rows[i][1] === season && rows[i][2] === episode) {
      duplicateRating ??= decimalRating(firstRating);
      if (decimalRating(rows[i][3]) !== duplicateRating) agreed = false;
      i++;
    }
    if (!agreed) continue;
    const rating = duplicateRating ?? firstRating;
    const row = [show, season < 0 ? '' : season, episode < 0 ? '' : episode, rating].join(',');
    csvBytes += row.length + 1;
    if (csvBytes > outputLimit.decoded) throw new Error('output exceeds the app CSV byte limit');
    records.push(row);
  }
  const publishedEpisodes = records.length - shows.size;
  if (publishedEpisodes < minimumEpisodeCount) {
    throw new Error('too few resolved episode scores: ' + publishedEpisodes + ' from ' + episodeCount + ' rated episodes');
  }
  const csv = header + records.join('\n') + '\n';
  const compressed = gzipSync(csv, { level: 9 });
  if (compressed.length > outputLimit.compressed) throw new Error('output exceeds the app compressed byte limit');
  const temporary = output + '.' + randomUUID() + '.tmp';
  const descriptor = openSync(temporary, 'wx');
  try {
    try { writeFileSync(descriptor, compressed); }
    finally { closeSync(descriptor); }
    renameSync(temporary, output);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  console.log(ratings.size + ' ratings read; ' + shows.size + ' show ratings and ' + publishedEpisodes + ' episode ratings written; ' +
    csv.length + ' bytes, ' + compressed.length + ' compressed');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [dir, output] = process.argv.slice(2);
  if (!dir || !output) {
    console.error('Usage: node build.mjs <input directory> <output.csv.gz>');
    process.exit(2);
  }
  await build(dir, output);
}
