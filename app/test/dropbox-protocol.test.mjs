import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DropboxAuth, captureDropboxCallback as capture, prepareDropboxCallback as prepare } from '../src/dropbox-auth.ts';
import { DropboxApi, dropboxContentHash } from '../src/dropbox-api.ts';
import { DropboxError, checkResponse, dropboxTransport } from '../src/dropbox-client.ts';
import { dropboxSessionInfo, StaleSnapshotError } from '../src/storage.ts';

const now = Date.UTC(2026, 10, 18, 12);
const week = 7 * 86_400_000;
const attemptLifetime = 15 * 60_000;
const captureDropboxCallback = win => capture(win,now);
const prepareDropboxCallback = win => prepare(win,()=>now);
const original = { accountId: 'fictional-one', appKey:'public-dev-app', instanceId: 'first', accessToken: 'access-one',
  refreshToken: 'refresh-one', accessExpiresAt: now + 5000, signInDeadline: now + week, providerExpiresAt: now + week };
const text = value => new TextEncoder().encode(value);
const response = (data = {}, status = 200) => ({ bytes: text(JSON.stringify(data)), status, metadata: null });
const errorOf = kind => e => e instanceof DropboxError && e.kind === kind;
class Store extends EventTarget {
  role = 'writer'; revision = 0n; owner; session; recordAppKey;
  eraseGeneration = 0n;
  attempt = null;
  async startDropboxAttempt(id) { this.attempt = id; return this.eraseGeneration; }
  async dropboxAttemptFence() { return {erased:this.eraseGeneration,attempt:this.attempt}; }
  async claimDropboxAttempt(id,erased,current) {
    const claim = 'submitted:'+(id ?? 'legacy');
    if (!current() || String(this.eraseGeneration) !== erased) throw new StaleSnapshotError();
    if (this.attempt === claim) return null;
    if (this.attempt === 'consumed' && this.session) return id && this.session.completedAttempt === id ? 'completed' : 'replaced';
    if (this.attempt !== id) throw new StaleSnapshotError();
    this.attempt = claim;
    return {id:claim,erased:this.eraseGeneration};
  }
  cooldowns = new Map();
  constructor(value = original) { super(); this.session = structuredClone(value); this.owner = value?.accountId ?? null; this.recordAppKey = value?.appKey ?? null; }
  async dropboxAuthState(account) { return { accountId: this.owner, recordAppKey:this.recordAppKey, session: structuredClone(this.session), revision: this.revision, cooldown:this.cooldowns.get(account) }; }
  async dropboxState() {
    const state = await this.dropboxAuthState();
    return {...state,session:state.session && dropboxSessionInfo(state.session)};
  }
  async saveDropboxCooldown(binding, value, current) {
    if (!current() || binding.instanceId !== this.session?.instanceId) throw new StaleSnapshotError();
    if (value) this.cooldowns.set(binding.accountId, value); else this.cooldowns.delete(binding.accountId);
  }
  async saveDropboxRenewal(expected,accessToken,accessExpiresAt,erased,current) {
    if (!current() || this.role !== 'writer' || this.eraseGeneration !== erased || this.owner !== expected.accountId ||
        this.session?.instanceId !== expected.instanceId) return false;
    if (this.session.accessToken === expected.accessToken && this.session.accessExpiresAt === expected.accessExpiresAt)
      Object.assign(this.session,{accessToken,accessExpiresAt});
    return true;
  }
  async commit(revision, change, options = {}) {
    if (revision !== this.revision || (options.current && !options.current())) throw new StaleSnapshotError();
    if (options.requireDropboxAccess && (this.session?.accessToken !== options.requireDropboxAccess.accessToken ||
        this.session?.accessExpiresAt !== options.requireDropboxAccess.accessExpiresAt)) throw new StaleSnapshotError();
    if (change.local?.syncAppKey) this.recordAppKey = change.local.syncAppKey;
    if (change.local?.dropboxSession) this.session = structuredClone(change.local.dropboxSession);
    if (change.removeLocal?.includes('dropboxSession')) this.session = null;
    this.revision++;
  }
  async storeExchangedSession(session, current, generation, attempt = null) {
    if ((current && !current()) || (generation !== undefined && (generation !== this.eraseGeneration || attempt !== this.attempt))) throw new StaleSnapshotError();
    if (generation !== undefined) this.attempt = 'consumed';
    if (!this.owner) this.recordAppKey = session.appKey ?? null;
    this.owner ??= session.accountId; this.session = structuredClone(session); this.revision++;
  }
}
function fixture(t, send, value = original) {
  const store = new Store(value), time = { now }, calls = [];
  const auth = new DropboxAuth(store, 'public-dev-app', { now: () => time.now, online: () => true,
    sleep: async ms => { time.now += ms; },
    transport: async request => { calls.push(request); return send(request, { time, calls, store }); } });
  t.after(() => auth.close());
  return { auth, store, time, calls };
}
function tab(initial = 'http://localhost:8765/#/settings') {
  const url = new URL(initial), memory = new Map();
  const win = Object.assign(new EventTarget(), { location: { href: url.href, assign: target => win.destination = new URL(target) },
    history: { state: {}, replaceState: (_, __, value) => { win.location.href = value; } },
    sessionStorage: { setItem: (k, v) => memory.set(k, v), getItem: k => memory.get(k) ?? null, removeItem: k => memory.delete(k) } });
  return win;
}
function returned(win, state = win.destination.searchParams.get('state')) {
  win.location.href = 'http://localhost:8765/?code=fictional-code&state=' + state + '#/settings';
}

test('Dropbox authorization and return use the exact address of each installation', async t => {
  for (const uri of ['https://my-watch-log.example/', 'https://shows.example:8443/tracker/', 'https://shows.example/tracker/index.html']) {
    const {auth} = fixture(t, () => assert.fail('No token exchange expected'), null);
    const win = tab(uri + '?source=bookmark#/settings');
    await auth.authorize(win);
    assert.equal(win.destination.searchParams.get('redirect_uri'), uri);
    const params = new URLSearchParams({code:'fictional-code', state:win.destination.searchParams.get('state')});
    win.location.href = uri + '?' + params;
    assert.equal(captureDropboxCallback(win)?.ticket?.uri, uri);
  }
});

test('an upload reply received as the browser goes offline keeps its exact outcome for the original grant',async t=>{
  const bytes = text('show_id,show,rating\r\n7,Fictional Relay,8\r\n'), hash = await dropboxContentHash(bytes);
  for (const outcome of ['accepted','conflict','new sign-in','expired']) {
    const store = new Store();
    let online = true, clock = now, sends = 0;
    const auth = new DropboxAuth(store,'public-dev-app',{now:()=>clock,online:()=>online,transport:async request=>{
      sends++;
      assert.equal(request.endpoint,'upload');
      online = false;
      if (outcome === 'new sign-in') store.session = {...original,instanceId:'replacement'};
      if (outcome === 'expired') clock = original.signInDeadline;
      if (outcome === 'conflict') return response({error:{'.tag':'path',path:{'.tag':'conflict'}}},409);
      const stamp = new Date(now).toISOString();
      return response({name:'ratings.csv',path_display:'/ratings.csv',rev:'r2',size:bytes.length,
        server_modified:stamp,client_modified:stamp,content_hash:hash});
    }});
    t.after(()=>auth.close());
    const api = new DropboxApi(auth,original), transfer = api.upload('/ratings.csv',bytes,{mode:'update',revision:'r1'});
    if (outcome === 'accepted') assert.equal((await transfer).rev,'r2');
    else await assert.rejects(transfer,errorOf(outcome === 'new sign-in' ? 'account-changed' : outcome));
    if (outcome === 'accepted' || outcome === 'conflict') await assert.rejects(api.list(''),errorOf('unavailable'));
    assert.equal(sends,1);
  }
});

test('a renewal response that arrives before disconnection is kept without starting another request',async t=>{
  for (const success of [true,false]) {
    const store = new Store({...original,accessExpiresAt:now-1});
    const calls = [];
    let online = true;
    const auth = new DropboxAuth(store,'public-dev-app',{now:()=>now,online:()=>online,transport:async req=>{
      calls.push(req.endpoint);online = false;
      return success ? response({access_token:'fictional-renewed',expires_in:3600}) : response({error:'invalid_grant'},400);
    }});
    t.after(()=>auth.close());
    await assert.rejects(auth.request({endpoint:'list'},original),errorOf(success ? 'unavailable' : 'signed-out'));
    assert.deepEqual(calls,['token']);
    if (success) assert.equal(store.session.accessToken,'fictional-renewed');
    else assert.equal(store.session,null);
  }
});

test('An existing grant proves its registration by renewal before sync or sign-out; a temporary failure preserves it', async t => {
  for (const finish of ['sync','sign out']) {
    const legacy = {...original}; delete legacy.appKey;
    let answer = 503;
    const {auth,store,calls} = fixture(t,request=>{
      if (request.endpoint === 'token') {
        const form = new URLSearchParams(request.body);
        assert.equal(form.get('client_id'),'public-dev-app');
        assert.equal(form.get('refresh_token'),legacy.refreshToken);
        return response({access_token:'renewed-fixture',expires_in:120},answer);
      }
      return response();
    },legacy);
    await assert.rejects(auth.request({endpoint:'list'}),errorOf('provider-unavailable'));
    assert.equal(store.recordAppKey,null);
    assert.deepEqual(store.session,legacy);
    assert.deepEqual(calls.map(call=>call.endpoint),['token']);
    answer = 200;
    if (finish === 'sync') {
      await auth.request({endpoint:'list'});
      assert.equal(store.session.appKey,'public-dev-app');
      assert.equal(calls[2].headers.Authorization,'Bearer renewed-fixture');
    } else {
      await auth.signOut();
      assert.equal(store.session,null);
      assert.deepEqual(calls.map(call=>call.endpoint),['token','token','revoke']);
    }
    assert.equal(store.recordAppKey,'public-dev-app');
  }
});

test('verifying an older registration preserves a concurrent renewal even when its access token string repeats', async t => {
  for (const nextToken of [original.accessToken,'another-access-version']) {
    const legacy = {...original}; delete legacy.appKey;
    const newExpiry = now + 900_000;
    const {auth,store,calls} = fixture(t,request => request.endpoint === 'token'
      ? response({access_token:'registration-proof',expires_in:30}) : response(),legacy);
    const commit = store.commit.bind(store);
    let saves = 0;
    store.commit = async (revision,change,options) => {
      if (change.local?.syncAppKey && ++saves === 1)
        assert.ok(await store.saveDropboxRenewal(legacy,nextToken,newExpiry,0n,()=>true));
      return commit(revision,change,options);
    };
    await auth.request({endpoint:'list'});
    assert.equal(saves,2);
    assert.equal(store.session.accessToken,nextToken);
    assert.equal(store.session.accessExpiresAt,newExpiry);
    assert.equal(store.session.appKey,'public-dev-app');
    assert.equal(store.recordAppKey,'public-dev-app');
    assert.deepEqual(calls.map(call=>call.endpoint),['token','list']);
    assert.equal(calls[1].headers.Authorization,'Bearer '+nextToken);
  }
});

