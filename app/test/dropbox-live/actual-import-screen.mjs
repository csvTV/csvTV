import {setTimeout as delay} from 'node:timers/promises';
import {readPageRecord} from './actual-import-verify.mjs';
import {verifyActualPreview} from './actual-import-preview.mjs';

// Executed in the page. Never return private review notices, titles or filenames for logging.
async function readPreview(host) {
  const integer = text => {
    const digits = text.replace(/[,\s\u00a0\u202f]/g,'');
    if (!/^\d+$/.test(digits) || !Number.isSafeInteger(Number(digits))) throw Error('Invalid preview count.');
    return Number(digits);
  };
  const totals = Object.fromEntries([...host.querySelectorAll('.import-totals > div')].map(tile=>
    [tile.querySelector('dt').textContent,integer(tile.querySelector('dd').textContent)]));
  const countEditors = [...host.querySelectorAll('[data-count-review]')];
  let reviewNotices=0, optionalCountCorrections=0;
  for (const editor of countEditors) {
    const collapsed=editor.querySelector('[data-count-summary][aria-expanded=false]');
    collapsed?.click();
    reviewNotices+=editor.querySelectorAll('[data-anilist-review-notice]').length;
    if (editor.querySelector('[data-whole-add]:enabled, [data-season-add]:enabled, [data-season-remove]:enabled')) optionalCountCorrections++;
    collapsed?.click();
  }
  const summary = {matchedShows:totals.Shows,placedEpisodes:totals['Episodes placed'],ratings:totals.Ratings,
    listEntries:totals['List entries'],newEpisodes:0,playsAdded:'0',addedRatings:0,keptRatings:0, differingRatings:0,
    addedMemberships:0,existingMemberships:0,skipped:0,skippedRecordChanges:0,skippedEntries:0,ambiguousPlacements:0,
    unplacedEpisodes:0,unplacedNotices:0,reviewNotices,averagedRatings:0,seasonMatchGroups:0,
    countDiscrepancies:host.closest('.trakt-import') ? countEditors.length : 0,optionalCountCorrections};
  if (host.querySelector('[data-count-review][data-adjusted], [data-count-show][aria-pressed=true]')) throw Error('An optional repeat correction was preselected.');
  const expected = {shows:[],episodes:[],ratings:[],lists:[],dropped:[]};
  let plays = 0n;
  for (const group of host.querySelectorAll('details')) {
    if (group.closest('[data-count-review]')) continue;
    const heading = group.querySelector('summary').textContent;
    const normal = /^(.*?) \(([^()]*)\)$/.exec(heading);
    const gap = /^Could not place · (.+?) episodes?$/.exec(heading);
    if (!normal && !gap) throw Error('Unknown import preview heading.');
    group.open = true;
    const more = group.querySelector('button'), list = group.querySelector('ul');
    while (!more.hidden) {
      const prior = list.childElementCount;
      more.click();
      if (list.childElementCount <= prior && !more.hidden) throw Error('The preview did not advance to its next page.');
      if (list.childElementCount % 1000===0) await new Promise(resolve=>setTimeout(resolve,0));
    }
    const lines = [...list.children].map(row=>row.textContent);
    if (gap) { summary.unplacedEpisodes=integer(gap[1]); summary.unplacedNotices=lines.length; continue; }
    if (integer(normal[2])!==lines.length) throw Error('A preview section did not load every entry.');
    switch (normal[1]) {
      case 'Matched shows': expected.shows=lines; break;
      case 'Dropped shows': expected.dropped=lines; break;
      case 'Episode placements':
        expected.episodes=lines;
        for (const line of lines) {
          const numbers = / · (\d+) → (\d+) plays$/.exec(line);
          if (!numbers) throw Error('An episode count could not be verified.');
          if (numbers[1]==='0') summary.newEpisodes++;
          plays+=BigInt(numbers[2])-BigInt(numbers[1]);
        }
        break;
      case 'Show ratings':
        for (const line of lines) {
          const kept = / · Keep [\d.]+\/10( · (?:Trakt|AniList) [\d.]+\/10)$/.exec(line);
          if (kept) { summary.keptRatings++; expected.ratings.push(line.slice(0,-kept[1].length)); }
          else if (/ · Add [\d.]+\/10$/.test(line)) { summary.addedRatings++; expected.ratings.push(line); }
          else throw Error('A rating outcome could not be verified.');
        }
        break;
      case 'List memberships':
        expected.lists=lines;
        for (const line of lines) {
          if (line.endsWith(' · Already on list')) summary.existingMemberships++;
          else if (line.endsWith(' · Add')) summary.addedMemberships++;
          else throw Error('A list outcome could not be verified.');
        }
        break;
      case 'Skipped': summary.skipped=lines.length; break;
      case 'Skipped record changes': summary.skippedRecordChanges=lines.length; break;
      case 'Skipped entries': summary.skippedEntries=lines.length; break;
      case 'Different ratings': summary.differingRatings=lines.length; break;
      case 'Entries to review': summary.reviewNotices+=lines.length; break;
      case 'AniList season matches': summary.seasonMatchGroups=lines.length; break;
      case 'Ratings from differing scores': summary.averagedRatings=lines.length; break;
      default: throw Error('Unrecognized import preview section.');
    }
    if (normal[1]==='Skipped' || normal[1]==='Skipped entries') {
      summary.ambiguousPlacements+=lines.filter(line=>line.endsWith('Ambiguous TMDB episode placement.') ||
        line.endsWith('The mapping gives conflicting placements.')).length;
    }
  }
  summary.playsAdded=String(plays);
  summary.droppedShows=expected.dropped.length;
  if (expected.shows.length!==summary.matchedShows || expected.episodes.length!==summary.placedEpisodes ||
    expected.ratings.length!==summary.ratings || expected.lists.length!==summary.listEntries) throw Error('The preview totals and details differ.');
  return {summary,expected};
}

