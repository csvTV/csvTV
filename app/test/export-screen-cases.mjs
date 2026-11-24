import { connectFixtureProviders } from './provider-fixture-cases.mjs';
import { mountExportScreen } from '../dist/export-screen.js';
import { openDeviceStore } from '../dist/storage.js';
import { TmdbClient } from '../dist/tmdb-client.js';
import { TmdbService } from '../dist/tmdb-service.js';

const title = 'Tide <b>Station</b>';
const watched = { show_id: 17, show: title, season: 1, episode: 3, episode_id: 1713, title: 'Foghorn', times_watched: 2 };
const privateValue = 'fictional-export-secret';
const prompt = 'The attached file is my complete TV watch record. Each row is one season of a show, or, with no season given, a show I have not started: how many episodes I watched, how many times I completed it, my rating of the show out of 10, and any lists it is on. Shows on the list "Watchlist" are ones I already plan to watch. Recommend ten shows I have not watched and that are not on my Watchlist. For each, give one sentence on why it fits what I rate highly or rewatch.';
const names = 'watched.csv,ratings.csv,lists.csv,shows.csv';
function check(condition, message) { if (!condition) throw Error(message); }
function gate() {
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  return { wait, release };
}
async function until(predicate, message) {
  const deadline = performance.now() + 5000;
  while (!predicate()) {
    if (performance.now() > deadline) throw Error(message);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function fixture(width, exercise) {
  const name = 'export-screen-' + crypto.randomUUID();
  const store = await openDeviceStore({ name });
  const service = new TmdbService(store, new TmdbClient({ fetch() { throw Error('Unexpected network request'); } }),
    { now: Date.now, online: () => false, visible: () => true });
  const frame = document.createElement('iframe');
  frame.width = String(width); frame.height = '720';
  const loaded = new Promise(resolve => frame.addEventListener('load', resolve, { once: true }));
  frame.src = '/screen-fixture';
  document.body.append(frame);
  let screen;
  try {
    const before = await connectFixtureProviders(store,name,[{setting:'tmdb_key',value:privateValue}]);
    await store.commit(before.revision, { put: { watched: [watched], lists: [{ show_id: 23, show: 'Night Shuttle', list: 'Watchlist' }],
      shows: [{ show_id: 17, show: title, year: 2017, imdb_id: 'tt0000017' }], ratings: [{ show_id: 17, show: title, rating: 8.5 }] } });
    await loaded;
    const win = frame.contentWindow, doc = frame.contentDocument;
    const root = doc.querySelector('#app');
    const checked = [], shares = [], copied = [], revoked = [];
    const platform = {
      canShare: () => true, share: () => Promise.resolve(), copy: () => Promise.resolve(),
    };
    Object.defineProperties(win.navigator, {
      canShare: { configurable: true, value(payload) { checked.push(payload); return platform.canShare(payload); } },
      share: { configurable: true, value(payload) { shares.push(payload); return platform.share(payload); } },
      clipboard: { configurable: true, value: { writeText(value) { copied.push(value); return platform.copy(value); } } },
    });
    const revoke = win.URL.revokeObjectURL.bind(win.URL);
    win.URL.revokeObjectURL = url => { revoked.push(url); revoke(url); };
    screen = mountExportScreen(root, { service });
    await screen.ready;
    const q = selector => root.querySelector(selector);
    const links = () => [...root.querySelectorAll('a[download][href]')];
    const choose = value => q('input[value="' + value + '"]').click();
    await exercise({ screen, store, doc, win, root, q, links, choose, platform, checked, shares, copied, revoked });
  } finally {
    screen?.dispose(); frame.remove(); service.close(); store.close();
    await new Promise((resolve, reject) => {
      const drop = indexedDB.deleteDatabase(name);
      drop.onsuccess = resolve; drop.onerror = () => reject(drop.error);
    });
  }
}

export async function exportScreenCases(run) {
  await run('Summary choices lead directly to the file actions and retain row count, completion warning and copyable prompt at phone width', () =>
    fixture(320, async ({ doc, q, links, checked, copied, win, platform }) => {
      const file = checked.at(-1).files[0];
      check(q('input[value=summary]').checked && checked.at(-1).files.length === 1 && file.name === 'summary.csv', 'Wrong initial selection');
      const bytes = await file.text();
      check(bytes.includes(title) && !q('[data-preview]') && q('fieldset + .export-actions') &&
        q('[data-row-count]').textContent.includes('2 rows') && q('.export-omission').textContent.includes('1 show'),
        'The file actions, exported rows or completion warning are missing');
      check(links().length === 1 && links()[0].download === file.name && await (await fetch(links()[0].href)).text() === bytes,
        'Download did not use the prepared summary');
      check(q('blockquote').textContent === prompt, 'Prompt differs from the prescribed text');
      q('[data-copy]').click();
      await until(() => q('[data-export-status]').textContent === 'Prompt copied.', 'Copy action did not complete');
      check(copied[0] === prompt, 'Clipboard received a shortened or altered prompt');
      platform.copy = () => Promise.reject(new Error('clipboard blocked'));
      q('[data-copy]').click();
      await until(() => win.getSelection().toString() === prompt, 'Clipboard refusal did not offer manual copying');
      check(doc.documentElement.scrollWidth <= 320, 'Export overflowed a 320px viewport');
    }));

  await run('A single tap shares the exact four previously checked files and leaves each download independently readable', () =>
    fixture(1080, async ({ q, links, choose, checked, shares, platform }) => {
      choose('record');
      check(q('[data-share]').disabled && !links().length && q('.export-prompt').hidden && q('fieldset + .export-actions'),
        'Old summary actions stayed available during preparation');
      await until(() => links().length === 4, 'Missing four-file downloads');
      const data = checked.at(-1);
      check(data.files.map(file => file.name).join() === names && links().map(link => link.download).join() === names,
        'A selected or individually downloadable file was missing');
      for (const [i, link] of links().entries()) {
        const received = new Uint8Array(await (await fetch(link.href)).arrayBuffer());
        const fileBytes = new Uint8Array(await data.files[i].arrayBuffer());
        check(received.length === fileBytes.length && received.every((b, j) => b === fileBytes[j]), 'Different download bytes for ' + link.download);
        check(!(new TextDecoder().decode(received)).includes(privateValue), 'A credential entered the download');
      }
      const reply = gate();
      platform.share = () => reply.wait;
      q('[data-share]').click();
      check(shares.length === 1 && shares[0].files === data.files && Object.keys(shares[0]).join() === 'files',
        'Share waited beyond the click turn or replaced the validated file array');
      q('[data-share]').click();
      check(shares.length === 1, 'A second tap opened two sheets');
      reply.release();
      await until(() => !q('[data-share]').disabled, 'Share did not finish');
      check(links().length === 4 && !q('[data-export-status]').textContent, 'Share reported delivery or removed downloads');
    }));

  await run('Canceled, refused and unsupported file shares preserve four separate downloads and the current selection', () =>
    fixture(320, async ({ q, screen, links, choose, checked, shares, platform, win }) => {
      choose('record');
      await until(() => links().length === 4, 'Four files did not prepare');
      const currentUrls = links().map(link => link.href).join();
      platform.share = () => Promise.reject(new win.DOMException('Canceled by user', 'AbortError'));
      q('[data-share]').click();
      await until(() => q('[data-export-status]').textContent === 'Share canceled.', 'Cancellation lost its state');
      check(!q('[data-share]').disabled && links().map(link => link.href).join() === currentUrls && q('input[value=record]').checked,
        'Cancel destroyed the prepared selection');
      platform.share = () => { throw new win.DOMException('Target unavailable', 'NotAllowedError'); };
      q('[data-share]').click();
      await until(() => q('[data-export-status]').textContent.includes('Sharing was unavailable'), 'Refusal did not offer downloading');
      check(links().map(link => link.href).join() === currentUrls, 'Refusal retired the download files');
      platform.canShare = payload => payload.files.length === 1;
      await screen.refresh();
      check(checked.at(-1).files.length === 4 && q('[data-share]').disabled && links().length === 4, 'Whole-set capability was bypassed');
      q('[data-share]').click();
      check(shares.length === 2, 'An unsupported set was sent anyway');
      platform.canShare = () => { throw Error('Unavailable capability'); };
      await screen.refresh();
      check(links().length === 4 && q('[data-share]').disabled, 'Capability exception removed file downloads');
    }));

  await run('Stale snapshots, a preparation error and a late share outcome cannot replace the latest export', () =>
    fixture(390, async ({ screen, store, q, links, choose, revoked, checked, platform, win }) => {
      const firstUrl = links()[0].href;
      const snapshot = store.exportSnapshot.bind(store);
      const delay = gate(), started = gate();
      const before = checked.length;
      let reads = 0, firstSignal;
      store.exportSnapshot = async (...args) => {
        reads++;
        if (reads === 1) firstSignal = args[3];
        const value = await snapshot(...args);
        if (reads === 1) { started.release(); await delay.wait; }
        return value;
      };
      const ready = screen.refresh();
      await started.wait;
      choose('record');
      check(firstSignal?.aborted,'Changing file selection left the obsolete summary read active');
      await store.commit((await store.snapshot()).revision, { put: { watched: [{ ...watched, times_watched: 5 }] } });
      const waiting = screen.refresh();
      check(!links().length && q('[data-share]').disabled && revoked.includes(firstUrl), 'Stale files remained actionable');
      delay.release();
      await Promise.all([ready, waiting]);
      check(reads === 2 && checked.length === before + 1 && checked.at(-1).files.length === 4,
        'An obsolete result was exposed or a burst of invalidations started duplicate reads');
      const contents = await (await fetch(links()[0].href)).text();
      check(contents.includes('Foghorn,5,1713'), 'Four-file selection lost the intervening watch change');
      const allocate = win.URL.createObjectURL.bind(win.URL);
      let allocations = 0, allocatedUrl;
      win.URL.createObjectURL = file => {
        if (++allocations === 2) throw new win.DOMException('Fictional allocation failure', 'QuotaExceededError');
        return allocatedUrl = allocate(file);
      };
      await screen.refresh();
      check(!q('.export-downloads a[download]') && !q('.export-downloads a[tabindex="0"]') && revoked.includes(allocatedUrl)
        && !q('[data-retry-export]').hidden, 'A partial set left a broken download in the tab order or leaked its URL');
      win.URL.createObjectURL = allocate;
      await screen.refresh();
      check(links().length === 4 && links().every(link => link.tabIndex === 0), 'Retry did not restore four keyboard downloads');
      const shareReply = gate();
      platform.share = () => shareReply.wait.then(() => { throw new win.DOMException('Canceled', 'AbortError'); });
      q('[data-share]').click();
      choose('summary');
      await until(() => links().length === 1, 'Selection change did not replace files');
      shareReply.release();
      await until(() => !q('[data-share]').disabled, 'Share did not finish');
      check(!q('[data-export-status]').textContent, 'A reply from the prior selection changed the new screen');
      store.exportSnapshot = () => Promise.reject(Error('Fictional interrupted snapshot'));
      await screen.refresh();
      check(!links().length && q('[data-share]').disabled && !q('[data-retry-export]').hidden, 'Failed preparation exposed stale bytes');
      store.exportSnapshot = snapshot;
      q('[data-retry-export]').click();
      await until(() => links().length === 1, 'Retry did not prepare a new file');
      const finalUrl = links()[0].href;
      let finished;
      store.exportSnapshot = (...args) => {
        const open = IDBDatabase.prototype.transaction;
        IDBDatabase.prototype.transaction = function(...options) {
          const tx = open.apply(this,options);
          finished = new Promise(resolve=>{
            for (const event of ['abort','complete']) tx.addEventListener(event,()=>resolve(event),{once:true});
          });
          return tx;
        };
        try { return snapshot(...args); }
        finally { IDBDatabase.prototype.transaction = open; }
      };
      const retiring = screen.refresh();
      const separate = snapshot(false,Date.now());
      screen.dispose();
      await retiring;
      check(await finished==='abort' && (await separate).tables.watched.length===1,
        'Leaving Export must cancel its transaction and let an independent backup read complete');
      check(revoked.includes(finalUrl) && !links().length && q('[data-share]').disabled, 'A disposed screen published or retained file URLs');
    }));
}
