import type { Screen, ScreenContext } from './screen-context.ts';
import { readDisplayRatings, type ShowRatings } from './critic-marks.ts';
import { malScoresForShows } from './record-overview.ts';
import { calculateStatistics, type StatisticsChart, type StatisticsEpisodeSummaries, type StatisticsInput, type StatisticsResult, type StatisticsScope } from './statistics.ts';
import { formatHours, renderChart, statIcon } from './statistics-charts.ts';
import { createStatisticsCache, createStatisticsHistory, readStatisticsRecord } from './statistics-data.ts';

const totalPaths = {
  shows: 'M4 7h16v11H4zM8 21h8M9 3l3 4 3-4',
  seasons: 'M3 8l9-5 9 5-9 5zM3 13l9 5 9-5',
  episodes: 'M4 12l5 5L20 6',
  plays: 'M7 4l13 8-13 8z',
  hours: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2',
};

function sameRows(a: StatisticsChart, b: StatisticsChart) {
  if (a === b) return true;
  const previous = a.tableRows ?? a.rows, next = b.tableRows ?? b.rows;
  return a.decimals === b.decimals && previous.length === next.length && previous.every((row, i) => row.label === next[i].label &&
    row.value === next[i].value && row.rating === next[i].rating);
}

type ChartCards = Map<string, {model: StatisticsChart} & ReturnType<typeof renderChart>>;
// Only the validated history entry keeps this view alive after navigation. Cards
// are detached on departure and hold chart values and table controls only.
const completedViews = new WeakMap<StatisticsInput,{
  cards: ChartCards; reports: Map<StatisticsScope, StatisticsResult>; summaries: StatisticsEpisodeSummaries;
}>();

export function mountStatisticsScreen(root: HTMLElement, ctx: ScreenContext, history?: ReturnType<typeof createStatisticsHistory>): Screen {
  if (!root.childElementCount || !history?.read(ctx.service.environment.now()) || root.querySelector('.statistics-screen,dialog[open],input[type=password]')) {
    return mountReport(root,ctx,history);
  }
  // Keep the outgoing page visible through the usual scope/revision check.
  // Its handlers have been disposed and its controls must not accept input.
  const outgoing = Array.from(root.children).filter((item):item is HTMLElement => 'inert' in item && !item.inert);
  const buffer = root.ownerDocument.createElement('div');
  const report = mountReport(buffer,ctx,history);
  let waiting = true;
  for (const item of outgoing) item.inert = true;
  const timeout = setTimeout(() => finish(true),80);
  function finish(attach:boolean) {
    if (!waiting) return;
    waiting = false;
    clearTimeout(timeout);
    if (attach) root.replaceChildren(...buffer.childNodes);
    for (const item of outgoing) item.inert = false;
    outgoing.length = 0;
  }
  return {ready:report.ready.finally(()=>finish(true)),refresh:report.refresh,
    dispose() { finish(false); report.dispose(); } };
}

