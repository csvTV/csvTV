import { applyImport, type ImportHooks } from './import-workflow.ts';
import type { DeviceStore } from './storage.ts';
import type { TraktPlacement } from './trakt-placement.ts';
import { planTraktImport, type TraktPlan } from './trakt-preview.ts';

export { describeTraktChanges, planTraktImport, type TraktCountSeason, type TraktPlan, type TraktSeasonExtras } from './trakt-preview.ts';

export function applyTraktImport(store: DeviceStore, placement: TraktPlacement, approved: TraktPlan,
    hooks: ImportHooks<TraktPlan>): Promise<boolean> {
  return applyImport(store, 'Trakt', placement, approved, hooks,
    (snapshot, current) => planTraktImport(placement, snapshot, current.selected, current.seasonExtras, current.wholeShowPasses));
}
