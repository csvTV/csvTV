import { checkDropboxBytes, dropboxLimits, DropboxLimitError } from './dropbox-limits.ts';

/** Only these Dropbox destinations can receive credentials from the browser transport. */
const api = 'https://api.dropboxapi.com/';
const content = 'https://content.dropboxapi.com/2/files/';
const endpoints = {
  token: api + 'oauth2/token', revoke: api + '2/auth/token/revoke',
  list: api + '2/files/list_folder', continue: api + '2/files/list_folder/continue',
  revisions: api + '2/files/list_revisions', create: api + '2/files/create_folder_v2',
  delete: api + '2/files/delete_v2', download: content + 'download', upload: content + 'upload',
} as const;

export interface DropboxRequest {
  endpoint: keyof typeof endpoints;
  headers?: Record<string, string>;
  body?: string | Uint8Array<ArrayBuffer> | null;
  downloadLimit?: number;
  readSignal?:AbortSignal;
  /** The remaining authorization attempt lifetime when exchanging a one-use sign-in code. */
  tokenTimeoutMs?: number;
}
export interface DropboxResponse { status: number; bytes: Uint8Array; metadata: string | null; retryAfter?: string | null; discarded?:true }
export type DropboxTransport = (request: DropboxRequest) => Promise<DropboxResponse>;
export function browsingSignal(request:DropboxRequest):AbortSignal|undefined {
  return request.endpoint === 'list' || request.endpoint === 'continue' || request.endpoint === 'download' ? request.readSignal : undefined;
}
type Failure = 'not-found' | 'conflict' | 'failed' | 'unavailable' | 'unauthorized' | 'expiry-unsupported'
  | 'account-changed' | 'signed-out' | 'sign-out-pending' | 'expired' | 'renewal-refused' | 'unconfigured' | 'callback' | 'callback-submitted' | 'callback-replaced' | 'throttled'
  | 'missing-scope' | 'permission' | 'storage-full' | 'provider-unavailable' | 'not-folder' | 'invalid-client' | 'unverified-folder';
const errors: Record<Failure, string> = {
  'sign-out-pending': 'Sign-out is incomplete. Open Settings to finish signing out.',
  'not-found': 'Dropbox could not find this path.', conflict: 'The file changed in Dropbox.',
  failed: 'Dropbox could not complete the request.', unavailable: 'Dropbox could not be reached.',
  unauthorized: 'Dropbox refused access.', 'expiry-unsupported': 'Dropbox could not set the required seven-day expiry. Sign-in stopped.',
  'account-changed': 'The Dropbox account or sign-in changed. Try again.', 'signed-out': 'Sign in to Dropbox.',
  expired: 'The seven-day Dropbox sign-in ended.', 'renewal-refused': 'Dropbox ended or revoked this sign-in.',
  unconfigured: 'Enter the public Dropbox app key first.', callback: 'Start Dropbox sign-in again in this tab.',
  'callback-submitted': 'This Dropbox sign-in was already submitted. If you stay signed out, sign in again.',
  'callback-replaced': 'A different Dropbox sign-in has already finished.',
  'invalid-client': 'Dropbox refused the app registration. Check the public app key in Settings.',
  'unverified-folder': 'Could not verify this record’s Dropbox folder. Sign out and enter the original app key, or export all four CSVs, clear this device in Settings and link again.',
  throttled: 'Dropbox is limiting requests for this account. Try again later.',
  'missing-scope': 'Enable files.metadata.read, files.content.read and files.content.write in the Dropbox App Console, then sign in again.',
  permission: 'Dropbox denied permission for this operation. Check access to the app folder in Dropbox.',
  'storage-full': 'Dropbox storage is full. Free up space in Dropbox, then try again.',
  'not-folder': 'Dropbox found a file where csvTV expected a folder.',
  'provider-unavailable': 'Dropbox had a server error. Try again later.',
};
export class DropboxError extends Error {
  readonly kind: Failure;
  readonly status?:number;
  constructor(kind: Failure, status?:number) { super(errors[kind]); this.name = 'DropboxError'; this.kind = kind; this.status = status; }
}

export function isTemporaryDropboxFailure(error:unknown):boolean {
  return error instanceof DropboxError &&
    (error.kind === 'unavailable' || error.kind === 'provider-unavailable' || error.kind === 'throttled');
}

