import { execFile, spawn } from "node:child_process";
import { createPrivateKey } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { OFFLINE_FULL_ARCHIVE_DOWNLOAD_CONFIRMATION } from "../../src/data/offline-acquire-verify.ts";
import { parseLegacyCatalogIdentityInput } from "../../src/data/catalog/legacy-catalog-identity.ts";
import { parseReviewedRockStyleCatalog } from "../../src/data/wikidata-rock-style-scope.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const POINTER_CONFIRMATION = "I_CONFIRM_ATOMIC_POINTER_SWITCH";
const execFileAsync = promisify(execFile);

await main().catch((error) => {
  process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const plan = parsePlan(await readFile(options.plan, "utf8"));
  const paths = resolvePipelinePaths(plan, options);
  const stages = buildStagePlan(plan, paths, options, null);
  if (!options.execute) {
    process.stdout.write(`${JSON.stringify({
      execution_mode: "dry-run",
      network_requests_executed: 0,
      files_written: 0,
      generation_id: plan.generation_id,
      stages: stages.map(redactStage),
      requirements: {
        plan_execution_ready: plan.execution_ready,
        capacity_gate: plan.capacity_gate.status,
        download_authorized: plan.download_authorization,
        publish_current: options.publishAuthorization === POINTER_CONFIRMATION,
      },
    }, null, 2)}\n`);
    return;
  }

  validateExecutionAuthorization(plan, options);
  await validateLocalExecutionInputs(options, plan);
  await runStage(stages[0]);
  await preparePipelineDirectories(paths);
  const state = JSON.parse(await readFile(paths.state, "utf8"));
  const musicBrainzSha = state.artifacts?.["musicbrainz:mbdump.tar.bz2"]?.observed_sha256;
  if (!/^[a-f0-9]{64}$/u.test(musicBrainzSha ?? "")) {
    throw new Error("Verified generation state has no MusicBrainz archive SHA-256");
  }
  const executableStages = buildStagePlan(plan, paths, options, musicBrainzSha);
  for (const stage of executableStages.slice(1)) {
    if (stage.reuse_manifest && await regularFileExists(stage.reuse_manifest)) {
      process.stderr.write(`Reusing ${stage.stage_id}: ${stage.reuse_manifest}\n`);
      continue;
    }
    await runStage(stage);
  }
  process.stdout.write(`${JSON.stringify({
    execution_mode: "executed",
    generation_id: plan.generation_id,
    canonical_manifest: join(paths.canonical, "canonical-project-manifest.json"),
    projection_manifest: join(paths.projection, "projection-manifest.json"),
    static_root: paths.staticRoot,
    current_pointer_updated: options.publishAuthorization === POINTER_CONFIRMATION,
  }, null, 2)}\n`);
}

function buildStagePlan(plan, paths, options, musicBrainzSha) {
  const [musicBrainzSnapshot, discogsSnapshot] = snapshots(plan.generation_id);
  const archive = artifact(plan, "musicbrainz:mbdump.tar.bz2");
  return [
    {
      stage_id: "acquire-verify",
      command: process.execPath,
      args: [
        script("acquire_verify_offline.mjs"),
        "--plan", options.plan,
        "--download-authorization", options.downloadAuthorization ?? "NOT_AUTHORIZED",
      ],
    },
    {
      stage_id: "musicbrainz-stage",
      command: process.execPath,
      args: [
        script("stage_musicbrainz_core.mjs"),
        "--archive", paths.musicbrainzArchive,
        "--expected-bytes", String(archive.expected_bytes),
        "--expected-sha256", musicBrainzSha ?? "SHA256_FROM_VERIFIED_STATE",
        "--snapshot", musicBrainzSnapshot,
        "--output-dir", paths.musicbrainzStage,
        "--database", options.database,
        "--psql-command", options.psqlCommand,
        "--generated-at", options.generatedAt,
      ],
      reuse_manifest: join(paths.musicbrainzStage, "musicbrainz-stage-manifest.json"),
    },
    {
      stage_id: "discogs-rock-stage",
      command: options.pythonCommand,
      args: [
        script("discogs_rock_stage.py"),
        "--snapshot", discogsSnapshot,
        "--input-scope", "full-monthly-snapshot",
        "--releases", paths.discogsReleases,
        "--artists", paths.discogsArtists,
        "--masters", paths.discogsMasters,
        "--labels", paths.discogsLabels,
        "--checksums", paths.discogsChecksum,
        "--output-dir", paths.discogsStage,
      ],
      reuse_manifest: join(paths.discogsStage, "discogs-stage-manifest.json"),
    },
    {
      stage_id: "wikidata-tracked-fetch",
      command: process.execPath,
      args: [
        script("fetch_wikidata_tracked.mjs"),
        ...(options.trackedQids ? ["--tracked-qids", options.trackedQids] : []),
        "--rock-style-catalog", options.rockStyleCatalog,
        "--output-dir", paths.wikidataStage,
        "--snapshot", options.wikidataSnapshot,
        "--contact", options.contact,
        "--generated-at", options.generatedAt,
      ],
      reuse_manifest: join(paths.wikidataStage, "wikidata-stage-manifest.json"),
    },
    {
      stage_id: "canonical-project",
      command: process.execPath,
      args: [
        script("project_offline_canonical.mjs"),
        "--musicbrainz-stage", paths.musicbrainzStage,
        "--discogs-stage", paths.discogsStage,
        "--wikidata-stage", paths.wikidataStage,
        "--generation", plan.generation_id,
        "--output-dir", paths.canonical,
        "--psql-command", options.psqlCommand,
        "--generated-at", options.generatedAt,
      ],
      reuse_manifest: join(paths.canonical, "canonical-project-manifest.json"),
    },
    {
      stage_id: "frontend-jsonl-export",
      command: process.execPath,
      args: [
        script("export_full_frontend_jsonl.mjs"),
        "--canonical-manifest", join(paths.canonical, "canonical-project-manifest.json"),
        "--output-dir", paths.projection,
        "--psql-command", options.psqlCommand,
        "--generated-at", options.generatedAt,
        "--legacy-catalog", options.legacyCatalog,
        "--gate-a-status", options.gateAReport ? "pass" : "not-run",
        ...(options.gateAReport ? ["--gate-a-report-url", options.gateAReportUrl] : []),
      ],
      reuse_manifest: join(paths.projection, "projection-manifest.json"),
    },
    {
      stage_id: "static-json-publish",
      command: process.execPath,
      args: [
        script("publish_offline_generation.mjs"),
        "--projection-manifest", join(paths.projection, "projection-manifest.json"),
        "--static-root", paths.staticRoot,
        "--signing-key", options.signingKey,
        "--key-id", options.keyId,
        "--published-at", options.generatedAt,
        ...(options.gateAReport ? ["--gate-a-report", options.gateAReport] : []),
        ...(options.publishAuthorization ? ["--publish-authorization", options.publishAuthorization] : []),
      ],
    },
  ];
}

function resolvePipelinePaths(plan, options) {
  const dataRoot = resolve(plan.data_root);
  const resolveData = (relativePath, label) => {
    const path = resolve(dataRoot, relativePath);
    if (path !== dataRoot && !path.startsWith(`${dataRoot}${sep}`)) throw new Error(`${label} escapes data_root`);
    return path;
  };
  const stageRoot = resolveData(plan.layout.generation_stage, "generation stage");
  const canonical = resolveData(plan.layout.generation_canonical, "generation canonical");
  return {
    state: resolveData(plan.layout.state, "generation state"),
    musicbrainzArchive: resolveData(artifact(plan, "musicbrainz:mbdump.tar.bz2").destination_relative, "MusicBrainz archive"),
    discogsChecksum: resolveData(artifact(plan, "discogs:CHECKSUM").destination_relative, "Discogs checksum"),
    discogsArtists: resolveData(artifact(plan, "discogs:artists").destination_relative, "Discogs artists"),
    discogsLabels: resolveData(artifact(plan, "discogs:labels").destination_relative, "Discogs labels"),
    discogsMasters: resolveData(artifact(plan, "discogs:masters").destination_relative, "Discogs masters"),
    discogsReleases: resolveData(artifact(plan, "discogs:releases").destination_relative, "Discogs releases"),
    musicbrainzStage: join(stageRoot, "musicbrainz"),
    discogsStage: join(stageRoot, "discogs"),
    wikidataStage: join(stageRoot, "wikidata"),
    canonical,
    projection: join(dirname(canonical), "frontend-v3-projection"),
    staticRoot: resolve(options.staticRoot),
  };
}

async function runStage(stage) {
  process.stderr.write(`Running ${stage.stage_id}\n`);
  const child = spawn(stage.command, stage.args, { stdio: "inherit", shell: false });
  const code = await new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("close", resolveExit);
  });
  if (code !== 0) throw new Error(`${stage.stage_id} exited with status ${code}`);
}

