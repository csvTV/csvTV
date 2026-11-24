import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';
import { pagesHeaders } from './hosting-policy.mjs';
import { createOfflineBuild, isShellAsset } from './offline-build.mjs';

/** Package the current offline installation. A reused dist directory may also contain obsolete files. */
export async function createRelease(dist) {
  const [worker, headers, workerTemplate] = await Promise.all([
    readFile(new URL('service-worker.js', dist), 'utf8'),
    readFile(new URL('_headers', dist), 'utf8'),
    readFile(new URL('service-worker.js', import.meta.url), 'utf8'),
  ]);
  const descriptor = /^const SHELL = (.+);$/m.exec(worker);
  if (!descriptor || headers !== pagesHeaders) throw Error('Rebuild the app to generate the worker and hosting headers.');
  const shell = JSON.parse(descriptor[1]);
  const names = Object.keys(shell.files);
  if (!names.includes('index.html') || !names.every(isShellAsset)) throw Error('Unexpected file in the offline build.');
  const files = new Map(await Promise.all(names.map(async name => [name, await readFile(new URL(name, dist))])));
  const html = files.get('index.html').toString('utf8');
  const inputs = new Map(files);
  inputs.set('index.html', html.replace(/name="csvtv-build" content="[a-f0-9]{64}"/, 'name="csvtv-build" content=""'));
  const expected = createOfflineBuild(inputs, workerTemplate, shell.retired);
  if (expected.worker !== worker || expected.html !== html) throw Error('Built files differ from the offline manifest. Rebuild before packaging.');
  files.set('_headers', Buffer.from(headers));
  files.set('LICENSE.txt', await readFile(new URL('../LICENSE', import.meta.url)));
  files.set('service-worker.js', Buffer.from(worker));
  return {bytes:await archiveReleaseFiles(files), build:shell.build, fileCount:files.size};
}

/** The verifier can reproduce the complete archive, including bytes outside named entries. */
export async function archiveReleaseFiles(files) {
  const zip = new ZipWriter(new Uint8ArrayWriter(), {
    useWebWorkers:false, level:6, extendedTimestamp:false, lastModDate:new Date(2000, 0, 1),
  });
  for (const name of [...files.keys()].sort()) await zip.add(name, new Uint8ArrayReader(files.get(name)));
  return zip.close();
}

export async function saveRelease(bytes, destination, temporary) {
  const file = await open(temporary, 'wx');
  try {
    try { await file.writeFile(bytes); }
    finally { await file.close(); }
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, {force:true});
    throw error;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const {bytes, build, fileCount} = await createRelease(new URL('dist/', import.meta.url));
  const directory = new URL('release/', import.meta.url);
  await mkdir(directory, {recursive:true});
  await saveRelease(bytes, new URL('csvTV.zip',directory), new URL('.' + randomUUID() + '.tmp',directory));
  console.log('release/csvTV.zip · ' + fileCount + ' files · build ' + build.slice(0, 16));
}
