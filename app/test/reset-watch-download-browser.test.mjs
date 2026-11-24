import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {openChromium} from './offline-chromium.mjs';
import {listen,stop,testSite} from './offline-site.mjs';
import {resetDownloadModes,resetWatchDownloadCase} from './reset-watch-download-cases.mjs';
import {absoluteRestoreModes,basedWatchDownloadCase,sparseRestoreCases} from './based-watch-download-cases.mjs';

async function exercise(t,run,modes,options={}) {
  const site=await testSite(),origin='http://127.0.0.1:'+await listen(site.server);
  const profile=await mkdtemp(join(tmpdir(),'csvtv-watched-recovery-'));let browser;
  t.after(async()=>{
    try {await browser?.close();}
    finally {await stop(site.server);await rm(profile,{recursive:true,force:true,maxRetries:6,retryDelay:150});}
  });
  browser=await openChromium(profile);await browser.navigate(origin+'/fixture');
  for (const entry of modes) {
    const args={base:'/tracker/',...(typeof entry==='string'?{mode:entry}:entry),...options};
    const result=await browser.evaluate('('+run.toString()+')('+JSON.stringify(args)+')');
    assert.equal(result.mode,args.mode);t.diagnostic([args.mode,args.sparse,result.saved?'saved':'rolled back'].filter(Boolean).join(' · '));
  }
}

test('a repopulated watch file commits with its reset generation through restart, loss of reply and writer handoff',
  {timeout:120000},t=>exercise(t,resetWatchDownloadCase,resetDownloadModes));

test('a confirmed backup restore retains its absolute pending receipt through native fallback, lost replies and expiry',
  {timeout:120000},t=>exercise(t,basedWatchDownloadCase,absoluteRestoreModes,{restore:true,size:68}));

test('a sparse backup Restore preserves all untouched watches and admits changes only with its exact absolute receipt',
  {timeout:120000},t=>exercise(t,basedWatchDownloadCase,sparseRestoreCases,{restore:true}));
