import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {createRelease} from '../package-release.mjs';
import {createOfflineBuild} from '../offline-build.mjs';
import {openChromium,until} from './offline-chromium.mjs';
import {offlineProviders,waitForStoredGrant} from './offline-providers.mjs';
import {listen,stop} from './offline-site.mjs';
import {releaseServer,unpack} from './release-site.mjs';

async function registerApp(browser, origin) {
  await browser.navigate(origin+'/?from=bookmark#/settings');
  await browser.waitFor('document.querySelector("#app").dataset.page==="dropbox-setup"');
  await browser.click('[data-dropbox-help]');
  const displayedUri = await browser.evaluate('document.querySelector("dialog:modal code").textContent');
  assert.equal(displayedUri,origin+'/');
  assert.equal(await browser.evaluate('document.querySelector("dialog:modal code").parentElement.querySelector("strong").textContent'),'Redirect URI for this site');
  assert.equal(await browser.evaluate('document.querySelector("dialog:modal a").href'),'https://www.dropbox.com/developers/apps');
  await browser.press('Escape');
  await browser.waitFor('!document.querySelector("dialog:modal") && document.activeElement.matches("[data-dropbox-help]")');
  await browser.click('[data-dropbox-help]');
  await browser.click('dialog:modal .help-actions button');
  await browser.waitFor('document.activeElement.matches("[data-dropbox-help]")');
  await browser.click('[data-dropbox-help]');
  const point={x:2,y:2,button:'left',clickCount:1};
  await browser.send('Input.dispatchMouseEvent',{...point,type:'mousePressed'});
  await browser.send('Input.dispatchMouseEvent',{...point,type:'mouseReleased'});
  await browser.waitFor('!document.querySelector("dialog:modal") && document.activeElement.matches("[data-dropbox-help]")');
  await browser.click('[data-edit-client]');
  const field = 'document.querySelector("input[name=appKey]")';
  await browser.evaluate(field+'.value="invalid key"');
  await browser.click('.dropbox-settings button[type=submit]');
  assert.equal(await browser.evaluate(field+'.validity.patternMismatch'),true);
  assert.equal(await browser.evaluate('document.querySelector("[data-sign-in]").hidden'),true);
  await browser.press('Escape');
  await browser.waitFor('document.activeElement.matches("[data-edit-client]")');
  assert.equal(await browser.evaluate('localStorage.getItem("csvTV-public-dropbox-app-key")'),null);
  for (const value of ['fictional-first-key','fictional-browser-registration']) {
    await browser.click('[data-edit-client]');
    await browser.evaluate(field+'.value='+JSON.stringify(value));
    await browser.click('.dropbox-settings button[type=submit]');
    await browser.waitFor('document.querySelector("[data-cloud-reason]")?.textContent==="Ready to sign in." && !document.querySelector("[data-edit-client]").hidden');
    assert.equal(await browser.evaluate('localStorage.getItem("csvTV-public-dropbox-app-key")'),value);
    assert.equal(await browser.evaluate('document.querySelector("[data-edit-client]").textContent'),'Change app key');
  }
  return displayedUri;
}

