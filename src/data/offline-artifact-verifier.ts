import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import {
  computeOfflineBootstrapPlanFingerprint,
  type OfflineBootstrapArtifact,
  type OfflineBootstrapPlan,
} from "./offline-bootstrap-plan.ts";
import type {
  OfflineArtifactVerificationEvidence,
  OfflineGenerationArtifactState,
  OfflineGenerationState,
} from "./offline-generation-state.ts";

const execFile = promisify(execFileCallback);
declare const receiptBrand: unique symbol;

/**
 * A same-process, single-audit credential for one verified plan/state snapshot.
 * It cannot be persisted or reconstructed. A real publish operation must reverify
 * the files; state.signature_verified is self-reported evidence, not final trust.
 * Successful audit revalidation consumes it; failed revalidation leaves it issued.
 */
export interface OfflineArtifactVerificationReceipt {
  readonly [receiptBrand]: true;
}

export interface OfflineArtifactVerifierOptions {
  readonly gpgExecutable?: string;
  readonly gnupgHome?: string;
}

export interface OfflineArtifactInspection {
  readonly artifact_id: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly verification_evidence: OfflineArtifactVerificationEvidence;
}

interface ReceiptBinding {
  readonly generationId: string;
  readonly planFingerprint: string;
  readonly stateUpdatedAt: string;
  readonly verifiedAt: string;
  readonly actualFiles: Readonly<Record<string, VerifiedFile>>;
}

interface VerifiedFile {
  readonly path: string;
  readonly bytes: number;
  readonly device: number;
  readonly inode: number;
  readonly mtimeMs: number;
  readonly sha256: string;
}

const issuedReceipts = new WeakSet<object>();
const receiptBindings = new WeakMap<object, ReceiptBinding>();

export async function inspectDownloadedOfflineGenerationArtifacts(
  plan: OfflineBootstrapPlan,
  state: OfflineGenerationState,
  options: OfflineArtifactVerifierOptions = {},
): Promise<Readonly<Record<string, OfflineArtifactInspection>>> {
  assertPlanAndDownloadedStateReady(plan, state);
  const requiredArtifacts = plan.artifacts.filter((artifact) => artifact.required);
  const dataRootState = await lstat(plan.data_root).catch((error: unknown) => {
    throw new Error(`Offline data_root is missing or unreadable: ${errorMessage(error)}`);
  });
  if (dataRootState.isSymbolicLink() || !dataRootState.isDirectory()) {
    throw new Error("Offline data_root must be a non-symlink directory");
  }
  const realDataRoot = await realpath(plan.data_root);
  const files = new Map<string, VerifiedFile>();
  for (const artifact of requiredArtifacts) {
    const file = await hashRequiredArtifact(realDataRoot, artifact);
    assertDownloadedFileMatchesPlanAndState(
      artifact,
      state.artifacts[artifact.artifact_id]!,
      file,
    );
    files.set(artifact.artifact_id, file);
  }
  await verifyManifestArchives(requiredArtifacts, files);
  await verifySignedMetadata(requiredArtifacts, files, options);

  return Object.fromEntries(
    requiredArtifacts.map((artifact) => {
      const file = files.get(artifact.artifact_id)!;
      return [
        artifact.artifact_id,
        {
          artifact_id: artifact.artifact_id,
          bytes: file.bytes,
          sha256: file.sha256,
          verification_evidence: buildVerificationEvidence(artifact, file, files),
        },
      ];
    }),
  );
}

