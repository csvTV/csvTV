import test from 'node:test';
import assert from 'node:assert/strict';
import { planTraktImport, applyTraktImport, describeTraktChanges } from '../dist/trakt-import.js';
import { sameImportOutcome } from '../dist/import-preview.js';
import { emptyTables, watchPosition } from '../dist/model.js';
import { recordExportFiles } from '../dist/export-data.js';
import { readLocalRecord } from '../dist/local-restore.js';
import { watch } from './dropbox-sync-fixture-cases.mjs';

const show = { show_id: 7, show: 'Coastal Dial', year: 2021, imdb_id: 'tt1234567' };
const source = (overrides = {}) => ({ shows: [show], watched: [], ratings: [], lists: [], skipped: [], counts: [],
  reusedPositions: new Set(), cache: new Map(), generation: 1n, ...overrides });
const local = (tables = {}) => ({ revision: 1n, tmdbGeneration: 1n, local: {}, sync: {}, tables: { ...emptyTables(), ...tables } });
const rating = value => ({ show_id: 7, show: show.show, rating: value });
const list = (name, id = 7) => ({ show_id: id, show: show.show, list: name });

test('A linked import accepts the hand-formatted base selected in the Dropbox guard', async () => {
  const snapshot = local({ ratings: [rating(0)] });
  const session = { accountId: 'fictional-owner', instanceId: 'test-sign-in', signInDeadline: Date.now() + 60000 };
  snapshot.local = { syncAccountId: session.accountId, dropboxSession: session };
  snapshot.sync.ratings = { pending: null, base: { content: 'rating,show_id,show\n0,7,Coastal Dial\n', revision: 'r5' } };
  let backedUp = 0, saved = 0;
  const store = { role: 'writer', snapshot: async () => snapshot,
    dropboxState: async () => ({ session, accountId: session.accountId, revision: snapshot.revision }),
    tmdbState: async () => ({ generation: 1n, token: 'fictional', refused: null }),
    commit: async () => { saved++; } };
  const data = source({ watched: [watch(2)] }), plan = planTraktImport(data, snapshot);
  const hooks = { active: () => true, online: () => true, preflight: async () => {}, backup: async () => { backedUp++; },
    confirm: assert.fail };
  assert.equal(await applyTraktImport(store, data, plan, hooks), true);
  assert.equal(backedUp, 1);
  assert.equal(saved, 1);
  snapshot.tables.ratings = [rating(5)];
  await assert.rejects(applyTraktImport(store, data, plan, hooks), /waiting to sync/);
  assert.equal(backedUp, 1);
  assert.equal(saved, 1);
});

test('Direct import refuses a never-linked record before metadata, sync, backup or edits',async()=>{
  const snapshot = local(), input = source(), plan = planTraktImport(input,snapshot);
  const store = {role:'writer',dropboxState:async()=>({session:null,accountId:null}),tmdbState:assert.fail,commit:assert.fail};
  await assert.rejects(applyTraktImport(store,input,plan,{active:()=>true,online:()=>true,preflight:assert.fail,backup:assert.fail}),
    /Dropbox sign-in/);
});

test('The count suggestion touches only placed episodes, never lowers plays, and can be unselected', () => {
  const input = source({ watched: [watch(1), watch(2, 2)], skipped: ['Third episode missing'],
    counts: [{ show_id: 7, show: show.show, total: 6, listedPlays: 5, listedEpisodes: 3, multiple: 2 }] });
  const record = local({ watched: [watch(4, 2), watch(6, 9)] });
  const ordinary = planTraktImport(input, record);
  const adjusted = planTraktImport(input, record, new Set([7, 707]));
  assert.deepEqual(ordinary.watched.map(row => row.after), [1, 4]);
  assert.deepEqual(adjusted.watched.map(row => row.after), [2, 4]);
  assert.deepEqual(adjusted.changes.put.watched.map(row => row.episode), [1]);
  assert.deepEqual([...adjusted.selected], [7]);
  assert.ok(sameImportOutcome(ordinary,planTraktImport(input, record, new Set())));
  assert.deepEqual(record.tables.watched.map(row => row.times_watched), [4, 6]);
});

