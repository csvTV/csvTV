import type { StatisticsChart, StatisticsRow } from './statistics.ts';
import { searchText } from './title-search.ts';

const svgNamespace = 'http://www.w3.org/2000/svg';
let hourFractionFormat: Intl.NumberFormat | undefined;
const hourFractions: string[] = [];

export function statIcon(doc: Document, path: string) {
  const svg = doc.createElementNS(svgNamespace, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'stat-icon');
  svg.setAttribute('aria-hidden', 'true');
  const shape = doc.createElementNS(svgNamespace, 'path');
  shape.setAttribute('d', path);
  svg.append(shape);
  return svg;
}

/** Keep the whole-hour part exact even for very large valid play counts. */
export function formatHours(minutes: number | bigint): string {
  const hundredths = (BigInt(minutes) * 100n + 30n) / 60n;
  const whole = (hundredths / 100n).toLocaleString();
  const fraction = Number(hundredths % 100n);
  if (!fraction) return whole;
  hourFractionFormat ??= new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
  const suffix = hourFractions[fraction] ??= hourFractionFormat.formatToParts(fraction / 100)
    .filter(part => part.type === 'decimal' || part.type === 'fraction').map(part => part.value).join('');
  return whole + suffix;
}

const descriptions: Record<string, [subtitle: string, label: string]> = {
  rewatches: ['', 'Type'],
  'plays-by-show': ['Top 10 by plays', 'Show'],
  'hours-by-show': ['Top 10 by hours', 'Show'],
  'rewatched-shows': ['Top 5 by completions', 'Show'],
  ratings: ['Shows per rating, 0 to 10 in half steps', 'My rating'],
  decades: ['Decade of first airing', 'Decade'],
  progress: ['Share of aired episodes watched', 'Share watched'],
  genres: ['Hours', 'Genre'],
  networks: ['Hours', 'Network'],
  countries: ['Shows', 'Country'],
  cast: ['Shows watched', 'Cast member'],
};
const unitHeading = {
  plays: 'Plays', minutes: 'Hours', times: 'Times', shows: 'Shows',
  tmdb: 'TMDB average', tomatoes: 'Rotten Tomatoes', metacritic: 'Metacritic', imdb: 'IMDb', myanimelist: 'MyAnimeList',
};
const tableIcon = 'M4 5h16v14H4zM4 10h16M10 5v14';

function text<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, value: string) {
  const el = doc.createElement(tag);
  el.textContent = value;
  return el;
}

function displayValue(value: number | bigint, {unit, decimals}: StatisticsChart) {
  if (unit === 'minutes') return formatHours(value);
  if (unit === 'tomatoes') return value.toLocaleString() + '%';
  if (unit === 'imdb' || unit === 'myanimelist') return Number(value).toFixed(decimals ?? 1);
  return value.toLocaleString() + (unit === 'times' ? '×' : '');
}

function playShare(count: bigint, total: bigint) {
  if (!total) return '0%';
  const percentage = count * 100n;
  // Keep exact half points so complementary shares never both round upward.
  if ((percentage % total) * 2n === total) return (Number(percentage / total) + 0.5).toLocaleString() + '%';
  return ((percentage + total / 2n) / total).toLocaleString() + '%';
}

