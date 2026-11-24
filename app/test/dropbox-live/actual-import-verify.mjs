import {csvColumns} from '../../dist/csv.js';
import {isAnimeClassification} from '../../dist/anime.js';
import {rowKey} from '../../dist/model.js';
import {orderedListNames} from '../../dist/personal-record.js';
import {dropMembership,upcomingMembership,visibleListRows} from '../../dist/upcoming-preference.js';

const tables = ['watched','ratings','lists','shows'];
const timeout = 180_000;

/** Read only the four public record tables, together in one readonly transaction. */
export async function readPageRecord(page) {
  return page.evaluate(async () => {
    const {openDeviceStore} = await import('/storage.js');
    const store = await openDeviceStore();
    try { return await store.overviewRows(); }
    finally { store.close(); }
  });
}

export async function readDropboxRecord(transport) {
  const files = await Promise.all(tables.map(table=>transport.read(table)));
  const record = {}, revisions = {};
  for (const [i, table] of tables.entries()) {
    record[table] = files[i].rows;
    revisions[table] = files[i].rev;
  }
  return {record,revisions};
}

/** Compare every CSV field under its exact record key. Errors disclose counts only. */
export function compareRecords(reference, candidate, label = 'Record comparison') {
  const mismatches = [];
  for (const table of tables) {
    const expected = new Map(reference[table].map(row=>[rowKey(table,row), row]));
    const actual = new Map(candidate[table].map(row=>[rowKey(table,row), row]));
    const duplicates = reference[table].length - expected.size + candidate[table].length - actual.size;
    let changed = 0, missing = 0, extra = 0;
    for (const [key,row] of expected) {
      const other = actual.get(key);
      if (!other) missing++;
      else if (csvColumns[table].some(field=>row[field] !== other[field])) changed++;
    }
    for (const key of actual.keys()) if (!expected.has(key)) extra++;
    if (missing || extra || changed || duplicates) mismatches.push(
      table+' ('+missing+' missing, '+extra+' extra, '+changed+' changed, '+duplicates+' duplicate keys)');
  }
  if (mismatches.length) throw Error(label+' failed on '+mismatches.join(', ')+'.');
}

export function recordCounts(record) {
  const plays = record.watched.reduce((sum,row)=>sum+BigInt(row.times_watched),0n);
  return {
    shows:record.shows.length, libraryShows:new Set(record.watched.map(row=>row.show_id)).size,
    episodes:record.watched.length, plays:plays<=BigInt(Number.MAX_SAFE_INTEGER) ? Number(plays) : String(plays),
    ratings:record.ratings.length, memberships:record.lists.length, populatedLists:new Set(record.lists.map(row=>row.list)).size,
  };
}

async function screenCheck(page, predicate, expected, failure) {
  try {
    const result = await page.waitForFunction(predicate,expected,{timeout,polling:350});
    await result.dispose();
  } catch { throw Error(failure); }
}
async function navigate(page,screen) {
  await page.evaluate(screen=>{location.hash='#/'+screen;},screen);
  await screenCheck(page,name=>document.querySelector('#app')?.dataset.page===name,screen,'Could not open '+screen+'.');
}

function libraryMatches(expected) {
  const cards = document.querySelectorAll('.library-grid a[data-show-id]');
  if (cards.length !== expected.length || !document.querySelector('.library-count')?.textContent) return false;
  const ids = new Map(expected.map(show=>[String(show.id),show]));
  for (const card of cards) {
    const show = ids.get(card.dataset.showId);
    if (!show || card.getAttribute('href') !== '#/show/'+show.id) return false;
    ids.delete(card.dataset.showId);
    const title = card.querySelector('strong')?.textContent;
    if (!title || (show.titles.length && !show.titles.includes(title))) return false;
    if ((card.closest('li')?.querySelector('.library-rating')?.textContent ?? null) !== show.rating) return false;
  }
  return !ids.size;
}

function listMatches({name,members}) {
  if (document.querySelector('#chosen-list')?.textContent !== name) return false;
  const rows = document.querySelectorAll('.list-shows > li');
  if (rows.length !== members.length) return false;
  const ids = new Map(members.map(m=>['#/show/'+m.id,m.rating]));
  for (const row of rows) {
    const link = row.querySelector('a'), href = link?.getAttribute('href');
    if (!ids.has(href) || !link.querySelector('strong')?.textContent ||
      (row.querySelector('.list-rating')?.textContent ?? null) !== ids.get(href)) return false;
    ids.delete(href);
  }
  return !ids.size;
}

