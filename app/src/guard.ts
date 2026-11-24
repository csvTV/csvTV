export interface MergeImpact {
  baseRows: number | null;
  localRows: number;
  remoteRows: number;
  /** Rows added, removed or changed, excluding descriptive changes and pure moves. */
  localToRemoteDifferences: number;
  localToBaseDifferences: number;
  removedRows: number;
  loweredCounts: number;
  lostViewings: bigint;
  changedRatings: number;
  changedSettings: number;
}

export function initialImpact(baseRows: number | null, localRows: number, remoteRows: number): MergeImpact {
  return { baseRows, localRows, remoteRows, localToRemoteDifferences: 0, localToBaseDifferences: 0,
    removedRows: 0, loweredCounts: 0, lostViewings: 0n,
    changedRatings: 0, changedSettings: 0 };
}

export type RemoteState = 'readable' | 'missing' | 'damaged' | 'unsupported' | 'unidentifiable';
type Choice = 'restore-device' | 'take-remote' | 'merge-anyway' | 'combine' | 'reload' | 'cancel';

export interface GuardDecision {
  case: 1 | 2 | 3;
  choices: Choice[];
  reason: string;
}

/** Before a merge. A missing file here means a confirmed download result. */
export function guardFile(input: {
  remote: RemoteState;
  hasBase: boolean;
  localRows: number;
  unresolvedPending?: 'unknown-outcome' | 'missing-target';
}): GuardDecision | null {
  const { remote, localRows } = input;
  const readable = remote === 'readable' || remote === 'missing';
  const choices: Choice[] = [];
  if (input.unresolvedPending) {
    if (readable) choices.push('combine', 'take-remote');
    if (remote === 'unsupported') choices.push('reload');
    return { case: 3, choices: [...choices, 'cancel'], reason: input.unresolvedPending };
  }
  if (remote === 'readable' || (remote === 'missing' && !input.hasBase)) return null;
  if (localRows > 0 && (remote === 'missing' || remote === 'damaged')) choices.push('restore-device');
  if (remote === 'missing') choices.push('take-remote');
  if (remote === 'unsupported') choices.push('reload');
  return { case: 1, choices: [...choices, 'cancel'], reason: remote };
}

/** After resolving identities and any double marks, before committing the result. */
export function guardMerge(impact: MergeImpact): GuardDecision | null {
  const { localRows, baseRows, remoteRows, removedRows } = impact;
  if (!localRows) return null;
  let reason: string;
  if (removedRows === localRows) reason = 'all-local-rows-removed';
  else if (localRows >= 50 && removedRows * 5 > localRows) reason = 'over-one-fifth-removed';
  else if (remoteRows === 0 && baseRows !== null && baseRows > 0) reason = 'remote-emptied';
  else return null;
  return { case: 2, reason, choices: ['restore-device', 'take-remote', 'merge-anyway', 'cancel'] };
}
