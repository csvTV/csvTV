import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createOfflineBuild } from '../../offline-build.mjs';

const publicTest = process.argv[2] === '--public';
if (process.argv.length !== (publicTest ? 4 : 3)) throw Error('Usage: node test/iphone-offline/prepare.mjs [--public] <empty-output-directory>');
const destination = resolve(process.argv.at(-1));
const built = name => new URL('../../dist/' + name, import.meta.url);
const worker = await readFile(built('service-worker.js'), 'utf8');
const descriptor = worker.match(/^const SHELL = (.+);$/m);
if (!descriptor) throw Error('Build the app with its service worker first.');
const { build, files, retired } = JSON.parse(descriptor[1]);
const assets = new Map();
for (const [name, expected] of Object.entries(files)) {
  if (!/^(?:index\.html|tmdb-logo\.svg|favicon\.svg|favicon-32\.png|apple-touch-icon\.png|[a-z0-9-]+\.(?:js|css))$/.test(name)) {
    throw Error('Unexpected file in the offline build: ' + name);
  }
  const bytes = await readFile(built(name));
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw Error('Build changed: ' + name);
  assets.set(name, bytes);
}
const html = assets.get('index.html')?.toString('utf8');
if (!html?.includes('name="dropbox-app-key" content=""')) throw Error('Make a build with an empty Dropbox app key.');
if (!html.includes('name="csvtv-build" content="' + build + '"')) throw Error('Build IDs differ.');

// The host adds its own controls to HTML responses. Keep that page as
// the online entry and give the worker a byte-identical copy of the app document.
const marker = 'name="csvtv-build" content=';
let template = html.replace(marker + '"' + build + '"', marker + '""');
if (publicTest) {
  const entry = '<script type="module" src="./main.js"></script>';
  if (!template.includes(entry) || !template.includes('<div id="app">')) throw Error('Missing production app entry.');
  template = template.replace(entry, '<link rel="stylesheet" href="./public-sample.css">\n  <script type="module" src="./public-entry.js"></script>')
    .replace('<div id="app">', '<aside id="sample-guide" aria-label="Offline test"><strong id="sample-status" role="status">Preparing Signal Garden…</strong>' +
      '<p id="sample-steps">No account needed.</p><a href="#/settings">Offline settings</a></aside>\n  <div id="app">');
  for (const name of ['public-entry.js', 'sample-record.js', 'public-sample.css']) {
    if (assets.has(name)) throw Error('Fixture file collides with app asset: ' + name);
    assets.set(name, await readFile(new URL(name, import.meta.url)));
  }
}
assets.set('index.html', template);
const documentSource = 'offline-document.txt';
const fixture = createOfflineBuild(assets, worker.replace(descriptor[0], 'const SHELL = null;'), retired, { documentSource });
assets.set('index.html', fixture.html);
await mkdir(destination, { recursive: true });
if ((await readdir(destination)).length) throw Error('Choose an empty output directory.');
const tracker = publicTest ? destination : join(destination, 'tracker');
if (!publicTest) await mkdir(tracker);
for (const [name, bytes] of assets) await writeFile(join(tracker, name), bytes, { flag: 'wx' });
await writeFile(join(tracker, documentSource), fixture.html, { flag: 'wx' });
await writeFile(join(tracker, 'service-worker.js'), fixture.worker, { flag: 'wx' });
const headers = await readFile(built('_headers'), 'utf8');
await writeFile(join(destination, '_headers'), publicTest ? headers : headers.replace(/^\/\*/m, '/tracker/*'), { flag: 'wx' });
if (!publicTest) {
  for (const name of ['index.html', 'fixture.css', 'fixture.js', 'sample-record.js']) {
    await copyFile(new URL(name, import.meta.url), join(destination, name));
  }
}
console.log('Prepared the iPhone offline test with build ' + fixture.build + '.');
