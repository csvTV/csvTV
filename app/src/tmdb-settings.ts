import { TmdbError, type TmdbResource } from './tmdb-client.ts';
import type { MetadataView, TmdbService } from './tmdb-service.ts';

type ViewState = MetadataView<TmdbResource['kind']>['status'] | 'loading';

/** Show the number excluded from a metadata-dependent view without hiding the rest of the record. */
export function renderOmittedShows(root: HTMLElement, coverage: { unfetched: readonly number[]; missing: readonly number[] }): void {
  const count = new Set([...coverage.unfetched, ...coverage.missing]).size;
  root.textContent = count ? count === 1 ? '1 show omitted because its title data is unavailable.'
    : count + ' shows omitted because their title data is unavailable.' : '';
}

export function mountFirstUseCard(root: HTMLElement, actions: {
  onKey: () => void; onDropbox?: () => void; onTraktImport?: () => void; onAniListImport?: () => void; onDismiss: () => void;
}) {
  const doc = root.ownerDocument;
  const card = doc.createElement('section');
  card.className = 'about setup-card';
  const heading = doc.createElement('h2');
  heading.textContent = 'Set up your watch record';
  card.append(heading);
  const controls = doc.createElement('div');
  controls.className = 'actions';
  function addLink(label: string, href: string, open: () => void) {
    const link = doc.createElement('a');
    link.className = 'button';
    link.href = href;
    link.textContent = label;
    link.onclick = event => {
      if (event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      open();
    };
    controls.append(link);
  }
  function addButton(label: string, action: () => void) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.onclick = action;
    controls.append(button);
    return button;
  }
  addLink('TMDB key', '#/settings', actions.onKey);
  if (actions.onTraktImport) addLink('Import from Trakt', '#/trakt-import', actions.onTraktImport);
  if (actions.onAniListImport) addLink('Import from AniList', '#/anilist-import', actions.onAniListImport);
  const signIn = actions.onDropbox && addButton('Sign in to Dropbox', actions.onDropbox);
  if (signIn) signIn.dataset.setupDropbox = '';
  const dismiss = addButton('Dismiss', actions.onDismiss);
  card.append(controls);
  return (visible: boolean, options: {writable: boolean; showSignIn: boolean; canSignIn: boolean}) => {
    if (!visible) { card.remove(); return; }
    if (card.parentElement !== root) root.append(card);
    if (signIn) {
      signIn.hidden = !options.writable || !options.showSignIn;
      signIn.disabled = !options.canSignIn || signIn.hidden;
    }
    dismiss.disabled = !options.writable;
  };
}

export function renderTmdbState(root: HTMLElement, status: ViewState, actions: {
  onSettings?: () => void; onRetry?: () => void; emptyMessage?: string; unavailableMessage?: string; canAccessKeys?: () => boolean;
} = {}): void {
  root.replaceChildren();
  if (status === 'ready' || status === 'cached') return;
  const doc = root.ownerDocument;
  const view = doc.createElement('div');
  view.className = 'tmdb-state';
  const report = doc.createElement('span');
  report.setAttribute('role', 'status');
  const labels: Record<Exclude<ViewState, 'ready' | 'cached'>, string> = {
    loading: 'Loading title data…', empty: actions.emptyMessage ?? 'No results.',
    'missing-key': actions.canAccessKeys?.() === false ? 'Connect to Dropbox to load your TMDB key.' : 'A TMDB key is needed.',
    refused: 'TMDB refused the key.',
    'read-only': 'This tab is read-only.',
    'not-found': 'Not on TMDB', offline: 'Cannot reach TMDB.', unavailable: actions.unavailableMessage ?? 'Cannot reach TMDB.',
  };
  report.textContent = labels[status];
  view.append(report);
  if (status === 'loading') {
    report.className = 'visually-hidden';
    const bars = doc.createElement('div');
    bars.className = 'skeleton';
    bars.setAttribute('aria-hidden', 'true');
    bars.append(doc.createElement('i'), doc.createElement('i'), doc.createElement('i'));
    view.append(bars);
  }
  const needsKey = status === 'missing-key' || status === 'refused';
  const action = needsKey ? actions.onSettings : (status === 'offline' || status === 'unavailable') ? actions.onRetry : undefined;
  if (action) {
    const button = doc.createElement('button');
    button.textContent = needsKey ? 'Settings' : 'Try again';
    button.addEventListener('click', action);
    view.append(button);
  }
  root.append(view);
}

const layout = `<div class="shell">
  <aside class="rail"><div class="brand">csvTV</div><nav aria-label="Settings sections">
    <a href="#settings-services">Services</a></nav></aside>
  <main><h1>Settings</h1><p class="notice" data-role-notice role="status"></p>
    <p class="key-storage-note">API keys and the GitHub token are plain text in Dropbox’s <code>settings.csv</code>.</p>
    <section id="settings-services" aria-label="Services">
      <div class="key-row">
        <span class="key-symbol" aria-hidden="true"></span><div class="key-copy"><strong id="tmdb-key-label" tabindex="-1">TMDB key</strong>
        <p>Required for Trakt and AniList imports.</p><p data-key-status role="status">Checking key…</p></div>
        <button class="help" data-help aria-label="How to get a TMDB key"><span aria-hidden="true">?</span></button>
        <button data-edit disabled>Add key</button></div>
    </section>
    <details class="source-credits" data-source-credits>
      <summary>Credits</summary><img src="./tmdb-logo.svg" alt="TMDB" width="108" height="14">
      <p>This product uses the TMDB API but is not endorsed or certified by TMDB.</p>
    </details>
  </main></div><dialog aria-labelledby="sheet-title"><div class="sheet" data-key-panel></div></dialog>`;

