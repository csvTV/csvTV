import { DropboxAuth } from '../dist/dropbox-auth.js';
import { DropboxController } from '../dist/dropbox-controller.js';
import { DropboxDialogs } from '../dist/dropbox-dialogs.js';
import { openDeviceStore } from '../dist/storage.js';
import { DropboxApi } from '../dist/dropbox-api.js';
import { DropboxSync } from '../dist/dropbox-sync.js';
import { restoreBackup } from '../dist/dropbox-restore.js';
import { writeCsv, readCsv } from '../dist/csv.js';
import { fictionalDropboxTransport } from './dropbox-roundtrip-cases.mjs';

function check(ok, message) { if (!ok) throw Error(message); }
const now = Date.now();
const seed = { accountId: 'dbid:first-test', appKey:'public-key', instanceId: 'initial', accessToken: 'fictional-a', refreshToken: 'fictional-r',
  accessExpiresAt: now + 3600_000, signInDeadline: now + 7 * 86_400_000, providerExpiresAt: now + 7 * 86_400_000 };
const answer = data => ({ status: 200, bytes: new TextEncoder().encode(JSON.stringify(data)), metadata: null });
async function withStore(body) {
  const name = 'csvTV-dropbox-auth-test-' + crypto.randomUUID();
  const store = await openDeviceStore({ name });
  try { await store.whenWriter(); await body(store, name); } finally {
    store.close();
    await new Promise((resolve, reject) => {
      const r = indexedDB.deleteDatabase(name); r.onsuccess = resolve; r.onerror = () => reject(r.error);
    });
  }
}
function delay() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
async function approvedCallback(writer,appKey, createdAt) {
  const state = crypto.randomUUID(), attemptId = crypto.randomUUID();
  const eraseGeneration = String(await writer.startDropboxAttempt(attemptId));
  sessionStorage.setItem('csvTV/dropbox-attempt-v2',JSON.stringify({state,createdAt}));
  return {ticket:{state,createdAt,appKey,verifier:'fixture',uri:location.origin,attemptId,eraseGeneration},code:'fixture'};
}

