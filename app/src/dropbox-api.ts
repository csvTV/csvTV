import type { DropboxAuth, DropboxIdentity } from './dropbox-auth.ts';
import { DropboxError, jsonObject } from './dropbox-client.ts';
import type { DropboxRequest } from './dropbox-client.ts';
import { checkDropboxBytes, checkDropboxFile, dropboxFileLimit, dropboxLimits, DropboxLimitError } from './dropbox-limits.ts';

export interface DropboxFolder { kind: 'folder'; path: string; name: string }
export interface DropboxFile {
  kind: 'file'; path: string; name: string; rev: string; id?:string;
  contentHash: string; serverModified: string; clientModified: string; size: number;
}
type UnhashedFile = Omit<DropboxFile, 'contentHash'> & { contentHash: null };
export type DropboxEntry = DropboxFile | DropboxFolder | UnhashedFile;
export interface DropboxUpload { mode: 'add' | 'update' | 'overwrite'; revision?: string; clientModified?: string }

function pathname(input: string, rootAllowed = false): string {
  if (rootAllowed && (input === '' || input === '/')) return '';
  const path = input.startsWith('/') ? input : '/' + input;
  if (/[\\\x00-\x1f]/.test(path) || path.slice(1).split('/').some(s => !s || s === '.' || s === '..')) throw new DropboxError('failed');
  return path;
}
function field(object: Record<string, unknown>, key: string): string {
  const value = object[key];
  if (typeof value !== 'string' || !value) throw new DropboxError('failed');
  return value;
}
/** Revision evidence needs a real calendar date, time of day and explicit zone. */
export function isDropboxTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
      !Number.isFinite(Date.parse(value))) return false;
  const date = value.slice(0,10);
  return new Date(date + 'T00:00:00Z').toISOString().startsWith(date + 'T');
}
function metadata(value: unknown, expected?: string): DropboxEntry {
  if (!value || typeof value !== 'object') throw new DropboxError('failed');
  const raw = value as Record<string, unknown>;
  const path = pathname(field(raw, raw.path_display ? 'path_display' : 'path_lower'));
  const name = field(raw, 'name');
  if (name.includes('/') || path.toLowerCase().split('/').pop() !== name.toLowerCase() ||
    (expected && path.toLowerCase() !== expected.toLowerCase())) throw new DropboxError('failed');
  if (raw['.tag'] === 'folder') return { kind: 'folder', path, name };
  if (raw['.tag'] !== undefined && raw['.tag'] !== 'file') throw new DropboxError('failed');
  const serverModified = field(raw, 'server_modified'), clientModified = field(raw, 'client_modified');
  const contentHash = raw.content_hash;
  if (!isDropboxTimestamp(serverModified) || !isDropboxTimestamp(clientModified) ||
    (contentHash !== undefined && (typeof contentHash !== 'string' || !/^[0-9a-f]{64}$/.test(contentHash))) ||
    typeof raw.size !== 'number' || !Number.isSafeInteger(raw.size) || raw.size < 0) {
    throw new DropboxError('failed');
  }
  return { kind: 'file', path, name, rev: field(raw, 'rev'), ...(typeof raw.id === 'string' && raw.id && {id:raw.id}),
    contentHash:contentHash ?? null, serverModified, clientModified, size: raw.size };
}
function file(value: unknown, expected: string) {
  const entry = metadata(value, expected);
  if (entry.kind !== 'file' || entry.contentHash === null) throw new DropboxError('failed');
  return entry;
}
function bytes(input: string | Uint8Array): Uint8Array<ArrayBuffer> {
  return typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input);
}
export async function dropboxContentHash(input: string | Uint8Array): Promise<string> {
  return hashSnapshot(bytes(input));
}
async function hashSnapshot(data: Uint8Array<ArrayBuffer>): Promise<string> {
  const block = 4 * 1024 * 1024;
  const hashes = new Uint8Array(Math.ceil(data.length / block) * 32);
  for (let offset = 0, index = 0; offset < data.length; offset += block, index += 32) {
    const digest = await crypto.subtle.digest('SHA-256', data.subarray(offset, offset + block));
    hashes.set(new Uint8Array(digest), index);
  }
  const final = await crypto.subtle.digest('SHA-256', hashes);
  return Array.from(new Uint8Array(final), n => n.toString(16).padStart(2, '0')).join('');
}
// Dropbox-API-Arg is an HTTP header. Escape UTF-16 code units before passing it to XHR.
function argument(value: object) {
  return JSON.stringify(value).replace(/[^\x20-\x7e]/g, ch => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
}
function page(raw: Record<string, unknown>) {
  if (!Array.isArray(raw.entries) || typeof raw.has_more !== 'boolean') throw new DropboxError('failed');
  return { entries: raw.entries, more: raw.has_more };
}

function listingBudget(maxPages = dropboxLimits.pages) {
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) throw new DropboxLimitError('Invalid Dropbox listing page limit.');
  const limit = Math.min(maxPages,dropboxLimits.pages);
  let pages = 0, bytes = 0, entries = 0;
  return {
    next() {
      if (++pages > limit) throw new DropboxLimitError('The Dropbox listing exceeds ' + limit + ' pages.');
    },
    read(length:number) {
      checkDropboxBytes(bytes += length,dropboxLimits.listingBytes);
    },
    rows(length:number) {
      if ((entries += length) > dropboxLimits.entries) throw new DropboxLimitError('The Dropbox listing exceeds 50,000 entries.');
    },
  };
}

