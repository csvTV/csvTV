import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {openChromium} from './offline-chromium.mjs';
import {linkFixture,offlineProviders} from './offline-providers.mjs';
import {listen,stop,testSite} from './offline-site.mjs';
import {setTimeout as delay} from 'node:timers/promises';

test('a sync with many unrecognized files keeps one expandable banner, all file names and the last 30 log entries', {timeout:60000}, async t => {
  const {server} = await testSite(), origin = 'http://127.0.0.1:' + await listen(server);
  const profile = await mkdtemp(join(tmpdir(),'csvtv-grouped-sync-'));
  const provider = offlineProviders(origin);
  const browser = await openChromium(profile,provider.respond);
  t.after(async () => { try { await browser.close(); } finally { await stop(server); await rm(profile,{recursive:true,force:true,maxRetries:6,retryDelay:150}); } });
  await linkFixture(browser,origin);
  await browser.navigate(origin+'/tracker/#/settings');
  const synced = 'document.querySelector("[data-cloud-reason]")?.dataset.synced === "true"';
  await browser.waitFor(synced);
  const names = Array.from({length:72},(_,i) => 'Fictional notes '+String(i+1).padStart(2,'0')+'.txt');
  for (const name of names) await provider.upload(name,'Fictional notes');
  await browser.click('[data-sync]');
  const banner = '.reports .report details', tile = '[data-sync-notices] details';
  await browser.waitFor('document.querySelector("'+banner+' summary")?.textContent==="Unrecognized Dropbox items (72)" && '+synced);
  assert.equal(await browser.evaluate('document.querySelectorAll(".report").length'),1);
  assert.equal(await browser.evaluate('document.querySelectorAll("'+banner+' li, '+tile+' li").length'),0);
  const expected = names.map(name => 'Unrecognized Dropbox item: '+name);
  for (const group of [banner,tile]) {
    await browser.evaluate('document.querySelector("'+group+' summary").focus()');
    await browser.press('Enter');
    await browser.waitFor('document.querySelectorAll("'+group+' li").length===50');
    await browser.evaluate('document.querySelector("'+group+' button").focus()');
    await browser.press('Enter');
    assert.deepEqual(await browser.evaluate('Array.from(document.querySelectorAll("'+group+' li"),item=>item.textContent)'),expected);
  }
  await browser.evaluate('document.querySelector(".notification-log summary").focus()');
  await browser.press('Enter');
  const log = 'Array.from(document.querySelectorAll(".notification-log li span"),item=>item.textContent)';
  await browser.waitFor('('+log+').length===30');
  assert.deepEqual(await browser.evaluate(log),expected.slice(-30).reverse());
  await delay(8300);
  assert.ok(await browser.evaluate('document.querySelector("'+banner+'")?.open'),'an expanded report stays open for reading');
  await browser.click('.reports .report > button');
  assert.equal(await browser.evaluate('document.querySelectorAll(".report").length'),0);
  const newer = ['Fictional update A.txt','Fictional update B.txt','Fictional update C.txt'];
  for (const name of newer) await provider.upload(name,'Fictional notes');
  // Match a background sync. The keyboard user is still reading the previous report.
  await browser.evaluate('document.querySelector("'+tile+' summary").focus(); document.querySelector("[data-sync]").click()');
  await browser.waitFor('document.querySelector("'+tile+' summary")?.textContent.endsWith("(3)") && '+synced);
  assert.equal(await browser.evaluate('document.querySelector("'+tile+'").open && document.activeElement === document.querySelector("'+tile+' summary")'),true);
  assert.deepEqual(await browser.evaluate('Array.from(document.querySelectorAll("'+tile+' li"),item=>item.textContent)'),newer.map(name => 'Unrecognized Dropbox item: '+name));
  await browser.evaluate('document.querySelector(".reports .report > button").click(); document.querySelector("[data-sync]").click()');
  await browser.waitFor('document.querySelector("[data-sync-notices]")?.hidden && '+synced);
  assert.equal(await browser.evaluate('document.activeElement.id'),'dropbox-label');
  assert.equal(await browser.evaluate('document.querySelectorAll(".report").length'),0);
  for (const name of [...names,...newer]) assert.equal(new TextDecoder().decode(provider.files.get('/'+name).bytes),'Fictional notes');
});

