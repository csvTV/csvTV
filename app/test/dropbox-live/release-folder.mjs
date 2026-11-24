import {createHash, randomUUID} from 'node:crypto';

const rpc = 'https://api.dropboxapi.com/2/files/';
const content = 'https://content.dropboxapi.com/2/files/';
const routes = new Map(Object.entries({
  list: rpc + 'list_folder', continue: rpc + 'list_folder/continue', revisions: rpc + 'list_revisions',
  create: rpc + 'create_folder_v2', delete: rpc + 'delete_v2', inspect: rpc + 'get_metadata',
  download: content + 'download', upload: content + 'upload',
}));
const csv = '(?:watched|ratings|lists|shows|settings)\\.csv';
const generation = '/backups/[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9a-f-]{36}';
const filePath = new RegExp('^(?:/(?:' + csv + '|summary\\.csv|README\\.txt)|' + generation + '/(?:' + csv + '|completion\\.json))$');
const folderPath = new RegExp('^(?:|/backups|' + generation + ')$');
const json = bytes => JSON.parse(bytes.toString('utf8'));
const jsonBytes = value => Buffer.from(JSON.stringify(value));
const parent = path => path.slice(0,path.lastIndexOf('/'));
const insist = (ok, message) => { if (!ok) throw Error(message); };

const clearScopes = new Set(['watched','ratings','lists','settings','backups']);
const uuid = value => typeof value === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(value);
function validTestClear(state) {
  if (state?.version !== 2 || !Number.isSafeInteger(state.backupsClearedAt) || state.backupsClearedAt < 0 ||
      !state.generations || !state.ancestry || !Array.isArray(state.pending) ||
      (state.claim !== undefined && (!state.pending.length || !uuid(state.claim))) ||
      Object.keys(state).some(key=>!['version','backupsClearedAt','pending','generations','ancestry','reservations','claim'].includes(key))) return false;
  const scopes = Object.keys(state.generations);
  return scopes.length > 0 && scopes.length === Object.keys(state.ancestry).length && scopes.every(scope=>
    clearScopes.has(scope) && uuid(state.generations[scope]) && Array.isArray(state.ancestry[scope]) &&
    state.ancestry[scope].every(id=>id === null || uuid(id))) && state.pending.every(scope=>scopes.includes(scope));
}

