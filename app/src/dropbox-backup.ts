import { dropboxContentHash, type DropboxApi, type DropboxEntry, type DropboxFile, type DropboxFolder } from './dropbox-api.ts';
import type { MergeTable, TableName } from './model.ts';
import { readCsv } from './csv.ts';
import { settingsWithoutKeys } from './dropbox-provider-settings.ts';
import { parseDropboxMarker } from './dropbox-marker.ts';
import { isTemporaryDropboxFailure } from './dropbox-client.ts';
import { hasRepeatedEpisode } from './watch-identity.ts';
import { checkDropboxBytes, checkDropboxFile, dropboxFileLimit, DropboxLimitError, dropboxLimits } from './dropbox-limits.ts';

export const backupTables = ['watched', 'ratings', 'lists', 'shows', 'settings'] as const;
export const restorableTables = ['watched', 'ratings', 'lists', 'settings'] as const;
type Entry = { rev: string; hash: string; omitted?: true } | null;
type Entries = Record<string, Entry>;
type FilesPort = Pick<DropboxApi, 'list' | 'download' | 'createFolder' | 'upload' | 'delete' | 'reserveBackup'>;
type ReadPort = Pick<FilesPort, 'list' | 'download'>;
type BackupFolder = DropboxFolder & {contents?: DropboxEntry[]};
type ReadManifest = {file:Awaited<ReturnType<ReadPort['download']>>} | {error:unknown};
export interface BackupGeneration {
  folder: string;
  status: 'verified' | 'unverified' | 'incomplete' | 'legacy';
  modified: string;
  entries: Entries | null;
}
const filename = (table: TableName) => table + '.csv';
const filenames = backupTables.map(filename);
const backupNames = new Set([...filenames, 'completion.json']);
const sevenDays = 7 * 24 * 60 * 60 * 1000;
const indexThreshold = 8;
const errorKind = (error: unknown) => (error as { kind?: string } | null)?.kind;
const text = (bytes: Uint8Array) => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);

function manifest(bytes: Uint8Array): { entries: Entries; complete: boolean } | null {
  try {
    const parsed = parseDropboxMarker(text(bytes));
    if (parsed?.version !== 1 || !parsed.entries || typeof parsed.entries !== 'object' || Array.isArray(parsed.entries)) return null;
    const entries: Entries = {};
    for (const name of filenames) {
      const e = parsed.entries[name];
      if (e === null || (e && typeof e.rev === 'string' && e.rev && typeof e.hash === 'string' && /^[a-f0-9]{64}$/.test(e.hash) &&
          (e.omitted === undefined || (name === 'settings.csv' && e.omitted === true)))) {
        entries[name] = e;
      }
    }
    return { entries, complete: Object.keys(parsed.entries).length === filenames.length && Object.keys(entries).length === filenames.length };
  } catch { return null; }
}

async function listing(api: ReadPort, path: string, recursive = false, maxPages?:number) {
  try { return await api.list(path, recursive, {maxPages}); } catch (error) {
    if (errorKind(error) === 'not-found') return [];
    throw error;
  }
}
function directory(folder: string) {
  if (!folder || /[/\\\x00-\x1f]/.test(folder) || folder === '.' || folder === '..') throw Error('Invalid backup folder name.');
  return '/backups/' + folder;
}

function browsing(api: ReadPort, signal?: AbortSignal): ReadPort {
  if (!signal) return api;
  return {
    list: (path, recursive, options) => { signal.throwIfAborted(); return api.list(path, recursive, {...options,signal}); },
    async download(path) {
      signal.throwIfAborted();
      const file = await api.download(path,signal);
      signal.throwIfAborted();
      return file;
    },
  };
}

function isBackupFile(item:DropboxEntry) {
  return item.kind === 'file' && item.size > 0 && backupNames.has(item.name.toLowerCase());
}

