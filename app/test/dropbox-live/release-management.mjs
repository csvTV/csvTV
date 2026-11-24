import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {writeCsv} from '../../dist/csv.js';
import {until} from '../offline-chromium.mjs';
import {sampleRecord} from './release-ui.mjs';

/** Restore an older backup after merging a watch count and a list membership. */
export async function exerciseManagement(browser,origin,{read,verifyKeys,verifyRecord,backups,profile,listRequests,onStage}) {
  const wait = (expression,label) => until(()=>browser.evaluate(expression),label,180000);
  const setting = () => browser.navigate(origin+'/#/settings');
  const enabled = selector => "!!document.querySelector("+JSON.stringify(selector+':enabled')+")?.getClientRects().length";
  const ready = 'document.querySelector("[data-cloud-reason]")?.textContent === "Synced" && '+enabled('[data-backup]');
  const completed = async () => (await backups()).filter(entry=>entry.name==='completion.json').map(entry=>entry.path_lower.split('/')[2]);
  async function sync() {
    await setting();
    await wait(enabled('[data-sync]'),'available Sync now button');
    const before=listRequests();
    await browser.click('[data-sync]');
    await until(async ()=>listRequests()>before && await browser.evaluate(ready),'live request and completed manual sync',180000);
  }
  onStage('explicit manual sync');
  await sync();
  await verifyRecord(7,true);
  console.log('PASS · Sync now issued a Dropbox request and reconciled the original watched episode, rating and Watchlist.');
  onStage('back up current record');
  const beforeBackup=new Set(await completed());
  await browser.click('[data-backup]');
  await wait("document.querySelector('[data-dropbox-feedback]')?.textContent === 'Backup saved to Dropbox.'",'manual backup');
  const newFolders=(await completed()).filter(name=>!beforeBackup.has(name));
  assert.equal(newFolders.length,1,'Expected exactly one new verified backup');
  assert.match(newFolders[0],/^\d{4}-\d{2}-\d{2}-[a-f\d-]{36}$/);
  console.log('PASS · Back up now created a new completed backup in the owned folder.');

  onStage('merge selected CSVs');
  const watched=[{...sampleRecord.watched[0],times_watched:3}];
  const files=[];
  for (const [name,rows] of Object.entries({watched,lists:[{...sampleRecord.lists[0],list:'Weekend'}]})) {
    const path=join(profile,name+'.csv');
    await writeFile(path,writeCsv(name,rows));
    files.push(path);
  }
  await browser.click('[data-file-actions] a[href="#/hand-merge"]');
  const selector='main input[type=file]:enabled';
  await wait(enabled('main input[type=file]'),'merge picker');
  const {root}=await browser.send('DOM.getDocument');
  const {nodeId}=await browser.send('DOM.querySelector',{nodeId:root.nodeId,selector});
  await browser.send('DOM.setFileInputFiles',{nodeId,files});
  await wait("document.querySelector('[data-preview]:not([hidden])')?.textContent.includes('Weekend') && "+enabled('[data-continue]'),'reviewed merge');
  await browser.click('[data-continue]');
  await wait("document.querySelector('[data-state]')?.textContent === 'Merge saved on this device.'",'saved merge');
  await sync();
  const mergedWatch=(await read('watched')).rows;
  assert.equal(mergedWatch.length,1);
  assert.equal(mergedWatch[0].times_watched,3);
  assert.deepEqual((await read('lists')).rows.map(row=>row.list).sort(),['Watchlist','Weekend']);
  assert.equal((await read('ratings')).rows[0]?.rating,7);
  await verifyKeys();
  console.log('PASS · Merge added two plays and the Weekend membership to Dropbox; the rating, Watchlist and keys survived.');

  onStage('restore selected files from the original backup');
  await browser.click('[data-file-actions] a[href="#/recovery"]');
  await wait(enabled('[data-refresh]'),'backup list');
  await browser.click('[data-refresh]');
  const selected='[data-folder="'+newFolders[0]+'"]';
  await wait(enabled(selected),'the exact original verified backup');
  await browser.click(selected);
  await wait("document.querySelector('[data-files] input[value=watched]:checked') && document.querySelector('[data-files] input[value=lists]:checked')",'restorable files');
  const checked=await browser.evaluate("Array.from(document.querySelectorAll('[data-files] input:checked'),box=>box.value)");
  for (const table of checked) if (!['watched','lists'].includes(table)) await browser.click('[data-files] input[value="'+table+'"]');
  await wait(enabled('[data-restore]'),'restore selected files');
  await browser.click('[data-restore]');
  await wait("document.querySelector('[data-result]')?.textContent.includes('Restore complete.')",'successful restore');
  const result=await browser.evaluate("document.querySelector('[data-result]').textContent");
  for (const table of ['watched','lists']) assert.ok(result.includes(table+'.csv — Restored.'));
  await sync();
  await verifyRecord(7,true);
  await verifyKeys();
  console.log('PASS · Restore returned the watched show to one play, preserved the separate planned show on Watchlist, and kept the rating and keys.');
}
