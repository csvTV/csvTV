import { readCsv, writeCsv } from './csv.ts';
import { summary, exportShowIndex } from './export-data.ts';
import { deriveShows } from './shows.ts';
import type { ShowRow } from './model.ts';
import { StaleSnapshotError, type DeviceStore, type ExportSnapshot } from './storage.ts';
import { tmdbResourceKey } from './tmdb-client.ts';
import { dropboxContentHash, type DropboxApi, type DropboxEntry } from './dropbox-api.ts';
import { mergedTables, tableMatchesDropboxBase } from './dropbox-sync-file.ts';
import { checkDropboxBytes, checkDropboxFile, dropboxLimits } from './dropbox-limits.ts';

export const recordReadme = [
  'csvTV watch record',
  '',
  'Import these UTF-8 CSV files into spreadsheets as text. A spreadsheet can interpret a title or list name as a formula.',
  'watched.csv has one row per marked episode. times_watched includes rewatches. Season 0 holds specials.',
  'ratings.csv holds your show ratings from 0 to 10. lists.csv holds your lists and their shows. A row with a list name and two blank show fields keeps the list even when empty. A saved Watchlist plan appears in the app only while the show has zero recorded watches.',
  'An Anime row in lists.csv preserves a show’s classification across devices. Use the Anime filter in Library to see watched anime.',
  'A Dropped row marks a dropped show. Drop and Pick Up keep its watches, ratings and list choices. A csvTV: picked up row remembers your choice on repeat imports.',
  'shows.csv indexes every show referenced by the other three files. Its title, first-air year and IMDb ID may be blank.',
  'settings.csv contains private service credentials, source choices, display preferences and recent marks. Keep it private. The four-file export omits it.',
  'summary.csv has one row per season with watches, and one row per unstarted rated or listed show. Blank completion means the count is unavailable.',
  'The shared summary compares air dates with the UTC date when it was rebuilt. The interactive summary uses the local calendar date.',
  'In the summary lists field, double each backslash and escape each semicolon with a backslash. Join names with a semicolon and a space. Apply ordinary CSV quoting last.',
  'For example, Watchlist\\; Drama is one name. Watchlist; Drama represents two memberships. Read escapes from left to right after CSV parsing.',
  'backups/ contains dated copies. A complete generation has a completion.json manifest identifying the files and their Dropbox hashes.',
  'Keep csvtv-reset.json. It tracks unfinished backup writers and tells other devices which older data to discard after a clear.',
  '',
].join('\r\n');

export function cloudFiles(snapshot: ExportSnapshot, remote: readonly ShowRow[], now: number) {
  // Nonblank Dropbox fields replace older preserved values; a blank cannot erase a device-only ID.
  const preserved = deriveShows(snapshot.tables, remote);
  const combined = { ...snapshot, tables: { ...snapshot.tables, shows:preserved } };
  const index = exportShowIndex(combined);
  const needsSeasonOrder = new Set(snapshot.tables.watched.filter(row => row.season > 0).map(row => row.show_id));
  // For an unstarted show the summary uses only its indexed title and year.
  const haveShows = index.every(row => snapshot.showMetadata.has(row.show_id) || snapshot.missingShowIds.has(row.show_id) ||
    (!needsSeasonOrder.has(row.show_id) && row.show !== '' && row.year !== null));
  const haveSeasons = snapshot.tables.watched.every(row => row.season === 0 ||
    snapshot.seasons.has(tmdbResourceKey({ kind:'season', id:row.show_id, season:row.season })) ||
    !snapshot.showMetadata.get(row.show_id)?.seasons.some(season => season.season === row.season));
  const day = new Date(now).toISOString().slice(0, 10);
  return { index, summary:haveShows && haveSeasons ? summary(combined, index, now, day).files[0] : null };
}

export async function publishDerived(store: DeviceStore, api: DropboxApi, listing: DropboxEntry[],
    binding: {accountId:string; instanceId:string}, now: number, exportRecord?:object) {
  const entries = new Map(listing.filter(entry => entry.kind === 'file').map(entry => [entry.name.toLowerCase(), entry]));
  let state = await store.dropboxPublicationState();
  const listedShows = entries.get('shows.csv');
  let downloaded = null;
  if (listedShows && (listedShows.contentHash === null || listedShows.contentHash !== state.hash)) {
    downloaded = await api.download('/shows.csv');
    if (downloaded) entries.set('shows.csv', downloaded.metadata);
    else entries.delete('shows.csv');
  }
  if (downloaded) checkDropboxFile('/shows.csv', downloaded.bytes);
  const remote = downloaded && readCsv('shows', downloaded.bytes);
  const snapshot = await store.exportSnapshot(true, now, true, undefined, exportRecord);
  if (state.revision !== snapshot.revision) state = await store.dropboxPublicationState();
  const {revision,session,accountId} = await store.dropboxState();
  if (snapshot.revision !== state.revision || revision !== state.revision || accountId !== binding.accountId ||
      session?.accountId !== binding.accountId || session?.instanceId !== binding.instanceId) throw new StaleSnapshotError();
  const record = {tables:{...snapshot.tables,settings:state.settings},sync:state.sync};
  if (!mergedTables.every(table => tableMatchesDropboxBase(record, table))) throw new StaleSnapshotError();
  const { index, summary:cloudSummary } = cloudFiles(snapshot, remote && !remote.stopped ? remote.rows : [], now);
  const shows = writeCsv('shows', index);
  const files: [string,string][] = [['shows.csv', shows], ['README.txt', recordReadme]];
  if (cloudSummary) {
    checkDropboxBytes(cloudSummary.size, dropboxLimits.file);
    files.push(['summary.csv', await cloudSummary.text()]);
  }
  for (const [name, content] of files) checkDropboxFile('/' + name, content);
  const hash = await dropboxContentHash(shows);
  if (state.hash !== hash || shows !== writeCsv('shows', snapshot.tables.shows)) {
    await store.commit(state.revision, { replace:{ shows:index }, local:{ dropboxShowsHash:hash } },
      { syncWrite:true, current:() => (session.signInDeadline ?? 0) > Date.now() });
  }
  for (const [name, content] of files) {
    const known = entries.get(name.toLowerCase());
    if (!known || known.contentHash === null || known.contentHash !== (name === 'shows.csv' ? hash : await dropboxContentHash(content)))
      await api.upload('/' + name, content, known ? {mode:'update',revision:known.rev} : {mode:'add'});
  }
}
