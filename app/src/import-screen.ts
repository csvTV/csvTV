import { writeBackup } from './dropbox-backup.ts';
import type { DropboxIdentity } from './dropbox-auth.ts';
import type { DropboxController } from './dropbox-controller.ts';
import { describeImportChanges, type ImportPlan } from './import-preview.ts';
import { reviewList } from './review-list.ts';
import type { ImportHooks } from './import-workflow.ts';
import type { Screen, ScreenContext } from './screen-context.ts';
import type { DeviceStore, ImportPreviewSnapshot } from './storage.ts';
import type { TmdbService } from './tmdb-service.ts';
interface MatchOptions {
  current(): boolean;
  signal: AbortSignal;
  status(message: string): void;
  progress(completed: number): void;
}
type SeasonExtras = ReadonlyMap<number, ReadonlyMap<number, number>>;
export type UpdateImportCounts<Plan> = (selected: ReadonlySet<number>, seasonExtras: SeasonExtras,
  wholeShowPasses: ReadonlyMap<number, number>) => Plan | undefined;
export type PrepareImportSeason = (showId: number, season: number) => Promise<boolean>;
interface ImportSource<Placement, Plan, Choices> {
  name: 'AniList' | 'Trakt';
  format: 'JSON' | 'ZIP';
  accept: string;
  instructions: string;
  match(file: File, service: TmdbService, options: MatchOptions): Promise<Placement>;
  plan(placement: Placement, record: ImportPreviewSnapshot, choices?: Choices): Plan;
  prepareSeason?(placement: Placement, showId: number, season: number): Promise<void>;
  render(host: HTMLElement, plan: Plan, updateCounts: (choices: Choices) => Plan | undefined, prepareSeason?: PrepareImportSeason): void;
  apply(store: DeviceStore, placement: Placement, plan: Plan, hooks: ImportHooks<Plan>): Promise<boolean>;
}