async function inspect(api: ReadPort, folder: string, mode:'browse'|'verify'|'restore', directoryContents?: DropboxEntry[],prefetched?:ReadManifest) {
  const dir = directory(folder);
  const contents = directoryContents ?? await listing(api, dir);
  const readCopies = mode !== 'browse';
  const tables = mode === 'restore' ? restorableTables : backupTables;
  const listed = new Map(contents.map(item => [item.name.toLowerCase(), item]));
  let storedBytes = 0;
  for (const name of [...tables.map(filename), 'completion.json']) {
    const item = listed.get(name);
    if (item?.kind !== 'file') continue;
    checkDropboxBytes(item.size, dropboxFileLimit(dir + '/' + name));
    if (name !== 'shows.csv' && name !== 'completion.json') storedBytes += item.size;
  }
  checkDropboxBytes(storedBytes, dropboxLimits.restoreBytes);
  const markerIsFolder = listed.get('completion.json')?.kind === 'folder';
  if (prefetched && 'error' in prefetched) throw prefetched.error;
  const marker = markerIsFolder || (!contents.length && !readCopies) ? null :
    prefetched ? prefetched.file : await api.download(dir + '/completion.json');
  if (marker) checkDropboxBytes(marker.bytes.byteLength, dropboxLimits.smallReply);
  const parsed = marker && manifest(marker.bytes), entries = parsed?.entries ?? null;
  let verified = parsed?.complete === true;
  const onlyBackupFiles = contents.every(file => file.kind === 'file' &&
    (file.name === 'completion.json' || filenames.includes(file.name)));
  const copies = new Map<TableName, Uint8Array>();
  let receivedBytes = 0;
  const revisions = new Map<string, string>();
  if (marker) revisions.set('completion.json', marker.metadata.rev);
  let latest = '';
  const noteTime = (s: string) => { if (!latest || Date.parse(s) > Date.parse(latest)) latest = s; };
  for (const file of contents) if (file.kind === 'file') noteTime(file.serverModified);
  for (const table of tables) {
    const name = filename(table), entry = entries?.[name];
    const item = listed.get(name);
    if (entry?.omitted) {
      // The manifest promises there is no settings copy. A listing can lag a direct read.
      if (item?.kind === 'folder' || await api.download(dir + '/' + name)) verified = false;
      continue;
    }
    if (item?.kind === 'folder') {
      verified = false;
      continue;
    }
    // Dropbox supplies the content hash for listed files. Browsing backup dates
    // does not need to transfer every historical copy of the watch record.
    if (!readCopies && (!entries || (entry && item?.kind === 'file' && item.contentHash === entry.hash))) continue;
    const copy = await api.download(dir + '/' + name);
    if (!copy) {
      if (entry) verified = false;
      continue;
    }
    noteTime(copy.metadata.serverModified);
    checkDropboxFile(dir + '/' + name, copy.bytes);
    if (table !== 'shows') {
      receivedBytes += copy.bytes.byteLength;
      checkDropboxBytes(receivedBytes, dropboxLimits.restoreBytes);
    }
    const hash = await dropboxContentHash(copy.bytes);
    if (hash !== copy.metadata.contentHash || (entries && (!entry || entry.hash !== hash))) {
      verified = false;
    } else if (!marker || entries) {
      if (mode === 'restore' && table !== 'shows') copies.set(table, copy.bytes);
      revisions.set(name, copy.metadata.rev);
    }
  }
  const status = verified ? 'verified' : marker || markerIsFolder ? 'unverified' : /^\d{4}-\d{2}-\d{2}-.+$/.test(folder) ? 'incomplete' : 'legacy';
  const generation: BackupGeneration = { folder, status,
    modified: verified ? marker!.metadata.serverModified : latest, entries: parsed?.complete ? entries : null };
  const hasContents = contents.some(isBackupFile);
  return { generation, copies, markerHash: marker?.metadata.contentHash, onlyBackupFiles, revisions, hasContents };
}

async function backupFolders(api:ReadPort, browse = false):Promise<BackupFolder[]> {
  const folders = (await listing(api, '/backups')).filter(entry => entry.kind === 'folder');
  const mustCount = folders.length >= dropboxLimits.backupFolders;
  if (!mustCount && (!browse || folders.length < indexThreshold)) return folders;
  return indexBackupFolders(api,folders,mustCount);
}

