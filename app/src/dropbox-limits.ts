const MiB = 1024 * 1024;
export const dropboxLimits = {file:64 * MiB, smallReply:256 * 1024, listingPage:4 * MiB,
  listingBytes:16 * MiB, pages:128, entries:50_000, csvRows:250_000, csvColumns:128,
  csvFields:4_000_000, physicalLines:1_000_000, restoreBytes:96 * MiB, backupFolders:128};

export class DropboxLimitError extends Error {
  readonly kind = 'too-large';
}

export function dropboxFileLimit(path:string) {
  return path.toLowerCase().endsWith('/completion.json') || path.toLowerCase() === '/csvtv-reset.json' ? dropboxLimits.smallReply : dropboxLimits.file;
}

export function checkDropboxBytes(size:number, limit:number) {
  if (!(size > limit)) return;
  const label = limit >= MiB ? (limit / MiB) + ' MiB' : (limit / 1024) + ' KiB';
  throw new DropboxLimitError('Dropbox data exceeds the ' + label + ' limit for this transfer.');
}

/** Scan the wire form before the CSV reader can allocate a field array or a finding for every row. */
export function checkDropboxFile(path:string, data:string|Uint8Array) {
  const limit = dropboxFileLimit(path);
  checkDropboxBytes(data.length,limit);
  // A UTF-16 code unit needs at most three UTF-8 bytes.
  if (typeof data === 'string' && data.length > limit / 3) checkDropboxBytes(new Blob([data]).size,limit);
  if (!path.toLowerCase().endsWith('.csv')) return;
  let quoted = false, columns = 1, records = 0, nonempty = false, fields = 0, lines = 0, previous = 0;
  const countRecord = () => {
    if (nonempty && ++records > dropboxLimits.csvRows + 1)
      throw new DropboxLimitError('A Dropbox CSV exceeds the 250,000-row sync limit.');
    if (nonempty && (fields += columns) > dropboxLimits.csvFields)
      throw new DropboxLimitError('A Dropbox CSV exceeds the 4,000,000-field sync limit.');
    nonempty = false;
    columns = 1;
  };
  for (let i = 0; i < data.length; i++) {
    const byte = typeof data === 'string' ? data.charCodeAt(i) : data[i];
    if ((byte === 13 || (byte === 10 && previous !== 13)) && ++lines > dropboxLimits.physicalLines)
      throw new DropboxLimitError('A Dropbox CSV exceeds the 1,000,000-line sync limit.');
    previous = byte;
    if (!quoted && (byte === 10 || byte === 13)) { countRecord(); continue; }
    nonempty = true;
    if (byte === 34) quoted = !quoted;
    if (!quoted && byte === 44 && ++columns > dropboxLimits.csvColumns)
      throw new DropboxLimitError('A Dropbox CSV exceeds the 128-column sync limit.');
  }
  countRecord();
}