function redactStage(stage) {
  return {
    stage_id: stage.stage_id,
    command: stage.command,
    args: stage.args.map((value, index, values) =>
      values[index - 1] === "--download-authorization" || values[index - 1] === "--publish-authorization"
        ? "[confirmation-required]"
        : value
    ),
    reuse_manifest: stage.reuse_manifest ?? null,
  };
}

function parseArguments(argv) {
  const options = {
    plan: null,
    trackedQids: null,
    rockStyleCatalog: join(repositoryRoot, "data/sources/global-style-mock-v1/wikidata-rock-styles.json"),
    legacyCatalog: join(repositoryRoot, "data/published/rock-catalog-v2/canonical-catalog.json"),
    contact: null,
    staticRoot: null,
    signingKey: null,
    keyId: null,
    psqlCommand: "psql",
    pythonCommand: "python3",
    database: "musicwiki_stage",
    generatedAt: new Date().toISOString(),
    wikidataSnapshot: new Date().toISOString().replaceAll(/[-:.TZ]/g, "").slice(0, 14),
    gateAReport: null,
    gateAReportUrl: null,
    downloadAuthorization: null,
    publishAuthorization: null,
    execute: false,
  };
  const flags = new Set(["--execute"]);
  const definitions = {
    "--plan": "plan",
    "--tracked-qids": "trackedQids",
    "--rock-style-catalog": "rockStyleCatalog",
    "--legacy-catalog": "legacyCatalog",
    "--contact": "contact",
    "--static-root": "staticRoot",
    "--signing-key": "signingKey",
    "--key-id": "keyId",
    "--psql-command": "psqlCommand",
    "--python-command": "pythonCommand",
    "--database": "database",
    "--generated-at": "generatedAt",
    "--wikidata-snapshot": "wikidataSnapshot",
    "--gate-a-report": "gateAReport",
    "--gate-a-report-url": "gateAReportUrl",
    "--download-authorization": "downloadAuthorization",
    "--publish-authorization": "publishAuthorization",
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (flags.has(argument)) {
      if (seen.has(argument)) throw new Error(`${argument} may only be provided once`);
      options.execute = true;
      seen.add(argument);
      continue;
    }
    const key = definitions[argument];
    if (!key) throw new Error(`Unknown argument: ${argument}`);
    if (seen.has(argument)) throw new Error(`${argument} may only be provided once`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    options[key] = value;
    seen.add(argument);
    index += 1;
  }
  for (const key of ["plan", "contact", "staticRoot", "signingKey", "keyId"]) {
    if (!options[key]) throw new Error(`Missing required option ${key}`);
  }
  if (![options.plan, options.rockStyleCatalog, options.legacyCatalog, options.staticRoot, options.signingKey].every(isAbsolute) ||
      (options.trackedQids !== null && !isAbsolute(options.trackedQids)) ||
      (options.gateAReport !== null && !isAbsolute(options.gateAReport))) {
    throw new Error("Plan, optional tracked QIDs, Rock style catalog, legacy catalog, static root, signing key and Gate A report paths must be absolute");
  }
  if (!Number.isFinite(Date.parse(options.generatedAt)) || !options.generatedAt.endsWith("Z")) {
    throw new Error("--generated-at must be an ISO-8601 UTC timestamp");
  }
  return options;
}

function parsePlan(text) {
  let plan;
  try { plan = JSON.parse(text); } catch { throw new Error("Bootstrap plan is malformed JSON"); }
  if (!plan || plan.plan_version !== "1.0" || typeof plan.generation_id !== "string" ||
      !isAbsolute(plan.data_root) || !plan.layout || !Array.isArray(plan.artifacts) || !plan.capacity_gate) {
    throw new Error("Bootstrap plan contract mismatch");
  }
  return plan;
}

function validateExecutionAuthorization(plan, options) {
  if (!plan.execution_ready || plan.capacity_gate.status !== "pass" ||
      plan.download_authorization !== "authorized") {
    throw new Error("Bootstrap plan is not execution-ready or has not passed capacity/download authorization gates");
  }
  if (options.downloadAuthorization !== OFFLINE_FULL_ARCHIVE_DOWNLOAD_CONFIRMATION) {
    throw new Error(`Execution requires --download-authorization ${OFFLINE_FULL_ARCHIVE_DOWNLOAD_CONFIRMATION}`);
  }
  if (options.publishAuthorization && options.publishAuthorization !== POINTER_CONFIRMATION) {
    throw new Error(`--publish-authorization must equal ${POINTER_CONFIRMATION}`);
  }
  if (options.publishAuthorization && (!options.gateAReport || !options.gateAReportUrl)) {
    throw new Error("Current pointer publication requires --gate-a-report and --gate-a-report-url");
  }
}

async function validateLocalExecutionInputs(options, plan) {
  if (options.trackedQids !== null) {
    const trackedQidsPath = await validateRegularFile(options.trackedQids, "tracked QIDs");
    const trackedQids = JSON.parse(await readFile(trackedQidsPath, "utf8"));
    if (!Array.isArray(trackedQids) || trackedQids.length === 0 ||
        trackedQids.some((value) => typeof value !== "string" || !/^Q[1-9][0-9]*$/u.test(value))) {
      throw new Error("Tracked QIDs must be a non-empty JSON array of Wikidata QIDs");
    }
  }
  const rockStyleCatalogPath = await validateRegularFile(options.rockStyleCatalog, "Rock style catalog");
  parseReviewedRockStyleCatalog(JSON.parse(await readFile(rockStyleCatalogPath, "utf8")));
  const legacyCatalogPath = await validateRegularFile(options.legacyCatalog, "legacy catalog");
  parseLegacyCatalogIdentityInput(JSON.parse(await readFile(legacyCatalogPath, "utf8")));
  const signingKeyPath = await validateRegularFile(options.signingKey, "signing key");
  const signingKeyInfo = await lstat(signingKeyPath);
  if ((signingKeyInfo.mode & 0o077) !== 0) throw new Error("Signing key permissions must be owner-only");
  const signingKey = createPrivateKey(await readFile(signingKeyPath));
  if (signingKey.asymmetricKeyType !== "ed25519") throw new Error("Signing key must be Ed25519");
  if (options.gateAReport) {
    const reportPath = await validateRegularFile(options.gateAReport, "Gate A report");
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    if (report?.report_version !== "3.0" || report?.gate !== "A" ||
        report?.status !== "pass" || report?.readiness?.v3_architecture_ready !== true ||
        !Array.isArray(report?.blockers) || report.blockers.length !== 0) {
      throw new Error("Gate A report is not a valid passing report");
    }
    const expectedReportUrl = `/data/rock-catalog-v3/generations/${plan.generation_id.toLowerCase()}/gate-a-report.json`;
    if (options.gateAReportUrl !== expectedReportUrl) {
      throw new Error(`--gate-a-report-url must equal ${expectedReportUrl}`);
    }
  }
  await Promise.all([
    execFileAsync(options.psqlCommand, ["--version"], { timeout: 5_000 }),
    execFileAsync(options.pythonCommand, ["--version"], { timeout: 5_000 }),
  ]).catch((error) => {
    throw new Error(`Required pipeline command is unavailable: ${error?.code ?? error?.message ?? "unknown"}`);
  });
  await realpath(dirname(options.staticRoot));
}

async function validateRegularFile(path, label) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  return realpath(path);
}

