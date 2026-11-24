import assert from 'node:assert/strict';
import {createReleaseFolder} from './release-folder.mjs';

export function rehearsalFolder({allowClear=false} = {}) {
  const history = new Map(), files = new Map(), calls = [], deleted = [];
  const result = (status,body) => Response.json(body,{status});
  const fileMetadata = ({['.tag']: tag,...entry}) => entry;
  const notFound = () => result(409,{error_summary:'path/not_found/',error:{'.tag':'path',path:{'.tag':'not_found'}}});
  const uploadConflict = () => result(409,{error_summary:'path/conflict/file/',error:{'.tag':'path',reason:{'.tag':'conflict',conflict:{'.tag':'file'}},upload_session_id:''}});
  let revision = 0;
  async function request(address,options) {
    const route = new URL(address).pathname.split('/').pop();
    assert.equal(options.redirect,'error');
    assert.equal(options.method,'POST');
    const args = JSON.parse(options.headers['Dropbox-API-Arg'] ?? options.body);
    const path = args.path?.toLowerCase();
    calls.push({route,path,cursor:args.cursor,mode:args.mode});
    if (options.headers.Authorization === 'Bearer wrong-account') return result(409,{error_summary:'path/not_found/'});
    if (route === 'create_folder_v2') {
      if (files.has(path)) return result(409,{error_summary:'path/conflict/folder/'});
      const entry = {'.tag':'folder',id:'id:' + ++revision,name:path.split('/').at(-1),path_lower:path,path_display:args.path};
      files.set(path,{entry});
      return result(200,{metadata:entry});
    }
    if (route === 'get_metadata') return result(200,files.get(path).entry);
    if (route === 'list_revisions') {
      const versions = history.get(path);
      if (!versions) return notFound();
      const before = args.before_rev ? versions.findIndex(entry => entry.rev === args.before_rev) : -1;
      if (args.before_rev && before < 0) return result(409,{error_summary:'invalid_before_rev/'});
      // Dropbox returned 409 for a cursor at the first version of a live test file.
      if (args.before_rev && before === versions.length - 1) return result(409,{});
      const end = before + 1 + (args.limit ?? 10);
      return result(200,{is_deleted:!files.has(path),entries:versions.slice(before + 1,end).map(fileMetadata),has_more:end < versions.length});
    }
    if (route === 'upload') {
      const previous = files.get(path);
      if (previous && (args.mode === 'add' || args.mode?.update !== previous.entry.rev ||
          args.strict_conflict && Buffer.from(options.body).equals(previous.bytes))) return uploadConflict();
      const rev = String(++revision);
      const modified = new Date().toISOString();
      const entry = {'.tag':'file',client_modified:args.client_modified ?? modified,server_modified:modified,id:previous?.entry.id ?? 'id:' + revision,rev,name:path.split('/').at(-1),
        path_lower:path,path_display:args.path,content_hash:args.content_hash,size:options.body.length};
      files.set(path,{entry,bytes:options.body});
      history.set(path,[entry,...(history.get(path) ?? [])]);
      return result(200,fileMetadata(entry));
    }
    if (route === 'list_folder') {
      if (!files.has(path)) return notFound();
      if (args.recursive) assert.ok(path.endsWith('/backups'));
      const entries = [...files.values()].map(item=>item.entry).filter(entry=>args.recursive ? entry.path_lower === path || entry.path_lower.startsWith(path + '/') :
        entry.path_lower.slice(0,entry.path_lower.lastIndexOf('/')) === path);
      return result(200,{entries,has_more:false,cursor:'end'});
    }
    if (route === 'download') {
      const item = files.get(path);
      if (!item) return notFound();
      return new Response(item.bytes,{headers:{'Dropbox-API-Result':JSON.stringify(fileMetadata(item.entry))}});
    }
    if (route === 'delete_v2') {
      const item = [...files.values()].find(item=>item.entry.id === args.path);
      assert.equal(item.entry.rev,args.parent_rev);
      files.delete(item.entry.path_lower);
      deleted.push(item.entry.path_lower);
      return result(200,{metadata:item.entry});
    }
    throw Error('Unexpected fictional route.');
  }
  return {folder:createReleaseFolder({fetch:request,allowClear}),files,calls,deleted};
}
