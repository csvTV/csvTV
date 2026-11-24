import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {openChromium, until} from './offline-chromium.mjs';
import {linkFixture, offlineProviders} from './offline-providers.mjs';
import {listen, stop, testSite} from './offline-site.mjs';
import {contrastRatio} from './rendered-contrast.mjs';

async function seedPosters() {
  const {openDeviceStore} = await import('/tracker/storage.js');
  const {tmdbResourceKey} = await import('/tracker/tmdb-client.js');
  const store = await openDeviceStore();
  try {
    await store.whenWriter();
    const {session} = await store.dropboxState();
    store.connectProviderKeys(async () => { throw Error('Unexpected key write'); }, Date.now);
    await store.loadProviderKeys(session, [{setting:'tmdb_key',value:'fictional-rail-key'}], () => true);
    const titles = Array.from({length:24}, (_, i) => ({show_id:i + 1,show:'Signal ' + String(i + 1).padStart(2,'0')}));
    const watched = titles.map(t => ({...t,season:1,episode:1,title:'Opening',episode_id:t.show_id * 10,times_watched:1}));
    const lists = titles.map(({show_id}) => ({show_id:show_id+24,show:'Planned '+String(show_id).padStart(2,'0'),list:'Watchlist'}));
    lists.push({...titles[1],list:'Following upcoming'});
    await store.commit((await store.snapshot()).revision, {put:{watched,lists},
      local:{recentlyMarked:titles.slice(0,20).map(t => t.show_id), firstUseDismissed:true}});
    const entries = {}, fetchedAt = Date.now();
    for (const title of titles) {
      const id = title.show_id;
      entries[tmdbResourceKey({kind:'show',id})] = {fetchedAt,value:{...title,firstAirDate:'2015-01-01',
        status:'Ended',genres:[],keywords:[],networks:[],originCountries:[],seasons:[{season:1,episodeCount:2}],
        lastAired:{season:1,episode:2},nextAirDate:null}};
    }
    entries[tmdbResourceKey({kind:'recommendations',id:1})] = {fetchedAt,value:{page:1,totalPages:1,results:titles.slice(1)}};
    entries[tmdbResourceKey({kind:'recommendations',id:2})] = {fetchedAt,value:{page:1,totalPages:1,results:titles.slice(2,7)}};
    if (!await store.writeTmdb((await store.tmdbState()).generation,{entries})) throw Error('Could not seed poster metadata');
  } finally { await store.closeForUpdate(); }
}

