import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import test from 'node:test';
import {createRelease} from '../package-release.mjs';
import {writeCsv} from '../src/csv.ts';
import {openChromium} from './offline-chromium.mjs';
import {listen,stop,testSite} from './offline-site.mjs';
import {linkFixture,offlineProviders} from './offline-providers.mjs';
import {releaseServer,unpack} from './release-site.mjs';
import {firstWatchDownloadCase} from './first-watch-download-cases.mjs';
import {basedDownloadModes,basedWatchDownloadCase,sparsePeerCases} from './based-watch-download-cases.mjs';

test('a first watched.csv download is atomic through stale grants, lost replies and writer handoff', {timeout:120000},async t=>{
  const site=await testSite(), assets=site.server.listeners('request')[0];
  const server=createServer((req,res)=>{
    if(req.url==='/fictional-expiry-worker.js'){
      res.writeHead(200,{'content-type':'text/javascript'}).end(`
        const send=self.postMessage.bind(self),now=Date.now;
        self.postMessage=(message,...rest)=>{
          if(message.type==='progress')Date.now=()=>now()+2*86400000;
          return send(message,...rest);
        };
        await import('/tracker/watch-download-worker.js');`);
    } else assets(req,res);
  });
  const origin='http://127.0.0.1:'+await listen(server);
  const profile=await mkdtemp(join(tmpdir(),'csvtv-first-watch-'));
  let browser;
  t.after(async()=>{try{await browser?.close();}finally{await stop(server);await rm(profile,{recursive:true,force:true,maxRetries:6,retryDelay:150});}});
  browser=await openChromium(profile);
  await browser.navigate(origin+'/fixture');
  for(const mode of ['valid','legacy','duplicate','revision','grant','erase','expiry','expiry-during','drain',
    'nonempty','prior-receipt','pending','lost-committed','lost-silent','lost-before-write','terminated','stalled-fallback','stalled-update',
    'unavailable','unavailable-wrong-owner','unavailable-expiry','constructor-old-instance','stalled-old-instance']){
    const args={base:'/tracker/',mode,shortIdle:mode==='lost-silent'||mode==='terminated'};
    const result=await browser.evaluate('('+firstWatchDownloadCase.toString()+')('+JSON.stringify(args)+')');
    assert.equal(result.mode,mode);
    t.diagnostic(mode+' · '+result.submissions+' record submission'+(result.submissions===1?'':'s'));
  }
});

test('a large peer import replaces an existing synced watch table atomically', {timeout:120000},async t=>{
  const site=await testSite(),profile=await mkdtemp(join(tmpdir(),'csvtv-peer-watch-'));
  const origin='http://127.0.0.1:'+await listen(site.server);let browser;
  t.after(async()=>{try{await browser?.close();}finally{await stop(site.server);await rm(profile,{recursive:true,force:true,maxRetries:6,retryDelay:150});}});
  browser=await openChromium(profile);await browser.navigate(origin+'/fixture');
  for(const mode of basedDownloadModes){
    const result=await browser.evaluate('('+basedWatchDownloadCase.toString()+')('+JSON.stringify({base:'/tracker/',mode})+')');
    assert.equal(result.mode,mode);t.diagnostic(mode+' · '+result.batches+' batches');
  }
  for(const sample of sparsePeerCases){
    const result=await browser.evaluate('('+basedWatchDownloadCase.toString()+')('+JSON.stringify({base:'/tracker/',...sample})+')');
    assert.equal(result.saved,['normal','legacy','native','lost'].includes(sample.mode),sample.sparse+' '+sample.mode);
  }
  for(const mode of ['normal','native','native-grant','native-expiry','before-admission','expiry']){
    const result=await browser.evaluate('('+basedWatchDownloadCase.toString()+')('+JSON.stringify({base:'/tracker/',mode,size:32})+')');
    assert.equal(result.mode,mode);
    t.diagnostic('32-row peer change · '+mode);
  }
});

