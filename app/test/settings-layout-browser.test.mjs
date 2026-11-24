import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openChromium } from './offline-chromium.mjs';
import { linkFixture, offlineProviders } from './offline-providers.mjs';
import { listen, stop, testSite } from './offline-site.mjs';

const services = ['Dropbox', 'TMDB key', 'MDBList key', 'IMDb ratings', 'MyAnimeList scores'];
const imports = ['Import from Trakt', 'Import from AniList'];

function measureSettings() {
  const main = document.querySelector('main');
  const tiles = [...main.querySelector('#settings-services').children];
  const actions = [...main.querySelectorAll('.settings-imports a')];
  const status = main.querySelector('[data-offline-status]');
  const update = main.querySelector('[data-offline-update]');
  const boxes = tiles.map(tile => tile.getBoundingClientRect());
  const actionsFit = tiles.every((tile, index) => {
    const buttons = [...tile.querySelectorAll('button, a[href]')].filter(button => button.getClientRects().length);
    const bounds = buttons.map(button => button.getBoundingClientRect());
    return bounds.every((box, position) => box.left >= boxes[index].left - 1 && box.right <= boxes[index].right + 1
      && !bounds.slice(position + 1).some(other => box.left < other.right - 1 && box.right > other.left + 1
        && box.top < other.bottom - 1 && box.bottom > other.top + 1));
  });
  const group = main.querySelector('.settings-imports');
  const groupBox = group.getBoundingClientRect();
  const note = main.querySelector('.key-storage-note');
  const signOut = main.querySelector('[data-sign-out]');
  const dropboxBoxes = [...main.querySelectorAll('.dropbox-actions :is(button,a)')]
    .filter(control => control.getClientRects().length).map(control => control.getBoundingClientRect());
  return {
    tileGaps:boxes.slice(1).map((box,i) => box.top-boxes[i].bottom),
    storageNoteLines:Math.round(note.offsetHeight / parseFloat(getComputedStyle(note).lineHeight)),
    signOutFill:getComputedStyle(signOut).backgroundColor,
    syncFill:getComputedStyle(main.querySelector('[data-sync]')).backgroundColor,
    tileFill:getComputedStyle(signOut.closest('.key-row')).backgroundColor,
    dropboxGaps:dropboxBoxes.slice(1).flatMap((box,index) =>
      Math.abs(box.top - dropboxBoxes[index].top) < 1 ? [box.left - dropboxBoxes[index].right] : []),
    tileNames:tiles.map(tile => tile.querySelector('strong').innerText),
    importNames:actions.map(link => link.innerText),
    importsNext:tiles[0].parentElement.nextElementSibling === group,
    stacked:boxes.slice(1).every((box, index) => box.top >= boxes[index].bottom - 1)
      && groupBox.top >= boxes.at(-1).bottom - 1,
    withinPage:[...boxes, groupBox].every(box => box.width > 0 && box.left >= 0 && box.right <= innerWidth + 1)
      && document.documentElement.scrollWidth <= innerWidth + 1,
    visibleTargets:actions.every(link => {
      const bounds = link.getBoundingClientRect();
      return bounds.height >= 44 && bounds.left >= groupBox.left - 1 && bounds.right <= groupBox.right + 1;
    }),
    actionsFit,
    gap:update.getBoundingClientRect().top - status.getBoundingClientRect().bottom,
    update:update.innerText,
    headings:[...main.querySelectorAll('h1,h2')].filter(h => h.getClientRects().length).map(h => h.innerText.toLowerCase()),
    about:!!main.querySelector('#about'),
  };
}

async function tabThroughSettings(browser) {
  await browser.evaluate('document.querySelector("main").focus()');
  const visited = [];
  for (let step = 0; step < 40; step++) {
    await browser.press('Tab');
    const label = await browser.evaluate(`(() => {
      const control = document.activeElement;
      return control.closest('.key-row')?.querySelector('strong').innerText
        ?? (control.closest('.settings-imports') ? control.innerText : null);
    })()`);
    assert.ok(label, 'Tab left the service tiles before reaching both imports');
    if (visited.at(-1) !== label) visited.push(label);
    if (label === imports[1]) break;
  }
  assert.deepEqual(visited, [...services, ...imports], 'Keyboard order');
  await browser.press('Tab', {shift:true});
  assert.equal(await browser.evaluate('document.activeElement.hash'), '#/trakt-import');
}

