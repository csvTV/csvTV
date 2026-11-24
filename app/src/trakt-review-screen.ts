import type { TraktPlan } from './trakt-import.ts';
import type { PrepareImportSeason, UpdateImportCounts } from './import-screen.ts';
import { countReviewCard, quantity, reviewShowsById } from './import-count-controls.ts';
import { renderImportPreview } from './import-review.ts';
import { compareTitles } from './record-overview.ts';

export function renderTraktPreview(host: HTMLElement, plan: TraktPlan, update: UpdateImportCounts<TraktPlan>, prepareSeason?: PrepareImportSeason) {
  const doc = host.ownerDocument;
  const refreshPlacements = renderImportPreview(host, plan, 'Trakt', () => {
    if (!plan.counts.length) return;
    let currentShows = reviewShowsById(plan.reviewShows);
    const section = doc.createElement('section'), heading = doc.createElement('h2');
    heading.textContent = 'Check these counts';
    section.append(heading);
    for (const check of [...plan.counts].sort((a, b) => compareTitles({id:a.show_id, title:a.show}, {id:b.show_id, title:b.show}))) {
      const id = check.show_id;
      section.append(countReviewCard(doc, {
        source:'trakt', id, show:check.show, prepareSeason,
        state() {
          const current = currentShows.get(id)!;
          const remaining = BigInt(check.total) - BigInt(check.listedPlays) - current.playDelta;
          const summary = remaining < 0n ? quantity(-remaining,'play') + ' above Trakt’s total of ' + check.total.toLocaleString()
            : remaining.toLocaleString() + ' of ' + quantity(check.total,'play') + ' unassigned';
          return {...current,
            seasonExtras:plan.seasonExtras, wholeShowPasses:plan.wholeShowPasses, summary};
        },
        update(extras, whole) {
          const next = update(plan.selected,extras,whole);
          if (!next) return false;
          plan = next;
          currentShows = reviewShowsById(next.reviewShows);
          refreshPlacements(next);
          return true;
        },
      }));
    }
    host.append(section);
  });
}
