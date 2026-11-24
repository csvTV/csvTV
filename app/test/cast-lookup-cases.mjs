import { openDeviceStore } from '../dist/storage.js';

function check(value,message) { if (!value) throw Error(message); }

export async function checkCachedCastWorkers(now=Date.now()) {
  const dbName = 'cast-cache-' + crypto.randomUUID();
  const isolated = await openDeviceStore({name:dbName});
  const db = await new Promise((resolve,reject) => {
    const request = indexedDB.open(dbName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    const tx = db.transaction('tmdb','readwrite'), cache = tx.objectStore('tmdb');
    const committed = new Promise((resolve,reject) => { tx.oncomplete=resolve; tx.onabort=()=>reject(tx.error); });
    const put = (key,value,at,expiry) => cache.put({value,fetchedAt:at,expiresAt:expiry},key);
    for (let id=100; id<170; id++) {
      const name = id === 145 ? 'Most recent' : id === 146 ? 'Equal timestamp' : 'Other name';
      put('tv/'+id+'/aggregate_credits',id===169 ? null : [{id:10,name}],id===145 || id===146 ? now : now-100,now+86_400_000);
      put('tv/'+id+'/season/1',{episodes:[]},now,now+86_400_000);
    }
    put('tv/180/aggregate_credits',[{id:11,name:'Expired'}],now-1000,now);
    put('tv/181/aggregate_credits',[{id:11,name:'Clock ahead'}],now+1,now+86_400_000);
    put('tv/182/recommendations?page=1',[{id:11,name:'Other resource'}],now,now+86_400_000);
    await committed;
    const Native=globalThis.Worker, reports=[], requests=[];
    let ended=0;
    try {
      globalThis.Worker=class extends Native {
        constructor(url,options) {
          check(url.pathname.endsWith('/cast-lookup-worker.js') && options.type==='module','Unexpected cast worker entry');
          super('/test/cast-worker-inspection-cases.mjs',options);
          this.addEventListener('message',({data})=>{if(data.inspection)reports.push(data.inspection);});
        }
        postMessage(data) { requests.push(data); super.postMessage(data); }
        terminate() { ended++; super.terminate(); }
      };
      const newest=await isolated.cachedCastMember(10,now);
      check(newest?.name==='Most recent','The worker lost newest or equal-time priority: '+JSON.stringify({newest,reports,ended}));
      check(await isolated.cachedCastMember(11,now)===null,'The worker returned an expired, future or unrelated identity');
      check(ended===2 && reports.length===2 && reports.every(r=>JSON.stringify(r.tables)==='[["tmdb","readonly"]]' && r.reads===71 && !r.unexpected),
        'The worker opened a private table, unrelated body or unexpected number of retained cast sources');
      check(requests.every(r=>Object.keys(r).sort().join()==='database,now,person,version' && r.database===dbName && r.version===db.version),
        'The cast worker received data beyond its database identity, person and time');
      globalThis.Worker=class {
        postMessage(){queueMicrotask(()=>this.onmessageerror());}
        terminate(){ended++;}
      };
      check((await isolated.cachedCastMember(10,now))?.sourceShowId===145 && await isolated.cachedCastMember(11,now)===null && ended===3,
        'An unavailable worker lost the matching identity, tie order or startup backoff');
      let admitted;
      globalThis.Worker=class {
        postMessage(){admitted.resolve();}
        terminate(){ended++;}
      };
      for(const close of [false,true]){
        admitted=Promise.withResolvers();
        const view=new AbortController(), work=isolated.cachedCastMember(10,now,view.signal).then(()=>false,error=>error.name==='AbortError');
        await admitted.promise;
        if(close) await isolated.closeForUpdate(); else view.abort();
        check(await work,'Leaving a view or closing its cache retained the pending cast lookup');
      }
      check(ended===5,'A canceled cast worker survived its view or database');
    } finally {globalThis.Worker=Native;}
  } finally {
    db.close(); await isolated.closeForUpdate();
    const drop = indexedDB.deleteDatabase(dbName);
    await new Promise((resolve,reject) => { drop.onsuccess=resolve; drop.onerror=()=>reject(drop.error); });
  }
}
