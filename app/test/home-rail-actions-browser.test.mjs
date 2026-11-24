import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {writeCsv} from '../dist/csv.js';
import {createRelease} from '../package-release.mjs';
import {openChromium} from './offline-chromium.mjs';
import {linkFixture,offlineProviders} from './offline-providers.mjs';
import {listen,stop} from './offline-site.mjs';
import {releaseServer,unpack} from './release-site.mjs';

async function record() {
  const {openDeviceStore} = await import('/storage.js');
  const store = await openDeviceStore();
  try {
    const {watched,lists} = await store.overviewRows();
    return {counts:watched.map(row=>[row.season,row.episode,row.times_watched]),lists:lists.map(row=>row.list)};
  } finally { store.close(); }
}

for (const width of [1440,390]) {
  test('Home More to watch offers Complete and Drop with Undo at '+width+'px', {timeout:60000}, async t => {
    const {bytes} = await createRelease(new URL('../dist/',import.meta.url));
    const server = releaseServer(await unpack(bytes)), origin = 'http://127.0.0.1:'+await listen(server);
    const profile = await mkdtemp(join(tmpdir(),'csvtv-home-count-')), cloud = offlineProviders(origin);
    let browser;
    t.after(async () => {
      try { await browser?.close(); }
      finally { await stop(server); await rm(profile,{recursive:true,force:true,maxRetries:6,retryDelay:150}); }
    });
    const phone = width === 390, show = 'The Listening House';
    const watched = [{show,show_id:45,season:1,episode:1,title:'Recording 1',times_watched:3,episode_id:45011}];
    await cloud.settings({tmdb_key:'fictional-offline-key'});
    await cloud.upload('watched.csv',writeCsv('watched',watched));
    browser = await openChromium(profile,cloud.respond);
    await browser.send('Emulation.setDeviceMetricsOverride',{width,height:850,deviceScaleFactor:1,mobile:phone});
    if (phone) await browser.send('Emulation.setTouchEmulationEnabled',{enabled:true});
    await linkFixture(browser,origin,'/');
    await browser.navigate(origin+'/#/home');
    const link = '[data-more] a[href="#/show/45"]', control = '[data-more] button[aria-haspopup='+(phone?'dialog':'menu')+']';
    const query = css => 'document.querySelector('+JSON.stringify(css)+')';
    const menu = '[role=menu]', sheet = 'dialog[open]';
    await browser.waitFor(query(link)+' && '+query('[data-more]')+'.textContent.includes("1 of 2")','the partial show on Home');
    async function pointAt(selector,shouldScroll) {
      return browser.evaluate('('+(function(selector,shouldScroll) {
        const button = document.querySelector(selector);
        if (shouldScroll) button.scrollIntoView({block:'center'});
        const {x,y,width,height} = button.getBoundingClientRect();
        const point = {x:x+width/2,y:y+height/2};
        if (!button.contains(document.elementFromPoint(point.x,point.y))) throw Error('Clipped or covered control: '+selector);
        return point;
      }).toString()+')('+JSON.stringify(selector)+','+shouldScroll+')');
    }
    async function mouseClick(point) {
      for (const type of ['mousePressed','mouseReleased']) await browser.send('Input.dispatchMouseEvent',{type,...point,button:'left',clickCount:1});
    }
    async function openCount() {
      await browser.waitFor(query(control)+'?.textContent.trim() === "1 of 2"');
      const point = await pointAt(control,true);
      if (phone) {
        await browser.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point]});
        await browser.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
      } else await mouseClick(point);
      await browser.waitFor(query(phone?sheet:menu),'Home count actions');
      const commands = phone ? 'dialog[open] .watch-sheet-action span' : '[role=menu] [role=menuitem]';
      assert.deepEqual(await browser.evaluate('Array.from(document.querySelectorAll('+JSON.stringify(commands)+'),e=>e.textContent)'),['Complete','Drop']);
    }
    await openCount();
    if (!phone) {
      assert.ok(await browser.evaluate('document.activeElement === '+query(menu)));
      assert.deepEqual(await browser.evaluate('Array.from(document.querySelectorAll("[role=menuitem]"),b=>getComputedStyle(b).backgroundColor)'),
        ['rgba(0, 0, 0, 0)','rgba(0, 0, 0, 0)']);
    }
    await browser.press('Escape');
    await browser.waitFor('!'+query(menu)+' && !'+query(sheet)+' && document.activeElement === '+query(control));
    for (const action of ['Complete','Drop']) {
      if (phone) {
        await openCount();
        await browser.click('dialog[open] .watch-sheet-action:'+(action==='Complete'?'first-of-type':'nth-of-type(2)'));
      } else if (action === 'Complete') {
        await browser.evaluate(query(control)+'.focus()');
        await browser.press('ArrowDown');
        assert.equal(await browser.evaluate('document.activeElement.textContent'),action);
        await browser.press('Enter');
      } else {
        await openCount();
        await mouseClick(await pointAt('[role=menu] [role=menuitem]:last-child',false));
      }
      await browser.waitFor('!'+query(link)+' && '+query('.undo-bar:not([hidden])')+' && '+query('#more-heading'),
        action+' removes the card while keeping Home open');
      const updated = await browser.evaluate('('+record+')()');
      assert.deepEqual(updated.counts,action==='Complete'?[[1,1,3],[1,2,1]]:[[1,1,3]]);
      assert.equal(updated.lists.includes('Dropped'),action==='Drop');
      await browser.click('.undo-bar [data-undo]');
      await browser.waitFor(query(control)+'?.textContent.trim() === "1 of 2"');
      assert.deepEqual(await browser.evaluate('('+record+')()'),{counts:[[1,1,3]],lists:[]});
    }
    assert.equal(await browser.evaluate(query(control)+'.closest("a") === null'),true);
    await browser.click(link);
    await browser.waitFor('location.hash === "#/show/45" && '+query('.show-page'));
    await browser.evaluate('history.back()');
    await browser.waitFor(query(control));
    await browser.click('#more-heading a');
    await browser.waitFor('location.hash === "#/watchlist/more-to-watch"');
  });
}
