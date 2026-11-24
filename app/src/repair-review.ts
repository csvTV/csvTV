import type { RepairPreview } from './episode-repair.ts';
import type { WatchedRow } from './model.ts';
import { openPersonalDialog } from './personal-dialog.ts';
import type { ScreenContext } from './screen-context.ts';

function position(row: Pick<WatchedRow, 'season' | 'episode'>) {
  return (row.season ? 'Season ' + row.season : 'Specials') + ', episode ' + row.episode;
}

function plays(count: number | bigint) {
  return count.toLocaleString() + (count === 1 || count === 1n ? ' play' : ' plays');
}

export function createRepairNotice(host: HTMLElement, ctx: ScreenContext, refresh: () => Promise<void>) {
  const doc = host.ownerDocument;
  const notice = doc.createElement('div');
  notice.className = 'repair-notice';
  notice.hidden = true;
  const summary = doc.createElement('span');
  summary.setAttribute('role', 'status');
  const review = doc.createElement('button');
  review.type = 'button';
  review.textContent = 'Review';
  review.setAttribute('aria-haspopup', 'dialog');
  review.setAttribute('aria-label', 'Review renumbered episodes');
  review.dataset.focus = 'episode-repair';
  review.dataset.seasonFocus = 'episode-repair';
  notice.append(summary, review);
  let preview: RepairPreview;
  let panel: ReturnType<typeof openPersonalDialog> | undefined;
  let updating = false;
  let completed = '';

  function draw(value: RepairPreview) {
    preview = value;
    const count = value.moves.length;
    if (count) completed = '';
    notice.hidden = !count && !completed;
    review.hidden = !count;
    const message = count ? 'TMDB renumbered ' + count + (count === 1 ? ' watched episode.' : ' watched episodes.') : completed;
    if (summary.textContent !== message) summary.textContent = message;
    const update = panel?.body.querySelector<HTMLButtonElement>('[data-repair-update]');
    if (update) update.disabled = ctx.service.store.role !== 'writer';
  }

  function describe(reviewed: RepairPreview, message = '') {
    const sheet = panel!;
    const list = doc.createElement('ul');
    list.className = 'repair-moves';
    for (const { from, to, occupied, combinedCount } of reviewed.moves) {
      const item = doc.createElement('li');
      const title = doc.createElement('strong');
      title.textContent = to.title || from.title || 'Episode ' + to.episode;
      const move = doc.createElement('p');
      move.textContent = 'TMDB numbering · ' + position(from) + ' to ' + position(to) + ' · ' + plays(from.times_watched);
      item.append(title, move);
      if (from.title && to.title && from.title !== to.title) {
        const saved = doc.createElement('p');
        saved.textContent = 'Saved as “' + from.title + '”.';
        item.append(saved);
      }
      if (occupied) {
        const combined = doc.createElement('p');
        combined.textContent = 'The destination also holds “' + (occupied.title || 'Episode ' + occupied.episode) +
          '” with ' + plays(occupied.times_watched) + '. Updating combines them into ' + plays(combinedCount) + '.';
        item.append(combined);
      }
      list.append(item);
    }
    const feedback = doc.createElement('p');
    feedback.className = 'feedback';
    feedback.setAttribute('role', 'status');
    const actions = doc.createElement('div');
    actions.className = 'actions';
    const cancel = doc.createElement('button');
    cancel.type = 'button';
    cancel.textContent = reviewed.moves.length ? 'Cancel' : 'Close';
    cancel.onclick = sheet.close;
    actions.append(cancel);
    if (reviewed.moves.length) {
      const update = doc.createElement('button');
      update.type = 'button';
      update.className = 'primary';
      update.textContent = 'Update';
      update.dataset.repairUpdate = '';
      update.disabled = ctx.service.store.role !== 'writer';
      update.onclick = () => {
        if (updating || !sheet.dialog.open || ctx.service.store.role !== 'writer') return;
        updating = true;
        sheet.setSaving(true);
        void ctx.run(async () => {
          try {
            if (await ctx.service.updateRepair(reviewed)) {
              if (!sheet.dialog.open) return;
              ctx.clearUndo();
              await refresh();
              if (!sheet.dialog.open) return;
              sheet.close();
              completed = 'Updated ' + reviewed.moves.length + (reviewed.moves.length === 1 ? ' episode.' : ' episodes.');
              draw(preview);
            } else if (sheet.dialog.open) {
              const latest = await ctx.service.repairPreview(reviewed.showId);
              if (!sheet.dialog.open) return;
              draw(latest);
              sheet.setSaving(false);
              describe(latest, latest.moves.length
                ? 'The proposed moves have changed. Review the revised list before updating.'
                : 'There are no episode moves left to update.');
            }
          } catch (error) {
            sheet.setSaving(false);
            if (sheet.dialog.open) feedback.textContent = error instanceof RangeError ? error.message
              : error instanceof DOMException && error.name === 'QuotaExceededError' ? 'This device is out of space. The episode changes were not saved.'
              : 'Could not update the episodes. Review the current record and try again.';
          } finally {
            updating = false;
            sheet.setSaving(false);
          }
        });
      };
      actions.append(update);
    }
    sheet.body.replaceChildren(list, feedback, actions);
    feedback.textContent = message;
  }

  review.onclick = () => {
    if (!preview?.moves.length || panel?.dialog.open) return;
    panel = openPersonalDialog(host, 'Review renumbered episodes',
      () => review.isConnected && !review.hidden ? review : host.querySelector<HTMLElement>('h1[tabindex],h2[tabindex]'));
    describe(preview);
  };
  return { notice, draw, dispose: () => panel?.close() };
}
