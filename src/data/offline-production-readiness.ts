import { createHash } from "node:crypto";

import type { OfflineBootstrapMachinePlan } from "./offline-bootstrap-plan.ts";

export type OfflineProductionStageId =
  | "acquire"
  | "verify"
  | "musicbrainz-stage"
  | "discogs-rock-stage"
  | "wikidata-tracked-fetch"
  | "canonical-project"
  | "quality-gates"
  | "publish";

export type OfflineProductionToolId = "node" | "python3" | "gpg" | "psql";

export interface OfflineProductionImplementationCheck {
  stage_id: OfflineProductionStageId;
  implemented: boolean;
  evidence_paths: string[];
  detail: string;
}

export interface OfflineProductionToolCheck {
  tool_id: OfflineProductionToolId;
  available: boolean;
  detail: string;
}

export interface OfflineProductionReadinessInput {
  generatedAt: string;
  machinePlan: OfflineBootstrapMachinePlan;
  implementationChecks: OfflineProductionImplementationCheck[];
  toolChecks: OfflineProductionToolCheck[];
}

export interface OfflineProductionBlocker {
  blocker_kind:
    | "missing-implementation"
    | "missing-tool"
    | "blocked-capacity"
    | "not-authorized";
  stage_id: OfflineProductionStageId;
  detail: string;
}

export interface OfflineProductionStageReadiness {
  stage_id: OfflineProductionStageId;
  label: string;
  status: "ready" | "blocked" | "missing-implementation";
  implemented: boolean;
  implementation_detail: string;
  evidence_paths: string[];
  required_tools: OfflineProductionToolId[];
}

export interface OfflineProductionReadinessReport {
  report_version: "1.0";
  generated_at: string;
  mode: "read-only-preflight";
  network_requests_executed: 0;
  full_archives_downloaded: false;
  data_root_mutated: false;
  generation_id: string;
  bootstrap_plan_fingerprint: string;
  data_root: string;
  overall_status: "ready" | "blocked";
  readiness_fingerprint: string;
  tools: OfflineProductionToolCheck[];
  stages: OfflineProductionStageReadiness[];
  blockers: OfflineProductionBlocker[];
}

interface StageDefinition {
  stage_id: OfflineProductionStageId;
  label: string;
  required_tools: OfflineProductionToolId[];
}

const STAGES: StageDefinition[] = [
  { stage_id: "acquire", label: "Acquire source artifacts", required_tools: ["node"] },
  { stage_id: "verify", label: "Verify source artifacts", required_tools: ["node", "gpg"] },
  {
    stage_id: "musicbrainz-stage",
    label: "Stage MusicBrainz core dump",
    required_tools: ["psql"],
  },
  {
    stage_id: "discogs-rock-stage",
    label: "Stage Discogs Rock closure",
    required_tools: ["python3"],
  },
  {
    stage_id: "wikidata-tracked-fetch",
    label: "Fetch tracked Wikidata entities",
    required_tools: ["node"],
  },
  {
    stage_id: "canonical-project",
    label: "Project canonical rock graph",
    required_tools: ["psql"],
  },
  { stage_id: "quality-gates", label: "Run completeness and quality gates", required_tools: ["node"] },
  { stage_id: "publish", label: "Publish an audited generation", required_tools: ["node"] },
];

const TOOL_ORDER: OfflineProductionToolId[] = ["node", "python3", "gpg", "psql"];

export function buildOfflineProductionReadiness(
  input: OfflineProductionReadinessInput,
): OfflineProductionReadinessReport {
  validateTimestamp(input.generatedAt);
  validateMachinePlan(input.machinePlan);
  const implementations = validateImplementationChecks(input.implementationChecks);
  const tools = validateToolChecks(input.toolChecks);
  const blockers: OfflineProductionBlocker[] = [];

  for (const definition of STAGES) {
    const implementation = implementations.get(definition.stage_id)!;
    if (!implementation.implemented) {
      blockers.push({
        blocker_kind: "missing-implementation",
        stage_id: definition.stage_id,
        detail: implementation.detail,
      });
      continue;
    }
    for (const toolId of definition.required_tools) {
      const tool = tools.get(toolId)!;
      if (!tool.available) {
        blockers.push({
          blocker_kind: "missing-tool",
          stage_id: definition.stage_id,
          detail: `required tool ${toolId} is unavailable: ${tool.detail}`,
        });
      }
    }
  }

  if (input.machinePlan.capacity_gate.status === "blocked") {
    blockers.push({
      blocker_kind: "blocked-capacity",
      stage_id: "acquire",
      detail: `target filesystem has ${input.machinePlan.capacity_gate.filesystem_available_bytes} bytes available but requires ${input.machinePlan.capacity_gate.required_free_bytes} bytes`,
    });
  }
  if (input.machinePlan.download_authorization === "not-authorized") {
    blockers.push({
      blocker_kind: "not-authorized",
      stage_id: "acquire",
      detail: "full archive download is not authorized",
    });
  }

  const stages = STAGES.map((definition): OfflineProductionStageReadiness => {
    const implementation = implementations.get(definition.stage_id)!;
    const stageBlockers = blockers.filter((blocker) => blocker.stage_id === definition.stage_id);
    return {
      stage_id: definition.stage_id,
      label: definition.label,
      status: !implementation.implemented
        ? "missing-implementation"
        : stageBlockers.length > 0
          ? "blocked"
          : "ready",
      implemented: implementation.implemented,
      implementation_detail: implementation.detail,
      evidence_paths: [...implementation.evidence_paths],
      required_tools: [...definition.required_tools],
    };
  });

  const report: Omit<OfflineProductionReadinessReport, "readiness_fingerprint"> = {
    report_version: "1.0",
    generated_at: input.generatedAt,
    mode: "read-only-preflight",
    network_requests_executed: 0,
    full_archives_downloaded: false,
    data_root_mutated: false,
    generation_id: input.machinePlan.generation_id,
    bootstrap_plan_fingerprint: input.machinePlan.plan_fingerprint,
    data_root: input.machinePlan.data_root,
    overall_status: blockers.length === 0 ? "ready" : "blocked",
    tools: TOOL_ORDER.map((toolId) => ({ ...tools.get(toolId)! })),
    stages,
    blockers,
  };
  return {
    ...report,
    readiness_fingerprint: computeOfflineProductionReadinessFingerprint(report),
  };
}