test('Settings orders prerequisites, imports and offline controls on desktop and phone', {timeout:75000}, async t => {
  const {server} = await testSite();
  const origin = 'http://127.0.0.1:' + await listen(server);
  const profile = await mkdtemp(join(tmpdir(), 'csvtv-settings-layout-'));
  const providers = offlineProviders(origin);
  let browser;
  t.after(async () => {
    try { await browser?.close(); }
    finally { await stop(server); await rm(profile, {recursive:true, force:true, maxRetries:6, retryDelay:150}); }
  });
  browser = await openChromium(profile, providers.respond);
  const url = origin + '/tracker/#/settings';
  await browser.navigate(url);
  await browser.waitFor('document.querySelector("#app").dataset.page === "dropbox-setup"');
  assert.equal(await browser.evaluate('document.querySelector("main h1").innerText'), 'Connect Dropbox');
  assert.equal(await browser.evaluate('document.querySelector("#tmdb-key-label, .settings-imports")'), null);
  await linkFixture(browser, origin);
  await browser.navigate(url);
  const ready = 'document.querySelector("[data-edit]")?.disabled === false && document.querySelector("[data-offline-status]")?.innerText === "Ready to open offline."';
  await browser.waitFor(ready);
  await browser.waitFor('document.querySelector("[data-cloud-reason]")?.innerText === "Synced"');
  assert.match(await browser.evaluate('document.querySelector("#dropbox-label").closest(".key-row").innerText'), /Required/i);
  assert.match(await browser.evaluate('document.querySelector("#tmdb-key-label").closest(".key-row").innerText'), /required.*Trakt.*AniList/i);
  assert.equal(await browser.evaluate('document.querySelector(".key-storage-note").innerText'),
    'API keys and the GitHub token are plain text in Dropbox’s settings.csv.');

  for (const [width, height] of [[320,740], [390,844], [900,800], [1440,900]]) {
    await t.test(width + 'px layout and keyboard navigation', async () => {
      await browser.send('Emulation.setDeviceMetricsOverride', {width,height,deviceScaleFactor:1,mobile:width < 900});
      const theme = width === 390 || width === 1440 ? 'light' : 'dark';
      await browser.click('.appearance-options input[value="' + theme + '"]');
      await browser.waitFor('document.documentElement.dataset.theme === ' + JSON.stringify(theme));
      const layout = await browser.evaluate('(' + measureSettings.toString() + ')()');
      assert.deepEqual(layout.tileNames, services);
      assert.ok(layout.tileGaps.every(gap => gap > 0 && Math.abs(gap-layout.tileGaps[0]) < 1),
        'Service tile gaps differ at '+width+'px: '+layout.tileGaps.join(', '));
      assert.deepEqual(layout.importNames, imports);
      assert.ok(layout.importsNext && layout.stacked, 'Imports must follow the ordered tiles on screen and in the DOM');
      assert.ok(layout.withinPage && layout.visibleTargets, 'All tiles and import targets must fit the viewport');
      assert.ok(layout.actionsFit, 'Buttons in each tile must be visible side by side or wrap without overlap');
      assert.ok(layout.dropboxGaps.length >= (width === 1440 ? 4 : 1));
      assert.ok(Math.min(...layout.dropboxGaps) > 0 && Math.max(...layout.dropboxGaps) - Math.min(...layout.dropboxGaps) < 1,
        'Adjacent Dropbox controls should have the same gap, including Sign out and Back up now: '+layout.dropboxGaps.join(', '));
      assert.equal(layout.signOutFill, layout.syncFill, 'Sign out uses the same button surface as Sync now');
      assert.notEqual(layout.signOutFill, layout.tileFill);
      if (width >= 900) assert.equal(layout.storageNoteLines, 1, 'Desktop storage note fits on one line');
      else assert.ok(layout.storageNoteLines > 1, 'The storage note wraps on narrow phones');
      if (width === 900) {
        const fits = await browser.evaluate(`(() => {
          const note = document.querySelector('.key-storage-note');
          note.style.fontFamily = 'Verdana, sans-serif';
          try {
            return note.offsetHeight < 1.5 * parseFloat(getComputedStyle(note).lineHeight)
              && note.scrollWidth <= note.clientWidth + 1;
          } finally {
            note.style.removeProperty('font-family');
          }
        })()`);
        assert.ok(fits, 'The full note fits at the desktop breakpoint with a wider system font');
      }
      assert.equal(layout.about, false);
      assert.ok(!layout.headings.includes('about') && layout.headings.includes('settings'));
      assert.equal(layout.update, 'Check for update');
      assert.ok(layout.gap >= 4 && layout.gap <= 20, 'Expected a small visible gap above Check for update, got ' + layout.gap);
      await tabThroughSettings(browser);
      assert.ok(!(await browser.evaluate('document.querySelector("#tmdb-key-label").closest(".key-row").innerText.includes("Credits")')));
      await browser.evaluate('document.querySelector("[data-help]").focus()');
      await browser.press('Enter');
      await browser.waitFor('document.querySelector("dialog[open] .steps")');
      assert.doesNotMatch(await browser.evaluate('document.querySelector("dialog[open]").innerText'), /Credits|endorsed or certified/);
      await browser.press('Escape');
      await browser.waitFor('!document.querySelector("dialog[open]") && document.activeElement.matches("[data-help]")');
      await browser.evaluate('document.querySelector(".source-credits summary").focus()');
      await browser.press('Enter');
      assert.match(await browser.evaluate('document.querySelector(".source-credits[open]").innerText'), /not endorsed or certified by TMDB/);
      await browser.press('Enter');
    });
  }
  for (const touch of [false,true]) {
    await t.test((touch ? 'Touch' : 'Mouse') + ' outside each help sheet dismisses it and restores focus', async () => {
      await browser.send('Emulation.setDeviceMetricsOverride', {width:touch ? 390 : 1440,height:touch ? 844 : 900,deviceScaleFactor:1,mobile:touch});
      await browser.send('Emulation.setTouchEmulationEnabled', {enabled:touch, maxTouchPoints:1});
      async function point(position) {
        if (touch) {
          await browser.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[position]});
          await browser.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
        } else {
          const click = {...position,button:'left',clickCount:1};
          await browser.send('Input.dispatchMouseEvent',{type:'mousePressed',...click});
          await browser.send('Input.dispatchMouseEvent',{type:'mouseReleased',...click});
        }
      }
      for (const [route, selectors] of [
        ['settings',['[data-dropbox-help]','[data-help]','[data-mdblist-help]']],
        ['imdb-ratings',['[data-imdb-help=omdb]','[data-imdb-help=github]']],
        ['mal-scores',['[data-mal-help=github]']],
      ]) {
        await browser.navigate(origin+'/tracker/#/'+route);
        for (const selector of selectors) {
          const trigger = 'document.querySelector('+JSON.stringify(selector)+')';
          await browser.waitFor(trigger+'?.matches(":enabled")');
          // Measure inside the opening tap, before even a cached dynamic import can settle.
          const heading = await browser.evaluate(`(() => {
            ${trigger}.click();
            return document.querySelector("dialog:modal h2").getBoundingClientRect().toJSON();
          })()`);
          if (selector.endsWith('=github]')) {
            await browser.waitFor('document.querySelector("dialog:modal .job-file-copy button:enabled")');
            const ready = await browser.evaluate('document.querySelector("dialog:modal h2").getBoundingClientRect().top');
            assert.ok(Math.abs(heading.top-ready)<1,route+' help moved when Copy became available');
          }
          await point({x:heading.left + 5, y:heading.top + 5});
          assert.equal(await browser.evaluate('Boolean(document.querySelector("dialog:modal"))'),true,selector+' should stay open when its contents are tapped');
          await point({x:3,y:3});
          await browser.waitFor('!document.querySelector("dialog:modal") && document.activeElement.matches('+JSON.stringify(selector)+')');
        }
      }
    });
  }
  await browser.navigate(url);
  await browser.waitFor(ready);
  for (const source of ['trakt', 'anilist']) {
    await browser.click('.settings-imports a[href="#/' + source + '-import"]');
    await browser.waitFor('document.querySelector("[data-block]")?.innerText.includes("Add a TMDB key")');
    assert.equal(await browser.evaluate('document.querySelector("input[type=file]").disabled'), true);
    await browser.click('[data-settings]');
    await browser.waitFor('document.activeElement.id === "tmdb-key-label"');
  }
  await browser.click('[data-edit]');
  await browser.evaluate('document.querySelector("#tmdb-input").value = "fictional-offline-key"');
  await browser.click('dialog[open] button[type=submit]');
  await browser.waitFor('!document.querySelector("dialog[open]") && document.querySelector("#tmdb-key-label").closest(".key-row").innerText.includes("Saved in Dropbox")');
  for (const source of ['trakt', 'anilist']) {
    const link = '.settings-imports a[href="#/' + source + '-import"]';
    await browser.evaluate('document.querySelector(' + JSON.stringify(link) + ').focus()');
    await browser.press('Enter');
    await browser.waitFor('document.querySelector("input[type=file]")?.matches(":enabled") && document.querySelector("input[type=file]").getClientRects().length > 0');
    await browser.evaluate('history.back()');
    await browser.waitFor(ready);
  }
});
