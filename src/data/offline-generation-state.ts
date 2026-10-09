import {
  computeOfflineBootstrapPlanFingerprint,
  type OfflineBootstrapArtifact,
  type OfflineBootstrapPlan,
} from "./offline-bootstrap-plan.ts";
import {
  validateOfflineRockCompletenessGates,
  type OfflineRockCompletenessAssessment,
} from "./offline-completeness.ts";
import {
  consumeOfflineArtifactVerificationReceipt,
  type OfflineArtifactVerificationReceipt,
} from "./offline-artifact-verifier.ts";

export type OfflineArtifactStatus = "pending" | "partial" | "downloaded" | "verified";
export type OfflineGenerationPhase =
  | "planned"
  | "downloading"
  | "downloaded"
  | "verified"
  | "publish-ready";
export type OfflineCompletenessGate = OfflineRockCompletenessAssessment["gates"][number];
// An external verifier produces this evidence; the state machine only validates its contract.
export type OfflineArtifactVerificationEvidence =
  | {
      readonly method: "signed-metadata";
      readonly verified_sha256: string;
      readonly signature_artifact_id: string;
      readonly signature_verified: boolean;
      readonly trusted_fingerprint: string;
    }
  | {
      readonly method: "sha256-signed-manifest";
      readonly verified_sha256: string;
      readonly manifest_expected_sha256: string;
      readonly checksum_artifact_id: string;
      readonly checksum_manifest_sha256: string;
      readonly signature_artifact_id: string;
      readonly signature_verified: boolean;
      readonly trusted_fingerprint: string;
    }
  | {
      readonly method: "sha256-manifest";
      readonly verified_sha256: string;
      readonly manifest_expected_sha256: string;
      readonly checksum_artifact_id: string;
      readonly checksum_manifest_sha256: string;
    }
  | { readonly method: "transport-size-only"; readonly verified_sha256: string };

export interface OfflineCompletenessGateSnapshot {
  readonly id: OfflineCompletenessGate["id"];
  readonly status: OfflineCompletenessGate["status"];
  readonly evidence: Readonly<Record<string, boolean | number>>;
}

export interface OfflineGenerationArtifactState {
  readonly artifact_id: string;
  readonly required: true;
  readonly status: OfflineArtifactStatus;
  readonly bytes_on_disk: number;
  readonly download_complete: boolean;
  readonly observed_sha256: string | null;
  readonly verification_evidence: OfflineArtifactVerificationEvidence | null;
  readonly observed_at: string | null;
}

export interface OfflineGenerationState {
  readonly state_version: "1.0";
  readonly generation_id: string;
  readonly plan_fingerprint: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly phase: OfflineGenerationPhase;
  readonly required_artifact_ids: readonly string[];
  readonly artifacts: Readonly<Record<string, OfflineGenerationArtifactState>>;
  readonly completeness_gates: readonly OfflineCompletenessGateSnapshot[] | null;
}

export interface OfflineArtifactObservation {
  readonly artifact_id: string;
  readonly bytes_on_disk: number;
  readonly download_complete: boolean;
  readonly observed_sha256: string | null;
  readonly verification_evidence: OfflineArtifactVerificationEvidence | null;
  readonly status?: OfflineArtifactStatus;
  readonly observed_at: string;
}

const STATUS_RANK: Record<OfflineArtifactStatus, number> = {
  pending: 0,
  partial: 1,
  downloaded: 2,
  verified: 3,
};

export function createOfflineGenerationState(
  plan: OfflineBootstrapPlan,
  createdAt: string,
): OfflineGenerationState {
  assertIsoTimestamp(createdAt, "createdAt");
  assertPlanFingerprint(plan);
  const requiredArtifacts = plan.artifacts.filter((artifact) => artifact.required);
  const requiredArtifactIds = requiredArtifacts.map((artifact) => artifact.artifact_id);
  if (new Set(requiredArtifactIds).size !== requiredArtifactIds.length) {
    throw new Error("Bootstrap plan required artifact ids must be unique");
  }

  const artifacts = Object.fromEntries(
    requiredArtifacts.map((artifact) => [
      artifact.artifact_id,
      {
        artifact_id: artifact.artifact_id,
        required: true as const,
        status: "pending" as const,
        bytes_on_disk: 0,
        download_complete: false,
        observed_sha256: null,
        verification_evidence: null,
        observed_at: null,
      },
    ]),
  );

  return {
    state_version: "1.0",
    generation_id: plan.generation_id,
    plan_fingerprint: plan.plan_fingerprint,
    created_at: createdAt,
    updated_at: createdAt,
    phase: "planned",
    required_artifact_ids: requiredArtifactIds,
    artifacts,
    completeness_gates: null,
  };
}

