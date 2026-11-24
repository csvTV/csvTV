import { providerDeadline, fetchProviderJson, serviceRetryAt } from './provider-http.ts';
import { broadcastCandidates, broadcastSource, readBroadcastOrder } from './tmdb-broadcast.ts';
import type { TmdbShow } from './tmdb-data.ts';
export type TmdbResource =
  | { kind: 'configuration' } | { kind: 'countries' }
  | { kind: 'search'; query: string; page?: number }
  | { kind: 'show'; id: number } | { kind: 'cast'; id: number }
  | { kind: 'external-ids'; id: number } | { kind: 'person'; id: number }
  | { kind: 'season'; id: number; season: number }
  | { kind: 'recommendations'; id: number; page?: number }
  | { kind: 'find'; source: 'imdb_id' | 'tvdb_id'; externalId: string };

type Failure = 'not-found' | 'refused' | 'unreachable' | 'superseded' | 'throttled' | 'invalid-response' | 'bad-request';
const messages: Record<Failure, string> = {
  'not-found': 'Not on TMDB', refused: 'TMDB refused the API Read Access Token.',
  unreachable: 'TMDB could not be reached. Try again.', superseded: 'This TMDB request is no longer current.',
  throttled: 'TMDB is limiting requests. Try again after the cooldown.',
  'invalid-response': 'TMDB returned an unreadable response.', 'bad-request': 'Invalid TMDB request.',
};

export class TmdbError extends Error {
  readonly kind: Failure;
  readonly retryAt?: number;
  readonly httpStatus?: number;
  constructor(kind: Failure, message = messages[kind], retryAt?: number, httpStatus?: number) {
    super(message);
    this.name = 'TmdbError';
    this.kind = kind;
    this.retryAt = retryAt;
    this.httpStatus = httpStatus;
  }
}

function numberPart(value: number, min = 0, max = Number.MAX_SAFE_INTEGER): string {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new TmdbError('bad-request');
  return String(value);
}

/** Stable, credential-free cache identity, also used to construct the fixed-origin URL. */
export function tmdbResourceKey(resource: TmdbResource): string {
  switch (resource.kind) {
    case 'configuration': return 'configuration';
    case 'countries': return 'configuration/countries';
    case 'show': return 'tv/' + numberPart(resource.id) + '?append_to_response=keywords,external_ids';
    case 'season': return 'tv/' + numberPart(resource.id) + '/season/' + numberPart(resource.season);
    case 'cast': return 'tv/' + numberPart(resource.id) + '/aggregate_credits';
    case 'external-ids': return 'tv/' + numberPart(resource.id) + '/external_ids';
    case 'person': return 'person/' + numberPart(resource.id) + '/tv_credits';
    case 'recommendations': return 'tv/' + numberPart(resource.id) + '/recommendations?page=' + numberPart(resource.page ?? 1, 1, 500);
    case 'search': {
      if (typeof resource.query !== 'string' || !resource.query.trim()) throw new TmdbError('bad-request');
      const params = new URLSearchParams({ query: resource.query, page: numberPart(resource.page ?? 1, 1, 500) });
      return 'search/tv?' + params;
    }
    case 'find': {
      const { source, externalId } = resource;
      if (!(source === 'imdb_id' && /^tt[0-9]+$/.test(externalId)) &&
          !(source === 'tvdb_id' && /^[0-9]+$/.test(externalId))) throw new TmdbError('bad-request');
      return 'find/' + encodeURIComponent(externalId) + '?external_source=' + source;
    }
    default: throw new TmdbError('bad-request');
  }
}

export interface TmdbCooldown { until: number; strikes: number }
export interface RequestContext {
  current(): boolean | Promise<boolean>;
  /** A foreground consumer can join a detail request while it is waiting. */
  background?(): boolean;
  /** A reply may still limit this credential after its screen or import closes. */
  credentialCurrent?(): boolean | Promise<boolean>;
  /** Distinguishes a new credential submission even if its text is identical. */
  generation?: string | bigint;
  readCooldown?(): Promise<TmdbCooldown | null>;
  /** The device rechecks the captured generation in the same transaction as the write. */
  writeCooldown?(next: TmdbCooldown | null): Promise<void>;
}

interface ClientOptions {
  fetch?: typeof fetch;
  now?: () => number;
  paceNow?: () => number;
  sleep?: (ms: number) => Promise<void>;
  inactivityMs?: number;
}

interface Gate {
  state: TmdbCooldown | null;
  version: number;
  ready: Promise<void>;
  probe?: Promise<void>;
  active: number;
}

