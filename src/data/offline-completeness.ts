export interface OfflineRockCompletenessInput {
  source_scope: {
    musicbrainz_core_full: boolean;
    discogs_monthly_full: boolean;
    wikidata_tracked_closure_full: boolean;
  };
  source_integrity: {
    musicbrainz_signature_verified: boolean;
    discogs_checksums_verified: boolean;
    wikidata_revisions_complete: boolean;
  };
  styles: {
    discogs_observed: number;
    discogs_retained_accepted_or_candidate: number;
    wikidata_closure_qids: number;
    wikidata_entities_with_revision: number;
    unresolved_without_status: number;
  };
  artists: {
    qualifying: number;
    materialized: number;
    missing_references: number;
    qualifying_catalog_owner_misses: number;
  };
  discography: {
    release_groups: number;
    releases: number;
    media: number;
    missing_release_group_references: number;
    missing_medium_references: number;
    missing_track_references: number;
  };
  identity: {
    evidence_records: number;
    accounted_evidence_records: number;
    unquarantined_conflicts: number;
  };
  licensing: { unpartitioned_rows: number };
  updates: {
    candidate_generation_audited: boolean;
    atomic_publish_verified: boolean;
    previous_generation_retained: boolean;
  };
}

export interface OfflineRockCompletenessAssessment {
  assessment_version: "1.0";
  operationally_complete: boolean;
  gates: Array<{
    id:
      | "full-source-scope"
      | "source-integrity"
      | "style-closure"
      | "artist-closure"
      | "discography-closure"
      | "identity-accounting"
      | "license-partition"
      | "atomic-update-readiness";
    status: "pass" | "fail";
    evidence: Record<string, boolean | number>;
  }>;
}

type OfflineCompletenessGate = OfflineRockCompletenessAssessment["gates"][number];
type OfflineCompletenessGateId = OfflineCompletenessGate["id"];
type EvidenceFieldKind = "boolean" | "count";

const GATE_EVIDENCE_SCHEMAS: Record<
  OfflineCompletenessGateId,
  Readonly<Record<string, EvidenceFieldKind>>
> = {
  "full-source-scope": {
    musicbrainz_core_full: "boolean",
    discogs_monthly_full: "boolean",
    wikidata_tracked_closure_full: "boolean",
  },
  "source-integrity": {
    musicbrainz_signature_verified: "boolean",
    discogs_checksums_verified: "boolean",
    wikidata_revisions_complete: "boolean",
  },
  "style-closure": {
    discogs_observed: "count",
    discogs_retained_accepted_or_candidate: "count",
    wikidata_closure_qids: "count",
    wikidata_entities_with_revision: "count",
    unresolved_without_status: "count",
  },
  "artist-closure": {
    qualifying: "count",
    materialized: "count",
    missing_references: "count",
    qualifying_catalog_owner_misses: "count",
  },
  "discography-closure": {
    release_groups: "count",
    releases: "count",
    media: "count",
    missing_release_group_references: "count",
    missing_medium_references: "count",
    missing_track_references: "count",
  },
  "identity-accounting": {
    evidence_records: "count",
    accounted_evidence_records: "count",
    unquarantined_conflicts: "count",
  },
  "license-partition": { unpartitioned_rows: "count" },
  "atomic-update-readiness": {
    candidate_generation_audited: "boolean",
    atomic_publish_verified: "boolean",
    previous_generation_retained: "boolean",
  },
};

export function assessOfflineRockCompleteness(
  input: OfflineRockCompletenessInput,
): OfflineRockCompletenessAssessment {
  validateCounts(input);
  const gates: OfflineRockCompletenessAssessment["gates"] = [
    gate("full-source-scope", input.source_scope),
    gate("source-integrity", input.source_integrity),
    gate("style-closure", input.styles),
    gate("artist-closure", input.artists),
    gate("discography-closure", input.discography),
    gate("identity-accounting", input.identity),
    gate("license-partition", input.licensing),
    gate("atomic-update-readiness", input.updates),
  ];
  return {
    assessment_version: "1.0",
    operationally_complete: gates.every((item) => item.status === "pass"),
    gates,
  };
}

