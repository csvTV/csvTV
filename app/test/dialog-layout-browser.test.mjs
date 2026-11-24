import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {openChromium} from './offline-chromium.mjs';
import {linkFixture, offlineProviders} from './offline-providers.mjs';
import {listen, stop, testSite} from './offline-site.mjs';

async function openLongSeasonReview() {
  const {DropboxDialogs}=await import('./dropbox-dialogs.js');
  const episodes=[1,2].map(episode=>({show_id:41,show:'FictionalUnbrokenShowTitle'.repeat(5),season:1,episode,
    title:'FictionalUnbrokenEpisodeTitle'.repeat(4),key:'fictional-'+episode,before:1,mine:2,theirs:2,
    deliveryTotals:{one:'2',two:'3'}}));
  void new DropboxDialogs(document).doubleMarks({status:'double-mark',baseToken:'fixture',delivery:true,episodes});
}

function measureFooter() {
  const dialog = document.querySelector('dialog:modal');
  const footer = dialog.querySelector('.actions, .watch-sheet-cancel');
  const visible = element => element.getBoundingClientRect().height > 0;
  const controls = footer.matches('button') ? [footer] : [...footer.children].filter(visible);
  const boxes = controls.map(control => control.getBoundingClientRect());
  const scale = Number(getComputedStyle(document.documentElement).getPropertyValue('--app-scale'));
  let previous;
  for (let node = footer; node !== dialog && !previous; node = node.parentElement) {
    previous = node.previousElementSibling;
    while (previous && !visible(previous)) previous = previous.previousElementSibling;
  }
  const bounds = dialog.getBoundingClientRect();
  return {
    overflow: dialog.scrollWidth > dialog.clientWidth + 1 || bounds.left < -1 || bounds.right > innerWidth + 1,
    targetsFit: boxes.every(box => box.height / scale >= 43.5 && box.left >= bounds.left && box.right <= bounds.right),
    topGap: previous ? (boxes[0].top - previous.getBoundingClientRect().bottom) / scale : null,
    gaps: boxes.slice(1).map((box, i) => {
      const before = boxes[i];
      return (Math.abs(box.top - before.top) < 1 ? box.left - before.right : box.top - before.bottom) / scale;
    }),
  };
}

