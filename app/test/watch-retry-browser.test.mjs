import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {writeCsv} from '../dist/csv.js';
import {openChromium} from './offline-chromium.mjs';
import {linkFixture,offlineProviders} from './offline-providers.mjs';
import {listen,stop,testSite} from './offline-site.mjs';

async function openShow(t,{lists=[],watchedEpisodes=[1,2]}={}) {
  const {server}=await testSite(), origin='http://127.0.0.1:'+await listen(server);
  const cloud=offlineProviders(origin),profile=await mkdtemp(join(tmpdir(),'csvtv-watch-retry-'));
  let browser;
  t.after(async()=>{try{await browser?.close();}finally{await stop(server);await rm(profile,{recursive:true,force:true,maxRetries:6,retryDelay:150});}});
  const name='The Listening House';
  await cloud.settings({tmdb_key:'fictional-offline-key'});
  if(lists.length) await cloud.upload('lists.csv',writeCsv('lists',lists.map(list=>({list,show_id:45,show:name}))));
  await cloud.upload('watched.csv',writeCsv('watched',watchedEpisodes.map(episode=>({show_id:45,show:name,
    season:1,episode,episode_id:45010+episode,title:'Recording '+episode,times_watched:1}))));
  browser=await openChromium(profile,(params,send)=>{
    if(new URL(params.request.url).pathname==='/3/search/tv' && params.request.method==='GET'){
      const reply={page:1,total_pages:1,results:[{id:45,name,first_air_date:'2019-10-01'}]};
      return send('Fetch.fulfillRequest',{requestId:params.requestId,responseCode:200,
        responseHeaders:[{name:'Access-Control-Allow-Origin',value:origin},{name:'Content-Type',value:'application/json'}],
        body:Buffer.from(JSON.stringify(reply)).toString('base64')});
    }
    return cloud.respond(params,send);
  });
  await linkFixture(browser,origin);
  await browser.navigate(origin+'/tracker/#/settings');
  await browser.waitFor('document.querySelector("[data-cloud-reason]")?.textContent==="Synced"');
  return {browser,origin};
}

const watchedCounts=`(async()=>{
  const {openDeviceStore}=await import('/tracker/storage.js'),store=await openDeviceStore();
  try{return (await store.searchRecords([45]))[0].watched.map(row=>row.times_watched);}finally{store.close();}
})()`;

test('a Search redraw failure after a committed rewatch retries only the displayed counts', {timeout:60000}, async t=>{
  const {browser,origin}=await openShow(t);
  await browser.navigate(origin+'/tracker/#/search?q=Listening');
  await browser.waitFor('document.querySelector(".result-mark")?.textContent==="Rewatch"');
  await browser.evaluate(`(async()=>{
    const {TmdbService}=await import('/tracker/tmdb-service.js'),{DeviceStore}=await import('/tracker/storage.js');
    const edit=TmdbService.prototype.markWithReceipt, read=DeviceStore.prototype.searchRecords;
    let failRead=false;
    window.rewatchAttempts=0;
    TmdbService.prototype.markWithReceipt=async function(...args){
      window.rewatchAttempts++;
      const result=await edit.apply(this,args);
      if(window.rewatchAttempts===1)failRead=true;
      return result;
    };
    DeviceStore.prototype.searchRecords=async function(...args){
      if(failRead){failRead=false;throw Error('Fictional redraw failure');}
      return read.apply(this,args);
    };
  })()`);
  await browser.click('.result-mark');
  await browser.waitFor('document.querySelector(".report[data-retry] button")?.textContent==="Try again"');
  await browser.click('.report[data-retry] button');
  await browser.waitFor('!document.querySelector(".result-mark")?.disabled && document.querySelector(".result-counts")?.textContent.includes("2 times")');
  assert.equal(await browser.evaluate('window.rewatchAttempts'),1,'Retry submitted an already committed rewatch');
  assert.deepEqual(await browser.evaluate(watchedCounts),[2,2]);
});

