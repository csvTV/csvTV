import { dropboxContentHash } from './dropbox-api.ts';

/** A successful reset must advance an existing file's revision even when its rows already match. */
export async function resetCsvPayload(desired: string, reviewed: string | Uint8Array | null): Promise<string> {
  if (reviewed === null) return desired;
  if (typeof reviewed === 'string') {
    if (await dropboxContentHash(desired) !== reviewed) return desired;
  } else {
    const bytes = new TextEncoder().encode(desired);
    if (bytes.length !== reviewed.length || !bytes.every((byte,i) => byte === reviewed[i])) return desired;
  }
  // Generated CSV has a single-line header followed by CRLF. Shortening only
  // that terminator also works at the file size limit and keeps quoted fields intact.
  const newline = desired.indexOf('\n');
  if (newline > 0 && desired[newline-1] === '\r') return desired.slice(0,newline-1) + desired.slice(newline);
  return desired.startsWith('\uFEFF') ? desired.slice(1) : '\uFEFF' + desired;
}
