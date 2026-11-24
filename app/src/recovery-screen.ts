import { listBackups, openBackup, type BackupGeneration } from './dropbox-backup.ts';
import type { DropboxApi } from './dropbox-api.ts';
import type { DropboxIdentity } from './dropbox-auth.ts';
import { unsyncedCount, type DropboxSync } from './dropbox-sync.ts';
import { restoreBackup, restoreFailure, restoreOutcomeLabel } from './dropbox-restore.ts';
import { applyLocalRecord, previewLocalRecord, readLocalRecord, type LocalPreview } from './local-restore.ts';
import { downloadLinks, releaseLinks } from './recovery-downloads.ts';
import { prepareExport } from './export-data.ts';
import { openPersonalDialog } from './personal-dialog.ts';
import { writeCsv } from './csv.ts';
import type { MergeTable } from './model.ts';
import type { DeviceSnapshot } from './storage.ts';
import type { Screen, ScreenContext } from './screen-context.ts';

export interface RecoveryActions {
  exclusive<T>(kind: 'restore', work: () => Promise<T>): Promise<T>;
  backupAccess(expected:DropboxIdentity): Promise<{ api: DropboxApi; engine: DropboxSync }>;
  erase(expectedRevision: bigint): Promise<void>;
  reload(): Promise<void>;
  readonly busy: boolean;
  changed: EventTarget;
  queueSync?(): void;
}
function identity(accountId:unknown, session:DeviceSnapshot['local']['dropboxSession'] | null) {
  return JSON.stringify([accountId, session?.accountId, session?.instanceId]);
}

