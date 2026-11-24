import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader } from '@zip.js/zip.js';
import { pagesHeaders } from '../hosting-policy.mjs';
import { createOfflineBuild } from '../offline-build.mjs';
import { shellModules } from '../shell-modules.mjs';
import { createRelease, saveRelease } from '../package-release.mjs';
import { createPreviewServer } from '../serve.mjs';
import { listen, stop } from './offline-site.mjs';
import { unpack } from './release-site.mjs';

test('the offline module set includes lazy imports and excludes unreferenced development helpers',() => {
  const sources = new Map([
    ['main.js', 'import "./startup.js"; export async function page(){return import("./page.js");}'],
    ['startup.js', 'export {ready} from "./locale.js";'],
    ['locale.js', 'export const ready = true;'],
    ['page.js', 'export async function details(){return import("./details.js", {with:{}});}'],
    ['details.js', 'import "./page.js";'],
    ['local-developer-tool.js', 'export const note = "fictional local note";'],
  ]);
  const graph = shellModules(sources);
  assert.deepEqual(graph.startup,['startup.js','locale.js']);
  assert.deepEqual([...graph.reachable],['main.js','startup.js','locale.js','page.js','details.js']);
  sources.set('page.js','export const load = name => import(name);');
  assert.throws(()=>shellModules(sources),/Cannot identify the offline import in page.js/);
  sources.set('page.js','export async function details(){return import("./missing.js");}');
  assert.throws(()=>shellModules(sources),/Unknown offline module .\/missing.js in page.js/);
  sources.set('page.js','export function job(){return new Worker(new URL("./job.js",import.meta.url),{type:"module"});}');
  sources.set('job.js','import "./details.js";');
  const withWorker=shellModules(sources);
  assert.ok(withWorker.reachable.has('job.js') && withWorker.reachable.has('details.js'));
  assert.ok(!withWorker.startup.includes('job.js') && !shellModules(sources,new Set(),'page.js').startup.includes('job.js'));
  sources.set('page.js','export function job(url){return new Worker(url);}');
  assert.throws(()=>shellModules(sources),/Cannot identify the offline worker/);
  sources.set('page.js','import "./zip-native.js";');
  assert.doesNotThrow(()=>shellModules(sources,new Set(['zip-native.js'])));
});

