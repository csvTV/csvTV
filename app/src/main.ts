import { openDeviceStore, type DeviceStore } from './storage.ts';
import { TmdbLibrary } from './tmdb-library.ts';
import { TmdbService } from './tmdb-service.ts';
import { MdbListService } from './mdblist-service.ts';
import { ImdbService } from './imdb-service.ts';
import { MalService } from './mal-service.ts';
import { mountApplication } from './application.ts';
import { DropboxAuth } from './dropbox-auth.ts';
import { openingDropboxReturn } from './dropbox-return.ts';
import { DropboxController } from './dropbox-controller.ts';
import { DropboxDialogs } from './dropbox-dialogs.ts';
import { OfflineShell, reloadOnlineBuild } from './offline.ts';

const root = document.querySelector<HTMLElement>('#app')!;
let callback:ReturnType<typeof openingDropboxReturn>;
let exchanging: {done: Promise<boolean>; cancel: () => void} | undefined;
let session = 0;
let opening: Promise<DeviceStore> | undefined;
let connected: DeviceStore | undefined;
let closeServices: ((finishSubmittedCallback: boolean) => void) | undefined;
function message(text: string, label: string, action: () => void) {
  const info = document.createElement('p');
  info.setAttribute('role', 'status');
  info.textContent = text;
  const button = document.createElement('button');
  button.textContent = label;
  button.onclick = action;
  root.replaceChildren(info, button);
}
async function stop(finishSubmittedCallback = false) {
  ++session;
  const exchange = exchanging;
  // A page can be closed while an update is already waiting for a submitted
  // code. Its cancellation still reaches the same authorization instance.
  if (!finishSubmittedCallback) exchange?.cancel();
  closeServices?.(finishSubmittedCallback);
  closeServices = undefined;
  const previous = opening;
  opening = undefined;
  const device = connected;
  connected = undefined;
  // A submitted one-use code cannot be replayed by the next build. Let this
  // compatible connection commit the response before acknowledging the update.
  if (finishSubmittedCallback && exchange) await exchange.done.catch(() => {});
  if (device) await device.closeForUpdate();
  else await previous?.then(store => store.closeForUpdate(), () => {});
}
const offline = new OfflineShell(window, reason => {
  const stopped = stop(!reason);
  message(reason ?? 'Waiting for other csvTV tabs to finish updating. If this takes a while, close other tabs and reopen csvTV.',
    'Reopen csvTV', () => void stopped.then(() => window.location.reload()));
  return stopped;
}, reason => {
  const stopped = stop(true);
  const current = session;
  void stopped.then(() => { if (session === current) void open(reason); });
});

