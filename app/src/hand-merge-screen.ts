import type { ScreenContext, Screen } from './screen-context.ts';
import type { DropboxController } from './dropbox-controller.ts';
import { readHandInputs, planHandMerge, applyHandMerge, type HandInput, type HandPlan } from './hand-merge.ts';
import { recordExportFiles } from './export-data.ts';
import { writeBackup } from './dropbox-backup.ts';

export function mountHandMerge(root:HTMLElement,ctx:ScreenContext,cloud:DropboxController):Screen {
  const doc = root.ownerDocument, win = doc.defaultView!, store = ctx.service.store;
  root.innerHTML = '<section class="group hand-merge-screen"><h1>Merge by hand</h1><p>Choose watched episodes, ratings or list memberships in CSV format. You can review the changes before saving.</p>' +
    '<label>Select CSV files <input type="file" multiple accept=".csv,text/csv"></label><p data-block role="status" hidden></p><p data-state role="status"></p>' +
    '<div data-copy></div><pre data-preview class="dropbox-message" hidden></pre><div class="actions"><button data-cancel hidden>Cancel</button><button data-continue hidden>Continue</button></div></section>';
  const q = <T extends HTMLElement>(s:string) => root.querySelector<T>(s)!;
  const picker = q<HTMLInputElement>('input'), go = q<HTMLButtonElement>('[data-continue]'), cancel = q<HTMLButtonElement>('[data-cancel]');
  const preview = q('[data-preview]'), status = q('[data-state]'), copies = q('[data-copy]');
  let source:HandInput|undefined, plan:HandPlan|undefined, seq = 0, refreshId = 0, alive = true;
  let review = new AbortController();
  const urls:string[] = [];
  let copyRevision:bigint|undefined;
  function clearDownloads() {
    copies.replaceChildren();
    urls.splice(0).forEach(url=>win.URL.revokeObjectURL(url));
    copyRevision=undefined;
  }
  async function showDownloads(current:()=>boolean) {
    const now = ctx.service.environment.now(), exported = await store.exportSnapshot(false,now);
    if (!current()) return;
    clearDownloads();
    const label = doc.createElement('p'); label.textContent='Save a copy of the current record before merging.'; copies.append(label);
    for (const file of recordExportFiles(exported,now)) {
      const a = doc.createElement('a'); a.className='button'; a.download=file.name; a.textContent=file.name;
      a.href=win.URL.createObjectURL(file); urls.push(a.href); copies.append(a);
    }
    copyRevision=exported.revision;
  }
  function reset(clearPicker = true) {
    review.abort(); review = new AbortController();
    seq++; plan=undefined; source=undefined; go.hidden=true; cancel.hidden=true;
    if (clearPicker) picker.value='';
    preview.hidden=true; clearDownloads();
  }
  async function refresh() {
    if (!alive) return;
    const id = ++refreshId;
    const state = await store.dropboxState();
    if (!alive || id !== refreshId) return;
    if (plan && (plan.accountId !== state.accountId || plan.instanceId !== (state.session?.instanceId ?? null))) {
      reset();
      status.textContent = 'The Dropbox sign-in changed. Choose the files again to review the merge.';
    }
    const blocked = store.role !== 'writer' || !!state.accountId && (!cloud.signedIn || cloud.mismatch || !win.navigator.onLine);
    picker.disabled = go.disabled = blocked || cloud.busy;
    const warning = q('[data-block]');
    warning.textContent = !blocked ? '' : store.role !== 'writer' ? store.readOnlyReason ?? 'Open this screen in the writer tab.'
      : 'Sign in to the linked Dropbox account and connect to continue.';
    warning.hidden = !blocked;
  }
  picker.onchange = async () => {
    const files = Array.from(picker.files ?? []);
    reset(false); const id = seq;
    const current = () => alive && id === seq;
    try {
      const input = await readHandInputs(files);
      if (!current()) return;
      const snap = await store.snapshot();
      if (!current()) return;
      const proposed = await planHandMerge(input,snap,result=>current() ? cloud.dialogs.identities(result,'Selected file',review.signal) : Promise.resolve(null));
      if (!current()) return;
      if (!snap.local.syncAccountId) {
        await showDownloads(current);
        if (!current()) return;
      }
      source=input; plan=proposed; preview.textContent=proposed.notes.join('\n'); preview.hidden=false;
      status.textContent='Review the selected files.'; go.hidden=!Object.keys(input.tables).length; cancel.hidden=false;
      await refresh();
    } catch(error) { if (alive && id===seq) status.textContent=cloud.failure(error); }
  };
  cancel.onclick = () => { reset(); status.textContent='Merge canceled.'; picker.focus(); };
  go.onclick = () => {
    if (!source || !plan || go.disabled || cloud.busy) return;
    const input=source, approved=plan, selected=seq;
    const current = () => alive && selected === seq;
    void cloud.exclusive('hand merge',async () => {
      const done=await applyHandMerge(store,input,approved,{
        active:current, resolve:result=>current() ? cloud.dialogs.identities(result,'Selected file',review.signal) : Promise.resolve(null),
        preflight:async expected => {
          await cloud.syncFiles(true,expected);
          if (!cloud.synced) throw Error('Some changes still need to sync. Try the hand merge again.');
        },
        backup:async expected => { const {api}=await cloud.backupAccess(expected); await writeBackup(api); },
        offerLocal:async (snapshot,revised) => {
          if (copyRevision === snapshot.revision || !current()) return;
          await showDownloads(current);
          if (!current()) return;
          plan=revised; preview.textContent=revised.notes.join('\n');
          throw Error('The record changed. Review the refreshed backup downloads before continuing.');
        },
        confirm:async revised => current() && await cloud.dialogs.choose('Review updated changes',revised.notes.join('\n'),
          [{value:'cancel',label:'Cancel'},{value:'continue',label:'Continue'}],undefined,review.signal) === 'continue',
      });
      if (!current()) return;
      reset(); ctx.clearUndo(); status.textContent = done ? 'Merge saved on this device.' : 'Merge canceled.';
    }).catch(error => {if(current()) status.textContent=cloud.failure(error);});
  };
  const changed = () => { void refresh(); };
  cloud.changed.addEventListener('change',changed);
  return {ready:refresh(),refresh,dispose(){alive=false;reset();cloud.changed.removeEventListener('change',changed);}};
}
