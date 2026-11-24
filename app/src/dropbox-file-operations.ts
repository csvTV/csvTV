// Load the record and recovery code when an account actually needs its Dropbox files.
export { tableMatchesDropboxBase } from './dropbox-sync-file.ts';
export { DropboxSync, mergedTables, unsyncedCount } from './dropbox-sync.ts';
export { restoreBackup, restoreOutcomeLabel } from './dropbox-restore.ts';
export { writeBackup } from './dropbox-backup.ts';
export { publishDerived } from './dropbox-derived.ts';
export { adoptReset, checkResetEpoch, checkResetHistory, performReset, reserveBackupWriter,
  resetEpoch, resetMarker, reviewMergeDestination, reviewReset } from './dropbox-reset.ts';
export { DropboxProviderSettings, hasUnmigratedProviderKeys } from './dropbox-provider-settings.ts';
