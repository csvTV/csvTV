import { openPersonalDialog } from './personal-dialog.ts';
import type { ScreenContext } from './screen-context.ts';
import { decodeSeasonBreaks, encodeSeasonBreaks, manualSeasonRanges, nativeSeasonOrder, seasonOrderKey, type SeasonBreaks } from './season-order.ts';
import { StaleSnapshotError } from './storage.ts';
import type { TmdbShow } from './tmdb-data.ts';

export function openSeasonOrderEditor(host: HTMLElement,ctx: ScreenContext,show: TmdbShow,returnFocus: () => HTMLElement | null) {
  const doc = host.ownerDocument, store = ctx.service.store;
  const panel = openPersonalDialog(host,'Season order',returnFocus);
  const form = doc.createElement('form');
  form.className = 'season-order-form';
  form.innerHTML = '<label>Order<select name="order"><option value="auto">Automatic</option>' +
    '<option value="native">TMDB seasons</option><option value="custom">Custom season breaks</option></select></label>' +
    '<div class="season-order-breaks"><p>Enter the last episode before each break, separated by commas.</p></div>' +
    '<p class="feedback" role="status"></p><div class="actions"><button type="button">Cancel</button>' +
    '<button class="primary" type="submit" disabled>Save</button></div>';
  panel.body.append(form);
  const mode = form.querySelector('select')!, breaks = form.querySelector<HTMLElement>('.season-order-breaks')!;
  const feedback = form.querySelector<HTMLElement>('.feedback')!, save = form.querySelector<HTMLButtonElement>('[type=submit]')!;
  form.querySelector<HTMLButtonElement>('[type=button]')!.onclick = panel.close;
  const fields = show.seasons.filter(s => s.season > 0 && s.episodeCount > 1).sort((a,b) => a.season-b.season).map(season => {
    const label = doc.createElement('label');
    label.textContent = 'TMDB season '+season.season+' · '+season.episodeCount+' episodes';
    const input = doc.createElement('input');
    input.type = 'text'; input.autocomplete = 'off'; input.spellcheck = false;
    input.name = 'season-'+season.season;
    label.append(input); breaks.append(label);
    return {season,input};
  });
  mode.querySelector<HTMLOptionElement>('[value=custom]')!.disabled = !fields.length;
  mode.onchange = () => { breaks.hidden = mode.value !== 'custom'; feedback.textContent = ''; };
  breaks.hidden = true;
  let original: Awaited<ReturnType<typeof store.seasonOrderState>> | undefined;
  void ctx.run(async () => {
    const state = await store.seasonOrderState(show.show_id);
    if (!panel.dialog.open) return;
    original = state;
    mode.value = state.value ? state.value === nativeSeasonOrder ? 'native' : 'custom' : 'auto';
    breaks.hidden = mode.value !== 'custom';
    const saved = state.value && decodeSeasonBreaks(state.value);
    if (saved) for (const {input,season} of fields) input.value = saved.find(row => row.season === season.season)?.after.join(', ') ?? '';
    if (saved && manualSeasonRanges({...show,manualSeasonOrder:state.value}) === undefined)
      feedback.textContent = 'TMDB changed its seasons. Review your breaks before saving.';
    save.disabled = store.role !== 'writer';
  });
  form.onsubmit = event => {
    event.preventDefault();
    if (!original || save.disabled) return;
    let value: string | undefined;
    if (mode.value === 'native') value = nativeSeasonOrder;
    if (mode.value === 'custom') {
      const groups: SeasonBreaks[] = [];
      for (const {input,season} of fields) {
        if (!input.value.trim()) continue;
        const numbers = input.value.split(',').map(n => n.trim()), after = numbers.map(Number);
        if (numbers.some((n,i) => !/^[1-9][0-9]*$/.test(n) || after[i] >= season.episodeCount || (i > 0 && after[i] <= after[i-1]))) {
          feedback.textContent = 'For TMDB season '+season.season+', use increasing episode numbers from 1 to '+(season.episodeCount-1)+'.';
          input.focus(); return;
        }
        groups.push({season:season.season,episodeCount:season.episodeCount,after});
      }
      value = encodeSeasonBreaks(groups);
      if (!decodeSeasonBreaks(value)) { feedback.textContent = 'Enter a season break to save.'; return; }
    }
    const expected = original;
    void ctx.run(async () => {
      panel.setSaving(true);
      try {
        while (panel.dialog.open) {
          const state = await store.seasonOrderState(show.show_id);
          if (state.accountId !== expected.accountId || state.value !== expected.value) {
            feedback.textContent = 'The saved order or Dropbox account changed. Reopen Season order to review it.';
            return;
          }
          if (state.value !== value) {
            const latest = await ctx.service.read({kind:'show',id:show.show_id});
            if (value && value !== nativeSeasonOrder && (!latest?.value ||
                !manualSeasonRanges({...latest.value,manualSeasonOrder:value}))) {
              feedback.textContent = 'TMDB changed its seasons. Reopen Season order to review them.'; return;
            }
            const key = seasonOrderKey(show.show_id);
            try {
              await store.commit(state.revision,value ? {put:{settings:[{setting:key,value}]}} : {remove:{settings:[key]}},
                {current:() => panel.dialog.open && store.role === 'writer'});
            } catch (error) { if (error instanceof StaleSnapshotError) continue; throw error; }
          }
          panel.close();
        }
      } finally { panel.setSaving(false); }
    });
  };
  return panel.close;
}
