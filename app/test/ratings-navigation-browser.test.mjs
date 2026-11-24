import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {readCsv} from '../dist/csv.js';
import {createRelease} from '../package-release.mjs';
import {openChromium,until} from './offline-chromium.mjs';
import {linkFixture,offlineProviders} from './offline-providers.mjs';
import {listen,stop} from './offline-site.mjs';
import {releaseServer,unpack} from './release-site.mjs';

async function holdSubmittedRating(phase) {
  const {DeviceStore} = await import('/storage.js'), commit = DeviceStore.prototype.commit;
  const {WatchActions} = await import('/watch-actions.js'), save = WatchActions.prototype.setRating;
  const gate = Promise.withResolvers();
  window.ratingStarted = window.ratingFinished = false;
  window.finishRating = fail => fail ? gate.reject(new DOMException('Fictional internal detail','UnknownError')) : gate.resolve();
  WatchActions.prototype.setRating = async function(...args) {
    WatchActions.prototype.setRating = save;
    try { return await save.apply(this,args); }
    finally { window.ratingFinished = true; }
  };
  if (phase === 'read') {
    const read = DeviceStore.prototype.ratingState;
    DeviceStore.prototype.ratingState = async function(...args) {
      DeviceStore.prototype.ratingState = read;
      window.ratingStarted = true;
      await gate.promise;
      return read.apply(this,args);
    };
    return;
  }
  DeviceStore.prototype.commit = async function(revision,patch,options) {
    if (!patch.put?.ratings && !patch.remove?.ratings) return commit.call(this,revision,patch,options);
    DeviceStore.prototype.commit = commit;
    window.ratingStarted = true;
    await gate.promise;
    return commit.call(this,revision,patch,options);
  };
}

async function savedRatings() {
  const {openDeviceStore} = await import('/storage.js'), reader = await openDeviceStore();
  try { return await reader.ratingRows(); } finally { reader.close(); }
}

async function linkedRatings(t) {
  const {bytes} = await createRelease(new URL('../dist/',import.meta.url));
  const server = releaseServer(await unpack(bytes)), origin = 'http://127.0.0.1:'+await listen(server);
  const provider = offlineProviders(origin), profile = await mkdtemp(join(tmpdir(),'csvtv-rating-navigation-'));
  let browser;
  t.after(async () => { try { await browser?.close(); }
    finally { await stop(server); await rm(profile,{recursive:true,force:true,maxRetries:6,retryDelay:150}); }
  });
  await provider.settings({});
  await provider.upload('ratings.csv','show_id,show,rating\r\n42,Evening Signal,2.5\r\n');
  browser = await openChromium(profile,provider.respond);
  await browser.send('Emulation.setFocusEmulationEnabled',{enabled:true});
  await linkFixture(browser,origin,'/');
  const saved = () => readCsv('ratings',provider.files.get('/ratings.csv').bytes).rows;
  return {browser,origin,saved};
}

const editor = 'document.querySelector(\'.ratings-rows li[data-show-id="42"] select\')';

