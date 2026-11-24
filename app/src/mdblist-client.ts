import { fetchProviderJson, providerDeadline, serviceRetryAt } from './provider-http.ts';
import type { CriticScores } from './mdblist-store.ts';

const minute = 60_000;
const emptyScores = (): CriticScores => ({ tomatoes: null, metacritic: null, myanimelist: null });
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

type Failure = 'unreachable' | 'invalid-response' | 'refused' | 'throttled' | 'superseded';
const messages: Record<Failure, string> = {
  unreachable: 'Cannot reach MDBList.', 'invalid-response': 'MDBList returned an unreadable response.',
  refused: 'MDBList refused the request.', throttled: 'MDBList is limiting requests.',
  superseded: 'The MDBList request is no longer current.',
};
export class MdbListError extends Error {
  readonly kind: Failure;
  readonly retryAt?: number;
  constructor(kind: Failure, message = messages[kind], retryAt?: number) {
    super(message);
    this.name = 'MdbListError';
    this.kind = kind;
    this.retryAt = retryAt;
  }
}

function errorText(data: unknown): string {
  if (!object(data)) return '';
  const text = data.error ?? data.detail ?? data.message;
  return typeof text === 'string' ? text.trim() : '';
}

function refusal(data: unknown, status: number): MdbListError {
  // Display recognized public messages only. An arbitrary proxy error can quote the key or URL.
  const known = ['Invalid API key', 'Missing API key', 'API key required', 'Authentication credentials were not provided',
    'You do not have permission to perform this action'];
  const message = known.find(item => item.toLowerCase() === errorText(data).replace(/[.!]$/, '').toLowerCase());
  return new MdbListError('refused', message ?? (status === 401 ? 'MDBList refused the API key.' : messages.refused));
}

function quotaEnd(data: unknown, headers: Headers, now: number): number {
  const text = errorText(data) + ' ' + (object(data) && typeof data.limit_type === 'string' ? data.limit_type : '');
  const remaining = headers.get('X-RateLimit-Remaining')?.trim();
  const midnight = new Date(now);
  midnight.setUTCHours(24, 0, 0, 0);
  const daily = /^0+$/.test(remaining ?? '') || /\bdaily\b|per.day|midnight/i.test(text);
  const windowEnd = daily ? midnight.getTime() : now + 5 * minute;
  const applicable = new Headers(headers);
  // The daily reset can be present on every response, including a five-minute
  // throttle when requests are still left in the daily allowance.
  if (!daily && remaining && /^\d+$/.test(remaining)) applicable.delete('X-RateLimit-Reset');
  return Math.max(windowEnd, providerDeadline(applicable, now) ?? now);
}

function readScores(id: number, row: unknown): CriticScores {
  if (!object(row) || !object(row.ids) || row.ids.tmdb !== id ||
      (row.type !== undefined && row.type !== 'show') || !Array.isArray(row.ratings)) {
    throw new MdbListError('invalid-response');
  }
  const scores = emptyScores();
  for (const rating of row.ratings) {
    if (!object(rating)) continue;
    const source = rating.source;
    if (source !== 'tomatoes' && source !== 'metacritic' && source !== 'myanimelist') continue;
    const value = rating.value;
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0 &&
        (source === 'myanimelist' ? value <= 10 : value <= 100 && Number.isInteger(value))) scores[source] = value;
  }
  return scores;
}

interface ClientOptions { fetch?: typeof fetch; now?: () => number; sleep?: (ms: number) => Promise<void>; inactivityMs?: number }
export class MdbListClient {
  readonly #send: typeof fetch;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #inactivity: number;
  constructor(options: ClientOptions = {}) {
    this.#send = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.#inactivity = options.inactivityMs ?? minute;
  }

  async lookup(id: number, key: string, current: () => Promise<boolean>): Promise<CriticScores> {
    if (!Number.isSafeInteger(id) || id <= 0) throw new MdbListError('invalid-response');
    const url = new URL('https://api.mdblist.com/tmdb/show/' + encodeURIComponent(id));
    url.searchParams.set('apikey', key);
    for (let attempt = 0; attempt < 5; attempt++) {
      if (!await current()) throw new MdbListError('superseded');
      const reply = await fetchProviderJson(url, { method: 'GET' }, this.#send, this.#inactivity, status => status < 500,
        kind => new MdbListError(kind), 1024 * 1024);
      const { status, headers, value } = reply;
      if (status >= 500 && status < 600) {
        const maintenance = serviceRetryAt(reply,this.#now());
        if (maintenance !== undefined) throw new MdbListError('throttled','MDBList is temporarily unavailable.',maintenance);
        if (!await current()) throw new MdbListError('superseded');
        if (attempt < 4) await this.#sleep(1000 * 2 ** attempt);
        continue;
      }
      if (status === 429) throw new MdbListError('throttled', messages.throttled, quotaEnd(value, headers, this.#now()));
      const text = errorText(value);
      if (status === 401 || status === 403 || /(?:invalid|missing|incorrect|expired|unauthorized).*api.?key/i.test(text)) {
        throw refusal(value, status);
      }
      if (status === 404 || /^(?:(?:media|item|show|title) )?not found[.!]?$/i.test(text)) {
        return emptyScores();
      }
      if (status < 200 || status >= 300 || text) throw refusal(value, status);
      return readScores(id, value);
    }
    throw new MdbListError('unreachable');
  }
}