test('the packaged Dropbox controls register, sync and back up the linked account, then clear only the shared device', {timeout:90000}, async t=>{
  const {bytes}=await createRelease(new URL('../dist/',import.meta.url));
  const files=await unpack(bytes), server=releaseServer(files);
  const origin='http://127.0.0.1:'+await listen(server);
  const profile=await mkdtemp(join(tmpdir(),'csvtv-shared-device-'));
  let authorizations=0, revocations=0, ratingReads=0, displayedUri;
  let accountId='fictional-owner', cleared=false;
  const provider=offlineProviders(origin,form=>{
    assert.equal(form.get('grant_type'),'authorization_code');
    assert.equal(form.get('client_id'),'fictional-browser-registration');
    assert.equal(form.get('redirect_uri'),origin+'/');
    return {account_id:accountId,access_token:'example-access',refresh_token:'example-refresh',expires_in:14400,token_type:'bearer'};
  });
  const open=()=>openChromium(profile,async (event,send)=>{
    const url=new URL(event.request.url);
    if (url.origin==='https://www.dropbox.com' && url.pathname==='/oauth2/authorize') {
      assert.equal(url.searchParams.get('redirect_uri'),displayedUri);
      if (cleared) {
        assert.equal(url.searchParams.get('client_id'),'fictional-new-deployment');
        return send('Fetch.fulfillRequest',{requestId:event.requestId,responseCode:200,
          responseHeaders:[{name:'Content-Type',value:'text/html'}],body:Buffer.from('<title>Fictional new registration</title>').toString('base64')});
      }
      assert.equal(url.searchParams.get('client_id'),'fictional-browser-registration');
      assert.equal(url.searchParams.get('code_challenge_method'),'S256');
      const callback=new URL('/',origin);
      callback.search=new URLSearchParams({code:'fictional-code-'+ ++authorizations,state:url.searchParams.get('state')});
      return send('Fetch.fulfillRequest',{requestId:event.requestId,responseCode:302,responseHeaders:[{name:'Location',value:callback.href}]});
    }
    if (event.request.method==='POST' && url.pathname==='/2/auth/token/revoke') revocations++;
    assert.ok(accountId==='fictional-owner' || !url.pathname.startsWith('/2/files/'),'The other account must receive no file requests before a decision');
    if (event.request.method==='POST' && url.pathname==='/2/files/download' &&
        JSON.parse(new Headers(event.request.headers).get('Dropbox-API-Arg')).path==='/ratings.csv') ratingReads++;
    return provider.respond(event,send);
  },{dropboxReleaseCheck:true});
  let browser;
  t.after(async()=>{
    try { await browser?.close(); }
    finally { await stop(server); await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:150}); }
  });
  const record={
    'watched.csv':'show_id,show,season,episode,title,times_watched,episode_id\r\n45,The Listening House,1,1,Recording 1,2,45011\r\n',
    'ratings.csv':'show_id,show,rating\r\n45,The Listening House,8\r\n',
    'lists.csv':'list,show_id,show\r\nFavourites,45,The Listening House\r\n',
  };
  for (const [file,body] of Object.entries(record)) await provider.upload(file,body);
  await provider.settings({tmdb_key:'fictional-offline-key',statistics_scope:'anime'});
  browser=await open();
  displayedUri = await registerApp(browser,origin);
  const settings=origin+'/#/settings';
  const synced='document.querySelector("[data-cloud-reason]")?.textContent==="Synced" && !document.querySelector("[data-backup]").disabled';
  async function signIn() {
    const previous=await browser.evaluate('performance.timeOrigin');
    await browser.click('[data-sign-in]');
    await browser.waitFor('performance.timeOrigin!=='+previous+' && ["home","settings"].includes(document.querySelector("#app")?.dataset.page)');
    await browser.navigate(settings);
    await browser.waitFor(synced);
  }
  await signIn();
  assert.equal(await browser.evaluate('document.querySelector("#tmdb-key-label ~ [data-key-status]").textContent'),'Saved in Dropbox');
  await browser.navigate(origin+'/#/statistics');
  await browser.waitFor('document.querySelector("input[name=statistics-scope][value=anime]")?.checked');
  await browser.navigate(settings);
  await browser.waitFor(synced);
  await browser.click('[data-sign-out]');
  await browser.waitFor('document.querySelector("[data-cloud-reason]")?.textContent.includes("Signed out")');
  assert.equal(revocations,1);
  await browser.evaluate('localStorage.removeItem("csvTV-public-dropbox-app-key")');
  const worker = files.get('service-worker.js').toString(), descriptor = /^const SHELL = (.+);$/m.exec(worker);
  const shell = JSON.parse(descriptor[1]);
  const assets = new Map(Object.keys(shell.files).map(name=>[name,files.get(name)]));
  assets.set('index.html',files.get('index.html').toString().replace(shell.build,'')
    .replace('name="dropbox-app-key" content=""','name="dropbox-app-key" content="fictional-new-deployment"'));
  const next = createOfflineBuild(assets,worker.replace(descriptor[0],'const SHELL = null;'),shell.retired);
  files.set('index.html',Buffer.from(next.html)); files.set('service-worker.js',Buffer.from(next.worker));
  await browser.close(); browser=await open();
  await browser.navigate(settings);
  await browser.waitFor('document.querySelector("[data-cloud-reason]")?.textContent.includes("Signed out")');
  await browser.send('Page.reload');
  await browser.waitFor('document.querySelector("meta[name=dropbox-app-key]")?.content==="fictional-new-deployment"');
  await browser.waitFor('document.querySelector("[data-cloud-reason]")?.textContent.includes("Signed out")');
  assert.equal(await browser.evaluate('document.querySelector("[data-edit-client]").hidden'),true);
  assert.equal(await browser.evaluate('document.querySelector("[data-sign-in]").hidden'),false);
  accountId='fictional-other';
  await browser.click('[data-sign-in]');
  const accountDialog='document.querySelector("dialog:modal")';
  await browser.waitFor(accountDialog+'?.textContent.includes("Choose your Dropbox account")');
  assert.match(await browser.evaluate(accountDialog+'.textContent'),/fictional-owner.*fictional-other/);
  await browser.click('dialog:modal button.destructive');
  await browser.waitFor(accountDialog+'?.textContent.includes("Erase this device’s data?")');
  await browser.press('Escape');
  await browser.waitFor(accountDialog+'?.textContent.includes("Choose your Dropbox account")');
  await browser.press('Escape');
  await waitForStoredGrant(browser,false);
  await browser.navigate(settings);
  await browser.waitFor('!'+accountDialog+' && document.querySelector("[data-cloud-reason]")?.textContent.includes("Signed out")');
  assert.equal(revocations,2);
  accountId='fictional-owner';
  await signIn();
  assert.equal(authorizations,3);
  const beforeBackup=[...provider.files.keys()].filter(path=>path.endsWith('/completion.json')).length;
  await provider.upload('ratings.csv',record['ratings.csv'].replace(',8\r\n',',9\r\n'));
  const beforeManualSync=ratingReads;
  await browser.click('[data-sync]');
  await until(()=>ratingReads>beforeManualSync,'Sync now reading ratings.csv from Dropbox');
  await browser.waitFor(synced);
  await browser.click('[data-backup]');
  await browser.waitFor('document.querySelector("[data-dropbox-feedback]")?.textContent==="Backup saved to Dropbox."');
  assert.equal([...provider.files.keys()].filter(path=>path.endsWith('/completion.json')).length,beforeBackup+1);
  const remote=new Map([...provider.files].map(([name,file])=>[name,Buffer.from(file.bytes)]));
  await browser.evaluate("window.sharedReader=window.open('/#/settings','csvtv-reader'); Boolean(window.sharedReader)");
  await browser.waitFor("sharedReader.document.querySelector('[data-sync]')?.disabled && sharedReader.document.querySelector('[data-backup]').disabled && sharedReader.document.querySelector('[data-clear-dropbox]').disabled && sharedReader.document.querySelector('[data-sign-out]').hidden");
  await browser.evaluate("sharedReader.location.hash='/library'");
  await browser.waitFor("window.sharedReader.document.querySelector('main')?.textContent.includes('The Listening House')");
  assert.equal(await browser.evaluate("sharedReader.document.querySelector('.library-rating').textContent"),'9/10');
  await browser.offline(true);
  await browser.waitFor("document.querySelector('[data-sync]').disabled && document.querySelector('[data-backup]').disabled && document.querySelector('[data-cloud-reason]').textContent.includes('Offline')");
  await browser.click('[data-sign-out]');
  await browser.waitFor('document.querySelector("[data-sign-out]")?.hidden === true');
  assert.equal(await browser.evaluate("window.sharedReader.document.querySelector('main').textContent.includes('The Listening House')"),true);
  await browser.evaluate(`sessionStorage.setItem('csvTV/dropbox-attempt-v2','fictional-pending');
    sharedReader.sessionStorage.setItem('csvTV/dropbox-attempt-v2','fictional-other');
    sharedReader.sessionStorage.setItem('csvTV/dropbox-callback-v2//old-path/','fictional-handoff');
    sharedReader.sessionStorage.setItem('other-app-marker','keep');`);
  await browser.evaluate('document.querySelector("[data-clear-device]").focus()');
  await browser.press('Enter');
  await browser.waitFor('document.querySelector("dialog[open] .destructive")?.textContent === "Clear this device"');
  await browser.press('Escape');
  await browser.waitFor('!document.querySelector("dialog[open]")');
  assert.equal(await browser.evaluate('document.activeElement.matches("[data-clear-device]")'),true);
  await browser.click('[data-clear-device]');
  await browser.click('dialog[open] .destructive');
  await browser.waitFor("document.querySelector('#app').dataset.page==='dropbox-setup' && sharedReader.document.querySelector('#app').dataset.page==='dropbox-setup'");
  assert.equal(await browser.evaluate(`sessionStorage.getItem('csvTV/dropbox-attempt-v2') ||
    sharedReader.sessionStorage.getItem('csvTV/dropbox-attempt-v2') || sharedReader.sessionStorage.getItem('csvTV/dropbox-callback-v2//old-path/')`),null);
  assert.equal(await browser.evaluate("sharedReader.sessionStorage.getItem('other-app-marker')"),'keep');
  await browser.close();
  browser=await open();
  await browser.navigate(origin+'/#/library');
  await browser.waitFor("document.querySelector('#app').dataset.page==='dropbox-setup'");
  const erased=await browser.evaluate('('+ (async function(){
    const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('csvTV');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
    const names=Array.from(db.objectStoreNames).filter(name=>name!=='meta' && name!=='statistics');
    const tx=db.transaction([...names,'meta','statistics']);
    function read(request) {
      return new Promise((resolve,reject)=>{
        request.onsuccess=()=>resolve(request.result);
        request.onerror=()=>reject(request.error);
      });
    }
    const [counts,statistics,erasedAt]=await Promise.all([
      Promise.all(names.map(name=>read(tx.objectStore(name).count()))),
      read(tx.objectStore('statistics').getAll()),read(tx.objectStore('meta').get('deviceEraseRevision')),
    ]);
    db.close();
    return {counts,statistics:Object.fromEntries(statistics.map(({key,value})=>[key,
      key==='revision' ? typeof value==='bigint' && value===erasedAt : value]))};
  }).toString()+')()');
  assert.deepEqual(erased.counts,Array(erased.counts.length).fill(0));
  assert.deepEqual(erased.statistics,{scope:null,legacyScope:null,opened:false,revision:true});
  assert.deepEqual([...provider.files.keys()].sort(),[...remote.keys()].sort());
  for (const [name,bytes] of remote) assert.deepEqual(Buffer.from(provider.files.get(name).bytes),bytes,name);
  cleared=true;
  await browser.click('[data-sign-in]');
  await browser.waitFor('document.title==="Fictional new registration"');
});

