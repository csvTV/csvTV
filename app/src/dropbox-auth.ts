import type { DeviceStore, ExchangedSession } from './storage.ts';
import { effectiveDropboxDeadline, StaleSnapshotError } from './storage.ts';
import { browsingSignal, checkResponse, DropboxError, dropboxTransport, jsonObject } from './dropbox-client.ts';
import type { DropboxRequest, DropboxResponse, DropboxTransport } from './dropbox-client.ts';
import { dropboxTransfer } from './dropbox-rate-limit.ts';
import { DropboxApi } from './dropbox-api.ts';
import {attemptKey, attemptMarker, callbackKey, captureDropboxCallback, currentTicket, dropboxRedirectUri, signInWindow, ticketKey, type DropboxCallback} from './dropbox-return.ts';
export {captureDropboxCallback, clearDropboxAttempt, prepareDropboxCallback, type DropboxCallback} from './dropbox-return.ts';

const week = 7 * 24 * 60 * 60 * 1000;
export interface DropboxIdentity { accountId: string; instanceId: string }
type State = Awaited<ReturnType<DeviceStore['dropboxState']>>;
type Pair = DropboxIdentity & { owner: string | null };
export type RevokeResult = 'revoked' | 'ended' | 'offline';
const signOutKey = 'csvTV-unfinished-dropbox-signout';
type SignOutState = {ended:boolean|null; durable:boolean};

function unfinishedSignOutMessage(state:SignOutState):string {
  let remote = 'Sign-out is incomplete.';
  if (state.ended !== null) remote = state.ended ? 'Dropbox access has ended.' : 'Dropbox revocation is unconfirmed.';
  return remote + (state.durable ? ' Free device storage and finish signing out.'
    : ' Only this tab has paused Dropbox. Free device storage and finish signing out before closing it.');
}

function base64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function tokenLifetime(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new DropboxError('failed');
  return value * 1000;
}
function same(session: DropboxIdentity | null, other: DropboxIdentity) {
  return session?.accountId === other.accountId && session.instanceId === other.instanceId;
}
function isExpired(session: ExchangedSession, now: number) {
  return now >= effectiveDropboxDeadline(session);
}