test('Matched seasons can be raised independently above the Trakt total, preserve higher personal counts and survive reimport', async () => {
  const one = watch(2), two = watch(1, 2), other = {...watch(1, 1, 21), season:2};
  const input = source({watched:[other, one, two], skipped:['Another listing was skipped'],
    counts:[{show_id:7, show:show.show, total:9, listedPlays:5, listedEpisodes:4, multiple:null}]});
  const unrelated = watch(4, 5);
  const record = local({watched:[unrelated, {...one, times_watched:8}]});
  const extras = new Map([[7, new Map([[1,4], [2,12]])]]);
  const plan = planTraktImport(input, record, new Set(), extras);
  assert.deepEqual(plan.countSeasons.get(7).map(s => [s.season,s.matchedEpisodes,s.eligibleEpisodes,s.listedPlays,
    s.minPlays,s.maxPlays,s.displayCount]), [[1,2,2,3,1,2,5],[2,1,1,1,1,1,13]]);
  assert.deepEqual(plan.seasonExtras, extras);
  assert.deepEqual(plan.watched.map(p => [p.row.episode_id, p.after]), [[21,13],[1,8],[2,5]]);
  assert.deepEqual(plan.changes.put.watched.map(r => r.episode_id), [21,2]);
  assert.deepEqual(plan.skipped, input.skipped);

  const result = local({watched:[...record.tables.watched, ...plan.changes.put.watched], shows:[show]});
  const files = recordExportFiles({tables:result.tables, showMetadata:new Map(), externalIds:new Map()}, 0);
  const reopened = local(await readLocalRecord(files));
  for (const choices of [extras, new Map()]) {
    const again = planTraktImport(input, reopened, new Set(), choices);
    assert.deepEqual(again.changes.put.watched, []);
    assert.deepEqual(again.changes.remove.watched, []);
  }
  assert.deepEqual(reopened.tables.watched.find(row => row.episode_id === unrelated.episode_id), unrelated);
});

test('Invalid season passes leave the entire selection unapplied, and uniform count suggestions remain exclusive', () => {
  const input = source({watched:[watch(1), {...watch(1, 1, 21), season:2}], skipped:['Third listing was skipped'],
    counts:[{show_id:7, show:show.show, total:6, listedPlays:3, listedEpisodes:3, multiple:2}]});
  const preview = (choices, selected = new Set()) => planTraktImport(input, local(), selected, new Map([[7, new Map(choices)]]));
  for (const choices of [
    [[1,0]], [[1,-1]], [[1,1.5]], [[1,NaN]], [[1,Number.MAX_SAFE_INTEGER + 1]],
    [[1,1], [2,Number.MAX_SAFE_INTEGER]], [[2,Number.MAX_SAFE_INTEGER], [1,1]], [[1,1], [3,1]],
  ]) {
    assert.deepEqual(preview(choices).seasonExtras, new Map());
    assert.deepEqual(preview(choices).watched.map(p => p.after), [1,1]);
  }
  assert.deepEqual(preview([[1,1], [2,0]]).seasonExtras.get(7), new Map([[1,1]]));
  const uniform = preview([[1,3]], new Set([7]));
  assert.deepEqual(uniform.seasonExtras, new Map());
  assert.deepEqual(uniform.watched.map(p => p.after), [2,2]);
});

test('Whole-show rewatches apply to every matched season, combine with season corrections and keep larger Library counts', async () => {
  const first = watch(1), second = watch(2,2), special = {...watch(1,1,21),season:0};
  const unrelated = {...watch(1,3,31),season:3};
  const input = source({watched:[first, second, special], skipped:['Unmatched third season'],
    counts:[{show_id:7,show:show.show,total:6,listedPlays:5,listedEpisodes:4,multiple:null}]});
  const saved = local({watched:[{...second,times_watched:9},unrelated]});
  const seasons = new Map([[7,new Map([[0,-2]])]]), whole = new Map([[7,2]]);
  const review = (record, count) => planTraktImport(input,record,new Set(),seasons,count);
  const approved = review(saved,whole);
  assert.deepEqual(approved.wholeShowPasses,whole);
  assert.deepEqual(approved.seasonExtras,seasons);
  assert.deepEqual(approved.watched.map(row => row.after),[3,9,1]);
  assert.deepEqual(approved.changes.put.watched.map(row => row.episode_id),[1,21]);
  assert.deepEqual(approved.skipped,input.skipped);
  const imported = local({watched:[...saved.tables.watched,...approved.changes.put.watched],shows:[show]});
  const files = recordExportFiles({tables:imported.tables,showMetadata:new Map(),externalIds:new Map()},0);
  const reopened = local(await readLocalRecord(files));
  assert.deepEqual(review(reopened,whole).changes.put.watched,[]);
  assert.deepEqual(reopened.tables.watched.find(row => row.episode_id === unrelated.episode_id),unrelated);
  const changed = review(local({watched:[watch(4,1,500),...saved.tables.watched]}),whole);
  assert.deepEqual(changed.watched.map(row => row.after),[9,1]);
  assert.deepEqual(changed.changes.remove.watched,[]);
  assert.equal(sameImportOutcome(changed,approved),false);
});

