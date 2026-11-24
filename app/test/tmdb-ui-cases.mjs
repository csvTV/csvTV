import { mountTmdbSettings, mountFirstUseCard, renderOmittedShows, renderTmdbState } from '../dist/tmdb-settings.js';
import { TmdbError } from '../dist/tmdb-client.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function check(condition, message) { if (!condition) throw Error(message); }

export async function tmdbUiCases() {
  // Keep the harness in its original top-level tab. A same-origin viewport makes
  // 320px reflow, dialog focus, and the desktop breakpoint observable in Chromium.
  const frame = document.createElement('iframe');
  frame.width = '320';
  frame.height = '600';
  const loaded = new Promise(resolve => frame.addEventListener('load', resolve, { once: true }));
  frame.srcdoc = '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/settings.css"><div id="screen"></div>';
  document.body.append(frame);
  await loaded;
  const doc = frame.contentDocument;
  const root = doc.getElementById('screen');
  const store = new EventTarget();
  store.role = 'writer';
  let key = { status: 'missing-key', message: null, generation: 1n };
  let outcome = 'success';
  let resolvePending;
  let removalGeneration;
  const fictional = 'fictional-ui-token';
  const service = {
    store, keyStatus: async () => ({ ...key }), cancelKeyCheck() {},
    async saveKey(candidate) {
      check(candidate === fictional, 'Unexpected test token');
      if (outcome === 'refuse') throw new TmdbError('refused', 'Invalid token.');
      if (outcome === 'offline') throw new TmdbError('unreachable');
      if (outcome === 'wait') { await new Promise(resolve => { resolvePending = resolve; }); throw new TmdbError('unreachable'); }
      key = { status: 'ready', message: null, generation: key.generation + 1n };
    },
    async removeKey(displayed) {
      removalGeneration = displayed;
      if (displayed !== key.generation) throw Error('Changed');
      key = { status: 'missing-key', message: null, generation: key.generation + 1n };
    },
  };
  const mounted = mountTmdbSettings(root, service);
  const el = query => root.querySelector(query);
  const type = value => { el('input').value = value; el('input').dispatchEvent(new Event('input')); };
  const send = () => el('form').requestSubmit();
  const cancel = () => el('dialog[open]').dispatchEvent(new Event('cancel', { cancelable: true }));
  try {
    await mounted.ready;
    check(el('[data-edit]').textContent === 'Add key', 'First use should offer Add key');
    check(doc.documentElement.scrollWidth <= frame.clientWidth, 'Settings overflowed at 320px');
    el('[data-help]').click();
    check(el('dialog[open]').matches(':modal') && doc.activeElement.id === 'sheet-title', 'Help must begin at its heading');
    check(root.querySelectorAll('.steps li').length === 5, 'Help should have the five TMDB steps');
    for (const link of root.querySelectorAll('dialog[open] a')) check(link.target === '_blank' && link.rel.includes('noopener'), 'External link must be isolated');
    const first = el('.steps a'), last = el('.actions a');
    first.focus();
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    check(doc.activeElement === last, 'Shift-Tab must wrap to the last dialog action');
    last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    check(doc.activeElement === first, 'Tab must wrap to the first link');
    check(el('dialog[open]').scrollWidth <= el('dialog[open]').clientWidth, 'Help actions must reflow at 320px');
    cancel();
    check(doc.activeElement === el('[data-help]'), 'Closing Help must return focus');
    el('[data-edit]').click();
    check(el('input') === doc.activeElement && el('input').type === 'password' && !el('input').value, 'Token entry must start empty and masked');
    type(fictional);
    outcome = 'refuse'; send(); await tick();
    check(el('[data-feedback]').textContent === 'Invalid token.' && el('input').getAttribute('aria-invalid') === 'true', 'Refusal needs the provider message');
    outcome = 'offline'; send(); await tick();
    check(el('[type=submit]').textContent === 'Try again', 'Offline checking must offer Try again');
    outcome = 'success'; send(); await tick();
    check(!el('dialog[open]') && el('[data-key-status]').textContent === 'Saved in Dropbox', 'A successful check should commit and close');
    check(!root.innerHTML.includes(fictional) && !el('input'), 'A saved token must not be rendered');
    el('[data-edit]').click(); check(!el('input').value, 'Change must open an empty field');
    send(); check(el('[data-remove]'), 'Saving an empty replacement must confirm removal');
    cancel(); check(key.status === 'ready', 'Cancelling removal must keep the key');
    el('[data-edit]').click(); send();
    const previous = key.generation; key.generation++;
    el('[data-remove]').click(); await tick();
    check(removalGeneration === previous && el('[data-feedback]').textContent.includes('current status'), 'Changed keys must invalidate removal confirmation');
    el('[data-close]').click(); await mounted.refresh();
    el('[data-edit]').click(); send(); el('[data-remove]').click(); await tick();
    check(key.status === 'missing-key', 'Confirmed removal should delete the displayed key');
    el('[data-edit]').click(); type(fictional); outcome = 'wait'; send(); cancel(); resolvePending(); await tick();
    check(!el('dialog[open]') && !root.textContent.includes('TMDB could not be reached.'), 'A cancelled check leaked its late error');
    key = { status: 'refused', generation: 8n, message: 'Invalid token.' };
    store.dispatchEvent(new Event('tmdbstatechange')); await tick();
    check(el('[data-key-status]').textContent.includes('Key refused'), 'Background refusal must update Settings');
    store.role = 'reader'; store.dispatchEvent(new Event('rolechange')); await tick();
    check(el('[data-edit]').disabled && el('[data-role-notice]').textContent.includes('read-only'), 'Read-only tabs must not edit credentials');
    el('[data-help]').click();
    check(!el('dialog[open]').textContent.includes('Credits'), 'Key help must contain only setup information');
    el('[data-close]').click();
    check(doc.activeElement === el('[data-help]'), 'Done in key help must return focus');
    const credits = el('[data-source-credits]');
    credits.querySelector('summary').click();
    check(credits.open && credits.querySelector('img').alt === 'TMDB'
      && credits.innerText.includes('not endorsed or certified by TMDB'), 'TMDB credit missing from Settings Credits');
    frame.width = '1080'; await tick();
    check(frame.contentWindow.getComputedStyle(el('.rail nav')).display !== 'none', 'Desktop navigation must be visible');
    check(doc.documentElement.scrollWidth <= frame.clientWidth, 'Desktop settings overflow');
    const host = doc.createElement('div'); root.append(host);
    let action = '';
    for (const state of ['missing-key', 'refused', 'offline', 'unavailable', 'read-only', 'not-found', 'empty', 'loading']) {
      renderTmdbState(host, state, { onSettings: () => { action = 'settings'; }, onRetry: () => { action = 'retry'; } });
      check(host.querySelector('[role=status]')?.textContent, 'Missing accessible screen state ' + state);
      if (['missing-key', 'refused', 'offline', 'unavailable'].includes(state)) {
        host.querySelector('button').click();
        check(action === (['offline', 'unavailable'].includes(state) ? 'retry' : 'settings'), 'Unexpected screen state action');
      }
    }
    renderTmdbState(host, 'cached');
    check(!host.childNodes.length, 'Cached content should render without a blocking screen state');
    renderOmittedShows(host, { unfetched: [1], missing: [] });
    check(host.textContent.startsWith('1 show omitted'), 'Singular missing metadata count');
    renderOmittedShows(host, { unfetched: [1], missing: [2] });
    check(host.textContent.startsWith('2 shows omitted'), 'Plural missing metadata count');
    renderOmittedShows(host, { unfetched: [], missing: [] });
    check(!host.textContent, 'No omissions should leave no message');
    const actions = { onKey() {}, onDismiss() { action = 'dismiss'; } };
    const showSetup = mountFirstUseCard(host, actions);
    const options = {writable:true, showSignIn:true, canSignIn:true};
    showSetup(true, options);
    check(host.querySelectorAll('a,button').length === 2 && host.querySelector('a').hash === '#/settings',
      'Only available setup actions should appear');
    host.querySelector('button:last-child').click();
    check(action === 'dismiss', 'First-use dismissal action missing');
    showSetup(false, options);
    check(!host.firstChild, 'Dismissed first-use card should disappear');
  } finally { mounted.dispose(); frame.remove(); }
}
