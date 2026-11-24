export const showSortOptions = [
  {value:'high',label:'Highest rated'}, {value:'low',label:'Lowest rated'},
  {value:'title',label:'Title'}, {value:'plays',label:'Most played'},
] as const;

export type ShowSort = typeof showSortOptions[number]['value'];

export function isShowSort(value: unknown): value is ShowSort {
  return showSortOptions.some(choice => choice.value === value);
}

export function compareShowOrder<T extends {rating:number|null; plays:bigint}>(
  a:T, b:T, sort:ShowSort, byTitle:(a:T,b:T) => number,
) {
  if (sort === 'plays' && a.plays !== b.plays) return a.plays > b.plays ? -1 : 1;
  if ((sort === 'high' || sort === 'low') && a.rating !== b.rating) {
    if (a.rating === null) return 1;
    if (b.rating === null) return -1;
    return sort === 'high' ? b.rating - a.rating : a.rating - b.rating;
  }
  return byTitle(a,b);
}