test('Settings keeps the latest banner messages through dismissal and restart, and clears them with this device', {timeout:75000}, async t => {
  const {server} = await testSite(), origin = 'http://127.0.0.1:' + await listen(server);
  const settings = origin + '/tracker/#/settings', profile = await mkdtemp(join(tmpdir(),'csvtv-notification-log-'));
  const providers = offlineProviders(origin), open = () => openChromium(profile,providers.respond);
  let browser;
  t.after(async () => {
    try { await browser?.close(); }
    finally { await stop(server); await rm(profile,{recursive:true,force:true,maxRetries:6,retryDelay:150}); }
  });
  browser = await open();
  await linkFixture(browser,origin);
  await browser.navigate(settings);
  const synced = 'document.querySelector("[data-cloud-reason]")?.textContent === "Synced"';
  await browser.waitFor(synced);
  const log = 'document.querySelector("details.notification-log")';
  const texts = 'Array.from(document.querySelectorAll(".notification-log li span"),s=>s.textContent)';
  const empty = log+'?.open && !'+log+'.querySelector("p").hidden && '+texts+'.length === 0';
  async function expand() {
    await browser.waitFor(log+'?.querySelector("summary")');
    assert.equal(await browser.evaluate(log+'.open'),false);
    await browser.evaluate(log+'.querySelector("summary").focus()');
    await browser.press('Enter');
    await browser.waitFor(log+'.open');
  }
  await expand();
  await browser.waitFor(empty);
  assert.equal(await browser.evaluate(log+'.previousElementSibling.contains(document.querySelector("[data-offline-status]"))'),true);
  assert.equal(await browser.evaluate(log+'.querySelector("summary").innerText'),'Notification log');
  for (const theme of ['light','dark']) {
    await browser.click('.appearance-options input[value="'+theme+'"]');
    await browser.waitFor('document.documentElement.dataset.theme === '+JSON.stringify(theme));
    const styles = await browser.evaluate(`['.notification-log summary','.source-credits summary'].map(selector=>{
      const style = getComputedStyle(document.querySelector(selector));
      return [style.color,style.opacity,style.fontWeight,style.fontSize];
    })`);
    assert.deepEqual(styles[0],styles[1],theme+' disclosure headings');
  }

  // Capture the controller handling the actual sign-out report. Other test messages use that same public entry point.
  await browser.evaluate('('+ (async function() {
    const {DropboxController} = await import('/tracker/dropbox-controller.js');
    const original = DropboxController.prototype.report;
    DropboxController.prototype.report = function(message) {
      window.testCloud = this;
      DropboxController.prototype.report = original;
      return original.call(this,message);
    };
  }).toString()+')()');
  await browser.click('[data-sign-out]');
  await browser.waitFor('document.querySelector(".reports .report span")?.textContent.startsWith("Signed out")');
  const signOut = await browser.evaluate('document.querySelector(".reports .report span").textContent');
  await browser.waitFor(texts+'.includes('+JSON.stringify(signOut)+')');
  await browser.click('.reports .report button');
  assert.ok((await browser.evaluate(texts)).includes(signOut));

  await browser.evaluate('window.logReader=window.open(location.href,"csvtv-notification-reader"); Boolean(logReader)');
  await browser.waitFor('logReader.document.querySelector("details.notification-log")');
  await browser.evaluate('logReader.document.querySelector(".notification-log summary").click()');
  const readerTexts = 'Array.from(logReader.document.querySelectorAll(".notification-log li span"),s=>s.textContent)';
  await browser.waitFor(readerTexts+'.includes('+JSON.stringify(signOut)+')');
  const messages = Array.from({length:32},(_,i)=>'Fictional report '+i);
  messages[31] = '<b>Fictional report 31</b>';
  const expected = messages.slice(-30).reverse();
  await browser.evaluate(log+'.querySelector("summary").focus()');
  await browser.evaluate(JSON.stringify(messages)+'.forEach(message=>testCloud.report(message))');
  await browser.waitFor('JSON.stringify('+texts+') === '+JSON.stringify(JSON.stringify(expected)));
  await browser.waitFor('JSON.stringify('+readerTexts+') === '+JSON.stringify(JSON.stringify(expected)),'open reader tab received writer notifications');
  await browser.evaluate('logReader.close()');
  assert.equal(await browser.evaluate(log+'.contains(document.activeElement)'),true);
  assert.equal(await browser.evaluate(log+'.querySelector("li b,li a,li button")'),null);
  assert.equal(await browser.evaluate('Array.from(document.querySelectorAll(".notification-log li time")).filter(t=>t.innerText && Number.isFinite(Date.parse(t.dateTime))).length'),30);
  assert.deepEqual(await browser.evaluate('testCloud.store.noticeHistory("another-fictional-owner")'),[]);

  await browser.send('Emulation.setDeviceMetricsOverride',{width:320,height:740,deviceScaleFactor:1,mobile:true});
  assert.ok(await browser.evaluate(log+'.getBoundingClientRect().right <= innerWidth && '+log+'.scrollWidth <= '+log+'.clientWidth'));
  await browser.waitFor('!document.querySelector(".reports .report")','banner expiry');
  assert.deepEqual(await browser.evaluate(texts),expected);
  await browser.close();
  browser = await open();
  await browser.navigate(settings);
  await expand();
  await browser.waitFor('JSON.stringify('+texts+') === '+JSON.stringify(JSON.stringify(expected)),'persisted notification history');

  await browser.click('[data-clear-device]');
  await browser.click('dialog[open] .destructive');
  await browser.waitFor('document.querySelector("#app")?.dataset.page === "dropbox-setup"');
  await linkFixture(browser,origin);
  await browser.navigate(settings);
  await browser.waitFor(synced);
  await expand();
  await browser.waitFor(empty,'erased log after reconnecting the same account');
  for (const file of providers.files.values()) assert.doesNotMatch(new TextDecoder().decode(file.bytes),/Fictional report/);
});
