import { mkdir, readFile, statfs, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildOfflineUpdatePlan } from "../../src/data/offline-update-plan.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const capacityPath = resolve(root, "data/sources/offline-db-capacity-v1.json");
const publishedStatePath = resolve(root, "data/sources/offline-published-state-v1.json");
const pocManifestPath = resolve(root, "data/sources/offline-poc/manifest.json");
const outputPath = resolve(root, "data/sources/offline-update-plan-v1.json");

const [capacitySnapshot, publishedState, pocManifest, filesystem] = await Promise.all([
  readJson(capacityPath),
  readJson(publishedStatePath),
  readJson(pocManifestPath),
  statfs(root),
]);
const assessment = capacitySnapshot.assessment.recommended;
const plan = buildOfflineUpdatePlan({
  generatedAt: new Date().toISOString(),
  discoveredAt: capacitySnapshot.generated_at,
  current: {
    musicbrainzSnapshot: publishedState.sources.musicbrainz.snapshot_id,
    discogsSnapshot: publishedState.sources.discogs.snapshot_id,
  },
  discovered: {
    musicbrainzSnapshot: capacitySnapshot.source_snapshots.musicbrainz.snapshot_id,
    discogsSnapshot: capacitySnapshot.source_snapshots.discogs.snapshot_id,
  },
  trackedQids: pocManifest.sources.wikidata.tracked_qids,
  filesystemCapacityBytes: filesystem.blocks * filesystem.bsize,
  filesystemAvailableBytes: filesystem.bavail * filesystem.bsize,
  capacity: {
    estimatedStableWorkingBytes: assessment.estimated_stable_working_bytes,
    estimatedPeakWorkingBytes: assessment.estimated_peak_working_bytes,
    provisionedDiskBytes: assessment.provisioned_disk_bytes,
  },
});
const report = {
  ...plan,
  evidence: {
    discovery_snapshot_generated_at: capacitySnapshot.generated_at,
    capacity_snapshot_path: "data/sources/offline-db-capacity-v1.json",
    published_state_path: "data/sources/offline-published-state-v1.json",
    tracked_qid_manifest_path: "data/sources/offline-poc/manifest.json",
  },
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
