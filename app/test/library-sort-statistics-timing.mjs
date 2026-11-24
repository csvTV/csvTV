// This benchmark observes the packaged UI and leaves application and IndexedDB methods intact.
async function sortAndVisit({navigation,shows,settle,verifyUpload}) {
  const frame = () => new Promise(done=>requestAnimationFrame(done));
  const select = document.querySelector('.library-selects select[aria-label=Sort]');
  const destination = document.querySelector(navigation);
  if (!select || select.disabled || !destination) throw Error('Library sort and Statistics must be available');
  async function waitForUpload(value,previousRevision) {
    const deadline = performance.now()+45000;
    while (performance.now()<deadline) {
      if (document.querySelector('.sync-state')?.dataset.synced==='true') {
        const saved = await window.fictionalLibrarySort();
        if (saved?.value===value && saved.revision!==previousRevision) return saved.revision;
      }
      await frame();
    }
    throw Error('Dropbox did not confirm the selected Library order');
  }
  const priorRevision = settle && verifyUpload ? await waitForUpload(select.value) : undefined;
  const sort = select.value === 'title' ? 'rating' : 'title';
  select.focus();
  select.value = sort;
  select.dispatchEvent(new Event('change',{bubbles:true}));
  await frame();
  if (select.value!==sort) throw Error('The selected Library order was lost');
  const first = document.querySelector('.library-grid [data-library-show]');
  if (sort === 'rating' ? !first?.querySelector('.library-rating')?.textContent.includes('10/10') :
      first?.getAttribute('data-library-show')!=='1') throw Error('Library did not adopt '+sort+' order');
  if (settle && verifyUpload) await waitForUpload(sort,priorRevision);
  else if (settle) await new Promise(done=>setTimeout(done,1500));
  const count = key=>document.querySelector('[data-stat='+key+'] dd')?.textContent;
  const dots = key=>document.querySelector('[data-chart='+key+'] .stats-dots path')?.getAttribute('d')?.split('M').length-1;
  const totals = {shows, seasons:shows*3, episodes:shows*45, plays:shows*54};
  const values = Object.entries(totals).map(([key,value])=>[key,value.toLocaleString()]);
  const hours = (shows*27).toLocaleString();
  let personal, full;
  const start = performance.now();
  destination.click();
  // Record the first frame *after* each milestone, so both figures include a paint.
  for (let hadPersonal=false,hadFull=false; performance.now()-start<30000;) {
    await frame();
    const elapsed = Math.round(performance.now()-start);
    if (hadPersonal && personal === undefined) personal = elapsed;
    if (hadFull) { full = elapsed; break; }
    hadPersonal = values.every(([key,value])=>count(key)===value);
    hadFull = hadPersonal && count('hours')===hours && !!document.querySelector('[data-chart=cast]') &&
      ['tmdb','tomatoes','metacritic','imdb','myanimelist'].every(key=>dots(key)===shows);
  }
  if (full===undefined) throw Error('Statistics failed to show the complete fixture: '+document.querySelector('main')?.innerText.slice(0,400));
  return {sort,personal,full};
}

export async function measureLibrarySortToStatistics(page,visibleNav,shows,repeats,afterSync,verifyUpload=false) {
  const timings = [];
  const libraryReady = () => page.waitForFunction(count=>{
    const cards = document.querySelectorAll('.library-grid [data-library-show]');
    return cards.length===count && cards[0]?.querySelector('.library-status-trigger')?.textContent==='Complete' &&
      !!document.querySelector('.library-selects select[aria-label=Sort]:enabled');
  },shows);
  for (let pass=0;pass<repeats;pass++) {
    // Invert the order of the two controls to avoid always giving one a warmer OS cache.
    for (const settle of pass%2 ? [true,false] : [false,true]) {
      for (const cold of [true,false]) {
        const nav = await visibleNav('library');
        await page.locator(nav).click();
        await libraryReady();
        if (cold) {
          await page.reload();
          await libraryReady();
          // Restoring provider keys after reopening invalidates all score projections.
          // In the normal signed-in case, finish that independent work before timing.
          if (afterSync) await page.waitForFunction(()=>
            document.querySelector('.sync-state')?.dataset.synced==='true' &&
            !!document.querySelector('.library-selects select[aria-label=Sort] option[value=tomatoes]'),
            undefined,{timeout:120000});
        }
        const navigation = await visibleNav('statistics');
        const result = await page.evaluate(sortAndVisit,{navigation,shows,settle,verifyUpload});
        timings.push({pass,settle,cold,...result});
        console.log('Statistics '+(cold?'first visit':'return')+' '+(settle ? (verifyUpload?'uploaded':'settled') : 'immediate')+' '+
          result.personal+' ms personal / '+result.full+' ms full');
      }
    }
  }
  return timings;
}
