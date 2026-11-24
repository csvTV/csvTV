import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {createRelease} from '../package-release.mjs';
import {openChromium,until} from './offline-chromium.mjs';
import {linkFixture,offlineProviders} from './offline-providers.mjs';
import {listen,stop} from './offline-site.mjs';
import {seedRatedLibrary} from './populated-navigation-fixture.mjs';
import {releaseServer,unpack} from './release-site.mjs';

async function delayLibraryRead(holdSeasons) {
  const {DeviceStore} = await import('/storage.js');
  const method = holdSeasons ? 'tmdbEntries' : 'overviewRows';
  const read = DeviceStore.prototype[method];
  const gate = Promise.withResolvers();
  window.releaseLibrary = gate.resolve;
  window.libraryHeld = false;
  if (!holdSeasons) {
    const preference = DeviceStore.prototype.devicePreference;
    window.librarySortRead = false;
    DeviceStore.prototype.devicePreference = async function(key) {
      const state = await preference.call(this,key);
      if (key === 'librarySort') {
        DeviceStore.prototype.devicePreference = preference;
        requestAnimationFrame(() => { window.librarySortRead = true; });
      }
      return state;
    };
  }
  DeviceStore.prototype[method] = async function(...args) {
    if (document.querySelector('.library-screen') && (!holdSeasons || args[0].some(key => key.includes('/season/')))) {
      window.libraryHeld = true;
      await gate.promise;
      DeviceStore.prototype[method] = read;
    }
    return read.apply(this,args);
  };
}

function locateCard(index) {
  const link = document.querySelectorAll('.library-grid a')[index];
  link.scrollIntoView({block:'center',behavior:'instant'});
  link.focus({preventScroll:true});
  const {left,top,width,height} = link.getBoundingClientRect();
  return {id:link.dataset.showId,top,scroll:scrollY,point:{x:left+width/2,y:top+height/3}};
}

test('A read-only Library sort survives writer acquisition and Back without changing the saved sort', {timeout:90000}, async t => {
  const {bytes} = await createRelease(new URL('../dist/',import.meta.url));
  const server = releaseServer(await unpack(bytes)), origin = 'http://127.0.0.1:'+await listen(server);
  const providers = offlineProviders(origin), profile = await mkdtemp(join(tmpdir(),'csvtv-reader-sort-'));
  let browser;
  t.after(async () => { try { await browser?.close(); }
    finally { await stop(server); await rm(profile,{recursive:true,force:true,maxRetries:6,retryDelay:150}); } });
  await providers.settings({tmdb_key:'fictional-offline-key',library_sort:'episodes'});
  browser = await openChromium(profile,providers.respond);
  await linkFixture(browser,origin,'/');
  await browser.evaluate(`(async()=>{
    const {openDeviceStore}=await import('/storage.js'),store=await openDeviceStore();
    try {
      const {revision}=await store.whenWriter();
      await store.commit(revision,{put:{watched:[{show_id:45,show:'The Listening House',season:1,episode:1,
        episode_id:45011,title:'Recording 1',times_watched:1}]}});
      await store.selectDisplayPreference('librarySort','episodes');
    }
    finally { await store.closeForUpdate(); }
  })()`);
  // Hold the real writer lock across app startup, then release it while the same Library remains open.
  const {identifier} = await browser.send('Page.addScriptToEvaluateOnNewDocument',{source:`
    if (location.pathname==='/') {
      const gate=Promise.withResolvers();
      window.releaseLibraryWriter=gate.resolve;
      void navigator.locks.request('csvTV/writer/csvTV',()=>gate.promise);
    }`});
  await browser.navigate(origin+'/#/library');
  const sort = 'document.querySelector(\'select[aria-label="Sort"]\')', card = '.library-grid a[data-show-id="45"]';
  const savedSort = () => Buffer.from(providers.files.get('/settings.csv').bytes).toString('utf8').split(/\r?\n/).find(s=>s.startsWith('library_sort,'));
  const choose = value => browser.evaluate(`{const s=${sort};s.value=${JSON.stringify(value)};s.dispatchEvent(new Event('change',{bubbles:true}));}`);
  await browser.waitFor(sort+'?.value==="episodes" && document.querySelector(".library-status-trigger:disabled")');
  await choose('rating');
  assert.equal(await browser.evaluate(sort+'.value'),'rating');
  await browser.evaluate('window.releaseLibraryWriter()');
  await browser.send('Page.removeScriptToEvaluateOnNewDocument',{identifier});
  const settled = 'document.querySelector(".sync-state")?.dataset.synced==="true" && !!document.querySelector(".library-status-trigger:not(:disabled)")';
  await browser.waitFor(settled,'writer lock and first Dropbox sync');
  assert.equal(await browser.evaluate(sort+'.value'),'rating','Gaining write access should keep the current Library order');
  assert.equal(savedSort(),'library_sort,episodes','A reader choice was uploaded when the writer lock changed');
  await browser.click(card);
  await browser.waitFor('document.querySelector(".show-page")');
  await browser.evaluate('history.back()');
  await browser.waitFor(settled);
  assert.equal(await browser.evaluate(sort+'.value'),'rating','Back lost the reader choice');
  await browser.click(card);
  await browser.waitFor('document.querySelector(".show-page")');
  await browser.click('.app-sidebar [data-destination="library"]');
  await browser.waitFor(settled);
  assert.equal(await browser.evaluate(sort+'.value'),'episodes','A fresh Library visit inherited the read-only sort');
  await choose('rating');
  await browser.click('.app-sidebar [data-destination="settings"]');
  await browser.waitFor('document.querySelector("[data-sync]:not(:disabled)")');
  await browser.click('[data-sync]');
  await until(()=>savedSort()==='library_sort,rating','a later explicit writer choice uploads to Dropbox',30000);
});

