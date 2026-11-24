/** A line number always refers to the physical input, including quoted newlines. */
interface RecordFields {
  line: number;
  fields: string[];
}

export interface FormatError {
  line: number;
  reason: string;
}

export function decodeInput(input: Uint8Array | string): { text: string; error?: FormatError } {
  if (typeof input === "string") {
    // A JS caller can supply an unpaired surrogate, which UTF-8 cannot represent.
    const invalid = input.search(/[\uD800-\uDFFF]/u);
    if (invalid < 0) return { text: input };
    const start = Math.max(input.lastIndexOf("\n", invalid), input.lastIndexOf("\r", invalid)) + 1;
    const text = input.slice(0, start);
    return { text, error: { line: text.split(/\r\n|[\r\n]/).length, reason: "Invalid Unicode text" } };
  }
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  try {
    return { text: decoder.decode(input) };
  } catch {
    // Only pay for line-by-line decoding on the error path. UTF-8 characters
    // cannot span an ASCII CR or LF. Keep the complete lines before the failure
    // so a recognizable newer header can still take precedence.
    let start = 0;
    let line = 1;
    while (start < input.length) {
      let end = start;
      while (end < input.length && input[end] !== 10 && input[end] !== 13) end++;
      if (end < input.length) end += input[end] === 13 && input[end + 1] === 10 ? 2 : 1;
      try {
        decoder.decode(input.subarray(start, end));
      } catch {
        return { text: decoder.decode(input.subarray(0, start)), error: { line, reason: "Invalid UTF-8" } };
      }
      start = end;
      line++;
    }
    throw new Error("Unable to locate invalid UTF-8");
  }
}

/** Fixed comma delimiter, LF/CRLF records, no trimming or type inference. */
export function* records(text: string, complete = true, maxFields = Infinity): Generator<RecordFields | FormatError> {
  let index = text.startsWith("\uFEFF") ? 1 : 0;
  let line = 1;
  while (index < text.length) {
    const recordLine = line;
    const recordStart = index;
    const fields: string[] = [];
    for (;;) {
      if (text[index] === '"') {
        const start = ++index;
        for (;;) {
          if (index === text.length) {
            if (complete) yield { line: recordLine, reason: "Unclosed quoted field" };
            return;
          }
          if (text[index] === '"') {
            if (text[index + 1] !== '"') break;
            index += 2;
          } else {
            if (text[index] === "\n" || (text[index] === "\r" && text[index + 1] !== "\n")) line++;
            index++;
          }
        }
        fields.push(text.slice(start, index++).replaceAll('""', '"'));
      } else {
        const start = index;
        while (index < text.length && text[index] !== "," && text[index] !== "\r" && text[index] !== "\n") {
          if (text[index] === '"') {
            yield { line, reason: "Quote inside an unquoted field" };
            return;
          }
          index++;
        }
        fields.push(text.slice(start, index));
      }

      if (text[index] === ",") {
        if (fields.length >= maxFields) throw Error('A CSV row exceeds the ' + maxFields + '-column import limit.');
        index++;
        continue;
      }
      const emptyLine = index === recordStart;
      if (index < text.length) {
        if (text.startsWith("\r\n", index)) index += 2;
        else if (text[index] === "\n") index++;
        else {
          yield { line, reason: "Expected a comma or record ending" };
          return;
        }
        line++;
      }
      if (!emptyLine) yield { line: recordLine, fields };
      break;
    }
  }
}

export function quoteField(value: string): string {
  return /[",\r\n]/.test(value) ? '"' + value.replaceAll('"', '""') + '"' : value;
}
