import type { ImportCountChoices, ImportCountShow } from './import-counts.ts';

type Choices = Required<ImportCountChoices>;
interface CountCardOptions {
  source: 'trakt' | 'anilist';
  id: number;
  show: string;
  reasons?: readonly string[];
  state(): ImportCountShow & Choices & {summary: string};
  update(seasonExtras: Choices['seasonExtras'], wholeShowPasses: Choices['wholeShowPasses']): boolean;
  prepareSeason?(showId: number, season: number): Promise<boolean>;
}

export const quantity = (n: number | bigint, unit: string) => n.toLocaleString() + ' ' + unit + (n === 1 || n === 1n ? '' : 's');

export function reviewShowsById(shows:readonly ImportCountShow[]) {
  return new Map(shows.map(show=>[show.show_id,show]));
}

function makeStepper(doc: Document, name: string, kind: 'whole' | 'season', id: number | undefined,
    disclosure: HTMLButtonElement,
    change: (delta: number, button: HTMLButtonElement) => void) {
  const element = doc.createElement('div'), value = doc.createElement('span');
  element.className = 'count-stepper';
  const prefix = 'data-' + kind + '-', number = id === undefined ? '' : String(id);
  value.setAttribute(prefix+'count', number);
  function button(adding: boolean) {
    const control = doc.createElement('button');
    control.type = 'button'; control.textContent = adding ? '+' : '−';
    control.setAttribute(prefix + (adding ? 'add' : 'remove'), number);
    control.setAttribute('aria-label', (adding ? 'Increase ' : 'Decrease ') + name);
    control.onclick = () => {
      change(adding ? 1 : -1, control);
      const target = control.disabled ? (adding ? remove : add) : control;
      (target.disabled ? disclosure : target).focus({preventScroll:true});
    };
    return control;
  }
  const remove = button(false), add = button(true);
  element.append(remove, value, add);
  return {element, value, remove, add};
}

