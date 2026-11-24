import type { ProviderSession } from './provider-credentials.ts';
import { retainRecentMarks } from './watch-record.ts';
import { csvColumns, readCsv } from './csv.ts';
import { records, decodeInput } from './csv-format.ts';
import { csvSelectionLimits } from './import-limits.ts';
import { mergeRows } from './merge.ts';
import { mergeWatched, type IdentityReview, type IdentityAssignment } from './watch-merge.ts';
import { isListDeclaration, rowKey, type RecordTables } from './model.ts';
import { StaleSnapshotError, type DeviceSnapshot, type DeviceStore } from './storage.ts';
import type { DropboxIdentity } from './dropbox-auth.ts';
import { mergedTables, tableMatchesDropboxBase } from './dropbox-sync-file.ts';

const required = { watched:['show_id','season','episode','times_watched'], ratings:['show_id','rating'], lists:['list','show_id'] };
type Table = keyof typeof required;
export interface HandInput { tables:Partial<Pick<RecordTables,Table>>; notes:string[] }
type Resolve = (review:IdentityReview)=>Promise<readonly IdentityAssignment[]|null>;
interface ApprovedMapping { inputs:string; assignments:readonly IdentityAssignment[] }

export async function readHandInputs(files:readonly File[]):Promise<HandInput> {
  const limits = csvSelectionLimits(files);
  const input:HandInput = { tables:{}, notes:[] };
  const groups = new Map<Table,{file:File; bytes:Uint8Array}[]>();
  for (const file of files) {
    let bytes: Uint8Array;
    try { bytes = new Uint8Array(await file.arrayBuffer()); }
    catch {
      input.notes.push(file.name + ' · Could not read this file. It was left out.');
      continue;
    }
    const decoded = decodeInput(bytes);
    const first = records(decoded.text, !decoded.error, limits.maxFields).next().value;
    const header = first && 'fields' in first ? first.fields : [];
    const candidates = (Object.keys(required) as Table[]).filter(name => required[name].every(key => header?.includes(key)));
    if (candidates.length !== 1) {
      const issue = decoded.error ?? (first && 'reason' in first ? first : undefined);
      input.notes.push(file.name + ' · ' + (issue ? 'line ' + issue.line + ' · ' + issue.reason :
        'The file could not be identified as one record table.'));
      continue;
    }
    const table = candidates[0];
    const group = groups.get(table) ?? [];
    group.push({ file,bytes }); groups.set(table,group);
  }
  for (const [table, group] of groups) {
    if (group.length !== 1) { input.notes.push(group.map(v=>v.file.name).join(', ') + ' · Multiple files match ' + table + '. All were left out.'); continue; }
    const {file,bytes} = group[0];
    const result = readCsv(table,bytes,limits);
    for (const finding of result.findings) {
      const column = finding.field === undefined ? '' : ' “' + finding.field + '”';
      const consequence = finding.kind === 'unknown' && !result.stopped ? ' will be dropped.' : '';
      input.notes.push(file.name + ' · line ' + finding.line + ' · ' + finding.reason + column + consequence);
    }
    if (!result.stopped) Object.assign(input.tables,{ [table]:result.rows });
  }
  return input;
}

