import { readCsv, writeCsv } from './csv.ts';
import { dropboxContentHash, isDropboxTimestamp, type DropboxUpload } from './dropbox-api.ts';
import { DropboxError } from './dropbox-client.ts';
import { checkDropboxFile } from './dropbox-limits.ts';
import type { SettingRow } from './model.ts';
import { isProviderKey, publicSettings, publicSettingsSync, type ProviderKey, type ProviderSession } from './provider-credentials.ts';
import { StaleSnapshotError, type DeviceStore, type FileSyncState } from './storage.ts';
import { SyncFiles, type Download, type SyncApi } from './dropbox-sync-file.ts';

const settingsPath = '/settings.csv';
const encode = (rows: readonly SettingRow[]) => writeCsv('settings', [...rows]);
const credentials = (rows: readonly SettingRow[]) => rows.filter(row => isProviderKey(row.setting));

export function settingsRows(content: string | Uint8Array): SettingRow[] {
  const result = readCsv('settings', content);
  if (result.stopped || result.schema !== 'known' || result.findings.length) {
    throw Error('Repair the unreadable or newer settings.csv before changing Dropbox settings.');
  }
  return result.rows;
}
export function settingsWithoutKeys(content: string | Uint8Array): string {
  const rows = settingsRows(content);
  if (rows.some(row => isProviderKey(row.setting))) return encode(publicSettings(rows));
  return typeof content === 'string' ? content : new TextDecoder('utf-8', {fatal:true,ignoreBOM:true}).decode(content);
}
const remoteRows = (file: Download | null) => file ? settingsRows(file.bytes) : [];

/** A lost reply can obscure delivery without obscuring what the device actually submitted. */
function legacyUploadRows(pending: FileSyncState['pending'] | undefined) {
  if (!pending) return;
  const validTarget = pending.targetRevision === null
    ? pending.targetContent === null && pending.targetModified === null
    : typeof pending.targetRevision === 'string' && pending.targetRevision && pending.targetContent !== null &&
      isDropboxTimestamp(pending.targetModified);
  if (!validTarget) return;
  try {
    return {target:pending.targetContent === null ? [] : settingsRows(pending.targetContent),sent:settingsRows(pending.content)};
  } catch { /* Unreadable evidence still needs the ordinary settings guard. */ }
}

/** Account-switch approval needs only the presence of credentials quarantined for the prior owner. */
export async function hasUnmigratedProviderKeys(store: Pick<DeviceStore,'legacyProviderSettings'>): Promise<boolean> {
  const legacy = await store.legacyProviderSettings();
  if (legacy.migrated) return false;
  if (legacy.rows.some(row => isProviderKey(row.setting))) return true;
  const copies = [legacy.sync?.base?.content,legacy.sync?.pending?.content,legacy.sync?.pending?.targetContent];
  return copies.some(content => {
    if (content == null) return false;
    try { return settingsRows(content).some(row => isProviderKey(row.setting)); }
    catch { return true; }
  });
}

/** The ordinary three-way merge and its persistent receipts see only preferences.
 * A conditional upload carries forward the exact target revision's current credentials. */
export class DropboxSettingsFiles implements SyncApi {
  private readonly api: SyncApi;
  readonly settingsHashTag: (hash:string)=>Promise<string>;
  constructor(api: SyncApi, tag:(hash:string)=>Promise<string>) { this.api = api; this.settingsHashTag = tag; }
  list(path?: string) { return this.api.list(path); }
  revisions(...args:Parameters<SyncApi['revisions']>) { return this.api.revisions(...args); }
  async download(path: string) {
    const file = await this.api.download(path);
    if (path !== settingsPath || !file) return file;
    return { metadata: file.metadata, bytes: new TextEncoder().encode(settingsWithoutKeys(file.bytes)) };
  }
  private async withLiveCredentials(content: string | Uint8Array, revision: string | null) {
    const live = await this.api.download(settingsPath);
    if ((live?.metadata.rev ?? null) !== revision) throw new DropboxError('conflict');
    const complete = encode([...publicSettings(settingsRows(content)), ...credentials(remoteRows(live))]);
    checkDropboxFile(settingsPath,complete);
    return complete;
  }
  async settingsHash(content: string, revision: string | null) {
    return this.settingsHashTag(await dropboxContentHash(await this.withLiveCredentials(content, revision)));
  }
  async upload(path: string, content: string | Uint8Array, options: DropboxUpload) {
    if (path !== settingsPath) return this.api.upload(path, content, options);
    if (options.mode === 'overwrite') throw Error('A settings update requires its Dropbox revision.');
    const payload = await this.withLiveCredentials(content, options.revision ?? null);
    return this.api.upload(path, payload, options);
  }
}

