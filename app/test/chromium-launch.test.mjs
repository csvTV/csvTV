import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, rmdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {openChromium} from './offline-chromium.mjs';

test('a launch failure reports the error code without the executable or profile path', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'csvtv-launch-failure-'));
  const previous = process.env.CSVTV_BROWSER;
  process.env.CSVTV_BROWSER = join(profile, 'missing-browser');
  try {
    await assert.rejects(openChromium(profile, async () => {}), {message:'Chromium could not start (ENOENT)'});
  } finally {
    if (previous === undefined) delete process.env.CSVTV_BROWSER;
    else process.env.CSVTV_BROWSER = previous;
    await rm(profile, {recursive:true, force:true});
  }
});

test('parallel Chromium launches and a reused profile each connect to their own page', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'csvtv-launch-'));
  const browsers = new Set();
  t.after(async () => {
    try { await Promise.all([...browsers].map(browser => browser.close())); }
    finally { await rm(directory, {recursive:true, force:true, maxRetries:6, retryDelay:150}); }
  });
  const executable = process.env.CSVTV_BROWSER;
  if (executable && process.platform !== 'win32') {
    // Exercise the hosted runner's silent-start path: only DevToolsActivePort can identify the port.
    const wrapper = join(directory, 'quiet-browser');
    await writeFile(wrapper, '#!/bin/sh\nexec "$CSVTV_LAUNCH_TEST_BROWSER" "$@" 2>/dev/null\n', {mode:0o700});
    const previous = process.env.CSVTV_LAUNCH_TEST_BROWSER;
    process.env.CSVTV_LAUNCH_TEST_BROWSER = executable;
    process.env.CSVTV_BROWSER = wrapper;
    t.after(() => {
      process.env.CSVTV_BROWSER = executable;
      if (previous === undefined) delete process.env.CSVTV_LAUNCH_TEST_BROWSER;
      else process.env.CSVTV_LAUNCH_TEST_BROWSER = previous;
    });
  }
  const firstProfile = await mkdtemp(join(directory, 'first-'));
  const secondProfile = await mkdtemp(join(directory, 'second-'));
  const firstMarker = join(firstProfile, 'DevToolsActivePort');
  const edge = process.platform === 'win32' && /[\\/]msedge\.exe$/i.test(executable ?? '');
  // A handed-off Edge process may never create this file. Make it impossible to read or write as a file.
  if (edge) await mkdir(firstMarker);
  async function launch(profile) {
    const browser = await openChromium(profile, async () => assert.fail('Startup contacted a provider'));
    browsers.add(browser);
    return browser;
  }
  const pair = await Promise.allSettled([launch(firstProfile), launch(secondProfile)]);
  const [first, second] = pair.map(result => {
    if (result.status === 'rejected') throw result.reason;
    return result.value;
  });
  const firstTitle = await first.evaluate('document.title');
  const secondTitle = await second.evaluate('document.title');
  assert.match(firstTitle, /^csvtv-/);
  assert.match(secondTitle, /^csvtv-/);
  assert.notEqual(firstTitle, secondTitle);

  // Reuse another running browser's marker when available.
  await first.close();
  if (edge) await rmdir(firstMarker);
  const secondMarker = await readFile(join(secondProfile, 'DevToolsActivePort')).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return '1\n/devtools/browser/00000000-0000-4000-8000-000000000000';
  });
  await writeFile(firstMarker, secondMarker);
  const reopened = await launch(firstProfile);
  assert.ok(![firstTitle, secondTitle].includes(await reopened.evaluate('document.title')));
  await reopened.close();
  assert.equal(await second.evaluate('document.title'), secondTitle);
});