async function indexBackupFolders(api:ReadPort, folders:DropboxFolder[], mustCount:boolean):Promise<BackupFolder[]> {
  // Retention leaves empty directories. One bounded listing supplies the direct children
  // of historical folders; markers and uncertain copies still require direct reads.
  let tree: DropboxEntry[];
  // Up to 127 ordinary generations (folder, marker and five CSVs) fit in two 500-entry pages.
  // A large unrelated subtree should not turn the optional fast path into a lengthy recursive scan.
  try { tree = await listing(api, '/backups', true, mustCount ? undefined : 2); }
  catch (error) {
    // Unrelated nested files can exceed the recursive limit. Small histories can still be read individually.
    if (!mustCount && error instanceof DropboxLimitError) return folders;
    throw error;
  }
  const indexed = new Map<string, DropboxFolder & {contents:DropboxEntry[]}>();
  for (const item of tree) {
    const path = item.path.toLowerCase();
    if (item.kind === 'folder' && path === '/backups/' + item.name.toLowerCase()) indexed.set(path,{...item,contents:[]});
  }
  const missing = new Map(folders.filter(folder => !indexed.has(folder.path.toLowerCase())).map(folder=>[folder.path.toLowerCase(),folder]));
  for (const item of tree) {
    const path = item.path.toLowerCase();
    const parent = path.slice(0,path.lastIndexOf('/')), folder = indexed.get(parent);
    if (folder) folder.contents.push(item);
    else if (mustCount && parent.lastIndexOf('/') === '/backups'.length && isBackupFile(item)) {
      // A child alone still identifies a directory that needs a direct read before applying the safety limit.
      const display = item.path.slice(0,item.path.lastIndexOf('/'));
      missing.set(parent,{kind:'folder',path:display,name:display.slice(display.lastIndexOf('/')+1)});
    }
  }
  if (!mustCount) {
    const visible:BackupFolder[] = [];
    for (const folder of folders) {
      const fromTree = indexed.get(folder.path.toLowerCase());
      // A recursive page can lag the root listing. Inspect the missing directory directly.
      if (!fromTree || fromTree.contents.some(isBackupFile)) visible.push(fromTree ?? folder);
    }
    return visible;
  }
  const nonempty:BackupFolder[] = [...indexed.values()].filter(folder => folder.contents.some(isBackupFile));
  const checkCount = () => {
    if (nonempty.length > dropboxLimits.backupFolders) throw new DropboxLimitError('Dropbox has more than 128 nonempty backup folders. Move older folders outside backups to continue.');
  };
  checkCount();
  if (missing.size > dropboxLimits.backupFolders) throw new DropboxLimitError('The Dropbox listings disagree on more than 128 backup folders. Refresh backups and try again.');
  for (const folder of missing.values()) {
    const contents = await listing(api,directory(folder.name));
    if (contents.some(isBackupFile)) {
      nonempty.push({...folder,contents});
      checkCount();
    }
  }
  return nonempty;
}

async function listedGeneration(api:ReadPort, folder:string, contents?:DropboxEntry[],marker?:ReadManifest):Promise<BackupGeneration|null> {
  try {
    const checked = await inspect(api, folder, 'browse', contents,marker);
    return checked.hasContents ? checked.generation : null;
  } catch (error) {
    if (!(error instanceof DropboxLimitError)) throw error;
    return {folder,status:'unverified',modified:'',entries:null};
  }
}

