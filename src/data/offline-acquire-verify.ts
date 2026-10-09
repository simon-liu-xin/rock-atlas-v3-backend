import {
  constants,
} from "node:fs";
import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  stat,
  statfs,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, normalize, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  computeOfflineBootstrapPlanFingerprint,
  type OfflineBootstrapArtifact,
  type OfflineBootstrapMachinePlan,
} from "./offline-bootstrap-plan.ts";
import {
  inspectDownloadedOfflineGenerationArtifacts,
  verifyOfflineGenerationArtifacts,
  type OfflineArtifactVerificationReceipt,
} from "./offline-artifact-verifier.ts";
import {
  assertOfflineGenerationStateForPlan,
  createOfflineGenerationState,
  observeOfflineArtifact,
  type OfflineGenerationState,
} from "./offline-generation-state.ts";
import {
  downloadBoundedFile,
  downloadBoundedUnknownFile,
  type BoundedDownloadResult,
} from "./resumable-download.ts";

export interface OfflineAcquireVerifyOptions {
  readonly observedAt?: string;
  readonly timeoutMs?: number;
  readonly downloadAuthorization?: string;
  readonly gpgExecutable?: string;
  readonly gnupgHome?: string;
  readonly statFilesystem?: (
    path: string,
  ) => Promise<{ readonly bavail: number; readonly bsize: number; readonly blocks: number }>;
  readonly allowSourceUrl?: (url: string, artifact: OfflineBootstrapArtifact) => boolean;
  readonly download?: (
    artifact: OfflineBootstrapArtifact,
    destination: string,
  ) => Promise<BoundedDownloadResult>;
}

export const OFFLINE_FULL_ARCHIVE_DOWNLOAD_CONFIRMATION =
  "I_CONFIRM_FULL_ARCHIVE_DOWNLOAD";

const MUSICBRAINZ_SIGNING_KEY_FINGERPRINT =
  "D5E63B4BDCCE195642948684B8FC2375C777580F";
const BOOTSTRAP_REQUIRED_FREE_BYTES = 381_448_295_016;
const PROVISIONED_FILESYSTEM_BYTES = 512_000_000_000;
const MAX_INITIAL_PLAN_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_STATE_BYTES = 10_000_000;
const INCOMPLETE_LOCK_GRACE_MS = 5 * 60 * 1000;
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const execFileAsync = promisify(execFile);

export interface OfflineAcquireVerifySummary {
  readonly summary_version: "1.0";
  readonly mode: "offline-artifact-acquire-verify";
  readonly generation_id: string;
  readonly plan_fingerprint: string;
  readonly artifacts_total: number;
  readonly artifacts_downloaded_this_run: number;
  readonly artifacts_reused: number;
  readonly artifact_bytes_on_disk: number;
  readonly runtime_capacity_available_bytes: number;
  readonly runtime_capacity_credit_bytes: number;
  readonly runtime_capacity_required_bytes: number;
  readonly phase: "verified";
  readonly state_path: string;
  readonly published_state_updated: false;
}

export interface OfflineAcquireVerifyResult {
  readonly state: OfflineGenerationState;
  readonly verificationReceipt: OfflineArtifactVerificationReceipt;
  readonly summary: OfflineAcquireVerifySummary;
}

