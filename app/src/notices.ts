import type { ScreenContext } from './screen-context.ts';
import { reviewList } from './review-list.ts';

/** A notification may retry a failed watch edit until a newer choice supersedes it. */
export function watchEditRunner(ctx: Pick<ScreenContext,'run'>) {
  const pending = new Map<string,AbortController>();
  function retire(scope?: string) {
    for (const [key,attempt] of pending) {
      // A whole-season edit overlaps its episode edits. Two different episodes are independent.
      if (scope !== undefined && key !== scope && !key.startsWith(scope + '/') && !scope.startsWith(key + '/')) continue;
      pending.delete(key);
      attempt.abort();
    }
  }
  return {retire,run(scope: string, edit: () => Promise<void>) {
    retire(scope);
    const attempt = new AbortController();
    pending.set(scope,attempt);
    return ctx.run(async () => {
      if (attempt.signal.aborted) return;
      await edit();
      if (pending.get(scope) === attempt) pending.delete(scope);
    },attempt.signal);
  }};
}

/** Top-of-page reports share the shell across navigation. Retry actions belong to the originating screen. */
export function mountNotices(host: HTMLElement, content: HTMLElement) {
  const doc = host.ownerDocument, win = doc.defaultView!;
  const entries = new Map<HTMLElement, { remaining: number; started: number; timer?: number; hovering: boolean; detach?: () => void }>();

  function remove(box: HTMLElement) {
    const entry = entries.get(box);
    win.clearTimeout(entry?.timer);
    entry?.detach?.();
    entries.delete(box);
    box.remove();
  }

  function update(box: HTMLElement, focused = box.contains(doc.activeElement)) {
    const entry = entries.get(box);
    if (!entry) return;
    const paused = doc.hidden || entry.hovering || focused || Boolean(box.querySelector('details[open]'));
    if (paused && entry.timer !== undefined) {
      win.clearTimeout(entry.timer);
      entry.remaining = Math.max(0,entry.remaining - (win.performance.now() - entry.started));
      entry.timer = undefined;
    } else if (!paused && entry.timer === undefined) {
      entry.started = win.performance.now();
      entry.timer = win.setTimeout(() => remove(box),entry.remaining);
    }
  }

  function visibilityChanged() {
    for (const box of entries.keys()) update(box);
  }
  doc.addEventListener('visibilitychange',visibilityChanged);

  function add(message: string, retry?: { label: string; action(): void }, signal?: AbortSignal, items?: readonly string[]) {
    if (signal?.aborted) return;
    const box = doc.createElement('div');
    box.className = 'report';
    if (items) {
      const {details} = reviewList(doc,message,items.length,i => items[i]);
      details.addEventListener('toggle',() => update(box));
      box.append(details);
    } else {
      const report = doc.createElement('span');
      report.setAttribute('role','status');
      report.textContent = message;
      box.append(report);
    }
    function button(label: string, action: () => void) {
      const control = doc.createElement('button');
      control.type = 'button';
      control.textContent = label;
      control.onclick = action;
      box.append(control);
    }
    function dismiss() {
      const focused = box.contains(doc.activeElement);
      remove(box);
      if (focused) (host.querySelector<HTMLElement>('.report > button, .report > details > summary') ?? content).focus({preventScroll:true});
    }
    if (retry) {
      box.dataset.retry = '';
      button(retry.label,() => { dismiss(); retry.action(); });
    }
    button('Dismiss',dismiss);
    host.prepend(box);
    signal?.addEventListener('abort',dismiss,{once:true});
    const entry = {remaining:retry ? 20_000 : 8_000, started:0,detach:signal && (() => signal.removeEventListener('abort',dismiss)),
      hovering:win.matchMedia('(any-hover: hover)').matches && box.matches(':hover')};
    entries.set(box,entry);
    box.addEventListener('pointerenter',event => { if (event.pointerType !== 'touch') { entry.hovering = true; update(box); } });
    box.addEventListener('pointerleave',event => { if (event.pointerType !== 'touch') { entry.hovering = false; update(box); } });
    box.addEventListener('focusin',() => update(box,true));
    box.addEventListener('focusout',event => {
      update(box,event.relatedTarget instanceof win.Node && box.contains(event.relatedTarget));
    });
    update(box);
  }
  function clear() { for (const box of entries.keys()) remove(box); }
  return {add, clear, clearRetries() { host.querySelectorAll<HTMLElement>('[data-retry]').forEach(remove); }, dispose() {
    doc.removeEventListener('visibilitychange',visibilityChanged);
    clear();
  }};
}
