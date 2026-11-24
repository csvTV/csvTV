import {mountNotices} from '../dist/notices.js';

export async function noticeCases(run) {
  await run('Top reports expire after visible reading time and retain focused, hovered and retry actions', async () => {
    const frame = document.createElement('iframe');
    frame.srcdoc = '<!doctype html><div class="reports"></div><main tabindex="-1">Home</main>';
    const loaded = new Promise(resolve => frame.addEventListener('load',resolve,{once:true}));
    document.body.append(frame); await loaded;
    const win = frame.contentWindow, doc = frame.contentDocument, host = doc.querySelector('.reports'), main = doc.querySelector('main');
    // Drive this frame's monotonic clock and timers together without waiting for wall time.
    let now = 0, id = 0, hidden = false;
    const pending = new Map();
    Object.defineProperty(win.performance,'now',{value:() => now});
    Object.defineProperty(doc,'hidden',{get:() => hidden});
    win.setTimeout = (callback,ms) => { pending.set(++id,{at:now + ms,callback}); return id; };
    win.clearTimeout = id => pending.delete(id);
    function advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...pending.entries()].sort((a,b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        now = next[1].at; pending.delete(next[0]); next[1].callback();
      }
      now = end;
    }
    function visibility(value) { hidden = value; doc.dispatchEvent(new Event('visibilitychange')); }
    function check(ok, message) { if (!ok) throw Error(message); }
    const reports = mountNotices(host,main);
    try {
      let retries = 0;
      reports.add('Record synced.');
      const first = host.firstChild;
      first.dispatchEvent(new PointerEvent('pointerleave',{pointerType:'mouse'}));
      advance(6000); reports.add('Backup finished.');
      const second = host.firstChild;
      second.dispatchEvent(new PointerEvent('pointerleave',{pointerType:'mouse'}));
      advance(2000);
      check(!first.isConnected && second.isConnected,'A new notice inherited a previous deadline');
      second.dispatchEvent(new PointerEvent('pointerenter',{pointerType:'mouse'}));
      advance(20000);
      check(second.isConnected,'Hover did not pause a notice');
      second.querySelector('button').focus();
      check(doc.activeElement === second.querySelector('button'),'Frame could not focus the notice');
      second.dispatchEvent(new PointerEvent('pointerleave',{pointerType:'mouse'}));
      advance(20000);
      check(second.isConnected && doc.activeElement === second.querySelector('button'),'Focused notice disappeared after pointer left');
      const control = second.querySelector('button');
      main.focus();
      // Chromium can suppress focusout in an inactive headless frame even after activeElement changes.
      control.dispatchEvent(new FocusEvent('focusout',{bubbles:true,relatedTarget:main}));
      advance(1000); visibility(true); advance(60000);
      check(second.isConnected,'Hidden time consumed the notice');
      visibility(false); advance(4999);
      check(second.isConnected,'Notice expired before the remaining reading time');
      advance(1);
      check(!second.isConnected,'A notice overstayed its visible time (' + [...pending.values()].map(timer => timer.at-now) + 'ms left)');
      check(doc.activeElement === main,'A timed notice moved focus away from main');

      const retry = {label:'Try again',action:() => { retries++; }};
      reports.add('Could not complete this action.',retry);
      const old = host.firstChild;
      old.dispatchEvent(new PointerEvent('pointerleave',{pointerType:'mouse'}));
      advance(19999);
      check(old.querySelector('button')?.textContent === 'Try again','Recovery action expired too early');
      advance(1);
      check(!old.isConnected && !retries,'An expired retry fired unexpectedly');
      reports.add('Could not save.',retry);
      const tryAgain = host.querySelector('button'); tryAgain.focus(); tryAgain.click();
      check(retries === 1 && !host.childElementCount && !pending.size,'Retry fired twice or left a timer');
      check(doc.activeElement === main,'Retry dropped keyboard focus onto the document body');
      reports.add('Could not save.',retry); reports.clearRetries();
      check(!host.childElementCount && !pending.size,'Navigation kept an obsolete retry');
      reports.add('Backup finished.');
      const dismiss = host.querySelector('button'); dismiss.focus(); dismiss.click();
      check(!host.childElementCount && doc.activeElement === main && !pending.size,'Manual dismissal lost focus or retained a timer');
      visibility(true); reports.add('Signed out.'); advance(60000); visibility(false);
      check(host.childElementCount === 1,'A notice received in a hidden tab expired immediately');
      reports.dispose(); advance(20000);
      check(!pending.size && !host.childElementCount,'Disposal kept an orphan report');
    } finally { reports.dispose(); frame.remove(); }
  });
}
