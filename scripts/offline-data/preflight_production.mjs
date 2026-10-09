import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { buildOfflineProductionReadiness } from "../../src/data/offline-production-readiness.ts";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

await main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Error: ${message}\n`);
  process.exitCode = 1;
});

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const machinePlan = JSON.parse(await readFile(resolve(options.plan), "utf8"));
  const [implementationChecks, toolChecks] = await Promise.all([
    inspectImplementations(),
    inspectTools(),
  ]);
  const report = buildOfflineProductionReadiness({
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    machinePlan,
    implementationChecks,
    toolChecks,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

function parseArguments(argv) {
  const options = { plan: null, generatedAt: null };
  const names = { "--plan": "plan", "--generated-at": "generatedAt" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const key = names[argument];
    if (!key) throw new Error(`Unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    if (options[key] !== null) throw new Error(`${argument} may only be provided once`);
    options[key] = value;
    index += 1;
  }
  if (options.plan === null) throw new Error("--plan is required");
  return options;
}

async function inspectImplementations() {
  const specifications = [
    {
      stage_id: "acquire",
      paths: [
        "scripts/offline-data/acquire_verify_offline.mjs",
        "src/data/offline-acquire-verify.ts",
        "src/data/resumable-download.ts",
      ],
      present: "production bounded resumable acquisition entrypoint is implemented",
      missing: "production bounded acquisition entrypoint is not implemented",
    },
    {
      stage_id: "verify",
      paths: [
        "scripts/offline-data/acquire_verify_offline.mjs",
        "src/data/offline-acquire-verify.ts",
        "src/data/offline-artifact-verifier.ts",
      ],
      present: "production streaming checksum and pinned-signature verification entrypoint is implemented",
      missing: "production artifact verification entrypoint is not implemented",
    },
    {
      stage_id: "musicbrainz-stage",
      paths: ["scripts/offline-data/stage_musicbrainz_core.mjs"],
      present: "production MusicBrainz full-dump staging is implemented",
      missing: "production MusicBrainz full-dump staging is not implemented",
    },
    {
      stage_id: "discogs-rock-stage",
      paths: ["scripts/offline-data/discogs_rock_stage.py"],
      present: "production two-pass Discogs Rock staging is implemented",
      missing: "production Discogs Rock staging is not implemented",
    },
    {
      stage_id: "wikidata-tracked-fetch",
      paths: [
        "scripts/offline-data/fetch_wikidata_tracked.mjs",
        "data/sources/global-style-mock-v1/wikidata-rock-styles.json",
      ],
      present: "production Wikidata tracked-entity fetch is implemented",
      missing: "production Wikidata tracked-entity fetch is not implemented",
    },
    {
      stage_id: "canonical-project",
      paths: ["scripts/offline-data/project_offline_canonical.mjs"],
      present: "production canonical projector is implemented",
      missing: "production canonical projector is not implemented",
    },
    {
      stage_id: "quality-gates",
      paths: ["src/data/offline-completeness.ts"],
      present: "deterministic completeness gates are implemented",
      missing: "production completeness gates are not implemented",
    },
    {
      stage_id: "publish",
      paths: [
        "scripts/offline-data/export_full_frontend_jsonl.mjs",
        "scripts/offline-data/publish_offline_generation.mjs",
        "scripts/offline-data/run_full_catalog_pipeline.mjs",
        "src/data/publication/catalog-jsonl-exporter-v3.ts",
      ],
      present: "production full static exporter and atomic generation publisher are implemented",
      missing: "production full static exporter or atomic generation publisher is not implemented",
    },
  ];

  return Promise.all(
    specifications.map(async (specification) => {
      const availability = await Promise.all(
        specification.paths.map(async (path) => ({
          path,
          present: await fileExists(resolve(repositoryRoot, path)),
        })),
      );
      const implemented = availability.every((item) => item.present);
      return {
        stage_id: specification.stage_id,
        implemented,
        evidence_paths: availability.filter((item) => item.present).map((item) => item.path),
        detail: implemented ? specification.present : specification.missing,
      };
    }),
  );
}

async function inspectTools() {
  const specifications = [
    { tool_id: "node", command: process.execPath, args: ["--version"] },
    { tool_id: "python3", command: "python3", args: ["--version"] },
    { tool_id: "gpg", command: "gpg", args: ["--version"] },
    { tool_id: "psql", command: "psql", args: ["--version"] },
  ];
  return Promise.all(
    specifications.map(async (specification) => {
      try {
        const result = await execFileAsync(specification.command, specification.args, {
          timeout: 5_000,
        });
        const firstLine = `${result.stdout}${result.stderr}`.trim().split(/\r?\n/, 1)[0];
        return {
          tool_id: specification.tool_id,
          available: true,
          detail: firstLine || "available",
        };
      } catch (error) {
        const detail = error?.code === "ENOENT" ? "not found" : `probe failed: ${error?.code ?? "unknown"}`;
        return { tool_id: specification.tool_id, available: false, detail };
      }
    }),
  );
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}
