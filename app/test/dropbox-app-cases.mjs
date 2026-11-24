import { DropboxDialogs } from '../dist/dropbox-dialogs.js';
import { readCsv } from '../dist/csv.js';
import { mergeWatched } from '../dist/watch-merge.js';
import { mountHandMerge } from '../dist/hand-merge-screen.js';
import { openDeviceStore } from '../dist/storage.js';
import { mountApplication } from '../dist/application.js';
import { DropboxAuth } from '../dist/dropbox-auth.js';
import { DropboxController } from '../dist/dropbox-controller.js';
import { mountDropboxSettings } from '../dist/dropbox-settings.js';
import { TmdbService } from '../dist/tmdb-service.js';
import { withImportApp } from './import-app-fixture-cases.mjs';
import { connectFixtureProviders } from './provider-fixture-cases.mjs';
import { WatchActions } from '../dist/watch-actions.js';

function check(ok,message) { if (!ok) throw Error(message); }
async function until(test,message) {
  for (let end=performance.now()+6000;performance.now()<end;) {
    const result=await test(); if (result) return result;
    await new Promise(resolve=>setTimeout(resolve,12));
  }
  throw Error(message);
}
async function inFrame(path,width,callback) {
  const frame=document.createElement('iframe');
  frame.width=width; frame.height=780;
  await new Promise(resolve=>{frame.onload=resolve; frame.src=path; document.body.append(frame);});
  try { await callback(frame.contentDocument,frame.contentWindow); } finally { frame.remove(); }
}

