import type { BroadcastSeason } from './broadcast-seasons.ts';
import type { ShowInfo } from './progress.ts';

export const seasonOrderPrefix = 'season_order.';
export const seasonOrderKey = (id: number) => seasonOrderPrefix + id;
export const nativeSeasonOrder = 'native';

export interface SeasonBreaks {
  season: number;
  episodeCount: number;
  after: number[];
}

function positive(text: string) {
  return /^[1-9][0-9]*$/.test(text) && Number.isSafeInteger(Number(text));
}

export function isSeasonOrderKey(key: string) {
  return key.startsWith(seasonOrderPrefix) && positive(key.slice(seasonOrderPrefix.length));
}

/** Each item records the native season, its observed length and its last episodes before a break. */
export function decodeSeasonBreaks(value: string): SeasonBreaks[] | null {
  if (!value || value.length > 32768) return null;
  const groups: SeasonBreaks[] = [];
  for (const item of value.split(';')) {
    const match = /^([0-9]+)\/([0-9]+):([0-9,]+)$/.exec(item);
    if (!match || !positive(match[1]) || !positive(match[2])) return null;
    const season = Number(match[1]), episodeCount = Number(match[2]);
    const numbers = match[3].split(',');
    if (season <= (groups.at(-1)?.season ?? 0) || !numbers.every(positive)) return null;
    const after = numbers.map(Number);
    if (after.some((n,i) => n >= episodeCount || (i > 0 && n <= after[i-1]))) return null;
    groups.push({season,episodeCount,after});
  }
  return groups;
}

export const encodeSeasonBreaks = (groups: readonly SeasonBreaks[]) =>
  groups.map(group => group.season+'/'+group.episodeCount+':'+group.after.join(',')).join(';');

export function manualSeasonRanges(show: Pick<ShowInfo,'seasons'|'manualSeasonOrder'>): readonly BroadcastSeason[] | null | undefined {
  const value = show.manualSeasonOrder;
  if (!value) return undefined;
  if (value === nativeSeasonOrder) return null;
  const groups = decodeSeasonBreaks(value);
  if (!groups) return undefined;
  const native = show.seasons.filter(s => s.season > 0).sort((a,b) => a.season-b.season);
  if (groups.some(group => !native.some(s => s.season === group.season && s.episodeCount >= group.episodeCount))) return undefined;
  const breaks = new Map(groups.map(group => [group.season,group.after]));
  const ranges: BroadcastSeason[] = [];
  for (const source of native) {
    let first = 1;
    for (const last of [...(breaks.get(source.season) ?? []),source.episodeCount]) {
      ranges.push({number:ranges.length+1,sourceSeason:source.season,first,last});
      first = last + 1;
    }
  }
  return ranges;
}

export function withoutManualOrder<T>(value: T): T {
  if (!value || typeof value !== 'object' || !('manualSeasonOrder' in value)) return value;
  const {manualSeasonOrder: _, ...metadata} = value;
  return metadata as T;
}
