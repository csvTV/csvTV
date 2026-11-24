import type { ImdbService } from './imdb-service.ts';
import type { MalService } from './mal-service.ts';
import type { DeviceStore } from './storage.ts';
import type { DropboxController } from './dropbox-controller.ts';
import { validGithubRepo } from './csv.ts';
import { openPersonalDialog } from './personal-dialog.ts';
import { openRatingsHelp } from './imdb-help.ts';

type Job = {id:'imdb'; service:ImdbService} | {id:'mal'; service:MalService};
export type SaveActivity = Pick<DropboxController, 'changed' | 'operation'>;
async function jobStatus(job: Job) {
  if (job.id === 'imdb') {
    const state = await job.service.status();
    return {...state, countLabel:state.showCount.toLocaleString() + (state.showCount === 1 ? ' show rated' : ' shows rated')};
  }
  const state = await job.service.status();
  return {...state, hasOmdbKey:false, countLabel:state.entryCount.toLocaleString() + (state.entryCount === 1 ? ' entry scored' : ' entries scored')};
}
type Status = Awaited<ReturnType<typeof jobStatus>>;
type Setting = 'omdb_key' | 'github_repo' | 'github_token';
const labels: Record<Setting, string> = {omdb_key:'OMDb key', github_repo:'Repository', github_token:'Access token'};
const names = {none:'None', omdb:'OMDb', github:'GitHub job', mdblist:'MDBList'} as const;
export const fetchedDate = (time: number, short = false) => new Intl.DateTimeFormat('en-GB', {
  day:'numeric', month:'short', year:short && new Date(time).getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
}).format(new Date(time));

function openEditor(root: HTMLElement, setting: Setting, state: Status, job: Job, trigger: HTMLElement, canSave: () => boolean, cloud?: SaveActivity) {
  const {body, heading, dialog, progress, close, setSaving} = openPersonalDialog(root, labels[setting], () => trigger);
  progress.className = 'feedback';
  const repo = setting === 'github_repo';
  const saved = repo ? !!state.repository : setting === 'omdb_key' ? state.hasOmdbKey : state.hasToken;
  body.innerHTML = `<form autocomplete="off"><label for="${job.id}-setting-input"></label><input id="${job.id}-setting-input" ` +
    `autocomplete="off" autocapitalize="none" spellcheck="false" aria-describedby="${job.id}-setting-hint">` +
    `<p id="${job.id}-setting-hint" class="hint"></p><div class="actions"><button type="button">Cancel</button>` +
    '<button class="primary" type="submit">Save</button></div></form><p class="feedback" role="status"></p>';
  body.querySelector('label')!.textContent = labels[setting];
  const input = body.querySelector('input')!;
  input.type = repo ? 'text' : 'password';
  if (repo) input.value = state.repository;
  body.querySelector('.hint')!.textContent = (repo ? 'Enter only owner/name, without the GitHub address.'
    : setting === 'omdb_key' ? 'Paste the key from OMDb.' : 'Paste a fine-grained token with read access to Contents for this repository.') +
    (saved ? ' Save an empty field to remove it.' : '');
  const feedback = body.querySelector<HTMLElement>('.feedback')!;
  async function commit(value: string | null) {
    if (body.inert || !canSave()) return;
    const update = () => setSaving(true, repo ? 'Saving…' : cloud?.operation === 'sync'
      ? 'Waiting for Dropbox sync…' : value === null ? 'Removing from Dropbox…' : 'Saving to Dropbox…');
    feedback.textContent = '';
    const buttons = body.querySelectorAll('button');
    for (const button of buttons) button.disabled = true;
    if (!repo) cloud?.changed.addEventListener('change', update);
    update();
    const current = () => dialog.open && canSave();
    try {
      if (job.id === 'imdb') await job.service.configure(setting, value, state.generation, current);
      else if (setting !== 'omdb_key') await job.service.configure(setting, value, state.generation, current);
      close();
    } catch {
      if (!dialog.open) return;
      setSaving(false);
      for (const button of buttons) button.disabled = false;
      feedback.textContent = 'Could not save the change. Check the current setting and try again.';
    } finally { cloud?.changed.removeEventListener('change', update); }
  }
  body.querySelector('button')!.onclick = close;
  body.querySelector('form')!.onsubmit = event => {
    event.preventDefault();
    const value = input.value.trim();
    if (value) {
      if (repo && !validGithubRepo(value)) { feedback.textContent = 'Enter the repository as owner/name.'; input.focus(); return; }
      void commit(value);
    } else if (!saved) {
      feedback.textContent = 'Enter ' + (repo ? 'the repository as owner/name.' : 'a value before saving.');
      input.focus();
    } else {
      heading.textContent = 'Remove ' + (repo ? 'the repository' : 'the ' + labels[setting]) + '?';
      body.innerHTML = '<p></p><div class="actions"><button data-cancel>Cancel</button><button class="destructive" data-remove>Remove</button></div>';
      body.querySelector('p')!.textContent = setting === 'omdb_key' ? 'This clears the OMDb ratings saved on this device.'
        : 'Saved job ratings stay available. Downloads resume when the repository and token are both set.';
      feedback.textContent = '';
      body.append(feedback);
      body.querySelector<HTMLButtonElement>('[data-cancel]')!.onclick = close;
      body.querySelector<HTMLButtonElement>('[data-remove]')!.onclick = () => void commit(null);
      heading.focus();
    }
  };
  input.focus();
  return close;
}

