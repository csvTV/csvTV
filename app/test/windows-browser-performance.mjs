// Run after npm run build with no other benchmarks active. No provider credentials are required.
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRelease} from '../package-release.mjs';
import {openChromium} from './offline-chromium.mjs';
import {listen,stop} from './offline-site.mjs';
import {releaseServer,unpack} from './release-site.mjs';
import {openWindowsFirefox} from './windows-firefox.mjs';

async function seed(size) {
  const {openDeviceStore} = await import('/storage.js');
  const {tmdbResourceKey} = await import('/tmdb-client.js');
  const store = await openDeviceStore();
  try {
    await store.whenWriter();
    const now=Date.now(), owner='fictional-performance-account', deadline=now+86_400_000;
    const session={accountId:owner,instanceId:crypto.randomUUID(),signInDeadline:deadline,providerExpiresAt:deadline,
      accessExpiresAt:now+3600_000,accessToken:'fixture-only',refreshToken:'fixture-only'};
    await store.storeExchangedSession(session);
    store.connectProviderKeys(async()=>{throw Error('Unexpected provider edit');},Date.now);
    await store.loadProviderKeys(session,[{setting:'tmdb_key',value:'fixture-only'}],()=>true);
    const watched=[], ratings=[], lists=[], entries={}, fetchedAt=Date.now();
    const cache=(resource,value) => {entries[tmdbResourceKey(resource)] = {value,fetchedAt};};
    for (let id=1;id<=size;id++) {
      const show='Signal Station '+String(id).padStart(3,'0');
      const seasons=[1,2,3].map(season=>({season,name:'Season '+season,episodeCount:15}));
      cache({kind:'show',id},{show_id:id,show,status:'Ended',genres:[],networks:[],keywords:[],originCountries:['US'],
        firstAirDate:'2012-01-01',posterPath:null,seasons,lastAired:{season:3,episode:15},nextAirDate:null,
        overview:'The investigation continues in Signal Station.'});
      cache({kind:'cast',id},[{id:1,name:'Robin Glass',roles:['Host']}]);
      cache({kind:'recommendations',id},{page:1,totalPages:1,results:[]});
      for (const {season} of seasons) {
        const episodes=Array.from({length:15},(_,i)=>({episode:i+1,episode_id:id*10000+season*100+i+1,
          title:'Broadcast '+(i+1),airDate:'2012-01-01',runtime:30}));
        cache({kind:'season',id,season},{show_id:id,season,name:'Season '+season,episodes});
        for (const ep of episodes) watched.push({show_id:id,show,season,episode:ep.episode,episode_id:ep.episode_id,
          title:ep.title,times_watched:ep.episode<=3?2:1});
      }
      ratings.push({show_id:id,show,rating:(id%19+1)/2});
      if (id%5 === 0) lists.push({list:'Watchlist',show_id:id,show});
      if (id%3 === 0) lists.push({list:'Mysteries',show_id:id,show});
    }
    await store.commit((await store.snapshot()).revision,{put:{watched,ratings,lists}});
    if (!await store.writeTmdb((await store.tmdbState()).generation,{entries})) throw Error('Fixture cache failed');
    await store.commit((await store.snapshot()).revision,{removeLocal:['dropboxSession']});
    sessionStorage.setItem('perf-count',String(size));
  } finally { await store.closeForUpdate(); }
}

function observeStartup() {
  if (location.pathname!=='/') return;
  const expected=sessionStorage.getItem('perf-count');
  const observer=new MutationObserver(() => {
    const ready=expected===null ? document.querySelector('h1')?.textContent==='Connect Dropbox' && document.querySelector('#settings-services button')
      : document.querySelector('.record-totals dd')?.textContent===expected;
    if (!ready) return;
    observer.disconnect();
    requestAnimationFrame(()=>requestAnimationFrame(()=>{window.homeReadyMs=Math.round(performance.now());}));
  });
  observer.observe(document,{childList:true,subtree:true});
}

