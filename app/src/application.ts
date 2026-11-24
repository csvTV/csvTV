import { isDisplaySetting } from './display-preferences.ts';
import { mountNotices } from './notices.ts';
import { createNoticeHistory } from './notice-history.ts';
import {createNavigationHistory, type VisitValue} from './navigation-history.ts';
import { createLibraryHistory } from './library-history.ts';
import { affectsStatisticsScores, createStatisticsHistory } from './statistics-data.ts';
import type { DropboxController } from './dropbox-controller.ts';
import { mountDropboxSettings } from './dropbox-settings.ts';
import { mountDropboxSetup } from './dropbox-setup-screen.ts';
import type { MalService } from './mal-service.ts';
import type { ImdbService } from './imdb-service.ts';
import type { MdbListService } from './mdblist-service.ts';
import { moduleReloadButton, mountOfflineSettings, type OfflineShell } from './offline.ts';
import { Appearance, mountAppearance } from './appearance.ts';
import { parentRoute, readRoute, routeHref } from './navigation.ts';
import type { Screen, ScreenContext, Route, SettingsFocus } from './screen-context.ts';
import { TmdbError } from './tmdb-client.ts';
import type { TmdbService } from './tmdb-service.ts';
import type { RecordChange } from './storage.ts';
import { WatchActions, EpisodeChangedError, type RemovalQuestion, type UndoBar } from './watch-actions.ts';
import { PersonalRecordError, type ListQuestion } from './personal-record.ts';

const paths = {
  home: 'M3 10 12 3l9 7v10h-6v-6H9v6H3z',
  library: 'M3 4h4v16H3zM9 4h4v16H9zM15 5l4-1 3 15-4 1z',
  ratings: 'm12 3 2.8 5.7 6.3.9-4.5 4.4 1 6.2-5.6-3-5.6 3 1-6.2-4.5-4.4 6.3-.9z',
  watchlist: 'M6 3h12v18l-6-4-6 4z',
  lists: 'M8 5h13M8 12h13M8 19h13M3 5h.5M3 12h.5M3 19h.5',
  statistics: 'M3 20h18M6 16v-5m6 5V4m6 12V8',
  export: 'M12 15V3m-4 4 4-4 4 4M7 10H4v11h16V10h-3',
  settings: 'M4 6h5m5 0h6M4 12h10m5 0h1M4 18h2m5 0h9 M9 3v6m5 0v6M7 15v6',
  back: 'm14 5-7 7 7 7',
};
function icon(name: keyof typeof paths) {
  return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + paths[name] + '"/></svg>';
}
const navLabels = { home: 'Home', library: 'Library', ratings: 'Ratings', watchlist: 'Watchlist',
  lists: 'Lists', statistics: 'Statistics', export: 'Export', settings: 'Settings' };
const screenLabels: Record<Route['page'],string> = {...navLabels,search:'Search',show:'Show',season:'Season',cast:'Cast member',
  recovery:'Backups and restore','hand-merge':'Merge by hand','imdb-ratings':'IMDb ratings','mal-scores':'MyAnimeList scores',
  'trakt-import':'Import from Trakt','anilist-import':'Import from AniList'};
function destinations(pages: (keyof typeof navLabels)[], phone = false) {
  return pages.map(page => '<a href="#/' + page + '" data-destination="' + page + '">' + icon(page) +
    '<span>' + (phone && page === 'statistics' ? 'Stats' : navLabels[page]) + '</span></a>').join('');
}

// Cache module exports only. The mount runs after navigation and account checks,
// including when a second route opens while its first download is in flight.
function viewModule<T extends object>(load:()=>Promise<T>) {
  let loaded:T|undefined;
  return {
    get ready() { return !!loaded; },
    prepare(mount:(views:T)=>Screen) {
      const current = loaded;
      if (current) return () => mount(current);
      return load().then(views => { loaded = views; return () => mount(views); });
    },
  };
}
const records = viewModule(() => import('./record-screens.ts'));
const catalog = viewModule(() => import('./catalog-screens.ts'));
const settings = viewModule(() => import('./settings-screens.ts'));
const recovery = viewModule(() => import('./recovery-screen.ts'));
const handMerge = viewModule(() => import('./hand-merge-screen.ts'));
const exportView = viewModule(() => import('./export-screen.ts'));
const trakt = viewModule(() => import('./trakt-import-screen.ts'));
const anilist = viewModule(() => import('./anilist-import-screen.ts'));

