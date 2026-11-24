import { openDeviceStore } from '../dist/storage.js';
import { DropboxAuth } from '../dist/dropbox-auth.js';
import { DropboxController } from '../dist/dropbox-controller.js';
import { DropboxDialogs } from '../dist/dropbox-dialogs.js';
import { DropboxApi, dropboxContentHash } from '../dist/dropbox-api.js';
import { readCsv, writeCsv } from '../dist/csv.js';
import { isProviderKey } from '../dist/provider-credentials.js';
import { prepareExport } from '../dist/export-data.js';
import { isAnime } from '../dist/anime.js';
import { readOverview } from '../dist/record-overview.js';
import { TmdbService } from '../dist/tmdb-service.js';
import { normalizeTmdb } from '../dist/tmdb-data.js';
import { tmdbResourceKey } from '../dist/tmdb-client.js';
import { MalGithubClient, MalService } from '../dist/mal-service.js';
import { WatchActions } from '../dist/watch-actions.js';
const enc=new TextEncoder();
const decode=bytes=>new TextDecoder().decode(bytes);
function check(ok,message){if(!ok) throw Error(message);}

// Only the HTTP boundary is replaced; both devices use the built controller, auth, IndexedDB and CSVs.
export function fictionalDropboxTransport() {
  const files=new Map(),folders=new Set(),history=new Map();
  let sequence=0;
  const name=path=>path.split('/').pop();
  const folder=p=>({'.tag':'folder',name:name(p),path_display:p});
  const reply=(v,status=200)=>({status,bytes:enc.encode(JSON.stringify(v)),metadata:null});
  const missing=()=>reply({error_summary:'path/not_found/'},409);
  const conflict=()=>reply({error_summary:'path/conflict/file/'},409);
  async function transport(req) {
    check(req.headers.Authorization==='Bearer example-access','Transport used a different session');
    const args=JSON.parse(req.headers['Dropbox-API-Arg']??req.body);
    const path=args.path,existing=files.get(path);
    if(req.endpoint==='list') {
      if(path&&!folders.has(path))return missing();
      const direct=p=>args.recursive ? p.startsWith(path+'/') : p.slice(0,p.lastIndexOf('/'))===path;
      return reply({entries:[...[...folders].filter(direct).map(folder),
        ...[...files].filter(([p])=>direct(p)).map(([,file])=>file.meta)],has_more:false,cursor:'end'});
    }
    if(req.endpoint==='revisions') {
      const entries = history.get(path);
      if (!entries) return missing();
      const index = args.before_rev ? entries.findIndex(entry=>entry.rev===args.before_rev) : -1;
      if (args.before_rev && index < 0) return reply({error_summary:'invalid_before_rev/'},409);
      const remaining=entries.slice(index+1);
      return reply({entries:remaining.slice(0,args.limit),has_more:remaining.length>args.limit});
    }
    if(req.endpoint==='create') { if(folders.has(path))return conflict();folders.add(path);return reply({metadata:folder(path)}); }
    if(req.endpoint==='download') return existing?{status:200,bytes:existing.bytes,metadata:JSON.stringify(existing.meta)}:missing();
    if(req.endpoint==='delete') {
      if(!existing)return missing();
      if(!args.parent_rev || args.parent_rev!==existing.meta.rev)return conflict();
      files.delete(path);return reply({metadata:existing.meta});
    }
    if(req.endpoint==='upload') {
      if(args.mode==='add'&&existing || args.mode.update && existing?.meta.rev!==args.mode.update)return conflict();
      check(await dropboxContentHash(req.body)===args.content_hash,'Bytes differ from uploaded hash');
      const modified=new Date().toISOString();
      const meta={'.tag':'file',name:name(path),path_display:path,size:req.body.length,rev:String(++sequence),content_hash:args.content_hash,
        id:existing?.meta.id ?? 'id:fictional-'+sequence,
        client_modified:args.client_modified??modified,server_modified:modified};
      files.set(path,{meta,bytes:req.body});history.set(path,[meta,...(history.get(path)??[])]);return reply(meta);
    }
    throw Error('Unexpected fictional route '+req.endpoint);
  }
  return {transport,files};
}

