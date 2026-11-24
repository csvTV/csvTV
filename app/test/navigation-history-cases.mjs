import {createVisitDraft} from '../dist/navigation-draft.js';
import {createNavigationHistory,updateVisits} from '../dist/navigation-history.js';
import {openDeviceStore} from '../dist/storage.js';

function check(ok,reason) { if (!ok) throw Error(reason); }
const selection = name=>({page:'lists',name});
const draftSlot = 'csvTV-pending-visit';
function testWindow(storage,cryptoApi=crypto) {
  return {crypto:cryptoApi,sessionStorage:storage,history:{state:{csvtvDepth:2},replaceState(value){this.state=value;}},
    setTimeout:setTimeout.bind(window),clearTimeout:clearTimeout.bind(window)};
}
function memoryStorage() {
  const map=new Map();
  return {getItem:key=>map.get(key) ?? null,setItem:(key,value)=>map.set(key,value),removeItem:key=>map.delete(key)};
}
function grant(accountId) {
  const now=Date.now();
  return {accountId,instanceId:crypto.randomUUID(),appKey:'fictional-registration',accessToken:'fictional-access',
    refreshToken:'fictional-refresh',accessExpiresAt:now+3600_000,signInDeadline:now+86400_000,providerExpiresAt:now+86400_000};
}

