import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {openChromium} from './offline-chromium.mjs';
import { linkFixture, offlineProviders } from './offline-providers.mjs';
import {listen, stop, testSite} from './offline-site.mjs';

test('Desktop uses 125% sizing, keeps dialogs and sidebar on screen, and preserves phone sizing', {timeout:60000}, async t => {
  const {server} = await testSite();
  const origin = 'http://127.0.0.1:' + await listen(server);
  const profile = await mkdtemp(join(tmpdir(), 'csvtv-desktop-sizing-'));
  let browser;
  t.after(async () => {
    try { await browser?.close(); }
    finally { await stop(server); await rm(profile, {recursive:true, force:true, maxRetries:6, retryDelay:150}); }
  });
  const providers = offlineProviders(origin);
  browser = await openChromium(profile, providers.respond);
  await linkFixture(browser, origin);
  const app = origin + '/tracker/';
  async function viewport(width, height) {
    await browser.send('Emulation.setDeviceMetricsOverride', {width,height,deviceScaleFactor:1,mobile:false});
    await browser.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    assert.equal(await browser.evaluate('document.documentElement.scrollWidth <= innerWidth'),true);
  }
  const rect = selector => browser.evaluate('document.querySelector(' + JSON.stringify(selector) + ').getBoundingClientRect().toJSON()');
  async function point(selector) {
    const element = 'document.querySelector(' + JSON.stringify(selector) + ')';
    await browser.waitFor(element + '?.matches(":not(:disabled)") && ' + element + '.getClientRects().length');
    await browser.evaluate(element + '.scrollIntoView({block:"center"})');
    const box = await rect(selector);
    const position = {x:box.left + box.width/2,y:box.top + box.height/2,button:'left',clickCount:1};
    await browser.send('Input.dispatchMouseEvent', {type:'mousePressed',...position});
    await browser.send('Input.dispatchMouseEvent', {type:'mouseReleased',...position});
  }
  await t.test('Wide Home uses the intended 125% scale at default browser zoom', async () => {
    await viewport(2200,1200);
    await browser.navigate(app+'#/home');
    await browser.waitFor('document.querySelector(".home-screen .setup-card .button")');
    assert.equal(await browser.evaluate('devicePixelRatio'),1);
    // The initial Dropbox status can settle between two browser commands.
    // Compare the three elements in the same layout frame.
    const [search,heading,title] = await browser.evaluate(`['.home-search','.home-screen .screen-heading','.home-screen h1']
      .map(selector => document.querySelector(selector).getBoundingClientRect().toJSON())`);
    assert.equal(heading.width,1330);
    assert.ok(search.left > title.right && Math.abs(search.right-heading.right) <= 1);
    assert.ok(search.top <= title.top && search.bottom >= title.bottom,JSON.stringify({search,title}));
    assert.equal(search.height,57.5);
    assert.equal((await rect('.setup-card')).width,1330);
    assert.equal((await rect('.setup-card .button')).height,55);
  });
  await t.test('Home accepts typing in place and opens Search only on keyboard or pointer submission', async () => {
    const input = '.home-search input', query = 'Signal & Tide + #4?/50%';
    const onHome = 'location.hash === "#/home" && !!document.querySelector(".home-search input")';
    const searchResult = text => 'document.querySelector(".search-screen input")?.value === ' + JSON.stringify(text) +
      ' && location.hash === ' + JSON.stringify('#/search?' + new URLSearchParams({q:text}));
    await point(input);
    const key = {key:'S',code:'KeyS',windowsVirtualKeyCode:83};
    await browser.send('Input.dispatchKeyEvent',{...key,type:'keyDown',text:'S'});
    await browser.send('Input.dispatchKeyEvent',{...key,type:'keyUp'});
    await browser.send('Input.insertText',{text:query.slice(1)});
    // Search itself debounces at 500 ms. Home should still hold the draft after that interval.
    await browser.evaluate('new Promise(resolve=>setTimeout(resolve,650))');
    assert.ok(await browser.evaluate(onHome));
    assert.equal(await browser.evaluate('document.activeElement.value'),query);
    await browser.press('Enter');
    await browser.waitFor(searchResult(query));
    await browser.evaluate('history.back()');
    await browser.waitFor(onHome);
    const depth = await browser.evaluate('history.state.csvtvDepth');
    await point(input);
    await browser.send('Input.insertText',{text:'   '});
    await browser.press('Enter');
    assert.ok(await browser.evaluate(onHome));
    assert.equal(await browser.evaluate('history.state.csvtvDepth'),depth);
    assert.ok(await browser.evaluate('document.activeElement.matches(".home-search input")'));
    await browser.send('Input.insertText',{text:'Second query'});
    await point('.home-search-submit');
    await browser.waitFor(searchResult('Second query'));
    await browser.evaluate('history.back()');
    await browser.waitFor(onHome);
  });
  await t.test('The visible Home name uses the tab icon on desktop and phone', async () => {
    for (const width of [1440, 320]) {
      await viewport(width, 844);
      const brand = await browser.evaluate(`(async () => {
        const [link] = [...document.querySelectorAll('.app-name')].filter(el => el.getClientRects().length);
        const icon = getComputedStyle(link, '::before');
        const image = new Image();
        image.src = icon.backgroundImage.match(/^url\\("(.+)"\\)$/)[1];
        await image.decode();
        const text = document.createRange();
        text.selectNodeContents(link);
        const textBox = text.getBoundingClientRect();
        const sync = document.querySelector('.phone-header .cloud-status').getBoundingClientRect();
        return {name:link.textContent, home:link.hash, sameIcon:image.src === document.querySelector('link[rel=icon][type="image/svg+xml"]').href,
          width:icon.width, height:icon.height, beforeText:textBox.left - link.getBoundingClientRect().left >= 24,
          fits:!sync.width || textBox.right <= sync.left};
      })()`);
      assert.deepEqual(brand,{name:'csvTV',home:'#/home',sameIcon:true,width:'24px',height:'24px',beforeText:true,fits:true});
    }
  });
  await browser.navigate(origin+'/fixture');
  await providers.settings({tmdb_key:'fictional-offline-key'});
  await browser.evaluate(`(async () => {
    const {openDeviceStore} = await import('/tracker/storage.js');
    const store = await openDeviceStore();
    try {
      await store.commit((await store.whenWriter()).revision, {put:{
        watched:[{show_id:45,show:'The Listening House',season:1,episode:1,episode_id:45011,title:'Recording 1',times_watched:1}],

      }});
    } finally { await store.closeForUpdate(); }
  })()`);
  await browser.navigate(app+'#/library');
  await browser.waitFor('document.querySelector("[data-show-id]") && document.querySelector(".sync-state")?.textContent === "Synced"');
  for (const [width,height,desktop] of [[390,844,false],[899,760,false],[900,675,true],[1374,800,true],[1375,800,true]]) {
    await viewport(width,height);
    const sidebar = await rect('.app-sidebar');
    assert.equal(sidebar.width,desktop ? 245 : 0);
    if (desktop) assert.equal(sidebar.height,height);
    const gap = await browser.evaluate('getComputedStyle(document.querySelector(".library-grid")).columnGap');
    if (width === 1374 || width === 1375) assert.equal(gap,width === 1375 ? '16px' : '12px');
    await point('.sort-trigger');
    assert.equal(await browser.evaluate('!!document.querySelector("dialog[open]")'),false);
    await browser.press('Escape');
    assert.equal(await browser.evaluate('document.activeElement.matches(".sort-trigger")'),true);
    if (width === 390) {
      for (const type of ['rawKeyDown','keyUp']) {
        await browser.send('Input.dispatchKeyEvent',{type,key:'ArrowDown',code:'ArrowDown',windowsVirtualKeyCode:40});
      }
      await browser.waitFor('document.querySelector(".sort-trigger").value === "rating"','native keyboard changes sort');
    }
  }
  await viewport(1000,450);
  await point('.app-sidebar .sync-state');
  await browser.waitFor('location.hash === "#/settings" && document.querySelector("input[value=light]")');
  await point('input[value=light]');
  await browser.waitFor('document.documentElement.dataset.theme === "light"');
  await viewport(1562,850);
  await browser.navigate(app+'#/show/45');
  await browser.waitFor('document.querySelector(".show-hero .show-art-poster")');
  const areas = () => browser.evaluate('getComputedStyle(document.querySelector(".show-hero")).gridTemplateAreas');
  assert.match(await areas(),/"poster title"/);
  await viewport(1563,850);
  assert.match(await areas(),/"poster title stats"/);
  await point('.show-rating');
  await browser.waitFor('document.querySelector("dialog[open] input[type=range]")');
  assert.equal((await rect('dialog[open]')).width,487.5);
});
