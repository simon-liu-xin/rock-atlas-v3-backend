import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  buildWikidataEntityUrlsForAll,
  buildWikidataRecentChangesUrl,
} from "../../src/data/wikidata-refresh.ts";

const trackedQidsPath = requiredArgument("--tracked-qids");
const statePath = requiredArgument("--state");
const windowEnd = requiredArgument("--window-end");
const outputPath = requiredArgument("--output");
const qids = JSON.parse(await readFile(trackedQidsPath, "utf8"));
const state = JSON.parse(await readFile(statePath, "utf8"));

if (!Array.isArray(qids) || qids.some((qid) => typeof qid !== "string")) {
  throw new Error("Tracked QID input must be a JSON array of strings");
}
if (state.cursor_version !== "1.0" || typeof state.window_start !== "string") {
  throw new Error("Unsupported Wikidata refresh cursor");
}
if (state.continuation !== null && typeof state.continuation !== "string") {
  throw new Error("Wikidata refresh continuation must be a string or null");
}

const fullReconcileUrls = buildWikidataEntityUrlsForAll(qids);
const recentChangesUrl = buildWikidataRecentChangesUrl({
  start: state.window_start,
  end: windowEnd,
  continuation: state.continuation ?? undefined,
});
const plan = {
  plan_version: "1.0",
  generated_at: new Date().toISOString(),
  mode: "metadata-only",
  network_requests_executed: 0,
  cursor_advanced: false,
  tracked_qids: qids.length,
  recent_changes: {
    window_start: state.window_start,
    window_end: windowEnd,
    continuation: state.continuation,
    url: recentChangesUrl,
  },
  full_reconcile: {
    cadence: "weekly",
    batch_size: 50,
    request_batches: fullReconcileUrls.length,
    urls: fullReconcileUrls,
  },
  publish_rule:
    "Do not advance the persisted cursor until every RecentChanges page and affected entity batch is staged, revision-audited, and atomically published.",
};

await mkdir(dirname(resolve(outputPath)), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);

function requiredArgument(name) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : null;
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}