test('a newer successful rewatch retires an old retry for the same show', {timeout:120000}, async t=>{
  const {browser,origin}=await openShow(t);
  await browser.send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
  await browser.evaluate(`(async()=>{
    const {TmdbService}=await import('/tracker/tmdb-service.js'),edit=TmdbService.prototype.markWithReceipt;
    window.submissions=0;
    TmdbService.prototype.markWithReceipt=async function(...args) {
      window.submissions++;
      if(window.failNextWatch){window.failNextWatch=false;throw Error('Fictional temporary failure');}
      return edit.apply(this,args);
    };
  })()`);
  const screens=[
    ['Search','search?q=Listening','.result-mark'],
    ['Show','show/45','.show-actions .primary'],
    ['Season','show/45/season/1','[data-season-focus="bulk"]'],
    ['Library','library','[data-library-show="45"] .library-status-trigger'],
  ];
  let expected=1;
  for(const [name,route,button] of screens){
    await browser.navigate(origin+'/tracker/#/'+route);
    await browser.waitFor('document.querySelector('+JSON.stringify(button)+')?.isConnected');
    if(name==='Library') await browser.waitFor('document.querySelector('+JSON.stringify(button)+')?.textContent==="Complete"');
    const choose=async()=>{
      await browser.click(button);
      if(name==='Library') {
        await browser.waitFor('Array.from(document.querySelectorAll("[role=menuitem]")).some(b=>b.textContent==="Watch again")');
        await browser.evaluate('Array.from(document.querySelectorAll("[role=menuitem]")).find(b=>b.textContent==="Watch again").click()');
      }
    };
    await browser.evaluate('window.failNextWatch=true');
    await choose();
    await browser.waitFor('document.querySelector(".report[data-retry] button")?.textContent==="Try again"');
    await browser.evaluate('window.olderWatchRetry=document.querySelector(".report[data-retry] button")');
    await choose();
    expected++;
    await browser.waitFor(watchedCounts+'.then(counts=>counts.length===2 && counts.every(v=>v==='+expected+'))');
    const before=await browser.evaluate('window.submissions');
    assert.equal(await browser.evaluate('window.olderWatchRetry.isConnected'),false,name+' still offered a superseded retry');
    await browser.evaluate('window.olderWatchRetry.click()');
    assert.equal(await browser.evaluate('window.submissions'),before,name+' submitted a superseded retry');
    assert.deepEqual(await browser.evaluate(watchedCounts),[expected,expected],name);
  }
  await browser.evaluate('window.failNextWatch=true');
  await browser.click('[data-library-show="45"] .library-status-trigger');
  await browser.click('[role="menuitem"]');
  await browser.waitFor('document.querySelector(".report[data-retry] button")?.textContent==="Try again"');
  await browser.click('.report[data-retry] button');
  await browser.waitFor(watchedCounts+'.then(counts=>counts.every(v=>v==='+ (expected+1) +'))');

  await browser.navigate(origin+'/tracker/#/show/45/season/1');
  const episode=n=>'[data-season-focus="episode-'+n+'-add"]';
  await browser.waitFor('document.querySelector('+JSON.stringify(episode(1))+')?.isConnected');
  await browser.evaluate(`(async()=>{
    const {WatchActions}=await import('/tracker/watch-actions.js'),edit=WatchActions.prototype.episode;
    WatchActions.prototype.episode=async function(...args){
      if(args[0].episode===1){WatchActions.prototype.episode=edit;throw Error('Fictional episode failure');}
      return edit.apply(this,args);
    };
  })()`);
  await browser.click(episode(1));
  await browser.waitFor('document.querySelector(".report[data-retry] button")?.textContent==="Try again"');
  await browser.click(episode(2));
  await browser.waitFor(watchedCounts+'.then(counts=>counts[1]==='+ (expected+2) +')');
  await browser.click('.report[data-retry] button');
  await browser.waitFor(watchedCounts+'.then(counts=>counts.every(v=>v==='+ (expected+2) +'))');
});

