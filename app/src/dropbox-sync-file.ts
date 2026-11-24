import { csvColumns, readCsv, writeCsv, writeCsvWithRows } from './csv.ts';
import { checkDropboxFile } from './dropbox-limits.ts';
import { retainRecentMarks } from './watch-record.ts';
import { recordTransferWorkerMinimum, sameReceipt } from './record-transaction.ts';
import { mergeRows, mergeWatched } from './merge.ts';
import { watchDeliveryChanges } from './watch-merge.ts';
import { canonicalListName, rowKey, type MergeTable, type TableRows, type WatchedRow } from './model.ts';
import { canceledKey, StaleSnapshotError, type DeviceChanges, type DeviceSnapshot, type DeviceStore,
  type FileSyncState, type PendingUpload } from './storage.ts';
import { dropboxContentHash, isDropboxTimestamp, type DropboxApi, type DropboxFile } from './dropbox-api.ts';
import { DropboxError } from './dropbox-client.ts';

export type SyncApi = Pick<DropboxApi, 'list' | 'download' | 'upload' | 'revisions'> & {
  settingsHash?(content: string, revision: string | null): Promise<string>;
  settingsHashTag?(hash:string):Promise<string>;
};
export type Download = { metadata: DropboxFile; bytes: Uint8Array };
export const mergedTables = ['watched', 'ratings', 'lists', 'settings'] as const;
export { canceledKey, sameReceipt };
export const filePath = (table: MergeTable) => '/' + table + '.csv';
export const fileState = (snapshot: Pick<DeviceSnapshot,'sync'>, table: MergeTable): FileSyncState =>
  snapshot.sync[table] ?? { base: null, pending: null, lastClientModified: null };


type RecordFile = Exclude<MergeTable,'settings'>;

/** A based merge has read the prior rows. Use individual writes when they save at least half the work on a nontrivial table. */
export function sparseRecordPatch<K extends RecordFile>(table: K, snapshot: DeviceSnapshot, patch: DeviceChanges, skipIdentical=false): DeviceChanges {
  const previous: readonly TableRows[K][] = snapshot.tables[table], next: readonly TableRows[K][] | undefined = patch.replace?.[table];
  if (!next?.length || previous.length < 32 || previous.length - next.length >= next.length / 2) return patch;
  // Normal membership deletes canonicalize their keys. Replace old IDs to physically remove both spellings.
  if (table === 'lists' && snapshot.tables.lists.some(row => canonicalListName(row.list) !== row.list)) return patch;
  const columns = csvColumns[table] as readonly (keyof TableRows[K])[];
  const missing = new Map(previous.map(row => [rowKey(table,row), row]));
  const put: TableRows[K][] = [];
  for (const row of next) {
    const key = rowKey(table,row), prior = missing.get(key);
    missing.delete(key);
    // A full replacement strips old device-only columns and keeps the canonical values.
    if (!prior || Object.keys(prior).length !== columns.length || !columns.every(column => Object.is(row[column], prior[column]))) {
      put.push(row);
      if (put.length * 2 >= next.length) return patch;
    }
  }
  const changed = put.length + missing.size;
  if ((!changed && !skipIdentical) || changed * 2 >= next.length) return patch;
  const replace = {...patch.replace};
  delete replace[table];
  if (!changed) return {...patch,replace};
  // rowKey encodes these three stores' numeric and tuple primary keys as JSON.
  const remove = [...missing.keys()].map(key => JSON.parse(key));
  return {...patch, replace, put:{...patch.put, [table]:put}, remove:{...patch.remove, [table]:remove}};
}

function recordPatch(snapshot:DeviceSnapshot,patch:DeviceChanges,table?:RecordFile) {
  const retained = retainRecentMarks(snapshot,patch,true);
  return {recentChanges:retained !== patch,changes:table ? sparseRecordPatch(table,snapshot,retained) : retained};
}

/** Transfer the changed rows only when a based merge or a reviewed Restore produced a sparse patch. */
function largeWatchTransfer(rows:WatchedRow[], patch:DeviceChanges) {
  const put = patch.put?.watched, remove = patch.remove?.watched;
  if (put && remove) return put.length + remove.length >= recordTransferWorkerMinimum ? {put,remove} : undefined;
  return rows.length >= recordTransferWorkerMinimum ? rows : undefined;
}

