import { readCsv, writeCsv } from './csv.ts';
import { backupTables, backupFileIssue } from './dropbox-backup.ts';
import { dropboxContentHash, type DropboxApi } from './dropbox-api.ts';
import { DropboxError } from './dropbox-client.ts';
import { hasUnmigratedProviderKeys, settingsRows } from './dropbox-provider-settings.ts';
import { publicSettings, type ProviderSession } from './provider-credentials.ts';
import { canceledKey, filePath, fileState, sparseRecordPatch, tableMatchesDropboxBase } from './dropbox-sync-file.ts';
import { emptyTables, isListDeclaration, type SettingRow } from './model.ts';
import { cloudFiles } from './dropbox-derived.ts';
import { withoutManualOrder } from './season-order.ts';
import { resetSummary } from './export-data.ts';
import { resetCsvPayload } from './dropbox-reset-csv.ts';
import { resetLabels, type ResetScope } from './dropbox-reset-options.ts';
import { checkDropboxFile, dropboxLimits } from './dropbox-limits.ts';
import { parseDropboxMarker } from './dropbox-marker.ts';
import { recentId } from './recent-history.ts';
import { recordTransferWorkerMinimum } from './record-transaction.ts';
import { StaleSnapshotError, type DeviceChanges, type DeviceSnapshot, type DeviceStore, type ExportSnapshot } from './storage.ts';

export { resetLabels, type ResetScope } from './dropbox-reset-options.ts';
const scopes = Object.keys(resetLabels) as ResetScope[];
const markerPath = '/csvtv-reset.json';
type Generations = Partial<Record<ResetScope,string>>;
type RetiredGenerations = Partial<Record<ResetScope,string[]>>;
type Ancestry = Partial<Record<ResetScope,(string|null)[]>>;
export interface ObservedReset {accountId:string; generations:Generations; retired?:RetiredGenerations; ancestry?:Ancestry; format?:2}
interface Marker {version:1|2; generations:Generations; ancestry?:Ancestry; pending:ResetScope[]; claim?:string; backupsClearedAt:number; reservations?:string[]}
type Port = Pick<DropboxApi,'download'|'upload'|'delete'|'list'>;
export const pendingResetMessage = 'A Dropbox clear is unfinished. Open Clear Dropbox in Settings to review and finish it.';
const changed = (message = 'Dropbox changed during review. Open Clear Dropbox again to review the current files.') => Error(message);
const syncChanged = () => Error('Dropbox changed during this operation. Sync again to load the latest record.');
const staleSyncReview = 'Dropbox changed during review. Sync again to review the current copies.';
const validGeneration = (value:unknown):value is string => typeof value === 'string' && /^[a-z\d-]{1,80}$/i.test(value);

// null identifies the first clear of a category. A chain starting with a legacy ID
// proves descent from that ID, without making claims about its unknown predecessors.
function validAncestry(marker:Marker) {
  const history = marker.ancestry;
  if (marker.version === 1) return history === undefined;
  if (!history || typeof history !== 'object' || Array.isArray(history) ||
      Object.keys(history).length !== Object.keys(marker.generations).length) return false;
  return Object.entries(history).every(([key,path])=>{
    const head = marker.generations[key as ResetScope];
    return Object.hasOwn(marker.generations,key) && head && Array.isArray(path) && !path.includes(head) && new Set(path).size === path.length &&
      path.every((id,i)=>validGeneration(id) || (i === 0 && id === null));
  });
}

