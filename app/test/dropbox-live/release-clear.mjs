import assert from 'node:assert/strict';
import {until} from '../offline-chromium.mjs';
import {dummyKeys} from './release-ui.mjs';

/** Exercise the packaged Settings controls. Independent reads use the folder-ownership transport. */
export async function exerciseClear(browser,origin,{read,verifyKeys,verifyRecord,backups,onStage}) {
  const feedback = () => browser.evaluate("document.querySelector('[data-dropbox-feedback]')?.textContent");
  const available = selector => until(()=>browser.evaluate("!!document.querySelector("+JSON.stringify(selector+":enabled")+")?.getClientRects().length"),'available '+selector,90000);
  const findButton = label => browser.evaluate("Array.from(document.querySelectorAll('dialog[open] button')).findIndex(b=>b.textContent.trim()==="+JSON.stringify(label)+")");
  async function press(label) {
    const index = await findButton(label);
    assert.ok(index >= 0,'Missing '+label+' decision');
    await browser.evaluate("document.querySelectorAll('dialog[open] button')["+index+"].click()");
  }
  async function select(scopes,cancel=false) {
    onStage('review '+scopes.join(', '));
    await available('[data-clear-dropbox]');
    await browser.click('[data-clear-dropbox]');
    for (const scope of scopes) await browser.click('dialog[open] input[value="'+scope+'"]');
    await press('Review');
    await until(async ()=>{
      if (await findButton('Clear selected data') >= 0) return true;
      const status = await feedback();
      assert.ok(!status || status === 'Checking Dropbox…','Clear review failed');
      return false;
    },'the scoped confirmation',90000);
    if (cancel) { await press('Cancel'); return; }
    onStage('clear '+scopes.join(', '));
    await press('Clear selected data');
    await until(async ()=>{
      const status = await feedback();
      if (status === 'Selected Dropbox data cleared.') return true;
      assert.ok(!status || status === 'Checking Dropbox…','Clear failed');
      return false;
    },'successful completion',120000);
    await available('[data-clear-dropbox]');
  }
  await browser.navigate(origin+'/#/settings');
  await select(['ratings'],true);
  await verifyRecord(7,true);
  console.log('PASS · Cancel preserved the fictional watch record.');

  await select(['ratings']);
  assert.equal((await read('ratings')).rows.length,0);
  assert.equal((await read('watched')).rows[0]?.times_watched,1);
  assert.equal((await read('lists')).rows[0]?.list,'Watchlist');
  await verifyKeys();
  console.log('PASS · Ratings-only clear preserved watch history, Watchlist and the four fictional keys.');

  onStage('creating a backup');
  await available('[data-backup]');
  await browser.click('[data-backup]');
  await until(async ()=>(await feedback()) === 'Backup saved to Dropbox.','completed manual backup',120000);
  assert.ok((await backups()).length > 0,'Expected populated backup files');
  await select(['backups']);
  assert.equal((await backups()).length,0);
  assert.equal((await read('watched')).rows[0]?.times_watched,1);
  await verifyKeys();
  console.log('PASS · Backups-only clear removed the backup data and preserved current watches and keys.');

  await select(['watched','ratings','lists','settings','backups']);
  for (const table of ['watched','ratings','lists','shows']) assert.equal((await read(table)).rows.length,0,table);
  assert.ok(!(await read('settings')).rows.some(row=>Object.hasOwn(dummyKeys,row.setting)),'A fictional provider key survived');
  await browser.navigate('about:blank');
  await browser.navigate(origin+'/#/library');
  await until(()=>browser.evaluate("document.querySelector('#app')?.dataset.page === 'library' && document.querySelector('.sync-state')?.textContent === 'Synced' && !document.querySelector('.library-grid strong')"),'synced empty Library',120000);
  console.log('PASS · Full clear removed the fictional record and keys. The reopened Library stayed empty.');
}
