import { validGithubRepo } from './csv.ts';
import { abortableProviderRead, providerDeadline, releaseProviderResponse, serviceRetryAt } from './provider-http.ts';
import { ratingsBusyMessage, ratingsFileLimits, RatingsFileLimitError, RatingsIndexBusyError, ratingsLimitMessage } from './ratings-csv.ts';

type Failure = 'configuration' | 'refused' | 'throttled' | 'http' | 'unreachable' | 'invalid-file' | 'file-too-large' | 'busy' | 'superseded';
const messages: Record<Failure, string> = {
  configuration: 'Enter the repository as owner/name and enter its read-only token.',
  refused: 'GitHub refused the token.', throttled: 'GitHub is limiting requests.',
  http: 'GitHub could not return the ratings file.', unreachable: 'Could not reach GitHub.',
  'invalid-file': 'The ratings file is invalid or incomplete.', superseded: 'The ratings source changed.',
  'file-too-large': ratingsLimitMessage,
  busy: ratingsBusyMessage,
};

export class GithubRatingsError extends Error {
  readonly kind: Failure;
  readonly status?: number;
  readonly retryAt?: number;
  constructor(kind: Failure, status?: number, retryAt?: number) {
    super(messages[kind] + (status ? ' HTTP ' + status + '.' : ''));
    this.name = 'GithubRatingsError';
    this.kind = kind;
    this.status = status;
    this.retryAt = retryAt;
  }
}

export interface GithubClientOptions {
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  inactivityMs?: number;
}
export type UnchangedRatingsFile = {digest:string; unchanged:true};
type ParsedRatingsFile<Index> = Index & {file:Blob; bytes:ArrayBuffer; digest:string; unchanged?:false};
// A 403 can mean either a denied request or an exhausted primary or secondary limit.
// Ordinary responses also carry a primary reset, even when primary quota remains.
export function githubThrottle(response: Pick<Response,'status'|'headers'>, detail: string, now: number): GithubRatingsError | undefined {
  const {status, headers} = response;
  const maintenance = serviceRetryAt(response,now);
  if (maintenance !== undefined) return new GithubRatingsError('throttled',status,maintenance);
  const remaining = headers.get('x-ratelimit-remaining');
  const exhausted = remaining !== null && /^0+$/.test(remaining);
  if (status !== 429 && !(status === 403 && (exhausted || headers.has('retry-after') ||
      /rate limit|abuse detection/i.test(detail)))) return;
  const applicable = new Headers(headers);
  if (remaining !== null && !exhausted) applicable.delete('x-ratelimit-reset');
  const deadline = providerDeadline(applicable, now);
  return new GithubRatingsError('throttled', status, deadline ?? now + 60_000);
}

export class GithubRatingsClient<Index> {
  readonly #job: 'imdb' | 'mal';
  readonly #read: (file:Blob) => Promise<Index>;
  readonly #send: typeof fetch;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #inactivity: number;
  constructor(job:'imdb'|'mal', read:(file:Blob)=>Promise<Index>, options:GithubClientOptions = {}) {
    this.#job = job;
    this.#read = read;
    this.#send = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.#inactivity = options.inactivityMs ?? 60_000;
  }

  async #request(url: URL, token: string): Promise<Blob> {
    const controller = new AbortController();
    let unread: ReadableStream<Uint8Array> | null = null;
    let timer: ReturnType<typeof setTimeout>;
    const timeout = () => controller.abort(new GithubRatingsError('unreachable'));
    const progress = () => { clearTimeout(timer); timer = setTimeout(timeout, this.#inactivity); };
    try {
      progress();
      const response = await abortableProviderRead(controller.signal,this.#send(url, {
        method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
        headers: {Accept:'application/vnd.github.raw+json', Authorization:'Bearer ' + token}, signal:controller.signal,
      }),releaseProviderResponse);
      unread = response.body;
      const {status} = response;
      if (status === 401) throw new GithubRatingsError('refused', status);
      const limited = githubThrottle(response, '', this.#now());
      if (limited) throw limited;
      if (status !== 200 && status !== 403) throw new GithubRatingsError('http', status);
      const maxBytes = ratingsFileLimits[this.#job].compressedBytes;
      if (status === 200 && Number(response.headers.get('Content-Length')) > maxBytes) {
        throw new GithubRatingsError('file-too-large', status);
      }
      progress();
      const chunks: BlobPart[] = [];
      const reader = response.body?.getReader();
      if (reader) {
        let bytes = 0;
        try {
          for (;;) {
            const {done, value} = await abortableProviderRead(controller.signal,reader.read());
            if (done) { unread = null; break; }
            if (!value.length) continue;
            progress();
            bytes += value.length;
            if (status === 200 && bytes > maxBytes) throw new GithubRatingsError('file-too-large', status);
            if (status === 403 && bytes >= 16_384) {
              chunks.push(value.slice(0, Math.max(0, 16_384 - (bytes - value.length))));
              break;
            }
            chunks.push(value);
          }
        } finally { reader.releaseLock(); }
      }
      const file = new Blob(chunks);
      if (status === 403) throw githubThrottle(response, await file.text(), this.#now()) ?? new GithubRatingsError('http', status);
      return file;
    } catch (error) {
      if (error instanceof GithubRatingsError) throw error;
      throw new GithubRatingsError('unreachable');
    } finally {
      clearTimeout(timer!);
      void unread?.cancel().catch(() => {});
      controller.abort();
    }
  }

  download(repo:string, token:string, current?:()=>Promise<boolean>):Promise<ParsedRatingsFile<Index>>;
  download(repo:string, token:string, current:()=>Promise<boolean>, savedDigest:string|undefined):Promise<ParsedRatingsFile<Index> | UnchangedRatingsFile>;
  async download(repo: string, token: string, current: () => Promise<boolean> = async () => true,
      savedDigest?:string): Promise<ParsedRatingsFile<Index> | UnchangedRatingsFile> {
    if (!validGithubRepo(repo) || !token.trim() || /[\r\n]/.test(token)) throw new GithubRatingsError('configuration');
    const path = repo.split('/').map(encodeURIComponent).join('/');
    const filePath = this.#job === 'imdb' ? 'imdb-ratings.csv.gz?ref=data' : 'mal-ratings.csv.gz?ref=mal-data';
    const url = new URL('https://api.github.com/repos/' + path + '/contents/' + filePath);
    for (let attempt = 0; ; attempt++) {
      if (!await current()) throw new GithubRatingsError('superseded');
      let file: Blob;
      try { file = await this.#request(url, token); }
      catch (error) {
        if (!(error instanceof GithubRatingsError) || error.kind !== 'http' || error.status === undefined || error.status < 500 ||
            error.status >= 600) throw error;
        if (!await current()) throw new GithubRatingsError('superseded');
        if (attempt >= 4) throw error;
        await this.#sleep(1000 * 2 ** attempt);
        continue;
      }
      if (!await current()) throw new GithubRatingsError('superseded');
      try {
        const bytes = await file.arrayBuffer();
        const hash = await crypto.subtle.digest('SHA-256', bytes);
        const digest = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
        // Only the digest of an atomically installed, validated file can take this path.
        if (digest === savedDigest) return {digest,unchanged:true};
        return {...await this.#read(file), file, bytes, digest};
      } catch (error) {
        if (error instanceof RatingsIndexBusyError) throw new GithubRatingsError('busy');
        if (error instanceof DOMException && error.name === 'AbortError') throw new GithubRatingsError('superseded');
        throw new GithubRatingsError(error instanceof RatingsFileLimitError ? 'file-too-large' : 'invalid-file', 200);
      }
    }
  }
}
