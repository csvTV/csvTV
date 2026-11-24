// Isolate this new-install check from device records created by earlier browser cases.
const name = 'new-dropbox-install-' + crypto.randomUUID();
const open = indexedDB.open.bind(indexedDB);
indexedDB.open = (requested, version) => open(requested === 'csvTV' ? name : requested, version);
await import('../dist/main.js');