const help = `<h2 id="sheet-title" tabindex="-1">Get a TMDB key</h2>
  <p class="secondary">Free for non-commercial use. TMDB recommends registering on a computer.</p>
  <ol class="steps"><li>Create a free TMDB account.
    <a href="https://www.themoviedb.org/signup" target="_blank" rel="noopener noreferrer">themoviedb.org/signup ↗</a></li>
    <li>Request a key in API settings.
    <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noopener noreferrer">themoviedb.org/settings/api ↗</a></li>
    <li>Accept the terms.</li>
    <li>Enter your app details.</li>
    <li>Paste “API Read Access Token”.</li></ol>
  <div class="actions help-actions"><button data-close>Done</button>
    <a class="button primary" href="https://www.themoviedb.org/settings/api" target="_blank" rel="noopener noreferrer">Open TMDB ↗</a></div>`;

const editor = `<h2 id="sheet-title" tabindex="-1">TMDB key</h2>
  <form autocomplete="off"><label for="tmdb-input">API Read Access Token</label>
    <input type="password" id="tmdb-input" autocomplete="off" spellcheck="false" autocapitalize="none" aria-describedby="tmdb-hint">
    <p id="tmdb-hint" class="hint"></p><p class="feedback" data-feedback role="status"></p>
    <div class="actions"><button type="button" data-close>Cancel</button><button class="primary" type="submit">Save</button></div>
  </form>`;

const removal = `<h2 id="sheet-title" tabindex="-1">Remove the TMDB key?</h2>
  <p class="secondary">Your watch record stays on this device. Add a key to fetch title data again.</p>
  <p class="feedback" data-feedback role="status"></p>
  <div class="actions"><button data-close>Cancel</button><button class="destructive" data-remove>Remove key</button></div>`;

interface SettingsPort extends Pick<TmdbService, 'keyStatus' | 'cancelKeyCheck' | 'saveKey' | 'removeKey'> {
  store: Pick<TmdbService['store'], 'role' | 'readOnlyReason' | 'addEventListener' | 'removeEventListener'>;
}