async function startupResult() {
  const until=performance.now()+20000;
  while (performance.now()<until) {
    if (window.homeReadyMs!==undefined) return window.homeReadyMs;
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  throw Error('No populated Home: '+document.body.innerText.slice(0,300));
}

async function measureVisits(size,rounds) {
  const q=s=>document.querySelector(s);
  const nav=key=>'.app-sidebar [data-destination='+key+']';
  const cases=[
    ['Library',nav('library'),()=>document.querySelectorAll('.library-grid li').length===size],
    ['Show','.library-grid [data-show-id="1"]',()=>document.querySelectorAll('.show-season-tile').length===3],
    ['Season','.show-season-row[data-season="1"]',()=>document.querySelectorAll('.episode-row').length===15],
    ['Ratings',nav('ratings'),()=>document.querySelectorAll('.rating-edit').length===size],
    ['Lists',nav('lists'),()=>document.querySelectorAll('.list-shows li').length===Math.floor(size/3)],
    ['Watchlist',nav('watchlist'),()=>!!q('.watchlist-screen a[href="#/show/5"]')],
    ['Statistics',nav('statistics'),()=>q('[data-stat=shows] dd')?.textContent===String(size) && q('[data-chart=cast]')?.getBoundingClientRect().height>0],
    ['Settings',nav('settings'),()=>!!q('.appearance-options')],
  ];
  const frame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
  const samples={};
  async function click(label,selector,ready) {
    const node=q(selector);
    if (!node || node.disabled) throw Error('Unavailable '+label+': '+selector);
    const start=performance.now(); node.click();
    while (!ready()) {
      if (performance.now()-start>20000) throw Error('No '+label+' content at '+location.hash+'; '+document.body.innerText.slice(-400));
      await frame();
    }
    await frame(); await frame();
    (samples[label]??=[]).push(Math.round(performance.now()-start));
  }
  for(let turn=0;turn<rounds;turn++) for(const c of cases) await click(...c);
  await click(...cases[0]); await click(...cases[1]); await click(...cases[2]);
  await click('Episode decrease','[data-season-focus="episode-1-subtract"]',()=>q('[data-season-focus="episode-1-count"]')?.textContent==='1×' && !!q('[data-undo]'));
  await click('Episode Undo','[data-undo]',()=>q('[data-season-focus="episode-1-count"]')?.textContent==='2×');
  return {samples,viewport:[innerWidth,innerHeight],build:q('meta[name=csvtv-build]').content};
}

const kind=process.argv[2],size=Number(process.argv[3]??300),rounds=Number(process.argv[4]??4);
if (!['firefox','edge'].includes(kind) || !Number.isInteger(size) || size<5 || !Number.isInteger(rounds) || rounds<1)
  throw Error('Use: node test/windows-browser-performance.mjs firefox|edge [shows >=5] [rounds >=1]');
const archive=process.env.CSVTV_WINDOWS_AUDIT_ZIP;
const files=await unpack(archive?await readFile(archive):(await createRelease(new URL('../dist/',import.meta.url))).bytes);
const server=releaseServer(files,(req,res)=>{
  if (req.url!=='/fixture') return false;
  res.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-store'}).end('<!doctype html><title>Fictional local setup</title>');
  return true;
});
const origin='http://127.0.0.1:'+await listen(server),profile=await mkdtemp(join(tmpdir(),'csvtv-perf-'+kind+'-'));
let browser;
try {
  if (kind==='firefox') browser=await openWindowsFirefox(profile);
  else {
    process.env.CSVTV_BROWSER=join(process.env['ProgramFiles(x86)'],'Microsoft/Edge/Application/msedge.exe');
    const edge=await openChromium(profile,(request,send)=>send('Fetch.failRequest',{requestId:request.requestId,errorReason:'InternetDisconnected'}));
    browser={...edge,version:(await edge.send('Browser.getVersion')).product,preload:source=>edge.send('Page.addScriptToEvaluateOnNewDocument',{source})};
    await edge.send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
  }
  await browser.preload('('+observeStartup+')()');
  console.error('Checking first-use Dropbox setup');
  await browser.navigate(origin+'/');
  const cold=await browser.evaluate('('+startupResult+')()');
  await browser.navigate(origin+'/fixture');
  console.error('Preparing fictional record');
  await browser.evaluate('('+seed+')('+size+')');
  await browser.navigate(origin+'/');
  const restored=await browser.evaluate('('+startupResult+')()');
  console.error('Checking populated routes');
  const visits=await browser.evaluate('('+measureVisits+')('+size+','+rounds+')');
  console.log(JSON.stringify({browser:kind,version:browser.version,size,rounds,cold,restored,...visits}));
} finally {
  try { await browser?.close(); } finally {
    await stop(server);
    await rm(profile,{recursive:true,force:true,maxRetries:8,retryDelay:150});
  }
}
