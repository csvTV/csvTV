import type {LibraryPreferences} from './library-screen.ts';
import type {DeviceStore,RatingRecordIdentity} from './storage.ts';
import {createVisitDraft} from './navigation-draft.ts';

export type VisitValue = LibraryPreferences | {page:'watchlist';moreSort:'left'|'title'} | {page:'lists';name:string};
export interface StoredVisits extends RatingRecordIdentity {
  entries:{id:string;value?:VisitValue;units:number;sequence:number}[];
}
export const visitStoreKey = 'navigationVisits';
export const visitSealKey = 'navigationVisitKey';
const visitId = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
const visitLimit = 64, textLimit = 32*1024;

export function savedVisits(stored:StoredVisits|undefined, identity:RatingRecordIdentity) {
  return stored?.account === identity.account && stored?.erased === identity.erased && Array.isArray(stored.entries)
    ? stored.entries : [];
}

export function updateVisits(stored:StoredVisits|undefined, identity:RatingRecordIdentity, id:string, sequence:number, value:VisitValue):StoredVisits {
  const previous = savedVisits(stored,identity);
  if (stored && previous.some(entry=>entry.id === id && entry.sequence >= sequence)) return stored;
  const entries = previous.filter(entry=>entry.id !== id);
  const units = JSON.stringify(value).length;
  entries.push(units <= textLimit ? {id,value,units,sequence} : {id,units:0,sequence});
  let total = 0, first = entries.length;
  while (first && entries.length-first < visitLimit) {
    const next = entries[first-1].units;
    if (total+next > textLimit) break;
    total += next;
    first--;
  }
  return {...identity,entries:entries.slice(first)};
}

interface ActiveVisit {
  page:VisitValue['page'];
  identity?:RatingRecordIdentity;
  key?:CryptoKey;
  id?:string;
  sequence:number;
  pending?:{sequence:number;value:VisitValue};
  saving?:boolean;
}

/** The browser keeps an opaque handle. The private value is subject to the same erase as the record. */
export function createNavigationHistory(win:Window,store:Pick<DeviceStore,'navigationVisit'|'saveNavigationVisit'>) {
  const history = win.history, draft = createVisitDraft(win);
  let active:ActiveVisit|undefined;
  let known:{identity:RatingRecordIdentity;key?:CryptoKey}|undefined;
  const sameOwner = (owner:string|null|undefined,identity:RatingRecordIdentity) =>
    owner === undefined || owner === (identity.account ?? null);
  function flush(visit:ActiveVisit, leaving=false) {
    if (!visit.pending || !visit.id || !visit.identity || (visit.saving && !leaving)) return;
    const {sequence,value} = visit.pending, id = visit.id;
    visit.pending = undefined;
    visit.saving = true;
    void store.saveNavigationVisit(id,visit.identity,sequence,value).then(saved=>{
      if (saved) draft.discard({id,sequence});
    }).catch(()=>{}).finally(() => {
      visit.saving = false;
      if (active === visit) flush(visit);
    });
  }
  function leave() {
    if (active) flush(active,true);
    active = undefined;
  }
  return {
    open(page:string, owner:string|null|undefined) {
      leave();
      const raw = history.state;
      const state = raw && typeof raw === 'object' ? raw : {};
      const previous = typeof state.csvtvVisit === 'string' && visitId.test(state.csvtvVisit) ? state.csvtvVisit : undefined;
      if ('csvtvView' in state || 'csvtvListName' in state || ('csvtvVisit' in state && !previous)) {
        const {csvtvView:_,csvtvListName:__,csvtvVisit:___,...safe} = state;
        history.replaceState(previous ? {...safe,csvtvVisit:previous} : safe,'');
      }
      if (page !== 'library' && page !== 'watchlist' && page !== 'lists') return;
      const visit:ActiveVisit = {page,sequence:0};
      active = visit;
      if (!previous && known && sameOwner(owner,known.identity)) {
        Object.assign(visit,known);
        return;
      }
      return store.navigationVisit(previous,draft.supported).then(async ({identity,entry,key}) => {
        if (active !== visit || !sameOwner(owner,identity)) return;
        const edit = await draft.read(previous,entry?.sequence ?? 0,key);
        if (active !== visit) return;
        let value = entry?.value;
        if (previous && edit?.value.page === page) {
          const id = previous;
          // Decryption can finish after another tab erased the record or saved a newer copy of this visit.
          const latest = await store.navigationVisit(id);
          if (active !== visit || latest.identity.account !== identity.account || latest.identity.erased !== identity.erased) return;
          if (latest.entry && latest.entry.sequence >= edit.sequence) {
            draft.discard({id,sequence:edit.sequence});
            value = latest.entry.value;
          } else {
            value = edit.value;
            void store.saveNavigationVisit(id,identity,edit.sequence,edit.value).then(saved=>{
              if (saved) draft.discard({id,sequence:edit.sequence});
            }).catch(()=>{});
          }
        }
        visit.identity = identity;
        visit.key = key;
        known = {identity,key};
        return value?.page === page ? value : undefined;
      }).catch(()=>undefined);
    },
    save(value:VisitValue) {
      const visit = active;
      if (!visit?.identity || value.page !== visit.page) return;
      // A duplicated tab initially has the same history entry. Give its first edit its own copy.
      if (!visit.id) {
        visit.id = crypto.randomUUID();
        history.replaceState({...history.state,csvtvVisit:visit.id},'');
      }
      const sequence = ++visit.sequence;
      visit.pending = {sequence,value};
      void draft.seal({id:visit.id,sequence},visit.key,value);
      flush(visit);
    },
    dispose() { leave(); known = undefined; },
    clear() { active = undefined; known = undefined; draft.clear(); },
  };
}
