import { DropboxError, jsonObject, type DropboxResponse } from './dropbox-client.ts';
import { providerDeadline } from './provider-http.ts';

export interface DropboxCooldown { until: number; strikes: number }
interface Slot { turn: Promise<void>; probe?: Promise<void>; version: number; users: number }
const accounts = new WeakMap<object, Map<string, Slot>>();
const shortWait = 8_000;
const backoff = (strike: number) => strike >= 5 ? 15 * 60_000 : 1000 * 2 ** (strike - 1);

function retryDeadline(reply: DropboxResponse, now: number): number | undefined {
  const headers = new Headers();
  if (reply.retryAfter) headers.set('Retry-After', reply.retryAfter);
  const fromHeader = providerDeadline(headers, now);
  // Dropbox's structured RateLimitError can supply seconds even when the header is absent.
  let delay: unknown;
  try {
    const error = jsonObject(reply.bytes).error;
    if (error && typeof error === 'object' && 'retry_after' in error) delay = error.retry_after;
  } catch { /* A missing or plain-text body leaves the header usable. */ }
  if (typeof delay !== 'number' || !Number.isSafeInteger(delay) || delay <= 0) return fromHeader;
  const fromBody = now + delay * 1000;
  return Number.isSafeInteger(fromBody) && Number.isFinite(new Date(fromBody).getTime())
    ? Math.max(fromHeader ?? 0, fromBody) : fromHeader;
}

// Order admissions and quota writes, while ordinary in-flight transfers can still overlap.
function inOrder<T>(slot: Slot, work: () => Promise<T>) {
  const result = slot.turn.then(work);
  slot.turn = result.then(() => {}, () => {});
  return result;
}

export async function dropboxTransfer(device: object, account: string, options: {
  inspect(forReply: boolean): Promise<{ cooldown?: DropboxCooldown | null; dispatch(): Promise<DropboxResponse> }>;
  save(value: DropboxCooldown | null): Promise<void>;
  now(): number;
  sleep(ms: number): Promise<void>;
}): Promise<DropboxResponse> {
  let map = accounts.get(device);
  if (!map) accounts.set(device, map = new Map());
  let existing = map.get(account);
  if (!existing) map.set(account, existing = {turn:Promise.resolve(),version:0,users:0});
  const slot = existing;
  slot.users++;
  try {
    for (let attempt = 1; attempt <= 5;) {
      const entry = await inOrder(slot, async () => {
        const checked = await options.inspect(false);
        if (slot.probe) return { wait:slot.probe };
        const remaining = (checked.cooldown?.until ?? 0) - options.now();
        if (remaining > shortWait) throw new DropboxError('throttled');
        if (remaining > 0) return { wait:options.sleep(remaining) };
        let release: (() => void) | undefined;
        if (checked.cooldown) slot.probe = new Promise<void>(resolve => { release = resolve; });
        return { work:checked.dispatch(), strikes:checked.cooldown?.strikes ?? 0, version:slot.version, release };
      });
      if ('wait' in entry) { await entry.wait; continue; }
      try {
        let reply: DropboxResponse;
        try { reply = await entry.work; } catch (error) {
          if (entry.release) await inOrder(slot, async () => {
            if (entry.version === slot.version) {
              await options.save({until:options.now() + backoff(entry.strikes + 1), strikes:entry.strikes});
              slot.version++;
            }
          });
          throw error;
        }
        if (reply.status !== 429) {
          if (entry.release) await inOrder(slot, async () => {
            if (entry.version !== slot.version) return;
            await options.save(reply.status >= 500 ?
              {until:options.now() + backoff(entry.strikes + 1), strikes:entry.strikes} : null);
            slot.version++;
          });
          return reply;
        }
        await inOrder(slot, async () => {
          const { cooldown } = await options.inspect(true);
          const now = options.now(), strikes = Math.min(5, Math.max(entry.strikes + 1, cooldown?.strikes ?? 0));
          const deadline = retryDeadline(reply, now) ?? now + backoff(strikes);
          const until = Math.max(cooldown?.until ?? 0, deadline, strikes >= 5 ? now + backoff(strikes) : 0);
          await options.save({until, strikes});
          slot.version++;
          if (until - now > shortWait || attempt === 5) throw new DropboxError('throttled');
        });
        attempt++;
      } finally {
        if (entry.release) { slot.probe = undefined; entry.release(); }
      }
    }
    throw new DropboxError('throttled');
  } finally {
    if (!--slot.users) map.delete(account);
  }
}