export async function resetMarker(api:Port) {
  const file = await api.download(markerPath);
  const empty:Marker = {version:1,generations:{},pending:[],backupsClearedAt:0};
  if (!file) return {revision:null,marker:empty};
  try {
    const m = parseDropboxMarker(new TextDecoder('utf-8',{fatal:true}).decode(file.bytes));
    if ((m.version !== 1 && m.version !== 2) || !Array.isArray(m.pending) || !m.pending.every((s:ResetScope)=>scopes.includes(s)) ||
        new Set(m.pending).size !== m.pending.length ||
        (m.claim !== undefined && (m.version !== 2 || !validGeneration(m.claim))) ||
        !m.generations || typeof m.generations !== 'object' ||
        Array.isArray(m.generations) || !Object.entries(m.generations).every(([k,v])=>scopes.includes(k as ResetScope) &&
          validGeneration(v)) || !validAncestry(m) ||
        (m.pending.length > 0 && (!m.generations[m.pending[0]] ||
          scopes.some(scope=>(m.generations[scope] === m.generations[m.pending[0]]) !== m.pending.includes(scope)))) ||
        !Number.isSafeInteger(m.backupsClearedAt) || m.backupsClearedAt < 0 ||
        (m.reservations !== undefined && (!Array.isArray(m.reservations) || m.reservations.length > dropboxLimits.backupFolders ||
          new Set(m.reservations).size !== m.reservations.length || !m.reservations.every((folder:unknown)=>typeof folder === 'string' && generatedFolder.test(folder))))) throw Error();
    return {revision:file.metadata.rev,marker:m as Marker};
  } catch { throw Error('The csvTV reset marker in Dropbox is unreadable or uses a newer format. Sync paused.'); }
}
type Fence = Awaited<ReturnType<typeof resetMarker>>;
/** A completed clear can replace a category's generation, but it never removes the category. */
export function checkResetHistory(fence:Fence, previous:({seen:boolean}&Partial<ObservedReset>)|undefined) {
  if (!previous?.seen) return;
  if (!fence.revision) throw Error('The csvTV reset marker is missing. Restore csvtv-reset.json in Dropbox before syncing.');
  if (previous.format === 2 && fence.marker.version !== 2) {
    throw Error('The Dropbox reset marker is from an older version. Restore the latest csvtv-reset.json before continuing.');
  }
  if (Object.keys(previous.generations ?? {}).some(scope=>!Object.hasOwn(fence.marker.generations,scope))) {
    throw Error('The Dropbox reset marker is missing a previously cleared category. Restore the latest csvtv-reset.json before continuing.');
  }
  if (fence.marker.pending.some(scope=>fence.marker.generations[scope] === previous.generations?.[scope]) || scopes.some(scope=>{
    const generation = fence.marker.generations[scope];
    return generation && (previous.retired?.[scope]?.includes(generation) || previous.ancestry?.[scope]?.includes(generation));
  })) {
    throw Error('The Dropbox reset marker repeats an older clear. Restore the latest csvtv-reset.json before continuing.');
  }
  for (const scope of scopes) {
    const known = previous.ancestry?.[scope], path = fence.marker.ancestry?.[scope], before = previous.generations?.[scope];
    if (!path || previous.format !== 2) continue;
    // A newly introduced category starts empty. An existing category can only extend its witnessed chain.
    if (!before && path[0] === null) continue;
    if (before && known) {
      const index = fence.marker.generations[scope] === before ? path.length : path.indexOf(before);
      if (index === known.length && known.every((id,i)=>path[i] === id)) continue;
    }
    throw Error('The Dropbox clear history diverges from this device. Restore the latest csvtv-reset.json before continuing.');
  }
}
export function resetEpoch(fence:Fence) {
  return JSON.stringify([fence.marker.version,scopes.map(s=>[fence.marker.generations[s] ?? null,fence.marker.ancestry?.[s] ?? null]),fence.marker.pending]);
}
export async function checkResetEpoch(api:Port, expected:string, requireMarker=false) {
  const fence = await resetMarker(api);
  checkResetHistory(fence,{seen:requireMarker});
  if (resetEpoch(fence) !== expected) throw syncChanged();
  return fence;
}
function writeMarker(api:Port, revision:string|null, marker:Marker) {
  const content = JSON.stringify(marker);
  checkDropboxFile(markerPath,content);
  return api.upload(markerPath,content,revision ? {mode:'update',revision} : {mode:'add'});
}
/** Register the exclusively created folder before a private byte can be sent to it. */
export async function reserveBackupWriter(api:Port, expected:string, folder:string, requireMarker=false,
    observed?:(fence:Fence)=>Promise<void>) {
  if (!generatedFolder.test(folder)) throw Error('Unrecognized csvTV backup folder.');
  async function change(add:boolean) {
    for (let attempt=0; attempt<8; attempt++) {
      const fence = await resetMarker(api);
      checkResetHistory(fence,{seen:requireMarker || !add});
      if (fence.marker.pending.length) throw Error(pendingResetMessage);
      if (resetEpoch(fence) !== expected) throw syncChanged();
      if (fence.revision && !requireMarker) {
        await observed?.(fence);
        requireMarker = true;
      }
      const existing = fence.marker.reservations ?? [];
      if (add && existing.length >= dropboxLimits.backupFolders) throw Error('Too many unfinished backups. Review Clear Dropbox in Settings.');
      if (existing.includes(folder) === add) return fence;
      const reservations = add ? [...existing,folder] : existing.filter(name=>name!==folder);
      const marker = {...fence.marker,reservations};
      try { const saved = await writeMarker(api,fence.revision,marker); return {revision:saved.rev,marker}; }
      catch (error) { if ((error as {kind?:string})?.kind !== 'conflict') throw error; }
    }
    throw syncChanged();
  }
  const reserved = await change(true);
  if (!requireMarker) await observed?.(reserved);
  return async () => { await change(false); };
}
/** A deliberate transfer to a different account can include its rows in a new merge after reviewing that account's past clears. */
export async function reviewMergeDestination(api:Port, store:DeviceStore, fence:Fence, session:ProviderSession, now:()=>number,
    choose:(affected:ResetScope[])=>Promise<string>) {
  if (fence.marker.pending.length) throw Error(pendingResetMessage);
  const snapshot = await store.snapshot();
  if (snapshot.local.dropboxMergeDestination !== session.accountId || snapshot.local.syncAccountId !== session.accountId ||
      snapshot.local.dropboxSession?.instanceId !== session.instanceId) throw new StaleSnapshotError();
  const affected = scopes.filter(s=>s !== 'backups' && fence.marker.generations[s]);
  const decision = affected.length ? await choose(affected) : 'include';
  if (decision !== 'include' && decision !== 'dropbox') throw Error('Account merge paused. Sync again to review the destination.');
  await checkResetEpoch(api,resetEpoch(fence),!!fence.revision);
  const local = decision === 'include' && fence.revision ? {dropboxResetSeen:{accountId:session.accountId,
    generations:fence.marker.generations,ancestry:fence.marker.ancestry,format:fence.marker.version === 2 ? 2 : undefined}} : {};
  await store.commit(snapshot.revision,{local,removeLocal:['dropboxMergeDestination']},{syncWrite:true,current:()=>now() < session.signInDeadline});
}
export async function checkResetRevision(api:Port, expected:string|null, message?:string) {
  if ((await resetMarker(api)).revision !== expected) throw changed(message);
}
function settingSelected(row:SettingRow, selected:readonly ResetScope[]) {
  return selected.includes(recentId(row.setting) !== null ? 'watched' : 'settings');
}
const canonicalBackup = new Set<string>([...backupTables.map(t=>t+'.csv'),'completion.json']);
const generatedFolder = /^\d{4}-\d{2}-\d{2}-[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/;
async function backupRevisions(api:Port, marker:Marker) {
  let entries;
  try { entries = await api.list('/backups',true); }
  catch (error) {
    const kind = (error as {kind?:string})?.kind;
    if (kind === 'not-found') return [];
    if (kind === 'not-folder') {
      if (marker.reservations?.length) throw Error('A file named backups blocks an unfinished csvTV backup. Move or rename that file in Dropbox, then review again.');
      return []; // A user's file named backups contains no csvTV backup folders.
    }
    throw error;
  }
  return entries.flatMap(entry=>{
    const parts = entry.path.toLowerCase().split('/');
    return entry.kind === 'file' && parts.length === 4 && parts[1] === 'backups' &&
      // csvTV creates dated generations. A similarly named file in a user's own folder is theirs.
      generatedFolder.test(parts[2]) && canonicalBackup.has(parts[3])
      ? [{path:entry.path,revision:entry.rev,size:entry.size}] : [];
  }).sort((a,b)=>a.path.localeCompare(b.path));
}
async function reviewRead<T>(step:string, read:()=>Promise<T>):Promise<T> {
  try {
    try { return await read(); }
    catch (error) {
      if (!(error instanceof DropboxError) || error.kind !== 'provider-unavailable') throw error;
      // Only retry a read. A lost write acknowledgement needs a fresh revision review.
      return await read();
    }
  }
  catch (error) {
    if (!(error instanceof DropboxError)) throw error;
    const reason = error.kind !== 'failed' ? error.message : error.status ? `Dropbox returned HTTP ${error.status}.` : 'csvTV could not verify the Dropbox reply.';
    throw new Error(`Couldn’t ${step}. ${reason} This review made no changes.`,{cause:error});
  }
}
export async function reviewReset(api:Port, requested:readonly ResetScope[]) {
  const selected = scopes.filter(s=>requested.includes(s));
  if (!selected.length || selected.length !== requested.length) throw Error('Choose at least one category to clear.');
  const fence = await reviewRead('read the Dropbox clear history',()=>resetMarker(api));
  if (fence.marker.pending.length && (selected.length !== fence.marker.pending.length ||
      !selected.every(s=>fence.marker.pending.includes(s)))) {
    throw Error('Finish the interrupted clear by selecting ' + fence.marker.pending.map(s=>resetLabels[s]).join(', ') + '.');
  }
  const root = await reviewRead('list the csvTV app folder',()=>api.list(''));
  const files = new Map(root.filter(entry=>entry.kind === 'file').map(entry=>[entry.name.toLowerCase(),entry]));
  const backups = selected.includes('backups') ? await reviewRead('list the csvTV backups',()=>backupRevisions(api,fence.marker)) : [];
  return {selected,fence,files,backups};
}
type Review = Awaited<ReturnType<typeof reviewReset>>;
async function prepareRoot(api:Port, review:Review, time:number, metadata?:()=>Promise<ExportSnapshot>) {
  const {selected,files} = review;
  const prepared = new Map<string,string>(), retainedSources = new Set<string>();
  async function read(name:string) {
    const file = await api.download('/'+name);
    if ((file?.metadata.rev ?? null) !== (files.get(name)?.rev ?? null)) throw changed();
    return file;
  }
  async function prepare(name:string, content:string) {
    const listed = files.get(name);
    const evidence = listed ? listed.contentHash ?? (await read(name))!.bytes : null;
    const payload = await resetCsvPayload(content,evidence);
    checkDropboxFile('/'+name,payload);
    prepared.set(name,payload);
  }
  if (selected.length === 1 && selected[0] === 'backups') return {prepared,retainedSources};
  const tables = emptyTables();
  for (const table of ['watched','ratings','lists'] as const) {
    const name = table+'.csv';
    if (selected.includes(table)) { await prepare(name,writeCsv(table,[])); continue; }
    retainedSources.add(name);
    const source = await read(name);
    if (!source) continue;
    const issue = backupFileIssue(table,source.bytes);
    if (issue) throw Error(issue);
    Object.assign(tables,{[table]:readCsv(table,source.bytes).rows});
  }
  if (selected.includes('watched') || selected.includes('settings')) {
    const all = selected.includes('watched') && selected.includes('settings');
    const source = all ? null : await read('settings.csv');
    const rows = source ? settingsRows(source.bytes) : [];
    await prepare('settings.csv',writeCsv('settings',rows.filter(row=>!settingSelected(row,selected))));
  }
  const retained = tables.watched.length || tables.ratings.length || tables.lists.some(row => !isListDeclaration(row));
  const source = retained ? await read('shows.csv') : null;
  if (source) {
    const index = readCsv('shows',source.bytes);
    if (index.stopped || index.findings.length || index.schema !== 'known') throw Error('Repair shows.csv before rebuilding the index.');
    tables.shows = index.rows;
  }
  const cached = retained && metadata ? await metadata() : undefined;
  const snapshot:ExportSnapshot = {...(cached ?? {revision:0n,missingShowIds:new Set(),externalIds:new Map(),
    showMetadata:new Map(),seasons:new Map()}),tables};
  if (cached && selected.includes('settings'))
    snapshot.showMetadata = new Map([...cached.showMetadata].map(([id,show])=>[id,withoutManualOrder(show)]));
  const {index,summary} = cloudFiles(snapshot,tables.shows,time);
  await prepare('shows.csv',writeCsv('shows',index));
  await prepare('summary.csv',await (summary ?? resetSummary(snapshot,index,time)).text());
  return {prepared,retainedSources};
}
export async function performReset(api:Port, review:Review, current:()=>Promise<void>, now=Date.now,
    metadata?:(time:number)=>Promise<ExportSnapshot>) {
  const {selected,fence,files,backups} = review;
  await current();
  const time = now();
  const {prepared,retainedSources} = await prepareRoot(api,review,time,metadata && (()=>metadata(time)));
  async function verifyRoot(names:Iterable<string>) {
    const actual = new Map((await api.list('')).map(entry=>[entry.name.toLowerCase(),entry]));
    for (const name of names) {
      const entry = actual.get(name);
      if ((entry && entry.kind !== 'file') || entry?.rev !== files.get(name)?.rev) throw changed();
    }
  }
  const clearingBackups = selected.includes('backups');
  if (clearingBackups && JSON.stringify(await backupRevisions(api,fence.marker)) !== JSON.stringify(backups)) throw changed();
  await verifyRoot([...prepared.keys(),...retainedSources]);
  await current();
  const resuming = fence.marker.pending.length > 0;
  const generation = resuming ? fence.marker.generations[selected[0]]! : crypto.randomUUID();
  const ancestry:Ancestry = {};
  for (const scope of scopes) {
    const before = fence.marker.generations[scope], old = fence.marker.ancestry?.[scope] ?? [];
    if (selected.includes(scope) && !resuming) ancestry[scope] = [...old,before ?? null];
    else if (before) ancestry[scope] = old;
  }
  // Reclaiming an interrupted clear must advance its revision even if its scope and files still match.
  const marker:Marker = {...fence.marker,version:2,ancestry,pending:selected,claim:crypto.randomUUID(),
    generations:{...fence.marker.generations,...Object.fromEntries(selected.map(s=>[s,generation]))}};
  const held = await writeMarker(api,fence.revision,marker);
  if (held.rev === fence.revision) throw changed();
  const check = async () => { await current(); await checkResetRevision(api,held.rev); };
  for (const [name,payload] of prepared) {
    await check();
    const file = files.get(name);
    await api.upload('/'+name,payload,file ? {mode:'update',revision:file.rev} : {mode:'add'});
  }
  if (clearingBackups) {
    const inFlight = new Set(marker.reservations), sources = new Map(backups.map(file=>[file.path.toLowerCase(),file]));
    // An add already submitted to Dropbox can outlive its browser and the clear. Occupy every
    // immutable destination in unfinished generations. Dropbox then refuses even a delayed first add.
    for (const folder of inFlight) for (const name of canonicalBackup) {
      const path = '/backups/'+folder+'/'+name, existing = sources.get(path);
      if (existing?.size === 0) continue;
      await check(); await api.upload(path,'',existing ? {mode:'update',revision:existing.revision} : {mode:'add'});
    }
    for (const file of backups) {
      if (!file.size || inFlight.has(file.path.toLowerCase().split('/')[2])) continue;
      await check(); await api.delete(file.path,file.revision);
    }
    if ((await backupRevisions(api,marker)).some(file=>file.size)) throw changed();
    marker.backupsClearedAt = now();
    marker.reservations = [];
  }
  await verifyRoot(retainedSources);
  await check();
  marker.pending = [];
  delete marker.claim;
  const finished = await writeMarker(api,held.rev,marker);
  return {revision:finished.rev,marker};
}

type ReviewLegacyClear = (scopes:ResetScope[],evidence:string)=>Promise<string>;
const recordTables = ['watched','ratings','lists','settings'] as const;
function resetTables(selected:readonly ResetScope[]) {
  return recordTables.filter(table=>selected.includes(table) || (table === 'settings' && selected.includes('watched')));
}
function hasSettingsEdits(snapshot:DeviceSnapshot,scope:ResetScope) {
  const project = (rows:SettingRow[]) => writeCsv('settings',publicSettings(rows).filter(row=>settingSelected(row,[scope])));
  const from = (content:string|null|undefined) => project(content == null ? [] : settingsRows(content));
  const {base,pending} = fileState(snapshot,'settings');
  try {
    return project(snapshot.tables.settings) !== from(base?.content) ||
      (!!pending && from(pending.content) !== from(pending.targetContent)) ||
      (scope === 'watched' && !snapshot.tables.settings.some(row=>recentId(row.setting) !== null) &&
        (Boolean(snapshot.local.displacedRecentMark) || Array.isArray(snapshot.local.recentlyMarked) && snapshot.local.recentlyMarked.length > 0)) ||
      (scope === 'settings' && (snapshot.local.appearance !== undefined || snapshot.local.statisticsScope !== undefined));
  } catch { return true; }
}
function hasRecordEdits(snapshot:DeviceSnapshot,scope:ResetScope) {
  if (scope === 'backups') return false;
  if (scope !== 'settings' && !tableMatchesDropboxBase(snapshot,scope)) return true;
  return (scope === 'watched' || scope === 'settings') && hasSettingsEdits(snapshot,scope);
}

/** Adopt only categories reset since this device's last contact. Other offline edits still merge normally. */
export async function adoptReset(api:Port, store:DeviceStore, fence:Fence, session:ProviderSession, now:()=>number,
    migrateKeys?:(inspectOnly:boolean)=>Promise<void>,reviewLegacy?:ReviewLegacyClear):Promise<boolean> {
  if (fence.marker.pending.length) throw Error(pendingResetMessage);
  if (!fence.revision) return false;
  const header = await store.dropboxResetSnapshot();
  if (header.local.syncAccountId !== session.accountId || header.local.dropboxSession?.instanceId !== session.instanceId ||
      now() >= session.signInDeadline) throw new StaleSnapshotError();
  const stored = header.local.dropboxResetSeen as ObservedReset|undefined;
  const previous = stored?.accountId === session.accountId ? stored : undefined;
  const seen = previous?.generations ?? {};
  checkResetHistory(fence,{seen:!!previous,...previous});
  const selected = scopes.filter(s=>fence.marker.generations[s] && fence.marker.generations[s] !== seen?.[s]);
  if (!selected.length) {
    if (fence.marker.version === 2 && previous?.format !== 2) {
      await checkResetEpoch(api,resetEpoch(fence),true);
      await store.commit(header.revision,{local:{dropboxResetSeen:{...previous,accountId:session.accountId,generations:seen,
        ancestry:fence.marker.ancestry,format:2}}},{syncWrite:true,current:()=>now() < session.signInDeadline});
    } else if (!previous) await store.rememberDropboxMarker(session,()=>now() < session.signInDeadline);
    return false;
  }
  const snapshot = await store.snapshot();
  if (snapshot.revision !== header.revision || snapshot.local.syncAccountId !== session.accountId ||
      snapshot.local.dropboxSession?.instanceId !== session.instanceId || now() >= session.signInDeadline) throw new StaleSnapshotError();
  const ambiguous = selected.filter(scope=>!fence.marker.ancestry?.[scope]?.includes(seen[scope] ?? null));
  const atRisk = ambiguous.filter(scope=>hasRecordEdits(snapshot,scope));
  const legacyKeys = (ambiguous.includes('settings') || selected.includes('watched')) &&
    typeof store.legacyProviderSettings === 'function' && await hasUnmigratedProviderKeys(store);
  if (ambiguous.includes('settings') && legacyKeys && !atRisk.includes('settings')) atRisk.push('settings');
  const keep:ResetScope[] = [];
  const reviewed = new Map<string,string|null>();
  if (atRisk.length) {
    const deferred = 'Dropbox clear review paused. Sync again to choose which copy to keep.';
    if (!reviewLegacy) throw Error(deferred);
    const localEvidence = [];
    for (const table of resetTables(atRisk)) {
      const file = await api.download(filePath(table));
      if (file) { const issue = backupFileIssue(table,file.bytes); if (issue) throw Error(issue); }
      reviewed.set(table,file?.metadata.rev ?? null);
      const {base,pending} = fileState(snapshot,table);
      const content = table === 'settings'
        ? writeCsv('settings',publicSettings(snapshot.tables.settings).filter(row=>settingSelected(row,atRisk)))
        : writeCsv(table,snapshot.tables[table]);
      localEvidence.push([table,base?.revision,pending?.targetRevision,pending?.clientModified,await dropboxContentHash(content)]);
    }
    const local = snapshot.local;
    const evidence = await dropboxContentHash(JSON.stringify([resetEpoch(fence),[...reviewed],atRisk,localEvidence,
      atRisk.includes('watched') && [Array.isArray(local.recentlyMarked) && local.recentlyMarked.filter(Number.isSafeInteger),
        Number.isSafeInteger(local.displacedRecentMark) && local.displacedRecentMark],
      atRisk.includes('settings') && [typeof local.appearance === 'string' && local.appearance,
        typeof local.statisticsScope === 'string' && local.statisticsScope,legacyKeys && snapshot.revision.toString()]]));
    const decision = await reviewLegacy(atRisk,evidence);
    if (decision !== 'device' && decision !== 'dropbox') throw Error(deferred);
    if (decision === 'device') keep.push(...atRisk);
    await checkResetRevision(api,fence.revision,staleSyncReview);
    if ((await store.snapshot()).revision !== snapshot.revision || now() >= session.signInDeadline) throw new StaleSnapshotError();
  }
  if ((selected.includes('watched') && !selected.includes('settings') || keep.includes('settings')) && migrateKeys && legacyKeys) {
    for (const [table,rev] of reviewed) if (((await api.download('/'+table+'.csv'))?.metadata.rev ?? null) !== rev) throw changed(staleSyncReview);
    await migrateKeys(true);
    return adoptReset(api,store,fence,session,now,undefined,reviewLegacy);
  }
  const retired = {...previous?.retired};
  const ancestry = {...previous?.ancestry,...fence.marker.ancestry};
  for (const scope of selected) {
    const superseded = seen[scope];
    if (superseded) {
      const known = new Set([...(retired[scope] ?? []),superseded,...(previous?.ancestry?.[scope] ?? []).filter(id=>id !== null)]);
      retired[scope] = [...known];
    }
    if (!fence.marker.ancestry?.[scope]) delete ancestry[scope];
  }
  const observation:ObservedReset = {accountId:session.accountId,generations:fence.marker.generations,retired,ancestry,
    format:fence.marker.version === 2 ? 2 : undefined};
  const patch:DeviceChanges = {local:{dropboxResetSeen:observation}};
  const replace:NonNullable<DeviceChanges['replace']> = {}, sync:NonNullable<DeviceChanges['sync']> = {}, removeLocal:string[] = [];
  for (const table of resetTables(selected)) {
    const file = await api.download(filePath(table));
    if (reviewed.has(table) && (file?.metadata.rev ?? null) !== reviewed.get(table)) throw changed(staleSyncReview);
    const previousState = fileState(snapshot,table);
    if (file) { const issue = backupFileIssue(table,file.bytes); if (issue) throw Error(issue); }
    let content:string;
    if (table === 'settings') {
      const rows = file ? publicSettings(settingsRows(file.bytes)) : [];
      content = writeCsv('settings',rows);
      const useLocal = (row:SettingRow) => settingSelected(row,keep);
      const chosen = [...rows.filter(row=>!useLocal(row)),...snapshot.tables.settings.filter(useLocal)];
      if (!(selected.includes('watched') && selected.includes('settings'))) {
        const cleared = rows.filter(row=>settingSelected(row,selected));
        const adopt = (items:SettingRow[]) => [...publicSettings(items).filter(row=>!settingSelected(row,selected)),...cleared];
        const project = (csv:string) => writeCsv('settings',adopt(settingsRows(csv)));
        const {base,pending} = previousState;
        // Keep the other category's own edit history. The ordinary sync can still inspect the
        // original upload's keyed hash, choose the right base, and ask about ambiguous changes.
        replace.settings = [...snapshot.tables.settings.filter(row=>!settingSelected(row,selected)),...chosen.filter(row=>settingSelected(row,selected))];
        sync.settings = {...previousState,base:base && {...base,content:project(base.content)},
          pending:pending && {...pending,content:project(pending.content),
            targetContent:pending.targetContent === null ? null : project(pending.targetContent),inspectOnly:true}};
        continue;
      }
      replace.settings = chosen;
    } else {
      const rows = file ? readCsv(table,file.bytes).rows : [];
      content = writeCsv(table,rows);
      if (!keep.includes(table)) Object.assign(replace,{[table]:rows});
    }
    sync[table] = {base:file ? {revision:file.metadata.rev,content} : null,pending:null,lastClientModified:previousState.lastClientModified};
    removeLocal.push(canceledKey(table));
  }
  if (selected.includes('watched') && !keep.includes('watched')) removeLocal.push('recentlyMarked','displacedRecentMark');
  const clearSettings = selected.includes('settings') && !keep.includes('settings');
  if (clearSettings) removeLocal.push('appearance','statisticsScope');
  if (selected.some(s=>s === 'watched' || s === 'ratings' || s === 'lists')) {
    const ids = new Set([...(replace.watched ?? snapshot.tables.watched),...(replace.ratings ?? snapshot.tables.ratings),
      ...(replace.lists ?? snapshot.tables.lists).filter(row => !isListDeclaration(row))].map(row=>row.show_id));
    replace.shows = snapshot.tables.shows.filter(row=>ids.has(row.show_id));
    removeLocal.push('dropboxShowsHash');
  }
  if (reviewed.size) await checkResetRevision(api,fence.revision,staleSyncReview);
  else await checkResetEpoch(api,resetEpoch(fence),true);
  const changes = sparseRecordPatch('watched',snapshot,{...patch,replace,sync,removeLocal},true);
  // A repopulated watch file can be large even on a device that had only a few episodes before the clear.
  // Keep mixed clears, pending uploads, and any changes to other rows together in the general transaction.
  const watches = changes.replace?.watched, receipt = sync.watched;
  if (watches && watches.length >= recordTransferWorkerMinimum && receipt?.base && store.installWatchDownload &&
      selected.length === 1 && selected[0] === 'watched' && observation.format === 2 &&
      !ambiguous.length && !legacyKeys && (!stored || stored.accountId === session.accountId) &&
      replace.shows?.length === snapshot.tables.shows.length) {
    const preferences = fileState(snapshot,'settings');
    const sameSettings = !preferences.pending && preferences.base?.content === sync.settings?.base?.content &&
      snapshot.tables.settings.every(row => Object.keys(row).length === 2) &&
      writeCsv('settings',replace.settings!) === writeCsv('settings',snapshot.tables.settings);
    if (sameSettings && tableMatchesDropboxBase(snapshot,'watched')) {
      const original = fileState(snapshot,'watched');
      const prior = original.base ? {count:snapshot.tables.watched.length,base:original.base,lastClientModified:original.lastClientModified} : undefined;
      await store.installWatchDownload(snapshot.revision,watches,receipt,session,() => now() < session.signInDeadline,prior,
        {before:stored ?? null,after:observation,initializeSettings:!Object.hasOwn(snapshot.sync,'settings')});
      return true;
    }
  }
  await store.commit(snapshot.revision,changes,
    {syncWrite:true,invalidateTmdbWork:selected.includes('watched') || selected.includes('settings'),
      current:()=>now() < session.signInDeadline,clearResetCredentials:clearSettings});
  if (clearSettings) store.clearProviderKeys();
  return true;
}
