import { MAX_INTEGER, rowKey, watchPosition, type WatchedRow } from './model.ts';
import { initialImpact } from './guard.ts';
import type { MergedRows } from './merge.ts';
import { alignEpisodes, applyAssignments, competingRows, episodeKey, sides,
  type EpisodeGroup, type IdentityAssignment, type Place, type WatchInputs } from './watch-identity.ts';

export type { IdentityAssignment } from './watch-identity.ts';

/** The executor supplies these from its committed read and the actual remote download. */
export interface WatchVersions {
  recordVersion: bigint;
  baseRevision: string | null;
  remoteRevision: string | null;
}
export interface IdentityReview {
  status: 'identity-review';
  reason: string;
  inputs: WatchInputs;
  conflicts: ReturnType<typeof competingRows>;
  token: string;
}
interface DoubleMark extends Place {
  show: string;
  title: string;
  key: string;
  before: number;
  mine: number;
  theirs: number;
  deliveryTotals?: {one:string; two:string};
}
export interface DoubleMarkReview {
  status: 'double-mark';
  episodes: DoubleMark[];
  baseToken: string;
  delivery?: true;
  firstCopy?: true;
}
type CountAnswer = 'one' | 'two';
interface Answers {
  baseToken: string;
  choices: ReadonlyMap<string, CountAnswer>;
}
export interface WatchOptions {
  versions?: WatchVersions;
  resolution?: { token: string; assignments: readonly IdentityAssignment[] };
  answers?: Answers;
  delivery?: { token:string; changes?:ReadonlyMap<string,bigint>; answers?:Answers };
  hold?: boolean;
}
export interface WatchedMerge extends MergedRows<WatchedRow> {
  remoteChangedEpisodes: string[];
  unansweredDoubleMarks: DoubleMark[];
}
type WatchResult = WatchedMerge | IdentityReview | DoubleMarkReview | { status: 'overflow'; episode: Place };

export function answerDoubleMarks(review: DoubleMarkReview, defaultChoice: CountAnswer,
    overrides: ReadonlyMap<string, CountAnswer> = new Map()): Answers {
  return { baseToken: review.baseToken, choices: new Map(review.episodes.map(item =>
    [item.key, overrides.get(item.key) ?? defaultChoice])) };
}

function countChange(group: EpisodeGroup): DoubleMark | undefined {
  const before = group.before?.times_watched ?? 0, mine = group.mine?.times_watched ?? 0;
  const theirs = group.theirs?.times_watched ?? 0;
  if ((mine > before && theirs > before) || (mine < before && theirs < before)) {
    const row = group.mine ?? group.theirs ?? group.before!;
    return { ...group.place, show:row.show, title:row.title, key: episodeKey(group.place), before, mine, theirs };
  }
  return undefined;
}

function countFor(group: EpisodeGroup, noBase: boolean, answer?: CountAnswer): bigint {
  const b = BigInt(group.before?.times_watched ?? 0), m = BigInt(group.mine?.times_watched ?? 0);
  const t = BigInt(group.theirs?.times_watched ?? 0);
  if (noBase || (answer === 'one' && m > b)) return m > t ? m : t;
  if (answer === 'one') return m < t ? m : t;
  return m + t - b;
}

/** Compare counting the original, indistinguishable update once or twice, before either device's later edits. */
export function watchDeliveryChanges(target: readonly WatchedRow[], prepared: readonly WatchedRow[]): Map<string,bigint> | null {
  const groups = alignEpisodes({before:target,mine:prepared,theirs:[]});
  if (!Array.isArray(groups)) return null;
  const changes = new Map<string,bigint>();
  for (const group of groups) {
    if (!group.mine) continue; // Removing the last watch once or twice leaves zero.
    const count = BigInt(group.mine.times_watched);
    const twice = 2n * count - BigInt(group.before?.times_watched ?? 0);
    const difference = (twice < 0n ? 0n : twice) - count;
    if (difference) changes.set(watchPosition(group.mine),difference);
  }
  return changes;
}

function label(group: EpisodeGroup, field: 'show' | 'title'): string {
  const { mine, theirs, before } = group;
  if (mine && theirs) return mine[field] === before?.[field] ? theirs[field] : mine[field];
  return (mine ?? theirs ?? before)![field];
}

function rowSignature(row: WatchedRow) {
  return [row.show_id, row.season, row.episode, row.episode_id, row.times_watched, row.show, row.title];
}

