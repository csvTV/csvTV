import { captureDropboxCallback, DropboxAuth } from '../../dist/dropbox-auth.js';
import { DropboxApi } from '../../dist/dropbox-api.js';
import { DropboxError, dropboxTransport, checkResponse, jsonObject } from '../../dist/dropbox-client.js';
import { openDeviceStore } from '../../dist/storage.js';

const modeKey = 'csvTV/dropbox-probe-mode';
const local = { revision: 0n, accountId: null, recordAppKey:null, session: null };
// All token material for this isolated provider probe lives only in memory.
const store = new EventTarget();
let attemptStore;
async function attempts() {
  return attemptStore ??= openDeviceStore({name:'csvTV-dropbox-provider-probe-attempts'});
}
const cooldowns = new Map();
Object.assign(store, { role: 'writer', dropboxAuthState: async account => ({...structuredClone(local), cooldown:cooldowns.get(account)}),
  dropboxState: async () => ({revision:local.revision,accountId:local.accountId,recordAppKey:local.recordAppKey,session:local.session && {
    accountId:local.session.accountId,instanceId:local.session.instanceId,signInDeadline:local.session.signInDeadline}}),
  startDropboxAttempt: async id => {
    const device = await attempts(); await device.whenWriter(); return device.startDropboxAttempt(id);
  },
  dropboxAttemptFence: async () => (await attempts()).dropboxAttemptFence(),
  claimDropboxAttempt: async (id,erased,current) => (await attempts()).claimDropboxAttempt(id,erased,current),
  saveDropboxRenewal: async (expected,accessToken,accessExpiresAt,erased,current) => {
    const fence = await (await attempts()).dropboxAttemptFence();
    if (!current() || fence.erased !== erased || local.accountId !== expected.accountId ||
        local.session?.instanceId !== expected.instanceId) return false;
    if (local.session.accessToken === expected.accessToken && local.session.accessExpiresAt === expected.accessExpiresAt)
      Object.assign(local.session,{accessToken,accessExpiresAt});
    return true;
  },
  saveDropboxCooldown: async (binding, value, current) => {
    if (!current() || local.session?.instanceId !== binding.instanceId) throw Error('The test sign-in changed.');
    if (value) cooldowns.set(binding.accountId, value); else cooldowns.delete(binding.accountId);
  },
  storeExchangedSession: async (session,current,erased,claim) => {
    const fence = await (await attempts()).dropboxAttemptFence();
    if (!current() || fence.erased !== erased || fence.attempt !== claim) throw Error('The test sign-in changed.');
    local.accountId = session.accountId; local.recordAppKey = session.appKey; local.session = session; local.revision++;
  },
  commit: async (revision, change) => {
    if (revision !== local.revision) throw Error();
    local.session = change.local?.dropboxSession ?? null;
    local.revision++;
  } });
const report = Object.fromEntries(['exchange','neverExisted','identicalAdd','listing','download','revisions','serverTime','cleanup','renewal','revocation']
  .map(key => [key, 'unverified']));
