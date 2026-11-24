import type {VisitValue} from './navigation-history.ts';

const slot = 'csvTV-pending-visit', lifetime = 120_000, byteLimit = 32*1024;
type Stamp = {id:string; sequence:number};
type Envelope = Stamp & {expires:number; iv:string; data:string};

function stamp(value:Stamp, expires:number) {
  return new TextEncoder().encode(JSON.stringify([value.id,value.sequence,expires]));
}
function base64(bytes:ArrayBuffer|Uint8Array) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}
function bytes(encoded:string) {
  return Uint8Array.from(atob(encoded),ch=>ch.charCodeAt(0));
}

/** An immediate reload can cancel an IndexedDB transaction. Keep one sealed edit for this tab. */
export function createVisitDraft(win:Window) {
  let storage:Storage|undefined;
  try { if (win.crypto?.subtle) storage = win.sessionStorage; } catch { /* The normal IDB save still works. */ }
  let pending:Stamp|undefined;
  let expiryTimer:number|undefined;
  function peek():Envelope|undefined {
    try {
      const raw = storage?.getItem(slot);
      if (!raw) return;
      if (raw.length < 48*1024) {
        const draft:Envelope = JSON.parse(raw);
        const now = Date.now();
        if (draft && typeof draft.id === 'string' && Number.isSafeInteger(draft.sequence) && draft.sequence > 0 &&
            Number.isSafeInteger(draft.expires) && draft.expires > now && draft.expires <= now+lifetime &&
            typeof draft.iv === 'string' && draft.iv.length === 16 && typeof draft.data === 'string') return draft;
      }
    } catch { /* Discard a malformed or unavailable draft. */ }
    try { storage?.removeItem(slot); } catch { /* Web Storage is optional. */ }
  }
  function discard(edit:Stamp) {
    if (pending?.id === edit.id && pending.sequence === edit.sequence) {
      pending = undefined; win.clearTimeout(expiryTimer);
    }
    const draft = peek();
    if (draft?.id === edit.id && draft.sequence === edit.sequence) {
      try { storage?.removeItem(slot); } catch { /* It also expires. */ }
    }
  }
  return {
    supported:!!storage,
    async seal(edit:Stamp, key:CryptoKey|undefined, value:VisitValue) {
      pending = edit;
      if (!storage || !key) return;
      try {
        const text = JSON.stringify(value);
        if (text.length > byteLimit) return;
        const plain = new TextEncoder().encode(text);
        if (plain.byteLength > byteLimit) return;
        const expires = Date.now()+lifetime, iv = win.crypto.getRandomValues(new Uint8Array(12));
        const encrypted = await win.crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:stamp(edit,expires)},key,plain);
        if (pending === edit) {
          storage.setItem(slot,JSON.stringify({...edit,expires,iv:base64(iv),data:base64(encrypted)}));
          win.clearTimeout(expiryTimer);
          expiryTimer = win.setTimeout(()=>discard(edit),Math.max(0,expires-Date.now()));
        }
      } catch { /* A denied or full session store cannot block the ordinary save. */ }
    },
    async read(id:string|undefined, sequence:number, key:CryptoKey|undefined) {
      const draft = peek();
      if (!draft || draft.id !== id) return;
      if (key && draft.sequence > sequence) {
        try {
          const plain = await win.crypto.subtle.decrypt({name:'AES-GCM',iv:bytes(draft.iv),additionalData:stamp(draft,draft.expires)},key,bytes(draft.data));
          const value:VisitValue = JSON.parse(new TextDecoder().decode(plain));
          return {value,sequence:draft.sequence};
        } catch { /* A retired or different record key cannot open this draft. */ }
      }
      discard(draft);
    },
    discard,
    clear() {
      pending = undefined; win.clearTimeout(expiryTimer);
      try { storage?.removeItem(slot); } catch { /* Other tabs lose the key at device erase. */ }
    },
  };
}
