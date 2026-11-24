import type { SyncGuardQuestion } from './dropbox-sync.ts';
import type { DoubleMarkReview, IdentityReview, IdentityAssignment } from './watch-merge.ts';
import { alignEpisodes, applyAssignments, competingRows, sides, type WatchInputs } from './watch-identity.ts';
import type { WatchedRow } from './model.ts';
import type { GuardDecision } from './guard.ts';
import type { ValueDeliveryReview } from './dropbox-delivery.ts';

type Button = { label:string; value:string; destructive?:boolean };

function appendReviewRows<T>(parent:HTMLElement,items:readonly T[],render:(item:T)=>HTMLElement,more:string) {
  const doc = parent.ownerDocument, button = doc.createElement('button');
  button.type = 'button'; button.textContent = more;
  let index = 0;
  const append = () => {
    const fragment = doc.createDocumentFragment(), end = Math.min(index + 50,items.length);
    while (index < end) fragment.append(render(items[index++]));
    const first = fragment.firstElementChild as HTMLElement|null;
    const keyboard = doc.activeElement === button;
    parent.insertBefore(fragment,button.parentElement === parent ? button : null);
    if (index === items.length) button.remove();
    else if (button.parentElement !== parent) parent.append(button);
    if (keyboard && first) {
      const focus = first.querySelector<HTMLElement>('summary,input,select,button') ?? first;
      if (focus === first) first.tabIndex = -1;
      focus.focus();
    }
  };
  button.onclick = append; append();
}

// Leave unambiguous episodes in the mapping without rendering an editor for every watched episode.
function separateMappings(review: IdentityReview) {
  const manual = new Set(review.conflicts.map(c => review.inputs[c.side][c.index]));
  const indexes = new Map<WatchedRow,number>();
  for (const side of sides) review.inputs[side].forEach((row,i) => indexes.set(row,i));
  for (;;) {
    const others:WatchInputs = {before:[],mine:[],theirs:[]};
    for (const side of sides) others[side] = review.inputs[side].filter(row => !manual.has(row));
    const matched = alignEpisodes(others,true);
    if (Array.isArray(matched)) {
      const automatic = matched.map(group => {
        const destination:IdentityAssignment = {...group.place};
        for (const side of sides) if (group[side]) destination[side] = indexes.get(group[side]!);
        return destination;
      });
      return {manual,automatic};
    }
    const additional = competingRows(others,matched.places);
    if (!additional.length) return {manual:new Set(sides.flatMap(side => review.inputs[side])),automatic:[]};
    for (const item of additional) manual.add(item.row);
  }
}

/** A modal owns its focus and returns it to the opening control, including after a non-cancellable hold. */
export class DropboxDialogs {
  readonly doc:Document;
  #finish?: (answer:string) => void;
  #retired = false;
  constructor(doc: Document) { this.doc = doc; }
  close(retire = false) {
    this.#retired ||= retire;
    this.#finish?.('cancel');
  }
  choose(title:string, body:string, buttons:Button[], extra?:HTMLElement, signal?:AbortSignal):Promise<string> {
    if (signal?.aborted || this.#retired) return Promise.resolve('cancel');
    this.close();
    const doc = this.doc, origin = doc.activeElement as HTMLElement|null;
    const dialog = doc.createElement('dialog');
    dialog.className = 'dropbox-dialog';
    if (signal) dialog.dataset.screenReview = '';
    const heading = doc.createElement('h2');
    heading.id = 'dropbox-dialog-title';
    heading.tabIndex = -1;
    heading.textContent = title;
    dialog.setAttribute('aria-labelledby', heading.id);
    const message = doc.createElement('p');
    message.className = 'dropbox-message';
    message.textContent = body;
    message.id = 'dropbox-dialog-message';
    dialog.setAttribute('aria-describedby', message.id);
    const actions = doc.createElement('div');
    actions.className = 'actions';
    dialog.append(heading, message);
    if (extra) dialog.append(extra);
    dialog.append(actions);
    doc.body.append(dialog);
    return new Promise(resolve => {
      const finish = (value:string) => {
        signal?.removeEventListener('abort', cancel);
        this.#finish = undefined;
        dialog.close(); dialog.remove();
        if (origin && origin !== doc.body && origin.isConnected && !origin.matches(':disabled') && origin.getClientRects().length) {
          origin.focus();
        } else doc.querySelector<HTMLElement>('main')?.focus();
        resolve(value);
      };
      const cancel = () => finish('cancel');
      signal?.addEventListener('abort', cancel, {once:true});
      this.#finish = finish;
      for (const choice of buttons) {
        const b = doc.createElement('button');
        b.type = 'button';
        b.textContent = choice.label;
        if (choice.destructive) b.className = 'destructive';
        b.onclick = () => finish(choice.value);
        actions.append(b);
      }
      dialog.oncancel = e => {
        e.preventDefault();
        if (buttons.some(b => b.value === 'cancel')) finish('cancel');
      };
      dialog.onkeydown = e => {
        if (e.key !== 'Tab') return;
        const controls = Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href],summary'))
          .filter(control => control.getClientRects().length > 0);
        if (!controls.length) { e.preventDefault(); heading.focus(); return; }
        if (e.shiftKey && (doc.activeElement === heading || doc.activeElement === controls[0])) {
          e.preventDefault(); controls.at(-1)!.focus();
        } else if (!e.shiftKey && doc.activeElement === controls.at(-1)) {
          e.preventDefault(); controls[0].focus();
        }
      };
      dialog.showModal();
      if (!buttons.length) heading.setAttribute('role','status');
      heading.focus();
    });
  }