const descriptions = {
  exchange: {
    accepted: 'A fresh sign-in succeeded with the requested two-minute refresh-token expiry.',
    refused: 'Dropbox refused the required refresh-token expiry. Sign-in stopped.',
    bounded: 'A fresh sign-in succeeded with the required seven-day refresh-token expiry.',
  },
  neverExisted: {
    empty: 'Dropbox returned an empty revision list for the never-created file.',
    'not-found': 'Dropbox reported the never-created file as missing when asked for its revisions.',
    failed: 'Dropbox returned an unexpected result for the never-created file.',
  },
  identicalAdd: {
    accepted: 'Dropbox accepted a strict add of identical bytes at the existing path.',
    refused: 'Dropbox returned a file conflict for a strict add of identical bytes at the existing path.',
  },
  listing: {
    passed: 'Each immediate folder listing included the uploaded revision.',
    failed: 'An immediate folder listing omitted the uploaded revision.',
  },
  download: {
    passed: 'Each immediate download matched the uploaded revision and contents.',
    failed: 'An immediate download did not match the uploaded revision and contents.',
  },
  revisions: {
    passed: 'Each immediate revision history included the uploaded revision.',
    failed: 'An immediate revision history omitted the uploaded revision.',
  },
  serverTime: {
    passed: 'Server modification times stayed the same or increased across the sampled writes.',
    failed: 'A later sampled write had an earlier server modification time.',
  },
  cleanup: {
    passed: 'Dropbox acknowledged deletion of the empty test folder.',
    failed: 'Cleanup of the test folder could not be confirmed.',
  },
  renewal: {
    accepted: 'Dropbox accepted the refresh token after the requested expiry.',
    refused: 'Dropbox refused the refresh token after the requested expiry.',
    unverified: 'Renewal after the requested expiry could not be verified.',
  },
  revocation: {
    passed: 'The refresh token worked immediately before sign-out. Dropbox refused the same token immediately afterward.',
    failed: 'Dropbox continued to accept the refresh token after acknowledging sign-out.',
    unverified: 'The effect of sign-out on the refresh token could not be verified.',
  },
};
export function describeObservation(key, value, renewal) {
  if (key === 'revocation' && value === 'unverified' && renewal === 'refused') {
    return 'Dropbox had already refused the refresh token before sign-out, so this run could not verify revocation.';
  }
  return descriptions[key]?.[value];
}
function record(key, value) {
  report[key] = value;
  const message = describeObservation(key, value, report.renewal);
  if (!message) return;
  const line = document.createElement('li');
  line.textContent = message;
  document.querySelector('#results').append(line);
}
function mark(key, condition) { record(key, condition ? 'passed' : 'failed'); }
let expiry = 0;
async function observe(req) {
  if (req.endpoint === 'token') {
    const p = new URLSearchParams(req.body);
    if (p.has('refresh_token_expiration_seconds')) expiry = Number(p.get('refresh_token_expiration_seconds')) * 1000;
  }
  const reply = await dropboxTransport(req);
  if (req.endpoint === 'revisions' && !Object.hasOwn(JSON.parse(req.body), 'before_rev') && JSON.parse(req.body).path.endsWith('/never-created.csv')) {
    if (reply.status === 200) {
      const entries = JSON.parse(new TextDecoder().decode(reply.bytes)).entries;
      record('neverExisted', Array.isArray(entries) && entries.length === 0 ? 'empty' : 'failed');
    }
    else {
      try { checkResponse(reply); } catch (error) { record('neverExisted', error.kind === 'not-found' ? 'not-found' : 'failed'); }
    }
  }
  return reply;
}
function auth(key, mode) { return new DropboxAuth(store, key, { transport: observe, providerLifetimeMs: mode === 'files' ? 120_000 : undefined }); }
async function tryRenewal(key, refreshToken, transport) {
  try {
    const reply = await transport({ endpoint: 'token', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: key, refresh_token: refreshToken }).toString() });
    const body = jsonObject(reply.bytes);
    if (reply.status === 400 || reply.status === 401) {
      return body.error === 'invalid_grant' ? 'refused' : 'unverified';
    }
    checkResponse(reply, true);
    return typeof body.access_token === 'string' && body.access_token && Number.isSafeInteger(body.expires_in) && body.expires_in > 0
      ? 'accepted' : 'unverified';
  } catch { return 'unverified'; }
}
export async function observeGrant(key, refreshToken, requestedExpiry, signOut, transport = dropboxTransport) {
  const before = await tryRenewal(key, refreshToken, transport);
  const renewal = requestedExpiry ? before : 'skipped';
  let revocation = 'unverified';
  try {
    const result = await signOut();
    if (result === 'revoked' && before === 'accepted') {
      const after = await tryRenewal(key, refreshToken, transport);
      if (after === 'refused') revocation = 'passed';
      if (after === 'accepted') revocation = 'failed';
    }
  } catch { /* A lost sign-out reply leaves the effect of revocation unknown. */ }
  return { renewal, revocation };
}
async function checkFiles(session) {
  let folderCreated = false, uploadAttempted = false, recoveryPath = '', failure = '';
  const folder = '/csvtv-probe-' + crypto.randomUUID();
  const path = folder + '/fictional.csv';
  const api = new DropboxApi(session);
  try {
    recoveryPath = folder;
    await api.createFolder(folder); folderCreated = true;
    await api.revisions(folder + '/never-created.csv');
    let previous;
    const checks = { listing: true, download: true, revisions: true, serverTime: true };
    async function checkAfterWrite(current, payload) {
      const [listing, copy, history] = await Promise.all([api.list(folder), api.download(path), api.revisions(path)]);
      checks.listing &&= listing.some(x => x.rev === current.rev);
      checks.download &&= copy?.metadata.rev === current.rev && new TextDecoder().decode(copy.bytes) === payload;
      checks.revisions &&= history.some(x => x.rev === current.rev);
      checks.serverTime &&= !previous || Date.parse(previous.serverModified) <= Date.parse(current.serverModified);
      previous = current;
    }
    for (let i = 0; i < 4; i++) {
      const payload = 'show,year\r\nFictional,' + (2000 + i) + '\r\n';
      uploadAttempted = true;
      const current = await api.upload(path, payload, previous ? { mode: 'update', revision: previous.rev } : { mode: 'add' });
      await checkAfterWrite(current, payload);
      if (i === 0) {
        let duplicate;
        try { duplicate = await api.upload(path, payload, { mode: 'add' }); }
        catch (error) { if (!(error instanceof DropboxError) || error.kind !== 'conflict') throw error; record('identicalAdd', 'refused'); }
        if (duplicate) { record('identicalAdd', 'accepted'); await checkAfterWrite(duplicate, payload); }
      }
    }
    for (const [key, ok] of Object.entries(checks)) mark(key, ok);
  } catch (error) { failure = error instanceof DropboxError ? error.message : 'The file probe stopped before completion.'; }
  finally {
    try {
      if (folderCreated) {
        if (uploadAttempted) {
          try { await api.delete(path); }
          catch (error) { if (error.kind !== 'not-found') throw error; }
        }
        if (!(await api.list(folder)).length) { await api.delete(folder); recoveryPath = ''; }
        record('cleanup', recoveryPath ? 'failed' : 'passed');
      }
    } catch { record('cleanup', 'failed'); }
  }
  return [failure, recoveryPath ? 'Cleanup could not be confirmed. Check the development App Folder for ' + recoveryPath + '.' : ''].filter(Boolean).join(' ');
}

