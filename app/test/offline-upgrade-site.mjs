import {readFile} from 'node:fs/promises';
import {createOfflineBuild} from '../offline-build.mjs';

const scope = '/upgrade-app/';
const dist = new URL('../dist/', import.meta.url);
const mime = { js:'text/javascript', html:'text/html', css:'text/css', svg:'image/svg+xml',
  png:'image/png', webmanifest:'application/manifest+json', ico:'image/x-icon' };

/** Deploy the shipped assets in successive builds. Every update uses the same next IDB version. */
export async function createUpgradeSite() {
  const manifest = (await readFile(new URL('service-worker.js', dist), 'utf8')).match(/^const SHELL = (.+);\r?$/m);
  const names = Object.keys(JSON.parse(manifest[1]).files).filter(name => name !== 'index.html');
  const common = new Map(await Promise.all(names.map(async name => [name, await readFile(new URL(name, dist))])));
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const worker = await readFile(new URL('../service-worker.js', import.meta.url), 'utf8');
  const builds = [1, 2, 3, 4].map(stage => {
    const files = new Map(common);
    files.set('index.html', html.replace('<html lang="en">', '<html lang="en" data-stage="' + stage + '">')
      .replace('src="./main.js"', 'src="./upgrade-entry.js"'));
    files.set('upgrade-entry.js', `
      const visits = Number(sessionStorage.getItem('upgrade-visits') ?? 0) + 1;
      sessionStorage.setItem('upgrade-visits', String(visits));
      window.fixture = { id: crypto.randomUUID(), stage: ${stage}, visits };
      if (location.hash !== '#legacy') {
        navigator.serviceWorker.addEventListener('message', event => {
          if (event.data?.type === 'csvtv:resume' && sessionStorage.getItem('drop-resume')) {
            window.fixture.dropped = true;
            event.stopImmediatePropagation();
          }
        });
        if (localStorage.getItem('upgrade-offline')) Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
        const originalFetch = window.fetch.bind(window);
        window.fetch = (input, options) => {
          if (new URL(input.url ?? input, location.href).origin !== location.origin) throw Error('A fictional test cannot contact a provider.');
          return originalFetch(input, options);
        };
        const {DropboxController} = await import('./dropbox-controller.js');
        const refresh = DropboxController.prototype.refresh;
        DropboxController.prototype.refresh = function(...args) {
          window.fixture.cloud = this; return refresh.apply(this,args);
        };
        await import('./main.js');
      }
    `);
    files.set('main.js', files.get('main.js').toString().replace('"./storage.js"', '"./upgrade-store.js"'));
    files.set('upgrade-store.js', `
      import {openDeviceStore as open, deviceMigrations} from './storage.js';
      export async function openDeviceStore(options) {
        const migrations = [...deviceMigrations];
        if (${stage} > 1) migrations.push((db, tx) => {
          db.createObjectStore('future-data');
          if (localStorage.getItem('interrupt-upgrade')) {
            const mutation = tx.objectStore('sync').delete('ratings');
            mutation.onsuccess = () => tx.abort();
          }
        });
        const store = await open({...options, name: 'csvtv-waiting-worker-test', migrations});
        window.fixture.store = store;
        return store;
      }
    `);
    const result = createOfflineBuild(files, worker);
    files.set('index.html', result.html);
    files.set('service-worker.js', result.worker);
    return files;
  });
  let stage = 0, mode = 'broken';
  let droppedReplacementReply = false;
  const offlineMisses = [];
  return (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (path === '/upgrade-test-control' && request.method === 'POST') {
      mode = request.headers['x-mode'];
      if (mode === 'publish') stage = 1;
      if (mode === 'replace') stage = 2;
      if (mode === 'final') stage = 3;
      if (mode === 'replace' && !droppedReplacementReply) {
        droppedReplacementReply = true;
        response.destroy();
        return true;
      }
      response.writeHead(204).end();
    } else if (path === '/upgrade-test-diagnostics') response.end(JSON.stringify(offlineMisses));
    else if (path.startsWith(scope)) {
      const name = path.slice(scope.length) || 'index.html';
      if (mode === 'offline') offlineMisses.push(name);
      if (mode === 'offline' || (mode === 'broken' && name === 'zip-native.js')) response.writeHead(503).end();
      else if (!builds[stage].has(name)) response.writeHead(404).end();
      else response.writeHead(200, {
        'Content-Type': mime[name.split('.').pop()], 'Cache-Control':'no-store',
      }).end(builds[stage].get(name));
    } else return false;
    return true;
  };
}
