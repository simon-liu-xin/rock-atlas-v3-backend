import { createHash } from "node:crypto";
import { isAbsolute, normalize, relative, sep } from "node:path";

export type BootstrapArtifactRole = "archive" | "checksum-manifest" | "signature";

export type OfflineBootstrapLicensePartition =
  | "musicbrainz-core-cc0"
  | "musicbrainz-derived-nc"
  | "discogs-cc0";

export interface OfflineBootstrapSourceFile {
  name: string;
  bytes: number;
  license_partition: OfflineBootstrapLicensePartition;
}

export interface OfflineBootstrapSourceSnapshot {
  snapshot_id: string;
  directory_url: string;
  files: OfflineBootstrapSourceFile[];
}

export interface OfflineBootstrapCapacityGate {
  status: "pass" | "blocked";
  filesystem_capacity_bytes: number;
  filesystem_available_bytes: number;
  required_free_bytes: number;
}

export interface OfflineBootstrapPlanInput {
  generatedAt: string;
  repositoryRoot: string;
  dataRoot: string;
  downloadAuthorized: boolean;
  capacityGate: OfflineBootstrapCapacityGate;
  sourceConfig: {
    musicbrainzSigningKeyFingerprint: string;
    metadataMaxBytes: number;
  };
  sourceSnapshots: {
    musicbrainz: OfflineBootstrapSourceSnapshot;
    discogs: OfflineBootstrapSourceSnapshot;
  };
}

export interface OfflineBootstrapArtifact {
  artifact_id: string;
  source: "musicbrainz" | "discogs";
  role: BootstrapArtifactRole;
  required: true;
  filename: string;
  source_url: string;
  expected_bytes: number | null;
  max_bytes: number;
  destination_relative: string;
  license_partition: "musicbrainz-core-cc0" | "discogs-cc0";
  verification:
    | {
        method: "signed-metadata";
        signature_artifact_id: string;
        trusted_fingerprint: string;
      }
    | {
        method: "sha256-signed-manifest";
        checksum_artifact_id: string;
        signature_artifact_id: string;
        trusted_fingerprint: string;
      }
    | { method: "sha256-manifest"; checksum_artifact_id: string }
    | { method: "transport-size-only" };
}

export interface OfflineBootstrapPlan {
  plan_version: "1.0";
  generated_at: string;
  mode: "dry-run";
  network_requests_executed: 0;
  full_archives_downloaded: false;
  generation_id: string;
  plan_fingerprint: string;
  data_root: string;
  download_authorization: "authorized" | "not-authorized";
  execution_ready: boolean;
  capacity_gate: OfflineBootstrapCapacityGate;
  known_download_bytes: number;
  layout: {
    incoming: { musicbrainz: string; discogs: string };
    verified: { musicbrainz: string; discogs: string };
    generation_stage: string;
    generation_canonical: string;
    published: string;
    state: string;
  };
  artifacts: OfflineBootstrapArtifact[];
}

export interface OfflineBootstrapMachinePlan extends OfflineBootstrapPlan {
  capacity_mode: "bootstrap" | "refresh";
  published_generation_reused: boolean;
  published_reuse_reason:
    | "no-published-generation"
    | "data-root-mismatch"
    | "generation-directory-missing"
    | "generation-directory-invalid"
    | "generation-manifest-missing"
    | "generation-manifest-invalid"
    | "generation-manifest-mismatch"
    | "generation-manifest-sha256-mismatch"
    | "published-content-root-invalid"
    | "published-content-inventory-mismatch"
    | "published-content-size-mismatch"
    | "published-content-allocation-unavailable"
    | "published-content-capacity-shortfall"
    | "generation-manifest-verified";
  published_content_allocated_bytes: number;
  target_filesystem: {
    requested_data_root: string;
    resolved_data_root: string;
    probe_path: string;
    filesystem_device_id: number;
    filesystem_capacity_bytes: number;
    filesystem_available_bytes: number;
  };
  evidence: {
    capacity_snapshot_path: string;
    published_state_path: string;
    tracked_qid_manifest_path: string;
    source_config_path: string;
  };
}

export type OfflineBootstrapMachinePlanMetadata = Pick<
  OfflineBootstrapMachinePlan,
  | "capacity_mode"
  | "published_generation_reused"
  | "published_reuse_reason"
  | "published_content_allocated_bytes"
  | "target_filesystem"
  | "evidence"
>;

const MUSICBRAINZ_ARCHIVE = "mbdump.tar.bz2";
const MUSICBRAINZ_CHECKSUM = "SHA256SUMS";
const MUSICBRAINZ_SIGNATURE = "SHA256SUMS.asc";
const DISCOGS_KINDS = ["artists", "labels", "masters", "releases"] as const;

