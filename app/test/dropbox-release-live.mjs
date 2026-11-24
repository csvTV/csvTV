// Run the release ZIP against a new folder of fictional data in a live development App Folder.
// The interactive browser handles Dropbox consent. All app and record activity uses a temporary profile.
// --clear tests Clear Dropbox. --controls also tests backup, merge, restore, sync and sign-out.
// Both modes need one sign-in. Add --rehearse to use fictional provider responses.
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {readCsv, writeCsv} from '../dist/csv.js';
import {dropboxContentHash} from '../dist/dropbox-api.js';
import {openChromium, until} from './offline-chromium.mjs';
import {unpack, releaseServer} from './release-site.mjs';
import {createReleaseConsent} from './dropbox-live/release-consent.mjs';
import {createReleaseFolder} from './dropbox-live/release-folder.mjs';
import {rehearsalFolder} from './dropbox-live/release-rehearsal.mjs';
import {exerciseClear} from './dropbox-live/release-clear.mjs';
import {exerciseManagement} from './dropbox-live/release-management.mjs';
import {beginSignIn, dummyKeys, providerReply, sampleRecord, saveProviderKeys, signOutAndEditOffline, waitSynced} from './dropbox-live/release-ui.mjs';

const origin = 'http://localhost:8765';
const rehearsal = process.argv.includes('--rehearse');
const controls = process.argv.includes('--controls');
const clear = controls || process.argv.includes('--clear');
const files = await unpack(await readFile(new URL('../release/csvTV.zip',import.meta.url)));
const build = /name="csvtv-build" content="([a-f0-9]{64})"/.exec(files.get('index.html').toString())?.[1];
if (!build) throw Error('The release ZIP has no build identifier.');
const consent = createReleaseConsent(origin,rehearsal ? 'fictional-release-registration' : process.env.CSVTV_DROPBOX_APP_KEY || undefined,
  {clearCheck:clear,controlsCheck:controls});
