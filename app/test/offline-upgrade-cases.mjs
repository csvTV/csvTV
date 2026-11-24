import { deviceMigrations } from '../dist/storage.js';
const scope = '/upgrade-app/';
const storeName = 'csvtv-waiting-worker-test';
const status = win => win.document.querySelector('[data-offline-status]')?.textContent ?? '';
const check = (yes, message) => { if (!yes) throw Error(message); };
async function command(mode) {
  // This loopback fixture sets an absolute mode. Reapplying it is safe if its reply was lost.
  const setMode = () => fetch('/upgrade-test-control', { method:'POST', headers:{'x-mode':mode} });
  let reply;
  try { reply = await setMode(); }
  catch (error) {
    if (!(error instanceof TypeError)) throw error;
    reply = await setMode();
  }
  if (!reply.ok) throw Error('Upgrade fixture could not enter ' + mode + ' (HTTP ' + reply.status + ').');
}
function value(request) { return new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
}); }
async function until(test, message) {
  const end = performance.now() + 12_000;
  while (performance.now() < end) {
    const result = await test();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw Error(typeof message === 'function' ? await message() : message);
}
async function rejected(action, message) {
  try { await action(); } catch (error) {
    check(error.name === 'InvalidStateError', message + ' (' + error.name + ')'); return;
  }
  throw Error(message);
}
function button(win, label) {
  return [...win.document.querySelectorAll('button')].find(item => item.textContent === label && !item.hidden);
}

export async function offlineUpgradeCases(run) {
  let first, second, legacy, blocker;
  const fakeSession = { accountId:'fictional-owner', instanceId:'fixture-sign-in', accessToken:'fiction-only', refreshToken:'fiction-only',
    accessExpiresAt: Date.now()+3_600_000, signInDeadline: Date.now()+4_000_000, providerExpiresAt: Date.now()+4_000_000 };
  const base = { revision:'r17', content:'fictional previously uploaded bytes' };
  const pending = { content:'fictional bytes waiting for an upload reply', targetRevision:base.revision, targetContent:base.content,
    preparedAt:17, targetModified:'2026-11-01T00:00:00Z', clientModified:'2026-11-01T00:01:00Z' };
  const rating = {show_id:17, show:'Amber Bay', rating:9};
  try {
    await run('A failed first installation keeps Settings and local edits usable; retry installs the full shell without reloading', async () => {
      first = window.open(scope + '#/settings', 'csvtv-upgrade-first');
      await until(() => first.fixture?.store && status(first).includes('could not be installed'), 'No actionable first-install failure: ' + status(first));
      const initial = first.fixture;
      await initial.store.whenWriter();
      await initial.store.commit((await initial.store.snapshot()).revision, {put:{ratings:[rating]}, local:{syncAccountId:fakeSession.accountId},
        sync:{ratings:{base, pending, lastClientModified:pending.clientModified}}});
      await command('online');
      const retry = await until(() => status(first).includes('could not be installed') && button(first,'Try again'),
        'The remounted Settings screen lost the first-install failure or its retry button');
      retry.focus(); retry.click();
      await until(() => status(first) === 'Ready to open offline.', 'Retry did not finish installation');
      check(first.fixture.id === initial.id && first.navigator.serviceWorker.controller, 'First installation unexpectedly reloaded the page');
      const snap = await first.fixture.store.snapshot();
      check(snap.tables.ratings[0].rating === 9 && snap.sync.ratings.pending.content === pending.content, 'Installation affected saved rows');
      await initial.cloud.reload();
      check(first.fixture.id === initial.id && initial.cloud.notices.some(text=>text.includes('still cannot read')),
        'An unchanged installed reader reloaded again or failed to explain the incompatible format');
    });

    await run('A waiting update blocked by an unresponsive tab reopens the signed-in writer and preserves its exact pending operation', async () => {
      second = window.open(scope + 'index.html#/settings','csvtv-upgrade-second');
      legacy = window.open(scope + '#legacy','csvtv-upgrade-legacy');
      await until(() => second.fixture?.cloud && legacy.fixture, 'Other tabs did not load');
      const old = first.fixture.store;
      await command('publish');
      const registration = await first.navigator.serviceWorker.getRegistration();
      await registration.update();
      await until(() => registration.waiting && status(first) === 'Update available.', 'The second complete build did not wait');
      await command('offline');
      localStorage.setItem('upgrade-offline','1');
      for (const win of [first,second]) Object.defineProperty(win.navigator,'onLine',{value:false, configurable:true});
      second.sessionStorage.setItem('drop-resume','1');
      await old.storeExchangedSession(fakeSession);
      await until(() => first.fixture.cloud.signedIn, 'Fictional offline sign-in was not recognized');
      await first.fixture.cloud.reload();
      await until(() => first.fixture.store !== old && status(first).includes('Close other csvTV tabs'), 'An unresponsive tab did not block the upgrade');
      await until(() => [first,second].every(win => win.fixture.cloud.store === win.fixture.store && win.fixture.cloud.signedIn &&
        !['obsolete','closed'].includes(win.fixture.store.role)), 'Blocked activation did not resume both existing signed-in sessions');
      check(second.fixture.dropped, 'The regression did not drop the second tab\'s resume message');
      check(registration.waiting && first.fixture.stage === 1 && second.fixture.stage === 1, 'The worker activated over an unresponsive tab');
      await rejected(() => old.storeExchangedSession(fakeSession), 'Closed tab could still store a sign-in');
      await rejected(() => old.commit(0n, { replace: { ratings: [] } }), 'Closed tab could still commit a row');
      const resumed = await first.fixture.store.snapshot();
      check(resumed.local.syncAccountId === fakeSession.accountId && resumed.sync.ratings.pending.content === pending.content &&
        resumed.sync.ratings.base.revision === base.revision, 'The original account or pending operation changed during recovery');
    });

    await run('A worker superseded during preparation releases both tabs and its replacement can still activate', async () => {
      const registration = await first.navigator.serviceWorker.getRegistration();
      const previous = registration.waiting;
      const held = [first,second].map(win => win.fixture.store);
      void first.fixture.cloud.reload();
      await until(() => held.every(store => store.role === 'obsolete'), 'The waiting worker did not prepare the two open tabs');
      await command('replace');
      await registration.update();
      await until(() => registration.waiting && registration.waiting !== previous && previous.state === 'redundant',
        'Publishing a newer build did not supersede the waiting worker');
      await until(() => [first,second].every((win,i) => win.fixture.store !== held[i] && win.fixture.cloud.store === win.fixture.store),
        'An obsolete waiting worker left a tab suspended');
      check([first,second].every(win => win.fixture.stage === 1 && win.fixture.visits === 1), 'Replacing a waiting worker reloaded an active tab');
      await command('offline');
    });

    await run('Offline compatibility Reload upgrades both tabs once, blocks an open database, rolls back an interrupted migration and resumes the pending record', async () => {
      legacy.close();
      await until(() => legacy.closed, 'Legacy tab did not close');
      const obsolete = [first.fixture.store, second.fixture.store];
      const before = [first.fixture.id, second.fixture.id];
      const count = [first,second].map(win => win.fixture.visits);
      blocker = await value(indexedDB.open(storeName, deviceMigrations.length));
      let askedToClose = false;
      blocker.onversionchange = () => { askedToClose = true; };
      localStorage.setItem('interrupt-upgrade','1');
      void first.fixture.cloud.reload(); // Successful activation unloads the caller's JavaScript context.
      await until(() => askedToClose && [first,second].some(win => win.document.body.textContent.includes('Close other csvTV tabs to finish updating local storage.')),
        async () => 'The blocked upgrade gave no close-tabs instruction. DB versionchange: ' + askedToClose + '. Network misses: ' +
          await (await fetch('/upgrade-test-diagnostics')).text() + '. ' + [first,second].map(win => {
            try { return 'Stage ' + win.fixture?.stage + ' / ' + (status(win) || win.document.body.textContent.trim().slice(0,180)); }
            catch { return 'Browser error page'; }
          }).join(' | '));
      blocker.close(); blocker = undefined;
      await until(() => [first,second].every(win => win.fixture?.stage === 3 && win.document.body.textContent.includes('Local storage could not be opened.')),
        'Interrupted migrations did not leave the new shell recoverable');
      const prior = await value(indexedDB.open(storeName, deviceMigrations.length));
      check(!prior.objectStoreNames.contains('future-data'), 'Interrupted transaction left part of the new schema');
      const sync = await value(prior.transaction('sync').objectStore('sync').get('ratings'));
      prior.close(); check(sync.pending.content === pending.content && sync.base.revision === base.revision, 'The interrupted migration changed pending/base');
      check(obsolete.every(store => store.role === 'obsolete'), 'A stale page retained its writer role');
      localStorage.removeItem('interrupt-upgrade');
      for (const win of [first,second]) button(win,'Try again').click();
      await until(() => [first,second].every(win => status(win) === 'Ready to open offline.' && win.fixture?.cloud), 'Compatible offline app failed to reopen');
      const writer = await until(() => [first,second].find(win=>win.fixture.store.role === 'writer'), 'No compatible writer resumed');
      const current = await writer.fixture.store.snapshot();
      try { (await value(indexedDB.open(storeName, deviceMigrations.length))).close(); throw Error('An old schema reopened after migration'); }
      catch (error) { check(error.name === 'VersionError', error.message); }
      check(current.tables.ratings[0].rating === 9 && current.sync.ratings.pending.content === pending.content &&
        current.sync.ratings.base.content === base.content && current.local.syncAccountId === fakeSession.accountId &&
        current.local.dropboxSession.instanceId === fakeSession.instanceId, 'Migration changed the committed record, credentials, or pending account operation');
      check([first,second].every((win,i)=>win.fixture.id !== before[i] && win.fixture.visits === count[i]+1), 'Unexpected navigation');
      const stable = writer.fixture.id;
      await writer.fixture.cloud.reload();
      check(writer.fixture.id === stable && writer.fixture.cloud.notices.some(text=>text.includes('No installed update is waiting')),
        'A repeated offline Reload restarted the already installed build');
    });

    await run('Online compatibility Reload installs a published shell, waits for both controllers and keeps the original pending bytes', async () => {
      const visits = [first,second].map(win => win.fixture.visits);
      await command('final');
      localStorage.removeItem('upgrade-offline');
      for (const win of [first,second]) delete win.navigator.onLine;
      void first.fixture.cloud.reload();
      await until(() => [first,second].every(win => win.fixture?.stage === 4 && status(win) === 'Ready to open offline.' && win.fixture.cloud),
        'Online Reload failed to obtain the newly published build in both tabs');
      check([first,second].every((win,i) => win.fixture.visits === visits[i] + 1), 'An online update navigated a tab more than once');
      const snapshot = await first.fixture.store.snapshot();
      check(snapshot.sync.ratings.pending.content === pending.content && snapshot.sync.ratings.base.revision === base.revision &&
        snapshot.local.syncAccountId === fakeSession.accountId, 'Online Reload changed the pending version or account');
    });
  } finally {
    blocker?.close(); first?.close(); second?.close(); legacy?.close();
    localStorage.removeItem('upgrade-offline'); localStorage.removeItem('interrupt-upgrade');
    await command('online');
  }
}
