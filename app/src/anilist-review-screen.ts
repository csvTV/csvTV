import type { AniListChoices, AniListPlan } from './anilist-preview.ts';
import type { PrepareImportSeason } from './import-screen.ts';
import { countReviewCard, quantity, reviewShowsById } from './import-count-controls.ts';
import { renderImportPreview } from './import-review.ts';
import { reviewList } from './review-list.ts';
import { compareTitles } from './record-overview.ts';

export function renderAniListPreview(host: HTMLElement, plan: AniListPlan,
    update: (choices: AniListChoices) => AniListPlan | undefined, prepareSeason?: PrepareImportSeason) {
  const doc = host.ownerDocument;
  type Notice = AniListPlan['notices'][number];
  let refreshEntryGroups: (() => void) | undefined;
  function addNotices(label: string, notices: Notice[], countEpisodes = false) {
    if (!notices.length) return;
    const {details} = reviewList(doc, label, notices.length, i => {
      const notice = notices[i], id = notice.anilistId;
      if (id === undefined || !Number.isSafeInteger(id) || id < 1) return notice.text;
      const link = doc.createElement('a');
      link.href = 'https://anilist.co/anime/' + id;
      link.target = '_blank'; link.rel = 'noopener noreferrer';
      link.textContent = notice.text;
      return link;
    });
    if (countEpisodes) {
      const total = notices.reduce((sum, note) => sum + BigInt(note.episodes), 0n);
      details.querySelector('summary')!.textContent = label + ' · ' + total.toLocaleString() + (total === 1n ? ' episode' : ' episodes');
    }
    details.open = true;
    host.append(details);
  }
  const refreshPlacements = renderImportPreview(host, plan, 'AniList', () => {
    const unplaced: Notice[] = [], skipped: Notice[] = [];
    const warnings = new Map<number,string[]>(), gaps = new Map<number,bigint>();
    for (const notice of plan.notices) {
      switch (notice.kind) {
        case 'unplaced':
          unplaced.push(notice);
          if (notice.review && notice.showId !== undefined) {
            gaps.set(notice.showId,(gaps.get(notice.showId) ?? 0n)+BigInt(notice.episodes));
          }
          break;
        case 'unknown-status': case 'rewatching': case 'overlap':
          if (notice.showId !== undefined) {
            const rows = warnings.get(notice.showId);
            if (rows) rows.push(notice.text); else warnings.set(notice.showId,[notice.text]);
          }
          break;
        default: skipped.push(notice);
      }
    }
    addNotices('Could not place', unplaced, true);
    addNotices('Skipped entries', skipped);
    if (plan.reviewShows.length) {
      let currentShows = reviewShowsById(plan.reviewShows);
      const section = doc.createElement('section'), heading = doc.createElement('h2');
      heading.textContent = 'Entries to review';
      section.append(heading);
      for (const show of [...plan.reviewShows].sort((a,b) => compareTitles({id:a.show_id,title:a.show}, {id:b.show_id,title:b.show}))) {
        const id = show.show_id;
        const reasons = warnings.get(id)?.map(text=>text.startsWith(show.show + ' · ') ? text.slice(show.show.length + 3) : text);
        const gap = gaps.get(id);
        section.append(countReviewCard(doc, {
          source:'anilist', id, show:show.show, reasons, prepareSeason,
          state() {
            const current = currentShows.get(id)!;
            const matched = current.seasons.reduce((count,season) => count + season.matchedEpisodes, 0);
            const delta = current.playDelta;
            const change = delta > 0n ? ' · +' + quantity(delta,'play') : delta < 0n ? ' · −' + quantity(-delta,'play') : '';
            const unplacedCount = gap ? ' · ' + gap.toLocaleString() + ' unplaced' : '';
            return {...current, ...plan.choices, summary:quantity(matched,'matched episode') + unplacedCount + change};
          },
          update(seasonExtras,wholeShowPasses) {
            const next = update({seasonExtras,wholeShowPasses});
            if (!next) return false;
            plan = next;
            currentShows = reviewShowsById(next.reviewShows);
            refreshPlacements(next);
            refreshEntryGroups?.();
            return true;
          },
        }));
      }
      host.append(section);
    }
    if (plan.entryGroups.length) {
      const sorted = () => [...plan.entryGroups].sort((a,b) => compareTitles({id:a.show_id,title:a.show},{id:b.show_id,title:b.show}));
      let groups = sorted();
      const report = reviewList(doc, 'AniList season matches', groups.length, i => {
        const group = groups[i], block = doc.createDocumentFragment();
        const title = doc.createElement('strong'), entries = doc.createElement('ul');
        title.textContent = group.show;
        for (const entry of group.entries) {
          const line = doc.createElement('li');
          line.append('AniList entry ' + entry.id + ' · ' + entry.matched.toLocaleString() + ' of ' +
            entry.progress.toLocaleString() + (entry.progress === 1 ? ' reported episode placed' : ' reported episodes placed'));
          if (!entry.seasons.length) line.append(' · No TMDB season identified');
          for (const {season,ranges} of entry.seasons) {
            const range = doc.createElement('div');
            const projected = plan.broadcastByShow?.get(group.show_id)?.find(r => r.number === season);
            const label = projected ? projected.name ?? 'Season ' + season : season ? 'TMDB season ' + season : 'TMDB specials';
            range.textContent = label + ' · ' + (ranges.length ?
              ranges.map(([first,last]) => first === last ? 'E' + first : 'E' + first + '–' + last).join(', ') : 'None placed');
            line.append(range);
          }
          entries.append(line);
        }
        block.append(title,entries);
        return block;
      });
      report.details.dataset.importReport = 'AniList season matches';
      host.append(report.details);
      refreshEntryGroups = () => { groups = sorted(); report.refreshRows(groups.length); };
    }
    if (plan.scoreGroups.length) {
      const groups = [...plan.scoreGroups].sort((a,b) => compareTitles({id:a.show_id,title:a.show}, {id:b.show_id,title:b.show}));
      const {details} = reviewList(doc, 'Ratings from differing scores', groups.length, i => {
        const group = groups[i];
        return group.show + ' · Entry scores ' + group.scores.map(entry => entry.score / 10).join(', ') +
          ' · Average rounded to ' + group.rating + '/10';
      });
      details.open = true;
      host.append(details);
    }
  });
}