test('Whole-show and individual season rewatches can exceed the Trakt total while each episode count remains a safe integer', () => {
  const last = Number.MAX_SAFE_INTEGER, one = watch(1), two = {...watch(2,1,21),season:2};
  const input = source({watched:[one,two],counts:[{show_id:7,show:show.show,total:4,listedPlays:3,listedEpisodes:2,multiple:2}]});
  const review = (count, corrections = []) => planTraktImport(input,local(),new Set(),
    new Map([[7,new Map(corrections)]]), new Map([[7,count],[700,4]]));
  assert.deepEqual(review(last-2).watched.map(row=>row.after),[last-1,last]);
  assert.deepEqual(review(last-1,[[2,-1]]).watched.map(row=>row.after),[last,last]);
  assert.deepEqual(review(1,[[1,-1]]).watched.map(row=>row.after),[1,3]);
  for (const bad of [NaN,Infinity,1.5,-1,last-1,last,last+1]) {
    const declined=review(bad);
    assert.deepEqual(declined.wholeShowPasses,new Map());
    assert.deepEqual(declined.watched.map(row=>row.after),[1,2]);
  }
  assert.deepEqual(review(1,[[1,-2]]).wholeShowPasses,new Map());
  assert.deepEqual(review(3,[[1,2]]).watched.map(row=>row.after),[6,5]);
  const nearLimit = review(1,[[1,last-2],[2,last-3]]);
  assert.deepEqual(nearLimit.watched.map(row=>row.after),[last,last]);
  assert.deepEqual(review(1,[[1,last-2],[2,last-2]]).seasonExtras,new Map());
  assert.deepEqual([...review(3).wholeShowPasses],[[7,3]]);
});

test('Season additions and reductions are independent of edit order and survive reopening and sync conflicts', async () => {
  const episode1 = watch(2), episode2 = watch(3,2), special = {...watch(1,1,21), season:0};
  const input = source({watched:[episode1,episode2,special], skipped:['One unmatched play'],
    counts:[{show_id:7, show:show.show,total:8,listedPlays:7,listedEpisodes:4,multiple:null}]});
  const preview = (order, snapshot = local()) => planTraktImport(input, snapshot, new Set(), new Map([[7,new Map(order)]]));
  const selection = [[0,6],[1,-1]];
  const first = preview(selection);
  assert.deepEqual(first.watched.map(p => p.after), [1,2,7]);
  assert.ok(sameImportOutcome(preview([...selection].reverse()),first));
  assert.deepEqual(preview([[1,-2],[0,1]]).seasonExtras, new Map());
  const files = recordExportFiles({tables:{...emptyTables(),watched:first.changes.put.watched,shows:[show]},
    showMetadata:new Map(),externalIds:new Map()},0);
  assert.deepEqual(preview(selection, local(await readLocalRecord(files))).changes.put.watched, []);
  const revised = preview(selection,local({watched:[{...episode1,times_watched:7},watch(9,2,502)]}));
  assert.deepEqual(revised.watched.map(p => p.after), [7,7]);
  assert.deepEqual(revised.changes.remove.watched, []);
  assert.match(describeTraktChanges(revised, first).join(' '), /occupies this position/);
  assert.equal(sameImportOutcome(revised,first),false);
});

