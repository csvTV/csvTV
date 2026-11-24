import { copyFile, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { createOfflineBuild } from './offline-build.mjs';
import { pagesHeaders } from './hosting-policy.mjs';
import { shellModules } from './shell-modules.mjs';

const styles = ['settings.css', 'application.css', 'home-search.css', 'show.css', 'season.css',
  'personal-sheets.css', 'lists.css', 'library.css', 'watch-views.css', 'cast.css', 'statistics.css', 'export.css'];
const assets = ['favicon.svg', 'favicon-32.png', 'apple-touch-icon.png', 'tmdb-logo.svg', 'theme-start.js'];
await copyFile(new URL('../LICENSE', import.meta.url), new URL('dist/LICENSE.txt', import.meta.url));
// Component fixtures use individual stylesheets. The shipped page makes one blocking request.
for (const asset of [...assets,...styles]) {
  await copyFile(new URL(asset, import.meta.url), new URL('dist/' + asset, import.meta.url));
}
const css = await Promise.all(styles.map(name => readFile(new URL(name,import.meta.url),'utf8')));
await writeFile(new URL('dist/csvtv.css',import.meta.url),css.join('\n'));
const zipPackage = new URL('node_modules/@zip.js/zip.js/', import.meta.url);
const zipLicense = await readFile(new URL('LICENSE', zipPackage), 'utf8');
const zipModule = await readFile(new URL('index-native.min.js', zipPackage), 'utf8');
await writeFile(new URL('dist/zip-native.js', import.meta.url), '/*!\n' + zipLicense + '\n*/\n' + zipModule);

// The help sheet copies the same templates that the publication tests exercise.
const templateFiles = ['imdb/build.mjs','imdb/imdb-ratings.yml','mal/mal-build.mjs','mal/mal-ratings.yml'];
const templates = await Promise.all(templateFiles.map(async path =>
  [path.split('/')[1], await readFile(new URL('../jobs/' + path, import.meta.url), 'utf8')]));
const jobTextName = 'imdb-job-text.js';
await writeFile(new URL('dist/' + jobTextName, import.meta.url),
  'export const jobText = ' + JSON.stringify(Object.fromEntries(templates)) + ';\n');

const key = process.env.CSVTV_DROPBOX_APP_KEY;
const index = new URL('dist/index.html',import.meta.url);
let html = await readFile(new URL('index.html',import.meta.url),'utf8');
if (key) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(key)) throw Error('Invalid public Dropbox app key.');
  html = html.replace('name="dropbox-app-key" content=""','name="dropbox-app-key" content="' + key + '"');
}
// A change to the CSV reader can fix a compatibility guard without changing the surrounding HTML.
const js = (await readdir(new URL('src/',import.meta.url))).filter(file => file.endsWith('.ts') && !file.endsWith('.d.ts')).map(file => file.slice(0,-3) + '.js');
const files = new Map(await Promise.all(['index.html','csvtv.css',...assets,...js,'zip-native.js',jobTextName].map(async name =>
  [name,name === 'index.html' ? html : await readFile(new URL('dist/' + name,import.meta.url))])));
const sources = new Map(js.map(name => [name,files.get(name)]));
const supplied = new Set(['zip-native.js',jobTextName]);
const modules = shellModules(sources,supplied);
for (const name of js) if (!modules.reachable.has(name)) files.delete(name);
const marker = '/* startup dependencies */ {}';
// The blocking head script and module entry must agree on ticket validation
// even when a previous release's module is already in the browser cache.
const returnFile = ts.createSourceFile('dropbox-return.js',sources.get('dropbox-return.js').toString(),ts.ScriptTarget.Latest,false,ts.ScriptKind.JS);
const protocol = returnFile.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'dropboxReturnProtocol');
if (!protocol?.body || protocol.parameters.length) throw Error('Missing self-contained Dropbox return protocol');
const returnMarker = '/* Dropbox return protocol */ () => null';
const template = files.get('theme-start.js').toString();
if (!template.includes(returnMarker)) throw Error('Missing Dropbox return marker');
const theme = template.replace(returnMarker,() => 'function dropboxReturnProtocol() ' + protocol.body.getText(returnFile).replaceAll('\r\n','\n'));
if (!theme.includes(marker)) throw Error('Missing startup dependency marker');
const startupNames = ['main.js',...modules.startup];
const routeGroups = [
  ['record-screens.js',['home','library','statistics','season','watchlist','upcoming','more-to-watch']],
  ['catalog-screens.js',['show','search','cast','lists','ratings']],
  ['settings-screens.js',['settings','imdb-ratings','mal-scores']],
  ['recovery-screen.js',['recovery']],
  ['hand-merge-screen.js',['hand-merge']],
  ['export-screen.js',['export']],
];
const groups = routeGroups.map(([entry]) =>
  [entry,...shellModules(sources,supplied,entry).startup].filter(name => !startupNames.includes(name)));
const routes = Object.fromEntries(routeGroups.flatMap(([,pages],index) => pages.map(page => [page,index])));
const recordNames = [...new Set(groups.flat())];
const sizes = names => Object.fromEntries(names.map(name => [name,Buffer.byteLength(files.get(name))]));
function moduleHash(names) {
  const hash = createHash('sha256');
  for (const name of names) hash.update(createHash('sha256').update(files.get(name)).digest());
  return hash.digest('hex');
}
const startup = theme.replace(marker, () => JSON.stringify({base:sizes(startupNames),record:sizes(recordNames),groups,routes,
  groupHashes:groups.map(moduleHash),hash:moduleHash([...startupNames,...recordNames])}));
files.set('theme-start.js',startup);
await writeFile(new URL('dist/theme-start.js',import.meta.url),startup);
// Keep the filenames of removed app assets here so a suspended older tab can
// finish loading its installed version after a worker process restart.
const retiredFiles = ['choice-sheet.js','season-count-editor.js','screen-context.js',...styles];
const result = createOfflineBuild(files,await readFile(new URL('service-worker.js',import.meta.url),'utf8'),retiredFiles);
await writeFile(index,result.html);
await writeFile(new URL('dist/service-worker.js',import.meta.url),result.worker);
await writeFile(new URL('dist/_headers',import.meta.url), pagesHeaders);