interface CredentialStore extends Pick<DeviceStore, 'legacyProviderSettings' | 'finishProviderMigration' |
    'loadProviderKeys' | 'snapshot' | 'commit' | 'providerContentTag'> {}
type Decide = (names: string[], uncertain: boolean, evidence: string) => Promise<'device' | 'dropbox' | 'cancel'>;

export class DropboxProviderSettings {
  private readonly store: CredentialStore;
  private readonly api: SyncApi;
  private readonly session: ProviderSession;
  private readonly now: () => number;
  private readonly active: () => boolean;
  private readonly decide: Decide;
  constructor(store: CredentialStore, api: SyncApi, session: ProviderSession, now: () => number, active: () => boolean, decide: Decide) {
    this.store = store; this.api = api; this.session = session;
    this.now = now; this.active = active; this.decide = decide;
  }

  private check() {
    if (!this.active() || this.now() >= this.session.signInDeadline) throw new DropboxError('account-changed');
  }
  private async read() {
    this.check();
    const file = await this.api.download(settingsPath);
    this.check();
    return { rows: remoteRows(file), revision: file?.metadata.rev ?? null };
  }

  /** A lost success reply is settled by reading the current file. A changed revision
   * never authorizes overwriting an unrelated edit made by another device. */
  private async write(rows: SettingRow[], revision: string | null, current: () => boolean,
      confirms?: (live: SettingRow[]) => boolean) {
    const content = encode(rows);
    this.check();
    if (!current()) throw new StaleSnapshotError();
    try {
      await this.api.upload(settingsPath, content, revision ? { mode:'update', revision } : { mode:'add' });
    } catch (error) {
      if ((error as {kind?:string})?.kind === 'conflict') throw error;
      const observed = await this.read();
      if (!(confirms ? confirms(observed.rows) : encode(observed.rows) === content)) throw error;
      rows = observed.rows;
    }
    // DropboxApi.upload verifies the returned path, revision, length and content hash.
    // A separate download is needed only when the upload acknowledgement is missing.
    this.check();
    if (!current()) throw new StaleSnapshotError();
    return rows;
  }

