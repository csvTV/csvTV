import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import test from 'node:test';
import {openChromium} from './offline-chromium.mjs';
import {listen,stop,testSite} from './offline-site.mjs';
import {importRecordWorkerCase} from './import-record-worker-cases.mjs';
import {importWorkerFixture} from './import-record-worker-fixture.mjs';

test('large approved imports keep one atomic record through account changes, failed writes and a lost result',{timeout:120000},async t=>{
  const site=await testSite(),assets=site.server.listeners('request')[0];
  const server=createServer((req,res)=>{if(!importWorkerFixture(req,res))assets(req,res);});
  const origin='http://127.0.0.1:'+await listen(server),profile=await mkdtemp(join(tmpdir(),'csvtv-import-record-'));
  let browser;
  t.after(async()=>{try{await browser?.close();}finally{await stop(server);await rm(profile,{recursive:true,force:true,maxRetries:6,retryDelay:150});}});
  browser=await openChromium(profile);
  await browser.navigate(origin+'/fixture');
  for(const mode of ['valid','legacy','native','expired','left','offline-at-end','cleared','prior-grant','native-prior-grant',
    'removed-key','revision','grant','generation','erase','handoff','no-admission','lost-success','killed','quota','constraint','worker-expired']){
    const args=JSON.stringify({base:'/tracker/',mode});
    const result=await browser.evaluate('('+importRecordWorkerCase.toString()+')('+args+')');
    assert.equal(result.mode,mode);
    t.diagnostic(mode+' · '+result.jobs+' import submission'+(result.jobs===1?'':'s'));
  }
  for(const [changes,mode] of [[31,'valid'],[32,'valid'],[32,'native'],[32,'native-prior-grant'],[32,'native-expiry'],[32,'expired'],[32,'left']]){
    const args=JSON.stringify({base:'/tracker/',mode,changes,expectWorker:changes>=32});
    const result=await browser.evaluate('('+importRecordWorkerCase.toString()+')('+args+')');
    assert.equal(result.mode,mode);
    t.diagnostic(changes+' changed watches · '+mode);
  }
});
