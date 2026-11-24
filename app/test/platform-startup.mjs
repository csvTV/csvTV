import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import test from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {gzipSync} from 'node:zlib';
import {createRelease} from '../package-release.mjs';
import {listen,stop} from './offline-site.mjs';
import {releaseServer,unpack} from './release-site.mjs';
import {measureImportPreview} from './import-preview-timing.mjs';

const require = createRequire(import.meta.url);
const {chromium,webkit} = require(process.env.CSVTV_PLAYWRIGHT_MODULE || 'playwright-core');
const baseline = process.env.CSVTV_STARTUP_BASELINE;

for (const [name,engine] of [['Chrome',chromium],['WebKit',webkit]]) {
  test(name+' reopens the installed release with its HTTP server stopped', {timeout:120000},async t => {
    const bytes = baseline ? await readFile(baseline) : (await createRelease(new URL('../dist/',import.meta.url))).bytes;
    const server = releaseServer(await unpack(bytes));
    const origin = 'http://127.0.0.1:'+await listen(server);
    t.after(async () => { if (server.listening) await stop(server); });
    const browser = await engine.launch({headless:true,...(engine===chromium ? {channel:'chrome'} : {})});
    t.after(() => browser.close());
    const context = await browser.newContext({proxy:{server:origin,bypass:'127.0.0.1'}});
    const page = await context.newPage();
    await page.goto(origin);
    await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
    // Stopping the host exercises the installed worker in both engines.
    await stop(server);
    const timings = [];
    for (let run=0;run<6;run++) {
      await page.reload({waitUntil:'domcontentloaded'});
      await page.getByRole('heading',{name:'Connect Dropbox',exact:true}).waitFor();
      timings.push(await page.evaluate(()=>Math.round(performance.getEntriesByType('navigation')[0].domContentLoadedEventEnd)));
    }
    t.diagnostic('Offline document ready (ms): '+timings.join(', '));
  });
}