test('A newly exchanged grant requires a saved revision on its original path before any record file is used', async t => {
  for (const mode of ['matched','other revision','other path','no evidence','rate limit','changed record','replaced receipt','renewed','new grant']) {
    const candidate = {...original,appKey:'fictional-candidate',instanceId:'returning'};
    let localRevision = 'saved-watch';
    const {auth,store,calls} = fixture(t,async req=>{
      if (req.endpoint === 'revisions') {
        assert.equal(JSON.parse(req.body).path,'/watched.csv');
        if (mode === 'rate limit') return {...response({},429),retryAfter:'120'};
        if (mode === 'renewed' && req.headers.Authorization === 'Bearer access-one') return response({},401);
        if (mode === 'changed record') store.revision++;
        if (mode === 'replaced receipt' && localRevision === 'saved-watch') { localRevision = 'new-target'; store.revision++; }
        if (mode === 'new grant') await store.storeExchangedSession({...candidate,instanceId:'newer'});
        const name = mode === 'other path' ? 'ratings.csv' : 'watched.csv';
        return response({has_more:false,entries:[{name,path_display:'/'+name,rev:mode === 'other revision' ? 'different' : 'saved-watch',
          size:10,content_hash:'a'.repeat(64),client_modified:'2026-11-10T13:10:00Z',server_modified:'2026-11-10T13:11:00Z'}]});
      }
      if (mode === 'renewed' && req.endpoint === 'token') return response({access_token:'new-candidate-token',expires_in:300});
      assert.ok(['matched','changed record','renewed'].includes(mode));
      assert.equal(store.recordAppKey,'fictional-candidate');
      return response();
    },candidate);
    store.recordAppKey = null;
    store.dropboxRegistrationEvidence = async()=>({revision:store.revision,files:mode === 'no evidence' ? [] :
      [{path:'/watched.csv',revisions:[localRevision]}]});
    const result = auth.request({endpoint:'list'});
    if (['matched','changed record','renewed'].includes(mode)) {
      await result;
      assert.deepEqual(calls.map(call=>call.endpoint),mode === 'renewed' ? ['revisions','token','revisions','list'] : ['revisions','list']);
    } else {
      await assert.rejects(result,errorOf(mode === 'rate limit' ? 'throttled' : mode === 'other path' ? 'failed' :
        mode === 'new grant' ? 'account-changed' : 'unverified-folder'));
      assert.equal(store.recordAppKey,null);
      assert.deepEqual(calls.map(call=>call.endpoint),mode === 'no evidence' ? [] : mode === 'replaced receipt' ? ['revisions','revisions'] : ['revisions']);
      assert.equal(store.session.instanceId,mode === 'new grant' ? 'newer' : 'returning');
    }
  }
});

test('Sign-out shares an in-flight upgrade check and a stale browser preference can recover through the original site registration',async t=>{
  const legacy = {...original}; delete legacy.appKey;
  const store = new Store(legacy), started = Promise.withResolvers(), release = Promise.withResolvers(), keys = [];
  const auth = new DropboxAuth(store, linked=>linked ? 'fictional-stale-preference' : 'fictional-original-site',{
    now:()=>now,online:()=>true,transport:async req=>{
      if (req.endpoint === 'token') {
        const key = new URLSearchParams(req.body).get('client_id'); keys.push(key);
        if (key === 'fictional-stale-preference') return response({error:'invalid_client'},400);
        started.resolve(); await release.promise;
        return response({access_token:'renewed-fixture',expires_in:300});
      }
      assert.equal(store.recordAppKey,'fictional-original-site');
      return response();
    },
  });
  t.after(()=>auth.close());
  const file = auth.request({endpoint:'list'}).catch(error=>assert.ok(['signed-out','account-changed'].includes(error.kind)));
  await started.promise;
  const signOut = auth.signOut();
  await new Promise(resolve=>setImmediate(resolve));
  release.resolve();
  await Promise.all([file,signOut]);
  assert.deepEqual(keys,['fictional-stale-preference','fictional-original-site']);
  assert.equal(store.recordAppKey,'fictional-original-site');
  assert.equal(store.session,null);
});

