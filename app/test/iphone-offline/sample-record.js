const marker = 'iPhoneOfflineSample';
export const sample = { show_id: 78115, show: 'Signal Garden' };

function needsSample(snapshot) {
  if (snapshot.local[marker]) return false;
  if (snapshot.revision !== 0n || Object.values(snapshot.tables).some(rows => rows.length) ||
      Object.keys(snapshot.sync).length || Object.keys(snapshot.local).length) {
    throw Error('This site already has a record. The sample needs an empty test site.');
  }
  return true;
}

export async function prepareSample(openDeviceStore, report, signal) {
  if (!window.isSecureContext || !navigator.serviceWorker || !navigator.locks || !window.indexedDB) {
    throw Error('Open this link over HTTPS in a regular Safari tab with website storage enabled.');
  }
  const store = await openDeviceStore();
  const cancel = () => store.close();
  let waiting;
  try {
    signal?.throwIfAborted();
    signal?.addEventListener('abort', cancel, {once:true});
    // Returning readers can open the sample even if another tracker tab is the writer.
    if (!needsSample(await store.snapshot())) return;
    waiting = setTimeout(() => report('Waiting for access. Close other tracker tabs on this test site.'), 2000);
    const snapshot = await store.whenWriter();
    if (!needsSample(snapshot)) return;
    signal?.throwIfAborted();
    await store.commit(snapshot.revision, {
      put: {
        shows: [{ ...sample, year: 2022, imdb_id: '' }],
        watched: [{ ...sample, season: 1, episode: 1, title: 'First Light', times_watched: 1, episode_id: 7811501 }],
        ratings: [{ ...sample, rating: 7 }],
        lists: [{ ...sample, list: 'One to revisit' }],
      },
      local: { [marker]: true, syncAccountId: 'fictional-offline-sample' },
    }, {current:() => !signal?.aborted});
  } finally {
    signal?.removeEventListener('abort', cancel);
    clearTimeout(waiting);
    await store.closeForUpdate();
  }
}