export async function acquireAndVerifyOfflineArtifacts(
  plan: OfflineBootstrapMachinePlan,
  options: OfflineAcquireVerifyOptions = {},
): Promise<OfflineAcquireVerifyResult> {
  const observedAt = options.observedAt ?? new Date().toISOString();
  assertCanonicalTimestamp(observedAt, "observedAt");
  const runtimeCapacity = await assertExecutionPreconditions(plan, observedAt, options);

  const dataRoot = runtimeCapacity.dataRoot;
  const statePath = resolveSafePath(dataRoot, plan.layout.state, "generation state");
  const stateDirectory = dirname(statePath);
  await assertNoSymlinkAncestors(dataRoot, stateDirectory, "generation state");
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await assertNoSymlinkAncestors(dataRoot, stateDirectory, "generation state");
  const resolvedStateDirectory = await realpath(stateDirectory);
  if (!isWithinRoot(dataRoot, resolvedStateDirectory)) {
    throw new Error("generation state path escapes data_root");
  }
  const releaseGenerationLock = await acquireGenerationLock(statePath, plan, observedAt);
  try {
  let state = await loadOrCreateState(dataRoot, statePath, plan, observedAt);
  if (state.phase === "publish-ready") {
    throw new Error("A publish-ready generation cannot be acquired again");
  }

  const download =
    options.download ??
    ((artifact: OfflineBootstrapArtifact, destination: string) => {
      const timeout = options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs };
      return artifact.expected_bytes === null
        ? downloadBoundedUnknownFile(artifact.source_url, destination, {
            maxBytes: artifact.max_bytes,
            ...timeout,
          })
        : downloadBoundedFile(artifact.source_url, destination, {
            expectedBytes: artifact.expected_bytes,
            maxBytes: artifact.max_bytes,
            ...timeout,
          });
    });

  const verifierOptions = {
    ...(options.gpgExecutable === undefined ? {} : { gpgExecutable: options.gpgExecutable }),
    ...(options.gnupgHome === undefined ? {} : { gnupgHome: options.gnupgHome }),
  };

  const requiredArtifacts = plan.artifacts.filter((item) => item.required);
  let artifactsDownloadedThisRun = 0;
  let artifactsReused = 0;
  if (state.phase !== "verified") {
    for (const artifact of requiredArtifacts) {
      const current = state.artifacts[artifact.artifact_id]!;
      if (current.status === "downloaded" || current.status === "verified") {
        artifactsReused += 1;
        continue;
      }
      const destination = resolveSafePath(dataRoot, artifact.destination_relative, artifact.artifact_id);
      await assertNoSymlinkAncestors(dataRoot, dirname(destination), artifact.artifact_id);
      const result = await download(artifact, destination);
      if (result.resumedFrom === result.bytes) artifactsReused += 1;
      else artifactsDownloadedThisRun += 1;
      if (current.status === "pending") {
        state = observeOfflineArtifact(state, plan, {
          artifact_id: artifact.artifact_id,
          bytes_on_disk: result.bytes,
          download_complete: false,
          observed_sha256: null,
          verification_evidence: null,
          observed_at: observedAt,
        });
        await persistState(dataRoot, statePath, state);
      }
      state = observeOfflineArtifact(state, plan, {
        artifact_id: artifact.artifact_id,
        bytes_on_disk: result.bytes,
        download_complete: true,
        observed_sha256: null,
        verification_evidence: null,
        observed_at: observedAt,
      });
      await persistState(dataRoot, statePath, state);
    }
  }

  if (state.phase === "downloaded") {
    const inspection = await inspectDownloadedOfflineGenerationArtifacts(
      plan,
      state,
      verifierOptions,
    );
    for (const artifact of verificationOrder(requiredArtifacts)) {
      if (state.artifacts[artifact.artifact_id]?.status === "verified") continue;
      const evidence = inspection[artifact.artifact_id];
      if (!evidence) throw new Error(`Inspection omitted artifact ${artifact.artifact_id}`);
      state = observeOfflineArtifact(state, plan, {
        artifact_id: artifact.artifact_id,
        bytes_on_disk: evidence.bytes,
        download_complete: true,
        observed_sha256: evidence.sha256,
        verification_evidence: evidence.verification_evidence,
        observed_at: observedAt,
      });
      await persistState(dataRoot, statePath, state);
    }
  }
  if (state.phase !== "verified") {
    throw new Error(`Artifact acquisition ended in unexpected phase ${state.phase}`);
  }
  if (artifactsDownloadedThisRun === 0 && artifactsReused === 0) {
    artifactsReused = requiredArtifacts.length;
  }
  const verificationReceipt = await verifyOfflineGenerationArtifacts(
    plan,
    state,
    observedAt,
    verifierOptions,
  );
  const artifactBytes = Object.values(state.artifacts).reduce(
    (total, artifact) => total + artifact.bytes_on_disk,
    0,
  );
  return {
    state,
    verificationReceipt,
    summary: {
      summary_version: "1.0",
      mode: "offline-artifact-acquire-verify",
      generation_id: plan.generation_id,
      plan_fingerprint: plan.plan_fingerprint,
      artifacts_total: requiredArtifacts.length,
      artifacts_downloaded_this_run: artifactsDownloadedThisRun,
      artifacts_reused: artifactsReused,
      artifact_bytes_on_disk: artifactBytes,
      runtime_capacity_available_bytes: runtimeCapacity.availableBytes,
      runtime_capacity_credit_bytes: runtimeCapacity.creditBytes,
      runtime_capacity_required_bytes: plan.capacity_gate.required_free_bytes,
      phase: "verified",
      state_path: statePath,
      published_state_updated: false,
    },
  };
  } finally {
    await releaseGenerationLock();
  }
}