async function withDevices(exercise) {
    const dbNames=[], opened=[], cloud=fictionalDropboxTransport();
    async function device(seed, now = Date.now) {
      const name='csvTV-full-sync-'+crypto.randomUUID(); dbNames.push(name);
      const store=await openDeviceStore({name});await store.whenWriter();
      await store.storeExchangedSession({accountId:'fictional-owner',appKey:'public-development-key',instanceId:crypto.randomUUID(),accessToken:'example-access',
        refreshToken:'example-refresh',accessExpiresAt:Date.now()+600000,signInDeadline:Date.now()+86400000,providerExpiresAt:Date.now()+86400000});
      const auth=new DropboxAuth(store,'public-development-key',{transport:cloud.transport});
      if (seed) {
        const {settings = [], legacyPreferences, ...record} = seed;
        await store.commit((await store.snapshot()).revision,{put:{...record,settings:settings.filter(r=>!isProviderKey(r.setting))},
          local:legacyPreferences});
        const keys = settings.filter(r=>isProviderKey(r.setting));
        if (keys.length) {
          const {session} = await store.dropboxState();
          await new DropboxApi(auth,session).upload('/settings.csv',writeCsv('settings',keys),{mode:'add'});
        }
      }
      const controller=new DropboxController(auth,window,new DropboxDialogs(document),now);
      opened.push({controller,store});
      await controller.refresh();
      async function sync() {
        let began=controller.busy;
        const observe=()=>{ if(controller.operation==='sync') began=true; };
        controller.changed.addEventListener('change',observe);
        try {
          controller.queueSync(true);
          for(let end=performance.now()+6000;performance.now()<end;) {
            await new Promise(resolve=>setTimeout(resolve,14));
            if(began&&!controller.busy&&controller.synced) return;
          }
          throw Error('Sync did not finish: '+controller.reason);
        } finally { controller.changed.removeEventListener('change',observe); }
      }
      return {store,controller,sync};
    }
    try { await exercise(device, cloud); }
    finally {
      for(const dev of opened){dev.controller.close();dev.store.close();}
      for(const name of dbNames){const r=indexedDB.deleteDatabase(name);await new Promise((yes,no)=>{r.onsuccess=yes;r.onerror=no;});}
    }
}