function compareTimestamps(left: string, right: string): number {
  const milliseconds = Date.parse(left) - Date.parse(right);
  if (milliseconds) return milliseconds;
  // Date.parse discards the rest of a fractional second. Preserve it when attributing an upload.
  const tail = (value: string) => (/\.(\d+)/.exec(value)?.[1] ?? '').slice(3).replace(/0+$/, '');
  const a = tail(left), b = tail(right);
  return a === b ? 0 : a < b ? -1 : 1;
}

export function checkedText(table: MergeTable, remote: Download | null): string | null {
  if (!remote) return writeCsv(table, []);
  const check = readCsv(table, remote.bytes);
  if (check.stopped || check.findings.length || check.schema !== 'known') return null;
  // Preserve every byte in a valid hand-written CSV, even its BOM, until normalization.
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(remote.bytes);
}

export function differences(table: MergeTable, mine: TableRows[MergeTable][], theirs: TableRows[MergeTable][]): number | null {
  if (table === 'watched') {
    const result = mergeWatched(null, mine as WatchedRow[], theirs as WatchedRow[], { hold: true });
    return result.status === 'merged' ? result.impact.localToRemoteDifferences : null;
  }
  type Value = TableRows[Exclude<MergeTable, 'watched'>];
  return mergeRows(table, null, mine as Value[], theirs as Value[]).impact.localToRemoteDifferences;
}

export function unsyncedCount(snapshot: Pick<DeviceSnapshot,'tables'|'sync'>, table: MergeTable): number | null {
  const { pending, base } = fileState(snapshot, table);
  if (!base && !pending) return differences(table, snapshot.tables[table], []);
  const content = pending ? pending.targetContent : base?.content;
  if (typeof content !== 'string') return null;
  const checked = readCsv(table, content);
  if (checked.stopped || checked.findings.length || checked.schema !== 'known') return null;
  return differences(table, snapshot.tables[table], checked.rows);
}

/** The guard can adopt valid Dropbox bytes with different headings, quoting or line endings. */
export function tableMatchesDropboxBase(snapshot: Pick<DeviceSnapshot,'tables'|'sync'>, table: MergeTable): boolean {
  const state = fileState(snapshot, table);
  if (state.pending) return false;
  if (!state.base) return !snapshot.tables[table].length;
  const local = writeCsv(table, snapshot.tables[table]), base = state.base.content;
  if (typeof base !== 'string' || typeof state.base.revision !== 'string' || !state.base.revision) return false;
  if (local === base) return true;
  const checked = readCsv(table, base);
  return !checked.stopped && !checked.findings.length && checked.schema === 'known' && writeCsv(table, checked.rows) === local;
}

export class SyncStop extends Error {}
export class RestartListing extends Error {}
export type RestoreStatus = 'restored' | 'local-only' | 'unknown' | 'accepted-unacknowledged' | 'conflict-unacknowledged';
type UploadResult = { status: RestoreStatus; file?: DropboxFile };
export type PendingGuard = 'missing-target' | 'unknown-outcome';
export interface MatchingDelivery {
  pending: PendingUpload;
  revision: string;
  changes?: ReadonlyMap<string,bigint>;
}
export interface Settled { file?: DropboxFile | null; unresolved?: PendingGuard; downloaded?: Download | null; delivery?: MatchingDelivery }

export class SyncFiles {
  readonly store: Pick<DeviceStore, 'snapshot' | 'commit'> & Partial<Pick<DeviceStore, 'dropboxSyncCheck'|'dropboxState'|'installWatchDownload'|'installWatchRestore'>>;
  readonly api: SyncApi;
  readonly binding: { accountId: string; instanceId: string };
  readonly now: () => number;
  refusals = 0;

  constructor(store: SyncFiles['store'], api: SyncApi,
      binding: { accountId: string; instanceId: string }, now: () => number) {
    this.store = store; this.api = api; this.binding = Object.freeze({ accountId: binding.accountId, instanceId: binding.instanceId }); this.now = now;
  }

