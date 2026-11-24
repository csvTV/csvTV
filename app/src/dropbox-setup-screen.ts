import type { DropboxController } from './dropbox-controller.ts';
import { mountDropboxSettings } from './dropbox-settings.ts';
import { mountOfflineSettings, type OfflineShell } from './offline.ts';
import type { Screen, ScreenContext } from './screen-context.ts';

/** Keep the original route while an unlinked device connects its Dropbox account. */
export function mountDropboxSetup(root: HTMLElement, ctx: ScreenContext, cloud: DropboxController, offline?: OfflineShell): Screen {
  root.innerHTML = '<h1>Connect Dropbox</h1><p class="key-storage-note">Sign in to link this device to your watch record. ' +
    'Once linked, you can use your Library and record ratings offline.</p><div id="settings-services"></div>' +
    '<section class="group" data-legacy hidden><h2>Existing record on this device</h2>' +
    '<p>You can download your four record files before linking this browser to Dropbox.</p>' +
    '<button type="button" data-export>Prepare downloads</button><div class="recovery-downloads"></div></section>' +
    '<p role="status" data-result></p>';
  const dropbox = mountDropboxSettings(root, ctx, cloud, true);
  const disposeOffline = offline && mountOfflineSettings(root, offline);
  const legacy = root.querySelector<HTMLElement>('[data-legacy]')!;
  const prepare = root.querySelector<HTMLButtonElement>('[data-export]')!;
  const downloads = root.querySelector<HTMLElement>('.recovery-downloads')!;
  const result = root.querySelector<HTMLElement>('[data-result]')!;
  const win = root.ownerDocument.defaultView!, urls: string[] = [];
  let alive = true;
  function clearFiles() {
    for (const url of urls.splice(0)) win.URL.revokeObjectURL(url);
    downloads.replaceChildren();
  }
  async function refresh() {
    dropbox.refresh();
    const hasRecord = await ctx.service.store.hasRecordRows();
    if (alive) legacy.hidden = !hasRecord;
  }
  prepare.onclick = async () => {
    prepare.disabled = true;
    clearFiles();
    try {
      const now = ctx.service.environment.now();
      const [snapshot,{recordExportFiles}] = await Promise.all([
        ctx.service.store.exportSnapshot(false, now), import('./export-data.ts'),
      ]);
      if (!alive) return;
      for (const file of recordExportFiles(snapshot, now)) {
        const link = root.ownerDocument.createElement('a');
        link.className = 'button'; link.download = link.textContent = file.name;
        link.href = win.URL.createObjectURL(file); urls.push(link.href); downloads.append(link);
      }
      result.textContent = '';
      downloads.querySelector('a')?.focus();
    } catch {
      if (alive) { clearFiles(); result.textContent = 'Could not prepare the downloads. Try again.'; }
    } finally { if (alive) prepare.disabled = false; }
  };
  return {ready:refresh(), refresh, dispose() {
    alive = false; clearFiles(); disposeOffline?.(); dropbox.dispose();
  }};
}
