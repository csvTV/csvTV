import { MAX_INTEGER } from './model.ts';
import { openPersonalDialog } from './personal-dialog.ts';
import { PersonalRecordError } from './personal-record.ts';
import { TmdbError } from './tmdb-client.ts';

export function openWatchCountEditor(host: HTMLElement, title: string, count: number,
    saveCount: (value: number, current: () => boolean) => Promise<void>, returnFocus: () => HTMLElement | null,
    kind: 'episode' | 'season', maximum = MAX_INTEGER) {
  const panel = openPersonalDialog(host, title + ' watches', returnFocus);
  const form = host.ownerDocument.createElement('form');
  form.className = 'season-count-form';
  form.innerHTML = '<label for="watch-count"></label><div class="season-count-stepper">' +
    '<button type="button" data-decrease aria-label="Decrease watches">−</button>' +
    '<input id="watch-count" name="count" type="text" inputmode="numeric" autocomplete="off">' +
    '<button type="button" data-increase aria-label="Increase watches">+</button></div>' +
    '<p class="feedback" role="status"></p><div class="actions"><button type="button" data-cancel>Cancel</button>' +
    '<button class="primary" type="submit">Save</button></div>';
  panel.body.append(form);
  const input = form.querySelector('input')!;
  form.querySelector('label')!.textContent = kind === 'season' ? 'Completed watches' : 'Episode watches';
  if (kind === 'season') {
    const hint = host.ownerDocument.createElement('p');
    hint.id = 'season-count-hint';
    hint.className = 'hint';
    hint.textContent = 'Each step adds or removes one play per aired episode. Extra episode watches are kept.';
    form.querySelector('.season-count-stepper')!.after(hint);
    input.setAttribute('aria-describedby',hint.id);
  }
  const less = form.querySelector<HTMLButtonElement>('[data-decrease]')!;
  const more = form.querySelector<HTMLButtonElement>('[data-increase]')!;
  const save = form.querySelector<HTMLButtonElement>('[type=submit]')!;
  const feedback = form.querySelector<HTMLElement>('.feedback')!;
  const value = () => /^\d+$/.test(input.value.trim()) ? Number(input.value.trim()) : NaN;
  function update() {
    const n = value(), valid = Number.isSafeInteger(n) && n <= maximum;
    less.disabled = !valid || n === 0;
    more.disabled = !valid || n === maximum;
    save.disabled = !valid || n === count;
    input.setAttribute('aria-invalid', String(!valid));
    feedback.textContent = valid ? '' : 'Enter a whole number from 0 to ' + maximum.toLocaleString() + '.';
  }
  function step(change: number) {
    input.value = String(value() + change);
    update();
  }
  input.value = String(count);
  input.oninput = update;
  less.onclick = () => step(-1);
  more.onclick = () => step(1);
  form.querySelector<HTMLButtonElement>('[data-cancel]')!.onclick = panel.close;
  form.onsubmit = async event => {
    event.preventDefault();
    update();
    if (save.disabled || panel.body.inert) return;
    panel.progress.className = 'feedback';
    panel.setSaving(true);
    try {
      await saveCount(value(), () => panel.dialog.open);
      panel.close();
    } catch (error) {
      if (!panel.dialog.open) return;
      panel.setSaving(false);
      feedback.textContent = error instanceof RangeError || error instanceof PersonalRecordError || error instanceof TmdbError
        ? error.message : 'Could not change the watches. Reopen the count and try again.';
    }
  };
  update();
  return panel.close;
}
