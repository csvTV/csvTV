import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {openChromium} from './offline-chromium.mjs';
import {linkFixture, offlineProviders} from './offline-providers.mjs';
import {listen, stop, testSite} from './offline-site.mjs';
import {traktZip} from './trakt-fixture-cases.mjs';
import {readCsv} from '../dist/csv.js';

test('Repeated Trakt count edits keep a late show and the active stepper in view', {timeout:75000}, async t => {
  const {server} = await testSite();
  const origin = 'http://127.0.0.1:' + await listen(server);
  const directory = await mkdtemp(join(tmpdir(),'csvtv-trakt-scroll-'));
  let browser;
  t.after(async () => {
    try { await browser?.close(); }
    finally { await stop(server); await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100}); }
  });
  const provider = offlineProviders(origin);
  await provider.settings({tmdb_key:'fictional-offline-key'});
  const shows = Array.from({length:32}, (_,i) => ({title:'Fictional Signal '+(100+i),ids:{tmdb:100+i}}));
  const episodes = shows.flatMap(show => [1,2].map(season => ({type:'episode', show, episode:{season, number:1,
    ids:{tmdb:show.ids.tmdb*10+season}}})));
  // Trakt lists this as a regular episode. Its stable TMDB ID belongs to Specials.
  const moved = shows.find(show => show.ids.tmdb === 129);
  episodes.push({type:'episode',show:moved,episode:{season:1,number:2,ids:{tmdb:1290}}});
  episodes[0].id = 10001;
  const file = await traktZip({'watched-history-1.json':episodes,'watched-history-2.json':[episodes[0]],
    'watched-shows.json':shows.map(show=>({show,plays:show.ids.tmdb === 100 ? 1 : 4})),
    'lists-watchlist.json':Array.from({length:60},()=>({type:'episode'}))});
  const path = join(directory,file.name);
  await writeFile(path,Buffer.from(await file.arrayBuffer()));
  let manualRequests = 0;
  const checking = Promise.withResolvers(), releaseReply = Promise.withResolvers();
  browser = await openChromium(join(directory,'profile'), async (message, send) => {
    const match = /^https:\/\/api\.themoviedb\.org\/3\/tv\/(\d+)(?:\/season\/(\d+))?(?:\?|$)/.exec(message.request.url);
    if (!match || message.request.method !== 'GET') return provider.respond(message,send);
    const id = Number(match[1]), season = Number(match[2]);
    const catalog = id === 128 ? [0,1,2,4,7] : id === 129 ? [0,1,2] : [1,2];
    let responseCode = 200;
    let value = match[2] === undefined ?
      {id,name:'Fictional Signal '+id,status:'Ended',seasons:catalog.map(n=>({season_number:n,episode_count:n===4?4:1})),
        keywords:{results:[]},external_ids:{}} :
      {season_number:season,episodes:[{id:id*10+season,episode_number:1,name:'Pilot',air_date:season===7?'2999-01-01':'2020-01-01'}]};
    if (season === 4) {
      manualRequests++;
      if (manualRequests === 1) responseCode = 403;
      if (manualRequests === 2) { checking.resolve(); await releaseReply.promise; }
      value = {season_number:4,episodes:['2020-01-01','2999-01-01',null,'2020-01-01'].map((air_date,i) => ({
        id:i===3 ? id*10+1 : 128001+i, episode_number:i+1,name:'Relay '+(i+1),air_date}))};
    }
    await send('Fetch.fulfillRequest',{requestId:message.requestId,responseCode,
      responseHeaders:[{name:'Access-Control-Allow-Origin',value:origin},{name:'Content-Type',value:'application/json'}],
      body:Buffer.from(JSON.stringify(value)).toString('base64')});
  });
  await linkFixture(browser,origin);
  await browser.navigate(origin+'/tracker/#/trakt-import');
  await browser.waitFor('document.querySelector("input[type=file]")?.disabled === false');
  const {root} = await browser.send('DOM.getDocument');
  const {nodeId} = await browser.send('DOM.querySelector',{nodeId:root.nodeId,selector:'input[type=file]'});
  await browser.send('DOM.setFileInputFiles',{nodeId,files:[path]});
  await browser.waitFor('document.querySelectorAll("[data-count-review]").length === 32');
  assert.equal(await browser.evaluate('document.querySelectorAll(".count-season").length'),0);
  const q = selector => 'document.querySelector('+JSON.stringify(selector)+')';
  assert.match(await browser.evaluate(q('[data-count-review="100"] [data-count-summary]')+'.innerText'), /1 play above Trakt’s total of 1/);
  assert.match(await browser.evaluate(q('[data-preview]')+'.textContent'), /Ignored repeated history rows with the same event ID: 1/);
  const row = '[data-count-review="128"]';
  const summary = row+' [data-count-summary]';
  const plus = row+' [data-season-add="1"]', minus = row+' [data-season-remove="1"]';
  const count = row+' [data-season-count="1"]';
  const settle = () => browser.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  for (const width of [390,1440]) {
    await browser.send('Emulation.setDeviceMetricsOverride',{width,height:760,deviceScaleFactor:1,mobile:width<900});
    await browser.click(summary);
    assert.equal(await browser.evaluate('document.querySelectorAll(".count-season").length'),4);
    await browser.evaluate(q(plus)+'.scrollIntoView({block:"center"})');
    await settle();
    const rect = await browser.evaluate(q(plus)+'.getBoundingClientRect().toJSON()');
    const scroll = await browser.evaluate('window.scrollY');
    assert.ok(scroll>600 && rect.top>0 && rect.bottom<760);
    await browser.evaluate('window.originalCountButton='+q(plus));
    let maxDrift = 0;
    await browser.send('Input.dispatchMouseEvent',{type:'mousePressed',x:rect.x+10,y:rect.y+10,button:'left',clickCount:1});
    await browser.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:rect.x+10,y:rect.y+10,button:'left',clickCount:1});
    for (const [key,value,focused] of [[null,'2×',plus],['Enter','3×',plus],['Space','4×',plus],['Enter','5×',plus],
      ['Shift+Tab','5×',minus],['Enter','4×',minus],['Space','3×',minus],['Enter','2×',minus],['Space','1×',plus]]) {
      if (key === 'Shift+Tab') await browser.press('Tab',{shift:true});
      else if (key) await browser.press(key);
      await settle();
      assert.equal(await browser.evaluate(q(count)+'.textContent'),value);
      if (value === '5×') assert.match(await browser.evaluate(q(summary)+'.innerText'),/2 plays above Trakt’s total of 4/);
      const after = await browser.evaluate('({y:scrollY,top:'+q(plus)+'.getBoundingClientRect().top,same:window.originalCountButton==='+q(plus)+',focus:document.activeElement==='+q(focused)+'})');
      // The longer over-total label can wrap. The active button must stay in the same place on screen.
      maxDrift = Math.max(maxDrift,Math.abs(after.top-rect.top));
      assert.ok(after.y > 600 && Math.abs(after.top-rect.top)<=1 && after.same && after.focus,
        width+'px '+value+' before '+JSON.stringify({y:scroll,top:rect.top})+' after '+JSON.stringify(after));
    }
    t.diagnostic(width+'px · scroll '+scroll+' · eight season edits · maximum viewport shift '+maxDrift+'px');
    await browser.click(summary);
    const wholeAdd = row+' [data-whole-add]', wholeRemove = row+' [data-whole-remove]';
    await browser.evaluate(q(wholeAdd)+'.focus({preventScroll:true})');
    await browser.press('Enter'); await browser.press('Space');
    assert.equal(await browser.evaluate(q(summary)+'.getAttribute("aria-expanded")'),'false');
    assert.equal(await browser.evaluate(q(row+' [data-whole-count]')+'.innerText'),'2×');
    assert.match(await browser.evaluate(q(summary)+'.innerText'),/2 plays above Trakt’s total of 4/);
    await browser.click(summary);
    assert.deepEqual(await browser.evaluate('[...'+q(row)+'.querySelectorAll("[data-season-count]")].map(el=>[el.dataset.seasonCount,el.innerText])'),
      [['1','3×'],['2','3×'],['4','0×'],['7','0×']]);
    await browser.click(minus); await browser.click(minus);
    assert.ok(await browser.evaluate(q(wholeRemove)+'.disabled'));
    await browser.click(plus); await browser.click(plus);
    await browser.click(wholeRemove); await browser.click(wholeRemove);
    assert.equal(await browser.evaluate(q(wholeRemove)+'.disabled && document.activeElement === '+q(wholeAdd)),true);
    assert.equal(await browser.evaluate(q(count)+'.innerText'),'1×');
    await browser.click(summary);
  }
  const withSpecial = '[data-count-review="129"]';
  await browser.click(withSpecial+' [data-count-summary]');
  assert.deepEqual(await browser.evaluate('[...'+q(withSpecial)+'.querySelectorAll(".count-season strong")].map(el=>el.textContent)'),
    ['Season 1','Season 2']);
  await browser.click(withSpecial+' [data-whole-add]');
  assert.match(await browser.evaluate(q(withSpecial+' [data-count-summary]')+'.innerText'), /2 plays above Trakt’s total of 4/);
  await browser.click(withSpecial+' [data-season-add="1"]');
  await browser.click(withSpecial+' [data-count-summary]');
  await browser.click(row+' [data-whole-add]'); await browser.click(row+' [data-whole-add]');
  await browser.click(summary); await browser.click(row+' [data-season-add="2"]');
  assert.equal(manualRequests,0,'Expanding a show or adjusting matched seasons fetched unselected season details');
  const addExtra = row+' [data-season-add="4"]', countExtra = row+' [data-season-count="4"]';
  const extraRow = q(addExtra)+'.closest(".count-season")';
  await browser.evaluate(q(addExtra)+'.focus()'); await browser.press('Enter');
  await browser.waitFor(extraRow+'.innerText.includes("Press + to retry.")');
  assert.equal(await browser.evaluate(q(countExtra)+'.textContent'),'0×');
  await browser.press('Space');
  await checking.promise;
  await browser.press('Enter');
  assert.ok(await browser.evaluate(q('[data-apply]')+'.disabled'));
  assert.equal(manualRequests,2,'Repeated Enter issued a second in-flight request');
  await browser.evaluate(q(addExtra)+'.scrollIntoView({block:"center"})'); await settle();
  const extraTop = await browser.evaluate(q(addExtra)+'.getBoundingClientRect().top');
  releaseReply.resolve();
  await browser.waitFor(q(countExtra)+'.textContent === "1×"'); await settle();
  assert.match(await browser.evaluate(extraRow+'.innerText'),/2 aired episodes · 1 importable/);
  assert.match(await browser.evaluate(q(plus)+'.closest(".count-season").innerText'),/1 aired episode · 1 matched · 0 importable/);
  assert.ok(await browser.evaluate(q(plus)+'.disabled'));
  assert.ok(Math.abs(await browser.evaluate(q(addExtra)+'.getBoundingClientRect().top')-extraTop)<=1);
  assert.ok(await browser.evaluate('document.activeElement === '+q(addExtra)));
  await browser.press('Enter');
  assert.equal(await browser.evaluate(q(countExtra)+'.textContent'),'2×');
  await browser.click(row+' [data-season-remove="4"]');
  await browser.click(row+' [data-season-remove="4"]');
  assert.ok(await browser.evaluate(q(plus)+'.disabled'),'Undo must not restore a known ambiguous placement');
  await browser.click(addExtra);
  assert.equal(manualRequests,2);
  const futureAdd = row+' [data-season-add="7"]';
  await browser.click(futureAdd);
  await browser.waitFor(q(futureAdd)+'.disabled && '+q(futureAdd)+'.closest(".count-season").innerText.includes("No aired episodes")');
  assert.equal(await browser.evaluate(q(row+' [data-season-count="7"]')+'.textContent'),'0×');
  assert.equal(await browser.evaluate(q(summary)+'.getAttribute("aria-expanded")'),'true');
  await browser.click('[data-apply]');
  await browser.waitFor(q('[data-status]')+'?.textContent.includes("Import complete")');
  await browser.waitFor(q('.sync-state')+'?.dataset.synced === "true"');
  const watched = readCsv('watched',provider.files.get('/watched.csv').bytes).rows;
  assert.equal(watched.length,65);
  assert.deepEqual(watched.filter(r=>r.show_id===128).map(r=>[r.season,r.times_watched]),[[2,4],[4,1]]);
  assert.deepEqual(watched.filter(r=>r.show_id===129).map(r=>[r.season,r.episode_id,r.times_watched]),
    [[0,1290,2],[1,1291,3],[2,1292,2]]);
  assert.ok(watched.filter(r=>r.show_id!==128 && r.show_id!==129).every(r=>r.times_watched===1));
});