async function run() {
  let callback = captureDropboxCallback(window);
  const keyField = document.querySelector('#key'), full = document.querySelector('#signin'), revoke = document.querySelector('#revoke-only');
  const status = document.querySelector('#status');
  if (!callback) {
    keyField.value = await (await fetch('/key')).json();
    full.disabled = revoke.disabled = false;
    async function start(mode) {
      full.disabled = revoke.disabled = true;
      try {
        sessionStorage.setItem(modeKey, mode);
        await auth(keyField.value,mode).authorize(window);
      } catch {
        status.textContent = 'Enter the public App Folder app key and try again.';
        full.disabled = revoke.disabled = false;
      }
    }
    full.onclick = () => start('files');
    revoke.onclick = () => start('revocation');
    return;
  }
  const key = callback.ticket?.appKey ?? '', mode = sessionStorage.getItem(modeKey);
  keyField.value = '';
  const session = auth(key,mode);
  let fileMessage = '';
  try {
    const exchanged = await session.finishCallback(window, callback);
    callback = null;
    if (!exchanged) { session.close(); return; }
    record('exchange', mode === 'files' ? 'accepted' : 'bounded');
    sessionStorage.removeItem(modeKey);
    if (mode === 'files') {
      status.textContent = 'Checking the isolated test folder…';
      fileMessage = await checkFiles(session);
    } else {
      for (const field of ['neverExisted', 'identicalAdd', 'listing', 'download', 'revisions', 'serverTime', 'cleanup']) report[field] = 'skipped';
      status.textContent = 'Checking the new grant before and after sign-out…';
    }
  } catch (error) {
    if (error instanceof DropboxError && error.kind === 'expiry-unsupported') record('exchange','refused');
    fileMessage = error instanceof DropboxError ? error.message : 'The sign-in test stopped before completion.';
  }
  try {
    const grant = local.session;
    if (grant && mode === 'files') {
      // Test Dropbox's own expiry without a local timer revoking the grant first.
      session.close();
      status.textContent = 'Waiting until the requested provider expiry to test renewal. Keep this tab open.';
      await new Promise(r => setTimeout(r, Math.max(0, expiry + 5000 - Date.now())));
      const evidence = await observeGrant(key,grant.refreshToken,true,async () => {
        checkResponse(await dropboxTransport({endpoint:'revoke',headers:{Authorization:'Bearer '+grant.accessToken}}));
        return 'revoked';
      });
      record('renewal',evidence.renewal);
      record('revocation',evidence.revocation);
    } else if (grant) {
      const evidence = await observeGrant(key, grant.refreshToken, false, () => session.signOut());
      record('renewal',evidence.renewal);
      record('revocation', evidence.revocation);
    } else record('renewal', 'skipped');
  } catch { record('revocation', 'unverified'); }
  finally {
    callback = null;
    local.session = null;
    local.accountId = null;
    local.recordAppKey = null;
    await attemptStore?.then(device=>device.closeForUpdate());
    sessionStorage.removeItem(modeKey);
    session.close();
    status.textContent = [fileMessage, 'Provider test finished. The observations are listed below.'].filter(Boolean).join(' ');
    try {
      const submitted = await fetch('/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report) });
      if (!submitted.ok) throw Error();
    } catch { status.textContent += ' The local runner could not receive the report.'; }
  }
}
if (typeof window !== 'undefined') run().catch(() => {
  document.querySelector('#status').textContent = 'The test stopped before it could finish. Check the development app settings and try again.';
});
