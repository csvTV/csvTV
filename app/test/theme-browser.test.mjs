import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openChromium } from './offline-chromium.mjs';
import { linkFixture, offlineProviders } from './offline-providers.mjs';
import { listen, stop, testSite } from './offline-site.mjs';

test('A cold document requests each static dependency once and a controlled offline document skips startup hints', {timeout:60000},async t=>{
  const {server,manifest} = await testSite(), scripts = new Map();
  server.prependListener('request',req=>{
    if (req.headers['sec-fetch-dest']==='script') scripts.set(req.url,(scripts.get(req.url)??0)+1);
  });
  const profile = await mkdtemp(join(tmpdir(),'csvtv-startup-')), origin = 'http://127.0.0.1:'+await listen(server);
  let browser;
  t.after(async()=>{
    try { await browser?.close(); } finally { await stop(server); await rm(profile,{recursive:true,force:true,maxRetries:8,retryDelay:150}); }
  });
  browser = await openChromium(profile);
  await browser.send('Page.addScriptToEvaluateOnNewDocument',{source:'('+(() => {
    window.startupHints = [];
    window.peakStartupHints = 0;
    new MutationObserver(records=>{
      window.peakStartupHints = Math.max(window.peakStartupHints,document.querySelectorAll('link[rel=modulepreload]').length);
      for (const record of records) for (const node of record.addedNodes) {
        if (node.rel==='modulepreload') window.startupHints.push(new URL(node.href).pathname);
      }
    }).observe(document,{subtree:true,childList:true});
  }).toString()+')()'});
  const route = origin+'/tracker/';
  const ready = 'document.querySelector("[data-page=dropbox-setup] main h1")?.textContent === "Connect Dropbox"';
  await browser.navigate(route);
  await browser.waitFor(ready+' && navigator.serviceWorker.controller && !document.querySelector("link[rel=modulepreload]")','setup and a complete offline installation');
  const hints = await browser.evaluate('window.startupHints');
  const peak = await browser.evaluate('window.peakStartupHints');
  assert.ok(hints.length>16 && peak>0 && peak<=16,'A slow browser must have room to fetch its entry and styles');
  assert.ok(hints.includes('/tracker/storage.js') && hints.includes('/tracker/dropbox-setup-screen.js'));
  assert.equal(new Set(hints).size,hints.length);
  for (const url of hints) {
    assert.ok(url.startsWith('/tracker/') && Object.hasOwn(manifest.files,url.slice('/tracker/'.length)),url);
    assert.equal(scripts.get(url),1,'Expected one module request for '+url);
  }
  for (const name of ['main.js','record-screens.js','library-screen.js','anilist-import-screen.js','trakt-import-screen.js','imdb-job-text.js','zip-native.js']) {
    assert.ok(!hints.includes('/tracker/'+name),'Unexpected startup hint for '+name);
  }
  await browser.offline(true);
  await browser.navigate('about:blank');
  await browser.navigate(route);
  await browser.waitFor(ready+' && navigator.serviceWorker.controller','offline setup in the installed shell');
  assert.deepEqual(await browser.evaluate('window.startupHints'),[]);
});

test('Appearance follows real device changes only in Match device and paints the saved theme before app startup', {timeout:60000}, async t => {
  const {server} = await testSite();
  const profile = await mkdtemp(join(tmpdir(), 'csvtv-appearance-'));
  let browser;
  t.after(async () => {
    try { await browser?.close(); } finally {
      await stop(server);
      await rm(profile, {recursive:true, force:true, maxRetries:8, retryDelay:150});
    }
  });
  const origin = 'http://127.0.0.1:' + await listen(server);
  const settings = origin + '/tracker/#/settings';
  const providers = offlineProviders(origin);
  browser = await openChromium(profile, providers.respond);
  await linkFixture(browser, origin);
  const device = value => browser.send('Emulation.setEmulatedMedia', {features:[{name:'prefers-color-scheme', value}]});
  const checked = value => '.appearance-options input[value="' + value + '"]:checked';
  const theme = async (effective, selected) => {
    const page = effective === 'light' ? 'rgb(246, 246, 247)' : 'rgb(10, 10, 12)';
    await browser.waitFor('document.documentElement.dataset.theme === ' + JSON.stringify(effective) +
      ' && getComputedStyle(document.documentElement).backgroundColor === ' + JSON.stringify(page) +
      ' && document.querySelector(' + JSON.stringify(checked(selected)) + ')', effective + ' appearance with ' + selected + ' selected');
  };
  await device('light');
  await browser.navigate(settings);
  await theme('dark', 'dark');
  await browser.waitFor('!document.querySelector(".appearance-options input").disabled', 'writer controls');
  await browser.evaluate('document.querySelector(' + JSON.stringify(checked('dark')) + ').focus()');
  await browser.press('ArrowRight');
  await theme('light', 'light');
  await device('dark');
  assert.equal(await browser.evaluate('matchMedia("(prefers-color-scheme: light)").matches'), false);
  await theme('light', 'light');
  await browser.press('ArrowRight');
  await theme('dark', 'device');
  await browser.waitFor('localStorage.getItem("csvTV-appearance") === "device"', 'saved startup preference');
  await device('light');
  await theme('light', 'device');
  await browser.navigate(origin + '/fixture');

  // With the app entry blocked, only the parser-blocking startup script can
  // apply the previous choice. The CSS and native browser colour must agree.
  await browser.send('Network.setBypassServiceWorker', {bypass:true});
  await browser.send('Network.setBlockedURLs', {urls:['*/tracker/main.js']});
  await browser.navigate(settings);
  assert.deepEqual(await browser.evaluate(`({
    theme:document.documentElement.dataset.theme, page:getComputedStyle(document.documentElement).backgroundColor,
    chrome:document.querySelector('meta[name="theme-color"]').content, controls:!!document.querySelector('.appearance-options')
  })`), {theme:'light', page:'rgb(246, 246, 247)', chrome:'#f6f6f7', controls:false});
  await browser.send('Network.setBlockedURLs', {urls:[]});
  await browser.send('Network.setBypassServiceWorker', {bypass:false});
  await browser.navigate(origin + '/fixture');
  await browser.navigate(settings);
  await theme('light', 'device');
  await device('dark');
  await theme('dark', 'device');
});