function readLimit(request:DropboxRequest, status:number) {
  if (status < 200 || status >= 300) return dropboxLimits.smallReply;
  if (request.endpoint === 'download') return Math.min(request.downloadLimit ?? dropboxLimits.file,dropboxLimits.file);
  if (request.endpoint === 'list' || request.endpoint === 'continue' || request.endpoint === 'revisions') return dropboxLimits.listingPage;
  return dropboxLimits.smallReply;
}

const inactivityMs = 120_000;

function initialTimeout(request:DropboxRequest):number {
  if (request.endpoint !== 'upload' || !request.body) return inactivityMs;
  const bytes = typeof request.body === 'string' ? new Blob([request.body]).size : request.body.byteLength;
  const MiB = 1024 * 1024;
  // Fetch exposes no upload progress. Give larger files more time to reach Dropbox before its first reply.
  return Math.min(15 * 60_000, inactivityMs + Math.ceil(Math.max(0,bytes - MiB) * 60_000 / MiB));
}

/** Refuse redirects for the request body as well as its credentials. Bound every decoded reply. */
export async function dropboxTransport(request:DropboxRequest):Promise<DropboxResponse> {
  if (!Object.hasOwn(endpoints,request.endpoint)) throw new DropboxError('failed');
  const controller = new AbortController();
  let timer:ReturnType<typeof setTimeout> | undefined;
  const progress = (timeout = inactivityMs) => {
    // A token reply is small. Occasional body bytes must not keep a sign-in or an update waiting.
    if (request.endpoint==='token') {
      if (timer!==undefined) return;
      timeout=Math.min(timeout,request.tokenTimeoutMs ?? inactivityMs);
      if (!Number.isFinite(timeout) || timeout<=0) throw new DropboxError('callback');
    }
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(),timeout);
  };
  try {
    progress(initialTimeout(request));
    const reply = await fetch(endpoints[request.endpoint],{method:'POST',headers:request.headers,body:request.body,
      signal:controller.signal,redirect:'error',credentials:'omit',referrerPolicy:'no-referrer',cache:'no-store'});
    progress();
    const status = reply.status, limit = readLimit(request,status);
    const metadata = request.endpoint === 'download' && reply.ok ? reply.headers.get('Dropbox-API-Result') : null;
    const retryAfter = status === 429 ? reply.headers.get('Retry-After') : null;
    const result = {status,metadata,retryAfter,bytes:new Uint8Array(0)};
    try {
      if (status === 206) throw new DropboxError('failed');
      checkDropboxBytes(Number(reply.headers.get('Content-Length') ?? 0),limit);
      let fileSize:number|undefined;
      if (metadata) {
        checkDropboxBytes(metadata.length,dropboxLimits.smallReply);
        const size:unknown = JSON.parse(metadata)?.size;
        if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) throw new DropboxError('failed');
        checkDropboxBytes(size,limit);
        fileSize = size;
      }
      if (!reply.body) return result;
      const reader = reply.body.getReader();
      // Keep error replies so the account can record Dropbox's cooldown. A successful read can release its stream.
      const signal = reply.ok ? browsingSignal(request) : undefined;
      const abandon = () => { void reader.cancel().catch(() => {}); };
      if (signal?.aborted) abandon();
      else signal?.addEventListener('abort',abandon,{once:true});
      let output = result.bytes, size = 0;
      try {
        for (;;) {
          const {value,done} = await reader.read();
          if (signal?.aborted) return {...result,discarded:true};
          if (done) break;
          if (!value.byteLength) continue;
          progress();
          const next = size + value.byteLength;
          checkDropboxBytes(next,limit);
          if (fileSize !== undefined && next > fileSize) throw new DropboxError('failed');
          if (next > output.byteLength) {
            const larger = new Uint8Array(Math.min(fileSize ?? limit,Math.max(8192,2*output.byteLength,next)));
            larger.set(output.subarray(0,size));
            output = larger;
          }
          output.set(value,size);
          size = next;
        }
        result.bytes = output.subarray(0,size);
      } finally { signal?.removeEventListener('abort',abandon); reader.releaseLock(); }
      return result;
    } catch (error) {
      void reply.body?.cancel().catch(() => {});
      if (error instanceof DropboxLimitError && !reply.ok) return result;
      if (error instanceof SyntaxError) throw new DropboxError('failed');
      throw error;
    }
  } catch (error) {
    if (error instanceof DropboxError || error instanceof DropboxLimitError) throw error;
    throw new DropboxError('unavailable');
  } finally { clearTimeout(timer!); controller.abort(); }
}

