import type { MdbListService } from './mdblist-service.ts';
import { openPersonalDialog } from './personal-dialog.ts';
import type { DeviceStore } from './storage.ts';

export function mountMdbListSettings(root: HTMLElement, service: MdbListService, store: DeviceStore, canAccessKeys: () => boolean,
    keyAccessMessage = () => 'Connect to Dropbox to access this key.') {
  const doc = root.ownerDocument;
  const row = doc.createElement('div');
  row.className = 'key-row mdblist-key';
  row.innerHTML = '<span class="key-symbol" aria-hidden="true"></span><div class="key-copy"><strong>MDBList key</strong>' +
    '<p data-mdblist-status>Checking key…</p></div>' +
    '<button class="help" data-mdblist-help aria-label="How to get an MDBList key"><span>?</span></button>' +
    '<button data-mdblist-edit disabled>Add key</button>';
  root.querySelector('#settings-services')!.append(row);
  const report = row.querySelector('p')!;
  const help = row.querySelector<HTMLButtonElement>('[data-mdblist-help]')!;
  const edit = row.querySelector<HTMLButtonElement>('[data-mdblist-edit]')!;
  const credit = doc.createElement('p');
  credit.dataset.mdblistCredit = '';
  credit.hidden = true;
  root.querySelector('[data-source-credits]')!.append(credit);
  const events = new AbortController();
  let panel: ReturnType<typeof openPersonalDialog> | undefined;
  let editing: bigint | undefined;
  let state: Awaited<ReturnType<MdbListService['keyStatus']>> | undefined;
  let version = 0;

  async function refresh() {
    const current = ++version;
    if (store.role !== 'writer' || !canAccessKeys()) { edit.disabled = true; if (editing !== undefined) panel?.close(); }
    try {
      const next = await service.keyStatus();
      if (current !== version) return;
      state = next;
      const saved = state.status !== 'missing-key';
      if (state.malSource === 'github') {
        const criticCredit = saved ? 'Critic scores come from MDBList. ' : '';
        const sources = saved ? 'Rotten Tomatoes, Metacritic or MyAnimeList' : 'MyAnimeList';
        credit.textContent = criticCredit + 'The selected GitHub job uses MyAnimeList’s API. csvTV is not affiliated with ' + sources + '.';
      } else {
        credit.textContent = 'Critic scores and MyAnimeList scores come from MDBList. csvTV is not affiliated with Rotten Tomatoes, Metacritic or MyAnimeList.';
      }
      credit.hidden = !saved && state.malSource !== 'github';
      edit.textContent = saved ? 'Change' : 'Add key';
      edit.disabled = store.role !== 'writer' || !canAccessKeys();
      if (editing !== undefined && editing !== state.generation) panel?.close();
      report.textContent = !canAccessKeys() ? keyAccessMessage()
        : state.status === 'refused' ? 'Key refused. ' + (state.message || 'Check your MDBList key.')
        : state.status === 'throttled' ? (state.message || 'MDBList has paused requests.')
        : saved ? 'Saved in Dropbox' : 'Optional · No key saved';
    } catch {
      if (current !== version) return;
      state = undefined;
      report.textContent = 'Could not read the saved key.';
      edit.disabled = true;
      credit.hidden = true;
    }
  }

  help.onclick = () => {
    editing = undefined;
    panel = openPersonalDialog(root, 'Get an MDBList key', () => help);
    const {body, close} = panel;
    body.innerHTML = '<p class="secondary">An MDBList key adds Rotten Tomatoes, Metacritic and MyAnimeList scores. The free plan allows 1,000 requests a day.</p>' +
      '<ol class="steps"><li>Sign in to MDBList.<a href="https://mdblist.com/signin" target="_blank" rel="noopener noreferrer">mdblist.com/signin ↗</a></li>' +
      '<li>Open Preferences.<a href="https://mdblist.com/preferences/" target="_blank" rel="noopener noreferrer">mdblist.com/preferences ↗</a></li>' +
      '<li>Paste your API key here.</li></ol>' +
      '<div class="actions help-actions"><button>Done</button><a class="button primary" href="https://mdblist.com/signin" target="_blank" rel="noopener noreferrer">Open MDBList ↗</a></div>';
    body.querySelector('button')!.onclick = close;
  };
  edit.onclick = () => {
    if (!state || store.role !== 'writer' || !canAccessKeys()) return;
    const original = state;
    editing = original.generation;
    panel = openPersonalDialog(root, 'MDBList key', () => edit.disabled ? help : edit);
    const {heading, body, dialog, close, setSaving} = panel;
    body.innerHTML = '<form autocomplete="off"><label for="mdblist-input">API key</label>' +
      '<input type="password" id="mdblist-input" autocomplete="off" autocapitalize="none" spellcheck="false">' +
      '<p class="hint"></p><div class="actions"><button type="button">Cancel</button><button class="primary" type="submit">Save</button></div></form>';
    const input = body.querySelector('input')!;
    body.querySelector('.hint')!.textContent = original.status === 'missing-key' ? 'MDBList receives the show IDs you look up and those in your record.'
      : 'Enter a replacement key, or save an empty field to remove it.';
    const feedback = doc.createElement('p');
    feedback.className = 'feedback';
    feedback.setAttribute('role', 'status');
    body.append(feedback);
    const save = async (key: string) => {
      if (body.inert || store.role !== 'writer' || !canAccessKeys()) return;
      setSaving(true);
      try {
        if (key) await service.saveKey(key, original.generation);
        else await service.removeKey(original.generation);
        close();
        await refresh();
      } catch {
        if (!dialog.open) return;
        setSaving(false);
        feedback.textContent = 'Could not save this change. Check the current key status and try again.';
      }
    };
    body.querySelector('button')!.onclick = close;
    body.querySelector('form')!.onsubmit = event => {
      event.preventDefault();
      const key = input.value.trim();
      if (key) { void save(key); return; }
      if (original.status === 'missing-key') { feedback.textContent = 'Enter your MDBList API key.'; input.focus(); return; }
      heading.textContent = 'Remove the MDBList key?';
      body.innerHTML = '<p>Removing this key deletes the scores this device saved from MDBList.</p>' +
        '<div class="actions"><button data-cancel>Cancel</button><button class="destructive" data-remove>Remove key</button></div>';
      feedback.textContent = '';
      body.append(feedback);
      body.querySelector<HTMLButtonElement>('[data-cancel]')!.onclick = close;
      body.querySelector<HTMLButtonElement>('[data-remove]')!.onclick = () => void save('');
      heading.focus();
    };
    input.focus();
  };
  for (const name of ['mdblistchange', 'recordchange', 'rolechange', 'providerkeyschange']) store.addEventListener(name, refresh, {signal:events.signal});
  return { ready:refresh(), refresh, dispose(keepLayout = false) {
    version++; events.abort(); panel?.close();
    if (!keepLayout) { row.remove(); credit.remove(); }
  } };
}