export function countReviewCard(doc: Document, options: CountCardOptions) {
  const id = options.id;
  const review = doc.createElement('div'), header = doc.createElement('div'), toggle = doc.createElement('button');
  const title = doc.createElement('strong'), gap = doc.createElement('span'), body = doc.createElement('div');
  review.className = 'import-count'; review.dataset.countReview = String(id);
  header.className = 'count-header'; title.textContent = options.show; gap.className = 'count-gap';
  body.id = options.source + '-seasons-' + id; body.hidden = true;
  toggle.type = 'button'; toggle.dataset.countSummary = '';
  toggle.setAttribute('aria-expanded','false'); toggle.setAttribute('aria-controls',body.id);
  toggle.onclick = () => {
    if (!body.firstChild) {
      fillDetails();
      refreshShow();
    }
    body.hidden = !body.hidden;
    toggle.setAttribute('aria-expanded', String(!body.hidden));
  };
  toggle.append(title, gap);

  // Updating the skipped and placement reports can move the card above or below the viewport.
  function keepButtonInPlace(button: HTMLButtonElement, render: () => void) {
    const before = button.getBoundingClientRect();
    render();
    const win = doc.defaultView!;
    if (before.height && before.bottom > 0 && before.top < win.innerHeight) {
      const shift = button.getBoundingClientRect().top - before.top;
      if (Math.abs(shift) > .5) win.scrollBy(0,shift);
    }
  }
  function adjust(season: number | undefined, delta: number, button: HTMLButtonElement) {
    const state = options.state();
    const whole = new Map(state.wholeShowPasses), extras = new Map(state.seasonExtras);
    if (season === undefined) {
      const value = (whole.get(id) ?? 0) + delta;
      if (value) whole.set(id,value); else whole.delete(id);
    } else {
      const edited = new Map(extras.get(id)), value = (edited.get(season) ?? 0) + delta;
      if (value) edited.set(season,value); else edited.delete(season);
      if (edited.size) extras.set(id,edited); else extras.delete(id);
    }
    keepButtonInPlace(button, () => {
      if (options.update(extras,whole)) refreshShow();
    });
  }
  const wholeControl = makeStepper(doc, 'whole-show rewatches for ' + options.show, 'whole', undefined, toggle, (delta,button) => adjust(undefined,delta,button));
  const wholeGroup = doc.createElement('div'), label = doc.createElement('small');
  wholeGroup.className = 'count-whole'; label.textContent = 'Whole-show rewatches';
  wholeGroup.title = 'Adjust only the episodes matched from the export.';
  wholeGroup.append(label, wholeControl.element);
  header.append(toggle,wholeGroup); review.append(header,body);
  const rows = new Map<number, ReturnType<typeof addSeason>>();
  function addSeason(season: ImportCountShow['seasons'][number]) {
    const number = season.season, label = season.label ?? 'Season ' + number;
    const line = doc.createElement('div'), description = doc.createElement('div'), name = doc.createElement('strong');
    const episodes = doc.createElement('small');
    line.className = 'count-season'; name.textContent = label;
    description.append(name, episodes);
    let loading = false;
    const control = makeStepper(doc, 'watches for ' + options.show + ', ' + label, 'season', number, toggle, async (delta,button) => {
      if (loading) return;
      const stateBeforeEdit = options.state();
      const current = stateBeforeEdit.seasons.find(s => s.season === number);
      const extra = stateBeforeEdit.seasonExtras.get(id)?.get(number) ?? 0;
      if (delta > 0 && extra >= 0 && current?.airedEpisodes === null && options.prepareSeason) {
        loading = true;
        control.add.setAttribute('aria-busy','true');
        episodes.textContent = 'Checking aired episodes…';
        try {
          if (!await options.prepareSeason(id,number)) return;
        } catch (error) {
          episodes.textContent = error instanceof Error ? error.message + ' Press + to retry.' : 'Could not load episodes. Press + to retry.';
          return;
        } finally {
          loading = false; control.add.removeAttribute('aria-busy');
        }
        const state = options.state();
        const focused = doc.activeElement === button;
        let ready = false;
        keepButtonInPlace(button, () => {
          if (!options.update(state.seasonExtras,state.wholeShowPasses)) return;
          refreshShow();
          ready = !control.add.disabled;
          if (!ready && focused && !body.hidden) toggle.focus({preventScroll:true});
        });
        if (!ready) return;
      }
      adjust(number,delta,button);
    });
    line.append(description,control.element); body.append(line);
    return {control,episodes};
  }
  function fillDetails() {
    for (const season of options.state().seasons) {
      if (season.season > 0) rows.set(season.season,addSeason(season));
    }
    if (!rows.size) {
      const empty = doc.createElement('p');
      empty.textContent = 'No regular seasons to adjust.';
      body.append(empty);
    }
    if (options.reasons?.length) {
      const notes = doc.createElement('ul');
      notes.className = 'count-notices';
      for (const reason of options.reasons) {
        const item = doc.createElement('li');
        item.dataset.anilistReviewNotice = '';
        item.textContent = reason;
        notes.append(item);
      }
      body.append(notes);
    }
  }
  function refreshShow() {
    const state = options.state(), seasons = state.seasons;
    const extras = state.seasonExtras.get(id), whole = state.wholeShowPasses.get(id) ?? 0;
    gap.textContent = state.summary;
    review.toggleAttribute('data-adjusted',Boolean(extras?.size || whole));
    wholeControl.value.textContent = whole.toLocaleString() + '×';
    wholeControl.add.disabled = !state.canIncrease;
    wholeControl.remove.disabled = !state.canDecrease;
    if (!rows.size) return;
    for (const season of seasons) {
      const row = rows.get(season.season);
      if (!row) continue;
      const {control,episodes} = row;
      if (!control.add.hasAttribute('aria-busy')) {
        let text = season.matchedEpisodes ? quantity(season.matchedEpisodes,'matched episode') : 'No matched episodes';
        if (season.airedEpisodes !== null) {
          text = season.airedEpisodes ? quantity(season.airedEpisodes,'aired episode') : 'No aired episodes';
          if (season.matchedEpisodes) text += ' · ' + season.matchedEpisodes.toLocaleString() + ' matched';
        }
        if (season.blockedEpisodes) text += ' · ' + season.eligibleEpisodes.toLocaleString() + ' importable';
        episodes.textContent = text;
      }
      control.value.textContent = season.displayCount.toLocaleString() + '×';
      control.add.disabled = !season.canIncrease;
      control.remove.disabled = !season.canDecrease;
    }
  }
  refreshShow();
  return review;
}
