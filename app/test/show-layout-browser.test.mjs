import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {openChromium} from './offline-chromium.mjs';
import {readCsv,writeCsv} from '../dist/csv.js';
import {linkFixture, offlineProviders} from './offline-providers.mjs';
import {listen, stop, testSite} from './offline-site.mjs';

function geometry() {
  const bounds = selector => {
    const {top,bottom,left,right} = document.querySelector(selector).getBoundingClientRect();
    return {top,bottom,left,right};
  };
  return {seasons:bounds('.show-seasons'), overview:bounds('.show-overview'), cast:bounds('.show-cast-grid'),
    page:bounds('.show-columns'), tiles:[...document.querySelectorAll('.show-season-tile')].map(tile => {
      const {top,right,bottom,left} = tile.getBoundingClientRect();
      return {top,right,bottom,left};
    }), overflow:document.documentElement.scrollWidth - innerWidth};
}

function pointerTarget(selector) {
  const control = document.querySelector(selector);
  control.scrollIntoView({block:'center'});
  const rect = control.getBoundingClientRect();
  const x = rect.left + rect.width * 0.3, y = rect.top + rect.height * 0.75;
  if (!control.contains(document.elementFromPoint(x,y))) throw Error('Another element covers ' + selector);
  return {x,y};
}

test('Show orders Overview, responsive Season tiles and Cast, with editable watch counts beside episode links',
  {timeout:90_000}, async t => {
    const {server} = await testSite();
    const origin = 'http://127.0.0.1:' + await listen(server);
    const providers = offlineProviders(origin);
    const profile = await mkdtemp(join(tmpdir(),'csvtv-show-layout-'));
    let browser;
    t.after(async () => {
      try { await browser?.close(); }
      finally { await stop(server); await rm(profile,{recursive:true,force:true,maxRetries:6,retryDelay:150}); }
    });
    await providers.settings({tmdb_key:'fictional-offline-key'});
    await providers.upload('lists.csv','list,show_id,show\r\nWatchlist,45,The Listening House\r\n');
    const cast = Array.from({length:12}, (_,i) => ({id:i+10,name:'Player '+(i+1),total_episode_count:2,
      roles:[{character:'Broadcaster '+(i+1)}]}));
    const seasons = [1,2,3,4,15].map(n => ({season_number:n,name:'Season '+n,episode_count:2}));
    const respond = (event,send) => {
      const url = new URL(event.request.url);
      if (event.request.method === 'GET' && url.hostname === 'api.themoviedb.org') {
        const path = url.pathname;
        let response;
        if (path === '/3/tv/45/aggregate_credits') response = {id:45,cast};
        if (path === '/3/tv/45') response = {id:45,name:'The Listening House',first_air_date:'2019-10-01',
          overview:'A family hears forgotten broadcasts.',status:'Ended',seasons,keywords:{results:[]},external_ids:{imdb_id:null},
          last_episode_to_air:{season_number:15,episode_number:2,air_date:'2020-10-01'},next_episode_to_air:null};
        const extra = path.match(/^\/3\/tv\/45\/season\/([2-4]|15)$/);
        if (extra) {
          const season = Number(extra[1]);
          response = {season_number:season,name:'Season '+season,episodes:[1,2].map(number => ({
            id:45000+season*10+number,episode_number:number,name:'Recording '+number,air_date:'2020-10-01',runtime:30}))};
        }
        if (response) {
          return send('Fetch.fulfillRequest',{requestId:event.requestId,responseCode:200,
            responseHeaders:[{name:'Content-Type',value:'application/json'},{name:'Access-Control-Allow-Origin',value:origin}],
            body:Buffer.from(JSON.stringify(response)).toString('base64')});
        }
      }
      return providers.respond(event,send);
    };
    browser = await openChromium(join(profile,'first'),respond);
    await linkFixture(browser,origin);
    const season = '.show-season-row[data-season="1"]';
    const badge = 'button.show-season-count[data-focus="watch-season-1"]';
    const countForm = '.season-count-form';
    const input = countForm+' input[name=count]';
    const q = selector => 'document.querySelector('+JSON.stringify(selector)+')';
    const waitCount = count => browser.waitFor(q(badge)+'?.textContent === '+JSON.stringify(count+'×'));
    const waitInput = count => browser.waitFor(q(input)+'?.value === '+JSON.stringify(String(count)));
    async function enterCount(count) {
      await browser.evaluate(q(input)+'.focus()');
      await browser.evaluate(q(input)+'.select()');
      await browser.send('Input.insertText',{text:String(count)});
      await waitInput(count);
    }
    const showUrl = origin + '/tracker/#/show/45', seasonUrl = showUrl + '/season/1';
    const ready = () => browser.waitFor('document.querySelectorAll(".show-cast-card").length === 12 && ' +
      'document.querySelector(".show-overview")?.textContent.includes("forgotten broadcasts") && ' +
      q(badge)+'?.matches(":enabled")','populated Show');
    const episodes = async () => {
      try { await browser.waitFor('location.href === ' + JSON.stringify(seasonUrl) +
        ' && document.querySelectorAll(".season-episode").length === 2','separate episode list'); }
      catch (error) { throw Error(error.message + ' at ' + await browser.evaluate('location.hash + " · " + document.body.innerText.slice(-350)')); }
    };
    const firstWatchCount = 'document.querySelector(\'[data-season-focus="episode-1-count"]\')?.textContent';
    for (const width of [1440,320]) {
      const phone = width === 320;
      await browser.send('Emulation.setDeviceMetricsOverride',{width,height:850,deviceScaleFactor:1,mobile:phone});
      await browser.send('Emulation.setTouchEmulationEnabled',{enabled:phone});
      await browser.navigate(origin + '/tracker/#/watchlist');
      await browser.waitFor('document.querySelector(".sync-state")?.dataset.synced === "true"','fictional record ready');
      await browser.click('.watchlist-screen a[href="#/show/45"]');
      await ready();
      const layout = await browser.evaluate('(' + geometry + ')()');
      const label = await browser.evaluate(`(() => {
        const row = document.querySelector('.show-season-row[data-season="15"]');
        const range = document.createRange();
        range.selectNodeContents(row.querySelector('.season-number-label').firstChild);
        return {lines:range.getClientRects().length, text:range.toString(),
          overlaps:range.getBoundingClientRect().right > row.closest('.show-season-tile').querySelector('.show-season-count').getBoundingClientRect().left + 1};
      })()`);
      assert.equal(label.text,'Season 15');
      assert.equal(label.overlaps,false,'season number overlaps its count at ' + width);
      assert.equal(label.lines,1,'Season 15 wraps at ' + width);
      assert.ok(layout.overflow <= 1,'page overflow at ' + width);
      assert.ok(Math.abs(layout.page.left-layout.cast.left) <= 2 && Math.abs(layout.page.right-layout.cast.right) <= 2,
        'Cast must span the full content width at ' + width);
      assert.ok(layout.cast.top >= Math.max(layout.seasons.bottom,layout.overview.bottom),'Cast overlaps Show sections');
      assert.ok(layout.seasons.top >= layout.overview.bottom,'Seasons must follow Overview at ' + width);
      assert.equal(layout.tiles.length,5);
      const [first,second] = layout.tiles;
      if (phone) assert.ok(second.top >= first.bottom && Math.abs(second.left-first.left) <= 1,'one column on phone');
      else {
        assert.ok(Math.abs(second.top-first.top) <= 1 && second.left >= first.right,'multiple tiles per row on desktop');
        assert.ok(layout.tiles.at(-1).top >= first.bottom,'remaining seasons wrap underneath');
      }
      assert.equal(await browser.evaluate('!!document.querySelector(".season-episode")'),false);
      assert.ok(await browser.evaluate('[...document.querySelectorAll(".show-season-tile")].every(tile=>tile.querySelector(".show-season-count + .show-season-add"))'),
        'Editable season tiles need adjacent count and quick-add controls');
      const controlsLayout = await browser.evaluate(`(() => {
        const group=document.querySelector('.show-season-controls'), [count,add]=group.children;
        const c=count.getBoundingClientRect(), a=add.getBoundingClientRect(), icon=add.firstElementChild.getBoundingClientRect();
        return {count:group.childElementCount, aligned:Math.abs(c.top-a.top)<1 && a.left>=c.right,
          centered:Math.abs(icon.left+icon.width/2-a.left-a.width/2)<1 && Math.abs(icon.top+icon.height/2-a.top-a.height/2)<1};
      })()`);
      assert.deepEqual(controlsLayout,{count:2,aligned:true,centered:true},'Season tiles should have the same two aligned controls at '+width);

      if (!phone) {
        await browser.evaluate('document.querySelector(' + JSON.stringify(season) + ').focus()');
        await browser.press('Enter');
        await episodes();
        assert.equal(await browser.evaluate(firstWatchCount),'0×','opening a season must not add a play');
        await browser.evaluate('history.back()');
        await ready();
        await browser.evaluate('document.querySelector(' + JSON.stringify(season) + ').focus()');
        await browser.press('Tab');
        assert.equal(await browser.evaluate('document.activeElement.matches('+JSON.stringify(badge)+')'),true);
        await browser.press('Tab');
        assert.equal(await browser.evaluate('document.activeElement.matches("[data-focus=add-season-1]")'),true);
        await browser.press('Enter');
        await waitCount(1);
        assert.equal(await browser.evaluate('document.querySelector("dialog[open]") === null'),true);
        await browser.click('[data-undo]');
        await waitCount(0);
        await browser.evaluate(q(badge)+'.focus()');
        await browser.press('Space');
        await waitInput(0);
        await enterCount(3);
        await browser.press('Escape');
        await browser.waitFor('!document.querySelector("dialog[open]")');
        await waitCount(0);
        assert.equal(await browser.evaluate('document.activeElement.matches('+JSON.stringify(badge)+')'),true);
        await browser.press('Enter');
        await waitInput(0);
        for (const [action,value] of [['increase',1],['decrease',0]]) {
          const selector = countForm+' [data-'+action+']';
          await browser.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:0,y:0});
          const button = q(selector);
          const color = await browser.evaluate('getComputedStyle('+button+').backgroundColor');
          const point = await browser.evaluate('(() => { const r='+button+'.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()');
          await browser.send('Input.dispatchMouseEvent',{type:'mouseMoved',...point});
          assert.equal(await browser.evaluate('getComputedStyle('+button+').textDecorationLine'),'none');
          assert.notEqual(await browser.evaluate('getComputedStyle('+button+').backgroundColor'),color,'The hovered step should highlight');
          await browser.click(selector); await waitInput(value);
        }
        await enterCount(3);
        await browser.press('Enter');
        await waitCount(3);
        await browser.click('[data-undo]');
        await waitCount(0);
        await browser.click(badge); await waitInput(0);
        await browser.click(countForm+' [data-increase]');
        await browser.click(countForm+' [type=submit]');
        await waitCount(1);
        await browser.waitFor(q(season+' small')+'?.textContent.includes("2 of 2")','saving 1× marks both aired episodes');
        assert.equal(await browser.evaluate('location.href'),showUrl);
      }
      async function pressTarget(selector) {
        const point = await browser.evaluate('(' + pointerTarget + ')(' + JSON.stringify(selector) + ')');
        if (phone) {
          await browser.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point]});
          await browser.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
        } else {
          for (const type of ['mousePressed','mouseReleased']) {
            await browser.send('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...point});
          }
        }
      }
      await pressTarget(season);
      await episodes();
      assert.equal(await browser.evaluate(firstWatchCount),'1×','opening the tile must leave the count alone');
      await pressTarget('[data-episode="episode-1"] .episode-name');
      assert.equal(await browser.evaluate('Boolean(document.querySelector("dialog[open]"))'),false,'the episode title is plain text');
      assert.equal(await browser.evaluate(firstWatchCount),'1×','tapping the watched title must preserve its count');
      const addEpisode = '[data-season-focus="episode-1-add"]', countEpisode = '[data-season-focus="episode-1-count"]',
        subtractEpisode = '[data-season-focus="episode-1-subtract"]';
      const waitEpisode = n => browser.waitFor(firstWatchCount + ' === ' + JSON.stringify(n+'×'));
      const alignment=await browser.evaluate(`(() => {
        const controls=document.querySelector('.episode-controls');
        const [plus,count,minus]=[...controls.children].map(node=>node.getBoundingClientRect());
        return plus.right<=count.left+1 && count.right<=minus.left+1 && plus.height>=44 && minus.height>=44 &&
          document.documentElement.scrollWidth<=innerWidth+1;
      })()`);
      assert.equal(alignment,true,'The independent episode controls must fit and keep usable tap targets');
      await browser.click(addEpisode); await waitEpisode(2);
      await browser.click(countEpisode); await waitInput(2);
      await enterCount(4); await browser.click(countForm+' [type=submit]'); await waitEpisode(4);
      await browser.waitFor('!document.querySelector("dialog[open]")');
      assert.equal(await browser.evaluate('document.activeElement.matches('+JSON.stringify(countEpisode)+')'),true);
      await browser.click(subtractEpisode); await waitEpisode(3);
      await browser.click('[data-undo]'); await waitEpisode(4);
      await browser.click(countEpisode); await waitInput(4); await enterCount(1);
      await browser.click(countForm+' [type=submit]'); await waitEpisode(1);
    }

    async function editor() {
      await browser.click('.show-more');
      await browser.press('Tab');
      assert.equal(await browser.evaluate('document.activeElement.textContent'),'Season order');
      await browser.press('Enter');
      await browser.waitFor('document.querySelector(".season-order-form [type=submit]")?.disabled === false');
    }
    async function mode(value) {
      await browser.evaluate(`(() => {const field=document.querySelector('select[name=order]');
        field.value=${JSON.stringify(value)}; field.dispatchEvent(new Event('change'));})()`);
    }
    const save = () => browser.click('.season-order-form [type=submit]');
    const tiles = n => browser.waitFor('document.querySelectorAll(".show-season-row").length === '+n,'displayed seasons');
    const setting = 'season_order.45', chosen = '1/2:1;2/2:1';
    await browser.navigate(showUrl);
    await ready();
    await editor(); await mode('custom');
    await browser.evaluate('document.querySelector("[name=season-1]").value="2"');
    await save();
    await browser.waitFor('document.querySelector(".season-order-form .feedback")?.textContent.includes("from 1 to 1")');
    await browser.evaluate('document.querySelector("[name=season-1]").value="1";document.querySelector("[name=season-2]").value="1"');
    await save(); await tiles(7);
    await browser.navigate(origin+'/tracker/#/settings');
    await browser.click('[data-sync]');
    await browser.waitFor('document.querySelector(".sync-state")?.dataset.synced === "true"');
    const settings = () => readCsv('settings',providers.files.get('/settings.csv').bytes).rows.find(row => row.setting===setting)?.value;
    assert.equal(settings(),chosen);
    const originalRows = Buffer.from(providers.files.get('/watched.csv').bytes);
    await browser.close();
    browser = await openChromium(join(profile,'second'),respond);
    await linkFixture(browser,origin);
    await browser.navigate(origin+'/tracker/#/settings');
    await browser.waitFor('document.querySelector(".sync-state")?.dataset.synced === "true"');
    await browser.navigate(showUrl);
    await ready(); await tiles(7);
    await browser.click('.show-season-row[data-season="2"]');
    await browser.waitFor('document.querySelectorAll(".season-episode").length === 1 && document.querySelector(".season-episode")?.textContent.includes("Recording 2")');
    assert.equal(await browser.evaluate('document.querySelector(".episode-count")?.textContent'),'1×');
    await browser.navigate(showUrl); await ready(); await editor();
    assert.equal(await browser.evaluate('document.querySelector("select[name=order]").value'),'custom');
    await mode('native'); await save(); await tiles(5);
    await editor(); await mode('auto'); await save();
    await browser.waitFor('!document.querySelector(".season-order-form")');
    await browser.navigate(origin+'/tracker/#/settings');
    await browser.click('[data-sync]');
    await browser.waitFor('document.querySelector(".sync-state")?.dataset.synced === "true"');
    assert.equal(settings(),undefined);
    assert.deepEqual(Buffer.from(providers.files.get('/watched.csv').bytes),originalRows);
  });