test('A local identity conflict retains the season selection for eligible episodes', () => {
  const input = source({watched:[watch(1), watch(1,2), {...watch(1,1,21), season:2}],
    counts:[{show_id:7, show:show.show, total:5, listedPlays:3, listedEpisodes:3, multiple:null}]});
  const extras = new Map([[7, new Map([[1,1]])]]);
  const first = planTraktImport(input, local(), new Set(), extras);
  const conflict = local({watched:[watch(5,2,502)]});
  const revised = planTraktImport(input, conflict, first.selected, first.seasonExtras);
  assert.deepEqual(revised.seasonExtras, first.seasonExtras);
  assert.deepEqual(revised.countSeasons.get(7).map(s => [s.matchedEpisodes,s.eligibleEpisodes]), [[2,1],[1,1]]);
  assert.deepEqual(revised.watched.map(p => [p.row.episode_id, p.after]), [[1,2],[21,1]]);
  assert.equal(revised.reviewShows[0].playDelta,1n);
  assert.match(describeTraktChanges(revised, first).join(' '), /occupies this position/);
  assert.deepEqual(revised.changes.remove.watched, []);
});

test('Manual missing seasons import aired episodes only, preserve local identities and allow zero to undo', () => {
  const day='2026-11-20';
  const detail = entries => ({episodes:entries.map(([episode,episode_id,airDate]) =>
    ({episode,episode_id,airDate,title:'Broadcast '+episode_id}))});
  const data = source({today:day,watched:[watch(1)],counts:[
    {show_id:7,show:show.show,total:2,listedPlays:1,listedEpisodes:1,multiple:2}],
    reviewShows:new Map([[7,{seasons:[0,1,2,3,4,5].map(season=>({season}))}]]),
    reviewSeasons:new Map([[7,new Map([[0,detail([[1,50,day]])],[1,detail([[1,1,day],[2,9,day]])],
      [2,detail([[1,21,day],[2,22,day],[3,23,'2026-11-21'],[4,24,null],[5,25,day],[6,1,day],[7,27,day]])],
      [3,detail([[1,31,day],[2,25,day]])],[4,null]])]])});
  const existing = {...watch(12,1,21),season:2};
  const conflict = {...watch(7,2,72),season:2};
  const blank = {...watch(2,7,null),season:2};
  data.reusedPositions.add(watchPosition(blank));
  const localRecord = local({watched:[existing,conflict,blank]});
  const plan = (choices, record=localRecord) => planTraktImport(data,record,new Set(),
    new Map([[7,new Map(choices)]]),new Map([[7,3]]));
  const details = data.reviewSeasons.get(7), late = details.get(2);
  details.delete(2);
  const beforeDetail = plan([]);
  assert.deepEqual(beforeDetail.watched.map(p=>p.row.episode_id),[1]);
  details.set(2,late);
  const base = plan([]);
  assert.deepEqual(base.watched,[]);
  assert.equal(base.countSeasons.get(7).find(s=>s.season===1).matchedEpisodes,1);
  assert.equal(base.countSeasons.get(7).find(s=>s.season===1).eligibleEpisodes,0);
  assert.equal(base.skipped.length,1,'Exactly one previously proposed export row is now ambiguous');
  assert.ok(describeTraktChanges(base,beforeDetail).some(s=>s.includes('multiple seasons')));
  const wanted = [[3,1],[2,4],[0,2]];
  const chosen = plan(wanted);
  assert.deepEqual(chosen.watched.map(p=>[p.row.episode_id,p.after]),[[50,2],[21,12],[31,1]]);
  assert.deepEqual(chosen.changes.put.watched.map(p=>p.episode_id).sort((a,b)=>a-b),[21,31,50]);
  assert.deepEqual(chosen.changes.remove.watched,[]);
  assert.equal(chosen.countSeasons.get(7).find(s=>s.season===2).airedEpisodes,5);
  assert.equal(chosen.countSeasons.get(7).find(s=>s.season===2).eligibleEpisodes,1);
  assert.equal(chosen.countSeasons.get(7).find(s=>s.season===4).airedEpisodes,0);
  assert.equal(chosen.countSeasons.get(7).find(s=>s.season===5).airedEpisodes,null);
  assert.equal(chosen.skipped.filter(s=>s.includes('multiple seasons')).length,4);
  assert.equal(new Set(chosen.skipped).size,chosen.skipped.length);
  data.reviewSeasons.set(7,new Map([...details].reverse()));
  assert.ok(sameImportOutcome(plan(wanted),chosen),'Season lookup order cannot decide an episode’s identity');
  assert.ok(chosen.skipped.some(s=>s.includes('occupies this position')));
  assert.ok(chosen.skipped.some(s=>s.includes('reused this position')));
  assert.ok(sameImportOutcome(plan(wanted.reverse()),chosen));
  assert.ok(sameImportOutcome(plan([[0,0],[2,0],[3,0]]),base));
  assert.deepEqual(plan([[5,1]]).changes.put.watched,[]);
  assert.deepEqual(plan([],local({watched:[watch(12)]})).changes.remove.watched,[]);
  const recovered = local({watched:[...chosen.changes.put.watched,conflict,blank],shows:[show]});
  assert.deepEqual(plan(wanted,recovered).changes.put.watched,[]);
});