async function preparePipelineDirectories(paths) {
  const { mkdir } = await import("node:fs/promises");
  await Promise.all([
    dirname(paths.musicbrainzStage),
    dirname(paths.discogsStage),
    dirname(paths.wikidataStage),
    dirname(paths.canonical),
    dirname(paths.projection),
    dirname(paths.staticRoot),
  ].map((path) => mkdir(path, { recursive: true })));
}

function artifact(plan, artifactId) {
  const matches = plan.artifacts.filter((candidate) => candidate.artifact_id === artifactId);
  if (matches.length !== 1) throw new Error(`Bootstrap plan must contain exactly one ${artifactId}`);
  return matches[0];
}

function snapshots(generationId) {
  const match = /^mb-(\d{8}-\d{6})__discogs-(\d{8})$/u.exec(generationId);
  if (!match) throw new Error("Generation id must be mb-YYYYMMDD-HHMMSS__discogs-YYYYMMDD");
  return [match[1], match[2]];
}

function script(name) {
  if (['export_full_frontend_jsonl.mjs', 'publish_offline_generation.mjs'].includes(name)) {
    const builderRoot = process.env.ROCK_ATLAS_JSON_BUILDER_ROOT ?? resolve(repositoryRoot, '../rock-atlas-v3-json-builder');
    if (!isAbsolute(builderRoot)) throw new Error('ROCK_ATLAS_JSON_BUILDER_ROOT must be absolute');
    return join(builderRoot, 'scripts/offline-data', name);
  }
  return join(repositoryRoot, "scripts/offline-data", name);
}

async function regularFileExists(path) {
  try { return (await lstat(path)).isFile(); } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}