async function assertExecutionPreconditions(
  plan: OfflineBootstrapMachinePlan,
  observedAt: string,
  options: OfflineAcquireVerifyOptions,
): Promise<{ availableBytes: number; creditBytes: number; dataRoot: string }> {
  assertMachinePlanContract(plan);
  assertRequiredArtifactContract(plan);
  if (computeOfflineBootstrapPlanFingerprint(plan) !== plan.plan_fingerprint) {
    throw new Error("Bootstrap plan fingerprint does not match its contents");
  }
  if (
    plan.download_authorization !== "authorized" ||
    plan.capacity_gate.status !== "pass" ||
    plan.execution_ready !== true
  ) {
    throw new Error("Bootstrap plan is not execution-ready for acquisition");
  }
  assertExecutableMachinePlanPolicy(plan);
  if (options.downloadAuthorization !== OFFLINE_FULL_ARCHIVE_DOWNLOAD_CONFIRMATION) {
    throw new Error("Offline acquisition requires the exact execution-time download confirmation");
  }
  assertSafeProductionDataRoot(plan.data_root);
  const required = plan.artifacts.filter((artifact) => artifact.required);
  if (required.length === 0 || new Set(required.map((artifact) => artifact.artifact_id)).size !== required.length) {
    throw new Error("Bootstrap plan must contain unique required artifacts");
  }
  for (const artifact of required) {
    validateRelativePath(artifact.destination_relative, artifact.artifact_id);
    const allowed = options.allowSourceUrl
      ? options.allowSourceUrl(artifact.source_url, artifact)
      : isOfficialSourceUrl(artifact.source_url, artifact, plan.generation_id);
    if (!allowed) throw new Error(`${artifact.artifact_id} source URL is not approved`);
  }
  validateRelativePath(plan.layout.state, "generation state");
  const dataRoot = await prepareDataRoot(plan.data_root);
  const dataRootStat = await stat(dataRoot);
  if (dataRootStat.dev !== plan.target_filesystem.filesystem_device_id) {
    throw new Error("Offline data_root is no longer on the planned filesystem device");
  }
  const statePath = resolveSafePath(dataRoot, plan.layout.state, "generation state");
  await assertNoSymlinkAncestors(dataRoot, dirname(statePath), "generation state");
  const existingState = await lstat(statePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existingState?.isSymbolicLink() || (existingState !== null && !existingState.isFile())) {
    throw new Error("Persisted offline generation state must be a regular non-symlink file");
  }
  if (existingState === null) assertInitialPlanFreshness(plan.generated_at, observedAt);

  const statFilesystem = options.statFilesystem ?? statfs;
  const [filesystem, creditBytes] = await Promise.all([
    statFilesystem(dataRoot),
    currentGenerationArtifactAllocation(plan),
  ]);
  const availableBytes = filesystem.bavail * filesystem.bsize;
  const capacityBytes = filesystem.blocks * filesystem.bsize;
  if (
    !Number.isSafeInteger(availableBytes) ||
    !Number.isSafeInteger(capacityBytes) ||
    !Number.isSafeInteger(creditBytes) ||
    capacityBytes < PROVISIONED_FILESYSTEM_BYTES ||
    capacityBytes !== plan.target_filesystem.filesystem_capacity_bytes ||
    availableBytes + creditBytes < plan.capacity_gate.required_free_bytes
  ) {
    throw new Error(
      `Runtime capacity gate has ${capacityBytes} total bytes and ${availableBytes} bytes available plus ${creditBytes} bytes of current-generation artifact allocation; it requires a ${PROVISIONED_FILESYSTEM_BYTES} byte device and ${plan.capacity_gate.required_free_bytes} free bytes`,
    );
  }
  return { availableBytes, creditBytes, dataRoot };
}

function assertMachinePlanContract(plan: OfflineBootstrapMachinePlan): void {
  requireExactKeys(plan, [
    "plan_version",
    "generated_at",
    "mode",
    "network_requests_executed",
    "full_archives_downloaded",
    "generation_id",
    "plan_fingerprint",
    "data_root",
    "download_authorization",
    "execution_ready",
    "capacity_gate",
    "known_download_bytes",
    "layout",
    "artifacts",
    "capacity_mode",
    "published_generation_reused",
    "published_reuse_reason",
    "published_content_allocated_bytes",
    "target_filesystem",
    "evidence",
  ], "Bootstrap machine plan");
  requireExactKeys(plan.capacity_gate, [
    "status",
    "filesystem_capacity_bytes",
    "filesystem_available_bytes",
    "required_free_bytes",
  ], "Bootstrap machine plan capacity_gate");
  requireExactKeys(plan.target_filesystem, [
    "requested_data_root",
    "resolved_data_root",
    "probe_path",
    "filesystem_device_id",
    "filesystem_capacity_bytes",
    "filesystem_available_bytes",
  ], "Bootstrap machine plan target_filesystem");
  requireExactKeys(plan.evidence, [
    "capacity_snapshot_path",
    "published_state_path",
    "tracked_qid_manifest_path",
    "source_config_path",
  ], "Bootstrap machine plan evidence");
  requireExactKeys(plan.layout, [
    "incoming",
    "verified",
    "generation_stage",
    "generation_canonical",
    "published",
    "state",
  ], "Bootstrap machine plan layout");
  requireExactKeys(plan.layout.incoming, ["musicbrainz", "discogs"], "Bootstrap incoming layout");
  requireExactKeys(plan.layout.verified, ["musicbrainz", "discogs"], "Bootstrap verified layout");
  assertCanonicalTimestamp(plan.generated_at, "Bootstrap machine plan generated_at");
}