export async function dropboxAppCases(run) {
  await run('Dropbox settings separate app registration from sign-in and gate backups by account, connection and tab', () =>
    inFrame('/screen-fixture', 320, async (doc, win) => {
      const root = doc.querySelector('#app'), key = 'csvTV-public-dropbox-app-key';
      const name = 'dropbox-settings-' + crypto.randomUUID(), store = await openDeviceStore({name});
      await store.whenWriter();
      const reader = await openDeviceStore({name}), ctx = {service:{store}};
      const previousKey = win.localStorage.getItem(key);
      const meta = doc.createElement('meta'); meta.name = 'dropbox-app-key'; doc.head.append(meta);
      win.localStorage.removeItem(key);
      let online = true, releaseBackup, rejectBackup, settings, reviewedScopes;
      Object.defineProperty(win.navigator, 'onLine', {configurable:true, get:() => online});
      const calls = [];
      const cloud = {
        auth:{get appKey() { return meta.content || win.localStorage.getItem(key) || ''; }},
        changed:new EventTarget(), notices:[], synced:false, signedIn:false, linked:false, mismatch:false, operation:null,
        reason:'Sign in to Dropbox.', get busy() { return this.operation !== null; },
        get canBackUpNow() { return this.signedIn && this.linked && !this.mismatch && !this.busy && online && ctx.service.store.role === 'writer'; },
        refresh() { this.changed.dispatchEvent(new Event('change')); },
        report(message) { this.notices.push(message); this.refresh(); }, failure:error => error.message,
        async signIn() { calls.push('sign in'); this.signedIn = this.linked = true; this.reason = 'Changes are waiting to sync.'; this.refresh(); },
        queueSync(explicit) { calls.push(explicit ? 'sync now' : 'sync'); },
        async signOut() { calls.push('sign out'); this.signedIn = false; this.reason = 'Sign in to Dropbox.'; this.refresh(); },
        async clearDropbox(scopes,signal) { check(!signal.aborted,'Reset review received a retired screen'); reviewedScopes=scopes; return false; },
        async backUpNow() {
          calls.push('backup'); this.operation = 'backup'; this.refresh();
          try { await new Promise((resolve, reject) => { releaseBackup = resolve; rejectBackup = reject; }); }
          finally { this.operation = null; this.refresh(); }
        },
      };
      const q = selector => root.querySelector(selector);
      try {
        win.history.replaceState(null, '', '/my-shows/?setup=1#/settings');
        root.innerHTML = '<div id="settings-services"><section class="key-row">Another service</section></div>';
        settings = mountDropboxSettings(root, ctx, cloud);
        const edit = q('[data-edit-client]'), help = q('[data-dropbox-help]'), field = q('[name=appKey]');
        const form = field.form, sign = q('[data-sign-in]'), backup = q('[data-backup]'), feedback = q('[data-dropbox-feedback]');
        const status = q('[data-cloud-reason]'), accountActions = q('[data-account-actions]'), fileActions = q('[data-file-actions]');
        check(q('#settings-services').firstElementChild === q('.dropbox-settings') && q('.dropbox-required').textContent === 'Required' &&
          accountActions.contains(sign) && accountActions.contains(q('[data-sync]')) && accountActions.contains(q('[data-sign-out]')) &&
          accountActions.contains(backup) && fileActions.contains(q('a[href="#/recovery"]')) && fileActions.contains(q('a[href="#/hand-merge"]')),
          'Dropbox lost its position, requirement or grouped controls');
        check(edit.textContent === 'Add app key' && !edit.hidden && form.hidden && sign.hidden && backup.disabled &&
          status.textContent === 'Add a public app key to connect.', 'Unconfigured Dropbox setup was unclear');
        help.click();
        const redirect = q('dialog code');
        const paragraphs = [...root.querySelectorAll('dialog p')].filter(p => p.textContent.trim() && !p.contains(redirect));
        const instructions = 'Open the Dropbox App Console and create an app with App folder access. ' +
          'Under Permissions enable files.metadata.read, files.content.read and files.content.write, then save. ' +
          'Under Settings, enable Allow public clients. Copy the address shown below into Redirect URIs, then add it. ' +
          'Copy the App key from Dropbox and save it in csvTV.';
        check(paragraphs.length === 1 && paragraphs[0].textContent === instructions, 'App key help changed the setup paragraph');
        const consoleLink = paragraphs[0].querySelector('a');
        check(consoleLink?.textContent === 'Dropbox App Console' && consoleLink.href === 'https://www.dropbox.com/developers/apps',
          'App key help lost the Dropbox App Console link');
        check(redirect?.parentElement.querySelector('strong')?.textContent === 'Redirect URI for this site' &&
          redirect.textContent === win.location.origin + '/my-shows/', 'App key help must label this installation’s exact redirect address');
        q('dialog button').click(); check(doc.activeElement === help, 'Closing help lost focus');
        edit.click(); field.value = 'FictionalDiscard'; q('[data-cancel-key]').click();
        check(form.hidden && !win.localStorage.getItem(key) && doc.activeElement === edit, 'Cancel saved the app key or lost focus');
        edit.click(); field.value = 'FictionalRegistration'; form.requestSubmit();
        await until(() => form.hidden && !sign.hidden && !edit.disabled, 'Saving the public registration did not enable sign-in');
        check(win.localStorage.getItem(key) === 'FictionalRegistration' && edit.textContent === 'Change app key' &&
          feedback.textContent.includes('saved on this device') && !cloud.signedIn, 'Saving an app key signed in or lost the saved value');
        edit.click();
        check(field.value === 'FictionalRegistration', 'Change app key did not show the existing registration');
        field.dispatchEvent(new win.KeyboardEvent('keydown', {key:'Escape',bubbles:true,cancelable:true}));
        check(form.hidden && doc.activeElement === edit, 'Escape did not cancel the in-place editor');
        sign.click();
        check(edit.hidden && !q('[data-sync]').hidden && !backup.disabled && !q('[data-sign-out]').hidden,
          'A matching signed-in account could not sync or back up before its first sync');
        check(fileActions.getBoundingClientRect().top >= accountActions.getBoundingClientRect().bottom &&
          doc.documentElement.scrollWidth <= win.innerWidth && q('[data-sync]').getBoundingClientRect().height >= 44,
          'Dropbox action groups overlapped, overflowed or lost their touch target at 320px');
        cloud.synced = true; cloud.reason = 'Every file is synced.'; cloud.refresh();
        check(status.textContent === 'Synced' && !q('.dropbox-settings').textContent.includes(cloud.reason), 'The synced state was repeated');
        check(status.previousElementSibling?.classList.contains('dropbox-required') && status.dataset.synced === 'true','Sync status lost its inline position or colour state');
        check([...q('.dropbox-actions').querySelectorAll('button:not([hidden]),a')].map(el=>el.textContent).join('|') ===
          'Sync now|Back up now|Sign out|Merge|Restore|Clear Dropbox…','Dropbox actions appeared out of order');
        q('[data-clear-dropbox]').click();
        const boxes = [...q('dialog fieldset').querySelectorAll('input')], review = q('dialog .actions button:last-child');
        check(boxes.length === 5 && boxes.every(box=>!box.checked) && review.disabled,'A destructive reset scope started selected');
        boxes[2].click(); check(!review.disabled,'Selecting a scope left review disabled');
        boxes[2].click(); check(review.disabled,'Review remained enabled with no selections');
        boxes[1].click(); boxes[4].click(); review.click();
        await until(()=>!!reviewedScopes,'Review did not hand off the choices');
        check(reviewedScopes.join('/')==='ratings/backups','Review included an unchecked category');
        cloud.synced = false; cloud.reason = 'Changes are waiting to sync.'; cloud.refresh();
        check(status.dataset.synced === 'false','Unsynced status kept its synced colour');
        q('[data-sync]').click(); backup.click();
        check(backup.disabled && backup.textContent.includes('Backing up'), 'The running backup was available twice');
        releaseBackup();
        await until(() => feedback.textContent === 'Backup saved to Dropbox.', 'A completed backup had no outcome');
        backup.click(); rejectBackup(Error('Fictional account changed before backup'));
        await until(() => feedback.textContent.includes('account changed'), 'A failed backup incorrectly reported success');
        for (const reason of ['offline', 'mismatch', 'reader']) {
          online = reason !== 'offline'; cloud.mismatch = reason === 'mismatch'; ctx.service.store = reason === 'reader' ? reader : store;
          cloud.refresh();
          const expected = {offline:'Offline', mismatch:'linked Dropbox account', reader:'editing tab'};
          check(backup.disabled && status.textContent.includes(expected[reason]) &&
            q('a[href="#/recovery"]') && q('a[href="#/hand-merge"]'), 'Backup or local navigation controls for ' + reason);
          backup.click();
        }
        online = true; cloud.mismatch = false; ctx.service.store = store; cloud.refresh();
        q('[data-sign-out]').click();
        check(edit.hidden && !sign.hidden && backup.disabled && q('[data-sync]').hidden &&
          calls.join('/') === 'sign in/sync now/backup/backup/sign out', 'Linked registration or account actions after sign-out');
        settings.dispose();
        root.innerHTML = '<div id="settings-services"></div>';
        meta.content = 'FictionalPublisherRegistration'; cloud.linked = false;
        settings = mountDropboxSettings(root, ctx, cloud);
        check(q('[data-edit-client]').hidden && q('form').hidden && !q('[data-sign-in]').hidden &&
          q('[data-cloud-reason]').textContent === 'Ready to sign in.', 'A configured site asked its users to provide an app key');
        check(q('[data-dropbox-help]').getAttribute('aria-label') === 'About Dropbox sign-in', 'Configured help offered publisher setup');
        q('[data-dropbox-help]').click();
        check(q('dialog').textContent.includes('app folder') && !q('dialog a, dialog code') && !q('dialog').textContent.includes('app key'),
          'Configured account help included developer registration instructions');
        q('dialog button').click();
        cloud.linked = cloud.registrationUnknown = true; cloud.refresh();
        const originalKey = q('[data-edit-client]'), originalHelp = q('[data-dropbox-help]');
        check(!originalKey.hidden && originalKey.textContent === 'Enter original app key' &&
          q('[data-cloud-reason]').textContent.includes('export all four CSVs'), 'An upgraded record hid its recovery options');
        originalHelp.click();
        check(originalHelp.getAttribute('aria-label').includes('original') && q('dialog').textContent.includes('existing csvTV folder') &&
          !q('dialog').textContent.includes('create an app'),'Help sent a returning owner to a new app folder');
        q('dialog button').click();
        check(doc.activeElement === originalHelp,'Recovery help lost keyboard focus');
        originalKey.click();
        const originalField = q('[name=appKey]');
        check(doc.activeElement === originalField,'The original registration field lost focus');
        originalField.dispatchEvent(new win.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
        check(q('form').hidden && doc.activeElement === originalKey && doc.documentElement.scrollWidth <= win.innerWidth,
          'The narrow recovery editor lost Escape, focus or its layout');
      } finally {
        settings?.dispose(); meta.remove(); delete win.navigator.onLine;
        if (previousKey === null) win.localStorage.removeItem(key); else win.localStorage.setItem(key, previousKey);
        reader.close(); store.close(); indexedDB.deleteDatabase(name);
      }
    }));
  await run('Closing the database dismisses a Dropbox modal, keeps late prompts closed and hands keyboard focus to a working Reload', () =>
    inFrame('/screen-fixture',320,async (doc,win)=>{
      const name='closed-cloud-dialog-'+crypto.randomUUID();
      const store=await openDeviceStore({name}); await store.whenWriter();
      const service=new TmdbService(store), dialogs=new DropboxDialogs(doc);
      const auth=new DropboxAuth(store,'',{online:()=>false});
      const cloud=new DropboxController(auth,win,dialogs), app=mountApplication(doc.querySelector('#app'),service,undefined,cloud);
      let reloads=0;
      cloud.reloadInstalledShell=async()=>{reloads++; return 'Checked the installed app.';};
      try {
        await app.ready;
        const answer=dialogs.choose('Sync paused','Review this file.',[{label:'Cancel',value:'cancel'}]);
        check(doc.querySelector('dialog[open]'),'Missing Dropbox modal');
        await store.closeForUpdate();
        const reload=doc.querySelector('.tab-state button');
        check(await answer==='cancel' && !doc.querySelector('dialog[open]') && doc.activeElement===reload,
          'The terminal writer left a modal over Reload');
        check(await dialogs.choose('Late review','An older request finished.',[])==='cancel' && !doc.querySelector('dialog[open]'),
          'A completed request reopened the modal');
        reload.click(); check(reloads===1,'Reload was disabled with the closed database');
      } finally {app.dispose(); cloud.close(); service.close(); store.close(); indexedDB.deleteDatabase(name);}
    }));
  await run('Hand merge discards superseded file reads, refreshes stale download offers and honors Cancel during sync', () =>
    inFrame('/screen-fixture', 320, async doc => {
      const store = await openDeviceStore({ name:'hand-merge-' + crypto.randomUUID() });
      await store.whenWriter();
      const ctx = { service:{ store, environment:{ now:Date.now } }, clearUndo:()=>{} };
      let questions = 0, releaseSync, operation;
      const cloud = { changed:new EventTarget(), signedIn:true, synced:true,
        dialogs:{ identities:async()=>{ questions++; return null; }, choose:async()=>'continue' },
        exclusive:(_name, work)=>operation=work(), failure:error=>error.message,
        syncFiles:async()=>new Promise(resolve=>{ releaseSync=resolve; }),
        backupAccess:()=>{ throw Error('Unexpected backup'); } };
      const root = doc.querySelector('#app'), screen = mountHandMerge(root,ctx,cloud);
      try {
        await screen.ready;
        const picker = root.querySelector('input'), go = root.querySelector('[data-continue]'), cancel = root.querySelector('[data-cancel]');
        const choose = file => { Object.defineProperty(picker,'files',{configurable:true,value:[file]}); return picker.onchange(); };
        const conflict = new File(['show_id,season,episode,times_watched,episode_id\n5,1,1,1,1\n5,2,2,1,1\n'],'old.csv');
        let releaseRead;
        conflict.arrayBuffer=()=>new Promise(resolve=>{ releaseRead=()=>resolve(Blob.prototype.arrayBuffer.call(conflict)); });
        const oldRead=choose(conflict);
        const good = new File(['list,show_id,show\nWatchlist,601,Radio Bloom\n'],'new.csv');
        await choose(good);
        releaseRead(); await oldRead;
        check(!questions && root.querySelector('[data-preview]').textContent.includes('Radio Bloom'),'A stale file opened an identity dialog');

        await store.commit((await store.snapshot()).revision,{ put:{ratings:[{show_id:22,show:'Iris Bay',rating:7}]} });
        go.click(); await operation.catch(()=>{});
        await until(()=>root.querySelector('[data-state]').textContent.includes('refreshed backup'),'Changed record reused obsolete backup links');
        const backup = await fetch(root.querySelector('[download="ratings.csv"]').href);
        check((await backup.text()).includes('Iris Bay') && !(await store.snapshot()).tables.lists.length,'New backup offer or record was incorrect');
        go.click(); await operation;
        check((await store.snapshot()).tables.lists.length===1,'Reviewed local merge did not save');
        await store.commit((await store.snapshot()).revision,{local:{syncAccountId:'fictional',dropboxSession:{
          accountId:'fictional',instanceId:'test-session',signInDeadline:Date.now()+60000,providerExpiresAt:Date.now()+60000}}});
        await choose(new File(['list,show_id,show\nLater,602,Iris Bay\n'],'linked.csv'));
        cloud.signedIn=false; await screen.refresh();
        check(go.disabled && root.textContent.includes('Sign in to the linked Dropbox account'), 'A disconnected preview stayed actionable');
        cloud.signedIn=true; await screen.refresh();
        check(!go.disabled && !root.textContent.includes('Sign in to the linked Dropbox account') &&
          root.querySelector('[data-state]').textContent === 'Review the selected files.', 'A resumed hand merge kept an obsolete sign-in warning');
        const signed = await store.snapshot();
        await store.commit(signed.revision,{local:{dropboxSession:{...(await store.dropboxAuthState()).session, instanceId:'replacement-session'}}});
        await screen.refresh();
        check(go.hidden && root.querySelector('[data-preview]').hidden && root.querySelector('[data-state]').textContent.includes('Choose the files again'),
          'A new sign-in kept the stale approval available');
        await choose(new File(['list,show_id,show\nLater,602,Iris Bay\n'],'linked.csv'));
        go.click(); await until(()=>releaseSync,'Did not reach sync');
        cancel.click(); releaseSync(); await operation;
        check(root.querySelector('[data-state]').textContent==='Merge canceled.' && (await store.snapshot()).tables.lists.length===1,
          'Cancel during sync applied the hand merge');
      } finally { screen.dispose(); store.close(); }
    }));
  await run('A fresh browser requires Dropbox on every route and accepts public registration changes from another tab',()=>
    inFrame('/dist/fresh-test.html#/settings',320,async (doc,win)=>{
      const select=s=>until(()=>doc.querySelector(s),'Missing '+s);
      await select('.dropbox-settings');
      await until(()=>doc.querySelector('[data-cloud-reason]').textContent === 'Add a public app key to connect.', 'Missing public registration guidance');
      check(!doc.querySelector('[data-cloud-sign]').disabled && doc.querySelector('[data-sync]').hidden,'Signed-out controls were incorrect');
      const key = 'csvTV-public-dropbox-app-key';
      try {
        localStorage.setItem(key,'fictional-registration');
        await until(() => !doc.querySelector('[data-sign-in]').hidden && !doc.querySelector('[data-edit-client]').hidden,
          'An open Settings tab missed the registration saved in another tab');
        doc.querySelector('[data-edit-client]').click();
        check(doc.querySelector('[name=appKey]').value === 'fictional-registration', 'Editing used the previous registration');
      } finally { localStorage.removeItem(key); }
      await until(() => doc.querySelector('[data-sign-in]').hidden && doc.querySelector('.dropbox-settings form').hidden &&
        doc.querySelector('[data-edit-client]').textContent === 'Add app key',
        'Removing the registration did not abandon the previous edit and restore app setup');
      for (const route of ['home','library','export','settings','hand-merge','recovery','anilist-import','trakt-import','show/601']) {
        win.location.hash = '#/' + route;
        await new Promise(resolve => win.addEventListener('hashchange',resolve,{once:true}));
        check(doc.querySelector('main h1')?.textContent === 'Connect Dropbox' &&
          doc.querySelector('[data-legacy]').hidden && !doc.querySelector('.import-screen,input[type=file],.library-screen,.show-page') &&
          !doc.querySelector('.app-sidebar').getClientRects().length && !doc.querySelector('[data-file-actions]').getClientRects().length,
          'An unlinked route exposed part of the record: ' + route);
      }
      check(doc.documentElement.scrollWidth <= 320, 'Dropbox setup overflowed the narrow viewport');
    }));
  await run('An upgraded unlinked record can be exported before linking, then Library and ratings reopen offline after the Dropbox deadline', () =>
    inFrame('/screen-fixture', 320, async (doc,win) => {
      const name = 'gate-reopen-' + crypto.randomUUID();
      Object.defineProperty(win.navigator,'onLine',{configurable:true,value:false});
      const root = doc.querySelector('#app'), q = selector => root.querySelector(selector);
      let store, service, cloud, app;
      async function open(checkSetupReads = false) {
        store = await openDeviceStore({name}); await store.whenWriter();
        if (checkSetupReads) store.overviewRows = () => { throw Error('Setup read the full watch record'); };
        service = new TmdbService(store);
        cloud = new DropboxController(new DropboxAuth(store,'fixture',{online:()=>false}),win,new DropboxDialogs(doc));
        app = mountApplication(root, service, undefined, cloud);
        try { await app.ready; }
        finally { if (checkSetupReads) delete store.overviewRows; }
      }
      function close() { app.dispose(); cloud.close(); service.close(); store.close(); }
      const seed = await openDeviceStore({name}); await seed.whenWriter();
      await seed.commit((await seed.snapshot()).revision, {put:{
        watched:[{show_id:601,show:'Signal Garden',season:1,episode:1,episode_id:701,title:'Signal',times_watched:1}],
        ratings:[{show_id:601,show:'Signal Garden',rating:7}],
      }});
      seed.close();
      win.history.replaceState(null,'','#/library');
      await open(true);
      try {
        check(q('h1').textContent === 'Connect Dropbox' && !q('[data-legacy]').hidden,'An upgraded unlinked record opened the tracker or lost recovery');
        q('[data-export]').click();
        await until(()=>root.querySelectorAll('a[download]').length === 4,'No four-file recovery');
        const links = [...root.querySelectorAll('a[download]')];
        check(links.map(a=>a.download).join() === 'watched.csv,ratings.csv,lists.csv,shows.csv' &&
          (await (await fetch(links[0].href)).text()).includes('Signal Garden'), 'The recovery downloads omitted the saved record');
        await store.storeExchangedSession({accountId:'fixture-owner',instanceId:'expired-instance',accessToken:'fixture-access',
          refreshToken:'fixture-refresh',accessExpiresAt:Date.now()-10_000,signInDeadline:Date.now()-1,providerExpiresAt:Date.now()-1});
        await until(()=>q('h1')?.textContent === 'Library' && q('main a[href="#/show/601"]'),'Linking did not open the requested Library bookmark');
        app.go({page:'show',id:601});
        const rating = await until(()=>q('.show-rating:not(:disabled)'),'The linked record could not be rated offline');
        rating.click();
        const slider = q('.rating-slider input');
        slider.value = '8.5'; slider.dispatchEvent(new win.Event('input'));
        q('.rating-commands button:last-child').click();
        await until(async ()=>(await store.snapshot()).tables.ratings[0]?.rating === 8.5,'The offline rating was not saved');
        app.go({page:'settings'});
        await until(()=>q('[data-edit]')?.disabled && q('[data-key-status]')?.textContent.includes('Go online'),
          'Expired sign-in exposed key editing or incorrectly offered to replace an unread key');
        close();
        win.history.replaceState(null,'','#/library');
        await open();
        const show = await until(()=>q('main a[href="#/show/601"]'),'The offline bookmark lost the record after reopening');
        show.click();
        await until(()=>q('.show-rating')?.getAttribute('aria-label') === 'Personal rating 8.5 out of 10','The new rating did not survive reopening');
        check((await store.dropboxState()).accountId === 'fixture-owner' && !cloud.signedIn, 'The offline edit replaced the account or recreated a sign-in');
      } finally { close(); delete win.navigator.onLine; indexedDB.deleteDatabase(name); }
    }));
  await run('Provider access follows the active account, clears open password fields, and permits only complete cached marks after expiry', () =>
    withImportApp(320,'settings',async ({doc,win,q,select,configure,title,fixture,peer}) => {
      await title('Settings'); await configure();
      const previous = (await peer.dropboxAuthState()).session;
      const held = Promise.withResolvers();
      let reading = false;
      fixture.beforeDropbox = async request => {
        if (request.endpoint === 'download' && JSON.parse(request.headers['Dropbox-API-Arg']).path === '/settings.csv') {
          reading = true; await held.promise;
        }
      };
      q('[data-edit]').click();
      const draft = q('#tmdb-input'); draft.value = 'fictional-unsubmitted-token';
      await peer.storeExchangedSession({...previous,instanceId:'second-grant'});
      try {
        await until(()=>reading,'The new grant did not request Dropbox settings');
        await until(()=>!q('dialog[open]') && q('[data-edit]').disabled && q('[data-key-status]').textContent.includes('Dropbox'),
          'A new grant exposed the old credential or kept its editor');
        check(!draft.value && q('[data-key-status]').textContent !== 'No key saved','The detached input or the pending key status retained the previous value');
      } finally { held.resolve(); delete fixture.beforeDropbox; }
      await until(()=>!q('[data-edit]').disabled && q('[data-key-status]').textContent === 'Saved in Dropbox','The replacement session did not load its keys');

      q('[data-mdblist-edit]').click();
      const scoreDraft = q('#mdblist-input'); scoreDraft.value = 'fictional-unsubmitted-score';
      await peer.storeExchangedSession({...previous,instanceId:'other-grant',accountId:'other-viewer'});
      await until(()=>q('[data-mdblist-edit]').disabled && q('[data-mdblist-status]').textContent.includes('linked to this record'),
        'A different Dropbox sign-in could access the linked record’s keys');
      check(!scoreDraft.value && !scoreDraft.isConnected, 'The MDBList draft remained after an account mismatch');
      await peer.storeExchangedSession({...previous,instanceId:'matching-grant'});
      await until(()=>!q('[data-edit]').disabled && !q('dialog[open]'),'The matching account did not recover the key controls');

      fixture.showSeasons = [1,2].map(season_number=>({season_number,name:'Season '+season_number,episode_count:2}));
      win.location.hash = '#/show/701/season/1';
      await until(()=>q('[data-season-focus=episode-1-add]') && fixture.paths.includes('tv/701/season/1'),'Season did not populate before expiry');
      const count = fixture.paths.length;
      fixture.online = false; win.dispatchEvent(new win.Event('offline'));
      await peer.storeExchangedSession({...previous,instanceId:'ended',signInDeadline:Date.now()-1,providerExpiresAt:Date.now()-1});
      await until(()=>q('.season-status')?.textContent.includes('Dropbox'),'Season did not observe the expired sign-in');
      q('[data-season-focus=episode-1-add]').click();
      await until(async ()=>(await peer.snapshot()).tables.watched.length === 1,'A cached episode could not be marked after expiry');
      (await select('.season-mark')).click();
      await until(async ()=>(await peer.snapshot()).tables.watched.length === 2,'A fully cached season could not be marked after expiry');
      win.location.hash = '#/show/701';
      await until(()=>q('.show-hero h1')?.textContent === 'Signal Garden','Cached Show was unavailable');
      check(!q('[data-focus=mark]') && fixture.paths.length === count,'The show offered an incomplete bulk mark or requested provider data after expiry');
    }));
  await run('A queued cached episode mark rechecks its record owner and accepted provider generation before committing', async () => {
    const target = {show_id:601,show:'Signal Garden',season:1,episode:1,episode_id:701,title:'First signal'};
    for (const change of ['record owner','accepted key']) {
      const name = 'cached-mark-fence-' + crypto.randomUUID(), store = await openDeviceStore({name});
      const service = new TmdbService(store), watch = new WatchActions(service,()=>false,()=>{},()=>{});
      try {
        await connectFixtureProviders(store,name,[{setting:'tmdb_key',value:'fictional-cached-mark-key'}]);
        const {session} = await store.dropboxState();
        const key = await service.keyStatus();
        await store.writeTmdb(key.generation,{entries:{'tv/601/season/1':{fetchedAt:Date.now(),value:{
          season:1,name:'Season 1',episodes:[{episode:1,episode_id:701,title:'First signal',airDate:'2020-01-01'}]}}}});
        store.clearProviderKeys();
        const commit = store.commit.bind(store);
        let intervened = false;
        store.commit = async (revision,patch,options) => {
          if (!intervened && options?.cachedMarkAccount) {
            intervened = true;
            if (change === 'record owner') await commit(revision,{local:{syncAccountId:'another-record'}});
            else await store.loadProviderKeys(session,[],()=>true);
          }
          return commit(revision,patch,options);
        };
        const outcome = await watch.episode(target,'mark').then(()=>'saved',error=>error.kind);
        check(intervened && outcome === 'superseded' && !(await store.snapshot()).tables.watched.length,
          'A delayed offline mark crossed a change to the ' + change);
      } finally { service.close(); store.close(); indexedDB.deleteDatabase(name); }
    }
  });
  await run('A linked device opens recovery, reviews a hand merge and cancels safely at 320px',()=>
    withImportApp(320,'settings',async ({doc,win,select})=>{
      const restore = await select('[href="#/recovery"]');
      await until(()=>doc.querySelector('[data-cloud-reason]') && !doc.querySelector('[data-sync]').disabled,'The linked device was not ready');
      restore.click();
      await until(()=>doc.querySelector('.recovery-screen h1')?.textContent==='Backups and restore','Recovery route did not mount');
      check(doc.querySelector('[data-local]').hidden,'The linked restore route exposed local replacement');
      win.history.back(); (await select('[href="#/hand-merge"]')).click();
      const picker=await select('input[type=file]');
      // The native file control's preferred width varies with platform font metrics.
      picker.style.font = '18px monospace';
      const data=new DataTransfer();
      data.items.add(new File(['list,show_id,show\r\nWatchlist,601,Radio Bloom\r\n'],'fictional.csv',{type:'text/csv'}));
      picker.files=data.files; picker.dispatchEvent(new Event('change'));
      await until(()=>doc.querySelector('[data-preview]').textContent.includes('Radio Bloom'),'Missing material preview');
      const pickerBounds=picker.getBoundingClientRect(), panelBounds=picker.closest('section').getBoundingClientRect();
      check(pickerBounds.left>=panelBounds.left && pickerBounds.right<=panelBounds.right && pickerBounds.height>=44 &&
        doc.documentElement.scrollWidth===doc.documentElement.clientWidth,'Narrow preview overflowed or lost its file picker touch target');
      doc.querySelector('[data-cancel]').click();
      check(doc.querySelector('[data-preview]').hidden&&doc.querySelector('[data-continue]').hidden&&doc.activeElement===picker,
        'Cancel retained the old preview or lost file picker focus');
      const conflicting = new DataTransfer();
      conflicting.items.add(new File(['show_id,season,episode,times_watched,episode_id\n5,1,1,1,1\n5,2,2,1,1\n'],'selected.csv'));
      picker.files=conflicting.files; picker.dispatchEvent(new Event('change'));
      const identity = await select('dialog[open] fieldset legend');
      check(identity.textContent.startsWith('Selected file'), 'A local-file episode was labeled as Dropbox');
      win.history.back();
      await until(()=>doc.querySelector('[href="#/hand-merge"]') && !doc.querySelector('dialog[open]'),
        'Browser Back left the previous file’s identity question over Settings');
    }));
  await run('Guard, double-mark and held status dialogs retain focus, keep each per-episode answer and restore keyboard focus',()=>
    inFrame('/screen-fixture',320,async (doc,win)=>{
      const open=doc.createElement('button');open.textContent='Open';doc.body.append(open);open.focus();
      const dialogs=new DropboxDialogs(doc);
      const report=readCsv('settings','setting,value,new_field\r\ntmdb_key,fictional-secret,a\r\ntmdb_key,second-secret,b\r\n');
      const guard=dialogs.guard({table:'settings',decision:{case:1,reason:'unsupported',choices:['reload','cancel']},
        findings:report.findings,different:null,unsynced:1});
      const modal=doc.querySelector('dialog[open]'); check(modal&&doc.activeElement===modal.querySelector('h2'),'Missing modal initial focus');
      check(modal.textContent.includes('Line 1 · Unknown column · new_field')&&
        modal.textContent.includes('Line 3 · Duplicate row · tmdb_key'),'Guard hid the offending column or setting name');
      check(!modal.textContent.includes('secret'),'Guard exposed a saved setting value');
      check(!modal.textContent.includes('Restore Dropbox'),'A newer schema allowed overwrite');
      const key=(shift)=>modal.dispatchEvent(new win.KeyboardEvent('keydown',{key:'Tab',shiftKey:shift,bubbles:true,cancelable:true}));
      key(true); check(doc.activeElement.textContent==='Cancel','Missing reverse tab trap');
      key(false); check(doc.activeElement.textContent==='Reload','Missing forward tab trap');
      modal.querySelector('button:last-child').click(); check(await guard==='cancel'&&doc.activeElement===open,'Cancel lost focus');
      const historical=dialogs.guard({table:'watched',decision:{case:3,reason:'damaged-base',
        choices:['combine','take-remote','cancel']},findings:[],different:1,unsynced:null});
      const recovered=doc.querySelector('dialog[open]');
      check(recovered.textContent.includes('last-synced copy on this device')&&recovered.textContent.includes('higher watch count')&&
        recovered.textContent.includes('unknown number of unsynced changes'),'Historical base warning misidentified the damaged copy or the cost');
      recovered.dispatchEvent(new win.KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true,cancelable:true}));
      check(doc.activeElement.textContent==='Cancel','Historical base recovery lost its keyboard exit');
      doc.activeElement.click(); check(await historical==='cancel'&&doc.activeElement===open,'Historical recovery lost focus on cancel');
      const ambiguous=dialogs.guard({table:'watched',decision:{case:3,reason:'damaged-base',choices:['combine','cancel']},
        findings:[],different:null,unsynced:null,ambiguousRemoteEpisodes:true});
      const identityWarning=doc.querySelector('dialog[open]');
      check(identityWarning.textContent.includes('one episode ID to multiple positions')&&
        ![...identityWarning.querySelectorAll('button')].some(button=>button.textContent==='Take Dropbox as it is'),
        'An ambiguous watched file offered an exact replacement');
      identityWarning.querySelector('button:last-child').click(); await ambiguous;
      for (const [table, expected] of Object.entries({watched:'higher watch count',ratings:'this device’s rating',
          lists:'list memberships from both copies',settings:'this device’s setting'})) {
        const pending=dialogs.guard({table,decision:{case:3,reason:'unknown-outcome',choices:['combine','cancel']},findings:[]});
        const warning=doc.querySelector('dialog[open]');
        check(warning.textContent.includes(expected)&&warning.textContent.includes('Rows removed'),'Wrong combine disclosure for '+table);
        warning.querySelector('button:last-child').click(); await pending;
      }
      const question=dialogs.doubleMarks({episodes:[1,2].map(n=>({show_id:61,season:1,episode:n,before:1,mine:2,theirs:3,key:String(n)}))});
      doc.querySelector('fieldset input:nth-of-type(1)').click();
      const buttons=[...doc.querySelectorAll('dialog button')];buttons.find(b=>b.textContent==='Two changes').click();
      const answer=await question;check(answer.choice==='two'&&answer.overrides.get('1')==='one','Per-episode override was lost');
      const delivery={delivery:true,episodes:[1,2].flatMap(season=>[1,2].map(episode=>({
        show_id:61,show:'Fictional Forest',season,episode,before:1,mine:2,theirs:2,key:season+'/'+episode,
        deliveryTotals:{one:'2',two:episode===2 && season===2?'4':'3'},
      })))};
      const openDelivery=()=>dialogs.doubleMarks(delivery);
      const canceled=openDelivery();
      const dialog=doc.querySelector('dialog[open]');
      const seasonSelect=dialog.querySelector('select');
      seasonSelect.value='two'; seasonSelect.dispatchEvent(new Event('change'));
      dialog.querySelector('button').click(); check(await canceled===null,'Cancel retained a season choice');
      const grouped=openDelivery();
      const reopened=doc.querySelector('dialog[open]');
      const summaries=[...reopened.querySelectorAll('summary')],selectors=[...reopened.querySelectorAll('select')];
      check(summaries.length===2&&summaries[0].textContent.includes('2 or 3 plays per episode')&&
        !summaries[1].textContent.includes('plays per episode'),'Collapsed season totals were misleading');
      check(selectors.every(select=>select.value==='')&&!reopened.querySelector('fieldset'),'Reopened review retained old choices');
      selectors[0].value='two'; selectors[0].dispatchEvent(new Event('change'));
      selectors[1].value='one'; selectors[1].dispatchEvent(new Event('change'));
      summaries[0].click();
      await new Promise(resolve=>doc.defaultView.setTimeout(resolve,20));
      const radios=reopened.querySelectorAll('fieldset')[0].querySelectorAll('input');
      radios[1].click();
      [...reopened.querySelectorAll('button')].find(button=>button.textContent==='Two changes').click();
      const selected=await grouped;
      check(selected.choice==='two'&&selected.overrides.get('1/1')==='one'&&selected.overrides.get('1/2')==='two'&&
        selected.overrides.get('2/1')==='one'&&selected.overrides.get('2/2')==='one','Season or episode choice was lost');
      const longReview=dialogs.doubleMarks({delivery:true,firstCopy:true,episodes:Array.from({length:1000},(_,i)=>({
        show_id:61,show:'Fictional Forest',season:3,episode:i+1,before:8,mine:7,theirs:8,key:'3/'+(i+1),
        deliveryTotals:{one:'7',two:'8'},
      }))});
      const large=doc.querySelector('dialog[open]'),details=large.querySelector('details');
      const toggle=()=>new Promise(done=>{
        details.addEventListener('toggle',done,{once:true});details.open=!details.open;
      });
      await toggle();
      check(large.querySelectorAll('fieldset').length===50,'Opening a season rendered every affected episode');
      const more=details.querySelector('button');more.focus();more.click();
      check(large.querySelectorAll('fieldset').length===100&&details.querySelector('fieldset:nth-last-of-type(50)').contains(doc.activeElement),
        'Show more lost the new episode controls or keyboard focus');
      const exception=large.querySelectorAll('fieldset')[75].querySelectorAll('input')[1];exception.click();
      await toggle();await toggle();
      check(exception.checked&&large.querySelectorAll('fieldset').length===100,'Collapsing discarded later episode choices');
      const select=large.querySelector('select');select.value='two';select.dispatchEvent(new Event('change'));
      [...large.querySelectorAll('.actions button')].find(b=>b.textContent==='Shared copy').click();
      const longAnswer=await longReview;
      check(longAnswer.choice==='one'&&longAnswer.overrides.get('3/76')==='one'&&longAnswer.overrides.get('3/1000')==='two',
        'Season default missed an unrendered episode or overwrote an exception');
      const many=dialogs.doubleMarks({delivery:true,episodes:Array.from({length:121},(_,i)=>({
        show_id:61,show:'Fictional Forest',season:i+1,episode:1,key:'s'+(i+1),deliveryTotals:{one:'2',two:'3'},
      }))});
      const seasonDialog=doc.querySelector('dialog:modal'),moreSeasons=[...seasonDialog.querySelectorAll('button')]
        .find(b=>b.textContent==='Show more seasons');
      check(seasonDialog.querySelectorAll('summary').length===50 && moreSeasons,'All season controls were mounted at once');
      moreSeasons.focus();moreSeasons.click();
      check(doc.activeElement===seasonDialog.querySelectorAll('summary')[50],'Paging lost keyboard focus on the next season');
      const later=seasonDialog.querySelectorAll('select')[74];later.value='two';later.dispatchEvent(new Event('change'));
      [...seasonDialog.querySelectorAll('.actions button')].find(b=>b.textContent==='One change').click();
      const laterSeasonAnswer=await many;
      check(laterSeasonAnswer.choice==='one'&&laterSeasonAnswer.overrides.size===1&&laterSeasonAnswer.overrides.get('s75')==='two',
        'A later season could not override the global choice or changed an undisplayed season');
      dialogs.hold('watched'); const held=doc.querySelector('dialog');
      check(held.open&&!held.querySelector('button')&&doc.activeElement.getAttribute('role')==='status','Saving hold had focusable actions');
      held.dispatchEvent(new Event('cancel',{cancelable:true}));check(held.open,'Escape dismissed the hold');
      dialogs.hold(null);check(doc.activeElement===open,'Focus lost after hold');
    }));
  await run('Episode identity mapping previews the counts from all sources before confirming renamed places',()=>
    inFrame('/screen-fixture',1000,async doc=>{
      const row=(episode,id,play)=>({show_id:10,season:1,episode,episode_id:id,show:'Watch Signal',title:'Start',times_watched:play});
      const base=[row(1,92,1)],mine=[row(2,92,2)],theirs=[row(3,92,3)];
      for(let i=4;i<104;i++) { base.push(row(i,i+1000,1));mine.push(row(i,i+1000,1));theirs.push(row(i,i+1000,1)); }
      const versions={recordVersion:3n,baseRevision:'old',remoteRevision:'new'};
      const review=mergeWatched(base,mine,theirs,{versions}); check(review.status==='identity-review','Missing identity fixture');
      const dialogs=new DropboxDialogs(doc);const result=dialogs.identities(review);
      check(doc.querySelectorAll('fieldset').length===3,'The owner was asked to map unrelated episodes');
      for (const box of doc.querySelectorAll('fieldset')) box.querySelectorAll('input')[2].value='2';
      [...doc.querySelectorAll('button')].find(b=>b.textContent==='Review mapping').click();
      await until(()=>doc.querySelector('dialog')?.textContent.includes('Before 1, here 2, Dropbox 3'),'Mapping omitted counts');
      [...doc.querySelectorAll('button')].find(b=>b.textContent==='Use mapping').click();
      const assignments=await result;
      const out=mergeWatched(base,mine,theirs,{versions,hold:true,resolution:{token:review.token,assignments}});
      check(out.status==='merged'&&out.rows.length===101&&out.rows.some(r=>r.episode===2&&r.times_watched===4),'Mapping did not work with the sync engine');
      const longRows=offset=>Array.from({length:80},(_,i)=>({...row(1+i%10,i+1,1),season:1+Math.floor(i/10)+offset}));
      const long=mergeWatched(longRows(0),longRows(20),longRows(40),{versions});
      check(long.status==='identity-review','Expected the multiple season order conflict');
      const chosen=dialogs.identities(long,'Selected file');
      const current=()=>doc.querySelector('dialog[open]');
      const button=text=>[...current().querySelectorAll('button')].find(b=>b.textContent===text);
      const repaired=new Set();
      const fixVisible=()=>{
        for(const box of current().querySelectorAll('fieldset')){
          if(repaired.has(box))continue;
          const inputs=box.querySelectorAll('input'),id=Number(inputs[3].value);
          inputs[1].value=String(1+Math.floor((id-1)/10));repaired.add(box);
        }
      };
      check(current().querySelectorAll('fieldset').length===50,'All conflict inputs were constructed before opening');
      fixVisible();button('Review mapping').click();
      await until(()=>current()?.querySelector('p')?.textContent.includes('needs one destination'));
      check(repaired.values().next().value.isConnected,'The first repair values were discarded during validation');
      while(button('Show more rows')) {button('Show more rows').click();fixVisible();}
      check(repaired.size===240,'Later pages omitted a conflicting row');
      button('Review mapping').click();
      await until(()=>current()?.querySelector('h2')?.textContent==='Confirm episode mapping');
      check(!!button('Show more matched episodes')&&!current().textContent.includes('S8 E10'),'Preview was not bounded to its first results');
      button('Show more matched episodes').click();
      check(current().textContent.includes('S8 E10'),'Preview omitted the final repaired episode');
      button('Edit mapping').click();
      await until(()=>current()?.querySelector('h2')?.textContent==='Match episode identities');
      check([...repaired].every(box=>box.isConnected),'Returning from preview lost the repaired inputs');
      button('Review mapping').click();
      await until(()=>current()?.querySelector('h2')?.textContent==='Confirm episode mapping');
      button('Use mapping').click();
      const all=await chosen;
      const merged=mergeWatched(longRows(0),longRows(20),longRows(40),{versions,hold:true,resolution:{token:long.token,assignments:all}});
      check(merged.status==='merged'&&merged.rows.length===80&&merged.rows.every(r=>r.season===1+Math.floor((r.episode_id-1)/10)),
        'Paged repair changed the committed episode identities');
    }));
}