test('Redirect uses PKCE, tab state and the same registered URI; callback scrubs the code before a compatible reader exchanges', async t => {
  const { auth, store, calls } = fixture(t, request => {
    const form = new URLSearchParams(request.body);
    assert.equal(form.get('redirect_uri'), 'http://localhost:8765/');
    assert.equal(form.get('refresh_token_expiration_seconds'), String((now + week) / 1000));
    assert.equal(form.has('client_secret'), false);
    const challenge = createHash('sha256').update(form.get('code_verifier')).digest('base64url');
    assert.equal(challenge, win.destination.searchParams.get('code_challenge'));
    return response({ account_id: 'destination', access_token: 'fresh', refresh_token: 'refresh', expires_in: 14400 });
  }, null);
  const win = tab();
  await auth.authorize(win);
  assert.equal(win.destination.origin + win.destination.pathname, 'https://www.dropbox.com/oauth2/authorize');
  assert.equal(win.destination.searchParams.get('client_id'),'public-dev-app');
  assert.equal(win.destination.searchParams.get('response_type'),'code');
  assert.equal(win.destination.searchParams.get('redirect_uri'),'http://localhost:8765/');
  assert.match(win.destination.searchParams.get('state'),/^[A-Za-z0-9_-]{43}$/);
  assert.equal(win.destination.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(win.destination.searchParams.get('token_access_type'), 'offline');
  assert.equal(win.destination.searchParams.get('scope'), 'files.metadata.read files.content.read files.content.write');
  returned(win);
  const callback = captureDropboxCallback(win);
  assert.equal(win.location.href, 'http://localhost:8765/#/settings');
  assert.equal(calls.length, 0);
  store.role = 'reader';
  assert.equal(await auth.finishCallback(win, callback), true);
  assert.equal(store.owner, 'destination');
  assert.equal(store.session.signInDeadline, now + week);
  assert.equal(store.session.accessExpiresAt, now + 14_400_000);
  assert.ok(store.session.instanceId);
  await assert.rejects(auth.authorize(win), errorOf('failed'));
  returned(win);
  await assert.rejects(auth.finishCallback(win), errorOf('callback'));
  assert.equal(calls.length, 1);
});

test('An expiring session is left for the current writer when the previous tab closes during the final credential read', async t => {
  const {auth,store,time,calls} = fixture(t,assert.fail);
  await new Promise(resolve=>setImmediate(resolve));
  time.now = original.signInDeadline;
  const read = store.dropboxAuthState.bind(store);
  let reads = 0;
  store.dropboxAuthState = async () => {
    const state = await read();
    if (++reads === 2) auth.close();
    return state;
  };
  assert.equal(await auth.checkDeadline(),true);
  assert.deepEqual(store.session,original);
  assert.equal(calls.length,0);
});

test('a terminated tab with an already claimed sign-in cannot make its copied return send the code, and a new sign-in can connect', async t => {
  const {auth,store,calls} = fixture(t,() => response({account_id:'new',refresh_token:'r',access_token:'a',expires_in:600}),null);
  const other = new DropboxAuth(store,'public-dev-app',{now:()=>now,transport:async () => {
    assert.fail('The other tab dispatched an already claimed code');
  }});
  t.after(()=>other.close());
  const win = tab(), copy = tab();
  await auth.authorize(win); returned(win);
  const saved = prepareDropboxCallback(win);
  for (const key of ['csvTV/dropbox-attempt-v2','csvTV/dropbox-callback-v2//']) {
    copy.sessionStorage.setItem(key,win.sessionStorage.getItem(key));
  }
  const handoff = prepareDropboxCallback(copy);
  const claim = store.claimDropboxAttempt.bind(store);
  store.claimDropboxAttempt = async (...args) => {
    const admitted = await claim(...args);
    if (admitted) auth.close();
    return admitted;
  };
  await assert.rejects(auth.finishCallback(win,saved.take()),errorOf('callback'));
  assert.equal(calls.length,0);
  await assert.rejects(other.finishCallback(copy,handoff.take()),errorOf('callback-submitted'));
  assert.equal(store.session,null);
  store.claimDropboxAttempt = claim;
  const fresh = new DropboxAuth(store,'public-dev-app',{now:()=>now,transport:async () =>
    response({account_id:'new',refresh_token:'r',access_token:'a',expires_in:600})});
  t.after(()=>fresh.close());
  await fresh.authorize(copy); returned(copy);
  assert.equal(await fresh.finishCallback(copy,captureDropboxCallback(copy)),true);
  assert.equal(store.owner,'new');
});

test('a saved copy recognizes only its completed Dropbox sign-in and never resubmits after a replacement or sign-out',async t=>{
  for (const result of ['completed','another grant','signed out']) {
    const {auth,store,calls} = fixture(t,()=>response({account_id:'one',refresh_token:'r',access_token:'a',expires_in:600}),null);
    const originalTab = tab(), duplicate = tab();
    await auth.authorize(originalTab); returned(originalTab);
    const handoff = prepareDropboxCallback(originalTab);
    for (const key of ['csvTV/dropbox-attempt-v2','csvTV/dropbox-callback-v2//']) {
      duplicate.sessionStorage.setItem(key,originalTab.sessionStorage.getItem(key));
    }
    const copy = prepareDropboxCallback(duplicate);
    assert.equal(await auth.finishCallback(originalTab,handoff.take()),true);
    assert.ok(store.session.completedAttempt);
    assert.equal(Object.hasOwn((await store.dropboxState()).session,'completedAttempt'),false);
    if (result==='another grant') store.session = {...store.session,instanceId:'another',completedAttempt:'a-later-attempt'};
    if (result==='signed out') store.session = null;
    const open = auth.finishCallback(duplicate,copy.take());
    if (result==='completed') assert.equal(await open,false);
    else await assert.rejects(open,errorOf(result==='another grant'?'callback-replaced':'callback'));
    assert.equal(calls.length,1);
  }
});

test('Missing, duplicate and mismatched state never dispatch an exchange or leave the code in the address', async t => {
  const { auth, calls } = fixture(t, () => { throw Error(); }, null);
  for (const state of ['wrong', 'x&state=y']) {
    const win = tab(); await auth.authorize(win); returned(win, state);
    await assert.rejects(auth.finishCallback(win), errorOf('callback'));
    assert.ok(!win.location.href.includes('code='));
  }
  const win = tab('http://localhost:8765/?code=abc&state=new');
  await assert.rejects(auth.finishCallback(win), errorOf('callback'));
  assert.equal(calls.length, 0);
});

test('A stale Dropbox return leaves the newer tab attempt available; a matching denial ends only its own attempt', async t => {
  const {auth,calls} = fixture(t,()=>response({account_id:'new',refresh_token:'r',access_token:'a',expires_in:600}),null);
  const win = tab();
  for (const key of ['code','error']) {
    await auth.authorize(win);
    const old = win.destination.searchParams.get('state');
    await auth.authorize(win);
    const current = win.destination.searchParams.get('state');
    win.location.href = 'http://localhost:8765/?' + key + '=old&state=' + old;
    await assert.rejects(auth.finishCallback(win),errorOf('callback'));
    assert.equal(new URL(win.location.href).search,'');
    returned(win,current);
    assert.equal(await auth.finishCallback(win),true);
  }
  await auth.authorize(win);
  const state = win.destination.searchParams.get('state');
  win.location.href = 'http://localhost:8765/?error=access_denied&state=' + state;
  await assert.rejects(auth.finishCallback(win),errorOf('callback'));
  returned(win,state);
  await assert.rejects(auth.finishCallback(win),errorOf('callback'));
  assert.equal(calls.length,2);
});

test('An ordinary reload restores only the current tab’s scrubbed, unsubmitted Dropbox callback once', async t => {
  const {auth,calls} = fixture(t,()=>response({account_id:'one',refresh_token:'r',access_token:'a',expires_in:600}),null);
  const win = tab();
  await auth.authorize(win);
  returned(win);
  const suspendedPage = prepareDropboxCallback(win);
  assert.equal(new URL(win.location.href).search,'');
  assert.equal(suspendedPage.canResumeAfterReload,true);
  const replacement = prepareDropboxCallback(win);
  assert.equal(replacement.canResumeAfterReload,true);
  assert.equal(prepareDropboxCallback(tab()).take(),null);
  assert.equal(await auth.finishCallback(win,replacement.take()),true);
  assert.equal(suspendedPage.canResumeAfterReload,false);
  assert.equal(replacement.canResumeAfterReload,false);
  assert.equal(suspendedPage.take(),null);
  assert.equal(prepareDropboxCallback(win).take(),null);
  assert.equal(calls.length,1);

  await auth.authorize(win);
  returned(win);
  const unfinished = prepareDropboxCallback(win);
  await auth.authorize(win);
  returned(win);
  const latest = prepareDropboxCallback(win);
  assert.equal(unfinished.canResumeAfterReload,false);
  assert.equal(latest.canResumeAfterReload,true);
  assert.equal(unfinished.take(),null,'An old document cannot submit its old code or consume the newer handoff');
  assert.equal(await auth.finishCallback(win,latest.take()),true);
  assert.equal(calls.length,2);
});

test('Returning to an older sign-in URL resumes the current approved handoff in the same visit', async t => {
  const {auth,calls} = fixture(t,request=>{
    assert.equal(new URLSearchParams(request.body).get('code'),'fictional-code');
    return response({account_id:'new',refresh_token:'r',access_token:'a',expires_in:600});
  },null);
  for (const key of ['code','error']) {
    const win = tab();
    await auth.authorize(win);
    const stale = win.destination.searchParams.get('state');
    await auth.authorize(win); returned(win);
    const suspended = prepareDropboxCallback(win);
    win.location.href = 'http://localhost:8765/?' + key + '=old&state=' + stale;
    const restored = prepareDropboxCallback(win);
    assert.equal(await auth.finishCallback(win,restored.take()),true);
    assert.equal(suspended.take(),null);
  }
  assert.equal(calls.length,2);
});

test('A full handoff store permits one exchange in the original document; a refused code requires a new sign-in', async t => {
  const {auth,calls,store} = fixture(t,()=>response({error:'invalid_grant'},400),null);
  const win = tab(); await auth.authorize(win); returned(win);
  win.sessionStorage.setItem = () => {throw new DOMException('','QuotaExceededError');};
  const callback = prepareDropboxCallback(win);
  assert.equal(callback.pending,true);
  assert.equal(callback.canResumeAfterReload,false);
  assert.equal(new URL(win.location.href).search,'');
  assert.equal(prepareDropboxCallback(win).take(),null);
  await assert.rejects(auth.finishCallback(win,callback.take()),errorOf('callback'));
  assert.equal(callback.take(),null);
  assert.equal(prepareDropboxCallback(win).take(),null);
  assert.equal(store.session,null);
  assert.equal(calls.length,1);

  for (const interrupt of ['leave','restart']) {
    const other = tab(); await auth.authorize(other); returned(other);
    const save = other.sessionStorage.setItem;
    other.sessionStorage.setItem = win.sessionStorage.setItem;
    const memoryOnly = prepareDropboxCallback(other);
    other.sessionStorage.setItem = save;
    if (interrupt === 'leave') other.dispatchEvent(new Event('pagehide'));
    else await auth.authorize(other);
    assert.equal(memoryOnly.take(),null,'A superseded memory-only return must be retired');
  }
  assert.equal(calls.length,1);
});

test('Erasing a device invalidates an outstanding sign-in in another tab before exchange and before local commitment',async t=>{
  for (const moment of ['before','during']) {
    const entered=Promise.withResolvers(),release=Promise.withResolvers();
    const {auth,store,calls}=fixture(t,async()=>{
      entered.resolve(); await release.promise;
      return response({account_id:'fixture',access_token:'a',refresh_token:'r',expires_in:600});
    },null);
    const win=tab(); await auth.authorize(win); returned(win);
    if (moment==='before') store.eraseGeneration++;
    const pending=auth.finishCallback(win).catch(error=>error);
    if (moment==='during') { await entered.promise; store.eraseGeneration++; }
    release.resolve();
    assert.equal((await pending).kind,'callback'); assert.equal(store.session,null);
    assert.equal(calls.length,moment==='before'?0:1);
    await auth.authorize(win); returned(win);
    assert.equal(await auth.finishCallback(win),true);
  }
});

test('a later sign-in in a different tab fences an old return and an old in-flight exchange', async t => {
  for (const moment of ['before exchange','during exchange']) {
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    const {auth,store,calls} = fixture(t,async request => {
      const code = new URLSearchParams(request.body).get('code');
      if (code === 'first') { entered.resolve(); await release.promise; }
      return response({account_id:code,access_token:'fictional-access',refresh_token:'fictional-refresh',expires_in:3600});
    },null);
    const first = tab(), latest = tab();
    await auth.authorize(first); returned(first);
    first.location.href = first.location.href.replace('fictional-code','first');
    const finishFirst = () => auth.finishCallback(first).catch(error => error);
    const delayed = moment === 'during exchange' ? finishFirst() : undefined;
    if (delayed) await entered.promise;
    await auth.authorize(latest); returned(latest);
    latest.location.href = latest.location.href.replace('fictional-code','latest');
    assert.equal(await auth.finishCallback(latest),true);
    const session = structuredClone(store.session);
    release.resolve();
    assert.equal((await (delayed ?? finishFirst())).kind,delayed ? 'callback' : 'callback-replaced');
    assert.deepEqual(store.session,session);
    assert.equal(store.session.accountId,'latest');
    assert.equal(calls.length,delayed ? 2 : 1,'a superseded return must stop before dispatch');
  }
});

test('closing a returning app fences its sign-in before exchange, during the reply and inside final storage admission',async t=>{
  for (const moment of ['before exchange','during reply','at commit']) {
    const entered=Promise.withResolvers(),resume=Promise.withResolvers();
    const {auth,store,calls}=fixture(t,async request=>{
      assert.equal(request.endpoint,'token');
      entered.resolve(); await resume.promise;
      return response({account_id:'fictional-return',refresh_token:'unused-refresh',access_token:'unused-access',expires_in:3600});
    },null);
    const win=tab(); await auth.authorize(win); returned(win);
    const callback=captureDropboxCallback(win);
    if (moment==='before exchange') auth.close();
    if (moment==='at commit') {
      const save=store.storeExchangedSession.bind(store);
      store.storeExchangedSession=(...args)=>{auth.close();return save(...args);};
    }
    const result=auth.finishCallback(win,callback);
    if (moment==='during reply') { await entered.promise; auth.close(); }
    resume.resolve();
    await assert.rejects(result,errorOf('callback'));
    assert.equal(calls.length,moment==='before exchange'?0:1);
    assert.equal(store.session,null);
  }
});

test('an update drains only an already submitted valid exchange; a hard close, erase or newer sign-in still wins',async t=>{
  for (const outcome of ['drain','unsubmitted','hard close','erase','new attempt','expired']) {
    const entered=Promise.withResolvers(),resume=Promise.withResolvers();
    const {auth,store,calls,time}=fixture(t,async()=>{entered.resolve();await resume.promise;
      return response({account_id:'fictional-return',refresh_token:'unused-refresh',access_token:'unused-access',expires_in:3600});
    },null);
    const win=tab(); await auth.authorize(win); returned(win);
    const callback=captureDropboxCallback(win);
    if (outcome==='unsubmitted') auth.close({finishSubmittedCallback:true});
    const result=auth.finishCallback(win,callback);
    if (outcome!=='unsubmitted') {
      await entered.promise; auth.close({finishSubmittedCallback:true});
      if (outcome==='hard close') {auth.close();auth.close({finishSubmittedCallback:true});}
      if (outcome==='new attempt') await store.startDropboxAttempt('a-new-tab');
      if (outcome==='erase') store.eraseGeneration++;
      if (outcome==='expired') time.now+=attemptLifetime;
    }
    resume.resolve();
    if (outcome==='drain') {
      assert.equal(await result,true);
      assert.equal(store.session.accountId,'fictional-return');
    } else { await assert.rejects(result,errorOf('callback')); assert.equal(store.session,null); }
    assert.equal(calls.length,outcome==='unsubmitted'?0:1);
  }
});

test('A second sign-in in the same tab fences a delayed token response from the first, even after the second finishes',async t=>{
  const entered=Promise.withResolvers(),reply=Promise.withResolvers();
  const {auth,store,calls}=fixture(t,async request=>{
    const code=new URLSearchParams(request.body).get('code');
    if (code==='first') { entered.resolve(); await reply.promise; }
    return response({account_id:code,access_token:'a',refresh_token:'r',expires_in:600});
  },null);
  const win=tab(); await auth.authorize(win); returned(win);
  win.location.href=win.location.href.replace('fictional-code','first');
  const delayed=auth.finishCallback(win).catch(e=>e);
  await entered.promise;
  await auth.authorize(win); returned(win);
  assert.equal(await auth.finishCallback(win),true);
  reply.resolve();
  assert.equal((await delayed).kind,'callback');
  assert.equal(store.session.accountId,'fictional-code');
  assert.equal(store.revision,1n);
  assert.equal(calls.length,2);
  assert.equal(win.sessionStorage.getItem('csvTV/dropbox-attempt-v2'),null);
});

test('Refusal of provider expiry ends sign-in; every new attempt requests the bounded grant even on an upgraded tab', async t => {
  const { auth, store, calls } = fixture(t, (_request, state) => state.calls.length === 1
    ? response({ error: 'invalid_request', error_description: 'unknown refresh_token_expiration_seconds parameter' }, 400)
    : response({ account_id: 'next', access_token: 'access', refresh_token: 'refresh', expires_in: 100 }), null);
  const win = tab();
  win.sessionStorage.setItem('csvTV/dropbox-omit-expiry','public-dev-app');
  await auth.authorize(win); const first = win.destination.searchParams.get('state');
  returned(win); await assert.rejects(auth.finishCallback(win),errorOf('expiry-unsupported'));
  assert.equal(win.destination.searchParams.get('state'), first);
  assert.equal(calls.length,1);
  assert.equal(store.session,null);
  await auth.authorize(win);
  assert.notEqual(win.destination.searchParams.get('state'), first);
  returned(win); await auth.finishCallback(win);
  assert.ok(calls.every(call=>new URLSearchParams(call.body).get('refresh_token_expiration_seconds') === String((now+week)/1000)));
  assert.equal(store.session.signInDeadline, now + week);
  assert.equal(store.session.providerExpiresAt, now + week);
});

test('The 15-minute sign-in window covers the tab ticket, scrubbed handoff, memory-only fallback and final database admission', async t => {
  const success = () => response({account_id:'example',refresh_token:'r',access_token:'a',expires_in:3600});
  const edge = fixture(t,success,null);
  const good = tab();
  await edge.auth.authorize(good); returned(good);
  edge.time.now += attemptLifetime - 1;
  assert.equal(await edge.auth.finishCallback(good),true);

  for (const mode of ['before-return','after-reload','while-open','memory','before-commit']) {
    const {auth,store,calls,time} = fixture(t,success,null), win = tab();
    await auth.authorize(win); returned(win);
    if (mode === 'before-return') {
      time.now += attemptLifetime;
      await assert.rejects(auth.finishCallback(win),errorOf('callback'));
    } else if (mode === 'before-commit') {
      const save = store.storeExchangedSession.bind(store);
      store.storeExchangedSession = (...args) => { time.now += attemptLifetime; return save(...args); };
      await assert.rejects(auth.finishCallback(win),errorOf('callback'));
    } else {
      if (mode === 'memory') win.sessionStorage.setItem = () => { throw new DOMException('','QuotaExceededError'); };
      const captured = prepare(win,()=>time.now);
      time.now += attemptLifetime;
      const handoff = mode === 'after-reload' ? prepare(win,()=>time.now) : captured;
      await assert.rejects(auth.finishCallback(win,handoff.take()),errorOf('callback'));
    }
    assert.equal(calls.length,mode === 'before-commit' ? 1 : 0);
    assert.equal(store.session,null);
    assert.equal(win.sessionStorage.getItem('csvTV/dropbox-pkce-v2'),null);
    assert.equal(win.sessionStorage.getItem('csvTV/dropbox-callback-v2//'),null);
    assert.equal(new URL(win.location.href).search,'');
  }
});

test('An idle tab clears malformed, old-format, expired and future-dated tickets on startup', async t => {
  const {auth,calls} = fixture(t,assert.fail,null);
  for (const timestamp of [undefined,now-attemptLifetime,now+1,'malformed']) {
    const win = tab(); await auth.authorize(win);
    const key = 'csvTV/dropbox-pkce-v2';
    const ticket = JSON.parse(win.sessionStorage.getItem(key));
    ticket.createdAt = timestamp;
    win.sessionStorage.setItem(key,timestamp === 'malformed' ? '{' : JSON.stringify(ticket));
    assert.equal(prepareDropboxCallback(win).take(),null);
    assert.equal(win.sessionStorage.getItem(key),null);
    returned(win);
    await assert.rejects(auth.finishCallback(win),errorOf('callback'));
  }
  assert.equal(calls.length,0);
});

test('An older shell cannot consume the new verifier; the new shell drops previous-format handoffs and expiry exceptions',async t=>{
  const {auth,calls} = fixture(t,assert.fail,null), win=tab();
  await auth.authorize(win);
  assert.equal(win.sessionStorage.getItem('csvTV/dropbox-pkce'),null);
  returned(win); const handoff = prepareDropboxCallback(win);
  assert.equal(win.sessionStorage.getItem('csvTV/dropbox-callback//'),null);
  assert.ok(handoff.take()?.ticket);
  win.sessionStorage.setItem('csvTV/dropbox-pkce','previous-verifier');
  win.sessionStorage.setItem('csvTV/dropbox-callback//','previous-handoff');
  win.sessionStorage.setItem('csvTV/dropbox-omit-expiry','public-dev-app');
  assert.equal(prepareDropboxCallback(win).take(),null);
  for(const key of ['csvTV/dropbox-pkce','csvTV/dropbox-callback//','csvTV/dropbox-omit-expiry']) assert.equal(win.sessionStorage.getItem(key),null);
  assert.equal(calls.length,0);
});

test('Network latency cannot move either grant deadline later than the requested Dropbox second', async t => {
  const {auth,time,calls,store} = fixture(t,()=>{
    time.now += 6300;
    return response({account_id:'example',refresh_token:'r',access_token:'a',expires_in:3600});
  },null);
  const win=tab(); time.now+=990;
  await auth.authorize(win); returned(win); await auth.finishCallback(win);
  assert.equal(store.session.signInDeadline,now+week);
  assert.equal(store.session.providerExpiresAt,now+week);
  assert.equal(new URLSearchParams(calls[0].body).get('refresh_token_expiration_seconds'),String((now+week)/1000));
  assert.throws(()=>new DropboxAuth(store,'key',{providerLifetimeMs:week+1}),RangeError);
});

test('Upgrading an unverified grant keeps the offline owner, blocks file requests, and reports uncertain revocation', async t => {
  for (const mode of ['revoked','offline','failure']) {
    const session = {...original}; delete session.providerExpiresAt;
    const store=new Store(session),sent=[];
    const auth=new DropboxAuth(store,'public-dev-app',{now:()=>now,online:()=>mode!=='offline',transport:async request=>{
      sent.push(request.endpoint);
      assert.equal(request.endpoint,'revoke');
      return response({},mode==='failure'?503:200);
    }});
    t.after(()=>auth.close());
    const notice=Promise.withResolvers();
    auth.addEventListener('expiry-notice',e=>notice.resolve(e.detail),{once:true});
    await assert.rejects(auth.request({endpoint:'list'}),error=>['expired','signed-out','account-changed'].includes(error.kind));
    const message=await notice.promise;
    assert.match(message,/Sign in again/);
    assert.equal(message.includes('disconnect csvTV in Dropbox'),mode!=='revoked');
    assert.deepEqual(sent,mode==='offline'?[]:['revoke']);
    assert.equal(store.owner,original.accountId);
    assert.equal(store.session,null);
  }
});

test('A token error that only echoes the expiry field preserves the original sign-in settings',async t=>{
  const {auth,store,calls} = fixture(t,()=>response({error:'invalid_request',error_description:'Invalid redirect URI',
    parameters:['client_id','refresh_token_expiration_seconds']},400),null);
  const win = tab(); await auth.authorize(win); const state = win.destination.searchParams.get('state');
  returned(win); await assert.rejects(auth.finishCallback(win),errorOf('failed'));
  assert.equal(calls.length,1);
  assert.equal(win.destination.searchParams.get('state'),state);
  assert.equal(win.sessionStorage.getItem('csvTV/dropbox-omit-expiry'),null);
  assert.equal(store.session,null);
  for(const message of ['Unknown parameter: refresh_token_expiration_seconds','Unknown parameter:refresh_token_expiration_seconds',
    'refresh_token_expiration_seconds: unsupported parameter',"'refresh_token_expiration_seconds' is not a supported parameter",
    '"refresh_token_expiration_seconds" is not supported for this app']){
    assert.throws(()=>checkResponse({bytes:text('OAuth error: '+message),status:400,metadata:null},true),errorOf('expiry-unsupported'));
    assert.throws(()=>checkResponse(response({error:'invalid_request',error_description:message},400),true),errorOf('expiry-unsupported'));
  }
  for(const message of ['Invalid redirect URI; request included refresh_token_expiration_seconds',
    'Invalid client_id. Fields: client_id, refresh_token_expiration_seconds']){
    assert.throws(()=>checkResponse({bytes:text(message),status:400,metadata:null},true),errorOf('failed'));
    assert.throws(()=>checkResponse(response({error:'invalid_request',error_description:message},400),true),errorOf('failed'));
  }
});

test('Renewal replies cannot save or clear credentials after the writer closes or the sign-in expires during the commit read',async t=>{
  const expired = {...original,accessExpiresAt:now};
  for (const refusal of [false,true]) for (const interrupt of ['close','reader','deadline']) {
    let returned = false, reads = 0;
    const {auth,store,time,calls} = fixture(t,request=>{
      assert.equal(request.endpoint,'token');
      returned = true;
      return refusal ? response({error:'invalid_grant'},400) : response({access_token:'renewed',expires_in:3600});
    },expired);
    const interruptWrite = () => {
      if (interrupt==='close') auth.close();
      if (interrupt==='reader') store.role='reader';
      if (interrupt==='deadline') time.now=original.signInDeadline;
    };
    const save = store.saveDropboxRenewal.bind(store);
    store.saveDropboxRenewal = (...args) => { interruptWrite(); return save(...args); };
    const read = store.dropboxAuthState.bind(store);
    store.dropboxAuthState = async () => {
      const value = await read();
      if (refusal && returned && ++reads===2) interruptWrite();
      return value;
    };
    await assert.rejects(auth.request({endpoint:'list'}),errorOf(interrupt==='deadline'?'expired':'failed'));
    assert.deepEqual(store.session,expired);
    assert.equal(calls.length,1);
  }
});

test('A 401 renews and retries once, a second 401 stops, refused renewal signs out and transient failure preserves the session', async t => {
  for (const result of ['ok', 'twice', 'denied', 'outage']) {
    const { auth, store, calls } = fixture(t, (request, state) => {
      if (request.endpoint === 'token') {
        if (result === 'denied') return response({ error: 'invalid_grant' }, 400);
        if (result === 'outage') return response({}, 503);
        return response({ access_token: 'retried', expires_in: 3600 });
      }
      return response({}, state.calls.length === 1 || result === 'twice' ? 401 : 200);
    });
    const request = auth.request({ endpoint: 'list' });
    if (result === 'ok') {
      assert.equal((await request).status, 200); assert.equal(calls[2].headers.Authorization, 'Bearer retried');
    } else await assert.rejects(request, errorOf({ twice: 'unauthorized', denied: 'signed-out', outage: 'provider-unavailable' }[result]));
    assert.equal(calls.filter(x => x.endpoint === 'token').length, 1);
    assert.equal(store.session === null, result === 'denied');
    assert.equal(calls.filter(x => x.endpoint === 'list').length, result === 'ok' || result === 'twice' ? 2 : 1);
  }
});

test('Transient token responses retain the sign-in for a successful later renewal', async t => {
  for (const status of [429, 503]) {
    let recovering = false;
    const {auth, store, time} = fixture(t, request => request.endpoint === 'token'
      ? recovering ? response({access_token:'retried',expires_in:3600}) : response({error:'invalid_grant'},status)
      : response({}), {...original,accessExpiresAt:now});
    await assert.rejects(auth.request({endpoint:'list'}), errorOf(status === 429 ? 'throttled' : 'provider-unavailable'));
    assert.equal(store.session.instanceId, original.instanceId);
    recovering = true;
    if (status === 429) time.now = store.cooldowns.get(original.accountId).until;
    assert.equal((await auth.request({endpoint:'list'})).status, 200);
    assert.equal(store.session.accessToken, 'retried');
  }
});

test('Overlapping Dropbox limits keep the later deadline and admit a single probe at expiry', async t => {
  const first = Promise.withResolvers(), second = Promise.withResolvers(), probe = Promise.withResolvers();
  const bothStarted = Promise.withResolvers(), probeStarted = Promise.withResolvers();
  let transfers = 0;
  const {auth, store, time} = fixture(t, async () => {
    transfers++;
    if (transfers === 1) return first.promise;
    if (transfers === 2) { bothStarted.resolve(); return second.promise; }
    if (transfers === 3) { probeStarted.resolve(); return probe.promise; }
    return response();
  }, {...original, accessExpiresAt:now + week});
  const run = () => auth.request({endpoint:'list'});
  const early = assert.rejects(run(), errorOf('throttled')), late = assert.rejects(run(), errorOf('throttled'));
  await bothStarted.promise;
  first.resolve({...response({},429), retryAfter:new Date(now + 60_000).toUTCString()});
  await early;
  second.resolve({...response({},429), retryAfter:'30'});
  await late;
  assert.deepEqual(store.cooldowns.get(original.accountId), {until:now + 60_000, strikes:1});
  await assert.rejects(run(),errorOf('throttled'));
  assert.equal(transfers,2);
  time.now += 60_000;
  const batch = Promise.all(Array.from({length:7},run));
  await probeStarted.promise;
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(transfers,3);
  probe.resolve(response());
  assert.equal((await batch).length,7);
  assert.equal(transfers,9);
  assert.equal(store.cooldowns.size,0);
});

test('Dropbox retries for one, two, four and eight seconds, then retains the gate through a failed probe', async t => {
  const attempts = [];
  const {auth, store, time} = fixture(t, (_request, {time}) => {
    attempts.push(time.now);
    if (attempts.length === 6) throw new DropboxError('unavailable');
    return response({},attempts.length <= 5 ? 429 : 200);
  }, {...original, accessExpiresAt:now + week});
  const run = () => auth.request({endpoint:'list'});
  await assert.rejects(run(),errorOf('throttled'));
  assert.deepEqual(attempts.map(n => n - now),[0,1000,3000,7000,15000]);
  assert.equal(store.cooldowns.get(original.accountId).until,time.now + 15 * 60_000);
  time.now += 15 * 60_000;
  await assert.rejects(run(),errorOf('unavailable'));
  assert.equal(store.cooldowns.get(original.accountId).until,time.now + 15 * 60_000);
  await assert.rejects(run(),errorOf('throttled'));
  time.now += 15 * 60_000;
  assert.equal((await run()).status,200);
});

test('A Dropbox 429 honors the later valid deadline from its Retry-After header and rate-limit error body', async t => {
  for (const [header, body, delay] of [
    [undefined,120,120], ['30',120,120], ['240',120,240], [new Date(now+60_000).toUTCString(),180,180],
    ['malformed',120,120], ['90',-1,90], ['90','120',90], ['90',Number.MAX_SAFE_INTEGER,90],
    [undefined,1,1], [undefined,'bad',1], [undefined,0,1],
  ]) {
    const {auth,store,calls,time} = fixture(t, (_request,state) => state.calls.length === 1 ?
      {...response({error:{reason:{'.tag':'too_many_requests'},retry_after:body}},429),retryAfter:header} : response(),
      {...original,accessExpiresAt:now + week});
    if (delay > 8) {
      await assert.rejects(auth.request({endpoint:'list'}),errorOf('throttled'));
      assert.equal(calls.length,1);
      assert.equal(store.cooldowns.get(original.accountId).until, now + delay * 1000);
    } else {
      await auth.request({endpoint:'list'});
      assert.equal(time.now, now + delay * 1000);
    }
  }
});

test('A replaced Dropbox sign-in discards its late throttle and another account has an independent gate', async t => {
  const started = Promise.withResolvers(), reply = Promise.withResolvers();
  const {auth,store,calls} = fixture(t, async () => {
    if (calls.length === 1) { started.resolve(); return reply.promise; }
    return response();
  });
  const work = assert.rejects(auth.request({endpoint:'list'}),errorOf('account-changed'));
  await started.promise;
  await store.storeExchangedSession({...original,instanceId:'new-grant'});
  reply.resolve({...response({},429),retryAfter:'1800'});
  await work;
  assert.equal(store.cooldowns.size,0);
  store.cooldowns.set(original.accountId,{until:now+1800_000,strikes:1});
  store.owner = 'other-account';
  await store.storeExchangedSession({...original,accountId:store.owner,instanceId:'other-grant'});
  assert.equal((await auth.request({endpoint:'list'})).status,200);
  assert.equal(store.cooldowns.size,1);
});

test('A throttle that arrives during disconnection still delays the next connected request on the same account', async t => {
  let online = true, requests = 0;
  const store = new Store(), auth = new DropboxAuth(store, 'public-example', {now:() => now, online:() => online,
    transport:async () => {
      requests++;
      online = false;
      return {...response({},429), retryAfter:'90'};
    }});
  t.after(() => auth.close());
  await assert.rejects(auth.request({endpoint:'list'}),errorOf('throttled'));
  assert.equal(store.cooldowns.get(original.accountId).until,now + 90_000);
  online = true;
  await assert.rejects(auth.request({endpoint:'list'}),errorOf('throttled'));
  assert.equal(requests,1);
});

test('The local deadline fences a still-valid token and a late response; revocation-only renewal keeps the next sign-in', async t => {
  const { auth, time, calls, store } = fixture(t, (request, state) => {
    if (request.endpoint === 'list') { state.time.now += week; return response({}); }
    if (request.endpoint === 'token') {
      state.store.storeExchangedSession({ ...original, instanceId: 'replacement', refreshToken: 'replacement-refresh' });
      return response({ access_token: 'revoke-only', expires_in: 3600 });
    }
    return response({});
  });
  await assert.rejects(auth.request({ endpoint: 'list' }), errorOf('expired'));
  await new Promise(r => setImmediate(r));
  assert.deepEqual(calls.map(r => r.endpoint), ['list', 'token', 'revoke']);
  assert.equal(calls[2].headers.Authorization, 'Bearer revoke-only');
  assert.equal(store.session.instanceId, 'replacement');
  const legacy = fixture(t, () => response({}), { ...original, signInDeadline: undefined });
  await assert.rejects(legacy.auth.request({ endpoint: 'list' }), e => e.kind === 'expired' || e.kind === 'signed-out' || e.kind === 'account-changed');
  assert.equal(legacy.calls.some(r => r.endpoint === 'list'), false);
  time.now = now;
});

test('Overlapping file requests share renewal and a delayed 401 retries with the credential already renewed', async t => {
  for (const expired of [true, false]) {
    const pending = Promise.withResolvers(), started = Promise.withResolvers();
    let renewals = 0;
    const { auth } = fixture(t, async request => {
      if (request.endpoint === 'token') {
        renewals++;
        started.resolve();
        if (expired) await pending.promise;
        return response({ access_token: 'fresh-' + renewals, expires_in: 3600 });
      }
      if (request.headers.Authorization === 'Bearer access-one') {
        if (request.endpoint === 'download') await pending.promise;
        return response({}, 401);
      }
      return response({});
    }, { ...original, accessExpiresAt: expired ? now : original.accessExpiresAt });
    const delayed = auth.request({ endpoint: 'download' });
    const other = auth.request({ endpoint: 'list' });
    await started.promise;
    if (expired) await new Promise(resolve => setImmediate(resolve));
    else await other;
    pending.resolve();
    assert.deepEqual((await Promise.all([delayed, other])).map(reply => reply.status), [200, 200]);
    assert.equal(renewals, 1, expired ? 'Expired access token' : 'Delayed 401 for the previous token');
  }
});

test('Account mismatch, superseded requests and stale sign-out choices cannot send to or clear the new session', async t => {
  const { auth, store, calls } = fixture(t, (req, s) => {
    s.store.storeExchangedSession({ ...original, accountId: 'other', instanceId: 'another' });
    return req.endpoint === 'token' ? response({ error: 'invalid_grant' }, 400) : response({});
  });
  await assert.rejects(auth.request({ endpoint: 'list' }), errorOf('account-changed'));
  await assert.rejects(auth.request({ endpoint: 'download' }), errorOf('account-changed'));
  await assert.rejects(auth.signOut({ ...original, owner: original.accountId }), errorOf('account-changed'));
  assert.equal(calls.length, 1); assert.equal(store.session.accountId, 'other');
  const expired = fixture(t, (_r, s) => {
    s.store.storeExchangedSession({ ...original, instanceId: 'renewed-elsewhere' });
    return response({ error: 'invalid_grant' }, 400);
  }, { ...original, accessExpiresAt: now - 1000 });
  await assert.rejects(expired.auth.request({ endpoint: 'list' }), errorOf('account-changed'));
  assert.equal(expired.store.session.instanceId, 'renewed-elsewhere');
});

test('Handing off the writer or closing the tracker during sign-out cannot revoke the other tab’s session', async t => {
  for (const stop of ['handoff','close']) {
    const {auth,store,calls} = fixture(t, () => response({}));
    const signOut = auth.signOut();
    if (stop === 'close') auth.close(); else store.role = 'reader';
    await assert.rejects(signOut, errorOf('failed'));
    assert.deepEqual(calls, []);
    assert.deepEqual(store.session, original);
  }
});

test('a device storage refusal during sign-out pauses only the original grant and retains the reviewed revision', async t => {
  for (const onlineAtSignOut of [true,false]) {
    const store = new Store(original);
    let online = onlineAtSignOut, full = true;
    const calls = [], commit = store.commit.bind(store);
    store.commit = (...args) => {
      if (full && args[1].removeLocal?.includes('dropboxSession')) throw new DOMException('Fictional full device','QuotaExceededError');
      return commit(...args);
    };
    const auth = new DropboxAuth(store,'public-dev-app',{now:()=>now,online:()=>online,transport:async request => {
      calls.push(request.endpoint); return response({});
    }});
    t.after(()=>auth.close());
    const first = {...original,owner:original.accountId};
    await assert.rejects(auth.signOut(first),online ? /Dropbox access has ended/ : /revocation is unconfirmed/);
    assert.match(auth.pendingSignOut(original.instanceId),/before closing/);
    assert.equal(store.revision,0n);
    online = true;
    await assert.rejects(auth.request({endpoint:'list'},original),errorOf('sign-out-pending'));
    assert.deepEqual(calls,onlineAtSignOut ? ['revoke'] : []);
    const replacement = {...original,instanceId:'different-grant'};
    store.session = replacement;
    assert.equal(auth.pendingSignOut(replacement.instanceId),'');
    await auth.request({endpoint:'list'},replacement);
    await assert.rejects(auth.signOut(first),errorOf('account-changed'));
    assert.equal(store.session,replacement);
    store.session = original;
    full = false;
    assert.equal(await auth.signOut(first),onlineAtSignOut ? 'ended' : 'revoked');
    assert.equal(store.revision,1n); assert.equal(store.session,null);
    assert.equal(auth.pendingSignOut(original.instanceId),'');
    assert.equal(calls.filter(endpoint=>endpoint==='revoke').length,1);
  }
});

test('The erase dialog uses only public session identity; a stale revision or changed account cannot revoke the current grant',async t=>{
  const {auth,store,calls}=fixture(t,request=>{
    assert.equal(request.endpoint,'revoke');
    assert.equal(request.headers.Authorization,'Bearer '+original.accessToken);
    return response({});
  });
  const state=await auth.status();
  assert.deepEqual(state.session,{accountId:original.accountId,instanceId:original.instanceId,signInDeadline:original.signInDeadline});
  const expected={owner:state.accountId,accountId:state.session.accountId,instanceId:state.session.instanceId};
  for (const [identity,revision] of [[expected,1n],[{...expected,owner:'different'},0n],[{...expected,instanceId:'old'},0n]]) {
    await assert.rejects(auth.revokeForErase(identity,revision),StaleSnapshotError);
  }
  assert.equal(calls.length,0);
  assert.equal(await auth.revokeForErase(expected,0n),'revoked');
  assert.equal(calls.length,1);
  assert.equal(store.session.instanceId,expected.instanceId);
});

test('Closing the tracker or handing off the writer during the last state read prevents dispatch', async t => {
  for (const stop of ['close', 'handoff']) {
    const {auth,store,calls} = fixture(t, () => response({}));
    const read = store.dropboxAuthState.bind(store), entered = Promise.withResolvers(), resume = Promise.withResolvers();
    let reads = 0;
    store.dropboxAuthState = async () => {
      const snapshot = await read();
      if (++reads === 2) { entered.resolve(); await resume.promise; }
      return snapshot;
    };
    const request = auth.request({endpoint:'upload',body:text('fictional file')});
    await entered.promise;
    if (stop === 'close') auth.close(); else store.role = 'reader';
    resume.resolve();
    await assert.rejects(request, errorOf('failed'));
    assert.equal(calls.length, 0, 'A released writer sent data after its final state read');
  }
});

test('Sign-out renews only for revocation; offline failure still removes only the captured session', async t => {
  for (const mode of ['revoked', 'ended', 'offline', 'replaced']) {
    const { auth, store, calls } = fixture(t, async (request, state) => {
      if (request.endpoint === 'token') return mode === 'ended' ? response({ error: 'invalid_grant' }, 400)
        : response({ access_token: 'fresh-for-revoke', expires_in: 60 });
      assert.equal(request.headers.Authorization, 'Bearer fresh-for-revoke');
      if (mode === 'replaced') await state.store.storeExchangedSession({ ...original, instanceId: 'next' });
      return response({}, mode === 'offline' ? 503 : 200);
    }, { ...original, accessExpiresAt: now });
    if (mode === 'replaced') {
      await assert.rejects(auth.signOut(), errorOf('account-changed')); assert.equal(store.session.instanceId, 'next');
    } else {
      assert.equal(await auth.signOut(), mode); assert.equal(store.session, null);
    }
    assert.equal(store.owner, original.accountId);
    assert.deepEqual(calls.map(r => r.endpoint), mode === 'ended' ? ['token'] : ['token', 'revoke']);
  }
  for (const [status,body] of [[401,{}],[401,{error:'invalid_client'}],[400,{error:'invalid_client'}]]) {
    const denied = fixture(t, () => response(body,status), { ...original, accessExpiresAt: now });
    assert.equal(await denied.auth.signOut(), 'offline','The registration failure cannot confirm remote revocation.');
    assert.equal(denied.store.session, null);
    assert.deepEqual(denied.calls.map(request => request.endpoint),['token']);
  }
});

test('Sign-out handles an early 401 from revocation by renewing the captured grant once', async t => {
  for (const finalStatus of [200, 401]) {
    const { auth, store, calls } = fixture(t, request => {
      if (request.endpoint === 'token') {
        assert.equal(new URLSearchParams(request.body).get('refresh_token'), original.refreshToken);
        return response({ access_token: 'revoke-retry', expires_in: 60 });
      }
      return response({}, request.headers.Authorization === 'Bearer revoke-retry' ? finalStatus : 401);
    });
    assert.equal(await auth.signOut(), finalStatus === 200 ? 'revoked' : 'offline');
    assert.deepEqual(calls.map(r => r.endpoint), ['revoke', 'token', 'revoke']);
    assert.equal(store.session, null);
  }
});

test('Dropbox hashes empty files and successive 4 MiB blocks at byte boundaries', async () => {
  const hash = input => createHash('sha256').update(input).digest();
  for (const size of [0, 1, 4194304, 4194305, 8388611]) {
    const bytes = Buffer.alloc(size, 143), parts = [];
    for (let offset = 0; offset < size; offset += 4194304) parts.push(hash(bytes.subarray(offset, offset + 4194304)));
    assert.equal(await dropboxContentHash(bytes), hash(Buffer.concat(parts)).toString('hex'));
  }
});

test('a Dropbox upload hashes and sends the same snapshot when the caller edits its buffer', async t => {
  const size = 4 * 1024 * 1024 + 2;
  const backing = new Uint8Array(size + 2).fill(8);
  const payload = backing.subarray(1,1 + size);
  const expected = await dropboxContentHash(payload);
  const stamp = new Date(now).toISOString();
  const {auth} = fixture(t, request => {
    assert.equal(request.endpoint,'upload');
    assert.equal(JSON.parse(request.headers['Dropbox-API-Arg']).content_hash,expected);
    assert.equal(request.body.byteLength,size);
    assert.equal(request.body[0],8);
    assert.equal(request.body.at(-1),8);
    return response({name:'sample.bin',path_display:'/sample.bin',rev:'r1',content_hash:expected,
      server_modified:stamp,client_modified:stamp,size});
  });
  const upload = new DropboxApi(auth).upload('/sample.bin',payload,{mode:'add'});
  backing.fill(5);
  assert.equal((await upload).contentHash,expected);
});

test('a 32 MiB Dropbox download returns the same owned bytes it verified', async t => {
  const size = 32 * 1024 * 1024;
  const backing = new Uint8Array(size + 2).fill(7);
  const source = backing.subarray(1,size + 1);
  const hash = await dropboxContentHash(source);
  const stamp = new Date(now).toISOString();
  const metadata = JSON.stringify({name:'fixture.bin',path_display:'/fixture.bin',size,rev:'known',
    client_modified:stamp,server_modified:stamp,content_hash:hash});
  const {auth} = fixture(t, () => ({status:200,metadata,bytes:source}));
  const hashing = Promise.withResolvers(), proceed = Promise.withResolvers();
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  t.mock.method(crypto.subtle,'digest',async (...args)=>{
    hashing.resolve();
    await proceed.promise;
    return digest(...args);
  });
  const downloading = new DropboxApi(auth).download('/fixture.bin');
  await hashing.promise;
  source[0] = 8; source[size-1] = 9;
  proceed.resolve();
  const result = await downloading;
  assert.equal(result.bytes[0],7);
  assert.equal(result.bytes[size-1],7);
  assert.notEqual(result.bytes.buffer,backing.buffer);
  assert.equal(result.bytes.buffer.byteLength,size);
  assert.equal(await dropboxContentHash(result.bytes),hash);
  result.bytes[1] = 10;
  assert.equal(source[1],7);
});

test('canceling a paginated backup listing stops before sending the next Dropbox cursor', async t => {
  const reader=new AbortController();
  const {auth,calls}=fixture(t,request=>{
    assert.equal(request.endpoint,'list');
    reader.abort();
    return response({entries:[],has_more:true,cursor:'next-page'});
  });
  await assert.rejects(new DropboxApi(auth).list('/backups',true,{signal:reader.signal}),{name:'AbortError'});
  assert.equal(calls.length,1);
});

test('the optional backup index stops at two pages before falling back to direct folder listings',async t=>{
  const {auth,calls}=fixture(t,()=>response({entries:[],has_more:true,cursor:'page-'+calls.length}));
  const api=new DropboxApi(auth);
  await assert.rejects(api.list('/backups',true,{maxPages:NaN}),{kind:'too-large'});
  await assert.rejects(api.list('/backups',true,{maxPages:2}),{kind:'too-large'});
  assert.deepEqual(calls.map(request=>request.endpoint),['list','continue']);
});

test('abandoned backup reads preserve a reported Dropbox cooldown and never use the next retry',async t=>{
  for (const [endpoint,status] of [['list',401],['list',429],['download',401],['download',429]]) {
    const reader=new AbortController();
    const {auth,calls,store,time}=fixture(t,()=>{
      if (calls.length === 1) {
        reader.abort();
        return {...response({},status),retryAfter:'2'};
      }
      return response({entries:[],has_more:false,cursor:'end'});
    });
    const api=new DropboxApi(auth);
    const read=endpoint==='list' ? api.list('/backups',true,{signal:reader.signal}) : api.download('/backups/old/completion.json',reader.signal);
    await assert.rejects(read,{name:'AbortError'});
    assert.equal(calls.length,1);
    if (status===429) assert.equal(store.cooldowns.get(original.accountId).until,time.now+2000);
    await api.list('/backups',true,{signal:new AbortController().signal});
    assert.equal(calls.length,2);
    assert.equal(store.cooldowns.size,0);
  }
});

test('leaving during a 401 renewal decision cancels an unsent renewal and keeps an accepted one',async t=>{
  for (const abortAt of ['decision','admission','sent']) {
    const reader=new AbortController();
    let refused=false,reads=0;
    const {auth,store,calls}=fixture(t,request=>{
      if (request.endpoint==='token') {
        assert.equal(abortAt,'sent');
        reader.abort();
        return response({access_token:'fresh',expires_in:3600});
      }
      refused=true;
      return response({},401);
    });
    const read=store.dropboxAuthState.bind(store);
    store.dropboxAuthState=async account=>{
      if (refused && ++reads===({decision:2,admission:3}[abortAt])) reader.abort();
      return read(account);
    };
    await assert.rejects(auth.request({endpoint:'list',readSignal:reader.signal}),{name:'AbortError'});
    assert.deepEqual(calls.map(r=>r.endpoint),abortAt==='sent'?['list','token']:['list']);
    assert.equal(store.session.accessToken,abortAt==='sent'?'fresh':original.accessToken);
  }
});

test('a second reader still renews if the first leaves while a shared renewal waits for admission',async t=>{
  const first=new AbortController(),admission=Promise.withResolvers(),resume=Promise.withResolvers();
  const {auth,calls,store}=fixture(t,r=>r.endpoint==='token' ? response({access_token:'fresh',expires_in:3600}) : response(),
    {...original,accessExpiresAt:now});
  await new Promise(resolve=>setImmediate(resolve));
  let reads=0;
  const read=store.dropboxAuthState.bind(store);
  store.dropboxAuthState=async account=>{
    if (++reads===3) { admission.resolve(); await resume.promise; }
    return read(account);
  };
  const abandoned=auth.request({endpoint:'list',readSignal:first.signal});
  await admission.promise;
  const needed=auth.request({endpoint:'list'});
  await new Promise(resolve=>setImmediate(resolve));
  first.abort();resume.resolve();
  await assert.rejects(abandoned,{name:'AbortError'});
  assert.equal((await needed).status,200);
  assert.deepEqual(calls.map(r=>r.endpoint),['token','list']);
  assert.equal(store.session.accessToken,'fresh');
});

test('leaving Restore cancels a successful response stream and finishes reading a rate-limit reply',async t=>{
  let status, body, stream, cancellations=0;
  t.mock.method(globalThis,'fetch',async()=>new Response(body,{status,headers:{'Retry-After':'7'}}));
  for(status of [200,429]) {
    const reader=new AbortController();
    body=new ReadableStream({start(controller){stream=controller;controller.enqueue(text('{"error":'));},
      cancel(){cancellations++;}});
    const pending=dropboxTransport({endpoint:'download',readSignal:reader.signal});
    await new Promise(resolve=>setImmediate(resolve));
    reader.abort();
    if (status===429) { stream.enqueue(text('{"retry_after":7}}')); stream.close(); }
    const reply=await pending;
    assert.equal(cancellations,1);
    if(status===200) {
      assert.equal(reply.discarded,true);
      assert.equal(reply.bytes.length,0);
      assert.throws(()=>checkResponse(reply),{name:'AbortError'});
    } else {
      assert.equal(reply.discarded,undefined);
      assert.equal(JSON.parse(new TextDecoder().decode(reply.bytes)).error.retry_after,7);
      assert.equal(reply.retryAfter,'7');
    }
  }
});

test('Dropbox mutations and token replies keep their full receipt even if given a browsing signal',async t=>{
  const reader=new AbortController(),receipt={rev:'written'};
  reader.abort();
  t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify(receipt)));
  const {auth,calls}=fixture(t,dropboxTransport);
  for (const endpoint of ['upload','create','delete','token','revoke']) {
    const result=await auth.request({endpoint,readSignal:reader.signal});
    assert.equal(result.discarded,undefined);
    assert.deepEqual(JSON.parse(new TextDecoder().decode(result.bytes)),receipt);
  }
  assert.equal(calls.length,5);
});

