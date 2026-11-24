import { readCsv } from "./csv.ts";
import { guardFile, type RemoteState } from "./guard.ts";
import type { MergeTable } from "./model.ts";

export * from "./model.ts";
export * from "./csv.ts";
export * from "./merge.ts";
export * from "./guard.ts";
export * from "./marks.ts";
export * from "./progress.ts";
export * from "./shows.ts";
export * from "./storage.ts";

/**
 * Validate an actual downloaded file before treating it as a merge input.
 * null means a confirmed missing file. A listing omission or failed download
 * is insufficient. The caller retains its input and pending upload on a guard.
 */
export function readMergeInput<K extends MergeTable>(
  table: K, content: string | Uint8Array | null, state: Omit<Parameters<typeof guardFile>[0], "remote">,
) {
  const checked = content === null ? null : readCsv(table, content);
  let remote: RemoteState = "missing";
  if (checked) {
    if (checked.schema === "unknown") remote = "unsupported";
    else if (checked.schema === "unconfirmed") remote = "unidentifiable";
    else if (checked.stopped || checked.findings.length) remote = "damaged";
    else remote = "readable";
  }
  const decision = guardFile({ ...state, remote });
  if (decision) return { status: "guard" as const, decision, findings: checked?.findings ?? [] };
  return { status: "ready" as const, rows: checked?.rows ?? [] };
}
