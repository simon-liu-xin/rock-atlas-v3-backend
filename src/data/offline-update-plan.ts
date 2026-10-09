export interface OfflineUpdatePlanInput {
  generatedAt: string;
  discoveredAt: string;
  current: {
    musicbrainzSnapshot: string | null;
    discogsSnapshot: string | null;
  };
  discovered: {
    musicbrainzSnapshot: string;
    discogsSnapshot: string;
  };
  trackedQids: number;
  filesystemCapacityBytes: number;
  filesystemAvailableBytes: number;
  capacity: {
    estimatedStableWorkingBytes: number;
    estimatedPeakWorkingBytes: number;
    provisionedDiskBytes: number;
  };
}

export interface OfflineUpdateAction {
  source: "musicbrainz" | "discogs" | "wikidata";
  operation: "blue-green-rebuild" | "monthly-replacement" | "tracked-qid-refresh";
  current_snapshot: string | null;
  target_snapshot: string;
  status: "ready" | "blocked-capacity" | "not-needed";
  license_partition: "musicbrainz-core-cc0" | "discogs-cc0" | "wikidata-cc0";
  stages: string[];
}

export interface OfflineUpdatePlan {
  plan_version: "1.0";
  generated_at: string;
  mode: "bootstrap" | "refresh";
  full_archives_downloaded: false;
  capacity_gate: {
    status: "pass" | "blocked";
    filesystem_capacity_bytes: number;
    filesystem_available_bytes: number;
    provisioned_disk_bytes: number;
    required_free_bytes: number;
    free_space_shortfall_bytes: number;
    device_capacity_shortfall_bytes: number;
  };
  actions: OfflineUpdateAction[];
  publish_rule: string;
}

const REPLACEMENT_STAGES = [
  "discover",
  "download",
  "verify",
  "stage",
  "project",
  "audit",
  "publish",
  "retain",
];

export function buildOfflineUpdatePlan(input: OfflineUpdatePlanInput): OfflineUpdatePlan {
  validateInput(input);
  const hasPublishedGeneration =
    input.current.musicbrainzSnapshot !== null || input.current.discogsSnapshot !== null;
  const mode = hasPublishedGeneration ? "refresh" : "bootstrap";
  const requiredFreeBytes =
    mode === "bootstrap"
      ? input.capacity.estimatedPeakWorkingBytes
      : input.capacity.estimatedPeakWorkingBytes - input.capacity.estimatedStableWorkingBytes;
  const freeSpaceShortfall = Math.max(0, requiredFreeBytes - input.filesystemAvailableBytes);
  const deviceCapacityShortfall = Math.max(
    0,
    input.capacity.provisionedDiskBytes - input.filesystemCapacityBytes,
  );
  const capacityPassed = freeSpaceShortfall === 0 && deviceCapacityShortfall === 0;

  return {
    plan_version: "1.0",
    generated_at: input.generatedAt,
    mode,
    full_archives_downloaded: false,
    capacity_gate: {
      status: capacityPassed ? "pass" : "blocked",
      filesystem_capacity_bytes: input.filesystemCapacityBytes,
      filesystem_available_bytes: input.filesystemAvailableBytes,
      provisioned_disk_bytes: input.capacity.provisionedDiskBytes,
      required_free_bytes: requiredFreeBytes,
      free_space_shortfall_bytes: freeSpaceShortfall,
      device_capacity_shortfall_bytes: deviceCapacityShortfall,
    },
    actions: [
      replacementAction(
        "musicbrainz",
        "blue-green-rebuild",
        "musicbrainz-core-cc0",
        input.current.musicbrainzSnapshot,
        input.discovered.musicbrainzSnapshot,
        capacityPassed,
      ),
      replacementAction(
        "discogs",
        "monthly-replacement",
        "discogs-cc0",
        input.current.discogsSnapshot,
        input.discovered.discogsSnapshot,
        capacityPassed,
      ),
      {
        source: "wikidata",
        operation: "tracked-qid-refresh",
        current_snapshot: null,
        target_snapshot: `${input.trackedQids}-tracked-qids`,
        status: "ready",
        license_partition: "wikidata-cc0",
        stages: ["discover", "fetch-50-qid-batches", "verify-revisions", "stage", "audit", "publish"],
      },
    ],
    publish_rule:
      "Publish only after every required source action is validated; switch the generation manifest atomically and retain the previous generation.",
  };
}

function replacementAction(
  source: "musicbrainz" | "discogs",
  operation: "blue-green-rebuild" | "monthly-replacement",
  licensePartition: "musicbrainz-core-cc0" | "discogs-cc0",
  currentSnapshot: string | null,
  targetSnapshot: string,
  capacityPassed: boolean,
): OfflineUpdateAction {
  const changed = currentSnapshot !== targetSnapshot;
  return {
    source,
    operation,
    current_snapshot: currentSnapshot,
    target_snapshot: targetSnapshot,
    status: changed ? (capacityPassed ? "ready" : "blocked-capacity") : "not-needed",
    license_partition: licensePartition,
    stages: [...REPLACEMENT_STAGES],
  };
}

function validateInput(input: OfflineUpdatePlanInput): void {
  const generatedAt = Date.parse(input.generatedAt);
  const discoveredAt = Date.parse(input.discoveredAt);
  if (!Number.isFinite(generatedAt) || !Number.isFinite(discoveredAt)) {
    throw new Error("Update plan timestamps must be valid ISO date-time values");
  }
  const discoveryAgeMs = generatedAt - discoveredAt;
  if (discoveryAgeMs < 0) throw new Error("Discovery snapshot cannot be newer than the plan");
  if (discoveryAgeMs > 24 * 60 * 60 * 1000) {
    throw new Error("Discovery snapshot is stale; refresh source metadata before planning updates");
  }
  if (!/^\d{8}-\d{6}$/.test(input.discovered.musicbrainzSnapshot)) {
    throw new Error(`Invalid MusicBrainz snapshot: ${input.discovered.musicbrainzSnapshot}`);
  }
  if (!/^\d{8}$/.test(input.discovered.discogsSnapshot)) {
    throw new Error(`Invalid Discogs snapshot: ${input.discovered.discogsSnapshot}`);
  }
  const hasMusicBrainzSnapshot = input.current.musicbrainzSnapshot !== null;
  const hasDiscogsSnapshot = input.current.discogsSnapshot !== null;
  if (hasMusicBrainzSnapshot !== hasDiscogsSnapshot) {
    throw new Error("Published generation is not atomic across MusicBrainz and Discogs");
  }
  if (
    input.current.musicbrainzSnapshot !== null &&
    input.discovered.musicbrainzSnapshot < input.current.musicbrainzSnapshot
  ) {
    throw new Error("Discovered MusicBrainz snapshot is older than the published snapshot");
  }
  if (
    input.current.discogsSnapshot !== null &&
    input.discovered.discogsSnapshot < input.current.discogsSnapshot
  ) {
    throw new Error("Discovered Discogs snapshot is older than the published snapshot");
  }
  if (!Number.isSafeInteger(input.trackedQids) || input.trackedQids < 1) {
    throw new Error(`Invalid tracked QID count: ${input.trackedQids}`);
  }
  for (const [name, value] of Object.entries({
    filesystemCapacityBytes: input.filesystemCapacityBytes,
    filesystemAvailableBytes: input.filesystemAvailableBytes,
    ...input.capacity,
  })) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${name}: ${value}`);
  }
  if (input.capacity.estimatedPeakWorkingBytes < input.capacity.estimatedStableWorkingBytes) {
    throw new Error("Peak working bytes cannot be lower than stable working bytes");
  }
}
