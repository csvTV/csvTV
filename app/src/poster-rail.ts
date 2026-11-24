import { poster } from './poster.ts';
import type { TmdbConfiguration } from './tmdb-data.ts';
import type { InitialMenuFocus } from './library-status-menu.ts';

export interface RailItem {
  id: number;
  title: string;
  posterPath: string | null;
  watched?: number;
  aired?: number;
  dismiss?: () => void;
}

/** Keep the scroller and its links mounted while background updates change their contents. */
export function createPosterRail(host: HTMLElement, heading: HTMLElement, label: string,
    open: (id: number) => void, recommendations = false, counts?: {
      desktop: MediaQueryList; writable(): boolean;
      open(item: RailItem, button: HTMLButtonElement, focus: InitialMenuFocus): void;
    }) {
  const doc = host.ownerDocument;
  const list = doc.createElement('ul');
  list.className = recommendations ? 'show-strip' : 'poster-rail';
  list.setAttribute('aria-label',label);
  const empty = doc.createElement('p');
  empty.className = 'tv-empty';
  const initial = host.firstElementChild;
  host.append(list,empty);
  const controls = doc.createElement('div');
  controls.className = 'rail-controls';
  heading.classList.add('rail-heading');
  heading.append(controls);
  function button(direction: -1 | 1) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.textContent = direction === 1 ? '›' : '‹';
    button.setAttribute(direction === 1 ? 'data-rail-next' : 'data-rail-prev','');
    button.setAttribute('aria-label',(direction === 1 ? 'Scroll right in ' : 'Scroll left in ') + label);
    button.onclick = () => {
      if (button.getAttribute('aria-disabled') === 'true') return;
      list.scrollBy({left:direction * Math.max(list.clientWidth / 2, list.clientWidth - 124)});
      updateButtons();
    };
    controls.append(button);
    return button;
  }
  const previous = button(-1), next = button(1);
  function updateButtons() {
    const limit = list.scrollWidth - list.clientWidth;
    controls.hidden = list.hidden || limit <= 1;
    previous.setAttribute('aria-disabled',String(list.scrollLeft <= 1));
    next.setAttribute('aria-disabled',String(list.scrollLeft >= limit - 1));
  }
  list.addEventListener('scroll',updateButtons,{passive:true});
  function onWheel(event: WheelEvent) {
    if (!event.cancelable || event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey ||
        event.altKey || event.deltaX || !event.deltaY) return;
    const remaining = list.scrollWidth - list.clientWidth - list.scrollLeft;
    if (event.deltaY > 0 ? remaining <= 1 : list.scrollLeft <= 1) return;
    const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 :
      event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? list.clientWidth : 1;
    event.preventDefault();
    list.scrollBy({left:event.deltaY * unit});
  }
  list.addEventListener('wheel',onWheel,{passive:false});
  const observer = new ResizeObserver(updateButtons);
  observer.observe(list);
  list.hidden = empty.hidden = controls.hidden = true;

  function createCard(id: number) {
    const row = doc.createElement('li'), link = doc.createElement('a'), title = doc.createElement('strong');
    if (recommendations) link.className = 'show-recommendation';
    link.href = '#/show/' + id;
    link.onclick = event => {
      if (event.button || event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return;
      event.preventDefault();
      open(id);
    };
    const count = doc.createElement('span'), progress = doc.createElement('progress');
    count.className = 'rail-count';
    const control = counts && doc.createElement('button');
    if (control) {
      control.type = 'button';
      control.className = 'library-status-trigger';
      count.classList.add('library-status-caption');
      control.append(count);
    }
    link.append(title);
    row.append(link);
    let art: HTMLElement | undefined, imageKey = '';
    let dismiss: HTMLButtonElement | undefined;
    function update(item: RailItem, config: TmdbConfiguration | null, configKey: string) {
      const key = configKey + '|' + (item.posterPath ?? '');
      if (!art || key !== imageKey) {
        const replacement = poster(doc,item,config);
        if (art) art.replaceWith(replacement);
        else link.prepend(replacement);
        art = replacement;
        imageKey = key;
      }
      if (title.textContent !== item.title) title.textContent = link.title = item.title;
      if (item.dismiss) {
        if (!dismiss) {
          dismiss = doc.createElement('button');
          dismiss.type = 'button';
          dismiss.dataset.dismissRecent = String(id);
          dismiss.textContent = '×';
          row.append(dismiss);
        }
        dismiss.setAttribute('aria-label', 'Remove ' + item.title + ' from Recently marked');
        dismiss.onclick = item.dismiss;
      } else if (dismiss) {
        dismiss.remove();
        dismiss = undefined;
      }
      if (item.aired !== undefined && item.watched !== undefined) {
        const caption = item.watched.toLocaleString() + ' of ' + item.aired.toLocaleString();
        if (count.textContent !== caption) count.textContent = caption;
        if (progress.max !== item.aired) progress.max = item.aired;
        if (progress.value !== item.watched || !progress.hasAttribute('value')) progress.value = item.watched;
        if (progress.parentElement !== art) art.append(progress);
        if (control && counts) {
          const desktop = counts.desktop.matches;
          control.setAttribute('aria-label',caption + ', ' + item.title);
          control.setAttribute('aria-haspopup',desktop ? 'menu' : 'dialog');
          if (!desktop) control.removeAttribute('aria-expanded');
          else if (!control.hasAttribute('aria-expanded')) control.setAttribute('aria-expanded','false');
          control.disabled = !counts.writable();
          control.onclick = e => counts.open(item,control,e.detail === 0 ? 'first' : 'menu');
          control.onkeydown = e => {
            if (desktop && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
              e.preventDefault(); counts.open(item,control,e.key === 'ArrowUp' ? 'last' : 'first');
            }
          };
          if (!control.parentNode) row.append(control);
        } else if (!count.parentElement) link.append(count);
      }
    }
    return {row,update};
  }
  const cards = new Map<number,ReturnType<typeof createCard>>();
  return {
    update(items: readonly RailItem[], config: TmdbConfiguration | null, emptyText = '') {
      initial?.remove();
      const focused = list.contains(doc.activeElement) ? doc.activeElement as HTMLElement : null;
      const ids = new Set(items.map(item => item.id));
      for (const [id,card] of cards) {
        if (!ids.has(id)) { card.row.remove(); cards.delete(id); }
      }
      const configKey = config ? config.secureBaseUrl + '/' + config.posterSizes.join(',') : '';
      let position = list.firstElementChild;
      for (const item of items) {
        let card = cards.get(item.id);
        if (!card) { card = createCard(item.id); cards.set(item.id,card); }
        card.update(item,config,configKey);
        if (card.row !== position) list.insertBefore(card.row,position);
        position = card.row.nextElementSibling;
      }
      list.hidden = !items.length;
      empty.hidden = !!items.length || !emptyText;
      if (!empty.hidden) empty.textContent = emptyText;
      if (focused?.isConnected && doc.activeElement === doc.body) focused.focus({preventScroll:true});
      updateButtons();
    },
    dispose() { observer.disconnect(); list.removeEventListener('wheel',onWheel); },
  };
}