  async save(key: ProviderKey, expected: string | null, next: string | null, current: () => boolean) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const { rows, revision } = await this.read();
      const previous = rows.find(row => row.setting === key)?.value ?? null;
      if (!current()) throw new StaleSnapshotError();
      if (previous === next) return rows;
      if (previous !== expected) throw Error('This key changed in Dropbox. Sync and review the saved key before changing it.');
      const updated = rows.filter(row => row.setting !== key);
      if (next !== null) updated.push({setting:key, value:next});
      try {
        return await this.write(updated, revision, current,
          live => (live.find(row => row.setting === key)?.value ?? null) === next);
      }
      catch (error) { if ((error as {kind?:string})?.kind !== 'conflict') throw error; }
    }
    throw Error('Dropbox settings kept changing. Try saving the key again.');
  }

  /** Settle a legacy receipt using its original bytes and conditional target. The
   * acknowledgement remains in memory until the migration can purge every local copy
   * together. An interrupted run can settle that original receipt again. */
  private async legacyBase(state: FileSyncState | null, revision: bigint, inspectOnly: boolean, rows:SettingRow[]) {
    let latest = state;
    if (!state?.pending) return {state, uncertain:false};
    const shadow: Pick<DeviceStore,'snapshot'|'commit'> = {
      snapshot: async () => {
        const snapshot = await this.store.snapshot();
        this.check();
        if (snapshot.revision !== revision) throw new StaleSnapshotError();
        return {...snapshot,tables:{...snapshot.tables,settings:rows},sync:{...snapshot.sync,settings:latest!}};
      },
      commit: async (_expected, patch) => { this.check(); latest = patch.sync!.settings!; },
    };
    const outcome = await new SyncFiles(shadow, this.api, this.session, this.now).settle('settings',inspectOnly);
    return {state:latest,uncertain:Boolean(outcome.unresolved),delivery:outcome.delivery};
  }

  async load(inspectOnly = false) {
    const legacy = await this.store.legacyProviderSettings();
    this.check();
    if (!legacy.migrated) {
      const settled = await this.legacyBase(legacy.sync,legacy.revision,inspectOnly,legacy.rows);
      const state = settled.state;
      let uncertain = settled.uncertain;
      const live = await this.read();
      let baseRows: SettingRow[] = [];
      if (state?.base) {
        try { baseRows = settingsRows(state.base.content); }
        catch { uncertain = true; }
      }
      const rows = credentials(legacy.rows);
      const localKeys = new Map(rows.map(row=>[row.setting, row.value]));
      const baseKeys = new Map(credentials(baseRows).map(row=>[row.setting, row.value]));
      const cloudKeys = new Map(credentials(live.rows).map(row=>[row.setting, row.value]));
      const delivery = settled.delivery;
      const keyValues = (content:string|null) => new Map(credentials(content ? settingsRows(content) : []).map(r=>[r.setting,r.value]));
      const sharedBase = delivery && keyValues(delivery.pending.content), independentBase = delivery && keyValues(delivery.pending.targetContent);
      const unknownUpload = uncertain ? legacyUploadRows(state?.pending) : undefined;
      // A key absent from both known upload copies and this device can only have come from Dropbox.
      const uncertainNames = unknownUpload ? credentials([...unknownUpload.target,...unknownUpload.sent]).map(row=>row.setting)
        : uncertain ? cloudKeys.keys() : [];
      const next = new Map(cloudKeys);
      const conflicts: string[] = [];
      const adopt = (name: string) => {
        const value = localKeys.get(name);
        if (value === undefined) next.delete(name); else next.set(name,value);
      };
      const unresolved = Symbol();
      const mergedKey = (base:string|undefined,mine:string|undefined,cloud:string|undefined) =>
        mine === cloud || mine === base ? cloud : cloud === base ? mine : unresolved;
      for (const name of new Set([...localKeys.keys(), ...(unknownUpload ? [] : baseKeys.keys()), ...(sharedBase?.keys() ?? []),
          ...(independentBase?.keys() ?? []), ...uncertainNames])) {
        if (localKeys.get(name) === cloudKeys.get(name)) continue;
        if (sharedBase && independentBase) {
          const mine = localKeys.get(name), cloud = cloudKeys.get(name);
          const shared = mergedKey(sharedBase.get(name),mine,cloud), separate = mergedKey(independentBase.get(name),mine,cloud);
          if (shared === unresolved || shared !== separate) conflicts.push(name);
          else if (shared === mine) adopt(name);
        } else if (uncertain) conflicts.push(name);
        else if (localKeys.get(name) !== baseKeys.get(name)) {
          if (cloudKeys.get(name) === baseKeys.get(name)) adopt(name);
          else conflicts.push(name);
        }
      }
      if (conflicts.length) {
        const unknown = uncertain || !!delivery;
        const evidence = await this.store.providerContentTag(JSON.stringify([unknown,[...conflicts].sort().map(name=>
          [name,localKeys.get(name) ?? null,cloudKeys.get(name) ?? null])]));
        this.check();
        const answer = await this.decide(conflicts,unknown,evidence);
        this.check();
        if (answer === 'cancel') throw Error('Dropbox settings migration paused. Your existing data has been retained.');
        if (answer === 'device') conflicts.forEach(adopt);
      }
      const proposed = [...publicSettings(live.rows), ...Array.from(next, ([setting,value]) => ({setting,value}))];
      if ((await this.store.legacyProviderSettings()).revision !== legacy.revision) throw new StaleSnapshotError();
      if (encode(proposed) !== encode(live.rows)) await this.write(proposed, live.revision, this.active);
      const confirmed = await this.read();
      if (encode(confirmed.rows) !== encode(proposed)) throw Error('Dropbox settings changed during migration. Try syncing again.');
      let clean = state && publicSettingsSync(state);
      if (clean?.pending && delivery) {
        const pending = clean.pending;
        if (pending.content === (pending.targetContent ?? encode([]))) {
          clean = {...clean,base:{revision:delivery.revision,content:pending.content},pending:null};
        } else {
          // A key decision cannot choose between two possible preference merges. Retain
          // the redacted receipt and a keyed fingerprint of the original key-bearing bytes.
          const tag = await this.store.providerContentTag(await dropboxContentHash(delivery.pending.content));
          clean = {...clean,pending:{...pending,settingsContentHash:tag,inspectOnly:true}};
        }
      } else if (clean && uncertain) {
        // A key-only upload kept its target's preferences in both possible histories.
        // A changed or unreadable preference payload keeps its redacted receipt for the guard.
        clean = {...clean,base:null};
        if (unknownUpload) {
          const content = encode(publicSettings(unknownUpload.target)), revision = clean.pending?.targetRevision;
          if (content === encode(publicSettings(unknownUpload.sent))) {
            clean = {...clean,base:revision ? {revision,content} : null,pending:null};
          }
        }
      }
      await this.store.finishProviderMigration(legacy.revision, clean, this.session, this.active);
      await this.store.loadProviderKeys(this.session, confirmed.rows, this.active);
    } else {
      const live = await this.read();
      await this.store.loadProviderKeys(this.session, live.rows, this.active);
    }
  }
}
