import { readMergeInput } from './core.ts';
import { readCsv, writeCsv, type CsvFinding } from './csv.ts';
import { decodeInput } from './csv-format.ts';
import { guardMerge, type GuardDecision, type MergeImpact } from './guard.ts';
import { mergeRows, type MergedRows } from './merge.ts';
import { answerDoubleMarks, mergeWatched, type DoubleMarkReview, type IdentityReview,
  type IdentityAssignment, type WatchOptions } from './watch-merge.ts';
import { hasRepeatedEpisode } from './watch-identity.ts';
import type { MergeTable, TableRows, WatchedRow } from './model.ts';
import { StaleSnapshotError, type DeviceSnapshot, type DeviceStore, type PendingUpload } from './storage.ts';
import { dropboxContentHash, type DropboxEntry, type DropboxFile } from './dropbox-api.ts';
import { checkDropboxBytes, dropboxLimits } from './dropbox-limits.ts';
import { DropboxSettingsFiles, settingsWithoutKeys } from './dropbox-provider-settings.ts';
import { backupFileIssue } from './dropbox-backup.ts';
import { compareValueDelivery, type ValueDeliveryReview } from './dropbox-delivery.ts';
import { canceledKey, checkedText, differences, filePath, fileState, mergedTables, RestartListing, sameReceipt, SyncFiles, SyncStop,
  unsyncedCount, type Download, type PendingGuard, type RestoreStatus, type Settled, type MatchingDelivery } from './dropbox-sync-file.ts';
export { unsyncedCount, SyncStop, mergedTables } from './dropbox-sync-file.ts';
export type { RestoreStatus, Download, SyncApi } from './dropbox-sync-file.ts';

export interface SyncGuardQuestion {
  table: MergeTable;
  decision: GuardDecision;
  findings: CsvFinding[];
  impact?: MergeImpact;
  different: number | null;
  unsynced: number | null;
  ambiguousRemoteEpisodes?: boolean;
}
export interface SyncHooks {
  guard?(question: SyncGuardQuestion): Promise<GuardDecision['choices'][number]>;
  doubleMarks?(review: DoubleMarkReview): Promise<{ choice: 'one' | 'two'; overrides?: ReadonlyMap<string, 'one' | 'two'> } | null>;
  valueDelivery?(review:ValueDeliveryReview):Promise<'shared'|'independent'|null>;
  identities?(review: IdentityReview): Promise<readonly IdentityAssignment[] | null>;
  hold?(table: MergeTable | null): void;
  answered?(): void;
  postponed?(table: MergeTable, remoteRevision: string|null): void;
  protect?(table: MergeTable, keys: string[]): void;
  restoreDevice?(table: MergeTable, content: string, engine: DropboxSync, displayedRevision: string | null): Promise<void>;
  reload?(): void;
  notice?(message: string): void;
  noticeGroup?(label: string, messages: string[]): void;
}
export interface SyncResult { complete: boolean; reason: string; listing: DropboxEntry[]; notices: string[]; exportRecord?:object }
type Remote = { metadata: DropboxFile | null; content: Uint8Array | string | null };
type ChoiceResult = 'done' | 'again' | 'merge-anyway' | 'combine' | 'canceled';
const remoteFrom = (file: Download | null): Remote => ({ metadata: file?.metadata ?? null, content: file?.bytes ?? null });
const emptyCsv = (table: MergeTable) => writeCsv(table, []);
const canonicalName = (table: MergeTable) => table + '.csv';

export class DropboxSync {
  private readonly files: SyncFiles;
  private readonly loadProviderKeys?: () => Promise<void>;
  readonly hooks: SyncHooks;
  #held: MergeTable | null = null;
  #notices = new Set<string>();
  #skipped = new Set<MergeTable>();
  #answers?: WatchOptions['answers'];
  #deliveries = new Map<MergeTable,MatchingDelivery>();
  #restoreInstead?: {table:MergeTable; pending:PendingUpload; content:string; revision:string|null};
  #listed = new Map<string, Extract<DropboxEntry, {kind:'file'}>>();
  #settlement = new Map<MergeTable, 'combine' | 'again'>();

