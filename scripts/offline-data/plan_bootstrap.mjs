import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  statfs,
  unlink,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildOfflineBootstrapMachinePlan,
  buildOfflineBootstrapPlan,
} from "../../src/data/offline-bootstrap-plan.ts";
import { buildOfflineUpdatePlan } from "../../src/data/offline-update-plan.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const evidencePaths = {
  capacity: "data/sources/offline-db-capacity-v1.json",
  publishedState: "data/sources/offline-published-state-v1.json",
  trackedQidManifest: "data/sources/offline-poc/manifest.json",
  sourceConfig: "config/offline-data-sources-v1.json",
};
const DOWNLOAD_AUTHORIZATION_CONFIRMATION = "I_CONFIRM_FULL_ARCHIVE_DOWNLOAD";

await main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Error: ${message}\n`);
  process.exitCode = 1;
});

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const dataRoot = normalize(options.dataRoot);
  const requestedOutputPath = options.output
    ? isAbsolute(options.output)
      ? normalize(options.output)
      : resolve(repositoryRoot, options.output)
    : null;
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const evidenceRoot = resolveEvidenceRoot();
  const capacityPath = resolve(evidenceRoot, evidencePaths.capacity);
  const publishedStatePath = resolve(evidenceRoot, evidencePaths.publishedState);
  const trackedQidManifestPath = resolve(evidenceRoot, evidencePaths.trackedQidManifest);
  const sourceConfigPath = resolve(evidenceRoot, evidencePaths.sourceConfig);
  const protectedEvidencePaths = [
    capacityPath,
    publishedStatePath,
    trackedQidManifestPath,
    sourceConfigPath,
  ];
  const targetPath = await resolveProspectiveDirectoryPath(dataRoot);
  if (options.downloadAuthorization === DOWNLOAD_AUTHORIZATION_CONFIRMATION) {
    await assertAuthorizedTargetRoot(dataRoot, targetPath);
  }
  const resolvedRepositoryRoot = await realpath(repositoryRoot);
  if (isPathAtOrWithin(resolvedRepositoryRoot, targetPath.resolved_path)) {
    throw new Error("--data-root must resolve outside the repository");
  }
  const outputTarget = requestedOutputPath
    ? await validateOutputPath(
        requestedOutputPath,
        targetPath.resolved_path,
        protectedEvidencePaths,
      )
    : null;

  const probePath = targetPath.probe_path;
  const [
    capacityJson,
    publishedStateJson,
    pocManifestJson,
    sourceConfigJson,
    filesystem,
    filesystemPathStat,
  ] =
    await Promise.all([
      readJson(capacityPath, "Capacity snapshot"),
      readJson(publishedStatePath, "Published state"),
      readJson(trackedQidManifestPath, "PoC manifest"),
      readJson(sourceConfigPath, "Source config"),
      statfs(probePath),
      stat(probePath),
    ]);
  const capacitySnapshot = validateCapacitySnapshot(capacityJson);
  const publishedState = await validatePublishedState(publishedStateJson);
  const pocManifest = validatePocManifest(pocManifestJson);
  const sourceConfig = validateSourceConfig(sourceConfigJson);
  const filesystemCapacityBytes = checkedFilesystemBytes(
    filesystem.blocks,
    filesystem.bsize,
    "capacity",
  );
  const filesystemAvailableBytes = checkedFilesystemBytes(
    filesystem.bavail,
    filesystem.bsize,
    "available capacity",
  );
  if (!Number.isSafeInteger(filesystemPathStat.dev) || filesystemPathStat.dev < 0) {
    throw new Error("Target filesystem device id is not a non-negative safe integer");
  }
  const assessment = capacitySnapshot.assessment.recommended;
  const publishedReuse = await inspectPublishedGenerationReuse(
    publishedState,
    targetPath.resolved_path,
    assessment.estimated_stable_working_bytes,
  );
  const publishedGenerationReused = publishedReuse.reused;
  const updatePlan = buildOfflineUpdatePlan({
    generatedAt,
    discoveredAt: capacitySnapshot.generated_at,
    current: {
      musicbrainzSnapshot: publishedGenerationReused
        ? publishedState.sources.musicbrainz.snapshot_id
        : null,
      discogsSnapshot: publishedGenerationReused
        ? publishedState.sources.discogs.snapshot_id
        : null,
    },
    discovered: {
      musicbrainzSnapshot: capacitySnapshot.source_snapshots.musicbrainz.snapshot_id,
      discogsSnapshot: capacitySnapshot.source_snapshots.discogs.snapshot_id,
    },
    trackedQids: pocManifest.sources.wikidata.tracked_qids,
    filesystemCapacityBytes,
    filesystemAvailableBytes,
    capacity: {
      estimatedStableWorkingBytes: assessment.estimated_stable_working_bytes,
      estimatedPeakWorkingBytes: assessment.estimated_peak_working_bytes,
      provisionedDiskBytes: assessment.provisioned_disk_bytes,
    },
  });
  const capacityGate = updatePlan.capacity_gate;
  const bootstrapPlan = buildOfflineBootstrapPlan({
    generatedAt,
    repositoryRoot,
    dataRoot: targetPath.resolved_path,
    downloadAuthorized:
      options.downloadAuthorization === DOWNLOAD_AUTHORIZATION_CONFIRMATION,
    capacityGate: {
      status: capacityGate.status,
      filesystem_capacity_bytes: capacityGate.filesystem_capacity_bytes,
      filesystem_available_bytes: capacityGate.filesystem_available_bytes,
      required_free_bytes: capacityGate.required_free_bytes,
    },
    sourceConfig: {
      musicbrainzSigningKeyFingerprint:
        sourceConfig.sources.musicbrainz.signing_key_fingerprint,
      metadataMaxBytes: sourceConfig.sources.musicbrainz.metadata_max_bytes,
    },
    sourceSnapshots: {
      musicbrainz: capacitySnapshot.source_snapshots.musicbrainz,
      discogs: capacitySnapshot.source_snapshots.discogs,
    },
  });
  if (assessment.required_archive_bytes !== bootstrapPlan.known_download_bytes) {
    throw new Error(
      "Capacity snapshot required_archive_bytes does not match bootstrap plan known_download_bytes",
    );
  }
  const report = buildOfflineBootstrapMachinePlan(bootstrapPlan, {
    capacity_mode: updatePlan.mode,
    published_generation_reused: publishedGenerationReused,
    published_reuse_reason: publishedReuse.reason,
    published_content_allocated_bytes: publishedReuse.allocated_bytes,
    target_filesystem: {
      requested_data_root: dataRoot,
      resolved_data_root: targetPath.resolved_path,
      probe_path: probePath,
      filesystem_device_id: filesystemPathStat.dev,
      filesystem_capacity_bytes: filesystemCapacityBytes,
      filesystem_available_bytes: filesystemAvailableBytes,
    },
    evidence: {
      capacity_snapshot_path: evidencePaths.capacity,
      published_state_path: evidencePaths.publishedState,
      tracked_qid_manifest_path: evidencePaths.trackedQidManifest,
      source_config_path: evidencePaths.sourceConfig,
    },
  });
  const serialized = `${JSON.stringify(report, null, 2)}\n`;

  if (outputTarget) {
    await writeOutputAtomically(
      outputTarget.path,
      serialized,
      outputTarget.existing_mode,
    );
  }
  process.stdout.write(serialized);
}

async function assertAuthorizedTargetRoot(requestedPath, targetPath) {
  const entry = await lstat(requestedPath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (entry === null || entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error(
      "--download-authorization requires --data-root to be an existing non-symlink directory",
    );
  }
  const canonical = await realpath(requestedPath);
  if (
    normalize(requestedPath) !== canonical ||
    targetPath.resolved_path !== canonical ||
    targetPath.probe_path !== canonical
  ) {
    throw new Error(
      "--download-authorization requires --data-root to use its canonical mounted path",
    );
  }
}

function parseArguments(argv) {
  const options = {
    dataRoot: null,
    output: null,
    generatedAt: null,
    downloadAuthorization: null,
  };
  const names = {
    "--data-root": "dataRoot",
    "--output": "output",
    "--generated-at": "generatedAt",
    "--download-authorization": "downloadAuthorization",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const key = names[argument];
    if (!key) throw new Error(`Unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${argument} requires a value`);
    }
    if (options[key] !== null) throw new Error(`${argument} may only be provided once`);
    options[key] = value;
    index += 1;
  }

  if (options.dataRoot === null) throw new Error("--data-root is required");
  if (!isAbsolute(options.dataRoot)) {
    throw new Error("--data-root must be an absolute path");
  }
  if (
    options.downloadAuthorization !== null &&
    options.downloadAuthorization !== DOWNLOAD_AUTHORIZATION_CONFIRMATION
  ) {
    throw new Error(
      `--download-authorization must equal ${DOWNLOAD_AUTHORIZATION_CONFIRMATION}`,
    );
  }
  return options;
}

async function resolveProspectiveDirectoryPath(requestedPath) {
  let candidate = requestedPath;
  while (true) {
    try {
      const candidateStat = await stat(candidate);
      if (!candidateStat.isDirectory()) {
        throw new Error(`Target filesystem probe path is not a directory: ${candidate}`);
      }
      const resolvedAncestor = await realpath(candidate);
      return {
        resolved_path: resolve(resolvedAncestor, relative(candidate, requestedPath)),
        probe_path: resolvedAncestor,
      };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const unresolvedEntry = await lstat(candidate).catch((lstatError) => {
        if (lstatError?.code === "ENOENT") return null;
        throw lstatError;
      });
      if (unresolvedEntry?.isSymbolicLink()) {
        throw new Error(
          `--data-root must not contain a dangling symbolic link: ${candidate}`,
        );
      }
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

async function validateOutputPath(requestedPath, resolvedDataRoot, protectedPaths) {
  const requestedParent = dirname(requestedPath);
  const resolvedParent = await realpath(requestedParent).catch((error) => {
    if (error?.code === "ENOENT") {
      throw new Error(`--output parent directory must already exist: ${requestedParent}`);
    }
    throw error;
  });
  const parentStat = await stat(resolvedParent);
  if (!parentStat.isDirectory()) {
    throw new Error(`--output parent must be a directory: ${requestedParent}`);
  }
  const outputPath = resolve(resolvedParent, basename(requestedPath));
  if (isPathAtOrWithin(resolvedDataRoot, outputPath)) {
    throw new Error("--output must be outside --data-root");
  }

  const protectedFiles = await Promise.all(
    protectedPaths.map(async (path) => ({
      resolved_path: await realpath(path),
      identity: await stat(path),
    })),
  );
  if (protectedFiles.some((file) => file.resolved_path === outputPath)) {
    throw new Error("--output must not replace input evidence");
  }

  const outputEntry = await lstat(outputPath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (outputEntry?.isSymbolicLink()) {
    throw new Error("--output must not be a symbolic link");
  }
  if (
    outputEntry &&
    protectedFiles.some((file) => sameFileIdentity(outputEntry, file.identity))
  ) {
    throw new Error("--output must not alias input evidence");
  }
  return {
    path: outputPath,
    existing_mode: outputEntry?.isFile() ? outputEntry.mode & 0o777 : null,
  };
}

function checkedFilesystemBytes(blocks, blockSize, label) {
  const bytes = blocks * blockSize;
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new Error(`Filesystem ${label} is outside safe integer range`);
  }
  return bytes;
}

function isPathAtOrWithin(parentPath, candidatePath) {
  const pathFromParent = relative(parentPath, candidatePath);
  return (
    pathFromParent === "" ||
    (pathFromParent !== ".." &&
      !pathFromParent.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromParent))
  );
}

function sameFileIdentity(first, second) {
  return first.dev === second.dev && first.ino === second.ino;
}

function resolveEvidenceRoot() {
  const testRoot = process.env.MUSICWIKI_TEST_EVIDENCE_ROOT;
  if (!testRoot) return repositoryRoot;
  if (process.env.NODE_ENV !== "test") {
    throw new Error("MUSICWIKI_TEST_EVIDENCE_ROOT is only available under NODE_ENV=test");
  }
  if (!isAbsolute(testRoot)) {
    throw new Error("MUSICWIKI_TEST_EVIDENCE_ROOT must be an absolute path");
  }
  return normalize(testRoot);
}

async function writeOutputAtomically(outputPath, serialized, existingMode) {
  const temporaryPath = resolve(
    dirname(outputPath),
    `.${basename(outputPath)}.${randomUUID()}.tmp`,
  );
  let temporaryHandle = null;
  try {
    temporaryHandle = await open(temporaryPath, "wx", existingMode ?? 0o666);
    await temporaryHandle.writeFile(serialized, "utf8");
    if (existingMode !== null) {
      await temporaryHandle.chmod(existingMode);
    }
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = null;
    await rename(temporaryPath, outputPath);
  } catch (error) {
    if (temporaryHandle) {
      await temporaryHandle.close().catch(() => undefined);
    }
    await unlink(temporaryPath).catch((cleanupError) => {
      if (cleanupError?.code !== "ENOENT") throw cleanupError;
    });
    throw error;
  }
}

function validateCapacitySnapshot(value) {
  const label = "Capacity snapshot";
  const root = requireObject(value, label);
  requireExactVersion(root.snapshot_version, "1.0", `${label} snapshot_version`);
  requireCanonicalTimestamp(root.generated_at, `${label} generated_at`);
  requireExactValue(root.probe_mode, "metadata-only", `${label} probe_mode`);
  requireExactValue(
    root.full_archives_downloaded,
    false,
    `${label} full_archives_downloaded`,
  );

  const snapshots = requireObject(root.source_snapshots, `${label} source_snapshots`);
  validateCapacitySourceSnapshot(
    snapshots.musicbrainz,
    `${label} MusicBrainz snapshot`,
    /^\d{8}-\d{6}$/,
  );
  validateCapacitySourceSnapshot(
    snapshots.discogs,
    `${label} Discogs snapshot`,
    /^\d{8}$/,
  );

  const assessment = requireObject(root.assessment, `${label} assessment`);
  const recommended = requireObject(
    assessment.recommended,
    `${label} recommended assessment`,
  );
  requireExactValue(
    recommended.bootstrap_strategy,
    "tracked-qid-api",
    `${label} bootstrap_strategy`,
  );
  requireExactValue(
    recommended.includes_full_wikidata_dump,
    false,
    `${label} includes_full_wikidata_dump`,
  );
  const requiredArchiveBytes = requirePositiveSafeInteger(
    recommended.required_archive_bytes,
    `${label} required_archive_bytes`,
  );
  const stableBytes = requirePositiveSafeInteger(
    recommended.estimated_stable_working_bytes,
    `${label} estimated_stable_working_bytes`,
  );
  const peakBytes = requirePositiveSafeInteger(
    recommended.estimated_peak_working_bytes,
    `${label} estimated_peak_working_bytes`,
  );
  const provisionedBytes = requirePositiveSafeInteger(
    recommended.provisioned_disk_bytes,
    `${label} provisioned_disk_bytes`,
  );
  if (
    requiredArchiveBytes > stableBytes ||
    stableBytes > peakBytes ||
    peakBytes > provisionedBytes
  ) {
    throw new Error(`${label} recommended capacity values are inconsistent`);
  }
  return root;
}

function validateCapacitySourceSnapshot(value, label, snapshotPattern) {
  const snapshot = requireObject(value, label);
  const snapshotId = requireNonEmptyString(snapshot.snapshot_id, `${label} snapshot_id`);
  if (!snapshotPattern.test(snapshotId)) {
    throw new Error(`${label} snapshot_id has an unsupported format`);
  }
  requireNonEmptyString(snapshot.directory_url, `${label} directory_url`);
  if (!Array.isArray(snapshot.files) || snapshot.files.length === 0) {
    throw new Error(`${label} files must be a non-empty array`);
  }
  for (const [index, fileValue] of snapshot.files.entries()) {
    const file = requireObject(fileValue, `${label} files[${index}]`);
    requireNonEmptyString(file.name, `${label} files[${index}].name`);
    requirePositiveSafeInteger(file.bytes, `${label} files[${index}].bytes`);
    requireNonEmptyString(
      file.license_partition,
      `${label} files[${index}].license_partition`,
    );
  }
}

async function validatePublishedState(value) {
  const label = "Published state";
  const root = requireObject(value, label);
  requireExactVersion(root.state_version, "1.0", `${label} state_version`);
  const sources = requireObject(root.sources, `${label} sources`);
  const musicbrainz = requireObject(sources.musicbrainz, `${label} MusicBrainz source`);
  const discogs = requireObject(sources.discogs, `${label} Discogs source`);
  const wikidata = requireObject(sources.wikidata, `${label} Wikidata source`);
  const currentGeneration = root.current_generation;
  const publishedAt = root.published_at;
  const dataRoot = root.data_root;
  const planFingerprint = root.plan_fingerprint;
  const musicbrainzSnapshot = musicbrainz.snapshot_id;
  const discogsSnapshot = discogs.snapshot_id;
  requirePositiveSafeInteger(wikidata.tracked_qids, `${label} Wikidata tracked_qids`);
  const lastRevisionRefreshAt = requireNullableNonEmptyString(
    wikidata.last_revision_refresh_at,
    `${label} Wikidata last_revision_refresh_at`,
  );
  if (lastRevisionRefreshAt !== null) {
    requireCanonicalTimestamp(
      lastRevisionRefreshAt,
      `${label} Wikidata last_revision_refresh_at`,
    );
  }

  const publicationFields = [
    currentGeneration,
    publishedAt,
    dataRoot,
    planFingerprint,
    musicbrainzSnapshot,
    discogsSnapshot,
  ];
  const isEmpty = publicationFields.every((field) => field === null);
  const isComplete = publicationFields.every(
    (field) => typeof field === "string" && field.length > 0,
  );
  if (!isEmpty && !isComplete) {
    throw new Error(`${label} must be atomically empty or complete`);
  }
  if (isComplete) {
    requireCanonicalTimestamp(publishedAt, `${label} published_at`);
    if (!/^[a-f0-9]{64}$/.test(planFingerprint)) {
      throw new Error(`${label} plan_fingerprint must be 64 lowercase hex`);
    }
    if (!/^\d{8}-\d{6}$/.test(musicbrainzSnapshot)) {
      throw new Error(`${label} MusicBrainz snapshot_id has an unsupported format`);
    }
    if (!/^\d{8}$/.test(discogsSnapshot)) {
      throw new Error(`${label} Discogs snapshot_id has an unsupported format`);
    }
    const expectedGeneration = `mb-${musicbrainzSnapshot}__discogs-${discogsSnapshot}`;
    if (currentGeneration !== expectedGeneration) {
      throw new Error(`${label} current_generation does not match source snapshots`);
    }
    if (!isAbsolute(dataRoot) || normalize(dataRoot) !== dataRoot) {
      throw new Error(`${label} data_root must be a canonical absolute real path`);
    }
    const resolvedDataRoot = await realpath(dataRoot).catch(() => {
      throw new Error(`${label} data_root must be a canonical absolute real path`);
    });
    const dataRootStat = await stat(resolvedDataRoot);
    if (resolvedDataRoot !== dataRoot || !dataRootStat.isDirectory()) {
      throw new Error(`${label} data_root must be a canonical absolute real path`);
    }
  }
  return root;
}

async function inspectPublishedGenerationReuse(
  publishedState,
  resolvedDataRoot,
  minimumAllocatedBytes,
) {
  if (publishedState.current_generation === null) {
    return rejectPublishedReuse("no-published-generation");
  }
  if (publishedState.data_root !== resolvedDataRoot) {
    return rejectPublishedReuse("data-root-mismatch");
  }

  const generationPath = resolve(
    resolvedDataRoot,
    "published",
    publishedState.current_generation,
  );
  const generationEntry = await lstat(generationPath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    return false;
  });
  if (generationEntry === null) {
    return rejectPublishedReuse("generation-directory-missing");
  }
  if (
    generationEntry === false ||
    generationEntry.isSymbolicLink() ||
    !generationEntry.isDirectory()
  ) {
    return rejectPublishedReuse("generation-directory-invalid");
  }
  const resolvedGenerationPath = await realpath(generationPath).catch(() => null);
  if (resolvedGenerationPath !== generationPath) {
    return rejectPublishedReuse("generation-directory-invalid");
  }

  const manifestPath = resolve(generationPath, "generation-manifest.json");
  const manifestEntry = await lstat(manifestPath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    return false;
  });
  if (manifestEntry === null) {
    return rejectPublishedReuse("generation-manifest-missing");
  }
  if (
    manifestEntry === false ||
    manifestEntry.isSymbolicLink() ||
    !manifestEntry.isFile()
  ) {
    return rejectPublishedReuse("generation-manifest-invalid");
  }
  const resolvedManifestPath = await realpath(manifestPath).catch(() => null);
  if (resolvedManifestPath !== manifestPath) {
    return rejectPublishedReuse("generation-manifest-invalid");
  }

  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    return rejectPublishedReuse("generation-manifest-invalid");
  }
  const validatedManifest = validatePublishedGenerationManifest(
    manifest,
    publishedState,
  );
  if (!validatedManifest.valid) {
    return rejectPublishedReuse(validatedManifest.reason);
  }
  const contentProof = await inspectPublishedContent(
    generationPath,
    validatedManifest.manifest,
    minimumAllocatedBytes,
  );
  if (!contentProof.valid) {
    return rejectPublishedReuse(contentProof.reason);
  }
  return {
    reused: true,
    reason: "generation-manifest-verified",
    allocated_bytes: contentProof.allocated_bytes,
  };
}

function validatePublishedGenerationManifest(value, publishedState) {
  let manifest;
  try {
    manifest = requireObject(value, "Published generation manifest");
    requireExactKeys(
      manifest,
      [
        "version",
        "generation_id",
        "plan_fingerprint",
        "published_at",
        "data_root",
        "sources",
        "content_root",
        "content_files",
        "manifest_sha256",
      ],
      "Published generation manifest",
    );
    requireExactVersion(
      manifest.version,
      "1.0",
      "Published generation manifest version",
    );
    requireNonEmptyString(
      manifest.generation_id,
      "Published generation manifest generation_id",
    );
    requireCanonicalTimestamp(
      manifest.published_at,
      "Published generation manifest published_at",
    );
    requireNonEmptyString(
      manifest.data_root,
      "Published generation manifest data_root",
    );
    if (!/^[a-f0-9]{64}$/.test(manifest.plan_fingerprint)) {
      throw new Error("Published generation manifest plan_fingerprint is invalid");
    }
    if (!/^[a-f0-9]{64}$/.test(manifest.manifest_sha256)) {
      throw new Error("Published generation manifest manifest_sha256 is invalid");
    }
    requireExactValue(
      manifest.content_root,
      "canonical",
      "Published generation manifest content_root",
    );
    if (!Array.isArray(manifest.content_files) || manifest.content_files.length === 0) {
      throw new Error(
        "Published generation manifest content_files must be a non-empty array",
      );
    }
    let previousPath = null;
    for (const [index, fileValue] of manifest.content_files.entries()) {
      const file = requireObject(
        fileValue,
        `Published generation manifest content_files[${index}]`,
      );
      requireExactKeys(
        file,
        ["relative_path", "bytes"],
        `Published generation manifest content_files[${index}]`,
      );
      const relativePath = requireNonEmptyString(
        file.relative_path,
        `Published generation manifest content_files[${index}].relative_path`,
      );
      if (!isSafeContentRelativePath(relativePath)) {
        throw new Error(
          `Published generation manifest content_files[${index}].relative_path is unsafe`,
        );
      }
      requireNonNegativeSafeInteger(
        file.bytes,
        `Published generation manifest content_files[${index}].bytes`,
      );
      if (
        previousPath !== null &&
        Buffer.compare(Buffer.from(previousPath), Buffer.from(relativePath)) >= 0
      ) {
        throw new Error(
          "Published generation manifest content_files must be unique and byte-sorted",
        );
      }
      previousPath = relativePath;
    }
    const sources = requireObject(
      manifest.sources,
      "Published generation manifest sources",
    );
    requireExactKeys(
      sources,
      ["musicbrainz", "discogs"],
      "Published generation manifest sources",
    );
    const musicbrainz = requireObject(
      sources.musicbrainz,
      "Published generation manifest MusicBrainz source",
    );
    const discogs = requireObject(
      sources.discogs,
      "Published generation manifest Discogs source",
    );
    requireExactKeys(
      musicbrainz,
      ["snapshot_id"],
      "Published generation manifest MusicBrainz source",
    );
    requireExactKeys(
      discogs,
      ["snapshot_id"],
      "Published generation manifest Discogs source",
    );
    requireNonEmptyString(
      musicbrainz.snapshot_id,
      "Published generation manifest MusicBrainz snapshot_id",
    );
    requireNonEmptyString(
      discogs.snapshot_id,
      "Published generation manifest Discogs snapshot_id",
    );
  } catch {
    return { valid: false, reason: "generation-manifest-invalid" };
  }

  if (
    manifest.generation_id !== publishedState.current_generation ||
    manifest.plan_fingerprint !== publishedState.plan_fingerprint ||
    manifest.published_at !== publishedState.published_at ||
    manifest.data_root !== publishedState.data_root ||
    manifest.sources.musicbrainz.snapshot_id !==
      publishedState.sources.musicbrainz.snapshot_id ||
    manifest.sources.discogs.snapshot_id !==
      publishedState.sources.discogs.snapshot_id
  ) {
    return { valid: false, reason: "generation-manifest-mismatch" };
  }

  const manifestPayload = {
    version: manifest.version,
    generation_id: manifest.generation_id,
    plan_fingerprint: manifest.plan_fingerprint,
    published_at: manifest.published_at,
    data_root: manifest.data_root,
    sources: {
      musicbrainz: {
        snapshot_id: manifest.sources.musicbrainz.snapshot_id,
      },
      discogs: {
        snapshot_id: manifest.sources.discogs.snapshot_id,
      },
    },
    content_root: manifest.content_root,
    content_files: manifest.content_files.map((file) => ({
      relative_path: file.relative_path,
      bytes: file.bytes,
    })),
  };
  const expectedManifestSha256 = createHash("sha256")
    .update(JSON.stringify(manifestPayload))
    .digest("hex");
  if (manifest.manifest_sha256 !== expectedManifestSha256) {
    return { valid: false, reason: "generation-manifest-sha256-mismatch" };
  }
  return { valid: true, manifest };
}

async function inspectPublishedContent(
  generationPath,
  manifest,
  minimumAllocatedBytes,
) {
  const contentRootPath = resolve(generationPath, manifest.content_root);
  const rootEntry = await lstat(contentRootPath).catch(() => null);
  if (
    rootEntry === null ||
    rootEntry.isSymbolicLink() ||
    !rootEntry.isDirectory()
  ) {
    return { valid: false, reason: "published-content-root-invalid" };
  }
  const resolvedContentRoot = await realpath(contentRootPath).catch(() => null);
  if (
    resolvedContentRoot !== contentRootPath ||
    !isPathAtOrWithin(generationPath, resolvedContentRoot)
  ) {
    return { valid: false, reason: "published-content-root-invalid" };
  }

  const actualFiles = new Map();
  const physicalFiles = new Set();
  let allocatedBytes = 0;

  async function visitDirectory(directoryPath) {
    const entries = await readdir(directoryPath).catch(() => null);
    if (entries === null) return "published-content-root-invalid";
    for (const entryName of entries) {
      const entryPath = resolve(directoryPath, entryName);
      if (!isPathAtOrWithin(contentRootPath, entryPath)) {
        return "published-content-root-invalid";
      }
      const entryStat = await lstat(entryPath).catch(() => null);
      if (entryStat === null || entryStat.isSymbolicLink()) {
        return "published-content-root-invalid";
      }
      const resolvedEntryPath = await realpath(entryPath).catch(() => null);
      if (
        resolvedEntryPath !== entryPath ||
        !isPathAtOrWithin(contentRootPath, resolvedEntryPath)
      ) {
        return "published-content-root-invalid";
      }
      if (entryStat.isDirectory()) {
        const nestedFailure = await visitDirectory(entryPath);
        if (nestedFailure !== null) return nestedFailure;
        continue;
      }
      if (!entryStat.isFile()) return "published-content-root-invalid";

      const relativePath = relative(contentRootPath, entryPath);
      if (
        !isSafeContentRelativePath(relativePath) ||
        !Number.isSafeInteger(entryStat.size) ||
        entryStat.size < 0
      ) {
        return "published-content-root-invalid";
      }
      actualFiles.set(relativePath, entryStat.size);
      if (
        !Number.isSafeInteger(entryStat.blocks) ||
        entryStat.blocks < 0 ||
        !Number.isSafeInteger(entryStat.dev) ||
        entryStat.dev < 0 ||
        !Number.isSafeInteger(entryStat.ino) ||
        entryStat.ino < 0
      ) {
        return "published-content-allocation-unavailable";
      }
      const identity = `${entryStat.dev}:${entryStat.ino}`;
      if (!physicalFiles.has(identity)) {
        const fileAllocatedBytes = entryStat.blocks * 512;
        if (!Number.isSafeInteger(fileAllocatedBytes)) {
          return "published-content-allocation-unavailable";
        }
        physicalFiles.add(identity);
        allocatedBytes += fileAllocatedBytes;
        if (!Number.isSafeInteger(allocatedBytes)) {
          return "published-content-allocation-unavailable";
        }
      }
    }
    return null;
  }

  const traversalFailure = await visitDirectory(contentRootPath);
  if (traversalFailure !== null) {
    return { valid: false, reason: traversalFailure };
  }
  if (actualFiles.size !== manifest.content_files.length) {
    return { valid: false, reason: "published-content-inventory-mismatch" };
  }
  for (const expectedFile of manifest.content_files) {
    if (!actualFiles.has(expectedFile.relative_path)) {
      return { valid: false, reason: "published-content-inventory-mismatch" };
    }
    if (actualFiles.get(expectedFile.relative_path) !== expectedFile.bytes) {
      return { valid: false, reason: "published-content-size-mismatch" };
    }
  }
  if (allocatedBytes < minimumAllocatedBytes) {
    return { valid: false, reason: "published-content-capacity-shortfall" };
  }
  return { valid: true, allocated_bytes: allocatedBytes };
}

function rejectPublishedReuse(reason) {
  return { reused: false, reason, allocated_bytes: 0 };
}

function isSafeContentRelativePath(path) {
  if (
    path.length === 0 ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.includes(":") ||
    isAbsolute(path)
  ) {
    return false;
  }
  return path
    .split("/")
    .every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function validatePocManifest(value) {
  const label = "PoC manifest";
  const root = requireObject(value, label);
  requireExactVersion(root.manifest_version, "1.0", `${label} manifest_version`);
  requireCanonicalTimestamp(root.generated_at, `${label} generated_at`);
  requireExactValue(root.mode, "bounded-sample-poc", `${label} mode`);
  requireExactValue(
    root.full_archives_downloaded,
    false,
    `${label} full_archives_downloaded`,
  );
  const sources = requireObject(root.sources, `${label} sources`);
  const wikidata = requireObject(sources.wikidata, `${label} Wikidata source`);
  requirePositiveSafeInteger(wikidata.tracked_qids, `${label} Wikidata tracked_qids`);
  return root;
}

function validateSourceConfig(value) {
  const label = "Source config";
  const root = requireObject(value, label);
  requireExactVersion(root.version, "1.0", `${label} version`);
  const sources = requireObject(root.sources, `${label} sources`);
  const musicbrainz = requireObject(sources.musicbrainz, `${label} MusicBrainz source`);
  const discogs = requireObject(sources.discogs, `${label} Discogs source`);
  const wikidata = requireObject(sources.wikidata, `${label} Wikidata source`);
  const fingerprint = requireNonEmptyString(
    musicbrainz.signing_key_fingerprint,
    `${label} MusicBrainz signing_key_fingerprint`,
  );
  if (!/^[A-F0-9]{40}$/.test(fingerprint)) {
    throw new Error(`${label} MusicBrainz signing_key_fingerprint is invalid`);
  }
  requirePositiveSafeInteger(
    musicbrainz.metadata_max_bytes,
    `${label} MusicBrainz metadata_max_bytes`,
  );
  if (!Array.isArray(musicbrainz.required_files)) {
    throw new Error(`${label} MusicBrainz required_files must be an array`);
  }
  for (const requiredFile of ["mbdump.tar.bz2", "SHA256SUMS", "SHA256SUMS.asc"]) {
    if (!musicbrainz.required_files.includes(requiredFile)) {
      throw new Error(`${label} MusicBrainz required_files is missing ${requiredFile}`);
    }
  }
  requireNonEmptyString(discogs.directory_url_template, `${label} Discogs directory URL`);
  requireNonEmptyString(wikidata.action_api, `${label} Wikidata action API`);
  return root;
}

function requireObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value;
}

function requireExactKeys(value, expectedKeys, label) {
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  if (
    actualKeys.length !== sortedExpectedKeys.length ||
    actualKeys.some((key, index) => key !== sortedExpectedKeys[index])
  ) {
    throw new Error(`${label} must contain exactly the supported keys`);
  }
}

function requireExactVersion(value, expected, label) {
  if (value !== expected) {
    throw new Error(`${label} must be ${expected}`);
  }
}

function requireExactValue(value, expected, label) {
  if (value !== expected) {
    throw new Error(`${label} must be ${JSON.stringify(expected)}`);
  }
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requireNullableNonEmptyString(value, label) {
  if (value === null) return null;
  return requireNonEmptyString(value, label);
}

function requirePositiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function requireNonNegativeSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function requireCanonicalTimestamp(value, label) {
  const timestamp = requireNonEmptyString(value, label);
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== timestamp) {
    throw new Error(`${label} must be a canonical ISO timestamp`);
  }
  return timestamp;
}

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`${label} is not valid JSON: ${error.message}`);
    }
    throw error;
  }
}