async function open(notice?: string) {
  const current = ++session;
  let verified = false;
  try {
    root.textContent = 'Opening csvTV…';
    if (!await offline.canOpen() || current !== session) return;
    verified = true;
    opening = openDeviceStore({ beforeReload: () => current === session ? exchanging?.done : undefined, onBlocked: () => {
      if (current === session) root.textContent = 'Close other csvTV tabs to finish updating local storage.';
    } });
    const device = await opening;
    if (current !== session) { await device.closeForUpdate(); return; }
    connected = device;
    const binding = await device.dropboxState('registration');
    if (current !== session) return;
    const configured = document.querySelector<HTMLMetaElement>('meta[name="dropbox-app-key"]')?.content.trim();
    let appKey = '';
    const auth = new DropboxAuth(device, linked => {
      try { appKey = localStorage.getItem('csvTV-public-dropbox-app-key') || ''; }
      catch { /* Keep the last readable registration when optional Web Storage is blocked. */ }
      return (linked && appKey) || configured || appKey;
    });
    auth.showRegistration(binding);
    const cloud = new DropboxController(auth,window,new DropboxDialogs(document));
    const service = new TmdbService(device);
    const critics = new MdbListService(device);
    const imdb = new ImdbService(service);
    const mal = new MalService(service);
    const library = new TmdbLibrary(service, critics, imdb, mal);
    if (offline.supported) cloud.reloadInstalledShell = async () => {
      const reason = await offline.update(true);
      return offline.installedCopy ? reason : undefined;
    };
    // The production detail job publishes its committed changes through the store.
    const app = mountApplication(root, service, undefined, cloud, offline, critics, imdb, mal, {accountId:binding.accountId});
    closeServices = finishSubmittedCallback => {
      cloud.close({finishSubmittedCallback});
      app.dispose(); library.close(); mal.close(); imdb.close(); critics.close(); service.close();
    };
    // The compatible database is ready. A slow screen must not consume the
    // remaining lifetime of a one-use sign-in code.
    const authorization = callback.take();
    const exchange = authorization && auth.finishCallback(window,authorization);
    if (exchange) exchanging = {done:exchange,cancel:() => auth.close()};
    const reported = exchange && exchange.catch(error => {
      if (current === session) cloud.report(cloud.failure(error));
    }).finally(() => { if (exchanging?.done === exchange) exchanging = undefined; });
    await Promise.all([app.ready,reported]);
    if (current !== session) return;
    if (notice) cloud.report(notice);
    await cloud.refresh(true);
  } catch (error) {
    if (current !== session) return;
    await stop();
    if (current + 1 !== session) return;
    if (!verified) {
      message('Could not verify the installed app. Reopen csvTV to try again.', 'Reopen csvTV', () => window.location.reload());
    } else if (error instanceof DOMException && error.name === 'VersionError') {
      const unchanged = 'This version of csvTV still cannot open this device’s record. Check again after a newer version is available.';
      let checking = false;
      const reload = async () => {
        if (checking) return;
        checking = true;
        try {
          let reason = offline.supported ? await offline.update(true, unchanged) : undefined;
          if (!offline.installedCopy && current + 1 === session) {
            reason = await reloadOnlineBuild(window, () => current + 1 === session, {unchanged});
          }
          if (reason && !offline.paused && current + 1 === session) message(reason, 'Reload', () => void reload());
        } finally { checking = false; }
      };
      message('A newer version of csvTV is needed to open this record.', 'Reload', () => void reload());
    } else message('Local storage could not be opened.', 'Try again', () => void open());
  }
}
async function start() {
  const boot = window as Window & {csvTVReturnReady?:Promise<void>};
  if (boot.csvTVReturnReady) {
    await boot.csvTVReturnReady;
    delete boot.csvTVReturnReady;
  }
  callback = openingDropboxReturn(window);
  const startup = (window as Window & {csvTVStartup?: {changed:boolean; refresh(manual?:boolean):Promise<boolean>}}).csvTVStartup;
  const incompatible = typeof DropboxAuth.prototype.showRegistration !== 'function';
  if (incompatible || (startup?.changed && !callback.pending)) {
    // No writer, sync operations or editable screen have started in this document.
    root.textContent = 'Updating csvTV’s app files…';
    if (!callback.pending && startup && await startup.refresh().catch(() => false)) return;
    const status = document.createElement('p');
    status.setAttribute('role','status');
    const returning = callback.pending, resumable = returning && callback.canResumeAfterReload;
    if (returning) status.textContent = resumable ? 'Retry in this tab to finish signing in to Dropbox.'
      : 'Open csvTV in a new tab and sign in to Dropbox again.';
    else status.textContent = incompatible
      ? 'This tab loaded files from different versions of csvTV. If the new tab shows this message, close your csvTV tabs and reopen your bookmark.'
      : 'This tab could not finish loading the update. Reconnect and try again.';
    const link = document.createElement('a');
    link.href = location.origin + location.pathname;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.className = 'button';
    link.textContent = returning ? 'Open csvTV to sign in again' : 'Open csvTV in a new tab';
    const actions = document.createElement('div');
    actions.className = 'startup-actions';
    actions.append(link);
    root.replaceChildren(status,actions);
    if (resumable || (startup && !returning)) {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.textContent = 'Try again';
      retry.onclick = async () => {
        if (retry.disabled) return;
        if (returning && !callback.canResumeAfterReload) {
          status.textContent = 'Open csvTV in a new tab and sign in to Dropbox again.';
          retry.remove(); link.focus(); return;
        }
        const focused = document.activeElement === retry;
        retry.disabled = true;
        if (!startup) { window.location.reload(); return; }
        status.textContent = 'Checking app files…';
        if (await startup.refresh(true).catch(() => false)) return;
        status.textContent = 'Could not verify the update. Reconnect and try again.';
        retry.disabled = false;
        if (focused && document.activeElement === document.body) retry.focus({preventScroll:true});
      };
      // Keep the same bookmark on a retry. The separate fresh-tab link omits return parameters.
      actions.prepend(retry);
    }
    return;
  }
  window.addEventListener('pagehide', () => { void stop(); });
  window.addEventListener('pageshow', event => { if (event.persisted) void open(); });
  offline.start(!callback.pending);
  await open();
}
void start();
