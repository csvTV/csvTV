import type { DropboxController } from './dropbox-controller.ts';
import { mountImport } from './import-screen.ts';
import type { ScreenContext } from './screen-context.ts';
import { readTraktArchive } from './trakt-archive.ts';
import { applyTraktImport, planTraktImport, type TraktPlan } from './trakt-import.ts';
import { resolveTrakt } from './trakt-placement.ts';
import { renderTraktPreview } from './trakt-review-screen.ts';

export function mountTraktImport(root: HTMLElement, ctx: ScreenContext, cloud: DropboxController) {
  return mountImport(root, ctx, cloud, {
    name:'Trakt', format:'ZIP', accept:'.zip,application/zip,application/x-zip-compressed',
    instructions:'Choose the ZIP from Trakt Settings → Data. The ZIP stays on this device. TMDB receives the IDs needed to match shows and episodes.',
    async match(file, service, options) {
      const archive = await readTraktArchive(file, options.signal);
      options.signal.throwIfAborted();
      options.status('Matching shows and episodes with TMDB…');
      return resolveTrakt(archive, service, options);
    },
    prepareSeason:(placement,id,season) => placement.prepareSeason(id,season),
    plan:(placement, record, choices?: Pick<TraktPlan, 'selected' | 'seasonExtras' | 'wholeShowPasses'>) =>
      planTraktImport(placement,record,choices?.selected,choices?.seasonExtras,choices?.wholeShowPasses),
    render:(host,plan,update,prepare) => renderTraktPreview(host,plan,
      (selected,seasonExtras,wholeShowPasses) => update({selected,seasonExtras,wholeShowPasses}),prepare),
    apply:applyTraktImport,
  });
}
