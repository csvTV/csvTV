import { recordedShowTitle } from './shows.ts';
import { calendarDate } from './calendar-date.ts';
import { appendImdbRating } from './critic-marks.ts';
import type { WatchedRow } from './model.ts';
import { MAX_INTEGER } from './model.ts';
import { openWatchCountEditor } from './watch-count-editor.ts';
import { hasAired, localCalendarDate, seasonProgress } from './progress.ts';
import { broadcastPosition, broadcastRangeAt, broadcastSeasons } from './broadcast-seasons.ts';
import type { Screen, ScreenContext } from './screen-context.ts';
import type { TmdbEpisode } from './tmdb-data.ts';
import { cacheOnlyView, type MetadataView } from './tmdb-service.ts';
import { renderTmdbState } from './tmdb-settings.ts';
import { createRepairNotice } from './repair-review.ts';
import { watchEditRunner } from './notices.ts';

export function mountSeasonScreen(root: HTMLElement, ctx: ScreenContext, id: number, number: number): Screen {
  const doc = root.ownerDocument;
  const service = ctx.service;
  const showResource = { kind: 'show' as const, id };
  let resource = { kind: 'season' as const, id, season: number };
  const container = doc.createElement('section');
  container.className = 'season-screen';
  root.replaceChildren(container);
  const repair = createRepairNotice(root, ctx, refresh);
  let disposed = false, busy = false, opening = true;
  let loadVersion = 0, renderVersion = 0;
  const lifetime = new AbortController();
  let activeRead:AbortController|undefined;
  let state: MetadataView<'season'>['status'] = 'ready';
  let source = '';
  let imdbSource = '';
  let closeSheet: (() => void) | undefined;

  function element<K extends keyof HTMLElementTagNameMap>(tag: K, text: string, className?: string) {
    const node = doc.createElement(tag);
    node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function button(label: string, focus: string, click: (trigger: HTMLButtonElement) => void) {
    const node = element('button', label);
    node.type = 'button';
    node.dataset.seasonFocus = focus;
    node.onclick = () => { if (!busy && !disposed) click(node); };
    return node;
  }
  const edits = watchEditRunner(ctx);
  async function act(scope: string, work: () => Promise<void>) {
    if (busy || disposed) return;
    await edits.run(scope,async () => {
      if (busy || disposed) return;
      busy = true;
      try { await work(); }
      finally {
        busy = false;
        if (!disposed) await ctx.run(refresh);
      }
    });
  }
  function focusTarget(key?: string) {
    const fields = Array.from(container.querySelectorAll<HTMLElement>('[data-season-focus]:not(:disabled)'));
    return fields.find(node => node.dataset.seasonFocus === key) ??
      fields.find(node => node.dataset.seasonFocus === key?.replace(/-(add|subtract)$/, '-count')) ??
      container.querySelector<HTMLElement>('.season-heading h1,.season-heading h2');
  }
  function report(host: HTMLElement, status: MetadataView<'season'>['status'] | 'loading') {
    renderTmdbState(host, status, {
      onSettings: () => ctx.go({ page: 'settings' }), onRetry: () => void ctx.run(load),
      canAccessKeys: ctx.canAccessKeys,
    });
  }
  async function load() {
    const version = ++loadVersion;
    activeRead?.abort();
    let firstPaint: Promise<void> | undefined;
    opening = true;
    if (!container.querySelector('.season-heading')) report(container, 'loading');
    try {
      const key = await service.keyStatus();
      if (version !== loadVersion || disposed) return;
      source = [key.generation, key.status, service.store.role, service.environment.online()].join('/');
      // A deep link may be the first visit to this show. A confirmed missing
      // parent or unlisted season must never resurrect an older cached season.
      const parent = await service.read(showResource) ?? await service.view(showResource);
      if (version !== loadVersion || disposed) return;
      const range = broadcastSeasons(parent.value)?.find(r => r.number === number);
      resource = { kind: 'season', id, season: range?.sourceSeason ?? number };
      const cached = await service.read(resource);
      if (version !== loadVersion || disposed) return;
      if (cached?.value && parent.value?.seasons.some(s => s.season === resource.season)) {
        opening = false;
        state = 'ready';
        firstPaint = ctx.run(refresh);
      }
      const result = await service.view(resource);
      if (version === loadVersion) state = result.status;
      if (cacheOnlyView(result)) await firstPaint;
    } finally {
      if (version === loadVersion && !disposed) {
        opening = false;
        await refresh();
      }
    }
  }

  async function refresh() {
    if (disposed || opening) return;
    const version = ++renderVersion;
    activeRead?.abort();
    activeRead = new AbortController();
    const {signal} = activeRead;
    const data = await Promise.all([
      service.store.showScreenState(id,resource.season,service.environment.now(),signal), service.keyStatus(),
    ]).catch(error=>{ if (!signal.aborted) throw error; });
    if (!data || disposed || opening || version !== renderVersion) return;
    const [{record:snapshot,header:parent,season:entry,preview},key] = data;
    const currentSource = [key.generation, key.status, service.store.role, service.environment.online()].join('/');
    if (currentSource !== source && key.status === 'ready' && service.store.role === 'writer' && service.environment.online()) {
      await load();
      return;
    }
    source = currentSource;
    const ranges = broadcastSeasons(parent?.value);
    const range = ranges?.find(r => r.number === number);
    if ((range?.sourceSeason ?? number) !== resource.season) { await load(); return; }
    const nativeSeason = resource.season;
    function bulk(action: 'mark' | 'again') {
      return act('watches',() => ctx.watch.bulk(id, { season: nativeSeason, broadcast:range }, action));
    }
    const belongs = (episode:number) => !ranges || broadcastPosition(ranges, nativeSeason, episode).season === number;
    const saved = snapshot.tables.watched.filter(row => row.season === nativeSeason && belongs(row.episode));
    const retired = range && range.sourceSeason !== number && ranges
      ? snapshot.tables.watched.filter(row => row.season === number && !broadcastRangeAt(ranges,row.season,row.episode)) : [];
    const descriptor = parent?.value?.seasons.find(season => season.season === nativeSeason);
    const missing = (parent !== null && !descriptor) || entry?.value === null;
    const season = missing ? null : entry?.value;
    const episodes = season?.episodes.filter(e => belongs(e.episode)) ?? [];
    const scopeName = number === 0 ? 'Specials' : range?.name ?? 'Season ' + number;
    const title = number === 0 || range ? scopeName : season?.name || descriptor?.name || scopeName;
    const show = parent?.value?.show || recordedShowTitle(snapshot.tables);
    const today = localCalendarDate(new Date(service.environment.now()));
    const reused = new Set(season?.reusedPositions);
    const progress = seasonProgress({season: number, episodeCount: episodes.length, episodes, reusedPositions:season?.reusedPositions}, null, saved, today);
    const writable = service.store.role === 'writer';
    const canMark = Boolean(writable && season && show && (key.status === 'ready' || key.cachedMarkAccount));
    const partial = progress.watchedAired < progress.aired;

    const focus = container.contains(doc.activeElement) ? (doc.activeElement as HTMLElement).dataset.seasonFocus : undefined;
    const fragment = doc.createDocumentFragment();
    const header = element('header', '', 'season-heading');
    const heading = element('h1', title);
    heading.tabIndex = -1;
    heading.dataset.seasonFocus = 'heading';
    header.append(heading);
    const actions = element('div', '', 'season-actions');
    if (canMark && progress.aired > 0) {
      const mark = button(partial ? 'Mark watched' : 'Watched again', 'bulk', () => void bulk(partial ? 'mark' : 'again'));
      mark.className = 'primary season-mark';
      actions.append(mark);
    }
    if (writable && saved.length) {
      const remove = button('Remove watches', 'remove', () => void act('watches',() => ctx.watch.remove(id, number, range)));
      actions.append(remove);
    }
    if (actions.childElementCount) header.append(actions);
    fragment.append(header);

    let summary = saved.length + (saved.length === 1 ? ' episode' : ' episodes');
    if (progress.aired > 0) {
      summary = partial ? progress.watchedAired + ' watched · ' + (progress.aired - progress.watchedAired) + ' left'
        : progress.watchedAired + ' of ' + progress.aired + (progress.aired === 1 ? ' episode' : ' episodes');
      if (progress.completed) summary += ' · completed ' + (progress.completed === 1 ? 'once' : progress.completed + ' times');
    }
    if (season || saved.length) fragment.append(element('p', summary, 'season-summary'));
    if (progress.rewatch) {
      const { viewing, watched, total } = progress.rewatch;
      const names = ['', 'First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth', 'Tenth'];
      const label = names[viewing] ? names[viewing] + ' time through' : 'Viewing ' + viewing;
      const card = element('div', '', 'season-rewatch');
      const caption = element('div', '', 'season-rewatch-label');
      caption.append(element('strong', label), element('span', watched + ' of ' + total));
      const bar = element('progress', '');
      bar.value = watched; bar.max = total; bar.setAttribute('aria-label', label);
      card.append(caption, bar);
      fragment.append(card);
    }
    repair.draw(preview);
    fragment.append(repair.notice);

    let status = missing ? 'not-found' as const : !season ? state : 'ready' as const;
    if (!missing && key.status !== 'ready') status = key.status;
    else if (!season && !missing && !writable) status = 'read-only';
    else if (!season && !missing && !service.environment.online()) status = 'offline';
    else if (!missing && !season && (status === 'ready' || status === 'cached')) status = 'unavailable';
    if (status !== 'ready' && status !== 'cached') {
      const notice = element('div', '', 'season-status');
      report(notice, status);
      fragment.append(notice);
    }
    const counts = new Map(saved.map(row => [row.episode, row]));
    const listed = new Map(episodes.map(episode => [episode.episode, episode]));
    const absent = new Set(preview.missing.filter(row => row.season === nativeSeason).map(row => row.episode));
    const moving = new Map(preview.moves.filter(move => move.from.season === nativeSeason).map(move => [move.from.episode,
      broadcastPosition(ranges,move.to.season,move.to.episode)]));
    const positions = Array.from(new Set([...counts.keys(), ...listed.keys()])).sort((a, b) => a - b);
    if (positions.length || season) {
      fragment.append(element('h2', 'Episodes', 'season-list-title'));
      if (!positions.length) fragment.append(element('p', 'No episodes listed.', 'season-summary'));
    }
    const list = element('ol', '', 'season-episodes');
    list.setAttribute('aria-label', 'Episodes');
    const ratingTargets = new Map<number, HTMLElement>();
    function episodeRow(position: number, episode: TmdbEpisode | undefined, row: WatchedRow | undefined,
        previous?: 'orphan' | 'retired' | 'occupied') {
      const count = row?.times_watched ?? 0;
      const ordinal = range?.unassigned || previous === 'retired' ? position : broadcastPosition(ranges,nativeSeason,position).episode;
      const name = episode?.title || row?.title || 'Episode ' + ordinal;
      const target = { show_id: id, show: show ?? '', season: nativeSeason, episode: position,
        episode_id: episode?.episode_id ?? row?.episode_id ?? null, title: name };
      const addition = Boolean(canMark && episode && previous !== 'occupied');
      const focusId = (previous === 'retired' ? 'retired-' : previous === 'orphan' ? 'record-' : 'episode-') + position;
      const node = element('div', '', 'season-episode');
      const numberCell = element('span', String(ordinal), 'episode-number');
      const body = element('span', '', 'episode-copy');
      body.append(element('span', name, 'episode-name'));
      let detail = '';
      if (!episode && row && previous !== 'retired') {
        const destination = moving.get(position);
        if (destination) detail = 'Renumbered to ' + (destination.season ? 'season ' + destination.season : 'Specials') +
          ', episode ' + destination.episode;
        else if (row.episode_id === null && reused.has(position)) detail = 'Saved watch · Episode identity unknown';
        else if (absent.has(position) || (row.episode_id === null && (missing || season))) detail = 'Not on TMDB';
      }
      if (episode && !hasAired(episode, today)) {
        detail = episode.airDate ? calendarDate(episode.airDate) : 'No date';
      }
      if (detail) body.append(element('small', detail));
      const badge = element('span', count + '×', 'episode-count');
      if (!count) badge.classList.add('empty');
      if (episode && progress.completed && count > progress.completed) badge.classList.add('rewatched');
      node.append(numberCell, body);
      // A displaced personal row and its replacement can share a position. Only
      // the listed episode can use that position's outside rating in this case.
      // The rating service indexes native episode positions. A custom split
      // changes the label only. It supplies no evidence about IMDb's own order.
      if (episode || (!previous && !moving.has(position))) ratingTargets.set(position, body);
      const episodeLabel = 'Episode ' + ordinal + ', ' + name;
      const retryScope = 'watches/' + focusId;
      const plus = button('', focusId + '-add', () => void act(retryScope,() => ctx.watch.episode(target, 'again')));
      const minus = button('', focusId + '-subtract', () => void act(retryScope,() => ctx.watch.episode(row!, 'remove-one')));
      plus.className = 'episode-step watch-step-plus';
      minus.className = 'episode-step';
      plus.disabled = !addition || count === MAX_INTEGER;
      minus.disabled = !writable || !count;
      for (const [step,label] of [[plus,'Add one watch to '],[minus,'Remove one watch from ']] as const) {
        step.setAttribute('aria-label', label + episodeLabel);
        step.title = label + episodeLabel;
        const icon = element('span','','season-step-icon');
        icon.setAttribute('aria-hidden','true');
        step.append(icon);
      }
      const countButton = button('', focusId + '-count', trigger => {
        closeSheet?.();
        closeSheet = openWatchCountEditor(root, episodeLabel, count, async (desiredCount, current) => {
          edits.retire(retryScope);
          await ctx.watch.episode(desiredCount < count ? row! : target, {expectedCount:count, desiredCount}, current);
          await ctx.run(refresh);
        }, () => focusTarget(trigger.dataset.seasonFocus), 'episode', addition ? MAX_INTEGER : count);
      });
      countButton.className = 'episode-count-button';
      countButton.disabled = !writable || (!addition && !count);
      countButton.setAttribute('aria-label', 'Change watches for ' + episodeLabel + ', ' + count + ' plays');
      countButton.setAttribute('aria-haspopup','dialog');
      countButton.append(badge);
      const controls = element('span','','episode-controls');
      controls.append(plus,countButton,minus);
      const item = element('li', '', 'episode-row');
      item.dataset.episode = focusId;
      item.append(node,controls);
      return item;
    }
    for (const position of positions) {
      const row = counts.get(position), episode = listed.get(position);
      if (episode && row && (row.episode_id === null ? reused.has(position) : row.episode_id !== episode.episode_id)) {
        list.append(episodeRow(position, episode, undefined, 'occupied'));
        list.append(episodeRow(position, undefined, row, 'orphan'));
      } else {
        list.append(episodeRow(position, episode, row));
      }
    }
    if (positions.length) fragment.append(list);
    if (retired.length) {
      fragment.append(element('h2', 'Previously saved episodes', 'season-list-title'));
      const previous = element('ul', '', 'season-episodes');
      for (const row of retired) previous.append(episodeRow(row.episode,undefined,row,'retired'));
      fragment.append(previous);
    }
    container.replaceChildren(fragment);
    if (focus) focusTarget(focus)?.focus({ preventScroll: true });
    if (!writable) closeSheet?.();
    const ratings = ctx.imdb;
    if (ratings) {
      const current = () => !disposed && !opening && version === renderVersion;
      void ratings.readSeason(id, nativeSeason,lifetime.signal).then(scores => {
        if (!current()) return;
        for (const [position, body] of ratingTargets) {
          if (!scores.has(position)) continue;
          appendImdbRating(body, scores.get(position));
        }
      }, () => {});
      void ctx.run(async () => {
        const state = await ratings.sourceStatus().catch(() => undefined);
        if (!current() || !state) return;
        const next = [state.generation, state.refused, state.retryAt, nativeSeason, currentSource].join('/');
        if (imdbSource === next) return;
        imdbSource = next;
        if (state.source !== 'none') await ratings.refreshSeason(id, nativeSeason);
      });
    }
  }

  return { ready: load(), refresh, dispose() {
    disposed = true;
    activeRead?.abort();
    lifetime.abort();
    repair.dispose();
    loadVersion++;
    closeSheet?.();
    container.remove();
  } };
}