export function mountRecoveryScreen(root: HTMLElement, ctx: ScreenContext, actions: RecoveryActions): Screen {
  const doc = root.ownerDocument, store = ctx.service.store;
  root.innerHTML = `<section class="recovery-screen"><h1>Backups and restore</h1>
    <p role="status" data-state></p><button type="button" data-refresh>Refresh backups</button>
    <div data-folders></div><div data-files></div>
    <section data-local hidden><h2>Restore local record</h2><p>Choose all four CSV files from the same export.</p>
    <label>Select the four CSV files <input type="file" multiple accept=".csv,text/csv"></label></section>
    <div data-local-preview></div><p tabindex="-1" role="status" data-result></p>
    </section>`;
  const one = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const listing = one('[data-folders]'), choices = one('[data-files]'), local = one('[data-local]'), result = one('[data-result]');
  const status = one('[data-state]'), reload = one<HTMLButtonElement>('[data-refresh]');
  const picker = one<HTMLInputElement>('input[type=file]'), previewBox = one('[data-local-preview]');
  const nodes = (tag: string, label: string) => { const el = doc.createElement(tag); el.textContent = label; return el; };
  const button = (label: string, click: () => void) => {
    const b = doc.createElement('button'); b.type = 'button'; b.textContent = label; b.onclick = click; return b;
  };
  type Access = Awaited<ReturnType<RecoveryActions['backupAccess']>>;
  let stateKey = '', remote = false, alive = true, version = 0, choiceId = 0, fileId = 0, active = false, refreshId = 0;
  let listingOwner:DropboxIdentity|undefined;
  let reader: AbortController | undefined;
  function startReading() {
    reader?.abort();
    reader = new AbortController();
    return reader.signal;
  }
  type Review = Pick<DeviceSnapshot,'revision'|'tables'>;
  let selected: { folder: string; files: ReadonlyMap<MergeTable, string>; access: Access; owner:DropboxIdentity; review?:Review } | undefined;
  let localPreview: LocalPreview | undefined, closeDialog: (() => void) | undefined;
  function showError(error: unknown) {
    if (alive) result.textContent = error instanceof Error && error.name === 'Error' && error.message.length < 180
      ? error.message : 'Could not finish. Review the current record and try again.';
  }
  function dropRemote() { choiceId++; selected = undefined; listing.replaceChildren(); choices.replaceChildren(); }
  const counts = (s: Pick<DeviceSnapshot,'tables'|'sync'>, t: MergeTable) => {
    const count = unsyncedCount(s, t);
    return count === null ? 'Unsynced changes unknown' : count + (count === 1 ? ' unsynced change' : ' unsynced changes');
  };
  function hold(title: string) {
    const panel = openPersonalDialog(root, title, () => result);
    panel.dialog.dataset.dropboxHold = '';
    panel.heading.setAttribute('role', 'status');
    panel.setSaving(true, ''); // The focused heading announces each restore stage.
    closeDialog = panel.close;
    return { message: (s: string) => {
      const text = title + ' · ' + s;
      if (panel.heading.textContent !== text) panel.heading.textContent = text;
    },
      close: () => { panel.close(); closeDialog = undefined; } };
  }

  async function runRestore(source: NonNullable<typeof selected>, tables: readonly MergeTable[]) {
    const review = source.review;
    if (!remote || active || actions.busy || source !== selected || !review || !tables.length) return;
    active = true;
    result.textContent = '';
    const panel = hold('Restoring ' + tables.map(t => t + '.csv').join(', '));
    try {
      await actions.exclusive('restore', async () => {
        const {accountId,session,revision} = await store.dropboxState();
        if (accountId !== source.owner.accountId || session?.accountId !== accountId || session?.instanceId !== source.owner.instanceId ||
            store.role !== 'writer') throw Error('The Dropbox sign-in changed. Review the backup again.');
        const chosen = new Map(tables.map(t => [t, source.files.get(t)!]));
        const reviewedLocal = new Map(tables.map(t => [t,writeCsv(t,review.tables[t])]));
        if (revision !== review.revision) {
          const latest = await store.dropboxRestorePreview(tables);
          if (tables.some(t => writeCsv(t,latest.tables[t]) !== reviewedLocal.get(t))) {
            result.textContent = ['The local record changed. Review the selection again.',
              ...tables.map(t => t + '.csv — ' + restoreOutcomeLabel.untouched)].join('\n');
            return;
          }
        }
        const restore = await restoreBackup(source.access.api, source.access.engine, chosen, {
          reviewedLocal,
          onSaved() { ctx.clearUndo(); actions.queueSync?.(); },
          onProgress: panel.message,
          onLastSave() {
            result.textContent = 'The selected files are saved on this device. Checking the Dropbox result…';
            panel.close();
          },
          current: () => alive,
        });
        if (!alive) return;
        const lines = [...restore.files].map(([t, outcome]) => t + '.csv — ' + restoreOutcomeLabel[outcome]);
        result.textContent = [restore.issue ?? 'Restore complete.', ...lines].join('\n');
        if (restore.compatibility) result.append(' ', button('Reload csvTV', () => { void actions.reload(); }));
      });
    } catch (error) { showError(error); }
    finally { active = false; panel.close(); if (alive) void refresh(); }
  }
  function updateRestoreButton() {
    const restore = choices.querySelector<HTMLButtonElement>('[data-restore]');
    if (restore) restore.disabled = active || actions.busy || !choices.querySelector('input:checked');
  }
  function renderChoices(s: Pick<DeviceSnapshot,'revision'|'tables'|'sync'>) {
    if (!selected) return;
    const source = selected;
    if (!choices.querySelector('fieldset')) {
      const fieldset = doc.createElement('fieldset');
      fieldset.append(nodes('legend', source.folder));
      for (const t of source.files.keys()) {
        const label = doc.createElement('label'), box = doc.createElement('input'), caption = doc.createElement('span');
        box.type = 'checkbox'; box.value = t; box.checked = true; caption.dataset.table = t;
        label.append(box, ' ', caption); fieldset.append(label);
      }
      const restore = button('Restore selected files', () => {
        const tables = [...fieldset.querySelectorAll<HTMLInputElement>('input:checked')].map(el => el.value as MergeTable);
        void runRestore(source, tables);
      });
      restore.dataset.restore = ''; fieldset.onchange = updateRestoreButton;
      if (source.files.size) choices.append(fieldset, restore);
      else choices.replaceChildren(nodes('p', 'This backup has no recoverable files.'));
    }
    for (const t of source.files.keys()) {
      const label = choices.querySelector<HTMLElement>('[data-table="' + t + '"]');
      if (label) label.textContent = t + '.csv · ' + counts(s, t);
    }
    source.review = {revision:s.revision,tables:s.tables};
    updateRestoreButton();
  }
  async function chooseFolder(generation: BackupGeneration, owner:DropboxIdentity, current:number) {
    if (!alive || current !== version || !remote) return;
    const id = ++choiceId;
    const signal = startReading();
    selected = undefined; choices.replaceChildren(); result.textContent = ''; status.textContent = 'Reading backup files…';
    try {
      const access = await actions.backupAccess(owner);
      signal.throwIfAborted();
      const files = await openBackup(access.api, generation.folder, signal);
      signal.throwIfAborted();
      const snap = await store.dropboxRestorePreview([...files.keys()],signal);
      if (!alive || current !== version || id !== choiceId || stateKey !== identity(snap.local.syncAccountId,snap.local.dropboxSession)) return;
      selected = { folder: generation.folder, files, access, owner };
      status.textContent = 'Choose a backup to review its files.';
      renderChoices(snap);
    } catch (error) {
      if (alive && current === version && id === choiceId) {
        dropRemote(); status.textContent = restoreFailure(error,'Could not read the Dropbox backup.','Check the connection and refresh.');
      }
    }
  }
  async function loadFolders(current: number,owner:DropboxIdentity) {
    const signal = startReading();
    dropRemote(); status.textContent = 'Checking Dropbox backups…';
    try {
      const { api } = await actions.backupAccess(owner);
      signal.throwIfAborted();
      const generations = await listBackups(api, signal);
      signal.throwIfAborted();
      const {accountId,session} = await store.dropboxState();
      if (!alive || version !== current || stateKey !== identity(accountId,session)) return;
      for (const verified of [true, false]) {
        const group = generations.filter(g => (g.status === 'verified') === verified);
        if (!group.length) continue;
        listing.append(nodes('h2', verified ? 'Verified backups' : 'Legacy or unverified folders'));
        for (const gen of group) {
          const note = { verified: '', unverified: ' · Unverified manifest', incomplete: ' · Incomplete attempt', legacy: ' · Unmarked folder' };
          const select = button(gen.folder + note[gen.status], () => void chooseFolder(gen,owner,current));
          select.dataset.folder = gen.folder; listing.append(select);
        }
      }
      status.textContent = generations.length ? 'Choose a backup to review its files.' : 'No Dropbox backups yet.';
    } catch (error) {
      if (alive && version === current) {
        dropRemote(); status.textContent = restoreFailure(error,'Could not list Dropbox backups.','Check the connection and refresh.');
      }
    }
  }
  async function showLocal(record: Awaited<ReturnType<typeof readLocalRecord>>, current: number) {
    const snap = await store.snapshot(), preview = previewLocalRecord(snap, record);
    if (!alive || current !== fileId) return;
    releaseLinks(previewBox); previewBox.replaceChildren(); localPreview = preview;
    previewBox.append(nodes('h3', 'Local restore preview'));
    for (const c of preview.counts) previewBox.append(nodes('p',
      c.table + '.csv · ' + c.adds + ' additions, ' + c.replacements + ' replacements, ' + c.removals + ' removals'));
    if (Object.values(record).every(rows => !rows.length)) previewBox.append(nodes('p', 'This will empty all four record tables.'));
    const cancel = button('Cancel', () => {
      fileId++; localPreview = undefined; picker.value = ''; releaseLinks(previewBox); previewBox.replaceChildren(); picker.focus();
    });
    const stillSelected = () => alive && current === fileId && preview === localPreview;
    const accept = button('Restore local record', () => void (async () => {
      if (active || actions.busy || !stillSelected()) return;
      try {
        await actions.exclusive('restore', async () => {
          const before = await store.snapshot();
          if (!stillSelected()) return;
          if (before.revision !== preview.revision) {
            result.textContent = 'The record changed. Review the updated preview.';
            await showLocal(record, ++fileId); return;
          }
          await applyLocalRecord(store, preview, stillSelected); ctx.clearUndo();
          if (!stillSelected()) return;
          fileId++; localPreview = undefined; releaseLinks(previewBox); previewBox.replaceChildren(); picker.value = '';
          result.textContent = 'All four record files restored.'; result.focus();
        });
      } catch (error) { if (stillSelected()) showError(error); }
    })());
    accept.dataset.applyLocal = '';
    const buttons = doc.createElement('div');
    buttons.className = 'actions';
    try {
      const backup = await prepareExport(ctx.service, 'record');
      if (!stillSelected()) return;
      accept.disabled = actions.busy || active || store.role !== 'writer';
      const downloads = downloadLinks(doc, backup.files);
      buttons.append(cancel, accept);
      previewBox.append(nodes('p', 'Download your current record before restoring.'), downloads, buttons);
    } catch {
      if (!stillSelected()) return;
      const retry = button('Retry downloads', () => {
        if (!stillSelected()) return;
        const next = ++fileId;
        void showLocal(record, next).catch(error => { if (alive && next === fileId) showError(error); });
      });
      buttons.append(retry, cancel);
      previewBox.append(nodes('p', 'Could not prepare the four backup downloads.'), buttons);
      retry.focus({preventScroll:true});
    }
  }
  picker.onchange = async () => {
    const current = ++fileId;
    releaseLinks(previewBox); previewBox.replaceChildren(); localPreview = undefined; result.textContent = '';
    const files = [...picker.files ?? []];
    picker.value = '';
    try { await showLocal(await readLocalRecord(files), current); }
    catch (error) { if (current === fileId) showError(error); }
  };

  async function refresh() {
    const reading = ++refreshId;
    const source = selected, {accountId,session,revision} = await store.dropboxState();
    if (!alive || reading !== refreshId) return;
    const writer = store.role === 'writer', linked = accountId != null;
    const signedIn = !!session && Number.isFinite(session.signInDeadline) && ctx.service.environment.now() < session.signInDeadline;
    const key = identity(accountId,session), canRead = writer && signedIn && linked && accountId === session.accountId && ctx.service.environment.online();
    const changed = key !== stateKey || canRead !== remote;
    stateKey = key; remote = canRead;
    listingOwner = canRead ? {accountId:session.accountId,instanceId:session.instanceId} : undefined;
    const canLocal = writer && !linked && !session;
    local.hidden = !canLocal; picker.disabled = actions.busy;
    reload.hidden = !canRead; reload.disabled = actions.busy || active;
    if (!canLocal) { fileId++; localPreview = undefined; releaseLinks(previewBox); previewBox.replaceChildren(); }
    const apply = previewBox.querySelector<HTMLButtonElement>('[data-apply-local]');
    if (apply) apply.disabled = !canLocal || actions.busy || active;
    if (changed) { version++; reader?.abort(); dropRemote(); }
    if (!canRead) status.textContent = !writer ? 'Open this screen in the writable tab to read backups.' :
      !linked ? 'Local record recovery is available on this device.' :
      !signedIn ? 'Sign in to Dropbox to list your backups.' : accountId !== session.accountId ?
      'Resolve the Dropbox account choice to read backups.' : 'Check your connection and Dropbox sign-in to read backups.';
    else if (changed && listingOwner) await loadFolders(version,listingOwner);
    else if (source && selected === source) {
      if (source.review?.revision === revision) { updateRestoreButton(); return; }
      const signal = reader?.signal;
      try {
        const snap = await store.dropboxRestorePreview([...source.files.keys()],signal);
        if (alive && reading === refreshId && selected === source && stateKey === identity(snap.local.syncAccountId,snap.local.dropboxSession)) renderChoices(snap);
      } catch (error) { if (alive && !signal?.aborted) throw error; }
    }
  }
  reload.onclick = () => { if (listingOwner) void loadFolders(++version,listingOwner); };
  const change = () => { if (alive) void refresh().catch(showError); };
  actions.changed.addEventListener('change', change);
  return { ready: refresh(), refresh, dispose() {
    alive = false; version++; fileId++; choiceId++; reader?.abort(); closeDialog?.(); releaseLinks(previewBox);
    actions.changed.removeEventListener('change', change);
  } };
}
