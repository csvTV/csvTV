import assert from 'node:assert/strict';
import { fictionalDropboxTransport } from './dropbox-roundtrip-cases.mjs';
import { dropboxContentHash } from '../dist/dropbox-api.js';
import { writeCsv } from '../dist/csv.js';

export async function waitForStoredGrant(browser, present) {
  await browser.waitFor('(' + (async function(expected) {
    return new Promise((resolve,reject) => {
      const open = indexedDB.open('csvTV');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const key = db.transaction('local').objectStore('local').getKey('dropboxSession');
        key.onsuccess = () => { db.close(); resolve((key.result !== undefined) === expected); };
        key.onerror = () => { db.close(); reject(key.error); };
      };
    });
  }).toString() + ')(' + present + ')', present ? 'stored Dropbox grant' : 'old Dropbox grant removed from IndexedDB');
}

// Complete the state transition normally performed after the OAuth token exchange.
// This helper runs only in isolated browser profiles. The app reads its keys over HTTP.
export async function linkFixture(browser, origin, base = '/tracker/', legacy = false) {
  await browser.navigate(origin + (base === '/' ? '/tmdb-logo.svg' : '/fixture'));
  await renewFixture(browser, base, legacy);
}

export async function renewFixture(browser, base = '/tracker/', legacy = false, accountId = 'fictional-owner') {
  await browser.evaluate('(' + (async function(base, legacy, accountId) {
    const {openDeviceStore} = await import(base + 'storage.js');
    const store = await openDeviceStore();
    try {
      const signInDeadline = Date.now() + 7 * 86400000;
      await store.storeExchangedSession({accountId, instanceId:crypto.randomUUID(),
        accessToken:'example-access', refreshToken:'example-refresh',
        accessExpiresAt:Date.now() + 4 * 3600000, signInDeadline,
        ...(legacy ? {} : {appKey:'fictional-browser-registration',providerExpiresAt:signInDeadline})});
      localStorage.setItem('csvTV-public-dropbox-app-key','fictional-browser-registration');
    } finally { await store.closeForUpdate(); }
  }).toString() + ')(...' + JSON.stringify([base,legacy,accountId]) + ')');
}

// The old grant can still display "Saved in Dropbox" while the app processes the replacement.
export async function renewSyncedFixture(browser) {
  await renewFixture(browser);
  await browser.waitFor(`(async () => {
    if (document.querySelector('.sync-state')?.dataset.synced !== 'true') return false;
    const {openDeviceStore} = await import('/tracker/storage.js');
    const store = await openDeviceStore();
    try {
      const {status,session} = await store.dropboxState();
      return status?.synced && session && status.instanceId === session.instanceId;
    } finally { store.close(); }
  })()`, 'replacement Dropbox session finishes syncing');
}

const episodes = [1, 2].map(number => ({
  id: 45010 + number, episode_number: number, name: 'Recording ' + number, runtime: 30, air_date:'2020-10-01',
}));

function metadata(path) {
  switch (path) {
    case '/3/configuration':
      return { images: { secure_base_url:'https://image.tmdb.org/t/p/', poster_sizes:['w154'],
        backdrop_sizes:['w300'], still_sizes:['w92'], profile_sizes:['w45'] } };
    case '/3/configuration/countries': return [{iso_3166_1:'NZ', english_name:'New Zealand'}];
    case '/3/tv/45':
      return {id:45, name:'The Listening House', first_air_date:'2019-10-01', overview:'A family hears forgotten broadcasts.',
        status:'Ended', seasons:[{season_number:1, name:'Season 1', episode_count:2}], origin_country:['NZ'],
        vote_average:7.25, vote_count:24, next_episode_to_air:null,
        last_episode_to_air:{season_number:1,episode_number:2,air_date:'2020-10-01'},
        keywords:{results:[]}, external_ids:{imdb_id:null}};
    case '/3/tv/45/season/1': return {season_number:1, name:'Season 1', episodes};
    case '/3/tv/45/aggregate_credits': return {id:45, cast:[]};
    case '/3/tv/45/recommendations': return {page:1,total_pages:0,results:[]};
    case '/3/tv/46': return {id:46,name:'Signal Park',status:'Planned',seasons:[],keywords:{results:[]},external_ids:{imdb_id:null}};
    case '/3/tv/46/external_ids': return {id:46,imdb_id:null};
    default: throw Error('Unexpected metadata path ' + path);
  }
}

