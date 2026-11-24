import type { MalService } from './mal-service.ts';
import { fetchedDate, mountRatingSources, type SaveActivity } from './rating-source-settings.ts';
import type { DeviceStore } from './storage.ts';

export function mountMalScores(root: HTMLElement, mal: MalService, store: DeviceStore, canAccessKeys: () => boolean, keyAccessMessage?: () => string, cloud?: SaveActivity) {
  return mountRatingSources(root, {id:'mal', service:mal}, store, canAccessKeys, keyAccessMessage, cloud);
}

export function mountMalSettingsRow(root: HTMLElement, mal: MalService) {
  const row = root.ownerDocument.createElement('a');
  row.className = 'key-row mal-settings-link';
  row.href = '#/mal-scores';
  row.innerHTML = '<div class="key-copy"><strong>MyAnimeList scores</strong><p></p></div><span aria-hidden="true">›</span>';
  root.querySelector('#settings-services')!.append(row);
  let version = 0;
  async function refresh() {
    const ticket = ++version;
    const state = await mal.status();
    if (ticket !== version) return;
    const date = state.fetchedAt === null ? '' : ', fetched ' + fetchedDate(state.fetchedAt, true);
    row.querySelector('p')!.textContent = state.source === 'github'
      ? 'Optional · GitHub job' + date : 'Optional · MDBList, one score per show';
  }
  return {ready:refresh(), refresh, dispose(keepLayout = false) { ++version; if (!keepLayout) row.remove(); }};
}
