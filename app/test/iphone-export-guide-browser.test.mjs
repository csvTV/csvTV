import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {openChromium} from './offline-chromium.mjs';
import {listen,stop} from './offline-site.mjs';
import {releaseServer} from './release-site.mjs';

test('the prepared iPhone share guide opens a fictional record and verifies four downloaded files', {timeout:60000}, async t => {
  const directory=await mkdtemp(join(tmpdir(),'csvtv-share-guide-'));
  const site=join(directory,'site'), downloads=join(directory,'downloads');
  let server,browser;
  t.after(async()=>{
    try { await browser?.close(); } finally {
      if(server) await stop(server);
      await rm(directory,{recursive:true,force:true,maxRetries:8,retryDelay:150});
    }
  });
  execFileSync(process.execPath,[fileURLToPath(new URL('./iphone-export/prepare.mjs',import.meta.url)),site]);
  const files=new Map([['_headers',Buffer.from('/*\n  Referrer-Policy: no-referrer\n')]]);
  for(const folder of ['','app/']) for(const entry of await readdir(join(site,folder),{withFileTypes:true})){
    if(entry.isFile()) files.set(folder+entry.name,await readFile(join(site,folder,entry.name)));
  }
  server=releaseServer(files);
  const origin='http://127.0.0.1:'+await listen(server);
  await mkdir(downloads);
  browser=await openChromium(join(directory,'profile'));
  await browser.navigate(origin+'/');
  await browser.click('input[value=record]');
  await browser.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloads,eventsEnabled:true});
  const names=['watched.csv','ratings.csv','lists.csv','shows.csv'];
  for(const name of names) await browser.download('a[download="'+name+'"]:not([aria-disabled=true])',name);
  const {root}=await browser.send('DOM.getDocument');
  const {nodeId}=await browser.send('DOM.querySelector',{nodeId:root.nodeId,selector:'#downloaded'});
  await browser.send('DOM.setFileInputFiles',{nodeId,files:names.map(name=>join(downloads,name))});
  await browser.waitFor('document.querySelector("#downloaded-result").textContent.startsWith("Pass.")','fixture accepts the downloaded bytes');
  assert.deepEqual((await readdir(downloads)).sort(),names.toSorted());
});