interface Reply { status: number; headers: Headers; value?: unknown }
const second = 1000;
const maximumShortWait = 8 * second;
export const importSeasonBatchSize = 6;
const backoff = (attempt: number) => Math.min(2 ** (attempt - 1), 8) * second;

async function current(context: RequestContext) {
  if (!await context.current()) throw new TmdbError('superseded');
}

async function currentCredential(context: RequestContext) {
  if (!await ownsCredential(context)) throw new TmdbError('superseded');
}

const ownsCredential = (context: RequestContext) => context.credentialCurrent ? context.credentialCurrent() : context.current();

function refusalMessage(value: unknown): string {
  // A provider or proxy could echo the request in free text. Only display known
  // TMDB messages, selected by numeric status code.
  const code = value && typeof value === 'object' && 'status_code' in value ? value.status_code : null;
  if (code === 7) return 'Invalid API key: You must be granted a valid key.';
  if (code === 10) return 'Suspended API key: Access to your account has been suspended, contact TMDB.';
  if (code === 35) return 'Invalid token.';
  return messages.refused;
}

export class TmdbClient {
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #paceNow: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #inactivity: number;
  readonly #gates = new Map<string, Gate>();
  #nextStart = 0;
  #turns: {background:()=>boolean; dispatch:()=>Promise<void>}[] = [];
  #dispatching = false;

  constructor(options: ClientOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#now = options.now ?? Date.now;
    this.#paceNow = options.paceNow ?? options.now ?? (() => performance.now());
    this.#sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.#inactivity = options.inactivityMs ?? 60 * second;
  }

  async #fetchReply(url: URL, token: string): Promise<Reply> {
    return fetchProviderJson(url, {
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
    }, this.#fetch, this.#inactivity, status => status === 401, kind => new TmdbError(kind), 16 * 1024 * 1024);
  }

