import { createHash } from "node:crypto";
import {
  lstat,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { fetchWikidataEntityBatches } from "../../src/data/wikidata-entity-fetch.ts";
import { parseReviewedRockStyleCatalog } from "../../src/data/wikidata-rock-style-scope.ts";

await main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Error: ${message}\n`);
  process.exitCode = 1;
});

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const outputDir = await validateOutputDirectory(options.outputDir);
  const endpoint = validateEndpoint(options.endpoint);
  const trackedQids = options.trackedQids ? await readQids(options.trackedQids) : [];
  const rockStyleScope = options.rockStyleCatalog
    ? await readRockStyleCatalog(options.rockStyleCatalog)
    : null;
  const qids = mergeQids(trackedQids, rockStyleScope?.styles.keys() ?? []);
  const generatedAt = validateTimestamp(options.generatedAt ?? new Date().toISOString());
  const userAgent = buildUserAgent(options.contact);
  const temporaryDir = await mkdtemp(join(dirname(outputDir), ".wikidata-stage-"));
  let published = false;

  try {
    const entitiesPath = join(temporaryDir, "entities.jsonl");
    const entityFile = await open(entitiesPath, "wx", 0o600);
    const entityHash = createHash("sha256");
    const qidHash = createHash("sha256");
    const seenQids = new Set();
    const batchReceipts = [];
    let entityBytes = 0;
    let entityCount = 0;
    let revisionCount = 0;
    let expectedQidCount = 0;
    let networkRequests = 0;
    let networkBytes = 0;
    let retries = 0;

    try {
      for await (const batch of fetchWikidataEntityBatches({
        qids,
        endpoint,
        userAgent,
        maxBatchBytes: options.maxBatchBytes,
        maxAttempts: options.maxAttempts,
        timeoutMs: options.timeoutMs,
      })) {
        networkRequests += batch.attempts;
        networkBytes += batch.network_bytes;
        retries += batch.retry_count;
        expectedQidCount += batch.qids.length;
        batchReceipts.push({
          batch_index: batch.batch_index,
          qids: batch.qids.length,
          attempts: batch.attempts,
          retries: batch.retry_count,
          network_bytes: batch.network_bytes,
          response_bytes: batch.response_bytes,
          response_sha256: batch.response_sha256,
          source_url: batch.source_url,
        });
        for (const entity of batch.entities) {
          if (seenQids.has(entity.qid)) throw new Error(`Duplicate Wikidata entity: ${entity.qid}`);
          seenQids.add(entity.qid);
          qidHash.update(`${entity.qid}\n`);
          const style = rockStyleScope?.styles.get(entity.qid);
          const projectedEntity = style
            ? { ...entity, roles: ["rock-style"], rock_style: style }
            : entity;
          const line = `${JSON.stringify(sortJson(projectedEntity))}\n`;
          const bytes = Buffer.from(line);
          await writeAll(entityFile, bytes);
          entityHash.update(bytes);
          entityBytes += bytes.byteLength;
          entityCount += 1;
          revisionCount += 1;
        }
      }
      await entityFile.sync();
    } finally {
      await entityFile.close();
    }

    if (entityCount !== seenQids.size || entityCount !== expectedQidCount) {
      throw new Error(`Wikidata stage entity count mismatch: ${entityCount}/${expectedQidCount}`);
    }
    const manifest = {
      manifest_version: "1.0",
      snapshot_id: options.snapshot,
      generated_at: generatedAt,
      mode: "tracked-qid-api-stage",
      license_partition: "wikidata-cc0",
      full_wikidata_dump_downloaded: false,
      cursor_advanced: false,
      source: {
        endpoint,
        user_agent: userAgent,
        batch_size: 50,
        max_batch_bytes: options.maxBatchBytes,
        max_attempts: options.maxAttempts,
        timeout_ms: options.timeoutMs,
      },
      counts: {
        tracked_qids: expectedQidCount,
        rock_style_qids: rockStyleScope?.styles.size ?? 0,
        batches: batchReceipts.length,
        entities: entityCount,
        entities_with_revision: revisionCount,
        network_requests_executed: networkRequests,
        retries,
        network_bytes_downloaded: networkBytes,
      },
      tracked_qid_set_sha256: qidHash.digest("hex"),
      rock_style_scope: rockStyleScope?.evidence ?? null,
      output: {
        relative_path: "entities.jsonl",
        bytes: entityBytes,
        sha256: entityHash.digest("hex"),
      },
      batches: batchReceipts,
    };
    const manifestFile = await open(
      join(temporaryDir, "wikidata-stage-manifest.json"),
      "wx",
      0o600,
    );
    try {
      await manifestFile.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      await manifestFile.sync();
    } finally {
      await manifestFile.close();
    }
    await rename(temporaryDir, outputDir);
    published = true;
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  } finally {
    if (!published) await rm(temporaryDir, { recursive: true, force: true });
  }
}

function parseArguments(argv) {
  const options = {
    trackedQids: null,
    rockStyleCatalog: null,
    outputDir: null,
    snapshot: null,
    endpoint: "https://www.wikidata.org/w/api.php",
    contact: process.env.MUSICWIKI_CONTACT ?? null,
    generatedAt: null,
    maxBatchBytes: 5_000_000,
    maxAttempts: 5,
    timeoutMs: 30_000,
  };
  const names = {
    "--tracked-qids": ["trackedQids", "string"],
    "--rock-style-catalog": ["rockStyleCatalog", "string"],
    "--output-dir": ["outputDir", "string"],
    "--snapshot": ["snapshot", "string"],
    "--endpoint": ["endpoint", "string"],
    "--contact": ["contact", "string"],
    "--generated-at": ["generatedAt", "string"],
    "--max-batch-bytes": ["maxBatchBytes", "integer"],
    "--max-attempts": ["maxAttempts", "integer"],
    "--timeout-ms": ["timeoutMs", "integer"],
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const definition = names[argument];
    if (!definition) throw new Error(`Unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    if (seen.has(argument)) throw new Error(`${argument} may only be provided once`);
    const [key, kind] = definition;
    options[key] = kind === "integer" ? parsePositiveInteger(value, argument) : value;
    seen.add(argument);
    index += 1;
  }
  for (const [argument, key] of [
    ["--output-dir", "outputDir"],
    ["--snapshot", "snapshot"],
    ["--contact", "contact"],
  ]) {
    if (options[key] === null) throw new Error(`${argument} is required`);
  }
  if (options.trackedQids === null && options.rockStyleCatalog === null) {
    throw new Error("At least one of --tracked-qids or --rock-style-catalog is required");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(options.snapshot)) {
    throw new Error("--snapshot contains unsupported characters");
  }
  return options;
}

