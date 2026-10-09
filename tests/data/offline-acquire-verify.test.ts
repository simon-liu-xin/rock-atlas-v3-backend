import { createHash } from "node:crypto";
import { createServer, type RequestListener } from "node:http";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  buildOfflineBootstrapMachinePlan,
  buildOfflineBootstrapPlan,
  computeOfflineBootstrapPlanFingerprint,
  type OfflineBootstrapMachinePlan,
  type OfflineBootstrapPlan,
  type OfflineBootstrapPlanInput,
} from "../../src/data/offline-bootstrap-plan.ts";
import {
  acquireAndVerifyOfflineArtifacts,
  type OfflineAcquireVerifyResult,
} from "../../src/data/offline-acquire-verify.ts";
import { assertOfflineArtifactVerificationReceipt } from "../../src/data/offline-artifact-verifier.ts";
import type { OfflineGenerationState } from "../../src/data/offline-generation-state.ts";

const FINGERPRINT = "D5E63B4BDCCE195642948684B8FC2375C777580F";
const NOW = "2026-08-03T15:00:00.000Z";
const DOWNLOAD_CONFIRMATION = "I_CONFIRM_FULL_ARCHIVE_DOWNLOAD";
const servers: Array<ReturnType<typeof createServer>> = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("offline acquire and verify executor", () => {
  test("rejects a blocked or unauthorized plan before network or filesystem mutation", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "musicwiki-acquire-blocked-"));
    roots.push(fixtureRoot);
    const dataRoot = join(fixtureRoot, "must-not-exist");
    const source = await readPlan();
    const candidate = {
      ...source,
      data_root: dataRoot,
      artifacts: source.artifacts.map((artifact) => ({
        ...artifact,
        source_url: "http://127.0.0.1:1/must-not-request",
      })),
    };
    const plan = {
      ...candidate,
      plan_fingerprint: computeOfflineBootstrapPlanFingerprint(candidate),
    } as OfflineBootstrapMachinePlan;
    let downloads = 0;

    await expect(
      acquireAndVerifyOfflineArtifacts(plan, {
        observedAt: NOW,
        download: async () => {
          downloads += 1;
          throw new Error("download must not run");
        },
      }),
    ).rejects.toThrow("not execution-ready");

    expect(downloads).toBe(0);
    await expect(stat(dataRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rejects a fingerprint-consistent plan that omits a required v1 artifact", async () => {
    const fixture = await createDownloadFixture();
    const candidate = {
      ...fixture.plan,
      artifacts: fixture.plan.artifacts.filter(
        (artifact) => artifact.artifact_id !== "discogs:labels",
      ),
    };
    const plan = {
      ...candidate,
      plan_fingerprint: computeOfflineBootstrapPlanFingerprint(candidate),
    } as OfflineBootstrapMachinePlan;

    await expect(
      acquireAndVerifyOfflineArtifacts(plan, {
        observedAt: NOW,
        downloadAuthorization: DOWNLOAD_CONFIRMATION,
        allowSourceUrl: (url) => url.startsWith(fixture.baseUrl),
        gpgExecutable: fixture.gpgExecutable,
        statFilesystem: fixture.statFilesystem,
      }),
    ).rejects.toThrow("required artifact contract");
    expect(fixture.requests).toEqual([]);
  });

  test("rejects a fingerprint-consistent base plan without machine evidence fields", async () => {
    const fixture = await createDownloadFixture();
    const {
      capacity_mode: ignoredCapacityMode,
      published_generation_reused: ignoredReused,
      published_reuse_reason: ignoredReason,
      published_content_allocated_bytes: ignoredAllocation,
      target_filesystem: ignoredFilesystem,
      evidence: ignoredEvidence,
      ...base
    } = fixture.plan;
    void ignoredCapacityMode;
    void ignoredReused;
    void ignoredReason;
    void ignoredAllocation;
    void ignoredFilesystem;
    void ignoredEvidence;
    const plan = {
      ...base,
      plan_fingerprint: computeOfflineBootstrapPlanFingerprint(base),
    } as OfflineBootstrapPlan;

    await expect(
      acquireAndVerifyOfflineArtifacts(plan as OfflineBootstrapMachinePlan, {
        observedAt: NOW,
        downloadAuthorization: DOWNLOAD_CONFIRMATION,
        allowSourceUrl: (url) => url.startsWith(fixture.baseUrl),
        gpgExecutable: fixture.gpgExecutable,
        statFilesystem: fixture.statFilesystem,
      }),
    ).rejects.toThrow("machine plan");
    expect(fixture.requests).toEqual([]);
  });

  test("rejects a MusicBrainz URL whose official snapshot differs from the generation", async () => {
    const fixture = await createDownloadFixture(false);
    const candidate = {
      ...fixture.plan,
      artifacts: fixture.plan.artifacts.map((artifact) => ({
        ...artifact,
        source_url:
          artifact.source === "musicbrainz"
            ? artifact.source_url.replace("/20260801-002250/", "/20260725-002250/")
            : artifact.source_url,
      })),
    };
    const plan = {
      ...candidate,
      plan_fingerprint: computeOfflineBootstrapPlanFingerprint(candidate),
    } as OfflineBootstrapMachinePlan;

    await expect(
      acquireAndVerifyOfflineArtifacts(plan, {
        observedAt: NOW,
        downloadAuthorization: DOWNLOAD_CONFIRMATION,
        statFilesystem: fixture.statFilesystem,
      }),
    ).rejects.toThrow("source URL is not approved");
    expect(fixture.requests).toEqual([]);
  });

  test("accepts every planner-shaped official URL without starting a real network request", async () => {
    const fixture = await createDownloadFixture(false);

    await expect(
      acquireAndVerifyOfflineArtifacts(fixture.plan, {
        observedAt: NOW,
        downloadAuthorization: DOWNLOAD_CONFIRMATION,
        gpgExecutable: fixture.gpgExecutable,
        statFilesystem: fixture.statFilesystem,
        download: async () => {
          throw new Error("official URL gate passed");
        },
      }),
    ).rejects.toThrow("official URL gate passed");
    expect(fixture.requests).toEqual([]);
  });

  test("requires a current machine plan and a second execution-time confirmation", async () => {
    const fixture = await createDownloadFixture();
    const staleCandidate = { ...fixture.plan, generated_at: "2026-08-02T14:59:59.999Z" };
    const stalePlan = {
      ...staleCandidate,
      plan_fingerprint: computeOfflineBootstrapPlanFingerprint(staleCandidate),
    } as OfflineBootstrapMachinePlan;

    await expect(
      acquireAndVerifyOfflineArtifacts(stalePlan, {
        observedAt: NOW,
        downloadAuthorization: DOWNLOAD_CONFIRMATION,
        allowSourceUrl: (url) => url.startsWith(fixture.baseUrl),
        gpgExecutable: fixture.gpgExecutable,
        statFilesystem: fixture.statFilesystem,
      }),
    ).rejects.toThrow("stale");
    await expect(
      acquireAndVerifyOfflineArtifacts(fixture.plan, {
        observedAt: NOW,
        allowSourceUrl: (url) => url.startsWith(fixture.baseUrl),
        gpgExecutable: fixture.gpgExecutable,
        statFilesystem: fixture.statFilesystem,
      }),
    ).rejects.toThrow("execution-time download confirmation");
    expect(fixture.requests).toEqual([]);
  });

  test("rejects a state directory symlink without writing outside data_root", async () => {
    const fixture = await createDownloadFixture();
    const external = await mkdtemp(join(tmpdir(), "musicwiki-state-outside-"));
    roots.push(external);
    await symlink(external, resolve(fixture.plan.data_root, "state"), "dir");

    await expect(
      acquireAndVerifyOfflineArtifacts(fixture.plan, {
        observedAt: NOW,
        downloadAuthorization: DOWNLOAD_CONFIRMATION,
        allowSourceUrl: (url) => url.startsWith(fixture.baseUrl),
        gpgExecutable: fixture.gpgExecutable,
        statFilesystem: fixture.statFilesystem,
      }),
    ).rejects.toThrow("generation state path contains a symbolic link");

    expect(await readdir(external)).toEqual([]);
    expect(fixture.requests).toEqual([]);
  });

  test("holds an exclusive generation lock across state and partial-file mutation", async () => {
    const fixture = await createDownloadFixture();
    let releaseFirst!: () => void;
    let reportFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolveStarted) => {
      reportFirstStarted = resolveStarted;
    });
    const release = new Promise<void>((resolveRelease) => {
      releaseFirst = resolveRelease;
    });
    let secondDownloads = 0;
    const first = acquireAndVerifyOfflineArtifacts(fixture.plan, {
      observedAt: NOW,
      downloadAuthorization: DOWNLOAD_CONFIRMATION,
      allowSourceUrl: (url) => url.startsWith(fixture.baseUrl),
      gpgExecutable: fixture.gpgExecutable,
      statFilesystem: fixture.statFilesystem,
      download: async () => {
        reportFirstStarted();
        await release;
        throw new Error("intentional first-run stop");
      },
    });
    await firstStarted;

    await expect(
      acquireAndVerifyOfflineArtifacts(fixture.plan, {
        observedAt: NOW,
        downloadAuthorization: DOWNLOAD_CONFIRMATION,
        allowSourceUrl: (url) => url.startsWith(fixture.baseUrl),
        gpgExecutable: fixture.gpgExecutable,
        statFilesystem: fixture.statFilesystem,
        download: async () => {
          secondDownloads += 1;
          throw new Error("second download must not start");
        },
      }),
    ).rejects.toThrow("already running");
    expect(secondDownloads).toBe(0);
    releaseFirst();
    await expect(first).rejects.toThrow("intentional first-run stop");
  });

  test.each(["dead-owner", "old-incomplete"] as const)(
    "recovers a %s generation lock without touching the network",
    async (kind) => {
      const fixture = await createDownloadFixture();
      const statePath = resolve(fixture.plan.data_root, fixture.plan.layout.state);
      const lockPath = `${statePath}.lock`;
      await mkdir(dirname(statePath), { recursive: true });
      if (kind === "dead-owner") {
        await writeFile(
          lockPath,
          `${JSON.stringify({
            version: "1.0",
            generation_id: fixture.plan.generation_id,
            plan_fingerprint: fixture.plan.plan_fingerprint,
            pid: 999_999_999,
            process_started_at: NOW,
            started_at: NOW,
          })}\n`,
          "utf8",
        );
      } else {
        await writeFile(lockPath, "", "utf8");
        const old = new Date(Date.now() - 10 * 60 * 1000);
        await utimes(lockPath, old, old);
      }

      await expect(
        acquireAndVerifyOfflineArtifacts(fixture.plan, {
          observedAt: NOW,
          downloadAuthorization: DOWNLOAD_CONFIRMATION,
          allowSourceUrl: (url) => url.startsWith(fixture.baseUrl),
          gpgExecutable: fixture.gpgExecutable,
          statFilesystem: fixture.statFilesystem,
          download: async () => {
            throw new Error("recovered stale lock");
          },
        }),
      ).rejects.toThrow("recovered stale lock");
      await expect(lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(fixture.requests).toEqual([]);
    },
  );

  test("requires an existing dedicated data root and never creates a missing target", async () => {
    const fixture = await createDownloadFixture();
    const missingRoot = join(fixture.plan.data_root, "missing-target");
    const candidate = {
      ...fixture.plan,
      data_root: missingRoot,
      target_filesystem: {
        ...fixture.plan.target_filesystem,
        requested_data_root: missingRoot,
        resolved_data_root: missingRoot,
        probe_path: missingRoot,
      },
    };
    const plan = {
      ...candidate,
      plan_fingerprint: computeOfflineBootstrapPlanFingerprint(candidate),
    } as OfflineBootstrapMachinePlan;

    await expect(
      acquireAndVerifyOfflineArtifacts(plan, {
        observedAt: NOW,
        downloadAuthorization: DOWNLOAD_CONFIRMATION,
        allowSourceUrl: (url) => url.startsWith(fixture.baseUrl),
        gpgExecutable: fixture.gpgExecutable,
        statFilesystem: fixture.statFilesystem,
      }),
    ).rejects.toThrow("must already exist");
    await expect(stat(missingRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect(fixture.requests).toEqual([]);
  });

  test("rejects a data root inside the repository before state or download mutation", async () => {
    const fixture = await createDownloadFixture();
    const repositoryRoot = process.cwd();
    const candidate = {
      ...fixture.plan,
      data_root: repositoryRoot,
      target_filesystem: {
        ...fixture.plan.target_filesystem,
        requested_data_root: repositoryRoot,
        resolved_data_root: repositoryRoot,
        probe_path: repositoryRoot,
      },
    };
    const plan = {
      ...candidate,
      plan_fingerprint: computeOfflineBootstrapPlanFingerprint(candidate),
    } as OfflineBootstrapMachinePlan;

    await expect(
      acquireAndVerifyOfflineArtifacts(plan, {
        observedAt: NOW,
        downloadAuthorization: DOWNLOAD_CONFIRMATION,
        allowSourceUrl: (url) => url.startsWith(fixture.baseUrl),
        gpgExecutable: fixture.gpgExecutable,
        statFilesystem: fixture.statFilesystem,
      }),
    ).rejects.toThrow("outside the repository");
    expect(fixture.requests).toEqual([]);
  });

  test("downloads all eight artifacts, persists verified state and issues a bound receipt", async () => {
    const fixture = await createDownloadFixture();
    const result: OfflineAcquireVerifyResult = await acquireAndVerifyOfflineArtifacts(fixture.plan, {
      observedAt: NOW,
      downloadAuthorization: DOWNLOAD_CONFIRMATION,
      allowSourceUrl: (url) => url.startsWith(fixture.baseUrl),
      gpgExecutable: fixture.gpgExecutable,
      statFilesystem: fixture.statFilesystem,
    });

    expect(fixture.requests).toHaveLength(8);
    expect(result.state.phase).toBe("verified");
    expect(Object.values(result.state.artifacts).every((artifact) => artifact.status === "verified"))
      .toBe(true);
    expect(result.summary).toMatchObject({
      generation_id: fixture.plan.generation_id,
      artifacts_total: 8,
      artifacts_downloaded_this_run: 8,
      artifacts_reused: 0,
      phase: "verified",
      published_state_updated: false,
    });
    const statePath = resolve(fixture.plan.data_root, fixture.plan.layout.state);
    expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual(result.state);
    assertOfflineArtifactVerificationReceipt(
      result.verificationReceipt,
      fixture.plan,
      result.state,
      NOW,
    );
  });

  test("recovers a mixed downloaded/verified state without downloading completed files again", async () => {
    const fixture = await createDownloadFixture();
    const first = await acquireAndVerifyOfflineArtifacts(fixture.plan, {
      observedAt: NOW,
      downloadAuthorization: DOWNLOAD_CONFIRMATION,
      allowSourceUrl: (url) => url.startsWith(fixture.baseUrl),
      gpgExecutable: fixture.gpgExecutable,
      statFilesystem: fixture.statFilesystem,
    });
    const artifactId = "discogs:releases";
    const interrupted: OfflineGenerationState = {
      ...first.state,
      phase: "downloaded",
      artifacts: {
        ...first.state.artifacts,
        [artifactId]: {
          ...first.state.artifacts[artifactId]!,
          status: "downloaded",
          observed_sha256: null,
          verification_evidence: null,
        },
      },
    };
    const statePath = resolve(fixture.plan.data_root, fixture.plan.layout.state);
    await writeFile(statePath, `${JSON.stringify(interrupted, null, 2)}\n`, "utf8");
    fixture.requests.splice(0);

    const recovered = await acquireAndVerifyOfflineArtifacts(fixture.plan, {
      observedAt: NOW,
      downloadAuthorization: DOWNLOAD_CONFIRMATION,
      allowSourceUrl: (url) => url.startsWith(fixture.baseUrl),
      gpgExecutable: fixture.gpgExecutable,
      statFilesystem: fixture.statFilesystem,
    });

    expect(fixture.requests).toEqual([]);
    expect(recovered.state.phase).toBe("verified");
    expect(recovered.state.artifacts[artifactId]?.status).toBe("verified");
    expect(recovered.summary).toMatchObject({
      artifacts_total: 8,
      artifacts_downloaded_this_run: 0,
      artifacts_reused: 8,
    });
  });

  test("credits current-generation artifact allocation when rechecking resume capacity", async () => {
    const fixture = await createDownloadFixture();
    const archive = fixture.plan.artifacts.find(
      (artifact) => artifact.artifact_id === "musicbrainz:mbdump.tar.bz2",
    )!;
    const payload = Buffer.from("musicbrainz archive\n");
    const archivePath = resolve(fixture.plan.data_root, archive.destination_relative);
    await mkdir(resolve(archivePath, ".."), { recursive: true });
    await writeFile(archivePath, payload);
    const archiveStat = await stat(archivePath);
    const recoverableBytes = archiveStat.blocks * 512;
    fixture.requests.splice(0);

    const result = await acquireAndVerifyOfflineArtifacts(fixture.plan, {
      observedAt: NOW,
      downloadAuthorization: DOWNLOAD_CONFIRMATION,
      allowSourceUrl: (url) => url.startsWith(fixture.baseUrl),
      gpgExecutable: fixture.gpgExecutable,
      statFilesystem: async () => ({
        bavail: fixture.plan.capacity_gate.required_free_bytes - recoverableBytes,
        bsize: 1,
        blocks: fixture.plan.capacity_gate.filesystem_capacity_bytes,
      }),
    });

    expect(result.state.phase).toBe("verified");
    expect(fixture.requests).toHaveLength(7);
    expect(result.summary).toMatchObject({
      artifacts_downloaded_this_run: 7,
      artifacts_reused: 1,
      runtime_capacity_credit_bytes: recoverableBytes,
    });
  });
});

async function createDownloadFixture(useLoopbackUrls = true): Promise<{
  plan: OfflineBootstrapMachinePlan;
  baseUrl: string;
  requests: string[];
  gpgExecutable: string;
  statFilesystem: () => Promise<{ bavail: number; bsize: number; blocks: number }>;
}> {
  const requestedRoot = await mkdtemp(join(tmpdir(), "musicwiki-acquire-fixture-"));
  roots.push(requestedRoot);
  const root = await realpath(requestedRoot);
  const payloads: Record<string, Buffer> = {
    "musicbrainz:mbdump.tar.bz2": Buffer.from("musicbrainz archive\n"),
    "musicbrainz:SHA256SUMS.asc": Buffer.from("detached signature fixture\n"),
    "discogs:artists": Buffer.from("discogs artists\n"),
    "discogs:labels": Buffer.from("discogs labels\n"),
    "discogs:masters": Buffer.from("discogs masters\n"),
    "discogs:releases": Buffer.from("discogs releases\n"),
  };
  payloads["musicbrainz:SHA256SUMS"] = Buffer.from(
    `${sha256(payloads["musicbrainz:mbdump.tar.bz2"]!)}  mbdump.tar.bz2\n`,
  );
  payloads["discogs:CHECKSUM"] = Buffer.from(
    ["artists", "labels", "masters", "releases"]
      .map((kind) => `${sha256(payloads[`discogs:${kind}`]!)} *discogs_20260801_${kind}.xml.gz`)
      .join("\n") + "\n",
  );
  const requests: string[] = [];
  const baseUrl = await serve((request, response) => {
    const artifactId = decodeURIComponent((request.url ?? "").slice(1));
    requests.push(artifactId);
    const payload = payloads[artifactId];
    if (!payload) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-length": payload.byteLength });
    response.end(payload);
  });
  const rootStat = await stat(root);
  const basePlan = buildPlan(root, payloads, rootStat.dev);
  const candidate = useLoopbackUrls
    ? {
        ...basePlan,
        artifacts: basePlan.artifacts.map((artifact) => ({
          ...artifact,
          source_url: `${baseUrl}/${encodeURIComponent(artifact.artifact_id)}`,
        })),
      }
    : basePlan;
  const plan = {
    ...candidate,
    plan_fingerprint: computeOfflineBootstrapPlanFingerprint(candidate),
  } as OfflineBootstrapMachinePlan;
  const gpgExecutable = join(root, "fake-gpg.sh");
  await writeFile(
    gpgExecutable,
    `#!/bin/sh\ncase " $* " in\n  *" --with-colons "*) printf 'fpr:::::::::${FINGERPRINT}:\\n' ;;\n  *" --verify "*) printf '[GNUPG:] VALIDSIG ${FINGERPRINT} 0 0 0 0 0 0 0 0 0\\n' ;;\nesac\n`,
    "utf8",
  );
  await chmod(gpgExecutable, 0o755);
  return {
    plan,
    baseUrl,
    requests,
    gpgExecutable,
    statFilesystem: async () => ({
      bavail: plan.capacity_gate.filesystem_available_bytes,
      bsize: 1,
      blocks: plan.capacity_gate.filesystem_capacity_bytes,
    }),
  };
}

function buildPlan(
  dataRoot: string,
  payloads: Readonly<Record<string, Buffer>>,
  filesystemDeviceId: number,
): OfflineBootstrapMachinePlan {
  const sourceSnapshots: OfflineBootstrapPlanInput["sourceSnapshots"] = {
    musicbrainz: {
      snapshot_id: "20260801-002250",
      directory_url: "https://data.metabrainz.org/pub/musicbrainz/data/fullexport/20260801-002250/",
      files: [{
        name: "mbdump.tar.bz2",
        bytes: payloads["musicbrainz:mbdump.tar.bz2"]!.byteLength,
        license_partition: "musicbrainz-core-cc0",
      }],
    },
    discogs: {
      snapshot_id: "20260801",
      directory_url: "https://data.discogs.com/?prefix=data/2026/",
      files: [
        {
          name: "discogs_20260801_CHECKSUM.txt",
          bytes: payloads["discogs:CHECKSUM"]!.byteLength,
          license_partition: "discogs-cc0",
        },
        ...["artists", "labels", "masters", "releases"].map((kind) => ({
          name: `discogs_20260801_${kind}.xml.gz`,
          bytes: payloads[`discogs:${kind}`]!.byteLength,
          license_partition: "discogs-cc0" as const,
        })),
      ],
    },
  };
  const plan = buildOfflineBootstrapPlan({
    generatedAt: NOW,
    repositoryRoot: "/workspace/music-wiki",
    dataRoot,
    downloadAuthorized: true,
    capacityGate: {
      status: "pass",
      filesystem_capacity_bytes: 512_000_000_000,
      filesystem_available_bytes: 381_448_295_016,
      required_free_bytes: 381_448_295_016,
    },
    sourceConfig: {
      musicbrainzSigningKeyFingerprint: FINGERPRINT,
      metadataMaxBytes: 10_000_000,
    },
    sourceSnapshots,
  });
  return buildOfflineBootstrapMachinePlan(plan, {
    capacity_mode: "bootstrap",
    published_generation_reused: false,
    published_reuse_reason: "no-published-generation",
    published_content_allocated_bytes: 0,
    target_filesystem: {
      requested_data_root: dataRoot,
      resolved_data_root: dataRoot,
      probe_path: dataRoot,
      filesystem_device_id: filesystemDeviceId,
      filesystem_capacity_bytes: 512_000_000_000,
      filesystem_available_bytes: 381_448_295_016,
    },
    evidence: {
      capacity_snapshot_path: "data/sources/offline-db-capacity-v1.json",
      published_state_path: "data/sources/offline-published-state-v1.json",
      tracked_qid_manifest_path: "data/sources/offline-poc/manifest.json",
      source_config_path: "config/offline-data-sources-v1.json",
    },
  });
}

async function readPlan(): Promise<OfflineBootstrapMachinePlan> {
  return JSON.parse(
    await readFile("data/sources/offline-bootstrap-plan-v1.json", "utf8"),
  ) as OfflineBootstrapMachinePlan;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function serve(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  return `http://127.0.0.1:${address.port}`;
}
