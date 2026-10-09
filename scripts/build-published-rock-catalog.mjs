import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildBoundedRockCatalog } from "./lib/build-bounded-rock-catalog.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePaths = {
  styles: resolve(repositoryRoot, "data/sources/global-style-mock-v1/wikidata-rock-styles.json"),
  representatives: resolve(repositoryRoot, "data/sources/rock-catalog-v2/wikidata-representatives.json"),
  sourceValidation: resolve(repositoryRoot, "data/sources/rock-catalog-v2/cross-source-validations.json"),
  seed: resolve(repositoryRoot, "data/fixtures/experiment-v1/sample.json"),
};
const canonicalPath = resolve(repositoryRoot, "data/published/rock-catalog-v2/canonical-catalog.json");
const contextPath = resolve(repositoryRoot, "data/published/rock-catalog-v2/frontend-context.json");
const manifestPath = resolve(repositoryRoot, "data/published/rock-catalog-v2/manifest.json");
const pipelineVersion = "bounded-catalog-v3.0";
const generatedAt = argument("--generated-at") ?? new Date().toISOString();
if (!Number.isFinite(Date.parse(generatedAt))) throw new Error("--generated-at must be an ISO timestamp.");

const inputBytes = await Promise.all(Object.values(sourcePaths).map((path) => readFile(path)));
const [styleCatalog, representatives, sourceValidation, seed] = inputBytes.map((bytes) => JSON.parse(bytes));
const sourceFingerprintSha256 = sha256(Buffer.concat([...inputBytes, Buffer.from(pipelineVersion)]));
const timestamp = `${new Date(generatedAt).toISOString().slice(0, 19).replaceAll(/[-:]/g, "")}Z`;
const generationId = `rock-catalog-${timestamp}-${sourceFingerprintSha256.slice(0, 12)}`;
const result = buildBoundedRockCatalog({
  styleCatalog,
  representatives,
  sourceValidation,
  seed,
  generatedAt: new Date(generatedAt).toISOString(),
  generationId,
  sourceFingerprintSha256,
});
for (const entity of [
  ...result.canonical.styles,
  ...result.canonical.artists,
  ...result.canonical.release_groups,
  ...result.canonical.source_entities,
]) {
  entity.payload_sha256 = sha256(Buffer.from(JSON.stringify(entity)));
}
const contextBytes = Buffer.from(`${JSON.stringify(result.canonical.frontend_context, null, 2)}\n`);
result.canonical.frontend_context_sha256 = sha256(contextBytes);
result.canonical.publication = {
  status: "validated",
  frontend_export_path: null,
  frontend_export_sha256: null,
};
const finalCanonicalBytes = Buffer.from(`${JSON.stringify(result.canonical, null, 2)}\n`);
const manifest = {
  manifest_version: "2.0",
  pipeline_version: pipelineVersion,
  generation_id: generationId,
  generated_at: result.canonical.generated_at,
  source_fingerprint_sha256: sourceFingerprintSha256,
  sources: Object.fromEntries(Object.entries(sourcePaths).map(([key, path], index) => [key, {
    path: relativePath(path),
    bytes: inputBytes[index].byteLength,
    sha256: sha256(inputBytes[index]),
  }])),
  outputs: {
    canonical: { path: relativePath(canonicalPath), bytes: finalCanonicalBytes.byteLength, sha256: sha256(finalCanonicalBytes) },
    frontend_context: { path: relativePath(contextPath), bytes: contextBytes.byteLength, sha256: sha256(contextBytes) },
  },
  validation: {
    exact_frontend_cardinality: true,
    real_entity_urls_only: true,
    source_lineage_complete: true,
  },
  counts: result.summary,
};

await atomicWrite(canonicalPath, finalCanonicalBytes);
await atomicWrite(contextPath, contextBytes);
await atomicWrite(manifestPath, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
console.log(JSON.stringify(manifest, null, 2));

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

async function atomicWrite(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}`;
  await writeFile(temporaryPath, bytes, { flag: "wx" });
  await rename(temporaryPath, path);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function relativePath(path) {
  return path.slice(repositoryRoot.length + 1);
}