test('Folder cursors, revision pages, strict writes and raw downloads preserve the server’s exact revision and bytes', async t => {
  const payload = new Uint8Array([255, 0, 127]);
  const raw = { name: 'Río.csv', path_display: '/Río.csv', rev: 'r2', content_hash: await dropboxContentHash(payload),
    client_modified: '2026-11-18T12:00:00Z', server_modified: '2026-11-18T12:00:01Z', size: payload.length };
  const { auth } = fixture(t, r => {
    const body = r.endpoint === 'upload' ? null : JSON.parse(r.body ?? '{}');
    if (r.endpoint === 'list') return response({ entries: [], has_more: true, cursor: 'c' });
    if (r.endpoint === 'continue') { assert.equal(body.cursor, 'c'); return response({ has_more: false, entries: [{ '.tag': 'file', ...raw }] }); }
    if (r.endpoint === 'revisions') return body.before_rev ? response({ has_more: false, entries: [{ ...raw, rev: 'r1' }] })
      : response({ has_more: true, entries: [raw] });
    if (r.endpoint === 'download') {
      assert.equal(JSON.parse(r.headers['Dropbox-API-Arg']).path, '/Río.csv');
      assert.match(r.headers['Dropbox-API-Arg'], /^[\x20-\x7e]+$/);
      return { status: 200, bytes: payload, metadata: JSON.stringify(raw) };
    }
    const args = JSON.parse(r.headers['Dropbox-API-Arg']);
    assert.deepEqual(args.mode, { '.tag': 'update', update: 'r1' }); assert.equal(args.strict_conflict, true);
    assert.equal(args.autorename, false); assert.equal(args.content_hash, raw.content_hash); assert.equal(args.client_modified, raw.client_modified);
    return response(raw);
  });
  const api = new DropboxApi(auth, original);
  assert.equal((await api.list())[0].rev, 'r2'); assert.deepEqual((await api.revisions('Río.csv')).map(x => x.rev), ['r2','r1']);
  assert.deepEqual((await api.revisions('Río.csv','r2')).map(x => x.rev), ['r1']);
  assert.deepEqual((await api.download('Río.csv')).bytes, payload);
  assert.equal((await api.upload('Río.csv', payload, { mode: 'update', revision: 'r1', clientModified: raw.client_modified })).rev, 'r2');
});

