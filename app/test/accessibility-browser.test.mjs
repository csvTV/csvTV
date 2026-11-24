import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openChromium } from './offline-chromium.mjs';
import { linkFixture, offlineProviders } from './offline-providers.mjs';
import { testSite, listen, stop } from './offline-site.mjs';
import { checkRenderedContrast } from './rendered-contrast.mjs';

async function seed() {
  const { openDeviceStore } = await import('/tracker/storage.js');
  const store = await openDeviceStore();
  try {
    const snapshot = await store.whenWriter();
    const show = { show_id:45, show:'The Listening House' };
    await store.commit(snapshot.revision, {put:{
      watched:[{...show, season:1, episode:1, episode_id:45011, title:'Recording 1', times_watched:1},
        {...show, season:1, episode:Number.MAX_SAFE_INTEGER, episode_id:null, title:'Archived finale', times_watched:Number.MAX_SAFE_INTEGER}],
      ratings:[{...show, rating:7}], lists:[{...show, list:'Watchlist'}],

    }});
  } finally { await store.closeForUpdate(); }
}

async function tabTo(browser, selector) {
  for (let i = 0; i < 75; i++) {
    if (await browser.evaluate('document.activeElement.matches(' + JSON.stringify(selector) + ')')) return;
    await browser.press('Tab');
  }
  assert.fail('Tab could not reach ' + selector);
}