export function assertOfflineGenerationStateForPlan(
  state: OfflineGenerationState,
  plan: OfflineBootstrapPlan,
): void {
  assertStateVersion(state);
  assertStateMatchesPlan(state, plan);
}

export function observeOfflineArtifact(
  state: OfflineGenerationState,
  plan: OfflineBootstrapPlan,
  observation: OfflineArtifactObservation,
): OfflineGenerationState {
  assertStateVersion(state);
  const requiredArtifactIds = assertStateMatchesPlan(state, plan);
  if (state.phase === "publish-ready") {
    throw new Error("A publish-ready generation cannot accept new artifact observations");
  }
  assertPlanExecutionReady(plan);
  const artifact = requirePlanArtifact(plan, observation.artifact_id);
  const current = state.artifacts[observation.artifact_id];
  if (!current || !requiredArtifactIds.includes(observation.artifact_id)) {
    throw new Error(`Artifact is not required by generation state: ${observation.artifact_id}`);
  }

  assertIsoTimestamp(observation.observed_at, "observed_at");
  assertNonNegativeSafeInteger(observation.bytes_on_disk, "bytes_on_disk");
  if (typeof observation.download_complete !== "boolean") {
    throw new Error(`${observation.artifact_id} download_complete must be a boolean`);
  }
  if (
    observation.bytes_on_disk === 0 &&
    !observation.download_complete &&
    observation.observed_sha256 === null &&
    observation.verification_evidence === null
  ) {
    throw new Error(`${observation.artifact_id} zero-progress observation is not allowed`);
  }
  if (
    artifact.expected_bytes !== null &&
    observation.bytes_on_disk > artifact.expected_bytes
  ) {
    throw new Error(
      `${observation.artifact_id} bytes_on_disk exceeds expected bytes ${artifact.expected_bytes}`,
    );
  }
  if (observation.bytes_on_disk > artifact.max_bytes) {
    throw new Error(
      `${observation.artifact_id} bytes_on_disk exceeds max bytes ${artifact.max_bytes}`,
    );
  }
  if (observation.bytes_on_disk < current.bytes_on_disk) {
    throw new Error(`${observation.artifact_id} bytes_on_disk cannot move backward`);
  }
  if (Date.parse(observation.observed_at) < Date.parse(state.updated_at)) {
    throw new Error(`${observation.artifact_id} observed_at cannot precede state updated_at`);
  }

  const hasSha256 = observation.observed_sha256 !== null;
  const hasEvidence = observation.verification_evidence !== null;
  if (hasSha256 && !/^[0-9a-f]{64}$/.test(observation.observed_sha256 ?? "")) {
    throw new Error(
      `${observation.artifact_id} observed_sha256 must be 64 lowercase hexadecimal digits`,
    );
  }
  if (hasSha256 && !hasEvidence) {
    throw new Error(`${observation.artifact_id} observed_sha256 requires verification_evidence`);
  }
  if (hasEvidence && !hasSha256) {
    throw new Error(`${observation.artifact_id} verification_evidence requires observed_sha256`);
  }
  if (hasEvidence) {
    assertVerificationEvidence(
      artifact,
      observation.verification_evidence,
      observation.observed_sha256,
      state.artifacts,
      observation.observed_at,
    );
  }
  if (observation.status === "verified" && (!hasSha256 || !hasEvidence)) {
    throw new Error(`${observation.artifact_id} cannot declare verified without evidence`);
  }
  if (observation.download_complete) {
    if (observation.bytes_on_disk === 0) {
      throw new Error(`${observation.artifact_id} cannot complete with zero bytes`);
    }
    if (
      artifact.expected_bytes !== null &&
      observation.bytes_on_disk !== artifact.expected_bytes
    ) {
      throw new Error(
        `${observation.artifact_id} download_complete requires exactly ${artifact.expected_bytes} bytes`,
      );
    }
  }
  if (hasSha256 && !observation.download_complete) {
    throw new Error(`${observation.artifact_id} cannot be verified before download is complete`);
  }
  const status: OfflineArtifactStatus = hasSha256
    ? "verified"
    : observation.download_complete
      ? "downloaded"
      : observation.bytes_on_disk > 0
        ? "partial"
        : "pending";
  if (observation.status !== undefined && observation.status !== status) {
    throw new Error(
      `${observation.artifact_id} declared ${observation.status} but observation implies ${status}`,
    );
  }
  if (STATUS_RANK[status] < STATUS_RANK[current.status]) {
    throw new Error(`${observation.artifact_id} status cannot move backward`);
  }
  if (STATUS_RANK[status] - STATUS_RANK[current.status] > 1) {
    throw new Error(`${observation.artifact_id} status can advance at most one step`);
  }

  const artifacts = cloneArtifacts(state.artifacts);
  artifacts[observation.artifact_id] = {
    artifact_id: observation.artifact_id,
    required: true as const,
    status,
    bytes_on_disk: observation.bytes_on_disk,
    download_complete: observation.download_complete,
    observed_sha256: observation.observed_sha256,
    verification_evidence: cloneVerificationEvidence(observation.verification_evidence),
    observed_at: observation.observed_at,
  };
  return {
    ...state,
    updated_at: observation.observed_at,
    phase: derivePhase(artifacts, requiredArtifactIds),
    required_artifact_ids: [...requiredArtifactIds],
    artifacts,
    completeness_gates: cloneGates(state.completeness_gates),
  };
}

