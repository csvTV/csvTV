import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {readCsv} from '../src/csv.ts';
import {openChromium,until} from './offline-chromium.mjs';
import {linkFixture,offlineProviders} from './offline-providers.mjs';
import {listen,stop,testSite} from './offline-site.mjs';

test('early edits to untitled ratings preserve blank CSV titles and take priority over further artwork reads', async t => {
  const {server} = await testSite(), origin = 'http://127.0.0.1:'+await listen(server);
  const profile = await mkdtemp(join(tmpdir(),'csvtv-early-rating-')), provider = offlineProviders(origin);
  let browser;
  t.after(async () => { try { await browser?.close(); } finally {
    await stop(server); await rm(profile,{recursive:true,force:true,maxRetries:6,retryDelay:150});
  } });
  const ids = Array.from({length:49},(_,i)=>23+i);
  await provider.upload('ratings.csv','show_id,show,rating\r\n'+ids.map(id=>id+',,6\r\n').join(''));
  browser = await openChromium(profile,provider.respond);
  await browser.send('Emulation.setFocusEmulationEnabled',{enabled:true});
  await linkFixture(browser,origin);
  await browser.navigate(origin+'/tracker/#/settings');
  await browser.waitFor('document.querySelector("[data-cloud-reason]")?.textContent==="Synced"');
  await browser.evaluate(`(async()=>{
    const {DeviceStore} = await import('/tracker/storage.js');
    const original = DeviceStore.prototype.tmdbEntries, cache = Promise.withResolvers(), edit = Promise.withResolvers();
    window.releaseTitles = cache.resolve; window.releaseEdit = edit.resolve;
    window.titleBatches = [];
    DeviceStore.prototype.tmdbEntries = async function(keys,...rest) {
      if (keys[0]?.startsWith('tv/') && keys.every(key=>key.includes('?append_to_response='))) {
        const batch = keys.map(key=>Number(key.split('/')[1].split('?')[0]));
        window.titleBatches.push(batch);
        await cache.promise;
        return batch.map(id=>({value:{show:'Amber Signal '+id,firstAirDate:null}}));
      }
      return original.call(this,keys,...rest);
    };
    const commit = DeviceStore.prototype.commit;
    DeviceStore.prototype.commit = async function(revision,patch,...rest) {
      if (patch.put?.ratings?.some(row=>row.show_id===24)) {window.editHeld=true; await edit.promise;}
      return commit.call(this,revision,patch,...rest);
    };
  })()`);
  await browser.click('.app-sidebar a[href="#/ratings"]');
  await browser.waitFor('document.querySelector(".rating-show-copy strong")?.textContent==="Show 23"');
  const chooseSeven = async id => {
    const score = 'document.querySelector(\'.ratings-rows [data-show-id="' + id + '"] .rating-edit:enabled\')';
    await browser.evaluate(score+'.focus()');
    await browser.waitFor(score+'?.querySelector("option[value=\'7\']")');
    await browser.evaluate('(()=>{const field='+score+';field.value="7";field.dispatchEvent(new Event("change",{bubbles:true}));})()');
  };
  await browser.waitFor('window.titleBatches.length===1');
  assert.deepEqual(await browser.evaluate('window.titleBatches[0]'),ids.slice(0,8),'First visible titles get their artwork first');
  await chooseSeven(23);
  await browser.waitFor('document.querySelector(".undo-bar:not([hidden])") && document.querySelector(".rating-edit:enabled")?.value === "7"');
  const row = await browser.evaluate(`(async () => {
    const {openDeviceStore}=await import('/tracker/storage.js'), store=await openDeviceStore();
    try {return (await store.ratingRows())[0];} finally {store.close();}
  })()`);
  assert.deepEqual(row,{show_id:23,show:'',rating:7});
  await chooseSeven(24);
  await browser.waitFor('window.editHeld');
  await browser.evaluate('window.releaseTitles()');
  await browser.waitFor('document.querySelector(\'.ratings-rows [data-show-id="23"] strong\')?.textContent==="Amber Signal 23"');
  assert.equal(await browser.evaluate('window.titleBatches.length'),1,'Another artwork transaction started during the edit');
  await browser.evaluate('window.releaseEdit()');
  await browser.waitFor('document.querySelector(\'.ratings-rows [data-show-id="'+ids.at(-1)+'"] strong\')?.textContent==="Amber Signal '+ids.at(-1)+'"');
  assert.deepEqual(await browser.evaluate('window.titleBatches.flat()'),ids);
  await browser.click('.app-sidebar a[href="#/settings"]');
  await browser.click('[data-sync]');
  await until(()=>readCsv('ratings',provider.files.get('/ratings.csv').bytes).rows[0]?.rating===7,'edited rating synced');
  assert.equal(readCsv('ratings',provider.files.get('/ratings.csv').bytes).rows[0].show,'');
});