function tableView(doc: Document, chart: StatisticsChart) {
  const table = doc.createElement('table');
  table.className = 'stats-data';
  const caption = text(doc, 'caption', chart.title);
  caption.className = 'visually-hidden';
  table.append(caption);
  const heading = table.createTHead().insertRow();
  const labels = chart.kind === 'dots' ? ['Show', 'My rating', unitHeading[chart.unit]]
    : [descriptions[chart.id][1], unitHeading[chart.unit]];
  if (chart.kind === 'meter') labels.push('Share');
  const body = table.createTBody();
  const cellsByRow = new Map<StatisticsRow, HTMLTableRowElement>();
  const collator = new Intl.Collator(undefined, { numeric:true, sensitivity:'base' });
  let sort = -1, ascending = true, query = '';
  for (const [index,label] of labels.entries()) {
    const column = doc.createElement('th');
    column.scope = 'col';
    const button = text(doc,'button',label);
    button.type = 'button';
    button.onclick = () => {
      ascending = sort === index ? !ascending : index === 0;
      sort = index;
      draw();
    };
    column.append(button);
    heading.append(column);
  }
  function draw() {
    for (const column of heading.cells) {
      if (column.cellIndex === sort) column.setAttribute('aria-sort',ascending ? 'ascending' : 'descending');
      else column.removeAttribute('aria-sort');
    }
    const allRows = chart.tableRows ?? chart.rows;
    const rows = query ? allRows.filter(row => searchText(row.label).includes(query)) : [...allRows];
    if (sort === 0 && chart.id === 'progress') {
      if (!ascending) rows.reverse(); // Progress ranges already run from lowest to highest.
    } else if (sort >= 0) {
      rows.sort((a,b) => {
        if (sort === 0) return (ascending ? 1 : -1) * collator.compare(a.label,b.label);
        // Share uses the same denominator throughout the Rewatches table.
        const field = chart.kind === 'dots' && sort === 1 ? 'rating' : 'value';
        const av = a[field]!, bv = b[field]!;
        return (ascending ? 1 : -1) * (av < bv ? -1 : av > bv ? 1 : 0);
      });
    }
    const total = chart.kind === 'meter' ? rows.reduce((sum, row) => sum + BigInt(row.value), 0n) : null;
    // Meter percentages depend on the visible total.
    if (total !== null) cellsByRow.clear();
    const fragment = doc.createDocumentFragment();
    for (const row of rows) {
      let cells = cellsByRow.get(row);
      if (!cells) {
        cells = doc.createElement('tr');
        const name = text(doc, 'th', row.label);
        name.scope = 'row';
        cells.append(name);
        if (row.rating !== undefined) cells.insertCell().textContent = row.rating.toLocaleString();
        cells.insertCell().textContent = displayValue(row.value, chart);
        if (total !== null) cells.insertCell().textContent = playShare(BigInt(row.value), total);
        cellsByRow.set(row,cells);
      }
      fragment.append(cells);
    }
    if (rows.length === 0) {
      const message = doc.createElement('tr');
      const cell = message.insertCell();
      cell.colSpan = labels.length;
      cell.textContent = 'No matches';
      fragment.append(message);
    }
    body.replaceChildren(fragment);
  }
  draw();
  return {table, update(next:StatisticsChart) { cellsByRow.clear(); chart = next; draw(); },
    filter(value:string) { query = searchText(value.trim()); draw(); }};
}

function meterView(doc: Document, chart: StatisticsChart) {
  const first = BigInt(chart.rows[0].value), repeats = BigInt(chart.rows[1].value);
  const plays = first + repeats;
  const content = doc.createElement('div');
  content.className = 'stats-rewatch';
  const result = doc.createElement('p');
  result.append(text(doc, 'strong', playShare(repeats, plays)),
    text(doc, 'span', repeats.toLocaleString() + ' of ' + plays.toLocaleString() + ' plays'));
  const meter = doc.createElement('progress');
  meter.max = Number(plays) || 1;
  meter.value = Number(repeats);
  meter.setAttribute('aria-hidden', 'true');
  content.append(result, meter, text(doc, 'small', first.toLocaleString() + (first === 1n ? ' first watch' : ' first watches') +
    ' · ' + repeats.toLocaleString() + (repeats === 1n ? ' rewatch' : ' rewatches')));
  return content;
}

function barView(doc: Document, chart: StatisticsChart) {
  const list = doc.createElement('div');
  list.className = 'stats-bars';
  const max = Math.max(1, ...chart.rows.map(row => Number(row.value)));
  for (const row of chart.rows) {
    const item = doc.createElement('div');
    const label = text(doc, 'span', row.label);
    label.title = row.label;
    const svg = doc.createElementNS(svgNamespace, 'svg');
    svg.setAttribute('aria-hidden', 'true');
    const bar = doc.createElementNS(svgNamespace, 'rect');
    bar.setAttribute('width', Number(row.value) / max * 100 + '%');
    bar.setAttribute('height', '6');
    bar.setAttribute('rx', '3');
    svg.append(bar);
    item.append(label, svg, text(doc, 'b', displayValue(row.value, chart)));
    list.append(item);
  }
  return list;
}

