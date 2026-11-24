const MiB = 1024 * 1024;
export const importLimits = {
  traktZip: 32 * MiB, zipEntries: 512, traktMember: 16 * MiB, traktTotal: 64 * MiB,
  aniListFile: 16 * MiB, csvFile: 16 * MiB, csvTotal: 32 * MiB, csvFiles: 16,
  csvColumns: 128, rows: 100_000, jsonDepth: 128, jsonStructures: 1_000_000,
} as const;

export class ImportLimitError extends Error {}

export function checkImportBytes(bytes: number, limit: number, description: string) {
  if (bytes > limit) throw new ImportLimitError(description + ' exceeds the ' + (limit / MiB) + ' MiB import limit.');
}

export function checkTraktMemberBytes(previous: number, current: number) {
  checkImportBytes(current, importLimits.traktMember, 'A Trakt file inside the ZIP');
  checkImportBytes(previous + current, importLimits.traktTotal, 'The expanded Trakt files');
}

export function checkImportRows(count: number) {
  if (count > importLimits.rows) throw new ImportLimitError('The selected data exceeds the ' + importLimits.rows.toLocaleString('en-US') + '-row import limit.');
}

/** Bound container allocation before JSON.parse, including sections the importer ignores. */
export function parseImportJson(text: string, preserveHistoryIds = false): unknown {
  let depth = 0, structures = 0;
  let copied = 0;
  const parts: string[] = [];
  const wideId = /\s*:\s*([1-9][0-9]{15,19})(?=\s*[,}])/y;
  for (let i = 0; i < text.length; i++) {
    switch (text[i]) {
      case '"': {
        // A quoted title may contain arbitrary punctuation and escaped quotes.
        const start = i;
        let escaped = false;
        for (i++; i < text.length && text[i] !== '"'; i++) {
          if (text[i] === '\\') { escaped = true; i++; }
        }
        if (preserveHistoryIds && (i - start === 3 && text.startsWith('"id"', start) ||
            escaped && i - start <= 13 && JSON.parse(text.slice(start, i + 1)) === 'id')) {
          // Trakt uses 64-bit history IDs. Preserve the literal before JSON.parse rounds it.
          wideId.lastIndex = i + 1;
          const match = wideId.exec(text);
          if (match && !Number.isSafeInteger(Number(match[1]))) {
            const end = wideId.lastIndex;
            parts.push(text.slice(copied, end - match[1].length), '"', match[1], '"');
            copied = end;
          }
        }
        break;
      }
      case '{': case '[':
        if (++depth > importLimits.jsonDepth) throw new ImportLimitError('This JSON is too deeply nested to import.');
        structures++;
        break;
      case '}': case ']': depth--; break;
      case ',': structures++; break;
    }
    if (structures > importLimits.jsonStructures) throw new ImportLimitError('This JSON contains too many nested items to import.');
  }
  return JSON.parse(copied ? parts.join('') + text.slice(copied) : text);
}

/** Check actual incoming bytes before retaining text, including decompressed ZIP output. */
export async function readImportText(writeTo: (sink: WritableStream<Uint8Array>) => Promise<unknown>,
  checkBytes: (count: number) => void) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const parts: string[] = [];
  let byteLength = 0;
  await writeTo(new WritableStream<Uint8Array>({
    write(chunk) {
      byteLength += chunk.byteLength;
      checkBytes(byteLength);
      parts.push(decoder.decode(chunk, {stream:true}));
    },
  }));
  parts.push(decoder.decode());
  return { text: parts.join(''), byteLength };
}

export function csvSelectionLimits(files: readonly File[]) {
  if (files.length > importLimits.csvFiles) throw new ImportLimitError('Choose up to ' + importLimits.csvFiles + ' CSV files at a time.');
  let total = 0;
  for (const file of files) {
    if (!Number.isSafeInteger(file.size) || file.size < 0) throw Error('Could not read ' + file.name + '. Select the file again.');
    checkImportBytes(file.size, importLimits.csvFile, 'A selected CSV');
    total += file.size;
  }
  checkImportBytes(total, importLimits.csvTotal, 'The CSV selection');
  let rows = 0;
  return { maxFields: importLimits.csvColumns, countDataRow: () => checkImportRows(++rows) };
}