for (const width of [1440,390]) {
  test('Browser Back restores the Library card after a delayed read at '+width+'px', {timeout:60000}, async t => {
    const {bytes} = await createRelease(new URL('../dist/',import.meta.url));
    const server = releaseServer(await unpack(bytes)), origin = 'http://127.0.0.1:'+await listen(server);
    const providers = offlineProviders(origin), profile = await mkdtemp(join(tmpdir(),'csvtv-library-history-'));
    let browser;
    t.after(async () => { try { await browser?.close(); }
      finally { await stop(server); await rm(profile,{recursive:true,force:true,maxRetries:6,retryDelay:150}); }
    });
    const phone = width === 390;
    const libraryTab = (phone ? '.phone-nav' : '.app-sidebar')+' [data-destination=library]';
    providers.state.online = false;
    browser = await openChromium(profile,providers.respond);
    await browser.send('Emulation.setDeviceMetricsOverride',{width,height:800,deviceScaleFactor:1,mobile:phone});
    if (phone) await browser.send('Emulation.setTouchEmulationEnabled',{enabled:true});
    await linkFixture(browser,origin,'/');
    await browser.evaluate('('+seedRatedLibrary+')({showCount:72})');
    await browser.navigate(origin+'/#/library');
    const fullGrid = "document.querySelectorAll('.library-grid li').length === 72";
    await browser.waitFor(fullGrid+" && document.querySelector('.library-status-trigger:not(:disabled)') && document.querySelector('.library-status-caption')?.textContent === 'Complete'");
    await browser.evaluate(`(() => {
      const input = document.querySelector('.library-screen input[type=search]');
      input.value = 'Station'; input.dispatchEvent(new Event('input',{bubbles:true}));
      for (const [selector,value] of [['select[aria-label=Sort]','rating'],['[data-filter=progress]','complete']]) {
        const select = document.querySelector(selector);
        select.value = value; select.dispatchEvent(new Event('change',{bubbles:true}));
      }
    })()`);
    await browser.waitFor(fullGrid+" && document.querySelector('[data-filter=progress]').value === 'complete'");
    await browser.waitFor(`(async () => {
      const {openDeviceStore} = await import('/storage.js'), reader = await openDeviceStore();
      try { return (await reader.devicePreference('librarySort')).preference === 'rating'; }
      finally { reader.close(); }
    })()`,'the selected sort saved before leaving Library');

    async function openCard(index) {
      const previous = await browser.evaluate('('+locateCard+')('+index+')');
      assert.ok(previous.scroll>400,'The card needs to start well below the first screen');
      if (phone) {
        await browser.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[previous.point]});
        await browser.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
      } else await browser.press('Enter');
      await browser.waitFor("location.hash === '#/show/"+previous.id+"' && document.querySelector('.show-page') && scrollY === 0");
      return previous;
    }
    let warmReturns = 0;
    async function returnToCard(previous,card) {
      await browser.evaluate('('+delayLibraryRead+')(false)');
      await browser.evaluate('history.back()');
      await browser.waitFor('window.libraryHeld && window.librarySortRead','Library checking the returning record and reading the saved sort');
      const count = await browser.evaluate("document.querySelectorAll('.library-grid li').length");
      if (count) {
        assert.equal(count,72);
        assert.ok(await browser.evaluate('Math.abs('+card+'.getBoundingClientRect().top - '+previous.top+') <= 2'),
          'The verified preview moved the reopened card');
        warmReturns++;
      }
      await browser.evaluate('window.releaseLibrary()');
      await browser.waitFor(fullGrid);
      await browser.waitFor('Math.abs('+card+'.getBoundingClientRect().top - '+previous.top+') <= 2',
        'the previously opened card at its original viewport position');
    }
    for (const index of [46,29]) {
      const previous = await openCard(index);
      const card = "document.querySelector('.library-grid a[data-show-id=\""+previous.id+"\"]')";
      await returnToCard(previous,card);
      if (index === 46) {
        await browser.evaluate('history.forward()');
        await browser.waitFor("location.hash === '#/show/"+previous.id+"' && document.querySelector('.show-page')");
        await returnToCard(previous,card);
      }
      assert.equal(await browser.evaluate("document.querySelector('.library-screen input').value"),'Station');
      assert.equal(await browser.evaluate("document.querySelector('select[aria-label=Sort]').value"),'rating');
      assert.equal(await browser.evaluate("document.querySelector('[data-filter=progress]').value"),'complete');
      if (!phone) {
        await browser.press('Tab');
        assert.ok(await browser.evaluate(`(() => {
          const item = ${card}.closest('li'), focused = document.activeElement.closest('li');
          return focused === item || focused === item.nextElementSibling;
        })()`),'Tab after Back should continue at the returned card');
      }
    }

    assert.ok(warmReturns > 0,'No repeat visit showed the verified Library while the full watch read was held');
    await browser.evaluate(`(() => {
      const filter = document.querySelector('[data-filter=progress]');
      filter.value = 'all'; filter.dispatchEvent(new Event('change',{bubbles:true}));
    })()`);
    await openCard(48);
    await browser.evaluate('('+delayLibraryRead+')(true)');
    await browser.evaluate('history.back()');
    await browser.waitFor('window.libraryHeld && scrollY > 400 && '+fullGrid,
      'the restored Library while episode details are still pending');
    await browser.press('Home');
    await browser.waitFor('scrollY === 0','the user moving to the top');
    await browser.evaluate('window.releaseLibrary()');
    await browser.waitFor('document.querySelector(".library-status-caption")?.textContent === "Complete"');
    assert.equal(await browser.evaluate('scrollY'),0,'A late metadata render should honor the user’s scroll');

    await openCard(48);
    await browser.click(libraryTab);
    await browser.waitFor(fullGrid);
    assert.deepEqual(await browser.evaluate("[scrollY,document.querySelector('.library-screen input').value]"),[0,'']);
    if (phone) {
      const previous = await browser.evaluate(`(async () => {
        const card=document.querySelectorAll('.library-grid li')[44];
        scrollBy(0,card.getBoundingClientRect().top-610);
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        const r=card.getBoundingClientRect(), x=r.left+r.width/2, y=r.top+12;
        return {id:card.dataset.libraryShow,point:{x,y},reachable:card.contains(document.elementFromPoint(x,y))};
      })()`);
      assert.ok(previous.reachable);
      await browser.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[previous.point]});
      await browser.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
      await browser.waitFor('location.hash==="#/show/'+previous.id+'" && document.querySelector(".show-page")');
      await browser.send('Emulation.setDeviceMetricsOverride',{width:800,height:390,deviceScaleFactor:1,mobile:true,
        screenOrientation:{type:'landscapePrimary',angle:90}});
      await browser.evaluate('history.back()');
      await browser.waitFor(fullGrid);
      await browser.waitFor(`(() => {
        const r=document.querySelector('[data-library-show="${previous.id}"]').getBoundingClientRect();
        const bottom=document.querySelector('.phone-nav').getBoundingClientRect().top;
        return r.top>=0 && r.bottom<=bottom+1;
      })()`,'the previously opened card is visible above the navigation after rotation');
    }
  });
}
