import { DropboxAuth as BuiltDropboxAuth } from '../dist/dropbox-auth.js';
import { openDeviceStore } from '../dist/storage.js';
import { fictionalDropboxTransport } from './dropbox-roundtrip-cases.mjs';
export { prepareDropboxCallback } from '../dist/dropbox-auth.js';

// Mount the built app with a real linked device and a fictional Dropbox account.
const remote = fictionalDropboxTransport();
export class DropboxAuth extends BuiltDropboxAuth {
  constructor(store) { super(store,'public-development-key',{transport:async request => {
    await window.importFixture?.beforeDropbox?.(request);
    return remote.transport(request);
  }}); }
}
(() => {
  const originalFetch = window.fetch.bind(window);
  const open = indexedDB.open.bind(indexedDB);
  const fixture = window.importFixture = {name:'import-ui-' + crypto.randomUUID(), files:remote.files,
    online:true, paths:[], violations:[], mappingRequests:[]};
  indexedDB.open = (name, version) => open(name === 'csvTV' ? fixture.name : name, version);
  Object.defineProperty(navigator,'onLine',{get:() => fixture.online});
  document.addEventListener('securitypolicyviolation', e => fixture.violations.push(e.violatedDirective));
  window.fetch = async (input, options) => {
    const url = new URL(input instanceof Request ? input.url : input, location.href);
    if (url.origin === location.origin) return originalFetch(input,options);
    if (url.hostname === 'raw.githubusercontent.com') {
      const request = new Request(input, options);
      fixture.mappingRequests.push({url:request.url, method:request.method, headers:[...request.headers], body:request.body,
        credentials:request.credentials, referrerPolicy:request.referrerPolicy});
      if (!fixture.mappingReply) throw Error('Unexpected mapping request.');
      return fixture.mappingReply(request);
    }
    if (url.hostname !== 'api.themoviedb.org') throw Error('Unexpected external request');
    const path = url.pathname.slice(3);
    fixture.paths.push(path);
    if (fixture.intercept) await fixture.intercept(path);
    if (path === 'configuration') return Response.json({images:{secure_base_url:'https://image.tmdb.org/t/p/',
      poster_sizes:['w154'], backdrop_sizes:['w300'], still_sizes:['w92'], profile_sizes:['w45']}});
    if (path === 'tv/701') return Response.json({id:701, name:fixture.showTitle || 'Signal Garden', first_air_date:'2020-01-01',
      status:'Ended', seasons:fixture.showSeasons ?? [{season_number:1, name:'Season 1',episode_count:2}], last_episode_to_air:null, next_episode_to_air:null,
      keywords:{results:[]}, external_ids:{imdb_id:null}, vote_count:0, vote_average:0});
    if (path === 'tv/701/season/1') return Response.json({id:708,season_number:1,episodes:[1,2].map(n => ({
      id:710+n,episode_number:n,name:'Signal ' + n,air_date:'2020-01-01',runtime:28
    }))});
    if (path === 'tv/701/season/2' && fixture.showSeasons?.some(s => s.season_number === 2))
      return Response.json({id:718,season_number:2,episodes:[1,2].map(n => ({
        id:720+n,episode_number:n,name:'Relay ' + n,air_date:'2021-01-01',runtime:28
      }))});
    return new Response(null,{status:404});
  };
})();
const seed = await openDeviceStore({name:window.importFixture.name});
try {
  await seed.storeExchangedSession({accountId:'fictional-owner',appKey:'public-development-key',instanceId:crypto.randomUUID(),accessToken:'example-access',
    refreshToken:'example-refresh',accessExpiresAt:Date.now()+600_000,signInDeadline:Date.now()+86_400_000,providerExpiresAt:Date.now()+86_400_000});
} finally { seed.close(); }