/** Check all rendered Library cards and all list chips and members. End on Library. */
export async function verifyRecordScreens(page,record) {
  const references = new Set();
  for (const name of ['watched','ratings','lists']) for (const row of record[name]) references.add(row.show_id);
  const index = new Set(record.shows.map(row=>row.show_id));
  if (references.size!==index.size || [...references].some(id=>!index.has(id))) {
    throw Error('The synced show index does not exactly cover the watched, rated and listed shows.');
  }
  const rating = new Map(record.ratings.map(row=>[row.show_id,String(row.rating)+'/10']));
  const watched = new Map();
  for (const {show_id,show} of record.watched) {
    if (!watched.has(show_id)) watched.set(show_id,new Set());
    if (show) watched.get(show_id).add(show);
  }
  const fallback = new Map();
  for (const {show_id,show} of [...record.ratings,...record.lists,...record.shows]) {
    if (show && !fallback.has(show_id)) fallback.set(show_id,show);
  }
  const expected = [...watched].map(([id,titles])=>({id,rating:rating.get(id)??null,
    titles:titles.size ? [...titles] : fallback.has(id) ? [fallback.get(id)] : []}));
  await navigate(page,'library');
  await screenCheck(page,libraryMatches,expected,'Library did not match all watched show IDs, titles and personal ratings.');

  const droppedIds = new Set(record.lists.filter(row=>dropMembership(row.list)==='dropped').map(row=>row.show_id));
  const dropToggle = page.locator('.library-screen [data-filter="dropped"]');
  await dropToggle.click({timeout});
  const expectedDrops = [...droppedIds].map(id=>({id,rating:rating.get(id)??null,
    titles:watched.has(id) ? [...watched.get(id)] : fallback.has(id) ? [fallback.get(id)] : []}));
  await screenCheck(page,libraryMatches,expectedDrops,'The Dropped filter did not match the saved statuses.');
  await dropToggle.click({timeout});

  const visible=visibleListRows(record.lists,false,watched);
  await navigate(page,'watchlist');
  await screenCheck(page,(ids)=>{
    const page=document.querySelector('.watchlist-screen');
    if(!page)return false;
    const links=[...page.querySelectorAll('[data-section="upcoming"] .watch-rows a,[data-section="available"] .watch-rows a')]
      .map(a=>a.getAttribute('href')).sort();
    return links.length===ids.length && links.every((value,i)=>value===ids[i]);
  },visible.filter(row=>row.list==='Watchlist').map(row=>'#/show/'+row.show_id).sort(),'Watchlist did not show the expected members.');

  await navigate(page,'lists');
  const custom=visible.filter(row=>!upcomingMembership(row.list) && !dropMembership(row.list) && !isAnimeClassification(row.list));
  const names = orderedListNames(custom).filter(name=>!upcomingMembership(name));
  const groups = new Map(names.map(name=>[name,[]]));
  for (const row of custom) groups.get(row.list).push({id:row.show_id,rating:rating.get(row.show_id)??null});
  const chips = '.list-chips button[data-list-focus^="chip/"]';
  await screenCheck(page,({selector,lists})=>{
    const controls = [...document.querySelectorAll(selector)];
    return controls.length===lists.length && controls.every((button,index)=>
      button.dataset.listFocus==='chip/'+lists[index].name && button.querySelector('span')?.textContent===String(lists[index].size));
  },{selector:chips,lists:names.map(name=>({name,size:groups.get(name).length}))},'Rendered list names or membership counts differ.');
  for (const [index,name] of names.entries()) {
    try { await page.locator(chips).nth(index).click({timeout}); }
    catch { throw Error('Could not select a list for membership verification.'); }
    await screenCheck(page,listMatches,{name,members:groups.get(name)},'A list did not display the expected show IDs and personal ratings.');
  }
  await navigate(page,'library');
  await screenCheck(page,libraryMatches,expected,'Library failed to retain its watches and ratings after returning from Lists.');
}