export async function verifyOfflineGenerationArtifacts(
  plan: OfflineBootstrapPlan,
  state: OfflineGenerationState,
  verifiedAt: string,
  options: OfflineArtifactVerifierOptions = {},
): Promise<OfflineArtifactVerificationReceipt> {
  assertCanonicalTimestamp(verifiedAt, "verifiedAt");
  assertPlanAndStateReady(plan, state);
  if (Date.parse(verifiedAt) < Date.parse(state.updated_at)) {
    throw new Error("verifiedAt cannot precede state updated_at");
  }

  const requiredArtifacts = plan.artifacts.filter((artifact) => artifact.required);
  const dataRootState = await lstat(plan.data_root).catch((error: unknown) => {
    throw new Error(`Offline data_root is missing or unreadable: ${errorMessage(error)}`);
  });
  if (dataRootState.isSymbolicLink()) {
    throw new Error("Offline data_root must not be a symbolic link");
  }
  if (!dataRootState.isDirectory()) {
    throw new Error("Offline data_root must be a directory");
  }
  const realDataRoot = await realpath(plan.data_root).catch((error: unknown) => {
    throw new Error(`Offline data_root is missing or unreadable: ${errorMessage(error)}`);
  });
  const verifiedFiles = new Map<string, VerifiedFile>();
  for (const artifact of requiredArtifacts) {
    const file = await hashRequiredArtifact(realDataRoot, artifact);
    assertFileMatchesPlanAndState(artifact, state.artifacts[artifact.artifact_id]!, file);
    verifiedFiles.set(artifact.artifact_id, file);
  }

  await verifyManifestArchives(requiredArtifacts, verifiedFiles, state);
  await verifySignedMetadata(requiredArtifacts, verifiedFiles, options);

  const actualFiles = Object.fromEntries(
    [...verifiedFiles.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([artifactId, file]) => [artifactId, { ...file }]),
  );
  const receipt = {} as OfflineArtifactVerificationReceipt;
  const receiptObject = receipt as object;
  issuedReceipts.add(receiptObject);
  receiptBindings.set(receiptObject, {
    generationId: plan.generation_id,
    planFingerprint: plan.plan_fingerprint,
    stateUpdatedAt: state.updated_at,
    verifiedAt,
    actualFiles,
  });
  return receipt;
}

export function assertOfflineArtifactVerificationReceipt(
  receipt: unknown,
  plan: OfflineBootstrapPlan,
  state: OfflineGenerationState,
  auditedAt: string,
): asserts receipt is OfflineArtifactVerificationReceipt {
  requireReceiptBinding(receipt, plan, state, auditedAt);
}

export function consumeOfflineArtifactVerificationReceipt(
  receipt: OfflineArtifactVerificationReceipt,
  plan: OfflineBootstrapPlan,
  state: OfflineGenerationState,
  auditedAt: string,
): void {
  const binding = requireReceiptBinding(receipt, plan, state, auditedAt);
  reverifyReceiptFiles(binding, plan, state);
  issuedReceipts.delete(receipt);
  receiptBindings.delete(receipt);
}

function requireReceiptBinding(
  receipt: unknown,
  plan: OfflineBootstrapPlan,
  state: OfflineGenerationState,
  auditedAt: string,
): ReceiptBinding {
  if (
    receipt === null ||
    (typeof receipt !== "object" && typeof receipt !== "function") ||
    !issuedReceipts.has(receipt)
  ) {
    throw new Error("Offline artifact verification receipt was not issued in this process");
  }
  const binding = receiptBindings.get(receipt);
  if (!binding) {
    throw new Error("Offline artifact verification receipt has no binding");
  }
  if (
    binding.generationId !== plan.generation_id ||
    binding.planFingerprint !== plan.plan_fingerprint ||
    state.generation_id !== binding.generationId ||
    state.plan_fingerprint !== binding.planFingerprint
  ) {
    throw new Error("Offline artifact verification receipt does not match the plan and state");
  }
  if (binding.stateUpdatedAt !== state.updated_at) {
    throw new Error("Offline artifact verification receipt does not match the state timestamp");
  }
  if (binding.verifiedAt !== auditedAt) {
    throw new Error("Offline artifact verification receipt does not match the audit time");
  }
  const stateDigests = Object.fromEntries(
    Object.entries(state.artifacts)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([artifactId, artifact]) => [artifactId, artifact.observed_sha256]),
  );
  const boundDigests = Object.fromEntries(
    Object.entries(binding.actualFiles)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([artifactId, file]) => [artifactId, file.sha256]),
  );
  if (JSON.stringify(stateDigests) !== JSON.stringify(boundDigests)) {
    throw new Error("Offline artifact verification receipt does not match state artifact digests");
  }
  return binding;
}

