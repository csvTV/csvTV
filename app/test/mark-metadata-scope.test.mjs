import assert from 'node:assert/strict';
import test from 'node:test';
import {broadcastSeasons} from '../src/broadcast-seasons.ts';
import {markAired} from '../src/marks.ts';
import {tmdbResourceKey} from '../src/tmdb-client.ts';
import {TmdbService} from '../src/tmdb-service.ts';

const id = 751, today = '2026-11-23';
const key = season => tmdbResourceKey({kind:'season',id,season});

function fixture() {
  const header = {fetchedAt:10,value:{show_id:id,show:'Copper Harbour',
    seasons:[0,1,2,3,4].map(season => ({season,episodeCount:4})),lastAired:null,
    nextEpisode:{season:3,episode:4,airDate:'2027-01-01'},nextAirDate:'2027-01-01'}};
  const details = new Map(header.value.seasons.map(({season}) => [key(season),{fetchedAt:20,
    value:{season,episodes:Array.from({length:4},(_,i) => ({episode_id:id*1000+10*season+i,
      episode:i+1,title:'Chapter '+(i+1),airDate:'2020-07-02'}))}}]));
  const reads = [];
  const service = new TmdbService({tmdbEntries:async keys => {
    reads.push(keys);
    return keys.map(k => details.get(k));
  }}, {}, {now:()=>30});
  return {header,details,reads,service};
}

test('a scoped mark reads selected seasons and preserves any correction to the next episode', async () => {
  const {header,details,reads,service} = fixture();
  const full = await service.showInfo(id,header);
  assert.deepEqual(reads.pop(),[0,1,2,3,4].map(key));
  assert.equal(full.nextEpisode.airDate,'2020-07-02');
  for (const [scope,expected] of [[{season:2},[2,3]], [{season:2,through:2},[2,3]],
      [{season:0},[0,3]], [{season:3},[3]], [{},[1,2,3,4]]]) {
    const current = await service.showInfo(id,header,undefined,scope);
    assert.deepEqual(reads.pop(),expected.map(key));
    assert.deepEqual(current.seasons.map(s => [s.season,s.episodeCount]),full.seasons.map(s => [s.season,s.episodeCount]));
    assert.deepEqual(current.nextEpisode,full.nextEpisode);
    assert.deepEqual(markAired([],current,today,scope,'mark'),markAired([],full,today,scope,'mark'));
  }
  details.set(key(3),{fetchedAt:20,value:null});
  assert.equal((await service.showInfo(id,header,undefined,{season:2})).nextEpisode,null);
  details.set(key(3),{fetchedAt:1,value:null});
  assert.deepEqual((await service.showInfo(id,header,undefined,{season:2})).nextEpisode,header.value.nextEpisode);
});

test('a manual broadcast season retains its placement and rejects an unknown or unavailable native season', async () => {
  const {header,details,reads,service} = fixture();
  header.value.nextEpisode = null;
  header.value.nextAirDate = null;
  header.value.seasons = header.value.seasons.filter(s => s.season === 2);
  header.value.manualSeasonOrder = '2/4:2';
  const full = await service.showInfo(id,header);
  const second = broadcastSeasons(full)[1], scope = {season:2,broadcast:second};
  const current = await service.showInfo(id,header,undefined,scope);
  assert.deepEqual(reads.pop(),[key(2)]);
  assert.deepEqual(markAired([],current,today,scope,'again').rows.map(r => [r.season,r.episode]),[[2,3],[2,4]]);
  assert.deepEqual(markAired([],current,today,scope,'again'),markAired([],full,today,scope,'again'));
  const missing = await service.showInfo(id,header,undefined,{season:7});
  assert.deepEqual(reads.pop(),[]);
  assert.throws(()=>markAired([],missing,today,{season:7},'again'),/Unknown season/);
  details.delete(key(2));
  const unavailable = await service.showInfo(id,header,undefined,scope);
  assert.throws(()=>markAired([],unavailable,today,scope,'again'),/detail is required/);
});