test('Ratings browses and edits scored shows and restores the saved ratings and sort on another device', {timeout:90000}, async t => {
  const {server} = await testSite();
  const origin = 'http://127.0.0.1:' + await listen(server);
  const profiles = await mkdtemp(join(tmpdir(),'csvtv-ratings-'));
  let browser;
  t.after(async () => {
    try { await browser?.close(); }
    finally { await stop(server); await rm(profiles,{recursive:true,force:true,maxRetries:8,retryDelay:150}); }
  });
  const dropbox = offlineProviders(origin);
  await dropbox.settings({ratings_sort:'gap'});
  await dropbox.upload('ratings.csv','show_id,show,rating\r\n11,Lunar Window,9\r\n23,Amber Signal,0\r\n37,Cedar Falls,4.5\r\n41,Bitter Tide,8\r\n');
  await dropbox.upload('watched.csv','show_id,show,season,episode,title,times_watched,episode_id\r\n11,Lunar Window,1,1,Pilot,4,1101\r\n37,Cedar Falls,1,1,Pilot,5,3701\r\n52,Evening Road,1,1,Pilot,7,5201\r\n');
  const q = selector => 'document.querySelector(' + JSON.stringify(selector) + ')';
  const sort = '.ratings-screen select[aria-label="Sort"]';
  const rows = '.ratings-rows li[data-show-id]';
  const ids = '[...document.querySelectorAll(' + JSON.stringify(rows) + ')].map(row=>Number(row.dataset.showId))';
  const search = '.ratings-screen input[type=search]';
  const score = id => rows+'[data-show-id="'+id+'"] select.rating-edit';
  const undo = '.undo-bar:not([hidden]) [data-undo]';
  const synced = 'document.querySelector(".sync-state")?.dataset.synced === "true"';
  const saved = table => readCsv(table,dropbox.files.get('/'+table+'.csv').bytes).rows;
  const order = expected => browser.waitFor('JSON.stringify('+ids+') === '+JSON.stringify(JSON.stringify(expected)),
    'rating order '+expected.join(', '));
  const value = (selector,wanted) => browser.waitFor(q(selector)+'?.value === '+JSON.stringify(wanted));
  async function choose(selector,wanted) {
    await browser.evaluate(q(selector)+'.focus()');
    await browser.waitFor(q(selector)+'?.disabled === false && [...'+q(selector)+'.options].some(option=>option.value === '+JSON.stringify(wanted)+')');
    await browser.evaluate('(() => {const field='+q(selector)+'; field.focus(); field.value='+JSON.stringify(wanted)+
      '; field.dispatchEvent(new Event("change",{bubbles:true}));})()');
  }
  async function searchFor(title) {
    await browser.evaluate('(() => {const field='+q(search)+'; field.focus(); field.value='+JSON.stringify(title)+
      '; field.dispatchEvent(new Event("input",{bubbles:true}));})()');
  }
  async function fresh(name) {
    browser = await openChromium(join(profiles,name),dropbox.respond);
    await browser.send('Emulation.setFocusEmulationEnabled',{enabled:true});
    await browser.send('Emulation.setDeviceMetricsOverride',{width:1280,height:820,deviceScaleFactor:1,mobile:false});
    await linkFixture(browser,origin);
    await browser.navigate(origin+'/tracker/#/settings');
    await browser.waitFor(synced);
    if (name === 'first') await browser.evaluate(`(async () => {
      const {DeviceStore} = await import('/tracker/storage.js');
      const original = DeviceStore.prototype.tmdbEntries, gate = Promise.withResolvers();
      window.finishRatingMetadata = () => { DeviceStore.prototype.tmdbEntries = original; gate.resolve(); };
      DeviceStore.prototype.tmdbEntries = async function(keys,...rest) {
        const entries = await original.call(this,keys,...rest);
        if (keys.length === 4 && keys.some(key=>key.startsWith('tv/23?'))) {
          window.ratingMetadataHeld = true;
          await gate.promise;
          entries[keys.findIndex(key=>key.startsWith('tv/23?'))] = {value:{firstAirDate:'2016-03-01'}};
        }
        return entries;
      };
    })()`);
    await browser.click('.app-sidebar a[href="#/ratings"]');
    await browser.waitFor(q(score(23))+'?.disabled === false');
    assert.equal(await browser.evaluate(q('.app-sidebar [aria-current=page]')+'?.textContent'),'Ratings');
    for (const nav of ['.app-sidebar nav','.phone-nav']) {
      assert.equal(await browser.evaluate(q(nav+' [data-destination=library]')+'.nextElementSibling.dataset.destination'),'ratings');
    }
  }
  await fresh('first');
  await browser.waitFor('window.ratingMetadataHeld');
  await browser.evaluate('window.originalRatingEditor='+q(score(23))+'; true');
  await order([11,41,37,23]);
  assert.equal(await browser.evaluate(q(sort)+'.value'),'high');
  assert.deepEqual(await browser.evaluate('[...'+q(sort)+'.options].map(option=>option.value)'),['high','low','title','plays']);
  assert.ok(await browser.evaluate(`(() => {
    const cards = [...document.querySelectorAll('.ratings-rows li')].map(row => row.getBoundingClientRect());
    return cards[0].top === cards[1].top && cards[0].right < cards[1].left && cards[2].top > cards[0].bottom &&
      document.querySelector('.ratings-rows .tv-poster').getBoundingClientRect().width === 0;
  })()`), 'Wide Ratings fits two cards across and gives the title the space of missing artwork');
  await value(score(23),'0');
  // Hold only the fictional local rating write while Chromium sends real keys to the native select.
  await browser.evaluate(`(async () => {
    const {DeviceStore} = await import('/tracker/storage.js');
    const overview = DeviceStore.prototype.overviewRows;
    window.ratingOverviewReads = 0;
    DeviceStore.prototype.overviewRows = function(...args) {
      window.ratingOverviewReads++;
      return overview.apply(this,args);
    };
    window.restoreOverviewReads = () => { DeviceStore.prototype.overviewRows = overview; };
    const commit = DeviceStore.prototype.commit;
    const gate = Promise.withResolvers();
    window.releaseRating = () => { DeviceStore.prototype.commit = commit; gate.resolve(); };
    DeviceStore.prototype.commit = async function(revision,patch,...rest) {
      if (patch.put?.ratings?.some(row=>row.show_id===23)) {
        window.ratingWriteStarted = true;
        await gate.promise;
      }
      return commit.call(this,revision,patch,...rest);
    };
  })()`);
  const down = async () => {
    const key = {key:'ArrowDown',code:'ArrowDown',windowsVirtualKeyCode:40};
    await browser.send('Input.dispatchKeyEvent',{type:'rawKeyDown',...key});
    await browser.send('Input.dispatchKeyEvent',{type:'keyUp',...key});
  };
  try {
    await browser.evaluate(q(score(23))+'.focus()');
    await down();
    await browser.waitFor('window.ratingWriteStarted && '+q(score(23))+'.disabled && '+q(score(23))+'.value==="0.5"');
    await browser.evaluate(q(search)+'.dispatchEvent(new Event("input",{bubbles:true}))');
    assert.equal(await browser.evaluate(q(score(23))+'.disabled'),true);
    await down();
    await value(score(23),'0.5');
  } finally { await browser.evaluate('window.releaseRating()'); }
  await browser.waitFor('!'+q(score(23))+'.disabled && document.activeElement==='+q(score(23)),
    'focus returns to the edited rating after its delayed write');
  await value(score(23),'0.5');
  await browser.evaluate('window.finishRatingMetadata()');
  await browser.waitFor(q(rows+'[data-show-id="23"] .rating-show-copy small')+'.textContent.startsWith("2016")');
  assert.equal(await browser.evaluate(q(score(23))+'===window.originalRatingEditor && document.activeElement===window.originalRatingEditor'),true);
  await value(score(23),'0.5');
  await browser.click(undo);
  await value(score(23),'0');
  assert.equal(await browser.evaluate('window.ratingOverviewReads'),0,'editing and undoing one rating reread all watched episodes');
  await browser.evaluate('window.restoreOverviewReads()');
  assert.equal(await browser.evaluate(q(rows+'[data-show-id="41"] a')+'.getAttribute("href")'),'#/show/41');
  await browser.evaluate(q(score(23))+'.focus()');
  assert.deepEqual(await browser.evaluate('[...'+q(score(23))+'.options].map(o=>o.value).filter(v=>v!=="remove").sort((a,b)=>a-b)'),
    Array.from({length:21},(_,i)=>String(i/2)));
  await choose(sort,'low'); await order([23,37,41,11]);
  await choose(sort,'title'); await order([23,41,37,11]);
  await choose(sort,'plays');
  await browser.waitFor(ids+'.slice(0,2).join() === "37,11"');
  await searchFor('sIgNaL'); await order([23]);
  await searchFor('absent fictional title'); await order([]);
  await searchFor(''); await browser.waitFor(ids+'.length === 4');
  assert.equal(await browser.evaluate(q(score(23))+' === window.originalRatingEditor'),true,
    'Clearing the search should restore the same hydrated rating editor');

  await choose(sort,'high');
  await browser.evaluate(`(() => {
    const field=${q(score(11))}, value=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value');
    window.unrelatedEditorWrites=0;
    Object.defineProperty(field,'value',{configurable:true,get(){return value.get.call(this);},
      set(next){window.unrelatedEditorWrites++;value.set.call(this,next);}});
  })()`);
  await choose(score(23),'9.5'); await order([23,11,41,37]);
  await browser.click(undo); await order([11,41,37,23]); await value(score(23),'0');
  assert.equal(await browser.evaluate('window.unrelatedEditorWrites'),0,'Editing and undoing one score rewrote another native editor');
  await browser.evaluate('delete '+q(score(11))+'.value');
  await browser.evaluate('window.removedRatingEditor='+q(score(41))+'; true');
  await choose(score(41),'remove'); await order([11,37,23]);
  await browser.click(undo); await order([11,41,37,23]); await value(score(41),'8');
  assert.equal(await browser.evaluate(q(score(41))+' !== window.removedRatingEditor'),true,
    'A newly restored rating should start with a new editor');
  await choose(score(37),'6.5'); await browser.waitFor(q(undo)+'?.getBoundingClientRect().width > 0');
  await value(score(37),'6.5'); await order([11,41,37,23]);
  await searchFor('lunar'); await order([11]);
  await searchFor(''); await order([11,41,37,23]);
  await choose(sort,'low'); await order([23,37,41,11]);

  await browser.send('Emulation.setDeviceMetricsOverride',{width:320,height:740,deviceScaleFactor:1,mobile:true});
  assert.ok(await browser.evaluate(`(() => {
    const nav = [...document.querySelectorAll('.phone-nav a')].map(a=>a.getBoundingClientRect());
    const cards = [...document.querySelectorAll('.ratings-rows li')].map(row=>row.getBoundingClientRect());
    const first = document.querySelector('.ratings-rows li');
    const title = first.querySelector('a').getBoundingClientRect(), edit = first.querySelector('select').getBoundingClientRect();
    return nav.length === 6 && nav.every(rect=>rect.width>=44 && rect.left>=0 && rect.right<=innerWidth+1) &&
      cards[0].left===cards[1].left && cards[1].top>cards[0].bottom && title.right<=edit.left &&
      edit.width>=44 && edit.height>=44 && edit.right<=innerWidth &&
      document.documentElement.scrollWidth<=innerWidth+1 &&
      document.querySelector('.phone-nav [aria-current=page]')?.textContent==='Ratings';
  })()`));
  await browser.navigate(origin+'/tracker/#/settings');
  await browser.click('[data-sync]');
  await until(()=>saved('ratings').find(row=>row.show_id===37)?.rating===6.5 &&
    dropbox.files.has('/settings.csv') && saved('settings').some(row=>row.setting==='ratings_sort' && row.value==='low'),
    'Dropbox ratings and selected order');
  assert.deepEqual(Object.fromEntries(saved('ratings').map(row=>[row.show_id,row.rating])),{11:9,23:0,37:6.5,41:8});
  await browser.close(); browser = undefined;
  await fresh('second'); await order([23,37,41,11]); await value(score(37),'6.5'); await value(sort,'low');

  // Keep a separate local tab on a fixture page holding only the actual writer lock.
  await browser.navigate(origin+'/fixture');
  await browser.evaluate(`(() => {
    const peer=window.open('/fixture','fictional-ratings-writer'); window.testPeer=peer;
    peer.addEventListener('load',()=>{
      const script=peer.document.createElement('script'); script.type='module';
      script.textContent="import {openDeviceStore} from '/tracker/storage.js'; const store=await openDeviceStore(); await store.whenWriter(); document.title='Writer ready';";
      peer.document.body.append(script);
    },{once:true});
  })()`);
  await browser.waitFor('window.testPeer?.document.title === "Writer ready"');
  await browser.navigate(origin+'/tracker/#/ratings'); await order([23,37,41,11]);
  assert.equal(await browser.evaluate('document.querySelectorAll(".ratings-rows select.rating-edit:enabled").length'),0);
  assert.equal(await browser.evaluate(q(rows+'[data-show-id="23"] a')+'?.getAttribute("href")'),'#/show/23');
});
