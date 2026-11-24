import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {openChromium} from './offline-chromium.mjs';
import {listen,stop,testSite} from './offline-site.mjs';
import {malIndexWorkerCase} from './mal-index-worker-cases.mjs';

import {malWorkerFixture} from './mal-index-worker-fixture.mjs';

test('a large MAL job preserves compatible per-show keys, atomic admission and a settings-only score projection',{timeout:120000},async t=>{
  const site=await testSite(),assets=site.server.listeners('request')[0];
  const server=createServer((req,res)=>{if(!malWorkerFixture(req,res))assets(req,res);});
  const origin='http://127.0.0.1:'+await listen(server),profile=await mkdtemp(join(tmpdir(),'csvtv-mal-index-'));
  let browser;
  t.after(async()=>{try{await browser?.close();}finally{await stop(server);await rm(profile,{recursive:true,force:true,maxRetries:6,retryDelay:150});}});
  browser=await openChromium(profile);await browser.navigate(origin+'/fixture');
  for (const mode of ['valid','lost-commit','expired','hidden','retired','killed','grant','generation','quota','unavailable','disabled-reader','late-source','late-file','late-erase','unrelated-edit']) {
    const result=await browser.evaluate('('+malIndexWorkerCase.toString()+')('+JSON.stringify({base:'/tracker/',mode})+')');
    assert.equal(result.mode,mode);
    t.diagnostic(mode);
  }
});
