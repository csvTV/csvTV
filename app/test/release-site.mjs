import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { extname } from 'node:path';
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader } from '@zip.js/zip.js';

export async function unpack(bytes) {
  const reader = new ZipReader(new Uint8ArrayReader(bytes), {useWebWorkers:false, checkSignature:true});
  const files = new Map();
  try {
    for (const entry of await reader.getEntries()) {
      assert.ok(!entry.directory && !entry.filename.includes('/') && !files.has(entry.filename), 'Expected distinct files at the ZIP root');
      files.set(entry.filename, Buffer.from(await entry.getData(new Uint8ArrayWriter())));
    }
  } finally { await reader.close(); }
  return files;
}

// Apply the Pages wildcard rule from the ZIP when serving the archive at the origin root.
export function releaseServer(files, intercept) {
  const [rule, ...lines] = files.get('_headers').toString('utf8').trimEnd().split(/\r?\n/);
  assert.equal(rule, '/*');
  const headers = {};
  for (const line of lines) {
    const [, name, value] = line.match(/^\s+([\w-]+):\s+(.+)$/) ?? [];
    assert.ok(name && value, 'Expected a header under the wildcard rule');
    headers[name] = value;
  }
  const types = {'.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.png':'image/png'};
  return createServer(async (request, response) => {
    if (intercept) {
      try { if (await intercept(request, response)) return; }
      catch { response.writeHead(500, {'Cache-Control':'no-store'}).end(); return; }
    }
    const path = new URL(request.url, 'http://localhost').pathname;
    const name = path === '/' ? 'index.html' : path.slice(1);
    const bytes = files.get(name);
    if (!bytes || name === '_headers') { response.writeHead(404, headers).end(); return; }
    response.writeHead(200, {...headers, 'Content-Type':types[extname(name)] ?? 'application/octet-stream'}).end(bytes);
  });
}