function assertPlanAndStateReady(
  plan: OfflineBootstrapPlan,
  state: OfflineGenerationState,
): void {
  if (computeOfflineBootstrapPlanFingerprint(plan) !== plan.plan_fingerprint) {
    throw new Error("Bootstrap plan fingerprint does not match its contents");
  }
  if (
    plan.download_authorization !== "authorized" ||
    plan.capacity_gate.status !== "pass" ||
    plan.execution_ready !== true
  ) {
    throw new Error("Bootstrap plan is not execution-ready for artifact verification");
  }
  if (
    state.generation_id !== plan.generation_id ||
    state.plan_fingerprint !== plan.plan_fingerprint
  ) {
    throw new Error("Generation state does not match the bootstrap plan");
  }
  assertCanonicalTimestamp(state.updated_at, "state.updated_at");
  if (state.phase !== "verified") {
    throw new Error("Generation phase must be verified before artifact verification");
  }
  const requiredIds = plan.artifacts
    .filter((artifact) => artifact.required)
    .map((artifact) => artifact.artifact_id);
  if (new Set(requiredIds).size !== requiredIds.length) {
    throw new Error("Bootstrap plan required artifact ids must be unique");
  }
  if (!arraysEqual(state.required_artifact_ids, requiredIds)) {
    throw new Error("Generation state required artifacts do not match the plan");
  }
  if (!arraysEqual(Object.keys(state.artifacts).sort(), [...requiredIds].sort())) {
    throw new Error("Generation state artifact map does not match the plan");
  }
  for (const artifactId of requiredIds) {
    const artifactState = state.artifacts[artifactId];
    if (
      artifactState?.artifact_id !== artifactId ||
      artifactState.required !== true ||
      artifactState.status !== "verified" ||
      artifactState.download_complete !== true
    ) {
      throw new Error(`Required artifact is not verified in generation state: ${artifactId}`);
    }
  }
}

function assertPlanAndDownloadedStateReady(
  plan: OfflineBootstrapPlan,
  state: OfflineGenerationState,
): void {
  if (computeOfflineBootstrapPlanFingerprint(plan) !== plan.plan_fingerprint) {
    throw new Error("Bootstrap plan fingerprint does not match its contents");
  }
  if (
    plan.download_authorization !== "authorized" ||
    plan.capacity_gate.status !== "pass" ||
    plan.execution_ready !== true
  ) {
    throw new Error("Bootstrap plan is not execution-ready for artifact inspection");
  }
  if (
    state.generation_id !== plan.generation_id ||
    state.plan_fingerprint !== plan.plan_fingerprint ||
    state.phase !== "downloaded"
  ) {
    throw new Error("Generation state must be downloaded and match the bootstrap plan");
  }
  const requiredIds = plan.artifacts
    .filter((artifact) => artifact.required)
    .map((artifact) => artifact.artifact_id);
  if (
    !arraysEqual(state.required_artifact_ids, requiredIds) ||
    !arraysEqual(Object.keys(state.artifacts).sort(), [...requiredIds].sort())
  ) {
    throw new Error("Generation state required artifacts do not match the plan");
  }
  for (const artifactId of requiredIds) {
    const artifactState = state.artifacts[artifactId];
    if (
      artifactState?.artifact_id !== artifactId ||
      artifactState.required !== true ||
      (artifactState.status !== "downloaded" && artifactState.status !== "verified") ||
      artifactState.download_complete !== true
    ) {
      throw new Error(`Required artifact is not downloaded or verified in generation state: ${artifactId}`);
    }
    if (
      artifactState.status === "downloaded" &&
      (artifactState.observed_sha256 !== null || artifactState.verification_evidence !== null)
    ) {
      throw new Error(`Downloaded artifact has premature verification evidence: ${artifactId}`);
    }
    if (
      artifactState.status === "verified" &&
      (!artifactState.observed_sha256 ||
        !/^[0-9a-f]{64}$/.test(artifactState.observed_sha256) ||
        artifactState.verification_evidence === null)
    ) {
      throw new Error(`Verified artifact has incomplete verification evidence: ${artifactId}`);
    }
  }
}

