import { describe, expect, test } from "vitest";

import {
  buildOfflineBootstrapPlan,
  type OfflineBootstrapPlanInput,
} from "../../src/data/offline-bootstrap-plan.ts";

const fixedSourceSnapshots: OfflineBootstrapPlanInput["sourceSnapshots"] = {
  musicbrainz: {
    snapshot_id: "20260801-002250",
    directory_url:
      "https://data.metabrainz.org/pub/musicbrainz/data/fullexport/20260801-002250/",
    files: [
      {
        name: "mbdump-derived.tar.bz2",
        bytes: 507_409_554,
        license_partition: "musicbrainz-derived-nc",
      },
      {
        name: "mbdump.tar.bz2",
        bytes: 7_400_395_332,
        license_partition: "musicbrainz-core-cc0",
      },
    ],
  },
  discogs: {
    snapshot_id: "20260801",
    directory_url: "https://data.discogs.com/?prefix=data/2026/",
    files: [
      {
        name: "discogs_20260801_CHECKSUM.txt",
        bytes: 388,
        license_partition: "discogs-cc0",
      },
      {
        name: "discogs_20260801_artists.xml.gz",
        bytes: 471_600_000,
        license_partition: "discogs-cc0",
      },
      {
        name: "discogs_20260801_labels.xml.gz",
        bytes: 85_900_000,
        license_partition: "discogs-cc0",
      },
      {
        name: "discogs_20260801_masters.xml.gz",
        bytes: 593_200_000,
        license_partition: "discogs-cc0",
      },
      {
        name: "discogs_20260801_releases.xml.gz",
        bytes: 10_400_000_000,
        license_partition: "discogs-cc0",
      },
    ],
  },
};

function makeInput(
  overrides: Partial<OfflineBootstrapPlanInput> = {},
): OfflineBootstrapPlanInput {
  return {
    generatedAt: "2026-08-03T08:00:00.000Z",
    repositoryRoot: "/workspace/music-wiki",
    dataRoot: "/Volumes/MusicWikiData",
    downloadAuthorized: false,
    capacityGate: {
      status: "pass",
      filesystem_capacity_bytes: 512_000_000_000,
      filesystem_available_bytes: 400_000_000_000,
      required_free_bytes: 381_448_295_016,
    },
    sourceConfig: {
      musicbrainzSigningKeyFingerprint: "D5E63B4BDCCE195642948684B8FC2375C777580F",
      metadataMaxBytes: 10_000_000,
    },
    sourceSnapshots: structuredClone(fixedSourceSnapshots),
    ...overrides,
  };
}

