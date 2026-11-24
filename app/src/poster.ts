import { tmdbImageUrl, type TmdbConfiguration, type TmdbTitle } from './tmdb-data.ts';

/** The linked text names the show. Artwork is decorative and can fail independently. */
export function poster(doc: Document, title: Pick<TmdbTitle, 'posterPath'>, config: TmdbConfiguration | null): HTMLElement {
  const frame = doc.createElement('span');
  frame.className = 'tv-poster';
  frame.setAttribute('aria-hidden', 'true');
  const size = config && (['w185', 'w154', 'w342', 'w92'].find(s => config.posterSizes.includes(s)) ?? config.posterSizes[0]);
  const url = config && size && tmdbImageUrl(config, 'poster', size, title.posterPath);
  if (url) {
    const image = doc.createElement('img');
    image.alt = '';
    image.loading = 'lazy';
    image.decoding = 'async';
    image.referrerPolicy = 'no-referrer';
    image.addEventListener('error', () => image.remove(), { once: true });
    image.src = url;
    frame.append(image);
  }
  return frame;
}
