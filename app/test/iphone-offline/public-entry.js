import { prepareSample, sample } from './sample-record.js';

const guide = document.querySelector('#sample-guide');
const status = document.querySelector('#sample-status');
const steps = document.querySelector('#sample-steps');

function followLibrary() {
  const expectedBuild = document.querySelector('meta[name="csvtv-build"]').content;
  let workers;
  try { workers = navigator.serviceWorker; } catch { /* The saved Library can still open. */ }
  let verifiedWorker;
  let incompleteWorker;
  let check = 0;
  let onLibrary = false;
  function render() {
    guide.hidden = location.hash !== '#/library';
    if (guide.hidden) return;
    const unlinked = document.querySelector('#app')?.dataset.page === 'dropbox-setup';
    const action = guide.querySelector('a');
    action.href = unlinked ? './' : '#/settings';
    action.textContent = unlinked ? 'Open sample setup' : 'Offline settings';
    if (unlinked) {
      status.textContent = 'This browser has not prepared the sample.';
      steps.textContent = 'Open sample setup to link the fictional record and add Signal Garden.';
      return;
    }
    if (!workers) {
      status.textContent = 'Offline access is unavailable in this browser.';
      steps.textContent = 'You can still check the saved Library here.';
      return;
    }
    const card = document.querySelector('.library-grid a[data-show-id="' + sample.show_id + '"]');
    const ready = verifiedWorker && verifiedWorker === workers.controller && card?.title === sample.show;
    const empty = document.querySelector('.library-screen [data-group="all"] span')?.textContent === (0).toLocaleString();
    status.textContent = empty ? 'This Library contains no watched shows.'
      : ready ? 'Ready to go offline.' : 'Preparing offline access…';
    if (empty) {
      steps.textContent = 'If you already prepared Signal Garden, record this result before making changes.';
      return;
    }
    if (document.querySelector('.library-screen .tv-empty')?.textContent === 'No matching shows.') {
      status.textContent = 'The current filters hide all shows.';
      steps.textContent = 'Clear the Library search and filters to check for Signal Garden.';
      return;
    }
    if (incompleteWorker && incompleteWorker === workers.controller) {
      status.textContent = 'Some offline files are missing.';
      steps.textContent = 'Open Offline settings while online to repair this copy before testing.';
      return;
    }
    steps.textContent = ready
      ? 'No account needed. Bookmark this Library. Turn on Airplane Mode, turn Wi-Fi off, then close the tab and reopen the bookmark.'
      : 'No account needed. Wait for Signal Garden and the ready message before disconnecting.';
  }
  function verifyController() {
    const current = ++check;
    verifiedWorker = undefined;
    incompleteWorker = undefined;
    render();
    const worker = workers?.controller;
    if (worker?.scriptURL !== new URL('./service-worker.js', location.href).href) return;
    const channel = new MessageChannel();
    const timeout = setTimeout(() => channel.port1.close(), 6000);
    channel.port1.onmessage = ({ data }) => {
      clearTimeout(timeout);
      channel.port1.close();
      if (current === check && workers.controller === worker &&
          data?.type === 'csvtv:version' && data.build === expectedBuild) {
        if (data.complete === true) verifiedWorker = worker;
        if (data.complete === false) incompleteWorker = worker;
        render();
      }
    };
    worker.postMessage({ type: 'csvtv:version' }, [channel.port2]);
  }
  function routeChanged() {
    const library = location.hash === '#/library';
    const entered = library && !onLibrary;
    onLibrary = library;
    if (entered) verifyController();
    else render();
  }
  new MutationObserver(routeChanged).observe(document.querySelector('#app'), { childList: true, subtree: true });
  workers?.addEventListener('controllerchange', verifyController);
  window.addEventListener('pageshow', verifyController);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) verifyController(); });
  window.addEventListener('hashchange', routeChanged);
  routeChanged();
}

async function offerSetup() {
  const start = document.createElement('button');
  start.type = 'button';
  start.textContent = 'Prepare Signal Garden and open Library';
  status.textContent = 'Set up the offline test';
  steps.replaceChildren(start);
  const settings = guide.querySelector('a');
  settings.hidden = true;
  document.querySelector('#app').replaceChildren();
  const setup = new AbortController();
  const leave = () => setup.abort();
  window.addEventListener('hashchange', leave);
  window.addEventListener('pagehide', leave);
  try {
    await new Promise(resolve => {
      start.addEventListener('click', resolve, {once:true, signal:setup.signal});
      setup.signal.addEventListener('abort', resolve, {once:true});
    });
    if (setup.signal.aborted || location.hash) return;
    start.disabled = true;
    status.textContent = 'Preparing Signal Garden…';
    const { openDeviceStore } = await import('./storage.js');
    await prepareSample(openDeviceStore, message => { status.textContent = message; }, setup.signal);
    if (!setup.signal.aborted && !location.hash) history.replaceState(history.state, '', '#/library');
  } catch (error) {
    if (!setup.signal.aborted) throw error;
  } finally {
    window.removeEventListener('hashchange', leave);
    window.removeEventListener('pagehide', leave);
    settings.hidden = false;
  }
}

async function open() {
  // Preserve the production app's handling of callback URLs.
  if (location.search) {
    guide.hidden = true;
  } else {
    if (!location.hash) await offerSetup();
    followLibrary();
  }
  await import('./main.js');
}

open().catch(error => {
  guide.hidden = false;
  status.textContent = error.message || 'The sample could not be opened.';
  steps.textContent = '';
  document.querySelector('#app').replaceChildren();
});
