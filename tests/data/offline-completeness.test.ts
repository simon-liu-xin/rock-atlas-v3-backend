import { describe, expect, test } from "vitest";

import {
  assessOfflineRockCompleteness,
  type OfflineRockCompletenessInput,
  validateOfflineRockCompletenessGates,
} from "../../src/data/offline-completeness.ts";

const completeInput: OfflineRockCompletenessInput = {
  source_scope: {
    musicbrainz_core_full: true,
    discogs_monthly_full: true,
    wikidata_tracked_closure_full: true,
  },
  source_integrity: {
    musicbrainz_signature_verified: true,
    discogs_checksums_verified: true,
    wikidata_revisions_complete: true,
  },
  styles: {
    discogs_observed: 600,
    discogs_retained_accepted_or_candidate: 600,
    wikidata_closure_qids: 838,
    wikidata_entities_with_revision: 838,
    unresolved_without_status: 0,
  },
  artists: {
    qualifying: 2_000_000,
    materialized: 2_300_000,
    missing_references: 0,
    qualifying_catalog_owner_misses: 0,
  },
  discography: {
    release_groups: 4_000_000,
    releases: 10_000_000,
    media: 15_000_000,
    missing_release_group_references: 0,
    missing_medium_references: 0,
    missing_track_references: 0,
  },
  identity: {
    evidence_records: 1_000_000,
    accounted_evidence_records: 1_000_000,
    unquarantined_conflicts: 0,
  },
  licensing: { unpartitioned_rows: 0 },
  updates: {
    candidate_generation_audited: true,
    atomic_publish_verified: true,
    previous_generation_retained: true,
  },
};

describe("offline Rock operational completeness", () => {
  test("passes only when all eight full-source and closure gates are proven", () => {
    const assessment = assessOfflineRockCompleteness(completeInput);

    expect(assessment.operationally_complete).toBe(true);
    expect(assessment.gates).toHaveLength(8);
    expect(assessment.gates.every((gate) => gate.status === "pass")).toBe(true);
  });

  test("does not mislabel a valid sample as a complete offline database", () => {
    const assessment = assessOfflineRockCompleteness({
      ...completeInput,
      source_scope: {
        musicbrainz_core_full: false,
        discogs_monthly_full: false,
        wikidata_tracked_closure_full: false,
      },
    });

    expect(assessment.operationally_complete).toBe(false);
    expect(assessment.gates.find((gate) => gate.id === "full-source-scope")?.status).toBe("fail");
  });

  test("fails the discography gate on any unresolved release, medium, or track reference", () => {
    const assessment = assessOfflineRockCompleteness({
      ...completeInput,
      discography: { ...completeInput.discography, missing_track_references: 1 },
    });

    expect(assessment.operationally_complete).toBe(false);
    expect(assessment.gates.find((gate) => gate.id === "discography-closure")?.status).toBe(
      "fail",
    );
  });

  test("validates persisted gate evidence against exact schemas and assessment formulas", () => {
    const gates = JSON.parse(
      JSON.stringify(assessOfflineRockCompleteness(completeInput).gates),
    ) as unknown;

    expect(() => validateOfflineRockCompletenessGates(gates)).not.toThrow();
  });

  test.each([
    {
      name: "empty evidence",
      mutate: (gates: unknown[]) => {
        (gates[0] as { evidence: object }).evidence = {};
      },
      error: "fields",
    },
    {
      name: "extra evidence field",
      mutate: (gates: unknown[]) => {
        ((gates[0] as { evidence: Record<string, unknown> }).evidence).extra = true;
      },
      error: "fields",
    },
    {
      name: "non-boolean evidence",
      mutate: (gates: unknown[]) => {
        (gates[0] as { evidence: Record<string, unknown> }).evidence.musicbrainz_core_full =
          "true";
      },
      error: "boolean",
    },
    {
      name: "negative count evidence",
      mutate: (gates: unknown[]) => {
        (gates[2] as { evidence: Record<string, unknown> }).evidence.discogs_observed = -1;
      },
      error: "safe integer",
    },
    {
      name: "forged status",
      mutate: (gates: unknown[]) => {
        (gates[0] as { status: string }).status = "fail";
      },
      error: "status",
    },
  ])("rejects $name in persisted gate evidence", ({ mutate, error }) => {
    const gates = JSON.parse(
      JSON.stringify(assessOfflineRockCompleteness(completeInput).gates),
    ) as unknown[];
    mutate(gates);

    expect(() => validateOfflineRockCompletenessGates(gates)).toThrow(error);
  });
});