export function validateOfflineRockCompletenessGates(
  gates: unknown,
): asserts gates is OfflineRockCompletenessAssessment["gates"] {
  const expectedGateIds = Object.keys(GATE_EVIDENCE_SCHEMAS) as OfflineCompletenessGateId[];
  if (!Array.isArray(gates) || gates.length !== expectedGateIds.length) {
    throw new Error("Completeness evidence requires exactly eight gates");
  }

  const seen = new Set<OfflineCompletenessGateId>();
  for (const value of gates) {
    if (!isRecord(value)) {
      throw new Error("Completeness gate must be an object");
    }
    assertExactKeys(value, ["evidence", "id", "status"], "Completeness gate");
    const id = value.id;
    if (typeof id !== "string" || !hasOwn(GATE_EVIDENCE_SCHEMAS, id)) {
      throw new Error(`Unknown completeness gate: ${String(id)}`);
    }
    const gateId = id as OfflineCompletenessGateId;
    if (seen.has(gateId)) {
      throw new Error(`Duplicate completeness gate: ${gateId}`);
    }
    seen.add(gateId);
    if (value.status !== "pass" && value.status !== "fail") {
      throw new Error(`${gateId} status must be pass or fail`);
    }
    if (!isRecord(value.evidence)) {
      throw new Error(`${gateId} evidence must be an object`);
    }

    const schema = GATE_EVIDENCE_SCHEMAS[gateId];
    assertExactKeys(value.evidence, Object.keys(schema), `${gateId} evidence`);
    for (const [field, kind] of Object.entries(schema)) {
      const evidenceValue = value.evidence[field];
      if (kind === "boolean") {
        if (typeof evidenceValue !== "boolean") {
          throw new Error(`${gateId} evidence ${field} must be a boolean`);
        }
      } else if (!Number.isSafeInteger(evidenceValue) || (evidenceValue as number) < 0) {
        throw new Error(`${gateId} evidence ${field} must be a non-negative safe integer`);
      }
    }

    const expectedStatus = evaluateGateStatus(
      gateId,
      value.evidence as Record<string, boolean | number>,
    );
    if (value.status !== expectedStatus) {
      throw new Error(`${gateId} status does not match its evidence`);
    }
  }

  if (seen.size !== expectedGateIds.length) {
    throw new Error("Completeness evidence must contain every expected gate");
  }
}

function gate<Id extends OfflineCompletenessGateId>(
  id: Id,
  evidence: Record<string, boolean | number>,
): OfflineCompletenessGate {
  return { id, status: evaluateGateStatus(id, evidence), evidence };
}

function evaluateGateStatus(
  id: OfflineCompletenessGateId,
  evidence: Readonly<Record<string, boolean | number>>,
): "pass" | "fail" {
  const count = (name: string): number => evidence[name] as number;
  const flag = (name: string): boolean => evidence[name] === true;
  let passed: boolean;
  switch (id) {
    case "full-source-scope":
      passed =
        flag("musicbrainz_core_full") &&
        flag("discogs_monthly_full") &&
        flag("wikidata_tracked_closure_full");
      break;
    case "source-integrity":
      passed =
        flag("musicbrainz_signature_verified") &&
        flag("discogs_checksums_verified") &&
        flag("wikidata_revisions_complete");
      break;
    case "style-closure":
      passed =
        count("discogs_observed") > 0 &&
        count("discogs_retained_accepted_or_candidate") === count("discogs_observed") &&
        count("wikidata_closure_qids") > 0 &&
        count("wikidata_entities_with_revision") === count("wikidata_closure_qids") &&
        count("unresolved_without_status") === 0;
      break;
    case "artist-closure":
      passed =
        count("qualifying") > 0 &&
        count("materialized") >= count("qualifying") &&
        count("missing_references") === 0 &&
        count("qualifying_catalog_owner_misses") === 0;
      break;
    case "discography-closure":
      passed =
        count("release_groups") > 0 &&
        count("releases") > 0 &&
        count("media") > 0 &&
        count("missing_release_group_references") === 0 &&
        count("missing_medium_references") === 0 &&
        count("missing_track_references") === 0;
      break;
    case "identity-accounting":
      passed =
        count("evidence_records") > 0 &&
        count("accounted_evidence_records") === count("evidence_records") &&
        count("unquarantined_conflicts") === 0;
      break;
    case "license-partition":
      passed = count("unpartitioned_rows") === 0;
      break;
    case "atomic-update-readiness":
      passed =
        flag("candidate_generation_audited") &&
        flag("atomic_publish_verified") &&
        flag("previous_generation_retained");
      break;
  }
  return passed ? "pass" : "fail";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(object: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function assertExactKeys(
  value: Readonly<Record<string, unknown>>,
  expectedKeys: readonly string[],
  name: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${name} fields do not match the expected schema`);
  }
}

function validateCounts(input: OfflineRockCompletenessInput): void {
  const countGroups = [input.styles, input.artists, input.discography, input.identity, input.licensing];
  for (const group of countGroups) {
    for (const [name, value] of Object.entries(group)) {
      if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) {
        throw new Error(`Invalid completeness count ${name}: ${value}`);
      }
    }
  }
}