export async function planHandMerge(input:HandInput, snapshot:DeviceSnapshot, resolve?:Resolve, mapping?:ApprovedMapping) {
  const notes = [...input.notes], actions:string[] = [];
  const replace:Partial<RecordTables> = {};
  for (const table of ['watched','ratings','lists'] as const) {
    if (!input.tables[table]) continue;
    let rows:RecordTables[Table];
    if (table === 'watched') {
      const versions = { recordVersion:snapshot.revision, baseRevision:null, remoteRevision:null };
      let result = mergeWatched(null,snapshot.tables.watched,input.tables.watched!,{ versions });
      if (result.status === 'identity-review') {
        const inputs = JSON.stringify(result.inputs);
        const assignments = mapping?.inputs === inputs ? mapping.assignments : await resolve?.(result);
        if (!assignments) throw Error('Episode mapping was canceled.');
        mapping = {inputs,assignments};
        result = mergeWatched(null,snapshot.tables.watched,input.tables.watched!,{versions,resolution:{token:result.token,assignments}});
      }
      if (result.status !== 'merged') throw Error('Correct the conflicting episode identities before merging.');
      rows = result.rows;
    } else {
      const result = mergeRows(table,null,snapshot.tables[table],input.tables[table]!);
      rows = result.rows as RecordTables[typeof table];
      for (const clash of result.clashes) if ('mine' in clash) {
        const label = 'Show ' + clash.show_id + ' · keep rating ' + clash.mine + ' (selected file ' + clash.theirs + ')';
        notes.push(label); actions.push(label);
      }
    }
    const before = new Map(snapshot.tables[table].map(row => [rowKey(table,row),row]));
    const values = (r:RecordTables[Table][number]) => csvColumns[table].map(c => Reflect.get(r,c));
    let added = 0, raised = 0;
    for (const row of rows) {
      const key = rowKey(table,row), old = before.get(key);
      before.delete(key);
      if (!old) {
        added++;
        if ('list' in row && isListDeclaration(row)) notes.push('Keep list “' + row.list + '” even when empty.');
        else notes.push('Add ' + (row.show || 'Show ' + row.show_id) + ('list' in row ? ' to ' + row.list :
          'rating' in row ? ' · rating ' + row.rating : ' · S' + row.season + ' E' + row.episode + ', ' + row.times_watched + ' plays'));
      } else if ('times_watched' in row && 'times_watched' in old && row.times_watched > old.times_watched) {
        raised++;
        notes.push((row.show || 'Show ' + row.show_id) + ' · S' + row.season + ' E' + row.episode + ' · ' +
          old.times_watched + ' → ' + row.times_watched + ' plays');
      }
      if (old && 'episode_id' in row && 'episode_id' in old && old.episode_id !== row.episode_id) {
        notes.push((row.show || 'Show ' + row.show_id) + ' · S' + row.season + ' E' + row.episode +
          ' · episode ID ' + (old.episode_id ?? 'blank') + ' → ' + (row.episode_id ?? 'blank'));
      }
      const previous = old ? values(old) : null, next = values(row);
      if (JSON.stringify(previous) !== JSON.stringify(next)) actions.push(JSON.stringify([table,key,previous,next]));
    }
    for (const [key, old] of before) {
      if (!('episode_id' in old)) continue;
      notes.push((old.show || 'Show ' + old.show_id) + ' · S' + old.season + ' E' + old.episode +
        ' · old position removed (episode ID ' + (old.episode_id ?? 'blank') + ', ' + old.times_watched + ' plays).');
      actions.push(JSON.stringify([table,key,values(old),null]));
    }
    notes.push(table + '.csv · ' + added + ' rows added' + (table === 'watched' ? ', ' + raised + ' episode counts raised.' : '.'));
    Object.assign(replace,{ [table]:rows });
  }
  const session = snapshot.local.dropboxSession;
  return { replace, notes, mapping, signature:JSON.stringify(actions.sort()),
    accountId:snapshot.local.syncAccountId ?? null, instanceId:session?.instanceId ?? null };
}
export type HandPlan = Awaited<ReturnType<typeof planHandMerge>>;
type HandHooks = { preflight:(expected:DropboxIdentity)=>Promise<void>; backup:(expected:DropboxIdentity)=>Promise<void>;
  offerLocal?:(snapshot:DeviceSnapshot,plan:HandPlan)=>Promise<void>; confirm:(plan:HandPlan)=>Promise<boolean>; resolve?:Resolve; active?:()=>boolean };

/** The owner already approved the displayed plan. Every subsequent write uses the exact snapshot rechecked here. */
export async function applyHandMerge(store:DeviceStore,input:HandInput,approved:HandPlan,hooks:HandHooks):Promise<boolean> {
  if (store.role !== 'writer' || !Object.keys(input.tables).length) throw Error('Choose a readable record file in the writer tab.');
  function checkedBinding(accountId:unknown, session:ProviderSession|null):DropboxIdentity|null {
    if (accountId !== approved.accountId || (session?.instanceId ?? null) !== approved.instanceId ||
        (session ? session.accountId !== accountId || !(session.signInDeadline > Date.now()) : accountId !== null)) {
      throw Error('The Dropbox sign-in changed or ended. Open the files again.');
    }
    return session ? { accountId:session.accountId, instanceId:session.instanceId } : null;
  }
  for (;;) {
    if (hooks.active && !hooks.active()) return false;
    const state = await store.dropboxState();
    const binding = checkedBinding(state.accountId, state.session);
    if (binding) await hooks.preflight(binding);
    if (hooks.active && !hooks.active()) return false;
    const snapshot = await store.snapshot();
    const session = snapshot.local.dropboxSession;
    checkedBinding(snapshot.local.syncAccountId ?? null, session ?? null);
    if (binding && !mergedTables.every(table => tableMatchesDropboxBase(snapshot,table))) {
      throw Error('A file is still waiting to sync. Try the hand merge again after syncing.');
    }
    if (hooks.active && !hooks.active()) return false;
    const plan = await planHandMerge(input,snapshot,hooks.resolve,approved.mapping);
    const needsReview = plan.signature !== approved.signature;
    if (needsReview && !await hooks.confirm(plan)) return false;
    approved = plan;
    // Identity mapping and confirmation can both wait for an owner decision.
    const latest = await store.dropboxState();
    if (hooks.active && !hooks.active()) return false;
    checkedBinding(latest.accountId, latest.session);
    if (latest.revision !== snapshot.revision) continue;
    if (binding) await hooks.backup(binding);
    else await hooks.offerLocal?.(snapshot,plan);
    if (hooks.active && !hooks.active()) return false;
    try {
      await store.commit(snapshot.revision,retainRecentMarks(snapshot,{replace:plan.replace}), {
        current:() => (hooks.active?.() ?? true) && (!session || session.signInDeadline > Date.now()) });
      return true;
    } catch (error) {
      if (!(error instanceof StaleSnapshotError)) throw error;
    }
  }
}
