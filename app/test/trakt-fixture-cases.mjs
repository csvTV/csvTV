import { BlobWriter, Uint8ArrayReader, ZipWriter } from '../dist/zip-native.js';

/** Generate real ZIP bytes entirely in memory, in either Node or a browser. */
export async function traktMemberZip(members, options = {}) {
  const writer = new ZipWriter(new BlobWriter('application/zip'), { useWebWorkers: false, level: 6, ...options });
  const encoder = new TextEncoder();
  for (const [name, value] of Object.entries(members)) {
    const bytes = typeof value === 'string' ? encoder.encode(value) : value;
    await writer.add(name, new Uint8ArrayReader(bytes));
  }
  return new File([await writer.close()], 'fictional-trakt.zip', { type: 'application/zip' });
}

export function traktZip(files, options) {
  return traktMemberZip(Object.fromEntries(Object.entries(files).map(([name, data]) => [name, JSON.stringify(data)])), options);
}