test('A linked record upgrades from a signed-out database, verifies its original folder and keeps that registration until clear',{timeout:30000},async t=>{
  const {bytes}=await createRelease(new URL('../dist/',import.meta.url));
  const server=releaseServer(await unpack(bytes)), origin='http://127.0.0.1:'+await listen(server);
  const profile=await mkdtemp(join(tmpdir(),'csvtv-registration-upgrade-'));
  let browser;
  t.after(async()=>{
    try { await browser?.close(); }
    finally { await stop(server); await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:150}); }
  });
  browser=await openChromium(profile,()=>{throw Error('Unexpected provider request');});
  await browser.navigate(origin+'/tmdb-logo.svg');
  await browser.evaluate('('+ (async function(){
    const [{openDeviceStore,deviceMigrations},{DropboxAuth},{writeCsv}] = await Promise.all(
      ['/storage.js','/dropbox-auth.js','/csv.js'].map(path=>import(path)));
    const check = (ok,message)=>{ if (!ok) throw Error(message); };
    const answer = value=>({status:200,bytes:new TextEncoder().encode(JSON.stringify(value)),metadata:null});

    const name = 'fixture-record-registration-'+crypto.randomUUID();
    const row = {show_id:17,show:'Glass Valley',rating:8};
    const file = {base:null,lastClientModified:'2026-10-05T11:13:00Z',pending:{
      content:writeCsv('ratings',[row]),targetRevision:'prior-rating',targetContent:writeCsv('ratings',[{...row,rating:7}]),
      targetModified:'2026-10-05T11:10:00Z',clientModified:'2026-10-05T11:13:00Z',preparedAt:Date.now()-1000}};
    let store = await openDeviceStore({name,migrations:deviceMigrations.slice(0,-1)}), auth;
    let optional = null, deployment = 'fixture-new-app', offered = '', granted = '', editedDuringCheck = false;
    const attempts = [], calls = [];
    const win = {sessionStorage,location:{href:location.origin+'/record',assign:target=>{offered=new URL(target).searchParams.get('client_id');}}};
    const open = async()=>{
      auth?.close(); await store.closeForUpdate();
      store = await openDeviceStore({name}); await store.whenWriter();
      auth = new DropboxAuth(store,linked=>(linked && optional) || deployment,{online:()=>true,transport:async request=>{
        calls.push(request.endpoint);
        if (request.endpoint === 'token') {
          const form = new URLSearchParams(request.body);
          granted = form.get('client_id');
          if (form.get('grant_type') === 'refresh_token') return answer({access_token:'fixture-renewed',expires_in:300});
          return answer({account_id:'fixture-owner',access_token:'fixture-access',refresh_token:'fixture-refresh',expires_in:300});
        }
        if (request.endpoint === 'revisions') {
          check(JSON.parse(request.body).path === '/ratings.csv','A saved revision was checked at a different path');
          if (granted === 'fixture-original-app' && !editedDuringCheck) {
            if (request.headers.Authorization === 'Bearer fixture-access') return {...answer({}),status:401};
            await store.commit((await store.dropboxState()).revision,{put:{ratings:[{...row,rating:9}]}});
            editedDuringCheck = true;
          }
          const meta = {name:'ratings.csv',path_display:'/ratings.csv',rev:'prior-rating',size:30,content_hash:'b'.repeat(64),
            server_modified:'2026-10-05T11:10:00Z',client_modified:'2026-10-05T11:09:00Z'};
          return answer({has_more:false,entries:granted === 'fixture-original-app' ? [meta] : []});
        }
        check(request.endpoint === 'revoke' || request.endpoint === 'list','Unexpected Dropbox operation');
        return answer({});
      }});
    };
    const connect = async()=>{
      await auth.authorize(win);
      const ticket = JSON.parse(sessionStorage.getItem('csvTV/dropbox-pkce-v2'));
      attempts.push(offered);
      await auth.finishCallback(win,{ticket,code:'fixture-code'});
    };
    try {
      await store.whenWriter();
      await store.commit(0n,{put:{ratings:[row]},sync:{ratings:file},local:{syncAccountId:'fixture-owner'}});
      await open(); await connect();
      let error;
      try { await auth.request({endpoint:'list'}); } catch (reason) { error = reason; }
      check(error?.kind === 'unverified-folder' && calls.join('/') === 'token/revisions' &&
        (await store.dropboxState()).recordAppKey === null,'The new default used an unverified folder');
      await auth.signOut();
      await open();
      const preserved = await store.snapshot();
      check(preserved.tables.ratings[0]?.rating === 8 && preserved.sync.ratings.pending.content === file.pending.content &&
        preserved.sync.ratings.pending.targetRevision === 'prior-rating','An unverified upgrade changed the pending edit across reopen');
      optional = 'fixture-original-app';
      await connect(); await auth.request({endpoint:'list'});
      check((await store.dropboxState()).recordAppKey === optional && editedDuringCheck &&
        calls.slice(-4).join('/') === 'revisions/token/revisions/list',
        'A matching pending target did not survive a 401 renewal and concurrent local edit');
      await auth.signOut(); optional = null; deployment = 'fixture-later-default';
      await open(); await connect();
      const before = calls.length;
      await auth.request({endpoint:'list'});
      const resumed = await store.snapshot();
      check(calls.slice(before).join('/') === 'list' && resumed.sync.ratings.pending.content === file.pending.content && resumed.tables.ratings[0]?.rating === 9,
        'Reopening the verified link repeated verification or dropped its receipt');
      await auth.signOut();
      await store.eraseDevice((await store.dropboxState()).revision);
      await open(); await connect();
      check(attempts.join('/') === 'fixture-new-app/fixture-original-app/fixture-original-app/fixture-later-default' &&
        (await store.dropboxState()).recordAppKey === deployment,'A different deployment replaced a link or a cleared device kept the old key');
    } finally { auth?.close(); store.close(); indexedDB.deleteDatabase(name); sessionStorage.removeItem('csvTV/dropbox-pkce-v2'); }
  }).toString()+')()');
});
