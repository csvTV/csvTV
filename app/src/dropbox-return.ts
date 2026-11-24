interface Ticket { verifier: string; state: string; uri: string; appKey: string; createdAt: number; eraseGeneration?: string; attemptId?:string }
export interface DropboxCallback { ticket: Ticket | null; code: string | null }
/** The build also runs this dependency-free protocol in the head script on an OAuth return. */
export function dropboxReturnProtocol() {
  const signInWindow = 15 * 60_000;
  // Older shells cannot enforce either deadline. Give them no verifier or handoff to exchange.
  const ticketKey = 'csvTV/dropbox-pkce-v2';
  const attemptKey = 'csvTV/dropbox-attempt-v2';
  const callbackKey = (uri: URL) => 'csvTV/dropbox-callback-v2/' + uri.pathname;
  function dropboxRedirectUri(location: Pick<URL, 'origin' | 'pathname'>): string {
    return location.origin + location.pathname;
  }
  function currentTicket(ticket: Pick<Ticket, 'createdAt'> | null, now: number): boolean {
    return !!ticket && Number.isSafeInteger(ticket.createdAt) && ticket.createdAt <= now && now - ticket.createdAt < signInWindow;
  }

  // Keep only an attempt ID and timestamp after the code/verifier are consumed. Starting
  // another sign-in replaces this ID, including while the previous exchange is in flight.
  function attemptMarker(ticket: Ticket): string {
    return JSON.stringify({state:ticket.state, createdAt:ticket.createdAt});
  }

  function clearDropboxAttempt(win: Window) {
    try {
      const storage = win.sessionStorage;
      for (const key of [ticketKey,attemptKey,'csvTV/dropbox-pkce','csvTV/dropbox-omit-expiry']) storage.removeItem(key);
      // The same profile can have hosted csvTV at more than one path on this origin.
      for (let index = storage.length - 1; index >= 0; index--) {
        const key = storage.key(index);
        if (key?.startsWith('csvTV/dropbox-callback-v2/') || key?.startsWith('csvTV/dropbox-callback/')) storage.removeItem(key);
      }
    } catch { /* The durable erase generation also invalidates attempts in closed or unavailable tabs. */ }
  }

  /** Remove callback parameters before inspecting the ticket or opening storage. */
  function captureDropboxCallback(win: Window, now = Date.now()): DropboxCallback | null {
    const url = new URL(win.location.href);
    const returned = url.searchParams.has('code') || url.searchParams.has('error');
    const code = url.searchParams.getAll('code'), states = url.searchParams.getAll('state');
    const denied = url.searchParams.has('error');
    if (returned) {
      for (const key of ['code','state','error','error_description','error_uri']) url.searchParams.delete(key);
      win.history.replaceState(win.history.state,'',url.href);
    }
    let ticket: Ticket | null = null;
    try {
      win.sessionStorage.removeItem('csvTV/dropbox-pkce');
      win.sessionStorage.removeItem('csvTV/dropbox-callback/' + url.pathname);
      win.sessionStorage.removeItem('csvTV/dropbox-omit-expiry');
      const attempt = win.sessionStorage.getItem(attemptKey);
      if (attempt) {
        let fresh = false;
        try { fresh = currentTicket(JSON.parse(attempt),now); } catch { /* Discard malformed attempt IDs. */ }
        if (!fresh) win.sessionStorage.removeItem(attemptKey);
      }
      const stored = win.sessionStorage.getItem(ticketKey);
      if (stored) {
        let parsed: Ticket | null = null;
        try { parsed = JSON.parse(stored); } catch { /* Discard unreadable attempts. */ }
        if (!currentTicket(parsed, now)) win.sessionStorage.removeItem(ticketKey);
        else if (parsed && returned && states.length === 1 && parsed.state === states[0] &&
            parsed.uri === dropboxRedirectUri(url) && (denied || code.length === 1 && code[0])) {
          // A late return from an older attempt must leave the current tab's verifier intact.
          win.sessionStorage.removeItem(ticketKey);
          if (!denied && typeof parsed.verifier === 'string' && parsed.verifier.length >= 43) ticket = parsed;
          else if (attempt === attemptMarker(parsed)) win.sessionStorage.removeItem(attemptKey);
        }
      }
    } catch { /* A tab without its own verifier cannot complete this exchange. */ }
    return returned ? { ticket, code: ticket ? code[0] : null } : null;
  }

  /** Keep the unsubmitted return in this tab through a reload. Consume it before the exchange. */
  function prepareDropboxCallback(win: Window, now = Date.now) {
    let immediate = captureDropboxCallback(win, now());
    const url = new URL(win.location.href);
    const uri = dropboxRedirectUri(url);
    const key = callbackKey(url);
    let handoff: string | null = null;
    try {
      let previous = win.sessionStorage.getItem(key);
      if (previous) {
        let saved: DropboxCallback | null = null;
        try { saved = JSON.parse(previous); } catch { /* Discard unreadable handoffs. */ }
        if (!currentTicket(saved?.ticket ?? null, now())) {
          win.sessionStorage.removeItem(key);
          previous = null;
          immediate ??= {ticket:null,code:null};
        }
      }
      if (immediate && (immediate.ticket || !previous)) {
        if (immediate.ticket) {
          const saved = JSON.stringify(immediate);
          win.sessionStorage.setItem(key,saved);
          handoff = saved;
          immediate = null;
        }
      } else handoff = previous; // Return from an older attempt while a verified handoff is waiting.
      if (handoff) immediate = null;
    } catch {
      // A memory-only return belongs to this visit. A previous page can be restored from the back/forward cache.
      if (immediate?.ticket) win.addEventListener('pagehide', () => { immediate = null; }, {once:true});
    }
    return {
      get pending() { return !!(immediate || handoff); },
      get canResumeAfterReload() {
        try {
          return !!handoff && win.sessionStorage.getItem(key) === handoff && currentTicket(JSON.parse(handoff).ticket,now());
        } catch { return false; }
      },
      take(): DropboxCallback | null {
        const direct = immediate, stored = handoff;
        immediate = null; handoff = null;
        if (direct?.ticket) {
          try { if (win.sessionStorage.getItem(ticketKey)) return null; } catch { /* Already verified on this page. */ }
          if (!currentTicket(direct.ticket, now())) return {ticket:null,code:null};
        }
        if (direct || !stored) return direct;
        try {
          // A restored document must not replay a consumed handoff or take a later attempt's code.
          if (win.sessionStorage.getItem(key) !== stored) return null;
          win.sessionStorage.removeItem(key);
          const saved = JSON.parse(stored);
          if (currentTicket(saved?.ticket, now()) && saved.ticket.uri === uri && typeof saved.ticket.verifier === 'string' && saved.ticket.verifier.length >= 43 &&
              typeof saved.ticket.appKey === 'string' && typeof saved.code === 'string' && saved.code) return saved;
          return {ticket:null, code:null};
        } catch { return {ticket:null, code:null}; }
      },
      forget() { immediate = null; handoff = null; },
    };
  }

  return {signInWindow,ticketKey,attemptKey,callbackKey,dropboxRedirectUri,currentTicket,attemptMarker,clearDropboxAttempt,captureDropboxCallback,prepareDropboxCallback};
}
export const {signInWindow,ticketKey,attemptKey,callbackKey,dropboxRedirectUri,currentTicket,attemptMarker,clearDropboxAttempt,captureDropboxCallback,prepareDropboxCallback} = dropboxReturnProtocol();

// Only a tab that cannot persist the verified handoff needs the entry to collect it from memory.
let initial:ReturnType<typeof prepareDropboxCallback>|undefined;
export function keepDropboxReturn(prepared:ReturnType<typeof prepareDropboxCallback>) { initial = prepared; }
export function openingDropboxReturn(win:Window) {
  const prepared = initial;
  initial = undefined;
  return prepared ?? prepareDropboxCallback(win);
}