export function jsonObject(bytes: Uint8Array): Record<string, unknown> {
  try {
    const result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (result && typeof result === 'object' && !Array.isArray(result)) return result;
  } catch { /* Remote response bodies may contain credentials. */ }
  throw new DropboxError('failed');
}

function rejectsExpiry(message: string) {
  const normalized = message.toLowerCase().replace(/['"`]/g, '').replace(/[:=]/g, ' ');
  return /\b(?:unknown|unrecognized|unexpected|unsupported|invalid|disallowed)(?:\s+(?:parameter|argument|field))?\s+refresh_token_expiration_seconds\b/.test(normalized) ||
    /\brefresh_token_expiration_seconds(?:\s+(?:parameter|argument|field))?(?:\s+is)?\s+(?:unsupported|invalid|unknown|unrecognized|unexpected|not (?:a )?(?:supported|allowed|permitted|recognized|valid))\b/.test(normalized);
}

function fields(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function errorTags(data: Record<string, unknown>) {
  const error = fields(data.error);
  const tag = error?.['.tag'];
  if (typeof tag !== 'string') {
    return typeof data.error_summary === 'string' ? data.error_summary.split('/', 2) : [];
  }
  if (tag !== 'path' && tag !== 'path_lookup' && tag !== 'path_write') return [tag];
  // UploadWriteFailed inlines a reason. The other file routes nest the union under its tag.
  const detail = fields(error?.[tag]);
  return [tag, fields(error?.reason ?? detail?.reason)?.['.tag'] ?? detail?.['.tag']];
}

/** Classify only provider-documented errors. Never surface a provider body or request argument. */
export function checkResponse(response: DropboxResponse, tokenExchange = false): void {
  if (response.discarded) throw new DOMException('Dropbox read canceled.','AbortError');
  if (response.status >= 200 && response.status < 300 && response.status !== 206) return;
  if (response.status === 429) throw new DropboxError('throttled');
  if (response.status >= 500 && response.status < 600) throw new DropboxError('provider-unavailable');
  let data: Record<string, unknown> = {};
  let plain = '';
  try { data = jsonObject(response.bytes); } catch {
    if (tokenExchange && response.status === 400) {
      const body = new TextDecoder().decode(response.bytes).trim();
      if (!/^[{[<]/.test(body)) plain = body;
    }
  }
  if (tokenExchange && (response.status === 400 || response.status === 401)) {
    if (data.error === 'invalid_grant') throw new DropboxError('renewal-refused');
    if (data.error === 'invalid_client') throw new DropboxError('invalid-client');
  }
  if (tokenExchange && response.status === 400 &&
      rejectsExpiry(typeof data.error_description === 'string' ? data.error_description : plain)) throw new DropboxError('expiry-unsupported');
  const [tag, reason] = errorTags(data);
  if (response.status === 401) throw new DropboxError(tag === 'missing_scope' ? 'missing-scope' : 'unauthorized');
  if (response.status === 403 && (tag === 'no_permission' || tag === 'team_access_denied')) throw new DropboxError('permission');
  if (response.status === 409) {
    if ((tag === 'path' || tag === 'path_lookup') && reason === 'not_found') throw new DropboxError('not-found');
    if ((tag === 'path' || tag === 'path_lookup') && reason === 'not_folder') throw new DropboxError('not-folder');
    if (tag === 'too_many_write_operations') throw new DropboxError('throttled');
    if (tag === 'path' || tag === 'path_write') {
      if (reason === 'conflict') throw new DropboxError('conflict');
      if (reason === 'too_many_write_operations') throw new DropboxError('throttled');
      if (reason === 'no_write_permission' || reason === 'access_restricted') throw new DropboxError('permission');
      if (reason === 'insufficient_space' || reason === 'team_folder_insufficient_space' || reason === 'member_folder_insufficient_space') {
        throw new DropboxError('storage-full');
      }
    }
  }
  throw new DropboxError('failed',response.status);
}