  hold(table:string|null) {
    if (table) void this.choose('Saving ' + table + '.csv', 'Please wait while csvTV checks the file and saves your choice.', []);
    else this.close();
  }

  async guard(q:SyncGuardQuestion):Promise<GuardDecision['choices'][number]> {
    const reasons:Record<string,string> = {
      missing:'The file is missing from Dropbox.', damaged:'Dropbox has a file with unreadable rows.',
      unsupported:'This file contains a field or setting this version cannot read.',
      unidentifiable:'The format could not be identified. Repair the file in Dropbox before syncing again.',
      'missing-target':'The pending upload’s original file is missing.',
      'damaged-base':'The last-synced copy on this device is unreadable. Dropbox has a newer version.',
      'unknown-outcome':'The revision history cannot establish whether the pending upload arrived.',
      'all-local-rows-removed':'Merging would remove every existing row on this device.',
      'over-one-fifth-removed':'Merging would remove over one fifth of the rows on this device.',
      'remote-emptied':'The Dropbox file has lost every row.',
    };
    const lines = [reasons[q.decision.reason] ?? q.decision.reason];
    if (q.ambiguousRemoteEpisodes) lines.push('Dropbox assigns one episode ID to multiple positions in a show. Review the episode positions before using those rows.');
    for (const finding of q.findings) {
      lines.push(['Line ' + finding.line, finding.reason, finding.field, finding.setting]
        .filter(part => part !== undefined).join(' · '));
    }
    if (q.impact) {
      const i = q.impact;
      lines.push('The merge removes ' + i.removedRows + ' rows, lowers ' + i.loweredCounts + ' episode counts by ' +
        i.lostViewings + ' viewings, and changes ' + i.changedRatings + ' ratings and ' + i.changedSettings + ' settings.');
    }
    if (q.decision.choices.includes('take-remote')) lines.push('Taking Dropbox replaces ' + (q.unsynced ?? 'an unknown number of') +
      ' unsynced changes. The two copies differ in ' + (q.different ?? 'an unknown number of') + ' rows.');
    if (q.decision.choices.includes('combine')) {
      const combined = {
        watched:'Combining keeps the higher watch count for each episode. A watch added on both devices can count only once.',
        ratings:'Combining keeps this device’s rating when the two copies disagree.',
        lists:'Combining keeps the list memberships from both copies.',
        settings:'Combining keeps this device’s setting when the two copies disagree.',
      };
      lines.push(combined[q.table] + ' Rows removed from one copy return if they still exist in the other.');
    }
    const labels = {'restore-device':'Restore Dropbox from this device','take-remote':'Take Dropbox as it is',
      'merge-anyway':'Merge anyway', combine:'Combine the two', reload:'Reload', cancel:'Cancel'};
    const answer = await this.choose('Sync paused · ' + q.table + '.csv', lines.join('\n\n'),
      q.decision.choices.map(value => ({label:labels[value],value})));
    return answer as GuardDecision['choices'][number];
  }