export class DropboxAuth extends EventTarget {
  readonly store: DeviceStore;
  readonly #registration: string | ((linked:boolean) => string);
  #linked = false;
  #recordAppKey: string | null = null;
  #checkingRegistration?: {instance:string; result:Promise<void>};
  #candidate(linked:boolean): string {
    return (typeof this.#registration === 'string' ? this.#registration : this.#registration(linked)).trim();
  }
  get appKey(): string {
    return this.#recordAppKey || this.#candidate(this.#linked);
  }
  showRegistration(state:Pick<State,'accountId'|'recordAppKey'>) {
    this.#linked = !!state.accountId;
    this.#recordAppKey = state.recordAppKey;
  }
  readonly #send: DropboxTransport;
  readonly #now: () => number;
  readonly #online: () => boolean;
  readonly #sleep: (ms:number) => Promise<void>;
  readonly #providerLifetime: number;
  readonly #active = new AbortController();
  #finishSubmittedCallback = false;
  #renewal?: { session: ExchangedSession; result: Promise<void>; reader?:AbortSignal };
  #pendingSignOut?: {instanceId:string;ended:boolean};
  #timer?: ReturnType<typeof setTimeout>;
  #timerGeneration = 0;
  #changed = () => {
    this.dispatchEvent(new Event('change'));
    void this.#schedule().catch(() => {});
  };
  constructor(store: DeviceStore, appKey: string | ((linked:boolean) => string), options: {
    transport?: DropboxTransport; now?: () => number; online?: () => boolean; sleep?: (ms:number) => Promise<void>;
    /** An isolated provider experiment can request an earlier *server* expiry. */
    providerLifetimeMs?: number;
  } = {}) {
    super();
    this.store = store; this.#registration = appKey;
    this.#send = options.transport ?? dropboxTransport;
    this.#now = options.now ?? Date.now;
    this.#online = options.online ?? (() => navigator.onLine);
    this.#sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.#providerLifetime = options.providerLifetimeMs ?? week;
    if (!Number.isSafeInteger(this.#providerLifetime) || this.#providerLifetime < 1000 || this.#providerLifetime > week) {
      throw new RangeError('Dropbox refresh-token lifetime must be between one second and seven days.');
    }
    const listeners = { signal: this.#active.signal };
    store.addEventListener('dropboxchange', this.#changed, listeners);
    store.addEventListener('rolechange', this.#changed, listeners);
    if (typeof window !== 'undefined') window.addEventListener('storage',event => {
      if (event.key === signOutKey || event.key === null) this.#changed();
    },listeners);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.#changed();
    }, listeners);
    void this.#schedule().catch(() => {});
  }
  close({finishSubmittedCallback=false}: {finishSubmittedCallback?:boolean} = {}) {
    if (!this.#active.signal.aborted || !finishSubmittedCallback) this.#finishSubmittedCallback=finishSubmittedCallback;
    this.#active.abort(); this.#timerGeneration++; clearTimeout(this.#timer);
  }
  status(): Promise<State> { return this.store.dropboxState(); }
  #storedSignOut():string|null {
    try { return globalThis.window?.localStorage.getItem(signOutKey) ?? null; } catch { return null; }
  }
  #signOutState(id:string): SignOutState|null {
    const remembered = this.#pendingSignOut?.instanceId === id ? this.#pendingSignOut : null;
    if (this.#storedSignOut() === id) return {ended:remembered?.ended ?? null,durable:true};
    return remembered ? {ended:remembered.ended,durable:false} : null;
  }
  pendingSignOut(id:string):string {
    const state = this.#signOutState(id);
    return state ? unfinishedSignOutMessage(state) : '';
  }
  #removeSignOutHint(value:string) {
    try {
      if (value === this.#storedSignOut()) window.localStorage.removeItem(signOutKey);
    } catch { /* A remaining hint only applies to the retired instance. */ }
  }
  #forgetSignOut(id:string) {
    if (this.#pendingSignOut?.instanceId === id) this.#pendingSignOut = undefined;
    this.#removeSignOutHint(id);
  }
  #requireWriter() {
    if (this.store.role !== 'writer' || this.#active.signal.aborted) throw new DropboxError('failed');
  }

  async #schedule() {
    const current = ++this.#timerGeneration;
    clearTimeout(this.#timer);
    const hint = this.#storedSignOut(), remembered = this.#pendingSignOut;
    const { session } = await this.store.dropboxAuthState(undefined,'request');
    if (this.#active.signal.aborted || current !== this.#timerGeneration || this.store.role !== 'writer') return;
    if (hint && hint !== session?.instanceId) this.#removeSignOutHint(hint);
    if (remembered && remembered === this.#pendingSignOut && remembered.instanceId !== session?.instanceId) this.#pendingSignOut = undefined;
    if (!session) return;
    if (isExpired(session, this.#now())) { await this.checkDeadline(); return; }
    this.#timer = setTimeout(() => { void this.#schedule().catch(() => {}); },
      Math.min(2_147_483_647, Math.max(0, effectiveDropboxDeadline(session) - this.#now())));
  }

  async authorize(win: Window): Promise<void> {
    this.#requireWriter();
    this.showRegistration(await this.store.dropboxState('registration'));
    const appKey = this.appKey;
    if (!appKey) throw new DropboxError('unconfigured');
    const url = new URL(win.location.href);
    const attemptId = crypto.randomUUID();
    const ticket = { verifier: base64url(crypto.getRandomValues(new Uint8Array(48))),
      state: base64url(crypto.getRandomValues(new Uint8Array(32))), appKey, uri: dropboxRedirectUri(url),
      createdAt: this.#now(), attemptId, eraseGeneration:String(await this.store.startDropboxAttempt(attemptId)) };
    const challenge = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ticket.verifier));
    const params = new URLSearchParams({ client_id: appKey, response_type: 'code', code_challenge: base64url(new Uint8Array(challenge)),
      code_challenge_method: 'S256', token_access_type: 'offline', state: ticket.state, redirect_uri: ticket.uri,
      scope: 'files.metadata.read files.content.read files.content.write' });
    this.#requireWriter();
    if (appKey !== this.appKey) throw new DropboxError('failed');
    win.sessionStorage.removeItem(callbackKey(url));
    win.sessionStorage.setItem(attemptKey,attemptMarker(ticket));
    win.sessionStorage.setItem(ticketKey, JSON.stringify(ticket));
    win.location.assign('https://www.dropbox.com/oauth2/authorize?' + params);
  }

  async finishCallback(win: Window, callback: DropboxCallback | null = captureDropboxCallback(win, this.#now())): Promise<boolean> {
    if (!callback) return false;
    const { ticket, code } = callback;
    if (!ticket || !code) throw new DropboxError('callback');
    const providerExpiresAt = Math.floor((this.#now() + this.#providerLifetime) / 1000) * 1000;
    const marker = attemptMarker(ticket);
    let submitted=false;
    this.showRegistration(await this.store.dropboxState('registration'));
    const current = () => {
      const now = this.#now();
      if ((this.#active.signal.aborted && !(submitted && this.#finishSubmittedCallback)) || !ticket.appKey || ticket.appKey !== this.appKey ||
          !currentTicket(ticket, now) || now >= providerExpiresAt) return false;
      try { return win.sessionStorage.getItem(attemptKey) === marker; } catch { return false; }
    };
    try {
      const claim = await this.store.claimDropboxAttempt(ticket.attemptId ?? null,ticket.eraseGeneration ?? '0',current);
      if (!claim) throw new DropboxError('callback-submitted');
      if (!current()) throw new DropboxError('callback');
      if (claim === 'completed') return false;
      if (claim === 'replaced') throw new DropboxError('callback-replaced');
      submitted=true;
      const reply = await this.#token({grant_type:'authorization_code', code, code_verifier:ticket.verifier,
        redirect_uri:ticket.uri, client_id:ticket.appKey, refresh_token_expiration_seconds:String(providerExpiresAt / 1000)},
        {timeoutMs:Math.min(ticket.createdAt+signInWindow,providerExpiresAt)-this.#now()});
      if (!current()) throw new DropboxError('callback');
      if (typeof reply.account_id !== 'string' || !reply.account_id || typeof reply.refresh_token !== 'string' ||
        !reply.refresh_token || typeof reply.access_token !== 'string' || !reply.access_token) throw new DropboxError('failed');
      await this.store.storeExchangedSession({accountId:reply.account_id, appKey:ticket.appKey, instanceId:crypto.randomUUID(),
        ...(ticket.attemptId && {completedAttempt:ticket.attemptId}), refreshToken:reply.refresh_token,
        accessToken:reply.access_token, accessExpiresAt:this.#now() + tokenLifetime(reply.expires_in), signInDeadline:providerExpiresAt,
        providerExpiresAt}, current, claim.erased, claim.id);
    } catch (error) {
      if (error instanceof StaleSnapshotError || !current()) throw new DropboxError('callback');
      if (error instanceof DropboxError && error.kind === 'renewal-refused') throw new DropboxError('callback');
      throw error;
    } finally {
      try { if (win.sessionStorage.getItem(attemptKey) === marker) win.sessionStorage.removeItem(attemptKey); }
      catch { /* The consumed code cannot be retried if tab storage has become unavailable. */ }
    }
    return true;
  }

  async #token(fields: Record<string, string>, {session, revoking=false, reader, timeoutMs}: {
      session?:ExchangedSession; revoking?:boolean; reader?:AbortSignal; timeoutMs?:number
    } = {}): Promise<Record<string, unknown>> {
    const request: DropboxRequest = { endpoint: 'token', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(), tokenTimeoutMs:timeoutMs };
    const response = session ? await this.#transfer(session, () => request, revoking,reader) : await this.#send(request);
    checkResponse(response, true);
    return jsonObject(response.bytes);
  }
  async #renewToken(session: ExchangedSession, revoking = false, reader?:AbortSignal, appKey = session.appKey || this.appKey) {
    let reply: Record<string, unknown>;
    try { reply = await this.#token({ client_id: appKey, grant_type: 'refresh_token', refresh_token: session.refreshToken }, {session,revoking,reader}); }
    catch (error) {
      // A refused client ends ordinary renewal here. An invalid grant identifies
      // an unusable credential. A client error leaves the grant's status unknown.
      if (!revoking && error instanceof DropboxError && (error.kind === 'unauthorized' || error.kind === 'invalid-client')) {
        throw new DropboxError('renewal-refused');
      }
      throw error;
    }
    if (reply.account_id !== undefined && reply.account_id !== session.accountId) throw new DropboxError('account-changed');
    if (typeof reply.access_token !== 'string' || !reply.access_token) throw new DropboxError('failed');
    return { ...session, accessToken: reply.access_token, accessExpiresAt: this.#now() + tokenLifetime(reply.expires_in) };
  }
  async #removeSession(expected: Pair, active?: () => boolean) {
    // CAS covers the owner and session along with all intervening edits in the transaction.
    while (true) {
      if (active && !active()) return false;
      const current = await this.status();
      if (active && !active()) return false;
      if (current.accountId !== expected.owner || !same(current.session, expected)) throw new DropboxError('account-changed');
      try {
        await this.store.commit(current.revision, { removeLocal: ['dropboxSession'] },
          {current:active});
        return true;
      } catch (error) { if (!(error instanceof StaleSnapshotError)) throw error; }
    }
  }
  async #revokeCaptured(session: ExchangedSession): Promise<RevokeResult> {
    if (!this.#online()) return 'offline';
    try {
      const revoke = (token: string) => this.#transfer(session, () => ({ endpoint: 'revoke', headers: { Authorization: 'Bearer ' + token } }), true);
      const current = session.accessExpiresAt > this.#now() ? session : await this.#renewToken(session, true);
      let response = await revoke(current.accessToken);
      if (response.status === 401 && current === session) {
        const renewed = await this.#renewToken(session, true);
        response = await revoke(renewed.accessToken);
      }
      checkResponse(response);
      return 'revoked';
    } catch (error) {
      return error instanceof DropboxError && error.kind === 'renewal-refused' ? 'ended' : 'offline';
    }
  }
  async revokeForErase(expected: Pair, revision: bigint): Promise<RevokeResult> {
    this.#requireWriter();
    const state = await this.store.dropboxAuthState();
    this.#requireWriter();
    if (state.revision !== revision || state.accountId !== expected.owner || !state.session || !same(state.session, expected)) {
      throw new StaleSnapshotError();
    }
    return this.#revokeCaptured(state.session);
  }
  async signOut(expected?: Pair): Promise<RevokeResult> {
    this.#requireWriter();
    const { accountId, recordAppKey, session } = await this.store.dropboxAuthState(undefined,'request');
    this.#requireWriter();
    if (expected && (expected.owner !== accountId || !same(session, expected))) throw new DropboxError('account-changed');
    if (!session) return 'ended';
    this.store.clearProviderKeys?.();
    const pending = this.#signOutState(session.instanceId);
    if (!pending && !recordAppKey && !session.appKey && accountId === session.accountId && this.#online() && !isExpired(session,this.#now())) {
      // A first sign-out just after upgrade can be the last opportunity to identify the existing grant.
      try { await this.#ensureRegistration(session); }
      catch { /* Sign-out remains available when the older link cannot be verified. */ }
      await this.#checkedState(session,undefined,false);
    }
    // A saved hint pauses use. Only an observed provider reply can establish revocation.
    const knownEnded = this.#pendingSignOut?.instanceId === session.instanceId && this.#pendingSignOut.ended;
    const result = knownEnded ? 'ended' : await this.#revokeCaptured(session);
    try { await this.#removeSession({ ...session, owner: accountId }); }
    catch (error) {
      if (!(error instanceof DOMException && error.name === 'QuotaExceededError')) throw error;
      const id = session.instanceId, ended = result !== 'offline';
      this.#pendingSignOut = {instanceId:id,ended};
      try { window.localStorage.setItem(signOutKey,id); } catch { /* The tab still pauses access. */ }
      this.#changed();
      throw new Error(this.pendingSignOut(id));
    }
    this.#forgetSignOut(session.instanceId);
    return result;
  }
  async checkDeadline(): Promise<boolean> {
    const { accountId, session } = await this.store.dropboxAuthState(undefined,'request');
    if (!session || !isExpired(session, this.#now())) return false;
    const active = () => !this.#active.signal.aborted && this.store.role === 'writer';
    if (active() && await this.#removeSession({ ...session, owner: accountId }, active)) {
      this.#forgetSignOut(session.instanceId);
      const legacy = !Number.isFinite(session.providerExpiresAt);
      void this.#revokeCaptured(session).then(result => {
        if (this.#active.signal.aborted || (!legacy && result !== 'offline')) return;
        let notice = legacy ? 'Sign in again to set a seven-day Dropbox expiry.' : 'Your Dropbox sign-in expired.';
        if (result === 'offline') notice += ' Revocation could not be confirmed. To end the old grant, disconnect csvTV in Dropbox.';
        this.dispatchEvent(new CustomEvent('expiry-notice', {detail:notice}));
      });
    }
    return true;
  }
  async #checkedState(expected?: DropboxIdentity, quotaAccount?: string, requireOnline = true) {
    this.#requireWriter();
    const { accountId, recordAppKey, session, cooldown } = await this.store.dropboxAuthState(quotaAccount,'request');
    this.#requireWriter();
    if (!session) throw new DropboxError('signed-out');
    if (this.#signOutState(session.instanceId)) throw new DropboxError('sign-out-pending');
    if (isExpired(session, this.#now())) {
      await this.checkDeadline();
      throw new DropboxError('expired');
    }
    if (accountId !== session.accountId || (expected && !same(session, expected))) throw new DropboxError('account-changed');
    if (requireOnline && !this.#online()) throw new DropboxError('unavailable');
    return {session, cooldown, recordAppKey};
  }
  async #checked(expected?: DropboxIdentity, requireOnline = true): Promise<ExchangedSession> {
    return (await this.#checkedState(expected,undefined,requireOnline)).session;
  }
  async #transfer(captured: ExchangedSession, request: (session: ExchangedSession) => DropboxRequest, revoking = false, signal?:AbortSignal) {
    return dropboxTransfer(this.store, captured.accountId, {
      now:this.#now, sleep:this.#sleep,
      inspect:async forReply => {
        this.#requireWriter();
        const state = revoking ? await this.store.dropboxAuthState(captured.accountId,'request')
          : await this.#checkedState(captured, captured.accountId, !forReply);
        // Record an in-flight quota response even if this reader has since left. The next admission can stop.
        if (!forReply) signal?.throwIfAborted();
        return {cooldown:state.cooldown, dispatch:async () => {
          this.#requireWriter();
          if (!this.#online()) throw new DropboxError('unavailable');
          if (!revoking && this.#signOutState(captured.instanceId)) throw new DropboxError('sign-out-pending');
          if (!revoking && isExpired(captured, this.#now())) throw new DropboxError('expired');
          return this.#send(request(revoking ? captured : state.session!));
        }};
      },
      save:value => this.store.saveDropboxCooldown(captured, value,
        () => !this.#active.signal.aborted && this.store.role === 'writer' && (revoking || !isExpired(captured, this.#now())), revoking),
    });
  }
  async #renew(expected: DropboxIdentity, rejected: ExchangedSession, reader?:AbortSignal):Promise<void> {
    const current = await this.#checked(expected);
    reader?.throwIfAborted();
    if (current.accessToken !== rejected.accessToken) return;
    const ongoing = this.#renewal;
    if (ongoing && same(ongoing.session, current)) {
      try { return await ongoing.result; }
      catch (error) {
        // A canceled reader may abandon renewal before it is sent. A different caller can still need it.
        if (!ongoing.reader?.aborted || error !== ongoing.reader.reason) throw error;
        reader?.throwIfAborted();
        return this.#renew(expected,rejected,reader);
      }
    }
    const result = this.#saveRenewal(current,reader);
    this.#renewal = { session: current, result, reader };
    try { await result; }
    finally { if (this.#renewal?.result === result) this.#renewal = undefined; }
  }
  async #saveRenewal(current: ExchangedSession, reader?:AbortSignal) {
    this.#requireWriter();
    if (isExpired(current, this.#now())) { await this.checkDeadline(); throw new DropboxError('expired'); }
    const {erased} = await this.store.dropboxAttemptFence();
    let next: ExchangedSession | null = null;
    try { next = await this.#renewToken(current,false,reader); } catch (error) {
      // The renewal reply belongs only to this session; a later exchange owns its own tokens.
      if (!(error instanceof DropboxError && error.kind === 'renewal-refused')) {
        await this.#checked(current,false);
        throw error;
      }
    }
    await this.#checked(current,false);
    const active = () => !this.#active.signal.aborted && this.store.role === 'writer' && !isExpired(current, this.#now());
    if (next) {
      if (await this.store.saveDropboxRenewal(current,next.accessToken,next.accessExpiresAt,erased,active)) return;
      if (!active()) throw new DropboxError(isExpired(current,this.#now()) ? 'expired' : 'failed');
      await this.#checked(current,false);
      throw new DropboxError('account-changed');
    }
    if (!await this.#removeSession({ ...current, owner: current.accountId }, active)) {
      throw new DropboxError(isExpired(current, this.#now()) ? 'expired' : 'failed');
    }
    throw new DropboxError('signed-out');
  }
  async #identifyOldGrant(session:ExchangedSession) {
    // A pre-upgrade grant can only be renewed by the registration that issued it.
    for (const key of new Set([this.appKey,this.#candidate(false)])) {
      if (!key) continue;
      try { return {...await this.#renewToken(session,false,undefined,key),appKey:key}; }
      catch (error) { if (!(error instanceof DropboxError && error.kind === 'renewal-refused')) throw error; }
    }
    throw new DropboxError('unverified-folder');
  }
  async #matchingFile(session:ExchangedSession, files:Awaited<ReturnType<DeviceStore['dropboxRegistrationEvidence']>>['files']) {
    // A new grant identifies its client, but the same account can contain several app folders.
    const api = new DropboxApi({request:req => this.#authenticated(req,session)});
    for (const file of files) {
      const knownRevision = (entry:{rev:string}) => file.revisions.includes(entry.rev);
      const match = (await api.revisions(file.path,undefined,Infinity,knownRevision)).find(knownRevision);
      if (match) return {path:file.path,rev:match.rev};
    }
  }
  async #verifyRegistration(expected:ExchangedSession) {
    let matched:{path:string;rev:string}|undefined;
    let verified:{prior:ExchangedSession; next:ExchangedSession & {appKey:string}}|undefined;
    for (;;) {
      this.#requireWriter();
      const state = await this.store.dropboxAuthState();
      const session = state.session;
      if (!session || state.accountId !== expected.accountId || !same(session,expected)) throw new DropboxError('account-changed');
      if (isExpired(session,this.#now())) throw new DropboxError('expired');
      this.showRegistration(state);
      if (state.recordAppKey) {
        if (state.recordAppKey !== session.appKey) throw new DropboxError('unverified-folder');
        return;
      }
      let key = session.appKey;
      if (key) {
        const evidence = await this.store.dropboxRegistrationEvidence();
        if (state.revision !== evidence.revision) continue;
        if (!evidence.files.some(file=>file.path === matched?.path && file.revisions.includes(matched.rev))) {
          matched = await this.#matchingFile(session,evidence.files);
          if (!matched) {
            if ((await this.status()).revision !== state.revision) continue;
            throw new DropboxError('unverified-folder');
          }
        }
      } else {
        verified ??= {prior:session,next:await this.#identifyOldGrant(session)};
        key = verified.next.appKey;
      }
      try {
        const access = verified && session.accessToken === verified.prior.accessToken && session.accessExpiresAt === verified.prior.accessExpiresAt
          ? verified.next : session;
        const grant = verified && {...session,appKey:key,accessToken:access.accessToken,accessExpiresAt:access.accessExpiresAt};
        await this.store.commit(state.revision,{local:{syncAppKey:key,...(grant && {dropboxSession:grant})}},{
          syncWrite:true,current:()=>!this.#active.signal.aborted && this.store.role === 'writer' && !isExpired(session,this.#now()),
          ...(grant && {requireDropboxAccess:{accessToken:session.accessToken,accessExpiresAt:session.accessExpiresAt}}),
        });
        this.#recordAppKey = key;
        return;
      } catch (error) {
        // An edit can change the record revision. A renewal can separately replace the reviewed access credentials.
        if (!(error instanceof StaleSnapshotError)) throw error;
      }
    }
  }
  async #ensureRegistration(session:ExchangedSession) {
    if (this.#checkingRegistration?.instance !== session.instanceId) {
      this.#checkingRegistration = {instance:session.instanceId,result:this.#verifyRegistration(session)};
    }
    const check = this.#checkingRegistration;
    try { await check.result; }
    finally { if (this.#checkingRegistration === check) this.#checkingRegistration = undefined; }
  }
  /** Every file operation, including reads that can replace local rows, first checks the record's registration. */
  async request(request: DropboxRequest, expected?: DropboxIdentity): Promise<DropboxResponse> {
    browsingSignal(request)?.throwIfAborted();
    const {session,recordAppKey} = await this.#checkedState(expected);
    if (!recordAppKey || recordAppKey !== session.appKey) {
      await this.#ensureRegistration(session);
      return this.#authenticated(request,await this.#checked(session));
    }
    return this.#authenticated(request,session);
  }
  /** Pin each transfer and its possible 401 retry to the account and session that started it. */
  async #authenticated(request: DropboxRequest, initial:ExchangedSession): Promise<DropboxResponse> {
    const signal = browsingSignal(request);
    signal?.throwIfAborted();
    const authenticate = async () => {
      let current = initial;
      const response = await this.#transfer(initial, session => {
        current = session;
        return { ...request, headers: { ...request.headers, Authorization: 'Bearer ' + session.accessToken } };
      },false,signal);
      // The reply has arrived. A connection change can block the next request without obscuring this one's outcome.
      await this.#checked(initial,false);
      signal?.throwIfAborted();
      return { response, sent: current };
    };
    if (!(initial.accessExpiresAt > this.#now())) await this.#renew(initial, initial, signal);
    let reply = await authenticate();
    if (reply.response.status === 401) {
      await this.#renew(initial, reply.sent, signal);
      reply = await authenticate();
    }
    checkResponse(reply.response);
    return reply.response;
  }
}
