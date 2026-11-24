import { restorableTables } from './dropbox-backup.ts';
import { unsyncedCount } from './dropbox-sync.ts';
import { prepareExport } from './export-data.ts';
import { openPersonalDialog } from './personal-dialog.ts';
import { downloadLinks, releaseLinks } from './recovery-downloads.ts';
import type { RecoveryActions } from './recovery-screen.ts';
import type { ScreenContext } from './screen-context.ts';

export function mountClearDevice(root: HTMLElement, ctx: ScreenContext, actions: RecoveryActions) {
  const doc = root.ownerDocument, store = ctx.service.store;
  const button = (label: string, click: () => void) => {
    const node = doc.createElement('button'); node.type = 'button'; node.textContent = label; node.onclick = click; return node;
  };
  const nodes = (tag: string, label: string) => { const node = doc.createElement(tag); node.textContent = label; return node; };
  const erase = doc.createElement('button'), result = doc.createElement('p');
  erase.type = 'button'; erase.dataset.clearDevice = ''; erase.textContent = 'Clear this device…';
  result.setAttribute('role','status'); result.dataset.deviceResult = '';
  const controls = root.querySelector('.offline-actions') ?? root;
  controls.append(erase);
  root.append(result);
  let erasePending = false, alive = true, closeDialog: (()=>void)|undefined;
  const refresh = () => { erase.disabled = erasePending || store.role !== 'writer' || actions.busy; };
  const showError = (error: unknown) => { if (alive) result.textContent = error instanceof Error && error.name === 'Error' &&
    error.message.length < 180 ? error.message : 'Could not clear this device. Review the record and try again.'; };
  erase.onclick = async () => {
    if (actions.busy || erasePending || erase.disabled) return;
    erase.disabled = erasePending = true;
    let ownDialog: ReturnType<typeof openPersonalDialog> | undefined;
    try {
      const s = await store.snapshot(), changes = restorableTables.map(t => unsyncedCount(s, t));
      if (!alive) return;
      const panel = openPersonalDialog(root, 'Clear this device?', () => {
        if (ownDialog) releaseLinks(ownDialog.body);
        if (closeDialog === ownDialog?.close) closeDialog = undefined;
        erasePending = false;
        erase.disabled = store.role !== 'writer' || actions.busy;
        return alive && !erase.disabled ? erase : null;
      });
      ownDialog = panel;
      closeDialog = panel.close;
      panel.body.className = 'clear-device-review';
      const total = changes.reduce<number>((n, v) => n + (v ?? 0), 0);
      panel.body.append(nodes('p', (changes.includes(null) ? 'Some unsynced changes cannot be counted.' :
        total + (total === 1 ? ' unsynced change.' : ' unsynced changes.')) + ' Clearing removes this device’s record, settings and sign-in. Dropbox files stay in your account. On a shared browser, also sign out of dropbox.com.'));
      const pending = Object.values(s.sync).some(file => file?.pending);
      if (pending) panel.body.append(nodes('p', 'An upload with an unknown outcome may have arrived or may still arrive in Dropbox.'));
      if (!(ctx.service.environment.now() < (s.local.dropboxSession?.signInDeadline ?? 0)) ||
          !ctx.service.environment.online() || pending || total > 0 || changes.includes(null)) {
        const backup = await prepareExport(ctx.service, 'record');
        if (!alive || !panel.dialog.open) return;
        panel.body.append(nodes('p', 'Download the current record before erasing.'), downloadLinks(doc, backup.files));
      }
      const confirm = button('Clear this device', () => void (async () => {
        if (actions.busy) return;
        panel.setSaving(true);
        try { await actions.erase(s.revision); ctx.clearUndo(); result.textContent = 'Device data erased.'; }
        catch (error) { showError(error); }
        finally { panel.close(); if (alive) void refresh(); }
      })());
      confirm.className = 'destructive';
      const buttons = doc.createElement('div');
      buttons.className = 'actions';
      buttons.append(button('Cancel', panel.close), confirm);
      panel.body.append(buttons);
    } catch (error) {
      if (!alive || (ownDialog && !ownDialog.dialog.open)) return;
      if (ownDialog) ownDialog.close();
      else { erasePending = false; erase.disabled = store.role !== 'writer' || actions.busy; }
      showError(error);
    }
  };

  actions.changed.addEventListener('change',refresh);
  refresh();
  return {refresh, dispose() { alive = false; closeDialog?.(); actions.changed.removeEventListener('change',refresh); }};
}