  #checkBinding(local: DeviceSnapshot['local']) {
    const session = local.dropboxSession;
    if (local.syncAccountId !== this.binding.accountId || session?.instanceId !== this.binding.instanceId ||
      session.accountId !== this.binding.accountId || !Number.isFinite(session.signInDeadline) || !(this.now() < session.signInDeadline)) {
      throw new SyncStop('Dropbox sign-in changed or ended.');
    }
  }

  async snapshot(previous?: DeviceSnapshot, forPublication = false): Promise<DeviceSnapshot> {
    if (previous && this.store.dropboxState) {
      // Record edits, file receipts and account changes advance the revision. Time can expire a grant independently.
      const {revision,accountId,session} = await this.store.dropboxState();
      this.#checkBinding({syncAccountId:accountId,dropboxSession:session ?? undefined});
      if (revision === previous.revision && session?.signInDeadline === previous.local.dropboxSession?.signInDeadline) {
        this.#checkBinding(previous.local);
        return previous;
      }
    }
    const snapshot = await this.store.snapshot(forPublication);
    this.#checkBinding(snapshot.local);
    return snapshot;
  }

  async check(table?: MergeTable) {
    if (this.store.dropboxSyncCheck) {
      const state = await this.store.dropboxSyncCheck(table);
      this.#checkBinding(state.local);
      return state.pending;
    }
    // A legacy settings migration provides its own in-memory receipt until the purge commits.
    const snapshot = await this.snapshot();
    return table ? fileState(snapshot, table).pending : null;
  }

  // The record revision includes successful code exchanges, including callbacks in another tab.
  async commit(snapshot: DeviceSnapshot, patch: DeviceChanges, current?: () => boolean, sparseTable?: RecordFile) {
    return this.#save(snapshot,recordPatch(snapshot,patch,sparseTable).changes,current);
  }

  #save(snapshot:DeviceSnapshot,patch:DeviceChanges,current?:()=>boolean) {
    const original = snapshot.local.dropboxSession!;
    return this.store.commit(snapshot.revision,patch,{syncWrite:true,
      current: () => this.now() < original.signInDeadline && (current?.() ?? true) });
  }

  async amend(plan: (snapshot: DeviceSnapshot) => DeviceChanges | null, previous?: DeviceSnapshot): Promise<void> {
    for (;;) {
      const snapshot = await this.snapshot(previous);
      const changes = plan(snapshot);
      if (!changes) return;
      try { await this.commit(snapshot, changes); return; }
      catch (error) { if (!(error instanceof StaleSnapshotError)) throw error; previous = undefined; }
    }
  }

  async prepare(table: MergeTable, snapshot: DeviceSnapshot, source: string | {rows:TableRows[MergeTable][]; localCsv?:string;
      reviewedWatchTarget?:boolean; ordinaryWatchDownload?:boolean}, target: DropboxFile | null,
      targetContent: string | null, afterSave?: () => void, discardBase = false, current?: () => boolean): Promise<PendingUpload | null> {
    const {content,rows:merged} = typeof source === 'string' ? {content:source,rows:undefined} : writeCsvWithRows(table,source.rows);
    checkDropboxFile(filePath(table),content);
    const state = fileState(snapshot, table);
    const local = snapshot.tables[table], localCsv = typeof source === 'string' ? undefined : source.localCsv;
    const sameTable = (!merged || merged.length === local.length) && (localCsv ?? writeCsv(table,local)) === content;
    const rows = sameTable ? undefined : merged ?? readCsv(table, content).rows;
    const replacement = rows ? { replace: { [table]: rows } } : {};
    const patch: DeviceChanges = { ...replacement, removeLocal: [canceledKey(table)] };
    const sparseTable = table !== 'settings' && rows && (typeof source === 'string' || state.base && !discardBase) ? table : undefined;
    if (targetContent === content) {
      const base = target ? { content, revision: target.rev } : null;
      if (rows || state.pending || snapshot.local[canceledKey(table)] || state.base?.revision !== base?.revision ||
        state.base?.content !== base?.content) {
        const receipt = {...state,base,pending:null}, update = {...patch,sync:{[table]:receipt}};
        const {recentChanges,changes:ready} = recordPatch(snapshot,update,sparseTable);
        const transfer = table === 'watched' && rows && !recentChanges && largeWatchTransfer(rows as WatchedRow[],ready);
        if (transfer && base && typeof source !== 'string' && !source.reviewedWatchTarget && !current &&
            !discardBase && !state.pending && this.store.installWatchDownload) {
          // Only a new device or an unchanged, fully synced watch table may install the peer's CSV directly.
          const first = !local.length && !state.base;
          const prior = source.ordinaryWatchDownload && local.length && state.base && !snapshot.local[canceledKey(table)] &&
            state.base.content === (localCsv ?? writeCsv('watched',snapshot.tables.watched))
            ? {count:local.length,base:state.base,lastClientModified:state.lastClientModified} : undefined;
          if (first || prior) {
            const {accountId,instanceId,signInDeadline} = snapshot.local.dropboxSession!;
            await this.store.installWatchDownload(snapshot.revision,transfer,receipt,
              {accountId,instanceId,signInDeadline},() => this.now() < signInDeadline,prior);
          } else await this.#save(snapshot,ready);
        } else await this.#save(snapshot,ready,current);
      }
      afterSave?.();
      return null;
    }
    const previous = target ? undefined : (await this.api.revisions(filePath(table))).map(revision => revision.rev);
    const preparedAt = this.now();
    let second = Math.floor(preparedAt / 1000) * 1000;
    for (const stamp of [state.lastClientModified, state.pending?.clientModified]) {
      if (!isDropboxTimestamp(stamp)) continue;
      const previousTime = Date.parse(stamp);
      second = Math.max(second, Math.floor(previousTime / 1000) * 1000 + 1000);
    }
    const clientModified = new Date(second).toISOString().replace('.000Z', 'Z');
    const pending: PendingUpload = { content, targetRevision: target?.rev ?? null, targetModified: target?.serverModified ?? null,
      targetContent, preparedAt, clientModified, ...(previous ? { previousRevisions: previous } : {}) };
    if (typeof source === 'string') {
      if (table === 'watched') pending.absoluteWatches = true; else pending.absoluteValues = true;
    }
    if (table === 'settings' && this.api.settingsHash) {
      try { pending.settingsContentHash = await this.api.settingsHash(content, target?.rev ?? null); }
      catch (error) {
        if (!isConflict(error)) throw error;
        this.refusals++; this.checkBudget(); throw new RestartListing();
      }
    }
    let base = discardBase ? null : state.base;
    // A reviewed first copy can lead to a second correction. That correction is
    // relative to the Dropbox revision the review just compared, even if its own reply is lost.
    if (!base && !discardBase && table === 'watched' && typeof source !== 'string' && source.reviewedWatchTarget &&
        target && targetContent !== null) base = {revision:target.rev,content:targetContent};
    const receipt = {...state,base,lastClientModified:clientModified,pending};
    const update = {...patch,sync:{[table]:receipt}};
    const {changes:ready,recentChanges} = recordPatch(snapshot,update,sparseTable);
    const transfer = table === 'watched' && rows && !recentChanges && largeWatchTransfer(rows as WatchedRow[],ready);
    if (transfer && typeof source === 'string' && !discardBase && current &&
        this.store.installWatchRestore && !snapshot.local[canceledKey(table)] && state.base &&
        state.base.revision === target?.rev && state.base.content === targetContent && tableMatchesDropboxBase(snapshot,'watched')) {
      const {accountId,instanceId,signInDeadline} = snapshot.local.dropboxSession!;
      await this.store.installWatchRestore(snapshot.revision,transfer,receipt,{accountId,instanceId,signInDeadline},
        () => this.now() < signInDeadline && current(),{count:local.length,base:state.base,lastClientModified:state.lastClientModified});
    } else await this.#save(snapshot,ready,current);
    afterSave?.();
    return pending;
  }

  #upload(table: MergeTable, pending: PendingUpload): Promise<DropboxFile> {
    if (pending.inspectOnly) throw new SyncStop('A settings upload from before the clear cannot be sent again.');
    return this.api.upload(filePath(table), pending.content, { mode: pending.targetRevision ? 'update' : 'add',
      revision: pending.targetRevision ?? undefined, clientModified: pending.clientModified });
  }

  async #ack(table: MergeTable, pending: PendingUpload, arrived: string | null, requireMatchingRows = false) {
    let acknowledged = false;
    await this.amend(snapshot => {
      const state = fileState(snapshot, table);
      if (!sameReceipt(state.pending,pending)) throw new SyncStop('The pending Dropbox upload changed.');
      acknowledged = !requireMatchingRows || writeCsv(table,snapshot.tables[table]) === pending.content;
      if (!acknowledged) return null;
      const base = arrived ? { content: pending.content, revision: arrived }
        : pending.targetRevision && pending.targetContent !== null ? { content: pending.targetContent, revision: pending.targetRevision } : null;
      return { sync: { [table]: { ...state, base, pending: null } } };
    });
    return acknowledged;
  }

  async send(table: MergeTable, pending: PendingUpload): Promise<UploadResult> {
    let file;
    try { file = await this.#upload(table, pending); }
    catch (error) {
      if (!isConflict(error)) return { status: 'unknown' };
      this.refusals++;
      try { await this.#ack(table, pending, null); }
      catch { return { status: 'conflict-unacknowledged' }; }
      return { status: 'local-only' };
    }
    try { await this.#ack(table, pending, file.rev); }
    catch { return { status: 'accepted-unacknowledged' }; }
    return { status: 'restored', file };
  }

  checkBudget() {
    if (this.refusals >= 5) throw new SyncStop('Dropbox refused five conditional uploads.');
  }

  /** A strict update can only produce the first revision following its target. */
  async #updateSuccessor(path: string, target: string, current: DropboxFile, matchesCurrent: boolean) {
    if (current.rev === target) return null;
    // The path history includes replacements. An update of a revision can only modify that file ID.
    const successorOf = (file:DropboxFile,previous:DropboxFile) =>
      ({file,sameFile:!file.id || !previous.id || file.id===previous.id});
    if (matchesCurrent) {
      const [previous] = await this.api.revisions(path,current.rev,1);
      if (previous?.rev === target) return successorOf(current,previous);
    }
    const retained = await this.api.revisions(path,current.rev,Infinity,file=>file.rev===target);
    const index = retained.findIndex(file => file.rev === target);
    if (index < 0) return null;
    const adjacent = index ? retained[index-1] : current;
    if (adjacent !== current || !matchesCurrent) {
      const [previous] = await this.api.revisions(path,adjacent.rev,1);
      if (previous?.rev === target) return successorOf(adjacent,previous);
    }
    // Each bounded prefix ends at the provider's next before_rev cursor. Locate the
    // largest prefix excluding the target; its last entry immediately follows the target.
    // Never query before the target, which may be the very first revision at this path.
    let newer = 0, includingTarget = retained.length, successor = current;
    let limit = Math.max(1,index); // A hint only. Verify both sides of the boundary.
    while (includingTarget - newer > 1) {
      const prefix = await this.api.revisions(path,current.rev,limit);
      if (prefix.length !== limit) return null;
      if (prefix.some(file => file.rev === target)) includingTarget = limit;
      else {
        newer = limit;
        successor = prefix[limit-1];
        // The excluded target is older than this cursor, so the cursor cannot be
        // the first revision. This common case ends in just one small additional read.
        if (includingTarget - newer > 1) {
          const [preceding] = await this.api.revisions(path,successor.rev,1);
          if (preceding?.rev === target) return successorOf(successor,preceding);
          if (!preceding) return null;
        }
      }
      limit = newer + Math.floor((includingTarget-newer)/2);
    }
    return successorOf(successor,retained[index]);
  }

  async settle(table: MergeTable, inspectOnly = false): Promise<Settled> {
    const pending = await this.check(table);
    if (!pending) return {};
    const path = filePath(table);
    const validCsv = (content: unknown) => {
      if (typeof content !== 'string') return false;
      const checked = readCsv(table, content);
      return !checked.stopped && !checked.findings.length && checked.schema === 'known';
    };
    if (!validCsv(pending.content) || (pending.targetContent !== null && !validCsv(pending.targetContent)) ||
      (pending.absoluteWatches !== undefined && (table !== 'watched' || pending.absoluteWatches !== true)) ||
      (pending.absoluteValues !== undefined && (table === 'watched' || pending.absoluteValues !== true)) ||
      (pending.inspectOnly !== undefined && (pending.inspectOnly !== true || table !== 'settings' || !this.api.settingsHashTag || !pending.settingsContentHash)) ||
      (table === 'settings' && this.api.settingsHash && !/^h1:[a-f0-9]{64}$/.test(pending.settingsContentHash ?? '')) ||
      !isDropboxTimestamp(pending.clientModified) || !Number.isFinite(pending.preparedAt) ||
      (pending.targetRevision === null ? pending.targetModified !== null || !Array.isArray(pending.previousRevisions) ||
        Array.from(pending.previousRevisions).some(revision => typeof revision !== 'string' || !revision) :
        typeof pending.targetRevision !== 'string' || !pending.targetRevision || !isDropboxTimestamp(pending.targetModified))) {
      // A damaged or incomplete receipt cannot safely authorize a replay.
      const downloaded = await this.api.download(path);
      return {file: downloaded?.metadata ?? null, downloaded, unresolved:'unknown-outcome'};
    }
    const earlier = new Set(pending.targetRevision === null ? pending.previousRevisions : []);
    let downloaded: Download | null | undefined;
    let history: DropboxFile[] | undefined;
    const outsideHistoryWindow = () => {
      const age = this.now() - pending.preparedAt;
      return age < 0 || age >= 25 * 86_400_000;
    };
    // Empty history cannot distinguish an unreceived creation from one since deleted and aged out.
    const mayReplay = !inspectOnly && !pending.inspectOnly && !(pending.targetRevision === null && outsideHistoryWindow());
    if (!mayReplay) {
      downloaded = await this.api.download(path);
      if (!downloaded && pending.targetRevision) return {file:null, unresolved:'missing-target', downloaded};
    }
    while (mayReplay) {
      if (pending.targetRevision === null) {
        history = await this.api.revisions(path);
        if (outsideHistoryWindow() || history.some(entry => !earlier.has(entry.rev))) break;
      }
      let accepted: DropboxFile;
      try { accepted = await this.#upload(table, pending); }
      catch (error) {
        if (!isConflict(error)) throw error;
        this.refusals++; this.checkBudget();
        downloaded = await this.api.download(path);
        if (pending.targetRevision && downloaded?.metadata.rev === pending.targetRevision) {
          // A rejected conditional write and a still-current target disagree. A stale
          // read cannot establish whether the original request arrived.
          downloaded = await this.api.download(path);
          if (downloaded?.metadata.rev === pending.targetRevision) {
            throw new SyncStop('Dropbox refused the upload but still shows its old revision. The change is pending. Sync again.');
          }
        }
        if (downloaded) { history = undefined; break; }
        if (pending.targetRevision) return { file: null, unresolved: 'missing-target', downloaded };
        continue;
      }
      await this.#ack(table, pending, accepted.rev);
      return { file: accepted };
    }
    const hash = table === 'settings' && this.api.settingsHash && pending.settingsContentHash
      ? pending.settingsContentHash : await dropboxContentHash(pending.content);
    const matchesReceipt = async (file: DropboxFile) => {
      const matchesTime = compareTimestamps(file.clientModified, pending!.clientModified) === 0 &&
        (pending!.targetRevision ? file.rev !== pending!.targetRevision && compareTimestamps(file.serverModified, pending!.targetModified!) >= 0
          : !earlier.has(file.rev));
      if (!matchesTime) return false;
      return hash === (table === 'settings' && this.api.settingsHashTag ? await this.api.settingsHashTag(file.contentHash) : file.contentHash);
    };
    const current = downloaded?.metadata;
    let matchingRevision:DropboxFile | undefined;
    let targetListed = false;
    if (pending.targetRevision && current) {
      // An aged-out revision could have come between the target and today's apparent successor.
      if (outsideHistoryWindow()) return {file:current,downloaded,unresolved:'unknown-outcome'};
      const matchesCurrent=await matchesReceipt(current);
      let candidate: {file:DropboxFile;sameFile:boolean} | null;
      try { candidate = await this.#updateSuccessor(path,pending.targetRevision,current,matchesCurrent); }
      catch (error) {
        // A cursor refusal cannot establish what revision came before it.
        if (!(error instanceof DropboxError) || (error.status !== 409 && error.kind !== 'not-found')) throw error;
        return {file:current,downloaded,unresolved:'unknown-outcome'};
      }
      if (outsideHistoryWindow()) return {file:current,downloaded,unresolved:'unknown-outcome'};
      targetListed = !!candidate || current.rev === pending.targetRevision;
      if (candidate?.sameFile && (candidate.file.rev===current.rev ? matchesCurrent : await matchesReceipt(candidate.file))) {
        matchingRevision=candidate.file;
      }
    } else if (!pending.targetRevision) {
      history ??= await this.api.revisions(path);
      const oldest = history.at(-1), times = new Map<string,string>(), ties = new Set<string>(), existingIds = new Set<string>();
      const observed = current && !history.some(file=>file.rev===current.rev) ? [...history,current] : history;
      for (const file of observed) {
        if (!file.id) continue;
        if (earlier.has(file.rev)) existingIds.add(file.id);
        const earliest = times.get(file.id);
        const order = earliest === undefined ? -1 : compareTimestamps(file.serverModified,earliest);
        if (order < 0) { times.set(file.id,file.serverModified); ties.delete(file.id); }
        else if (order === 0) ties.add(file.id);
      }
      const candidates = [...(oldest ? [oldest] : []),...(current && current.rev !== oldest?.rev ? [current] : []),
        ...history.filter(file=>file.rev!==oldest?.rev && file.rev!==current?.rev)];
      for (const file of candidates) {
        // A strict add creates a new file ID. A revision of an existing ID cannot be that add.
        const earliest = file.id && times.get(file.id);
        if (file.id && (existingIds.has(file.id) || earliest && compareTimestamps(earliest,file.serverModified)<0)) continue;
        if (!await matchesReceipt(file)) continue;
        if (file.id && file.rev!==oldest?.rev && ties.has(file.id)) {
          try {
            const sameId = (other:DropboxFile) => other.id===file.id;
            if ((await this.api.revisions(path,file.rev,Infinity,sameId)).some(sameId)) continue;
          } catch (error) {
            if (!(error instanceof DropboxError) || error.status!==409 && error.kind!=='not-found') throw error;
            // A refused cursor offers no proof about which writer created the file.
          }
        }
        matchingRevision=file; break;
      }
    }
    if (matchingRevision) {
      // Matching bytes and a second-precision client timestamp identify a candidate, not the writer.
      // A direct upload acknowledgement above does identify the writer.
      if (table === 'watched' && pending.targetRevision && pending.targetContent !== null && !pending.absoluteWatches &&
          fileState(await this.snapshot(),table).base) {
        const changes = watchDeliveryChanges(readCsv('watched',pending.targetContent).rows,readCsv('watched',pending.content).rows);
        if (!changes) {
          downloaded ??= await this.api.download(path);
          return {file:downloaded?.metadata ?? null,downloaded,unresolved:'unknown-outcome'};
        }
        if (changes.size) return {file:current ?? null,delivery:{pending,revision:matchingRevision.rev,changes}};
      } else if (!pending.absoluteWatches && !pending.absoluteValues) {
        if (downloaded === undefined) downloaded = await this.api.download(path);
        if (!downloaded || pending.targetRevision && pending.targetContent === null) {
          return {file:downloaded?.metadata ?? null,downloaded,unresolved:'unknown-outcome'};
        }
        // Both copies now have the same rows. Establish that observed revision as their base
        // only while the local rows still agree inside the acknowledging transaction.
        if (downloaded.metadata.rev === matchingRevision.rev && await this.#ack(table,pending,matchingRevision.rev,true)) {
          return {file:downloaded.metadata};
        }
        return {file:downloaded.metadata,delivery:{pending,revision:matchingRevision.rev}};
      }
      await this.#ack(table, pending, matchingRevision.rev);
    } else {
      if ((pending.targetRevision && !targetListed) || outsideHistoryWindow()) {
        if (downloaded === undefined) downloaded = await this.api.download(path);
        return { file: downloaded?.metadata ?? null, unresolved: 'unknown-outcome', downloaded };
      }
      await this.#ack(table, pending, null);
    }
    // A create whose history advanced without an upload has no known current path revision.
    return { file: current ?? null };
  }
}

function isConflict(error: unknown) {
  return typeof error === 'object' && error !== null && 'kind' in error && error.kind === 'conflict';
}