test('the desktop inline rating menu opens in the app theme and commits a pointer choice', async t => {
  const {browser,origin,saved} = await linkedRatings(t);
  await browser.send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
  await browser.navigate(origin+'/#/home');
  await browser.waitFor('document.querySelector(".sync-state")?.dataset.synced==="true"');
  await browser.evaluate(`(async () => {
    const {TmdbService} = await import('/tmdb-service.js'), edit = TmdbService.prototype.editRating;
    TmdbService.prototype.editRating = function(show,...args) {
      TmdbService.prototype.editRating = edit;
      window.changeFictionalRating = async (expected,rating) => {
        const submitted = await this.store.ratingState(show.show_id);
        // Advance the record revision between the other editor's read and its write, keeping this show's score intact.
        const other = {show_id:84,show:'Fictional Night Train'};
        await this.editRating(other,1.5,undefined,await this.store.ratingState(other.show_id),()=>true);
        return !!await this.editRating(show,rating,expected,submitted,()=>true);
      };
      return edit.call(this,show,...args);
    };
  })()`);
  await browser.click('.app-sidebar a[href="#/ratings"]');
  await browser.waitFor(editor+' && !'+editor+'.disabled');
  if (!await browser.evaluate('CSS.supports("appearance","base-select") && CSS.supports("selector(::picker(select))")')) {
    t.skip('This browser uses the platform picker'); return;
  }
  async function pointer(element) {
    const point = await browser.evaluate('(() => { const el='+element+'; el.scrollIntoView({block:"nearest"}); const r=el.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()');
    for (const type of ['mouseMoved','mousePressed','mouseReleased'])
      await browser.send('Input.dispatchMouseEvent',{type,button:type==='mouseMoved'?'none':'left',clickCount:1,...point});
  }
  const category = 'document.querySelector(\'select[aria-label="Category"]\')';
  await pointer(category);
  assert.equal(await browser.evaluate('getComputedStyle('+category+').outlineStyle'),'none','Clicking a filter should not draw a focus ring');
  await browser.press('Escape');
  for (const theme of ['light','dark']) {
    await browser.evaluate('document.documentElement.dataset.theme='+JSON.stringify(theme));
    await pointer(editor);
    await browser.waitFor(editor+'.matches(":open")','visible desktop picker');
    const palette = await browser.evaluate(`(() => {
      const field=${editor}, menu=getComputedStyle(field,"::picker(select)"), card=getComputedStyle(field.closest("li"));
      return {panel:menu.backgroundColor,card:card.backgroundColor,radius:menu.borderRadius,options:field.options.length};
    })()`);
    assert.equal(palette.panel,palette.card);
    assert.equal(palette.radius,'8px');
    assert.equal(palette.options,22);
    assert.equal(await browser.evaluate('getComputedStyle(document.activeElement).outlineStyle'),'none','Mouse-opened option has no focus ring');
    if (theme==='light') {
      await browser.press('ArrowDown');
      assert.equal(await browser.evaluate('getComputedStyle(document.activeElement).outlineStyle'),'solid','Keyboard navigation restores visible focus');
      await browser.press('Escape');
    } else await pointer(editor+'.querySelector(\'option[value="7.5"]\')');
    await browser.waitFor('!'+editor+'.matches(":open")');
  }
  await until(()=>saved()[0]?.rating===7.5,'selected half-step saved to the fictional record');
  await pointer(editor);
  await browser.waitFor(editor+'.matches(":open")');
  assert.equal(await browser.evaluate('window.changeFictionalRating(7.5,5)'),true,'the competing editor saved its change');
  await browser.waitFor(editor+'.value==="5"');
  await pointer(editor+'.querySelector(\'option[value="9"]\')');
  await browser.waitFor('document.querySelector(".reports")?.textContent.includes("This rating changed")','a stale open menu must report a conflict');
  await until(()=>{
    const rows = saved();
    return rows.find(row=>row.show_id===42)?.rating===5 && rows.find(row=>row.show_id===84)?.rating===1.5;
  },'both the newer score and the unrelated edit survived the stale choice');
});

async function choose(browser,score) {
  const chosen = JSON.stringify(String(score??'remove'));
  await browser.waitFor(`(()=>{
    const field=${editor}; if(!field || field.disabled) return false;
    field.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true})); field.focus();
    if(![...field.options].some(option=>option.value===${chosen})) return false;
    field.value=${chosen};field.dispatchEvent(new Event('change',{bubbles:true}));return true;
  })()`);
}