describe("offline bootstrap plan", () => {
  test("builds the complete deterministic dry-run artifact manifest", () => {
    const plan = buildOfflineBootstrapPlan(makeInput());

    expect(plan).toMatchObject({
      plan_version: "1.0",
      generated_at: "2026-08-03T08:00:00.000Z",
      mode: "dry-run",
      network_requests_executed: 0,
      full_archives_downloaded: false,
      generation_id: "mb-20260801-002250__discogs-20260801",
      data_root: "/Volumes/MusicWikiData",
      download_authorization: "not-authorized",
      execution_ready: false,
      known_download_bytes: 18_951_095_720,
      layout: {
        incoming: {
          musicbrainz: "incoming/musicbrainz/20260801-002250/",
          discogs: "incoming/discogs/20260801/",
        },
        verified: {
          musicbrainz: "verified/musicbrainz/20260801-002250/",
          discogs: "verified/discogs/20260801/",
        },
        generation_stage: "generations/mb-20260801-002250__discogs-20260801/stage/",
        generation_canonical:
          "generations/mb-20260801-002250__discogs-20260801/canonical/",
        published: "published/mb-20260801-002250__discogs-20260801/",
        state: "state/mb-20260801-002250__discogs-20260801.json",
      },
    });
    expect(plan.artifacts).toHaveLength(8);
    expect(new Set(plan.artifacts.map((item) => item.artifact_id))).toHaveLength(8);
    expect(plan.artifacts.filter((item) => item.role === "archive")).toHaveLength(5);
    expect(plan.artifacts.map((item) => String(item.license_partition))).not.toContain(
      "musicbrainz-derived-nc",
    );
    expect(plan.plan_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(buildOfflineBootstrapPlan(makeInput()).plan_fingerprint).toBe(
      plan.plan_fingerprint,
    );
  });

  test("models signed MusicBrainz metadata and archive verification dependencies", () => {
    const plan = buildOfflineBootstrapPlan(makeInput());
    const fingerprint = "D5E63B4BDCCE195642948684B8FC2375C777580F";

    expect(
      plan.artifacts.find((item) => item.artifact_id === "musicbrainz:mbdump.tar.bz2"),
    ).toMatchObject({
      role: "archive",
      required: true,
      source_url:
        "https://data.metabrainz.org/pub/musicbrainz/data/fullexport/20260801-002250/mbdump.tar.bz2",
      expected_bytes: 7_400_395_332,
      max_bytes: 7_400_395_332,
      destination_relative: "incoming/musicbrainz/20260801-002250/mbdump.tar.bz2",
      verification: {
        method: "sha256-signed-manifest",
        checksum_artifact_id: "musicbrainz:SHA256SUMS",
        signature_artifact_id: "musicbrainz:SHA256SUMS.asc",
        trusted_fingerprint: fingerprint,
      },
    });
    expect(
      plan.artifacts.find((item) => item.artifact_id === "musicbrainz:SHA256SUMS"),
    ).toMatchObject({
      role: "checksum-manifest",
      expected_bytes: null,
      max_bytes: 10_000_000,
      verification: {
        method: "signed-metadata",
        signature_artifact_id: "musicbrainz:SHA256SUMS.asc",
        trusted_fingerprint: fingerprint,
      },
    });
    expect(
      plan.artifacts.find((item) => item.artifact_id === "musicbrainz:SHA256SUMS.asc"),
    ).toMatchObject({
      role: "signature",
      expected_bytes: null,
      max_bytes: 10_000_000,
      verification: { method: "transport-size-only" },
    });
  });

  test("constructs Discogs archive URLs and checksum dependencies from the official directory", () => {
    const plan = buildOfflineBootstrapPlan(makeInput());
    const releases = plan.artifacts.find((item) => item.artifact_id === "discogs:releases");
    const sourceUrl = new URL(releases?.source_url ?? "");

    expect(sourceUrl.origin).toBe("https://data.discogs.com");
    expect(sourceUrl.searchParams.get("download")).toBe(
      "data/2026/discogs_20260801_releases.xml.gz",
    );
    expect(releases).toMatchObject({
      filename: "discogs_20260801_releases.xml.gz",
      destination_relative:
        "incoming/discogs/20260801/discogs_20260801_releases.xml.gz",
      verification: {
        method: "sha256-manifest",
        checksum_artifact_id: "discogs:CHECKSUM",
      },
    });
    expect(plan.artifacts.find((item) => item.artifact_id === "discogs:CHECKSUM"))
      .toMatchObject({
        filename: "discogs_20260801_CHECKSUM.txt",
        role: "checksum-manifest",
        verification: { method: "transport-size-only" },
      });
  });

  test("requires both authorization and a passing capacity gate for execution readiness", () => {
    expect(
      buildOfflineBootstrapPlan(makeInput({ downloadAuthorized: true })).execution_ready,
    ).toBe(true);
    expect(
      buildOfflineBootstrapPlan(
        makeInput({
          downloadAuthorized: true,
          capacityGate: {
            status: "blocked",
            filesystem_capacity_bytes: 512_000_000_000,
            filesystem_available_bytes: 1,
            required_free_bytes: 381_448_295_016,
          },
        }),
      ).execution_ready,
    ).toBe(false);
    expect(buildOfflineBootstrapPlan(makeInput()).execution_ready).toBe(false);
  });

  test("rejects a capacity requirement below the known artifact download total", () => {
    expect(() =>
      buildOfflineBootstrapPlan(
        makeInput({
          downloadAuthorized: true,
          capacityGate: {
            status: "pass",
            filesystem_capacity_bytes: 512_000_000_000,
            filesystem_available_bytes: 400_000_000_000,
            required_free_bytes: 1,
          },
        }),
      ),
    ).toThrow("known download bytes");
  });

  test("validates capacity gate arithmetic while allowing zero available bytes", () => {
    const zeroAvailable = buildOfflineBootstrapPlan(
      makeInput({
        downloadAuthorized: true,
        capacityGate: {
          status: "blocked",
          filesystem_capacity_bytes: 512_000_000_000,
          filesystem_available_bytes: 0,
          required_free_bytes: 381_448_295_016,
        },
      }),
    );
    expect(zeroAvailable.execution_ready).toBe(false);

    expect(() =>
      buildOfflineBootstrapPlan(
        makeInput({
          capacityGate: {
            status: "blocked",
            filesystem_capacity_bytes: 20_000_000_000,
            filesystem_available_bytes: 20_000_000_001,
            required_free_bytes: 18_951_095_720,
          },
        }),
      ),
    ).toThrow("capacity");
    expect(() =>
      buildOfflineBootstrapPlan(
        makeInput({
          capacityGate: {
            status: "pass",
            filesystem_capacity_bytes: 20_000_000_000,
            filesystem_available_bytes: 18_951_095_719,
            required_free_bytes: 18_951_095_720,
          },
        }),
      ),
    ).toThrow("pass");
    expect(
      buildOfflineBootstrapPlan(
        makeInput({
          downloadAuthorized: true,
          capacityGate: {
            status: "blocked",
            filesystem_capacity_bytes: 20_000_000_000,
            filesystem_available_bytes: 20_000_000_000,
            required_free_bytes: 18_951_095_720,
          },
        }),
      ).execution_ready,
    ).toBe(false);
  });

  test("rejects a known download byte total that exceeds safe integer precision", () => {
    const sourceSnapshots = structuredClone(fixedSourceSnapshots);
    sourceSnapshots.musicbrainz.files[1]!.bytes = Number.MAX_SAFE_INTEGER - 100;

    expect(() =>
      buildOfflineBootstrapPlan(makeInput({ sourceSnapshots })),
    ).toThrow("known_download_bytes");
  });

  test("rejects a data root equal to or nested inside the repository", () => {
    expect(() =>
      buildOfflineBootstrapPlan(makeInput({ dataRoot: "/workspace/music-wiki" })),
    ).toThrow("outside");
    expect(() =>
      buildOfflineBootstrapPlan(
        makeInput({ dataRoot: "/workspace/music-wiki/data/offline" }),
      ),
    ).toThrow("outside");
    expect(() => buildOfflineBootstrapPlan(makeInput({ dataRoot: "relative/data" }))).toThrow(
      "absolute",
    );
  });

  test("rejects missing MusicBrainz or Discogs required archives", () => {
    const missingMusicBrainz = structuredClone(fixedSourceSnapshots);
    missingMusicBrainz.musicbrainz.files = [];
    expect(() =>
      buildOfflineBootstrapPlan(makeInput({ sourceSnapshots: missingMusicBrainz })),
    ).toThrow("mbdump.tar.bz2");

    const missingDiscogs = structuredClone(fixedSourceSnapshots);
    missingDiscogs.discogs.files = missingDiscogs.discogs.files.filter(
      (file) => !file.name.endsWith("masters.xml.gz"),
    );
    expect(() =>
      buildOfflineBootstrapPlan(makeInput({ sourceSnapshots: missingDiscogs })),
    ).toThrow("masters");
  });

  test("rejects source filenames and directories that do not match the declared snapshot", () => {
    const mismatchedDiscogs = structuredClone(fixedSourceSnapshots);
    mismatchedDiscogs.discogs.files[0] = {
      ...mismatchedDiscogs.discogs.files[0]!,
      name: "discogs_20260701_CHECKSUM.txt",
    };
    expect(() =>
      buildOfflineBootstrapPlan(makeInput({ sourceSnapshots: mismatchedDiscogs })),
    ).toThrow("snapshot");

    const mismatchedMusicBrainz = structuredClone(fixedSourceSnapshots);
    mismatchedMusicBrainz.musicbrainz.directory_url =
      "https://data.metabrainz.org/pub/musicbrainz/data/fullexport/20260730-002250/";
    expect(() =>
      buildOfflineBootstrapPlan(makeInput({ sourceSnapshots: mismatchedMusicBrainz })),
    ).toThrow("snapshot");
  });

  test("rejects invalid timestamps, paths, and non-positive or unsafe byte counts", () => {
    expect(() =>
      buildOfflineBootstrapPlan(makeInput({ generatedAt: "August 3, 2026" })),
    ).toThrow("ISO");
    expect(() =>
      buildOfflineBootstrapPlan(
        makeInput({ generatedAt: "2026-02-30T08:00:00.000Z" }),
      ),
    ).toThrow("ISO");
    expect(() =>
      buildOfflineBootstrapPlan(
        makeInput({ generatedAt: "2026-08-03T16:00:00.000+08:00" }),
      ),
    ).toThrow("ISO");
    expect(() =>
      buildOfflineBootstrapPlan(makeInput({ repositoryRoot: "relative/repository" })),
    ).toThrow("absolute");
    expect(() =>
      buildOfflineBootstrapPlan(
        makeInput({ sourceConfig: { ...makeInput().sourceConfig, metadataMaxBytes: 0 } }),
      ),
    ).toThrow("metadataMaxBytes");

    const unsafeBytes = structuredClone(fixedSourceSnapshots);
    unsafeBytes.musicbrainz.files[1]!.bytes = Number.MAX_SAFE_INTEGER + 1;
    expect(() =>
      buildOfflineBootstrapPlan(makeInput({ sourceSnapshots: unsafeBytes })),
    ).toThrow("bytes");
  });
});
