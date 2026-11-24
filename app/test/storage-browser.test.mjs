import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUpgradeSite } from './offline-upgrade-site.mjs';

const screenStyles = ['settings', 'application', 'home-search', 'show', 'season', 'personal-sheets', 'lists',
  'library', 'watch-views', 'cast', 'statistics', 'export'];

async function browserPath() {
  if (process.env.CSVTV_BROWSER) return process.env.CSVTV_BROWSER;
  const candidates = process.platform === 'win32' ? [
    join(process.env.ProgramFiles, 'Google/Chrome/Application/chrome.exe'),
    join(process.env['ProgramFiles(x86)'], 'Microsoft/Edge/Application/msedge.exe'),
  ] : ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  for (const path of candidates) {
    try { await access(path); return path; } catch { /* Try the next standard location. */ }
  }
  throw new Error('Set CSVTV_BROWSER to a Chromium browser executable to run the storage acceptance tests.');
}

// Serve just the test modules and compiled app on a fresh loopback origin. The browser
// posts its assertions back so IDB, Web Locks and page transitions run on real clocks.
test('Storage, TMDB and screen acceptance in Chromium', { timeout: 150_000 }, async t => {
  const executable = await browserPath();
  const profile = await mkdtemp(join(tmpdir(), 'csvtv-storage-'));
  let receive;
  let fail;
  const report = new Promise((resolve, reject) => { receive = resolve; fail = reject; });
  let compatibilityBuild = 1;
  const upgradeSite = await createUpgradeSite();
  const server = createServer(async (request, response) => {
    try {
      if (upgradeSite(request, response)) return;
      if (request.method === 'POST' && request.url === '/result') {
        let data = '';
        for await (const part of request) data += part;
        receive(JSON.parse(data));
        response.writeHead(204).end();
      } else if (request.url === '/') {
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end(`<!doctype html><title>csvTV storage tests</title><script type="module">
          import('/test/storage-cases.mjs').catch(error => fetch('/result', {
            method: 'POST', body: JSON.stringify({ passed: [], error: error.message })
          }));
        </script>`);
      } else if (request.method === 'POST' && request.url === '/publish-compatible-test-build') {
        compatibilityBuild = 3;
        response.writeHead(204).end();
      } else if (request.url === '/compatibility-fixture') {
        response.writeHead(200, { 'Content-Type':'text/html; charset=utf-8', 'Cache-Control':'no-store' });
        response.end('<!doctype html><html lang="en" data-stage="' + compatibilityBuild + '"><head><meta name="csvtv-build" content="' +
          String(compatibilityBuild).repeat(64) + '"><title>Compatibility test</title><script type="module">' +
          'import { openCompatibilityFixture } from "/test/dropbox-compatibility-cases.mjs"; await openCompatibilityFixture();</script></head><body></body></html>');
      } else if (request.url === '/peer') {
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end('<!doctype html><title>csvTV second tab</title><script type="module">import {openDeviceStore} from "/dist/storage.js"; window.openStore = openDeviceStore;</script>');
      } else if (request.url === '/screen-fixture') {
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
          screenStyles.map(name => '<link rel="stylesheet" href="/' + name + '.css">').join('') +
          '<div id="app"></div>');
      } else if (screenStyles.some(name => request.url === '/' + name + '.css') || request.url === '/tmdb-logo.svg') {
        const asset = await readFile(new URL('../dist' + request.url, import.meta.url));
        response.setHeader('Content-Type', request.url.endsWith('.css') ? 'text/css' : 'image/svg+xml');
        response.end(asset);
      } else if (request.url === '/dist/import-test.html' || request.url === '/dist/fresh-test.html') {
        const html = await readFile(new URL('../dist/index.html', import.meta.url), 'utf8');
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        const entry = request.url === '/dist/fresh-test.html' ? '/test/fresh-device-cases.mjs' : './import-main.js';
        response.end(html.replace('src="./main.js"', 'src="' + entry + '"'));
      } else if (request.url === '/dist/import-main.js') {
        const main = await readFile(new URL('../dist/main.js', import.meta.url), 'utf8');
        response.writeHead(200, {'Content-Type':'text/javascript; charset=utf-8'});
        response.end(main.replace('from "./dropbox-auth.js"', 'from "/test/import-provider-cases.mjs"'));
      } else if (/^\/dist\/(index\.html|[\w-]+\.(css|svg|png))$/.test(request.url)) {
        const extension = request.url.split('.').pop();
        response.setHeader('Content-Type', { html: 'text/html; charset=utf-8', css: 'text/css', svg: 'image/svg+xml', png: 'image/png' }[extension]);
        response.end(await readFile(new URL('..' + request.url, import.meta.url)));
      } else if (/^\/(dist\/[\w-]+\.js|test\/(?:[\w-]+-cases|core-roundtrip|tmdb-integration)\.mjs)$/.test(request.url)) {
        const source = await readFile(new URL('..' + request.url, import.meta.url), 'utf8');
        response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
        response.end(source);
      } else {
        response.writeHead(404).end();
      }
    } catch (error) {
      response.writeHead(500).end();
      fail(error);
    }
  });
  let browser;
  let exited;
  t.after(async () => {
    if (browser && browser.exitCode === null) browser.kill();
    if (exited) await exited;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(profile, { recursive: true, force: true, maxRetries: 12, retryDelay: 150 });
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  browser = spawn(executable, ['--headless', '--disable-gpu', '--disable-background-networking',
    // A headless Windows session can have no physical pointing device.
    '--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4',
    '--disable-default-apps', '--disable-sync', '--disable-popup-blocking', '--no-first-run',
    '--no-default-browser-check', '--user-data-dir=' + profile, url], { stdio: 'ignore', windowsHide: true });
  browser.on('error', fail);
  exited = new Promise(resolve => browser.once('close', code => {
    fail(new Error('The test browser closed before reporting results (exit ' + code + ').'));
    resolve();
  }));
  // The full page reports once, after all scenarios. Hosted Chrome can take over 70 seconds.
  const timeout = setTimeout(() => fail(new Error('The browser did not report its assertions.')), 120_000);
  try {
    const result = await report;
    for (const name of result.passed) await t.test(name, () => {});
    assert.equal(result.error, undefined, result.error);
    assert.equal(new Set(result.passed).size, result.passed.length, 'Each scenario must run once.');
  } finally {
    clearTimeout(timeout);
  }
});