/** Use the same route mounts and persistence in the application and browser acceptance tests. */
export function mountApplication(root: HTMLElement, service: TmdbService, cacheUpdates?: EventTarget, cloud?: DropboxController, offline?: OfflineShell, critics?: MdbListService, imdb?: ImdbService, mal?: MalService, initial?: {accountId: string | null}) {
  const doc = root.ownerDocument;
  const win = doc.defaultView!;
  const history = win.history;
  const listener = new AbortController();
  const options = { signal: listener.signal };
  // WebKit can keep :focus-visible on script-focused headings and buttons after a tap.
  // Track the actual input so the same device can switch straight back to keyboard navigation.
  doc.addEventListener('pointerdown', event => {
    doc.documentElement.toggleAttribute('data-touch-input',event.pointerType === 'touch' || event.pointerType === 'pen');
    doc.documentElement.toggleAttribute('data-mouse-input',event.pointerType === 'mouse');
  }, { ...options, capture:true });
  doc.addEventListener('keydown', event => {
    if (event.isComposing) return;
    const target = event.target as HTMLElement | null;
    const selectByTyping = event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey && target?.closest?.('select');
    if (!selectByTyping && !['Tab','Escape','Enter',' ','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','PageUp','PageDown'].includes(event.key)) return;
    // Moving a caret or choosing an IME candidate keeps focus in the same touch editor.
    if (event.key !== 'Tab' && event.key !== 'Escape') {
      if (target?.isContentEditable || target?.matches?.(
        'textarea,input:not([type]),input:is([type=text],[type=search],[type=email],[type=password],[type=url],[type=tel],[type=number])'
      )) return;
    }
    doc.documentElement.removeAttribute('data-touch-input');
    doc.documentElement.removeAttribute('data-mouse-input');
  }, { ...options, capture:true });
  const libraryHistory = createLibraryHistory(service.store,listener.signal);
  const statisticsHistory = createStatisticsHistory(service,listener.signal);
  const appearance = new Appearance(doc, service.store);
  root.innerHTML = `<div class="app-frame"><a class="skip-link" href="#screen">Skip to content</a>
    <aside class="app-sidebar"><a class="app-name" href="#/home">csvTV</a><nav aria-label="Main navigation">${destinations(['home', 'library', 'ratings', 'watchlist', 'lists', 'statistics', 'export', 'settings'])}</nav>
    <div class="cloud-status"><a href="#/settings" class="sync-state">Not synced</a><button data-cloud-sign hidden>Sign in</button></div></aside><div class="app-column">
    <header class="phone-header"><button class="phone-back" aria-label="Go back">${icon('back')}Back</button>
      <a class="app-name" href="#/home">csvTV</a><span class="phone-title" aria-hidden="true" hidden></span><div class="cloud-status"><a href="#/settings" class="sync-state">Not synced</a><button data-cloud-sign hidden>Sign in</button></div>
      <a class="settings-shortcut" href="#/settings" aria-label="Settings">${icon('settings')}</a></header>
    <div class="tab-status-area"><p class="tab-state" role="status"></p></div>
    <div class="reports"></div><main id="screen" tabindex="-1"></main></div>
    <nav class="phone-nav" aria-label="Main navigation">${destinations(['home', 'library', 'ratings', 'watchlist', 'lists', 'statistics'], true)}</nav>
    <div class="undo-bar" hidden><span role="status"></span>
      <button data-undo>Undo</button></div></div>`;
  const one = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const content = one('main'), notices = mountNotices(one('.reports'),content), bar = one('.undo-bar');
  const tabState = one('.tab-state');
  const tabStatusArea = one('.tab-status-area');
  // If this tab becomes writable during a press, keep the target under the pointer until the click.
  content.addEventListener('pointerdown', event => {
    if (event.isPrimary && service.store.role === 'reader') tabStatusArea.style.minHeight = win.getComputedStyle(tabStatusArea).height;
  }, options);
  const releaseStatusSpace = () => { tabStatusArea.style.minHeight = ''; };
  win.addEventListener('pointerup', () => {
    if (tabStatusArea.style.minHeight) win.setTimeout(releaseStatusSpace, 0);
  }, options);
  win.addEventListener('pointercancel', releaseStatusSpace, options);
  win.addEventListener('blur', releaseStatusSpace, options);
  const back = one<HTMLButtonElement>('.phone-back');
  const desktopBack = back.cloneNode(true) as HTMLButtonElement;
  desktopBack.className = 'desktop-back';
  let route = readRoute(win.location.hash);
  if (!Number.isSafeInteger(history.state?.csvtvDepth)) {
    history.replaceState({...history.state, csvtvDepth:0}, '');
  }
  let activeDepth = history.state.csvtvDepth as number;
  let returningToDecision = false;
  let screen: Screen | undefined;
  let disposeQuestion: (() => void) | undefined;
  let mountId = 0;
  let refreshTimer: number | undefined;
  let cacheTimer: number | undefined;
  let refreshingCache: Screen | undefined;
  let cacheChanged = false;
  let midnightTimer: number | undefined;
  let scheduledMidnight: number | undefined;
  let closed = false;
  let accountId = initial?.accountId;
  let accountCheck = 0;
  let libraryVisitScope = crypto.randomUUID();
  const visitHistory = createNavigationHistory(win,service.store);
  const noticeHistory = createNoticeHistory(service.store,()=>accountId ?? null);

  async function checkAccount() {
    const check = ++accountCheck;
    const state = await service.store.dropboxState('registration');
    if (closed || content.inert || check !== accountCheck || state.accountId === accountId) return;
    if (accountId && !state.accountId) {
      service.store.dispatchEvent(new Event('deviceerased'));
      return;
    }
    if (accountId) { notices.clear(); noticeHistory.reset(); }
    visitHistory.clear();
    accountId = state.accountId;
    libraryVisitScope = crypto.randomUUID();
    await open(route, true);
  }
  const canAccessKeys = () => !cloud || Boolean(accountId && cloud.signedIn && !cloud.mismatch &&
    win.navigator.onLine && service.store.providerKeysAvailable);
  function keyAccessMessage() {
    if (service.store.role === 'reader' && service.store.readOnlyReason) return service.store.readOnlyReason;
    if (!win.navigator.onLine) return 'Go online to access your keys in Dropbox.';
    if (cloud?.mismatch) return 'Sign in to the Dropbox account linked to this record to access your keys.';
    if (!cloud?.signedIn) return 'Sign in to Dropbox to access your keys.';
    if (service.store.role === 'reader') return 'Use the editing tab to manage your Dropbox keys.';
    return cloud.operation === 'sync' ? 'Loading keys from Dropbox…' : 'Sync with Dropbox to load your keys.';
  }

  function notice(message: string, retry?: () => Promise<void>, quota = false, signal?: AbortSignal) {
    if (closed || signal?.aborted) return;
    const origin = mountId, record = watch.recordGeneration;
    const current = () => !closed && !signal?.aborted && origin === mountId && record === watch.recordGeneration;
    noticeHistory.add(message);
    notices.add(message,retry && {label:quota ? 'Clear cached titles and retry' : 'Try again',action:() => {
      void run(async () => {
        if (!current()) return;
        if (quota) await service.store.clearRebuildableCaches();
        if (current()) await retry();
      },signal);
    }},signal);
  }
  async function run(action: () => Promise<void>, signal?: AbortSignal) {
    const id = mountId, record = watch.recordGeneration;
    try { await action(); }
    catch (error) {
      if (id !== mountId || closed || signal?.aborted) return;
      const sameRecord = record === watch.recordGeneration;
      if (!sameRecord && error instanceof TmdbError && error.kind === 'superseded') return;
      const quota = error instanceof DOMException && error.name === 'QuotaExceededError';
      if (error instanceof EpisodeChangedError || error instanceof PersonalRecordError) { notice(error.message); return; }
      const message = quota ? 'This device is out of space. The change was not saved.'
        : error instanceof TmdbError ? error.message : error instanceof RangeError ? error.message : 'Could not complete this action.';
      notice(message, sameRecord ? action : undefined, quota, signal);
    }
  }
  function confirmChange(title: string, description: string, action: string, destructive: boolean): Promise<boolean> {
    disposeQuestion?.();
    const origin = doc.activeElement as HTMLElement | null;
    const dialog = doc.createElement('dialog');
    dialog.className = 'remove-question';
    dialog.setAttribute('aria-labelledby', 'remove-title');
    dialog.setAttribute('aria-describedby', 'remove-count');
    dialog.innerHTML = '<div class="sheet"><h2 id="remove-title"></h2><p id="remove-count"></p>' +
      '<div class="actions"><button data-cancel>Cancel</button><button data-accept></button></div></div>';
    dialog.querySelector('h2')!.textContent = title;
    dialog.querySelector('p')!.textContent = description;
    const accept = dialog.querySelector<HTMLButtonElement>('[data-accept]')!;
    accept.textContent = action;
    accept.className = destructive ? 'destructive' : 'primary';
    root.append(dialog);
    return new Promise(resolve => {
      const finish = (answer: boolean) => {
        disposeQuestion = undefined;
        dialog.close(); dialog.remove();
        if (origin?.isConnected) origin.focus(); else content.focus();
        resolve(answer);
      };
      disposeQuestion = () => finish(false);
      const cancel = dialog.querySelector<HTMLButtonElement>('[data-cancel]')!;
      cancel.onclick = () => finish(false);
      accept.onclick = () => finish(true);
      dialog.oncancel = event => { event.preventDefault(); finish(false); };
      dialog.onkeydown = event => {
        if (event.key !== 'Tab') return;
        if (event.shiftKey && doc.activeElement === cancel) { event.preventDefault(); accept.focus(); }
        else if (!event.shiftKey && doc.activeElement === accept) { event.preventDefault(); cancel.focus(); }
      };
      dialog.showModal(); cancel.focus();
    });
  }
  function confirmRemoval(q: RemovalQuestion) {
    const description = 'Remove ' + q.plays.toLocaleString('en-US') + (q.plays === 1n ? ' play' : ' plays') + ' from ' +
      q.episodes.toLocaleString('en-US') + (q.episodes === 1 ? ' episode' : ' episodes') + ' in ' + q.title + '?';
    return confirmChange('Remove watches?', description, 'Remove watches', true);
  }
  function confirmList(q: ListQuestion) {
    const count = q.count.toLocaleString() + (q.count === 1 ? ' show' : ' shows');
    if (q.kind === 'rename') {
      return confirmChange('Rename list?', 'Rename “' + q.name + '” to “' + q.newName + '” for ' + count + '?', 'Rename list', false);
    }
    const detail = q.kind === 'last-show' ? '“' + q.name + '” holds one show. Removing it deletes the list.'
      : 'Delete “' + q.name + '” and remove its ' + count + ' from this list?';
    return confirmChange('Delete list?', detail, 'Delete list', true);
  }
  function showUndo(value: UndoBar | null) {
    const focused = bar.contains(doc.activeElement);
    bar.hidden = !value;
    bar.querySelector('span')!.textContent = value?.label ?? '';
    if (focused && !value) content.focus({ preventScroll: true });
  }
  const watch = new WatchActions(service, confirmRemoval, showUndo, notice, confirmList);
  function clearRecordActions() {
    watch.clear();
    notices.clearRetries();
  }
  function startSignIn() {
    if (!cloud || cloud.signedIn || cloud.busy || service.store.role !== 'writer') return;
    if (!cloud.auth.appKey) {
      go({page:'settings'},'dropbox-label');
      return;
    }
    void cloud.signIn().catch(error=>notice(cloud.failure(error)));
  }
  if (cloud) {
    let lastHomeStatus = '';
    cloud.hooks.answered = clearRecordActions;
    cloud.hooks.notice = message => notice(message);
    cloud.hooks.noticeGroup = (label,messages) => {
      if (closed) return;
      noticeHistory.addGroup(messages);
      notices.add(label,undefined,undefined,messages);
    };
    cloud.hooks.protect = (table, keys) => watch.protect(table === 'watched' ? keys : [],table === 'lists' ? keys : [],table === 'ratings' ? keys : []);
    const updateStatus = () => {
      if (route.page === 'imdb-ratings' || route.page === 'mal-scores') queueRefresh();
      const status = [cloud.signedIn, cloud.busy, service.store.role].join('/');
      if (status !== lastHomeStatus && route.page === 'home') queueRefresh();
      lastHomeStatus = status;
      for (const label of root.querySelectorAll<HTMLElement>('.sync-state')) {
        label.textContent = cloud.synced ? 'Synced' : 'Not synced'; label.dataset.synced = String(cloud.synced);
      }
      for (const button of root.querySelectorAll<HTMLButtonElement>('[data-cloud-sign]')) {
        button.hidden = cloud.signedIn || service.store.role !== 'writer'; button.disabled = cloud.busy || !win.navigator.onLine;
        button.onclick = startSignIn;
      }
    };
    cloud.changed.addEventListener('change',updateStatus,options); updateStatus();
  }
  function go(next: Route, focusTarget?:SettingsFocus) {
    if (content.inert) return;
    if (doc.querySelector('dialog.dropbox-dialog:not([data-screen-review])[open],dialog[data-dropbox-hold][open]')) return;
    const target = routeHref(next);
    if (target === routeHref(route)) {
      if (focusTarget) doc.getElementById(focusTarget)?.focus();
      return;
    }
    history.pushState({ csvtvDepth: (Number(history.state?.csvtvDepth) || 0) + 1 }, '', target);
    void open(next, true, focusTarget);
  }
  const ctx: ScreenContext = { service, critics, imdb, mal, go, run, watch, canAccessKeys, clearUndo: clearRecordActions,
    openTraktImport: cloud ? () => go({page:'trakt-import'}) : undefined,
    openAniListImport: cloud ? () => go({page:'anilist-import'}) : undefined,
    signInDropbox:cloud ? startSignIn : undefined,
    canSignInDropbox:cloud ? () => !cloud.busy && win.navigator.onLine : undefined,
    saveView(state) {
      if ('moreSort' in state && route.page === 'watchlist') visitHistory.save({page:'watchlist',moreSort:state.moreSort});
      else if ('page' in state && state.page === route.page) visitHistory.save(state);
    },
    selectList(name) {
      if (route.page === 'lists') visitHistory.save({page:'lists',name});
    },
    searchQuery(query) {
      if (route.page !== 'search' || route.query === query) return;
      route = { page: 'search', query };
      history.replaceState(history.state, '', routeHref(route));
    },
  };
  function disposeScreen(keepLayout = false) {
    win.clearTimeout(cacheTimer);
    cacheTimer = undefined;
    refreshingCache = undefined;
    cacheChanged = false;
    if (keepLayout) {
      for (const child of content.children) if (child instanceof HTMLElement) child.inert = true;
    }
    screen?.dispose(keepLayout);
    screen = undefined;
  }
  function role() {
    const obsolete = service.store.role === 'obsolete' || service.store.role === 'closed';
    content.inert = obsolete;
    tabState.textContent = service.store.role === 'reader' ? service.store.readOnlyReason ?? 'Another tab is using csvTV. This tab is read-only.'
      : obsolete ? 'Reload csvTV to continue with this record. ' : '';
    if (obsolete) {
      ++mountId;
      disposeQuestion?.(); watch.clear();
      disposeScreen();
      const reload = doc.createElement('button');
      reload.textContent = 'Reload';
      reload.onclick = () => cloud ? void cloud.reload() : win.location.reload();
      tabState.append(reload);
      reload.focus({preventScroll:true});
    }
  }
  function updateTitle(fallback?: string) {
    const title = content.querySelector('h1')?.textContent || fallback;
    if (!title) return;
    if (content.getAttribute('aria-label') !== title) content.setAttribute('aria-label', title);
    const tabTitle = title + ' · csvTV';
    if (doc.title !== tabTitle) doc.title = tabTitle;
  }
  function queueRefresh() {
    if (!screen || content.inert) return;
    if (route.page === 'export') {
      // Disable the old share payload and download URLs as soon as the committed inputs change.
      const active = screen;
      void run(() => active.refresh());
      return;
    }
    if (refreshTimer !== undefined) return;
    refreshTimer = win.setTimeout(() => {
      refreshTimer = undefined;
      const active = screen;
      if (active) void run(async () => {
        await active.refresh();
        if (screen === active && !closed) updateTitle();
      });
    }, 0);
  }
  function scheduleMidnight() {
    const now = service.environment.now();
    const next = new Date(now);
    next.setHours(24, 0, 0, 0);
    const midnight = next.getTime();
    const changed = scheduledMidnight !== midnight;
    win.clearTimeout(midnightTimer);
    scheduledMidnight = midnight;
    midnightTimer = win.setTimeout(() => { queueRefresh(); scheduleMidnight(); }, midnight - now);
    return changed;
  }
  function mountSettings(views:typeof import('./settings-screens.ts')):Screen {
    const tmdb = views.mountTmdbSettings(content, service, true, canAccessKeys, keyAccessMessage);
    const scores = critics && views.mountMdbListSettings(content, critics, service.store, canAccessKeys, keyAccessMessage);
    const imdbSettings = imdb && views.mountImdbSettingsRow(content, imdb);
    const malSettings = mal && views.mountMalSettingsRow(content, mal);
    const dropbox = cloud && mountDropboxSettings(content,ctx,cloud);
    if (cloud) {
      const imports = doc.createElement('section');
      imports.className = 'group settings-imports';
      imports.innerHTML = '<h2>Imports</h2><div class="actions"><a class="button" href="#/trakt-import">Import from Trakt</a>' +
        '<a class="button" href="#/anilist-import">Import from AniList</a></div>';
      content.querySelector('#settings-services')!.after(imports);
    }
    const exportLink = doc.createElement('a');
    exportLink.className = 'button settings-phone-export';
    exportLink.href = '#/export';
    exportLink.textContent = 'Export watch record';
    (content.querySelector('.settings-imports') ?? content.querySelector('#settings-services')!).after(exportLink);
    const disposeAppearance = mountAppearance(content, appearance);
    const disposeOffline = (offline || cloud) && mountOfflineSettings(content, offline);
    const clear = cloud && views.mountClearDevice(content.querySelector('.offline-settings')!,ctx,cloud);
    const disposeLog = noticeHistory.mount(content);
    content.append(content.querySelector('[data-source-credits]')!);
    const updateKey = () => { void tmdb.refresh(); void scores?.refresh(); };
    cloud?.changed.addEventListener('change',updateKey);
    return { ready:Promise.all([tmdb.ready, scores?.ready, imdbSettings?.ready, malSettings?.ready, appearance.ready]).then(() => {}),
      refresh:async () => { dropbox?.refresh(); await Promise.all([tmdb.refresh(), scores?.refresh(), imdbSettings?.refresh(), malSettings?.refresh()]); },
      dispose(keepLayout){cloud?.changed.removeEventListener('change',updateKey);clear?.dispose();disposeAppearance();disposeOffline?.();disposeLog();
        dropbox?.dispose();scores?.dispose(keepLayout);imdbSettings?.dispose(keepLayout);malSettings?.dispose(keepLayout);tmdb.dispose(keepLayout);} };
  }
  async function open(next: Route, focus = false, focusTarget?:SettingsFocus) {
    if (closed || content.inert) return;
    scheduleMidnight();
    const id = ++mountId;
    const previous = route;
    let restoreFocusedBack = false;
    win.clearTimeout(refreshTimer); refreshTimer = undefined;
    disposeQuestion?.();
    watch.leaveScreen();
    const needsDropbox = cloud && !accountId;
    // Keep the Settings tiles in place while a warm report checks its record. Editors close immediately.
    const keepSettingsLayout = previous.page === 'settings' && next.page === 'statistics' && !needsDropbox && records.ready &&
      !!statisticsHistory.read(service.environment.now()) && !content.querySelector('dialog[open],input[type=password],form:not([hidden])');
    disposeScreen(keepSettingsLayout);
    route = next;
    if (next.page === 'watchlist' && next.section && win.location.hash !== routeHref(next)) {
      history.replaceState(history.state, '', routeHref(next));
    }
    activeDepth = history.state?.csvtvDepth ?? 0;
    notices.clearRetries();
    const visit = visitHistory.open(needsDropbox ? 'dropbox-setup' : next.page,cloud ? accountId ?? null : undefined);
    if (next.page !== 'statistics' || !records.ready || needsDropbox) content.replaceChildren();
    root.dataset.page = needsDropbox ? 'dropbox-setup' : next.page;
    const tabTitle = next.page === 'library' || next.page === 'watchlist' || next.page === 'lists' || next.page === 'ratings' || next.page === 'statistics'
      ? navLabels[next.page] : '';
    const screenName = screenLabels[next.page];
    content.setAttribute('aria-label', screenName);
    back.hidden = next.page === 'home' || Boolean(tabTitle);
    const shellTitle = next.page === 'statistics';
    one('.phone-title').hidden = !shellTitle;
    one('.phone-title').textContent = tabTitle;
    one('.phone-header .app-name').hidden = shellTitle;
    for (const link of root.querySelectorAll<HTMLElement>('[data-destination]')) {
      if (link.dataset.destination === next.page) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
    }
    try {
      if (needsDropbox) {
        screen = mountDropboxSetup(content, ctx, cloud, offline);
      } else {
        let saved:VisitValue|void;
        const prepare = () => {
          switch (next.page) {
            case 'home': return records.prepare(v => v.mountHomeScreen(content,ctx));
            case 'library': return records.prepare(v => v.mountLibraryScreen(content,ctx,saved?.page === 'library' ? saved : undefined,
              !!cloud,previous.page === 'show' ? previous.id : undefined,libraryVisitScope,libraryHistory));
            case 'watchlist': return records.prepare(v => v.mountWatchlistScreen(content,ctx,
              saved?.page === 'watchlist' && saved.moreSort === 'title' ? 'title' : 'left',next.section));
            case 'statistics': return records.prepare(v => v.mountStatisticsScreen(content,ctx,statisticsHistory));
            case 'season': return records.prepare(v => v.mountSeasonScreen(content,ctx,next.id,next.season));
            case 'ratings': return catalog.prepare(v => v.mountRatingsScreen(content,ctx));
            case 'cast': return catalog.prepare(v => v.mountCastScreen(content,ctx,next.id,next.showId));
            case 'search': return catalog.prepare(v => v.mountSearchScreen(content,ctx,next.query));
            case 'show': return catalog.prepare(v => v.mountShowScreen(content,ctx,next.id));
            case 'lists': return catalog.prepare(v => v.mountListsScreen(content,ctx,saved?.page === 'lists' ? saved.name : undefined));
            case 'export': return exportView.prepare(v => v.mountExportScreen(content,ctx));
            case 'trakt-import': return cloud && trakt.prepare(v => v.mountTraktImport(content,ctx,cloud));
            case 'anilist-import': return cloud && anilist.prepare(v => v.mountAniListImport(content,ctx,cloud));
            case 'recovery': return cloud && recovery.prepare(v => v.mountRecoveryScreen(content,ctx,cloud));
            case 'hand-merge': return cloud && handMerge.prepare(v => v.mountHandMerge(content,ctx,cloud));
            case 'imdb-ratings': return imdb && settings.prepare(v => v.mountImdbRatings(content,imdb,service.store,canAccessKeys,keyAccessMessage,cloud));
            case 'mal-scores': return mal && settings.prepare(v => v.mountMalScores(content,mal,service.store,canAccessKeys,keyAccessMessage,cloud));
            case 'settings': return settings.prepare(mountSettings);
          }
        };
        const prepared = prepare();
        if (!prepared) { go({page:'settings'}); return; }
        const navigateFocus = focus;
        const showHeading = () => {
          const heading = doc.createElement('h1');
          heading.textContent = screenName;
          if (parentRoute(next).page === 'settings' || next.page === 'season') content.append(desktopBack);
          content.append(heading);
          doc.title = screenName + ' · csvTV';
        };
        try {
          let mount;
          if (typeof prepared === 'function') mount = prepared;
          else {
            const startup = (win as Window & {csvTVStartup?:{preloadPage?(page:string):void}}).csvTVStartup;
            startup?.preloadPage?.(next.page);
            showHeading();
            if (focus) { content.focus({preventScroll:true}); win.scrollTo(0,0); }
            mount = await prepared;
            if (closed || id !== mountId || content.inert) return;
            focus = false;
          }
          if (visit) saved = await visit;
          if (closed || id !== mountId || content.inert) return;
          if (typeof prepared !== 'function') {
            restoreFocusedBack = doc.activeElement === desktopBack;
            content.replaceChildren();
          }
          screen = mount();
        } catch {
          if (closed || id !== mountId || content.inert) return;
          // A successfully fetched older module may still lack this screen. Retrying its cached namespace cannot repair it.
          const keepBack = restoreFocusedBack || doc.activeElement === desktopBack;
          const focusRetry = navigateFocus && doc.activeElement === content;
          content.replaceChildren();
          showHeading();
          const reason = doc.createElement('p');
          reason.setAttribute('role','status');
          reason.textContent = next.page === 'trakt-import' || next.page === 'anilist-import'
            ? 'The importer could not load. Reload csvTV to try again.' : 'This screen could not load. Reload csvTV to try again.';
          const reload = moduleReloadButton(reason,service.store,next.page);
          content.append(reason,reload);
          if (keepBack) desktopBack.focus({preventScroll:true});
          else if (focusRetry) reload.focus({preventScroll:true});
          return;
        }
      }
      if (!needsDropbox && (parentRoute(next).page === 'settings' || next.page === 'season')) content.prepend(desktopBack);
      if (restoreFocusedBack) desktopBack.focus({preventScroll:true});
      doc.title = screenName + ' · csvTV';
      if (focusTarget && next.page === 'settings' && (focus || doc.activeElement === content)) {
        doc.getElementById(focusTarget)?.focus();
      } else if (focus) {
        if (next.page !== 'search') content.focus({ preventScroll: true });
        win.scrollTo(0, 0);
      }
      await screen.ready;
      if (mountId === id) updateTitle(screenName);
    } catch {
      if (mountId === id) notice('Could not open this screen.', () => open(next));
    }
  }
  function onHistory() {
    // The browser creates untagged entries when a user follows a native hash or edits the address.
    if (!Number.isSafeInteger(history.state?.csvtvDepth)) {
      history.replaceState({...history.state, csvtvDepth:activeDepth + 1}, '');
    }
    if (returningToDecision) {
      if (history.state?.csvtvDepth === activeDepth && routeHref(readRoute(win.location.hash)) === routeHref(route)) {
        returningToDecision = false;
      }
      return;
    }
    if (doc.querySelector('dialog.dropbox-dialog:not([data-screen-review])[open],dialog[data-dropbox-hold][open]')) {
      if (routeHref(readRoute(win.location.hash)) !== routeHref(route) || history.state?.csvtvDepth !== activeDepth) {
        const destination = history.state?.csvtvDepth;
        // Restore the actual entry so Back still reaches its original destination after the decision.
        returningToDecision = true;
        history.go(Number.isSafeInteger(destination) && destination !== activeDepth ? activeDepth - destination : -1);
      }
      return;
    }
    const next = readRoute(win.location.hash);
    if (routeHref(next) !== routeHref(route) || history.state.csvtvDepth !== activeDepth) void open(next, true);
  }
  root.addEventListener('click', event => {
    if (event.defaultPrevented || event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const anchor = (event.target as Element).closest('a[href^="#/"]');
    if (anchor && !anchor.hasAttribute('target')) {
      event.preventDefault(); go(readRoute(anchor.getAttribute('href')!));
    }
  }, options);
  one('.skip-link').onclick = event => { event.preventDefault(); content.focus(); };
  function goBack() {
    if (history.state?.csvtvDepth > 0) history.back();
    else {
      const parent = parentRoute(route);
      history.replaceState({ csvtvDepth: 0 }, '', routeHref(parent));
      void open(parent, true);
    }
  }
  back.onclick = desktopBack.onclick = goBack;
  one('[data-undo]').onclick = () => void run(() => watch.undo());
  win.addEventListener('popstate', onHistory, options);
  win.addEventListener('hashchange', onHistory, options);
  service.store.addEventListener('rolechange', () => { role(); queueRefresh(); }, options);
  if (cloud) service.store.addEventListener('dropboxchange', () => { void run(checkAccount); }, options);
  if (cloud) service.store.addEventListener('deviceerased', () => {
    ++accountCheck;
    accountId = null;
    visitHistory.clear();
    libraryVisitScope = crypto.randomUUID();
    notices.clear();
    noticeHistory.reset();
    history.replaceState({csvtvDepth:0},'',routeHref({page:'home'}));
    void run(() => open({page:'home'},true));
  }, options);
  service.store.addEventListener('providerkeyschange', queueRefresh, options);
  service.store.addEventListener('recentmarkschange', () => {
    if (service.store.role === 'reader' && route.page === 'home') queueRefresh();
  }, options);
  service.store.addEventListener('exportchange', () => {
    // Readers receive cross-tab invalidations after a watched edit or a show/season cache write.
    if (route.page === 'export' || (service.store.role === 'reader' &&
        (usesOverview() || ['search', 'show', 'season', 'lists'].includes(route.page)))) queueRefresh();
  }, options);
  service.store.addEventListener('recordchange', event => {
    const change = (event as CustomEvent<RecordChange>).detail;
    const refreshRatings = screen?.refreshRatings;
    if (refreshRatings && change.tables.length === 1 && change.tables[0] === 'ratings' && !change.localKeys.length) {
      void run(refreshRatings);
      return;
    }
    // Display controls observe their own settings even when Dropbox or a sibling tab changes them.
    if (change.tables.length === 1 && change.tables[0] === 'settings' && !change.localKeys.length &&
        change.settings !== 'all' && change.settings.length && change.settings.every(isDisplaySetting)) return;
    if (route.page === 'statistics' && change.statisticsUnchangedAt !== undefined) return;
    // The Statistics controls observe their own preference. Neither preference edits the report's inputs.
    if (route.page === 'statistics' && !change.tables.length && change.localKeys.length &&
        change.localKeys.every(key => key === 'statisticsOpened' || key === 'statisticsScope')) return;
    if (route.page === 'export') return;
    if (!change.onlyDescriptions) queueRefresh();
    else if (usesOverview() || route.page === 'lists') onCacheChange();
  }, options);
  service.store.addEventListener('tmdbstatechange', queueRefresh, options);
  service.store.addEventListener('imdbchange', event => {
    if (route.page === 'statistics' && !affectsStatisticsScores(event)) return;
    if (['search','show','season','library','statistics','settings','imdb-ratings'].includes(route.page)) queueRefresh();
  }, options);
  service.store.addEventListener('malchange', event => {
    if (route.page === 'statistics' && !affectsStatisticsScores(event)) return;
    if (['search','show','season','library','statistics','settings','mal-scores'].includes(route.page)) queueRefresh();
  }, options);
  service.store.addEventListener('mdblistchange', event => {
    if (route.page === 'statistics' && !affectsStatisticsScores(event)) return;
    if (route.page === 'search' || route.page === 'show' || route.page === 'library' || route.page === 'statistics') queueRefresh();
  }, options);
  function usesOverview() {
    return route.page === 'home' || route.page === 'library' || route.page === 'ratings' ||
      route.page === 'watchlist' || route.page === 'cast' || route.page === 'statistics';
  }
  function onCacheChange() {
    if (!screen || content.inert || !(usesOverview() || ['search','lists','show','season'].includes(route.page))) return;
    // During first sign-in hundreds of individual metadata commits may arrive
    // while one Library read is still running. Finish that read before the next.
    cacheChanged = true;
    if (cacheTimer !== undefined || refreshingCache) return;
    const active = screen;
    cacheTimer = win.setTimeout(() => {
      cacheTimer = undefined;
      refreshingCache = active;
      cacheChanged = false;
      void run(async () => {
        try {
          await active.refresh();
          if (screen === active) updateTitle();
        } finally {
          if (refreshingCache === active) {
            refreshingCache = undefined;
            if (cacheChanged) onCacheChange();
          }
        }
      });
    }, 250);
  }
  service.store.addEventListener('cachechange', onCacheChange, options);
  service.store.addEventListener('tmdbmetadata', onCacheChange, options);
  service.store.addEventListener('tmdbbrowse', event => {
    if (route.page === 'statistics') return;
    const detailOnly = (event as CustomEvent<{detailOnly?:boolean}>).detail?.detailOnly;
    if (!detailOnly || ['show','season','search','cast'].includes(route.page)) onCacheChange();
  }, options);
  cacheUpdates?.addEventListener('cachechange', onCacheChange, options);
  win.addEventListener('online', queueRefresh, options);
  win.addEventListener('offline', queueRefresh, options);
  win.addEventListener('focus', () => { if (scheduleMidnight()) queueRefresh(); }, options);
  doc.addEventListener('visibilitychange', () => {
    if (doc.visibilityState === 'visible') {
      if (cloud && !content.inert) void run(checkAccount);
      queueRefresh(); scheduleMidnight();
    }
  }, options);
  scheduleMidnight();
  role();
  return { ready: cloud && accountId === undefined ? run(checkAccount) : open(route), go, watch, dispose() {
    closed = true; mountId++; appearance.close(); listener.abort(); win.clearTimeout(refreshTimer); win.clearTimeout(midnightTimer);
    notices.dispose(); disposeQuestion?.(); disposeScreen(); visitHistory.dispose(); watch.clear(); root.replaceChildren();
  } };
}
