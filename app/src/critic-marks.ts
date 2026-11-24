import type { CriticScores } from './mdblist-service.ts';
import type { MalEntry } from './mal-file.ts';
import type { ScreenContext } from './screen-context.ts';
import type { ImdbHeaders } from './storage.ts';

export interface ShowRatings {
  critics?: Map<number, CriticScores>;
  imdb?: Map<number, number>;
  mal?: Map<number, MalEntry[]>;
}

/** Read independent score caches alongside the screen's own record. Paint each as it arrives. */
export function readDisplayRatings(ctx: Pick<ScreenContext, 'critics'|'imdb'|'mal'>, ids: number[], previous?: ShowRatings,
  options?: {read?: () => Promise<ImdbHeaders | undefined>; signal:AbortSignal}) {
  const scores: ShowRatings = ids.length ? {...previous} : {};
  let validUntil = Infinity, complete = true;
  let listener: ((scores: ShowRatings, source?: keyof ShowRatings) => void) | undefined;
  function read<K extends keyof ShowRatings>(source: K, work: Promise<ShowRatings[K]> | undefined) {
    if (!work) { delete scores[source]; return; }
    return work.then(value => { scores[source] = value; listener?.(scores,source); },
      () => { complete = false; delete scores[source]; listener?.(scores,source); });
  }
  const settled = Promise.all(ids.length ? [
    read('critics', ctx.critics?.read(ids,options?.signal)),
    read('imdb', ctx.imdb?.readShows(ids, deadline => { validUntil = Math.min(validUntil,deadline); },options?.read,options?.signal)),
    read('mal', ctx.mal?.read(ids,options?.signal)),
  ] : []);
  return { settled: settled.then(() => ({complete,validUntil,scores})),
    render(update: (scores: ShowRatings, source?: keyof ShowRatings) => void) { listener = update; update(scores); } };
}

// The two original drawings used in the design mockups. Only these fixed paths are inserted as markup.
const tomato = '<path class="score-red" d="M8 4.4c3.6 0 6.3 2.1 6.3 5.2S11.6 15 8 15s-6.3-2.3-6.3-5.4S4.4 4.4 8 4.4z"/>' +
  '<path class="score-green" d="M8 6.3 5.6 7.2l.7-2-2-1.3 2.5-.2L8 1.2l1.2 2.5 2.5.2-2 1.3.7 2z"/>';
const splat = '<g class="score-green"><path d="M8 3C8.6 1.2 10.4 1.4 10.2 3.4 11.4 2.6 13.6 2.2 13 4.6 12.8 5.6 15.4 6 14.6 8 14.2 9 12.6 8.8 12.8 10.2 13 11.6 14.4 12.6 12.8 13.4 11.6 14 11 12.4 9.8 12.6 8.8 12.8 9 15 7.4 14.8 6 14.6 6.8 12.8 5.8 12.4 4.6 12 3.4 13.6 2.4 12.4 1.6 11.4 3.4 10.6 3.2 9.4 3 8.2.8 8.4 1.2 6.6 1.6 5 3.4 6 4 5 4.6 4 3.2 2.6 4.8 2 6.2 1.5 6.6 3.4 8 3z"/>' +
  '<circle cx="14.3" cy="11.2" r=".8"/><circle cx="1.6" cy="3.4" r=".7"/></g>';

function appendCriticMarks(parent: HTMLElement, scores?: CriticScores) {
  if (!scores || (scores.tomatoes === null && scores.metacritic === null)) return;
  const doc = parent.ownerDocument;
  const group = doc.createElement('span');
  group.className = 'critic-marks';
  if (scores.tomatoes !== null) {
    const mark = doc.createElement('span');
    const fresh = scores.tomatoes >= 60;
    mark.className = 'tomatoes-score';
    mark.title = 'Rotten Tomatoes ' + scores.tomatoes + '% · ' + (fresh ? 'Fresh' : 'Rotten');
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = fresh ? tomato : splat;
    mark.append(svg, scores.tomatoes + '%');
    group.append(mark);
  }
  if (scores.metacritic !== null) {
    const mark = doc.createElement('span');
    mark.className = 'metacritic-score';
    mark.dataset.band = scores.metacritic >= 61 ? 'green' : scores.metacritic >= 40 ? 'yellow' : 'red';
    mark.textContent = String(scores.metacritic);
    mark.title = 'Metacritic ' + scores.metacritic + '/100';
    group.append(mark);
  }
  parent.append(group);
}

export function appendImdbRating(parent: HTMLElement, rating?: number) {
  if (rating === undefined) return;
  const doc = parent.ownerDocument;
  const mark = doc.createElement('span');
  mark.className = 'imdb-score';
  const figure = rating.toFixed(1);
  mark.title = 'IMDb ' + figure + '/10';
  const star = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  star.setAttribute('viewBox', '0 0 16 16');
  star.setAttribute('aria-hidden', 'true');
  star.innerHTML = '<path d="m8 0.8 2.1 4.4 4.9.7-3.5 3.4.8 4.9L8 11.9l-4.3 2.3.8-4.9L1 5.9l4.9-.7z"/>';
  mark.append(star, figure);
  parent.append(mark);
}

export function appendMalRating(parent: HTMLElement, value: number, decimals: 1 | 2) {
  const mark = parent.ownerDocument.createElement('span');
  mark.className = 'myanimelist-score';
  mark.textContent = value.toFixed(decimals);
  mark.title = 'MyAnimeList ' + mark.textContent + '/10';
  parent.append(mark);
}

/** Search supplies a job score or null for the MDBList fallback. Omitting MAL keeps the Show header series-wide. */
export function appendShowRatings(parent: HTMLElement, scores?: CriticScores, imdb?: number, malJobScore?: number | null) {
  const group = parent.ownerDocument.createElement('span');
  group.className = 'outside-scores';
  appendCriticMarks(group, scores);
  appendImdbRating(group, imdb);
  if (malJobScore != null) appendMalRating(group, malJobScore, 2);
  else if (malJobScore === null && scores?.myanimelist != null) appendMalRating(group, scores.myanimelist, 1);
  if (group.childElementCount) parent.append(group);
}