async function readListedManifests(api:ReadPort,folders:BackupFolder[],signal?:AbortSignal) {
  signal?.throwIfAborted();
  const batch = new AbortController(), stop = () => batch.abort();
  signal?.addEventListener('abort',stop,{once:true});
  try {
    return await Promise.all(folders.map(async(folder):Promise<ReadManifest|undefined> => {
      const known = folder.contents?.find(file => file.name.toLowerCase() === 'completion.json');
      if (known?.kind !== 'file' || known.size > dropboxLimits.smallReply) return;
      try { return {file:await api.download(directory(folder.name)+'/completion.json',batch.signal)}; }
      catch (error) {
        if (error instanceof DropboxLimitError) return {error};
        throw error;
      }
    }));
  } finally {
    stop();
    signal?.removeEventListener('abort',stop);
  }
}

export async function listBackups(api: ReadPort, signal?: AbortSignal): Promise<BackupGeneration[]> {
  const reads = browsing(api,signal), root = await backupFolders(reads,true);
  const generations: BackupGeneration[] = [];
  // Only the small completion manifests overlap. Large CSVs and uncertain files are
  // still checked one at a time under the original per-generation limits.
  for (let first=0;first<root.length;first+=3) {
    const batch = root.slice(first,first+3);
    const markers = await readListedManifests(api,batch,signal);
    signal?.throwIfAborted();
    for (const [i,folder] of batch.entries()) {
      const generation = await listedGeneration(reads,folder.name,folder.contents,markers[i]);
      if (generation) generations.push(generation);
    }
  }
  return generations.sort((a, b) => Number(b.status === 'verified') - Number(a.status === 'verified') ||
    (Date.parse(b.modified) || 0) - (Date.parse(a.modified) || 0) || (a.folder < b.folder ? 1 : a.folder > b.folder ? -1 : 0));
}

export function backupFileIssue(table: MergeTable, input: string | Uint8Array): string | null {
  const watched = table === 'watched' ? readCsv('watched', input) : null;
  const checked = watched ?? readCsv(table, input);
  if (checked.stopped || checked.findings.length || checked.schema !== 'known') return 'The selected ' + table + '.csv is unreadable.';
  if (watched && hasRepeatedEpisode(watched.rows)) return 'The selected watched.csv gives an episode more than one position.';
  return null;
}

export async function openBackup(api: ReadPort, folder: string, signal?: AbortSignal): Promise<ReadonlyMap<MergeTable, string>> {
  const { copies } = await inspect(browsing(api,signal), folder, 'restore');
  const files = new Map<MergeTable, string>();
  for (const table of restorableTables) {
    const bytes = copies.get(table);
    if (!bytes) continue;
    copies.delete(table);
    if (!backupFileIssue(table, bytes)) {
      files.set(table, table === 'settings' ? settingsWithoutKeys(bytes) : text(bytes));
    }
  }
  return files;
}

async function reserve(api: FilesPort, now: number, id: () => string) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const folder = new Date(now).toISOString().slice(0, 10) + '-' + id(), dir = directory(folder);
    try { await api.createFolder(dir); return { folder, dir }; } catch (error) {
      if (errorKind(error) !== 'conflict') throw error;
    }
  }
  throw Error('Could not reserve a new Dropbox backup folder.');
}

