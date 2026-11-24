import { openActionSheet, type SheetAction } from './action-sheet.ts';
import type { ScreenContext } from './screen-context.ts';
import { watchEditRunner } from './notices.ts';

export type InitialMenuFocus = 'menu' | 'first' | 'last';

/** Desktop action menu anchored to the count. The menu never participates in card layout. */
export function openLibraryStatusMenu(trigger: HTMLButtonElement, id: number, actions: SheetAction[],
    returnFocus: () => HTMLElement | null, initialFocus: InitialMenuFocus) {
  const doc = trigger.ownerDocument, win = doc.defaultView!;
  const menu = doc.createElement('div');
  menu.id = 'library-actions-' + id;
  menu.className = 'library-status-menu';
  menu.tabIndex = -1;
  menu.setAttribute('role','menu');
  menu.setAttribute('aria-label',trigger.getAttribute('aria-label')!);
  const listeners = new AbortController();
  const {signal} = listeners;
  function close(restore = true) {
    if (signal.aborted) return;
    listeners.abort();
    trigger.removeAttribute('aria-controls');
    if (trigger.getAttribute('aria-haspopup') === 'menu') trigger.setAttribute('aria-expanded','false');
    menu.remove();
    const target = returnFocus();
    if (restore) target?.focus({preventScroll:true});
  }
  const items = actions.map(({label,choose}) => {
    const button = doc.createElement('button');
    button.type = 'button';
    button.setAttribute('role','menuitem');
    button.tabIndex = -1;
    button.textContent = label;
    button.onpointermove = event => {
      if (event.pointerType !== 'touch' && doc.activeElement !== button) button.focus({preventScroll:true});
    };
    button.onpointerleave = event => {
      if (event.pointerType !== 'touch' && doc.activeElement === button) menu.focus({preventScroll:true});
    };
    button.onclick = () => { close(); choose(); };
    menu.append(button);
    return button;
  });
  const rail = trigger.closest('.poster-rail');
  if (rail) {
    // An absolutely positioned child would be clipped by the horizontal scroller.
    menu.style.position = 'fixed';
    doc.body.append(menu);
  } else trigger.after(menu);
  trigger.setAttribute('aria-expanded','true');
  trigger.setAttribute('aria-controls',menu.id);
  function position() {
    const rect = trigger.getBoundingClientRect(), box = menu.getBoundingClientRect();
    const viewport = win.visualViewport;
    const left = viewport?.offsetLeft ?? 0, top = viewport?.offsetTop ?? 0;
    const right = left + (viewport?.width ?? doc.documentElement.clientWidth);
    const bottom = top + (viewport?.height ?? win.innerHeight);
    const scale = box.width / menu.offsetWidth;
    const railBox = rail?.getBoundingClientRect();
    if (rect.bottom <= top || rect.top >= bottom || rect.right <= Math.max(left,railBox?.left ?? left) ||
        rect.left >= Math.min(right,railBox?.right ?? right)) { close(false); return; }
    const below = bottom - rect.bottom - 8, above = rect.top - top - 8;
    const flip = below < (menu.scrollHeight + 2) * scale && above > below;
    menu.toggleAttribute('data-above',flip);
    menu.style.maxHeight = Math.max(0,(flip ? above : below) / scale) + 'px';
    const aligned = Math.max(left + 4,Math.min(rect.left,right - box.width - 4));
    if (rail) {
      menu.style.bottom = 'auto';
      menu.style.top = (flip ? rect.top - menu.getBoundingClientRect().height - 2 : rect.bottom + 2) / scale + 'px';
      menu.style.left = aligned / scale + 'px';
    } else menu.style.left = (aligned - rect.left) / scale + 'px';
  }
  menu.onkeydown = e => {
    const index = items.indexOf(doc.activeElement as HTMLButtonElement);
    let next: number;
    switch (e.key) {
      case 'Escape': e.preventDefault(); close(); return;
      case 'Tab': close(); return; // Normal tab order continues from the trigger.
      case 'ArrowDown': next = (index + 1) % items.length; break;
      case 'ArrowUp': next = index <= 0 ? items.length - 1 : index - 1; break;
      case 'Home': next = 0; break;
      case 'End': next = items.length - 1; break;
      default: return;
    }
    e.preventDefault();
    items[next].focus({preventScroll:true});
  };
  function outside(e: Event) {
    const path = e.composedPath();
    if (!path.includes(menu) && !path.includes(trigger)) close(false);
  }
  doc.addEventListener('pointerdown',outside,{capture:true,signal});
  doc.addEventListener('focusin',outside,{signal});
  win.addEventListener('resize',position,{signal});
  win.addEventListener('scroll',position,{capture:true,passive:true,signal});
  win.visualViewport?.addEventListener('resize',position,{signal});
  win.visualViewport?.addEventListener('scroll',position,{signal});
  position();
  if (!signal.aborted) {
    const target = initialFocus === 'menu' ? menu : items[initialFocus === 'last' ? items.length - 1 : 0];
    target.focus({preventScroll:true});
  }
  return {close,position};
}

/** Library cards and Home counts share their menu, watch edits and Undo. */
export function createProgressActions(root: HTMLElement, ctx: ScreenContext, desktopPicker: MediaQueryList,
    available: () => boolean, focusTarget: (button: HTMLButtonElement) => HTMLElement) {
  let popup: {trigger:HTMLButtonElement; close():void; current():boolean; position?():void} | undefined;
  const pending = new Set<number>();
  const edits = watchEditRunner(ctx);
  function open(show: {id:number; title:string}, button: HTMLButtonElement, choices: readonly string[], focus: InitialMenuFocus) {
    if (!available() || button.disabled || pending.has(show.id)) return;
    if (popup?.trigger === button) { popup.close(); return; }
    popup?.close();
    const label = button.getAttribute('aria-label'), desktop = desktopPicker.matches;
    const current = () => available() && desktop === desktopPicker.matches && button.isConnected && !button.disabled &&
      button.getAttribute('aria-label') === label && ctx.service.store.role === 'writer';
    async function choose(action: string) {
      if (!current() || pending.has(show.id)) return;
      pending.add(show.id);
      button.setAttribute('aria-busy','true');
      try {
        if (action === 'Drop' || action === 'Pick up')
          await ctx.watch.setDropped({show_id:show.id,show:show.title},action === 'Drop',current);
        else await ctx.watch.bulk(show.id,{},action === 'Complete' ? 'mark' : 'rewatch-complete',current);
      } finally {
        pending.delete(show.id);
        button.removeAttribute('aria-busy');
      }
    }
    const actions: SheetAction[] = choices.map(label => ({label,choose:() => {
      const scope = label === 'Drop' || label === 'Pick up' ? 'dropped' : 'watches';
      void edits.run(show.id + '/' + scope,() => choose(label));
    }}));
    const restore = () => { popup = undefined; return focusTarget(button); };
    const sheet = desktop ? openLibraryStatusMenu(button,show.id,actions,restore,focus)
      : {close:openActionSheet(root,restore,{title:show.title,actions})};
    if (!desktop || button.hasAttribute('aria-controls')) popup = {trigger:button,current,...sheet};
  }
  return {open, refresh() {
    if (popup && !popup.current()) popup.close();
    else popup?.position?.();
  }, close() { popup?.close(); }};
}
