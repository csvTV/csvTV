import type { DropboxController } from './dropbox-controller.ts';
import { dropboxRedirectUri } from './dropbox-return.ts';
import { resetLabels, type ResetScope } from './dropbox-reset-options.ts';
import { openPersonalDialog } from './personal-dialog.ts';
import type { ScreenContext } from './screen-context.ts';
import { reviewList } from './review-list.ts';

const registrationKey = 'csvTV-public-dropbox-app-key';

export function mountDropboxSettings(root: HTMLElement, ctx: ScreenContext, cloud: DropboxController, setupOnly = false) {
  const doc = root.ownerDocument, win = doc.defaultView!;
  const group = doc.createElement('section');
  group.className = 'key-row dropbox-settings';
  group.setAttribute('aria-labelledby', 'dropbox-label');
  group.innerHTML = '<div class="dropbox-key-heading">' +
    '<div class="key-copy"><strong id="dropbox-label" tabindex="-1">Dropbox</strong><span class="dropbox-required">Required</span>' +
    '<span data-cloud-reason role="status"></span></div>' +
    '<button type="button" class="help" data-dropbox-help aria-label="How to get a Dropbox app key"><span>?</span></button>' +
    '<button type="button" data-edit-client>Add app key</button></div>' +
    '<form hidden><label>Dropbox public app key <input name="appKey" required maxlength="100" autocomplete="off" ' +
    'autocapitalize="none" spellcheck="false" pattern="[A-Za-z0-9_\\-]+"></label>' +
    '<div class="actions"><button type="submit">Save app key</button><button type="button" data-cancel-key>Cancel</button></div></form>' +
    '<div class="dropbox-actions"><div class="actions" data-account-actions role="group" aria-label="Dropbox account">' +
    '<button type="button" class="primary" data-sign-in>Sign in to Dropbox</button><button type="button" data-sync>Sync now</button>' +
    '<button type="button" data-backup>Back up now</button><button type="button" data-sign-out>Sign out</button></div>' +
    '<div class="actions" data-file-actions role="group" aria-label="Watch record files">' +
    '<a class="button" href="#/hand-merge">Merge</a><a class="button" href="#/recovery">Restore</a>' +
    '<button type="button" data-clear-dropbox>Clear Dropbox…</button></div></div>' +
    '<p data-dropbox-feedback role="status"></p>' +
    '<div data-sync-notices></div>';
  root.querySelector('#settings-services')!.prepend(group);
  const one = <T extends HTMLElement>(selector: string) => group.querySelector<T>(selector)!;
  one('[data-file-actions]').hidden = setupOnly;
  const form = one<HTMLFormElement>('form'), field = one<HTMLInputElement>('input');
  const edit = one<HTMLButtonElement>('[data-edit-client]'), cancel = one<HTMLButtonElement>('[data-cancel-key]');
  const help = one<HTMLButtonElement>('[data-dropbox-help]'), backup = one<HTMLButtonElement>('[data-backup]');
  const feedback = one('[data-dropbox-feedback]');
  const status = one('[data-cloud-reason]');
  const siteKey = doc.querySelector<HTMLMetaElement>('meta[name="dropbox-app-key"]')?.content.trim();
  let editing: string | undefined;
  let helpSheet: ReturnType<typeof openPersonalDialog> | undefined;
  let clearSheet: ReturnType<typeof openPersonalDialog> | undefined;
  const lifetime = new AbortController();
  let saving = false, closed = false;
  let reportRows:string[] = [];
  let reportList:ReturnType<typeof reviewList>|undefined;
  let displayed:{source:string[];length:number;status:string;feedback:string}|undefined;

  function drawNotices(status:string, feedback:string) {
    const source = cloud.notices;
    if (displayed?.source === source && displayed.length === source.length && displayed.status === status && displayed.feedback === feedback) return;
    displayed = {source,length:source.length,status,feedback};
    const host = one('[data-sync-notices]');
    reportRows = source.filter(message => message !== status && message !== feedback);
    // A background sync empties the old report before its new notices arrive.
    // Keep its keyboard control in place while replacing the rows.
    const focused = host.contains(doc.activeElement);
    const updatingFocusedList = focused && reportList && cloud.operation === 'sync' && cloud.signedIn && !cloud.mismatch;
    if (reportRows.length > 1 || updatingFocusedList) {
      host.hidden = false;
      if (reportList) reportList.refreshRows(reportRows.length);
      else {
        reportList = reviewList(doc,'Last sync notices',reportRows.length,i => reportRows[i]);
        host.replaceChildren(reportList.details);
      }
    } else {
      if (focused) one('#dropbox-label').focus({preventScroll:true});
      reportList = undefined;
      host.textContent = reportRows[0] ?? '';
      host.hidden = !reportRows.length;
    }
  }

  function canEdit(key: string) {
    return ctx.service.store.role === 'writer' && !cloud.signedIn &&
      (cloud.registrationUnknown || (!siteKey && (!cloud.linked || !key)));
  }
  function finishEdit() {
    editing = undefined;
    form.reset();
  }
  function focusKeyControl() {
    (edit.hidden || edit.disabled ? one('#dropbox-label') : edit).focus();
  }
  help.onclick = () => {
    helpSheet = openPersonalDialog(group, cloud.registrationUnknown ? 'Find the original Dropbox app key' :
      siteKey ? 'Dropbox sign-in' : 'Dropbox app key', () => help);
    helpSheet.body.innerHTML = cloud.registrationUnknown
      ? '<p>In the <a href="https://www.dropbox.com/developers/apps" target="_blank" rel="noopener noreferrer">Dropbox App Console</a>, ' +
        'open the app that owns your existing csvTV folder. Copy its App key from Settings. If someone else hosts csvTV, ask them for the original key.</p>'
      : siteKey
      ? '<p>Sign in with the Dropbox account you want to use. csvTV uses its app folder in that account to sync and back up your watch record.</p>'
      : '<p>Open the <a href="https://www.dropbox.com/developers/apps" target="_blank" rel="noopener noreferrer">Dropbox App Console</a> ' +
      'and create an app with App folder access. Under Permissions enable files.metadata.read, files.content.read and files.content.write, then save. Under Settings, ' +
      'enable Allow public clients. Copy the address shown below into Redirect URIs, then add it. Copy the App key from Dropbox and save it in csvTV.</p>' +
      '<p><strong>Redirect URI for this site</strong><br><code></code></p>';
    const address = helpSheet.body.querySelector('code');
    if (address) address.textContent = dropboxRedirectUri(win.location);
    const done = doc.createElement('button');
    done.type = 'button'; done.textContent = 'Done'; done.onclick = helpSheet.close;
    const actions = doc.createElement('div');
    actions.className = 'actions help-actions';
    actions.append(done);
    helpSheet.body.append(actions);
  };
  edit.onclick = () => {
    const key = cloud.auth.appKey;
    if (!canEdit(key) || cloud.busy) return;
    editing = key;
    feedback.textContent = '';
    field.value = key;
    refresh();
    field.focus();
  };
  cancel.onclick = () => {
    finishEdit();
    refresh();
    focusKeyControl();
  };
  form.onkeydown = event => {
    if (event.key === 'Escape' && !saving) { event.preventDefault(); cancel.click(); }
  };
  async function saveKey() {
    const before = editing, value = field.value.trim();
    if (before === undefined || saving || !canEdit(before) || cloud.busy || !form.reportValidity()) return;
    saving = true;
    refresh();
    let storageBlocked = false;
    try {
      const saved = await ctx.service.store.saveDropboxRegistration(() => {
        if (closed || before !== editing || before !== cloud.auth.appKey || !canEdit(before) || cloud.busy) return false;
        try { win.localStorage.setItem(registrationKey, value); }
        catch { storageBlocked = true; return false; }
        return true;
      });
      if (closed) return;
      if (storageBlocked) throw Error('This browser could not save the Dropbox public app key. Allow site storage and try again.');
      finishEdit();
      feedback.textContent = saved ? 'App key saved on this device.' : 'Dropbox settings changed. Review the current app key.';
      await cloud.refresh();
    } finally {
      saving = false;
      if (!closed) { refresh(); if (editing === undefined) focusKeyControl(); else field.focus(); }
    }
  }
  const run = (work: () => Promise<void>) => {
    feedback.textContent = '';
    void work().catch(error => cloud.report(cloud.failure(error)));
  };
  form.onsubmit = event => {
    event.preventDefault();
    void saveKey().catch(error => { if (!closed) feedback.textContent = cloud.failure(error); });
  };
  one('[data-sign-in]').onclick = () => run(() => cloud.signIn());
  one('[data-sync]').onclick = () => { feedback.textContent = ''; cloud.queueSync(true); };
  one('[data-sign-out]').onclick = () => run(() => cloud.signOut());
  const clear = one<HTMLButtonElement>('[data-clear-dropbox]');
  clear.onclick = () => {
    if (!cloud.canBackUpNow) return;
    clearSheet = openPersonalDialog(group,'Clear Dropbox',()=>clear);
    const panel = clearSheet, fieldset = doc.createElement('fieldset'), legend = doc.createElement('legend');
    fieldset.className = 'dropbox-reset-options'; legend.textContent = 'Choose what to clear'; fieldset.append(legend);
    for (const [scope,name] of Object.entries(resetLabels)) {
      const label = doc.createElement('label'), input = doc.createElement('input');
      input.type = 'checkbox'; input.value = scope;
      label.append(input,name); fieldset.append(label);
    }
    const buttons = doc.createElement('div'), cancel = doc.createElement('button'), next = doc.createElement('button');
    buttons.className = 'actions'; cancel.type = next.type = 'button'; cancel.textContent = 'Cancel'; cancel.onclick = panel.close;
    next.textContent = 'Review'; next.disabled = true;
    fieldset.onchange = () => { next.disabled = !fieldset.querySelector('input:checked'); };
    next.onclick = () => {
      const scopes = [...fieldset.querySelectorAll<HTMLInputElement>('input:checked')].map(box=>box.value as ResetScope);
      if (!scopes.length) return;
      panel.close(); feedback.textContent = 'Checking Dropbox…';
      void cloud.clearDropbox(scopes,lifetime.signal).then(done=>{
        if (!closed) feedback.textContent = done ? 'Selected Dropbox data cleared.' : '';
      },error=>{ if (!closed) feedback.textContent = cloud.failure(error); });
    };
    buttons.append(cancel,next); panel.body.append(fieldset,buttons);
  };
  backup.onclick = () => {
    if (!cloud.canBackUpNow) return;
    feedback.textContent = '';
    void cloud.backUpNow().then(() => {
      if (!closed) feedback.textContent = 'Backup saved to Dropbox.';
    }, error => { if (!closed) feedback.textContent = cloud.failure(error); });
  };
  function refresh() {
    const key = cloud.auth.appKey, writer = ctx.service.store.role === 'writer', online = win.navigator.onLine;
    help.setAttribute('aria-label',cloud.registrationUnknown ? 'How to find the original Dropbox app key' :
      siteKey ? 'About Dropbox sign-in' : 'How to get a Dropbox app key');
    if (editing !== undefined && (!canEdit(key) || editing !== key)) finishEdit();
    form.hidden = editing === undefined;
    field.disabled = saving || cloud.busy || form.hidden;
    one<HTMLButtonElement>('button[type=submit]').disabled = field.disabled;
    cancel.disabled = saving;
    edit.hidden = !form.hidden || cloud.signedIn || (!cloud.registrationUnknown && (!!siteKey || (cloud.linked && !!key)));
    edit.disabled = !writer || cloud.busy || saving;
    edit.textContent = cloud.registrationUnknown ? 'Enter original app key' : key ? 'Change app key' : 'Add app key';
    if (cloud.unfinishedSignOut) status.textContent = cloud.unfinishedSignOut;
    else if (!online) status.textContent = cloud.linked ? 'Offline · Changes stay on this device.' : 'Go online to connect.';
    else if (cloud.mismatch) status.textContent = 'Sign in with the linked Dropbox account.';
    else if (!cloud.signedIn && !writer) status.textContent = ctx.service.store.readOnlyReason ?? 'Use the editing tab to connect.';
    else if (!cloud.signedIn && cloud.registrationUnknown) status.textContent = 'Use the original app key to reconnect. If it’s unavailable, export all four CSVs, clear this device in Settings and link it again.';
    else if (!cloud.signedIn && !key) status.textContent = 'Add a public app key to connect.';
    else if (!cloud.signedIn) status.textContent = cloud.linked ? 'Signed out · Sign in to sync.' : 'Ready to sign in.';
    else if (!writer && cloud.reason === 'Changes are waiting to sync.') status.textContent = ctx.service.store.readOnlyReason ?? 'Use the editing tab to sync.';
    else if (cloud.operation === 'sync' || cloud.reason === 'Sync in progress.') status.textContent = 'Syncing…';
    else status.textContent = cloud.synced ? 'Synced' : cloud.reason;
    status.dataset.synced = String(status.textContent === 'Synced');
    const sign = one<HTMLButtonElement>('[data-sign-in]'), sync = one<HTMLButtonElement>('[data-sync]'), out = one<HTMLButtonElement>('[data-sign-out]');
    sign.hidden = !form.hidden || !writer || cloud.signedIn || !!cloud.unfinishedSignOut || !key;
    sign.disabled = cloud.busy || !online || saving;
    out.hidden = !writer || (!cloud.signedIn && !cloud.unfinishedSignOut);
    out.disabled = cloud.busy;
    out.textContent = cloud.unfinishedSignOut ? 'Finish sign-out' : 'Sign out';
    clear.disabled = !cloud.canBackUpNow;
    sync.hidden = !cloud.signedIn || !!cloud.unfinishedSignOut;
    sync.disabled = !writer || cloud.busy || cloud.mismatch || !online;
    const account = one('[data-account-actions]');
    account.hidden = setupOnly && sign.hidden && sync.hidden && out.hidden;
    one('.dropbox-actions').hidden = setupOnly && account.hidden;
    backup.disabled = !cloud.canBackUpNow;
    backup.hidden = setupOnly;
    backup.textContent = cloud.operation === 'backup' ? 'Backing up…' : 'Back up now';
    drawNotices(status.textContent,feedback.textContent);
  }
  cloud.changed.addEventListener('change', refresh);
  const storageChanged = (event: StorageEvent) => {
    if (event.key === registrationKey || event.key === null) {
      const wasEditing = editing !== undefined;
      finishEdit();
      feedback.textContent = '';
      refresh();
      if (wasEditing) focusKeyControl();
    }
  };
  win.addEventListener('storage', storageChanged);
  refresh();
  return { refresh, dispose() {
    closed = true;
    lifetime.abort();
    clearSheet?.close();
    helpSheet?.close();
    win.removeEventListener('storage', storageChanged);
    cloud.changed.removeEventListener('change', refresh);
  } };
}
