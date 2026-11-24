import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {openChromium} from './offline-chromium.mjs';
import {listen,stop,testSite} from './offline-site.mjs';
import {manualWatchFixture,manualWatchModes,manualWatchWorkerCase,protectedBulkUndo} from './watch-edit-worker-cases.mjs';

test('bulk watch edits preserve offline, Undo and exact-once outcomes through interruption and reopening',{timeout:120000},async t=>{
  const site=await testSite(),serve=site.server.listeners('request')[0];
  const server=createServer((req,res)=>{if(!manualWatchFixture(req,res))serve(req,res);});
  const origin='http://127.0.0.1:'+await listen(server),profile=await mkdtemp(join(tmpdir(),'csvtv-manual-watch-'));
  let browser;t.after(async()=>{try{await browser?.close();}finally{await stop(server);await rm(profile,{recursive:true,force:true,maxRetries:6,retryDelay:150});}});
  browser=await openChromium(profile);await browser.navigate(origin+'/fixture');
  for(const mode of manualWatchModes){
    const result=await browser.evaluate('('+manualWatchWorkerCase.toString()+')('+JSON.stringify({base:'/tracker/',mode})+')');
    assert.equal(result.mode,mode);t.diagnostic(mode+' · '+result.submissions+' background writes');
  }
  assert.deepEqual(await browser.evaluate('('+protectedBulkUndo.toString()+')("/tracker/")'),[520,519]);
});