async function hashRequiredArtifact(
  realDataRoot: string,
  artifact: OfflineBootstrapArtifact,
): Promise<VerifiedFile> {
  const destination = artifact.destination_relative;
  if (isAbsolute(destination) || destination.length === 0) {
    throw new Error(`${artifact.artifact_id} destination must be a non-empty relative path`);
  }
  const candidate = resolve(realDataRoot, destination);
  if (!isWithinRoot(realDataRoot, candidate)) {
    throw new Error(`${artifact.artifact_id} destination escapes data_root`);
  }
  await assertNoSymlinkComponents(realDataRoot, candidate, artifact.artifact_id);
  const pathState = await lstat(candidate).catch((error: unknown) => {
    throw new Error(`${artifact.artifact_id} file is missing or unreadable: ${errorMessage(error)}`);
  });
  if (pathState.isSymbolicLink()) {
    throw new Error(`${artifact.artifact_id} file must not be a symbolic link`);
  }
  if (!pathState.isFile()) {
    throw new Error(`${artifact.artifact_id} destination is not a regular file`);
  }
  const resolvedCandidate = await realpath(candidate);
  if (!isWithinRoot(realDataRoot, resolvedCandidate)) {
    throw new Error(`${artifact.artifact_id} resolved path escapes data_root`);
  }

  const handle = await open(candidate, "r");
  try {
    const before = await handle.stat();
    if (before.dev !== pathState.dev || before.ino !== pathState.ino) {
      throw new Error(`${artifact.artifact_id} file changed while it was opened`);
    }
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      hash.update(buffer);
    }
    const after = await handle.stat();
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ino !== after.ino ||
      bytes !== after.size
    ) {
      throw new Error(`${artifact.artifact_id} file changed during SHA-256 verification`);
    }
    return {
      path: resolvedCandidate,
      bytes,
      device: after.dev,
      inode: after.ino,
      mtimeMs: after.mtimeMs,
      sha256: hash.digest("hex"),
    };
  } finally {
    await handle.close();
  }
}

function reverifyReceiptFiles(
  binding: ReceiptBinding,
  plan: OfflineBootstrapPlan,
  state: OfflineGenerationState,
): void {
  let rootState;
  try {
    rootState = lstatSync(plan.data_root);
  } catch (error) {
    throw new Error(`Offline data_root changed after verification: ${errorMessage(error)}`);
  }
  if (rootState.isSymbolicLink() || !rootState.isDirectory()) {
    throw new Error("Offline data_root changed after verification");
  }
  const realDataRoot = realpathSync(plan.data_root);
  const requiredArtifacts = plan.artifacts.filter((artifact) => artifact.required);
  for (const artifact of requiredArtifacts) {
    const bound = binding.actualFiles[artifact.artifact_id];
    if (!bound) {
      throw new Error(`${artifact.artifact_id} is absent from the verification receipt`);
    }
    reverifyReceiptFile(realDataRoot, artifact, state.artifacts[artifact.artifact_id]!, bound);
  }
}

