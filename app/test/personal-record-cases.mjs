import { openDeviceStore } from '../dist/storage.js';
import { TmdbService } from '../dist/tmdb-service.js';
import { WatchActions } from '../dist/watch-actions.js';
import { orderedListNames } from '../dist/personal-record.js';
import { mergeRows } from '../dist/merge.js';
import { rowKey } from '../dist/model.js';
import { upcomingReason } from '../dist/upcoming-preference.js';

const amber = { show_id: 1, show: 'Amber Coast' };
const birch = { show_id: 2, show: 'Paper Birch' };
const cedar = { show_id: 3, show: 'Cedar Station' };
const member = (show, list) => ({ ...show, list });
const episode = show => ({ ...show, season: 1, episode: 1, episode_id: show.show_id * 100, title: 'Opening', times_watched: 1 });
function check(value, message) { if (!value) throw new Error(message); }
async function rejects(operation, predicate) {
  try { await operation; } catch (error) { if (predicate(error)) return; throw error; }
  throw new Error('Expected the operation to fail.');
}

async function fixture(body) {
  const name = 'csvtv-personal-' + crypto.randomUUID();
  const store = await openDeviceStore({ name });
  await store.whenWriter();
  const service = new TmdbService(store);
  const state = { bar: null, notices: [], questions: [], answer: async () => true };
  const watch = new WatchActions(service, async () => false, bar => { state.bar = bar; },
    text => state.notices.push(text), async question => {
      state.questions.push(question);
      return state.answer(question);
    });
  const seed = async patch => store.commit((await store.personalRows()).revision, patch);
  try { await body({ name, store, service, watch, state, seed }); }
  finally { service.close(); store.close(); }
}