export function markOfflineGenerationAudited(
  state: OfflineGenerationState,
  plan: OfflineBootstrapPlan,
  gates: readonly OfflineCompletenessGate[],
  auditedAt: string,
  verificationReceipt: OfflineArtifactVerificationReceipt,
): OfflineGenerationState {
  assertStateVersion(state);
  assertPlanExecutionReady(plan);
  assertIsoTimestamp(auditedAt, "auditedAt");
  if (Date.parse(auditedAt) < Date.parse(state.updated_at)) {
    throw new Error("auditedAt cannot precede state updated_at");
  }
  const requiredArtifactIds = assertStateMatchesPlan(state, plan);
  if (state.phase !== "verified") {
    throw new Error("Generation phase must be verified before audit");
  }
  const unverified = requiredArtifactIds.filter(
    (artifactId) => state.artifacts[artifactId]?.status !== "verified",
  );
  if (unverified.length > 0) {
    throw new Error(`All required artifacts must be verified before audit: ${unverified.join(", ")}`);
  }

  validateOfflineRockCompletenessGates(gates);
  if (gates.some((gate) => gate.status !== "pass")) {
    throw new Error("Every completeness gate must pass before publish-ready");
  }
  const auditedState: OfflineGenerationState = {
    ...state,
    updated_at: auditedAt,
    phase: "publish-ready",
    required_artifact_ids: [...requiredArtifactIds],
    artifacts: cloneArtifacts(state.artifacts),
    completeness_gates: cloneGates(gates),
  };
  consumeOfflineArtifactVerificationReceipt(
    verificationReceipt,
    plan,
    state,
    auditedAt,
  );
  return auditedState;
}

function assertPlanFingerprint(plan: OfflineBootstrapPlan): void {
  const actualFingerprint = computeOfflineBootstrapPlanFingerprint(plan);
  if (actualFingerprint !== plan.plan_fingerprint) {
    throw new Error("Bootstrap plan fingerprint does not match its contents");
  }
}

function assertPlanExecutionReady(plan: OfflineBootstrapPlan): void {
  if (
    plan.download_authorization !== "authorized" ||
    plan.capacity_gate.status !== "pass" ||
    plan.execution_ready !== true
  ) {
    throw new Error("Bootstrap plan is not execution-ready for artifact observations");
  }
}

