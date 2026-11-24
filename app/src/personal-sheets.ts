import { openPersonalDialog } from './personal-dialog.ts';
import { dropMembership } from './upcoming-preference.ts';
import { isWatchlist, orderedListNames, PersonalRecordError, visibleListRows, type PersonalShow } from './personal-record.ts';
import type { ScreenContext } from './screen-context.ts';

type Panel = ReturnType<typeof openPersonalDialog>;

function button(doc: Document, label: string, className = '') {
  const node = doc.createElement('button');
  node.type = 'button';
  node.className = className;
  node.textContent = label;
  return node;
}

function showSheet(host: HTMLElement, ctx: ScreenContext, title: string, show: PersonalShow, restore: () => HTMLElement | null) {
  const panel = openPersonalDialog(host, title, restore);
  const tag = host.ownerDocument.createElement('p');
  tag.className = 'personal-show-name';
  tag.textContent = show.show || 'Show ' + show.show_id;
  panel.sheet.prepend(tag);
  const events = new AbortController();
  panel.dialog.addEventListener('close', () => events.abort(), { once: true });
  ctx.service.store.addEventListener('rolechange', () => {
    if (ctx.service.store.role !== 'writer') panel.close();
  }, { signal: events.signal });
  return { ...panel, events };
}

/** Invalid names stay editable. A storage failure returns to the screen's recovery notice and retry control. */
async function save(panel: Panel, ctx: ScreenContext, feedback: HTMLElement, apply: () => Promise<void>) {
  if (panel.body.inert || !panel.dialog.open) return;
  await ctx.run(async () => {
    panel.setSaving(true);
    try { await apply(); }
    catch (error) {
      if (error instanceof PersonalRecordError && panel.dialog.open) feedback.textContent = error.message;
      else { panel.close(); throw error; }
    } finally { panel.setSaving(false); }
  });
}

export function openRatingSheet(host: HTMLElement, ctx: ScreenContext, show: PersonalShow, rating: number | null,
    restore: () => HTMLElement | null) {
  const doc = host.ownerDocument;
  const panel = showSheet(host, ctx, 'Your rating', show, restore);
  panel.body.innerHTML = `<p class="rating-figure" aria-hidden="true"><strong></strong><small>/10</small></p>
    <div class="rating-slider"><progress max="10" aria-hidden="true"></progress>
      <input type="range" min="0" max="10" step="0.5" aria-label="Your rating"></div>
    <p class="rating-scale" aria-hidden="true"><span>0</span><span>Half steps</span><span>10</span></p>
    <p class="feedback" role="status"></p><div class="actions rating-commands"></div>`;
  const slider = panel.body.querySelector('input')!;
  const track = panel.body.querySelector('progress')!;
  const figure = panel.body.querySelector<HTMLElement>('.rating-figure')!;
  const feedback = panel.body.querySelector<HTMLElement>('.feedback')!;
  const commands = panel.body.querySelector('.rating-commands')!;
  const done = button(doc, 'Done');
  let draft = rating;
  slider.value = String(rating ?? 5);
  function draw() {
    track.value = slider.valueAsNumber;
    figure.hidden = draft === null;
    figure.querySelector('strong')!.textContent = draft === null ? '' : String(draft);
    slider.setAttribute('aria-valuetext', draft === null ? 'No rating selected' : draft + ' out of 10');
    done.disabled = draft === null;
  }
  function select() { draft = slider.valueAsNumber; draw(); }
  slider.oninput = select;
  // A tap on the initial middle thumb can select 5 without generating an input event.
  slider.onclick = select;
  slider.onpointerup = event => {
    // Touch browsers can release the thumb without sending click or input when its value stays at 5.
    if (event.isPrimary && event.pointerType === 'touch') select();
  };
  slider.onkeydown = event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      select();
    }
  };
  function commit(value: number | null) {
    void save(panel, ctx, feedback, async () => { await ctx.watch.setRating(show, value); panel.close(); });
  }
  done.onclick = () => { if (draft !== null) commit(draft); };
  if (rating !== null) {
    const remove = button(doc, 'Remove rating', 'destructive');
    remove.onclick = () => commit(null);
    commands.append(remove);
  }
  commands.append(done);
  draw();
  return panel.close;
}