export async function personalRecordCases(run) {
  await run('A concurrent first watch blocks an outdated Watchlist add without changing other memberships', () =>
    fixture(async ({store,watch,seed}) => {
      await seed({put:{lists:[member(cedar,'Favorites')]}});
      const commit = store.commit.bind(store);
      let raced = false;
      store.commit = async (revision,patch,options) => {
        if (!raced) {
          raced = true;
          await commit(revision,{put:{watched:[{...episode(cedar),season:0}]}});
        }
        return commit(revision,patch,options);
      };
      try { await rejects(watch.setMembership(cedar,'WATCHLIST',true), e => e.message.includes('watched episodes')); }
      finally { store.commit = commit; }
      const rows = await store.personalRows([cedar.show_id]);
      check(raced && rows.watchedIds.has(cedar.show_id) && rows.lists.length === 1 && rows.lists[0].list === 'Favorites',
        'A stale Watchlist action committed or changed the favorite after a first special was watched');
    }));

  await run('Watchlist resolves old follows and opt-outs, preserves custom lists, and undoes exactly after reopening', () =>
    fixture(async ({name, store, watch, state, seed}) => {
      const lists = [
        member(amber,'WATCHLIST'),member(amber,'Weekend'),member(amber,'Hidden from upcoming'),member(amber,'HIDDEN FROM UPCOMING'),
        member(amber,'following upcoming'),member(birch,'FOLLOWING UPCOMING'),
      ];
      await seed({put:{watched:[episode(birch)],lists}});
      const names = async (s,id) => (await s.personalRows()).lists.filter(r => r.show_id === id).map(r => r.list);
      check(!upcomingReason(await names(store,amber.show_id)), 'Conflicting synced choices should respect the opt-out');
      check(await watch.setMembership(amber,'Watchlist',true), 'An opted-out member could not rejoin the Watchlist');
      const saved = await openDeviceStore({name});
      try {
        const active = await names(saved,amber.show_id);
        check(upcomingReason(active) === 'watchlist' && active.sort().join() === ['WATCHLIST','Weekend'].join(),
          'Reopen lost a custom list or kept a redundant preference');
      } finally { saved.close(); }
      await watch.undo();
      check((await names(store,amber.show_id)).sort().join() === lists.filter(r => r.show_id === 1).map(r => r.list).sort().join(),
        'Undo did not restore exactly the previous preference keys');
      await watch.setMembership(cedar,'Watchlist',true);
      check(upcomingReason(await names(store,cedar.show_id)) === 'watchlist', 'An unwatched show could not join the Watchlist');
      await watch.setMembership(cedar,'Watchlist',false);
      await watch.setMembership(cedar,'WATCHLIST',true);
      check(upcomingReason(await names(store,cedar.show_id)) === 'watchlist', 'An explicit add left an older opt-out in force');
      check(!state.questions.length && (await store.overviewRows()).watched.length === 1,
        'Editing an Upcoming preference changed watches or requested list deletion');
      await seed({put:{lists:[member(birch,'stOPped'),member(birch,'STOPPED')]}});
      const original = (await names(store,birch.show_id)).sort().join();
      check(!upcomingReason(await names(store,birch.show_id)), 'A historical follow beat Dropped');
      await rejects(watch.setMembership(birch,'Watchlist',true), e => e.message.includes('Pick up'));
      await watch.setDropped(birch,false);
      check((await names(store,birch.show_id)).sort().join() === 'FOLLOWING UPCOMING,csvTV: picked up',
        'Picking up did not preserve the historical follow or missed a spelling');
      await watch.undo();
      check((await names(store,birch.show_id)).sort().join() === original,'Undo of Pick Up lost the original CSV spellings');
      await watch.setDropped(birch,false);
      await watch.setDropped(birch,true);
      check((await names(store,birch.show_id)).sort().join() === 'Dropped,FOLLOWING UPCOMING','Dropping again left a stale Pick Up override');
      await watch.undo();
      check(upcomingReason(await names(store,birch.show_id)) && (await store.overviewRows()).watched.length === 1,
        'Undo of Drop lost a follow or changed the watch record');
    }));
  await run('Ratings save zero and half steps without a key, remove their row, and Undo preserves fresh titles', () =>
    fixture(async ({ store, watch, state, seed }) => {
      check(await watch.setRating(amber, 0), 'A rating of zero must create a row.');
      const zero = await store.personalRows();
      check(zero.ratings[0].rating === 0 && state.bar, 'Zero was treated as an empty rating.');
      check(!await watch.setRating(amber, 0), 'Identical rating was reported as a new edit.');
      for (const invalid of [-0.5, 10.5, 2.2, NaN, Infinity]) {
        await rejects(watch.setRating(amber, invalid), e => e.message.includes('half steps'));
      }
      check((await store.personalRows()).revision === zero.revision, 'Invalid or identical ratings changed the record.');
      await watch.setRating(amber, 9.5);
      await seed({ put: { ratings: [{ ...amber, show: 'Revised Coast', rating: 9.5 }] } });
      await watch.undo();
      const restored = (await store.personalRows()).ratings[0];
      check(restored.rating === 0 && restored.show === 'Revised Coast' && !state.bar, 'Undo clobbered a descriptive rewrite.');
      await watch.setRating(amber, null);
      check(!(await store.personalRows()).ratings.length, 'Remove rating left a row.');
      await watch.undo();
      check((await store.personalRows()).ratings[0].rating === 0, 'Undo of removal failed to restore zero.');
      await watch.setRating(amber, 10);
      check((await store.personalRows()).ratings[0].rating === 10, 'The highest rating was rejected.');
    }));

  await run('A submitted Rating follows its original record through navigation and unrelated writes, but respects competing scores, guards, erase and writer handoff', () =>
    fixture(async ({store,name,service,watch,seed,state}) => {
      const row = {...amber,rating:2.5};
      const current = async () => (await store.ratingState(amber.show_id)).rating?.rating;
      const put = () => seed({put:{ratings:[row]},local:{syncAccountId:'fictional-owner'}});
      await put();
      async function paused(whileHeld) {
        const release = service.holdRecordChanges();
        const saving = watch.setRating(amber,8,2.5);
        watch.leaveScreen();
        try { await whileHeld(); } finally { release(); }
        return saving;
      }
      check(await paused(()=>seed({put:{lists:[member(amber,'Weekend')]}})) && await current()===8 && !state.bar,
        'An unrelated revision or leaving Ratings lost the edit or put Undo on the destination');
      await put();
      await rejects(paused(()=>seed({put:{ratings:[{...amber,rating:6}]}})),e=>e.message.includes('rating changed'));
      check(await current()===6,'A concurrent score was replaced by the older choice');
      await put();
      check(!await paused(async()=>watch.clear()) && await current()===2.5,'A resolved record guard did not cancel the old choice');
      check(!await paused(()=>seed({local:{syncAccountId:'fictional-second-owner'}})) && await current()===2.5,
        'An equal score in another account was overwritten');
      check(!await watch.setRating(amber,8,2.5,{account:'fictional-owner',erased:0n}) && await current()===2.5,
        'A field still displaying the previous account overwrote the new record before repaint');
      await put();
      check(!await paused(async()=>{
        await store.eraseDevice((await store.devicePreference('appearance')).revision);
        await put();
      }) && await current()===2.5,'Erasing and restoring the same account revived the old choice');
      const notices = state.notices.length;
      const commit = store.commit.bind(store), started = Promise.withResolvers(), fail = Promise.withResolvers();
      store.commit = async (...args) => {
        if (args[1].put?.ratings?.[0]?.rating===8) {
          started.resolve(); await fail.promise;
          throw Error('Fictional storage failure from the previous account');
        }
        return commit(...args);
      };
      try {
        const oldAccount = watch.setRating(amber,8,2.5);
        await started.promise; watch.leaveScreen();
        await seed({local:{syncAccountId:'fictional-third-owner'}});
        fail.resolve();
        await rejects(oldAccount,e=>e.message.includes('Fictional storage'));
        check(state.notices.length===notices,'The new account saw a failure from the previous record');
      } finally { fail.resolve(); store.commit = commit; }
      const reader = await openDeviceStore({name});
      try {
        await rejects(paused(async()=>{ await store.closeForUpdate(); await reader.whenWriter(); }),e=>e.kind==='superseded');
        check((await reader.ratingState(amber.show_id)).rating.rating===2.5,'A rating was committed by a retired writer');
      } finally { reader.close(); }
    }));

  await run('List names use ASCII folding and file order; Watchlist variants survive and stale Library picks cannot commit', () =>
    fixture(async ({ store, watch, seed }) => {
      const start = await store.personalRows();
      check(orderedListNames(start.lists).join() === 'Watchlist', 'Empty Watchlist absent.');
      check(await watch.createList('Empty', []) && orderedListNames((await store.personalRows()).lists).includes('Empty'),
        'Creating an empty list did not reserve its name.');
      await rejects(watch.createList('empty', []), e => e.message.includes('exists'));
      await watch.undo();
      check(!(await store.personalRows()).lists.length,'Undo left the empty list behind.');
      for (const name of ['WATCHLIST', '  watchList ', '   ']) {
        await rejects(watch.createList(name, [amber]), e => /exists|name/.test(e.message));
      }
      const accent = 'Á';
      await seed({ put: { watched: [episode(amber)], lists: ['watchlist', 'WATCHLIST', 'Anime', 'anime', 'Club', 'club', accent, 'z'].map(l => member(amber,l)) } });
      const names = orderedListNames((await store.personalRows()).lists);
      check(names.join() === ['Watchlist','Club','club','z',accent].join(), 'Incorrect custom list order or surfaced Anime classification');
      await rejects(watch.setMembership(amber,'Watchlist',true),e => e.message.includes('watched episodes'));
      await watch.setMembership(amber,'watchlist',false);
      check(!(await store.personalRows()).lists.some(r => r.show_id === 1 && r.list.toLowerCase() === 'watchlist'),
        'The explicit Watchlist opt-out missed an existing spelling.');
      await watch.undo();
      await rejects(watch.createList('Club', [birch]), e => e.message.includes('exists'));
      const categoryError = e => e.message.includes('Library filter');
      await rejects(watch.createList('ANime', [birch]),categoryError);
      await rejects(watch.setMembership(amber,'Anime',false),categoryError);
      await rejects(watch.setMembership(birch,'Anime',true),categoryError);
      await rejects(watch.renameList('anime','Categories'),categoryError);
      await rejects(watch.deleteList('Anime'),categoryError);
      await rejects(watch.createList('Queue', [amber,birch], { requireWatched: true }), e => e.message.includes('Library'));
      check(!(await store.personalRows()).lists.some(r => r.list === 'Queue'), 'Stale picker partially wrote a list.');
      await watch.createList('  Queue  ', [amber, amber], { requireWatched: true });
      await watch.createList('á', [birch]);
      await watch.setMembership(birch, 'watchlist', true);
      let rows = (await store.personalRows()).lists;
      check(rows.filter(r => r.list === 'Queue').length === 1 && rows.some(r => r.list === 'á'), 'Name trimming or ASCII-only folding failed.');
      check(!rows.some(r => r.list === 'WATCHLIST' && r.show_id === 2), 'An explicit toggle touched the other spelling.');
      for (const name of ['WATCHLIST','watchlist','Watchlist']) {
        await rejects(watch.renameList(name, 'Elsewhere'), e => e.message.includes('Watchlist'));
        await rejects(watch.deleteList(name), e => e.message.includes('Watchlist'));
      }
      await rejects(watch.renameList('Queue', 'ANIME'), categoryError);
      await watch.renameList('Queue', ' queue ');
      rows = (await store.personalRows()).lists;
      check(rows.some(r => r.list === 'queue') && !rows.some(r => r.list === 'Queue'), 'Case-only rename of own list failed.');
      check(rows.filter(r=>r.list.toLowerCase()==='anime').map(r=>r.list).join() === 'Anime,anime',
        'An ordinary list edit rewrote legacy Anime classification rows');
    }));

  await run('Each membership edit owns Undo; deleting a last custom member requires consent and clears Undo only after saving', () =>
    fixture(async ({ store, watch, state, seed }) => {
      await watch.createList('Later', [amber,birch]);
      await seed({ put: { lists: [member(cedar, 'Later')] } });
      await watch.undo();
      check((await store.personalRows()).lists.map(r => r.show).join() === cedar.show, 'Undo of New list erased a later member.');
      await watch.setMembership(amber, 'Later', true);
      await watch.setMembership(amber, 'Later', false);
      await watch.undo();
      check((await store.personalRows()).lists.length === 2 && !state.questions.length, 'An ordinary membership changed the wrong rows or asked.');
      await watch.setMembership(amber, 'Later', false);
      const priorBar = state.bar;
      state.answer = async () => false;
      check(!await watch.setMembership(cedar, 'Later', false) && state.bar === priorBar, 'Cancel invalidated a previous Undo.');
      check(state.questions.at(-1).kind === 'last-show' && state.questions.at(-1).count === 1, 'Last-show confirmation was misidentified.');
      state.answer = async () => true;
      await watch.setMembership(cedar, 'Later', false);
      check(!(await store.personalRows()).lists.length && !state.bar, 'Last member and prior Undo must go after confirmation.');
      const count = state.questions.length;
      await watch.setMembership(amber, 'Watchlist', true);
      await watch.setMembership(amber, 'Watchlist', false);
      check(state.questions.length === count && state.bar && orderedListNames((await store.personalRows()).lists)[0] === 'Watchlist',
        'Emptying Watchlist asked a question, hid Watchlist, or lost Undo.');
      await watch.undo();
      check((await store.personalRows()).lists[0].list === 'Watchlist', 'Could not restore the last Watchlist member.');
    }));

  await run('Destructive list changes reconfirm altered memberships, honor guard holds and navigation, and reject a second writer', () =>
    fixture(async ({ store, service, watch, state, seed, name }) => {
      await watch.createList('Run', [amber,birch]);
      state.answer = async () => {
        if (state.questions.length === 1) {
          await seed({ remove: { lists: [['Run',1]] }, put: { lists: [member(cedar, 'Run')] } });
          return true;
        }
        return false;
      };
      check(!await watch.deleteList('Run'), 'A stale destructive decision deleted changed rows.');
      check(state.questions.length === 2 && state.questions.every(q => q.count === 2), 'Membership change with equal count was missed.');
      const before = (await store.personalRows()).revision;
      const release = service.holdRecordChanges();
      const pending = watch.setRating(amber, 1.5);
      await new Promise(resolve => setTimeout(resolve, 15));
      check((await store.personalRows()).revision === before, 'Rating bypassed a guard hold.');
      watch.clear(); release();
      check(!await pending && (await store.personalRows()).revision === before, 'An old screen committed after a guard.');
      state.answer = async () => { watch.clear(); return true; };
      check(!await watch.renameList('Run','Other'), 'A stale screen applied a late confirmation.');
      const reader = await openDeviceStore({ name });
      const readerService = new TmdbService(reader);
      const readerWatch = new WatchActions(readerService, async () => false, () => {}, () => {});
      try { await rejects(readerWatch.setRating(amber, 3), e => e.kind === 'superseded'); }
      finally { readerService.close(); reader.close(); }
      check((await store.personalRows()).revision === before, 'Reader or late confirmation altered a durable row.');
    }));

  await run('A quota error during multirow rename rolls back both sides and leaves the prior Undo valid across a database read', () =>
    fixture(async ({ store, watch, state, name }) => {
      await watch.createList('Saved', [amber,birch,cedar]);
      const before = await store.personalRows();
      const prior = state.bar;
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function(...args) {
        const result = put.apply(this, args);
        if (this.name === 'lists' && args[0].list === 'Renamed' && args[0].show_id === 2) {
          throw new DOMException('Fictional quota failure', 'QuotaExceededError');
        }
        return result;
      };
      try { await rejects(watch.renameList('Saved', 'Renamed'), e => e.name === 'QuotaExceededError'); }
      finally { IDBObjectStore.prototype.put = put; }
      const reopened = await openDeviceStore({ name });
      try {
        const after = await reopened.personalRows();
        check(before.revision === after.revision && JSON.stringify(before.lists) === JSON.stringify(after.lists) && state.bar === prior,
          'An aborted rename changed the file, revision, or previous Undo.');
      } finally { reopened.close(); }
      await watch.renameList('Saved','Renamed');
      check((await store.personalRows()).lists.every(r => r.list === 'Renamed') && !state.bar, 'Explicit retry failed.');
      await watch.deleteList('Renamed');
      check(!(await store.personalRows()).lists.length && !state.bar && state.questions.at(-1).count === 3, 'Deleting a list lost its count or offered Undo.');
    }));

  await run('Undo takes merge protection from rating and list keys including deleted, equal-value and no-base rows', () =>
    fixture(async ({ store, watch, state, seed }) => {
      await watch.setRating(amber, 0);
      const rated = (await store.personalRows()).ratings;
      const equal = mergeRows('ratings', null, rated, rated);
      watch.protect([], [], equal.remoteChangedKeys);
      await watch.undo();
      check((await store.personalRows()).ratings[0].rating === 0 && state.notices.pop().includes('1 row'), 'Undo overwrote a no-base rating.');
      await watch.setRating(amber, 4.5);
      await seed({ remove: { ratings: [1] } });
      watch.protect([], [], [String(amber.show_id)]);
      await watch.undo();
      check(!(await store.personalRows()).ratings.length, 'Undo recreated a remotely deleted rating.');
      await watch.createList('Shared', [amber,birch]);
      const added = (await store.personalRows()).lists;
      const remote = [member(amber, 'Shared'), member(cedar, 'Shared')];
      const merged = mergeRows('lists', [], added, remote);
      await seed({ replace: { lists: merged.rows } });
      watch.protect([], merged.remoteChangedKeys);
      await watch.undo();
      const remaining = (await store.personalRows()).lists;
      check(remaining.map(r => r.show_id).join() === '1,3' && state.notices.pop().includes('1 row'), 'Multi-show Undo touched protected or later rows.');
      await watch.setMembership(amber, 'Shared', false);
      watch.protect([], [rowKey('lists', member(amber, 'Shared'))]);
      await watch.undo();
      check((await store.personalRows()).lists.length === 1 && !state.bar, 'Undo recreated a remotely removed membership.');
      await watch.setRating(birch, 3);
      const commit = store.commit.bind(store);
      store.commit = async (...args) => {
        store.commit = commit;
        watch.protect([], [], [String(birch.show_id)]);
        return commit(...args);
      };
      try { await watch.undo(); } finally { store.commit = commit; }
      check((await store.personalRows()).ratings[0].rating === 3 && state.notices.pop().includes('1 row'),
        'Undo overwrote a just-protected rating at the same value.');
    }));
}