function assertStateVersion(state: OfflineGenerationState): void {
  if (state.state_version !== "1.0") {
    throw new Error(`Unsupported state_version: ${String(state.state_version)}`);
  }
}

function assertStateMatchesPlan(
  state: OfflineGenerationState,
  plan: OfflineBootstrapPlan,
): string[] {
  if (state.generation_id !== plan.generation_id) {
    throw new Error("Generation state does not match the bootstrap plan generation");
  }
  assertPlanFingerprint(plan);
  if (state.plan_fingerprint !== plan.plan_fingerprint) {
    throw new Error("Generation state does not match the bootstrap plan fingerprint");
  }
  if (!isPlanExecutionReady(plan) && state.phase !== "planned") {
    throw new Error("A non-execution-ready plan cannot persist a non-planned generation state");
  }
  assertIsoTimestamp(state.created_at, "state.created_at");
  assertIsoTimestamp(state.updated_at, "state.updated_at");
  if (Date.parse(state.updated_at) < Date.parse(state.created_at)) {
    throw new Error("Generation state updated_at cannot precede created_at");
  }

  const requiredArtifactIds = plan.artifacts
    .filter((artifact) => artifact.required)
    .map((artifact) => artifact.artifact_id);
  if (new Set(requiredArtifactIds).size !== requiredArtifactIds.length) {
    throw new Error("Bootstrap plan required artifact ids must be unique");
  }
  if (!arraysEqual(state.required_artifact_ids, requiredArtifactIds)) {
    throw new Error("Generation state required artifact ids do not match the complete plan set");
  }
  const artifactKeys = Object.keys(state.artifacts).sort();
  const expectedKeys = [...requiredArtifactIds].sort();
  if (!arraysEqual(artifactKeys, expectedKeys)) {
    throw new Error("Generation state artifact map keys do not match the complete plan set");
  }

  for (const artifactId of requiredArtifactIds) {
    const artifactState = state.artifacts[artifactId];
    if (!artifactState || artifactState.artifact_id !== artifactId) {
      throw new Error(`Generation state embedded artifact_id does not match key ${artifactId}`);
    }
    if (artifactState.required !== true) {
      throw new Error(`Generation state artifact is not required: ${artifactId}`);
    }
    assertStoredArtifactState(
      artifactState,
      requirePlanArtifact(plan, artifactId),
      state.artifacts,
      state.created_at,
      state.updated_at,
    );
  }

  const derivedPhase = derivePhase(state.artifacts, requiredArtifactIds);
  if (state.phase === "publish-ready") {
    if (derivedPhase !== "verified") {
      throw new Error("A publish-ready generation must derive from verified artifacts");
    }
    validateOfflineRockCompletenessGates(state.completeness_gates);
    if (state.completeness_gates.some((gate) => gate.status !== "pass")) {
      throw new Error("A publish-ready generation requires passing completeness gates");
    }
  } else if (state.phase !== derivedPhase) {
    throw new Error(
      `Generation state phase ${state.phase} does not match derived phase ${derivedPhase}`,
    );
  } else if (state.completeness_gates !== null) {
    throw new Error("Completeness gates are only valid for a publish-ready generation");
  }
  return requiredArtifactIds;
}

function isPlanExecutionReady(plan: OfflineBootstrapPlan): boolean {
  return (
    plan.download_authorization === "authorized" &&
    plan.capacity_gate.status === "pass" &&
    plan.execution_ready === true
  );
}

