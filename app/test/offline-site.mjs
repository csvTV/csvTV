import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createOfflineBuild } from '../offline-build.mjs';

const dist = new URL('../dist/', import.meta.url);
const mime = {html:'text/html', js:'text/javascript', css:'text/css', png:'image/png', svg:'image/svg+xml',
  webmanifest:'application/manifest+json', json:'application/json'};
export const privateMarker = 'fictional-private-response';
export async function testSite({oauth = false} = {}) {
  const worker = await readFile(new URL('service-worker.js',dist));
  const manifest = JSON.parse(worker.toString().match(/^const SHELL = (.+);$/m)[1]);
  const files = new Map(await Promise.all(Object.keys(manifest.files).map(async name =>
    [name, await readFile(new URL(name,dist))])));
  files.set('service-worker.js',worker);
  let next;
  if (oauth) {
    const inputs = new Map(files);
    inputs.delete('service-worker.js');
    const template = inputs.get('index.html').toString().replace(manifest.build,'').replace('<head>','<head>\n<!-- Release two -->');
    inputs.set('index.html',template);
    next = createOfflineBuild(inputs,await readFile(new URL('../service-worker.js',import.meta.url),'utf8'),manifest.retired);
  }
  let failNextAsset = false, failedAssets = 0;
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    response.setHeader('Cache-Control', 'no-store');
    if (url.pathname === '/fixture') {
      response.writeHead(200, {'Content-Type':'text/html'}).end('<!doctype html><title>Fictional device setup</title>');
      return;
    }
    if (request.headers.authorization || (!oauth && url.searchParams.has('code')) || url.searchParams.has('test-key')) {
      response.writeHead(200, {'Content-Type':'text/plain'}).end(privateMarker);
      return;
    }
    const file = url.pathname === '/tracker/' ? 'index.html' : /^\/tracker\/([\w.-]+)$/.exec(url.pathname)?.[1];
    if (!files.has(file)) { response.writeHead(404).end(); return; }
    if (file === 'main.js' && failNextAsset) {
      failNextAsset = false; failedAssets++;
      response.writeHead(503).end();
      return;
    }
    response.writeHead(200, {'Content-Type':mime[file.split('.').pop()]}).end(files.get(file));
  });
  return {server,manifest, publishDocument:() => files.set('index.html',next.html),
    publishWorker:({failOnce = false} = {}) => { failNextAsset = failOnce; files.set('service-worker.js',next.worker); },
    failedAssets:() => failedAssets, nextBuild:next?.build};
}

export async function listen(server, port = 0) {
  await new Promise((resolve,reject) => server.once('error', reject).listen(port, '127.0.0.1', () => {
    server.off('error', reject);
    resolve();
  }));
  return server.address().port;
}
export async function stop(server) {
  if (!server.listening) return;
  const stopped = new Promise(resolve => server.close(resolve));
  server.closeAllConnections();
  await stopped;
}
