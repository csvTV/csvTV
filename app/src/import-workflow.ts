import type { ProviderSession } from './provider-credentials.ts';
import { retainRecentMarks } from './watch-record.ts';
import type { DropboxIdentity } from './dropbox-auth.ts';
import { mergedTables, tableMatchesDropboxBase } from './dropbox-sync-file.ts';
import { StaleSnapshotError, type DeviceSnapshot, type DeviceStore } from './storage.ts';
import { sameImportOutcome, type ImportPlan } from './import-preview.ts';
import type { CacheEntry } from './tmdb-data.ts';
import {seasonOrderKey} from './season-order.ts';

export interface ImportHooks<Plan> {
  preflight: (expected: DropboxIdentity) => Promise<void>;
  backup: (expected: DropboxIdentity) => Promise<void>;
  confirm: (current: Plan, previous: Plan) => Promise<boolean>;
  active: () => boolean;
  online: () => boolean;
  now?: () => number;
}

interface ImportMetadata {
  generation: bigint;
  seasonOrders?: ReadonlyMap<number,string|undefined>;
  cache: Map<string, CacheEntry & { prior: CacheEntry | null }>;
}

/** The caller holds the writer's exclusive import lock throughout sync, owner decisions, backup and commit. */
export async function applyImport<Plan extends ImportPlan>(store: DeviceStore, source: 'Trakt' | 'AniList',
    placement: ImportMetadata, approved: Plan, hooks: ImportHooks<Plan>,
    replan: (snapshot: DeviceSnapshot, approved: Plan) => Plan): Promise<boolean> {
  const now = hooks.now ?? Date.now;
  function checkAccess(accountId: unknown, session: ProviderSession | null) {
    if (store.role !== 'writer') throw Error('Open the import in the tab that can edit this record.');
    if (!hooks.online()) throw Error('Connect to the internet before importing from ' + source + '.');
    if (!accountId || !session || accountId !== approved.accountId || session.instanceId !== approved.instanceId ||
        session.accountId !== accountId || !(session.signInDeadline > now())) {
      throw Error('The Dropbox sign-in changed or ended. Open the file again.');
    }
    return {accountId:session.accountId,instanceId:session.instanceId};
  }
  async function checkKey() {
    const state = await store.tmdbState();
    if (state.generation !== placement.generation || !state.token || state.refused !== null) {
      throw Error('The TMDB key changed or needs attention. Open the file again after checking the key.');
    }
  }
  while (hooks.active()) {
    const binding = await store.dropboxState();
    const owner = checkAccess(binding.accountId,binding.session);
    await checkKey();
    if (!hooks.active()) return false;
    await hooks.preflight(owner);
    if (!hooks.active()) return false;
    const snapshot = await store.snapshot();
    const session = snapshot.local.dropboxSession;
    checkAccess(snapshot.local.syncAccountId ?? null, session ?? null);
    if (placement.seasonOrders) {
      const settings = new Map(snapshot.tables.settings.map(row => [row.setting,row.value]));
      for (const [id,reviewed] of placement.seasonOrders) {
        if (settings.get(seasonOrderKey(id)) !== reviewed) throw Error('Season order changed. Reopen this import to review the new seasons.');
      }
    }
    if (snapshot.tmdbGeneration !== placement.generation) {
      throw Error('The TMDB key changed. Open the file again.');
    }
    if (!mergedTables.every(table => tableMatchesDropboxBase(snapshot, table))) {
      throw Error('A file is still waiting to sync. Your ' + source + ' import has not been applied.');
    }
    const plan = replan(snapshot, approved);
    if (!sameImportOutcome(plan, approved)) {
      if (!await hooks.confirm(plan, approved) || !hooks.active()) return false;
      approved = plan;
      // An edit during review must go through preflight before making an additional backup.
      if ((await store.dropboxState()).revision !== snapshot.revision) continue;
    }
    if (!hooks.active()) return false;
    await hooks.backup(owner);
    if (!hooks.active()) return false;
    checkAccess(snapshot.local.syncAccountId ?? null, session ?? null);
    try {
      const hasEdits = Object.values(plan.changes.put ?? {}).some(rows => rows?.length) ||
        Object.values(plan.changes.remove ?? {}).some(keys => keys?.length);
      if (!hasEdits && !placement.cache.size) {
        // A change during backup still needs a new comparison.
        const latest = await store.dropboxState();
        checkAccess(latest.accountId, latest.session);
        if (latest.revision !== snapshot.revision) continue;
        await checkKey();
        return hooks.active();
      }
      await store.commit(snapshot.revision, retainRecentMarks(snapshot, plan.changes), {
        requireTmdbGeneration: placement.generation,
        tmdbImport: { generation: placement.generation, entries: placement.cache,
          session: {accountId:owner.accountId,instanceId:owner.instanceId,signInDeadline:session!.signInDeadline} },
        current: () => hooks.active() && hooks.online() && !!session && session.signInDeadline > now(),
      });
      return true;
    } catch (error) {
      if (!(error instanceof StaleSnapshotError)) throw error;
      // The old transaction made no writes. Reread credentials and rerun the prerequisites.
    }
  }
  return false;
}