  async doubleMarks(review:DoubleMarkReview) {
    const list = this.doc.createElement('div');
    const overrides = new Map<string,'one'|'two'>();
    const seasonChoices = new Map<DoubleMarkReview['episodes'],'one'|'two'>();
    const episodeRow = (item:DoubleMarkReview['episodes'][number]) => {
      const row = this.doc.createElement('fieldset');
      const legend = this.doc.createElement('legend');
      const place = (item.show || 'Show ' + item.show_id) + ' · S' + item.season + ' E' + item.episode;
      legend.textContent = place + (item.title ? ' · ' + item.title : '') + (item.deliveryTotals
        ? (review.firstCopy ? ' · Shared copy ' : ' · Once gives ') + item.deliveryTotals.one +
          (review.firstCopy ? ' · Separate copies ' : ' · Twice gives ') + item.deliveryTotals.two
        : ' · Before ' + item.before + ', here ' + item.mine + ', Dropbox ' + item.theirs);
      row.append(legend);
      if (review.episodes.length > 1) {
        const segments = this.doc.createElement('div');
        segments.className = 'segments';
        const choices = review.delivery ? ['season','one','two'] as const : ['one','two'] as const;
        for (const answer of choices) {
          const label = this.doc.createElement('label'), radio = this.doc.createElement('input');
          radio.type = 'radio'; radio.name = item.key; radio.checked = answer === 'season';
          radio.onchange = () => answer === 'season' ? overrides.delete(item.key) : overrides.set(item.key, answer);
          const caption = this.doc.createElement('span');
          caption.textContent = answer === 'season' ? 'Use season' : review.firstCopy
            ? answer === 'one' ? 'Shared' : 'Separate' : answer === 'one' ? 'One' : 'Two';
          label.append(radio, caption); segments.append(label);
        }
        row.append(segments);
      }
      return row;
    };
    if (review.delivery && review.episodes.length > 1) {
      const seasons = new Map<string,DoubleMarkReview['episodes']>();
      for (const episode of review.episodes) {
        const key = episode.show_id + '/' + episode.season, season = seasons.get(key);
        if (season) season.push(episode);
        else seasons.set(key,[episode]);
      }
      appendReviewRows(list,[...seasons.values()],episodes => {
        const first = episodes[0], details = this.doc.createElement('details'), summary = this.doc.createElement('summary');
        const seasonName = (first.show || 'Show ' + first.show_id) + ' · Season ' + first.season;
        const totals = first.deliveryTotals;
        const uniform = totals && episodes.every(row=>row.deliveryTotals?.one===totals.one && row.deliveryTotals.two===totals.two);
        summary.textContent = seasonName + ' · ' + episodes.length + (episodes.length === 1 ? ' episode' : ' episodes') +
          (uniform ? ' · ' + totals.one + ' or ' + totals.two + ' plays per episode' : '');
        details.append(summary);
        details.ontoggle = () => {
          if (!details.open || details.childElementCount > 1) return;
          appendReviewRows(details,episodes,episodeRow,'Show more episodes');
        };
        const group = this.doc.createElement('div'), select = this.doc.createElement('select');
        group.className = 'delivery-season'; select.setAttribute('aria-label',seasonName + ' watch change');
        for (const [value,label] of [['','Use main choice'],['one',review.firstCopy?'Shared copy':'Count once'],
          ['two',review.firstCopy?'Separate copies':'Count twice']]) {
          const option = this.doc.createElement('option');
          option.value = value; option.textContent = label; select.append(option);
        }
        select.onchange = () => {
          if (select.value === 'one' || select.value === 'two') seasonChoices.set(episodes,select.value);
          else seasonChoices.delete(episodes);
        };
        group.append(details,select); return group;
      },'Show more seasons');
    } else {
      appendReviewRows(list,review.episodes,episodeRow,'Show more episodes');
    }
    const choice = await this.choose(review.firstCopy ? 'Choose the watch counts to keep' :
      review.delivery ? 'Count the interrupted watch change once or twice?' : 'Count the change once or twice?',
      review.firstCopy ? 'Dropbox has the same first watch file this device tried to save. Shared copy applies later edits to that file. Separate copies keeps the higher count from each episode’s two current copies.' :
      review.delivery ? 'Dropbox has a matching change. Choose One for the same watch or removal, including a retry on this device. Choose Two if the change happened separately on two devices.' +
        (review.episodes.length > 1 ? ' Set a different choice for a season or expand it to choose by episode.' : '') :
        'Choose One if both copies recorded the same viewing or removal. Choose Two to count both changes. Your choice applies to episodes without their own answer.',
      [{value:'cancel',label:'Cancel'}, {value:'one',label:review.firstCopy?'Shared copy':'One change'},
        {value:'two',label:review.firstCopy?'Separate copies':'Two changes'}], list);
    if (choice !== 'one' && choice !== 'two') return null;
    for (const [episodes,answer] of seasonChoices) {
      for (const {key} of episodes) if (!overrides.has(key)) overrides.set(key,answer);
    }
    return {choice,overrides} as const;
  }

  async valueDelivery(review:ValueDeliveryReview):Promise<'shared'|'independent'|null> {
    const body = this.doc.createElement('div');
    appendReviewRows(body,review.rows,item=>{
      const row = this.doc.createElement('p'), title = this.doc.createElement('strong');
      title.textContent = item.label;
      row.append(title,this.doc.createElement('br'),'This device’s upload · ' + item.shared,
        this.doc.createElement('br'),'Separate change · ' + item.independent);
      return row;
    },'Show more changes');
    const choice = await this.choose('Choose which ' + review.table + ' to keep',
      'Dropbox has the same file this device tried to save. These results depend on whether its copy came from this device or from a separate change.',
      [{value:'cancel',label:'Cancel'},{value:'shared',label:'This device’s upload'},{value:'independent',label:'Separate change'}],body);
    return choice === 'shared' || choice === 'independent' ? choice : null;
  }

