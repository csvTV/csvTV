export function releaseLinks(container: HTMLElement) {
    const win = container.ownerDocument.defaultView!;
    for (const link of container.querySelectorAll<HTMLAnchorElement>('a[download][href]')) {
      win.URL.revokeObjectURL(link.href);
      link.removeAttribute('href');
    }
  }
export function downloadLinks(doc: Document, items: readonly File[]) {
    const win = doc.defaultView!;
    const links = doc.createElement('div');
    links.className = 'recovery-downloads';
    try {
      for (const file of items) {
        const link = doc.createElement('a');
        link.download = file.name; link.textContent = file.name; link.className = 'button'; links.append(link);
        link.href = win.URL.createObjectURL(file);
      }
    } catch (error) { releaseLinks(links); throw error; }
    return links;
  }
