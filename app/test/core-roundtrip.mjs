import { guardMerge, mergeWatched, openDeviceStore, readMergeInput, writeCsv } from "../dist/core.js";

// Run in the same browser as the storage acceptance cases, on its isolated origin.
export async function coreRoundtrip() {
  const name = "csvtv-roundtrip-" + crypto.randomUUID();
  const header = "show_id,show,season,episode,title,times_watched,episode_id\r\n";
  const baseText = header + "7,North,1,1,First,1,101\r\n7,North,1,2,Second,1,102\r\n";
  const phoneText = baseText.replace("First,1,101", "First,2,101");
  const pcText = header + "7,North,1,1,Second,1,102\r\n7,North,1,2,First,1,101\r\n";
  const expected = pcText.replace("First,1,101", "First,2,101");
  const context = { hasBase: true, localRows: 2 };
  function rows(csv) {
    const input = readMergeInput("watched", new TextEncoder().encode(csv), context);
    if (input.status !== "ready") throw new Error("A valid watch file did not pass its guard");
    return input.rows;
  }
  let db = await openDeviceStore({ name });
  try {
    const empty = await db.whenWriter();
    await db.commit(empty.revision, { replace: { watched: rows(phoneText) },
      sync: { watched: { base: { revision: "fiction-a", content: baseText }, lastClientModified: null, pending: null } } });
    const local = await db.snapshot();
    const guarded = readMergeInput("watched", pcText.replace("episode_id", "episode_id,next_format"), context);
    if (guarded.status !== "guard" || !guarded.decision.choices.includes("reload") || "rows" in guarded) {
      throw new Error("A newer CSV format reached the merge");
    }
    const merged = mergeWatched(rows(local.sync.watched.base.content), local.tables.watched, rows(pcText));
    if (merged.status !== "merged" || guardMerge(merged.impact)) throw new Error("The numbering swap did not merge");
    await db.commit(local.revision, { replace: { watched: merged.rows } });
    db.close();
    db = await openDeviceStore({ name });
    const reopened = await db.whenWriter();
    if (writeCsv("watched", reopened.tables.watched) !== expected) throw new Error("The reopened record changed episode identity or CSV bytes");
  } finally {
    db.close();
  }
}
