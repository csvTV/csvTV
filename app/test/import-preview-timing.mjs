// Executed inside the tested browser. Metadata is already matched so these timings
// measure local review and export work separately from provider and Dropbox latency.
export async function measureImportPreview() {
  const [{planTraktImport},{planAniListImport},{recordExportFiles},{emptyTables}] = await Promise.all([
    import('/trakt-import.js'),import('/anilist-import.js'),import('/export-data.js'),import('/model.js')
  ]);
  const shows = [], watched = [], ratings = [], lists = [], entries = [], counts = [], notices = [], entryRanges = [];
  for (let id=1;id<=300;id++) {
    const title = {show_id:id,show:'Signal Station '+id};
    shows.push({...title,year:2020,imdb_id:''});
    ratings.push({...title,rating:8});
    if (id%5===0) lists.push({...title,list:'Watchlist'});
    entries.push({...title,id,score:80,status:2,progress:45,targetSeason:1,favourite:false});
    entryRanges.push({entryId:id,season:1,first:1,last:45});
    if (id<=20) {
      counts.push({...title,total:75,listedPlays:45,listedEpisodes:45,multiple:null});
      notices.push({kind:'rewatching',showId:id,text:title.show+' partially rewatched'});
    }
    for (let episode=1;episode<=45;episode++) watched.push({...title,season:1,episode,
      episode_id:id*100+episode,title:'Episode '+episode,times_watched:1});
  }
  const snapshot = {tables:emptyTables(),local:{}};
  const placement = {shows,watched,ratings,lists,skipped:[],counts,reusedPositions:new Set(),
    entries,notices,entryRanges,archive:{entries},reviewCandidates:new Map(),reviewLoadedSeasons:new Map(),
    reviewAmbiguousIds:new Map(),reviewSeasonNumbers:new Map()};
  const extras = new Map([[1,new Map([[1,1]])]]);
  const results = [];
  for (let run=0;run<3;run++) {
    const start=performance.now();
    const trakt=planTraktImport(placement,snapshot,new Set(),extras);
    const middle=performance.now();
    const ani=planAniListImport(placement,snapshot,{seasonExtras:extras});
    const end=performance.now();
    const files=recordExportFiles({tables:{...snapshot.tables,shows,watched,ratings,lists},showMetadata:new Map(),externalIds:new Map()},Date.now());
    results.push({trakt:Math.round(middle-start),anilist:Math.round(end-middle),csv:Math.round(performance.now()-end)});
    if ([trakt,ani].some(plan=>plan.watched.length!==13500 ||
        plan.watched.filter(edit=>edit.after===2).length!==45) || files.length!==4) throw Error('Incomplete bulk result');
  }
  return results;
}