export function buildOfflineBootstrapPlan(
  input: OfflineBootstrapPlanInput,
): OfflineBootstrapPlan {
  validateInput(input);

  const musicBrainz = input.sourceSnapshots.musicbrainz;
  const discogs = input.sourceSnapshots.discogs;
  const generationId = `mb-${musicBrainz.snapshot_id}__discogs-${discogs.snapshot_id}`;
  const fingerprint = input.sourceConfig.musicbrainzSigningKeyFingerprint.toUpperCase();
  const musicBrainzArchive = requireSourceFile(musicBrainz.files, MUSICBRAINZ_ARCHIVE);
  const discogsChecksumFilename = `discogs_${discogs.snapshot_id}_CHECKSUM.txt`;
  const discogsChecksum = requireSourceFile(discogs.files, discogsChecksumFilename);

  const artifacts: OfflineBootstrapArtifact[] = [
    {
      artifact_id: `musicbrainz:${MUSICBRAINZ_ARCHIVE}`,
      source: "musicbrainz",
      role: "archive",
      required: true,
      filename: MUSICBRAINZ_ARCHIVE,
      source_url: new URL(MUSICBRAINZ_ARCHIVE, musicBrainz.directory_url).toString(),
      expected_bytes: musicBrainzArchive.bytes,
      max_bytes: musicBrainzArchive.bytes,
      destination_relative: incomingPath(
        "musicbrainz",
        musicBrainz.snapshot_id,
        MUSICBRAINZ_ARCHIVE,
      ),
      license_partition: "musicbrainz-core-cc0",
      verification: {
        method: "sha256-signed-manifest",
        checksum_artifact_id: `musicbrainz:${MUSICBRAINZ_CHECKSUM}`,
        signature_artifact_id: `musicbrainz:${MUSICBRAINZ_SIGNATURE}`,
        trusted_fingerprint: fingerprint,
      },
    },
    {
      artifact_id: `musicbrainz:${MUSICBRAINZ_CHECKSUM}`,
      source: "musicbrainz",
      role: "checksum-manifest",
      required: true,
      filename: MUSICBRAINZ_CHECKSUM,
      source_url: new URL(MUSICBRAINZ_CHECKSUM, musicBrainz.directory_url).toString(),
      expected_bytes: null,
      max_bytes: input.sourceConfig.metadataMaxBytes,
      destination_relative: incomingPath(
        "musicbrainz",
        musicBrainz.snapshot_id,
        MUSICBRAINZ_CHECKSUM,
      ),
      license_partition: "musicbrainz-core-cc0",
      verification: {
        method: "signed-metadata",
        signature_artifact_id: `musicbrainz:${MUSICBRAINZ_SIGNATURE}`,
        trusted_fingerprint: fingerprint,
      },
    },
    {
      artifact_id: `musicbrainz:${MUSICBRAINZ_SIGNATURE}`,
      source: "musicbrainz",
      role: "signature",
      required: true,
      filename: MUSICBRAINZ_SIGNATURE,
      source_url: new URL(MUSICBRAINZ_SIGNATURE, musicBrainz.directory_url).toString(),
      expected_bytes: null,
      max_bytes: input.sourceConfig.metadataMaxBytes,
      destination_relative: incomingPath(
        "musicbrainz",
        musicBrainz.snapshot_id,
        MUSICBRAINZ_SIGNATURE,
      ),
      license_partition: "musicbrainz-core-cc0",
      verification: { method: "transport-size-only" },
    },
    {
      artifact_id: "discogs:CHECKSUM",
      source: "discogs",
      role: "checksum-manifest",
      required: true,
      filename: discogsChecksumFilename,
      source_url: discogsDownloadUrl(
        discogs.directory_url,
        discogs.snapshot_id,
        discogsChecksumFilename,
      ),
      expected_bytes: discogsChecksum.bytes,
      max_bytes: discogsChecksum.bytes,
      destination_relative: incomingPath(
        "discogs",
        discogs.snapshot_id,
        discogsChecksumFilename,
      ),
      license_partition: "discogs-cc0",
      verification: { method: "transport-size-only" },
    },
    ...DISCOGS_KINDS.map((kind): OfflineBootstrapArtifact => {
      const filename = `discogs_${discogs.snapshot_id}_${kind}.xml.gz`;
      const file = requireSourceFile(discogs.files, filename);
      return {
        artifact_id: `discogs:${kind}`,
        source: "discogs",
        role: "archive",
        required: true,
        filename,
        source_url: discogsDownloadUrl(discogs.directory_url, discogs.snapshot_id, filename),
        expected_bytes: file.bytes,
        max_bytes: file.bytes,
        destination_relative: incomingPath("discogs", discogs.snapshot_id, filename),
        license_partition: "discogs-cc0",
        verification: {
          method: "sha256-manifest",
          checksum_artifact_id: "discogs:CHECKSUM",
        },
      };
    }),
  ];
  const knownDownloadBytes = sumKnownDownloadBytes(artifacts);
  if (input.capacityGate.required_free_bytes < knownDownloadBytes) {
    throw new Error(
      "Capacity gate required free bytes cannot be below known download bytes",
    );
  }

  const plan: Omit<OfflineBootstrapPlan, "plan_fingerprint"> = {
    plan_version: "1.0",
    generated_at: input.generatedAt,
    mode: "dry-run",
    network_requests_executed: 0,
    full_archives_downloaded: false,
    generation_id: generationId,
    data_root: normalize(input.dataRoot),
    download_authorization: input.downloadAuthorized ? "authorized" : "not-authorized",
    execution_ready: input.downloadAuthorized && input.capacityGate.status === "pass",
    capacity_gate: { ...input.capacityGate },
    known_download_bytes: knownDownloadBytes,
    layout: {
      incoming: {
        musicbrainz: `incoming/musicbrainz/${musicBrainz.snapshot_id}/`,
        discogs: `incoming/discogs/${discogs.snapshot_id}/`,
      },
      verified: {
        musicbrainz: `verified/musicbrainz/${musicBrainz.snapshot_id}/`,
        discogs: `verified/discogs/${discogs.snapshot_id}/`,
      },
      generation_stage: `generations/${generationId}/stage/`,
      generation_canonical: `generations/${generationId}/canonical/`,
      published: `published/${generationId}/`,
      state: `state/${generationId}.json`,
    },
    artifacts,
  };
  return {
    ...plan,
    plan_fingerprint: computeOfflineBootstrapPlanFingerprint(plan),
  };
}