export function mountTmdbSettings(root: HTMLElement, service: SettingsPort, embedded = false, canAccessKeys = () => true,
    keyAccessMessage = () => 'Connect to Dropbox to access this key.') {
  root.innerHTML = layout;
  if (embedded) root.replaceChildren(...root.querySelector('main')!.children, ...root.querySelectorAll('dialog'));
  const doc = root.ownerDocument;
  const dialog = root.querySelector('dialog')!;
  const sheet = dialog.querySelector<HTMLElement>('[data-key-panel]')!;
  const edit = root.querySelector<HTMLButtonElement>('[data-edit]')!;
  const helpButton = root.querySelector<HTMLButtonElement>('[data-help]')!;
  const keyReport = root.querySelector<HTMLElement>('[data-key-status]')!;
  const roleReport = root.querySelector<HTMLElement>('[data-role-notice]')!;
  roleReport.hidden = embedded;
  const events = new AbortController();
  const listener = { signal: events.signal };
  let sequence = 0, operation = 0;
  let state: Awaited<ReturnType<SettingsPort['keyStatus']>> | undefined;
  let origin: HTMLElement | undefined;
  let committingRemoval = false;
  let mode: 'help' | 'edit' | 'remove' | null = null;

  async function refresh() {
    const request = ++sequence;
    const role = service.store.role;
    edit.disabled = role !== 'writer' || !state || !canAccessKeys();
    roleReport.textContent = role === 'reader' ? service.store.readOnlyReason ?? 'Another tab is using csvTV. This tab is read-only.'
      : role === 'obsolete' || role === 'closed' ? 'Reload csvTV to continue with this record.' : '';
    if ((role !== 'writer' || !canAccessKeys()) && (mode === 'edit' || mode === 'remove')) close();
    try {
      const next = await service.keyStatus();
      if (request !== sequence || events.signal.aborted) return;
      state = next;
      keyReport.textContent = !canAccessKeys() ? keyAccessMessage() : next.status === 'ready' ? 'Saved in Dropbox'
        : next.status === 'missing-key' ? 'No key saved' : 'Key refused. ' + (next.message ?? 'Check the saved token.');
      edit.textContent = next.status === 'missing-key' ? 'Add key' : 'Change';
      edit.disabled = service.store.role !== 'writer' || !canAccessKeys();
    } catch {
      if (request !== sequence || events.signal.aborted) return;
      keyReport.textContent = 'Could not read the saved key.';
      edit.disabled = true;
    }
  }
  function close() {
    operation++;
    service.cancelKeyCheck();
    mode = null;
    committingRemoval = false;
    const input = sheet.querySelector('input');
    if (input) input.value = '';
    if (dialog.open) dialog.close();
    sheet.replaceChildren();
    if (origin && !origin.matches(':disabled')) origin.focus();
    else helpButton.focus();
  }
  function display(content: string, nextMode: typeof mode) {
    mode = nextMode;
    sheet.innerHTML = content;
    if (!dialog.open) dialog.showModal();
    sheet.querySelector<HTMLButtonElement>('[data-close]')!.addEventListener('click', close);
    sheet.querySelector<HTMLElement>('#sheet-title')!.focus();
  }
  function confirmRemoval(generation: bigint) {
    display(removal, 'remove');
    sheet.querySelector<HTMLButtonElement>('[data-remove]')!.onclick = async () => {
      if (!canAccessKeys() || service.store.role !== 'writer') { close(); return; }
      const attempt = ++operation;
      const feedback = sheet.querySelector<HTMLElement>('[data-feedback]')!;
      committingRemoval = true;
      sheet.querySelector<HTMLElement>('#sheet-title')!.focus();
      for (const button of sheet.querySelectorAll('button')) button.disabled = true;
      feedback.textContent = 'Removing key…';
      try {
        await service.removeKey(generation);
        if (attempt !== operation) return;
        close();
        await refresh();
      } catch {
        if (attempt !== operation) return;
        committingRemoval = false;
        feedback.textContent = 'Could not remove this key. Close and check its current status.';
        const done = sheet.querySelector<HTMLButtonElement>('[data-close]')!;
        done.disabled = false;
        done.textContent = 'Close';
        done.focus();
      }
    };
  }
  function editKey() {
    if (!state || service.store.role !== 'writer' || !canAccessKeys()) return;
    const original = state;
    origin = edit;
    display(editor, 'edit');
    const field = sheet.querySelector('input')!;
    const save = sheet.querySelector<HTMLButtonElement>('[type=submit]')!;
    const feedback = sheet.querySelector<HTMLElement>('[data-feedback]')!;
    sheet.querySelector<HTMLElement>('#tmdb-hint')!.textContent = original.status === 'missing-key'
      ? 'Copy your token from the API page in your TMDB account.' : 'Paste a new token, or leave this empty to remove the saved key.';
    field.focus();
    field.oninput = () => {
      operation++;
      service.cancelKeyCheck();
      feedback.textContent = '';
      save.disabled = false;
      save.textContent = 'Save';
      field.removeAttribute('aria-invalid');
    };
    sheet.querySelector('form')!.onsubmit = async event => {
      event.preventDefault();
      if (save.disabled) return;
      if (!canAccessKeys() || service.store.role !== 'writer') { close(); return; }
      if (!field.value) {
        if (original.status !== 'missing-key') confirmRemoval(original.generation);
        else {
          feedback.textContent = 'Enter the TMDB API Read Access Token.';
          field.setAttribute('aria-invalid', 'true');
          field.focus();
        }
        return;
      }
      const attempt = ++operation;
      save.disabled = true;
      field.focus();
      feedback.textContent = 'Checking key…';
      try {
        await service.saveKey(field.value);
        if (attempt !== operation) return;
        close();
        await refresh();
      } catch (error) {
        if (attempt !== operation) return;
        save.disabled = false;
        const refused = error instanceof TmdbError && error.kind === 'refused';
        const limited = error instanceof TmdbError && error.kind === 'throttled';
        feedback.textContent = refused ? error.message : limited ? 'TMDB is limiting requests. Try again later.'
          : error instanceof TmdbError && error.kind !== 'superseded' ? 'TMDB could not be reached.'
          : 'The key was not saved. Try again.';
        field.setAttribute('aria-invalid', String(refused));
        save.textContent = refused ? 'Save' : 'Try again';
      }
    };
  }
  helpButton.addEventListener('click', () => { origin = helpButton; display(help, 'help'); }, listener);
  edit.addEventListener('click', editKey, listener);
  dialog.addEventListener('cancel', event => { event.preventDefault(); if (!committingRemoval) close(); }, listener);
  dialog.addEventListener('click', event => { if (mode === 'help' && event.target === dialog) close(); }, listener);
  // Keep Tab on the panel at both ends even in browsers that cycle through their chrome.
  dialog.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const controls = [...dialog.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled])')]
      .filter(control => !control.closest('[hidden]'));
    const first = controls[0], last = controls[controls.length - 1];
    if (!first) { event.preventDefault(); return; }
    if (event.shiftKey && (doc.activeElement === first || doc.activeElement === sheet.querySelector('h2'))) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && doc.activeElement === last) {
      event.preventDefault(); first.focus();
    }
  }, listener);
  for (const event of ['rolechange', 'recordchange', 'tmdbstatechange', 'providerkeyschange']) service.store.addEventListener(event, refresh, listener);
  const ready = refresh();
  return { ready, refresh, dispose(keepLayout = false) {
    events.abort();
    if (dialog.open) close();
    if (!keepLayout) root.replaceChildren();
  } };
}