export function computeOfflineProductionReadinessFingerprint(
  report: Omit<OfflineProductionReadinessReport, "readiness_fingerprint">,
): string {
  return createHash("sha256").update(JSON.stringify(report)).digest("hex");
}

function validateTimestamp(value: string): void {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || !value.endsWith("Z")) {
    throw new Error("generatedAt must be an ISO-8601 UTC timestamp");
  }
}

function validateMachinePlan(plan: OfflineBootstrapMachinePlan): void {
  if (
    !plan ||
    plan.plan_version !== "1.0" ||
    plan.mode !== "dry-run" ||
    typeof plan.generation_id !== "string" ||
    !/^[0-9a-f]{64}$/.test(plan.plan_fingerprint) ||
    typeof plan.data_root !== "string" ||
    (plan.capacity_gate?.status !== "pass" && plan.capacity_gate?.status !== "blocked") ||
    (plan.download_authorization !== "authorized" &&
      plan.download_authorization !== "not-authorized")
  ) {
    throw new Error("Unsupported or malformed offline bootstrap machine plan");
  }
}

function validateImplementationChecks(
  checks: OfflineProductionImplementationCheck[],
): Map<OfflineProductionStageId, OfflineProductionImplementationCheck> {
  if (!Array.isArray(checks)) throw new Error("implementation checks must be an array");
  const expected = new Set(STAGES.map((stage) => stage.stage_id));
  const values = new Map<OfflineProductionStageId, OfflineProductionImplementationCheck>();
  for (const check of checks) {
    if (!expected.has(check.stage_id)) {
      throw new Error(`Unknown implementation check: ${String(check.stage_id)}`);
    }
    if (values.has(check.stage_id)) {
      throw new Error(`Duplicate implementation check: ${check.stage_id}`);
    }
    if (typeof check.implemented !== "boolean" || !check.detail.trim()) {
      throw new Error(`Invalid implementation check: ${check.stage_id}`);
    }
    if (!Array.isArray(check.evidence_paths) || check.evidence_paths.some((path) => !path.trim())) {
      throw new Error(`Invalid implementation evidence: ${check.stage_id}`);
    }
    if (check.implemented && check.evidence_paths.length === 0) {
      throw new Error(`implemented stage ${check.stage_id} requires evidence`);
    }
    values.set(check.stage_id, {
      ...check,
      evidence_paths: [...check.evidence_paths],
    });
  }
  if (values.size !== STAGES.length) {
    throw new Error(`Production readiness requires ${STAGES.length} implementation checks`);
  }
  return values;
}

function validateToolChecks(
  checks: OfflineProductionToolCheck[],
): Map<OfflineProductionToolId, OfflineProductionToolCheck> {
  if (!Array.isArray(checks)) throw new Error("tool checks must be an array");
  const expected = new Set(TOOL_ORDER);
  const values = new Map<OfflineProductionToolId, OfflineProductionToolCheck>();
  for (const check of checks) {
    if (!expected.has(check.tool_id)) throw new Error(`Unknown tool check: ${String(check.tool_id)}`);
    if (values.has(check.tool_id)) throw new Error(`Duplicate tool check: ${check.tool_id}`);
    if (typeof check.available !== "boolean" || !check.detail.trim()) {
      throw new Error(`Invalid tool check: ${check.tool_id}`);
    }
    values.set(check.tool_id, { ...check });
  }
  if (values.size !== TOOL_ORDER.length) {
    throw new Error(`Production readiness requires ${TOOL_ORDER.length} tool checks`);
  }
  return values;
}