test('an announced empty native season preserves broadcast episode numbers and keeps a caught-up show off Watchlist', {timeout:60000}, async t=>{
  const {server}=await testSite();
  const origin='http://127.0.0.1:'+await listen(server), providers=offlineProviders(origin);
  const profile=await mkdtemp(join(tmpdir(),'csvtv-broadcast-'));
  let browser;
  t.after(async()=>{
    try{await browser?.close();}finally{await stop(server);await rm(profile,{recursive:true,force:true,maxRetries:6,retryDelay:150});}
  });
  // A real catalog ID selects its verified season order. All metadata and watches are fictional.
  const id=237150,show='The Paper Observatory',date='2020-11-12',future='2099-02-18';
  const episodes=Array.from({length:32},(_,i)=>({id:1001+i,episode_number:i+1,name:'Signal '+(i+1),
    runtime:24,air_date:i===31?future:date}));
  const rows=episodes.slice(0,31).map(e=>({show_id:id,show,season:1,episode:e.episode_number,episode_id:e.id,
    title:e.name,times_watched:e.episode_number===31?2:1}));
  const watched=writeCsv('watched',rows);
  await providers.settings({tmdb_key:'fictional-offline-key'});
  await providers.upload('watched.csv',watched);
  await providers.upload('lists.csv',writeCsv('lists',[{show_id:id,show,list:'Watchlist'}]));
  const tv='/3/tv/'+id;
  const replies=new Map([
    [tv,{id,name:show,first_air_date:date,status:'Returning Series',seasons:[
      {season_number:1,name:'Season 1',episode_count:32},{season_number:2,name:'Season 2',episode_count:0}],
      last_episode_to_air:{season_number:1,episode_number:31,air_date:date},
      next_episode_to_air:{season_number:1,episode_number:32,air_date:future},
      episode_groups:{results:[]},keywords:{results:[]},external_ids:{}}],
    [tv+'/season/1',{season_number:1,name:'Season 1',episodes}],
    [tv+'/season/2',{season_number:2,name:'Season 2',episodes:[]}],
    [tv+'/aggregate_credits',{id,cast:[]}],[tv+'/recommendations',{page:1,total_pages:0,results:[]}],
  ]);
  browser=await openChromium(profile,(event,send)=>{
    const url=new URL(event.request.url);
    if(event.request.method!=='GET' || url.hostname!=='api.themoviedb.org' || !url.pathname.startsWith(tv))return providers.respond(event,send);
    const reply=replies.get(url.pathname);
    return send('Fetch.fulfillRequest',{requestId:event.requestId,responseCode:reply?200:404,responseHeaders:[
      {name:'Content-Type',value:'application/json'},{name:'Access-Control-Allow-Origin',value:origin}],
      body:Buffer.from(JSON.stringify(reply??{})).toString('base64')});
  });
  await linkFixture(browser,origin);
  await browser.navigate(origin+'/tracker/#/show/'+id);
  const third='.show-season-row[data-season="3"]';
  await browser.waitFor('document.querySelector('+JSON.stringify(third)+')?.textContent.includes("Season 3") && document.querySelector(".sync-state")?.dataset.synced==="true"');
  await browser.click(third);
  await browser.waitFor('document.querySelectorAll(".season-episode").length===8');
  const readRows='Array.from(document.querySelectorAll(".episode-row"),row=>[row.querySelector(".episode-number").textContent,row.innerText,row.querySelector(".episode-count").textContent])';
  const shown=await browser.evaluate(readRows);
  assert.equal(shown[6][0],'7');assert.match(shown[6][1],/Signal 31/);assert.equal(shown[6][2],'2×');
  assert.equal(shown[7][0],'8');assert.match(shown[7][1],/Signal 32/);
  await browser.navigate(origin+'/tracker/#/watchlist');
  await browser.waitFor('document.querySelector("[data-section=more-to-watch] .watch-lead")?.textContent==="No shows with more to watch."');
  assert.equal(await browser.evaluate('document.querySelector(".watchlist-screen > .watch-lead").textContent'),'Your Watchlist is empty.');
  assert.equal(await browser.evaluate('document.querySelectorAll(".watchlist-screen .watch-rows li").length'),0);
  assert.equal(new TextDecoder().decode(providers.files.get('/watched.csv').bytes),watched);
});
