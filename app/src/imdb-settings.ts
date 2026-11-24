import type { ImdbService } from './imdb-service.ts';
import type { DeviceStore } from './storage.ts';
import { fetchedDate, mountRatingSources, type SaveActivity } from './rating-source-settings.ts';

const names = {none:'None', omdb:'OMDb', github:'GitHub job'} as const;

export function mountImdbSettingsRow(root: HTMLElement, imdb: ImdbService) {
  const doc = root.ownerDocument;
  const row = doc.createElement('a');
  row.className = 'key-row imdb-settings-link';
  row.href = '#/imdb-ratings';
  row.innerHTML = '<div class="key-copy"><strong>IMDb ratings</strong><p></p></div><span aria-hidden="true">›</span>';
  root.querySelector('#settings-services')!.append(row);
  const credit = doc.createElement('p');
  credit.hidden = true;
  credit.innerHTML = 'Information courtesy of IMDb (<a href="https://www.imdb.com" target="_blank" rel="noopener noreferrer">https://www.imdb.com</a>). Used with permission.';
  const omdb = doc.createElement('p');
  omdb.hidden = true;
  omdb.textContent = 'IMDb ratings provided by OMDb.';
  root.querySelector('[data-source-credits]')!.append(credit, omdb);
  let version = 0;
  async function refresh() {
    const ticket = ++version;
    const state = await imdb.status();
    if (ticket !== version) return;
    credit.hidden = state.source === 'none';
    omdb.hidden = state.source !== 'omdb';
    const date = state.source === 'github' && state.fetchedAt !== null ? ', fetched ' + fetchedDate(state.fetchedAt, true) : '';
    row.querySelector('p')!.textContent = 'Optional · ' + names[state.source] + date;
  }
  return {ready:refresh(), refresh, dispose(keepLayout = false) {
    ++version;
    if (!keepLayout) { row.remove(); credit.remove(); omdb.remove(); }
  }};
}

export function mountImdbRatings(root: HTMLElement, imdb: ImdbService, store: DeviceStore, canAccessKeys: () => boolean, keyAccessMessage?: () => string, cloud?: SaveActivity) {
  return mountRatingSources(root, {id:'imdb', service:imdb}, store, canAccessKeys, keyAccessMessage, cloud);
}
