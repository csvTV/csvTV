import type { Route } from './screen-context.ts';

/** Destination for Back when the current screen was opened from a bookmark. */
export function parentRoute(route: Route): Route {
  switch (route.page) {
    case 'season': return {page:'show', id:route.id};
    case 'cast': return route.showId === undefined ? {page:'home'} : {page:'show', id:route.showId};
    case 'recovery': case 'hand-merge': case 'trakt-import': case 'anilist-import':
    case 'imdb-ratings': case 'mal-scores': return {page:'settings'};
    default: return {page:'home'};
  }
}

export function routeHref(route: Route): string {
  switch (route.page) {
    case 'watchlist': return route.section ? '#/watchlist/' + route.section : '#/watchlist';
    case 'home': case 'lists': case 'settings': case 'library': case 'ratings':
    case 'statistics': case 'export': case 'recovery': case 'hand-merge': case 'trakt-import': case 'anilist-import':
    case 'imdb-ratings': case 'mal-scores': return '#/' + route.page;
    case 'search': return '#/search' + (route.query ? '?' + new URLSearchParams({ q: route.query }) : '');
    case 'show': return '#/show/' + route.id;
    case 'season': return '#/show/' + route.id + '/season/' + route.season;
    case 'cast': return '#/cast/' + route.id + (route.showId !== undefined ? '?show=' + route.showId : '');
  }
}

export function readRoute(hash: string): Route {
  const [path, query = ''] = hash.slice(1).split(/\?(.*)/s);
  if (path === '/upcoming') return { page: 'watchlist' };
  if (path === '/more-to-watch' || path === '/watchlist/more-to-watch') return { page:'watchlist', section:'more-to-watch' };
  for (const page of ['library', 'ratings', 'watchlist', 'settings', 'lists', 'statistics', 'export','recovery','hand-merge','trakt-import','anilist-import','imdb-ratings','mal-scores'] as const) {
    if (path === '/' + page) return { page };
  }
  if (path === '/search') return { page: 'search', query: new URLSearchParams(query).get('q') ?? '' };
  const person = /^\/cast\/([1-9]\d*)$/.exec(path);
  if (person && Number.isSafeInteger(Number(person[1]))) {
    const id = Number(person[1]);
    const source = new URLSearchParams(query).get('show') ?? '';
    return /^(0|[1-9]\d*)$/.test(source) && Number.isSafeInteger(Number(source))
      ? { page: 'cast', id, showId: Number(source) } : { page: 'cast', id };
  }
  const parts = /^\/show\/(0|[1-9]\d*)(?:\/season\/(0|[1-9]\d*))?$/.exec(path);
  if (parts && Number.isSafeInteger(Number(parts[1]))) {
    const id = Number(parts[1]);
    if (parts[2] === undefined) return { page: 'show', id };
    if (Number.isSafeInteger(Number(parts[2]))) return { page: 'season', id, season: Number(parts[2]) };
  }
  return { page: 'home' };
}