export async function dropboxRoundtripCases(run) {
  await run('A selected Dropbox clear reaches the returning device, keeps other edits and keys, and leaves weekly backups cleared', () =>
    withDevices(async (device,cloud)=>{
      const title = {show_id:71,show:'Fictional Beacon'}, episode = {...title,season:1,episode:1,title:'Pilot',episode_id:711,times_watched:1};
      const credentials = {setting:'tmdb_key',value:'fictional-reset-key'};
      const a = await device({watched:[episode],ratings:[{...title,rating:7}],lists:[{...title,list:'Watchlist'}],
        settings:[credentials,{setting:'recently_marked.71',value:'100/100'}]});
      await a.sync(); const b = await device(); await b.sync();
      await b.store.commit((await b.store.snapshot()).revision,{put:{watched:[{...episode,times_watched:4}],ratings:[{...title,rating:8}]}});
      const clear = async categories => {
        const approve = a.controller.clearDropbox(categories,new AbortController().signal);
        for (let end=performance.now()+6000; !document.querySelector('dialog .destructive') && performance.now()<end;)
          await new Promise(done=>setTimeout(done,10));
        const confirm = document.querySelector('dialog .destructive');
        check(confirm && confirm.closest('dialog').textContent.includes('fictional-owner'),'Missing scoped account confirmation');
        confirm.click(); check(await approve,'Clear did not finish'); await a.sync();
      };
      await clear(['watched','backups']); await b.sync(); await a.sync();
      const path = '/csvtv-reset.json', good = cloud.files.get(path);
      const completed = JSON.parse(decode(good.bytes));
      const raw = new DropboxApi(a.controller.auth,(await a.store.dropboxState()).session);
      const stale = await raw.upload(path,JSON.stringify({...completed,pending:['watched','backups']}),{mode:'update',revision:good.meta.rev});
      const choose = b.controller.dialogs.choose;
      let offered = false, reason = '';
      b.controller.dialogs.choose = async () => { offered = true; return 'cancel'; };
      try { await b.controller.clearDropbox(['watched','backups'],new AbortController().signal); }
      catch (error) { reason = error.message; }
      finally { b.controller.dialogs.choose = choose; }
      check(!offered && reason.includes('older clear') && cloud.files.get(path).meta.rev===stale.rev,
        'A returning device offered to repeat a clear that it knew had already finished');
      await raw.upload(path,good.bytes,{mode:'update',revision:stale.rev}); await b.sync();
      const aState = await a.store.snapshot(), bState = await b.store.snapshot();
      check(!aState.tables.watched.length && !bState.tables.watched.length &&
        !bState.local.recentlyMarked?.length && aState.tables.ratings[0].rating===8 &&
        aState.tables.lists.length===1,'The stale device resurrected watches or lost its unselected rating or list');
      check(readCsv('settings',cloud.files.get('/settings.csv').bytes).rows.some(r=>r.value===credentials.value) &&
        ![...cloud.files.keys()].some(p=>p.startsWith('/backups/')),'Unselected keys disappeared or automatic sync recreated backups');
      await clear(['settings']); await b.sync();
      check(!readCsv('settings',cloud.files.get('/settings.csv').bytes).rows.length && a.controller.signedIn && b.controller.signedIn,
        'Clearing keys left old settings or revoked the Dropbox grant');
      const c = await device(); await c.sync(); const fresh = await c.store.snapshot();
      check(!fresh.tables.watched.length && fresh.tables.ratings[0].rating===8 && fresh.tables.lists.length===1,
        'A fresh profile diverged after the clear');
    }));
  await run('Recently marked syncs explicit marks, independent offline edits and dismissals to a fresh device', () =>
    withDevices(async (device, cloud) => {
      const episode = id => ({show_id:id,show:'Signal ' + id,season:1,episode:1,episode_id:id * 100,
        title:'Transmission',times_watched:1});
      const a = await device({watched:[episode(81)]});
      const first = new TmdbService(a.store);
      const mark = (service,id) => service.editWatches(id, snapshot => ({
        rows:[{...episode(id),times_watched:(snapshot.tables.watched[0]?.times_watched ?? 0) + 1}]}));
      const order = async store => (await store.snapshot()).local.recentlyMarked?.join() ?? '';
      let second;
      try {
        await mark(first,41); await mark(first,42); await a.sync();
        const b = await device(); await b.sync(); second = new TmdbService(b.store);
        check(await order(b.store) === '42,41','Fresh device did not receive both deliberate marks in order, or promoted imported watches');
        const stale = await device(); await stale.sync();
        await mark(first,43);
        await b.store.dismissRecentMark(41);
        await mark(second,44);
        await b.sync(); await a.sync(); await b.sync(); await stale.sync();
        const fresh = await device(); await fresh.sync();
        for (const participant of [a,b,stale,fresh]) {
          const current = await participant.store.snapshot();
          check(await order(participant.store) === '44,43,42' && current.tables.watched.length === 5 &&
            current.tables.watched.every(row => row.times_watched === 1),'Divergent order or lost watches after syncing the stale device');
        }
        const settings = readCsv('settings',cloud.files.get('/settings.csv').bytes);
        check(settings.schema === 'known' && settings.rows.some(row => row.setting === 'recently_marked.41' && row.value.endsWith('/0')),
          'The shared removal was missing from settings.csv');
        await mark(first,41); await a.sync(); await b.sync();
        check(await order(b.store) === '44,43,42','A rewatch revived the dismissed title');
        await first.editWatches(41,({tables}) => ({rows:[...tables.watched,{...episode(41),season:2,episode_id:4101}]}));
        await a.sync(); await b.sync();
        check(await order(b.store) === '41,44,43,42','A new season did not bring the dismissed title back');
        await second.editWatches(41,({tables}) => ({rows:tables.watched.filter(row => row.season !== 2)}));
        await b.sync(); await a.sync(); await fresh.sync();
        check(await order(fresh.store) === '44,43,42' && (await fresh.store.tmdbRows(41)).tables.watched[0].times_watched === 2,
          'Withdrawing the only new season on another device revived a dismissed entry or removed its imported watches');
      } finally { first.close(); second?.close(); }
    }));

  await run('A replacement sign-in during manual backup does not receive later backup requests or a success message', () =>
    withDevices(async (device, cloud) => {
      const transport = cloud.transport, started = Promise.withResolvers(), release = Promise.withResolvers();
      const sends = [];
      cloud.transport = async request => {
        const path = JSON.parse(request.headers['Dropbox-API-Arg'] ?? request.body).path;
        sends.push({path,authorization:request.headers.Authorization});
        const reply = await transport(request);
        if (request.endpoint === 'create' && path === '/backups') { started.resolve(); await release.promise; }
        return reply;
      };
      const {store,controller} = await device();
      const pending = controller.backUpNow();
      try {
        await started.promise;
        const {session} = await store.dropboxAuthState();
        await store.storeExchangedSession({...session,instanceId:'second-fixture-session',accessToken:'second-fixture-token'});
        release.resolve();
        const outcome = await pending.then(() => 'completed', error => error.kind);
        check(outcome === 'account-changed' && !sends.some(s => s.path?.startsWith('/backups/')) &&
          sends.every(s => s.authorization === 'Bearer example-access'),'The backup crossed the sign-in change');
      } finally { release.resolve(); await pending.catch(() => {}); }
    }));

  await run('Back up now synchronizes local changes, writes one verified generation per request, and works again within the week', () =>
    withDevices(async (device, cloud) => {
      const value = {show_id:302,show:'Night Bridge',rating:8.5};
      const manifests = () => [...cloud.files.keys()].filter(path => path.endsWith('/completion.json'));
      const send = cloud.transport;
      let throttled = false;
      cloud.transport = async request => {
        if (request.endpoint === 'list' && JSON.parse(request.body).path === '/backups' && manifests().length === 2 &&
            !JSON.parse(decode(cloud.files.get('/csvtv-reset.json').bytes)).reservations.length) {
          throttled = true;
          return {status:429,retryAfter:'120',bytes:enc.encode('{}'),metadata:null};
        }
        return send(request);
      };
      const {controller,store} = await device({ratings:[value]});
      check(controller.canBackUpNow,'A connected writer with unsynced edits could not request a backup');
      const first = await controller.backUpNow();
      check(first.status === 'verified' && manifests().length === 1,'First explicit backup also created an automatic generation');
      check(decode(cloud.files.get('/backups/' + first.folder + '/ratings.csv').bytes).includes('8.5'),
        'Manual backup omitted the unsynced local rating');
      await store.commit((await store.snapshot()).revision, {put:{ratings:[{...value,rating:9}]}});
      const second = await controller.backUpNow();
      check(throttled && (await store.dropboxAuthState('fictional-owner')).cooldown?.until > Date.now(),
        'The test did not exercise a saved backup during an active Dropbox cooldown');
      const secondRating = cloud.files.get('/backups/' + second.folder + '/ratings.csv');
      check(first.folder !== second.folder && manifests().length === 2 && second.status === 'verified' &&
        readCsv('ratings',secondRating.bytes).rows[0].rating === 9,'A new manual backup did not contain the new rating');
      check(second.entries['ratings.csv'].rev === cloud.files.get('/ratings.csv').meta.rev &&
        second.entries['ratings.csv'].hash === secondRating.meta.content_hash,'The manifest did not identify the synced file');
    }));

  await run('A sync crossing UTC midnight republishes before marking the new summary date synced', () =>
    withDevices(async device => {
      const midnight = Date.parse(new Date().toISOString().slice(0,10) + 'T00:00:00Z');
      let clock = midnight - 1000;
      const a = await device({}, () => clock);
      const read = a.store.exportSnapshot.bind(a.store), days = [];
      a.store.exportSnapshot = async (...args) => {
        const value = await read(...args);
        days.push(new Date(args[1]).toISOString().slice(0,10));
        clock = midnight;
        return value;
      };
      await a.sync();
      const saved = (await a.store.dropboxState()).status;
      check(days[0] === new Date(midnight - 1000).toISOString().slice(0,10), 'First export used the wrong UTC day');
      check(days.at(-1) === new Date(midnight).toISOString().slice(0,10) && saved.synced && saved.day === days.at(-1),
        'The current day was marked synced with a summary from before midnight');
    }));

  await run('Two linked devices converge through the full wire protocol, derived files and a verified weekly backup', () =>
    withDevices(async (device, cloud) => {
      const watched={show_id:302,show:'Night Bridge',season:1,episode:1,episode_id:30211,title:'Crossing',times_watched:2};
      const title={show_id:302,show:'Night Bridge',year:2012,imdb_id:'tt1122334'};
      const a=await device({watched:[watched],shows:[title],settings:[{setting:'omdb_key',value:'fictional-setting'}]});
      await a.sync();
      check(cloud.files.has('/watched.csv')&&cloud.files.has('/shows.csv')&&cloud.files.has('/README.txt'),'First device missed shared files');
      check(!cloud.files.has('/summary.csv'),'Missing metadata produced a premature shared summary');
      check([...cloud.files.keys()].filter(p=>p.endsWith('/completion.json')).length===1,'Weekly backup did not complete');
      const b=await device(); await b.sync();
      let snapshot=await b.store.snapshot();
      check(snapshot.tables.shows[0].imdb_id===title.imdb_id&&!snapshot.tables.settings.length&&
        (await b.store.imdbState()).config.omdb_key==='fictional-setting'&&
        snapshot.tables.watched[0].times_watched===2,'New device lost a file or descriptive metadata');
      await b.store.commit(snapshot.revision,{put:{ratings:[{show_id:302,show:'Night Bridge',rating:8.5}]}});
      await b.sync();await a.sync();
      snapshot=await a.store.snapshot();
      check(snapshot.tables.ratings[0].rating===8.5&&!snapshot.sync.ratings.pending,'Rating did not converge across devices');
      for(const [path,file] of cloud.files) if(path!=='/settings.csv') {
        const text=decode(file.bytes);
        check(!text.includes('example-access')&&!text.includes('example-refresh')&&!text.includes('fictional-setting'),'Credential value in '+path);
      }
      check(readCsv('shows',cloud.files.get('/shows.csv').bytes).rows[0].imdb_id===title.imdb_id,'Later rebuild lost imported IMDb ID');
      check([...cloud.files.keys()].filter(p=>p.endsWith('/completion.json')).length===1,'Fresh weekly backup was duplicated');
    }));

  await run('Two devices share display preferences and Anime classification while a large custom list rename and delete use the guard', () =>
    withDevices(async (device, cloud) => {
      const lists = Array.from({ length: 129 }, (_, i) => ({
        show_id: i + 1, show: 'Fictional series ' + (i + 1), list: i < 87 ? 'Archive' : 'Weekend',
      }));
      lists.push({...lists[0],list:'aNiMe'});
      const watched = [lists[0], lists[100]].map(({show_id, show}) => ({
        show_id, show, season: 1, episode: 1, episode_id: show_id * 10, title: 'Pilot', times_watched: 2,
      }));
      const a = await device({lists, watched, legacyPreferences:{appearance:'light',statisticsScope:'tv'},
        settings:[{setting:'mdblist_key',value:'fictional-mdb-key'}]});
      await a.sync();
      const migrated = readCsv('settings',cloud.files.get('/settings.csv').bytes).rows;
      check(migrated.some(row=>row.setting==='appearance' && row.value==='light') &&
        migrated.some(row=>row.setting==='statistics_scope' && row.value==='tv'), 'Existing device choices were not migrated');
      const b = await device({legacyPreferences:{appearance:'dark',statisticsScope:'anime'}});
      await b.sync();
      check((await b.store.appearanceState()).preference === 'light' &&
        (await b.store.devicePreference('statisticsScope')).preference === 'tv', 'An older device overwrote the existing Dropbox preference');
      const source = new TmdbService(a.store), destination = new TmdbService(b.store);
      const watch = new WatchActions(source, async () => true, () => {}, () => {}, async () => true);
      const countAnime = async () => (await readOverview(destination)).shows.filter(isAnime).length;
      const remoteFiles = () => [...cloud.files].map(([path, file]) => [path, decode(file.bytes)]).sort(([a], [b]) => a.localeCompare(b));
      async function exportFiles() {
        const files = [];
        for (const mode of ['record', 'summary']) {
          for (const file of (await prepareExport(source, mode)).files) files.push([file.name, await file.text()]);
        }
        return files;
      }
      try {
        check(await countAnime() === 1, 'Imported Anime classification was not applied on the second device');
        const originalExports = await exportFiles(), originalRemote = remoteFiles();
        const {generation} = await a.store.mdbListState();
        const cached = await a.store.writeMdbList(generation, {entries: new Map([[1, {fetchedAt: Date.now(),
          scores: {tomatoes:null, metacritic:null, myanimelist:9.7}}]])});
        await a.store.selectStatisticsScope('anime');
        await a.store.selectAppearance('device');
        await a.store.selectWatchlistDensity('compact');
        await a.store.selectDisplayPreference('librarySort','rating');
        await a.store.selectDisplayPreference('moreSort','title');
        check(cached && (await a.store.devicePreference('statisticsScope')).preference === 'anime', 'Local fixture failed to save');
        await a.sync();
        await b.sync();
        check(JSON.stringify(originalExports) === JSON.stringify(await exportFiles()), 'A score or device preference changed an export');
        const otherFiles = files => files.filter(([path]) => path !== '/settings.csv');
        check(JSON.stringify(otherFiles(originalRemote)) === JSON.stringify(otherFiles(remoteFiles())), 'A display preference changed another Dropbox file');
        const saved = Object.fromEntries(readCsv('settings',cloud.files.get('/settings.csv').bytes).rows.map(row=>[row.setting,row.value]));
        check(saved.appearance === 'device' && saved.statistics_scope === 'anime' && saved.watchlist_density === 'compact' &&
          saved.library_sort === 'rating' && saved.more_to_watch_sort === 'title' && saved.mdblist_key === 'fictional-mdb-key',
          'Dropbox settings did not retain the five display choices and provider key');
        for (const [key,value] of Object.entries({appearance:'device',statisticsScope:'anime',watchlistDensity:'compact',librarySort:'rating',moreSort:'title'})) {
          check((await b.store.devicePreference(key)).preference === value,'Missing synced preference '+key);
        }
        check(!(await b.store.mdbListState([1])).entries.has(1), 'A second device received a device-cached score');
        let held = 0;
        const dialogs = b.controller.dialogs;
        const guard = dialogs.guard.bind(dialogs);
        dialogs.guard = async question => {
          const choice = guard(question);
          const dialog = document.querySelector('dialog.dropbox-dialog[open]');
          check(question.table === 'lists' && question.decision.reason === 'over-one-fifth-removed' &&
            question.impact.removedRows === 87 && dialog?.textContent.includes('87 rows'), 'The list guard did not show its removal count');
          const expected = held === 0 ? 'Archive' : 'archive';
          check((await b.store.personalRows()).lists.filter(row=>row.list===expected).length === 87 && await countAnime()===1,
            'A pending guard changed the committed custom list or Anime marker');
          held++;
          [...dialog.querySelectorAll('button')].find(button => button.textContent === 'Merge anyway').click();
          return choice;
        };
        check(await watch.renameList('Archive', 'archive'), 'Case-only rename failed');
        await a.sync();
        await b.sync();
        check(held === 1 && await countAnime() === 1 && (await b.store.personalRows()).lists.filter(row => row.list === 'archive').length===87,
          'The rename lost memberships or bypassed the second device’s guard');
        check(await watch.deleteList('archive'), 'Could not delete the list');
        await a.sync();
        await b.sync();
        check(held === 2 && await countAnime()===1 && (await b.store.personalRows()).lists.length === 43,
          'The deletion bypassed the guard or changed unrelated memberships');
        const marker = readCsv('lists',cloud.files.get('/lists.csv').bytes).rows.filter(row=>row.list.toLowerCase()==='anime');
        check(marker.length===1 && marker[0].list==='aNiMe' && marker[0].show_id===1,'Custom list operations changed the raw classification row');
        check((await b.store.overviewRows()).watched.length === 2, 'Custom list edits removed personal watch history');
      } finally { source.close(); destination.close(); }
    }));

  await run('Two devices sync the MyAnimeList source and shared GitHub credentials, while job scores stay outside Dropbox and every interactive export', () =>
    withDevices(async (device, cloud) => {
      const title = {show_id:57, show:'Winter at Moon Lake'};
      const repo = 'fictional-owner/scores', token = 'fictional-ratings-read-only';
      const a = await device({settings:[{setting:'tmdb_key', value:'fictional-tmdb'}],
        lists:[{...title, list:'Anime'}], ratings:[{...title, rating:6.5}],
        watched:[{...title, season:1, episode:1, episode_id:5701, title:'Ice', times_watched:2}]});
      await a.sync();
      const metadata = [
        [{kind:'show', id:57}, {id:57, name:title.show, status:'Ended', first_air_date:'2015-01-01',
          seasons:[{season_number:1, episode_count:1}], keywords:{results:[]}, external_ids:{}}],
        [{kind:'season', id:57, season:1}, {season_number:1, episodes:[{episode_number:1, id:5701,
          name:'Ice', air_date:'2015-01-01'}]}],
      ];
      check(await a.store.writeTmdb((await a.store.tmdbState()).generation, {entries:Object.fromEntries(metadata.map(([resource, raw]) =>
        [tmdbResourceKey(resource), {fetchedAt:Date.now(), value:normalizeTmdb(resource, raw)}]))}), 'Summary metadata missing');
      await a.sync();
      const b = await device(); await b.sync();
      const source = new TmdbService(a.store), destination = new TmdbService(b.store);
      const calls = [];
      function github(score) {
        return new MalGithubClient({fetch:async (url, options) => {
          const headers = new Headers(options.headers);
          check(String(url) === 'https://api.github.com/repos/' + repo + '/contents/mal-ratings.csv.gz?ref=mal-data' &&
            options.method === 'GET' && !options.body && [...headers.keys()].sort().join() === 'accept,authorization' &&
            headers.get('authorization') === 'Bearer ' + token, 'GitHub received unexpected fields or credentials');
          calls.push(score);
          const csv = 'show,season,offset,mal_id,score\n57,1,,917652,' + score + '\n';
          return new Response(new Blob([csv]).stream().pipeThrough(new CompressionStream('gzip')));
        }});
      }
      const first = new MalService(source, github(8.37)), second = new MalService(destination, github(9.18));
      async function exports() {
        const files = [];
        for (const mode of ['record','summary']) {
          const prepared = await prepareExport(source, mode);
          for (const file of prepared.files) files.push([file.name, Array.from(new Uint8Array(await file.arrayBuffer()))]);
        }
        return files;
      }
      // The transport verifies each upload's content_hash against its actual bytes.
      const remote = () => [...cloud.files].map(([name,file]) => [name,file.meta.content_hash]).sort(([a],[b]) => a.localeCompare(b));
      try {
        const original = await exports();
        const summary = original.find(([name]) => name === 'summary.csv');
        check(original.length === 5 && summary && decode(new Uint8Array(summary[1])).includes(title.show) &&
          decode(cloud.files.get('/summary.csv').bytes).includes(title.show), 'A personal export or the synced summary is missing');
        await first.configure('github_repo',repo); await first.configure('github_token',token);
        await first.configure('mal_source','github'); await a.sync(); await b.sync();
        const shared = Object.fromEntries(readCsv('settings',cloud.files.get('/settings.csv').bytes).rows.map(r=>[r.setting,r.value]));
        check(Object.keys(shared).sort().join() === 'github_repo,github_token,mal_source,tmdb_key' &&
          shared.github_repo === repo && shared.github_token === token && shared.mal_source === 'github' &&
          (await second.status()).source === 'github' && !(await second.read([57])).size,
          'The second device received scores with its settings, or lost the shared configuration');
        const before = JSON.stringify(remote());
        await first.refreshFile(true); await a.sync(); await b.sync();
        check((await first.read([57])).get(57)?.[0].score === 8.37 && !(await second.read([57])).size &&
          (await second.status()).fetchedAt === null, 'Scores leaked between devices');
        await second.refreshFile(true); await b.sync(); await a.sync();
        check(calls.join() === '8.37,9.18' && (await second.read([57])).get(57)?.[0].score === 9.18 &&
          (await first.read([57])).get(57)?.[0].score === 8.37, 'Devices did not keep their own downloaded files');
        check(JSON.stringify(await exports()) === JSON.stringify(original) && JSON.stringify(remote()) === before,
          'Caching a MyAnimeList file changed a personal export or a Dropbox file');
        await second.configure('mal_source','mdblist'); await b.sync(); await a.sync();
        const after = await first.status();
        check(after.source === 'mdblist' && after.repository === repo && after.hasToken && !(await first.read([57])).size &&
          after.fetchedAt === null && JSON.stringify(await exports()) === JSON.stringify(original),
          'A source change received through sync kept old scores, changed the record or lost the shared credentials');
      } finally { first.close(); second.close(); source.close(); destination.close(); }
    }));
}