delete process.env.CSVTV_DROPBOX_APP_KEY;
const server = releaseServer(files,async (req,res) => {
  if (req.headers.host !== 'localhost:8765') { res.writeHead(403).end(); return true; }
  if (req.headers['user-agent'] === 'csvTV-release-check') {
    if (req.method === 'GET') return false;
  } else if (await consent.handle(req,res)) return true;
  res.writeHead(404,{'Cache-Control':'no-store'}).end();
  return true;
});
const folder = rehearsal ? rehearsalFolder({allowClear:clear}).folder : createReleaseFolder({allowClear:clear});
const profile = await mkdtemp(join(tmpdir(),'csvtv-dropbox-release-'));
let browser, owner, token, publicKey, approval, stage = 'starting', grants = 0, offline = false, prepared = false;
let savedSettingsRev, savedRatingsRev, savedListsRev;
let listRequests = 0, signOutAfterCleanup = false;
let rehearsalChallenge;
const recent = [];
const refused = [];
function trace(entry) { recent.push(entry); if (recent.length > 16) recent.shift(); }
const failed = Promise.withResolvers();
// A transport error can precede the next browser wait, including during an interactive sign-in.
failed.promise.catch(()=>{});
const endpoints = new Map(Object.entries({
  '/2/files/list_folder':'list','/2/files/list_folder/continue':'continue','/2/files/list_revisions':'revisions',
  '/2/files/create_folder_v2':'create','/2/files/delete_v2':'delete','/2/files/upload':'upload','/2/files/download':'download',
}));
function check(ok,message) { if (!ok) throw Error(message); }
async function seed() {
  await folder.prepare(token);
  prepared = true;
  for (const [table,rows] of Object.entries(sampleRecord)) {
    const bytes = Buffer.from(writeCsv(table,rows));
    const reply = await folder.forward('upload',token,{path:'/'+table+'.csv',mode:'add',autorename:false,
      strict_conflict:true,content_hash:await dropboxContentHash(bytes)},bytes);
    check(reply.status === 200,'Could not seed the isolated record.');
  }
}
async function read(table) {
  const file = await folder.read(token,'/'+table+'.csv');
  check(file && file.contentHash === await dropboxContentHash(file.bytes),'Independent file verification failed.');
  const parsed = readCsv(table,file.bytes);
  check(!parsed.stopped && parsed.schema === 'known' && !parsed.findings.length,'Dropbox returned an unreadable CSV.');
  return {rows:parsed.rows,rev:file.rev};
}
async function verifyRecord(rating,member) {
  const [ratings,lists,watched] = await Promise.all(['ratings','lists','watched'].map(read));
  check(ratings.rows.length === 1 && ratings.rows[0].show_id === 45 && ratings.rows[0].rating === rating,'Unexpected remote rating.');
  const expectedList = member ? 'Watchlist' : 'Hidden from upcoming';
  check(lists.rows.length === 1 && lists.rows[0].list === expectedList && lists.rows[0].show_id === sampleRecord.lists[0].show_id,'Unexpected remote list.');
  check(watched.rows.length === 1 && watched.rows[0].show_id === 45 && watched.rows[0].times_watched === 1,'Unexpected remote watch count.');
  return {ratings:ratings.rev,lists:lists.rev};
}
async function verifyKeys() {
  const {rows,rev} = await read('settings');
  const actual = new Map(rows.map(r=>[r.setting,r.value]));
  check(Object.entries(dummyKeys).every(([name,value])=>actual.get(name) === value),'The four expected key rows did not match.');
  return rev;
}
async function tokenRequest(body) {
  const form = new URLSearchParams(body);
  check(form.get('client_id') === publicKey,'The OAuth client changed.');
  const exchange = form.get('grant_type') === 'authorization_code';
  check(exchange ? grants < (clear ? 1 : 2) && form.get('redirect_uri') === origin+'/' && form.has('code_verifier') :
    form.get('grant_type') === 'refresh_token' && owner,'Unexpected grant.');
  if (rehearsal && exchange) check(createHash('sha256').update(form.get('code_verifier')).digest('base64url') === rehearsalChallenge,'The rehearsal PKCE verifier changed.');
  const response = rehearsal ? Response.json({access_token:'fictional-access-'+(grants+1),token_type:'bearer',
    account_id:'fictional-owner',refresh_token:'fictional-refresh',expires_in:14400}) :
    await fetch('https://api.dropboxapi.com/oauth2/token',{method:'POST',body:form,redirect:'error',cache:'no-store',signal:AbortSignal.timeout(30000)});
  const bytes = Buffer.from(await response.arrayBuffer());
  if (response.ok) {
    const grant = JSON.parse(bytes);
    check(typeof grant.access_token === 'string' && grant.access_token,'Missing access token.');
    if (exchange) {
      check(typeof grant.account_id === 'string' && grant.account_id && (!owner || grant.account_id === owner),'Choose the same development Dropbox account for both sign-ins.');
      owner = grant.account_id;
    }
    token = grant.access_token;
    if (exchange && ++grants === 1) await seed();
    else if (exchange) {
      const before = await verifyRecord(7,true);
      check(before.ratings === savedRatingsRev && before.lists === savedListsRev,'The cloud record changed during sign-out.');
      check(await verifyKeys() === savedSettingsRev,'Cloud keys changed during sign-out.');
      console.log('PASS · Independent Dropbox read before the second grant reached the app: original rating, Watchlist and settings revisions intact.');
    }
  }
  return {bytes,status:response.status};
}
async function revoke(access) {
  if (rehearsal) return 200;
  const response = await fetch('https://api.dropboxapi.com/2/auth/token/revoke',{method:'POST',headers:{Authorization:'Bearer '+access},
    redirect:'error',cache:'no-store',signal:AbortSignal.timeout(30000)});
  return response.status;
}
async function intercept(message,send) {
  const {request,requestId} = message, url = new URL(request.url);
  if (url.origin === 'https://www.dropbox.com' && url.pathname === '/oauth2/authorize') {
    check(approval && request.method === 'GET','Unexpected sign-in navigation.');
    const result = approval;
    approval = undefined;
    const pending = consent.expectAuthorization(url.href);
    pending.then(result.resolve,result.reject);
    if (rehearsal) {
      rehearsalChallenge = url.searchParams.get('code_challenge');
      const callback = new URL('/',origin);
      callback.search = new URLSearchParams({state:url.searchParams.get('state'),code:'fictional-code'}).toString();
      const response = await fetch(callback,{redirect:'manual'});
      check(response.status === 303,'The rehearsal consent handoff failed.');
    } else console.log('READY · Dropbox approval '+(grants+1)+' is available on the local consent page.');
    return send('Fetch.fulfillRequest',{requestId,responseCode:204});
  }
  if (offline) return send('Fetch.failRequest',{requestId,errorReason:'InternetDisconnected'});
  if (!['api.dropboxapi.com','content.dropboxapi.com'].includes(url.hostname)) return providerReply(message,send,origin);
  const headers = new Headers(request.headers);
  const responseHeaders = new Headers({'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Methods':'POST, OPTIONS',
    'Access-Control-Allow-Headers':'Authorization, Content-Type, Dropbox-API-Arg','Access-Control-Expose-Headers':'Dropbox-API-Result, Retry-After',
    'Cache-Control':'no-store','Content-Type':'application/json'});
  let reply;
  if (request.method === 'OPTIONS') reply = {status:204,bytes:Buffer.alloc(0)};
  else {
    check(url.protocol === 'https:' && request.method === 'POST' && !url.search,'Unexpected provider request.');
    const payload = request.postDataEntries?.length ? Buffer.concat(request.postDataEntries.map(part=>Buffer.from(part.bytes??'','base64'))) : Buffer.from(request.postData??'');
    if (url.origin === 'https://api.dropboxapi.com' && url.pathname === '/oauth2/token') reply = await tokenRequest(payload.toString());
    else {
      check(token && headers.get('Authorization') === 'Bearer '+token,'Unexpected Dropbox session.');
      if (url.origin === 'https://api.dropboxapi.com' && url.pathname === '/2/auth/token/revoke') {
        if (signOutAfterCleanup && prepared) {
          await folder.cleanup(token);
          prepared = false;
          console.log('PASS · Temporary Dropbox folder removed before the app revoked its grant.');
        }
        reply = {status:await revoke(token),bytes:Buffer.from('null')};
        if (reply.status===200) token = undefined;
      } else {
        const endpoint = endpoints.get(url.pathname);
        check(endpoint && prepared && url.hostname === (['upload','download'].includes(endpoint)?'content':'api')+'.dropboxapi.com','Unexpected Dropbox route.');
        const args = JSON.parse(headers.get('Dropbox-API-Arg') ?? payload.toString());
        const file = /^(watched|ratings|lists|shows|settings|summary)\.csv$|^README\.txt$|^(completion|csvtv-reset)\.json$/.exec(String(args.path).split('/').at(-1))?.[0] ?? 'directory';
        trace(endpoint+' '+file);
        if (endpoint === 'list') listRequests++;
        reply = await folder.forward(endpoint,token,args,payload);
        trace(endpoint+' '+file+' HTTP '+reply.status);
        if (clear && reply.status >= 400 && refused.length < 12) {
          let summary;
          try { summary = JSON.parse(reply.bytes).error_summary; } catch { /* HTTP status suffices. */ }
          if (!(reply.status === 409 && typeof summary === 'string' && /^(?:path|path_lookup)\/not_found\//.test(summary)))
            refused.push(stage+' · '+endpoint+' '+file+' HTTP '+reply.status);
        }
        if (endpoint === 'download') responseHeaders.set('Content-Type','application/octet-stream');
        if (reply.metadata) responseHeaders.set('Dropbox-API-Result',reply.metadata);
        if (reply.retryAfter) responseHeaders.set('Retry-After',reply.retryAfter);
      }
    }
  }
  await send('Fetch.fulfillRequest',{requestId,responseCode:reply.status,body:Buffer.from(reply.bytes).toString('base64'),
    responseHeaders:[...responseHeaders].map(([name,value])=>({name,value}))});
}
async function signIn() {
  const request = Promise.withResolvers();
  approval = request;
  await beginSignIn(browser,origin,publicKey);
  const {code,state} = await request.promise;
  const url = new URL(origin+'/');
  url.search = new URLSearchParams({code,state}).toString();
  // The release scrubs its own one-use callback URL on entry.
  const result = await browser.send('Page.navigate',{url:url.href});
  check(!result.errorText,'The release could not open its callback.');
  // Let the real callback commit the exchanged grant before routing the tab to Library.
  await until(()=>browser.evaluate(`(async () => {
    if (location.search || !document.querySelector('#app')?.dataset.page) return false;
    const db = await new Promise((ok,no) => { const r=indexedDB.open('csvTV'); r.onsuccess=()=>ok(r.result); r.onerror=()=>no(); });
    try { return await new Promise((ok,no) => {
      const r=db.transaction('local').objectStore('local').get('dropboxSession');
      r.onsuccess=()=>ok(!!r.result?.instanceId); r.onerror=()=>no();
    }); } finally { db.close(); }
  })()`),'committed Dropbox sign-in',120000);
}
async function exercise() {
  publicKey = await consent.publicKey;
  browser = await openChromium(profile,async (message,send) => {
    try { await intercept(message,send); }
    catch (error) { failed.reject(error); throw error; }
  },{dropboxReleaseCheck:true});
  stage = 'first authorization';
  await signIn();
  stage = 'initial Library sync';
  await waitSynced(browser,origin,7);
  stage = 'saving provider keys';
  await saveProviderKeys(browser,origin,description=>{stage=description;});
  stage = 'independent verification of provider keys';
  savedSettingsRev = await verifyKeys();
  stage = 'independent verification of the original record';
  const initial = await verifyRecord(7,true);
  savedRatingsRev = initial.ratings; savedListsRev = initial.lists;
  console.log('PASS · Downloaded and verified all four dummy provider keys in '+(rehearsal ? 'fictional' : 'live')+' settings.csv.');
  if (clear) {
    const backups = async () => {
      const listing = await folder.forward('list',token,{path:'/backups',recursive:true});
      check(listing.status === 200,'Cannot independently inspect the fictional backups.');
      const entries = JSON.parse(listing.bytes).entries;
      if (entries.some(entry=>entry['.tag']==='folder' && entry.path_lower==='/backups'))
        trace('recursive listing included queried backup folder');
      return entries.filter(entry=>entry['.tag'] === 'file' && entry.size > 0);
    };
    const probes = {read,verifyKeys,verifyRecord,backups,onStage:value=>{stage=value;}};
    if (controls) await exerciseManagement(browser,origin,{...probes,profile,listRequests:()=>listRequests});
    await exerciseClear(browser,origin,probes);
    if (controls) {
      stage = 'sign-out after all checks';
      await browser.navigate(origin+'/#/settings');
      await until(()=>browser.evaluate("!!document.querySelector('[data-sign-out]:enabled')?.getClientRects().length"),'available Sign out',90000);
      signOutAfterCleanup = true;
      await browser.click('[data-sign-out]');
      await until(async ()=>!token && !prepared && await browser.evaluate("!!document.querySelector('[data-sign-in]:enabled')?.getClientRects().length && document.querySelector('[data-sign-out]').hidden"),'successful sign-out and revoked grant',180000);
      console.log('PASS · Sign out revoked the grant and Settings offered Sign in again.');
    }
    return;
  }
  stage = 'signed-out offline edit';
  await signOutAndEditOffline(browser,origin,async ()=>{
    await until(()=>!token,'revocation of the first grant');
    offline=true;
  });
  check(offline && !token,'The first Dropbox grant was not revoked before the offline edit.');
  console.log('PASS · Signed out, edited the fictional rating and Watchlist offline and reopened the record.');
  offline = false;
  await browser.offline(false);
  stage = 'second authorization';
  await signIn();
  stage = 'same-account reconciliation';
  await waitSynced(browser,origin,8);
  const final = await verifyRecord(8,false);
  check(final.ratings !== savedRatingsRev && final.lists !== savedListsRev,'Missing new record revisions.');
  await verifyKeys();
  check(grants===2,'The live check requires two grants.');
  console.log('PASS · Same-account reauthorization synced rating 8 and the Watchlist removal. One episode play and all four keys were preserved.');
}
let passed = false;
try {
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(8765,'localhost',resolve);});
  console.log('Release '+build.slice(0,16)+(rehearsal ? ' · Fictional Dropbox rehearsal' : ' · Open '+origin+consent.path));
  await Promise.race([exercise(),failed.promise]);
  passed = true;
} catch (error) {
  console.error('Live Dropbox check stopped during '+stage+'.');
  // Print known test code locations and operation names only. Provider bodies, grants, URLs and account IDs stay private.
  for (const line of String(error.stack ?? '').split('\n').slice(1,10)) {
    const location = /[/\\]([\w-]+\.mjs):(\d+):(\d+)/.exec(line);
    if (location) console.error('  '+location.slice(1).join(':'));
  }
  if (recent.length) console.error('Recent Dropbox operations · '+recent.join(', '));
  if (refused.length) console.error('Dropbox refusals during the clear test · '+refused.join(', '));
  const summary = await browser?.send('Runtime.evaluate',{expression:`(() => ({
    synced:document.querySelector('.sync-state')?.textContent === 'Synced',
    expectedShow:document.querySelector('.library-grid strong')?.textContent === 'The Listening House',
    libraryRating:/^(?:7|8)\\/10$/.test(document.querySelector('.library-rating')?.textContent),
    dialog:!!document.querySelector('dialog[open]'), online:navigator.onLine,
    saved:document.querySelector('#tmdb-key-label ~ [data-key-status]')?.textContent === 'Saved in Dropbox'
  }))()`,returnByValue:true}).catch(()=>null);
  if (summary?.result?.value) console.error('Browser state · '+JSON.stringify(summary.result.value));
  if (rehearsal) console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (prepared) {
    try {
      if (!token) throw Error();
      await folder.cleanup(token);
      console.log('PASS · Temporary Dropbox folder removed.');
    } catch {
      console.error('Cleanup pending for the fictional folder '+folder.path);
      process.exitCode = 1;
    }
  }
  if (token) {
    try { if (await revoke(token)!==200) throw Error(); console.log('PASS · Test grant revoked.'); }
    catch { console.error('Final grant revocation could not be confirmed.'); process.exitCode = 1; }
  }
  token = undefined;
  consent.markDone(passed && !process.exitCode);
  await rm(profile,{recursive:true,force:true,maxRetries:8,retryDelay:150});
  await new Promise(resolve=>setTimeout(resolve,2000));
  consent.close();
  server.closeAllConnections();
  server.close();
}
