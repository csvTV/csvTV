import { appendShowRatings } from './critic-marks.ts';
import type { CriticScores } from './mdblist-service.ts';
import { poster } from './poster.ts';
import type { watchProgress } from './progress.ts';
import type { TmdbConfiguration, TmdbTitle } from './tmdb-data.ts';

type SearchWatchAction = 'mark' | 'rewatch-complete';

/** Keep the result's artwork and focused controls mounted as its metadata changes. */
export function createSearchResult(doc: Document, title: TmdbTitle, actions: {
  open(): void;
  mark(button: HTMLButtonElement, action: SearchWatchAction): void;
  setDropped(button: HTMLButtonElement, title: TmdbTitle, dropped: boolean): void;
  lists(title: TmdbTitle): void;
}) {
  const row = doc.createElement('li');
  row.dataset.show = String(title.show_id);
  row.innerHTML = '<a class="result-link"><span><strong></strong><span class="result-counts"></span>' +
    '<span class="result-scores"></span></span></a><div class="result-actions">' +
    '<button type="button" class="result-drop" hidden></button>' +
    '<button type="button" class="result-list" aria-haspopup="dialog">List</button></div>';
  const link = row.querySelector('a')!, name = row.querySelector('strong')!;
  const counts = row.querySelector<HTMLElement>('.result-counts')!, description = doc.createTextNode('');
  const scoreSlot = row.querySelector<HTMLElement>('.result-scores')!;
  const drop = row.querySelector<HTMLButtonElement>('.result-drop')!, lists = row.querySelector<HTMLButtonElement>('.result-list')!;
  const tick = doc.createElement('span'), mark = doc.createElement('button');
  tick.className = 'complete-tick';
  tick.setAttribute('aria-label','Complete');
  tick.setAttribute('role','img');
  tick.textContent = '✓';
  counts.append(description);
  mark.type = 'button';
  mark.className = 'result-mark primary';
  let watchAction: SearchWatchAction | null = null;
  let dropped = false;
  mark.onclick = () => { if (watchAction) actions.mark(mark,watchAction); };
  drop.onclick = () => actions.setDropped(drop,title,!dropped);
  lists.disabled = true;
  lists.onclick = () => actions.lists(title);
  link.href = '#/show/' + title.show_id;
  link.onclick = event => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    event.preventDefault();
    actions.open();
  };
  let artwork: HTMLElement | undefined, artworkKey: string | undefined;
  let scoreKey = '';

  function previewTitle(t: TmdbTitle, config: TmdbConfiguration | null) {
    title = t;
    if (name.textContent !== t.show) {
      name.textContent = t.show;
      lists.setAttribute('aria-label','Lists for ' + t.show);
    }
    const source = [t.posterPath,config?.secureBaseUrl,config?.posterSizes.join(',')].join('|');
    if (artworkKey !== source) {
      const next = poster(doc,t,config);
      if (artwork) artwork.replaceWith(next);
      else link.prepend(next);
      artwork = next;
      artworkKey = source;
    }
    if (!description.data && t.firstAirDate) description.data = t.firstAirDate.slice(0,4);
  }
  function setBusy(busy: boolean) {
    for (const button of [mark,drop]) {
      const disabled = String(busy || button.disabled);
      if (button.getAttribute('aria-disabled') !== disabled) button.setAttribute('aria-disabled',disabled);
    }
  }
  function update(t: TmdbTitle, config: TmdbConfiguration | null, progress: ReturnType<typeof watchProgress>,
      canMark: boolean, isDropped: boolean, busy: boolean, writable: boolean) {
    previewTitle(t,config);
    const p = progress, pieces: string[] = [];
    if (t.firstAirDate) pieces.push(t.firstAirDate.slice(0,4));
    if (!p.recordedEpisodes) pieces.push('Not watched');
    else if (p.aired) pieces.push(p.watchedAired.toLocaleString() + ' of ' + p.aired.toLocaleString() + ' episodes');
    else pieces.push(p.recordedEpisodes.toLocaleString() + (p.recordedEpisodes === 1 ? ' episode' : ' episodes'));
    if (p.completed && p.completed >= 2) pieces.push(p.completed.toLocaleString() + ' times');
    const text = pieces.join(' · ');
    if (description.data !== text) description.data = text;
    if (p.complete && !tick.parentNode) counts.prepend(tick);
    if (!p.complete && tick.parentNode) tick.remove();

    watchAction = canMark ? (p.complete ? 'rewatch-complete' : 'mark') : null;
    if (watchAction) {
      const label = p.complete ? 'Rewatch' : 'Mark watched';
      const name = p.complete ? 'Rewatch ' + t.show : 'Mark ' + t.show + ' watched';
      if (mark.textContent !== label) mark.textContent = label;
      if (mark.getAttribute('aria-label') !== name) mark.setAttribute('aria-label',name);
    }
    if ((!canMark && doc.activeElement === mark) || (!writable && (doc.activeElement === lists || doc.activeElement === drop))) link.focus({preventScroll:true});
    if (canMark && !mark.parentNode) drop.before(mark);
    if (!canMark && mark.parentNode) mark.remove();
    dropped = isDropped;
    const dropText = dropped ? 'Pick Up' : 'Drop', dropLabel = dropText + ' ' + t.show;
    if (drop.textContent !== dropText) drop.textContent = dropText;
    if (drop.getAttribute('aria-label') !== dropLabel) drop.setAttribute('aria-label',dropLabel);
    drop.hidden = false;
    drop.disabled = !writable;
    setBusy(busy);
    lists.toggleAttribute('disabled',!writable);
  }
  function updateRatings(critics: CriticScores | undefined, imdb: number | undefined, mal: number | null) {
    const key = [critics?.tomatoes,critics?.metacritic,imdb,mal,mal === null ? critics?.myanimelist : null].join('|');
    if (key === scoreKey) return;
    scoreKey = key;
    scoreSlot.replaceChildren();
    appendShowRatings(scoreSlot,critics,imdb,mal);
  }
  return {row, previewTitle, update, updateRatings, setBusy};
}