for (const [name,engine,options] of [
  ['Chrome desktop',chromium,{viewport:{width:1440,height:900}}],
  ['touch WebKit',webkit,{isMobile:true,hasTouch:true,viewport:{width:390,height:844}}],
]) test(name+' cold startup and navigation during the first importer download', {timeout:120000},async t => {
  const bytes = baseline ? await readFile(baseline) : (await createRelease(new URL('../dist/',import.meta.url))).bytes;
  const files = await unpack(bytes);
  let release, importing;
  const server = releaseServer(files,async request => {
    const path = new URL(request.url,'http://localhost').pathname;
    if (path === '/trakt-import-screen.js' && importing) {
      importing.resolve();
      await importing.gate;
    }
    if (path.endsWith('.js') || path.endsWith('.css')) await delay(35);
    return false;
  });
  const origin = 'http://127.0.0.1:'+await listen(server);
  let browser;
  t.after(async () => { release?.(); try { await browser?.close(); } finally { await stop(server); } });
  browser = await engine.launch({headless:true,...(engine===chromium ? {channel:'chrome'} : {})});
  for(let run=1;run<=3;run++) {
    // Separate first-page execution from the background installation of every offline asset.
    const context = await browser.newContext({...options,serviceWorkers:'block',proxy:{server:origin,bypass:'127.0.0.1'}});
    try {
      const page = await context.newPage();
      await page.addInitScript(() => {
        if (location.pathname !== '/' || location.hash) return;
        function frame() {
          if (document.querySelector('[data-page=dropbox-setup] main h1')?.textContent === 'Connect Dropbox') {
            requestAnimationFrame(() => { window.setupPaint = Math.round(performance.now()); });
          } else requestAnimationFrame(frame);
        }
        requestAnimationFrame(frame);
      });
      await page.goto(origin+'/',{waitUntil:'commit'});
      await page.waitForFunction(()=>window.setupPaint!==undefined);
      const result = await page.evaluate(() => {
        const assets = performance.getEntriesByType('resource').map(entry=>new URL(entry.name).pathname.slice(1));
        return {ms:window.setupPaint,js:[...new Set(assets.filter(path=>path.endsWith('.js')))],
          css:[...new Set(assets.filter(path=>path.endsWith('.css')))]};
      });
      const gzipBytes = result.js.reduce((sum,file)=>sum+gzipSync(files.get(file)).byteLength,0);
      t.diagnostic('Cold visit '+run+': '+result.ms+' ms, '+result.css.length+' stylesheets, '+result.js.length+' scripts, '+gzipBytes+' script bytes gzipped individually');
      if (baseline) continue;
      assert.deepEqual(result.css,['csvtv.css']);
      assert.ok(result.js.includes('application.js'));
      assert.ok(!result.js.some(file=>/^(trakt|anilist)-import-screen\.js$/.test(file)),'Home eagerly loaded an importer');
      assert.ok(!result.js.includes('imdb-job-text.js'),'Opening csvTV eagerly downloaded the optional job templates');
      if (run!==3) continue;
      await page.goto(origin+'/tmdb-logo.svg');
      await page.evaluate(async () => {
        const {openDeviceStore} = await import('/storage.js'), store = await openDeviceStore();
        try {
          await store.whenWriter();
          await store.storeExchangedSession({accountId:'fixture',instanceId:crypto.randomUUID(),accessToken:'expired',
            refreshToken:'expired',accessExpiresAt:Date.now()-3600000,signInDeadline:Date.now()-86400000,providerExpiresAt:Date.now()-86400000});
        } finally { await store.closeForUpdate(); }
      });
      await page.goto(origin+'/#/settings');
      await page.getByRole('heading',{name:'Settings',exact:true}).waitFor();
      await page.evaluate(() => {
        const expected = getComputedStyle(document.documentElement).backgroundColor;
        window.routeFrames = {count:0,empty:0,changedBackground:0};
        const sample = () => {
          if (!window.routeFrames) return;
          window.routeFrames.count++;
          if (!document.querySelector('main h1')?.textContent) window.routeFrames.empty++;
          if (getComputedStyle(document.documentElement).backgroundColor!==expected) window.routeFrames.changedBackground++;
          requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      });
      const started = Promise.withResolvers();
      const held = Promise.withResolvers();
      release = held.resolve;
      importing = {resolve:started.resolve,gate:held.promise};
      await page.getByRole('link',{name:'Import from Trakt',exact:true}).click();
      await started.promise;
      await page.getByRole('heading',{name:'Import from Trakt',exact:true}).waitFor();
      await page.getByRole('button',{name:'Go back',exact:true}).click();
      await page.getByRole('heading',{name:'Settings',exact:true}).waitFor();
      release();
      await page.getByRole('link',{name:'Import from AniList',exact:true}).click();
      await page.locator('.anilist-import input[type=file]').waitFor({state:'attached'});
      assert.equal(await page.locator('.trakt-import').count(),0,'late Trakt load replaced the chosen page');
      await page.getByRole('button',{name:'Go back',exact:true}).click();
      await page.getByRole('link',{name:'Import from Trakt',exact:true}).click();
      await page.locator('.trakt-import input[type=file]').waitFor({state:'attached'});
      const frames = await page.evaluate(() => { const sampled=window.routeFrames;window.routeFrames=null;return sampled; });
      assert.ok(frames.count>0);
      assert.equal(frames.empty,0,'a navigation frame lost its screen title');
      assert.equal(frames.changedBackground,0,'a navigation frame flashed a different page background');
      t.diagnostic('13,500 placed episodes, preview edit and CSV generation (ms): '+JSON.stringify(await page.evaluate(measureImportPreview)));

      const startedFiles = Promise.withResolvers(), allowFailure = Promise.withResolvers();
      await page.route('**/imdb-job-text.js', async route => {
        startedFiles.resolve();
        await allowFailure.promise;
        await route.fulfill({status:503,body:''});
      }, {times:1});
      await page.goto(origin+'/#/imdb-ratings');
      const help = page.locator('fieldset [data-imdb-help=github]');
      const copy = page.getByRole('button',{name:'Copy build.mjs',exact:true});
      try {
        await help.click();
        await startedFiles.promise;
        assert.equal(await copy.isDisabled(),true);
        await page.getByRole('button',{name:'Done',exact:true}).click();
        await help.click();
      } finally { allowFailure.resolve(); }
      await page.getByRole('button',{name:'Reload csvTV',exact:true}).click();
      await help.click();
      await page.evaluate(() => Object.defineProperty(navigator,'clipboard',{configurable:true,
        value:{writeText(text) { window.copiedSetup = {text,active:navigator.userActivation.isActive}; return Promise.resolve(); }}
      }));
      await copy.click();
      const copied = await page.evaluate(() => window.copiedSetup);
      assert.equal(copied.active,true,'copying the file lost its triggering user gesture');
      assert.equal(copied.text,await readFile(new URL('../../jobs/imdb/build.mjs',import.meta.url),'utf8'));
    } finally { release?.(); await context.close(); }
  }
});