test('A show with only a Trakt total can be imported via a season, then returned to an empty proposal', () => {
  const data = source({today:'2026-11-20', counts:[{show_id:7,show:show.show,total:1,listedEpisodes:0,
    listedPlays:0,multiple:null}],reviewShows:new Map([[7,{seasons:[{season:0}]}]]),
    reviewSeasons:new Map([[7,new Map([[0,{episodes:[{episode:1,episode_id:84,title:'Overture',airDate:'2020-02-09'}]}]])]])});
  const preview = (passes, whole) => planTraktImport(data,local(),new Set(),
    new Map([[7,new Map([[0,passes]])]]),new Map([[7,whole]]));
  const added = preview(Number.MAX_SAFE_INTEGER,2);
  assert.equal(added.watched[0].after,Number.MAX_SAFE_INTEGER);
  assert.equal(added.wholeShowPasses.size,0);
  assert.deepEqual(added.changes.put.shows,[show]);
  for (const passes of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1]) {
    const cleared=preview(passes,0);
    assert.deepEqual(cleared.changes.put.watched,[]);
    assert.deepEqual(cleared.changes.put.shows,[]);
  }
});

test('Import preserves zero and conflicting local ratings, each case variant, prior IMDb IDs and unrelated rows', () => {
  const input = source({ shows: [{ ...show, imdb_id: '' }], lists: [list('Watchlist'), list('Favorites')], ratings: [rating(8)] });
  const record = local({ ratings: [rating(0)], shows: [show], lists: [list('WATCHLIST', 30), list('watchlist'), list('favourites', 31)] });
  const plan = planTraktImport(input, record);
  assert.equal(plan.ratings[0].after, 0);
  assert.equal(plan.ratings[0].row.rating, 8);
  assert.deepEqual(plan.changes.put.ratings, []);
  assert.deepEqual(plan.lists.map(p => [p.row.list, p.present]), [['WATCHLIST', false], ['watchlist', true], ['Favorites', false]]);
  assert.deepEqual(plan.changes.put.shows, []);
  assert.deepEqual(planTraktImport(source({ ratings: [rating(8)] }), local()).changes.put.shows, [show]);
  assert.deepEqual(planTraktImport(source(), local()).changes.put.shows, []);
});

test('An explicit Watchlist opt-out suppresses reimport from Trakt without changing custom lists or ratings', () => {
  const input=source({lists:[list('Watchlist'),list('Favorites')],ratings:[rating(8)]});
  const result=planTraktImport(input,local({lists:[list('HIDDEN FROM UPCOMING'),list('Archive')]}));
  assert.deepEqual(result.changes.put.lists.map(r=>r.list),['Favorites']);
  assert.equal(result.changes.put.ratings.length,1);
  assert.equal(result.changes.remove.lists,undefined);
});

test('Trakt adds an unstarted plan but suppresses it when either the export or the device has a watch', () => {
  const lists = [list('Watchlist'),list('Favorites')];
  const episode = {...watch(1),show_id:show.show_id};
  assert.deepEqual(planTraktImport(source({lists}),local()).changes.put.lists,lists);
  const fromFile = planTraktImport(source({lists,watched:[episode]}),local());
  const onDevice = planTraktImport(source({lists}),local({watched:[{...episode,season:0}]}));
  for (const plan of [fromFile,onDevice]) assert.deepEqual(plan.changes.put.lists,[list('Favorites')]);
  assert.deepEqual(fromFile.changes.put.watched,[episode]);
});

