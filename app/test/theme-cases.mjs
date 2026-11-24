import { openDeviceStore } from '../dist/storage.js';
import { Appearance, mountAppearance } from '../dist/appearance.js';

function check(condition, message) { if (!condition) throw Error(message); }
async function waitFor(condition, message) {
  const limit = performance.now() + 3000;
  while (performance.now() < limit) {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw Error(message);
}

export async function themeCases(run) {
  await run('Appearance defaults safely on older records, saves a settings row, and survives reopening IndexedDB', async () => {
    const name = 'fictional-theme-' + crypto.randomUUID();
    let store = await openDeviceStore({ name });
    let theme;
    try {
      await store.whenWriter();
      theme = new Appearance(document, store);
      await theme.ready;
      check(theme.preference === 'dark', 'Fresh device did not default to Dark');
      await store.commit((await store.appearanceState()).revision, { local: { appearance:'unknown' } });
      // A background record edit can commit while Settings is reading the local preference.
      const read = store.appearanceState.bind(store);
      const edited = Promise.withResolvers();
      store.appearanceState = async () => {
        store.appearanceState = read;
        const state = await read();
        await store.commit(state.revision, {put:{ratings:[{show_id:12,show:'Signal Garden',rating:8}]}});
        edited.resolve();
        return state;
      };
      await theme.select('light');
      await edited.promise;
      const snapshot = await store.snapshot();
      check(snapshot.tables.ratings[0]?.rating === 8 && snapshot.local.appearance === undefined &&
        snapshot.tables.settings.find(row => row.setting === 'appearance')?.value === 'light',
        'Theme selection lost an unrelated watch record edit or failed to save its settings row');
      theme.close(); store.close();
      store = await openDeviceStore({ name });
      await store.whenWriter();
      theme = new Appearance(document, store);
      await theme.ready;
      check(theme.preference === 'light' && document.documentElement.dataset.theme === 'light', 'Light did not survive reopening');
      await store.commit((await store.appearanceState()).revision, { remove:{settings:['appearance']}, local:{appearance:'future-value'} });
      await waitFor(() => theme.preference === 'dark', 'Unrecognized persisted preference did not fall back to Dark');
      check(localStorage.getItem('csvTV-appearance') === null, 'Invalid preference survived in the startup hint');
    } finally { theme?.close(); store.close(); indexedDB.deleteDatabase(name); }
  });

  await run('A reader follows committed appearance changes and erase; a failed save keeps the previous theme selected', async () => {
    const name = 'fictional-theme-peer-' + crypto.randomUUID();
    const writer = await openDeviceStore({ name });
    let reader, editable, readOnly, disposeControls;
    const controls = document.createElement('div');
    document.body.append(controls);
    try {
      await writer.whenWriter();
      reader = await openDeviceStore({ name });
      editable = new Appearance(document, writer); readOnly = new Appearance(document, reader);
      await Promise.all([editable.ready, readOnly.ready]);
      disposeControls = mountAppearance(controls, readOnly);
      check([...controls.querySelectorAll('input')].every(input => input.disabled), 'Read-only tab could write the appearance');
      await editable.select('light');
      await waitFor(() => controls.querySelector('input[value=light]').checked, 'Read-only controls missed a committed theme');
      const save = writer.selectAppearance;
      writer.selectAppearance = async () => { throw new DOMException('Simulated full storage', 'QuotaExceededError'); };
      try { await editable.select('device'); } finally { writer.selectAppearance = save; }
      check(editable.preference === 'light' && editable.error.includes('Could not save') &&
        localStorage.getItem('csvTV-appearance') === 'light', 'Failed save changed the committed theme or startup hint');
      await writer.eraseDevice((await writer.appearanceState()).revision);
      await waitFor(() => controls.querySelector('input[value=dark]').checked && editable.preference === 'dark', 'Erase did not reset both tabs');
      check(localStorage.getItem('csvTV-appearance') === null, 'Erase left a stale first-paint preference');
      // Two choices were made before erase, while the first save was still reporting its result.
      const committed = Promise.withResolvers(), release = Promise.withResolvers();
      writer.selectAppearance = async value => {
        await save.call(writer,value);
        if (value === 'light') { committed.resolve(); await release.promise; }
      };
      const first = editable.select('light');
      await committed.promise;
      const second = editable.select('device');
      try { await writer.eraseDevice((await writer.appearanceState()).revision); }
      finally { release.resolve(); writer.selectAppearance = save; }
      await Promise.all([first,second]);
      check((await writer.appearanceState()).preference === undefined && editable.preference === 'dark' &&
        localStorage.getItem('csvTV-appearance') === null, 'A theme choice made before erase reached the fresh device');
    } finally {
      disposeControls?.(); readOnly?.close(); editable?.close(); reader?.close(); writer.close(); controls.remove();
      indexedDB.deleteDatabase(name);
    }
  });
}
