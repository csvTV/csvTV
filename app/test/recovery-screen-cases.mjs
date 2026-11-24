import { openDeviceStore } from '../dist/storage.js';
import { applyLocalRecord, previewLocalRecord, readLocalRecord } from '../dist/local-restore.js';
import { TmdbService } from '../dist/tmdb-service.js';
import { prepareExport } from '../dist/export-data.js';
import { mountClearDevice } from '../dist/clear-device.js';
import { mountRecoveryScreen } from '../dist/recovery-screen.js';
import { DropboxSync } from '../dist/dropbox-sync.js';
import { dropboxContentHash } from '../dist/dropbox-api.js';
import { writeCsv } from '../dist/csv.js';
const title = { show_id: 7, show: 'Cliff Signal' };
const watch = count => ({ ...title, season: 1, episode: 3, episode_id: 71, title: 'Low Tide', times_watched: count });
const settings = [{ setting: 'github_repo', value: 'fictional/recovery' }];
const seed = { watched: [watch(1)], ratings: [{ ...title, rating: 8 }], lists: [{ list: 'Watchlist', ...title }],
  shows: [{ ...title, year: 2007, imdb_id: 'tt54321' }], settings };
const credentials = { instanceId: 'fictional-recovery-1', accountId: 'fictional-A', accessToken: 'fixture-a',
  refreshToken: 'fixture-b', accessExpiresAt: Date.now() + 86400000, signInDeadline: Date.now() + 2 * 86400000, providerExpiresAt: Date.now() + 2 * 86400000 };
