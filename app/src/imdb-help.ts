import { openPersonalDialog } from './personal-dialog.ts';
import { moduleReloadButton } from './offline.ts';
import type { DeviceStore } from './storage.ts';
import type { jobText } from './imdb-job-text.js';

const omdb = 'https://www.omdbapi.com/apikey.aspx';
const newRepo = 'https://github.com/new?name=csvtv-ratings&visibility=private';
const newToken = 'https://github.com/settings/personal-access-tokens/new?name=csvTV+ratings&description=Reads+the+ratings+files&contents=read&expires_in=30';
const myAnimeList = 'https://myanimelist.net/apiconfig';

type Step = { instruction: string; href?: string; file?: keyof typeof jobText };
const omdbSteps: Step[] = [
  {instruction:'Open the OMDb API key page.', href:omdb},
  {instruction:'Choose the free account.'},
  {instruction:'Fill in the form and submit.'},
  {instruction:'Check your email for the key.'},
  {instruction:'Paste the key here.'},
];
const githubSteps: Step[] = [
  {instruction:'Create a private repo with a README.', href:newRepo},
  {instruction:'Choose Add file → Create new file. Paste the script and commit to the default branch.', file:'build.mjs'},
  {instruction:'Add the workflow at the path shown below and commit it to the default branch.', file:'imdb-ratings.yml'},
  {instruction:'In Actions, run IMDb ratings. Look for imdb-ratings.csv.gz on the data branch.'},
  {instruction:'Limit a fine-grained token to this repository. Set Contents to read-only, generate the token, then copy it.', href:newToken},
  {instruction:'In csvTV, choose GitHub job. Save the repository as owner/name, then save your token.'},
];

const malSteps: Step[] = [
  {instruction:'Reuse your IMDb repository and token. Otherwise, create a private repo with a README and a fine-grained token with read-only Contents for that repo.'},
  {instruction:'Under Account Settings → API, choose Create ID. Register the app, then open Edit and copy the Client ID.', href:myAnimeList},
  {instruction:'In repository Settings → Secrets and variables → Actions, save the Client ID as MAL_CLIENT_ID.'},
  {instruction:'Choose Add file → Create new file. Paste the script and commit to the default branch.', file:'mal-build.mjs'},
  {instruction:'Add the workflow at the path shown below and commit it to the default branch.', file:'mal-ratings.yml'},
  {instruction:'In Actions, run MyAnimeList scores. Look for mal-ratings.csv.gz on the mal-data branch.'},
  {instruction:'In csvTV, choose GitHub job under MyAnimeList scores. Save owner/name and your token if prompted.'},
];
const helpSheets = {
  omdb: {title:'Get an OMDb key', steps:omdbSteps, link:omdb, label:'Open OMDb'},
  github: {title:'Set up the GitHub job', steps:githubSteps, link:newRepo, label:'Open GitHub'},
  mal: {title:'Set up the MyAnimeList job', steps:malSteps, link:myAnimeList, label:'Open MyAnimeList'},
};

export function openRatingsHelp(root: HTMLElement, source: keyof typeof helpSheets, trigger: HTMLElement, store: DeviceStore) {
  const doc = root.ownerDocument;
  const sheet = helpSheets[source];
  const {body, dialog, progress, close} = openPersonalDialog(root, sheet.title, () => trigger);
  const list = doc.createElement('ol');
  list.className = 'steps';
  function link(label: string, href: string) {
    const anchor = doc.createElement('a');
    anchor.textContent = label;
    anchor.href = href; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer';
    return anchor;
  }
  const feedback = doc.createElement('p');
  feedback.className = 'feedback';
  feedback.setAttribute('role','status');
  let copyRequest = 0;
  let manualCopy: HTMLTextAreaElement | undefined;
  let templates: typeof jobText | undefined;
  const copyButtons: HTMLButtonElement[] = [];
  for (const step of sheet.steps) {
    const item = doc.createElement('li');
    const instruction = doc.createElement('span');
    instruction.className = 'help-instruction';
    instruction.textContent = step.instruction;
    item.append(instruction);
    if (step.href) {
      const url = new URL(step.href);
      item.append(link(url.hostname.replace(/^www\./,'') + url.pathname.replace(/\/$/,''), step.href));
    }
    const file = step.file;
    if (file) {
      const filename = doc.createElement('code');
      filename.textContent = file.endsWith('.yml') ? '.github/workflows/' + file : file;
      const button = doc.createElement('button');
      button.textContent = 'Copy';
      button.disabled = true;
      button.setAttribute('aria-busy','true');
      copyButtons.push(button);
      button.setAttribute('aria-label', 'Copy ' + filename.textContent);
      button.onclick = async () => {
        if (!templates) return;
        const text = templates[file];
        const request = ++copyRequest;
        manualCopy?.remove();
        try {
          await doc.defaultView!.navigator.clipboard.writeText(text);
          if (dialog.open && request === copyRequest) feedback.textContent = 'Copied ' + filename.textContent + '.';
        } catch {
          if (!dialog.open || request !== copyRequest) return;
          feedback.textContent = 'Use your device’s Copy command to copy the selected contents of ' + filename.textContent + '.';
          manualCopy = doc.createElement('textarea');
          manualCopy.className = 'job-manual-copy';
          manualCopy.readOnly = true;
          manualCopy.rows = 4;
          manualCopy.setAttribute('aria-label', filename.textContent + ' contents');
          manualCopy.value = text;
          feedback.after(manualCopy);
          manualCopy.focus();
          manualCopy.select();
        }
      };
      const line = doc.createElement('div');
      line.className = 'job-file-copy';
      line.append(filename, button); item.append(line);
    }
    list.append(item);
  }
  const actions = doc.createElement('div');
  actions.className = 'actions help-actions';
  const done = doc.createElement('button');
  done.textContent = 'Done'; done.onclick = close;
  const open = link(sheet.label + ' ↗', sheet.link);
  open.className = 'button primary';
  actions.append(done, open);
  body.append(list, feedback, actions);
  if (copyButtons.length) {
    // Loading must not move a bottom sheet between the start and end of a tap.
    progress.textContent = 'Loading setup files…';
    void import('./imdb-job-text.js').then(module => {
      if (!dialog.open) return;
      templates = module.jobText;
      // Copy must reach the clipboard in the original tap, especially in iPhone Safari.
      for (const button of copyButtons) {
        button.removeAttribute('aria-busy');
        button.disabled = false;
      }
      progress.textContent = '';
    }).catch(() => {
      if (!dialog.open) return;
      for (const button of copyButtons) button.removeAttribute('aria-busy');
      progress.textContent = '';
      feedback.textContent = 'Could not load the setup files. Reconnect and reload csvTV to try again.';
      actions.prepend(moduleReloadButton(feedback,store));
    });
  }
  return close;
}

export {openRatingsHelp as openImdbHelp};