test('Favorites reuses earlier spellings and preserves unrelated custom names', () => {
  const placement=source({lists:[list('Favorites')]});
  const old=list('Favourites',10), other=list('My Favourites',12);
  const legacy=planTraktImport(placement,local({lists:[old,other]}));
  assert.deepEqual(legacy.changes.put.lists,[list('Favorites')]);
  assert.equal(legacy.lists[0].label,'Favorites');
  assert.deepEqual(planTraktImport(placement,local({lists:[old,other,...legacy.changes.put.lists]})).changes.put.lists,[]);

  const separate=planTraktImport(placement,local({lists:[old,other,list('Favorites',11)]}));
  assert.deepEqual(separate.changes.put.lists,[list('Favorites')]);
  assert.equal(separate.changes.remove.lists,undefined);
});

test('Known episode IDs can swap slots while preserving rewatches; occupied, reused or ambiguous slots keep their personal rows', () => {
  const input = source({ watched: [watch(1, 1, 22), watch(2, 2, 11), watch(1, 3, 33), watch(1, 4, 44), watch(1, 5, 55),
    watch(2, 7, 77), watch(1, 8, 88)] });
  input.reusedPositions.add(watchPosition(watch(1, 3)));
  const stored = [watch(4, 1, 11), watch(7, 2, 22), watch(3, 3, null), watch(1, 4, 55), watch(2, 5, 66),
    watch(3, 7, null), watch(1, 8, 88), watch(1, 9, 88)];
  const plan = planTraktImport(input, local({ watched: stored }));
  assert.deepEqual(plan.watched.map(e => [e.row.episode, e.after]), [[1, 7], [2, 4], [7, 3]]);
  assert.deepEqual(plan.changes.remove.watched, [[7, 1, 2], [7, 1, 1]]);
  assert.equal(plan.changes.put.watched.find(r => r.episode === 7).episode_id, 77);
  assert.equal(plan.skipped.length, 4);
});

test('An unchanged action set is stable across row ordering, while equal totals on different episodes and kept ratings require review', () => {
  const input = source({ watched: [watch(1), watch(1, 2)], ratings: [rating(8)] });
  const original = planTraktImport(input, local({ watched: [watch(1), watch(3, 91)] }));
  const reordered = planTraktImport(input, local({ watched: [watch(3, 91), watch(1)] }));
  const moved = planTraktImport(input, local({ watched: [watch(1, 2)], ratings: [rating(9)] }));
  assert.ok(sameImportOutcome(original,reordered));
  assert.equal(sameImportOutcome(original,moved),false);
  const lines = describeTraktChanges(moved, original).join('\n');
  assert.match(lines, /S1 E1/);
  assert.match(lines, /S1 E2/);
  assert.match(lines, /keep your rating 9 \(Trakt 8\)/);
  const both = [watch(1, 1, 71), { ...watch(1, 1, 71), show_id: 77, episode_id: 701 }];
  const sameLabels = source({ watched: both });
  const changed = planTraktImport(sameLabels, local({ watched: both }));
  const details = describeTraktChanges(changed, planTraktImport(sameLabels, local())).join('\n');
  assert.match(details, /TMDB episode 71\)/);
  assert.match(details, /TMDB episode 701\)/);
});

test('Approval compares exact row values and identities, including same-sized replacements and reordered review notes', () => {
  const episode = {...watch(3,1,71),title:'Fictional "Pilot"\nPart, one'};
  const input = {watched:[episode],ratings:[rating(8)],lists:[list('Favorites')],skipped:['A, B','C\nD']};
  const preview = overrides => planTraktImport(source({...input,...overrides}),local());
  const original = preview({});
  const entries = [...original.actions].map(([key,action])=>[key,{...action}]);
  const equivalent = preview({skipped:input.skipped.toReversed()});
  assert.ok(sameImportOutcome(original,equivalent));
  assert.deepEqual(describeTraktChanges(original,equivalent),[]);
  for (const changes of [
    {skipped:['A','B, C\nD']},
    {watched:[{...episode,title:'Fictional "Pilot",\nPart one'}]},
    {watched:[{...episode,episode_id:72}]},
    {ratings:[rating(7)]},
    {lists:[list('My list')]},
  ]) {
    const revised = preview(changes);
    assert.equal(original.actions.size,revised.actions.size);
    assert.equal(sameImportOutcome(original,revised),false);
    assert.equal(sameImportOutcome(revised,original),false);
    assert.ok(describeTraktChanges(revised,original).length);
  }
  assert.deepEqual([...original.actions],entries);
});

