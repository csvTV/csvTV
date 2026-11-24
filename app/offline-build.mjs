import { createHash } from 'node:crypto';
import { pagesHeaders, permissionsPolicy, securityPolicy } from './hosting-policy.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const buildMeta = 'name="csvtv-build" content=""';
const placeholder = 'const SHELL = null;';

export function isShellAsset(name) {
  return /^[\w-]+\.(?:html|css|js|svg|png|ico|webmanifest)$/.test(name) &&
    name !== 'service-worker.js' && (!name.endsWith('.html') || name === 'index.html');
}

/** Build identity includes the worker so a policy-only change gets its own installation. */
export function createOfflineBuild(files, workerSource, retiredFiles = [], {documentSource} = {}) {
  if (documentSource !== undefined && documentSource !== 'offline-document.txt') throw Error('Unexpected offline document source');
  const input = files.get('index.html');
  const template = input && Buffer.from(input).toString('utf8');
  if (!template?.includes(buildMeta) || !workerSource.startsWith(placeholder)) throw Error('Missing offline build marker');
  const names = [...files.keys()].sort();
  const retired = [...new Set(retiredFiles)].filter(name => !files.has(name)).sort();
  if (![...names,...retired].every(isShellAsset)) {
    throw Error('Unexpected offline shell asset');
  }
  const hashes = Object.fromEntries(names.map(name => [name,hash(files.get(name))]));
  const build = hash(JSON.stringify([hashes,retired,hash(workerSource),pagesHeaders,documentSource]));
  const html = template.replace(buildMeta, 'name="csvtv-build" content="' + build + '"');
  hashes['index.html'] = hash(html);
  const sizes = Object.fromEntries(names.map(name => [name, Buffer.byteLength(name === 'index.html' ? html : files.get(name))]));
  const descriptor = {build,files:hashes,sizes,retired,documentPolicy:securityPolicy,permissionsPolicy,documentSource};
  const worker = workerSource.replace(placeholder, 'const SHELL = ' + JSON.stringify(descriptor) + ';');
  return {build, html, worker, hashes};
}