export function mergeWatched(before: readonly WatchedRow[] | null, mine: readonly WatchedRow[],
    theirs: readonly WatchedRow[], options: WatchOptions = {}): WatchResult {
  const inputs: WatchInputs = { before: before ?? [], mine, theirs };
  const { versions, resolution } = options;
  const noBase = before === null;
  // Only exceptional, interactive paths need a copy suitable for binding a later answer.
  const currentToken = () => JSON.stringify([versions?.recordVersion.toString(), versions?.baseRevision,
    versions?.remoteRevision, noBase, ...sides.map(side => inputs[side].map(rowSignature))]);
  function review(reason: string, places: readonly Place[] = []): IdentityReview {
    const copyRows = (rows: readonly WatchedRow[]) => rows.map(row => ({ ...row }));
    const snapshot = { before: copyRows(inputs.before), mine: copyRows(mine), theirs: copyRows(theirs) };
    return { status: 'identity-review', reason, token: currentToken(), inputs: snapshot,
      conflicts: competingRows(snapshot, places) };
  }
  if (resolution && !versions) return review('Capture the record, base and remote revisions before resolving identities.');
  if (resolution && resolution.token !== currentToken()) return review('The inputs changed. Review the current rows.');
  const groups = resolution ? applyAssignments(inputs, resolution.assignments) : alignEpisodes(inputs);
  if (typeof groups === 'string') return review(groups);
  if (!Array.isArray(groups)) return review(groups.reason, groups.places);

  const doubles = new Map<EpisodeGroup, DoubleMark>();
  if (!noBase) {
    for (const group of groups) {
      const change = countChange(group);
      if (!change) continue;
      // Later removals can both reach zero. An interrupted earlier addition may
      // lift one outcome above zero; otherwise this later choice changes nothing.
      if (options.delivery && group.before && (!change.mine || !change.theirs) &&
          (options.delivery.changes?.get(watchPosition(group.before)) ?? 0n) <= 0n) continue;
      doubles.set(group,change);
    }
  }
  const baseToken = doubles.size ? JSON.stringify([versions?.baseRevision, inputs.before.map(rowSignature)]) : '';
  if (doubles.size && !options.answers && !options.hold) {
    return { status: 'double-mark', episodes: [...doubles.values()], baseToken };
  }
  const impact = initialImpact(before?.length ?? null, mine.length, theirs.length);
  const occupied = new Map<string, Place>();
  const remoteChangedKeys = new Set<string>(), remoteChangedEpisodes = new Set<string>();
  const unansweredDoubleMarks: DoubleMark[] = [];
  let deliveryQuestions: DoubleMark[] | undefined;
  let overflow: Place | undefined;
  const rows: WatchedRow[] = [];
  for (const group of groups) {
    const localCount = group.mine?.times_watched ?? 0, remoteCount = group.theirs?.times_watched ?? 0;
    const baseCount = group.before?.times_watched ?? 0;
    if (localCount !== remoteCount) impact.localToRemoteDifferences++;
    if (localCount !== baseCount) impact.localToBaseDifferences++;
    const change = doubles.get(group);
    const answer = change && options.answers?.baseToken === baseToken ? options.answers.choices.get(change.key) : undefined;
    if (change && !answer) unansweredDoubleMarks.push(change);
    let count = countFor(group, noBase, answer);
    let separateDelivery = false;
    const delivery = options.delivery;
    const difference = group.before && delivery?.changes?.get(watchPosition(group.before));
    if (delivery && (!delivery.changes || difference)) {
      // Without a shared first copy, independent imports keep the higher count for each episode.
      const both = delivery.changes ? count + difference! : BigInt(Math.max(localCount,remoteCount));
      const one = count < 0n ? 0n : count, two = both < 0n ? 0n : both;
      if (one !== two) {
        const key = episodeKey(group.place);
        const choice = delivery.answers?.baseToken === delivery.token ? delivery.answers.choices.get(key) : undefined;
        if (!choice) {
          (deliveryQuestions ??= []).push({...group.place, show:label(group,'show'), title:label(group,'title'), key,
            before:baseCount, mine:localCount, theirs:remoteCount, deliveryTotals:{one:one.toString(),two:two.toString()}});
          continue;
        }
        if (choice === 'two') { count = both; separateDelivery = true; }
      }
    }
    if (count > BigInt(MAX_INTEGER)) {
      if (!delivery) return {status:'overflow',episode:group.place};
      overflow ??= group.place;
      continue;
    }
    if (baseCount !== remoteCount || separateDelivery) {
      const previous = (group.mine ?? group.before ?? group.theirs)!;
      remoteChangedKeys.add(rowKey('watched', previous));
      remoteChangedEpisodes.add(episodeKey(previous));
      remoteChangedEpisodes.add(episodeKey(group.place));
    }
    if (count <= 0n) {
      if (group.mine) impact.removedRows++;
      continue;
    }
    const row: WatchedRow = { ...group.place, show: label(group, 'show'), title: label(group, 'title'),
      times_watched: Number(count) };
    const slot = rowKey('watched', row);
    const occupant = occupied.get(slot);
    if (occupant) return review('Surviving episodes would occupy the same position.', [occupant, row]);
    occupied.set(slot, group.place);
    rows.push(row);
    if (group.mine && group.mine.times_watched > row.times_watched) {
      impact.loweredCounts++;
      impact.lostViewings += BigInt(group.mine.times_watched) - count;
    }
  }
  if (deliveryQuestions) return {status:'double-mark',delivery:true,...(!options.delivery!.changes && {firstCopy:true as const}),
    episodes:deliveryQuestions,baseToken:options.delivery!.token};
  if (overflow) return {status:'overflow',episode:overflow};
  return { status: 'merged', noBase, rows, impact, clashes: [],
    remoteChangedKeys: [...remoteChangedKeys], remoteChangedEpisodes: [...remoteChangedEpisodes], unansweredDoubleMarks };
}
