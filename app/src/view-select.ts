import type { ScreenContext } from './screen-context.ts';
import type { PreferenceAttempt, RecordStamp } from './storage.ts';

export interface Choice { value: string; label: string }

export function compactControl(page: HTMLElement, ctx: ScreenContext) {
  const store = ctx.service.store;
  const button = page.ownerDocument.createElement('button');
  button.className = 'watch-density';
  button.type = 'button';
  button.textContent = 'Compact';
  button.setAttribute('aria-pressed','false');
  let generation = 0, selection = 0, disposed = false, loaded = false, saving = false;
  const availability = () => { button.disabled = !loaded || store.role !== 'writer'; };
  availability();
  async function read() {
    const request = ++generation;
    const { preference } = await store.devicePreference('watchlistDensity');
    if (disposed || request !== generation) return;
    const compact = preference === 'compact';
    page.classList.toggle('watch-compact',compact);
    button.setAttribute('aria-pressed',String(compact));
    loaded = true;
    availability();
  }
  const changed = () => { void ctx.run(read); };
  const roleChanged = () => { selection++; availability(); };
  store.addEventListener('watchlistdensitychange',changed);
  store.addEventListener('rolechange',roleChanged);
  button.onclick = () => {
    if (disposed || saving || button.disabled) return;
    const value = page.classList.contains('watch-compact') ? 'comfortable' : 'compact';
    const ticket = ++selection, attempt: PreferenceAttempt = {};
    let tried = false;
    void ctx.run(async () => {
      // Retry the original choice only while the same record still has its previous setting.
      if (disposed || ticket !== selection || saving || button.disabled || (tried && !attempt.previous)) return;
      tried = true; saving = true;
      try {
        await store.selectDisplayPreference('watchlistDensity',value,attempt);
        if (!disposed) await read();
      } finally { saving = false; }
    });
  };
  return {button, read, dispose() {
    disposed = true;
    store.removeEventListener('watchlistdensitychange',changed);
    store.removeEventListener('rolechange',roleChanged);
  }};
}

export function choiceControl(doc: Document, label: string, change: (value: string) => void) {
  const root = doc.createElement('label');
  root.className = label === 'Sort' ? 'view-choice view-sort' : 'view-choice';
  const select = doc.createElement('select');
  select.setAttribute('aria-label',label);
  if (label === 'Sort') select.className = 'sort-trigger';
  select.onchange = () => change(select.value);
  root.append(label,select);
  return {root, select, display(choices: readonly Choice[], value: string) {
    // Refreshes of ratings or watch counts must leave an open picker and its focus intact.
    if (choices.length !== select.length || choices.some((item,i) =>
      select.options[i].value !== item.value || select.options[i].text !== item.label)) {
      select.replaceChildren(...choices.map(item => {
        const option = doc.createElement('option');
        option.value = item.value;
        option.textContent = item.label;
        return option;
      }));
    }
    if (select.value !== value) select.value = value;
  }};
}

/** Keep the selected order responsive while rapid keyboard choices are committed in order. */
export function rememberSort<T extends string>(ctx: ScreenContext, key: 'librarySort' | 'moreSort' | 'ratingsSort' | 'listsSort',
    fallback: T, valid: (value: unknown) => value is T, show: (value: T) => void) {
  const store = ctx.service.store;
  const event = key.toLowerCase() + 'change';
  let disposed = false, reading = 0, pending = 0, selection = 0;
  async function read(observe?:(record:RecordStamp|undefined)=>void) {
    const ticket = ++reading;
    const {preference,record} = await store.devicePreference(key);
    observe?.(record);
    if (!disposed && ticket === reading && !pending) show(valid(preference) ? preference : fallback);
  }
  const reread = () => { if (!pending) void ctx.run(read); };
  store.addEventListener(event,reread);
  if (key === 'librarySort') store.addEventListener('rolechange',reread);
  return {read, choose(value: T) {
    ++reading;
    show(value);
    if (store.role !== 'writer') return;
    const ticket = ++selection;
    const attempt: PreferenceAttempt = {};
    let tried = false;
    void ctx.run(async () => {
      if (disposed || ticket !== selection || store.role !== 'writer' || (tried && !attempt.previous)) return;
      tried = true;
      pending++;
      // Each click or Retry admits its own transaction immediately, across screen mounts.
      try { await store.selectDisplayPreference(key,value,attempt); }
      catch (error) { if (!disposed && ticket === selection) throw error; }
      finally {
        pending--;
        if (!pending && !disposed) await read();
      }
    });
  }, dispose() {
    disposed = true;
    store.removeEventListener(event,reread);
    store.removeEventListener('rolechange',reread);
  }};
}