function assertExecutableMachinePlanPolicy(plan: OfflineBootstrapMachinePlan): void {
  if (
    plan.capacity_mode !== "bootstrap" ||
    plan.published_generation_reused !== false ||
    plan.published_reuse_reason !== "no-published-generation" ||
    plan.published_content_allocated_bytes !== 0
  ) {
    throw new Error("Offline acquisition v1 only accepts a bootstrap machine plan without published reuse");
  }
  if (
    plan.data_root !== normalize(plan.data_root) ||
    plan.target_filesystem.requested_data_root !== plan.data_root ||
    plan.target_filesystem.resolved_data_root !== plan.data_root ||
    plan.target_filesystem.probe_path !== plan.data_root
  ) {
    throw new Error("Bootstrap machine plan data_root and target filesystem paths are inconsistent");
  }
  if (
    !Number.isSafeInteger(plan.target_filesystem.filesystem_device_id) ||
    plan.target_filesystem.filesystem_device_id < 0 ||
    plan.target_filesystem.filesystem_capacity_bytes !==
      plan.capacity_gate.filesystem_capacity_bytes ||
    plan.target_filesystem.filesystem_available_bytes !==
      plan.capacity_gate.filesystem_available_bytes ||
    plan.capacity_gate.required_free_bytes !== BOOTSTRAP_REQUIRED_FREE_BYTES ||
    plan.capacity_gate.filesystem_capacity_bytes < PROVISIONED_FILESYSTEM_BYTES ||
    plan.capacity_gate.filesystem_available_bytes < BOOTSTRAP_REQUIRED_FREE_BYTES
  ) {
    throw new Error("Bootstrap machine plan does not satisfy the production capacity policy");
  }
  const expectedEvidence = {
    capacity_snapshot_path: "data/sources/offline-db-capacity-v1.json",
    published_state_path: "data/sources/offline-published-state-v1.json",
    tracked_qid_manifest_path: "data/sources/offline-poc/manifest.json",
    source_config_path: "config/offline-data-sources-v1.json",
  };
  if (JSON.stringify(plan.evidence) !== JSON.stringify(expectedEvidence)) {
    throw new Error("Bootstrap machine plan evidence paths are not the production evidence set");
  }
}