function reverifyReceiptFile(
  realDataRoot: string,
  artifact: OfflineBootstrapArtifact,
  artifactState: OfflineGenerationArtifactState,
  bound: VerifiedFile,
): void {
  const destination = artifact.destination_relative;
  if (isAbsolute(destination) || destination.length === 0) {
    throw new Error(`${artifact.artifact_id} destination is no longer a relative path`);
  }
  const candidate = resolve(realDataRoot, destination);
  if (!isWithinRoot(realDataRoot, candidate)) {
    throw new Error(`${artifact.artifact_id} destination escapes data_root during audit`);
  }
  assertNoSymlinkComponentsSync(realDataRoot, candidate, artifact.artifact_id);
  const pathState = lstatSync(candidate);
  if (pathState.isSymbolicLink() || !pathState.isFile()) {
    throw new Error(`${artifact.artifact_id} audit path is not a regular non-symlink file`);
  }
  const resolvedCandidate = realpathSync(candidate);
  if (!isWithinRoot(realDataRoot, resolvedCandidate) || resolvedCandidate !== bound.path) {
    throw new Error(`${artifact.artifact_id} resolved path changed after verification`);
  }

  const descriptor = openSync(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const openedResolvedCandidate = realpathSync(candidate);
    if (
      !isWithinRoot(realDataRoot, openedResolvedCandidate) ||
      openedResolvedCandidate !== bound.path
    ) {
      throw new Error(`${artifact.artifact_id} opened path changed after verification`);
    }
    const before = fstatSync(descriptor);
    assertBoundFileIdentity(artifact.artifact_id, before, bound);
    if (before.dev !== pathState.dev || before.ino !== pathState.ino) {
      throw new Error(`${artifact.artifact_id} file identity changed while audit opened it`);
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let bytes = 0;
    for (;;) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      bytes += bytesRead;
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = fstatSync(descriptor);
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      bytes !== after.size
    ) {
      throw new Error(`${artifact.artifact_id} changed during audit verification`);
    }
    const digest = hash.digest("hex");
    if (digest !== bound.sha256 || digest !== artifactState.observed_sha256) {
      throw new Error(`${artifact.artifact_id} SHA-256 changed after receipt issuance`);
    }
  } finally {
    closeSync(descriptor);
  }
}

function assertBoundFileIdentity(
  artifactId: string,
  state: ReturnType<typeof fstatSync>,
  bound: VerifiedFile,
): void {
  if (
    state.dev !== bound.device ||
    state.ino !== bound.inode ||
    state.size !== bound.bytes ||
    state.mtimeMs !== bound.mtimeMs
  ) {
    throw new Error(`${artifactId} file identity changed after receipt issuance`);
  }
}

function assertNoSymlinkComponentsSync(
  root: string,
  candidate: string,
  artifactId: string,
): void {
  const pathFromRoot = relative(root, candidate);
  let current = root;
  for (const component of pathFromRoot.split(sep)) {
    if (component.length === 0) continue;
    current = resolve(current, component);
    const componentState = lstatSync(current);
    if (componentState.isSymbolicLink()) {
      throw new Error(`${artifactId} audit path contains a symbolic link`);
    }
  }
}

function assertFileMatchesPlanAndState(
  artifact: OfflineBootstrapArtifact,
  artifactState: OfflineGenerationArtifactState,
  file: VerifiedFile,
): void {
  if (file.bytes !== artifactState.bytes_on_disk) {
    throw new Error(`${artifact.artifact_id} actual bytes do not match generation state`);
  }
  if (artifact.expected_bytes !== null && file.bytes !== artifact.expected_bytes) {
    throw new Error(`${artifact.artifact_id} actual bytes do not match the plan`);
  }
  if (file.bytes > artifact.max_bytes) {
    throw new Error(`${artifact.artifact_id} actual bytes exceed the planned maximum`);
  }
  if (artifactState.observed_sha256 !== file.sha256) {
    throw new Error(`${artifact.artifact_id} actual SHA-256 does not match generation state`);
  }
  const evidence = artifactState.verification_evidence;
  if (!evidence || evidence.verified_sha256 !== file.sha256) {
    throw new Error(`${artifact.artifact_id} actual SHA-256 does not match verification evidence`);
  }
}

function assertDownloadedFileMatchesPlanAndState(
  artifact: OfflineBootstrapArtifact,
  artifactState: OfflineGenerationArtifactState,
  file: VerifiedFile,
): void {
  if (file.bytes !== artifactState.bytes_on_disk) {
    throw new Error(`${artifact.artifact_id} actual bytes do not match generation state`);
  }
  if (artifact.expected_bytes !== null && file.bytes !== artifact.expected_bytes) {
    throw new Error(`${artifact.artifact_id} actual bytes do not match the plan`);
  }
  if (file.bytes < 1 || file.bytes > artifact.max_bytes) {
    throw new Error(`${artifact.artifact_id} actual bytes are outside the planned bounds`);
  }
}

