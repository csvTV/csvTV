import { mountListsScreen } from '../dist/lists-screen.js';
import { mountApplication } from '../dist/application.js';
import { openDeviceStore } from '../dist/storage.js';
import { TmdbClient } from '../dist/tmdb-client.js';
import { TmdbService } from '../dist/tmdb-service.js';
import { WatchActions } from '../dist/watch-actions.js';

function check(value, message) { if (!value) throw Error(message); }
async function until(test, message) {
  const limit = performance.now() + 4500;
  while (!await test()) {
    if (performance.now() > limit) throw Error(message);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
function watched(show_id, show) {
  return { show_id, show, season: 1, episode: 1, title: 'Opening', episode_id: show_id * 10, times_watched: 1 };
}
const first = watched(1, 'Écho Waters'), second = watched(2, 'Copper Thistle'), third = watched(3, 'Last Orchard');
const membership = (list, { show_id, show }) => ({ list, show_id, show });

async function fixture(seed, test) {
  const name = 'lists-test-' + crypto.randomUUID();
  const store = await openDeviceStore({ name });
  const client = new TmdbClient({ fetch: async () => { throw Error('Lists tried to fetch remotely'); } });
  const service = new TmdbService(store, client, { online: () => false, visible: () => true, now: Date.now });
  const frame = document.createElement('iframe');
  frame.width = 320; frame.height = 650;
  const loaded = new Promise(resolve => { frame.onload = resolve; });
  frame.src = '/screen-fixture'; document.body.append(frame);
  let screen;
  try {
    const start = await store.whenWriter();
    await store.commit(start.revision, { put: seed });
    await loaded;
    const doc = frame.contentDocument;
    const root = doc.querySelector('#app');
    const state = { queries: [], approvals: true, routes: [], selection: null, bar: null };
    const watch = new WatchActions(service, async () => false, v => { state.bar = v; }, () => {}, async q => {
      state.queries.push(q); return state.approvals;
    });
    let task;
    const ctx = { service, watch, selectList: name => { state.selection = name; }, clearUndo: () => watch.clear(),
      go: route => state.routes.push(route), run: work => (task = work()) };
    screen = mountListsScreen(root, ctx);
    await screen.ready;
    const q = sel => root.querySelector(sel);
    const all = sel => [...root.querySelectorAll(sel)];
    async function click(control) {
      const el = typeof control === 'string' ? q(control) : control;
      check(el && !el.disabled, 'List control is unavailable: ' + control);
      task = undefined;
      el.click();
      await task;
    }
    const byText = (sel, value) => all(sel).find(n => n.textContent === value);
    const chip = name => all('.list-chips button').find(n => n.dataset.listFocus === 'chip/' + name);
    const setValue = (el, value) => { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); };
    const names = async () => (await store.snapshot()).tables.lists.map(row => row.list);
    await test({ doc, frame, root, screen, ctx, watch, store, state, q, all, click, chip, byText, setValue, names, name });
  } finally {
    screen?.dispose(); frame.remove(); service.close(); store.close();
    const remove = indexedDB.deleteDatabase(name);
    await new Promise((resolve, reject) => { remove.onsuccess = resolve; remove.onerror = () => reject(remove.error); });
  }
}

export async function listsCases(run) {
  await run('Favorites spellings converge on one editable list and similar custom names remain separate', () =>
    fixture({lists:[membership('Favourites',first),membership('Favourites',second),membership('fAvOrItEs',first)]}, async ({q,chip,click,store,screen,names}) => {
      check(q('h2').textContent === 'Favorites' && chip('Favorites').textContent === 'Favorites2','Duplicate membership or missing canonical caption');
      await click('.list-remove');
      await until(() => chip('Favorites')?.textContent === 'Favorites1','Removing a legacy member did not update its count');
      check((await names()).join() === 'Favorites','Legacy spelling remained in storage');
      await store.commit((await store.snapshot()).revision,{put:{lists:[membership('Favorites',third),membership('My Favourites',first)]}});
      await screen.refresh();
      check(!chip('Favourites') && chip('Favorites').textContent === 'Favorites2' && chip('My Favourites').textContent === 'My Favourites1','Alias collision leaked into custom lists');
      await click(chip('Favorites'));
      check(q('.list-shows').textContent.includes(third.show),'Favorites lost a member');
      await click(chip('My Favourites'));
      check(q('.list-shows a').textContent.includes(first.show),'The custom list opened the wrong member');
    }));

  await run('Leaving Lists while Rename is reading the record abandons the pending confirmation', () =>
    fixture({ lists: [membership('Later', first)] }, async ({ q, click, chip, byText, setValue, screen, store, state, names }) => {
      await click(chip('Later'));
      await click('.list-more'); await click(byText('dialog button', 'Rename list'));
      setValue(q('dialog input'), 'Tomorrow');
      const personal = store.personalRows.bind(store);
      let release;
      const pending = new Promise(resolve => { release = resolve; });
      store.personalRows = async (...args) => { await pending; return personal(...args); };
      const submitted = click('dialog [type=submit]');
      screen.dispose();
      release();
      await submitted;
      check(state.queries.length === 0 && (await names()).join() === 'Later',
        'An abandoned Rename asked for confirmation or changed membership after navigation');
    }));

  await run('Lists opens the first custom list, preserves exact names, sorts shows, and works offline at phone width', () =>
    fixture({ watched: [second, watched(99,'Unrelated history')], lists: [membership('Watchlist', third), membership('WATCHLIST', first),
      membership('WATCHLIST', { show_id: 2, show: '' }),
      membership('Anime',first), membership('aNiMe',third), membership('Club', first),
      membership('Club', { show_id: 2, show:'' }), membership('club', third), membership('<b>Revisit</b>', third)],
      ratings: [{ show_id: 1, show: first.show, rating: 0 }], shows: [{ show_id: 1, show: first.show, year: 2022, imdb_id: '' },
        {show_id: 2, show: 'Older show spelling', year: 0, imdb_id: ''}] },
      async ({ q, all, chip, click, screen, state, doc, frame }) => {
        const order = all('.list-chips button[aria-pressed]').map(b => b.dataset.listFocus.slice(5));
        check(order.join('|') === '<b>Revisit</b>|Club|club', 'Custom names merged or a built-in list or classification appeared');
        check(q('#chosen-list').textContent === '<b>Revisit</b>' && q('.list-more'), 'Lists did not open its first custom list');
        await click(chip('Club'));
        check(all('.list-shows strong').map(el => el.textContent).join('|') === 'Copper Thistle|Écho Waters', 'Members were not in Library title order');
        const reads = [], transactions = [], settingsScans = [];
        const getAll = IDBObjectStore.prototype.getAll, transaction = IDBDatabase.prototype.transaction;
        IDBObjectStore.prototype.getAll = function(...args) {
          if (this.name==='watched') reads.push(args[0]?.lower?.[0]);
          if (this.name==='settings' && !args[0]) settingsScans.push(this.name);
          return getAll.apply(this,args);
        };
        IDBDatabase.prototype.transaction = function(stores,...rest) {
          transactions.push(...(typeof stores==='string' ? [stores] : stores));
          return transaction.call(this,stores,...rest);
        };
        try {
          await screen.refresh();
          check(reads.join() === '2' && !transactions.includes('sync') && !settingsScans.length &&
            !transactions.includes('local'),'Lists loaded an unrelated episode, sync file, or personal setting.');
          reads.length = 0;
          await click(chip('club'));
          check(!reads.length,'A list with named members read the episode history.');
          await click(chip('Club'));
        } finally {
          IDBObjectStore.prototype.getAll = getAll;
          IDBDatabase.prototype.transaction = transaction;
        }
        check(q('.list-rating').textContent === '0/10' && q('.list-shows').textContent.includes('2022'), 'Saved zero rating or saved year was lost');
        check(q('.list-shows li:first-child small')?.textContent === '0', 'A recorded zero year disappeared from Lists');
        const layout = () => all('.list-shows li').map(item => item.getBoundingClientRect());
        const [p1,p2] = layout();
        check(p2.top >= p1.bottom, 'Phone list members should run in one column.');
        frame.width = 1080;
        let [a,b] = layout();
        check(a.top === b.top && b.left > a.right, 'Wide custom lists should share a row.');
        const compact = q('.watch-density');
        compact.focus(); await click(compact);
        [a,b] = layout();
        check(a.top === b.top && b.left > a.right && doc.activeElement === compact,
          'Compact list layout changed the column count or moved keyboard focus.');
        frame.width = 320;
        await click(compact);
        await click(chip('<b>Revisit</b>'));
        check(q('#chosen-list').textContent === '<b>Revisit</b>' && !q('#chosen-list b'), 'List name became markup');
        await screen.refresh();
        check(q('#chosen-list').textContent === '<b>Revisit</b>', 'Background refresh reset selection');
        await click('.list-shows a');
        check(state.routes.at(-1)?.id === 3 && state.selection === '<b>Revisit</b>', 'Show navigation lost its list');
        check(doc.documentElement.scrollWidth <= 320, 'Lists overflowed the narrow viewport');
      }));

  await run('Lists sorts members by title, score and exact play totals without changing membership or scanning unrelated watches', async () => {
    const fourth = watched(4,'Amber Quay'), fifth = watched(5,'Glass Ferry'), other = watched(6,'West Dunes');
    const members = [first,second,third,fourth,fifth];
    const twoEpisodes = (show,extra) => [{...show,times_watched:Number.MAX_SAFE_INTEGER},
      {...show,episode:2,episode_id:show.episode_id+1,times_watched:extra}];
    await fixture({
      lists:[...members.map(show=>membership('Collection',show)),membership('Evening',other),membership('Evening',fourth)],
      ratings:[{show_id:1,show:first.show,rating:8},{show_id:2,show:second.show,rating:0},{show_id:3,show:third.show,rating:8}],
      watched:[...twoEpisodes(first,2),...twoEpisodes(second,1),{...third,times_watched:3},other],
    },async ({q,all,click,chip,doc,store}) => {
      const select = q('select[aria-label="Sort"]');
      check(select?.value === 'title' && !select.disabled,'Lists did not start in Title order with a usable dropdown');
      const expected = {title:'Title',high:'Highest rated',low:'Lowest rated',plays:'Most played'};
      check(select.options.length === 4 && [...select.options].every(o => expected[o.value] === o.text),
        'Lists did not offer the Ratings sort choices');
      const order = () => all('.list-shows a').map(a=>Number(a.hash.split('/').pop())).join();
      const choose = async (value,ids) => {
        select.focus();
        select.value = value; select.dispatchEvent(new Event('change',{bubbles:true}));
        await until(()=>order() === ids.join() && select.value === value,'Incorrect list order for '+value);
        check(doc.activeElement === select,'Sorting replaced the keyboard-focused dropdown');
      };
      check(order() === '4,2,1,5,3','The default title order changed');
      await choose('high',[1,3,2,4,5]);
      await choose('low',[2,1,3,4,5]);
      const scanned = [], read = IDBObjectStore.prototype.getAll;
      try {
        IDBObjectStore.prototype.getAll = function(query,...args) {
          if (this.name === 'watched') scanned.push(query?.lower?.[0]);
          return read.call(this,query,...args);
        };
        await choose('plays',[1,2,3,4,5]);
        check(q('a[href="#/show/3"]').textContent.includes('3 plays'),'Most played did not explain the order on the tile');
        check(!scanned.some(id=>!members.some(show=>show.show_id === id)),'Most played read outside the selected list');
      } finally { IDBObjectStore.prototype.getAll = read; }
      await click(chip('Evening'));
      await until(()=>order() === '6,4','Switching lists lost Most played or reused another list’s plays');
      check(q('.list-shows a').textContent.includes('1 play'),'One viewing was missing its play count');
      check(q('select[aria-label="Sort"]').value === 'plays' && chip('Collection').textContent === 'Collection5',
        'Switching lists changed the sort selection or membership counts');
      await click('.list-remove');
      await until(()=>order() === '4','Remove after sorting targeted another row');
      const remaining = (await store.snapshot()).tables.lists;
      check(remaining.length === 6 && remaining.filter(r=>r.list==='Evening').every(r=>r.show_id === 4),
        'Removing from a sorted list changed the wrong membership');
    });
  });

  await run('A read-only Lists tab can sort locally without writing the owner’s preference', () =>
    fixture({lists:[membership('Saved',first),membership('Saved',second)],ratings:[{show_id:1,show:first.show,rating:0}]},
      async ({root,screen,ctx,store,name,q}) => {
        screen.dispose();
        const peer = await openDeviceStore({name});
        const service = new TmdbService(peer,new TmdbClient({fetch:async()=>{throw Error('Unexpected network lookup');}}),
          {online:()=>false,visible:()=>true,now:Date.now});
        const reader = mountListsScreen(root,{...ctx,service});
        try {
          await reader.ready;
          const select = q('select[aria-label="Sort"]');
          check(peer.role === 'reader' && !select.disabled && q('.list-remove').disabled,'Reader sort or edit availability was wrong');
          select.value='low'; select.dispatchEvent(new Event('change',{bubbles:true}));
          await until(()=>q('.list-shows a')?.hash === '#/show/1','Reader failed to sort a zero score above an unrated title');
          check((await store.devicePreference('listsSort')).preference !== 'low','Reader changed the writer’s saved order');
        } finally { reader.dispose(); service.close(); peer.close(); }
      }));

  await run('Switching lists opens saved titles while details load and preserves the focused link through a title reorder', () =>
    fixture({lists:[membership('First',third),membership('Second',first),membership('Second',second)],
      watched:[first,{...second,times_watched:3}],
      ratings:[{show_id:1,show:first.show,rating:8}]},
      async ({store,click,chip,q,doc}) => {
        const read = store.tmdbEntries.bind(store);
        for (const sort of ['title','high','plays']) {
          const gate = Promise.withResolvers(), reading = Promise.withResolvers();
          let artworkReads = 0;
          store.tmdbEntries = async (keys,...rest) => {
            if (!keys.some(key=>key.startsWith('tv/'))) return read(keys,...rest);
            artworkReads++;
            reading.resolve(); await gate.promise;
            return keys.map(key=>key.startsWith('tv/1?') ? {value:{show:'Amber Waters',firstAirDate:'2018-04-02'}} : {value:null});
          };
          const switchList = click(chip('Second'));
          try {
            await reading.promise;
            const link = q('a[href="#/show/1"]');
            check(link?.textContent.includes(first.show),'The saved title waited for optional details');
            if (sort !== 'title') {
              const select = q('select[aria-label="Sort"]');
              select.value = sort; select.dispatchEvent(new Event('change',{bubbles:true}));
              if (sort === 'plays') {
                await until(()=>q('.list-shows a')?.hash === '#/show/2' && q('.list-shows a').textContent.includes('3 plays'),
                  'Sorting local play totals waited for optional artwork');
                check(q('a[href="#/show/1"]') === link && link.textContent.includes('1 play'),'Loading play totals replaced the saved link');
              } else {
                await until(()=>q('.list-shows a')?.hash === '#/show/1','Sorting saved scores waited for optional artwork');
              }
            }
            link.focus(); gate.resolve(); await switchList;
            check(q('.list-shows a')?.hash === (sort === 'plays' ? '#/show/2' : '#/show/1') &&
              q('a[href="#/show/1"]') === link && doc.activeElement === link,'Enrichment reset the selected order or replaced the focused link');
            check(artworkReads === 1,'Changing the sort started an extra artwork read');
            check(link.textContent.includes('Amber Waters') && link.textContent.includes('2018') &&
              q('a[href="#/show/2"] strong').textContent === second.show &&
              q('a[href="#/show/2"] small')?.textContent.includes('Not on TMDB'),'Cache enrichment mixed up the selected members');
            check(q('[data-list-focus="remove/1"]').getAttribute('aria-label').includes('Amber Waters'),'Remove kept the old title');
          } finally { gate.resolve(); await switchList; store.tmdbEntries = read; }
          await click(chip('First'));
        }
      }));

  await run('A late search reply cannot offer Add to the wrong list', () =>
    fixture({lists:[membership('Day',first),membership('Night',second)]},async ({ctx,q,chip,click,setValue,names}) => {
      const response = Promise.withResolvers(), finished = Promise.withResolvers();
      let started = false;
      const service = ctx.service;
      service.search = async () => {
        started = true;
        await response.promise;
        finished.resolve();
        return {status:'ready',value:{page:1,totalPages:1,results:[{show_id:8,show:'Late Beacon',firstAirDate:'2020-10-01'}]}};
      };
      const field = q('section input[type=search]');
      field.focus(); setValue(field,'late beacon');
      await until(() => started,'The remote search never started');
      await click(chip('Night'));
      response.resolve(); await finished.promise;
      await new Promise(r=>setTimeout(r,0));
      check(q('#chosen-list').textContent === 'Night' && !q('button[aria-label*="Late Beacon"]') &&
        (await names()).length === 2,'The previous list supplied an add action or wrote a stale search result');
    }));

  await run('Broad queries keep exact matches visible and a query made of only accent marks stays closed', () =>
    fixture({lists:[membership('Cove',first)],ratings:Array.from({length:30},(_,i)=>({
      show_id:100+i,show:i===29?'Quarry':'A Quarry '+i,rating:7}))},async ({q,all,setValue})=>{
      const field = q('section input[type=search]');
      field.focus(); setValue(field,'Quarry');
      await until(()=>all('.list-search-menu button').length===20,'A broad query failed to show its first twenty results');
      check(q('.list-search-menu button').getAttribute('aria-label')==='Add Quarry to Cove','The exact match was hidden below partial matches');
      setValue(field,'\u0301');
      check(field.getAttribute('aria-expanded')==='false' && !q('.list-search-menu button'),'A combining-mark query selected every saved title');
    }));

  await run('New list opens an empty collection, validates its name and supports adding and removing saved shows offline', () =>
    fixture({watched:[first,second],lists:[membership('Saved',third)]},async ({q,all,click,chip,byText,setValue,doc,state,store}) => {
      await click('.list-new');
      const name = q('dialog input');
      check(doc.activeElement === name,'The name field lost keyboard focus');
      setValue(name,'sAvEd'); await click('dialog [type=submit]');
      check(q('dialog .feedback').textContent.includes('exists') && doc.activeElement === name,'Case-folded duplicate was accepted');
      setValue(name,' Canceled '); q('dialog').dispatchEvent(new Event('cancel',{cancelable:true}));
      check(!chip('Canceled') && doc.activeElement === q('.list-new'),'Escape saved the list or lost focus');

      await click('.list-new'); setValue(q('dialog input'),'  Night cycle  ');
      await click(byText('dialog button','Create list'));
      const field = q('section input[type=search]');
      check(!q('dialog') && q('#chosen-list').textContent === 'Night cycle' && !q('.list-shows li') &&
        chip('Night cycle')?.textContent === 'Night cycle0','Creating the list required selecting a show or added a phantom member');
      field.focus(); setValue(field,'echo');
      const add = () => q('button[aria-label="Add Écho Waters to Night cycle"]');
      await until(add,'The saved show could not be found by its unaccented name offline');
      await store.commit(await store.recordRevision(),{put:{ratings:[{show_id:7,show:'Echo Hill',rating:5}]}});
      await until(()=>q('button[aria-label="Add Echo Hill to Night cycle"]'),'Open search kept a stale record after a rating arrived');
      await click(add());
      await until(()=>chip('Night cycle')?.textContent === 'Night cycle1','Add did not update the selected list');
      check(all('.list-shows strong').map(n=>n.textContent).join() === first.show &&
        q('button[aria-label="Added Écho Waters to Night cycle"]')?.disabled,'Added the wrong show or offered the same membership again');
      await click('.list-remove');
      await until(()=>chip('Night cycle')?.textContent === 'Night cycle0','Removing the last member lost the saved empty list');
      check(!state.queries.length && !(await store.snapshot()).tables.lists.some(r=>r.list==='Night cycle' && r.show_id===first.show_id),
        'Removing one member deleted the explicit list or retained that show');
      await click('.list-more'); await click(byText('dialog button','Rename list'));
      setValue(q('dialog input'),'New evening'); await click('dialog [type=submit]');
      check(!chip('Night cycle') && chip('New evening')?.textContent === 'New evening0','Renaming an empty list failed');
      await click('.list-more'); await click(byText('dialog button','Delete list'));
      check(!chip('New evening') && q('#chosen-list').textContent === 'Saved','Deleting an empty list lost another list or left its declaration');
    }));

  await run('Rename and delete confirm the current membership and preserve the original list on cancel', () =>
    fixture({ watched: [first, second], lists: [membership('Cycle', first), membership('Cycle', second), membership('Saved', second),
      membership('Night\r\nShows', first)] },
      async ({ frame, q, click, chip, byText, state, names, setValue, doc }) => {
        frame.width = 1080;
        await click(chip('Cycle'));
        await click('.list-more'); await click(byText('dialog button', 'Rename list'));
        const input = q('dialog input');
        setValue(input, 'Saved'); await click('dialog [type=submit]');
        check(q('dialog .feedback').textContent.includes('exists') && state.queries.length === 0, 'Renaming collided with another list');
        setValue(input, 'cycle'); state.approvals = false; await click('dialog [type=submit]');
        check(state.queries.at(-1)?.kind === 'rename' && q('dialog') && (await names()).includes('Cycle'), 'Cancel renamed the list');
        state.approvals = true; await click('dialog [type=submit]');
        check(q('#chosen-list').textContent === 'cycle' && (await names()).filter(n => n === 'cycle').length === 2 && !state.bar,
          'Case-only rename failed or offered Undo');
        await click('.list-more'); state.approvals = false; await click(byText('dialog button', 'Delete list'));
        check(state.queries.at(-1)?.count === 2 && q('#chosen-list').textContent === 'cycle', 'Unconfirmed deletion changed the list');
        await click('.list-more'); state.approvals = true; await click(byText('dialog button', 'Delete list'));
        check(!chip('cycle') && !state.bar && q('#chosen-list').textContent === 'Night\r\nShows', 'Deletion did not select the next custom list');
        await click(chip('Night\r\nShows'));
        await click('.list-more'); await click(byText('dialog button', 'Rename list'));
        check(q('dialog textarea')?.value === 'Night\nShows', 'A CSV list name lost its line break in Rename');
        const decisions = state.queries.length;
        await click('dialog [type=submit]');
        check(!q('dialog') && (await names()).includes('Night\r\nShows') && state.queries.length === decisions,
          'An unchanged list name was rewritten with different line endings');
        await click('.list-more'); await click(byText('dialog button', 'Rename list'));
        setValue(q('dialog textarea'), 'Night\nTelevision'); await click('dialog [type=submit]');
        check((await names()).includes('Night\nTelevision') && !chip('Night\r\nShows'), 'An edited multiline name was lost');
        check(doc.documentElement.scrollWidth <= 1080, 'Lists overflowed the desktop viewport');
      }));

  await run('Removing the last custom member asks first and leaves the separate Watchlist intact', () =>
    fixture({ watched: [first], lists: [membership('Watchlist', first), membership('Single', first)] },
      async ({ q, click, chip, state, screen, names, root, ctx, store, setValue }) => {
        await click(chip('Single')); state.approvals = false; await click('.list-remove');
        check(state.queries.at(-1)?.kind === 'last-show' && q('.list-shows li'), 'Last custom row did not require confirmation');
        state.approvals = true; await click('.list-remove');
        check(!chip('Single') && (await names()).join() === 'Watchlist' && !chip('Watchlist') && !state.bar &&
          q('.list-empty').textContent === 'No custom lists yet.', 'Empty custom lists lost the Watchlist or exposed it on Lists');
        screen.dispose();
        const app = mountApplication(root, ctx.service);
        const put = IDBObjectStore.prototype.put;
        try {
          await app.ready; app.go({ page: 'lists' });
          await until(() => q('.list-new'), 'Recovery fixture could not open Lists');
          q('.list-new').click();
          setValue(q('dialog input'), 'Recovered');
          IDBObjectStore.prototype.put = function(...args) {
            const request = put.apply(this, args);
            if (this.name === 'lists' && args[0]?.list === 'Recovered') {
              throw new DOMException('Fictional quota', 'QuotaExceededError');
            }
            return request;
          };
          q('dialog [type=submit]').click();
          await until(() => q('.reports [data-retry] button'), 'Missing storage recovery');
          check(!q('dialog[open]') && !(await names()).includes('Recovered'), 'Failed list save blocked recovery or stored the rows');
          IDBObjectStore.prototype.put = put;
          const retry = q('.reports [data-retry] button');
          check(retry.textContent === 'Clear cached titles and retry', 'Quota recovery did not offer cache cleanup');
          retry.click();
          await until(() => q('#chosen-list')?.textContent === 'Recovered', 'Recovery did not retry the submitted list creation');
          check(!q('.list-shows li') && (await names()).filter(n => n === 'Recovered').length === 1,
            'Retry duplicated the list declaration or added a phantom show');
        } finally { IDBObjectStore.prototype.put = put; app.dispose(); }
      }));
}
