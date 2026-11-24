import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { isShellAsset } from './offline-build.mjs';
import { appHeaders } from './hosting-policy.mjs';

const types = { html:'text/html; charset=utf-8', css:'text/css', js:'text/javascript', svg:'image/svg+xml',
  png:'image/png', ico:'image/x-icon', webmanifest:'application/manifest+json' };

export function createPreviewServer(dist) {
  return createServer(async (request, response) => {
    try {
      const path = new URL(request.url, 'http://localhost').pathname;
      const file = path === '/' ? 'index.html' : path.slice(1);
      if (!['GET','HEAD'].includes(request.method) || (file !== 'service-worker.js' && !isShellAsset(file))) {
        response.writeHead(404).end(); return;
      }
      // Read the active manifest on each request so a running preview follows rebuilds.
      const worker = await readFile(new URL('service-worker.js',dist),'utf8');
      const manifest = JSON.parse(worker.match(/^const SHELL = (.+);$/m)[1]);
      if (file !== 'service-worker.js' && !Object.hasOwn(manifest.files,file)) {
        response.writeHead(404).end(); return;
      }
      const body = file === 'service-worker.js' ? worker : await readFile(new URL(file, dist));
      response.writeHead(200, { ...appHeaders, 'Content-Type':types[file.split('.').pop()], 'Cache-Control':'no-store' });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch { response.writeHead(404).end(); }
  });
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const server = createPreviewServer(new URL('dist/', import.meta.url));
  server.listen(Number(process.env.PORT ?? 4173), '127.0.0.1', () =>
    console.log('csvTV is running at http://127.0.0.1:' + server.address().port));
}
