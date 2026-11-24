import { isProviderKey, publicSettings } from '../dist/provider-credentials.js';

// The fixture's remote file lives outside the device store and survives a store reopen within one test.
const remotes = new Map();
export async function connectFixtureProviders(store, name, initial) {
  await store.whenWriter();
  let remote = remotes.get(name);
  if (!remote) {
    remote = new Map(initial?.map(row=>[row.setting,row.value]));
    remotes.set(name,remote);
  }
  let {session,accountId} = await store.dropboxState();
  if (!session) {
    session = {accountId:accountId ?? 'fixture-provider-account',instanceId:crypto.randomUUID(),signInDeadline:Date.now()+7*86_400_000,providerExpiresAt:Date.now()+7*86_400_000,
      accessExpiresAt:Date.now()+3600_000,accessToken:'fictional-access',refreshToken:'fictional-refresh'};
    await store.storeExchangedSession(session);
  }
  store.connectProviderKeys(async (key,expected,next,current) => {
    if (!current() || (remote.get(key) ?? null) !== expected) throw Error('Fictional remote changed');
    if (next === null) remote.delete(key); else remote.set(key,next);
    return Array.from(remote,([setting,value])=>({setting,value}));
  },Date.now);
  await store.loadProviderKeys(session,Array.from(remote,([setting,value])=>({setting,value})),()=>true);
  return store.snapshot();
}

export async function replaceFixtureSettings(store, name, settings) {
  if (!store.providerKeysAvailable) await connectFixtureProviders(store,name);
  const remote = remotes.get(name);
  remote.clear();
  for (const {setting,value} of settings) if (isProviderKey(setting)) remote.set(setting,value);
  const {session} = await store.dropboxState();
  await store.commit((await store.snapshot()).revision,{replace:{settings:publicSettings(settings)}},{syncWrite:true});
  await store.loadProviderKeys(session,settings,()=>true);
}