function assertStoredArtifactState(
  state: OfflineGenerationArtifactState,
  artifact: OfflineBootstrapArtifact,
  artifacts: Readonly<Record<string, OfflineGenerationArtifactState>>,
  createdAt: string,
  updatedAt: string,
): void {
  assertArtifactStatus(state.status, state.artifact_id);
  if (typeof state.download_complete !== "boolean") {
    throw new Error(`${state.artifact_id} download_complete must be a boolean`);
  }
  assertNonNegativeSafeInteger(state.bytes_on_disk, `${state.artifact_id} bytes_on_disk`);
  if (state.bytes_on_disk > artifact.max_bytes) {
    throw new Error(`${state.artifact_id} bytes_on_disk exceeds max bytes`);
  }
  if (
    artifact.expected_bytes !== null &&
    state.bytes_on_disk > artifact.expected_bytes
  ) {
    throw new Error(`${state.artifact_id} bytes_on_disk exceeds expected bytes`);
  }
  if (state.status === "pending") {
    if (
      state.observed_at !== null ||
      state.bytes_on_disk !== 0 ||
      state.download_complete ||
      state.observed_sha256 !== null ||
      state.verification_evidence !== null
    ) {
      throw new Error(`${state.artifact_id} pending state is inconsistent`);
    }
    return;
  }
  if (state.observed_at === null) {
    throw new Error(`${state.artifact_id} non-pending state requires observed_at`);
  }
  assertIsoTimestamp(state.observed_at, `${state.artifact_id} observed_at`);
  if (Date.parse(state.observed_at) < Date.parse(createdAt)) {
    throw new Error(`${state.artifact_id} observed_at cannot precede state created_at`);
  }
  if (Date.parse(state.observed_at) > Date.parse(updatedAt)) {
    throw new Error(`${state.artifact_id} observed_at exceeds state updated_at`);
  }
  if (state.status === "partial") {
    if (
      state.bytes_on_disk === 0 ||
      state.download_complete ||
      state.observed_sha256 !== null ||
      state.verification_evidence !== null
    ) {
      throw new Error(`${state.artifact_id} partial state is inconsistent`);
    }
    return;
  }
  assertCompletedBytes(artifact, state.bytes_on_disk);
  if (!state.download_complete) {
    throw new Error(`${state.artifact_id} completed state requires download_complete`);
  }
  if (state.status === "downloaded") {
    if (state.observed_sha256 !== null || state.verification_evidence !== null) {
      throw new Error(`${state.artifact_id} downloaded state is inconsistent`);
    }
    return;
  }
  if (!state.observed_sha256 || !/^[0-9a-f]{64}$/.test(state.observed_sha256)) {
    throw new Error(`${state.artifact_id} verified state requires a canonical SHA-256`);
  }
  if (state.verification_evidence === null) {
    throw new Error(`${state.artifact_id} verified state requires verification evidence`);
  }
  assertVerificationEvidence(
    artifact,
    state.verification_evidence,
    state.observed_sha256,
    artifacts,
    state.observed_at,
  );
}

