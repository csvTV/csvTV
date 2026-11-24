import { readCsv } from './csv.ts';
import type { MergeTable } from './model.ts';
import { backupFileIssue, restorableTables, writeBackup } from './dropbox-backup.ts';
import type { DropboxApi } from './dropbox-api.ts';
import { DropboxError } from './dropbox-client.ts';
import { SyncStop, type DropboxSync } from './dropbox-sync.ts';

export type RestoreOutcome = 'untouched' | 'restored' | 'local-only' | 'unknown' | 'accepted-unacknowledged' | 'conflict-unacknowledged';
export const restoreOutcomeLabel: Record<RestoreOutcome, string> = {
  restored: 'Restored.', untouched: 'Not restored.', 'local-only': 'Restored on this device only. Dropbox changed.',
  unknown: 'Restored on this device. Delivery to Dropbox is unknown.',
  'accepted-unacknowledged': 'Dropbox accepted the upload. Local reconciliation is pending.',
  'conflict-unacknowledged': 'Restored on this device only. Dropbox refused the upload and local reconciliation is pending.',
};
export interface RestoreResult {
  files: Map<MergeTable, RestoreOutcome>;
  issue: string | null;
  compatibility: boolean;
}
type Live = Awaited<ReturnType<DropboxApi['download']>>;
interface RestoreOptions {
  onSaved?(): void;
  onProgress?(message: string): void;
  onLastSave?(): void;
  guardTarget?: { table: MergeTable; revision: string | null; content: string };
  reviewedLocal?: ReadonlyMap<MergeTable,string>;
  current?(): boolean;
}

function checkLive(table: MergeTable, file: Live, result: RestoreResult) {
  if (!file) return;
  const checked = readCsv(table, file.bytes);
  if (checked.schema === 'unknown') {
    result.compatibility = true;
    throw new RestoreIssue(table + '.csv uses a newer format. Reload csvTV before restoring it.');
  }
  if (checked.schema === 'unconfirmed') throw new RestoreIssue('Repair the live ' + table + '.csv in Dropbox before restoring it.');
}
class RestoreIssue extends Error {}

export function restoreFailure(error:unknown, step:string, fallback:string):string {
  if (error instanceof DOMException && error.name === 'QuotaExceededError') {
    return step + ' This device is out of storage. Free some space, then review the files again.';
  }
  // A provider response can contain private data. Show only its known public category.
  const reason = error instanceof DropboxError ? new DropboxError(error.kind).message : fallback;
  return step + ' ' + reason;
}

/** Hold the caller's operation lock across the entire restore, including each acknowledgement. */
export async function restoreBackup(api: DropboxApi, engine: Pick<DropboxSync, 'settleForRestore' | 'replaceForRestore'>,
    chosen: ReadonlyMap<MergeTable, string>, options: RestoreOptions = {}): Promise<RestoreResult> {
  const { onSaved, onProgress, onLastSave, guardTarget, current } = options;
  const selected = new Map(chosen);
  const tables = restorableTables.filter(t => selected.has(t));
  const result: RestoreResult = { files: new Map(tables.map(t => [t, 'untouched'])), issue: null, compatibility: false };
  function ensureActive() {
    if (current && !current()) throw new RestoreIssue('The restore screen closed. Review the remaining files to restore them.');
  }
  try {
    if (!tables.length || tables.length !== selected.size) throw new RestoreIssue('Choose a recoverable record file.');
    for (const t of tables) {
      const issue = backupFileIssue(t, selected.get(t)!);
      if (issue) throw new RestoreIssue(issue);
    }
    onProgress?.('Settling outstanding uploads…');
    ensureActive();
    await engine.settleForRestore(tables);
    ensureActive();
    onProgress?.('Backing up the current Dropbox files…');
    const backup = await writeBackup(api, { beforeRestore: true });
    ensureActive();
    if (!backup?.entries) throw new RestoreIssue('The prerequisite backup could not be verified.');
    onProgress?.('Checking the format and revision of every selected file…');
    const approved = new Map<MergeTable, string | null>();
    for (const t of tables) {
      ensureActive();
      const live = await api.download('/' + t + '.csv');
      checkLive(t, live, result);
      const revision = live?.metadata.rev ?? null;
      if ((backup.entries[t + '.csv']?.rev ?? null) !== revision) throw new RestoreIssue('A file changed after the backup. Review the restore again.');
      if (backup.entries[t + '.csv']?.omitted) throw new RestoreIssue('Repair the live settings.csv in Dropbox before restoring preferences.');
      if (t === guardTarget?.table && guardTarget.revision !== revision) throw new RestoreIssue(t + '.csv changed after the guard opened. Review the current Dropbox revision.');
      approved.set(t, revision);
    }
    for (const t of tables) {
      ensureActive();
      onProgress?.('Restoring ' + t + '.csv…');
      const live = await api.download('/' + t + '.csv');
      ensureActive();
      checkLive(t, live, result);
      if (approved.get(t) !== (live?.metadata.rev ?? null)) throw new RestoreIssue(t + '.csv changed after review. Review the remaining files again.');
      const outcome = await engine.replaceForRestore(t, selected.get(t)!, live, () => {
        result.files.set(t, 'unknown');
        onSaved?.();
        if (t === tables.at(-1)) onLastSave?.();
      }, t === guardTarget?.table ? guardTarget.content : options.reviewedLocal?.get(t), current);
      result.files.set(t, outcome);
      if (outcome !== 'restored') throw new RestoreIssue('The restore stopped. Check each file’s outcome below.');
    }
  } catch (error) {
    result.issue = error instanceof RestoreIssue || error instanceof SyncStop ? error.message :
      restoreFailure(error,'Could not finish the Dropbox restore.','Check the connection and sign-in, then review the files again.');
  }
  return result;
}