function assertRequiredArtifactContract(plan: OfflineBootstrapMachinePlan): void {
  const generation = /^mb-(\d{8}-\d{6})__discogs-(\d{8})$/.exec(plan.generation_id);
  if (
    plan.plan_version !== "1.0" ||
    plan.mode !== "dry-run" ||
    plan.network_requests_executed !== 0 ||
    plan.full_archives_downloaded !== false ||
    !generation ||
    !Array.isArray(plan.artifacts)
  ) {
    throw new Error("Bootstrap v1 required artifact contract is malformed");
  }
  const musicBrainzSnapshot = generation[1]!;
  const discogsSnapshot = generation[2]!;
  const expected = [
    {
      artifact_id: "musicbrainz:mbdump.tar.bz2",
      source: "musicbrainz",
      role: "archive",
      filename: "mbdump.tar.bz2",
      destination: `incoming/musicbrainz/${musicBrainzSnapshot}/mbdump.tar.bz2`,
      license: "musicbrainz-core-cc0",
      method: "sha256-signed-manifest",
    },
    {
      artifact_id: "musicbrainz:SHA256SUMS",
      source: "musicbrainz",
      role: "checksum-manifest",
      filename: "SHA256SUMS",
      destination: `incoming/musicbrainz/${musicBrainzSnapshot}/SHA256SUMS`,
      license: "musicbrainz-core-cc0",
      method: "signed-metadata",
    },
    {
      artifact_id: "musicbrainz:SHA256SUMS.asc",
      source: "musicbrainz",
      role: "signature",
      filename: "SHA256SUMS.asc",
      destination: `incoming/musicbrainz/${musicBrainzSnapshot}/SHA256SUMS.asc`,
      license: "musicbrainz-core-cc0",
      method: "transport-size-only",
    },
    {
      artifact_id: "discogs:CHECKSUM",
      source: "discogs",
      role: "checksum-manifest",
      filename: `discogs_${discogsSnapshot}_CHECKSUM.txt`,
      destination: `incoming/discogs/${discogsSnapshot}/discogs_${discogsSnapshot}_CHECKSUM.txt`,
      license: "discogs-cc0",
      method: "transport-size-only",
    },
    ...["artists", "labels", "masters", "releases"].map((kind) => ({
      artifact_id: `discogs:${kind}`,
      source: "discogs",
      role: "archive",
      filename: `discogs_${discogsSnapshot}_${kind}.xml.gz`,
      destination: `incoming/discogs/${discogsSnapshot}/discogs_${discogsSnapshot}_${kind}.xml.gz`,
      license: "discogs-cc0",
      method: "sha256-manifest",
    })),
  ];
  for (const artifact of plan.artifacts) {
    requireExactKeys(artifact, [
      "artifact_id",
      "source",
      "role",
      "required",
      "filename",
      "source_url",
      "expected_bytes",
      "max_bytes",
      "destination_relative",
      "license_partition",
      "verification",
    ], `${artifact.artifact_id ?? "unknown artifact"} contract`);
    const verificationKeys =
      artifact.verification.method === "transport-size-only"
        ? ["method"]
        : artifact.verification.method === "sha256-manifest"
          ? ["method", "checksum_artifact_id"]
          : artifact.verification.method === "signed-metadata"
            ? ["method", "signature_artifact_id", "trusted_fingerprint"]
            : [
                "method",
                "checksum_artifact_id",
                "signature_artifact_id",
                "trusted_fingerprint",
              ];
    requireExactKeys(artifact.verification, verificationKeys, `${artifact.artifact_id} verification`);
  }
  if (
    plan.artifacts.length !== expected.length ||
    plan.artifacts.some((artifact, index) => {
      const contract = expected[index]!;
      return (
        artifact.artifact_id !== contract.artifact_id ||
        artifact.source !== contract.source ||
        artifact.role !== contract.role ||
        artifact.required !== true ||
        artifact.filename !== contract.filename ||
        artifact.destination_relative !== contract.destination ||
        artifact.license_partition !== contract.license ||
        artifact.verification?.method !== contract.method ||
        !Number.isSafeInteger(artifact.max_bytes) ||
        artifact.max_bytes < 1 ||
        ((artifact.artifact_id === "musicbrainz:SHA256SUMS" ||
          artifact.artifact_id === "musicbrainz:SHA256SUMS.asc") !==
          (artifact.expected_bytes === null)) ||
        ((artifact.artifact_id === "musicbrainz:SHA256SUMS" ||
          artifact.artifact_id === "musicbrainz:SHA256SUMS.asc") &&
          artifact.max_bytes !== MAX_STATE_BYTES) ||
        (artifact.expected_bytes !== null &&
          (!Number.isSafeInteger(artifact.expected_bytes) ||
            artifact.expected_bytes < 1 ||
            artifact.expected_bytes !== artifact.max_bytes))
      );
    })
  ) {
    throw new Error("Bootstrap v1 required artifact contract must contain the exact eight artifacts");
  }
  const byId = new Map(plan.artifacts.map((artifact) => [artifact.artifact_id, artifact]));
  const archiveVerification = byId.get("musicbrainz:mbdump.tar.bz2")!.verification;
  const checksumVerification = byId.get("musicbrainz:SHA256SUMS")!.verification;
  const fingerprint =
    archiveVerification.method === "sha256-signed-manifest"
      ? archiveVerification.trusted_fingerprint
      : "";
  if (
    archiveVerification.method !== "sha256-signed-manifest" ||
    archiveVerification.checksum_artifact_id !== "musicbrainz:SHA256SUMS" ||
    archiveVerification.signature_artifact_id !== "musicbrainz:SHA256SUMS.asc" ||
    checksumVerification.method !== "signed-metadata" ||
    checksumVerification.signature_artifact_id !== "musicbrainz:SHA256SUMS.asc" ||
    checksumVerification.trusted_fingerprint !== fingerprint ||
    fingerprint !== MUSICBRAINZ_SIGNING_KEY_FINGERPRINT ||
    ["artists", "labels", "masters", "releases"].some((kind) => {
      const verification = byId.get(`discogs:${kind}`)!.verification;
      return (
        verification.method !== "sha256-manifest" ||
        verification.checksum_artifact_id !== "discogs:CHECKSUM"
      );
    })
  ) {
    throw new Error("Bootstrap v1 required artifact contract has invalid verification dependencies");
  }
  const knownDownloadBytes = plan.artifacts.reduce(
    (total, artifact) => total + (artifact.expected_bytes ?? 0),
    0,
  );
  if (
    !Number.isSafeInteger(knownDownloadBytes) ||
    plan.known_download_bytes !== knownDownloadBytes ||
    (plan.download_authorization !== "authorized" &&
      plan.download_authorization !== "not-authorized") ||
    (plan.capacity_gate.status !== "pass" && plan.capacity_gate.status !== "blocked") ||
    !Number.isSafeInteger(plan.capacity_gate.filesystem_capacity_bytes) ||
    plan.capacity_gate.filesystem_capacity_bytes < 1 ||
    !Number.isSafeInteger(plan.capacity_gate.filesystem_available_bytes) ||
    plan.capacity_gate.filesystem_available_bytes < 0 ||
    plan.capacity_gate.filesystem_available_bytes >
      plan.capacity_gate.filesystem_capacity_bytes ||
    !Number.isSafeInteger(plan.capacity_gate.required_free_bytes) ||
    plan.capacity_gate.required_free_bytes < knownDownloadBytes ||
    plan.execution_ready !==
      (plan.download_authorization === "authorized" && plan.capacity_gate.status === "pass")
  ) {
    throw new Error("Bootstrap v1 required artifact contract has inconsistent execution totals");
  }
  const expectedLayout = {
    incoming: {
      musicbrainz: `incoming/musicbrainz/${musicBrainzSnapshot}/`,
      discogs: `incoming/discogs/${discogsSnapshot}/`,
    },
    verified: {
      musicbrainz: `verified/musicbrainz/${musicBrainzSnapshot}/`,
      discogs: `verified/discogs/${discogsSnapshot}/`,
    },
    generation_stage: `generations/${plan.generation_id}/stage/`,
    generation_canonical: `generations/${plan.generation_id}/canonical/`,
    published: `published/${plan.generation_id}/`,
    state: `state/${plan.generation_id}.json`,
  };
  if (JSON.stringify(plan.layout) !== JSON.stringify(expectedLayout)) {
    throw new Error("Bootstrap v1 required artifact contract has an invalid generation layout");
  }
}

