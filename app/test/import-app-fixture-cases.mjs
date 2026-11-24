import { openDeviceStore } from '../dist/storage.js';

export function check(ok, message) { if (!ok) throw Error(message); }
export async function until(read, message) {
  const end = performance.now() + 8000;
  do {
    const result = await read();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve,15));
  } while (performance.now() < end);
  throw Error(message);
}

export function checkPreImportBackup(files, previousCount) {
  const complete = [...files.keys()].filter(path => path.endsWith('/completion.json'));
  check(complete.length > previousCount, 'Import did not create a verified Dropbox backup');
  const folder = complete.at(-1).slice(0, -'completion.json'.length);
  const manifest = JSON.parse(new TextDecoder().decode(files.get(complete.at(-1)).bytes));
  for (const name of ['watched.csv','ratings.csv','lists.csv','shows.csv']) {
    const file = files.get(folder + name);
    check(file ? new TextDecoder().decode(file.bytes).trimEnd().split(/\r?\n/).length === 1 : manifest.entries[name] === null,
      'The pre-import backup omitted ' + name + ' or included the proposed changes');
  }
}

export async function withImportApp(width, page, exercise) {
  const frame = document.createElement('iframe');
  frame.width = width; frame.height = 812;
  const load = new Promise(resolve => {frame.onload = resolve;});
  frame.src = '/dist/import-test.html#/' + page; document.body.append(frame);
  let peer, name;
  try {
    await load;
    const win = frame.contentWindow, doc = frame.contentDocument;
    const q = selector => doc.querySelector(selector);
    const select = selector => until(() => q(selector),'Missing ' + selector);
    const fixture = win.importFixture; name = fixture.name;
    await select('.app-frame');
    // This peer only inspects the record. Let the application claim its writer before opening it.
    await until(async () => (await win.navigator.locks.query()).held.some(lock => lock.name === 'csvTV/writer/' + name),
      'The import application did not acquire its writer');
    peer = await openDeviceStore({name});
    const title = text => until(() => {
      // Import titles appear before the first download of their matching code.
      const heading = text.startsWith('Import from ') ? '.import-screen h1' : 'h1';
      return q(heading)?.textContent === text;
    },'Did not open ' + text);
    async function configure() {
      const edit = await until(() => { const button = q('[data-edit]'); return button && !button.disabled && button; },
        'TMDB key editor did not become available');
      edit.click();
      const input = await select('#tmdb-input');
      input.value = 'fictional-import-ui';
      q('dialog button[type=submit]').click();
      await until(() => !q('dialog[open]') && fixture.paths.includes('configuration'),'TMDB setup failed');
    }
    async function choose(file) {
      const picker = await until(() => {
        const el = q('.import-screen input'); return el && !el.disabled && el;
      },'File input unavailable: '+q('[data-block]')?.textContent);
      const transfer = new win.DataTransfer(); transfer.items.add(file);
      picker.files = transfer.files; picker.dispatchEvent(new win.Event('change',{bubbles:true}));
    }
    const preview = () => until(() => q('.import-totals') && !q('[data-apply]').disabled, 'Preview unavailable: ' + q('[data-status]')?.textContent);
    await exercise({doc,win,q,select,fixture,peer,configure,choose,preview,title});
    check(fixture.violations.length === 0, 'Shipped security policy blocked ' + fixture.violations.join(', '));
  } finally {
    peer?.close();
    frame.remove();
    if (name) await new Promise((ok,fail) => {
      const req = indexedDB.deleteDatabase(name); req.onsuccess = ok; req.onerror = () => fail(req.error);
    });
  }
}