function check(result, msg) { if (!result) throw Error(msg); }
async function until(test, msg) {
  const limit = performance.now() + 6000;
  while (performance.now() < limit) {
    const v = await test(); if (v) return v;
    await new Promise(resolve => setTimeout(resolve, 12));
  }
  throw Error(msg);
}
async function fixture(body) {
  const name = 'recovery-tests-' + crypto.randomUUID(), store = await openDeviceStore({ name });
  const service = new TmdbService(store, undefined, { now: Date.now, online: () => true, visible: () => true });
  const frame = document.createElement('iframe');
  frame.width = 320; frame.height = 660;
  const loaded = new Promise(resolve => { frame.onload = resolve; });
  frame.src = '/screen-fixture'; document.body.append(frame);
  let screen;
  try {
    await loaded; await store.whenWriter(); await store.commit((await store.snapshot()).revision, { put: seed });
    const root = frame.contentDocument.querySelector('#app'), events = new EventTarget();
    const actions = { changed: events, busy: false, async exclusive(_kind, fn) {
      if (this.busy) throw Error('Already running');
      this.busy = true; try { return await fn(); } finally { this.busy = false; }
    }, async backupAccess() { throw Error('Unexpected Dropbox access'); } };
    const mount = async () => {
      const ctx = {service,clearUndo() {}};
      const recovery = mountRecoveryScreen(root,ctx,actions);
      check(!root.querySelector('[data-clear-device]'), 'Restore duplicated the device clear');
      const offline = root.ownerDocument.createElement('section'); root.append(offline);
      const device = mountClearDevice(offline,ctx,actions);
      screen = {async refresh(){device.refresh(); await recovery.refresh();},dispose(){device.dispose(); recovery.dispose();}};
      await recovery.ready; return screen;
    };
    await body({ name, frame, root, store, service, actions, mount });
  } finally {
    screen?.dispose(); service.close(); store.close(); frame.remove();
    const req = indexedDB.deleteDatabase(name);
    await new Promise((done, fail) => { req.onsuccess = done; req.onerror = () => fail(req.error); });
  }
}
export async function recoveryScreenCases(run) {
  await run('A Dropbox restore stays bound to its live grant and open screen until the final native watch write', () =>
    fixture(async({store})=>{
      await store.storeExchangedSession(credentials);
      for (const gate of ['grant','screen']) {
        const count=gate==='grant'?2055:12,rows=Array.from({length:count},(_,i)=>({...watch(1),episode:i+1,episode_id:10000+i}));
        let current=true,now=Date.now(),reached=false;
        const csv=writeCsv('watched',rows),live={bytes:new TextEncoder().encode(csv),metadata:{rev:'verified-copy'}};
        const engine=new DropboxSync(store,{},credentials,{},()=>now);
        const original=IDBObjectStore.prototype.add;
        try {
          IDBObjectStore.prototype.add=function(row,...args){
            const request=original.call(this,row,...args);
            if(this.name==='watched'&&row.episode===count)request.addEventListener('success',()=>{
              reached=true;
              if(gate==='grant')now=credentials.signInDeadline;else current=false;
            },{once:true});
            return request;
          };
          const outcome=await engine.replaceForRestore('watched',csv,live,undefined,undefined,()=>current)
            .then(()=>'',error=>error.message);
          check(reached,'The test did not reach the final persisted watch request');
          check(gate==='grant'?outcome.includes('sign-in changed or ended'):outcome.includes('screen closed'),
            'An obsolete '+gate+' admitted the restore after its last watch reached IndexedDB');
          const after=await store.snapshot();
          check(after.tables.watched.length===1&&after.tables.watched[0].episode_id===71&&!after.sync.watched,
            'A late restore left watch rows or a base revision after its '+gate+' ended');
        } finally {IDBObjectStore.prototype.add=original;}
      }
      const choices={ratings:[{...title,rating:3}],lists:[{...title,list:'Favorites'}],settings:[{setting:'appearance',value:'light'}]};
      for(const [table,method] of [['ratings','add'],['lists','add'],['settings','put'],['settings','delete']]) {
        const rows=choices[table],original=IDBObjectStore.prototype[method];
        const before=(await store.snapshot()).tables[table];
        let open=true,reached=false;
        try {
          IDBObjectStore.prototype[method]=function(...args){
            const request=original.apply(this,args);
            if(this.name===table)request.addEventListener('success',()=>{reached=true;open=false;},{once:true});
            return request;
          };
          const csv=writeCsv(table,rows),live={bytes:new TextEncoder().encode(csv),metadata:{rev:'reviewed-'+table}};
          const engine=new DropboxSync(store,{},credentials);
          const outcome=await engine.replaceForRestore(table,csv,live,undefined,undefined,()=>open)
            .then(()=>'',error=>error.message);
          check(reached&&outcome.includes('screen closed'),'A late '+table+' write survived its closed Restore screen');
          const state=await store.snapshot();
          check(writeCsv(table,state.tables[table])===writeCsv(table,before)&&!state.sync[table],
            'A closed Restore left '+table+' rows or its base revision');
        } finally {IDBObjectStore.prototype[method]=original;}
      }
    }));
  await run('A backup preview reads its own tables and omits stored grant and legacy provider values',()=>
    fixture(async({name,store})=>{
      await store.storeExchangedSession(credentials);
      const db = await new Promise((resolve,reject)=>{const r=indexedDB.open(name);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
      const key = {setting:'tmdb_key',value:'fictional-private-migration-value'}, raw = writeCsv('settings',[...settings,key]);
      try {
        const tx = db.transaction(['settings','sync'],'readwrite');
        tx.objectStore('settings').put(key);
        const stamp = '2026-11-01T00:00:00Z';
        tx.objectStore('sync').put({base:{content:raw,revision:'old'},pending:{content:raw,targetContent:raw,
          targetRevision:'old',targetModified:stamp,clientModified:stamp,preparedAt:Date.parse(stamp)},lastClientModified:stamp},'settings');
        await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});
      } finally { db.close(); }
      const all=IDBObjectStore.prototype.getAll, get=IDBObjectStore.prototype.get;
      const tables=[],receipts=[];
      try {
        IDBObjectStore.prototype.getAll=function(...args){tables.push(this.name);return all.apply(this,args);};
        IDBObjectStore.prototype.get=function(...args){if(this.name==='sync')receipts.push(args[0]);return get.apply(this,args);};
        const rating=await store.dropboxRestorePreview(['ratings','ratings']);
        check(rating.tables.ratings.length===1 && !rating.tables.watched.length && !rating.tables.settings.length &&
          tables.join()==='ratings' && receipts.join()==='ratings','A ratings preview read a second table or receipt');
        const historic=await store.dropboxRestorePreview(['settings']);
        const returned=JSON.stringify(historic,(_k,value)=>typeof value==='bigint'?String(value):value);
        check(historic.local.dropboxSession?.instanceId===credentials.instanceId && historic.tables.settings[0].value===settings[0].value &&
          ![key.value,credentials.accessToken,credentials.refreshToken].some(value=>returned.includes(value)),
          'The recovery projection exposed a protected value or lost its public sign-in identity');
        check([historic.sync.settings.base.content,historic.sync.settings.pending.content,historic.sync.settings.pending.targetContent]
          .every(csv=>csv===writeCsv('settings',settings)),'A key-bearing recovery receipt retained its provider row');
        await store.dropboxRestorePreview([]);
        check(tables.join()==='ratings,settings' && receipts.join()==='ratings,settings','An empty preview read record files');
        const canceled = new AbortController();
        IDBObjectStore.prototype.getAll=function(...args){if(this.name==='watched')queueMicrotask(()=>canceled.abort());return all.apply(this,args);};
        const stopped = await store.dropboxRestorePreview(['watched'],canceled.signal).then(()=>false,error=>error.name==='AbortError');
        check(stopped,'Closing a preview while its record read was queued returned the old selection');
      } finally { IDBObjectStore.prototype.getAll=all; IDBObjectStore.prototype.get=get; }
    }));

  await run('A displayed Dropbox backup belongs to its listing grant, including when the account notification arrives late', () =>
    fixture(async({store,root,actions,mount})=>{
      await store.storeExchangedSession(credentials);
      const calls=[],opens=[];
      actions.backupAccess=async expected=>{
        const {accountId,session}=await store.dropboxState();
        opens.push({expected,actual:session.instanceId});
        if (expected && (expected.accountId!==accountId || expected.instanceId!==session.instanceId)) throw Error('The sign-in changed.');
        const folder=accountId===credentials.accountId?'Signal collection':'Harbor collection';
        const item={kind:'file',path:'/backups/'+folder+'/ratings.csv',name:'ratings.csv',size:48,serverModified:'2026-01-01T12:00:00Z'};
        return {api:{async list(dir,recursive){
          calls.push([accountId,dir]);
          return dir==='/backups'?[{kind:'folder',path:'/backups/'+folder,name:folder},...(recursive?[item]:[])]:[item];
        },async download(path){calls.push([accountId,path]);return null;}}};
      };
      const screen=await mount();
      const oldFolder=root.querySelector('[data-folder="Signal collection"]');
      check(oldFolder,'Original account did not list its backup');
      const next={...credentials,accountId:'fictional-B',instanceId:'fictional-recovery-2'};
      await store.storeExchangedSession(next);
      await store.commit((await store.snapshot()).revision,{local:{syncAccountId:next.accountId}});
      // Keep the original listing visible until the pending account-change notification is delivered.
      oldFolder.click();
      await until(()=>opens.some(item=>item.actual===next.instanceId),'Old folder did not encounter the replacement sign-in');
      await until(()=>calls.some(([account,path])=>account===next.accountId&&path.includes('Signal collection')) ||
        !root.querySelector('[data-state]').textContent.includes('Reading backup files'),'Stale folder did not settle');
      check(!calls.some(([account,path])=>account===next.accountId&&path.includes('Signal collection')),
        'The previous account’s selected backup path reached the replacement account');
      check(opens.at(-1).expected?.instanceId===credentials.instanceId,'The displayed folder did not bind its listing grant');
      await screen.refresh();
      check(root.querySelector('[data-folder="Harbor collection"]'),'The new account could not list its own backups');
    }));

  await run('Late preparation respects a busy restore and cannot close a newer erase dialog', () =>
    fixture(async ({ store, service, frame, root, actions, mount }) => {
      const files = (await prepareExport(service, 'record')).files, screen = await mount();
      const original = store.exportSnapshot.bind(store);
      function delayNext() {
        const started = Promise.withResolvers(), gate = Promise.withResolvers();
        store.exportSnapshot = async (...args) => {
          store.exportSnapshot = original;
          const snapshot = await original(...args);
          started.resolve(); await gate.promise; return snapshot;
        };
        return { started: started.promise, gate };
      }
      const delayedPreview = delayNext(), transfer = new frame.contentWindow.DataTransfer();
      for (const file of files) transfer.items.add(file);
      const input = root.querySelector('input[type=file]');
      input.files = transfer.files; input.dispatchEvent(new Event('change'));
      await delayedPreview.started; actions.busy = true; await screen.refresh();
      delayedPreview.gate.resolve();
      const apply = await until(() => root.querySelector('[data-apply-local]'), 'Pending preview did not finish');
      check(apply.disabled, 'A background restore enabled acceptance during a hold');
      actions.busy = false; await screen.refresh();
      check(!apply.disabled, 'Restoring remained disabled after the hold');
      const erase = root.querySelector('[data-clear-device]'), stale = delayNext();
      erase.click(); await stale.started;
      root.querySelector('dialog').dispatchEvent(new Event('cancel', {cancelable:true}));
      await until(() => !erase.disabled, 'Canceled erase kept the control disabled');
      erase.click();
      await until(() => root.querySelectorAll('dialog a[download]').length === 4, 'New erase did not finish preparation');
      const current = root.querySelector('dialog');
      stale.gate.reject(Error('Superseded download'));
      await new Promise(resolve => setTimeout(resolve, 0));
      check(current.open && root.querySelector('dialog') === current && !root.querySelector('[data-result]').textContent,
        'A retired erase operation closed its replacement or showed a stale error');
    }));

  await run('Recovery frees partial backup downloads and can retry after a changed preview or an erase failure', () =>
    fixture(async ({ store, service, frame, root, mount }) => {
      const files = (await prepareExport(service, 'record')).files;
      const screen = await mount(), doc = frame.contentDocument, win = frame.contentWindow;
      const input = root.querySelector('input[type=file]'), transfer = new win.DataTransfer();
      for (const file of files) transfer.items.add(file);
      const create = win.URL.createObjectURL.bind(win.URL), revoke = win.URL.revokeObjectURL.bind(win.URL);
      const live = new Set();
      let untilFailure = 2;
      win.URL.createObjectURL = file => {
        if (--untilFailure === 0) throw new DOMException('Fixture quota reached', 'QuotaExceededError');
        const url = create(file); live.add(url); return url;
      };
      win.URL.revokeObjectURL = url => { live.delete(url); revoke(url); };
      const result = () => root.querySelector('[data-device-result]').textContent;
      const retry = () => [...root.querySelectorAll('[data-local-preview] button')].find(b => b.textContent === 'Retry downloads');
      const waitRetry = () => until(retry, 'The failed backup offer left no retry for the selected four files');
      try {
        input.files = transfer.files; input.dispatchEvent(new Event('change'));
        (await waitRetry()).click();
        await until(() => root.querySelector('[data-apply-local]'), 'Retry did not prepare the restore offer');
        check(live.size === 4, 'A partial restore download survived retry');
        await store.commit((await store.snapshot()).revision, { put: { watched: [watch(6)] } });
        untilFailure = 2;
        root.querySelector('[data-apply-local]').click();
        await waitRetry();
        check(!live.size && !root.querySelector('[data-apply-local]') && (await store.snapshot()).tables.watched[0].times_watched === 6,
          'Failed revised preview retained URLs, an acceptance or stale data');
        retry().click();
        await until(() => root.querySelector('[data-apply-local]'), 'Could not reopen the revised preview');
        untilFailure = 2;
        root.querySelector('[data-clear-device]').click();
        await until(() => !root.querySelector('dialog') && result().includes('Could not'), 'Failed erase preparation was left open');
        check(live.size === 4 && [...root.querySelectorAll('a[download]')].every(a => live.has(a.href)),
          'Failed erase revoked preview files or leaked a partial erase download');
        const cancel = [...root.querySelectorAll('[data-local-preview] button')].find(b => b.textContent === 'Cancel');
        cancel.focus(); cancel.click();
        check(!live.size && doc.activeElement === input, 'Cancel leaked backup URLs or lost picker focus');
        root.querySelector('[data-clear-device]').click();
        await until(() => root.querySelectorAll('dialog a[download]').length === 4, 'Erase did not recover');
        [...root.querySelectorAll('dialog button')].find(b => b.textContent === 'Cancel').click();
        await until(() => !live.size, 'Erase left live URLs on cancellation');
      } finally {
        screen.dispose(); win.URL.createObjectURL = create; win.URL.revokeObjectURL = revoke;
      }
    }));

  await run('An exact offline snapshot restores all four local tables, keeps settings and survives reopening', () =>
    fixture(async ({ store, service, name }) => {
      const files = (await prepareExport(service, 'record')).files;
      const record = await readLocalRecord(files), baseline = await store.snapshot();
      await store.commit(baseline.revision, { put: { watched: [watch(5)], lists: [{ ...title, list: 'Later' }] }, local: { recentlyMarked: [7] } });
      const preview = previewLocalRecord(await store.snapshot(), record);
      check(preview.counts[0].replacements === 1 && preview.counts[2].removals === 1, 'Preview missed count or membership changes');
      await applyLocalRecord(store, preview);
      const reopened = await openDeviceStore({ name });
      try {
        const after = await reopened.snapshot();
        check(after.tables.watched[0].times_watched === 1 && after.tables.lists.length === 1 &&
          after.tables.shows[0].imdb_id === 'tt54321' && after.tables.settings[0].value === settings[0].value,
          'Reopened local restore changed or lost a selected value');
        check(after.tmdbGeneration > baseline.tmdbGeneration && !after.local.recentlyMarked, 'Old record work was not invalidated');
      } finally { reopened.close(); }
    }));

  await run('A canceled, aborted, or account-mismatched local recovery preserves all four tables and the selected credentials', () =>
    fixture(async ({ name, store, service, frame, root, actions, mount }) => {
      const files = (await prepareExport(service, 'record')).files;
      const screen = await mount();
      const input = root.querySelector('input[type=file]'), transfer = new frame.contentWindow.DataTransfer();
      for (const file of files) transfer.items.add(file);
      input.files = transfer.files; input.dispatchEvent(new Event('change'));
      await until(() => root.querySelector('[data-apply-local]'), 'Local restore buttons missing');
      check(root.querySelectorAll('a[download]').length === 4 && !root.querySelector('a[download="settings.csv"]'), 'Backup offer incorrect');
      [...root.querySelectorAll('button')].find(b => b.textContent === 'Cancel').click();
      check(!root.querySelector('[data-apply-local]') && frame.contentDocument.activeElement === input, 'Cancel left a live preview or lost focus');
      await store.commit((await store.snapshot()).revision, {put:{watched:[watch(2)]}});
      const second = new frame.contentWindow.DataTransfer();
      for (const file of files) second.items.add(file);
      input.files = second.files; input.dispatchEvent(new Event('change'));
      const apply = await until(() => root.querySelector('[data-apply-local]'), 'Could not reopen local restore');
      const commit = store.commit.bind(store), admitted = Promise.withResolvers(), proceed = Promise.withResolvers();
      store.commit = async (...args) => {
        admitted.resolve(); await proceed.promise; return commit(...args);
      };
      try {
        apply.click(); await admitted.promise;
        [...root.querySelectorAll('button')].find(b => b.textContent === 'Cancel').click();
        proceed.resolve();
        await until(() => !actions.busy, 'Canceled restore did not finish');
      } finally { store.commit = commit; proceed.resolve(); }
      const reopened = await openDeviceStore({name});
      try {
        check((await reopened.snapshot()).tables.watched[0].times_watched === 2,
          'A canceled local restore replaced the record after its commit resumed');
      } finally { reopened.close(); }
      await store.commit((await store.snapshot()).revision, {put:{watched:[watch(1)]}});
      const original = await store.snapshot(), record = await readLocalRecord(files);
      record.watched[0].times_watched = 9;
      const plan = previewLocalRecord(original, record), put = IDBObjectStore.prototype.put;
      let aborted = false;
      IDBObjectStore.prototype.put = function (...args) {
        const request = put.apply(this, args);
        if (this.name === 'meta' && args[1] === 'revision') { aborted = true; this.transaction.abort(); }
        return request;
      };
      try { await applyLocalRecord(store, plan).then(() => { throw Error('Abort committed'); }, () => {}); }
      finally { IDBObjectStore.prototype.put = put; }
      check(aborted && (await store.snapshot()).tables.watched[0].times_watched === 1, 'Failed replacement changed the record');
      await store.storeExchangedSession(credentials);
      let refused = false;
      try { await applyLocalRecord(store, plan); } catch { refused = true; }
      await screen.refresh();
      check(refused && root.querySelector('[data-local]').hidden && (await store.snapshot()).tables.settings[0].value === settings[0].value,
        'A code exchange did not fence the old restore');
    }));

  await run('Dropbox recovery at phone width retains keyboard focus through a held preflight and reports untouched files after a failed call', () =>
    fixture(async ({ store, root, frame, actions, mount }) => {
      await store.storeExchangedSession(credentials);
      const path = '/backups/Legacy-folder/ratings.csv', body = writeCsv('ratings', seed.ratings), bytes = new TextEncoder().encode(body);
      const meta = { kind: 'file', path, name: 'ratings.csv', contentHash: await dropboxContentHash(bytes), rev: 'r1',
        serverModified: new Date().toISOString(), clientModified: new Date().toISOString(), size: bytes.length };
      let unblock, noRead = false, queue = 0;
      const api = { async list(dir) {
        if (noRead) throw Error('Read failed');
        return dir === '/backups' ? [{ kind: 'folder', path: '/backups/Legacy-folder', name: 'Legacy-folder' }] : [meta];
      }, async download(target) { return target === path ? { metadata: meta, bytes } : null; },
      async createFolder() { await new Promise(resolve => { unblock = resolve; }); throw Error('Provider failure'); } };
      actions.backupAccess = async () => ({ api, engine: new DropboxSync(store, api, credentials) });
      actions.queueSync = () => { queue++; };
      const snapshot = store.snapshot.bind(store);
      const read = store.dropboxRestorePreview.bind(store), previews = [];
      store.dropboxRestorePreview = async (tables,signal) => { previews.push([...tables]); return read(tables,signal); };
      let fullReads = 0;
      store.snapshot = async () => { fullReads++; return snapshot(); };
      const screen = await mount(), doc = frame.contentDocument;
      check(fullReads === 0, 'Listing backup dates read the entire watch record');
      check(!root.querySelector('[data-local] input').getClientRects().length, 'A linked device offered local restore');
      const row = root.querySelector('[data-folder="Legacy-folder"]');
      check(row?.textContent.includes('Unmarked folder'), 'Unverified generation was not labeled');
      noRead = true; row.click();
      await until(() => root.querySelector('[data-state]').textContent.includes('Could not read'), 'Folder failure missing');
      check(!root.textContent.includes('Reading backup files') && !root.querySelector('[data-restore]'),
        'A failed backup read still claimed to be in progress');
      noRead = false;
      root.querySelector('[data-refresh]').click();
      await until(() => root.querySelector('[data-folder="Legacy-folder"]'), 'Refresh omitted the recovered backup folder');
      root.querySelector('[data-folder="Legacy-folder"]').click();
      const restore = await until(() => root.querySelector('[data-restore]'), 'Restore action absent');
      const box = root.querySelector('[data-files] input');
      check(box.checked && box.value === 'ratings' && box.parentElement.textContent.includes('1 unsynced change'), 'Incorrect initial selection or change count');
      check(fullReads === 0 && JSON.stringify(previews) === '[["ratings"]]', 'A ratings-only backup opened unrelated record files');
      box.click();
      check(restore.disabled, 'Removing the last selected file did not immediately disable Restore');
      box.click();
      await screen.refresh();
      check(!restore.disabled && fullReads===0 && previews.length===1, 'Refreshing an unchanged preview recounted the watch record');
      await store.commit((await snapshot()).revision,{put:{ratings:[{show_id:8,show:'Harbor Radio',rating:6}]}});
      await screen.refresh();
      check(box.checked && box.parentElement.textContent.includes('2 unsynced changes') && previews.length===2 && fullReads===0,
        'A real record change did not update the selected file’s unsynced count');
      // A delayed write can complete before this screen receives its record-change event.
      await store.commit((await snapshot()).revision,{put:{ratings:[{...title,rating:9}]}});
      restore.click();
      await until(()=>unblock || root.querySelector('[data-result]').textContent.includes('ratings.csv — Not restored.'),
        'The outdated local selection was not settled');
      if(unblock){unblock();throw Error('The old selection began backing up before reviewing a changed local score');}
      check((await snapshot()).tables.ratings.find(r=>r.show_id===title.show_id).rating===9 && box.checked && !queue,
        'An obsolete confirmation replaced the new score, changed the selection or queued a write');
      await screen.refresh();
      // An unrelated watch edit must not require reviewing the same selected ratings again.
      await store.commit((await snapshot()).revision,{put:{watched:[watch(4)]}});
      restore.focus(); restore.click();
      await until(() => unblock, 'Backup did not reach held state');
      const dialog = root.querySelector('dialog');
      check(dialog.matches(':modal') && doc.activeElement?.getAttribute('role') === 'status', 'Hold did not focus its named status');
      dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
      dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
      check(dialog.open && doc.activeElement === dialog.querySelector('h2'), 'Held dialog allowed dismissal or focus escape');
      unblock();
      await until(() => root.querySelector('[data-result]').textContent.includes('ratings.csv — Not restored.'), 'Missing per-file failure');
      check(!queue && doc.activeElement === root.querySelector('[data-result]'), 'An untouched restore queued a sync or lost focus');
      noRead = true; root.querySelector('[data-refresh]').click();
      await until(() => root.querySelector('[data-state]').textContent.includes('Could not list'), 'Listing failure missing');
      check(!root.querySelector('[data-restore]') && doc.documentElement.scrollWidth <= 320, 'Stale restore targets remained or phone layout overflowed');
      await screen.refresh();
    }));

  await run('Erase shows outstanding work and four backup downloads while signed out, fences a new sign-in, and clears every device store on fresh consent', () =>
    fixture(async ({ name, store, root, service, actions, mount }) => {
      await store.storeExchangedSession(credentials);
      const pending = { content: writeCsv('watched', [watch(1)]), targetRevision: 'r1', targetContent: writeCsv('watched', [watch(3)]),
        targetModified: '2026-01-01T00:00:00Z', clientModified: '2026-01-02T00:00:00Z', preparedAt: 1 };
      await store.commit((await store.snapshot()).revision, { removeLocal: ['dropboxSession'], sync: { watched: {
        pending, base: null, lastClientModified: pending.clientModified } } });
      await store.cache('fictional-opaque', { value: 1 });
      let release;
      actions.erase = async revision => {
        await new Promise(resolve => { release = resolve; });
        await store.eraseDevice(revision);
      };
      const screen = await mount();
      const openErase = async () => {
        root.querySelector('[data-clear-device]').click();
        return until(() => root.querySelector('dialog .sheet button:last-child'), 'Erase confirmation did not open');
      };
      const cutoff = credentials.signInDeadline;
      await store.storeExchangedSession(credentials);
      await screen.refresh();
      await openErase();
      check(root.querySelectorAll('dialog a[download]').length === 4, 'An unresolved upload while signed in hid the backup downloads');
      [...root.querySelectorAll('dialog button')].find(b => b.textContent === 'Cancel').click();
      await until(() => !root.querySelector('dialog') && !root.querySelector('[data-clear-device]').disabled, 'Cancel did not return to recovery');
      service.environment.now = () => cutoff;
      for (const deadline of [cutoff, undefined]) {
        await store.storeExchangedSession({...credentials, signInDeadline:deadline});
        await screen.refresh();
        await openErase();
        check(root.querySelectorAll('dialog a[download]').length === 4, 'Expired sign-in hid the four backup downloads');
        check(root.querySelector('[data-state]').textContent.includes('Sign in to Dropbox'), 'Expired device did not explain how to recover access');
        [...root.querySelectorAll('dialog button')].find(b => b.textContent === 'Cancel').click();
        await until(() => !root.querySelector('dialog') && !root.querySelector('[data-clear-device]').disabled, 'Cancel did not return to recovery');
      }
      await store.commit((await store.snapshot()).revision,{removeLocal:['dropboxSession']});
      const first = await openErase();
      check(root.querySelectorAll('dialog a[download]').length === 4 && root.querySelector('dialog').textContent.includes('may still arrive'),
        'Erase omitted the offline backup offer or outstanding-upload warning');
      first.click(); await until(() => release, 'Erase did not start');
      await store.storeExchangedSession({ ...credentials, instanceId: 'fictional-new', accountId: 'fictional-new-owner' });
      release();
      await until(() => !root.querySelector('dialog'), 'Stale Erase held the screen');
      const retained = await store.snapshot();
      check(retained.tables.watched.length === 1 && retained.sync.watched.pending && retained.local.dropboxSession.instanceId === 'fictional-new',
        'Stale Erase removed a new sign-in or its data');
      await store.commit(retained.revision, { removeLocal: ['dropboxSession'] });
      actions.erase = async revision => store.eraseDevice(revision);
      await until(() => !root.querySelector('[data-clear-device]').disabled, 'Erase did not reenable');
      (await openErase()).click();
      await until(() => root.querySelector('[data-device-result]').textContent === 'Device data erased.', 'Fresh Erase did not complete');
      const peer = await openDeviceStore({ name });
      try {
        const empty = await peer.snapshot();
        check(Object.values(empty.tables).every(rows => !rows.length) && !Object.keys(empty.sync).length &&
          !Object.keys(empty.local).length && !await peer.cacheValue('fictional-opaque'), 'Erased data reappeared after reopening');
      } finally { peer.close(); }
    }));
}