async function currentGenerationArtifactAllocation(plan: OfflineBootstrapMachinePlan): Promise<number> {
  const rootState = await lstat(plan.data_root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (rootState === null) return 0;
  if (rootState.isSymbolicLink() || !rootState.isDirectory()) {
    throw new Error("Offline data_root must be a non-symlink directory");
  }
  const root = await realpath(plan.data_root);
  const seenFiles = new Set<string>();
  let allocatedBytes = 0;
  for (const artifact of plan.artifacts.filter((item) => item.required)) {
    const destination = resolveSafePath(root, artifact.destination_relative, artifact.artifact_id);
    const completed = await allocatedArtifactFile(root, destination, artifact, false, seenFiles);
    const allocation =
      completed ??
      (await allocatedArtifactFile(root, `${destination}.part`, artifact, true, seenFiles)) ??
      0;
    allocatedBytes += allocation;
    if (!Number.isSafeInteger(allocatedBytes)) {
      throw new Error("Runtime capacity credit exceeds safe integer precision");
    }
  }
  return allocatedBytes;
}

async function allocatedArtifactFile(
  root: string,
  path: string,
  artifact: OfflineBootstrapArtifact,
  partial: boolean,
  seenFiles: Set<string>,
): Promise<number | null> {
  await assertNoSymlinkAncestors(root, dirname(path), artifact.artifact_id);
  const state = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (state === null) return null;
  if (state.isSymbolicLink() || !state.isFile()) {
    throw new Error(`${artifact.artifact_id} capacity credit path must be a regular non-symlink file`);
  }
  const resolved = await realpath(path);
  if (!isWithinRoot(root, resolved)) {
    throw new Error(`${artifact.artifact_id} capacity credit path escapes data_root`);
  }
  if (
    state.size > artifact.max_bytes ||
    (!partial && state.size < 1) ||
    (!partial && artifact.expected_bytes !== null && state.size !== artifact.expected_bytes)
  ) {
    throw new Error(`${artifact.artifact_id} capacity credit file is outside planned size bounds`);
  }
  const identity = `${state.dev}:${state.ino}`;
  if (seenFiles.has(identity)) return 0;
  seenFiles.add(identity);
  const blocks = state.blocks;
  if (!Number.isSafeInteger(blocks) || blocks < 0) return 0;
  const bytes = blocks * 512;
  return Number.isSafeInteger(bytes) ? bytes : 0;
}

async function prepareDataRoot(requestedPath: string): Promise<string> {
  const existing = await lstat(requestedPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing === null) {
    throw new Error("Offline data_root must already exist on the planned filesystem before acquisition");
  }
  if (existing.isSymbolicLink() || !existing.isDirectory()) {
    throw new Error("Offline data_root must be a non-symlink directory");
  }
  const resolved = await realpath(requestedPath);
  if (resolved !== requestedPath) {
    throw new Error("Offline data_root must be the canonical resolved path from the machine plan");
  }
  return resolved;
}

async function loadOrCreateState(
  dataRoot: string,
  statePath: string,
  plan: OfflineBootstrapMachinePlan,
  observedAt: string,
): Promise<OfflineGenerationState> {
  const bytes = await readBoundedRegularFile(statePath, MAX_STATE_BYTES, "offline generation state");
  if (bytes === null) {
    const state = createOfflineGenerationState(plan, observedAt);
    await persistState(dataRoot, statePath, state);
    return state;
  }
  let state: OfflineGenerationState;
  try {
    state = JSON.parse(bytes.toString("utf8")) as OfflineGenerationState;
  } catch {
    throw new Error("Persisted offline generation state is not valid JSON");
  }
  assertOfflineGenerationStateForPlan(state, plan);
  return state;
}

let stateWriteSequence = 0;

async function persistState(
  dataRoot: string,
  statePath: string,
  state: OfflineGenerationState,
): Promise<void> {
  const stateDirectory = dirname(statePath);
  await assertNoSymlinkAncestors(dataRoot, stateDirectory, "generation state");
  if (!isWithinRoot(dataRoot, await realpath(stateDirectory))) {
    throw new Error("generation state path escapes data_root");
  }
  const temporaryPath = `${statePath}.tmp-${process.pid}-${stateWriteSequence++}`;
  try {
    const handle = await open(
      temporaryPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await assertNoSymlinkAncestors(dataRoot, stateDirectory, "generation state");
    await rename(temporaryPath, statePath);
    const directoryHandle = await open(stateDirectory, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readBoundedRegularFile(
  path: string,
  maxBytes: number,
  label: string,
): Promise<Buffer | null> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`${label} must be a regular file`);
    if (before.size > maxBytes) throw new Error(`${label} exceeds the ${maxBytes} byte limit`);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      bytes.byteLength !== after.size
    ) {
      throw new Error(`${label} changed while it was read`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

interface GenerationLockRecord {
  readonly version: "1.0";
  readonly generation_id: string;
  readonly plan_fingerprint: string;
  readonly pid: number;
  readonly process_started_at: string;
  readonly started_at: string;
}

async function acquireGenerationLock(
  statePath: string,
  plan: OfflineBootstrapMachinePlan,
  startedAt: string,
): Promise<() => Promise<void>> {
  const lockPath = `${statePath}.lock`;
  const processStartedAt = await requireProcessStartTime(process.pid);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = await open(
        lockPath,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      const record: GenerationLockRecord = {
        version: "1.0",
        generation_id: plan.generation_id,
        plan_fingerprint: plan.plan_fingerprint,
        pid: process.pid,
        process_started_at: processStartedAt,
        started_at: startedAt,
      };
      let identity: Awaited<ReturnType<typeof handle.stat>> | null = null;
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
        await handle.sync();
        identity = await handle.stat();
        return async () => {
          const current = await lstat(lockPath).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return null;
            throw error;
          });
          if (current && current.dev === identity!.dev && current.ino === identity!.ino) {
            await unlink(lockPath);
          }
        };
      } catch (error) {
        identity ??= await handle.stat().catch(() => null);
        if (identity) await unlinkIfIdentityMatches(lockPath, identity);
        throw error;
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const staleIdentity = await inspectExistingGenerationLock(lockPath, plan);
      if (staleIdentity === null) {
        throw new Error(`Offline acquisition is already running for ${plan.generation_id}`);
      }
      const current = await lstat(lockPath).catch((lockError: NodeJS.ErrnoException) => {
        if (lockError.code === "ENOENT") return null;
        throw lockError;
      });
      if (
        current &&
        current.dev === staleIdentity.dev &&
        current.ino === staleIdentity.ino
      ) {
        await unlink(lockPath);
      }
    }
  }
  throw new Error(`Could not safely acquire the generation lock for ${plan.generation_id}`);
}

async function inspectExistingGenerationLock(
  lockPath: string,
  plan: OfflineBootstrapMachinePlan,
): Promise<{ dev: number; ino: number } | null> {
  const handle = await open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
  if (handle === null) {
    throw new Error("Existing generation lock is not a readable regular non-symlink file");
  }
  try {
    const identity = await handle.stat();
    if (!identity.isFile() || identity.size > 4_096) {
      return incompleteLockDisposition(identity);
    }
    let record: GenerationLockRecord;
    try {
      record = JSON.parse((await handle.readFile()).toString("utf8")) as GenerationLockRecord;
    } catch {
      return incompleteLockDisposition(identity);
    }
    requireExactKeys(record, [
      "version",
      "generation_id",
      "plan_fingerprint",
      "pid",
      "process_started_at",
      "started_at",
    ], "Existing generation lock");
    if (
      record.version !== "1.0" ||
      record.generation_id !== plan.generation_id ||
      record.plan_fingerprint !== plan.plan_fingerprint ||
      !Number.isSafeInteger(record.pid) ||
      record.pid < 1
    ) {
      throw new Error("Existing generation lock does not match this machine plan");
    }
    assertCanonicalTimestamp(record.started_at, "Existing generation lock started_at");
    assertCanonicalTimestamp(
      record.process_started_at,
      "Existing generation lock process_started_at",
    );
    if (isProcessAlive(record.pid)) {
      const currentStart = await readProcessStartTime(record.pid);
      if (currentStart === null || currentStart === record.process_started_at) return null;
    }
    return { dev: identity.dev, ino: identity.ino };
  } finally {
    await handle.close();
  }
}

function incompleteLockDisposition(
  identity: { readonly dev: number; readonly ino: number; readonly mtimeMs: number },
): { dev: number; ino: number } {
  if (Date.now() - identity.mtimeMs <= INCOMPLETE_LOCK_GRACE_MS) {
    throw new Error("Generation lock is still initializing; retry after the lock grace period");
  }
  return { dev: identity.dev, ino: identity.ino };
}

async function unlinkIfIdentityMatches(
  path: string,
  identity: { readonly dev: number; readonly ino: number },
): Promise<void> {
  const current = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (current && current.dev === identity.dev && current.ino === identity.ino) {
    await unlink(path);
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function requireProcessStartTime(pid: number): Promise<string> {
  const startedAt = await readProcessStartTime(pid);
  if (startedAt === null) {
    throw new Error(`Could not establish process start identity for generation lock PID ${pid}`);
  }
  return startedAt;
}

async function readProcessStartTime(pid: number): Promise<string | null> {
  try {
    const result = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)], {
      timeout: 5_000,
    });
    const raw = result.stdout.trim();
    const timestamp = new Date(raw);
    if (raw.length === 0 || Number.isNaN(timestamp.getTime())) return null;
    return timestamp.toISOString();
  } catch {
    return null;
  }
}

function verificationOrder(artifacts: readonly OfflineBootstrapArtifact[]): OfflineBootstrapArtifact[] {
  const remaining = new Map(artifacts.map((artifact) => [artifact.artifact_id, artifact]));
  const emitted = new Set<string>();
  const ordered: OfflineBootstrapArtifact[] = [];
  while (remaining.size > 0) {
    let advanced = false;
    for (const [artifactId, artifact] of remaining) {
      const dependencies = verificationDependencies(artifact);
      if (dependencies.every((dependency) => emitted.has(dependency))) {
        ordered.push(artifact);
        emitted.add(artifactId);
        remaining.delete(artifactId);
        advanced = true;
      }
    }
    if (!advanced) throw new Error("Artifact verification dependencies contain a cycle or missing id");
  }
  return ordered;
}

function verificationDependencies(artifact: OfflineBootstrapArtifact): string[] {
  const verification = artifact.verification;
  if (verification.method === "transport-size-only") return [];
  if (verification.method === "signed-metadata") return [verification.signature_artifact_id];
  if (verification.method === "sha256-manifest") return [verification.checksum_artifact_id];
  return [verification.checksum_artifact_id, verification.signature_artifact_id];
}

function resolveSafePath(root: string, relativePath: string, label: string): string {
  validateRelativePath(relativePath, label);
  const candidate = resolve(root, relativePath);
  const difference = relative(root, candidate);
  if (difference.startsWith(`..${sep}`) || difference === ".." || isAbsolute(difference)) {
    throw new Error(`${label} path escapes data_root`);
  }
  return candidate;
}

function isWithinRoot(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return (
    difference === "" ||
    (!difference.startsWith(`..${sep}`) && difference !== ".." && !isAbsolute(difference))
  );
}

function validateRelativePath(path: string, label: string): void {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    isAbsolute(path) ||
    path.split(/[\\/]/).some((component) => component === "" || component === "." || component === "..")
  ) {
    throw new Error(`${label} must use a safe relative path`);
  }
}