export function mountRatingSources(root: HTMLElement, job: Job, store: DeviceStore, canAccessKeys: () => boolean,
    keyAccessMessage = () => 'Connect to Dropbox to access this credential.', cloud?: SaveActivity) {
  const doc = root.ownerDocument;
  const id = job.id;
  const attribute = (suffix: string) => 'data-' + id + '-' + suffix;
  const select = (suffix: string, value?: string) => '[' + attribute(suffix) + (value ? '=' + value : '') + ']';
  const isImdb = id === 'imdb';
  const title = isImdb ? 'IMDb ratings' : 'MyAnimeList scores';
  root.innerHTML = `<section class="${id}-settings rating-source-settings"><h1>${title}</h1>` +
    '<fieldset class="rating-sources"><legend>Ratings source</legend></fieldset>' +
    (isImdb ? '<section class="group" data-imdb-section="omdb" hidden><h2>OMDb</h2>' +
    '<p class="secondary">A free key allows 1,000 lookups a day. Some episodes have no OMDb rating.</p></section>' : '') +
    `<section class="group" ${attribute('section')}="github" hidden><h2>GitHub job</h2>` +
    '<div class="key-row" data-file><div class="key-copy"><strong>Ratings file</strong><p data-fetched></p></div>' +
    `<button ${attribute('refresh')}>Refresh now</button></div>` +
    (isImdb ? '' : '<p class="hint">The IMDb and MyAnimeList jobs share the repository and token. Your MyAnimeList Client ID stays in the repository’s secrets.</p>') +
    `</section><p class="feedback" ${attribute('message')} role="status"></p></section>`;
  const find = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!;
  const fieldset = find<HTMLFieldSetElement>('fieldset');
  const github = find(select('section', 'github'));
  const omdb = root.querySelector<HTMLElement>('[data-imdb-section=omdb]');
  const file = find('[data-file]');
  const fetchButton = find<HTMLButtonElement>(select('refresh'));
  const feedback = find(select('message'));
  let state: Status | undefined;
  let version = 0, closed = false, writing = false, fetching = false;
  let editGeneration: bigint | undefined;
  let editingSecret = false;
  let closePanel: (() => void) | undefined;

  function help(source: 'omdb' | 'github') {
    const button = doc.createElement('button');
    button.className = 'help';
    button.setAttribute(attribute('help'), source);
    button.setAttribute('aria-label', source === 'omdb' ? 'How to get an OMDb key' : isImdb ? 'How to set up the GitHub job' : 'How to set up the MyAnimeList job');
    button.innerHTML = '<span aria-hidden="true">?</span>';
    button.onclick = () => {
      editGeneration = undefined;
      closePanel = openRatingsHelp(root, isImdb ? source : 'mal', button, store);
    };
    return button;
  }
  const sources = isImdb ? ['none','omdb','github'] as const : ['mdblist','github'] as const;
  for (const source of sources) {
    const row = doc.createElement('div'); row.className = 'key-row';
    const label = doc.createElement('label');
    const radio = doc.createElement('input');
    radio.type = 'radio'; radio.name = id + '-source'; radio.value = source; radio.disabled = true;
    label.append(radio, names[source]);
    if (source !== 'none') {
      const hint = doc.createElement('small');
      const hints = {omdb:'Look up shows and seasons with your own key.', mdblist:'One score per show with your MDBList key.',
        github:isImdb ? 'Read IMDb’s daily ratings from your private repository.' : 'Your repository checks MyAnimeList daily for show and season scores.'};
      hint.textContent = hints[source];
      label.append(hint);
    }
    radio.onchange = async () => {
      if (!state || !radio.checked || writing) return;
      writing = true; feedback.textContent = '';
      let failed = false;
      try {
        if (job.id === 'imdb') await job.service.configure('imdb_source', source === 'none' ? null : source, state.generation);
        else await job.service.configure('mal_source', source === 'mdblist' ? null : source, state.generation);
      }
      catch { failed = true; }
      finally {
        writing = false;
        if (!closed) {
          await refresh();
          if (failed) feedback.textContent = 'Could not change the ratings source. Try again.';
        }
      }
    };
    row.append(label); if (source === 'github' || source === 'omdb') row.append(help(source)); fieldset.append(row);
  }
  const credentials = isImdb ? ['omdb_key','github_repo','github_token'] as const : ['github_repo','github_token'] as const;
  for (const setting of credentials) {
    const row = doc.createElement('div'); row.className = 'key-row';
    row.innerHTML = '<div class="key-copy"><strong></strong><p></p></div>';
    row.querySelector('strong')!.textContent = labels[setting];
    row.querySelector('p')!.setAttribute(attribute('value'), setting);
    const button = doc.createElement('button');
    button.setAttribute(attribute('edit'), setting);
    button.onclick = () => {
      const canSave = () => store.role === 'writer' && (setting === 'github_repo' || canAccessKeys());
      if (state && canSave()) {
        editGeneration = state.generation;
        editingSecret = setting !== 'github_repo';
        closePanel = openEditor(root, setting, state, job, button, canSave, cloud);
      }
    };
    row.append(button);
    if (setting === 'omdb_key') omdb!.querySelector('h2')!.after(row);
    else file.before(row);
  }

  async function refresh() {
    const current = ++version;
    if (editGeneration !== undefined && editingSecret && !canAccessKeys()) { closePanel?.(); editGeneration = undefined; }
    if (store.role !== 'writer') {
      if (editGeneration !== undefined) { closePanel?.(); editGeneration = undefined; }
      for (const control of root.querySelectorAll<HTMLInputElement | HTMLButtonElement>(['input',select('edit'),select('refresh')].join(','))) control.disabled = true;
      if (store.role === 'closed' || store.role === 'obsolete') return;
    }
    const next = await jobStatus(job);
    if (closed || current !== version) return;
    if (editGeneration !== undefined && (editGeneration !== next.generation || store.role !== 'writer')) {
      closePanel?.(); editGeneration = undefined;
    }
    state = next;
    for (const radio of fieldset.querySelectorAll('input')) {
      radio.checked = radio.value === next.source;
      radio.disabled = store.role !== 'writer' || writing;
    }
    github.hidden = next.source !== 'github';
    if (omdb) omdb.hidden = next.source !== 'omdb';
    for (const setting of credentials) {
      const unavailable = setting !== 'github_repo' && !canAccessKeys();
      const configured = setting === 'github_repo' ? !!next.repository : setting === 'omdb_key' ? next.hasOmdbKey : next.hasToken;
      const refused = next.refused && (setting === 'github_token' && next.source === 'github' || setting === 'omdb_key' && next.source === 'omdb');
      find(select('value', setting)).textContent = unavailable ? keyAccessMessage()
        : refused ? (next.message || 'Credential refused.')
        : setting === 'github_repo' ? (next.repository || 'owner/name') : configured ? 'Saved in Dropbox' : 'None saved';
      const button = find<HTMLButtonElement>(select('edit', setting));
      button.textContent = configured ? 'Change' : 'Add'; button.disabled = store.role !== 'writer' || unavailable;
    }
    find('[data-fetched]').textContent = next.fetchedAt === null ? 'No file downloaded' :
      'Fetched ' + fetchedDate(next.fetchedAt) + ' · ' + next.countLabel +
      (next.unchangedSince === null ? '' : ' · Unchanged since ' + fetchedDate(next.unchangedSince));
    fetchButton.disabled = fetching || store.role !== 'writer' || !canAccessKeys() || !next.hasToken || !next.repository;
    if (!writing) feedback.textContent = fetching ? 'Fetching ratings…' : next.message ?? '';
  }
  fetchButton.onclick = async () => {
    if (fetchButton.disabled) return;
    fetching = true; fetchButton.disabled = true; feedback.textContent = 'Fetching ratings…';
    let failed = false;
    try { await job.service.refreshFile(true); }
    catch { failed = true; }
    finally {
      fetching = false;
      if (!closed) {
        await refresh();
        if (failed && !feedback.textContent) feedback.textContent = 'Could not fetch the ratings file. Try again.';
      }
    }
  };
  const roleChanged = () => { void refresh().catch(() => {}); };
  store.addEventListener('rolechange', roleChanged);
  store.addEventListener('providerkeyschange', roleChanged);
  return {ready:refresh(), refresh, dispose() {
    closed = true;
    store.removeEventListener('rolechange', roleChanged);
    store.removeEventListener('providerkeyschange', roleChanged);
    closePanel?.();
  }};
}