function assertVerificationEvidence(
  artifact: OfflineBootstrapArtifact,
  evidence: OfflineArtifactVerificationEvidence | null,
  observedSha256: string | null,
  artifacts: Readonly<Record<string, OfflineGenerationArtifactState>>,
  verifiedAt: string,
): asserts evidence is OfflineArtifactVerificationEvidence {
  if (evidence === null || typeof evidence !== "object" || Array.isArray(evidence)) {
    throw new Error(`${artifact.artifact_id} verification_evidence must be structured`);
  }
  const planned = artifact.verification;
  if (evidence.method !== planned.method) {
    throw new Error(
      `${artifact.artifact_id} verification evidence method must be ${planned.method}`,
    );
  }
  const expectedKeys = verificationEvidenceKeys(planned.method);
  if (!arraysEqual(Object.keys(evidence).sort(), [...expectedKeys].sort())) {
    throw new Error(`${artifact.artifact_id} verification evidence fields do not match the plan`);
  }
  assertCanonicalSha256(evidence.verified_sha256, `${artifact.artifact_id} verified_sha256`);
  if (evidence.verified_sha256 !== observedSha256) {
    throw new Error(`${artifact.artifact_id} verified_sha256 does not match observed_sha256`);
  }

  if (planned.method === "transport-size-only") return;
  if (planned.method === "signed-metadata") {
    if (
      evidence.method !== "signed-metadata" ||
      evidence.signature_artifact_id !== planned.signature_artifact_id
    ) {
      throw new Error(`${artifact.artifact_id} signed metadata evidence does not match the plan`);
    }
    if (evidence.trusted_fingerprint !== planned.trusted_fingerprint) {
      throw new Error(`${artifact.artifact_id} verification fingerprint does not match the plan`);
    }
    if (evidence.signature_verified !== true) {
      throw new Error(`${artifact.artifact_id} signature_verified must be true`);
    }
    assertDependencyVerified(
      artifact.artifact_id,
      planned.signature_artifact_id,
      artifacts,
      verifiedAt,
    );
    return;
  }
  if (planned.method === "sha256-manifest") {
    if (
      evidence.method !== "sha256-manifest" ||
      evidence.checksum_artifact_id !== planned.checksum_artifact_id
    ) {
      throw new Error(`${artifact.artifact_id} checksum evidence does not match the plan`);
    }
    assertCanonicalSha256(
      evidence.manifest_expected_sha256,
      `${artifact.artifact_id} manifest_expected_sha256`,
    );
    if (evidence.manifest_expected_sha256 !== observedSha256) {
      throw new Error(
        `${artifact.artifact_id} manifest_expected_sha256 does not match observed_sha256`,
      );
    }
    const checksum = assertDependencyVerified(
      artifact.artifact_id,
      planned.checksum_artifact_id,
      artifacts,
      verifiedAt,
    );
    assertCanonicalSha256(
      evidence.checksum_manifest_sha256,
      `${artifact.artifact_id} checksum_manifest_sha256`,
    );
    if (evidence.checksum_manifest_sha256 !== checksum.observed_sha256) {
      throw new Error(
        `${artifact.artifact_id} checksum_manifest_sha256 does not match verified checksum artifact`,
      );
    }
    return;
  }
  if (
    evidence.method !== "sha256-signed-manifest" ||
    evidence.checksum_artifact_id !== planned.checksum_artifact_id ||
    evidence.signature_artifact_id !== planned.signature_artifact_id
  ) {
    throw new Error(`${artifact.artifact_id} signed manifest evidence does not match the plan`);
  }
  if (evidence.trusted_fingerprint !== planned.trusted_fingerprint) {
    throw new Error(`${artifact.artifact_id} verification fingerprint does not match the plan`);
  }
  if (evidence.signature_verified !== true) {
    throw new Error(`${artifact.artifact_id} signature_verified must be true`);
  }
  assertCanonicalSha256(
    evidence.manifest_expected_sha256,
    `${artifact.artifact_id} manifest_expected_sha256`,
  );
  if (evidence.manifest_expected_sha256 !== observedSha256) {
    throw new Error(
      `${artifact.artifact_id} manifest_expected_sha256 does not match observed_sha256`,
    );
  }
  const checksum = assertDependencyVerified(
    artifact.artifact_id,
    planned.checksum_artifact_id,
    artifacts,
    verifiedAt,
  );
  assertCanonicalSha256(
    evidence.checksum_manifest_sha256,
    `${artifact.artifact_id} checksum_manifest_sha256`,
  );
  if (evidence.checksum_manifest_sha256 !== checksum.observed_sha256) {
    throw new Error(
      `${artifact.artifact_id} checksum_manifest_sha256 does not match verified checksum artifact`,
    );
  }
  assertDependencyVerified(
    artifact.artifact_id,
    planned.signature_artifact_id,
    artifacts,
    verifiedAt,
  );
}

function verificationEvidenceKeys(
  method: OfflineArtifactVerificationEvidence["method"],
): readonly string[] {
  if (method === "transport-size-only") return ["method", "verified_sha256"];
  if (method === "signed-metadata") {
    return [
      "method",
      "verified_sha256",
      "signature_artifact_id",
      "signature_verified",
      "trusted_fingerprint",
    ];
  }
  if (method === "sha256-manifest") {
    return [
      "method",
      "verified_sha256",
      "manifest_expected_sha256",
      "checksum_artifact_id",
      "checksum_manifest_sha256",
    ];
  }
  return [
    "method",
    "verified_sha256",
    "manifest_expected_sha256",
    "checksum_artifact_id",
    "checksum_manifest_sha256",
    "signature_artifact_id",
    "signature_verified",
    "trusted_fingerprint",
  ];
}

