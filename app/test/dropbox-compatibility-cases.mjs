import { deviceMigrations, openDeviceStore } from '../dist/storage.js';
import { DropboxController } from '../dist/dropbox-controller.js';
import { DropboxAuth } from '../dist/dropbox-auth.js';
import { DropboxDialogs } from '../dist/dropbox-dialogs.js';
import { readCsv } from '../dist/csv.js';
import { records, quoteField } from '../dist/csv-format.js';

const dbName = 'csvtv-test-compatibility-version';
const futureCsv = 'show_id,show,rating,release_note\r\n17,Amber Bay,7,early cut\r\n';

export async function openCompatibilityFixture() {
  const stage = Number(document.documentElement.dataset.stage);
  const migrations = stage === 3 ? [...deviceMigrations, db => db.createObjectStore('fixture-version-three')] : deviceMigrations;
  const store = await openDeviceStore({ name:dbName, migrations });
  const cloud = new DropboxController(new DropboxAuth(store,''),window,new DropboxDialogs(document));
  // The future fixture build knows one extra optional column. Both packages consume the same fixture bytes.
  const check = () => {
    if (stage < 3) return readCsv('ratings',futureCsv);
    const withoutAnnotation = [...records(futureCsv)].map(row => row.fields.slice(0,3).map(quoteField).join(',')).join('\r\n') + '\r\n';
    return readCsv('ratings',withoutAnnotation);
  };
  window.deviceTest = {id:crypto.randomUUID(),stage,store,cloud,check};
  window.addEventListener('pagehide',() => { cloud.close(); store.close(); },{once:true});
}

async function until(check, message) {
  const end = performance.now() + 7000;
  while (performance.now() < end) {
    if (check()) return;
    await new Promise(r=>setTimeout(r,10));
  }
  throw Error(message);
}
function check(ok,message) { if (!ok) throw Error(message); }

export async function dropboxCompatibilityCases(run) {
  await run('Online compatibility Reload fetches a later usable build after an unchanged build, migrates data, and fences the obsolete second tab',async()=>{
    const first = window.open('/compatibility-fixture','csvtv-compatibility-first');
    let second;
    try {
      await until(()=>first?.deviceTest,'First tab did not open');
      const initial = first.deviceTest;
      await initial.store.whenWriter();
      second = window.open('/compatibility-fixture','csvtv-compatibility-second');
      await until(()=>second?.deviceTest,'Second tab did not open');
      check(initial.check().schema === 'unknown' && second.deviceTest.check().schema === 'unknown','Old builds understood the future field');
      const pending = {content:'fictional pending bytes',targetRevision:'r0',targetModified:'2026-11-01T00:00:00Z',
        targetContent:'old bytes',clientModified:'2026-11-01T00:05:00Z',preparedAt:1234};
      await initial.store.commit((await initial.store.snapshot()).revision,{ put:{ ratings:[{show_id:17,show:'Amber Bay',rating:9}] },
        sync:{ratings:{base:{revision:'r0',content:'old bytes'},lastClientModified:pending.clientModified,pending}} });
      const fetch = first.fetch.bind(first);
      const requests = [];
      first.fetch = (url, options) => { requests.push({url,mode:options.cache}); return fetch(url,options); };
      Object.defineProperty(first.navigator,'onLine',{configurable:true,value:false});
      await initial.cloud.reload();
      check(requests.length === 0 && initial.cloud.notices.some(n=>n.includes('Connect to the internet')), 'Offline Reload attempted a fetch');
      delete first.navigator.onLine;
      await initial.cloud.reload();
      await until(()=>first.deviceTest && first.deviceTest.id !== initial.id,'Initial network Reload did not navigate');
      check(requests.length === 1 && requests[0].mode === 'reload','Reload did not fetch a fresh network shell');
      const unchanged = first.deviceTest;
      await unchanged.cloud.reload();
      check(first.deviceTest.id === unchanged.id && unchanged.cloud.notices.some(n=>n.includes('still cannot read')),
        'The same unsupported build caused another reload');
      await window.fetch('/publish-compatible-test-build',{method:'POST'});
      await unchanged.cloud.reload();
      await until(()=>first.deviceTest?.stage === 3,'Reload never picked up the newly published build');
      await until(()=>second.deviceTest.store.role === 'obsolete','A stale second tab retained its compatible connection');
      const upgraded = first.deviceTest;
      await upgraded.store.whenWriter();
      const saved = await upgraded.store.snapshot();
      check(upgraded.check().rows[0]?.rating === 7 && upgraded.check().schema === 'known','Published reader could not open the new format');
      check(saved.tables.ratings[0]?.rating === 9 && saved.sync.ratings.pending.content === pending.content &&
        saved.sync.ratings.base.revision === 'r0','A compatibility reload altered protected local data or pending delivery');
      let refused = false;
      try { await second.deviceTest.store.commit(saved.revision,{replace:{ratings:[]}}); } catch { refused = true; }
      check(refused,'The obsolete build could issue a write after migration');
      await second.deviceTest.cloud.reload();
      await until(()=>second.deviceTest?.stage === 3,'The obsolete tab could not join the new build');
    } finally { first?.close(); second?.close(); }
  });
}