test('episode approval evidence keeps the reviewed counts, names and season labels until confirmation', () => {
  const proposed={...watch(2,2,71),show:'Coastal Dial',title:'Night Signal'};
  const previouslyWatched={...watch(1,1,71),show:'Coastal Dial',title:'Old Recording'};
  const order=[{number:1,sourceSeason:1,first:1,last:2,name:'Winter run'}];
  const input=source({watched:[proposed],broadcastByShow:new Map([[7,order]])});
  const current=local({watched:[previouslyWatched]});
  const approved=planTraktImport(input,current), equivalent=planTraktImport(input,current);
  const removed=planTraktImport(source(),local());
  const text=describeTraktChanges(removed,approved);
  assert.match(text.join(' '),/Winter run/);

  proposed.title='Changed input';
  previouslyWatched.times_watched=10;
  order[0].name='Revised mapping';
  approved.changes.put.watched[0].title='Changed proposed write';
  assert.ok(sameImportOutcome(approved,equivalent));
  assert.deepEqual(describeTraktChanges(removed,approved),text);
  assert.equal(sameImportOutcome(planTraktImport(input,current),approved),false);
});

test('Small imports compare all local positions in the imported show and ignore identical IDs in unrelated shows', () => {
  const input = source({watched:[watch(1,1,71),watch(1,2,72),watch(1,3,73)]});
  const own = [watch(4,4,71),watch(2,2,12),watch(1,3,73)];
  const other = own.flatMap(row => [17,27].map(show_id=>({...row,show_id})));
  other.push({...watch(8,2,71),show_id:17});
  const expected = planTraktImport(input,local({watched:own}));
  const mixed = planTraktImport(input,local({watched:[...other,...own]}));
  assert.ok(sameImportOutcome(expected,mixed));
  assert.deepEqual(mixed.changes,expected.changes);
  assert.deepEqual(mixed.changes.put.watched.map(row=>[row.episode,row.episode_id,row.times_watched]),[[1,71,4]]);
  assert.deepEqual(mixed.changes.remove.watched,[[7,1,4]]);
  assert.equal(mixed.skipped.length,1);
  const onlyRating = planTraktImport(source({ratings:[rating(6)]}),local({watched:[...other,...own]}));
  assert.deepEqual(onlyRating.watched,[]);
  assert.deepEqual(onlyRating.changes.put.ratings,[rating(6)]);
});

test('A long episode rotation keeps counts by identity through import, four-file recovery and repeated import', async () => {
  const size = 2048;
  const rows = Array.from({length:size}, (_, i) => watch(i === 0 ? Number.MAX_SAFE_INTEGER : i + 1, i + 1, i + 101));
  const input = source({ watched:rows.map((row, i) => ({...row, episode:(i + 1) % size + 1, times_watched:1})) });
  const snapshot = local({watched:rows, ratings:[rating(0)], lists:[list('Night; \nShows')], shows:[show]});
  const plan = planTraktImport(input, snapshot);
  assert.equal(plan.skipped.length, 0);
  assert.equal(plan.changes.remove.watched.length, size);
  assert.equal(plan.changes.put.watched.length, size);
  const files = recordExportFiles({tables:{...snapshot.tables, watched:plan.changes.put.watched},
    showMetadata:new Map(), externalIds:new Map()}, 0);
  const recovered = await readLocalRecord(files.reverse());
  const counted = new Map(recovered.watched.map(row => [row.episode_id, [row.episode, row.times_watched]]));
  for (const [i, row] of rows.entries()) assert.deepEqual(counted.get(row.episode_id), [(i + 1) % size + 1, row.times_watched]);
  assert.deepEqual(recovered.ratings, snapshot.tables.ratings);
  assert.deepEqual(recovered.lists, snapshot.tables.lists);
  const repeated = planTraktImport(input, local(recovered));
  assert.deepEqual(repeated.changes.remove.watched, []);
  assert.deepEqual(repeated.changes.put.watched, []);
});