for(const shape of ['replacement','sparse update'])test('a renderer crash keeps the prior watches until the peer '+shape+' is retried', {timeout:60000},async t=>{
  const {bytes}=await createRelease(new URL('../dist/',import.meta.url)),server=releaseServer(await unpack(bytes));
  const origin='http://127.0.0.1:'+await listen(server),profile=await mkdtemp(join(tmpdir(),'csvtv-peer-import-reopen-'));
  const cloud=offlineProviders(origin),open=()=>openChromium(profile,(params,send)=>cloud.respond(params,send));
  let browser;t.after(async()=>{try{await browser?.close();}finally{await stop(server);await rm(profile,{recursive:true,force:true,maxRetries:6,retryDelay:150});}});
  const row=(id,n,plays)=>({show_id:id,show:id===7?'Copper Jetty':'Glass Harbour',season:1,episode:n,
    episode_id:id*10000+n,title:'Crossing '+n,times_watched:plays});
  const sparse=shape==='sparse update',original=Array.from({length:sparse?2400:48},(_,i)=>row(7,i+1,1));
  const additions=Array.from({length:sparse?1:2050},(_,i)=>row(8,i+1,1));
  const remaining=original.slice(2).map((r,i)=>sparse&&i<520?{...r,times_watched:2}:r);
  const incoming=[row(7,2,4),...remaining,...additions],before=writeCsv('watched',original),target=writeCsv('watched',incoming);
  const rating={show_id:7,show:'Copper Jetty',rating:8.5},member={show_id:7,show:'Copper Jetty',list:'Coastal routes'};
  const inspect='('+ (async function(){
    const {openDeviceStore}=await import('/storage.js'),{writeCsv}=await import('/csv.js'),store=await openDeviceStore();
    try{const {tables,sync}=await store.snapshot();return {csv:writeCsv('watched',tables.watched),base:sync.watched.base,pending:sync.watched.pending,
      ratings:tables.ratings,lists:tables.lists};}finally{store.close();}
  }).toString()+')()';
  await cloud.settings({});await cloud.upload('watched.csv',before);await cloud.upload('ratings.csv',writeCsv('ratings',[rating]));
  await cloud.upload('lists.csv',writeCsv('lists',[member]));
  browser=await open();await linkFixture(browser,origin,'/');await browser.navigate(origin+'/#/settings');
  await browser.waitFor('document.querySelector(".sync-state")?.dataset.synced==="true"');
  const first=await browser.evaluate(inspect);assert.equal(first.csv,before);assert.equal(first.base.content,before);
  await browser.evaluate(`{const Real=Worker;window.peerBatches=0;window.Worker=class extends Real{
    constructor(url,options){super(url,options);if(String(url).endsWith('/watch-download-worker.js'))this.addEventListener('message',event=>{
      if(event.data.type==='progress')window.peerBatches++;
      if(event.data.type==='admission'){event.stopImmediatePropagation();window.peerWaiting=true;}
    });}
    postMessage(message,...args){if(message.rows)window.peerSparse=Array.isArray(message.remove);return super.postMessage(message,...args);}
  };}`);
  await cloud.upload('watched.csv',target);
  await browser.evaluate('[...document.querySelectorAll("button")].find(b=>b.textContent==="Sync now").click()');
  await browser.waitFor('window.peerWaiting===true && window.peerBatches==='+ (sparse?2:5));
  assert.equal(await browser.evaluate('window.peerSparse'),sparse);
  void browser.send('Page.crash').catch(()=>{});await delay(150);await browser.close();
  browser=await open();await browser.navigate(origin+'/tmdb-logo.svg');
  assert.deepEqual(await browser.evaluate(inspect),first);
  await browser.navigate(origin+'/#/library');await browser.waitFor('document.querySelector(".library-grid")?.innerText.includes("Glass Harbour")');
  await browser.navigate(origin+'/#/settings');await browser.waitFor('document.querySelector(".sync-state")?.dataset.synced==="true"');
  const next=await browser.evaluate(inspect);
  assert.equal(next.csv,target);assert.equal(next.base.content,target);assert.notEqual(next.base.revision,first.base.revision);
  assert.equal(next.pending,null);assert.deepEqual(next.ratings,[rating]);assert.deepEqual(next.lists,[member]);
  assert.equal(new TextDecoder().decode(cloud.files.get('/watched.csv').bytes),target);
  await browser.close();browser=await open();await browser.offline(true);await browser.navigate(origin+'/#/library');
  await browser.waitFor('document.querySelector(".library-grid")?.innerText.includes("Glass Harbour")');
  assert.deepEqual(await browser.evaluate(inspect),next);
});
