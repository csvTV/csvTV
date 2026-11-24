import assert from 'node:assert/strict';
import test from 'node:test';
import {broadcastCandidates,readBroadcastOrder,broadcastSource} from '../src/tmdb-broadcast.ts';
import {TmdbClient} from '../src/tmdb-client.ts';
import {TmdbService} from '../src/tmdb-service.ts';
import {broadcastSeasons} from '../src/broadcast-seasons.ts';

const id='1234567890abcdef12345678', other='2234567890abcdef12345678';
const show={show_id:500001,seasons:[{season:1,episodeCount:4},{season:2,episodeCount:2}]};
const ep=(s,n)=>({show_id:show.show_id,id:s*100+n,episode_number:n,season_number:s,order:n-1});
const group=(name,episodes)=>({name,episodes});
const order=()=>({id,type:1,groups:[
  group('Season 3',[ep(2,1),ep(2,2)]),group('Specials',[ep(0,1)]),
  group('Season 2',[ep(1,3),ep(1,4)]),group('Season 1',[ep(1,1),ep(1,2)])]});
const listing=(ids=[id])=>({seasons:[{season_number:1,id:441},{season_number:2,id:442}],
  episode_groups:{results:ids.map(id=>({id,type:1,name:'Air date',group_count:3}))}});

test('any show can split multiple native seasons from verified alternate-order episodes and keep later additions visible',()=>{
  const ranges=readBroadcastOrder(order(),id,show);
  assert.deepEqual(ranges?.map(r=>[r.number,r.sourceSeason,r.first,r.last]),[[1,1,1,2],[2,1,3,4],[3,2,1,2]]);
  const grown={...show,seasons:[show.seasons[0],{season:2,episodeCount:3}]};
  assert.deepEqual(readBroadcastOrder(order(),id,grown),ranges);
  const final=broadcastSeasons({...grown,broadcastOrder:ranges}).at(-1);
  assert.deepEqual([final.sourceSeason,final.first,final.last,final.unassigned],[2,3,3,true]);
  assert.deepEqual(broadcastCandidates(listing()),[id]);
  assert.equal(broadcastSource(listing(),[id]),broadcastSource({...listing(),seasons:listing().seasons.reverse()},[id]));
});

test('conflicting identities, missing middle episodes, cour partitions, relisted positions and permutations cannot create season boundaries',()=>{
  for(const change of [
    d=>{d.groups[2].episodes[0].show_id++}, d=>{d.groups[2].episodes[0].id=101},
    d=>{d.groups[2].episodes[0].episode_number++},d=>{d.groups[2].episodes[0].order=8},
    d=>{d.groups[2].episodes[0].season_number=2},d=>{d.groups[2].name='Cour 2'},
    d=>{d.groups[2].name='Season 3'},d=>{d.groups[2].episodes[0].order=3},
    d=>{d.groups[3].episodes.pop()}, d=>{d.id=other}, d=>{d.type=5},
  ]){
    const d=order();change(d);assert.equal(readBroadcastOrder(d,id,show),null);
  }
  const entries=listing().episode_groups.results;
  assert.deepEqual(broadcastCandidates({episode_groups:{results:[
    {...entries[0],id:'bad/group'}, {...entries[0],type:7,name:'Cours'}, {...entries[0],type:2},
    {...entries[0],id:other,type:7,name:'Broadcast Seasons'},
  ]}}),[other]);
});

test('alternate season calls share the credential gate, require agreement and safely tolerate an unavailable supplement',async()=>{
  const responses=new Map([[id,order()],[other,{...order(),id:other}]]),requests=[];
  const client=new TmdbClient({fetch:async(url,init)=>{
    requests.push(url);assert.equal(url.origin,'https://api.themoviedb.org');
    assert.equal(init.headers.Authorization,'Bearer fictional-test');
    const response=responses.get(url.pathname.split('/').at(-1));
    return response instanceof Response ? response : Response.json(response);
  }});
  const lookup=(ids,current=()=>true)=>client.broadcastOrder(listing(ids),show,'fictional-test',{current});
  assert.equal((await lookup([id,other])).order.length,3);
  const alternative=order();alternative.id=other;
  alternative.groups[2].episodes.unshift(alternative.groups[3].episodes.pop());
  responses.set(other,alternative);assert.equal((await lookup([id,other])).order,null);
  responses.set(id,new Response('',{status:404}));
  assert.equal((await lookup([id])).retrySource,broadcastSource(listing(),[id]));
  const prior=requests.length;
  await assert.rejects(lookup([id],()=>false),{kind:'superseded'});
  assert.equal(requests.length,prior);
});

test('a cold import discovers an unfamiliar show’s seasons and a temporary failure only retains the matching catalog order',async t=>{
  const header={...listing(),id:show.show_id,name:'Fictional shoreline',status:'Returning Series',
    seasons:listing().seasons.map((s,i)=>({...s,episode_count:show.seasons[i].episodeCount})),
    keywords:{results:[]},external_ids:{}};
  let missing=false,prior;
  const client=new TmdbClient({fetch:async url=>{
    if (url.pathname.endsWith('/'+show.show_id)){
      assert.ok(url.searchParams.get('append_to_response').split(',').includes('episode_groups'));
      return Response.json(header);
    }
    assert.equal(url.pathname,'/3/tv/episode_group/'+id);
    return missing ? new Response('',{status:404}) : Response.json(order());
  }});
  const store={role:'writer',tmdbState:async()=>({token:'fictional-test',generation:1n,refused:null}),
    tmdbEntry:async()=>prior,seasonOrderState:async()=>({})};
  const service=new TmdbService(store,client,{now:Date.now,visible:()=>true,online:()=>true});
  t.after(()=>service.close());
  const read=()=>service.fetchForImport({kind:'show',id:show.show_id},1n,()=>true);
  prior=await read();
  assert.deepEqual(broadcastSeasons(prior.value).map(r=>[r.sourceSeason,r.first,r.last]),[[1,1,2],[1,3,4],[2,1,2]]);
  missing=true;
  assert.deepEqual((await read()).value.broadcastOrder,prior.value.broadcastOrder);
  header.seasons[0].id++;
  assert.equal((await read()).value.broadcastOrder,undefined);
});
