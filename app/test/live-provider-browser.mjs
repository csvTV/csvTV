import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { securityPolicy } from '../hosting-policy.mjs';
import { openChromium } from './offline-chromium.mjs';
import { listen, stop } from './offline-site.mjs';

/** Run a read-only provider probe in a fresh profile, serving only its compiled client and dependencies. */
export async function liveProviderBrowser(provider, probe, verify) {
  const variable = 'CSVTV_' + provider.toUpperCase() + '_TEST_KEY';
  const key = process.env[variable];
  delete process.env[variable];
  if (!key) {
    console.error('Set ' + variable + ' to run the live ' + provider + ' browser check.');
    process.exitCode = 2;
    return;
  }
  const modules = new Map(await Promise.all([provider.toLowerCase() + '-client.js','provider-http.js'].map(async name =>
    ['/' + name, await readFile(new URL('../dist/' + name, import.meta.url))])));
  const profile = await mkdtemp(join(tmpdir(), 'csvtv-live-' + provider.toLowerCase() + '-'));
  const server = createServer((request, response) => {
    const script = modules.get(request.url);
    response.writeHead(script || request.url === '/' ? 200 : 404, {'Content-Type':script ? 'text/javascript' : 'text/html',
      'Content-Security-Policy':securityPolicy, 'Referrer-Policy':'no-referrer', 'Cache-Control':'no-store'})
      .end(script ?? '<!doctype html><title>Provider check</title>');
  });
  let browser;
  try {
    const port = await listen(server);
    browser = await openChromium(profile, async () => { throw Error('Unexpected provider'); }, {liveProvider:provider});
    await browser.navigate('http://127.0.0.1:' + port + '/');
    const result = await browser.evaluate('(' + probe.toString() + ')(' + JSON.stringify(key) + ')');
    verify(result);
  } catch {
    console.error('The live ' + provider + ' browser contract check did not pass.');
    process.exitCode = 1;
  } finally {
    try { await browser?.close(); }
    finally { await stop(server); await rm(profile, {recursive:true, force:true, maxRetries:6, retryDelay:150}); }
  }
}
