import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {createRelease} from '../package-release.mjs';
import {openChromium} from './offline-chromium.mjs';
import {listen,stop} from './offline-site.mjs';
import {releaseServer,unpack} from './release-site.mjs';

async function renderReview(source) {
  const {emptyTables}=await import('/model.js');
  const shows=Array.from({length:180},(_,i)=>({show_id:i+1,year:2020,imdb_id:'',
    show:'Fictional Review '+String(i+1).padStart(3,'0')+(i%11===0?' · A long title with another season and several more words':'')}));
  const watched=shows.map(({show,show_id})=>({show,show_id,season:1,episode:1,title:'Opening',episode_id:show_id*10,times_watched:1}));
  const snapshot={tables:emptyTables(),local:{}}, host=document.querySelector('main section');
  const input={shows,watched,reusedPositions:new Set(),ratings:[],lists:[],skipped:[]};
  let plan;
  if(source==='Trakt'){
    const {planTraktImport}=await import('/trakt-preview.js'),{renderTraktPreview}=await import('/trakt-review-screen.js');
    input.counts=shows.map(s=>({...s,total:3,listedPlays:1,listedEpisodes:1,multiple:3}));
    input.today='2026-01-01';
    input.reviewSeasons=new Map(watched.map(w=>[w.show_id,new Map([[1,{episodes:[{...w,airDate:'2020-01-01'}]}]])]));
    const update=(...choices)=>plan=planTraktImport(input,snapshot,...choices);
    renderTraktPreview(host,update(),update);
  }else{
    const {planAniListImport}=await import('/anilist-preview.js'),{renderAniListPreview}=await import('/anilist-review-screen.js');
    input.entries=shows.map(s=>({...s,id:s.show_id,score:0,status:7,favourite:false}));
    input.notices=shows.flatMap(s=>[{kind:'rewatching',showId:s.show_id,text:s.show+' · Check entry '+s.show_id,episodes:0},
      {kind:'unplaced',showId:s.show_id,text:s.show+' · Unplaced episodes',episodes:s.show_id%3+1,review:true}]);
    input.reviewCandidates=new Map(watched.map(w=>[w.show_id,[{...w,times_watched:0}]]));
    input.reviewLoadedSeasons=new Map(shows.map(s=>[s.show_id,new Set([1])]));
    const update=choices=>plan=planAniListImport(input,snapshot,choices);
    renderAniListPreview(host,update(),update);
  }
  window.plannedCount=id=>plan.watched.find(p=>p.row.show_id===id)?.after;
}

test('deep Trakt and AniList count cards remain findable, editable and anchored at phone and desktop widths', {timeout:60000},async t=>{
  const {bytes}=await createRelease(new URL('../dist/',import.meta.url));
  const files=await unpack(bytes);
  files.set('review.html',Buffer.from('<!doctype html><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="csvtv.css"><main class="import-screen"><section></section></main>'));
  const server=releaseServer(files),origin='http://127.0.0.1:'+await listen(server);
  const profile=await mkdtemp(join(tmpdir(),'csvtv-import-review-'));
  let browser;
  t.after(async()=>{try{await browser?.close();}finally{await stop(server);await rm(profile,{recursive:true,force:true,maxRetries:6,retryDelay:150});}});
  browser=await openChromium(profile);
  const card='[data-count-review="133"]',toggle=card+' [data-count-summary]',plus=card+' [data-season-add="1"]';
  const button='document.querySelector('+JSON.stringify(plus)+')';
  const frames='new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))';
  for(const width of [390,1280])for(const source of ['Trakt','AniList']){
    await browser.send('Emulation.setDeviceMetricsOverride',{width,height:820,deviceScaleFactor:1,mobile:false});
    await browser.navigate(origin+'/review.html');
    await browser.evaluate('('+renderReview.toString()+')('+JSON.stringify(source)+')');
    assert.equal(await browser.evaluate('document.querySelectorAll("[data-count-review]").length'),180);
    assert.equal(await browser.evaluate('window.find("Fictional Review 133")'),true);
    await browser.evaluate('const toggle=document.querySelector('+JSON.stringify(toggle)+');toggle.scrollIntoView({block:"center"});toggle.focus({preventScroll:true});');
    await browser.press('Enter');
    await browser.waitFor('document.activeElement.getAttribute("aria-expanded")==="true"');
    await browser.press('Tab');
    assert.equal(await browser.evaluate('document.activeElement.hasAttribute("data-whole-add")'),true);
    if(source==='AniList'){
      assert.equal(await browser.evaluate('document.querySelector('+JSON.stringify(card+' [data-anilist-review-notice]')+').textContent'),'Check entry 133');
      assert.ok((await browser.evaluate('document.querySelector('+JSON.stringify(toggle)+').textContent')).includes('2 unplaced'));
    }
    await browser.evaluate(button+'.focus();'+frames);
    const before=await browser.evaluate(button+'.getBoundingClientRect().top');
    await browser.press('Enter');
    await browser.evaluate(frames);
    const outcome=await browser.evaluate('({top:'+button+'.getBoundingClientRect().top,focus:document.activeElement==='+button+',target:plannedCount(133),neighbor:plannedCount(132)})');
    assert.ok(Math.abs(outcome.top-before)<=3,source+' '+width+' moved the focused season control by '+(outcome.top-before)+' px');
    assert.deepEqual([outcome.focus,outcome.target,outcome.neighbor],[true,2,1]);
    t.diagnostic(source+' at '+width+' px retained its focused season control');
  }
});
