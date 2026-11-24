import type { DeviceStore } from './storage.ts';

type Preference = 'dark' | 'light' | 'device';
const choices: ReadonlyArray<[Preference, string]> = [['dark', 'Dark'], ['light', 'Light'], ['device', 'Match device']];

export class Appearance extends EventTarget {
  readonly ready: Promise<void>;
  readonly #doc: Document;
  readonly #store: DeviceStore;
  readonly #light: MediaQueryList;
  readonly #events = new AbortController();
  #reading = 0;
  #selection = 0;
  preference: Preference = 'dark';
  error = '';

  constructor(doc: Document, store: DeviceStore) {
    super();
    this.#doc = doc;
    this.#store = store;
    this.#light = doc.defaultView!.matchMedia('(prefers-color-scheme: light)');
    const options = { signal: this.#events.signal };
    this.#light.addEventListener('change', () => this.#paint(), options);
    store.addEventListener('appearancechange', () => { void this.#read(); }, options);
    store.addEventListener('rolechange', () => this.dispatchEvent(new Event('change')), options);
    doc.addEventListener('visibilitychange', () => { if (!doc.hidden) void this.#read(); }, options);
    this.ready = this.#read();
  }

  get writable() { return this.#store.role === 'writer'; }

  #paint() {
    const light = this.preference === 'light' || (this.preference === 'device' && this.#light.matches);
    this.#doc.documentElement.dataset.theme = light ? 'light' : 'dark';
    const meta = this.#doc.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (meta) meta.content = light ? '#f6f6f7' : '#0a0a0c';
  }

  async #read() {
    if (this.#events.signal.aborted) return;
    const reading = ++this.#reading;
    try {
      const { preference } = await this.#store.appearanceState();
      if (reading !== this.#reading) return;
      this.preference = preference === 'light' || preference === 'device' ? preference : 'dark';
      this.#paint();
      try {
        const cache = this.#doc.defaultView!.localStorage;
        if (this.preference === 'dark') cache.removeItem('csvTV-appearance');
        else cache.setItem('csvTV-appearance', this.preference);
      } catch { /* IndexedDB still holds the saved preference. */ }
      this.error = '';
    } catch {
      if (reading !== this.#reading) return;
      this.error = 'Could not read the appearance setting.';
    }
    this.dispatchEvent(new Event('change'));
  }

  async select(preference: Preference) {
    if (this.#events.signal.aborted) return;
    const selection = ++this.#selection;
    try {
      // IndexedDB orders writes when opened. Register this choice before any subsequent device erase.
      await this.#store.selectAppearance(preference);
    } catch {
      if (selection !== this.#selection) return;
      await this.#read();
      if (selection !== this.#selection || this.#events.signal.aborted) return;
      this.error = 'Could not save the appearance setting. Try again.';
      this.dispatchEvent(new Event('change'));
      return;
    }
    if (selection === this.#selection) await this.#read();
  }

  close() { ++this.#reading; this.#events.abort(); }
}

export function mountAppearance(content: HTMLElement, appearance: Appearance) {
  const doc = content.ownerDocument;
  const section = doc.createElement('section');
  section.className = 'group';
  section.innerHTML = '<h2 id="appearance-heading">Appearance</h2>' +
    '<div class="segments appearance-options" role="radiogroup" aria-labelledby="appearance-heading"></div>' +
    '<p class="appearance-error" role="status"></p>';
  const group = section.querySelector('.appearance-options')!;
  for (const [value, caption] of choices) {
    const label = doc.createElement('label');
    const input = doc.createElement('input');
    input.type = 'radio'; input.name = 'appearance'; input.value = value;
    input.onchange = () => { if (input.checked) void appearance.select(value); };
    const text = doc.createElement('span');
    text.textContent = caption;
    label.append(input, text); group.append(label);
  }
  function render() {
    for (const input of group.querySelectorAll('input')) {
      input.checked = input.value === appearance.preference;
      input.disabled = !appearance.writable;
    }
    section.querySelector('.appearance-error')!.textContent = appearance.error;
  }
  content.append(section);
  appearance.addEventListener('change', render);
  render();
  return () => appearance.removeEventListener('change', render);
}
