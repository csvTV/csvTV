export interface ProviderReply { status: number; headers: Headers; value?: unknown }

/** Detach the previous read as soon as it settles, including adapters that ignore abort. */
export function abortableProviderRead<T>(signal: AbortSignal, operation: Promise<T>, releaseLate?: (value:T) => void): Promise<T> {
  return new Promise((resolve,reject) => {
    const aborted = () => reject(signal.reason);
    if (signal.aborted) aborted();
    else signal.addEventListener('abort',aborted,{once:true});
    Promise.resolve(operation).then(value => {
      signal.removeEventListener('abort',aborted);
      if (signal.aborted) releaseLate?.(value);
      else resolve(value);
    },error => {
      signal.removeEventListener('abort',aborted);
      reject(error);
    });
  });
}

export function releaseProviderResponse(response:Response) {
  void response.body?.cancel().catch(() => {});
}

/** Read streamed JSON with an inactivity deadline. Neither network errors nor failed
 * JSON parsing can expose a credential-bearing request URL or response body. */
export async function fetchProviderJson(url: URL, init: RequestInit, send: typeof fetch, inactivity: number,
    readError: (status: number) => boolean, failure: (kind: 'unreachable' | 'invalid-response') => Error,
    maxBytes: number): Promise<ProviderReply> {
  const controller = new AbortController();
  let unread: ReadableStream<Uint8Array> | null = null;
  let timer: ReturnType<typeof setTimeout>;
  const timedOut = () => controller.abort(failure('unreachable'));
  const caller = init.signal;
  const progress = () => { clearTimeout(timer); timer = setTimeout(timedOut, inactivity); };
  try {
    caller?.throwIfAborted();
    caller?.addEventListener('abort', timedOut, { once: true });
    progress();
    // Resource Timing retains complete request URLs across screens and sign-out.
    // Some providers require a key in the query. Stop buffering new URLs before
    // the first such request, including when its reply arrives after sign-out.
    if (url.searchParams.has('apikey') && typeof window !== 'undefined') window.performance.setResourceTimingBufferSize?.(0);
    const response = await abortableProviderRead(controller.signal,send(url, {
      ...init, redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: controller.signal,
    }),releaseProviderResponse);
    unread = response.body;
    progress();
    const { status, headers } = response;
    // No caller requests a byte range. A JSON fragment may still parse as an entire season or list.
    if (status === 206) throw new SyntaxError();
    if (!response.ok && !readError(status)) return { status, headers };
    if (Number(headers.get('Content-Length')) > maxBytes) {
      if (!response.ok) return {status,headers};
      throw new SyntaxError();
    }
    const reader = response.body?.getReader();
    if (!reader) {
      if (response.ok) throw new SyntaxError();
      return { status, headers };
    }
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let text = '', bytes = 0;
    try {
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try { chunk = await abortableProviderRead(controller.signal,reader.read()); }
        catch { throw failure('unreachable'); }
        if (chunk.done) unread = null;
        if (chunk.value?.length) {
          bytes += chunk.value.byteLength;
          if (bytes > maxBytes) throw new SyntaxError();
          progress();
        }
        try { text += decoder.decode(chunk.value, { stream: !chunk.done }); }
        catch { throw new SyntaxError(); }
        if (chunk.done) break;
      }
    } catch (error) {
      caller?.throwIfAborted();
      if (!response.ok) return { status, headers };
      throw error;
    } finally { reader.releaseLock(); }
    try { return { status, headers, value: JSON.parse(text) }; }
    catch {
      if (!response.ok) return { status, headers, value:text };
      throw new SyntaxError();
    }
  } catch (error) {
    caller?.throwIfAborted();
    throw failure(error instanceof SyntaxError ? 'invalid-response' : 'unreachable');
  } finally {
    caller?.removeEventListener('abort', timedOut);
    clearTimeout(timer!);
    void unread?.cancel().catch(() => {});
    controller.abort();
  }
}

/** Normalize the two legacy HTTP-date formats to IMF-fixdate before validating the UTC date. */
function httpDate(value: string, now: number): number {
  const asctime = /^(\w{3}) (\w{3}) ( \d|\d{2}) (\d\d:\d\d:\d\d) (\d{4})$/.exec(value);
  const legacy = /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), (\d\d)-(\w{3})-(\d\d) (\d\d:\d\d:\d\d) GMT$/.exec(value);
  if (asctime) {
    const [, weekday, month, day, time, year] = asctime;
    value = weekday + ', ' + day.trim().padStart(2, '0') + ' ' + month + ' ' + year + ' ' + time + ' GMT';
  } else if (legacy) {
    const [, weekday, day, month, shortYear, time] = legacy;
    // RFC 9110 §5.6.7 interprets two-digit years relative to the date of receipt.
    const limit = new Date(now);
    limit.setUTCFullYear(limit.getUTCFullYear() + 50);
    let year = limit.getUTCFullYear() - (limit.getUTCFullYear() - Number(shortYear)) % 100;
    const stamp = (y: number) => weekday.slice(0, 3) + ', ' + day + ' ' + month + ' ' + y + ' ' + time + ' GMT';
    if (Date.parse(stamp(year).replace('23:59:60', '23:59:59')) + (time === '23:59:60' ? 1000 : 0) > limit.getTime()) year -= 100;
    value = stamp(year);
  }
  if (!/^\w{3}, \d\d \w{3} \d{4} \d\d:\d\d:\d\d GMT$/.test(value)) return NaN;
  const leap = value.endsWith('23:59:60 GMT');
  const normalized = leap ? value.replace('23:59:60', '23:59:59') : value;
  const date = new Date(normalized);
  // Date.parse can roll an impossible February date into March and ignores the supplied weekday.
  return date.toUTCString() === normalized ? date.getTime() + (leap ? 1000 : 0) : NaN;
}

function futureDeadline(when: number, now: number): number | undefined {
  if (when > now && Number.isSafeInteger(when) && Number.isFinite(new Date(when).getTime())) return when;
}
function retryAfter(headers: Headers, now: number) {
  const retry = headers.get('Retry-After')?.trim();
  if (retry) return futureDeadline(/^\d+$/.test(retry) ? now + Number(retry) * 1000 : httpDate(retry, now), now);
}

/** A service outage can request a wait independently of any ordinary quota reset header. */
export function serviceRetryAt(reply: Pick<ProviderReply,'status'|'headers'>, now: number): number | undefined {
  return reply.status === 503 ? retryAfter(reply.headers,now) : undefined;
}

export function providerDeadline(headers: Headers, now: number): number | undefined {
  const reset = headers.get('X-RateLimit-Reset')?.trim();
  const quota = reset && /^\d+$/.test(reset) ? futureDeadline(Number(reset) * 1000,now) : undefined;
  const wait = retryAfter(headers,now);
  return wait === undefined ? quota : Math.max(wait,quota ?? wait);
}