/** Keep both importers on the same writer, confirmation and pre-import backup path. */
export function mountImport<Placement extends {generation:bigint;shows:readonly {show_id:number}[]}, Plan extends ImportPlan, Choices>(
    root: HTMLElement, ctx: ScreenContext, cloud: DropboxController, source: ImportSource<Placement, Plan, Choices>): Screen {
  const {service} = ctx, {store} = service, doc = root.ownerDocument;
  root.innerHTML = '<section class="import-screen"><h1></h1>' +
    '<p role="status" data-block>Checking whether this device can import…</p>' +
    '<a class="button primary" href="#/settings" data-settings hidden></a>' +
    '<button type="button" data-retry-access hidden>Try again</button>' +
    '<div data-select><p></p><label hidden><span></span><input type="file" disabled></label></div>' +
    '<p role="status" tabindex="-1" data-status></p><div data-preview></div>' +
    '<div class="actions"><button type="button" data-cancel hidden>Cancel</button>' +
    '<button type="button" class="primary" data-apply hidden>Import</button></div></section>';
  const find = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const picker = find<HTMLInputElement>('input'), select = find('[data-select]'), preview = find('[data-preview]');
  const status = find('[data-status]'), block = find('[data-block]'), settings = find('[data-settings]');
  const label = find('label'), retry = find<HTMLButtonElement>('[data-retry-access]');
  const cancel = find<HTMLButtonElement>('[data-cancel]'), apply = find<HTMLButtonElement>('[data-apply]');
  find('section').classList.add(source.name === 'Trakt' ? 'trakt-import' : 'anilist-import');
  find('h1').textContent = 'Import from ' + source.name;
  find('[data-select] p').textContent = source.instructions;
  find('label span').textContent = source.name + ' export ' + source.format;
  picker.accept = source.accept;
  let placement: Placement | undefined, original: ImportPreviewSnapshot | undefined, plan: Plan | undefined;
  let alive = true, matching = false, applying = false, generation = 0, refreshId = 0;
  let pendingSeasons = 0;
  let reader: AbortController | undefined;
  let eligibleSession: DropboxIdentity | undefined, chooserSession: DropboxIdentity | undefined, fileSession: DropboxIdentity | undefined;
  const changedSignIn = 'The Dropbox sign-in changed. Choose the file again to review the import.';
  let latestCheck: Promise<void>;
  const links = {addKey:'Add a TMDB key in Settings', changeKey:'Change TMDB key in Settings', dropbox:'Open Dropbox settings'};
  let destination: keyof typeof links | undefined;
  let question: HTMLDialogElement | null = null;

  function reset() {
    reader?.abort(); reader = undefined;
    generation++; matching = false; pendingSeasons = 0;
    placement = undefined; original = undefined; plan = undefined; fileSession = undefined; chooserSession = undefined;
    picker.value = ''; select.hidden = false;
    preview.replaceChildren(); cancel.hidden = apply.hidden = true;
  }
  function setAccess(reason: string, action?: keyof typeof links) {
    block.textContent = reason;
    block.hidden = !reason;
    destination = action;
    settings.textContent = action ? links[action] : '';
    settings.hidden = !action;
    label.hidden = Boolean(reason);
    picker.disabled = Boolean(reason) || matching || applying;
    apply.disabled = Boolean(reason) || !plan || applying || pendingSeasons > 0;
    cancel.disabled = applying;
  }
  async function checkAccess(id: number): Promise<void> {
    retry.hidden = true;
    let access;
    try {
      access = await Promise.all([service.keyStatus(), store.dropboxState()]);
    } catch {
      if (!alive) return;
      if (id !== refreshId) return latestCheck;
      setAccess('Could not check whether this device can import.');
      retry.hidden = false;
      return;
    }
    if (!alive) return;
    if (id !== refreshId) return latestCheck;
    const [key, link] = access;
    const online = service.environment.online();
    let reason = '', action: keyof typeof links | undefined;
    if (store.role !== 'writer') reason = store.readOnlyReason ??
      'Another csvTV tab can edit this record. Import there, or close that tab to import here.';
    else if (!online) reason = 'Connect to the internet to match and import your export.';
    else if (!link.accountId || !link.session || link.session.accountId !== link.accountId || link.session.signInDeadline <= cloud.now()) {
      reason = 'Sign in to the linked Dropbox account in Settings before importing.';
      action = 'dropbox';
    } else if (!store.providerKeysAvailable) {
      reason = 'Sync with Dropbox to load your provider keys before importing.';
      action = 'dropbox';
    } else if (key.status === 'missing-key') {
      reason = 'Add a TMDB key before choosing your export. csvTV uses it to match shows and episodes.';
      action = 'addKey';
    } else if (key.status === 'refused') {
      reason = 'TMDB refused the saved key. Replace it before choosing your export.';
      action = 'changeKey';
    } else if (cloud.busy && !applying) reason = 'A Dropbox operation is in progress.';
    eligibleSession = !reason && link.session ? {accountId:link.session.accountId, instanceId:link.session.instanceId} : undefined;
    if (fileSession && !applying && (fileSession.accountId !== link.accountId || fileSession.instanceId !== link.session?.instanceId)) {
      reset(); status.textContent = changedSignIn;
    } else if (placement && !applying && placement.generation !== key.generation) {
      reset(); status.textContent = 'The TMDB key changed. Choose the file again to refresh the matches.';
    }
    setAccess(reason, action);
  }
  function refresh() {
    // Keep an eligible native chooser clickable while a background check is pending.
    // The change handler verifies access again before it reads the selected file.
    apply.disabled = true;
    latestCheck = checkAccess(++refreshId);
    return latestCheck;
  }
  retry.onclick = async () => {
    await refresh();
    if (!alive) return;
    if (!retry.hidden) retry.focus();
    else if (!settings.hidden) settings.focus();
    else if (!picker.disabled) picker.focus();
  };
  settings.onclick = event => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey ||
        !destination) return;
    event.preventDefault();
    ctx.go({page:'settings'},destination === 'dropbox' ? 'dropbox-label' : 'tmdb-key-label');
  };

  function showPreviewStatus(proposed: Plan) {
    const hasRows = proposed.watched.length + proposed.ratings.length + proposed.lists.length > 0 ||
      Boolean(proposed.changes.put?.shows?.length);
    if (hasRows) status.textContent = 'On confirmation, csvTV syncs and backs up your record before importing.';
    else status.textContent = preview.querySelector('[data-count-review]') ?
      'No entries selected for import.' : 'No entries can be imported from this file.';
    apply.hidden = !hasRows;
  }
  const changeCounts = (choices: Choices) => {
    if (!plan || !placement || !original || applying) return;
    plan = source.plan(placement, original, choices);
    showPreviewStatus(plan);
    return plan;
  };
  const prepareSeason: PrepareImportSeason = async (showId, season) => {
    if (!source.prepareSeason || !placement || applying || !alive) return false;
    const resolved = placement, id = generation;
    const current = () => alive && generation === id && placement === resolved;
    pendingSeasons++; apply.disabled = true;
    try {
      await refresh();
      if (!current()) return false;
      if (!eligibleSession || !block.hidden) throw Error(block.textContent || 'Check your Dropbox sign-in before adding a season.');
      try { await source.prepareSeason(resolved, showId, season); }
      finally { if (current()) await refresh(); }
      if (!current()) return false;
      if (!eligibleSession || !block.hidden) throw Error(block.textContent || 'Check your Dropbox sign-in before adding a season.');
      return true;
    } finally {
      if (current()) {
        pendingSeasons--;
        apply.disabled = !block.hidden || !plan || applying || pendingSeasons > 0;
      }
    }
  };
  picker.onclick = () => { chooserSession = eligibleSession; };
  picker.oncancel = () => { chooserSession = undefined; };
  picker.onchange = async () => {
    const file = picker.files?.[0];
    const owner = chooserSession ?? eligibleSession;
    chooserSession = undefined;
    if (label.hidden || applying || matching) { picker.value = ''; return; }
    const selection = ++generation;
    if (!file) return;
    // The native picker can remain open while credentials, connectivity or the account change.
    await refresh();
    if (!alive || selection !== generation) return;
    if (picker.disabled || !eligibleSession || !owner) { picker.value = ''; return; }
    reset();
    if (owner.accountId !== eligibleSession.accountId || owner.instanceId !== eligibleSession.instanceId) {
      status.textContent = changedSignIn; status.focus(); return;
    }
    fileSession = owner;
    matching = true;
    reader = new AbortController();
    const id = generation, current = () => alive && generation === id;
    status.textContent = 'Reading the ' + source.name + ' ' + source.format + '…';
    select.hidden = true; cancel.hidden = false; cancel.focus();
    try {
      const resolved = await source.match(file, service, {current, signal:reader.signal, status(message) {
        if (current()) status.textContent = message;
      }, progress(completed) {
        if (current() && (completed === 1 || completed % 10 === 0))
          status.textContent = 'Matching shows and episodes · ' + completed.toLocaleString() + ' lookups completed';
      }});
      if (!current()) return;
      const snapshot = await store.importPreviewSnapshot(resolved.shows.map(show=>show.show_id),reader.signal);
      if (!current()) return;
      const proposed = source.plan(resolved,snapshot);
      if (proposed.accountId !== owner.accountId || proposed.instanceId !== owner.instanceId) throw Error(changedSignIn);
      original = snapshot; placement = resolved; plan = proposed; matching = false;
      source.render(preview,plan,changeCounts,source.prepareSeason ? prepareSeason : undefined);
      showPreviewStatus(plan); status.focus({preventScroll:true});
      await refresh();
    } catch (error) {
      if (!current()) return;
      reset(); status.textContent = cloud.failure(error); await refresh();
      if (alive) status.focus();
    }
  };
  cancel.onclick = async () => {
    if (applying) return;
    reset(); status.textContent = 'Import canceled.';
    await refresh();
    if (alive && !picker.disabled) picker.focus();
  };
  async function confirmImport(title: string, message: string, label: string, contents: HTMLElement) {
    const answer = cloud.dialogs.choose(title,message,
      [{value:'cancel',label:'Cancel'}, {value:'import',label}],contents);
    question = contents.closest('dialog');
    try { return await answer === 'import'; } finally { question = null; }
  }
  apply.onclick = async () => {
    if (!plan || !placement || applying || pendingSeasons > 0 || cloud.busy || apply.disabled || apply.hidden) return;
    const resolved = placement, approved = plan;
    applying = true; apply.disabled = cancel.disabled = true;
    preview.inert = true;
    status.textContent = 'Checking the current record…'; status.focus();
    try {
      const saved = await cloud.exclusive('import', () => source.apply(store,resolved,approved,{
        active:() => alive, online:() => service.environment.online(),
        preflight:async expected => {
          status.textContent = 'Syncing the current record with Dropbox…';
          await cloud.syncFiles(true,expected);
          if (!cloud.synced) throw Error('Some changes still need to sync. Try the import again.');
        },
        backup:async expected => {
          status.textContent = 'Backing up the synced record to Dropbox…';
          const {api} = await cloud.backupAccess(expected); await writeBackup(api);
          if (alive) status.textContent = 'Saving your import on this device…';
        },
        confirm:async (revised, previous) => {
          if (!alive) return false;
          const changes = describeImportChanges(revised,previous);
          const {details} = reviewList(doc,'Changed outcomes',changes.length,i => changes[i]); details.open = true;
          return confirmImport('Review updated import',
            'The record changed after your preview. Review the affected entries before importing.',
            'Import updated changes', details);
        },
      }));
      if (!alive) return;
      reset();
      if (saved) ctx.clearUndo();
      status.textContent = saved ? 'Import complete. Your record is saved on this device.' : 'Import canceled.';
    } catch (error) { if (alive) status.textContent = cloud.failure(error); }
    finally {
      applying = false;
      if (alive) { preview.inert = false; await refresh(); if (alive) status.focus(); }
    }
  };
  const changed = () => { if (alive) void refresh(); };
  cloud.changed.addEventListener('change',changed);
  return {ready:refresh(),refresh,dispose(){
    alive = false; generation++; refreshId++; reader?.abort();
    if (question?.open) cloud.dialogs.close();
    cloud.changed.removeEventListener('change',changed);
  }};
}
