import { applyImport, type ImportHooks } from './import-workflow.ts';
import type { DeviceStore } from './storage.ts';
import type { AniListPlacement } from './anilist-placement.ts';
import { planAniListImport, type AniListPlan } from './anilist-preview.ts';

export { planAniListImport, type AniListPlan, type AniListChoices } from './anilist-preview.ts';
export { describeImportChanges } from './import-preview.ts';

export function applyAniListImport(store: DeviceStore, placement: AniListPlacement, approved: AniListPlan,
    hooks: ImportHooks<AniListPlan>): Promise<boolean> {
  return applyImport(store, 'AniList', placement, approved, hooks,
    (snapshot, current) => planAniListImport(placement, snapshot, current.choices));
}
