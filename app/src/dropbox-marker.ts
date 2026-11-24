/** Destructive and recovery decisions need one unambiguous value for every JSON property. */
export function parseDropboxMarker(text: string) {
  const parsed = JSON.parse(text);
  const objects: Set<string>[] = [];
  for (const match of text.matchAll(/("(?:[^"\\]|\\.)*")(\s*:)?|[{}]/gs)) {
    if (match[0] === '{') objects.push(new Set());
    else if (match[0] === '}') objects.pop();
    else if (match[2]) {
      const name: string = JSON.parse(match[1]);
      const names = objects[objects.length - 1];
      if (names.has(name)) throw Error('Repeated property in the Dropbox marker.');
      names.add(name);
    }
  }
  return parsed;
}
