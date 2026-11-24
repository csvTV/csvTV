// The rendered preview has display text rather than database IDs. Match its outcomes
// as multisets, then check the changes in row and play totals. Keep all titles in memory.
const check = (ok,message) => { if (!ok) throw Error(message); };
const position = r => JSON.stringify([r.show_id,r.season,r.episode]);
const episodeId = r => JSON.stringify([r.show_id,r.episode_id]);
const membership = r => JSON.stringify([r.show_id,r.list]);
const bigSum = (rows,read) => rows.reduce((total,r)=>total+BigInt(read(r)),0n);

// One stored show can have several historic spellings, and distinct shows can share
// a display name. Assign each preview row a separate committed row.
function checkRows(lines,rows,render,label) {
  const candidates = new Map();
  for (const [index,row] of rows.entries()) {
    for (const line of new Set(render(row))) {
      if (!candidates.has(line)) candidates.set(line,[]);
      candidates.get(line).push(index);
    }
  }
  const assigned = new Map();
  function assign(line,seen) {
    for (const id of candidates.get(line) ?? []) {
      if (seen.has(id)) continue;
      seen.add(id);
      if (!assigned.has(id) || assign(assigned.get(id),seen)) { assigned.set(id,line); return true; }
    }
    return false;
  }
  for (const line of lines) check(assign(line,new Set()),'A reviewed '+label+' did not match the committed record.');
}

export function verifyActualPreview(preview,before,after,source) {
  const {summary,expected} = preview;
  const index = new Map(after.shows.map(r=>[r.show_id,r]));
  const oldIndex = new Map(before.shows.map(r=>[r.show_id,r]));
  const aliases = r => [...new Set([r.show,index.get(r.show_id)?.show,oldIndex.get(r.show_id)?.show].filter(s=>s!==undefined))];
  const byId = new Map(before.watched.filter(r=>r.episode_id!==null).map(r=>[episodeId(r),r]));
  const byPosition = new Map(before.watched.map(r=>[position(r),r]));
  checkRows(expected.episodes,after.watched,r=>{
    const atPosition = byPosition.get(position(r));
    const prior = (r.episode_id!==null && byId.get(episodeId(r))) || (atPosition?.episode_id===null ? atPosition : undefined);
    const moved = prior && position(r)!==position(prior) ? ' (from S'+prior.season+' E'+prior.episode+')' : '';
    const titles = prior && prior.title===r.title ? [r.title,''] : [r.title];
    return aliases(r).flatMap(name=>titles.map(title=>name+' · S'+r.season+' E'+r.episode+' · '+title+moved+' · '+
      (prior?.times_watched ?? 0)+' → '+r.times_watched+' plays'));
  },'episode');
  check(after.watched.length===before.watched.length+summary.newEpisodes,'The committed episode total did not match the preview.');
  check(bigSum(after.watched,r=>r.times_watched)-bigSum(before.watched,r=>r.times_watched)===BigInt(summary.playsAdded),
    'The committed play total did not match the preview.');

  const oldRatings = new Map(before.ratings.map(r=>[r.show_id,r.rating]));
  checkRows(expected.ratings,after.ratings,r=>aliases(r).map(name=>name+(oldRatings.has(r.show_id)?' · Keep ':' · Add ')+r.rating+'/10'),'rating');
  check(after.ratings.length===before.ratings.length+summary.addedRatings,'The committed rating total did not match the preview.');
  const finalRatings = new Map(after.ratings.map(r=>[r.show_id,r.rating]));
  check(before.ratings.every(r=>finalRatings.get(r.show_id)===r.rating),'A prior rating changed during import.');

  const priorLists = new Set(before.lists.map(membership)),finalLists = new Set(after.lists.map(membership));
  checkRows(expected.lists,after.lists,r=>aliases(r).map(name=>name+' · '+r.list+
    (priorLists.has(membership(r))?' · Already on list':' · Add')),'list membership');
  const anime = after.lists.filter(r=>r.list.toLowerCase()==='anime');
  const dropped = after.lists.filter(r=>r.list.toLowerCase()==='dropped');
  const droppedShows = [...new Map(dropped.map(r=>[r.show_id,r])).values()];
  const reviewedDrops = expected.dropped ?? [];
  checkRows(reviewedDrops,droppedShows,aliases,'dropped show');
  const priorDropIds = new Set(before.lists.filter(r=>r.list.toLowerCase()==='dropped').map(r=>r.show_id));
  const newDrops = droppedShows.filter(r=>!priorDropIds.has(r.show_id));
  const reviewedDropNames = new Set(reviewedDrops);
  check(newDrops.every(row=>aliases(row).some(name=>reviewedDropNames.has(name))),
    'An unreviewed show was marked Dropped.');
  if (source==='AniList') {
    const marked=new Set(anime.map(r=>r.show_id));
    checkRows(expected.shows,after.shows.filter(row=>marked.has(row.show_id)),row=>
      [row.show+(row.year===null?'':' ('+row.year+')')+(row.imdb_id?' · '+row.imdb_id:'')],'Anime classification');
  }
  const newTags=after.lists.filter(row=>['anime','dropped'].includes(row.list.toLowerCase()) && !priorLists.has(membership(row))).length;
  check(after.lists.length===before.lists.length+summary.addedMemberships+newTags && before.lists.every(r=>finalLists.has(membership(r))),
    'The committed list memberships did not match the reviewed additions.');

  // A parsed show without any placed episodes, ratings or memberships may be in
  // Matched shows without an index row. Only newly referenced shows must be written.
  const newShows = after.shows.filter(r=>!oldIndex.has(r.show_id));
  const matched = new Map();
  for (const line of expected.shows) matched.set(line,(matched.get(line) ?? 0)+1);
  for (const row of newShows) {
    const line = row.show+(row.year===null?'':' ('+row.year+')')+(row.imdb_id?' · '+row.imdb_id:'');
    check(matched.get(line)>0,'A newly committed show was absent from the matched-show preview.');
    matched.set(line,matched.get(line)-1);
  }
  check(before.shows.every(r=>index.has(r.show_id)),'A prior show disappeared from the index.');
}