  #gate(key: string, context: RequestContext): Gate {
    const existing = this.#gates.get(key);
    if (existing) return existing;
    const gate: Gate = { state: null, version: 0, ready: Promise.resolve(), active: 0 };
    gate.ready = Promise.resolve(context.readCooldown?.()).then(state => {
      if (state && Number.isFinite(state.until) && Number.isInteger(state.strikes) && state.strikes > 0) gate.state = state;
    });
    this.#gates.set(key, gate);
    return gate;
  }

  async #setGate(gate: Gate, state: TmdbCooldown | null, context: RequestContext) {
    gate.version++;
    gate.state = state;
    // Responses can arrive out of order. Persist their decisions in the same order
    // as the in-memory changes, including a successful probe clearing a deadline.
    const saved = gate.ready.then(async () => {
      await currentCredential(context);
      await context.writeCooldown?.(state);
    });
    gate.ready = saved.catch(() => {});
    await saved;
  }

  async request(resource: TmdbResource, token: string, context: RequestContext): Promise<unknown> {
    const url = new URL(tmdbResourceKey(resource), 'https://api.themoviedb.org/3/');
    if (resource.kind === 'show') url.searchParams.set('append_to_response','keywords,external_ids,episode_groups');
    return this.#dispatch(url, token, context);
  }

  async broadcastOrder(raw:unknown, show:TmdbShow, token:string, context:RequestContext) {
    const ids = broadcastCandidates(raw);
    const source = broadcastSource(raw,ids);
    let agreed: ReturnType<typeof readBroadcastOrder> = null;
    for (const id of ids) {
      const url = new URL('tv/episode_group/' + id,'https://api.themoviedb.org/3/');
      try {
        const order = readBroadcastOrder(await this.#dispatch(url,token,context),id,show);
        if (!order) continue;
        if (agreed && JSON.stringify(agreed) !== JSON.stringify(order)) return {order:null};
        agreed = order;
      } catch (error) {
        if (error instanceof TmdbError && (error.kind === 'superseded' || error.kind === 'refused')) throw error;
        // Supplementary metadata can be missing or temporarily unavailable while the show is usable.
        return {order:null,retrySource:source};
      }
    }
    return {order:agreed,source};
  }

  async requestShowWithSeasons(id: number, seasons: readonly number[], token: string, context: RequestContext): Promise<unknown> {
    if (!seasons.length || seasons.length > importSeasonBatchSize) throw new TmdbError('bad-request');
    const url = new URL(tmdbResourceKey({kind:'show', id}), 'https://api.themoviedb.org/3/');
    url.searchParams.set('append_to_response', ['keywords', 'external_ids', 'episode_groups', ...seasons.map(n => 'season/' + numberPart(n))].join(','));
    return this.#dispatch(url, token, context);
  }

  #turn<T>(context:RequestContext, start:()=>Promise<T>):Promise<T> {
    return new Promise((resolve,reject) => {
      this.#turns.push({background:context.background ?? (()=>false), dispatch:async () => {
        try { resolve(await start()); } catch (error) { reject(error); }
      }});
      void this.#dispatchTurns();
    });
  }

  async #dispatchTurns() {
    if (this.#dispatching) return;
    this.#dispatching = true;
    let foreground = 0;
    try {
      while (this.#turns.length) {
        // After three interactive starts, reserve a turn for the oldest detail request.
        const preferBackground = foreground >= 3;
        const preferred = this.#turns.findIndex(turn => turn.background() === preferBackground);
        const [turn] = this.#turns.splice(Math.max(0,preferred),1);
        foreground = turn.background() ? 0 : Math.min(3,foreground+1);
        await turn.dispatch();
      }
    } finally { this.#dispatching = false; }
  }

  async #dispatch(url: URL, token: string, context: RequestContext): Promise<unknown> {
    url.searchParams.set('language', 'en-US');
    if (!token.trim() || /[\r\n]/.test(token)) throw new TmdbError('refused');
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
    const key = Array.from(digest, b => b.toString(16).padStart(2, '0')).join('') + '/' + String(context.generation ?? '');
    await current(context);
    const gate = this.#gate(key, context);
    gate.active++;
    try {
      return await this.#request(url, token, context, gate);
    } finally {
      if (!--gate.active && !gate.state) this.#gates.delete(key);
    }
  }

  async #request(url: URL, token: string, context: RequestContext, gate: Gate): Promise<unknown> {
    for (let attempt = 1; attempt <= 5; attempt++) {
      let wait = 0;
      let reply: Reply | undefined;
      let version = 0;
      let finishProbe: (() => void) | undefined;
      let priorStrikes = 0;
      try {
        while (!reply) {
          await gate.ready;
          await current(context);
          if (gate.probe) { await gate.probe; continue; }
          const remaining = (gate.state?.until ?? 0) - this.#now();
          if (remaining > maximumShortWait) throw new TmdbError('throttled', undefined, gate.state!.until);
          if (remaining > 0) { await this.#sleep(remaining); continue; }

          // Serialize only the dispatch, never its response or a credential's cooldown.
          // Even after a stalled browser clock, dispatches remain 50 ms apart.
          const started = await this.#turn(context,async () => {
            const delay = this.#nextStart - this.#paceNow();
            if (delay > 0) await this.#sleep(Math.ceil(delay));
            await current(context);
            if (gate.probe || (gate.state && gate.state.until > this.#now())) return;
            version = gate.version;
            priorStrikes = gate.state?.strikes ?? 0;
            if (gate.state) gate.probe = new Promise(resolve => { finishProbe = resolve; });
            this.#nextStart = this.#paceNow() + 50;
            return { work: this.#fetchReply(url, token) };
          });
          if (started) reply = await started.work;
        }
        await currentCredential(context);
        const maintenance = serviceRetryAt(reply,this.#now());
        if (reply.status === 429 || maintenance !== undefined) {
          const now = this.#now();
          const strikes = Math.max(priorStrikes + 1, gate.state?.strikes ?? 0);
          const deadline = maintenance ?? providerDeadline(reply.headers, now) ?? now + backoff(strikes);
          const until = Math.max(deadline, gate.state?.until ?? 0, strikes >= 5 ? now + 15 * 60 * second : 0);
          await this.#setGate(gate, { until, strikes }, context);
          if (until - now > maximumShortWait || attempt === 5) throw new TmdbError('throttled', undefined, until);
          continue;
        }
        const serverFailure = reply.status >= 500 && reply.status < 600;
        if (!serverFailure && finishProbe && version === gate.version) await this.#setGate(gate, null, context);
        if (reply.status === 401) throw new TmdbError('refused', refusalMessage(reply.value));
        await current(context);
        if (serverFailure) {
          wait = backoff(attempt);
          if (attempt === 5) throw new TmdbError('unreachable');
        } else {
          if (reply.status === 404) throw new TmdbError('not-found');
          if (reply.status < 200 || reply.status >= 300) throw new TmdbError('bad-request', undefined, undefined, reply.status);
          return reply.value;
        }
      } catch (error) {
        if (error instanceof TmdbError && error.kind === 'refused') await currentCredential(context);
        else await current(context);
        throw error;
      } finally {
        if (finishProbe) {
          try {
            if (version === gate.version && await ownsCredential(context)) {
              await this.#setGate(gate, { until: this.#now() + (wait || backoff(priorStrikes)), strikes: priorStrikes }, context);
            }
          } finally {
            gate.probe = undefined;
            finishProbe();
          }
        }
      }
      if (wait) await this.#sleep(wait);
    }
    throw new TmdbError('unreachable');
  }
}
