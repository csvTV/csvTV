let dialogNumber = 0;

/** Keep focus in the sheet even while its contents change, and restore the current screen control on close. */
export function openPersonalDialog(host: HTMLElement, title: string, returnFocus: () => HTMLElement | null) {
  const doc = host.ownerDocument;
  const dialog = doc.createElement('dialog');
  const sheet = doc.createElement('div');
  sheet.className = 'sheet personal-sheet';
  const heading = doc.createElement('h2');
  heading.id = 'personal-heading-' + ++dialogNumber;
  heading.tabIndex = -1;
  heading.textContent = title;
  const body = doc.createElement('div');
  const progress = doc.createElement('p');
  progress.className = 'visually-hidden';
  progress.setAttribute('role', 'status');
  sheet.append(heading, body, progress);
  dialog.setAttribute('aria-labelledby', heading.id);
  dialog.append(sheet);
  let saving = false;

  function close() {
    if (!dialog.open) return;
    for (const input of body.querySelectorAll<HTMLInputElement>('input[type=password]')) input.value = '';
    dialog.close();
    dialog.remove();
    returnFocus()?.focus({ preventScroll: true });
  }
  function setSaving(value: boolean, message = 'Saving…') {
    if (!dialog.open) return;
    if (saving === value) {
      if (saving && progress.textContent !== message) progress.textContent = message;
      return;
    }
    saving = value;
    if (saving) heading.focus({ preventScroll: true });
    body.inert = saving;
    progress.textContent = saving ? message : '';
  }
  dialog.oncancel = event => { event.preventDefault(); if (!saving) close(); };
  dialog.onclick = event => { if (!saving && event.target === dialog) close(); };
  dialog.onkeydown = event => {
    if (event.key !== 'Tab') return;
    const fields = [...body.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),a[href],select:not(:disabled)')]
      .filter(el => el.getClientRects().length);
    const first = fields[0], last = fields.at(-1);
    if (saving || !first) { event.preventDefault(); heading.focus(); }
    else if (event.shiftKey && (doc.activeElement === first || doc.activeElement === heading)) {
      event.preventDefault(); last?.focus();
    } else if (!event.shiftKey && doc.activeElement === last) {
      event.preventDefault(); first.focus();
    }
  };
  host.append(dialog);
  dialog.showModal();
  heading.focus({ preventScroll: true });
  return { dialog, sheet, heading, body, progress, close, setSaving };
}