async function assertNoSymlinkAncestors(root: string, directory: string, label: string): Promise<void> {
  const difference = relative(root, directory);
  let current = root;
  for (const component of difference.split(sep)) {
    if (!component) continue;
    current = resolve(current, component);
    const state = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (state?.isSymbolicLink()) throw new Error(`${label} path contains a symbolic link`);
  }
}

function isOfficialSourceUrl(
  url: string,
  artifact: OfflineBootstrapArtifact,
  generationId: string,
): boolean {
  try {
    const parsed = new URL(url);
    const expectedHost =
      artifact.source === "musicbrainz" ? "data.metabrainz.org" : "data.discogs.com";
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname !== expectedHost ||
      parsed.port !== "" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.hash !== ""
    ) return false;
    if (artifact.source === "musicbrainz") {
      const snapshot = /^mb-(\d{8}-\d{6})__discogs-\d{8}$/.exec(generationId)?.[1];
      return (
        snapshot !== undefined &&
        parsed.search === "" &&
        parsed.pathname ===
          `/pub/musicbrainz/data/fullexport/${snapshot}/${artifact.filename}`
      );
    }
    const snapshot = /^discogs_(\d{8})_/.exec(artifact.filename)?.[1];
    const queryKeys = [...parsed.searchParams.keys()].sort();
    return (
      snapshot !== undefined &&
      generationId.endsWith(`__discogs-${snapshot}`) &&
      parsed.pathname === "/" &&
      queryKeys.length === 2 &&
      queryKeys[0] === "download" &&
      queryKeys[1] === "prefix" &&
      parsed.searchParams.get("prefix") === `data/${snapshot.slice(0, 4)}/` &&
      parsed.searchParams.get("download") ===
        `data/${snapshot.slice(0, 4)}/${artifact.filename}`
    );
  } catch {
    return false;
  }
}

function assertSafeProductionDataRoot(path: string): void {
  if (!isAbsolute(path)) throw new Error("Bootstrap data_root must be absolute");
  const normalized = normalize(path);
  if (normalized !== path || dirname(normalized) === normalized || normalized === homedir()) {
    throw new Error("Bootstrap data_root must be a dedicated canonical directory, not a broad root");
  }
  if (isWithinRoot(REPOSITORY_ROOT, normalized)) {
    throw new Error("Bootstrap data_root must resolve outside the repository");
  }
}

function assertInitialPlanFreshness(generatedAt: string, observedAt: string): void {
  const age = Date.parse(observedAt) - Date.parse(generatedAt);
  if (age < 0) throw new Error("Bootstrap machine plan cannot be newer than execution time");
  if (age > MAX_INITIAL_PLAN_AGE_MS) {
    throw new Error("Bootstrap machine plan is stale; regenerate it before initial acquisition");
  }
}

function requireExactKeys(value: object, expectedKeys: readonly string[], label: string): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${label} must contain exactly the supported keys`);
  }
}

function assertCanonicalTimestamp(value: string, name: string): void {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime()) || timestamp.toISOString() !== value) {
    throw new Error(`${name} must be a canonical UTC ISO timestamp`);
  }
}