test('retrying a Watchlist redraw preserves an intervening Undo', {timeout:60000}, async t=>{
  const {browser,origin}=await openShow(t,{lists:['Watchlist'],watchedEpisodes:[]});
  await browser.navigate(origin+'/tracker/#/watchlist');
  const remove='[data-watchlist-remove="45"]';
  await browser.waitFor('document.querySelector('+JSON.stringify(remove)+')?.isConnected');
  await browser.evaluate(`(async()=>{
    const {WatchActions}=await import('/tracker/watch-actions.js'),{DeviceStore}=await import('/tracker/storage.js');
    const remove=WatchActions.prototype.setMembership, members=DeviceStore.prototype.watchlistMembers;
    let failRead=false;
    window.membershipChanges=0;
    WatchActions.prototype.setMembership=async function(...args) {
      window.membershipChanges++;
      if(window.failMembershipWrite){window.failMembershipWrite=false;throw Error('Fictional Watchlist write failure');}
      const result=await remove.apply(this,args);
      if(window.membershipChanges===1)failRead=true;
      return result;
    };
    DeviceStore.prototype.watchlistMembers=async function(...args) {
      if(failRead){failRead=false;throw Error('Fictional Watchlist read failure');}
      return members.apply(this,args);
    };
  })()`);
  await browser.click(remove);
  await browser.waitFor('document.querySelector(".report[data-retry] button")?.textContent==="Try again"');
  await browser.click('[data-undo]');
  await browser.waitFor('document.querySelector(".undo-bar").hidden && document.querySelector('+JSON.stringify(remove)+')?.isConnected');
  await browser.click('.report[data-retry] button');
  assert.equal(await browser.evaluate('window.membershipChanges'),1,'Retry submitted the undone Watchlist removal');
  await browser.evaluate('window.failMembershipWrite=true');
  await browser.click(remove);
  await browser.waitFor('document.querySelector(".report[data-retry] button")?.textContent==="Try again"');
  await browser.evaluate('window.oldRemoveRetry=document.querySelector(".report[data-retry] button")');
  await browser.click(remove);
  await browser.waitFor('!document.querySelector(".undo-bar").hidden && !document.querySelector('+JSON.stringify(remove)+')');
  await browser.click('[data-undo]');
  await browser.waitFor('document.querySelector(".undo-bar").hidden && document.querySelector('+JSON.stringify(remove)+')?.isConnected');
  assert.equal(await browser.evaluate('window.oldRemoveRetry.isConnected'),false,'The successful removal left an old write available');
  await browser.evaluate('window.oldRemoveRetry.click()');
  assert.equal(await browser.evaluate('window.membershipChanges'),3,'A superseded retry removed the restored show');
  await browser.navigate(origin+'/tracker/#/home');
  await browser.navigate(origin+'/tracker/#/watchlist');
  await browser.waitFor('document.querySelector('+JSON.stringify(remove)+')?.isConnected');
});

test('switching custom lists dismisses a removal retry for the previously selected list', {timeout:60000}, async t=>{
  const {browser,origin}=await openShow(t,{lists:['Evening','Morning']});
  await browser.navigate(origin+'/tracker/#/lists');
  await browser.click('[data-list-focus="chip/Evening"]');
  const remove='[aria-label="Remove The Listening House from Evening"]';
  await browser.waitFor('document.querySelector('+JSON.stringify(remove)+')?.isConnected');
  await browser.evaluate(`(async()=>{
    const {WatchActions}=await import('/tracker/watch-actions.js');
    window.removals=0;
    WatchActions.prototype.setMembership=async function(){window.removals++;throw Error('Fictional removal failure');};
  })()`);
  await browser.click(remove);
  await browser.waitFor('document.querySelector(".report[data-retry] button")?.textContent==="Try again"');
  await browser.evaluate('window.formerListRetry=document.querySelector(".report[data-retry] button")');
  await browser.click('[data-list-focus="chip/Morning"]');
  await browser.waitFor('document.querySelector(\'[aria-label="Remove The Listening House from Morning"]\')?.isConnected');
  assert.equal(await browser.evaluate('window.formerListRetry.isConnected'),false);
  await browser.evaluate('window.formerListRetry.click()');
  assert.equal(await browser.evaluate('window.removals'),1);
});
