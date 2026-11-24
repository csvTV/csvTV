/** A report can contain thousands of rows. Populate the details as the reader opens them. */
export function reviewList(doc: Document, label: string, length: number, item: (index: number) => string | Node) {
  const details = doc.createElement('details'), heading = doc.createElement('summary');
  heading.textContent = label + ' (' + length.toLocaleString() + ')';
  const list = doc.createElement('ul'), more = doc.createElement('button');
  more.type = 'button'; more.textContent = 'Show more';
  let limit = 50;
  function fillPage() {
    for (let i = list.childElementCount; i < Math.min(length, limit); i++) {
      const row = doc.createElement('li');
      row.append(item(i)); list.append(row);
    }
    const focused = doc.activeElement === more;
    more.hidden = limit >= length;
    if (more.hidden && focused) heading.focus();
  }
  details.ontoggle = () => {
    if (details.open && !list.childElementCount) fillPage();
    if (!details.open) list.replaceChildren();
  };
  more.onclick = () => { limit += 50; fillPage(); };
  details.append(heading, list, more);
  function refreshRows(nextLength: number) {
    if (nextLength !== length) {
      length = nextLength;
      heading.textContent = label + ' (' + length.toLocaleString() + ')';
    }
    if (!details.open) { list.replaceChildren(); return; }
    Array.from(list.children).forEach((li,i) => {
      if (i >= length) { li.remove(); return; }
      const value = item(i);
      if (typeof value !== 'string' || value !== li.textContent) li.replaceChildren(value);
    });
    fillPage();
  }
  return {details, refreshRows};
}