test('The packaged first-paint theme works when startup hints are unavailable',async()=>{
  const {bytes} = await createRelease(new URL('../dist/',import.meta.url));
  const files = await unpack(bytes), script = files.get('theme-start.js').toString();
  for (const name of ['service-worker.js','theme-start.js','favicon.svg','apple-touch-icon.png','csvtv.css',
    'trakt-import-screen.js','anilist-import-screen.js','zip-native.js','imdb-job-text.js']) assert.ok(files.has(name),name);
  assert.deepEqual(files.get('LICENSE.txt'),await readFile(new URL('../../LICENSE',import.meta.url)));
  const zipLicense = await readFile(new URL('../node_modules/@zip.js/zip.js/LICENSE',import.meta.url),'utf8');
  assert.ok(files.get('zip-native.js').toString().startsWith('/*!\n' + zipLicense + '\n*/'));
  assert.equal(files.has('screen-context.js'),false,'The type-only module entered the release.');
  assert.doesNotMatch(files.get('index.html').toString(),/rel=["']modulepreload["']/);
  assert.doesNotMatch(script,/\/\* startup dependencies \*\//);
  for (const navigator of [{},{serviceWorker:{controller:{}}},{get serviceWorker(){throw Error('unavailable');}}]) {
    const root = {dataset:{}}, meta = {};
    let appended = false;
    const document = {documentElement:root,querySelector:()=>meta,addEventListener(){},
      createElement:()=>({relList:{supports:()=>false}}),head:{append(){appended=true;}}};
    runInNewContext(script,{document,navigator,localStorage:{getItem(key){assert.equal(key,'csvTV-appearance');return 'light';}}});
    assert.equal(root.dataset.theme,'light');
    assert.equal(meta.content,'#f6f6f7');
    assert.equal(appended,false);
  }
});

test('the first page script makes a verified return available to an older entry before modules start',async () => {
  const {bytes} = await createRelease(new URL('../dist/',import.meta.url));
  const files = await unpack(bytes), script = files.get('theme-start.js').toString();
  const origin = 'https://fictional.example', uri = origin+'/tracker/';
  const ticket = {state:'fictional-state',uri,verifier:'v'.repeat(43),appKey:'fictional-app',createdAt:Date.now()};
  const values = new Map([['csvTV/dropbox-pkce-v2',JSON.stringify(ticket)]]);
  const sessionStorage = {getItem:key=>values.get(key)??null,removeItem:key=>values.delete(key),setItem:(key,value)=>values.set(key,value)};
  const location = new URL(uri+'?code=fictional-return&state=fictional-state&view=record#/library');
  const history = {state:{visit:2},replaceState(state,title,address){assert.equal(state,this.state);location.href=address;}};
  const window = {sessionStorage,location,history};
  const document = {documentElement:{dataset:{}},querySelector:()=>({}),addEventListener(){}};
  runInNewContext(script,{window,document,location,URL,URLSearchParams,navigator:{serviceWorker:{controller:{}}},
    localStorage:{getItem:()=>null}});
  assert.equal(location.href,uri+'?view=record#/library');
  assert.equal(values.has('csvTV/dropbox-pkce-v2'),false);
  assert.deepEqual(JSON.parse(values.get('csvTV/dropbox-callback-v2//tracker/')),{ticket,code:'fictional-return'});
  assert.equal(window.csvTVReturnReady,undefined,'A durable return should be ready before any asynchronous import.');
  assert.deepEqual(Object.keys(window).sort(),['history','location','sessionStorage']);
});

test('An uncontrolled tab refreshes only packaged startup modules once per changed build',async () => {
  const {bytes} = await createRelease(new URL('../dist/',import.meta.url));
  const files = await unpack(bytes), script = files.get('theme-start.js').toString();
  const values = new Map(), fetched = [], cacheModes = [];
  const sessionStorage = {getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value)};
  let reloads = 0, timeout, fail = false;
  function open(build, options = {}) {
    const window = options.window ?? new EventTarget();
    const document = {documentElement:{dataset:{}},head:{append(){}},addEventListener(){},querySelector:selector=>selector.includes('csvtv-build')?{content:build}:{},
      createElement:()=>({relList:{supports:()=>Boolean(options.preloads)}})};
    runInNewContext(script,{document,window,navigator:{},localStorage:{getItem:()=>null},sessionStorage,
      history:{get state(){throw Error('History unavailable');}},
      location:{pathname:'/tracker/',reload:()=>reloads++},AbortController,crypto,
      setTimeout:fn=>(timeout=fn,1),clearTimeout:()=>{timeout=undefined;},
      fetch:async (name,init)=>{
        assert.match(name,/^\.\/[\w-]+\.js$/);
        assert.ok(files.has(name.slice(2)));
        cacheModes.push(init.cache);
        assert.equal(init.mode,'same-origin');
        assert.equal(init.redirect,'error');
        fetched.push(name);
        if (fail) { timeout(); init.signal.throwIfAborted(); }
        return new Response(files.get(name.slice(2)),{headers:{'Content-Type':'text/javascript'}});
      },...options});
    return window.csvTVStartup;
  }
  assert.equal(open('old').changed,false);
  assert.equal(open('old').changed,false);
  assert.equal(fetched.length,0);
  const next = open('second',{navigator:{userActivation:{hasBeenActive:true}}});
  assert.equal(next.changed,true);
  assert.equal(await next.refresh(),true);
  assert.deepEqual([...new Set(cacheModes)],['no-cache']);
  assert.ok(['./main.js','./dropbox-auth.js','./storage.js','./record-screens.js','./catalog-screens.js',
    './settings-screens.js','./recovery-screen.js','./hand-merge-screen.js','./export-screen.js'].every(name=>fetched.includes(name)));
  assert.equal(new Set(fetched).size,fetched.length,'Shared screen dependencies should be verified once.');
  assert.ok(!fetched.includes('./trakt-import-screen.js'));
  assert.equal(reloads,1);
  assert.equal(open('second').changed,false);
  const before = fetched.length;
  assert.equal(await open('second').refresh(),false);
  assert.equal(fetched.length,before);
  fail = true;
  await assert.rejects(open('third').refresh(),{name:'AbortError'});
  const after = fetched.length;
  const retry = open('third');
  assert.equal(retry.changed,true);
  assert.equal(await retry.refresh(),false);
  assert.equal(fetched.length,after);
  assert.equal(reloads,1);
  const denied = {getItem(){throw Error('Storage denied');},setItem(){throw Error('Storage denied');}};
  assert.equal(open('third',{sessionStorage:denied}).changed,false);
  await assert.rejects(open('third',{sessionStorage:denied}).refresh(),/History unavailable/);
  assert.equal(open('third',{navigator:{serviceWorker:{controller:{}}}}),undefined);
  const beforeModules = new EventTarget();
  const touched = open('fourth',{window:beforeModules});
  beforeModules.dispatchEvent(new Event('keydown'));
  assert.equal(await touched.refresh(),false);
  assert.equal(fetched.length,after);
  fail = false;
  const history = {state:{csvtvDepth:2},replaceState(state){this.state=state;}};
  assert.equal(await open('fourth',{sessionStorage:denied,history}).refresh(),true);
  assert.equal(await open('fourth',{sessionStorage:denied,history}).refresh(),false);
  assert.equal(history.state.csvtvDepth,2);
  assert.equal(reloads,2);
  const interacting = new EventTarget();
  const interrupted = open('fifth',{window:interacting,fetch:async name=>{
    interacting.dispatchEvent(new Event('keydown'));
    return new Response(files.get(name.slice(2)),{headers:{'Content-Type':'text/javascript'}});
  }});
  assert.equal(await interrupted.refresh(),false);
  assert.equal(await interrupted.refresh(),false);
  assert.equal(reloads,2);
  for (const fault of ['different bytes','wrong type','partial response','oversized']) {
    const damaged = open('damaged',{fetch:async name => {
      const bytes = files.get(name.slice(2)), headers = {'Content-Type':'text/javascript'};
      if (name !== './record-screens.js') return new Response(bytes,{headers});
      if (fault === 'wrong type') headers['Content-Type']='text/html';
      if (fault === 'partial response') headers['Content-Range']='bytes 0-9/20';
      const changed = Buffer.from(bytes);
      if (fault === 'different bytes') changed[0]^=1;
      return new Response(fault === 'oversized' ? Buffer.concat([changed,Buffer.from('x')]) : changed,{headers});
    }});
    if (fault === 'different bytes') assert.equal(await damaged.refresh(true),false);
    else await assert.rejects(damaged.refresh(true));
    assert.equal(reloads,2,fault);
  }
  const manualStart = fetched.length;
  const restricted = {userActivation:{hasBeenActive:true},get serviceWorker(){throw new DOMException('Site permission','SecurityError');}};
  assert.equal(await open('damaged',{navigator:restricted}).refresh(true),true);
  assert.deepEqual([...new Set(cacheModes.slice(manualStart))],['reload']);
  const beforePage = fetched.length, checked = open('current');
  const priorReloads = reloads;
  assert.equal(await checked.checkPage('library'),true);
  const pageFiles = fetched.slice(beforePage);
  assert.deepEqual([...new Set(cacheModes.slice(beforePage))],['reload']);
  assert.ok(pageFiles.includes('./record-screens.js') && !pageFiles.includes('./main.js') && !pageFiles.includes('./settings-screens.js'));
  assert.equal(await checked.checkPage('trakt-import'),true);
  assert.deepEqual(fetched.slice(beforePage),pageFiles,'An unhinted importer has no previous-document hints to repair.');
  const incompletePage = open('current',{fetch:async name=>{
    const bytes = Buffer.from(files.get(name.slice(2)));
    if (name === './record-screens.js') bytes[0] ^= 1;
    return new Response(bytes,{headers:{'Content-Type':'text/javascript'}});
  }});
  assert.equal(await incompletePage.checkPage('library'),false);
  assert.equal(await incompletePage.checkPage('settings'),true);
  assert.equal(reloads,priorReloads,'Screen verification leaves the pending-write check in charge of reloading.');
  assert.equal(reloads,3);
  const stale = open('revalidated',{fetch:async (name,init)=>{
    const bytes = Buffer.from(files.get(name.slice(2)));
    if (name === './catalog-screens.js' && init.cache === 'no-cache') bytes[0] ^= 1;
    return new Response(bytes,{headers:{'Content-Type':'text/javascript'}});
  }});
  assert.equal(await stale.refresh(),false,'A revalidated response must still match the release checksum.');
  assert.equal(await stale.refresh(),false);
  assert.equal(reloads,3);
  assert.equal(await stale.refresh(true),true,'The manual retry downloads a fresh copy.');
  assert.equal(reloads,4);
  let time = 0;
  const slowWindow = new EventTarget();
  slowWindow.performance = {now:()=>time};
  const slow = open('slow',{window:slowWindow,preloads:true,fetch:async name=>{
    time += 500;
    return new Response(files.get(name.slice(2)),{headers:{'Content-Type':'text/javascript'}});
  }});
  assert.equal(await slow.refresh(),true);
  const onSlowConnection = open('slow',{preloads:true});
  assert.equal(onSlowConnection.preloadPage,undefined,'Let the browser schedule imports after a slow full verification.');
  assert.equal(await onSlowConnection.refresh(true),true);
  assert.equal(typeof open('slow',{preloads:true}).preloadPage,'function','A fast full verification restores the usual hints.');
});

test('Packaging includes only the verified runtime and host files, even after an older build', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'csvtv-package-'));
  t.after(() => rm(dir, {recursive:true, force:true}));
  const dist = pathToFileURL(dir + '/');
  const inputs = new Map([['index.html','<meta name="csvtv-build" content="">'], ['main.js','export const app = 1;']]);
  const worker = await readFile(new URL('../service-worker.js', import.meta.url), 'utf8');
  const built = createOfflineBuild(inputs, worker);
  const files = {'index.html':built.html, 'main.js':inputs.get('main.js'), 'service-worker.js':built.worker, '_headers':pagesHeaders,
    'obsolete.js':'old UI', 'main.d.ts':'declare const app: number;', 'watched.csv':'fictional fixture'};
  await Promise.all(Object.entries(files).map(([name, value]) => writeFile(join(dir, name), value)));
  const first = await createRelease(dist);
  assert.equal(first.build, built.build);
  assert.equal(first.fileCount, 5);
  const zip = new ZipReader(new Uint8ArrayReader(first.bytes));
  try {
    const entries = await zip.getEntries();
    assert.deepEqual(entries.map(file => file.filename), ['LICENSE.txt','_headers','index.html','main.js','service-worker.js']);
    assert.deepEqual(Buffer.from(await entries[0].getData(new Uint8ArrayWriter())), await readFile(new URL('../../LICENSE',import.meta.url)));
  } finally { await zip.close(); }
  assert.deepEqual((await createRelease(dist)).bytes, first.bytes);
  const destination = join(dir,'csvTV.zip'), temporary = join(dir,'build.tmp');
  await saveRelease(first.bytes,destination,temporary);
  await writeFile(temporary,'other build');
  await assert.rejects(saveRelease(Buffer.from('interrupted'),destination,temporary), {code:'EEXIST'});
  assert.equal(await readFile(temporary,'utf8'), 'other build');
  assert.deepEqual(await readFile(destination), Buffer.from(first.bytes));

  const server = createPreviewServer(dist);
  const origin = 'http://127.0.0.1:' + await listen(server);
  try {
    for (const path of ['obsolete.js','main.d.ts','watched.csv','_headers']) {
      assert.equal((await fetch(origin + '/' + path)).status, 404, path);
    }
    const head = await fetch(origin + '/main.js', {method:'HEAD'});
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-type'), 'text/javascript');
    assert.equal(await head.text(), '');
    assert.equal(await (await fetch(origin + '/')).text(), built.html);
    const replacement = createOfflineBuild(new Map([['index.html',inputs.get('index.html')], ['replacement.js','// new']]), worker);
    await writeFile(join(dir,'replacement.js'),'// new');
    await writeFile(join(dir,'service-worker.js'),replacement.worker);
    assert.equal((await fetch(origin + '/main.js')).status, 404);
    assert.equal(await (await fetch(origin + '/replacement.js')).text(), '// new');
    await writeFile(join(dir,'service-worker.js'),built.worker);
  } finally { await stop(server); }

  await writeFile(join(dir, 'main.js'), 'export const app = 2;');
  await assert.rejects(createRelease(dist), /differ from the offline manifest/);
  await writeFile(join(dir, 'main.js'), files['main.js']);
  await writeFile(join(dir, '_headers'), '/*\n');
  await assert.rejects(createRelease(dist), /hosting headers/);
  await writeFile(join(dir, '_headers'), pagesHeaders);
  await rm(join(dir, 'main.js'));
  await assert.rejects(createRelease(dist), {code:'ENOENT'});
});
