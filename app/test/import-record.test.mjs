import assert from 'node:assert/strict';
import test from 'node:test';
import {supportedImport} from '../src/import-record.ts';

const watched=Array(32).fill({show_id:1,show:'Fictional Estuary',season:2,episode:1,episode_id:88,title:'Cove',times_watched:4});
test('only substantial import patches with known personal outcomes enter the background writer',()=>{
  assert.equal(supportedImport({put:{watched:watched.slice(1)}}),false);
  assert.equal(supportedImport({put:{watched:watched.slice(1)},remove:{watched:[[1,1,1]]}}),true);
  for(const patch of [
    {put:{watched,settings:[{setting:'recently_marked.1.2.0.0',value:'123/0'}]},removeLocal:['displacedRecentMark']},
    {put:{watched},local:{recentlyMarked:[3,1]}},
  ])assert.equal(supportedImport(patch),true);
  for(const patch of [
    {put:{watched},replace:{watched:[]}}, {put:{watched},sync:{settings:null}},
    {put:{watched,settings:[{setting:'tmdb_key',value:'fictional-key'}]}},
    {put:{watched,settings:[{setting:'recently_marked.1',value:'fictional-invalid-rank'}]}},
    {put:{watched},remove:{settings:['appearance']}}, {put:{watched},local:{syncAccountId:'fictional-account'}},
    {put:{watched},local:{recentlyMarked:['fictional-invalid-id']}}, {put:{watched},removeLocal:['dropboxSession']},
  ])assert.equal(supportedImport(patch),false);
});