/** A unique live Dropbox folder presents an empty app root to the exact packaged client. */
export function createReleaseFolder({fetch:request = fetch,allowClear=false} = {}) {
  const root = '/csvtv-live-' + randomUUID();
  // Only successful strict creations and uploads confer ownership for later cleanup.
  const known = new Map(), cursors = new Map(), grants = new Set();
  let retired = false, reserving;
  async function send(endpoint, token, args, bytes) {
    insist(typeof token === 'string' && token.length > 0, 'A Dropbox access token is required.');
    const headers = {Authorization:'Bearer ' + token};
    let body;
    if (endpoint === 'upload' || endpoint === 'download') {
      headers['Dropbox-API-Arg'] = JSON.stringify(args);
      if (endpoint === 'upload') {
        headers['Content-Type'] = 'application/octet-stream';
        body = bytes;
      }
    } else {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(args);
    }
    const response = await request(routes.get(endpoint),{method:'POST',headers,body,redirect:'error',cache:'no-store',
      signal:AbortSignal.timeout(120000)});
    return {status:response.status,bytes:Buffer.from(await response.arrayBuffer()),
      metadata:response.headers.get('Dropbox-API-Result'),retryAfter:response.headers.get('Retry-After')};
  }
  function relative(entry, expected) {
    insist(typeof entry?.id === 'string' && entry.id && typeof entry.path_lower === 'string', 'Dropbox returned incomplete test metadata.');
    const result = {...entry};
    for (const field of ['path_lower','path_display']) {
      if (result[field] === undefined) continue;
      const path = result[field];
      insist(typeof path === 'string' && (path.toLowerCase() === root || path.toLowerCase().startsWith(root + '/')),
        'Dropbox returned a path outside the test folder.');
      result[field] = path.slice(root.length);
    }
    insist(expected === undefined || result.path_lower === expected.toLowerCase(), 'Dropbox returned the wrong test path.');
    return result;
  }
  function verify(entry, checkRevision = true) {
    const recorded = known.get(entry.path_lower);
    insist(recorded && recorded.id === entry.id && (!checkRevision || recorded.rev === entry.rev),
      'The test folder contains an unrecognized or independently changed item. Nothing further will be removed.');
    return entry;
  }
  async function prepare(token) {
    insist(!retired, 'The test folder has been closed.');
    const grant = createHash('sha256').update(token).digest('hex');
    if (grants.has(grant)) return;
    if (!known.has('')) {
      if (reserving) { await reserving; return prepare(token); }
      reserving = (async () => {
        const reply = await send('create',token,{path:root,autorename:false});
        insist(reply.status === 200, 'Dropbox could not reserve the new test folder (HTTP ' + reply.status + ').');
        known.set('',relative(json(reply.bytes).metadata,''));
        grants.add(grant);
      })();
      // A lost reply may have created a folder. Never adopt it on a retry.
      await reserving;
    } else {
      const reply = await send('inspect',token,{path:root});
      insist(reply.status === 200, 'This Dropbox grant cannot access the original test folder.');
      verify(relative(json(reply.bytes),''));
      grants.add(grant);
    }
  }
  async function listContents(token, directory) {
    const entries = [], seen = new Set();
    let reply = await send('list',token,{path:root + directory,recursive:false});
    for (;;) {
      insist(reply.status === 200,'Dropbox could not verify test folder contents.');
      const page = json(reply.bytes);
      for (const raw of page.entries) {
        const entry = verify(relative(raw));
        insist(parent(entry.path_lower) === directory.toLowerCase(), 'Unexpected test folder listing.');
        entries.push(entry);
      }
      if (!page.has_more) return entries;
      insist(typeof page.cursor === 'string' && page.cursor && !seen.has(page.cursor),'Invalid test folder listing cursor.');
      seen.add(page.cursor);
      reply = await send('continue',token,{cursor:page.cursor});
    }
  }
  async function remove(token, path, expectedRevision) {
    const lower = path.toLowerCase(), recorded = known.get(lower);
    insist(recorded && lower && recorded.rev === expectedRevision,'The deletion did not match an owned test revision.');
    if (!recorded.rev) {
      const inspection = await send('inspect',token,{path:root + path});
      insist(inspection.status === 200,'Could not verify the test directory for removal.');
      verify(relative(json(inspection.bytes),path));
      insist((await listContents(token,path)).length === 0,'Refusing to delete a nonempty test directory.');
    }
    const reply = await send('delete',token,{path:recorded.id,parent_rev:expectedRevision});
    if (reply.status === 200) {
      const result = verify(relative(json(reply.bytes).metadata,path));
      known.delete(lower);
      reply.bytes = jsonBytes({metadata:result});
    }
    return reply;
  }
  async function forward(endpoint,token,args,uploadBytes) {
    insist(routes.has(endpoint) && endpoint !== 'inspect','Unknown Dropbox test endpoint.');
    insist(args && typeof args === 'object','Invalid Dropbox request arguments.');
    const priorPage = endpoint === 'continue' ? cursors.get(args.cursor) : null;
    const path = endpoint === 'continue' ? priorPage?.path : args.path;
    const recursive = priorPage ? priorPage.recursive : args.recursive === true;
    const directory = ['list','continue','create'].includes(endpoint);
    const marker = path === '/csvtv-reset.json' && (endpoint === 'download' || endpoint === 'upload');
    insist(typeof path === 'string' && (directory ? folderPath.test(path) : marker || filePath.test(path) || endpoint === 'delete' && folderPath.test(path)),
      'Only csvTV test files and backup directories are permitted.');
    insist(!['create','delete'].includes(endpoint) || path !== '', 'The test root is reserved.');
    insist(endpoint !== 'list' || args.recursive === false || recursive && path === '/backups','Recursive listing is limited to test backups.');
    insist(endpoint !== 'create' || args.autorename === false,'Folder creation must be strict.');
    if (endpoint === 'upload') {
      insist(args.autorename === false && args.strict_conflict === true && uploadBytes instanceof Uint8Array, 'A strict file upload is required.');
      insist(args.mode === 'add' || args.mode === 'overwrite' || args.mode?.['.tag'] === 'update' && typeof args.mode.update === 'string',
        'Unsupported Dropbox write mode.');
      if (marker) {
        insist(args.mode !== 'overwrite' && uploadBytes.length <= 65536,'Test backup reservations require a conditional write.');
        const state = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(uploadBytes));
        const reservation = state?.version === 1 && state.backupsClearedAt === 0 &&
          Array.isArray(state.pending) && !state.pending.length && state.generations && typeof state.generations === 'object' &&
          !Array.isArray(state.generations) && !Object.keys(state.generations).length && Array.isArray(state.reservations) &&
          Object.keys(state).every(key=>['version','backupsClearedAt','pending','generations','reservations'].includes(key));
        insist((reservation || allowClear && validTestClear(state)) && (state.reservations === undefined ||
          Array.isArray(state.reservations) && state.reservations.every(name=>typeof name === 'string' && folderPath.test('/backups/'+name) && known.has('/backups/'+name))),
          'Only backup reservations in this test folder are permitted.');
      }
    }
    insist(known.has(''), 'Reserve the test folder before using it.');
    await prepare(token);
    if (endpoint === 'delete') return remove(token,path,args.parent_rev);
    if (endpoint === 'create' || endpoint === 'upload') {
      const parentEntry = known.get(parent(path).toLowerCase());
      insist(parentEntry && !parentEntry.rev,'Cannot write under an unowned test directory.');
    }
    const scoped = endpoint === 'continue' ? {cursor:args.cursor} : {...args,path:root + path};
    // Older release copies may use overwrite. Limit those writes to owned revisions.
    if (endpoint === 'upload' && args.mode === 'overwrite') {
      const revision = known.get(path.toLowerCase())?.rev;
      scoped.mode = revision ? {'.tag':'update',update:revision} : 'add';
    }
    if (endpoint === 'upload' && args.mode?.['.tag'] === 'update' && known.get(path.toLowerCase())?.rev !== args.mode.update) {
      return {status:409,bytes:jsonBytes({error_summary:'path/conflict/file/'})};
    }
    const reply = await send(endpoint,token,scoped,uploadBytes);
    if (reply.status !== 200) return reply;
    if (endpoint === 'download') {
      const entry = verify(relative(JSON.parse(reply.metadata),path),false);
      reply.metadata = JSON.stringify(entry);
    } else {
      const body = json(reply.bytes);
      if (endpoint === 'list' || endpoint === 'continue' || endpoint === 'revisions') {
        body.entries = body.entries.map(raw => {
          const entry = relative(raw,endpoint === 'revisions' ? path : undefined);
          // A recursive listing may include the queried folder itself. Preserve it in the app's response.
          const folderItself = entry.path_lower === path.toLowerCase() && entry['.tag'] === 'folder';
          if (endpoint !== 'revisions') insist(recursive ? folderItself || entry.path_lower.startsWith(path.toLowerCase()+'/') :
            parent(entry.path_lower) === path.toLowerCase(), 'Unexpected Dropbox listing parent.');
          return verify(entry,false);
        });
        if (endpoint !== 'revisions' && body.has_more) {
          insist(typeof body.cursor === 'string' && body.cursor,'Missing Dropbox listing cursor.');
          cursors.set(body.cursor,{path,recursive});
        }
      } else {
        const entry = relative(endpoint === 'create' ? body.metadata : body,path);
        const prior = known.get(entry.path_lower);
        insist(!prior || prior.id === entry.id,'Dropbox replaced an owned item during the test.');
        known.set(entry.path_lower,entry);
        reply.bytes = jsonBytes(endpoint === 'create' ? {metadata:entry} : entry);
        return reply;
      }
      reply.bytes = jsonBytes(body);
    }
    return reply;
  }
  async function read(token,path) {
    insist(filePath.test(path) && known.has(path.toLowerCase()),'The independent check needs an owned file.');
    await prepare(token);
    const reply = await send('download',token,{path:root + path});
    insist(reply.status === 200,'The independent Dropbox download failed.');
    const entry = verify(relative(JSON.parse(reply.metadata),path));
    const hash = createHash('sha256'), block = 4 * 1024 * 1024;
    for (let start = 0; start < reply.bytes.length; start += block) {
      hash.update(createHash('sha256').update(reply.bytes.subarray(start,start + block)).digest());
    }
    insist(hash.digest('hex') === entry.content_hash && entry.size === reply.bytes.length,
      'The downloaded test file size or hash did not match Dropbox metadata.');
    return {bytes:reply.bytes,rev:entry.rev,contentHash:entry.content_hash};
  }
  async function cleanup(token) {
    if (retired) return;
    insist(known.has(''),'Cannot clean up an unconfirmed folder.');
    await prepare(token);
    const rootInfo = await send('inspect',token,{path:root});
    insist(rootInfo.status === 200,'Cannot verify the test folder before cleanup.');
    const folder = verify(relative(json(rootInfo.bytes),''));
    const ordered = [];
    async function visit(directory) {
      for (const entry of await listContents(token,directory)) {
        if (entry['.tag'] === 'folder') await visit(entry.path_lower);
        ordered.push(entry);
      }
    }
    await visit('');
    insist(ordered.length + 1 === known.size,'Dropbox did not return every recorded test item.');
    for (const entry of ordered) {
      const reply = await remove(token,entry.path_lower,entry.rev);
      insist(reply.status === 200,'Dropbox did not acknowledge removal of an owned test item.');
    }
    insist((await listContents(token,'')).length === 0,'The test folder is no longer empty.');
    const reply = await send('delete',token,{path:folder.id});
    insist(reply.status === 200 && relative(json(reply.bytes).metadata,'').id === folder.id,'Could not confirm test folder removal.');
    retired = true;
    known.clear(); grants.clear(); cursors.clear();
  }
  return {path:root,prepare,forward,read,cleanup};
}
