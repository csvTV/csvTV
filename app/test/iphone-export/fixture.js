import { mountExportScreen } from './app/export-screen.js';
import { openDeviceStore } from './app/storage.js';
import { TmdbService } from './app/tmdb-service.js';

// Fixed against hand-authored UTF-8/CRLF fixture bytes, independently of the exporter.
const expected = new Map([
  ['watched.csv', [111, '73b6881b4f071f884a9a35f4c0ae27d783f72285879ab929bb8f6e4b0352ecc7']],
  ['ratings.csv', [46, 'f0b8660bc624f4494664196ce6d1b2f60873d258e24248081b8caa44a9d831e9']],
  ['lists.csv', [92, 'd1fe25a4ac7f3c57a7fc8b79f15a67d885d31f53baf7eeb2e2218e7988e7072d']],
  ['shows.csv', [91, '943eb58af8b427dea426a68c769a6948e5578a7a37d28477f8e4c94da83da8bf']],
]);

const manifest = document.querySelector('#manifest');
for (const [name, [size, hash]] of expected) {
  const item = document.createElement('li');
  const digest = document.createElement('code');
  digest.textContent = hash;
  item.append(name + ' · ' + size + ' bytes ', digest);
  manifest.append(item);
}

async function verify(files) {
  const remaining = new Set(expected.keys());
  const issues = [];
  for (const file of files) {
    if (!remaining.delete(file.name)) {
      issues.push('Unexpected or repeated name: ' + file.name);
      continue;
    }
    const [size, hash] = expected.get(file.name);
    if (file.size !== size) {
      issues.push(file.name + ' has ' + file.size + ' bytes, expected ' + size + '.');
      continue;
    }
    const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()));
    const actual = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    if (actual !== hash) issues.push('Byte mismatch in ' + file.name + '.');
  }
  if (remaining.size) issues.push('Missing files: ' + [...remaining].join(', '));
  return issues.length ? issues.join('\n') : 'Pass. All four filenames and SHA-256 digests match.';
}

for (const input of document.querySelectorAll('input[type=file]')) {
  const output = document.getElementById(input.id + '-result');
  let generation = 0;
  input.onchange = async () => {
    const current = ++generation;
    output.textContent = 'Checking files…';
    try {
      const result = await verify(Array.from(input.files));
      if (generation === current) output.textContent = result;
    } catch {
      if (generation === current) output.textContent = 'Could not read the files. Choose the saved copies again.';
    }
  };
}

const root = document.querySelector('#export');
let databaseName, store, service, screen;
async function open() {
  if (!window.isSecureContext) throw Error('Open the device test from a trusted HTTPS address in Safari.');
  if (!window.indexedDB || !navigator.locks || !crypto.subtle) {
    throw Error('This test requires IndexedDB, Web Locks and SHA-256 support. Record the iOS version.');
  }
  const title = { show_id: 78101, show: 'Río, Relay' };
  const next = { show_id: 78102, show: 'Fable Junction' };
  databaseName = 'csvTV-four-file-share-test-' + crypto.randomUUID();
  store = await openDeviceStore({ name: databaseName });
  const snapshot = await store.whenWriter();
  await store.commit(snapshot.revision, { replace: {
    watched: [{ ...title, season: 1, episode: 3, title: 'The "Shift"', times_watched: 2, episode_id: 7810103 }],
    ratings: [{ ...title, rating: 8.5 }],
    lists: [{ ...title, list: 'Archive; Late\\Night' }, { ...next, list: 'Watchlist' }],
    shows: [{ ...title, year: 2018, imdb_id: 'tt0007123' }, { ...next, year: 2020, imdb_id: '' }],
    settings: [{ setting: 'github_repo', value: 'fictional/fixture-only-settings-marker' }],
  } });
  service = new TmdbService(store, undefined, { now: Date.now, online: () => false, visible: () => true });
  screen = mountExportScreen(root, { service });
  await screen.ready;
}

open().catch(error => { root.textContent = 'Could not open the test record. ' + error.message; });
window.addEventListener('pagehide', () => {
  screen?.dispose();
  service?.close();
  store?.close();
  if (databaseName) indexedDB.deleteDatabase(databaseName);
});
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