test('Folder reservations and deletes require acknowledgements for the requested object', async t => {
  const path = '/backups/sample', folder = {name:'sample',path_display:path};
  let metadata = folder;
  let sent;
  const {auth} = fixture(t, request => { sent = JSON.parse(request.body); return response({metadata}); });
  const api = new DropboxApi(auth);
  await api.createFolder(path);
  metadata = {...folder, '.tag':'folder'};
  await api.createFolder(path);
  await api.delete(path);
  metadata = {...folder, '.tag':'file', rev:'r1',size:0,client_modified:new Date(now).toISOString(),server_modified:new Date(now).toISOString()};
  await assert.rejects(api.createFolder(path),errorOf('failed'));
  await api.delete(path,'r1');
  assert.deepEqual(sent,{path,parent_rev:'r1'});
  await assert.rejects(api.delete(path,'r2'),errorOf('failed'));
  for (metadata of [undefined, {...folder,'.tag':'deleted'}, {name:'other',path_display:'/backups/other','.tag':'folder'}]) {
    await assert.rejects(api.createFolder(path),errorOf('failed'));
    await assert.rejects(api.delete(path),errorOf('failed'));
  }
});

test('a bounded revision range pages to its exact cursor and rejects overlapping or oversized replies',async t=>{
  const stamp='2026-11-18T12:00:00Z';
  const rows=Array.from({length:207},(_,i)=>({name:'ratings.csv',path_display:'/ratings.csv',rev:'r'+i,
    client_modified:stamp,server_modified:stamp,size:0,content_hash:'0'.repeat(64)}));
  const pages=[];
  let fault;
  const {auth}=fixture(t,request=>{
    const {before_rev,limit}=JSON.parse(request.body);
    pages.push([before_rev,limit]);
    const start=rows.findIndex(row=>row.rev===before_rev)+1;
    const page=rows.slice(start,start+limit);
    if (fault==='overlap') page[0]=rows[start-1];
    if (fault==='overfull') page.push(rows[start+limit]);
    return response({entries:page,has_more:start+limit<rows.length});
  });
  const api=new DropboxApi(auth,original);
  const read=()=>api.revisions('/ratings.csv','r1',105);
  const found=await read();
  assert.deepEqual(pages,[['r1',100],['r101',5]]);
  assert.equal(found.length,105); assert.equal(found.at(-1).rev,'r106');
  for (fault of ['overlap','overfull']) await assert.rejects(read(),errorOf('failed'));
});