async function validateOutputDirectory(requestedPath) {
  if (!isAbsolute(requestedPath)) throw new Error("--output-dir must be an absolute path");
  const parent = await realpath(dirname(requestedPath));
  if (!(await stat(parent)).isDirectory()) throw new Error("--output-dir parent must be a directory");
  const outputPath = resolve(parent, basename(requestedPath));
  const existing = await lstat(outputPath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (existing) throw new Error("--output-dir must not already exist");
  return outputPath;
}

function validateEndpoint(value) {
  const url = new URL(value);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("--endpoint must use HTTPS except for loopback testing");
  }
  return url.toString();
}

async function readQids(path) {
  const value = JSON.parse(await readFile(path, "utf8"));
  if (!Array.isArray(value) || value.length === 0 || value.some((qid) => typeof qid !== "string")) {
    throw new Error("--tracked-qids must contain a non-empty JSON array of strings");
  }
  return value;
}

async function readRockStyleCatalog(path) {
  if (!isAbsolute(path)) throw new Error("--rock-style-catalog must be an absolute path");
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new Error("--rock-style-catalog must be a regular non-symlink file");
  }
  const resolved = await realpath(path);
  const bytes = await readFile(resolved);
  let catalog;
  try {
    catalog = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("--rock-style-catalog contains malformed JSON");
  }
  const parsed = parseReviewedRockStyleCatalog(catalog);
  const styles = new Map(parsed.styles.map((style) => [style.qid, style]));
  const qidSetBytes = Buffer.from([...styles.keys()].sort(compareQids).map((qid) => `${qid}\n`).join(""));
  return {
    styles,
    evidence: {
      snapshot_id: parsed.snapshot_id,
      root_qid: "Q11399",
      license: parsed.license,
      qid_count: styles.size,
      qid_set_sha256: createHash("sha256").update(qidSetBytes).digest("hex"),
      catalog_bytes: bytes.byteLength,
      catalog_sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  };
}

function mergeQids(left, right) {
  const values = [...left, ...right].map((qid) => qid.trim().toUpperCase());
  if (values.some((qid) => !/^Q[1-9][0-9]*$/u.test(qid))) {
    throw new Error("Tracked Wikidata scope contains an invalid QID");
  }
  return [...new Set(values)].sort(compareQids);
}

function compareQids(left, right) {
  const leftNumber = BigInt(left.slice(1));
  const rightNumber = BigInt(right.slice(1));
  return leftNumber < rightNumber ? -1 : leftNumber > rightNumber ? 1 : 0;
}


function validateTimestamp(value) {
  if (!Number.isFinite(Date.parse(value)) || !value.endsWith("Z")) {
    throw new Error("--generated-at must be an ISO-8601 UTC timestamp");
  }
  return value;
}

function buildUserAgent(contact) {
  const normalized = contact.trim();
  if (normalized.length < 3 || /[\r\n]/.test(normalized)) {
    throw new Error("--contact must identify an operator without control characters");
  }
  return `MusicWiki/0.1 (offline-wikidata-stage; ${normalized})`;
}

function parsePositiveInteger(value, argument) {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
    throw new Error(`${argument} must be a positive integer`);
  }
  return Number(value);
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortJson(item)]),
    );
  }
  return value;
}

async function writeAll(file, bytes) {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await file.write(bytes, offset, bytes.byteLength - offset, null);
    if (bytesWritten < 1) throw new Error("Wikidata entity output stopped before the line completed");
    offset += bytesWritten;
  }
}