function progressState(submitted) {
  const screen=document.querySelector('.import-screen');
  if (!screen) return {phase:'interrupted'};
  const status=screen.querySelector('[data-status]').textContent;
  const dialog=document.querySelector('dialog[open]');
  if (dialog) {
    const changed=dialog.querySelector('summary')?.textContent.match(/^Changed outcomes \(([^()]*)\)$/);
    return {phase:'review',changed:changed?Number(changed[1].replace(/[,\s]/g,'')):null};
  }
  if (status.startsWith('Import complete.')) return {phase:'committed'};
  if (!submitted && screen.querySelector('.import-totals')) return {phase:'preview'};
  if (submitted && !screen.querySelector('[data-apply]').disabled && !status.startsWith('On confirmation,')) return {phase:'failed'};
  if (!submitted && status && screen.querySelector('[data-cancel]').hidden) return {phase:'failed'};
  if (status.startsWith('Syncing')) return {phase:'preflight sync'};
  if (status.startsWith('Backing up')) return {phase:'backup'};
  const match=/([\d,]+) lookups completed/.exec(status);
  return match?{phase:'matching',lookups:Number(match[1].replaceAll(',',''))}:{phase:submitted?'confirming':'reading or matching'};
}

/** Exercise both chooser and import UI, preserving the default repeat-count choices. */
export async function importActualFile(page,{source,file,onProgress,onReview}) {
  if (!['Trakt','AniList'].includes(source)) throw Error('Unexpected export source.');
  let step='checking the original record', lastActivity=Date.now(), lastReport='', reportedAt=0, changed;
  const activity=response=>{
    const host=new URL(response.url()).hostname;
    if (host==='api.themoviedb.org' || host==='raw.githubusercontent.com' || host.endsWith('.dropboxapi.com')) lastActivity=Date.now();
  };
  page.on('response',activity);
  async function waitForStage(submitted) {
    let previous='';
    for (;;) {
      const state=await page.evaluate(progressState,submitted), label=JSON.stringify(state);
      if (label!==previous) { previous=label; lastActivity=Date.now(); }
      if (label!==lastReport && (Date.now()-reportedAt>=30000 || state.phase!=='matching')) {
        lastReport=label; reportedAt=Date.now(); await onProgress?.({source,...state});
      }
      if (state.phase==='review') {
        changed=state.changed;
        await onReview?.({source,changedOutcomes:changed});
        throw Error('Review required.');
      }
      if (['failed','interrupted'].includes(state.phase)) throw Error('The app stopped the import.');
      if (state.phase===(submitted?'committed':'preview')) return;
      if (Date.now()-lastActivity>30*60*1000) throw Error('The import stopped reporting progress.');
      await delay(1000);
    }
  }
  try {
    const before=await readPageRecord(page);
    step='opening the file chooser';
    await page.getByRole('link',{name:'Import from '+source,exact:true}).click();
    const screen=page.locator('.import-screen'),picker=screen.locator('input[type=file]:enabled');
    await picker.waitFor({state:'visible',timeout:180000});
    const [chooser]=await Promise.all([page.waitForEvent('filechooser'),picker.click({position:{x:22,y:15}})]);
    const accepted=(await chooser.element().getAttribute('accept') ?? '').split(',');
    if (chooser.isMultiple() || !accepted.includes(source==='Trakt'?'.zip':'.json')) throw Error('The chooser did not accept this file type.');
    step='matching the export';
    await chooser.setFiles(file);
    await waitForStage(false);
    step='reading the complete preview';
    const preview=await screen.locator('[data-preview]').evaluate(readPreview);
    await onProgress?.({source,phase:'reviewed',...preview.summary});
    const button=screen.locator('[data-apply]');
    const noChanges=await button.isHidden();
    if (noChanges) {
      const message = await screen.locator('[data-status]').textContent();
      if (!['No entries can be imported from this file.', 'No entries selected for import.'].includes(message)) throw Error('Missing import confirmation.');
    } else {
      step='syncing, backing up and committing';
      await button.click({timeout:180000});
      await waitForStage(true);
    }
    step='comparing each reviewed outcome with the committed record';
    const after=await readPageRecord(page);
    verifyActualPreview(preview,before,after,source);
    return {summary:{...preview.summary,committed:!noChanges}};
  } catch {
    // Playwright exceptions can contain paths, private file names, titles or secret form values.
    throw Error(changed!==undefined?source+' requires another decision about '+(changed ?? 'unknown')+' updated outcomes.':
      source+' verification stopped while '+step+'.');
  } finally { page.off('response',activity); }
}