test('evidence near the head of a long file history reads through its full page and stops there',async t=>{
  const stamp='2026-11-19T12:00:00Z';
  const seed={name:'ratings.csv',path_display:'/ratings.csv',id:'id:fictional',size:0,client_modified:stamp,
    server_modified:stamp,content_hash:'0'.repeat(64)};
  const rows=Array.from({length:317},(_,i)=>({...seed,rev:'r'+i})),pages=[];
  const {auth}=fixture(t,request=>{
    const {before_rev,limit}=JSON.parse(request.body),start=rows.findIndex(row=>row.rev===before_rev)+1;
    pages.push(start);return response({entries:rows.slice(start,start+limit),has_more:start+limit<rows.length});
  });
  const api=new DropboxApi(auth,original);
  for(const [target,end,reads] of [[3,101,[1]],[150,201,[1,101]],[400,317,[1,101,201,301]]]) {
    pages.length=0;
    const result=await api.revisions('/ratings.csv','r0',Infinity,entry=>entry.rev==='r'+target);
    assert.deepEqual(pages,reads);assert.equal(result.length,end-1);assert.equal(result.at(-1).rev,'r'+(end-1));
  }
});

test('Revision history requires a calendar timestamp with a zone and accepts equivalent explicit offsets',async t=>{
  const stamp='2024-02-29T23:30:12.125+02:00';
  const raw={name:'ratings.csv',path_display:'/ratings.csv',rev:'r1',size:0,content_hash:await dropboxContentHash(''),
    client_modified:stamp,server_modified:'2024-02-29T21:30:12.125Z'};
  const {auth}=fixture(t,()=>response({entries:[raw],has_more:false}));
  const api=new DropboxApi(auth);
  const [revision]=await api.revisions('/ratings.csv');
  assert.equal(Date.parse(revision.clientModified),Date.parse(revision.serverModified));
  for(const bad of ['0','2024-02-30T00:00:00Z','2024-02-29T23:30:12','2024-02-29T24:00:00Z']){
    raw.client_modified=bad;
    await assert.rejects(api.revisions('/ratings.csv'),errorOf('failed'));
  }
});

