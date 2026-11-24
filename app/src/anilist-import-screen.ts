import type { DropboxController } from './dropbox-controller.ts';
import { mountImport } from './import-screen.ts';
import type { ScreenContext } from './screen-context.ts';
import { readAniListArchive } from './anilist-archive.ts';
import { applyAniListImport, planAniListImport } from './anilist-import.ts';
import { resolveAniList } from './anilist-placement.ts';
import { renderAniListPreview } from './anilist-review-screen.ts';

export function mountAniListImport(root: HTMLElement, ctx: ScreenContext, cloud: DropboxController) {
  return mountImport(root, ctx, cloud, {
    name:'AniList', format:'JSON', accept:'.json,application/json',
    instructions:'Choose your AniList data export. The JSON stays on this device. csvTV downloads a public mapping file from GitHub. TMDB receives the matched show IDs to look up their episodes.',
    async match(file, service, options) {
      const archive = await readAniListArchive(file, options.signal);
      options.signal.throwIfAborted();
      options.status('Checking the public mapping file and matching episodes…');
      return resolveAniList(archive, service, options);
    },
    prepareSeason:(placement,id,season) => placement.prepareSeason(id,season),
    plan:planAniListImport, render:renderAniListPreview, apply:applyAniListImport,
  });
}
