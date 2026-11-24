export interface SheetAction {
  label: string;
  detail?: string;
  destructive?: boolean;
  when?: Promise<boolean>;
  choose(): void;
}

let sheetNumber = 0;

export function openActionSheet(root: HTMLElement, returnFocus: () => HTMLElement | null, options: {
  title: string; eyebrow?: string; description?: string; actions: SheetAction[];
}): () => void {
  const doc = root.ownerDocument;
  const dialog = doc.createElement('dialog');
  const sheet = doc.createElement('div');
  sheet.className = 'sheet watch-sheet';
  if (options.eyebrow) {
    const context = doc.createElement('p');
    context.className = 'watch-sheet-context';
    context.textContent = options.eyebrow;
    sheet.append(context);
  }
  const heading = doc.createElement('h2');
  heading.textContent = options.title;
  heading.id = 'watch-sheet-' + ++sheetNumber;
  heading.tabIndex = -1;
  dialog.setAttribute('aria-labelledby', heading.id);
  sheet.append(heading);
  if (options.description) {
    const description = doc.createElement('p');
    description.textContent = options.description;
    description.className = 'watch-sheet-description';
    sheet.append(description);
  }
  function close() {
    if (!dialog.open) return;
    dialog.close();
    dialog.remove();
    returnFocus()?.focus({ preventScroll: true });
  }
  const pending: Promise<void>[] = [];
  for (const action of options.actions) {
    const button = doc.createElement('button');
    button.className = 'watch-sheet-action' + (action.destructive ? ' destructive' : '');
    const label = doc.createElement('span');
    label.textContent = action.label;
    button.append(label);
    if (action.detail) {
      const detail = doc.createElement('small');
      detail.textContent = action.detail;
      button.append(detail);
    }
    button.onclick = () => { close(); action.choose(); };
    if (action.when) {
      const slot = doc.createComment('optional action');
      sheet.append(slot);
      pending.push(action.when.then(visible => {
        if (visible && dialog.open) slot.replaceWith(button);
      }));
    } else sheet.append(button);
  }
  const cancel = doc.createElement('button');
  cancel.className = 'watch-sheet-cancel';
  cancel.textContent = 'Cancel';
  cancel.onclick = close;
  sheet.append(cancel);
  if (pending.length) {
    dialog.setAttribute('aria-busy','true');
    void Promise.allSettled(pending).then(() => dialog.removeAttribute('aria-busy'));
  }
  dialog.append(sheet);
  dialog.oncancel = event => { event.preventDefault(); close(); };
  dialog.onclick = event => { if (event.target === dialog) close(); };
  dialog.onkeydown = event => {
    if (event.key !== 'Tab') return;
    const first = sheet.querySelector('button')!;
    if (event.shiftKey && (doc.activeElement === first || doc.activeElement === heading)) {
      event.preventDefault(); cancel.focus();
    } else if (!event.shiftKey && doc.activeElement === cancel) {
      event.preventDefault(); first.focus();
    }
  };
  root.append(dialog);
  dialog.showModal();
  heading.focus();
  return close;
}