export async function dropboxProtocolCases(run) {
  await run('Renewal keeps the reviewed record revision and rejects retired credentials, erase and replacement grants', () =>
    withStore(async writer => {
      const grant = {...seed,completedAttempt:'fictional-completed-attempt'};
      await writer.storeExchangedSession(grant);
      const {erased} = await writer.dropboxAttemptFence(), before = await writer.recordRevision();
      const newerExpiry = grant.accessExpiresAt + 180_000;
      check(await writer.saveDropboxRenewal(grant,grant.accessToken,newerExpiry,erased,()=>true),'Existing grant could not renew');
      check(await writer.recordRevision() === before,'Renewal invalidated a record review');
      let staleBinding = false;
      try {
        await writer.commit(before,{local:{syncAppKey:grant.appKey,dropboxSession:grant}},
          {syncWrite:true,current:()=>true,requireDropboxAccess:{accessToken:grant.accessToken,accessExpiresAt:grant.accessExpiresAt}});
      } catch (error) { staleBinding = error.name === 'StaleSnapshotError'; }
      check(staleBinding,'A one-time registration write replaced a newer access expiry');
      await writer.saveDropboxRenewal(grant,'obsolete-access',newerExpiry+10_000,erased,()=>true);
      const authorized = (await writer.dropboxAuthState(undefined,'request')).session;
      check(authorized.accessToken === grant.accessToken && authorized.accessExpiresAt === newerExpiry &&
        authorized.refreshToken === grant.refreshToken && authorized.completedAttempt === grant.completedAttempt &&
        authorized.signInDeadline === grant.signInDeadline && authorized.providerExpiresAt === grant.providerExpiresAt,
        'The stale reply overwrote renewed access or changed the absolute grant');
      await writer.commit(before,{put:{ratings:[{show_id:7,show:'Polar Night',rating:8}]}});
      check(await writer.recordRevision() !== before,'An actual rating edit kept an old clear review valid');
      check(!await writer.saveDropboxRenewal(authorized,'expired-access',newerExpiry,erased,()=>false),'A late write passed final admission');
      await writer.storeExchangedSession({...grant,instanceId:'later-login'});
      check(!await writer.saveDropboxRenewal(authorized,'retired-access',newerExpiry,erased,()=>true),'A retired grant changed a fresh sign-in');
      await writer.eraseDevice(await writer.recordRevision());
      await writer.storeExchangedSession(grant);
      check(!await writer.saveDropboxRenewal(grant,'retired-access',newerExpiry,erased,()=>true),'A pre-erase reply changed a new record');
      check((await writer.dropboxAuthState(undefined,'request')).session.accessExpiresAt === grant.accessExpiresAt,
        'Refusing the pre-erase reply changed the new grant');
    }));
  await run('A confirmed Dropbox code claim survives a closed tab and profile reopen before the provider answers', () =>
    withStore(async (writer,name) => {
      const returning = await openDeviceStore({name});
      const id = crypto.randomUUID(), erased = await writer.startDropboxAttempt(id);
      try {
        const first = await returning.claimDropboxAttempt(id,String(erased),()=>true);
        check(first && first.erased === erased,'The returning reader could not reserve the code');
        check(!await writer.claimDropboxAttempt(id,String(erased),()=>true),'A second connection reserved the same code');
      } finally { await returning.closeForUpdate(); }
      await writer.closeForUpdate();
      const reopened = await openDeviceStore({name});
      try {
        await reopened.whenWriter();
        check(!await reopened.claimDropboxAttempt(id,String(erased),()=>true),'Reopening permitted a second dispatch of an interrupted exchange');
        const next = crypto.randomUUID();
        await reopened.startDropboxAttempt(next);
        const fresh = await reopened.claimDropboxAttempt(next,String(erased),()=>true);
        await reopened.storeExchangedSession({...seed,completedAttempt:next},()=>true,fresh.erased,fresh.id);
        check((await reopened.dropboxAttemptFence()).attempt === 'consumed','A new sign-in could not complete after an interrupted exchange');
        check(await reopened.claimDropboxAttempt(next,String(erased),()=>true) === 'completed','A completed duplicate asked to sign in again');
        check(await reopened.claimDropboxAttempt(id,String(erased),()=>true) === 'replaced','An unrelated return was mistaken for the completed sign-in');
        check(!Object.hasOwn((await reopened.dropboxState()).session,'completedAttempt'),'Display state contained a sign-in attempt');
      } finally { await reopened.closeForUpdate(); }
    }));
  await run('A superseded Dropbox attempt cannot store its grant through another database connection or after reopening', () =>
    withStore(async (writer,name) => {
      const returning = await openDeviceStore({name});
      try {
        const first = await writer.startDropboxAttempt('first-test-attempt');
        const latest = await writer.startDropboxAttempt('latest-test-attempt');
        check((await returning.dropboxAttemptFence()).attempt === 'latest-test-attempt','A returning tab missed the latest authorization');
        async function rejectOld() {
          let error;
          try { await returning.storeExchangedSession(seed,()=>true,first,'first-test-attempt'); }
          catch (reason) { error = reason; }
          check(error?.name === 'StaleSnapshotError','An older grant replaced the latest sign-in');
        }
        await rejectOld();
        const newest = {...seed,accountId:'dbid:new-test',instanceId:'new-test-session'};
        await returning.storeExchangedSession(newest,()=>true,latest,'latest-test-attempt');
        await rejectOld();
        check((await writer.dropboxState()).accountId === newest.accountId,'The first account was linked by a superseded exchange');
      } finally { returning.close(); }
      writer.close();
      const reopened = await openDeviceStore({name});
      try {
        check((await reopened.dropboxState()).session.instanceId === 'new-test-session','Reopening selected the stale grant');
        check((await reopened.dropboxAttemptFence()).attempt === 'consumed','Reopening revived a consumed authorization');
      } finally { reopened.close(); }
    }));
  await run('An initial backup marker survives database reopen without invalidating edits or transferring across accounts', () =>
    withStore(async (store,name) => {
      const session = {...seed,accessToken:'example-access'};
      await store.storeExchangedSession(session);
      const before = await store.snapshot();
      const cloud = fictionalDropboxTransport();
      const auth = new DropboxAuth(store,'public-development-key',{transport:cloud.transport});
      const controller = new DropboxController(auth,window,new DropboxDialogs(document));
      try {
        const {api} = await controller.backupAccess();
        const release = await api.reserveBackup('2026-01-12-12345678-abcd-4abc-9000-abcdef123456');
        await release();
        const path = '/csvtv-reset.json', saved = cloud.files.get(path);
        cloud.files.delete(path);
        let reason = '';
        try { await controller.backupAccess(); } catch (error) { reason = error.message; }
        check(reason.includes('marker is missing') && !cloud.files.has(path),'The same tab treated its newly missing marker as a new folder');
        cloud.files.set(path,saved);
        await controller.backupAccess();
      } finally { controller.close(); }
      check((await store.snapshot()).revision === before.revision,'Observing the first marker invalidated the reviewed record');
      store.close();
      const reopened = await openDeviceStore({name});
      try {
        await reopened.whenWriter();
        check((await reopened.dropboxResetState(seed.accountId)).seen,'Reopening forgot the original marker');
        const other = {...seed,instanceId:'replacement',accountId:'dbid:other'};
        check(!(await reopened.dropboxResetState(other.accountId)).seen,'A different account inherited the marker');
        let refused = false;
        try { await reopened.rememberDropboxMarker(other,()=>true); } catch { refused = true; }
        check(refused && (await reopened.dropboxResetState(seed.accountId)).seen,'A stale sign-in changed the marker witness');
      } finally { reopened.close(); }
    }));
  await run('A rate-limited Dropbox restore preserves its receipt across a real database reopen and recovers on the next eligible sync', () =>
    withStore(async (store, name) => {
      const cloud = fictionalDropboxTransport(), session = {...seed,accessToken:'example-access'};
      const row = {show_id:7,show:'Polar Night',season:0,episode:1,episode_id:71,title:'Pilot',times_watched:2};
      const content = writeCsv('watched',[row]);
      let clock = now, limit = true, requests = 0, accepted = 0;
      const transport = async req => {
        requests++;
        const path = JSON.parse(req.headers['Dropbox-API-Arg'] ?? req.body).path;
        if (req.endpoint === 'upload' && path === '/watched.csv') {
          if (limit) return {status:429,bytes:new Uint8Array(),metadata:null,retryAfter:'120'};
          accepted++;
        }
        return cloud.transport(req);
      };
      const open = db => {
        const auth = new DropboxAuth(db, 'fictional-public-key', {now:() => clock, online:() => true, transport});
        const api = new DropboxApi(auth, session);
        return {auth,api,sync:new DropboxSync(db,api,session,{},() => clock)};
      };
      await store.storeExchangedSession(session);
      const first = open(store);
      try {
        const report = await restoreBackup(first.api, first.sync, new Map([
          ['watched',content],['ratings',writeCsv('ratings',[{show_id:7,show:'Polar Night',rating:0}])],
        ]));
        check(report.files.get('watched') === 'unknown' && report.files.get('ratings') === 'untouched' && report.issue,
          'The failed restore misreported its file outcomes');
        const saved = await store.snapshot();
        check(saved.sync.watched.pending.content === content && saved.tables.watched[0].times_watched === 2 &&
          !saved.tables.ratings.length && accepted === 0, 'The rate limit lost the pending bytes or touched the next file');
      } finally {first.auth.close(); store.close();}
      const reopened = await openDeviceStore({name});
      await reopened.whenWriter();
      const next = open(reopened);
      try {
        const before = requests;
        await next.sync.run().then(() => {throw Error('The cooldown permitted an early request');}, error =>
          check(error.kind === 'throttled', 'The pending operation failed for the wrong reason'));
        check(requests === before && (await reopened.snapshot()).sync.watched.pending.content === content,
          'Reopening bypassed the account cooldown');
        limit = false; clock += 120_000;
        check((await next.sync.run()).complete, 'The eligible sync failed to recover the restore');
        const after = await reopened.snapshot();
        check(accepted === 1 && !after.sync.watched.pending && after.tables.watched[0].times_watched === 2 &&
          !after.tables.ratings.length && readCsv('watched',cloud.files.get('/watched.csv').bytes).rows[0].times_watched === 2,
          'Recovery replayed an unselected action or lost watches');
      } finally {next.auth.close();reopened.close();}
    }));
  await run('Changing the registration while another tab exchanges a code never links the old registration', () =>
    withStore(async (writer, name) => {
      const reader = await openDeviceStore({name}), waiting = delay(), sending = delay();
      let key = 'fictional-first-key';
      const oauth = new DropboxAuth(reader, () => key, { transport: async () => {
        sending.resolve(); await waiting.promise;
        return answer({account_id:'fictional-owner',access_token:'fictional-access',refresh_token:'fictional-refresh',expires_in:60});
      } });
      const callback = () => approvedCallback(writer,key,Date.now());
      try {
        const exchange = oauth.finishCallback(window, await callback()).catch(error => error);
        await sending.promise;
        check(await writer.saveDropboxRegistration(() => { key = 'fictional-next-key'; return true; }),
          'An unlinked writer could not change its registration');
        waiting.resolve();
        check((await exchange)?.kind === 'callback', 'The returning tab accepted credentials for the old registration');
        check((await writer.dropboxState()).accountId === null, 'The stale exchange bound the owner');
        const commit = reader.storeExchangedSession.bind(reader);
        reader.storeExchangedSession = async (...args) => {
          await writer.saveDropboxRegistration(() => { key = 'fictional-last-key'; return true; });
          return commit(...args);
        };
        check((await oauth.finishCallback(window, await callback()).catch(error => error))?.kind === 'callback',
          'Changing the registration at local transaction admission still linked an old sign-in');
        reader.storeExchangedSession = commit;
        check(await oauth.finishCallback(window, await callback()), 'The current registration could not sign in');
        check(!await writer.saveDropboxRegistration(() => { throw Error('Replaced a linked registration'); }),
          'Changing the registration after the owner was linked was accepted');
      } finally { waiting.resolve(); oauth.close(); reader.close(); }
    }));

  await run('A reader can finish its code exchange; the writer is notified and fences its old account before applying a reply', () =>
    withStore(async (writer, name) => {
      await writer.storeExchangedSession(seed);
      const reader = await openDeviceStore({ name });
      const waiting = delay(), sending = delay();
      const active = new DropboxAuth(writer, 'public-key', { now: () => now, online: () => true,
        transport: async request => {
          check(request.headers.Authorization === 'Bearer fictional-a', 'The writer used different credentials');
          sending.resolve(); await waiting.promise; return answer({});
        } });
      const oauth = new DropboxAuth(reader, 'public-key', { now: () => now, online: () => true,
        transport: async () => answer({ account_id: 'dbid:other-test', access_token: 'fictional-b', refresh_token: 'fictional-r2', expires_in: 60 }) });
      try {
        const request = active.request({ endpoint: 'list' }, seed).catch(e => e);
        await sending.promise;
        const notified = delay(); active.addEventListener('change', notified.resolve, { once: true });
        await oauth.finishCallback(window, await approvedCallback(writer,'public-key',now));
        await notified.promise;
        waiting.resolve();
        check((await request).kind === 'account-changed', 'The writer accepted a reply from a superseded session');
        const s = await writer.dropboxState();
        check(s.accountId === seed.accountId && s.session.accountId === 'dbid:other-test' && s.session.instanceId !== seed.instanceId,
          'Finishing OAuth rebound the owner, failed to generate a new instance or lost the proposed destination');
      } finally { waiting.resolve(); active.close(); oauth.close(); reader.close(); }
    }));

  await run('Deadline sign-out preserves the committed watch, base and pending across reopen even when revocation is unreachable', () =>
    withStore(async (store, name) => {
      const watched = [{ show_id: 7, show: 'Fixture', season: 1, episode: 1, episode_id: 71, title: 'One', times_watched: 2 }];
      const pending = { content: 'two', targetRevision: 'r1', targetModified: '2026-01-01T00:00:00Z', targetContent: 'one',
        clientModified: '2026-01-01T00:00:01Z', preparedAt: now };
      await store.commit((await store.snapshot()).revision, { put: { watched }, sync: { watched: {
        base: { revision: 'r1', content: 'one' }, lastClientModified: pending.clientModified, pending } } });
      await store.storeExchangedSession(seed);
      let clock = now, sent = false;
      const auth = new DropboxAuth(store, 'public-key', { now: () => clock, online: () => false,
        transport: async () => { sent = true; return answer({}); } });
      try {
        clock = seed.signInDeadline;
        await auth.checkDeadline();
        check(!sent, 'An offline transfer was sent');
      } finally { auth.close(); }
      store.close();
      const reopened = await openDeviceStore({ name });
      try {
        const s = await reopened.whenWriter();
        check(s.local.dropboxSession == null && s.local.syncAccountId === seed.accountId && s.tables.watched[0].times_watched === 2 &&
          s.sync.watched.base.revision === 'r1' && s.sync.watched.pending.content === 'two', 'Deadline cleanup changed recoverable state');
      } finally { reopened.close(); }
    }));
}
