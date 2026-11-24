import { clearDropboxAttempt, DropboxAuth, type DropboxIdentity, type RevokeResult } from './dropbox-auth.ts';
import { DropboxApi } from './dropbox-api.ts';
import { DropboxError, isTemporaryDropboxFailure } from './dropbox-client.ts';
import { reloadOnlineBuild } from './offline.ts';
import type { SyncHooks } from './dropbox-sync.ts';
import type { BackupGeneration } from './dropbox-backup.ts';
import { resetLabels, type ResetScope } from './dropbox-reset-options.ts';
import { StaleSnapshotError, type DeviceStore, type RecordChange } from './storage.ts';
import type { DropboxDialogs } from './dropbox-dialogs.ts';
import type { MergeTable } from './model.ts';

type Operation = 'sync'|'backup'|'restore'|'import'|'hand merge'|'sign out'|'erase'|'account'|'sign in'|'save key'|'clear Dropbox';
type State = Awaited<ReturnType<DeviceStore['dropboxState']>>;
const pendingSync = 'Sync pending.';
async function fileOperations() {
  try { return await import('./dropbox-file-operations.ts'); }
  catch (cause) { throw new Error('Dropbox tools could not load. Reload csvTV and try again.',{cause}); }
}
export class DropboxController {
  readonly changed = new EventTarget();
  readonly store:DeviceStore;
  readonly auth:DropboxAuth;
  readonly win:Window;
  readonly dialogs:DropboxDialogs;
  readonly now:()=>number;
  hooks:SyncHooks = {};
  reloadInstalledShell?: () => Promise<string | undefined>;
  notices:string[] = [];
  reason = 'Sign in to Dropbox.';
  synced = false;
  signedIn = false;
  unfinishedSignOut = '';
  linked = true;
  registrationUnknown = false;
  mismatch = false;
  operation:Operation|null = null;
  #events = new AbortController();
  #timer?:number;
  #expiryTimer?:number;
  #dirty = false;
  #generation = 0;
  #queued = false;
  #waitingKey?: {run:()=>Promise<void>; cancel:()=>void};
  #explicit = false;
  #reopening = false;
  #retriedSignOut = '';
  #postponed?: {binding:DropboxIdentity; files:Map<MergeTable,string|null>; clear?:string; keys?:string};
  #displayedSession: (DropboxIdentity & {owner:string|null}) | null = null;
  #displayedOwner: string|null = null;
  #backupOwner?: DropboxIdentity & { deadline:number };
  #pair = '';
  #refreshNumber = 0;
  #opened = false;
  #hiddenAt:number|null = null;
  #utcDate = '';
  #closed = false;
  #reloading = false;
  #adoptedReset = '';
  #backupsClearedAt = 0;
  get busy() { return this.operation !== null; }
  get canBackUpNow() {
    return !this.#closed && !this.busy && this.store.role === 'writer' && this.win.navigator.onLine &&
      !!this.#backupOwner && this.#backupOwner.deadline > this.now();
  }

