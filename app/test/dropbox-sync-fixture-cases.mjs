import { DropboxSync } from '../dist/dropbox-sync.js';
import { dropboxContentHash } from '../dist/dropbox-api.js';
import { emptyTables, rowKey } from '../dist/model.js';
import { readCsv, writeCsv } from '../dist/csv.js';
import { dropboxSessionInfo, StaleSnapshotError } from '../dist/storage.js';
const encoder = new TextEncoder();
const tagKey = crypto.subtle.importKey('raw',encoder.encode('fictional-device-key'),{name:'HMAC',hash:'SHA-256'},false,['sign']);

export const time = Date.UTC(2026, 9, 1, 12);
export const credentials = { accountId: 'fictional-account', instanceId: 'a', accessToken: 'test-access',
  refreshToken: 'test-refresh', accessExpiresAt: time + 3600000, signInDeadline: time + 7 * 86400000, providerExpiresAt: time + 7 * 86400000 };
export const watch = (count, episode = 1, id = episode) => ({ show_id: 7, season: 1, episode, episode_id: id,
  show: 'Coastal Dial', title: 'Transmission ' + id, times_watched: count });
export const watchCsv = (count, episode = 1) => writeCsv('watched', count === 0 ? [] : [watch(count, episode)]);
export const count = async store => (await store.snapshot()).tables.watched[0]?.times_watched ?? 0;
export const edit = async (store, ...rows) => store.commit((await store.snapshot()).revision, { replace: { watched: rows } });
/** The fixture observed the original upload succeed; the product still needs the owner's answer. */
export const confirmSingleDelivery = { doubleMarks:async review => {
  if (!review.delivery) throw Error('Unexpected overlapping watch edits');
  return {choice:'one'};
} };
export const sync = (store, cloud, hooks = {}, now = () => time) => new DropboxSync(store, cloud, credentials, hooks, now);

export function memoryStore() {
  let data = { revision: 1n, tables: emptyTables(), sync: {}, local: { syncAccountId: credentials.accountId,
    dropboxSession: credentials } };
  return {
    async rememberDropboxMarker(session,current) {
      if (!current() || data.local.dropboxSession?.instanceId !== session.instanceId ||
          data.local.syncAccountId !== session.accountId) throw new StaleSnapshotError();
      data.local.dropboxResetSeen ??= {accountId:session.accountId,generations:{}};
    },
    async providerContentTag(hash) {
      const bytes = new Uint8Array(await crypto.subtle.sign('HMAC',await tagKey,encoder.encode(hash)));
      return 'h1:'+Array.from(bytes,byte=>byte.toString(16).padStart(2,'0')).join('');
    },
    async snapshot() { return structuredClone(data); },
    async dropboxResetSnapshot() {
      const {syncAccountId,dropboxSession,dropboxResetSeen}=data.local;
      return structuredClone({revision:data.revision,local:{syncAccountId,dropboxResetSeen,
        dropboxSession:dropboxSession && dropboxSessionInfo(dropboxSession)}});
    },
    async dropboxState() {
      const {syncAccountId,dropboxSession} = data.local;
      return {revision:data.revision,accountId:syncAccountId,session:structuredClone(dropboxSession)};
    },
    async dropboxPublicationState() {
      return structuredClone({revision:data.revision,hash:data.local.dropboxShowsHash,settings:data.tables.settings,sync:data.sync});
    },
    async commit(revision, patch, options = {}) {
      if (data.revision !== revision || (options.current && !options.current())) throw new StaleSnapshotError();
      const next = structuredClone(data);
      for (const [key, rows] of Object.entries(patch.replace ?? {})) {
        next.tables[key] = rows;
        if (!options.syncWrite) delete next.local['dropboxCanceled:' + key];
      }
      for (const table of new Set([...Object.keys(patch.remove ?? {}), ...Object.keys(patch.put ?? {})])) {
        const rows = new Map(next.tables[table].map(row => [rowKey(table,row),row]));
        for (const key of patch.remove?.[table] ?? []) rows.delete(Array.isArray(key) ? JSON.stringify(key) : String(key));
        for (const row of patch.put?.[table] ?? []) rows.set(rowKey(table,row),row);
        next.tables[table] = [...rows.values()];
        if (!options.syncWrite) delete next.local['dropboxCanceled:' + table];
      }
      Object.assign(next.sync, patch.sync);
      Object.assign(next.local, patch.local);
      for (const key of patch.removeLocal ?? []) delete next.local[key];
      next.revision++;
      data = structuredClone(next);
    },
  };
}

export class FictionalDropbox {
  history = new Map();
  live = new Map();
  calls = [];
  counter = 0;
  before = async () => {};
  after = async () => {};
  async #step(method, path, args = {}) {
    this.calls.push({ method, path, ...args });
    await this.before(method, path, args);
  }
  async list(path) {
    await this.#step('list', path);
    return [...this.live.values()].map(file => ({ ...file.metadata }));
  }
  async download(path) {
    await this.#step('download', path);
    return structuredClone(this.live.get(path) ?? null);
  }
  async revisions(path, before, maximum=Infinity) {
    await this.#step('revisions', path, {before,maximum});
    const entries = (this.history.get(path) ?? []).map(file => ({ ...file.metadata }));
    if (!before) return entries.slice(0,maximum);
    const index = entries.findIndex(entry => entry.rev === before);
    if (index < 0) throw Error('Unknown fictional revision cursor');
    return entries.slice(index+1,index+1+maximum);
  }
  async put(path, content, cm = '2020-05-02T11:12:13Z') {
    const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    const seq = ++this.counter;
    const metadata = { path, name: path.slice(1), kind: 'file', rev: 'r' + seq, size: bytes.length,
      id:this.live.get(path)?.metadata.id ?? 'id:fictional-'+seq,
      clientModified: cm, serverModified: new Date(time + seq * 1000).toISOString(), contentHash: await dropboxContentHash(bytes) };
    const result = { metadata, bytes };
    this.history.set(path, [result, ...(this.history.get(path) ?? [])]);
    this.live.set(path, result);
    return metadata;
  }
  async upload(path, content, options) {
    await this.#step('upload', path, { content, options });
    const current = this.live.get(path)?.metadata;
    if ((options.mode === 'add' && current) || (options.mode === 'update' && current?.rev !== options.revision)) {
      throw Object.assign(new Error('Fictional revision conflict'), { kind: 'conflict' });
    }
    const metadata = await this.put(path, content, options.clientModified);
    await this.after('upload', path, metadata);
    return metadata;
  }
  rows(table) {
    const current = this.live.get('/' + table + '.csv');
    return current ? readCsv(table, current.bytes).rows : [];
  }
}
