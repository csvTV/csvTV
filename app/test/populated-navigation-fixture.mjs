export async function seedRatedLibrary({withLists = false, showCount = 300, batchSize = 13500} = {}) {
  const {openDeviceStore} = await import('/storage.js');
  const {tmdbResourceKey} = await import('/tmdb-client.js');
  const store = await openDeviceStore();
  try {
    await store.whenWriter();
    const {session} = await store.dropboxState();
    store.connectProviderKeys(async () => { throw Error('Unexpected credential edit'); }, Date.now);
    await store.loadProviderKeys(session,[{setting:'tmdb_key',value:'fictional-offline-key'},
      {setting:'mdblist_key',value:'fictional-scores'}],()=>true);
    const watched = [], ratings = [], lists = [], entries = {}, scores = new Map(), imdb = [], fetchedAt = Date.now();
    function cache(resource,value) { entries[tmdbResourceKey(resource)] = {fetchedAt,value}; }
    for (let id=1;id<=showCount;id++) {
      const show = 'Signal Station '+id;
      const seasons = [1,2,3].map(season => ({season,episodeCount:15}));
      if (withLists && id % 5 === 0) lists.push({show_id:id,show,list:'Watchlist'});
      if (withLists && id % 4 === 0) lists.push({show_id:id,show,list:'Favorites'});
      ratings.push({show_id:id,show,rating:(id%17+4)/2});
      cache({kind:'show',id},{show_id:id,show,status:'Ended',posterPath:null,firstAirDate:'2013-01-02',genres:[],networks:[],
        keywords:id%3===0 ? [{id:210024,name:'anime'}]:[],originCountries:['US'],voteAverage:5+id%41/10,imdbId:'tt'+(1000000+id),
        seasons,lastAired:{season:3,episode:15},nextAirDate:null});
      cache({kind:'cast',id},Array.from({length:12},(_,i)=>({id:id*6+i+1,name:'Performer '+(id*6+i+1),
        profilePath:null,roles:['Character '+(i+1)],episodeCount:15})));
      for (const {season} of seasons) {
        const episodes = Array.from({length:15},(_,i)=>({episode:i+1,episode_id:id*10000+season*100+i+1,
          runtime:30,airDate:'2014-01-02',title:'Chapter '+(i+1)}));
        cache({kind:'season',id,season},{show_id:id,season,episodes});
        for (const ep of episodes) watched.push({show_id:id,show,season,episode:ep.episode,episode_id:ep.episode_id,
          title:ep.title,times_watched:ep.episode<=3 ? 2 : 1});
      }
      scores.set(id,{fetchedAt,scores:{tomatoes:60+id%41,metacritic:50+id%51,myanimelist:6+id%40/10}});
      imdb.push([['imdb','omdb','tt'+(1000000+id)],{at:fetchedAt,value:{rating:5+id%40/10}}]);
    }
    cache({kind:'countries'},[{code:'US',name:'United States'}]);
    const initial = (await store.snapshot()).revision;
    await store.commit(initial,{put:{ratings,lists,watched:watched.slice(0,batchSize),settings:[{setting:'imdb_source',value:'omdb'}]}});
    for (let i=batchSize;i<watched.length;i+=batchSize) {
      await store.commit((await store.devicePreference('appearance')).revision,{put:{watched:watched.slice(i,i+batchSize)}});
    }
    if (!await store.writeTmdb((await store.tmdbState()).generation,{entries}) ||
        !await store.writeMdbList((await store.mdbListState()).generation,{entries:scores}) ||
        !await store.writeImdb((await store.imdbState()).generation,{entries:imdb})) throw Error('Could not seed score caches');
  } finally { await store.closeForUpdate(); }
}
