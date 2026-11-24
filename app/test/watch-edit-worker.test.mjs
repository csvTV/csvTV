import assert from 'node:assert/strict';
import test from 'node:test';
import {largeWatchEdit} from '../src/watch-edit-storage.ts';

test('the bulk watch writer accepts only watch rows, recent marks and removal of legacy recency',()=>{
  const row={show_id:12,show:'Pale Orchard',season:2,episode:1,episode_id:4501,title:'Oak',times_watched:2};
  const watched=Array(16).fill(row),recent={setting:'recently_marked.12.2.0.0',value:'99/99'};
  assert.equal(largeWatchEdit({put:{watched:watched.slice(1)}}),undefined);
  const patch={put:{watched:watched.slice(1),settings:[recent]},remove:{watched:[[12,1,1]]},removeLocal:['recentlyMarked']};
  assert.deepEqual(largeWatchEdit(patch),{put:patch.put.watched,remove:patch.remove.watched,recent:[recent],clearLegacy:true});
  for(const change of [
    {replace:{watched:[]}}, {local:{owner:'other'}}, {sync:{watched:null}}, {removeLocal:['dropboxSession']},
    {put:{watched,ratings:[]}}, {put:{watched,settings:[{...recent,setting:'tmdb_key'}]}}, {put:{watched,settings:[{...recent,value:'broken'}]}},
    {put:{watched,settings:[{...recent,undocumented:'x'}]}}, {put:{watched:[...watched,{...row,undocumented:'x'}]}},
    {remove:{watched:[[12,1,1,'other']]}}, {remove:{settings:['appearance']}},
  ])assert.equal(largeWatchEdit({put:{watched},...change}),undefined);
});
