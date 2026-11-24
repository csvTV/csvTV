// Older online-only tabs can keep the ordinary writer lock after a new release arrives.
// These advisory locks identify clients that also maintain the Statistics cache revisions.
const prefix = (database:string) => 'csvTV/metadata-revisions/'+encodeURIComponent(database)+'/';

export function announceMetadataClient(database:string, writerLease:string|undefined, closing:AbortSignal, lifetime:Promise<void>) {
  const name = prefix(database)+(writerLease ? 'writer/'+writerLease : 'reader');
  // Failure of an advisory lock must leave the normal writer request available.
  try { void navigator.locks.request(name,{mode:'shared',signal:closing},()=>lifetime).catch(()=>{}); }
  catch { /* The reader falls back to rechecking its report. */ }
}

export async function metadataPeers(database:string):Promise<{writerLease?:string; olderReader:boolean}> {
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    const clients = await Promise.race([navigator.locks.query(),new Promise<undefined>(resolve=>{
      timer = setTimeout(()=>resolve(undefined),100);
    })]);
    if (!clients) return {olderReader:true};
    const {held=[],pending=[]} = clients;
    const writer = 'csvTV/writer/'+database, scope = prefix(database);
    const owner = held.find(lock=>lock.name===writer)?.clientId;
    const stamp = owner && held.find(lock=>lock.clientId===owner && lock.name?.startsWith(scope+'writer/'))?.name;
    const modern = new Set(held.filter(lock=>lock.name===scope+'reader').map(lock=>lock.clientId));
    return {writerLease:stamp ? stamp.slice((scope+'writer/').length) : undefined,
      olderReader:pending.some(lock=>lock.name===writer && (!lock.clientId || !modern.has(lock.clientId)))};
  } catch { return {olderReader:true}; }
  finally { clearTimeout(timer); }
}
