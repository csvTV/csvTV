import { openPersonalDialog } from './personal-dialog.ts';
import { PersonalRecordError, validateListName } from './personal-record.ts';
import type { ScreenContext } from './screen-context.ts';

interface ListEditorOptions {
  name?: string;
  returnFocus(): HTMLElement | null;
  saved(name: string): Promise<void>;
}

export function openListEditor(host: HTMLElement, ctx: ScreenContext, options: ListEditorOptions) {
  const doc = host.ownerDocument;
  const rename = options.name !== undefined;
  const modal = openPersonalDialog(host, rename ? 'Rename list' : 'New list', options.returnFocus);
  const form = doc.createElement('form');
  form.className = 'list-form';
  const field = /[\r\n]/.test(options.name ?? '') ? '<textarea rows="2" required autocomplete="off"></textarea>' :
    '<input type="text" required autocomplete="off">';
  form.innerHTML = '<label>List name' + field + '</label>' +
    '<p class="feedback" role="status"></p><div class="actions"><button type="button">Cancel</button>' +
    '<button type="submit" class="primary"></button></div>';
  modal.body.append(form);
  const nameInput = form.querySelector<HTMLInputElement | HTMLTextAreaElement>('input,textarea')!;
  nameInput.value = options.name ?? '';
  const initialValue = nameInput.value;
  form.querySelector<HTMLButtonElement>('[type=submit]')!.textContent = rename ? 'Rename list' : 'Create list';
  const feedback = form.querySelector<HTMLElement>('.feedback')!;
  nameInput.focus();
  if (rename) nameInput.select();
  form.querySelector<HTMLButtonElement>('[type=button]')!.onclick = modal.close;
  nameInput.oninput = () => { feedback.textContent = ''; nameInput.removeAttribute('aria-invalid'); };
  let busy = false;
  let retired = false;
  const current = () => !retired;
  form.onsubmit = event => {
    event.preventDefault();
    if (busy || !modal.dialog.open) return;
    // Preserve existing CR/CRLF spellings when a textarea is left unchanged.
    if (rename && nameInput.value === initialValue) { modal.close(); return; }
    const requested = nameInput.value;
    void ctx.run(async () => {
      if (busy || !current()) return;
      busy = true;
      modal.setSaving(true);
      feedback.textContent = '';
      try {
        const name = validateListName(requested, []);
        const saved = rename ? await ctx.watch.renameList(options.name!,name,current) : await ctx.watch.createList(name,[],{current});
        if (saved && current()) {
          modal.close();
          await options.saved(name);
        }
      } catch (error) {
        if (error instanceof PersonalRecordError && modal.dialog.open) {
          feedback.textContent = error.message;
          nameInput.setAttribute('aria-invalid','true');
        } else { modal.close(); throw error; }
      } finally {
        busy = false;
        if (modal.dialog.open) { modal.setSaving(false); nameInput.focus(); }
      }
    });
  };
  return () => { retired = true; modal.close(); };
}