test('Leaving Ratings during a submitted change or removal keeps the edit in Dropbox without moving destination focus or Undo', {timeout:60000}, async t => {
  const {browser,origin,saved} = await linkedRatings(t);
  for (const [before,choice,phase] of [[2.5,9,'read'],[2.5,9,'commit'],[2.5,8,'success'],[8,null,'success']]) {
    const fail = phase !== 'success';
    await browser.navigate(origin+'/#/ratings');
    await browser.waitFor('document.querySelector(".sync-state")?.dataset.synced==="true" && '+editor+
      '?.disabled === false && '+editor+'.value === '+JSON.stringify(String(before)));
    await browser.evaluate('('+holdSubmittedRating+')('+JSON.stringify(phase)+')');
    await choose(browser,choice);
    await browser.waitFor('window.ratingStarted','admitted rating write');
    await browser.click('.app-sidebar a[href="#/library"]');
    await browser.waitFor('!!document.querySelector(".library-screen input[type=search]")');
    await browser.evaluate('document.querySelector(".library-screen input[type=search]").focus(); window.finishRating('+fail+')');
    await browser.waitFor('window.ratingFinished');
    const expected = choice===null ? [] : [{show_id:42,show:'Evening Signal',rating:fail?before:choice}];
    assert.deepEqual(await browser.evaluate('('+savedRatings+')()'),expected);
    assert.ok(await browser.evaluate('document.activeElement.matches(".library-screen input[type=search]") && document.querySelector(".undo-bar").hidden'));
    if (fail) {
      const reports = await browser.evaluate('[...document.querySelectorAll(".report")].map(e=>[e.textContent,e.hasAttribute("data-retry")])');
      assert.equal(reports.filter(([text,retry])=>text.includes('Rating could not be saved') && !retry).length,1);
      assert.ok(!reports.some(([text])=>text.includes('Fictional internal detail')));
    }
    await browser.click('.app-sidebar a[href="#/settings"]');
    await browser.click('[data-sync]');
    await until(()=>JSON.stringify(saved())===JSON.stringify(expected),'confirmed ratings.csv');
    await browser.send('Page.reload',{});
    await browser.waitFor('document.querySelector(".sync-state")?.dataset.synced==="true" && !!document.querySelector("[data-sync]")');
    assert.deepEqual(await browser.evaluate('('+savedRatings+')()'),expected);
  }
});

test('Retrying a failed inline score locks the editor and an obsolete Retry cannot replace a later choice', {timeout:60000}, async t => {
  const {browser,origin,saved} = await linkedRatings(t);
  const retry = '.report[data-retry] button:first-of-type';
  await browser.navigate(origin+'/#/ratings');
  await browser.waitFor('document.querySelector(".sync-state")?.dataset.synced==="true"');
  const settled = value => browser.waitFor(editor+'?.disabled===false && '+editor+'.value==='+JSON.stringify(String(value)));
  await settled(2.5);
  await browser.evaluate(`(() => {
    const field = ${editor};
    field.selectedIndex = -1;
    field.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
  await settled(2.5);
  assert.equal((await browser.evaluate('('+savedRatings+')()'))[0].rating,2.5,'A dismissed empty selection changed the rating');
  async function fail(score,before) {
    await browser.evaluate('('+holdSubmittedRating+')("commit")');
    await choose(browser,score);
    await browser.waitFor('window.ratingStarted');
    await browser.evaluate('window.finishRating(true)');
    await browser.waitFor('!!document.querySelector('+JSON.stringify(retry)+')');
    await settled(before);
  }
  await fail(4.5,2.5);
  await browser.evaluate('('+holdSubmittedRating+')("commit")');
  await browser.click(retry);
  await browser.waitFor('window.ratingStarted');
  assert.ok(await browser.evaluate(editor+'.disabled && '+editor+'.getAttribute("aria-busy")==="true"'));
  await browser.evaluate('window.finishRating(false)');
  await settled(4.5);
  await fail(6,4.5);
  await choose(browser,8); await settled(8);
  await choose(browser,4.5); await settled(4.5);
  await browser.click(retry);
  const current = await browser.evaluate('('+savedRatings+')()');
  assert.equal(current[0].rating,4.5);
  await browser.click('.app-sidebar a[href="#/settings"]');
  await browser.click('[data-sync]');
  await until(()=>saved()?.[0]?.rating===4.5,'newer score reached Dropbox');
});