export function computeOfflineBootstrapPlanFingerprint(
  plan:
    | OfflineBootstrapPlan
    | OfflineBootstrapMachinePlan
    | Omit<OfflineBootstrapPlan, "plan_fingerprint">,
): string {
  const { plan_fingerprint: ignored, ...payload } = plan as OfflineBootstrapPlan;
  void ignored;
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function buildOfflineBootstrapMachinePlan(
  plan: OfflineBootstrapPlan,
  metadata: OfflineBootstrapMachinePlanMetadata,
): OfflineBootstrapMachinePlan {
  const machinePlan: OfflineBootstrapMachinePlan = {
    ...plan,
    capacity_mode: metadata.capacity_mode,
    published_generation_reused: metadata.published_generation_reused,
    published_reuse_reason: metadata.published_reuse_reason,
    published_content_allocated_bytes: metadata.published_content_allocated_bytes,
    target_filesystem: { ...metadata.target_filesystem },
    evidence: { ...metadata.evidence },
  };
  return {
    ...machinePlan,
    plan_fingerprint: computeOfflineBootstrapPlanFingerprint(machinePlan),
  };
}

function validateInput(input: OfflineBootstrapPlanInput): void {
  assertIsoTimestamp(input.generatedAt, "generatedAt");
  assertAbsolutePath(input.repositoryRoot, "repositoryRoot");
  assertAbsolutePath(input.dataRoot, "dataRoot");
  assertDataRootOutsideRepository(input.repositoryRoot, input.dataRoot);
  if (typeof input.downloadAuthorized !== "boolean") {
    throw new Error("downloadAuthorized must be a boolean");
  }
  if (!/^[0-9a-f]{40}$/i.test(input.sourceConfig.musicbrainzSigningKeyFingerprint)) {
    throw new Error("Invalid MusicBrainz signing key fingerprint");
  }
  assertPositiveSafeInteger(input.sourceConfig.metadataMaxBytes, "metadataMaxBytes");
  assertPositiveSafeInteger(
    input.capacityGate.filesystem_capacity_bytes,
    "filesystem_capacity_bytes",
  );
  assertNonNegativeSafeInteger(
    input.capacityGate.filesystem_available_bytes,
    "filesystem_available_bytes",
  );
  assertPositiveSafeInteger(input.capacityGate.required_free_bytes, "required_free_bytes");
  if (input.capacityGate.status !== "pass" && input.capacityGate.status !== "blocked") {
    throw new Error(`Invalid capacity gate status: ${String(input.capacityGate.status)}`);
  }
  if (
    input.capacityGate.filesystem_available_bytes >
    input.capacityGate.filesystem_capacity_bytes
  ) {
    throw new Error("Filesystem available capacity cannot exceed filesystem capacity");
  }
  if (
    input.capacityGate.status === "pass" &&
    input.capacityGate.filesystem_available_bytes < input.capacityGate.required_free_bytes
  ) {
    throw new Error("A passing capacity gate must satisfy required free bytes");
  }

  const musicBrainz = input.sourceSnapshots.musicbrainz;
  const discogs = input.sourceSnapshots.discogs;
  if (!/^\d{8}-\d{6}$/.test(musicBrainz.snapshot_id)) {
    throw new Error(`Invalid MusicBrainz snapshot: ${musicBrainz.snapshot_id}`);
  }
  if (!/^\d{8}$/.test(discogs.snapshot_id)) {
    throw new Error(`Invalid Discogs snapshot: ${discogs.snapshot_id}`);
  }
  const musicBrainzUrl = assertOfficialDirectoryUrl(
    musicBrainz.directory_url,
    "data.metabrainz.org",
    "MusicBrainz",
  );
  if (!musicBrainzUrl.pathname.endsWith(`/${musicBrainz.snapshot_id}/`)) {
    throw new Error("MusicBrainz directory does not match the declared snapshot");
  }
  const discogsUrl = assertOfficialDirectoryUrl(
    discogs.directory_url,
    "data.discogs.com",
    "Discogs",
  );
  const discogsYear = discogs.snapshot_id.slice(0, 4);
  if (discogsUrl.searchParams.get("prefix") !== `data/${discogsYear}/`) {
    throw new Error("Discogs directory does not match the declared snapshot year");
  }

  for (const [source, files] of [
    ["MusicBrainz", musicBrainz.files],
    ["Discogs", discogs.files],
  ] as const) {
    for (const file of files) assertPositiveSafeInteger(file.bytes, `${source} ${file.name} bytes`);
  }
  for (const file of discogs.files) {
    const snapshot = file.name.match(/^discogs_(\d{8})_/)?.[1];
    if (!snapshot || snapshot !== discogs.snapshot_id) {
      throw new Error(`Discogs filename does not match the declared snapshot: ${file.name}`);
    }
  }

  const musicBrainzArchive = requireSourceFile(musicBrainz.files, MUSICBRAINZ_ARCHIVE);
  if (musicBrainzArchive.license_partition !== "musicbrainz-core-cc0") {
    throw new Error(`${MUSICBRAINZ_ARCHIVE} must use the musicbrainz-core-cc0 partition`);
  }
  const requiredDiscogsFiles = [
    `discogs_${discogs.snapshot_id}_CHECKSUM.txt`,
    ...DISCOGS_KINDS.map((kind) => `discogs_${discogs.snapshot_id}_${kind}.xml.gz`),
  ];
  for (const filename of requiredDiscogsFiles) {
    const file = requireSourceFile(discogs.files, filename);
    if (file.license_partition !== "discogs-cc0") {
      throw new Error(`${filename} must use the discogs-cc0 partition`);
    }
  }
}

function requireSourceFile(
  files: OfflineBootstrapSourceFile[],
  filename: string,
): OfflineBootstrapSourceFile {
  const matches = files.filter((file) => file.name === filename);
  if (matches.length !== 1) {
    throw new Error(`Required source artifact ${filename} must appear exactly once`);
  }
  return matches[0]!;
}

function sumKnownDownloadBytes(artifacts: OfflineBootstrapArtifact[]): number {
  let total = 0;
  for (const artifact of artifacts) {
    if (artifact.expected_bytes === null) continue;
    total += artifact.expected_bytes;
    if (!Number.isSafeInteger(total)) {
      throw new Error("known_download_bytes exceeds safe integer precision");
    }
  }
  return total;
}

function discogsDownloadUrl(
  directoryUrl: string,
  snapshotId: string,
  filename: string,
): string {
  const url = new URL(directoryUrl);
  url.searchParams.set("download", `data/${snapshotId.slice(0, 4)}/${filename}`);
  return url.toString();
}

function incomingPath(
  source: "musicbrainz" | "discogs",
  snapshotId: string,
  filename: string,
): string {
  return `incoming/${source}/${snapshotId}/${filename}`;
}

function assertIsoTimestamp(value: string, name: string): void {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime()) || timestamp.toISOString() !== value) {
    throw new Error(`${name} must be a canonical UTC ISO timestamp`);
  }
}

function assertAbsolutePath(value: string, name: string): void {
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
}

function assertDataRootOutsideRepository(repositoryRoot: string, dataRoot: string): void {
  const pathFromRepository = relative(normalize(repositoryRoot), normalize(dataRoot));
  const outsideRepository =
    pathFromRepository === ".." || pathFromRepository.startsWith(`..${sep}`);
  if (!outsideRepository) {
    throw new Error("dataRoot must be outside repositoryRoot");
  }
}

function assertOfficialDirectoryUrl(
  value: string,
  expectedHostname: string,
  source: string,
): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${source} directory_url must be a valid URL`);
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== expectedHostname ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new Error(`${source} directory_url must use the official HTTPS host`);
  }
  return url;
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
}

function assertNonNegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
}