test('Listing an unrelated file without an optional hash preserves other entries; downloads and history require verified metadata', async t => {
  const raw = {'.tag':'file',name:'Notes.txt',path_display:'/Notes.txt',size:3,rev:'notes',server_modified:new Date(now).toISOString(),
    client_modified:new Date(now).toISOString()};
  const folder = {'.tag':'folder',name:'Backups',path_display:'/Backups'};
  const {auth} = fixture(t, request => request.endpoint === 'list' ? response({entries:[raw,folder],has_more:false}) :
    request.endpoint === 'download' ? {status:200,metadata:JSON.stringify(raw),bytes:text('abc')} : response({entries:[raw],has_more:false}));
  const api = new DropboxApi(auth);
  assert.deepEqual((await api.list('')).map(item => item.name), ['Notes.txt','Backups']);
  await assert.rejects(api.download('/Notes.txt'), errorOf('failed'));
  await assert.rejects(api.revisions('/Notes.txt'), errorOf('failed'));
});

test('Recursive Dropbox listings omit the requested folder itself on either page and retain its descendants', async t => {
  const folder = {'.tag':'folder',name:'Backups',path_display:'/Backups',path_lower:'/backups'};
  const child = {'.tag':'folder',name:'Generation',path_display:'/Backups/Generation'};
  const file = {'.tag':'file',name:'ratings.csv',path_display:'/Backups/Generation/ratings.csv',size:5,rev:'fictional-revision',
    server_modified:new Date(now).toISOString(),client_modified:new Date(now).toISOString()};
  for (const onContinuation of [false,true]) {
    const {auth,calls} = fixture(t,request => {
      if (request.endpoint === 'list') {
        assert.deepEqual(JSON.parse(request.body),{path:'/backups',recursive:true,limit:500});
        return response({entries:onContinuation ? [child] : [folder,child],cursor:'next-page',has_more:true});
      }
      assert.equal(request.endpoint,'continue');
      assert.deepEqual(JSON.parse(request.body),{cursor:'next-page'});
      return response({entries:onContinuation ? [folder,file] : [file],has_more:false});
    });
    assert.deepEqual((await new DropboxApi(auth).list('/backups',true)).map(entry=>entry.path),
      ['/Backups/Generation','/Backups/Generation/ratings.csv']);
    assert.deepEqual(calls.map(request=>request.endpoint),['list','continue']);
  }
});