const compactBands = ['<25%', '25–<50%', '50–<75%', '75–<100%', '100%'];

function columnView(doc: Document, chart: StatisticsChart) {
  const ratings = chart.id === 'ratings';
  const scroller = doc.createElement('div');
  const max = chart.rows.reduce((high, row) => Math.max(high, Number(row.value)), 1);
  if (ratings) {
    scroller.className = 'stats-rating-histogram';
    const scale = doc.createElement('div');
    scale.className = 'stats-count-scale';
    scale.append(text(doc,'span',max.toLocaleString()),text(doc,'span','0'));
    scroller.append(scale);
  } else {
    scroller.className = 'stats-column-scroll';
    scroller.tabIndex = 0;
    scroller.setAttribute('role','region');
    scroller.setAttribute('aria-label',chart.title);
  }
  const plot = doc.createElement('div');
  plot.className = 'stats-columns';
  for (const [i, row] of chart.rows.entries()) {
    const column = doc.createElement('div');
    column.title = row.label + ' · ' + row.value.toLocaleString() + (Number(row.value) === 1 ? ' show' : ' shows');
    const bars = doc.createElement('div');
    bars.className = 'stats-column-mark';
    if (row.value) {
      const svg = doc.createElementNS(svgNamespace, 'svg');
      svg.setAttribute('height', String(Math.max(1, 80 * Number(row.value) / max)));
      svg.setAttribute('aria-hidden', 'true');
      const bar = doc.createElementNS(svgNamespace, 'rect');
      bar.setAttribute('width', '100%');
      bar.setAttribute('height', '100%');
      bar.setAttribute('rx', '2');
      svg.append(bar);
      if (!ratings) bars.append(text(doc, 'b', row.value.toLocaleString()));
      bars.append(svg);
    }
    const axis = ratings && i % 2 ? '' : chart.id === 'progress' ? compactBands[i] : row.label;
    column.append(bars, text(doc, 'span', axis));
    plot.append(column);
  }
  scroller.append(plot);
  return scroller;
}