  constructor(auth:DropboxAuth, win:Window, dialogs:DropboxDialogs, now:()=>number = Date.now) {
    this.store = auth.store; this.auth = auth; this.win = win; this.dialogs = dialogs; this.now = now;
    this.store.connectProviderKeys?.(async (key, expected, next, current, installed) => {
      const owner = this.#backupOwner;
      if (!owner || !current()) throw Error('Sign in to the linked Dropbox account to save a key.');
      try {
        const save = async () => {
          if (!current()) throw new StaleSnapshotError();
          const {providerSettings} = await this.backupAccess(owner);
          return providerSettings.save(key,expected,next,current);
        };
        if (this.operation !== 'sync') return await this.exclusive('save key', save);
        if (this.#waitingKey) throw Error('Another provider key is being saved.');
        return await new Promise<Awaited<ReturnType<typeof save>>>((resolve,reject) => {
          this.#waitingKey = {
            cancel:() => reject(new StaleSnapshotError()),
            run:async () => {
              try { resolve(await save()); } catch (error) { reject(error); }
              // Publishing derived files also checks the local record revision. Finish the local key change first.
              await installed;
            },
          };
        });
      } catch (error) { this.queueSync(); throw error; }
    },now);
    const opt = { signal:this.#events.signal };
    auth.addEventListener('change', () => void this.refresh(), opt);
    auth.addEventListener('expiry-notice', e => this.report((e as CustomEvent<string>).detail), opt);
    this.store.addEventListener('deviceerased', () => {
      this.store.clearProviderKeys?.();
      clearDropboxAttempt(win);
      this.dialogs.close(true);
      this.notices = [];
    }, opt);
    this.store.addEventListener('rolechange', () => {
      if (this.store.role === 'closed' || this.store.role === 'obsolete') {
        this.store.clearProviderKeys?.();
        this.#refreshNumber++;
        this.dialogs.close(true);
      } else void this.refresh(true);
    },opt);
    this.store.addEventListener('dropboxstatus', () => void this.refresh(),opt);
    this.store.addEventListener('recordchange', e => {
      const change = (e as CustomEvent<RecordChange>).detail;
      if (!change.syncWrite && change.tables.length) this.edited();
    },opt);
    this.store.addEventListener('summarychange', () => this.edited(),opt);
    this.store.addEventListener('cachechange', () => this.edited(),opt);
    win.addEventListener('online', () => { this.#retriedSignOut = ''; void this.refresh().then(() => this.queueSync()); },opt);
    win.addEventListener('offline', () => void this.refresh(),opt);
    win.document.addEventListener('visibilitychange', () => {
      const now = this.now();
      if (win.document.visibilityState === 'hidden') {
        this.#hiddenAt = now;
        if (this.#dirty) this.queueSync();
      } else {
        const reopen = this.#hiddenAt !== null && now - this.#hiddenAt >= 60_000;
        this.#hiddenAt = null;
        const newDay = this.#utcDate !== new Date(now).toISOString().slice(0,10);
        if (reopen) void this.refresh(true);
        else void this.refresh().then(() => { if (newDay) this.queueSync(); });
      }
    },opt);
  }

  notify() { if (!this.#closed) this.changed.dispatchEvent(new Event('change')); }
  report(message:string) {
    if (!this.notices.includes(message)) this.notices.push(message);
    this.hooks.notice?.(message); this.notify();
  }
  #reportGroup(label:string,messages:string[]) {
    this.notices = Array.from(new Set([...this.notices,...messages]));
    if (this.hooks.noticeGroup) this.hooks.noticeGroup(label,messages);
    else for (const message of messages) this.hooks.notice?.(message);
    this.notify();
  }
  edited() {
    if (this.#closed || this.store.role !== 'writer') return;
    this.#generation++; this.#dirty = true; this.synced = false;
    if (this.signedIn && !this.mismatch && !this.unfinishedSignOut) this.reason = 'Changes are waiting to sync.';
    this.notify();
    // A scheduled sync already covers this change. Debouncing here would replace its immediate start.
    if (this.#queued) return;
    this.win.clearTimeout(this.#timer);
    this.#timer = this.win.setTimeout(() => this.queueSync(),10_000);
  }
  queueSync(explicit = false, opening = false) {
    if (this.#closed || this.store.role !== 'writer') return;
    this.win.clearTimeout(this.#timer);
    this.#dirty = false; this.#queued = true; this.#explicit ||= explicit; this.#reopening ||= opening;
    if (!this.busy) this.#timer = this.win.setTimeout(() => void this.#drain(),0);
  }
  async #drain() {
    if (this.busy || !this.#queued || this.#closed) return;
    this.#queued = false;
    const manual = this.#explicit, retry = manual || this.#reopening;
    this.#explicit = false; this.#reopening = false;
    if (!this.signedIn || this.unfinishedSignOut || this.mismatch || !this.win.navigator.onLine || this.store.role !== 'writer') return;
    this.#dirty = false;
    try { await this.exclusive('sync', () => this.syncFiles(retry,undefined,{automatic:!manual})); }
    catch { /* syncFiles publishes the outcome. A new trigger starts a fresh run. */ }
  }
  /** The same sync retains the operation lock and its file/revision evidence across this handoff. */
  async #serveWaitingKey() {
    const request = this.#waitingKey;
    if (!request || this.operation !== 'sync') return false;
    this.#waitingKey = undefined;
    this.operation = 'save key'; this.notify();
    try { await request.run(); }
    finally { this.operation = 'sync'; this.notify(); }
    return true;
  }
  async exclusive<T>(kind:Operation, work:()=>Promise<T>):Promise<T> {
    if (this.#closed || this.store.role !== 'writer' || this.busy) throw Error('Another operation is using this device.');
    this.operation = kind; this.notify();
    try { return await work(); }
    finally {
      if (kind === 'sync') while (this.#waitingKey) await this.#serveWaitingKey();
      this.operation = null; this.notify();
      if (this.#queued && !this.#closed) this.queueSync(this.#explicit);
      void this.refresh();
    }
  }
  async refresh(open = false):Promise<void> {
    if (this.#closed || this.store.role === 'closed' || this.store.role === 'obsolete') return;
    this.#opened ||= open;
    const seq = ++this.#refreshNumber;
    let state:State;
    try { state = await this.store.dropboxState(); } catch { return; }
    if (seq !== this.#refreshNumber || this.#closed) return;
    open = this.#opened;
    this.#opened = false;
    const session = state.session;
    const id = session?.instanceId ?? '';
    const pair = JSON.stringify([state.accountId,id,session?.accountId]);
    const changed = id !== (this.#displayedSession?.instanceId ?? '');
    if (changed || (this.#pair && this.#pair !== pair)) this.dialogs.close();
    const now = this.now();
    this.signedIn = !!session && Number.isFinite(session.signInDeadline) && session.signInDeadline > now;
    this.unfinishedSignOut = session ? this.auth.pendingSignOut?.(id) ?? '' : '';
    this.linked = !!state.accountId;
    this.registrationUnknown = this.linked && !state.recordAppKey;
    this.auth.showRegistration(state);
    this.#displayedOwner = state.accountId;
    this.mismatch = this.signedIn && !this.unfinishedSignOut && state.accountId !== session?.accountId;
    if (changed || !this.signedIn || this.mismatch || this.unfinishedSignOut) this.store.clearProviderKeys?.();
    this.#backupOwner = session && this.signedIn && !this.unfinishedSignOut && state.accountId === session.accountId
      ? {accountId:session.accountId,instanceId:session.instanceId,deadline:session.signInDeadline} : undefined;
    const today = new Date(now).toISOString().slice(0,10);
    const status = state.status && state.status.accountId === state.accountId && state.status.instanceId === id ? state.status : null;
    if (this.operation !== 'sync' && (changed || this.store.role === 'reader')) this.notices = status?.notices ?? [];
    if (this.unfinishedSignOut) {
      this.synced = false;
      this.reason = this.unfinishedSignOut;
    } else if (!this.signedIn || this.mismatch || !this.win.navigator.onLine) {
      this.synced = false;
      this.reason = !this.signedIn ? 'Sign in to Dropbox.' : this.mismatch ? 'Choose which Dropbox account to use.'
        : 'No connection. Changes stay on this device.';
    } else if (this.operation !== 'sync') {
      this.synced = !this.registrationUnknown && !!status?.synced && status.day === today && !state.dirty && !this.#dirty;
      this.reason = status && !(status.synced && this.registrationUnknown) && !state.dirty && !this.#dirty && status.day === today
        ? status.reason : 'Changes are waiting to sync.';
      // Older writers saved this marker before sending their first request.
      if (this.reason === 'The previous sync did not finish.') this.reason = pendingSync;
    }
    this.#displayedSession = session ? {owner:state.accountId, accountId:session.accountId, instanceId:id} : null;
    if (this.win.document.visibilityState !== 'hidden') this.#utcDate = today;
    this.win.clearTimeout(this.#expiryTimer);
    if (this.signedIn && this.store.role === 'reader') this.#expiryTimer = this.win.setTimeout(() => void this.refresh(),
      Math.min(session!.signInDeadline - now, 2_000_000_000));
    if (session && !this.signedIn && this.store.role === 'writer') void this.auth.checkDeadline().catch(() => {});
    this.notify();
    if (this.unfinishedSignOut) {
      if (!this.busy && this.store.role === 'writer' && this.win.navigator.onLine && this.#retriedSignOut !== id) {
        void this.signOut().catch(() => {});
      }
      return;
    }
    if (this.mismatch && this.store.role === 'writer' && !this.busy && this.#pair !== pair) {
      this.#pair = pair;
      void this.#account(state).catch(error => this.report(this.failure(error)));
    } else if (!this.mismatch) {
      this.#pair = '';
      if ((open || changed) && this.signedIn && this.win.navigator.onLine) this.queueSync(false,open || changed);
    }
  }
  failure(error:unknown) {
    if (error instanceof StaleSnapshotError) return 'The record changed. Review the current record and try again.';
    if (error instanceof DOMException && error.name === 'QuotaExceededError') return 'Local storage is full. The change was not saved.';
    return error instanceof Error ? error.message : 'Dropbox could not complete the request.';
  }
  async #boundAccess(expected?:DropboxIdentity, requireOnline = true) {
    const requireAccess = () => {
      if (this.#closed || this.store.role !== 'writer') throw Error('A writer tab is required.');
      if (requireOnline && !this.win.navigator.onLine) throw new DropboxError('unavailable');
    };
    requireAccess();
    const s = await this.auth.status();
    requireAccess();
    if (!s.session || !Number.isFinite(s.session.signInDeadline) || !(s.session.signInDeadline > this.now())) throw Error('Sign in to Dropbox.');
    if (this.auth.pendingSignOut?.(s.session.instanceId)) throw new DropboxError('sign-out-pending');
    if (s.accountId !== s.session.accountId) throw Error('Choose which Dropbox account to use.');
    if (expected && (expected.accountId !== s.accountId || expected.instanceId !== s.session.instanceId)) {
      throw new DropboxError('account-changed');
    }
    const binding:DropboxIdentity = {accountId:s.session.accountId,instanceId:s.session.instanceId};
    return {state:s,binding,raw:new DropboxApi(this.auth,binding),session:{...binding,signInDeadline:s.session.signInDeadline}};
  }
  async backupAccess(expected?:DropboxIdentity, automatic = false) {
    const [{state,binding,raw,session},operations] = await Promise.all([this.#boundAccess(expected),fileOperations()]);
    const {adoptReset,checkResetEpoch,checkResetHistory,reserveBackupWriter,resetEpoch,resetMarker,reviewMergeDestination,
      DropboxProviderSettings,restoreBackup,restoreOutcomeLabel,DropboxSync} = operations;
    if (this.#postponed?.binding.accountId !== binding.accountId || this.#postponed.binding.instanceId !== binding.instanceId)
      this.#postponed = {binding,files:new Map()};
    const postponed = this.#postponed;
    const fence = await resetMarker(raw);
    this.#backupsClearedAt = fence.marker.backupsClearedAt;
    const epoch = resetEpoch(fence);
    const stamp = JSON.stringify([binding.accountId,binding.instanceId,!!fence.revision,epoch]);
    let markerSeen = !!fence.revision;
    const observe = async (live:typeof fence) => {
      if (!live.revision || markerSeen) return;
      // The very first backup can create the shared marker while this operation is running.
      await adoptReset(raw,this.store,live,session,this.now);
      markerSeen = true;
    };
    const api = new DropboxApi(this.auth,binding,async()=>observe(await checkResetEpoch(raw,epoch,markerSeen)),
      folder=>reserveBackupWriter(raw,epoch,folder,markerSeen,observe));
    const providerSettings = new DropboxProviderSettings(this.store,api,session,this.now,
      () => !this.#closed && this.store.role === 'writer' && this.win.navigator.onLine &&
        this.#backupOwner?.instanceId === binding.instanceId && this.#backupOwner?.accountId === binding.accountId,
      async (names,uncertain,evidence) => {
        if (automatic && postponed.keys === evidence) return 'cancel';
        const reason = uncertain ? 'An earlier settings upload has an unknown outcome. ' : '';
        const keys = 'The copies differ for ' + names.join(', ') + '. ';
        const answer = await this.dialogs.choose('Move saved keys to Dropbox',reason + keys +
          'Choose which saved keys to keep for this account. Cancel leaves the migration pending.',
          [{value:'cancel',label:'Cancel'}, {value:'dropbox',label:'Keep Dropbox keys'}, {value:'device',label:'Use this device’s keys'}]);
        const decision = answer === 'dropbox' || answer === 'device' ? answer : 'cancel';
        postponed.keys = decision === 'cancel' ? evidence : undefined;
        return decision;
      });
    const hooks:SyncHooks = { ...this.hooks,
      postponed:(table,revision) => postponed.files.set(table,revision),
      guard:q => this.dialogs.guard(q), doubleMarks:q => this.dialogs.doubleMarks(q), identities:q => this.dialogs.identities(q),
      valueDelivery:q => this.dialogs.valueDelivery(q),
      hold:t => this.dialogs.hold(t), notice:m => this.report(m), noticeGroup:(label,items) => this.#reportGroup(label,items),
      reload:() => void this.reload(),
      restoreDevice:async (table,content,engine,displayedRevision) => {
        const outcome = await restoreBackup(api, engine, new Map([[table, content]]), {
          onSaved: () => this.queueSync(), guardTarget: { table, revision: displayedRevision, content },
        });
        const outcomeText = restoreOutcomeLabel[outcome.files.get(table) ?? 'untouched'];
        this.report(table + '.csv · ' + outcomeText);
        if (outcome.issue || outcome.files.get(table) !== 'restored') throw Error([outcome.issue, outcomeText].filter(Boolean).join(' '));
      },
    };
    const load = typeof this.store.legacyProviderSettings === 'function' ? (inspectOnly = false) => providerSettings.load(inspectOnly) : undefined;
    // A backup can create and witness the first marker after this controller last checked the folder.
    if (!fence.revision || stamp !== this.#adoptedReset) {
      const local = await this.store.dropboxResetState?.(binding.accountId);
      checkResetHistory(fence,local);
      if (local?.entering) await reviewMergeDestination(raw,this.store,fence,session,this.now,scopes=>
        this.dialogs.choose('Merge into ' + binding.accountId + '?','This account previously cleared ' +
          scopes.map(scope=>resetLabels[scope]).join(', ') + '. Choose which rows to use for those categories.',
          [{value:'cancel',label:'Cancel'},{value:'dropbox',label:'Use Dropbox copies'},{value:'include',label:'Include this device’s rows'}]));
      const adopted = await adoptReset(raw,this.store,fence,session,this.now,load,async(scopes,evidence)=>{
        if (automatic && postponed.clear === evidence) return 'cancel';
        const answer = await this.dialogs.choose('Review Dropbox clear history','Account ' + binding.accountId + '. csvTV cannot verify the order of older clears for ' +
          scopes.map(scope=>resetLabels[scope]).join(', ') + '. Keep local edits uses this device’s copy of those categories in the next sync. ' +
          'Use Dropbox replaces those categories on this device.',[
            {value:'cancel',label:'Decide later'},{value:'device',label:'Keep local edits'},{value:'dropbox',label:'Use Dropbox'}]);
        postponed.clear = answer === 'cancel' ? evidence : undefined;
        return answer;
      });
      if (adopted) this.hooks.answered?.();
      this.#adoptedReset = stamp;
    }
    return { api,binding,state,providerSettings,postponedFiles:postponed.files,engine:new DropboxSync(this.store,api,binding,hooks,this.now,load) };
  }
  async syncFiles(retryCanceled:boolean, expected?:DropboxIdentity, {weeklyBackup = true,automatic = false} = {}) {
    const generation = this.#generation;
    this.notices = []; this.synced = false; this.reason = 'Sync in progress.'; this.notify();
    let owner:DropboxIdentity|undefined = expected ?? this.#backupOwner;
    const today = () => new Date(this.now()).toISOString().slice(0,10);
    const saveStatus = async (synced:boolean, reason:string, day = today()) => {
      if (!owner || this.#closed) return;
      await this.store.saveDropboxStatus({ ...owner, synced, reason, day,
        notices:[...this.notices] }, () => !this.#closed && (!synced || generation === this.#generation));
    };
    try {
      const {api,engine,binding,state,postponedFiles} = await this.backupAccess(owner,automatic);
      owner = binding;
      await saveStatus(false, pendingSync);
      const beforeMerge = this.operation === 'sync' ? () => this.#serveWaitingKey() : undefined;
      const previouslySynced = !state.dirty && !!state.status?.synced && state.status.accountId === binding.accountId &&
        state.status.instanceId === binding.instanceId;
      const run = await engine.run({retryCanceled,beforeMerge,previouslySynced,postponed:automatic ? postponedFiles : undefined});
      if (!run.complete) throw Error(run.reason || 'A file was left unsynced.');
      if (this.#waitingKey) await this.#serveWaitingKey();
      const publicationTime = this.now(), publicationDay = new Date(publicationTime).toISOString().slice(0,10);
      const {publishDerived,writeBackup} = await fileOperations();
      await publishDerived(this.store,api,run.listing,binding,publicationTime,run.exportRecord);
      if (weeklyBackup && (!this.#backupsClearedAt || this.now() - this.#backupsClearedAt >= 7 * 86400_000)) {
        if (this.#waitingKey) await this.#serveWaitingKey();
        await writeBackup(api,{weekly:true,now:this.now()});
      }
      const current = await this.auth.status();
      if (current.accountId !== binding.accountId || current.session?.instanceId !== binding.instanceId ||
          current.session.signInDeadline <= this.now()) throw new DropboxError('account-changed');
      this.synced = generation === this.#generation && publicationDay === today();
      this.reason = this.synced ? 'Every file is synced.' : 'Changes are waiting to sync.';
      await saveStatus(this.synced, this.reason, publicationDay);
      if (publicationDay !== today()) {
        this.synced = false; this.reason = 'Changes are waiting to sync.';
        this.queueSync();
      }
    } catch (error) {
      this.synced = false; this.reason = this.failure(error);
      try { await saveStatus(false, this.reason); } catch { /* Preserve the original failed operation. */ }
      throw error;
    }
    finally { this.notify(); }
  }
  async backUpNow():Promise<BackupGeneration> {
    // Pin the identity last displayed by Settings, before any asynchronous work.
    const expected = this.#backupOwner;
    if (!expected || expected.deadline <= this.now()) throw Error('Sign in to the linked Dropbox account to back up.');
    return this.exclusive('backup',async () => {
      await this.backupAccess(expected);
      // This preflight handles already scheduled edits and explicit sync requests. Later triggers still queue.
      this.win.clearTimeout(this.#timer);
      this.#queued = this.#explicit = this.#reopening = false;
      const generation = this.#generation;
      // The manual generation also satisfies the weekly backup when that one is due.
      await this.syncFiles(true,expected,{weeklyBackup:false});
      const {api,state} = await this.backupAccess(expected);
      const status = state.status;
      if (!status?.synced || status.accountId !== expected.accountId || status.instanceId !== expected.instanceId ||
          status.day !== new Date(this.now()).toISOString().slice(0,10) || state.dirty || generation !== this.#generation) {
        throw Error(status && !status.synced ? status.reason : 'Changes are waiting to sync. Try backing up again.');
      }
      this.#dirty = false;
      const {writeBackup} = await fileOperations();
      const backup = await writeBackup(api,{now:this.now()});
      if (!backup) throw Error('Dropbox did not confirm a backup.');
      try { await this.backupAccess(expected); }
      catch (error) {
        if (!isTemporaryDropboxFailure(error)) throw error;
        // The backup was verified. A later outage can delay rechecking the remote clear history.
        await this.#boundAccess(expected,false);
      }
      return backup;
    });
  }
  async signIn() { return this.exclusive('sign in', () => this.auth.authorize(this.win)); }
  async clearDropbox(scopes:readonly ResetScope[], signal:AbortSignal) {
    const expected = this.#backupOwner;
    if (!expected || !this.canBackUpNow) throw Error('Sign in to the linked Dropbox account to clear data.');
    return this.exclusive('clear Dropbox',async () => {
      const [{raw:api},initial,{reviewReset,checkResetHistory,performReset}] = await Promise.all([
        this.#boundAccess(expected), this.store.dropboxState(), fileOperations(),
      ]);
      const valid = async () => {
        const state = await this.store.dropboxState();
        if (signal.aborted || this.#closed || this.store.role !== 'writer' || !this.win.navigator.onLine ||
            state.accountId !== expected.accountId || state.session?.instanceId !== expected.instanceId ||
            this.now() >= expected.deadline || state.revision !== initial.revision) throw new StaleSnapshotError();
      };
      await valid();
      const review = await reviewReset(api,scopes);
      checkResetHistory(review.fence,await this.store.dropboxResetState(expected.accountId));
      await valid();
      const choices = review.selected.map(s=>resetLabels[s]).join(', ');
      const answer = await this.dialogs.choose('Clear selected Dropbox data?',
        'Account ' + expected.accountId + '. Clear ' + choices + '. Update csvTV on every device before clearing so an older version cannot reupload these records. ' +
        (scopes.includes('backups') ? review.backups.filter(file=>file.size>0).length + ' files in csvTV-created backups will be cleared.' : 'Existing backups stay in Dropbox.'),
        [{value:'cancel',label:'Cancel'},{value:'clear',label:'Clear selected data',destructive:true}],undefined,signal);
      if (answer !== 'clear') return false;
      this.synced = false; this.reason = 'Clearing selected Dropbox data…'; this.notify();
      void this.dialogs.choose('Clearing selected Dropbox data…','Keep this page open until the clear finishes.',[]);
      try {
        await performReset(api,review,valid,this.now,time=>this.store.exportSnapshot(true,time,true));
        try { await this.backupAccess(expected); }
        catch (error) { throw new Error('Dropbox cleared the selected data. Sync again to update this device. ' + this.failure(error),{cause:error}); }
        this.hooks.answered?.();
        return true;
      } finally { this.dialogs.close(); this.queueSync(true); }
    });
  }
  #revocation(result:RevokeResult, recordKept = false) {
    const message = result === 'offline' ? 'Access may remain valid until you revoke csvTV in Dropbox.'
      : result === 'ended' ? 'This device no longer has a usable Dropbox sign-in.' : '';
    if (recordKept) this.report(('Signed out. Your watch record stays on this device. ' + message).trimEnd());
    else if (message) this.report(message);
  }
  async signOut() {
    const expected = this.#displayedSession;
    await this.exclusive('sign out', async () => {
      if (!expected) throw new DropboxError('signed-out');
      this.#retriedSignOut = expected.instanceId;
      this.#revocation(await this.auth.signOut(expected), true);
    });
  }
  async erase(expectedRevision:bigint) {
    await this.exclusive('erase', () => this.#erase(expectedRevision));
  }
  /** The shared-device shortcut only clears rows already acknowledged by Dropbox. */
  async clearLinkedDevice() {
    const owner = this.#displayedOwner, session = this.#displayedSession;
    await this.exclusive('erase', async () => {
      const {mergedTables,tableMatchesDropboxBase,hasUnmigratedProviderKeys} = await fileOperations();
      const [snapshot,state] = await Promise.all([this.store.snapshot(),this.store.dropboxState()]);
      const active = snapshot.local.dropboxSession;
      if (!owner || state.revision !== snapshot.revision || snapshot.local.syncAccountId !== owner || (active?.instanceId ?? null) !== (session?.instanceId ?? null) ||
          (active && active.accountId !== owner)) throw new StaleSnapshotError();
      if (state.dirty || !mergedTables.every(table => tableMatchesDropboxBase(snapshot,table)) ||
          await hasUnmigratedProviderKeys(this.store)) {
        throw Error('Changes are waiting for Dropbox. Sign in and sync before clearing this device.');
      }
      const answer = await this.dialogs.choose('Clear this device?',
        'Remove csvTV’s watch record, settings and sign-in from this browser. Your synced record stays in Dropbox. On a shared browser, also sign out of dropbox.com.',
        [{value:'cancel',label:'Cancel'}, {value:'erase',label:'Clear this device',destructive:true}]);
      if (answer === 'erase' && !this.#closed) await this.#erase(snapshot.revision);
    });
  }
  async #erase(expectedRevision:bigint, accountDeadline?:number) {
    const current = () => !this.#closed && this.store.role === 'writer' &&
      (accountDeadline === undefined || this.now() < accountDeadline);
    const state = await this.store.dropboxState();
    if (state.revision !== expectedRevision || !current()) throw new StaleSnapshotError();
    const outcome = state.session ? await this.auth.revokeForErase({
      owner:state.accountId, accountId:state.session.accountId, instanceId:state.session.instanceId,
    }, expectedRevision) : null;
    await this.store.eraseDevice(expectedRevision, current);
    if (outcome) this.#revocation(outcome);
    this.synced = false; this.hooks.answered?.();
  }
  async #account(state:State) {
    const expected = state.session!;
    try {
      await this.exclusive('account',async () => {
        const choice = await this.dialogs.choose('Choose your Dropbox account',
          'This device’s record belongs to ' + state.accountId + '. You signed in to ' + expected.accountId + '.',
          [{value:'cancel',label:'Cancel'}, {value:'merge',label:'Merge into this account'},
            {value:'erase',label:'Erase this device’s data first',destructive:true}]);
        if (this.#closed || this.store.role !== 'writer') return;
        const stillCurrent = (owner:unknown, session:State['session']) =>
          !this.#closed && this.store.role === 'writer' && owner === state.accountId &&
          session?.instanceId === expected.instanceId && session.accountId === expected.accountId &&
          session.signInDeadline === expected.signInDeadline && expected.signInDeadline > this.now();
        const pair = {owner:state.accountId,accountId:expected.accountId,instanceId:expected.instanceId};
        if (choice !== 'merge' && choice !== 'erase') {
          if (choice !== 'cancel') return;
          const latest = await this.auth.status();
          if (!stillCurrent(latest.accountId,latest.session)) return;
          this.hooks.answered?.();
          this.#revocation(await this.auth.signOut(pair));
          return;
        }
        const operations = await fileOperations();
        if (this.#closed || this.store.role !== 'writer') return;
        const snap = await this.store.snapshot();
        if (!stillCurrent(snap.local.syncAccountId ?? null,snap.local.dropboxSession ?? null)) return;
        this.hooks.answered?.();
        if (choice === 'merge') {
          const {mergedTables,hasUnmigratedProviderKeys} = operations;
          if (typeof this.store.legacyProviderSettings === 'function' && await hasUnmigratedProviderKeys(this.store)) {
            this.#revocation(await this.auth.signOut(pair));
            await this.refresh();
            this.report('Sign back in to the original Dropbox account to finish moving its saved keys before changing accounts.');
            return;
          }
          const sync = Object.fromEntries(mergedTables.map(t => [t,{base:null,pending:null,lastClientModified:snap.sync[t]?.lastClientModified ?? null}]));
          await this.store.commit(snap.revision,{sync,local:{syncAccountId:expected.accountId,dropboxMergeDestination:expected.accountId,
            ...(state.grantAppKey && {syncAppKey:state.grantAppKey})},removeLocal:[
            'dropboxResetSeen','dropboxShowsHash','dropboxUnknownFiles', ...mergedTables.map(t=>'dropboxCanceled:'+t)]},
            {syncWrite:true,current:()=>!this.#closed && this.store.role === 'writer' && expected.signInDeadline > this.now()});
          this.queueSync(true);
        }
        if (choice === 'erase') {
          const {mergedTables,unsyncedCount} = operations;
          const counts = mergedTables.map(t => unsyncedCount(snap,t));
          const count = counts.includes(null) ? 'An unknown number of' : String(counts.reduce<number>((a,b)=>a+(b ?? 0),0));
          const yes = await this.dialogs.choose('Erase this device’s data?',count + ' unsynced changes will be lost. An outstanding upload may still arrive.',
            [{value:'cancel',label:'Cancel'},{value:'erase',label:'Erase this device',destructive:true}]);
          if (yes === 'erase' && !this.#closed) { await this.#erase(snap.revision, expected.signInDeadline); if (!this.#closed) await this.auth.authorize(this.win); }
        }
      });
    } finally { this.#pair = ''; if (!this.#closed) void this.refresh(); }
  }
  async reload() {
    if (this.#reloading || this.#closed) return;
    this.#reloading = true;
    try {
      let message = await this.reloadInstalledShell?.();
      if (message === undefined && !this.#closed) message = await reloadOnlineBuild(this.win, () => !this.#closed,
        {beforeReload: () => this.store.closeForUpdate(true)});
      if (message && !this.#closed) this.report(message);
    } finally { this.#reloading = false; }
  }
  close(options?: {finishSubmittedCallback?:boolean}) {
    this.#closed = true; this.win.clearTimeout(this.#timer);
    this.#waitingKey?.cancel(); this.#waitingKey = undefined;
    this.store.clearProviderKeys?.();
    this.win.clearTimeout(this.#expiryTimer);
    this.#events.abort(); this.dialogs.close(true); this.auth.close(options);
  }
}
