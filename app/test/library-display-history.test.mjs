import assert from 'node:assert/strict';
import test from 'node:test';
import {createLibraryHistory} from '../dist/library-history.js';
import {cacheExpiresAt} from '../dist/tmdb-refresh.js';
import {localCalendarDate} from '../dist/progress.js';

const date = new Date(2030,0,30,10).getTime();
const stamp = {account:'fictional-first',erased:7n,revision:13n};
const show = {id:1,title:'Signal Garden',posterPath:null,rating:8,lists:['Favorites'],missing:false,
  metadata:{overview:'Unused public synopsis',keywords:[{id:1,name:'anime'}],originCountries:['KR']},
  progress:{recordedEpisodes:12,watchedAired:12,aired:12,complete:true,moreToWatch:false,
    seasons:[{season:1,unused:'Unused season details'}],plays:24n}};
const view = {shows:[show],listNames:['Favorites'],config:null,today:'2030-01-30'};
const cache = {readable:true,details:new Map(),seasons:new Map()};
function fixture(){
  const end=new AbortController();
  const store=Object.assign(new EventTarget(),{role:'writer'});
  const history=createLibraryHistory(store,end.signal),save=(value=view,metadata=cache,now=date)=>history.save(history.generation,stamp,value,metadata,now);
  return {end,store,history,save,read:(now=date,record=stamp)=>history.read(now,record)};
}

test('Library retains one compact display and refuses oversized, expired or unreadable snapshots',async()=>{
  const {read,save,history}=fixture();save();
  const [card]=(await read()).overview.shows;
  assert.deepEqual(card.metadata,{keywords:[{name:'anime'}],originCountries:['KR']});
  assert.deepEqual(Object.keys(card.progress).sort(),['aired','complete','moreToWatch','recordedEpisodes','watchedAired']);
  assert.equal(card.rating,8);
  for (const large of [{...view,shows:Array(1025).fill(show)}, {...view,shows:[{...show,lists:Array(4097).fill('A')}]},
    {...view,shows:[{...show,title:'x'.repeat(262145)}]}, {...view,listNames:Array(4097).fill('A')},
    {...view,config:{secureBaseUrl:'x'.repeat(262145),posterSizes:[]}}]) {
    save(large);assert.equal(history.available,false);
  }
  save(view,{...cache,readable:false});assert.equal(await read(),undefined);
  const fetched=new Date(2029,6,31,11).getTime(),deadline=cacheExpiresAt(fetched),earlier=deadline-60000;
  for(const field of ['config','details','seasons']){
    const metadata=field==='config'?{...cache,configFetchedAt:fetched}:{...cache,[field]:new Map([[1,{fetchedAt:fetched}]])};
    save({...view,today:localCalendarDate(new Date(earlier))},metadata,earlier);assert.ok(await read(deadline-1));assert.equal(await read(deadline),undefined);
  }
  save();const midnight=new Date(date);midnight.setHours(24,0,0,0);assert.ok(await read(midnight.getTime()-1));assert.equal(await read(midnight.getTime()),undefined);
  save();assert.equal(await read(date-1),undefined);
  save({...view,today:'2030-01-31'});assert.equal(await read(date),undefined,'Same instant, different local date');
});

test('Library rejects changed owners, erases and revisions and releases its display after invalidation',async()=>{
  const {save,read,store,history,end}=fixture();
  for(const difference of [{account:'fictional-second'},{erased:8n},{revision:14n}]) {
    save();assert.equal(read(date,{...stamp,...difference}),undefined);
  }
  for(const event of ['recordchange','exportchange','deviceerased','dropboxchange','rolechange','tmdbmetadata','providerkeyschange']){
    save();store.dispatchEvent(new Event(event));assert.equal(history.available,false);
  }
  const previous=history.generation;history.clear();history.save(previous,stamp,view,cache,date);assert.equal(read(),undefined);
  store.role='reader';save();assert.equal(await read(),undefined);
  store.role='writer';save();end.abort();assert.equal(history.available,false);
  save();assert.equal(history.available,false);
});
