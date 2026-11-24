import { check, checkPreImportBackup, until, withImportApp } from './import-app-fixture-cases.mjs';

const entry = (series_id, changes = {}) => ({series_type:0, series_id, status:2, score:0, progress:0, repeat:0, ...changes});
const data = (lists, favourites = []) => new File([JSON.stringify({lists, favourites, reviews:['fictional private review']})], 'sample.json');
const mapping = [
  {anilist_id:31, themoviedb_id:{tv:701}, season:{tmdb:1}},
  {anilist_id:32, themoviedb_id:{tv:701}, season:{tmdb:8}},
  {anilist_id:33, themoviedb_id:{movie:62}},
  {anilist_id:34, type:'SPECIAL'},
  {anilist_id:35, themoviedb_id:{tv:702}},
];

export async function anilistScreenCases(run) {
  await run('Home and Settings open AniList import, and missing prerequisites, malformed files and failed mapping responses leave the record intact', () =>
    withImportApp(320,'home',async ({q,doc,win,select,configure,choose,title,fixture,peer}) => {
      const home = await select('[data-setup] a[href="#/anilist-import"]');
      home.click(); await title('Import from AniList');
      await until(() => q('[data-block]').textContent.includes('Add a TMDB key'), 'Missing-key instruction');
      check(q('input[type=file]').disabled && !fixture.mappingRequests.length, 'Keyless import could make requests');
      q('[data-settings]').click(); await title('Settings'); await configure();
      (await select('a[href="#/anilist-import"]')).click(); await title('Import from AniList');
      fixture.online = false; win.dispatchEvent(new win.Event('offline'));
      await until(() => q('input[type=file]').disabled && q('[data-block]').textContent.includes('internet'), 'Offline picker was enabled');
      fixture.online = true; win.dispatchEvent(new win.Event('online'));
      await choose(data([],Array(100_001).fill(null)));
      await until(() => q('[data-status]').textContent.includes('100,000-row import limit'), 'AniList row limit was not reported');
      check(!fixture.mappingRequests.length && !q('.import-totals') && !(await peer.snapshot()).tables.watched.length,
        'Oversized AniList input started matching or changed the record');
      for (const invalid of ['plain text', '{"notes":"fictional"}']) {
        await choose(new File([invalid], 'sample.json'));
        await until(() => q('[data-status]').textContent.includes('Could not read'), 'Malformed JSON was not reported');
        check(!fixture.mappingRequests.length, 'An invalid file triggered a mapping download');
      }
      fixture.mappingReply = () => new Response('fictional provider error', {status:403});
      await choose(data([entry(31)]));
      await until(() => q('[data-status]').textContent.includes('403'), 'Missing mapping HTTP failure');
      check(!fixture.paths.includes('tv/701') && !(await peer.snapshot()).tables.lists.length && !q('.import-totals'),
        'A rejected mapping download started matching, wrote rows or left a preview');
    }));

  await run('AniList previews differing scores and unplaced episodes, links only valid skipped entries, then backs up the linked record and saves confirmed rows', () =>
    withImportApp(320,'settings',async ({q,doc,win,select,configure,choose,preview,title,fixture,peer}) => {
      await title('Settings'); await configure(); (await select('a[href="#/anilist-import"]')).click(); await title('Import from AniList');
      fixture.mappingReply = () => Response.json(mapping);
      fixture.showTitle = 'Fictional <b>Signal</b>';
      const lists = [entry(31,{score:80, status:7, repeat:1, progress:1}), entry(32,{score:90, status:3, progress:2}),
        entry(33), entry(34), entry(35), entry('31/malformed')];
      const favourites = [{favourite_type:1, favourite_id:31}];
      await choose(data(lists,favourites)); await preview();
      await until(() => q('[data-preview]').textContent.includes('Average rounded to 8.5/10'), 'Scores did not explain the resulting rating');
      const review = q('[data-preview]');
      check(review.textContent.includes('Entry scores 8, 9') && review.textContent.includes('Could not place · 2 episodes') &&
        review.textContent.includes('Fictional <b>Signal</b>') && !review.querySelector('b'), 'Review lost unplaced episodes, showed incorrect score inputs, or parsed the title as markup');
      const links = [...review.querySelectorAll('a')];
      check(links.find(a=>a.href === 'https://anilist.co/anime/34')?.textContent ===
        'AniList entry 34 · Special · No TMDB show in the mapping file.', 'Skipped notice lost the special’s format or AniList link');
      check(JSON.stringify(links.map(a => a.href).sort()) === JSON.stringify([33,34,35].map(id=>'https://anilist.co/anime/' + id)) &&
        links.every(a=>a.target === '_blank' && a.relList.contains('noopener') && a.relList.contains('noreferrer')), 'Invalid AniList link or target');
      check(q('[data-import-report="Dropped shows"] summary')?.textContent === 'Dropped shows (1)' &&
        [...doc.querySelectorAll('.import-totals dd')].map(el=>el.textContent).join() === '1,1,1,1' &&
        doc.activeElement === q('[data-status]') && doc.documentElement.scrollWidth <= 320, 'Incorrect preview totals, focus or mobile layout');
      check(fixture.mappingRequests.length === 1 && fixture.paths.includes('tv/701/season/1') && !(await peer.snapshot()).tables.watched.length,
        'Preview missed a lookup or committed the imported watches');
      const request = fixture.mappingRequests[0];
      check(request.url === 'https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-mini.json' &&
        request.method === 'GET' && !request.body && !request.headers.length && request.credentials === 'omit' &&
        request.referrerPolicy === 'no-referrer', 'The public mapping request contained personal input or credentials');
      const card = q('[data-count-review="701"]'), toggle = card.querySelector('[data-count-summary]');
      const whole = card.querySelector('[data-whole-add]');
      check(toggle.getAttribute('aria-expanded') === 'false' && !card.querySelector('.count-season, [data-anilist-review-notice]'),
        'The collapsed review built its season rows or notices before they were requested');
      whole.click(); toggle.click();
      check(toggle.getAttribute('aria-expanded') === 'true' && card.querySelectorAll('[data-anilist-review-notice]').length === 2 &&
        card.textContent.includes('Progress may cover only the current viewing.'), 'The opened review lost a reason');
      const add = card.querySelector('[data-season-add="1"]'), remove = card.querySelector('[data-season-remove="1"]');
      const value = card.querySelector('[data-season-count="1"]');
      check(value.textContent === '3×' && card.textContent.includes('2 aired episodes · 1 matched'),
        'The whole-show correction changed an episode absent from AniList progress');
      add.click();
      check(value.textContent === '4×' && doc.activeElement === add &&
        [...doc.querySelectorAll('.import-totals dd')][1].textContent === '2', 'The season edit did not add the missing aired episode');
      remove.click();
      check(value.textContent === '3×' && [...doc.querySelectorAll('.import-totals dd')][1].textContent === '1',
        'Undo kept the extra episode');
      add.click(); toggle.click();
      check(toggle.getAttribute('aria-expanded') === 'false' && toggle.textContent.includes('+3 plays') && doc.documentElement.scrollWidth <= 320,
        'The collapsed card omitted the adjusted plays or overflowed the phone');
      const previousCount = [...fixture.files.keys()].filter(path => path.endsWith('/completion.json')).length;
      q('[data-apply]').click();
      await until(() => q('[data-status]').textContent.includes('Import complete'), 'AniList import did not complete');
      checkPreImportBackup(fixture.files, previousCount);
      const first = (await peer.snapshot()).tables;
      check(first.watched.length === 2 && first.watched[0].episode_id === 711 && first.watched[0].times_watched === 4 &&
        first.watched[1].episode_id === 712 && first.watched[1].times_watched === 1 &&
        first.ratings[0].rating === 8.5 && first.lists.map(row=>row.list).sort().join() === 'Anime,Dropped,Favorites',
        'Saved record differed from the preview');
      await choose(data([lists[0], {...lists[1], score:50}], favourites)); await preview();
      await until(() => q('[data-preview]').textContent.includes('Keep 8.5/10 · AniList 6.5/10'), 'Kept rating did not identify the AniList proposal');
      q('[data-cancel]').click();
      check(JSON.stringify((await peer.snapshot()).tables) === JSON.stringify(first), 'Canceling changed the first import');
    }));

  await run('Adding a first watch withdraws the Planning proposal and undoing it restores the open proposal', () =>
    withImportApp(390,'settings',async ({q,select,configure,choose,preview,title,fixture,peer}) => {
      await title('Settings'); await configure(); (await select('a[href="#/anilist-import"]')).click();
      fixture.mappingReply = () => Response.json(mapping);
      await choose(data([entry(31,{status:1,repeat:1})])); await preview();
      const lists = q('[data-import-report="List memberships"]'), card = q('[data-count-review="701"]');
      const listNames = () => [...lists.querySelectorAll('li')].map(li => li.textContent);
      const listTotal = () => q('.import-totals > div:last-child dd').textContent;
      lists.open = true;
      await until(() => listNames().some(name => name.includes('Watchlist')), 'Planning preview omitted Watchlist');
      card.querySelector('[data-count-summary]').click();
      check(card.querySelector('[data-whole-add]').disabled, 'Whole-show rewatches were offered without exported episodes');
      card.querySelector('[data-season-add="1"]').click();
      await until(() => card.querySelector('[data-season-count="1"]').textContent === '1×', 'First aired season was not ready');
      check(listTotal() === '0' && !lists.isConnected, 'Recording a watch kept an ineligible Planning membership');
      card.querySelector('[data-season-remove="1"]').click();
      check(listTotal() === '1' && listNames()[0].includes('Watchlist') && lists.open,
        'Undo did not restore the open Watchlist proposal and list total');
      check(!(await peer.snapshot()).tables.watched.length, 'A review edit changed the saved record');
    }));

  await run('AniList explains two entries in one TMDB season and offers a manual season when a regular entry has no target', () =>
    withImportApp(320,'settings',async ({q,doc,select,configure,choose,preview,title,fixture,peer}) => {
      await title('Settings'); await configure(); (await select('a[href="#/anilist-import"]')).click();
      fixture.mappingReply = () => Response.json([...mapping,
        {anilist_id:36,themoviedb_id:{tv:701},season:{tmdb:1},episode_offset:{tmdb:1}}]);
      await choose(data([entry(31,{progress:1}),entry(36,{progress:1})])); await preview();
      const selector = '[data-import-report="AniList season matches"]';
      const matches = q(selector);
      check(matches && !matches.open && !q('[data-count-review]'), 'Two correctly placed parts should start with a collapsed source report');
      matches.querySelector('summary').click();
      await until(() => matches.querySelector('strong')?.textContent === 'Signal Garden', 'The match report did not identify its TMDB show');
      const lines = [...matches.querySelectorAll('li li')].map(node => node.textContent);
      check(lines.length === 2 && lines[0].includes('AniList entry 31 · 1 of 1 reported episode placed') &&
        lines[0].includes('TMDB season 1 · E1') && lines[1].includes('AniList entry 36') && lines[1].includes('TMDB season 1 · E2'),
        'The two legitimate parts of one season did not identify their own matched episodes');
      q('[data-cancel]').click();
      await choose(data([entry(32,{progress:2})])); await preview();
      const card = q('[data-count-review="701"]');
      check(card && card.textContent.includes('0 matched episodes · 2 unplaced'), 'The unplaced regular entry has no editable review');
      card.querySelector('[data-count-summary]').click();
      check(card.querySelector('[data-whole-add]').disabled && !card.querySelector('[data-season-add="0"]'),
        'Zero matched episodes incorrectly enabled a whole-show or special-season watch');
      card.querySelector('[data-season-add="1"]').click();
      await until(() => card.querySelector('[data-season-count="1"]').textContent === '1×', 'Manual season on a zero-match show did not load');
      q(selector).querySelector('summary').click();
      await until(() => q(selector).textContent.includes('0 of 2 reported episodes placed'), 'Manual watches were attributed to the missing source season');
      check(q(selector).textContent.includes('TMDB season 8 · None placed') && doc.documentElement.scrollWidth <= 320,
        'The missing mapping or phone layout was lost');
      q('[data-apply]').click();
      await until(() => q('[data-status]').textContent.includes('Import complete'), 'Corrected gap import did not complete');
      const {watched} = (await peer.snapshot()).tables;
      check(watched.length === 2 && watched.every(row => row.season === 1 && row.times_watched === 1), 'The manually selected season differed from the saved watches');
    }));

  await run('Canceling a public mapping fetch or the reviewed AniList import preserves the desktop record', () =>
    withImportApp(1080,'settings',async ({q,doc,select,configure,choose,preview,title,fixture,peer}) => {
      await title('Settings'); await configure(); (await select('a[href="#/anilist-import"]')).click(); await title('Import from AniList');
      const held = Promise.withResolvers();
      let signal;
      fixture.mappingReply = request => { signal = request.signal; return held.promise; };
      const file = data([entry(31,{progress:1})]);
      await choose(file);
      await until(() => signal, 'Mapping request did not start');
      q('[data-cancel]').click(); held.resolve(Response.json(mapping));
      await until(() => signal.aborted && q('[data-status]').textContent === 'Import canceled.' && doc.activeElement === q('input[type=file]'),
        'Cancel left a request pending or lost focus');
      fixture.mappingReply = () => Response.json(mapping);
      await choose(file); await preview();
      q('[data-cancel]').click();
      await until(() => q('[data-status]').textContent === 'Import canceled.', 'Cancel kept the import pending');
      check(!q('.import-totals') && !(await peer.snapshot()).tables.shows.length && doc.documentElement.scrollWidth <= 1080,
        'Cancel wrote rows or left a preview');
    }));
}