async function verifyManifestArchives(
  artifacts: readonly OfflineBootstrapArtifact[],
  files: ReadonlyMap<string, VerifiedFile>,
  state?: OfflineGenerationState,
): Promise<void> {
  const manifestCache = new Map<string, readonly ManifestEntry[]>();
  for (const artifact of artifacts) {
    const verification = artifact.verification;
    if (
      verification.method !== "sha256-manifest" &&
      verification.method !== "sha256-signed-manifest"
    ) {
      continue;
    }
    const archive = files.get(artifact.artifact_id)!;
    const checksum = files.get(verification.checksum_artifact_id);
    if (!checksum) {
      throw new Error(`${artifact.artifact_id} checksum artifact is missing from the plan`);
    }
    let entries = manifestCache.get(verification.checksum_artifact_id);
    if (!entries) {
      entries = parseSha256Manifest(
        await readFile(checksum.path, "utf8"),
        verification.checksum_artifact_id,
      );
      manifestCache.set(verification.checksum_artifact_id, entries);
    }
    const matches = entries.filter((entry) => entry.filename === artifact.filename);
    if (matches.length !== 1) {
      throw new Error(
        `${artifact.artifact_id} manifest must contain exactly one exact filename entry`,
      );
    }
    if (matches[0]!.sha256 !== archive.sha256) {
      throw new Error(`${artifact.artifact_id} manifest digest does not match the actual archive`);
    }
    if (state) {
      const evidence = state.artifacts[artifact.artifact_id]!
        .verification_evidence as Extract<
        OfflineArtifactVerificationEvidence,
        { method: "sha256-manifest" | "sha256-signed-manifest" }
      >;
      if (
        evidence.manifest_expected_sha256 !== archive.sha256 ||
        evidence.checksum_manifest_sha256 !== checksum.sha256
      ) {
        throw new Error(`${artifact.artifact_id} manifest evidence does not match actual digests`);
      }
    }
  }
}

function buildVerificationEvidence(
  artifact: OfflineBootstrapArtifact,
  file: VerifiedFile,
  files: ReadonlyMap<string, VerifiedFile>,
): OfflineArtifactVerificationEvidence {
  const verification = artifact.verification;
  if (verification.method === "transport-size-only") {
    return { method: verification.method, verified_sha256: file.sha256 };
  }
  if (verification.method === "signed-metadata") {
    return {
      method: verification.method,
      verified_sha256: file.sha256,
      signature_artifact_id: verification.signature_artifact_id,
      signature_verified: true,
      trusted_fingerprint: verification.trusted_fingerprint,
    };
  }
  const checksum = files.get(verification.checksum_artifact_id);
  if (!checksum) {
    throw new Error(`${artifact.artifact_id} checksum artifact is missing from inspection`);
  }
  if (verification.method === "sha256-manifest") {
    return {
      method: verification.method,
      verified_sha256: file.sha256,
      manifest_expected_sha256: file.sha256,
      checksum_artifact_id: verification.checksum_artifact_id,
      checksum_manifest_sha256: checksum.sha256,
    };
  }
  return {
    method: verification.method,
    verified_sha256: file.sha256,
    manifest_expected_sha256: file.sha256,
    checksum_artifact_id: verification.checksum_artifact_id,
    checksum_manifest_sha256: checksum.sha256,
    signature_artifact_id: verification.signature_artifact_id,
    signature_verified: true,
    trusted_fingerprint: verification.trusted_fingerprint,
  };
}

interface ManifestEntry {
  readonly sha256: string;
  readonly filename: string;
}

function parseSha256Manifest(content: string, artifactId: string): readonly ManifestEntry[] {
  const entries: ManifestEntry[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    if (rawLine.length === 0) continue;
    const match = /^([0-9a-fA-F]{64})[ \t]+\*?(.+)$/.exec(rawLine);
    if (!match) {
      throw new Error(`${artifactId} contains an invalid SHA-256 manifest line`);
    }
    entries.push({ sha256: match[1]!.toLowerCase(), filename: match[2]! });
  }
  if (entries.length === 0) {
    throw new Error(`${artifactId} SHA-256 manifest is empty`);
  }
  return entries;
}