  constructor(store: ConstructorParameters<typeof SyncFiles>[0] & Partial<Pick<DeviceStore,'providerContentTag'>>, api: ConstructorParameters<typeof SyncFiles>[1],
      binding: ConstructorParameters<typeof SyncFiles>[2], hooks: SyncHooks = {}, now: () => number = Date.now,
      loadProviderKeys?: () => Promise<void>) {
    this.files = new SyncFiles(store, loadProviderKeys ? new DropboxSettingsFiles(api, hash => {
      if (!store.providerContentTag) throw Error('Could not protect the settings upload receipt.');
      return store.providerContentTag(hash);
    }) : api, binding, now);
    this.loadProviderKeys = loadProviderKeys;
    this.hooks = hooks;
  }

  #notice(message: string) {
    if (!this.#notices.has(message)) this.hooks.notice?.(message);
    this.#notices.add(message);
  }
  #noticeGroup(label:string, messages:string[]) {
    const fresh = messages.filter(message => {
      if (this.#notices.has(message)) return false;
      this.#notices.add(message);
      return true;
    });
    if (fresh.length > 1 && this.hooks.noticeGroup) this.hooks.noticeGroup(label,fresh);
    else for (const message of fresh) this.hooks.notice?.(message);
  }
  #hold(table: MergeTable | null) { this.#held = table; this.hooks.hold?.(table); }
  #saved(table: MergeTable) { if (this.#held === table) this.#hold(null); }
  #listedAs(table: MergeTable, entry: DropboxFile | null | undefined) {
    if (entry === undefined) return;
    if (entry) this.#listed.set(canonicalName(table), entry);
    else this.#listed.delete(canonicalName(table));
  }

  async #skip(table: MergeTable, displayed:DeviceSnapshot) {
    this.#skipped.add(table);
    let current = false;
    await this.files.amend(s => {
      const before = fileState(displayed,table), after = fileState(s,table);
      current = s.revision === displayed.revision || (
        before.base?.revision === after.base?.revision && before.pending?.clientModified === after.pending?.clientModified &&
        writeCsv(table,displayed.tables[table]) === writeCsv(table,s.tables[table]));
      return current && !s.local[canceledKey(table)] ? {local:{[canceledKey(table)]:true}} : null;
    });
    if (current) this.hooks.postponed?.(table,this.#listed.get(canonicalName(table))?.rev ?? null);
  }

  async #ask(table: MergeTable, remote: Remote, decision: GuardDecision, findings: CsvFinding[], snapshot: DeviceSnapshot,
      impact?: MergeImpact): Promise<ChoiceResult> {
    const watched = table === 'watched' && remote.content !== null ? readCsv('watched', remote.content) : null;
    const check = watched ?? (remote.content === null ? null : readCsv(table, remote.content));
    const rows = check?.rows ?? [];
    const ambiguousRemoteEpisodes = decision.choices.includes('take-remote') && !!watched && hasRepeatedEpisode(watched.rows);
    if (ambiguousRemoteEpisodes) decision = { ...decision, choices: decision.choices.filter(choice => choice !== 'take-remote') };
    this.#hold(null);
    const answer = await this.hooks.guard?.({ table, decision, findings, impact, ambiguousRemoteEpisodes, unsynced: unsyncedCount(snapshot, table),
      different: check?.stopped || check?.findings.length ? null : differences(table, snapshot.tables[table], rows) }) ?? 'cancel';
    this.hooks.answered?.();
    if (!decision.choices.includes(answer)) throw new SyncStop('Invalid Dropbox guard choice.');
    if (answer === 'reload' || answer === 'cancel') {
      if (answer === 'reload') this.hooks.reload?.();
      await this.#skip(table,snapshot);
      return 'canceled';
    }
    this.#hold(table);
    if (answer === 'take-remote') {
      const download = await this.files.api.download(filePath(table));
      this.#listedAs(table, download?.metadata ?? null);
      if ((remote.metadata?.rev ?? null) !== (download?.metadata.rev ?? null)) return 'again';
      const content = checkedText(table, download);
      if (content === null) throw new SyncStop('The Dropbox file could not be read after confirmation.');
      let changed = false;
      const displayState = fileState(snapshot, table);
      await this.files.amend(current => {
        const state = fileState(current, table);
        if (writeCsv(table, current.tables[table]) !== writeCsv(table, snapshot.tables[table]) ||
          state.base?.revision !== displayState.base?.revision || state.pending?.clientModified !== displayState.pending?.clientModified) {
          changed = true;
          return null;
        }
        return { replace: { [table]: readCsv(table, content).rows }, removeLocal: [canceledKey(table)],
          sync: { [table]: { ...state, pending: null, base: download ? { content, revision: download.metadata.rev } : null } } };
      });
      if (changed) return 'again';
      this.#saved(table);
      return table === 'lists' && check?.normalizedListNames ? 'again' : 'done';
    }
    if (answer === 'restore-device') {
      if (!this.hooks.restoreDevice) throw new SyncStop('Dropbox restore is unavailable.');
      const current = await this.files.snapshot();
      const content = writeCsv(table, snapshot.tables[table]);
      if (writeCsv(table, current.tables[table]) !== content) return 'again';
      const revision = remote.metadata?.rev ?? null;
      const delivery = this.#deliveries.get(table);
      if (delivery && (delivery.pending.targetRevision || remote.metadata)) {
        if (!sameReceipt(fileState(current,table).pending,delivery.pending)) return 'again';
        this.#restoreInstead = {table,pending:delivery.pending,content,revision};
      }
      try { await this.hooks.restoreDevice(table, content, this, revision); }
      finally { this.#restoreInstead = undefined; }
      this.#saved(table);
      return 'done';
    }
    return answer;
  }

  async #unresolved(table: MergeTable, settled: Settled, reason: PendingGuard): Promise<ChoiceResult> {
    const remote = remoteFrom(settled.downloaded ?? null);
    const snapshot = await this.files.snapshot();
    const check = readMergeInput(table, remote.content, { hasBase: Boolean(fileState(snapshot, table).base),
      localRows: snapshot.tables[table].length, unresolvedPending: reason });
    if (check.status !== 'guard') throw new Error('An unresolved upload requires a guard.');
    return this.#ask(table, remote, check.decision, check.findings, snapshot);
  }

  async #settle(table: MergeTable) {
    const settled = await this.files.settle(table);
    if (settled.delivery) this.#deliveries.set(table,settled.delivery);
    else this.#deliveries.delete(table);
    this.#listedAs(table, settled.file);
    if (!settled.unresolved) return;
    const choice = await this.#unresolved(table, settled, settled.unresolved);
    if (choice === 'combine' || choice === 'again') this.#settlement.set(table, choice);
  }

  async #remote(table: MergeTable, base: ReturnType<typeof fileState>['base']): Promise<Remote> {
    const listed = this.#listed.get(canonicalName(table));
    if (base && typeof base.content === 'string' && listed?.rev === base.revision && !decodeInput(base.content).error &&
        listed.contentHash !== null && listed.contentHash === await dropboxContentHash(base.content)) {
      return { metadata: listed, content: base.content };
    }
    const downloaded = await this.files.api.download(filePath(table));
    if (!downloaded && listed) throw new SyncStop('Dropbox listed ' + canonicalName(table) + ' but its download did not find it.');
    this.#listedAs(table, downloaded?.metadata ?? null);
    return remoteFrom(downloaded);
  }

  /** A settled snapshot with four unchanged Dropbox revisions needs only one final device revision check. */
  async #unchanged(snapshot:DeviceSnapshot): Promise<boolean> {
    const candidates = [];
    for (const table of mergedTables) {
      const state = fileState(snapshot,table), listed = this.#listed.get(canonicalName(table));
      if (state.pending || snapshot.local[canceledKey(table)] || !state.base || !listed?.contentHash ||
          listed.rev !== state.base.revision || typeof state.base.content !== 'string') return false;
      candidates.push({table,base:state.base});
    }
    for (const {table,base} of candidates) {
      const remote = await this.#remote(table,base);
      if (remote.metadata?.rev !== base.revision || remote.content === null) return false;
      // A credential-bearing settings file still needs its protected download. Other
      // tables take exactly the same revision and hash checks as an ordinary merge.
      const checked = typeof remote.content === 'string' ? {text:remote.content} : decodeInput(remote.content);
      if (checked.error || checked.text !== base.content || writeCsv(table,snapshot.tables[table]) !== checked.text) return false;
    }
    return await this.files.snapshot(snapshot) === snapshot;
  }

  #reportMerge(table: MergeTable, merged: MergedRows<TableRows[MergeTable]>) {
    if (merged.noBase && (merged.impact.localRows || merged.impact.remoteRows)) this.#notice('Combined ' + canonicalName(table) + ' without a last-synced copy.');
    this.#noticeGroup(table === 'settings' ? 'Settings kept on this device' : 'Ratings kept on this device',
      merged.clashes.map(clash => 'setting' in clash ? 'Kept this device’s setting for ' + clash.setting + '.'
        : 'Kept rating ' + clash.mine + ' for show ' + clash.show_id + '. Dropbox had ' + clash.theirs + '.'));
    if ('remoteChangedEpisodes' in merged) {
      const watched = merged as ReturnType<typeof mergeWatched> & { status: 'merged' };
      this.hooks.protect?.(table, watched.remoteChangedEpisodes);
      this.#noticeGroup('Combined watch changes',watched.unansweredDoubleMarks.map(e => 'Combined both changes for show ' +
        e.show_id + ', season ' + e.season + ', episode ' + e.episode + '.'));
    } else this.hooks.protect?.(table, merged.remoteChangedKeys);
  }

  async #mergeFile(table: MergeTable, previous: DeviceSnapshot) {
    let resolution: WatchOptions['resolution'];
    let deliveryAnswers: WatchOptions['answers'];
    let valueAnswer:{token:string;choice:'shared'|'independent'}|undefined;
    let approved: string | undefined;
    for (;;) {
      if (this.#settlement.get(table) === 'again') {
        this.#settlement.delete(table);
        await this.#settle(table);
        if (this.#skipped.has(table)) return;
        if (this.#settlement.get(table) === 'again') continue;
      }
      const combine = this.#settlement.get(table) === 'combine';
      const s = await this.files.snapshot(previous);
      previous = s;
      const state = fileState(s, table);
      const delivery = !combine ? this.#deliveries.get(table) : undefined;
      if (delivery && !sameReceipt(state.pending,delivery.pending)) {
        throw new RestartListing();
      }
      const base = combine ? null : delivery ? {revision:delivery.revision,content:delivery.pending.content} : state.base;
      const remote = await this.#remote(table, base);
      if (delivery && !delivery.pending.targetRevision && !remote.metadata) {
        // A first upload could still arrive at a missing path. Reinspect the history
        // and the missing copy together before offering a restore.
        this.#settlement.set(table,'again');
        continue;
      }
      const mine = s.tables[table];
      let localCsv: string | undefined;
      const localContent = () => localCsv ??= writeCsv(table,mine);
      if (!delivery && base && typeof remote.content === 'string' && localContent() === remote.content) {
        this.#saved(table); return;
      }
      const revision = remote.metadata?.rev ?? null;
      const deliveryToken = delivery && JSON.stringify([s.revision.toString(),delivery.pending.targetRevision,
        delivery.pending.clientModified,delivery.revision,revision]);
      const input = readMergeInput(table, remote.content, { hasBase: Boolean(base), localRows: s.tables[table].length });
      if (input.status === 'guard') {
        const choice = await this.#ask(table, remote, input.decision, input.findings, s);
        if (choice === 'again') continue;
        return;
      }
      // Give the browser a turn between parsing, matching and saving a large first download.
      // Each checkpoint also detects edits or a changed grant before using the earlier snapshot.
      const largeFirstDownload = table === 'watched' && !base && !delivery && !combine &&
        !mine.length && input.rows.length >= 4096;
      if (largeFirstDownload) {
        previous = await this.files.snapshot(s);
        if (previous.revision !== s.revision) continue;
      }
      let before = null;
      if (base && base.revision === revision) before = input.rows;
      else if (base) {
        const saved = typeof base.content === 'string' ? readCsv(table, base.content) : null;
        if (!saved || typeof base.revision !== 'string' || !base.revision || saved.schema !== 'known' || saved.stopped || saved.findings.length) {
          const decision: GuardDecision = {case:3,reason:'damaged-base',choices:['combine','take-remote','cancel']};
          const choice = await this.#ask(table, remote, decision, [], s);
          if (choice === 'combine') this.#settlement.set(table, choice);
          if (choice === 'combine' || choice === 'again') continue;
          return;
        }
        before = saved.rows;
      }
      let merged: MergedRows<TableRows[MergeTable]>;
      if (table === 'watched') {
        const result = mergeWatched(before as WatchedRow[] | null, mine as WatchedRow[], input.rows as WatchedRow[],
          { resolution, answers: this.#answers, hold: this.#held !== null,
            delivery:delivery && {changes:delivery.changes, answers:deliveryAnswers,
              token:deliveryToken!},
            versions: { recordVersion: s.revision, baseRevision: base?.revision ?? null, remoteRevision: revision } });
        if (result.status === 'identity-review') {
          this.#hold(null);
          const assignments = await this.hooks.identities?.(result);
          this.hooks.answered?.();
          if (!assignments) { await this.#skip(table,s); return; }
          resolution = { token: result.token, assignments };
          const latest = await this.files.api.download(filePath(table));
          this.#listedAs(table, latest?.metadata ?? null);
          continue;
        }
        if (result.status === 'double-mark') {
          const answer = await this.hooks.doubleMarks?.(result);
          this.hooks.answered?.();
          if (!answer) { await this.#skip(table,s); return; }
          const choices = answerDoubleMarks(result, answer.choice, answer.overrides);
          if (result.delivery) {
            deliveryAnswers = choices;
            await this.files.check();
            const latest = await this.files.api.download(filePath(table));
            this.#listedAs(table,latest?.metadata ?? null);
          } else this.#answers = choices;
          continue;
        }
        if (result.status === 'overflow') throw new SyncStop('Watch count is too large for show ' + result.episode.show_id +
          ', season ' + result.episode.season + ', episode ' + result.episode.episode + '.');
        merged = result;
      } else {
        type Value = TableRows[Exclude<MergeTable, 'watched'>];
        merged = mergeRows(table, before as Value[] | null, mine as Value[], input.rows as Value[]);
        if (delivery) {
          const old = delivery.pending.targetRevision && delivery.pending.targetContent !== null
            ? readCsv(table,delivery.pending.targetContent).rows : null;
          const independent = mergeRows(table,old,mine as Value[],input.rows as Value[]);
          const review = compareValueDelivery(table,merged.rows as Value[],independent.rows,mine as Value[]);
          if (review.rows.length) {
            if (valueAnswer?.token !== deliveryToken) {
              this.#hold(null);
              const choice = await this.hooks.valueDelivery?.(review);
              this.hooks.answered?.();
              if (!choice) { await this.#skip(table,s); return; }
              valueAnswer = {token:deliveryToken!,choice};
              const latest = await this.files.api.download(filePath(table));
              this.#listedAs(table,latest?.metadata ?? null);
              continue;
            }
            if (valueAnswer?.choice === 'independent') merged = independent;
          }
        }
      }
      const guard = !combine && guardMerge(merged.impact);
      const impact = merged.impact;
      const proposal = guard && JSON.stringify([revision, guard.reason, impact.removedRows, impact.loweredCounts,
        impact.lostViewings.toString(), impact.changedRatings, impact.changedSettings, localContent()]);
      if (guard && approved !== proposal) {
        const choice = await this.#ask(table, remote, guard, [], s, merged.impact);
        if (choice === 'merge-anyway' && proposal) approved = proposal;
        if (choice === 'merge-anyway' || choice === 'again') continue;
        return;
      }
      if (largeFirstDownload) {
        previous = await this.files.snapshot(s);
        if (previous.revision !== s.revision) continue;
      }
      const target = remote.content === null ? emptyCsv(table) : typeof remote.content === 'string'
        ? remote.content : new TextDecoder('utf-8', { ignoreBOM: true }).decode(remote.content);
      let pending;
      try {
        const ordinaryWatchDownload = table === 'watched' && !guard && !approved && !resolution && !this.#answers &&
          !delivery && !combine && !this.#held && !this.#settlement.has(table);
        pending = await this.files.prepare(table, s, {rows:merged.rows,localCsv,reviewedWatchTarget:!!delivery,ordinaryWatchDownload}, remote.metadata, target, () => {
          this.#saved(table); this.#reportMerge(table, merged);
        }, combine);
      } catch (error) {
        if (error instanceof StaleSnapshotError) continue;
        throw error;
      }
      this.#settlement.delete(table);
      this.#deliveries.delete(table);
      if (!pending) return;
      const sent = await this.files.send(table, pending);
      if (sent.status === 'local-only') { this.files.checkBudget(); throw new RestartListing(); }
      if (sent.status === 'unknown') throw new SyncStop('The upload of ' + canonicalName(table) + ' has an unknown outcome. Sync again to settle it.');
      if (sent.status === 'accepted-unacknowledged') throw new SyncStop('Dropbox accepted ' + canonicalName(table) + '. Local reconciliation is pending.');
      if (sent.status === 'conflict-unacknowledged') throw new SyncStop('Dropbox refused ' + canonicalName(table) + '. Local reconciliation is pending.');
      this.#listedAs(table, sent.file);
      return;
    }
  }

  async run({ retryCanceled = false, postponed, beforeMerge, previouslySynced = false }: {
    retryCanceled?:boolean; postponed?:ReadonlyMap<MergeTable,string|null>; beforeMerge?:()=>Promise<boolean>; previouslySynced?:boolean
    } = {}): Promise<SyncResult> {
    this.files.refusals = 0;
    this.#answers = undefined; this.#deliveries.clear(); this.#notices.clear(); this.#skipped.clear(); this.#settlement.clear();
    try {
      let settingsIssue: string | undefined;
      try { await this.loadProviderKeys?.(); }
      catch (error) {
        await this.files.check();
        settingsIssue = error instanceof Error ? error.message : 'Could not read Dropbox settings.';
        this.#skipped.add('settings');
      }
      for (;;) {
        const initial = await this.files.snapshot(undefined,previouslySynced);
        const listing = await this.files.api.list('');
        const names = new Set([...mergedTables.map(canonicalName), 'shows.csv', 'summary.csv', 'readme.txt', 'backups', 'csvtv-reset.json']);
        const unknown = listing.filter(entry => !names.has(entry.name.toLowerCase()));
        if (unknown.length) {
          const saved = initial.local.dropboxUnknownFiles;
          const reported = new Set(Array.isArray(saved) ? saved as string[] : []);
          const fresh = [];
          for (const {name} of unknown) {
            if (reported.has(name)) continue;
            reported.add(name);
            fresh.push(name);
          }
          if (fresh.length) {
            await this.files.amend(() => ({local:{dropboxUnknownFiles:[...reported]}}));
            this.#noticeGroup('Unrecognized Dropbox items',fresh.map(name => 'Unrecognized Dropbox item: ' + name));
          }
        }
        this.#listed.clear();
        for (const entry of listing) if (entry.kind === 'file') this.#listed.set(entry.name.toLowerCase(), entry);
        const retry = new Set<MergeTable>();
        for (const table of mergedTables) {
          if (this.#skipped.has(table) || !initial.local[canceledKey(table)]) continue;
          const shouldRetry = postponed?.has(table)
            ? postponed.get(table) !== (this.#listed.get(canonicalName(table))?.rev ?? null)
            : retryCanceled;
          if (shouldRetry) retry.add(table); else this.#skipped.add(table);
        }
        if (retry.size) await this.files.amend(s => {
          const removeLocal = [...retry].filter(table => s.local[canceledKey(table)]).map(canceledKey);
          return removeLocal.length ? {removeLocal} : null;
        },initial);
        try {
          for (const table of [...mergedTables, 'shows'] as const) {
            if (table !== 'shows' && this.#skipped.has(table)) continue;
            const entry = this.#listed.get(table + '.csv');
            if (entry) checkDropboxBytes(entry.size, dropboxLimits.file);
          }
          let unchanged = previouslySynced && !this.#held && !this.#skipped.size && await this.#unchanged(initial);
          if (unchanged && await beforeMerge?.()) {
            this.#listed.delete(canonicalName('settings'));
            unchanged = false;
          }
          if (!unchanged) {
            for (const table of mergedTables) if (!this.#skipped.has(table)) await this.#settle(table);
            for (const table of mergedTables) {
              if (this.#skipped.has(table)) continue;
              // Receipts have settled and the previous merge is complete. A key save can now change the settings revision.
              if (beforeMerge && this.#held === null && !this.#skipped.has('settings') && !this.#settlement.has('settings') && await beforeMerge())
                this.#listed.delete(canonicalName('settings'));
              await this.#mergeFile(table,initial);
            }
          }
        } catch (error) {
          if (error instanceof RestartListing) { this.#settlement.clear(); continue; }
          throw error;
        }
        await this.files.check();
        const complete = !this.#skipped.size;
        return { complete, reason: settingsIssue ?? (complete ? '' : 'Review was canceled for ' + [...this.#skipped].map(canonicalName).join(', ') + '.'),
          notices: [...this.#notices], listing, ...(complete && initial.exportRecord ? {exportRecord:initial.exportRecord} : {}) };
      }
    } finally { if (this.#held !== null) this.#hold(null); }
  }

  async settleForRestore(tables: readonly MergeTable[]): Promise<void> {
    if (tables.includes('settings')) await this.loadProviderKeys?.();
    for (const table of tables) {
      if (this.#restoreInstead?.table === table) {
        // Keep the receipt through the backup. Replacement requires the same reviewed
        // Dropbox revision, including an existing file that blocks the earlier strict add.
        const snapshot = await this.files.snapshot();
        if (!sameReceipt(fileState(snapshot,table).pending,this.#restoreInstead.pending) ||
            writeCsv(table,snapshot.tables[table]) !== this.#restoreInstead.content) {
          throw new SyncStop('The interrupted update changed. Review it again before restoring.');
        }
        continue;
      }
      const outcome = await this.files.settle(table);
      if (outcome.unresolved || outcome.delivery) throw new SyncStop('A pending upload for ' + canonicalName(table) + ' needs review. Choose Sync now before restoring.');
    }
  }

  async replaceForRestore(table: MergeTable, content: string, live: Download | null, onSave?: () => void,
      expectedLocalContent?: string, current?: () => boolean): Promise<RestoreStatus> {
    const issue = backupFileIssue(table, content);
    if (issue) throw new SyncStop(issue);
    if (table === 'lists') {
      const lists = readCsv('lists',content);
      if (lists.normalizedListNames) content = writeCsv('lists',lists.rows);
    }
    let target = checkedText(table, live);
    if (table === 'settings' && this.loadProviderKeys) {
      content = settingsWithoutKeys(content);
      if (target === null) throw new SyncStop('Repair settings.csv in Dropbox before restoring preferences.');
      target = settingsWithoutKeys(target);
    }
    for (;;) {
      const snapshot = await this.files.snapshot();
      if (current && !current()) throw new SyncStop('The restore screen closed. Review the remaining files to restore them.');
      if (expectedLocalContent !== undefined && writeCsv(table, snapshot.tables[table]) !== expectedLocalContent) {
        throw new SyncStop('The device’s file changed after confirmation. Review the restore again.');
      }
      const pendingBefore = fileState(snapshot,table).pending;
      if (pendingBefore && !(this.#restoreInstead?.table === table && expectedLocalContent === this.#restoreInstead.content &&
          content === expectedLocalContent && (live?.metadata.rev ?? null) === this.#restoreInstead.revision &&
          sameReceipt(pendingBefore,this.#restoreInstead.pending))) {
        throw new SyncStop('The restore target still has a pending upload.');
      }
      let pending;
      try { pending = await this.files.prepare(table, snapshot, content, live?.metadata ?? null, target, () => {
        this.#saved(table); onSave?.();
      }, false, current); }
      catch (error) { if (error instanceof StaleSnapshotError) continue; throw error; }
      if (!pending) return 'restored';
      return (await this.files.send(table, pending)).status;
    }
  }
}
