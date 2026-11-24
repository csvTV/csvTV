import { isListDeclaration, rowKey, type MergeTable, type TableRows } from './model.ts';

export type ValueTable = Exclude<MergeTable,'watched'>;
type ValueRow = TableRows[ValueTable];
export interface ValueDeliveryReview {
  table:ValueTable;
  rows:{label:string; shared:string; independent:string}[];
}

/** Project only the different results. A settings credential never leaves the merge layer. */
export function compareValueDelivery(table:ValueTable, shared:ValueRow[], independent:ValueRow[],
    mine:ValueRow[]):ValueDeliveryReview {
  const byKey = (rows:ValueRow[]) => new Map(rows.map(row=>[rowKey(table,row),row]));
  const a = byKey(shared), b = byKey(independent), local = byKey(mine);
  const rows:ValueDeliveryReview['rows'] = [];
  for (const key of new Set([...a.keys(),...b.keys()])) {
    const first = a.get(key), second = b.get(key), sample = first ?? second!;
    // Compare the actual record fields. UI labels, formatting and output order
    // cannot decide whether a recovery choice matters.
    if (first && second) {
      if ('value' in first && 'value' in second && first.value === second.value) continue;
      if ('show' in first && 'show' in second && first.show === second.show &&
          ('list' in first || 'rating' in first && 'rating' in second && first.rating === second.rating)) continue;
    }
    let label:string;
    if ('setting' in sample) label = sample.setting;
    else if ('list' in sample) label = isListDeclaration(sample) ? 'List “' + sample.list + '”' :
      (sample.show || 'Show ' + sample.show_id) + ' · ' + sample.list;
    else label = sample.show || 'Show ' + sample.show_id;
    const titleChanged = first && second && 'show' in first && 'show' in second && first.show !== second.show;
    function describe(row:ValueRow|undefined) {
      if (!row) return table === 'ratings' ? 'Unrated' : 'Removed';
      if ('setting' in row) {
        const source = local.get(key);
        return source && 'value' in source && source.value === row.value ? 'Use this device’s value' : 'Use Dropbox’s value';
      }
      const result = 'rating' in row ? row.rating + '/10' : 'Included';
      return titleChanged ? result + (row.show ? ' · Title “' + row.show + '”' : ' · Title missing') : result;
    }
    const one = describe(first), two = describe(second);
    rows.push({label,shared:one,independent:two});
  }
  return {table,rows};
}
