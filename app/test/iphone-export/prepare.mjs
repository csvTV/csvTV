import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import ts from 'typescript';

if (process.argv.length !== 3) throw Error('Usage: node test/iphone-export/prepare.mjs <empty-output-directory>');
const destination = resolve(process.argv[2]);
const fixture = name => readFile(new URL(name, import.meta.url), 'utf8');
const built = name => readFile(new URL('../../dist/' + name, import.meta.url), 'utf8');
const files = new Map();
// Trace only static, local imports from the production modules actually used by this test.
const entry = await fixture('fixture.js');
files.set('fixture.js', entry);
const pending = ts.preProcessFile(entry).importedFiles.map(({ fileName }) => {
  if (!/^\.\/app\/[\w-]+\.js$/.test(fileName)) throw Error('Unexpected fixture dependency: ' + fileName);
  return fileName.slice('./app/'.length);
});
while (pending.length) {
  const name = pending.pop();
  if (files.has('app/' + name)) continue;
  const source = await built(name);
  files.set('app/' + name, source);
  for (const { fileName } of ts.preProcessFile(source).importedFiles) {
    if (!/^\.\/[\w-]+\.js$/.test(fileName)) throw Error('Unexpected compiled dependency: ' + fileName);
    pending.push(fileName.slice(2));
  }
}
for (const name of ['export.css', 'settings.css']) files.set('app/' + name, await built(name));
files.set('fixture.css', await fixture('fixture.css'));
files.set('index.html', await fixture('index.html'));
const hash = createHash('sha256');
for (const name of [...files.keys()].sort()) hash.update(name + '\0' + files.get(name) + '\0');
const build = hash.digest('hex').slice(0, 16);
files.set('index.html', files.get('index.html').replace('@@BUILD@@', build));

await mkdir(destination, { recursive: true });
if ((await readdir(destination)).length) throw Error('Choose an empty output directory for the device test.');
await mkdir(join(destination, 'app'));
for (const [name, contents] of files) await writeFile(join(destination, name), contents, { flag: 'wx' });
console.log('Prepared iPhone four-file share test ' + build + ' in ' + destination);
