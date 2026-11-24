// Local consent page for the development App Folder application. Never log request URLs or provider responses.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const here = new URL('./dropbox-live/', import.meta.url);
const publicKey = process.env.CSVTV_DROPBOX_APP_KEY || '';
const origin = 'http://localhost:8765';
const fields = ['exchange', 'neverExisted', 'identicalAdd', 'listing', 'download', 'revisions', 'serverTime', 'cleanup', 'renewal', 'revocation'];
const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' https://api.dropboxapi.com https://content.dropboxapi.com; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  try {
    if (req.headers.host !== 'localhost:8765') { res.writeHead(403).end(); return; }
    const { pathname } = new URL(req.url, origin);
    if (req.method === 'GET' && pathname === '/key') { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(publicKey)); return; }
    if (req.method === 'POST' && pathname === '/report' && req.headers.origin === origin && req.headers['content-type'] === 'application/json') {
      let body = '';
      for await (const part of req) { body += part; if (body.length > 2048) { res.writeHead(413).end(); return; } }
      const report = JSON.parse(body);
      const statuses = ['passed', 'failed', 'unverified', 'refused', 'accepted', 'bounded', 'not-found', 'empty', 'skipped'];
      if (fields.some(k => !statuses.includes(report[k]))) { res.writeHead(400).end(); return; }
      console.log('Live Dropbox observations');
      for (const key of fields) console.log(key + ' ' + report[key]);
      res.writeHead(204).end();
      server.close();
      return;
    }
    const built = /^\/dist\/([\w-]+\.js)$/.exec(pathname);
    const path = pathname === '/' ? new URL('index.html', here) : pathname === '/probe.js' ? new URL('probe.js', here)
      : built ? new URL('../dist/' + built[1], import.meta.url) : null;
    if (req.method !== 'GET' || !path) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', pathname === '/' ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8');
    res.end(await readFile(path));
  } catch { res.writeHead(500).end(); }
});
server.on('error', () => { console.error('Could not start the loopback test on port 8765.'); process.exitCode = 1; });
server.listen(8765, 'localhost', () => console.log('Open ' + origin + '/ in your browser. Use a dedicated development Dropbox App Folder key with this exact redirect address. Keep this tab open for the two-minute expiry test.'));