test('Poster rails reach every title with desktop controls and touch and keep their place through refresh', {timeout:90000}, async t => {
  const {server} = await testSite();
  const origin = 'http://127.0.0.1:' + await listen(server);
  const profile = await mkdtemp(join(tmpdir(),'csvtv-poster-rails-'));
  let browser;
  t.after(async () => {
    try { await browser?.close(); }
    finally { await stop(server); await rm(profile,{recursive:true,force:true,maxRetries:6,retryDelay:100}); }
  });
  const providers = offlineProviders(origin);
  browser = await openChromium(profile,providers.respond);
  await linkFixture(browser,origin);
  await browser.evaluate('(' + seedPosters + ')()');

  const recent = '[data-recent] .poster-rail', watchlist = '[data-home-watchlist] .poster-rail';
  const more = '[data-more] .poster-rail', suggestions = '.show-extras .show-strip';
  async function onRail(selector, fn, ...args) {
    return browser.evaluate('(' + fn + ')(document.querySelector(' + JSON.stringify(selector) + ')' +
      args.map(arg => ',' + JSON.stringify(arg)).join('') + ')');
  }
  const offset = list => list.scrollLeft;
  const wheelCanceled = (list,init) => !list.dispatchEvent(new WheelEvent('wheel',{...init,cancelable:true,bubbles:true}));
  async function wheel(selector,deltaX,deltaY) {
    const point = await onRail(selector,async list => {
      await document.fonts.ready;
      list.scrollIntoView({block:'center',behavior:'instant'});
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      const box = list.getBoundingClientRect();
      const x = box.left + 22, y = box.top + 24;
      if (!list.contains(document.elementFromPoint(x,y))) throw Error('Wheel target is outside the rail');
      list.testWheelHandled = new Promise(resolve => {
        document.addEventListener('wheel',event => resolve(list.contains(event.target) && event.defaultPrevented),{once:true});
      });
      return {x,y,scroll:scrollY,top:box.top};
    });
    await browser.send('Input.dispatchMouseEvent',{type:'mouseWheel',x:point.x,y:point.y,deltaX,deltaY});
    const result = await onRail(selector,async list => {
      const handled = await list.testWheelHandled;
      delete list.testWheelHandled;
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      return {handled,scroll:scrollY,top:list.getBoundingClientRect().top};
    });
    assert.equal(result.handled,true,selector+' must handle the native vertical wheel event');
    // Inserting a sync report above the rail can change scrollY while Chromium keeps the rail anchored in the viewport.
    assert.ok(Math.abs(result.scroll - point.scroll) <= 1 || Math.abs(result.top - point.top) <= 1,
      selector+' wheel moved the page and displaced the rail on screen');
  }
  const visibleEnd = list => {
    const box = list.getBoundingClientRect(), last = [...list.querySelectorAll('a')].at(-1).getBoundingClientRect();
    return last.right <= box.right + 2 && last.left >= box.left - 2;
  };
  const boundary = (selector, direction) => onRail(selector,(list,dir) => {
    const button = list.closest('section').querySelector('[data-rail-' + dir + ']');
    return button && (button.disabled || button.getAttribute('aria-disabled') === 'true');
  },direction);
  async function refreshMore() {
    const before = await onRail(more,offset);
    await browser.evaluate(`new Promise((resolve,reject) => {
      const observer = new MutationObserver(() => {clearTimeout(timer);observer.disconnect();resolve()});
      const timer = setTimeout(()=>{observer.disconnect();reject(Error('More to watch did not finish refreshing'));},5000);
      // The full Home refresh updates this caption after it has reconciled the rail.
      observer.observe(document.querySelector('[data-more-count]'),{childList:true,subtree:true,characterData:true});
      dispatchEvent(new Event('offline'));
    })`);
    const after = await onRail(more,offset);
    assert.ok(Math.abs(after - before) <= 1, 'Home refresh moved More to watch from ' + before + ' to ' + after);
  }
  async function pointerClick(selector, direction, touch = false) {
    const point = await onRail(selector,(list,dir) => {
      const button = list.closest('section').querySelector('[data-rail-' + dir + ']');
      if (!button) return null;
      button.scrollIntoView({block:'center'});
      const box = button.getBoundingClientRect(), x = box.left + box.width / 2, y = box.top + box.height / 2;
      return box.width && box.height && button.contains(document.elementFromPoint(x,y)) ? {x,y} : null;
    },direction);
    assert.ok(point, selector + ' is missing a visible, clickable ' + direction + ' button');
    if (touch) {
      await browser.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point]});
      await browser.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    } else {
      for (const type of ['mousePressed','mouseReleased']) {
        await browser.send('Input.dispatchMouseEvent',{type,...point,button:'left',clickCount:1});
      }
    }
  }
  async function exerciseRails(width) {
    const touch = width === 390;
    await browser.send('Emulation.setDeviceMetricsOverride',{width,height:850,deviceScaleFactor:1,mobile:touch});
    if (touch) await browser.send('Emulation.setTouchEmulationEnabled',{enabled:true});
    await browser.navigate(origin + '/tracker/#/home');
    for (const [selector,count] of [[more,24],[recent,8],[watchlist,24],[suggestions,23]]) {
      if (selector === suggestions) await browser.navigate(origin + '/tracker/#/show/1');
      await until(() => onRail(selector,(list,n) => list?.querySelectorAll('a').length === n,count), selector + ' populated');
      if (selector === suggestions) {
        const caption = await onRail(selector,list => {
          const root = document.documentElement, originalTheme = root.dataset.theme;
          try {
            root.dataset.theme = 'light';
            const title = list.querySelector('.show-recommendation strong');
            let surface = title;
            while (surface && getComputedStyle(surface).backgroundColor === 'rgba(0, 0, 0, 0)') surface = surface.parentElement;
            const rgb = value => value.match(/[\d.]+/g).map(Number);
            return {weight:getComputedStyle(title).fontWeight,color:rgb(getComputedStyle(title).color),
              background:rgb(getComputedStyle(surface).backgroundColor)};
          } finally {
            if (originalTheme === undefined) delete root.dataset.theme;
            else root.dataset.theme = originalTheme;
          }
        });
        const contrast = contrastRatio(caption.color,caption.background);
        assert.equal(caption.weight,'400','Light-mode recommendation titles should have regular weight');
        assert.ok(contrast >= 4.5,'Light-mode recommendation title contrast was ' + contrast.toFixed(2));
        t.diagnostic(width + 'px light-mode recommendation contrast ' + contrast.toFixed(2) + ':1');
      }
      assert.ok(await browser.evaluate('document.documentElement.scrollWidth <= innerWidth'), selector + ' overflowed the page');
      if (selector === recent && !touch && !await onRail(selector,list => list.scrollWidth > list.clientWidth)) {
        assert.ok(await onRail(selector,visibleEnd), 'All eight recent posters should fit when the arrows are hidden');
        continue;
      }
      assert.ok(await onRail(selector,list => list.scrollWidth > list.clientWidth), selector + ' should scroll within the page');
      if (selector === more && !touch) {
        await onRail(selector,list => list.querySelectorAll('a')[14].focus());
        await until(async () => await onRail(selector,offset) > 200, 'focus reveals a later poster');
        await refreshMore();
        assert.ok(await onRail(selector,list => list.querySelectorAll('a')[14] === document.activeElement),
          'Home refresh lost the focused poster');
        await onRail(selector,list => list.querySelector('a').focus());
        await until(() => boundary(selector,'prev'), 'first poster restores the start of More to watch');
      }
      if (touch) {
        const {x,y} = await onRail(selector,list => {
          list.scrollIntoView({block:'center'});
          const box = list.getBoundingClientRect();
          return {x:box.right - 24,y:box.top + 36};
        });
        await browser.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
        for (let delta = 30; delta <= 210; delta += 30) {
          await browser.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x - delta,y}]});
        }
        await browser.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
        await until(async () => (await onRail(selector,offset)) > 30,selector + ' moves on touch swipe');
      } else {
        assert.equal(await boundary(selector,'prev'),true,selector + ' signals the beginning');
        assert.equal(await onRail(selector,wheelCanceled,{deltaY:-100}),false, 'Wheel up is free at the start');
        await wheel(selector,0,100);
        await until(async () => await onRail(selector,offset) > 10, 'Vertical mouse wheel advances '+selector);
        for (const flags of [{deltaX:12},{ctrlKey:true},{shiftKey:true}]) {
          assert.equal(await onRail(selector,wheelCanceled,{...flags,deltaY:20}),false,'A horizontal or modified gesture was captured');
        }
      }
      for (let click = 0; click < count && !await boundary(selector,'next'); click++) {
        const before = await onRail(selector,offset);
        await pointerClick(selector,'next',touch);
        await until(async () => await onRail(selector,offset) > before || await boundary(selector,'next'),
          selector + ' advances toward its last title');
      }
      assert.ok(await onRail(selector,visibleEnd), selector + ' last poster is fully visible');
      assert.equal(await boundary(selector,'next'),true,selector + ' signals the end');
      if (!touch) assert.equal(await onRail(selector,wheelCanceled,{deltaY:100}),false,'Wheel down is free at the end');
      if (selector === more) await refreshMore();
      if (!touch) {
        const before = await onRail(selector,offset);
        await pointerClick(selector,'prev');
        await until(async () => await onRail(selector,offset) < before,selector + ' goes back with the mouse');
      }
      await onRail(selector,list => [...list.querySelectorAll('a')].at(-2).focus());
      await browser.press('Tab');
      if (selector === more) {
        assert.ok(await onRail(selector,list => document.activeElement ===
          [...list.querySelectorAll('li')].at(-2).querySelector('button[aria-haspopup]')),
          'Tab reaches the matching poster’s episode count');
        await browser.press('Tab');
      }
      if (selector === recent && !touch) {
        assert.ok(await onRail(selector,list => document.activeElement ===
          [...list.querySelectorAll('li')].at(-2).querySelector('[data-dismiss-recent]')),
          'Tab reaches the matching poster’s Remove control');
        await browser.press('Tab');
      }
      assert.ok(await onRail(selector,list => document.activeElement === [...list.querySelectorAll('a')].at(-1)), 'Tab reaches the last poster');
      await until(() => onRail(selector,visibleEnd),'keyboard-focused last poster in ' + selector);
    }
  }
  const home = origin + '/tracker/#/home', show = origin + '/tracker/#/show/';
  const visibleIds = () => onRail(recent,list => [...(list?.querySelectorAll('a') ?? [])].map(a => Number(a.hash.split('/').at(-1))));
  await exerciseRails(1440);
  await browser.navigate(home);
  await until(async () => (await visibleIds()).length === 8,'eight recent titles');
  assert.deepEqual(await visibleIds(),[1,2,3,4,5,6,7,8]);
  const close = '[data-dismiss-recent="1"]';
  await browser.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:1,y:1});
  await browser.evaluate('document.querySelector(".home-search input").focus()');
  assert.equal(await browser.evaluate('getComputedStyle(document.querySelector(\''+close+'\')).opacity'),'0');
  const point = await onRail(recent,async list => {
    const card = list.querySelector('li'), art = card.querySelector('.tv-poster'), button = card.querySelector('button');
    art.scrollIntoView({block:'center',behavior:'instant'});
    // Chromium can clear hover when it delivers the pending scroll event on the next frame.
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const a = art.getBoundingClientRect(), b = button.getBoundingClientRect();
    const x = b.x + b.width/2, y = b.y + b.height/2;
    return {x,y,overPoster:art.contains(document.elementFromPoint(x,y)),
      corner:b.right <= a.right && b.left > a.left+a.width/2 && b.top >= a.top && b.bottom < a.top+a.height/2};
  });
  assert.ok(point.corner,'Dismiss belongs over the top-right of the poster');
  assert.ok(point.overPoster,'The hidden dismiss button lets the poster receive clicks');
  await browser.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x,y:point.y});
  await until(() => onRail(recent,(list,x,y) => {
    const button = list.querySelector('button');
    return getComputedStyle(button).opacity === '1' && button.contains(document.elementFromPoint(x,y));
  },point.x,point.y),'the visible dismiss button receives clicks at the pointer');
  await browser.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:1,y:1});
  await onRail(recent,list => list.querySelector('a').focus());
  await browser.press('Tab');
  assert.equal(await browser.evaluate('document.activeElement.matches(\''+close+'\') && getComputedStyle(document.activeElement).opacity === "1"'),true);
  await browser.press('Enter');
  await until(async () => (await visibleIds())[0] === 2,'keyboard dismissal reveals next recent');
  assert.deepEqual(await visibleIds(),[2,3,4,5,6,7,8,9]);
  assert.equal(await browser.evaluate('document.activeElement.hash'),'#/show/2');

  await exerciseRails(390);
  await browser.navigate(show + '2');
  await until(() => onRail(suggestions,list => list?.querySelectorAll('a').length === 5),'five recommendations');
  const visibleButton = () => onRail(suggestions,list => !!list.closest('section').querySelector('[data-rail-next]')?.getClientRects().length);
  assert.ok(await visibleButton(),'five posters need controls on a phone');
  await browser.send('Emulation.setDeviceMetricsOverride',{width:1440,height:850,deviceScaleFactor:1,mobile:false});
  await until(async () => !await visibleButton(),'controls disappear once every recommendation fits');
  assert.equal(await onRail(suggestions,wheelCanceled,{deltaY:100}),false,'A nonoverflowing rail blocked the page wheel');

  await browser.send('Emulation.setDeviceMetricsOverride',{width:390,height:850,deviceScaleFactor:1,mobile:true});
  await browser.navigate(home);
  await until(async () => (await visibleIds())[0] === 2,'recent titles return after visiting recommendations');
  assert.equal(await onRail(recent,list => list.querySelector('button').getClientRects().length),0,'Touch Home has no dismiss overlay');
  await browser.click('[data-recent] a[href="#/show/2"]');
  await browser.click('.show-more');
  async function actions() {
    await browser.waitFor('document.querySelector("dialog[open]:not([aria-busy]) .watch-sheet-action")');
    return browser.evaluate('[...document.querySelectorAll("dialog[open] .watch-sheet-action")].map(b=>b.textContent)');
  }
  const recentActions = await actions();
  assert.equal(recentActions.includes('Remove from Watchlist'),false);
  assert.deepEqual(recentActions.slice(-2),['Remove from Recently marked','Remove watches']);
  await browser.evaluate('[...document.querySelectorAll("dialog[open] button")].find(b=>b.textContent==="Remove from Recently marked").click()');
  await browser.waitFor('document.querySelector(".show-more")?.getAttribute("aria-disabled") === "false"');
  assert.ok(await browser.evaluate('document.querySelector(".show-stat strong")?.textContent.startsWith("1")'),'Dismissing erased a watched episode');
  await browser.click('.show-more');
  assert.equal((await actions()).at(-1),'Remove watches');
  await browser.press('Escape');
  await browser.navigate(home);
  await until(async () => (await visibleIds())[0] === 3,'mobile dismissal');
  assert.deepEqual(await visibleIds(),[3,4,5,6,7,8,9,10]);
  await browser.navigate(show + '11');
  await browser.click('.show-more');
  assert.equal((await actions()).includes('Remove from Recently marked'),false,'Show outside the eight offered a redundant removal');
});