/** A generation exists only after the five individually checked reads and the final marker. */
export async function writeBackup(api: FilesPort, options: {
  weekly?: boolean; beforeRestore?: boolean; now?: number; id?: () => string;
} = {}): Promise<BackupGeneration | null> {
  const now = options.now ?? Date.now();
  const folders = await backupFolders(api);
  if (options.weekly) {
    // Try recent date-prefixed names first. Only the verified marker's server timestamp decides freshness.
    folders.sort((a, b) => a.name < b.name ? 1 : a.name > b.name ? -1 : 0);
    const recent = (g:BackupGeneration|null) => g?.status === 'verified' && now - Date.parse(g.modified) <= sevenDays;
    const [first,...rest] = folders;
    if (first && recent(await listedGeneration(api,first.name))) return null;
    // An overdue account may have many retired folders. Reuse the index after the ordinary newest-folder check.
    const remaining = rest.length >= indexThreshold && !first.contents ? await indexBackupFolders(api,rest,false) : rest;
    for (const folder of remaining) if (recent(await listedGeneration(api,folder.name,folder.contents))) return null;
  }
  if (folders.length >= dropboxLimits.backupFolders) throw new DropboxLimitError('Dropbox already has 128 backup folders. Move older folders outside backups before creating another.');
  try { await api.createFolder('/backups'); } catch (error) {
    if (errorKind(error) !== 'conflict') throw error;
  }
  const { folder, dir } = await reserve(api, now, options.id ?? (() => crypto.randomUUID()));
  const release = await api.reserveBackup?.(folder);
  const entries: Entries = {};
  let restorableBytes = 0;
  for (const name of filenames) {
    const source = await api.download('/' + name);
    if (!source) { entries[name] = null; continue; }
    checkDropboxFile('/' + name, source.bytes);
    const hash = await dropboxContentHash(source.bytes);
    if (hash !== source.metadata.contentHash) throw Error('Dropbox backup source did not match its content hash.');
    let bytes = source.bytes;
    if (name === 'settings.csv') {
      try {
        bytes = new TextEncoder().encode(settingsWithoutKeys(source.bytes));
      } catch {
        // An unreadable file can contain credentials anywhere. Its revision still
        // pins restore preflight while other record files remain recoverable.
        entries[name] = { rev:source.metadata.rev, hash, omitted:true };
        continue;
      }
    }
    if (name !== 'shows.csv') {
      restorableBytes += bytes.byteLength;
      checkDropboxBytes(restorableBytes, dropboxLimits.restoreBytes);
    }
    const copyHash = bytes === source.bytes ? hash : await dropboxContentHash(bytes);
    const copy = await api.upload(dir + '/' + name, bytes, { mode: 'add' });
    if (copy.contentHash !== copyHash) throw Error('Dropbox backup copy did not match its source.');
    entries[name] = { rev: source.metadata.rev, hash:copyHash };
  }
  const contents = JSON.stringify({ version: 1, entries }) + '\n';
  const markerHash = await dropboxContentHash(contents);
  let marker: DropboxFile;
  try { marker = await api.upload(dir + '/completion.json', contents, { mode: 'add' }); }
  catch (error) {
    if (errorKind(error) === 'conflict') throw error;
    const received = await api.download(dir + '/completion.json');
    if (!received || received.metadata.contentHash !== markerHash || await dropboxContentHash(received.bytes) !== markerHash) throw error;
    marker = received.metadata;
  }
  if (marker.contentHash !== markerHash) throw Error('Dropbox returned a different backup manifest.');
  const confirmed = await inspect(api, folder, 'verify');
  if (confirmed.markerHash !== markerHash || confirmed.generation.status !== 'verified') throw Error('The completed Dropbox backup no longer matches its source.');
  // Every immutable add has been acknowledged. An abandoned or uncertain writer stays reserved for Clear Backups.
  await release?.();
  if (!options.beforeRestore) {
    const completed = (await listBackups(api).catch(error => {
      // Retention is optional after verification. Identity and format errors still reach the caller.
      if (isTemporaryDropboxFailure(error)) return [];
      throw error;
    })).filter(g => g.status === 'verified');
    for (const old of completed.slice(10)) {
      try {
        const checked = await inspect(api, old.folder, 'verify');
        if (checked.generation.status === 'verified' && checked.onlyBackupFiles && checked.generation.modified === old.modified) {
          const dir = directory(old.folder);
          const latest = await api.list(dir);
          const unchanged = latest.length === checked.revisions.size && latest.every(file => file.kind === 'file' &&
            checked.revisions.get(file.name) === file.rev && (file.name !== 'completion.json' || file.serverModified === old.modified));
          if (unchanged) {
            // The marker is inserted first. Retire its exact revision before removing its verified copies.
            // Dropbox has no conditional folder delete. New files and replacement revisions must survive.
            for (const [name, revision] of checked.revisions) await api.delete(dir + '/' + name, revision);
          }
        }
      } catch {
        // The new generation is complete. Any partially retired copies remain available individually.
        break;
      }
    }
  }
  return { folder, status: 'verified', modified: marker.serverModified, entries };
}
