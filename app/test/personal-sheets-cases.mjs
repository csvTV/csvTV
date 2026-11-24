import { openMembershipSheet, openRatingSheet } from '../dist/personal-sheets.js';
import { openDeviceStore } from '../dist/storage.js';
import { TmdbService } from '../dist/tmdb-service.js';
import { WatchActions } from '../dist/watch-actions.js';

function check(value, message) { if (!value) throw Error(message); }

async function until(test, message) {
  const limit = performance.now() + 3500;
  while (performance.now() < limit) {
    const value = await test();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw Error(message);
}

async function fixture(width, exercise) {
  const name = 'fictional-personal-sheets-' + crypto.randomUUID();
  const store = await openDeviceStore({ name });
  const service = new TmdbService(store);
  const frame = document.createElement('iframe');
  frame.width = width; frame.height = 440;
  const loaded = new Promise(resolve => { frame.onload = resolve; });
  frame.src = '/screen-fixture';
  document.body.append(frame);
  let closeSheet;
  try {
    await loaded;
    await store.whenWriter();
    const doc = frame.contentDocument, root = doc.querySelector('#app');
    const origin = doc.createElement('button');
    origin.className = 'opener';
    origin.textContent = 'Personal record';
    root.append(origin);
    const show = { show_id: 33, show: 'West <Signal>' };
    let bar, accept = false;
    const questions = [], errors = [];
    const watch = new WatchActions(service, async () => false, value => { bar = value; }, () => {},
      async question => { questions.push(question); return accept; });
    const ctx = { service, watch, run: async action => { try { await action(); } catch (error) { errors.push(error); } } };
    const q = selector => root.querySelector(selector);
    const focus = () => q('.opener');
    const button = label => [...root.querySelectorAll('dialog button')].find(el => el.textContent === label);
    const tick = name => [...root.querySelectorAll('dialog [type=checkbox]')].find(el => el.value === name);
    const rate = n => { closeSheet = openRatingSheet(root, ctx, show, n, focus); };
    const lists = async () => {
      closeSheet = openMembershipSheet(root, ctx, show, focus);
      await until(() => tick('Watchlist') || tick('WATCHLIST'), 'List options did not load');
    };
    await exercise({ store, service, doc, root, q, rate, lists, watch, button, tick, show, close: () => closeSheet(),
      undo: () => bar, questions, accept: yes => { accept = yes; } });
    check(!errors.length, errors[0]?.message ?? 'Unexpected sheet error');
  } finally {
    closeSheet?.(); service.close(); store.close(); frame.remove();
    const deletion = indexedDB.deleteDatabase(name);
    await new Promise((resolve, reject) => { deletion.onsuccess = resolve; deletion.onerror = () => reject(deletion.error); });
  }
}

export async function personalSheetsCases(run) {
  await run('An open Search list sheet removes Watchlist after a first watch and restores the saved plan when it is undone', () =>
    fixture(390,async ({store,doc,lists,tick,show}) => {
      await store.commit((await store.personalRows()).revision,{put:{lists:[{...show,list:'Watchlist'},{...show,list:'Favorites'}]}});
      await lists();
      check(tick('Watchlist')?.checked && tick('Favorites')?.checked,'Missing planned show or favorite');
      tick('Watchlist').focus();
      await store.commit((await store.personalRows()).revision,{put:{watched:[
        {...show,season:1,episode:1,title:'Signal',times_watched:1,episode_id:3311}]}});
      await until(() => !tick('Watchlist') && tick('Favorites')?.checked,'Watched Search result still offered Watchlist or lost Favorites');
      check(doc.activeElement.textContent === 'New list','Hiding a focused Watchlist choice lost modal focus');
      await store.commit((await store.personalRows()).revision,{remove:{watched:[[show.show_id,1,1]]}});
      await until(() => tick('Watchlist')?.checked,'The prior plan did not reappear after the only watch was removed');
    }));

  await run('An unrated slider distinguishes untouched, middle, zero and half-step values; only Done saves a draft', () =>
    fixture(320, async ({ doc, root, q, rate, store, button, undo, watch }) => {
      const rows = async () => (await store.personalRows()).ratings;
      rate(null);
      let slider = q('input[type=range]');
      check(q('dialog').matches(':modal') && q('dialog h2').textContent === 'Your rating', 'Sheet missing accessible name or modality');
      check(q('.rating-figure').hidden && !button('Remove rating') && button('Done').disabled &&
        slider.min === '0' && slider.max === '10' && slider.step === '0.5' && slider.value === '5', 'Unrated initial state');
      slider.click();
      check(!button('Done').disabled && q('.rating-figure').textContent === '5/10', 'Tap on the initial middle thumb did not select 5');
      slider.value = '7.5'; slider.dispatchEvent(new Event('input'));
      q('dialog').dispatchEvent(new Event('cancel', { cancelable: true }));
      check(!q('dialog') && !(await rows()).length && !undo() && doc.activeElement.matches('.opener'), 'Escape saved the draft or lost focus');
      rate(null);
      slider = q('input[type=range]');
      slider.value = '0'; slider.dispatchEvent(new Event('input'));
      button('Done').click();
      await until(() => !q('dialog'), 'Saving zero did not close');
      check((await rows())[0].rating === 0 && undo(), 'Zero was discarded');
      rate(0);
      check(q('.rating-figure').textContent === '0/10' && button('Remove rating') && !button('Done').disabled, 'Zero reopened as unrated');
      slider = q('input[type=range]');
      slider.value = '8.5'; slider.dispatchEvent(new Event('input'));
      button('Done').click();
      await until(() => !q('dialog'), 'Half point did not save');
      check((await rows())[0].rating === 8.5, 'Lost half point');
      rate(8.5);
      const newOrigin = doc.createElement('button');
      newOrigin.className = 'opener'; q('.opener').replaceWith(newOrigin);
      button('Remove rating').click();
      await until(() => !q('dialog'), 'Remove did not close');
      check(!(await rows()).length && doc.activeElement === newOrigin, 'Removal left an empty rating or focused an obsolete trigger');
      await watch.undo();
      check((await rows())[0].rating === 8.5 && !undo(), 'Undo did not restore the removed rating');
      check(!root.querySelector('signal'), 'Title was interpreted as HTML');
    }));

  await run('Each list tick commits independently, exact case variants remain distinct, and the Watchlist stays available when empty', () =>
    fixture(1080, async ({ q, lists, tick, button, store, show, watch, undo, questions }) => {
      const other = { show: 'River Glass', show_id: 34 };
      await store.commit((await store.snapshot()).revision, { put: { lists: [
        { ...other, list: 'WATCHLIST' }, { ...show, list: 'Watchlist' }, { ...other, list: 'Zebra' },
        { ...show, list: 'ideas' }, { ...other, list: 'Ideas' },
      ] } });
      await lists();
      const names = () => [...q('dialog').querySelectorAll('[type=checkbox]')].map(el => el.value).join('|');
      check(names() === 'Watchlist|Ideas|ideas|Zebra' && tick('Watchlist').checked && tick('ideas').checked && !tick('Ideas').checked,
        'Expected one Watchlist, followed by the distinct custom names');
      async function toggle(name, state) {
        tick(name).click();
        await until(() => !q('dialog .personal-sheet > div').inert && Boolean(tick(name)?.checked) === state, 'Tick did not settle for ' + name);
      }
      await toggle('Ideas', true);
      await toggle('Watchlist', false);
      check(!questions.length && undo(), 'Last Watchlist deletion asked or lost its Undo');
      button('Done').click();
      await watch.undo();
      const mine = (await store.personalRows()).lists.filter(r => r.show_id === 33).map(r => r.list).sort().join('|');
      check(mine === 'Ideas|Watchlist|ideas', 'Undo changed more than the last tick');
      await store.commit((await store.snapshot()).revision, { remove: { lists: [['WATCHLIST',34]] } });
      await lists(); await toggle('Watchlist', false);
      check(tick('Watchlist') && !tick('Watchlist').checked && !questions.length, 'The empty Watchlist choice disappeared');
    }));

  await run('New list validates in place, preserves literal names and Undo keeps shows added to the list afterward', () =>
    fixture(320, async ({ doc, q, lists, button, tick, store, show, watch, undo, questions, accept }) => {
      await lists();
      button('New list').click();
      const input = q('input[type=text]');
      check(input === doc.activeElement && button('Create list').disabled, 'Name form focus or empty validation');
      const name = value => { input.value = value; input.dispatchEvent(new Event('input')); };
      name(' wAtChLiSt '); button('Create list').click();
      await until(() => q('dialog .feedback').textContent.includes('exists') && doc.activeElement === input, 'Duplicate Watchlist was not reported in context');
      name('  Filmed <elsewhere>  '); button('Create list').click();
      await until(() => tick('Filmed <elsewhere>')?.checked && doc.activeElement === tick('Filmed <elsewhere>'), 'Created list did not receive focus and membership');
      check(!q('elsewhere') && (await store.personalRows()).lists[0].show_id === show.show_id, 'Created list lost its first show or used HTML');
      button('Done').click();
      const extra = { list: 'Filmed <elsewhere>', show_id: 44, show: 'Coast Road' };
      await store.commit((await store.snapshot()).revision, { put: { lists: [extra] } });
      await watch.undo();
      check((await store.personalRows()).lists.length === 1 && (await store.personalRows()).lists[0].show_id === 44, 'Undo deleted a second member');
      await store.commit((await store.snapshot()).revision, { put: { lists: [{ ...show, list: 'Solo' }] } });
      await lists();
      tick('Solo').click();
      await until(() => questions.length === 1 && !q('.membership-choices').parentElement.inert, 'Last-show cancellation did not finish');
      check(tick('Solo').checked && questions[0].count === 1 && questions[0].kind === 'last-show', 'Last custom member did not require informed confirmation');
      accept(true); tick('Solo').click();
      await until(() => !tick('Solo'), 'Confirmed final member survived');
      check(questions.length === 2 && !undo(), 'Confirmed list deletion offered Undo');
    }));

  await run('Personal sheets keep keyboard focus, scroll long lists at 320 pixels and discard drafts on backdrop dismissal', () =>
    fixture(320, async ({ doc, q, rate, lists, store, button, tick }) => {
      rate(null);
      const rating = q('input[type=range]');
      rating.value = '9.5'; rating.dispatchEvent(new Event('input'));
      button('Done').focus();
      button('Done').dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
      check(doc.activeElement === rating, 'Tab left the sheet');
      rating.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
      check(doc.activeElement === button('Done') && rating.getBoundingClientRect().height >= 44, 'Reverse tab or slider hit target');
      q('dialog').click();
      check(!q('dialog') && !(await store.personalRows()).ratings.length, 'Backdrop applied the draft');
      await store.commit((await store.snapshot()).revision, { put: { lists: Array.from({ length: 32 }, (_, i) =>
        ({ list: 'Day ' + (i + 1), show_id: 77, show: 'Several Springs' })) } });
      await lists();
      check(q('dialog').scrollHeight > q('dialog').clientHeight && doc.documentElement.scrollWidth <= 320 &&
        tick('Watchlist').getBoundingClientRect().width === 20, 'Long lists overflowed or tick size changed');
      button('New list').focus(); button('New list').click();
      q('input[type=text]').value = 'Unsaved';
      q('dialog').dispatchEvent(new Event('cancel', { cancelable: true }));
      check(doc.activeElement.matches('.opener') && !(await store.personalRows()).lists.some(r => r.list === 'Unsaved'),
        'Escape from the name step created a list or lost focus');
    }));
}