test('Keyboard navigation and visual accessibility at phone and desktop sizes', {timeout:100_000}, async t => {
  const {server} = await testSite();
  const profile = await mkdtemp(join(tmpdir(), 'csvtv-accessibility-'));
  let browser;
  t.after(async () => {
    try { await browser?.close(); }
    finally { await stop(server); await rm(profile, {recursive:true, force:true, maxRetries:6, retryDelay:150}); }
  });
  const origin = 'http://127.0.0.1:' + await listen(server);
  const providers = offlineProviders(origin);
  browser = await openChromium(profile, providers.respond);
  await linkFixture(browser, origin);
  await providers.settings({tmdb_key:'fictional-offline-key'});
  const viewport = width => browser.send('Emulation.setDeviceMetricsOverride', {
    width, height:720, deviceScaleFactor:1, mobile:false,
  });
  const route = async page => {
    await browser.navigate(origin + '/tracker/#/' + page);
    const expected = page.includes('/season/') ? 'season' : page.split('/')[0];
    await browser.waitFor('document.querySelector("#app")?.dataset.page === ' + JSON.stringify(expected));
  };
  await viewport(320);
  await browser.navigate(origin + '/fixture');
  await browser.evaluate('(' + seed.toString() + ')()');
  await route('settings');
  await browser.waitFor('document.querySelector("[data-help]")');

  await t.test('Keyboard skip, TMDB help, focus wrapping and Escape work at 320 CSS pixels', async () => {
    await browser.press('Tab');
    assert.equal(await browser.evaluate('document.activeElement.className'), 'skip-link');
    assert.equal(await browser.evaluate('getComputedStyle(document.activeElement).outlineWidth'), '2px');
    await browser.press('Enter');
    assert.equal(await browser.evaluate('document.activeElement.id'), 'screen');
    assert.equal(await browser.evaluate('getComputedStyle(document.activeElement).outlineStyle'), 'none', 'Skip should not frame the whole page');
    await tabTo(browser, '[data-help]');
    assert.equal(await browser.evaluate('getComputedStyle(document.activeElement).outlineWidth'), '2px');
    await browser.press('Enter');
    await browser.waitFor('document.activeElement.id === "sheet-title"');
    assert.equal(await browser.evaluate('document.activeElement.textContent'), 'Get a TMDB key');
    await browser.press('Tab', {shift:true});
    assert.equal(await browser.evaluate('document.activeElement.textContent.includes("Open TMDB")'), true);
    await browser.press('Tab');
    assert.equal(await browser.evaluate('document.activeElement.href'), 'https://www.themoviedb.org/signup');
    assert.ok(await browser.evaluate('document.querySelector("dialog").scrollWidth <= document.querySelector("dialog").clientWidth'));
    await browser.press('Escape');
    assert.ok(await browser.evaluate('document.activeElement.matches("[data-help]")'));
  });

  await t.test('Key instructions fit one line at each width and help actions have a consistent gap', async () => {
    for (const width of [320,390,1440]) {
      await viewport(width);
      for (const selector of ['[data-help]','[data-mdblist-help]','[data-dropbox-help]']) {
        await browser.click(selector);
        await browser.waitFor('document.querySelector("dialog[open] .help-actions")');
        const layout = await browser.evaluate(`(() => {
          const dialog=document.querySelector('dialog[open]'), actions=dialog.querySelector('.help-actions');
          const measureSteps=()=>Array.from(dialog.querySelectorAll('.steps li'),item=>{
            const node=item.firstChild, range=document.createRange();
            range.setStart(node,0); range.setEnd(node,node.textContent.trimEnd().length);
            return {lines:range.getClientRects().length,instruction:range.toString()};
          });
          const text=measureSteps();
          if (innerWidth === 320) {
            dialog.style.fontFamily='Verdana, sans-serif';
            text.push(...measureSteps());
            dialog.style.removeProperty('font-family');
          }
          return {text,gap:actions.getBoundingClientRect().top-actions.previousElementSibling.getBoundingClientRect().bottom};
        })()`);
        assert.ok(layout.gap>=23, selector+' spacing at '+width);
        for (const row of layout.text) assert.equal(row.lines,1,width+'px: '+row.instruction);
        await browser.press('Escape');
      }
    }
    await viewport(320);
  });

  await t.test('The main screens fit 320 CSS pixels', async () => {
    for (const page of ['home','settings','library','lists','watchlist','watchlist/more-to-watch','search','export',
      'statistics','trakt-import','hand-merge','recovery','show/45','show/45/season/1']) {
      await route(page);
      await browser.waitFor('!!document.querySelector("main h1")');
      if (page.includes('/season/')) {
        const selector = '[data-episode="episode-9007199254740991"] .season-episode';
        await browser.waitFor(`document.querySelector('${selector}')`);
        for (const textSize of ['100%','125%']) {
          const layout = await browser.evaluate(`(() => {
            const info = document.querySelector('${selector}'), row = info.parentElement;
            row.style.fontSize = '${textSize}';
            const title = info.querySelector('.episode-copy');
            return {width:title.clientWidth, name:title.querySelector('.episode-name').textContent,
              overflow:[row, ...row.querySelectorAll('*')].some(cell => cell.scrollWidth > cell.clientWidth + 1),
              buttons:[...row.querySelectorAll('button')].map(button => [button.clientWidth, button.clientHeight])};
          })()`);
          assert.ok(layout.width >= 64, 'Episode title has only ' + layout.width + 'px at ' + textSize);
          assert.equal(layout.name, 'Archived finale');
          assert.equal(layout.overflow, false, 'Episode row content overflowed at ' + textSize);
          assert.equal(layout.buttons.length, 3);
          assert.ok(layout.buttons.every(([w,h]) => w >= 44 && h >= 44), 'Episode controls shrank at ' + textSize);
        }
      }
      assert.ok(await browser.evaluate('document.documentElement.scrollWidth <= innerWidth'), page + ' overflowed horizontally');
    }
  });

  await t.test('Settings subpages have one keyboard-accessible Back control on phone and desktop', async () => {
    for (const width of [320,1120]) {
      await viewport(width);
      async function useBack() {
        const phone = width < 900;
        assert.deepEqual(await browser.evaluate(`[...document.querySelectorAll('[aria-label="Go back"]')]
          .filter(button => button.getClientRects().length).map(button => button.textContent)`), ['Back']);
        await browser.evaluate('document.querySelector("' + (phone ? '.skip-link' : 'main') + '").focus()');
        await browser.press('Tab');
        assert.equal(await browser.evaluate('document.activeElement.getAttribute("aria-label")'), 'Go back');
        assert.ok(await browser.evaluate('getComputedStyle(document.activeElement).outlineStyle === "solid" && parseFloat(getComputedStyle(document.activeElement).outlineWidth) > 0'),
          'Keyboard Back should have a visible focus ring at the active scale');
        await browser.press('Enter');
        await browser.waitFor('location.hash === "#/settings" && document.activeElement.id === "screen"');
        assert.equal(await browser.evaluate('getComputedStyle(document.activeElement).outlineStyle'), 'none',
          'Keyboard Back framed the full Settings page');
      }
      // A bookmark has no earlier app entry, even when the browser has history from a different page.
      await browser.navigate(origin + '/fixture');
      await route(width === 320 ? 'imdb-ratings' : 'mal-scores');
      assert.equal(await browser.evaluate('history.state.csvtvDepth'), 0);
      assert.equal(await browser.evaluate('getComputedStyle(document.querySelector("#screen")).outlineStyle'), 'none', 'Direct screen entry should be borderless');
      await useBack();
      for (const page of ['imdb-ratings','mal-scores','trakt-import','anilist-import','recovery','hand-merge']) {
        await browser.click('main a[href="#/' + page + '"]');
        await browser.waitFor('document.querySelector("#app").dataset.page === ' + JSON.stringify(page));
        assert.equal(await browser.evaluate('getComputedStyle(document.querySelector("#screen")).outlineStyle'), 'none', 'Pointer navigation framed the new page');
        await useBack();
        assert.equal(await browser.evaluate('history.state.csvtvDepth'), 0, 'Back should restore the original Settings entry');
      }
    }
  });

  await t.test('Keyboard controls save an edited rating and open its chart table', async () => {
    await route('show/45');
    await browser.waitFor('document.querySelector(".show-rating:not(:disabled)")');
    await tabTo(browser, '.show-rating');
    await browser.press('Enter');
    await browser.waitFor('document.querySelector("dialog[open] .rating-slider")');
    await tabTo(browser, 'input[type=range]');
    await browser.press('ArrowRight');
    assert.equal(await browser.evaluate('document.querySelector(".rating-figure strong").textContent'), '7.5');
    await browser.press('Tab');
    await browser.press('Tab');
    assert.equal(await browser.evaluate('document.activeElement.textContent'), 'Done');
    await browser.press('Enter');
    await browser.waitFor('document.querySelector(".show-rating")?.textContent === "7.5/10"');
    await viewport(1120);
    await route('statistics');
    await browser.waitFor('document.querySelector("[data-table=ratings]")');
    await tabTo(browser, '[data-table=ratings]');
    await browser.press('Enter');
    await browser.waitFor('document.querySelector("[data-chart=ratings] table")?.offsetWidth > 0');
    assert.equal(await browser.evaluate('document.querySelector("[data-chart=ratings] thead th").textContent'), 'My rating');
  });

  await t.test('A keyboard user can select the initial rating of five, cancel, and save it on reopening', async () => {
    await route('show/45');
    await browser.waitFor('document.querySelector(".show-rating")?.textContent === "7.5/10"');
    await tabTo(browser, '.show-rating');
    await browser.press('Enter');
    await tabTo(browser, '.rating-commands .destructive');
    await browser.press('Enter');
    await browser.waitFor('document.querySelector(".show-rating")?.textContent === "Rate"');
    for (const key of ['Enter', 'Space']) {
      await tabTo(browser, '.show-rating');
      await browser.press('Enter');
      await tabTo(browser, 'input[type=range]');
      assert.ok(await browser.evaluate('document.querySelector(".rating-commands button").disabled'));
      await browser.press(key);
      assert.equal(await browser.evaluate('document.querySelector(".rating-figure:not([hidden]) strong")?.textContent'), '5');
      if (key === 'Enter') {
        await browser.press('Escape');
        assert.equal(await browser.evaluate('document.querySelector(".show-rating").textContent'), 'Rate');
      } else {
        await tabTo(browser, '.rating-commands button');
        await browser.press('Enter');
        await browser.waitFor('document.querySelector(".show-rating")?.textContent === "5/10"');
      }
    }
  });

  await t.test('Artwork, poster progress, slider, focus and control colours meet the contrast thresholds in both themes', async () => {
    await route('settings');
    await browser.waitFor('document.querySelector(".appearance-options input:checked")');
    for (const width of [320,1120]) {
      await viewport(width);
      await checkRenderedContrast(browser);
    }
  });
});
