export const displayPreferences = {
  appearance: {setting:'appearance', values:['dark','light','device']},
  statisticsScope: {setting:'statistics_scope', values:['all','tv','anime']},
  watchlistDensity: {setting:'watchlist_density', values:['comfortable','compact']},
  librarySort: {setting:'library_sort', values:['title','rating','episodes','tomatoes','metacritic','imdb','myanimelist']},
  moreSort: {setting:'more_to_watch_sort', values:['left','title']},
  listsSort: {setting:'lists_sort', values:['title','high','low','plays']},
  // Older files can contain "gap" or "shuffle". Ratings displays Highest rated for both.
  ratingsSort: {setting:'ratings_sort', values:['high','low','title','plays','gap','shuffle']},
} as const;

export type DisplayPreference = keyof typeof displayPreferences;
export const displayPreferenceNames = Object.keys(displayPreferences) as DisplayPreference[];
const displaySettings = new Set<string>(Object.values(displayPreferences).map(preference => preference.setting));
export const isDisplaySetting = (name: string) => displaySettings.has(name);

const key = 'csvTV/pending-library-sort';
const lifetime = 120_000;
type SortProofs = ReadonlyMap<string,string>;

/** Page destruction can abort an admitted IndexedDB write. Keep only a short-lived,
 * account-bound hint for the latest Library sort in the departing tab. */
export class LibrarySortRecovery {
  #prepared?: {signature:string; proofs:Promise<SortProofs | undefined>};
  #proofs?: SortProofs;
  #pending?: {value:string};
  #checked = false;
  #receipt?: string;
  #departing?: string;

  #sign:(text:string)=>Promise<string>;
  constructor(sign:(text:string)=>Promise<string>) { this.#sign = sign; }

  observe(account:string|undefined, erased:bigint, revision:bigint, previous:string|undefined) {
    if (!account) {
      this.#prepared = this.#proofs = undefined;
      return;
    }
    const signature = JSON.stringify(['library_sort',account,String(erased),String(revision),previous ?? null]);
    if (this.#prepared?.signature === signature) return this.#prepared.proofs;
    const proofs = Promise.all(displayPreferences.librarySort.values.map(async value =>
      [value,await this.#sign(signature+'|'+value)] as const)).then(pairs => {
        const result: SortProofs = new Map(pairs);
        if (this.#prepared?.signature === signature) this.#proofs = result;
        return result;
      }).catch(() => undefined);
    this.#prepared = {signature,proofs};
    return proofs;
  }

  get needsRecovery() {
    if (!this.#checked) {
      this.#checked = true;
      try {
        const raw = sessionStorage.getItem(key);
        if (raw) {
          if (raw.length <= 220) this.#receipt = raw;
          else sessionStorage.removeItem(key);
        }
      } catch { /* Browser storage may be blocked. */ }
    }
    return !!this.#receipt;
  }

  take(proofs:SortProofs|undefined):string|undefined {
    if (!this.needsRecovery) return;
    const raw = this.#receipt!;
    this.#receipt = undefined;
    try {
      // Verification can span another refresh. Take only the same hint, just
      // before the caller can submit its revision-guarded write.
      if (sessionStorage.getItem(key) !== raw) return;
      sessionStorage.removeItem(key);
      if (!proofs || this.#pending) return;
      const receipt = JSON.parse(raw), now = Date.now();
      if (typeof receipt?.proof === 'string' && Number.isSafeInteger(receipt.expires) &&
          receipt.expires > now && receipt.expires <= now+lifetime && proofs.get(receipt.value) === receipt.proof)
        return receipt.value;
    } catch { /* A blocked or invalid hint leaves the committed setting in place. */ }
  }

  #leaving = () => {
    const value = this.#pending?.value, proof = value && this.#proofs?.get(value);
    if (!proof) return;
    try {
      const raw = JSON.stringify({value,proof,expires:Date.now()+lifetime});
      sessionStorage.setItem(key,raw);
      this.#departing = raw;
    } catch { /* Optional. */ }
  };

  async track(value:string, write:Promise<void>) {
    // A newer choice always wins over an unconsumed handoff, including on a copied tab.
    if (this.needsRecovery) this.take(undefined);
    const marker = this.#pending = {value};
    window.addEventListener('pagehide',this.#leaving,{once:true});
    try {
      await write;
      if (this.#pending === marker && this.#departing) {
        // A suspended page can finish its commit after pagehide. Retire only its own hint.
        try { if (sessionStorage.getItem(key) === this.#departing) sessionStorage.removeItem(key); } catch { /* Optional. */ }
        this.#departing = undefined;
      }
    } finally {
      if (this.#pending === marker) {
        this.#pending = undefined;
        window.removeEventListener('pagehide',this.#leaving);
      }
    }
  }

  clear() {
    this.#receipt = this.#departing = undefined;
    this.#pending = this.#proofs = this.#prepared = undefined;
    window.removeEventListener('pagehide',this.#leaving);
    try { sessionStorage.removeItem(key); } catch { /* Optional. */ }
  }
}