const routes = new Map(Object.entries({
  '/2/files/list_folder':'list', '/2/files/list_revisions':'revisions', '/2/files/create_folder_v2':'create',
  '/2/files/download':'download', '/2/files/upload':'upload', '/2/files/delete_v2':'delete',
}));

/** Intercept only provider HTTP, preserving the app's fetch, XHR, CORS and credential handling. */
export function offlineProviders(origin, answerToken) {
  const cloud = fictionalDropboxTransport();
  const metadataReads = new Set();
  const state = {online:true};
  async function respond({requestId, request}, send) {
    if (!state.online) {
      await send('Fetch.failRequest', {requestId, errorReason:'InternetDisconnected'});
      return;
    }
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    const responseHeaders = new Headers({
      'Access-Control-Allow-Origin':origin, 'Access-Control-Allow-Methods':'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers':'Authorization, Content-Type, Dropbox-API-Arg',
      'Access-Control-Expose-Headers':'Dropbox-API-Result', 'Cache-Control':'no-store',
    });
    let responseCode = 200, body = '';
    if (request.method === 'OPTIONS') {
      responseCode = 204;
    } else if (url.hostname === 'api.themoviedb.org') {
      assert.equal(headers.get('Authorization'), 'Bearer fictional-offline-key');
      metadataReads.add(url.pathname);
      body = Buffer.from(JSON.stringify(metadata(url.pathname))).toString('base64');
      responseHeaders.set('Content-Type','application/json');
    } else if (url.hostname === 'api.dropboxapi.com' && url.pathname === '/2/auth/token/revoke') {
      assert.equal(request.method,'POST');
      assert.equal(headers.get('Authorization'),'Bearer example-access');
      body = Buffer.from('null').toString('base64');
      responseHeaders.set('Content-Type','application/json');
    } else if (url.pathname === '/oauth2/token') {
      const form = new URLSearchParams(request.postData);
      if (!answerToken) assert.equal(form.get('refresh_token'),'example-refresh');
      const reply = answerToken ? await answerToken(form) : {access_token:'example-access',token_type:'bearer',expires_in:14400};
      body = Buffer.from(JSON.stringify(reply)).toString('base64');
      responseHeaders.set('Content-Type','application/json');
    } else {
      const endpoint = routes.get(url.pathname);
      assert.ok(endpoint, 'Unexpected fictional Dropbox path ' + url.pathname);
      const providerHeaders = { Authorization:headers.get('Authorization') };
      if (headers.has('Dropbox-API-Arg')) providerHeaders['Dropbox-API-Arg'] = headers.get('Dropbox-API-Arg');
      const bytes = request.postDataEntries?.[0]?.bytes;
      const payload = bytes ? Buffer.from(bytes, 'base64') : Buffer.from(request.postData ?? '');
      const response = await cloud.transport({endpoint, headers:providerHeaders,
        body:endpoint === 'upload' ? payload : payload.toString()});
      responseCode = response.status;
      body = Buffer.from(response.bytes).toString('base64');
      responseHeaders.set('Content-Type', endpoint === 'download' ? 'application/octet-stream':'application/json');
      if (response.metadata) responseHeaders.set('Dropbox-API-Result', response.metadata);
    }
    await send('Fetch.fulfillRequest', {requestId, responseCode, body,
      responseHeaders:Array.from(responseHeaders, ([name, value]) => ({name, value}))});
  }
  async function upload(name, text, clientModified) {
    const path = '/' + name, existing = cloud.files.get(path);
    const bytes = new TextEncoder().encode(text);
    const args = {path, mode:existing ? {update:existing.meta.rev} : 'add', content_hash:await dropboxContentHash(bytes),
      client_modified:clientModified};
    const result = await cloud.transport({endpoint:'upload', body:bytes,
      headers:{Authorization:'Bearer example-access','Dropbox-API-Arg':JSON.stringify(args)}});
    assert.equal(result.status, 200);
  }
  async function settings(values) {
    await upload('settings.csv', writeCsv('settings', Object.entries(values).map(([setting,value]) => ({setting,value}))));
  }
  return {respond, state, metadataReads, files:cloud.files, upload, settings};
}