test('The recursive listing exception is limited to a well-formed folder at exactly the requested path', async t => {
  const folder = {'.tag':'folder',name:'Backups',path_display:'/Backups'};
  const file = {...folder,'.tag':'file',size:5,rev:'fictional-revision',
    server_modified:new Date(now).toISOString(),client_modified:new Date(now).toISOString()};
  for (const [recursive,item] of [
    [false,folder], [true,file], [true,{...folder,name:'other',path_display:'/other'}],
    [true,{...folder,name:'generation',path_display:'/backups-copy/generation'}], [true,{...folder,name:'different'}],
    [true,{...folder,'.tag':'deleted'}],
  ]) {
    const {auth} = fixture(t,()=>response({entries:[item],has_more:false}));
    await assert.rejects(new DropboxApi(auth).list('/backups',recursive),errorOf('failed'));
  }
});

test('Partial responses cannot confirm a full Dropbox revision listing or revocation', async t => {
  const {auth,store} = fixture(t, () => response({entries:[],has_more:false},206));
  await assert.rejects(new DropboxApi(auth).revisions('/watched.csv'), errorOf('failed'));
  assert.equal(await auth.signOut(), 'offline');
  assert.equal(store.session, null);
});

test('Distinguish missing paths, file conflicts and failed calls; reject unrelated metadata, partial bytes and recursive cursors', async t => {
  const { auth } = fixture(t, req => {
    if (req.endpoint === 'upload') return response({ error_summary: 'path/conflict/file/' }, 409);
    if (req.endpoint === 'list' || req.endpoint === 'continue') return response({ entries: [], cursor: 'same', has_more: true });
    return response({ error_summary: 'path/not_found/' }, 409);
  });
  const api = new DropboxApi(auth);
  assert.equal(await api.download('missing'), null); assert.deepEqual(await api.revisions('missing'), []);
  await assert.rejects(api.upload('test', 'a', { mode: 'add' }), errorOf('conflict'));
  await assert.rejects(api.list(), errorOf('failed'));
  const absentFolder = fixture(t, () => response({ error_summary:'path/not_found/' },409));
  const folders = new DropboxApi(absentFolder.auth);
  assert.deepEqual(await folders.list(), []);
  await assert.rejects(folders.list('/backups'), errorOf('not-found'));
  await assert.rejects(api.delete('/'), errorOf('failed'));
  const { auth: bad } = fixture(t, () => response({ error_summary: 'path/restricted_content/' }, 409));
  await assert.rejects(new DropboxApi(bad).download('test'), errorOf('failed'));
  const raw = { name:'test', path_lower:'/test', rev:'r', content_hash:'0'.repeat(64), size:2,
    server_modified:'2026-11-18T12:00:00Z', client_modified:'2026-11-18T12:00:00Z' };
  const wrong = fixture(t, () => ({ status:200, metadata:JSON.stringify(raw), bytes:text('abc') }));
  await assert.rejects(new DropboxApi(wrong.auth).download('test'), errorOf('failed'));
  await assert.rejects(new DropboxApi(wrong.auth).download('elsewhere'), errorOf('failed'));
  assert.throws(() => checkResponse(response({ error_summary: 'private-value' }, 409)), e => e.kind === 'failed' && !e.message.includes('private-value'));
});

test('Dropbox file and permission errors give actionable reasons without exposing provider text', () => {
  const privateValue = 'fictional-private-file-name';
  for (const [status,body,kind] of [
    [409,{error:{'.tag':'path_write',path_write:{'.tag':'conflict',conflict:{'.tag':'file'}}}},'conflict'],
    [409,{error:{'.tag':'path_lookup',path_lookup:{'.tag':'not_found'}}},'not-found'],
    [409,{error:{'.tag':'path',reason:{'.tag':'insufficient_space'},upload_session_id:privateValue}},'storage-full'],
    [409,{error_summary:'path_write/member_folder_insufficient_space/'+privateValue},'storage-full'],
    [409,{error_summary:'path/access_restricted/'+privateValue},'permission'],
    [409,{error_summary:'path_write/no_write_permission/'+privateValue},'permission'],
    [409,{error_summary:'too_many_write_operations/'+privateValue},'throttled'],
    [409,{error_summary:'path/too_many_write_operations/'+privateValue},'throttled'],
    [401,{error:{'.tag':'missing_scope',required_scope:privateValue}},'missing-scope'],
    [403,{error:{'.tag':'no_permission'}},'permission'],
    [503,{error_summary:privateValue},'provider-unavailable'],
    [409,{error_summary:'path/not_found_elsewhere/'+privateValue},'failed'],
    [409,{error:{'.tag':'path_lookup',path_lookup:{'.tag':'restricted_content'}},error_summary:'path/not_found/'},'failed'],
    [409,{error:{'.tag':'unknown',reason:{'.tag':'not_found'}}},'failed'],
    [409,{error_summary:'path_write/not_found/'},'failed'],
  ]) {
    assert.throws(() => checkResponse(response(body,status)), error =>
      error instanceof DropboxError && error.kind === kind && !error.message.includes(privateValue));
  }
});

test('Dropbox rejects unknown transport endpoints before constructing a network request',async t => {
  const send = t.mock.method(globalThis,'fetch',() => assert.fail('Unexpected network call'));
  for (const endpoint of ['missing','constructor',undefined]) {
    await assert.rejects(dropboxTransport({endpoint}),errorOf('failed'));
  }
  assert.equal(send.mock.callCount(),0);
});

test('slow token response bytes cannot extend the sign-in or renewal deadline',async t=>{
  let clock,wire;
  t.mock.timers.enable({apis:['setTimeout']});
  t.mock.method(globalThis,'fetch',(_url,init)=>{
    wire=init.signal;
    return new Response(new ReadableStream({start(controller){
      clock=controller;
      init.signal.addEventListener('abort',()=>controller.error(new DOMException('Timed out','AbortError')),{once:true});
    }}));
  });
  for (const [timeout,maximum] of [[undefined,120_000],[550,550]]) {
    const response=dropboxTransport({endpoint:'token',tokenTimeoutMs:timeout});
    await new Promise(resolve=>setImmediate(resolve));
    t.mock.timers.tick(maximum-1);
    clock.enqueue(text('{')); await new Promise(resolve=>setImmediate(resolve));
    assert.equal(wire.aborted,false);
    t.mock.timers.tick(1);
    await assert.rejects(response,errorOf('unavailable'));
    assert.equal(wire.aborted,true);
  }
});

test('Dropbox refuses redirects before sending an upload elsewhere, bounds the initial wait and extends it as receipt bytes arrive', async t => {
  let request, reply;
  t.mock.method(globalThis,'fetch',(url, init) => {
    assert.equal(url,'https://content.dropboxapi.com/2/files/upload');
    assert.equal(init.method,'POST');
    assert.equal(init.redirect,'error');
    assert.equal(init.credentials,'omit');
    assert.equal(init.referrerPolicy,'no-referrer');
    assert.equal(init.cache,'no-store');
    request = init;
    return new Promise((resolve,reject) => {
      init.signal.addEventListener('abort',() => reject(init.signal.reason),{once:true});
      reply = resolve;
    });
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const [MiB,limit] of [[1,120_000],[2,180_000],[15,900_000]]) {
    const stalled = dropboxTransport({endpoint:'upload',body:new Uint8Array(MiB * 1024 * 1024)});
    t.mock.timers.tick(limit - 1);
    assert.equal(request.signal.aborted,false);
    t.mock.timers.tick(1);
    await assert.rejects(stalled,errorOf('unavailable'));
  }
  const payload = text('fictional settings');
  const slow = dropboxTransport({endpoint:'upload',body:payload});
  assert.equal(request.body,payload);
  t.mock.timers.tick(119_000);
  let controller;
  reply(new Response(new ReadableStream({start(value) { controller = value; }})));
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(119_000);
  controller.enqueue(new Uint8Array(2));
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(119_000);
  assert.equal(request.signal.aborted,false);
  controller.close();
  assert.equal((await slow).bytes.length, 2);
  const limited = dropboxTransport({endpoint:'upload'});
  reply(new Response(null,{status:429,headers:{'Retry-After':'120'}}));
  assert.equal((await limited).retryAfter, '120');
});