async function verifySignedMetadata(
  artifacts: readonly OfflineBootstrapArtifact[],
  files: ReadonlyMap<string, VerifiedFile>,
  options: OfflineArtifactVerifierOptions,
): Promise<void> {
  const gpg = options.gpgExecutable ?? "gpg";
  const verifiedTuples = new Set<string>();
  for (const artifact of artifacts) {
    const verification = artifact.verification;
    if (
      verification.method !== "signed-metadata" &&
      verification.method !== "sha256-signed-manifest"
    ) {
      continue;
    }
    const signedArtifactId =
      verification.method === "signed-metadata"
        ? artifact.artifact_id
        : verification.checksum_artifact_id;
    const signatureId = verification.signature_artifact_id;
    const fingerprint = verification.trusted_fingerprint.toUpperCase();
    if (!/^[0-9A-F]{40}$/.test(fingerprint)) {
      throw new Error(`${artifact.artifact_id} has an invalid trusted fingerprint`);
    }
    const tuple = `${signedArtifactId}\0${signatureId}\0${fingerprint}`;
    if (verifiedTuples.has(tuple)) continue;
    const metadataFile = files.get(signedArtifactId);
    const signatureFile = files.get(signatureId);
    if (!metadataFile || !signatureFile) {
      throw new Error(`${artifact.artifact_id} signature artifact is missing from the plan`);
    }
    const homeArgs = options.gnupgHome ? ["--homedir", options.gnupgHome] : [];
    const keyListing = await runGpg(gpg, [
      "--batch",
      "--no-tty",
      ...homeArgs,
      "--with-colons",
      "--fingerprint",
      fingerprint,
    ], "keyring fingerprint lookup");
    const keyringFingerprints = keyListing.stdout
      .split(/\r?\n/)
      .filter((line) => line.startsWith("fpr:"))
      .map((line) => line.split(":")[9]?.toUpperCase());
    if (!keyringFingerprints.includes(fingerprint)) {
      throw new Error(`Pinned fingerprint ${fingerprint} is absent from the GPG keyring`);
    }
    const signatureCheck = await runGpg(gpg, [
      "--batch",
      "--no-tty",
      "--auto-key-locate",
      "clear",
      ...homeArgs,
      "--status-fd=1",
      "--verify",
      signatureFile.path,
      metadataFile.path,
    ], "detached signature verification");
    const validFingerprints = signatureCheck.stdout
      .split(/\r?\n/)
      .map((line) => /^\[GNUPG:\] VALIDSIG ([0-9A-F]{40})(?:\s|$)/.exec(line)?.[1])
      .filter((value): value is string => value !== undefined);
    if (!validFingerprints.includes(fingerprint)) {
      throw new Error(`GPG VALIDSIG did not match pinned fingerprint ${fingerprint}`);
    }
    verifiedTuples.add(tuple);
  }
}

async function runGpg(
  executable: string,
  args: readonly string[],
  operation: string,
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFile(executable, [...args], {
      encoding: "utf8",
      maxBuffer: 1_000_000,
      env: { ...process.env, GPG_TTY: undefined },
    });
  } catch (error) {
    throw new Error(`GPG ${operation} failed: ${errorMessage(error)}`);
  }
}

async function assertNoSymlinkComponents(
  root: string,
  candidate: string,
  artifactId: string,
): Promise<void> {
  const pathFromRoot = relative(root, candidate);
  let current = root;
  for (const component of pathFromRoot.split(sep)) {
    if (component.length === 0) continue;
    current = resolve(current, component);
    const componentState = await lstat(current).catch((error: unknown) => {
      throw new Error(`${artifactId} file is missing or unreadable: ${errorMessage(error)}`);
    });
    if (componentState.isSymbolicLink()) {
      throw new Error(`${artifactId} path must not contain a symbolic link`);
    }
  }
}

function isWithinRoot(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot))
  );
}

function arraysEqual<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertCanonicalTimestamp(value: string, name: string): void {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime()) || timestamp.toISOString() !== value) {
    throw new Error(`${name} must be a canonical UTC ISO timestamp`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