  async identities(review:IdentityReview, source: 'Dropbox' | 'Selected file' = 'Dropbox', signal?:AbortSignal):Promise<IdentityAssignment[]|null> {
    const {manual,automatic} = separateMappings(review);
    const form = this.doc.createElement('div');
    type Entry = {side:typeof sides[number];index:number;row:WatchedRow;group:string;fields?:HTMLInputElement[]};
    const byEpisode = new Map<string,Entry[]>();
    for (const side of sides) review.inputs[side].forEach((row,index) => {
      if (!manual.has(row)) return;
      const group = row.show_id + '/' + (row.episode_id ?? (row.season + '.' + row.episode));
      const entries = byEpisode.get(group), entry = {side,index,row,group};
      if (entries) entries.push(entry); else byEpisode.set(group,[entry]);
    });
    const entries = [...byEpisode.values()].flat();
    appendReviewRows(form,entries,entry=>{
      const {row,side} = entry;
      const group = this.doc.createElement('fieldset'), legend = this.doc.createElement('legend');
      legend.textContent = ({before:'Base',mine:'This device',theirs:source})[side] + ' · ' + (row.show || row.show_id) +
        ' · S' + row.season + ' E' + row.episode + ' · ' + row.times_watched + ' plays · ID ' + (row.episode_id ?? 'unknown');
      group.append(legend);
      const field = (name:string,value:string) => {
        const label = this.doc.createElement('label'), input = this.doc.createElement('input');
        input.value = value; label.append(name,input); group.append(label); return input;
      };
      entry.fields = [field('Episode group',entry.group),field('Destination season',String(row.season)),
        field('Destination episode',String(row.episode)),field('Destination ID',String(row.episode_id ?? ''))];
      return group;
    },'Show more rows');
    let message = review.reason + ' Give rows for the same episode the same group and destination.';
    for (;;) {
      if (await this.choose('Match episode identities',message,[{value:'cancel',label:'Cancel'},{value:'review',label:'Review mapping'}],form,signal) !== 'review') return null;
      const groups = new Map<string,IdentityAssignment>();
      let invalid:Entry|undefined;
      for (const f of entries) {
        const row = f.row, fields = f.fields, name = fields ? fields[0].value.trim() : f.group;
        if (!name || fields && (!/^\d+$/.test(fields[1].value) || !/^\d+$/.test(fields[2].value) || !/^\d*$/.test(fields[3].value))) { invalid = f; break; }
        const place = {show_id:row.show_id,season:fields ? Number(fields[1].value) : row.season,
          episode:fields ? Number(fields[2].value) : row.episode,episode_id:fields ? fields[3].value ? Number(fields[3].value) : null : row.episode_id};
        const current = groups.get(name) ?? place;
        if (current[f.side as keyof typeof current] !== undefined || current.show_id !== place.show_id ||
            current.season !== place.season || current.episode !== place.episode || current.episode_id !== place.episode_id) { invalid=f; break; }
        groups.set(name,{...current,[f.side]:f.index});
      }
      if (invalid) {
        const row = invalid.row;
        message = (row.show || 'Show '+row.show_id) + ' · S' + row.season + ' E' + row.episode +
          ' needs one destination and at most one row from each source.';
        continue;
      }
      const assignments = [...groups.values(), ...automatic];
      const mapped = applyAssignments(review.inputs,assignments);
      if (typeof mapped === 'string') { message = mapped; continue; }
      const preview = this.doc.createElement('div');
      appendReviewRows(preview,mapped.slice(0,groups.size),g=>{
        const line = this.doc.createElement('p');
        line.textContent = 'Show ' + g.place.show_id + ' · S' + g.place.season + ' E' + g.place.episode +
          ' · Before ' + (g.before?.times_watched ?? 0) + ', here ' + (g.mine?.times_watched ?? 0) + ', ' + source + ' ' + (g.theirs?.times_watched ?? 0);
        return line;
      },'Show more matched episodes');
      const summary = groups.size + (groups.size === 1 ? ' reviewed episode.' : ' reviewed episodes.') +
        (automatic.length ? ' ' + automatic.length + ' other episodes matched automatically.' : '');
      const result = await this.choose('Confirm episode mapping',summary,[
        {value:'cancel',label:'Cancel'},{value:'edit',label:'Edit mapping'},{value:'accept',label:'Use mapping'}],preview,signal);
      if (result === 'accept') return assignments;
      if (result === 'cancel') return null;
    }
  }
}
