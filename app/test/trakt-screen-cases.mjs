import { check, checkPreImportBackup, until, withImportApp } from './import-app-fixture-cases.mjs';
import { traktZip } from './trakt-fixture-cases.mjs';
import { mountImport } from '../dist/import-screen.js';

const show = {title:'Signal Garden', ids:{trakt:51, tmdb:701, imdb:'tt0000701'}};
const history = id => ({type:'episode',show,episode:{season:1,number:id-710,title:'Entry '+id, ids:{trakt:id+80,tmdb:id}}});
function archive() {
  return traktZip({
    'watched-history-1.json':[history(711), history(713)],
    'watched-shows.json':[{show,plays:4}],
    'ratings-shows.json':[{show,rating:8}],
    'lists-favorites.json':[{type:'show',show}],
    'lists-watchlist.json':[{type:'episode',show}, {type:'episode'}],
  });
}

export async function traktScreenCases(run) {
  await run('Import waits for access, retries failed checks, and rechecks the account when a file is chosen', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    let key = Promise.withResolvers();
    const linked = {accountId:'fixture-account',session:{accountId:'fixture-account',instanceId:'test',signInDeadline:900}};
    let link = linked;
    const matchedFiles = [];
    const store = {role:'reader',providerKeysAvailable:true,dropboxState:async () => link};
    const service = {store, keyStatus:() => key.promise, environment:{online:() => true}};
    const cloud = {changed:new EventTarget(), busy:false, now:() => 500, failure:error => error.message};
    const screen = mountImport(host, {service}, cloud, {
      name:'Trakt', format:'ZIP', accept:'.zip', instructions:'Choose a fictional file.',
      match:async file => { matchedFiles.push(file.name); throw Error('Fictional parser stopped.'); },
    });
    try {
      const picker = host.querySelector('input'), message = host.querySelector('[data-block]');
      const settings = host.querySelector('[data-settings]'), retry = host.querySelector('[data-retry-access]');
      const ready = {status:'ready', generation:0n};
      function choose(name = 'test.zip') {
        const selection = new DataTransfer();
        selection.items.add(new File(['fictional'], name));
        picker.files = selection.files;
        picker.dispatchEvent(new Event('change'));
      }
      check(picker.disabled && !picker.getClientRects().length, 'The native picker was available before the first check');
      choose();
      key.resolve({status:'missing-key',generation:0n});
      await screen.ready;
      check(picker.disabled && settings.hidden && message.textContent.includes('Another csvTV tab') && !matchedFiles.length,
        'The reader offered a key editor or admitted its file');
      store.readOnlyReason = 'This browser cannot lock the record for editing.';
      await screen.refresh();
      check(picker.disabled && settings.hidden && message.textContent === store.readOnlyReason,
        'Import attributed a browser lock restriction to another tab');
      delete store.readOnlyReason;
      store.role = 'writer';
      key = Promise.withResolvers();
      const checkKey = screen.refresh();
      key.reject(Error('Device read interrupted'));
      await checkKey;
      check(!retry.hidden && picker.disabled && settings.hidden, 'Failed prerequisites did not offer a retry');
      key = Promise.withResolvers(); retry.click();
      key.resolve({status:'refused',generation:1n});
      await until(() => !settings.hidden && settings.textContent.includes('Change TMDB key'),
        'Retry ignored the refused credential');
      key = Promise.withResolvers(); key.resolve(ready);
      await screen.refresh();
      check(!picker.disabled && picker.getClientRects().length && settings.hidden, 'Ready local writer could not choose a file');
      key = Promise.withResolvers();
      const recheck = screen.refresh();
      check(!picker.disabled && picker.getClientRects().length,'A background check interrupted the ready file chooser');
      // The native chooser stays available, but a changed sign-in still blocks reading its file.
      link = {accountId:'fixture-account', session:{accountId:'fixture-account',instanceId:'test',signInDeadline:499}};
      choose();
      check(!matchedFiles.length,'The file was parsed while its access check was pending');
      key.resolve(ready);
      await recheck;
      await until(() => settings.textContent === 'Open Dropbox settings', 'Changed account access was not rechecked');
      check(picker.disabled && !picker.value && !matchedFiles.length, 'A stale selection reached the archive parser');
      link = {accountId:null,session:null}; await screen.refresh();
      check(picker.disabled && settings.textContent === 'Open Dropbox settings','A never-linked writer could select an import');
      link = linked; await screen.refresh();
      key = Promise.withResolvers();
      choose('earlier.zip'); choose('later.zip');
      key.resolve(ready);
      await until(() => host.querySelector('[data-status]').textContent === 'Fictional parser stopped.',
        'The latest eligible file never reached the parser');
      check(matchedFiles.join() === 'later.zip','An earlier deferred selection displaced the newer one');
    } finally { screen.dispose(); host.remove(); }
  });

  await run('An export selected or matched across a Dropbox sign-in change must be chosen again', async () => {
    const host = document.createElement('div'); document.body.append(host);
    const grant = (accountId,instanceId) => ({accountId,session:{accountId,instanceId,signInDeadline:900}});
    let link = grant('owner-a','first'), pending = Promise.withResolvers(), started = 0, renders = 0;
    let prepare, seasonRead, seasonRequested;
    const store = {role:'writer',providerKeysAvailable:true,dropboxState:async () => link,importPreviewSnapshot:async () => link};
    const service = {store,keyStatus:async () => ({status:'ready',generation:1n}),environment:{online:() => true}};
    const cloud = {changed:new EventTarget(),busy:false,now:()=>500,failure:error=>error.message};
    const screen = mountImport(host,{service},cloud,{
      name:'Trakt',format:'ZIP',accept:'.zip',instructions:'Choose the fictional export.',
      async match() { started++; return pending.promise; },
      plan:(_,record) => ({accountId:record.accountId,instanceId:record.session.instanceId,
        watched:[{}],ratings:[],lists:[],changes:{}}),
      render:(_host,_plan,_changeCounts,prepareSeason) => { renders++; prepare = prepareSeason; },
      prepareSeason:() => { seasonRequested.resolve(); return seasonRead.promise; },
    });
    try {
      await screen.ready;
      const input = host.querySelector('input'), status = host.querySelector('[data-status]');
      function choose() {
        const data = new DataTransfer(); data.items.add(new File(['sample'],'fictional.zip'));
        input.files = data.files; input.dispatchEvent(new Event('change'));
      }
      // Suppress the operating system picker, but let its normal click handler record the initial sign-in.
      input.addEventListener('click',event=>event.preventDefault());
      input.click();
      link = grant('owner-b','second');
      await screen.refresh(); choose();
      await until(()=>status.textContent.includes('sign-in changed'),'Another active account accepted the first account’s selected file');
      check(!started && !input.value && !input.disabled,'The rejected file reached matching or disabled a new selection');
      choose(); await until(()=>started===1,'Matching did not start for the new owner');
      link = grant('owner-b','third');
      pending.resolve({generation:1n,shows:[]});
      await until(()=>!host.querySelector('[data-select]').hidden,'A replaced sign-in still produced a preview');
      check(!renders && status.textContent.includes('sign-in changed') && host.querySelector('[data-apply]').hidden,
        'The matching result could be approved under a replacement sign-in');
      await until(()=>!input.disabled,'The current owner could not select a file again');
      pending = Promise.withResolvers();
      choose(); await until(()=>started===2,'The current owner could not retry matching');
      pending.resolve({generation:1n,shows:[]});
      await until(()=>renders===1 && !host.querySelector('[data-apply]').disabled,'A newly selected file did not reach preview');
      for (const action of ['change grant','cancel']) {
        seasonRead = Promise.withResolvers(); seasonRequested = Promise.withResolvers();
        const prepared = prepare(7,3);
        await seasonRequested.promise;
        check(host.querySelector('[data-apply]').disabled,'An unresolved season choice allowed confirmation');
        if (action === 'change grant') link = grant('owner-b','fourth');
        else host.querySelector('[data-cancel]').click();
        seasonRead.resolve();
        check(!await prepared,'A stale season reply reached the active preview after '+action);
        await until(()=>!input.disabled && host.querySelector('[data-apply]').hidden,'Old preview survived '+action);
        check(status.textContent.includes(action === 'change grant' ? 'sign-in changed' : 'Import canceled'),
          'Stale season response replaced the status after '+action);
        if (action === 'change grant') {
          choose();
          await until(()=>renders===2 && !host.querySelector('[data-apply]').disabled,'A new file could not be reviewed after an interrupted lookup');
        }
      }
    } finally { screen.dispose(); host.remove(); }
  });

  await run('The shipped Home and Settings open Trakt import, explain its prerequisites and reject an unreadable ZIP at 320px', () =>
    withImportApp(320,'home',async ({doc,q,select,fixture,peer,configure,choose,title}) => {
      const launch = await select('[data-setup] a[href="#/trakt-import"]');
      launch.click(); await title('Import from Trakt');
      q('.phone-back').click(); await title('Home');
      (await select('[data-setup] a[href="#/trakt-import"]')).click(); await title('Import from Trakt');
      await until(() => q('[data-block]').textContent.includes('Add a TMDB key'),'Missing key explanation');
      check(q('input[type=file]').disabled && !q('input[type=file]').getClientRects().length && !fixture.paths.length, 'Keyless import was available');
      check(q('[data-settings]').textContent === 'Add a TMDB key in Settings' &&
        Boolean(q('[data-settings]').compareDocumentPosition(q('input[type=file]')) & Node.DOCUMENT_POSITION_FOLLOWING),
        'The key action should appear before the file chooser');
      q('[data-settings]').click(); await title('Settings');
      await until(()=>q('#tmdb-key-label') && doc.activeElement === q('#tmdb-key-label'), 'Key action did not reach the TMDB row');
      await configure();
      (await select('a[href="#/trakt-import"]')).click(); await title('Import from Trakt');
      fixture.online=false; doc.defaultView.dispatchEvent(new Event('offline'));
      await until(() => q('input[type=file]').disabled && q('[data-block]').textContent.includes('internet'), 'Offline import was available');
      fixture.online=true; doc.defaultView.dispatchEvent(new Event('online'));
      await choose(new File(['plain text'], 'fictional.zip'));
      await until(() => q('[data-status]').textContent.includes('Could not read'), 'Invalid ZIP was not reported');
      check(!(await peer.snapshot()).tables.watched.length && !q('.import-totals') && doc.documentElement.scrollWidth <= 320, 'Failed import changed the record or overflowed');
      const before = fixture.paths.length;
      const padding = new Blob([new Uint8Array(1024 * 1024)]);
      await choose(new File([...Array(32).fill(padding),' '],'oversize.zip'));
      await until(() => q('[data-status]').textContent.includes('32 MiB import limit'), 'Trakt size limit was not reported');
      check(fixture.paths.length === before && !q('.import-totals') && !(await peer.snapshot()).tables.watched.length,
        'Oversized Trakt selection started matching or changed the record');
      await choose(await traktZip({'ratings-shows.json':[{show,rating:8}]}));
      await select('.import-totals');
    }));

  await run('A Trakt preview identifies a missing history page and a later complete ZIP fills only its missing watches', () =>
    withImportApp(390,'settings',async ({q,select,peer,configure,choose,preview,title}) => {
      await title('Settings'); await configure(); (await select('a[href="#/trakt-import"]')).click();
      const pages = {'watched-history-3.json':[{...history(711),id:3}],'watched-history-1.json':[{...history(711),id:1}]};
      async function importPages() {
        q('[data-apply]').click();
        await until(()=>q('[data-status]').textContent.includes('Import complete'),'Trakt did not finish importing the available pages');
        return (await peer.snapshot()).tables.watched.map(row=>[row.episode_id,row.times_watched]);
      }
      await choose(await traktZip(pages)); await preview();
      await until(()=>q('[data-import-report="Skipped"]')?.textContent.includes('History page 2 is missing'),
        'The natural Trakt preview did not identify the missing page');
      check(JSON.stringify(await importPages())==='[[711,2]]','The incomplete ZIP invented an episode or lost a documented play');
      await choose(await traktZip({...pages,'watched-history-2.json':[{...history(712),id:2}]})); await preview();
      check(!q('[data-import-report="Skipped"]'),'A complete set retained the missing-page warning');
      check(JSON.stringify(await importPages())==='[[711,2],[712,1]]','The complete ZIP did not fill the gap while preserving earlier plays');
    }));

  await run('A Trakt show with only a reported total can add its first importable season and undo to an empty preview', () =>
    withImportApp(390,'settings',async ({q,select,fixture,peer,configure,choose,title}) => {
      await title('Settings'); await configure(); (await select('a[href="#/trakt-import"]')).click();
      await choose(await traktZip({'watched-history-1.json':[], 'watched-shows.json':[{show,plays:1}]}));
      const toggle = await select('[data-count-summary]'), apply = q('[data-apply]');
      check(apply.hidden && q('[data-status]').textContent === 'No entries selected for import.', 'The initial zero-row preview offered a write');
      toggle.click();
      check(q('[data-season-count="1"]').textContent === '0×' && !fixture.paths.includes('tv/701/season/1'), 'Showing the season added a watch or fetched detail');
      q('[data-season-add="1"]').click();
      await until(() => !apply.hidden && !apply.disabled && q('[data-import-report="Episode placements"] summary')?.textContent.includes('(2)'),
        'Selecting two aired episodes did not enable import or reveal the placement report');
      check(q('[data-whole-add]').disabled && toggle.textContent.includes('1 play above'), 'A manual watch changed the whole-show scope or the wrong play total');
      q('[data-season-remove="1"]').click();
      check(apply.hidden && !q('[data-import-report="Episode placements"]') && q('[data-season-count="1"]').textContent === '0×',
        'Undoing the only manual watch left a stale proposal');
      check(!(await peer.snapshot()).tables.watched.length, 'A preview edit changed the saved record');
    }));

  await run('A deflated Trakt ZIP previews before writing, adjusts a season with focus, backs up the linked record and imports once', () =>
    withImportApp(320,'settings',async ({doc,win,q,select,fixture,peer,configure,choose,preview,title}) => {
      await title('Settings'); await configure(); (await select('a[href="#/trakt-import"]')).click();
      const zip = await archive(); await choose(zip); await preview();
      check(fixture.paths.includes('tv/701/season/1') && (await peer.snapshot()).tables.watched.length === 0, 'Matching did not precede the preview');
      check([...doc.querySelectorAll('.import-totals dd')].map(n=>n.textContent).join() === '1,1,1,1', 'Wrong totals for placed/skipped episodes');
      await until(() => q('[data-preview]').textContent.includes('Watchlist item 2'), 'Skipped watchlist item hidden');
      q('[data-count-summary]').click();
      for (const [action, expected, focused] of [['add','2×','add'],['remove','1×','add'],['add','2×','add']]) {
        const button = q('[data-season-' + action + ']');
        button.focus(); button.click();
        check(q('[data-season-count]').textContent === expected && doc.activeElement === q('[data-season-' + focused + ']'),
          'Season adjustment lost its value or keyboard focus');
      }
      const previousCount = [...fixture.files.keys()].filter(path => path.endsWith('/completion.json')).length;
      let saving = false;
      const status = q('[data-status]'), previewPanel = q('[data-preview]');
      const progress = new win.MutationObserver(() => {
        if (status.textContent === 'Saving your import on this device…' && previewPanel.inert) saving = true;
      });
      progress.observe(status,{childList:true,subtree:true});
      try {
        q('[data-apply]').click();
        check(previewPanel.inert,'The approved preview can still be edited during the save');
        await until(() => status.textContent.includes('Import complete'), 'Linked import did not complete');
        check(saving && !previewPanel.inert,'The local save phase or the unlocked next review was missing');
      } finally { progress.disconnect(); }
      checkPreImportBackup(fixture.files, previousCount);
      const after = (await peer.snapshot()).tables;
      check(after.watched.length === 2 && after.watched[0].times_watched === 2 && after.watched[1].times_watched === 1 && after.ratings[0].rating === 8 &&
        after.lists.length === 1 && after.lists[0].list === 'Favorites' && after.shows[0].imdb_id === 'tt0000701', 'Incorrect saved import');
      await choose(zip); await preview();
      q('[data-apply]').click();
      await until(() => q('[data-status]').textContent.includes('Import complete'),'Repeat import did not finish');
      check(JSON.stringify((await peer.snapshot()).tables) === JSON.stringify(after), 'Importing twice changed the record');
      check(doc.documentElement.scrollWidth <= 320, 'Phone layout overflowed');
    }));

  await run('Canceling during TMDB matching or after reviewing the Trakt import leaves the desktop record intact', () =>
    withImportApp(1366,'settings',async ({doc,q,select,fixture,peer,configure,choose,preview,title}) => {
      await title('Settings'); await configure(); (await select('a[href="#/trakt-import"]')).click();
      let release;
      fixture.intercept = path => path === 'tv/701' ? new Promise(r => {release=r;}) : undefined;
      const zip = await archive(); await choose(zip);
      await until(() => release,'Fictional TMDB request was not held');
      q('[data-cancel]').click(); release(); fixture.intercept = undefined;
      await until(() => q('[data-status]').textContent === 'Import canceled.' && doc.activeElement === q('input[type=file]'),
        'Cancel lost status or focus');
      await choose(zip); await preview();
      q('[data-cancel]').click();
      await until(() => q('[data-status]').textContent === 'Import canceled.', 'Canceling the backup did not discard the import');
      check(!q('.import-totals') && !(await peer.snapshot()).tables.shows.length && doc.documentElement.scrollWidth <= 1366, 'Canceled desktop import left partial data');
    }));

  await run('A phone can raise matched season counts beyond Trakt’s total, undo them and repeat the import without adding them again', () =>
    withImportApp(320,'settings',async ({doc,q,select,fixture,peer,configure,choose,preview,title}) => {
      await title('Settings'); await configure(); (await select('a[href="#/trakt-import"]')).click();
      fixture.showSeasons = [1,2].map(n => ({season_number:n,name:'Season ' + n,episode_count:2}));
      const relay = {type:'episode',show,episode:{season:2,number:1,title:'Relay',ids:{trakt:801,tmdb:721}}};
      const zip = await traktZip({
        'watched-history-1.json':[history(711),history(711),history(712),relay,relay],
        'watched-shows.json':[{show,plays:10}],
      });
      const review = () => q('[data-count-review]'), add = n => q('[data-season-add="' + n + '"]');
      const remove = n => q('[data-season-remove="' + n + '"]');
      const count = n => q('[data-season-count="' + n + '"]').textContent;
      const summary = () => review().querySelector('[data-count-summary]');
      const expanded = () => summary().getAttribute('aria-expanded') === 'true';
      async function open() {
        await choose(zip); await preview();
        const heading = [...doc.querySelectorAll('h2')].find(el => el.textContent === 'Check these counts');
        check(heading?.nextElementSibling === review(), 'The first flagged show should follow the heading directly');
        check(!expanded() && summary().textContent.includes('Signal Garden') && summary().textContent.includes('5 of 10 plays unassigned'),
          'The collapsed show hid its remaining plays or started expanded');
        summary().click();
        check(count(1) === '1×' && count(2) === '2×' && remove(1).disabled && !remove(2).disabled,
          'The season counts did not start at the individual episodes’ documented watches');
      }
      function assign() {
        add(1).click(); add(1).click();
        check(!add(1).disabled && doc.activeElement === add(1) && count(1) === '3×' && !add(2).disabled,
          'The longer season stopped accepting edits when one unassigned play remained');
        add(1).click();
        check(count(1) === '4×' && count(2) === '2×' && summary().textContent.includes('1 play above Trakt’s total of 10'),
          'A season pass could not cross the reported total while preserving the other season');
        remove(2).click();
        check(remove(2).disabled && count(2) === '1×' && doc.activeElement === add(2) && summary().textContent.includes('0 of 10 plays unassigned'),
          'Lowering a detected repeat did not restore the reported total or retain focus');
        add(1).click();
        check(!add(1).disabled && !add(2).disabled && count(1) === '5×' && doc.activeElement === add(1) && expanded() &&
          summary().textContent.includes('2 plays above Trakt’s total of 10'), 'The next over-total season edit lost its value or focus');
      }
      async function save() {
        q('[data-apply]').click();
        await until(() => q('[data-status]').textContent.includes('Import complete'), 'Season import did not complete');
        return (await peer.snapshot()).tables;
      }
      await open();
      check(review().textContent.includes('2 aired episodes · 2 matched') && review().querySelectorAll('.count-season button').length === 4,
        'The mixed season lost its matched episode count or season steppers');
      assign();
      remove(1).click(); add(2).click();
      check(!add(2).disabled && doc.activeElement === add(2) && summary().textContent.includes('1 play above Trakt’s total of 10'),
        'Undo did not restore the shorter season’s detected count or keyboard focus');
      remove(1).click();
      check(summary().textContent.includes('1 of 10 plays unassigned'), 'Undoing the extra season pass did not cross below the reported total');
      remove(1).click(); remove(1).click();
      check(remove(1).disabled && doc.activeElement === add(1) && count(1) === '1×' && count(2) === '2×',
        'Undoing the adjustments did not restore the original counts and focus');
      assign();
      summary().click();
      check(!expanded() && summary().textContent.includes('2 plays above Trakt’s total of 10') &&
        doc.documentElement.scrollWidth <= 320, 'Assigned source plays or actual record increase was wrong, or the phone overflowed');
      const after = await save();
      check(after.watched.map(r => [r.season,r.episode,r.times_watched].join('/')).sort().join() === '1/1/6,1/2/5,2/1/1',
        'An undocumented episode was marked or per-episode history was flattened');
      await open(); assign();
      check(summary().textContent.includes('2 plays above Trakt’s total of 10'), 'Reopening the same choices lost assigned rewatches');
      check(JSON.stringify(await save()) === JSON.stringify(after), 'Repeating the same estimates changed the saved record');
    }));

  await run('An archive with just show totals can supply an IMDb ID for an existing rated show', () =>
    withImportApp(320,'settings',async ({q,select,peer,configure,choose,preview,title}) => {
      await title('Settings'); await configure(); (await select('a[href="#/trakt-import"]')).click();
      const noImdb = {...show, ids:{trakt:51,tmdb:701}};
      async function save() {
        await preview(); q('[data-apply]').click();
        await until(() => q('[data-status]').textContent.includes('Import complete'),'Import did not save');
      }
      await choose(await traktZip({'ratings-shows.json':[{show:noImdb,rating:9}]})); await save();
      check((await peer.snapshot()).tables.shows[0].imdb_id === '', 'Seed already had an IMDb ID');
      await choose(await traktZip({'watched-shows.json':[{show,plays:0}]})); await save();
      const {tables} = await peer.snapshot();
      check(tables.shows[0].imdb_id === 'tt0000701' && tables.ratings[0].rating === 9 && !tables.watched.length,
        'Metadata-only import missed the IMDb ID or changed the viewing record');
    }));
}