function assertDependencyVerified(
  artifactId: string,
  dependencyId: string,
  artifacts: Readonly<Record<string, OfflineGenerationArtifactState>>,
  verifiedAt: string,
): OfflineGenerationArtifactState {
  const dependency = artifacts[dependencyId];
  if (dependency?.status !== "verified") {
    throw new Error(`${artifactId} verification requires ${dependencyId} to be verified`);
  }
  if (dependency.observed_at === null) {
    throw new Error(`${dependencyId} verified dependency requires observed_at`);
  }
  assertIsoTimestamp(dependency.observed_at, `${dependencyId} observed_at`);
  if (Date.parse(dependency.observed_at) > Date.parse(verifiedAt)) {
    throw new Error(`${dependencyId} was observed after verified archive ${artifactId}`);
  }
  assertCanonicalSha256(
    dependency.observed_sha256,
    `${dependencyId} verified dependency observed_sha256`,
  );
  return dependency;
}

function assertCompletedBytes(artifact: OfflineBootstrapArtifact, bytesOnDisk: number): void {
  if (bytesOnDisk === 0) {
    throw new Error(`${artifact.artifact_id} cannot complete with zero bytes`);
  }
  if (artifact.expected_bytes !== null && bytesOnDisk !== artifact.expected_bytes) {
    throw new Error(
      `${artifact.artifact_id} download_complete requires exactly ${artifact.expected_bytes} bytes`,
    );
  }
}

function cloneArtifacts(
  artifacts: Readonly<Record<string, OfflineGenerationArtifactState>>,
): Record<string, OfflineGenerationArtifactState> {
  return Object.fromEntries(
    Object.entries(artifacts).map(([artifactId, artifact]) => [
      artifactId,
      {
        ...artifact,
        verification_evidence: cloneVerificationEvidence(artifact.verification_evidence),
      },
    ]),
  );
}

function cloneVerificationEvidence(
  evidence: OfflineArtifactVerificationEvidence | null,
): OfflineArtifactVerificationEvidence | null {
  return evidence === null ? null : ({ ...evidence } as OfflineArtifactVerificationEvidence);
}

function cloneGates(
  gates:
    | readonly OfflineCompletenessGate[]
    | readonly OfflineCompletenessGateSnapshot[]
    | null,
): OfflineCompletenessGateSnapshot[] | null {
  return gates === null
    ? null
    : gates.map((gate) => ({ ...gate, evidence: { ...gate.evidence } }));
}

function arraysEqual<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function requirePlanArtifact(
  plan: OfflineBootstrapPlan,
  artifactId: string,
): OfflineBootstrapArtifact {
  const matches = plan.artifacts.filter((artifact) => artifact.artifact_id === artifactId);
  if (matches.length !== 1) {
    throw new Error(`Unknown or duplicate plan artifact: ${artifactId}`);
  }
  return matches[0]!;
}

function derivePhase(
  artifacts: Readonly<Record<string, OfflineGenerationArtifactState>>,
  requiredArtifactIds: readonly string[],
): Exclude<OfflineGenerationPhase, "publish-ready"> {
  const statuses = requiredArtifactIds.map((artifactId) => artifacts[artifactId]?.status);
  if (statuses.length > 0 && statuses.every((status) => status === "verified")) {
    return "verified";
  }
  if (
    statuses.length > 0 &&
    statuses.every(
      (status) => status !== undefined && STATUS_RANK[status] >= STATUS_RANK.downloaded,
    )
  ) {
    return "downloaded";
  }
  if (statuses.some((status) => status !== undefined && status !== "pending")) {
    return "downloading";
  }
  return "planned";
}

function assertArtifactStatus(
  value: unknown,
  artifactId: string,
): asserts value is OfflineArtifactStatus {
  if (
    value !== "pending" &&
    value !== "partial" &&
    value !== "downloaded" &&
    value !== "verified"
  ) {
    throw new Error(`${artifactId} has invalid status: ${String(value)}`);
  }
}

function assertCanonicalSha256(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${name} must be 64 lowercase hexadecimal digits`);
  }
}

function assertIsoTimestamp(value: string, name: string): void {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime()) || timestamp.toISOString() !== value) {
    throw new Error(`${name} must be a canonical UTC ISO timestamp`);
  }
}

function assertNonNegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
}