function mountReport(root: HTMLElement, ctx: ScreenContext, history?: ReturnType<typeof createStatisticsHistory>): Screen {
  const doc = root.ownerDocument;
  const visit = history?.beginVisit();
  root.innerHTML = `<section class="statistics-screen"><header><h1 tabindex="-1">Statistics</h1>
    <div class="segments stats-scope" role="radiogroup" aria-label="Shows counted"></div></header>
    <div class="stats-report"><div class="stats-summary"><dl class="stats-totals" aria-label="Watch totals"></dl></div><p class="stats-omissions"></p>
    <p class="stats-empty" role="status">Loading…</p><div class="stats-charts">
      <div class="stats-rankings"><div class="stats-rewatch-stack"></div></div>
      <div class="stats-distributions"></div><div class="stats-comparisons"></div></div></div></section>`;
  const heading = root.querySelector('h1')!;
  const figures = root.querySelector('dl')!;
  const summary = root.querySelector<HTMLElement>('.stats-summary')!;
  const grid = root.querySelector<HTMLElement>('.stats-charts')!;
  const rankings = grid.querySelector<HTMLElement>('.stats-rankings')!;
  const rewatchStack = rankings.querySelector<HTMLElement>('.stats-rewatch-stack')!;
  const distributions = grid.querySelector<HTMLElement>('.stats-distributions')!;
  const comparisons = grid.querySelector<HTMLElement>('.stats-comparisons')!;
  const notices = root.querySelector<HTMLElement>('.stats-omissions')!;
  const empty = root.querySelector<HTMLElement>('.stats-empty')!;
  const retry = doc.createElement('button');
  retry.type = 'button'; retry.textContent = 'Try again'; retry.hidden = true;
  empty.after(retry);
  retry.onclick = () => {
    const focused = doc.activeElement === retry;
    void ctx.run(async () => {
      await refresh(false);
      if (focused && retry.hidden && doc.activeElement === doc.body) heading.focus({preventScroll:true});
    });
  };
  const choices = root.querySelector<HTMLElement>('.stats-scope')!;
  const counts = new Map<string, HTMLElement>();
  for (const [name, path] of Object.entries(totalPaths)) {
    const tile = doc.createElement('div');
    tile.dataset.stat = name;
    const term = doc.createElement('dt');
    term.append(statIcon(doc, path), name[0].toUpperCase() + name.slice(1));
    const number = doc.createElement('dd');
    number.textContent = '–';
    tile.append(term, number);
    figures.append(tile);
    counts.set(name, number);
  }
  const metadataCache = createStatisticsCache();
  // Each projection replaces its episode arrays when watches or runtimes change.
  let episodeSummaries: StatisticsEpisodeSummaries = new WeakMap();
  let reports = new Map<StatisticsScope, StatisticsResult>();
  let cards: ChartCards = new Map();
  let opening: Promise<void> | undefined;
  type ScopeState = Awaited<ReturnType<ScreenContext['service']['store']['statisticsState']>>;
  let latestScopeRead: Promise<ScopeState | undefined>;
  let inFlight: Promise<void> | undefined;
  let pending = false;
  let disposed = false;
  let scope: StatisticsScope = 'all';
  let lastInput: StatisticsInput | undefined;
  let preferenceRead = 0;
  let recordRead = 0;
  let enrichment: Promise<unknown> | undefined;
  let previousScores: ShowRatings | undefined;
  let scoresVersion = 0;
  let displacedFocus: {chart: string; selector: string; fallback: HTMLElement} | undefined;
  let scheduledDraw: ReturnType<typeof setTimeout> | undefined;

  function flushDraw() {
    clearTimeout(scheduledDraw);
    scheduledDraw = undefined;
    if (!disposed) drawReport();
  }

  for (const [value, caption] of [['all', 'All'], ['tv', 'TV'], ['anime', 'Anime']] as const) {
    const label = doc.createElement('label');
    const radio = doc.createElement('input');
    radio.type = 'radio'; radio.name = 'statistics-scope'; radio.value = value; radio.disabled = true;
    const text = doc.createElement('span');
    text.textContent = caption;
    label.append(radio, text);
    choices.append(label);
    radio.onchange = () => {
      if (!radio.checked) return;
      ++preferenceRead;
      setScope(value);
      void ctx.run(async () => {
        try { await ctx.service.store.selectStatisticsScope(value); }
        catch (error) { await readScope(); throw error; }
      });
    };
  }

  function setScope(next: StatisticsScope) {
    const changed = next !== scope;
    if (changed) displacedFocus = undefined;
    scope = next;
    for (const radio of choices.querySelectorAll('input')) {
      radio.checked = radio.value === next;
      radio.disabled = ctx.service.store.role !== 'writer';
    }
    if (changed) drawReport();
  }
  function drawReport() {
    if (!lastInput) return;
    let report = reports.get(scope);
    if (!report) {
      report = calculateStatistics(lastInput, scope, episodeSummaries);
      reports.set(scope,report);
    }
    update(report);
  }
  function readScope(changedKeys?:ReadonlySet<string>) {
    // A scope write can finish after returning to this screen. Follow the
    // newest read so the report and the selected tab use the same revision.
    const read: Promise<ScopeState | undefined> = readStoredScope(changedKeys).then(state =>
      latestScopeRead === read ? state : latestScopeRead);
    latestScopeRead = read;
    return read;
  }
  async function readStoredScope(changedKeys?:ReadonlySet<string>) {
    if (disposed) return;
    const current = ++preferenceRead;
    try {
      const store = ctx.service.store;
      const state = await store.statisticsState(changedKeys,ctx.service.environment.now(),changedKeys ? metadataCache.begin() : undefined);
      if (disposed) return;
      if (!state.statisticsOpened && store.role === 'writer') {
        opening ??= ctx.run(() => store.openStatistics());
      }
      const {preference} = state;
      if (!disposed && current === preferenceRead) setScope(preference === 'anime' || preference === 'tv' ? preference : 'all');
      return state;
    } catch {
      if (!disposed && current === preferenceRead) setScope(scope);
    }
  }
  const scopeChanged = () => { void ctx.run(async () => { await readScope(); }); };
  ctx.service.store.addEventListener('statisticsscopechange', scopeChanged);
  function forgetScores() {
    ++scoresVersion;
    previousScores = undefined;
    if (lastInput) {
      lastInput.critics = lastInput.imdb = lastInput.mal = undefined;
      reports.clear();
      drawReport();
    }
  }
  const scoreEvents = ['imdbconfigchange','malconfigchange','providerkeyschange','ratingscredentialschange'];
  for (const event of scoreEvents) ctx.service.store.addEventListener(event,forgetScores);

  function update(report: StatisticsResult) {
    const { totals, omittedShows } = report;
    for (const key of ['shows', 'seasons', 'episodes', 'plays'] as const) counts.get(key)!.textContent = totals[key].toLocaleString();
    counts.get('hours')!.textContent = formatHours(totals.minutes);
    notices.textContent = omittedShows ? 'Charts that need title data omit ' + omittedShows.toLocaleString() +
      (omittedShows === 1 ? ' show.' : ' shows.') : '';
    empty.textContent = totals.shows ? '' : scope === 'all' ? 'Your statistics appear here when you mark an episode watched.'
      : scope === 'anime' ? 'No watched anime.' : 'No watched TV shows.';

    const active = doc.activeElement as HTMLElement | null;
    const focused = active?.closest<HTMLElement>('[data-chart]')?.dataset.chart;
    const focusSelector = active?.matches('.stats-column-scroll') ? '.stats-column-scroll' : 'button';
    const visible = new Set(report.charts.map(chart => chart.id));
    for (const [id, item] of cards) {
      if (!visible.has(id)) { item.card.remove(); cards.delete(id); }
    }
    const positions = new Map<HTMLElement, number>();
    for (const chart of report.charts) {
      const group = chart.id === 'plays-by-show' || chart.id === 'hours-by-show' ? rankings
        : chart.kind === 'meter' || chart.id === 'rewatched-shows' ? rewatchStack
        : chart.kind === 'dots' || chart.id === 'cast' ? comparisons : distributions;
      const position = positions.get(group) ?? 0;
      positions.set(group, position + 1);
      const current = cards.get(chart.id);
      if (current) {
        if (!sameRows(current.model, chart)) { current.update(chart); current.model = chart; }
        if (current.card.parentElement !== group) group.insertBefore(current.card,group.children[position] ?? null);
        continue;
      }
      const view = renderChart(doc, chart);
      group.insertBefore(view.card, group.children[position] ?? null);
      cards.set(chart.id, {model:chart, ...view});
    }
    if (focused && !active.isConnected) {
      const replacement = cards.get(focused)?.card.querySelector<HTMLElement>(focusSelector);
      const fallback = replacement ?? grid.querySelector('button') ?? heading;
      fallback.focus({ preventScroll: true });
      displacedFocus = replacement ? undefined : {chart:focused, selector:focusSelector, fallback};
    } else if (displacedFocus) {
      const control = cards.get(displacedFocus.chart)?.card.querySelector<HTMLElement>(displacedFocus.selector);
      if (control && doc.activeElement === displacedFocus.fallback) control.focus({preventScroll:true});
      if (control || doc.activeElement !== displacedFocus.fallback) displacedFocus = undefined;
    }
  }

  async function readChanges() {
    try {
      do {
        pending = false;
        const read = ++recordRead;
        if (disposed) return;
        const now = ctx.service.environment.now();
        let warm = history?.read(now);
        const scopeRead = readScope(warm?.changedMetadata?.keys);
        const generation = history?.generation;
        const comparisons: Pick<ShowRatings,'critics'|'mal'> = {};
        let record: Awaited<ReturnType<typeof readStatisticsRecord>>;
        let versions:ScopeState|undefined;
        try {
          const [state,cold] = await Promise.all([scopeRead,warm ? undefined : readStatisticsRecord(ctx.service,metadataCache)]);
          versions = state;
          if (disposed) return;
          if (warm?.changedMetadata && state && history) {
            const changed=history.applyCredits(warm,state,metadataCache);
            if (changed) {
              const view=completedViews.get(warm.input);
              if (view) completedViews.set(changed.input,{...view,reports:new Map()});
              warm=changed;
            }
          }
          if (warm && !warm.changedMetadata && state?.revision === warm.revision && (state.checksCacheVersions || ctx.service.store.role === 'writer') &&
              state.writerLease === warm.writerLease && state.metadataVersion === warm.metadataVersion &&
              history?.read(ctx.service.environment.now()) === warm) {
            if (disposed) return;
            const view = completedViews.get(warm.input);
            const scoresCurrent = state.scoresVersion === warm.scoresVersion && warm.scoresCurrent;
            if (view) {
              cards = view.cards;
              reports = scoresCurrent ? view.reports : new Map();
              episodeSummaries = view.summaries;
            }
            if (scoresCurrent) {
              previousScores = warm.scores;
              lastInput = {...warm.input,critics:warm.scores?.critics,imdb:warm.scores?.imdb,
                mal:malScoresForShows(warm.scores?.mal,warm.input.shows)};
              retry.hidden = true;
              drawReport();
              continue;
            }
            // Keep comparisons already displayed while the independent reads are repeated.
            // IMDb also depends on the identity expiry checked by completeScores.
            previousScores = state.scoresVersion === warm.scoresVersion ? warm.scores : undefined;
            comparisons.critics = previousScores?.critics;
            comparisons.mal = previousScores?.mal;
            const period={from:warm.from,until:warm.until,day:warm.day};
            record = {input:{...warm.input},loadMetadata:async()=>true,validity:()=>period,
              revision:warm.revision,imdbHeaders:undefined};
          } else record = cold ?? await readStatisticsRecord(ctx.service,metadataCache);
        }
        catch {
          if (disposed) return;
          history?.clear();
          metadataCache.clear();
          reports.clear();
          lastInput = undefined; previousScores = undefined; enrichment = undefined; displacedFocus = undefined;
          for (const counter of counts.values()) counter.textContent = '–';
          notices.textContent = '';
          const focused = grid.contains(doc.activeElement) || summary.contains(doc.activeElement);
          for (const item of cards.values()) item.card.remove();
          cards.clear();
          empty.textContent = 'Could not read your statistics on this device.';
          retry.hidden = false;
          if (focused) retry.focus({preventScroll:true});
          continue;
        }
        if (!disposed) {
          retry.hidden = true;
          displacedFocus = undefined;
          const {input} = record;
          lastInput = input;
          const rated = input.shows.filter(show => show.rating !== null);
          const source = scoresVersion;
          const shared = record.imdbHeaders;
          const displayRatings = readDisplayRatings(ctx, rated.map(show => show.id), previousScores,shared && {signal:shared.signal,read:async () => {
            const headers = await shared.ready;
            if (disposed || recordRead !== read) throw new DOMException('Statistics view closed','AbortError');
            return scoresVersion === source && history?.generation === generation ? headers : undefined;
          }});
          let first = true;
          const render = () => {
            input.mal = malScoresForShows(previousScores?.mal, input.shows);
            reports.clear();
            // Show the personal record immediately. Independent score, cast and
            // season reads often finish together and only need one more paint.
            if (first) { first = false; flushDraw(); }
            else scheduledDraw ??= setTimeout(flushDraw,16);
          };
          displayRatings.render((scores,provider) => {
            if (disposed || recordRead !== read || scoresVersion !== source) return;
            if (provider === 'critics') comparisons.critics = scores.critics;
            if (provider === 'mal') comparisons.mal = scores.mal;
            previousScores = scores;
            input.critics = scores.critics;
            input.imdb = scores.imdb;
            render();
          });
          const metadata = record.loadMetadata(enriched => {
            if (disposed || recordRead !== read) return;
            input.shows = enriched.shows;
            input.countries = enriched.countries;
            render();
          });
          // The validated record can already be on screen while an independent
          // ratings read is pending. Keep it when the user leaves at that point.
          const projection = metadata.then(complete => {
            if (!complete || disposed || recordRead !== read || generation === undefined || visit === undefined) return;
            const saved = history?.saveRecord(visit,generation,input,record.revision,record.validity(),comparisons,versions);
            if (saved) completedViews.set(saved,{cards,reports:new Map(),summaries:episodeSummaries});
            return saved;
          });
          enrichment = Promise.all([projection, displayRatings.settled]).then(([saved,result]) => {
            if (!disposed && recordRead === read && scheduledDraw !== undefined) flushDraw();
            if (saved && result.complete && recordRead === read && generation !== undefined && visit !== undefined && scoresVersion === source) {
              const current = history?.completeScores(visit,generation,saved,result.scores,result.validUntil,ctx.service.environment.now());
              if (current && !disposed) completedViews.set(saved,{cards,reports,summaries:episodeSummaries});
            }
          });
        }
      } while (pending && !disposed);
    } finally { inFlight = undefined; }
  }
  function refresh(waitForMetadata = true) {
    if (disposed) return Promise.resolve();
    if (inFlight) pending = true;
    else inFlight = readChanges();
    return waitForMetadata ? inFlight.then(async () => { await enrichment; }) : inFlight;
  }
  return { ready: refresh(false), refresh, dispose() {
    disposed = true;
    clearTimeout(scheduledDraw);
    for (const item of cards.values()) { item.closeTable(); item.card.remove(); }
    metadataCache.clear();
    for (const event of scoreEvents) ctx.service.store.removeEventListener(event,forgetScores);
    ctx.service.store.removeEventListener('statisticsscopechange', scopeChanged);
  } };
}