function dotView(doc: Document, chart: StatisticsChart) {
  const plot = doc.createElement('div');
  plot.className = 'stats-dots';
  const scale = chart.unit === 'tomatoes' || chart.unit === 'metacritic' ? 100 : 10;
  const max = scale === 100 ? 100 : chart.rows.reduce((high, row) => Math.max(high, Number(row.value)), scale);
  const vertical = doc.createElement('div');
  vertical.className = 'stats-y-ticks';
  for (const n of [max, max / 2, 0]) vertical.append(text(doc, 'span', displayValue(n, chart)));
  const svg = doc.createElementNS(svgNamespace, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('viewBox','0 0 100 100');
  svg.setAttribute('preserveAspectRatio','none');
  const guide = doc.createElementNS(svgNamespace,'line');
  guide.setAttribute('x1','0');
  guide.setAttribute('y1','100');
  guide.setAttribute('x2','100');
  guide.setAttribute('y2',String(100 - scale / max * 100));
  svg.append(guide);
  // A round cap on each zero-length segment draws a fixed-size dot. Large
  // libraries can paint every pair without attaching thousands of SVG nodes.
  const points = doc.createElementNS(svgNamespace,'path');
  points.setAttribute('d',chart.rows.map(row =>
    'M'+Number(row.rating)*10+' '+(100-Number(row.value)/max*100)+'h0').join(''));
  svg.append(points);
  const horizontal = doc.createElement('div');
  horizontal.className = 'stats-x-ticks';
  for (const n of [0, 5, 10]) horizontal.append(text(doc, 'span', String(n)));
  const xLabel = text(doc, 'span', 'My rating');
  xLabel.className = 'stats-x-label';
  const yLabel = chart.unit === 'tomatoes' ? 'Critic approval' : unitHeading[chart.unit];
  plot.append(text(doc, 'span', yLabel), vertical, svg, horizontal, xLabel);
  return plot;
}

export function renderChart(doc: Document, chart: StatisticsChart) {
  const card = doc.createElement('section');
  card.className = 'statistics-card';
  card.dataset.chart = chart.id;
  const title = text(doc, 'h2', chart.title);
  title.id = 'stats-title-' + chart.id;
  card.setAttribute('aria-labelledby', title.id);
  const header = doc.createElement('header');
  const copy = doc.createElement('div');
  copy.append(title);
  const subtitle = chart.kind !== 'dots' ? descriptions[chart.id][0]
    : chart.unit === 'tomatoes' ? 'At 8/10, the line marks 80% approval'
      : 'Above the dashed line, you rated the show lower';
  if (subtitle) copy.append(text(doc,'p',subtitle));
  const toggle = doc.createElement('button');
  toggle.type = 'button';
  toggle.dataset.table = chart.id;
  const content = doc.createElement('div');
  toggle.setAttribute('aria-label', 'Show table for ' + chart.title);
  toggle.setAttribute('aria-haspopup', 'dialog');
  toggle.title = 'Show table';
  toggle.append(statIcon(doc,tableIcon));
  let dialog:HTMLDialogElement | undefined, data:ReturnType<typeof tableView> | undefined;
  const dotPlots = new WeakMap<StatisticsChart, HTMLElement>();
  function close() {
    if (!dialog) return;
    dialog.close();
    dialog.remove();
    dialog = undefined;
    data = undefined;
    if (toggle.isConnected) toggle.focus({preventScroll:true});
  }
  toggle.onclick = () => {
    if (dialog) return;
    dialog = doc.createElement('dialog');
    dialog.className = 'stats-table-dialog';
    dialog.setAttribute('aria-label', chart.title);
    const top = doc.createElement('div');
    top.className = 'stats-table-heading';
    const dismiss = text(doc,'button','Close');
    dismiss.type = 'button'; dismiss.onclick = close;
    top.append(text(doc,'h2',chart.title), dismiss);
    const scroller = doc.createElement('div');
    scroller.className = 'stats-table-scroll';
    scroller.tabIndex = 0;
    scroller.setAttribute('role','region'); scroller.setAttribute('aria-label',chart.title+' table');
    data = tableView(doc,chart);
    scroller.append(data.table);
    dialog.append(top);
    if (chart.kind === 'bar' || chart.kind === 'dots') {
      const field = doc.createElement('label');
      field.className = 'tv-search-field';
      const filter = doc.createElement('input');
      filter.type = 'search';
      const label = chart.id === 'cast' ? 'Find a cast member' : chart.kind === 'dots' || descriptions[chart.id][1] === 'Show'
        ? 'Find a show' : 'Find by name';
      filter.placeholder = label;
      filter.setAttribute('aria-label',label);
      filter.oninput = () => { data?.filter(filter.value); scroller.scrollTop = 0; };
      field.append(filter);
      dialog.append(field);
    }
    dialog.append(scroller);
    dialog.oncancel = e => { e.preventDefault(); close(); };
    dialog.onclick = e => {
      if (e.target !== dialog || !dialog) return;
      const box = dialog.getBoundingClientRect();
      if (e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom) close();
    };
    card.append(dialog);
    dialog.showModal();
    dismiss.focus({preventScroll:true});
  };
  function draw() {
    const visual = { meter: meterView, bar: barView, column: columnView, dots: dotView };
    let view = dotPlots.get(chart);
    if (!view) {
      view = visual[chart.kind](doc, chart);
      if (chart.kind === 'dots') dotPlots.set(chart,view);
    }
    const scroller = content.querySelector<HTMLElement>('.stats-column-scroll');
    if (scroller && view.classList.contains('stats-column-scroll')) scroller.replaceChildren(...view.childNodes);
    else content.replaceChildren(view);
    data?.update(chart);
  }
  header.append(copy, toggle);
  card.append(header, content);
  draw();
  return {card, closeTable:close, update(next: StatisticsChart) { chart = next; draw(); }};
}