export async function navigationHistoryCases(run) {
  await run('Back state and its sealed pending edit belong to one account and erase generation, including a relink to the same account.',async()=>{
    const name='fictional-history-'+crypto.randomUUID(), id=crypto.randomUUID(),store=await openDeviceStore({name});
    let reader;
    try {
      await store.whenWriter(); await store.storeExchangedSession(grant('fictional-one'));
      reader=await openDeviceStore({name});
      const [a,other]=await Promise.all([store.navigationVisit(id,true),reader.navigationVisit(id,true)]);
      check(a.key && !a.key.extractable && other.key,'Nonextractable navigation keys unavailable');
      const edit={id,sequence:2}, value=selection('Fictional private selection'), storage=memoryStorage();
      const draft=createVisitDraft(testWindow(storage));
      await draft.seal(edit,a.key,value);
      const sealed=storage.getItem(draftSlot);
      check(sealed && !sealed.includes(value.name) && !sealed.includes(a.identity.account),'Pending private values escaped in readable form');
      check((await draft.read(id,0,other.key)).value.name===value.name,'Concurrent initial visits obtained different keys');
      const before=await store.snapshot();
      await reader.saveNavigationVisit(id,a.identity,2,value);
      await store.saveNavigationVisit(id,a.identity,1,selection('Earlier selection'));
      const read=await store.navigationVisit(id);
      check(read.entry?.value.name===value.name && read.entry.sequence===2 && (await store.snapshot()).revision===before.revision,
        'A late earlier write reverted the visit or changed the watch record revision');
      await store.eraseDevice(before.revision);
      await store.storeExchangedSession(grant('fictional-one'));
      const relink=await reader.navigationVisit(id,true);
      check(relink.identity.erased!==a.identity.erased && !relink.entry && !(await draft.read(id,0,relink.key)),
        'A relink to the original account recovered data from before erasure');
      check(!await reader.saveNavigationVisit(id,a.identity,3,value),'A delayed pre-erase write was admitted');
      const linked=await store.snapshot();
      await store.commit(linked.revision,{local:{syncAccountId:'fictional-two'}});
      const b=await reader.navigationVisit(id,true);
      storage.setItem(draftSlot,sealed);
      check(!b.entry && !(await draft.read(id,0,b.key)) && !storage.getItem(draftSlot),'Another owner opened or retained the stale envelope');
      check(!await reader.saveNavigationVisit(id,relink.identity,4,value),'A save from the previous owner survived replacement');
      draft.clear();
    } finally {reader?.close();store.close();indexedDB.deleteDatabase(name);}
  });
  await run('A pending edit authenticates its visit and expiry and keeps the newest character when encryption finishes out of order.',async()=>{
    const storage=memoryStorage(),id=crypto.randomUUID(),key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
    const first=Promise.withResolvers();
    let call=0;
    const wrapped={getRandomValues:v=>crypto.getRandomValues(v),subtle:{
      encrypt:async(...args)=>{if(!call++) await first.promise; return crypto.subtle.encrypt(...args);},
      decrypt:(...args)=>crypto.subtle.decrypt(...args)}};
    const draft=createVisitDraft(testWindow(storage,wrapped));
    try {
      const slow=draft.seal({id,sequence:1},key,selection('Older'));
      await draft.seal({id,sequence:2},key,selection('Latest'));
      first.resolve(); await slow;
      const raw=storage.getItem(draftSlot);
      check((await draft.read(id,1,key))?.value.name==='Latest','The obsolete encryption replaced a more recent draft');
      draft.discard({id,sequence:1});
      check(storage.getItem(draftSlot)===raw,'Retiring an earlier DB save removed the newer pending draft');
      const changed=JSON.parse(raw);changed.id=crypto.randomUUID();
      storage.setItem(draftSlot,JSON.stringify(changed));
      check(!await draft.read(changed.id,0,key),'Ciphertext copied under another ID was accepted');
      storage.setItem(draftSlot,JSON.stringify({...JSON.parse(raw),expires:Date.now()-1}));
      check(!await draft.read(id,0,key) && !storage.getItem(draftSlot),'An expired draft survived');
      storage.setItem(draftSlot,raw);
      check(!await draft.read(id,3,key) && !storage.getItem(draftSlot),'A tab’s older copied draft displaced a newer committed edit');
      storage.setItem(draftSlot,'invalid');
      check(!await draft.read(id,0,key) && !storage.getItem(draftSlot),'Malformed text prevented the normal restore');
    } finally {first.resolve();draft.clear();}
  });
  await run('Unavailable optional crypto or Web Storage leaves committed Back state working and ignores legacy unbound text.',async()=>{
    const deny=()=>{throw new DOMException('Fictional browser restriction','SecurityError');};
    for(const unavailable of ['session storage','crypto','quota']){
      const space=memoryStorage(),win=testWindow(space,unavailable==='crypto'?{}:crypto);
      if(unavailable==='session storage')Object.defineProperty(win,'sessionStorage',{get:deny});
      if(unavailable==='quota')space.setItem=deny;
      win.history.state={csvtvDepth:2,csvtvView:{query:'Fictional legacy private text'},csvtvListName:'Legacy name'};
      const identity={account:'fictional-owner',erased:2n},entries=new Map(), key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
      const store={navigationVisit:async(id,wantsDraft)=>({identity,entry:entries.get(id),key:wantsDraft?key:undefined}),
        saveNavigationVisit:async(id,_,sequence,value)=>{entries.set(id,{sequence,value});return true;}};
      const visit=createNavigationHistory(win,store);
      check(await visit.open('lists',identity.account)===undefined && !JSON.stringify(win.history.state).includes('Legacy'),'Unbound legacy values survived');
      visit.save(selection('Fictional chosen list'));
      check(Object.keys(win.history.state).sort().join(',')==='csvtvDepth,csvtvVisit','The history entry contains a readable preference');
      visit.dispose();
      check((await visit.open('lists',identity.account)).name==='Fictional chosen list','Optional browser restriction hid the committed selection');
      visit.clear();
    }
  });
  await run('An erase or newer save by another tab during decryption takes precedence before a restored filter becomes visible.',async()=>{
    for(const action of ['erase','update']){
      const win=testWindow(memoryStorage()),id=crypto.randomUUID(),identity={account:'fictional-owner',erased:6n};
      const key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
      const source=createVisitDraft(win);
      try {
        await source.seal({id,sequence:1},key,selection('Stale private selection'));
        win.history.state={csvtvDepth:1,csvtvVisit:id};
        let reads=0,writes=0;
        const later=action==='erase'?{identity:{...identity,erased:7n}}:
          {identity,entry:{sequence:2,value:selection('Newer private selection')}};
        const store={navigationVisit:async()=>++reads===1?{identity,key}:later,
          saveNavigationVisit:async()=>{writes++;return true;}};
        const history=createNavigationHistory(win,store);
        const recovered=await history.open('lists',identity.account);
        check(reads===2 && !writes && recovered?.name===(action==='erase'?undefined:'Newer private selection'),
          'The decrypted draft escaped a concurrent '+action);
        history.clear();
      } finally {source.clear();}
    }
  });
  await run('Navigation retains a bounded number and size of private visits and cannot revive an oversized edit from an older save.',async()=>{
    const identity={account:'fictional-owner',erased:7n}, id='oversized';
    let stored;
    for(let i=0;i<71;i++)stored=updateVisits(stored,identity,String(i),1,selection('Fictional '+i));
    check(stored.entries.length===64 && stored.entries[0].id==='7','Visit retention count was not bounded');
    for(let i=0;i<12;i++)stored=updateVisits(stored,identity,String(i),2,selection('F'.repeat(5000)));
    check(stored.entries.reduce((s,r)=>s+r.units,0)<=32*1024,'Visit retention text was not bounded');
    stored=updateVisits(stored,identity,id,3,selection('F'.repeat(40*1024)));
    stored=updateVisits(stored,identity,id,2,selection('An obsolete earlier value'));
    check(stored.entries.find(e=>e.id===id)?.value===undefined,'An oversized edit reverted to an older private value');
  });
}
