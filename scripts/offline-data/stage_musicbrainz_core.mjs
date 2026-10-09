import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  constants,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  MUSICBRAINZ_SAMPLE_REQUIRED_MEMBERS,
  validateMusicBrainzSampleMembers,
} from "../../src/data/musicbrainz-sample-archive.ts";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const schemaTemplatePath = resolve(repositoryRoot, "database/musicbrainz-stage-v31.sql");
const indexTemplatePath = resolve(
  repositoryRoot,
  "database/musicbrainz-stage-v31-indexes.sql",
);
const expectedSchemaSequence = 31;
const tableMembers = MUSICBRAINZ_SAMPLE_REQUIRED_MEMBERS.filter((member) =>
  member.startsWith("mbdump/"),
);
const tables = tableMembers.map((member) => basename(member));

await main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Error: ${message}\n`);
  process.exitCode = 1;
});

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const outputDir = await validateOutputDirectory(options.outputDir);
  const archivePath = await validateArchivePath(options.archive);
  const generatedAt = validateTimestamp(options.generatedAt ?? new Date().toISOString());
  const stageSchema = `raw_mb_${options.snapshot.replaceAll("-", "_")}`;
  const psqlCommand = await validateCommand(options.psqlCommand);
  const archiveStat = await stat(archivePath);
  if (archiveStat.size !== options.expectedBytes) {
    throw new Error(
      `MusicBrainz archive has ${archiveStat.size} bytes, expected ${options.expectedBytes}`,
    );
  }
  const archiveSha256 = await sha256File(archivePath);
  if (archiveSha256 !== options.expectedSha256) {
    throw new Error(
      `MusicBrainz archive SHA-256 ${archiveSha256} does not match ${options.expectedSha256}`,
    );
  }

  const { stdout: listing } = await execFileAsync("tar", ["-tf", archivePath], {
    maxBuffer: 10 * 1024 * 1024,
  });
  const selectedMembers = validateMusicBrainzSampleMembers(
    listing.split(/\r?\n/).filter(Boolean),
  );
  const temporaryDir = await mkdtemp(join(dirname(outputDir), ".musicbrainz-stage-"));
  let schemaMayExist = false;
  let published = false;

  try {
    await execFileAsync(
      "tar",
      ["-xf", archivePath, "-C", temporaryDir, "--no-same-owner", ...selectedMembers],
      { maxBuffer: 10 * 1024 * 1024 },
    );
    const extractedFiles = await inspectExtractedFiles(temporaryDir, selectedMembers);
    const archiveAfterExtraction = await stat(archivePath);
    if (
      archiveAfterExtraction.dev !== archiveStat.dev ||
      archiveAfterExtraction.ino !== archiveStat.ino ||
      archiveAfterExtraction.size !== archiveStat.size ||
      archiveAfterExtraction.mtimeMs !== archiveStat.mtimeMs
    ) {
      throw new Error("MusicBrainz archive changed after SHA-256 verification");
    }
    const schemaSequence = Number(
      (await readFile(join(temporaryDir, "SCHEMA_SEQUENCE"), "utf8")).trim(),
    );
    if (schemaSequence !== expectedSchemaSequence) {
      throw new Error(
        `MusicBrainz schema sequence ${schemaSequence} does not match supported sequence ${expectedSchemaSequence}`,
      );
    }
    const timestamp = (await readFile(join(temporaryDir, "TIMESTAMP"), "utf8")).trim();
    if (!Number.isFinite(Date.parse(timestamp))) {
      throw new Error("MusicBrainz archive TIMESTAMP is invalid");
    }

    const schemaLookup = await runPsql(psqlCommand, options.database, [
      "-At",
      "-c",
      `SELECT to_regnamespace('${stageSchema}')::text;`,
    ]);
    if (schemaLookup.stdout.trim()) {
      throw new Error(`PostgreSQL stage schema already exists: ${stageSchema}`);
    }

    const ddlTemplate = await readFile(schemaTemplatePath, "utf8");
    if (!ddlTemplate.includes("__STAGE_SCHEMA__")) {
      throw new Error("MusicBrainz stage DDL has no schema placeholder");
    }
    const renderedDdl = ddlTemplate.replaceAll("__STAGE_SCHEMA__", stageSchema);
    const ddlPath = join(temporaryDir, "stage-ddl.sql");
    await writeFile(ddlPath, renderedDdl, { encoding: "utf8", flag: "wx", mode: 0o600 });
    schemaMayExist = true;
    await runPsql(psqlCommand, options.database, ["-f", ddlPath]);
    await runPsql(psqlCommand, options.database, [
      "-c",
      `INSERT INTO ${stageSchema}.musicwiki_stage_meta (snapshot_id, schema_sequence, source_archive_sha256, created_at) VALUES ('${options.snapshot}', ${expectedSchemaSequence}, '${archiveSha256}', '${generatedAt}');`,
    ]);

    for (const [index, table] of tables.entries()) {
      const member = tableMembers[index];
      const sourcePath = join(temporaryDir, member);
      await runPsql(psqlCommand, options.database, [
        "-c",
        `\\copy ${stageSchema}.${table} FROM '${escapeSqlLiteral(sourcePath)}' WITH (FORMAT text)`,
      ]);
    }

    const indexTemplate = await readFile(indexTemplatePath, "utf8");
    if (!indexTemplate.includes("__STAGE_SCHEMA__")) {
      throw new Error("MusicBrainz stage index SQL has no schema placeholder");
    }
    const renderedIndexes = indexTemplate.replaceAll("__STAGE_SCHEMA__", stageSchema);
    const indexPath = join(temporaryDir, "stage-indexes.sql");
    await writeFile(indexPath, renderedIndexes, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await runPsql(psqlCommand, options.database, ["-f", indexPath]);

    const rowCounts = await readRowCounts(psqlCommand, options.database, stageSchema);
    const ddlBytes = await readFile(ddlPath);
    const indexBytes = await readFile(indexPath);
    const manifest = {
      manifest_version: "1.0",
      generated_at: generatedAt,
      mode: "musicbrainz-core-postgres-stage",
      network_requests_executed: 0,
      archive_downloaded_this_run: false,
      license_partition: "musicbrainz-core-cc0",
      snapshot_id: options.snapshot,
      schema_sequence: schemaSequence,
      stage_schema: stageSchema,
      database: options.database,
      source: {
        archive_filename: basename(archivePath),
        archive_bytes: archiveStat.size,
        archive_sha256: archiveSha256,
        timestamp,
      },
      input_verification: {
        status: "caller-digest-revalidated",
        archive_size_revalidated: true,
        archive_sha256_revalidated: true,
        signature_verified: false,
        signature_evidence_owner: "offline-bootstrap-verifier",
      },
      counts: {
        selected_members: selectedMembers.length,
        selected_tables: tables.length,
        imported_tables: Object.keys(rowCounts).length,
        extracted_bytes: extractedFiles.reduce((sum, file) => sum + file.bytes, 0),
      },
      row_counts: rowCounts,
      ddl: {
        template: "database/musicbrainz-stage-v31.sql",
        rendered_relative_path: "stage-ddl.sql",
        bytes: ddlBytes.byteLength,
        sha256: sha256Bytes(ddlBytes),
      },
      indexes: {
        template: "database/musicbrainz-stage-v31-indexes.sql",
        rendered_relative_path: "stage-indexes.sql",
        bytes: indexBytes.byteLength,
        sha256: sha256Bytes(indexBytes),
      },
      selected_files: extractedFiles,
    };
    await writeFile(
      join(temporaryDir, "musicbrainz-stage-manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    await rename(temporaryDir, outputDir);
    published = true;
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  } catch (error) {
    if (schemaMayExist) {
      await runPsql(psqlCommand, options.database, [
        "-c",
        `DROP SCHEMA ${stageSchema} CASCADE;`,
      ]).catch(() => undefined);
    }
    throw error;
  } finally {
    if (!published) await rm(temporaryDir, { recursive: true, force: true });
  }
}

function parseArguments(argv) {
  const options = {
    archive: null,
    expectedBytes: null,
    expectedSha256: null,
    snapshot: null,
    outputDir: null,
    database: null,
    psqlCommand: "psql",
    generatedAt: null,
  };
  const names = {
    "--archive": ["archive", "string"],
    "--expected-bytes": ["expectedBytes", "integer"],
    "--expected-sha256": ["expectedSha256", "string"],
    "--snapshot": ["snapshot", "string"],
    "--output-dir": ["outputDir", "string"],
    "--database": ["database", "string"],
    "--psql-command": ["psqlCommand", "string"],
    "--generated-at": ["generatedAt", "string"],
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
    ["--archive", "archive"],
    ["--expected-bytes", "expectedBytes"],
    ["--expected-sha256", "expectedSha256"],
    ["--snapshot", "snapshot"],
    ["--output-dir", "outputDir"],
    ["--database", "database"],
  ]) {
    if (options[key] === null) throw new Error(`${argument} is required`);
  }
  if (!/^\d{8}-\d{6}$/.test(options.snapshot)) {
    throw new Error("--snapshot must use YYYYMMDD-HHMMSS");
  }
  if (!/^[0-9a-f]{64}$/.test(options.expectedSha256)) {
    throw new Error("--expected-sha256 must be a lowercase SHA-256 digest");
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(options.database)) {
    throw new Error("--database must be a PostgreSQL database name, not a connection URI");
  }
  return options;
}

async function validateArchivePath(requestedPath) {
  if (!isAbsolute(requestedPath)) throw new Error("--archive must be an absolute path");
  const entry = await lstat(requestedPath);
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new Error("--archive must be a regular non-symlink file");
  }
  return realpath(requestedPath);
}

async function validateOutputDirectory(requestedPath) {
  if (!isAbsolute(requestedPath)) throw new Error("--output-dir must be an absolute path");
  const parent = await realpath(dirname(requestedPath));
  if (!(await stat(parent)).isDirectory()) throw new Error("--output-dir parent must be a directory");
  const outputPath = resolve(parent, basename(requestedPath));
  const resolvedRepositoryRoot = await realpath(repositoryRoot);
  if (isPathAtOrWithin(resolvedRepositoryRoot, outputPath)) {
    throw new Error("--output-dir must be outside the repository");
  }
  const existing = await lstat(outputPath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (existing) throw new Error("--output-dir must not already exist");
  return outputPath;
}

async function validateCommand(command) {
  if (!command.includes(sep)) return command;
  if (!isAbsolute(command)) throw new Error("--psql-command with a path must be absolute");
  await access(command, constants.X_OK);
  return command;
}

async function inspectExtractedFiles(root, members) {
  const files = [];
  for (const member of members) {
    const path = join(root, member);
    const entry = await lstat(path);
    const resolved = await realpath(path);
    if (!entry.isFile() || entry.isSymbolicLink() || !isPathAtOrWithin(root, resolved)) {
      throw new Error(`Extracted MusicBrainz member is not a contained regular file: ${member}`);
    }
    files.push({ member, bytes: entry.size });
  }
  return files;
}

async function readRowCounts(psqlCommand, database, stageSchema) {
  const unions = tables
    .map((table) => `SELECT '${table}' AS table_name, count(*)::bigint AS row_count FROM ${stageSchema}.${table}`)
    .join(" UNION ALL ");
  const { stdout } = await runPsql(psqlCommand, database, [
    "-At",
    "-c",
    `SELECT json_object_agg(table_name, row_count ORDER BY table_name) FROM (${unions}) counts;`,
  ]);
  let value;
  try {
    value = JSON.parse(stdout.trim());
  } catch {
    throw new Error("PostgreSQL stage row-count audit did not return JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("PostgreSQL stage row-count audit is malformed");
  }
  for (const table of tables) {
    if (!Number.isSafeInteger(value[table]) || value[table] < 0) {
      throw new Error(`PostgreSQL stage row count is invalid for ${table}`);
    }
  }
  if (Object.keys(value).length !== tables.length) {
    throw new Error("PostgreSQL stage row-count audit contains unexpected tables");
  }
  return Object.fromEntries(tables.map((table) => [table, value[table]]));
}

async function runPsql(command, database, args) {
  return execFileAsync(command, ["-v", "ON_ERROR_STOP=1", "-d", database, ...args], {
    maxBuffer: 10 * 1024 * 1024,
  });
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function escapeSqlLiteral(value) {
  return value.replaceAll("'", "''");
}

function validateTimestamp(value) {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error("--generated-at must be a canonical ISO-8601 UTC timestamp");
  }
  return value;
}

function parsePositiveInteger(value, argument) {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
    throw new Error(`${argument} must be a positive integer`);
  }
  return Number(value);
}

function isPathAtOrWithin(parent, candidate) {
  const difference = relative(parent, candidate);
  return difference === "" || (!difference.startsWith(`..${sep}`) && difference !== "..");
}