export class DropboxApi {
  readonly #auth: Pick<DropboxAuth,'request'>;
  readonly #identity?: DropboxIdentity;
  readonly #beforeWrite?: () => Promise<void>;
  readonly reserveBackup?: (folder:string)=>Promise<()=>Promise<void>>;
  constructor(auth: Pick<DropboxAuth,'request'>, identity?: DropboxIdentity, beforeWrite?: () => Promise<void>,
      reserveBackup?: (folder:string)=>Promise<()=>Promise<void>>) {
    this.#auth = auth;
    this.#identity = identity && { accountId: identity.accountId, instanceId: identity.instanceId };
    this.#beforeWrite = beforeWrite;
    this.reserveBackup = reserveBackup;
  }
  async #rpc(endpoint: DropboxRequest['endpoint'], body: object, budget?: ReturnType<typeof listingBudget>, signal?:AbortSignal) {
    budget?.next();
    const reply = await this.#auth.request({ endpoint, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), readSignal:signal }, this.#identity);
    budget?.read(reply.bytes.byteLength);
    return jsonObject(reply.bytes);
  }
  async list(folder = '', recursive = false, {signal,maxPages}:{signal?:AbortSignal;maxPages?:number} = {}): Promise<DropboxEntry[]> {
    signal?.throwIfAborted();
    const path = pathname(folder, true), seen = new Set<string>();
    const entries = new Map<string, DropboxEntry>();
    const budget = listingBudget(maxPages);
    let raw;
    try { raw = await this.#rpc('list', { path, recursive, limit:500 },budget,signal); }
    catch (error) {
      if (!path && error instanceof DropboxError && error.kind === 'not-found') return [];
      throw error;
    }
    while (true) {
      signal?.throwIfAborted();
      const current = page(raw);
      budget.rows(current.entries.length);
      for (const item of current.entries) {
        const entry = metadata(item);
        const child = entry.path.toLowerCase(), parent = path.toLowerCase();
        // A recursive listing can include the requested folder's own metadata.
        if (recursive && entry.kind === 'folder' && child === parent) continue;
        if (recursive ? !child.startsWith(parent + '/') : child.slice(0, child.lastIndexOf('/')) !== parent) throw new DropboxError('failed');
        entries.set(entry.path.toLowerCase(), entry);
      }
      if (!current.more) return [...entries.values()];
      const cursor = field(raw, 'cursor');
      if (seen.has(cursor)) throw new DropboxError('failed');
      seen.add(cursor);
      raw = await this.#rpc('continue', { cursor },budget,signal);
    }
  }
  async revisions(input: string, beforeRevision?:string, maximum = Infinity, through?: (file:DropboxFile) => boolean): Promise<DropboxFile[]> {
    if (maximum !== Infinity && (!Number.isSafeInteger(maximum) || maximum < 1)) throw new DropboxError('failed');
    const path = pathname(input), seen = new Set<string>(), result: DropboxFile[] = [];
    const budget = listingBudget();
    let before = beforeRevision;
    if (before) seen.add(before);
    while (true) {
      let raw;
      const limit = Math.min(100,maximum-result.length);
      try { raw = await this.#rpc('revisions', { path, mode: 'path', limit, before_rev: before },budget); }
      catch (error) {
        if (!before && error instanceof DropboxError && error.kind === 'not-found') return [];
        throw error;
      }
      const current = page(raw);
      if (current.entries.length > limit) throw new DropboxError('failed');
      budget.rows(current.entries.length);
      let found = false;
      for (const entry of current.entries) {
        const revision=file(entry,path);
        if (seen.has(revision.rev)) throw new DropboxError('failed');
        seen.add(revision.rev);
        result.push(revision);
        if (through?.(revision)) found = true;
      }
      // Preserve the complete evidence and pagination cursor of the page containing the revision.
      if (found || !current.more || result.length===maximum) return result;
      const next = result.at(-1)?.rev;
      if (!current.entries.length || !next) throw new DropboxError('failed');
      before = next;
    }
  }
  async download(input: string, signal?:AbortSignal): Promise<{ metadata: DropboxFile; bytes: Uint8Array } | null> {
    const path = pathname(input);
    let reply;
    try { reply = await this.#auth.request({ endpoint: 'download', downloadLimit:dropboxFileLimit(path),
      headers: { 'Dropbox-API-Arg': argument({ path }) }, readSignal:signal }, this.#identity); }
    catch (error) {
      if (error instanceof DropboxError && error.kind === 'not-found') return null;
      throw error;
    }
    let value;
    try { value = JSON.parse(reply.metadata ?? ''); } catch { throw new DropboxError('failed'); }
    const item = file(value, path);
    const limit = dropboxFileLimit(path);
    checkDropboxBytes(item.size,limit);
    checkDropboxBytes(reply.bytes.byteLength,limit);
    if (item.size !== reply.bytes.byteLength) throw new DropboxError('failed');
    const verified = bytes(reply.bytes);
    checkDropboxFile(path,verified);
    if (item.contentHash !== await hashSnapshot(verified)) throw new DropboxError('failed');
    return { metadata: item, bytes: verified };
  }
  async upload(input: string, payload: string | Uint8Array, options: DropboxUpload): Promise<DropboxFile> {
    const path = pathname(input);
    if (options.mode === 'update' && !options.revision) throw new DropboxError('failed');
    checkDropboxFile(path,payload);
    const body = bytes(payload), content_hash = await hashSnapshot(body);
    const args = { path, mode: options.mode === 'update' ? { '.tag': 'update', update: options.revision } : options.mode,
      autorename: false, strict_conflict: true, client_modified: options.clientModified, content_hash };
    await this.#beforeWrite?.();
    const reply = await this.#auth.request({ endpoint: 'upload', body,
      headers: { 'Dropbox-API-Arg': argument(args), 'Content-Type': 'application/octet-stream' } }, this.#identity);
    const item = file(jsonObject(reply.bytes), path);
    if (item.contentHash !== content_hash || item.size !== body.length) throw new DropboxError('failed');
    return item;
  }
  async createFolder(input: string): Promise<void> {
    const path = pathname(input);
    await this.#beforeWrite?.();
    const result = await this.#rpc('create', { path, autorename: false });
    const folder = metadata({ '.tag': 'folder', ...(result.metadata as object) }, path);
    if (folder.kind !== 'folder') throw new DropboxError('failed');
  }
  async delete(input: string, revision?: string): Promise<void> {
    const path = pathname(input);
    if (revision === '') throw new DropboxError('failed');
    await this.#beforeWrite?.();
    const result = await this.#rpc('delete', { path, parent_rev: revision });
    const removed = metadata(result.metadata, path);
    if (revision !== undefined && (removed.kind !== 'file' || removed.rev !== revision)) throw new DropboxError('failed');
  }
}
