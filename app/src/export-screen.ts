import { prepareExport, type ExportSelection, type PreparedExport } from './export-data.ts';
import type { Screen, ScreenContext } from './screen-context.ts';

const prompt = 'The attached file is my complete TV watch record. Each row is one season of a show, or, with no season given, a show I have not started: how many episodes I watched, how many times I completed it, my rating of the show out of 10, and any lists it is on. Shows on the list "Watchlist" are ones I already plan to watch. Recommend ten shows I have not watched and that are not on my Watchlist. For each, give one sentence on why it fits what I rate highly or rewatch.';

const symbols = {
  share: 'M12 15V3m-4 4 4-4 4 4M7 9H5v12h14V9h-2',
  download: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',
  copy: 'M8 8h12v13H8zM16 5V3H4v13h1',
};
function icon(name: keyof typeof symbols) {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + symbols[name] + '"/></svg>';
}

export function mountExportScreen(root: HTMLElement, ctx: ScreenContext): Screen {
  const doc = root.ownerDocument;
  const win = doc.defaultView!;
  const nav = win.navigator;
  root.innerHTML = `<section class="export-screen">
    <header><h1>Export</h1><p>Send your watch record to an AI app and ask for recommendations.</p></header>
    <fieldset><legend class="visually-hidden">Choose files to export</legend>
      <label><input type="radio" name="export-files" value="summary" checked><span><strong>summary.csv</strong>
        <small>Seasons watched, and shows not started<span data-row-count></span></small></span></label>
      <label><input type="radio" name="export-files" value="record"><span><strong>All four data files</strong>
        <small>watched, ratings, lists, shows</small></span></label>
    </fieldset>
    <div class="export-actions"><button class="primary" data-share disabled>${icon('share')}Share</button>
      <div class="export-downloads" role="group" aria-label="Downloads"></div></div>
    <p class="export-omission"></p>
    <p data-export-status role="status"></p><button type="button" data-retry-export hidden>Prepare again</button>
    <section class="export-prompt"><h2>Prompt</h2><blockquote></blockquote><button data-copy>${icon('copy')}Copy prompt</button></section>
  </section>`;
  const one = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const share = one<HTMLButtonElement>('[data-share]');
  const downloads = one('.export-downloads');
  const promptSection = one('.export-prompt');
  const quote = one('blockquote');
  const count = one('[data-row-count]');
  const omission = one('.export-omission');
  const status = one('[data-export-status]');
  const retry = one<HTMLButtonElement>('[data-retry-export]');
  quote.textContent = prompt;
  let selection: ExportSelection = 'summary';
  let prepared: PreparedExport | undefined;
  let supported = false;
  let sharing = false;
  let generation = 0;
  let disposed = false;
  let inFlight: Promise<void> | undefined;
  let reading: AbortController | undefined;

  function releaseDownloads() {
    for (const link of downloads.querySelectorAll<HTMLAnchorElement>('a[href]')) {
      win.URL.revokeObjectURL(link.href);
      link.removeAttribute('href');
      link.removeAttribute('download');
      link.tabIndex = -1;
      link.setAttribute('aria-disabled', 'true');
    }
  }

  function showDownloads(files: readonly File[]) {
    // Keep the same focusable link when a committed record edit replaces its bytes.
    if (downloads.children.length !== files.length) downloads.replaceChildren();
    files.forEach((file, index) => {
      const link = (downloads.children[index] as HTMLAnchorElement | undefined) ?? doc.createElement('a');
      link.className = 'button';
      link.href = win.URL.createObjectURL(file);
      link.download = file.name;
      link.removeAttribute('aria-disabled');
      link.setAttribute('aria-label', 'Download ' + file.name);
      link.innerHTML = icon('download');
      link.append(selection === 'summary' ? 'Download' : file.name);
      link.tabIndex = 0;
      if (!link.parentNode) downloads.append(link);
    });
  }

  function present(result: PreparedExport) {
    showDownloads(result.files);
    prepared = result;
    try {
      supported = typeof nav.share === 'function' && typeof nav.canShare === 'function' && nav.canShare({ files: result.files });
    } catch { supported = false; }
    share.disabled = !supported || sharing;
    share.hidden = !supported;
    status.textContent = supported ? '' : selection === 'record'
      ? 'File sharing is unavailable here. Download each CSV separately.' : 'File sharing is unavailable here. Use Download.';
    if (selection === 'summary') {
      count.textContent = ' · ' + result.rows.toLocaleString() + (result.rows === 1 ? ' row' : ' rows');
      if (result.missingShows) {
        omission.textContent = 'Season completion is unavailable for ' + result.missingShows.toLocaleString() +
          (result.missingShows === 1 ? ' show.' : ' shows.');
      }
    }
  }

  async function prepareLatest() {
    try {
      while (!disposed) {
        const pending = generation;
        reading = new AbortController();
        try {
          const result = await prepareExport(ctx.service, selection,reading.signal);
          if (disposed) return;
          if (pending !== generation) continue;
          present(result);
        } catch {
          if (disposed) return;
          if (pending !== generation) continue;
          releaseDownloads();
          status.textContent = 'Could not prepare the files.';
          retry.hidden = false;
        }
        return;
      }
    } finally { reading = undefined; inFlight = undefined; }
  }

  function refresh() {
    if (disposed) return Promise.resolve();
    generation++;
    reading?.abort();
    prepared = undefined;
    supported = false;
    share.disabled = true;
    retry.hidden = true;
    count.textContent = '';
    omission.textContent = '';
    status.textContent = 'Preparing files…';
    releaseDownloads();
    inFlight ??= prepareLatest();
    return inFlight;
  }

  async function shareSelection() {
    const source = prepared;
    if (!source || !supported || sharing || disposed) return;
    sharing = true;
    share.disabled = true;
    status.textContent = '';
    try {
      // Keep the tap's transient activation. All files and capability checks are already ready.
      await nav.share({ files: source.files });
    } catch (error) {
      if (!disposed && prepared === source) {
        const canceled = typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError';
        status.textContent = canceled ? 'Share canceled.' : 'Sharing was unavailable. You can still download the files.';
      }
    } finally {
      sharing = false;
      if (!disposed) share.disabled = !supported;
    }
  }

  async function copyPrompt() {
    const current = generation;
    try {
      await nav.clipboard.writeText(prompt);
      if (!disposed && current === generation) status.textContent = 'Prompt copied.';
    } catch {
      if (!disposed && current === generation) {
        win.getSelection()?.selectAllChildren(quote);
        status.textContent = 'Copy the selected prompt using your device’s Copy command.';
      }
    }
  }

  for (const radio of root.querySelectorAll<HTMLInputElement>('input[name="export-files"]')) {
    radio.onchange = () => {
      if (disposed || !radio.checked) return;
      selection = radio.value === 'record' ? 'record' : 'summary';
      promptSection.hidden = selection !== 'summary';
      downloads.classList.toggle('export-record-downloads', selection === 'record');
      releaseDownloads();
      downloads.replaceChildren();
      void refresh();
    };
  }
  retry.onclick = () => { void refresh(); };
  share.onclick = () => { void shareSelection(); };
  one('[data-copy]').onclick = () => { void copyPrompt(); };
  return { ready: refresh(), refresh, dispose() {
    disposed = true;
    reading?.abort();
    prepared = undefined;
    share.disabled = true;
    releaseDownloads();
  } };
}