export function openMembershipSheet(host: HTMLElement, ctx: ScreenContext, show: PersonalShow, restore: () => HTMLElement | null,
    includeWatchlist = true) {
  const doc = host.ownerDocument;
  const panel = showSheet(host, ctx, 'Add to list', show, restore);
  let version = 0;
  let naming = false;
  const feedback = doc.createElement('p');
  feedback.className = 'feedback';
  feedback.setAttribute('role', 'status');
  const rows = doc.createElement('div');
  rows.className = 'membership-choices';
  const actions = doc.createElement('div');
  actions.className = 'actions';
  const newList = button(doc, 'New list');
  const done = button(doc, 'Done', 'primary');
  done.onclick = panel.close;
  actions.append(newList, done);

  async function refresh(focusName?: string) {
    const ticket = ++version;
    if (naming || !panel.dialog.open) return;
    const {lists, watchedIds} = await ctx.service.store.personalRows(includeWatchlist ? [show.show_id] : []);
    if (ticket !== version || naming || !panel.dialog.open) return;
    const mine = lists.filter(row => row.show_id === show.show_id);
    const selected = new Set(visibleListRows(mine).map(row => row.list));
    const showWatchlist = includeWatchlist && !watchedIds.has(show.show_id) && !mine.some(row => dropMembership(row.list) === 'dropped');
    const fragment = doc.createDocumentFragment();
    let focus: HTMLElement | undefined;
    const active = doc.activeElement as HTMLInputElement | null;
    const nameToFocus = focusName ?? (active && rows.contains(active) ? active.value : undefined);
    const names = orderedListNames(lists);
    for (const name of names) {
      if (!showWatchlist && isWatchlist(name)) continue;
      const label = doc.createElement('label');
      label.className = 'personal-check-row';
      const tick = doc.createElement('input');
      tick.type = 'checkbox'; tick.className = 'personal-check'; tick.value = name;
      const before = selected.has(name);
      tick.checked = before;
      const text = doc.createElement('span');
      text.textContent = name;
      label.append(tick, text);
      tick.onchange = () => {
        tick.checked = before;
        const write = async () => {
          const changed = await ctx.watch.setMembership(show, name, !before);
          if (!panel.dialog.open) return;
          feedback.textContent = changed ? (before ? 'Removed from ' : 'Added to ') + name + '.' : '';
        };
        void save(panel, ctx, feedback, write).then(() => refresh(name)).catch(fail);
      };
      if (nameToFocus === name) focus = tick;
      fragment.append(label);
    }
    rows.replaceChildren(fragment);
    if (nameToFocus !== undefined && !panel.body.inert) (focus ?? newList).focus({ preventScroll: true });
  }
  function fail() {
    if (!panel.dialog.open || naming) return;
    feedback.textContent = 'Could not read your lists.';
    const retry = button(doc, 'Try again');
    retry.onclick = () => { feedback.textContent = ''; void refresh().catch(fail); };
    feedback.append(' ', retry);
  }
  function choices() {
    naming = false;
    panel.heading.textContent = 'Add to list';
    panel.body.replaceChildren(rows, actions, feedback);
  }
  newList.onclick = () => {
    naming = true;
    version++;
    feedback.textContent = '';
    panel.heading.textContent = 'New list';
    const form = doc.createElement('form');
    form.innerHTML = '<label>List name<input type="text" autocomplete="off"></label><div class="actions">' +
      '<button type="button">Cancel</button><button type="submit" class="primary">Create list</button></div>';
    const input = form.querySelector('input')!;
    const submit = form.querySelector<HTMLButtonElement>('[type="submit"]')!;
    submit.disabled = true;
    input.oninput = () => { feedback.textContent = ''; submit.disabled = !input.value.replace(/^ +| +$/g, ''); };
    form.querySelector<HTMLButtonElement>('[type="button"]')!.onclick = () => {
      choices(); feedback.textContent = ''; newList.focus(); void refresh().catch(fail);
    };
    form.onsubmit = event => {
      event.preventDefault();
      const name = input.value;
      void save(panel, ctx, feedback, async () => {
        if (await ctx.watch.createList(name, [show]) && panel.dialog.open) {
          choices(); feedback.textContent = 'Added to ' + name.replace(/^ +| +$/g, '') + '.';
        }
      }).then(() => {
        if (!panel.dialog.open) return;
        if (naming) input.focus();
        else void refresh(name.replace(/^ +| +$/g, '')).catch(fail);
      });
    };
    panel.body.replaceChildren(form, feedback);
    input.focus();
  };
  choices();
  ctx.service.store.addEventListener('recordchange', () => {
    if (!naming && !panel.body.inert) void refresh().catch(fail);
  }, { signal: panel.events.signal });
  void refresh().catch(fail);
  return panel.close;
}