test('dialog footers leave room between decisions, including wrapped and offline recovery actions', {timeout:90000}, async t => {
  const {server} = await testSite();
  const origin = 'http://127.0.0.1:' + await listen(server);
  const profile = await mkdtemp(join(tmpdir(), 'csvtv-dialog-layout-'));
  const providers = offlineProviders(origin);
  let browser;
  t.after(async () => {
    try { await browser?.close(); }
    finally { await stop(server); await rm(profile, {recursive:true,force:true,maxRetries:5,retryDelay:150}); }
  });
  await providers.settings({tmdb_key:'fictional-offline-key'});
  await providers.upload('watched.csv','show_id,show,season,episode,title,times_watched,episode_id\r\n45,The Listening House,1,1,Recording 1,1,45011\r\n');
  await providers.upload('ratings.csv','show_id,show,rating\r\n45,The Listening House,8\r\n');
  await providers.upload('lists.csv','list,show_id,show\r\nFavourites,45,The Listening House\r\n');
  browser = await openChromium(profile, providers.respond);
  await linkFixture(browser, origin);
  const route = page => browser.navigate(origin + '/tracker/#/' + page);
  async function check(selector, label) {
    await browser.waitFor('document.querySelector(' + JSON.stringify('dialog:modal ' + selector) + ')');
    const layout = await browser.evaluate('(' + measureFooter.toString() + ')()');
    assert.equal(layout.overflow, false, label + ' overflows the viewport');
    assert.equal(layout.targetsFit, true, label + ' action bounds');
    assert.ok(layout.topGap >= 23.5, label + ' content-to-actions gap ' + layout.topGap);
    assert.ok(layout.gaps.every(gap => gap >= 11.5), label + ' button gaps ' + layout.gaps);
  }
  async function close() {
    await browser.press('Escape');
    await browser.waitFor('!document.querySelector("dialog:modal")');
  }
  for (const [width, theme] of [[320,'dark'],[390,'light'],[1440,'light']]) {
    await t.test(width + 'px, ' + theme, async () => {
      await browser.send('Emulation.setDeviceMetricsOverride', {width,height:740,deviceScaleFactor:1,mobile:width < 900});
      await route('settings');
      await browser.click('.appearance-options input[value="' + theme + '"]');
      await browser.waitFor('document.documentElement.dataset.theme === ' + JSON.stringify(theme));
      await browser.waitFor('document.querySelector("[data-cloud-reason]")?.innerText === "Synced"');
      for (const [trigger, selector] of [
        ['[data-clear-device]','.destructive'], ['[data-edit]','form .actions'],
        ['[data-dropbox-help]','.help-actions'], ['[data-help]','.help-actions'], ['[data-mdblist-help]','.help-actions'],
      ]) {
        await browser.click(trigger);
        await check(selector, trigger);
        await close();
        assert.ok(await browser.evaluate('document.activeElement.matches(' + JSON.stringify(trigger) + ')'), trigger + ' focus');
      }
      await browser.evaluate('('+openLongSeasonReview.toString()+')()');
      await check('.delivery-season summary','Long season name');
      await browser.click('dialog:modal summary');
      await check('fieldset legend','Long episode name');
      await close();
      await browser.click('[data-clear-dropbox]');
      await check('fieldset', 'Choose Dropbox data');
      await browser.click('dialog:modal input[value=ratings]');
      await browser.click('dialog:modal .actions button:last-child');
      await check('.destructive','Confirm Dropbox clear');
      await close();
      for (const [page, selectors] of [
        ['imdb-ratings',['[data-imdb-help=omdb]','[data-imdb-help=github]']],
        ['mal-scores',['[data-mal-help=github]']],
      ]) {
        await route(page);
        for (const selector of selectors) {
          await browser.click(selector);
          await check('.help-actions', selector);
          if (selector.includes('github')) {
            const shortEndings = await browser.evaluate(`Array.from(document.querySelectorAll('dialog .help-instruction')).filter(el => {
              const range = document.createRange();
              range.selectNodeContents(el);
              const lines = [...range.getClientRects()];
              return lines.length > 1 && lines.at(-1).width < el.getBoundingClientRect().width * .4;
            }).map(el => el.textContent)`);
            assert.deepEqual(shortEndings, [], width + 'px GitHub help left a short final line');
          }
          await close();
        }
      }
      await route('show/45');
      for (const [trigger, selector] of [
        ['.show-rating','.rating-commands'], ['.show-list','.actions'], ['.show-season-count','.season-count-form'],
        ['.show-more','.watch-sheet-cancel'],
      ]) {
        await browser.click(trigger);
        await check(selector, trigger);
        await close();
      }
      await browser.click('.show-more');
      await browser.evaluate('[...document.querySelectorAll(".watch-sheet-action")].find(button => button.textContent === "Season order").click()');
      await check('.season-order-form','Season order');
      await close();
      await browser.click('.show-more');
      await browser.click('.watch-sheet-action.destructive');
      await check('[data-accept]', 'Remove watches');
      await close();
      await route('lists');
      await browser.click('.list-new');
      await check('.list-form .actions','New list');
      await close();
    });
  }
  await route('settings');
  await browser.offline(true);
  await browser.click('[data-clear-device]');
  await check('.clear-device-review .destructive','Offline device clear');
  assert.equal(await browser.evaluate('document.querySelectorAll("dialog:modal a[download]").length'),4);
  await browser.press('Tab',{shift:true});
  assert.equal(await browser.evaluate('document.activeElement.innerText'),'Clear this device');
  await browser.press('Tab');
  assert.equal(await browser.evaluate('document.activeElement.matches("a[download]")'),true);
  await close();
});
