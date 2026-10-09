import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
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
import { createGunzip } from "node:zlib";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { assessOfflineRockCompleteness } from "../../src/data/offline-completeness.ts";
import { MUSICBRAINZ_SAMPLE_REQUIRED_MEMBERS } from "../../src/data/musicbrainz-sample-archive.ts";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const canonicalSchemaTemplatePath = resolve(repositoryRoot, "database/offline-rock-v1.sql");
const relationSchemaTemplatePath = resolve(repositoryRoot, "database/style-relation-v2.sql");
const projectionTemplatePath = resolve(repositoryRoot, "database/offline-canonical-project-v1.sql");
const musicBrainzTables = MUSICBRAINZ_SAMPLE_REQUIRED_MEMBERS
  .filter((member) => member.startsWith("mbdump/"))
  .map((member) => basename(member));
const discogsFiles = {
  artists: "artists.jsonl.gz",
  releases: "releases.jsonl.gz",
  masters: "masters.jsonl.gz",
  labels: "labels.jsonl.gz",
  style_evidence: "style-evidence.jsonl.gz",
};
const requiredMusicBrainzIndexes = [
  "artist_id_idx", "artist_gid_idx", "artist_type_id_idx", "artist_credit_id_idx",
  "artist_credit_name_credit_idx", "artist_credit_name_artist_idx", "release_group_id_idx",
  "release_group_gid_idx", "release_group_artist_credit_idx",
  "release_group_primary_type_id_idx", "release_group_secondary_type_id_idx",
  "release_group_secondary_join_group_idx", "release_id_idx", "release_gid_idx",
  "release_release_group_idx", "release_status_id_idx", "release_packaging_id_idx",
  "release_country_release_idx", "release_unknown_country_release_idx", "iso_3166_1_area_idx",
  "medium_id_idx", "medium_release_idx", "medium_format_id_idx", "track_medium_idx",
  "track_recording_idx", "recording_id_idx", "recording_gid_idx",
  "recording_artist_credit_idx", "url_id_idx", "link_id_idx", "link_type_id_idx",
  "l_artist_url_entity0_idx", "l_artist_url_entity1_idx", "l_release_group_url_entity0_idx",
  "l_release_group_url_entity1_idx", "l_release_url_entity0_idx", "l_release_url_entity1_idx",
];
const auditFields = [
  "styles", "published_styles", "wikidata_rock_styles", "discogs_only_styles", "discogs_style_identities",
  "style_relations", "published_relations", "qualifying_artists", "artists",
  "mapped_musicbrainz_artists", "fallback_discogs_artists", "release_groups",
  "studio_release_groups", "live_release_groups", "releases", "media", "recordings",
  "tracks", "identity_evidence", "accounted_identity_evidence", "identity_components",
  "identity_conflicts", "unquarantined_conflicts", "missing_artist_references",
  "missing_release_group_references", "missing_medium_references", "missing_track_references",
];

await main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Error: ${message}\n`);
  process.exitCode = 1;
});

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const generatedAt = validateTimestamp(
    options.generatedAt ?? new Date().toISOString(),
    "--generated-at",
  );
  const outputDir = await validateOutputDirectory(options.outputDir);
  const psqlCommand = await validateCommand(options.psqlCommand);
  const musicBrainz = await readStageManifest(
    options.musicbrainzStage, "musicbrainz-stage-manifest.json", "MusicBrainz",
  );
  const discogs = await readStageManifest(
    options.discogsStage, "discogs-stage-manifest.json", "Discogs",
  );
  const wikidata = await readStageManifest(
    options.wikidataStage, "wikidata-stage-manifest.json", "Wikidata",
  );
  validateMusicBrainzManifest(musicBrainz.value);
  validateDiscogsManifest(discogs.value);
  validateWikidataManifest(wikidata.value);

  const expectedGeneration =
    `mb-${musicBrainz.value.snapshot_id}__discogs-${discogs.value.snapshot}`;
  if (options.generation !== expectedGeneration) {
    throw new Error(`--generation must equal ${expectedGeneration}`);
  }
  const canonicalSchema = `canon_${options.generation.replaceAll("-", "_")}`;
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(canonicalSchema)) {
    throw new Error("derived canonical schema is not a valid PostgreSQL identifier");
  }

  const verifiedDiscogs = {};
  for (const [kind, filename] of Object.entries(discogsFiles)) {
    const evidence = requireRecord(discogs.value.outputs[kind], `Discogs ${kind} evidence`);
    if (evidence.path !== filename) throw new Error(`Discogs ${kind} output path mismatch`);
    verifiedDiscogs[kind] = await verifyArtifact(
      discogs.directory, filename, evidence, `Discogs ${kind}`,
    );
  }
  const wikidataOutput = requireRecord(wikidata.value.output, "Wikidata output evidence");
  if (wikidataOutput.relative_path !== "entities.jsonl") {
    throw new Error("Wikidata entities output path mismatch");
  }
  const verifiedWikidata = await verifyArtifact(
    wikidata.directory, "entities.jsonl", {
      bytes: wikidataOutput.bytes,
      sha256: wikidataOutput.sha256,
    }, "Wikidata entities",
  );

  const temporaryDir = await mkdtemp(join(dirname(outputDir), ".canonical-project-"));
  let schemaMayExist = false;
  let published = false;
  try {
    const localInputs = {};
    for (const [kind, artifact] of Object.entries(verifiedDiscogs)) {
      localInputs[kind] = await copyJsonLines(
        artifact.path, join(temporaryDir, `${kind}.jsonl`), true, artifact,
      );
      const expectedLines = expectedDiscogsLines(discogs.value, kind);
      if (localInputs[kind].lines !== expectedLines) {
        throw new Error(
          `Discogs ${kind} has ${localInputs[kind].lines} lines, expected ${expectedLines}`,
        );
      }
    }
    localInputs.wikidata = await copyJsonLines(
      verifiedWikidata.path,
      join(temporaryDir, "wikidata-entities.jsonl"),
      false,
      verifiedWikidata,
    );
    if (localInputs.wikidata.lines !== wikidata.value.counts.entities) {
      throw new Error(
        `Wikidata entities has ${localInputs.wikidata.lines} lines, expected ${wikidata.value.counts.entities}`,
      );
    }

    const mbStage = await readMusicBrainzStage(
      psqlCommand, musicBrainz.value.database, musicBrainz.value.stage_schema,
    );
    if (
      mbStage.snapshot_id !== musicBrainz.value.snapshot_id ||
      mbStage.schema_sequence !== musicBrainz.value.schema_sequence ||
      mbStage.source_archive_sha256 !== musicBrainz.value.source.archive_sha256
      || mbStage.canonical_index_count !== requiredMusicBrainzIndexes.length
    ) {
      throw new Error("MusicBrainz PostgreSQL stage does not match its manifest");
    }
    const schemaLookup = await runPsql(psqlCommand, musicBrainz.value.database, [
      "-At", "-c", `SELECT to_regnamespace('${canonicalSchema}')::text;`,
    ]);
    if (schemaLookup.stdout.trim()) {
      throw new Error(`PostgreSQL canonical schema already exists: ${canonicalSchema}`);
    }

    const schemaTemplate = await readFile(canonicalSchemaTemplatePath, "utf8");
    const relationSchemaTemplate = await readFile(relationSchemaTemplatePath, "utf8");
    if (!schemaTemplate.includes("mw_offline")) {
      throw new Error("canonical schema template has no mw_offline namespace");
    }
    if (!relationSchemaTemplate.includes("mw_offline.style_relation")) {
      throw new Error("style relation V2 template has no mw_offline relation namespace");
    }
    const renderedBaseSchema = schemaTemplate.replaceAll("mw_offline", canonicalSchema);
    const renderedRelationSchema = relationSchemaTemplate.replaceAll("mw_offline", canonicalSchema);
    const renderedSchema = `${renderedBaseSchema}\n${renderedRelationSchema}`;
    const renderedProjection = renderProjection({
      template: await readFile(projectionTemplatePath, "utf8"),
      canonicalSchema,
      musicBrainzSchema: musicBrainz.value.stage_schema,
      generatedAt,
      musicBrainz: musicBrainz.value,
      discogs: discogs.value,
      discogsManifestSha256: discogs.sha256,
      wikidata: wikidata.value,
      wikidataManifestSha256: wikidata.sha256,
      paths: {
        artists: localInputs.artists.path,
        releases: localInputs.releases.path,
        masters: localInputs.masters.path,
        styles: localInputs.style_evidence.path,
        wikidata: localInputs.wikidata.path,
      },
    });
    const schemaSqlPath = join(temporaryDir, "canonical-schema.sql");
    const projectionSqlPath = join(temporaryDir, "canonical-project.sql");
    await writeFile(schemaSqlPath, renderedSchema, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await writeFile(projectionSqlPath, renderedProjection, { encoding: "utf8", flag: "wx", mode: 0o600 });

    schemaMayExist = true;
    await runPsql(psqlCommand, musicBrainz.value.database, ["-q", "-f", schemaSqlPath]);
    const projection = await runPsql(psqlCommand, musicBrainz.value.database, [
      "-qAt", "-f", projectionSqlPath,
    ]);
    const metrics = parseAudit(projection.stdout);
    validateAudit(metrics, discogs.value, wikidata.value);
    const completeness = assessOfflineRockCompleteness({
      source_scope: {
        musicbrainz_core_full: musicBrainz.value.mode === "musicbrainz-core-postgres-stage",
        discogs_monthly_full: discogs.value.input_scope === "full-monthly-snapshot",
        wikidata_tracked_closure_full:
          wikidata.value.counts.rock_style_qids > 0 &&
          wikidata.value.counts.tracked_qids === wikidata.value.counts.entities,
      },
      source_integrity: {
        musicbrainz_signature_verified:
          recordOrEmpty(musicBrainz.value.input_verification).signature_verified === true,
        discogs_checksums_verified: discogs.value.input_verification.status === "verified",
        wikidata_revisions_complete:
          wikidata.value.counts.entities_with_revision === wikidata.value.counts.entities,
      },
      styles: {
        discogs_observed: discogs.value.counts.accepted_styles + discogs.value.counts.candidate_styles,
        discogs_retained_accepted_or_candidate: metrics.discogs_style_identities,
        wikidata_closure_qids: wikidata.value.counts.rock_style_qids,
        wikidata_entities_with_revision: wikidata.value.counts.rock_style_qids,
        unresolved_without_status: discogs.value.completeness_evidence.unclassified_rock_styles,
      },
      artists: {
        qualifying: discogs.value.counts.qualifying_artists,
        materialized: metrics.artists,
        missing_references: metrics.missing_artist_references,
        qualifying_catalog_owner_misses:
          discogs.value.completeness_evidence.qualifying_catalog_owner_misses,
      },
      discography: {
        release_groups: metrics.release_groups,
        releases: metrics.releases,
        media: metrics.media,
        missing_release_group_references: metrics.missing_release_group_references,
        missing_medium_references: metrics.missing_medium_references,
        missing_track_references: metrics.missing_track_references,
      },
      identity: {
        evidence_records: metrics.identity_evidence,
        accounted_evidence_records: metrics.accounted_identity_evidence,
        unquarantined_conflicts: metrics.unquarantined_conflicts,
      },
      licensing: { unpartitioned_rows: 0 },
      updates: {
        candidate_generation_audited: true,
        atomic_publish_verified: false,
        previous_generation_retained: false,
      },
    });

    for (const input of Object.values(localInputs)) await rm(input.path);
    const manifest = {
      manifest_version: "1.0",
      generated_at: generatedAt,
      mode: "offline-canonical-postgres-project",
      network_requests_executed: 0,
      archives_downloaded_this_run: false,
      generation_id: options.generation,
      canonical_schema: canonicalSchema,
      database: musicBrainz.value.database,
      projection_audit_passed: true,
      inputs: {
        musicbrainz: {
          manifest_sha256: musicBrainz.sha256,
          snapshot_id: musicBrainz.value.snapshot_id,
          stage_schema: musicBrainz.value.stage_schema,
          source_archive_sha256: musicBrainz.value.source.archive_sha256,
        },
        discogs: {
          manifest_sha256: discogs.sha256,
          snapshot_id: discogs.value.snapshot,
          input_scope: discogs.value.input_scope,
          files: Object.fromEntries(Object.entries(localInputs)
            .filter(([kind]) => kind !== "wikidata")
            .map(([kind, evidence]) => [kind, stripPath(evidence)])),
        },
        wikidata: {
          manifest_sha256: wikidata.sha256,
          snapshot_id: wikidata.value.snapshot_id,
          entities: stripPath(localInputs.wikidata),
        },
      },
      sql: {
        schema_template: "database/offline-rock-v1.sql",
        schema_sha256: sha256Bytes(Buffer.from(renderedBaseSchema)),
        style_relation_v2_template: "database/style-relation-v2.sql",
        style_relation_v2_sha256: sha256Bytes(Buffer.from(renderedRelationSchema)),
        projection_template: "database/offline-canonical-project-v1.sql",
        projection_sha256: sha256Bytes(Buffer.from(renderedProjection)),
      },
      metrics,
      completeness,
    };
    await writeFile(
      join(temporaryDir, "canonical-project-manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    await rename(temporaryDir, outputDir);
    published = true;
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  } catch (error) {
    if (schemaMayExist) {
      await runPsql(psqlCommand, musicBrainz.value.database, [
        "-c", `DROP SCHEMA ${canonicalSchema} CASCADE;`,
      ]).catch(() => undefined);
    }
    throw error;
  } finally {
    if (!published) await rm(temporaryDir, { recursive: true, force: true });
  }
}

function parseArguments(argv) {
  const options = {
    musicbrainzStage: null,
    discogsStage: null,
    wikidataStage: null,
    generation: null,
    outputDir: null,
    psqlCommand: "psql",
    generatedAt: null,
  };
  const names = {
    "--musicbrainz-stage": "musicbrainzStage",
    "--discogs-stage": "discogsStage",
    "--wikidata-stage": "wikidataStage",
    "--generation": "generation",
    "--output-dir": "outputDir",
    "--psql-command": "psqlCommand",
    "--generated-at": "generatedAt",
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const key = names[argument];
    if (!key) throw new Error(`Unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    if (seen.has(argument)) throw new Error(`${argument} may only be provided once`);
    options[key] = value;
    seen.add(argument);
    index += 1;
  }
  for (const [argument, key] of Object.entries({
    "--musicbrainz-stage": "musicbrainzStage",
    "--discogs-stage": "discogsStage",
    "--wikidata-stage": "wikidataStage",
    "--generation": "generation",
    "--output-dir": "outputDir",
  })) {
    if (options[key] === null) throw new Error(`${argument} is required`);
  }
  if (!/^mb-\d{8}-\d{6}__discogs-\d{8}$/.test(options.generation)) {
    throw new Error("--generation must use mb-YYYYMMDD-HHMMSS__discogs-YYYYMMDD");
  }
  return options;
}

async function readStageManifest(requestedDirectory, filename, label) {
  const directory = await validateStageDirectory(requestedDirectory, label);
  const path = join(directory, filename);
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 10_000_000) {
    throw new Error(`${label} manifest must be a bounded regular non-symlink file`);
  }
  const bytes = await readFile(path);
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} manifest is not valid JSON`);
  }
  return { directory, path, value: requireRecord(value, `${label} manifest`), sha256: sha256Bytes(bytes) };
}

function validateMusicBrainzManifest(manifest) {
  validateTimestamp(manifest.generated_at, "MusicBrainz generated_at");
  if (
    manifest.manifest_version !== "1.0" ||
    manifest.mode !== "musicbrainz-core-postgres-stage" ||
    manifest.license_partition !== "musicbrainz-core-cc0" ||
    manifest.archive_downloaded_this_run !== false ||
    manifest.schema_sequence !== 31 ||
    !/^\d{8}-\d{6}$/.test(manifest.snapshot_id) ||
    manifest.stage_schema !== `raw_mb_${manifest.snapshot_id.replaceAll("-", "_")}` ||
    !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(manifest.database)
  ) throw new Error("MusicBrainz stage manifest contract mismatch");
  const source = requireRecord(manifest.source, "MusicBrainz source evidence");
  requireDigest(source.archive_sha256, "MusicBrainz archive SHA-256");
  if (!Number.isSafeInteger(source.archive_bytes) || source.archive_bytes < 1) {
    throw new Error("MusicBrainz archive bytes are invalid");
  }
  const rowCounts = requireRecord(manifest.row_counts, "MusicBrainz row counts");
  const actualTables = Object.keys(rowCounts).sort();
  if (
    actualTables.length !== musicBrainzTables.length ||
    actualTables.some((table, index) => table !== [...musicBrainzTables].sort()[index]) ||
    actualTables.some((table) => !Number.isSafeInteger(rowCounts[table]) || rowCounts[table] < 0)
  ) throw new Error("MusicBrainz stage row-count contract mismatch");
  const indexes = requireRecord(manifest.indexes, "MusicBrainz index evidence");
  if (
    indexes.template !== "database/musicbrainz-stage-v31-indexes.sql" ||
    indexes.rendered_relative_path !== "stage-indexes.sql" ||
    !Number.isSafeInteger(indexes.bytes) || indexes.bytes < 1
  ) throw new Error("MusicBrainz stage index evidence mismatch");
  requireDigest(indexes.sha256, "MusicBrainz stage index SHA-256");
}

function validateDiscogsManifest(manifest) {
  validateTimestamp(manifest.generated_at, "Discogs generated_at");
  if (
    manifest.manifest_version !== "1.0" || manifest.source !== "discogs" ||
    !/^\d{8}$/.test(manifest.snapshot) ||
    !["fixture", "sample", "full-monthly-snapshot"].includes(manifest.input_scope)
  ) throw new Error("Discogs stage manifest contract mismatch");
  const counts = requireRecord(manifest.counts, "Discogs counts");
  for (const name of [
    "qualifying_artists", "selected_releases", "referenced_artists", "selected_masters",
    "selected_labels", "accepted_styles", "candidate_styles",
  ]) requireCount(counts[name], `Discogs ${name}`);
  if (counts.qualifying_artists < 1 || counts.selected_releases < 1) {
    throw new Error("Discogs stage contains no Rock closure");
  }
  const audit = requireRecord(manifest.reference_audit, "Discogs reference audit");
  if (["missing_artists", "missing_masters", "missing_labels"].some((name) => audit[name] !== 0)) {
    throw new Error("Discogs stage has unresolved references");
  }
  const completeness = requireRecord(manifest.completeness_evidence, "Discogs completeness evidence");
  if (
    completeness.qualifying_catalog_owner_misses !== 0 ||
    completeness.unclassified_rock_styles !== 0
  ) throw new Error("Discogs stage completeness evidence failed");
  const verification = requireRecord(manifest.input_verification, "Discogs input verification");
  if (manifest.input_scope === "full-monthly-snapshot" && verification.status !== "verified") {
    throw new Error("full Discogs stage requires verified input checksums");
  }
  requireRecord(manifest.outputs, "Discogs outputs");
}

function validateWikidataManifest(manifest) {
  validateTimestamp(manifest.generated_at, "Wikidata generated_at");
  if (
    manifest.manifest_version !== "1.0" || manifest.mode !== "tracked-qid-api-stage" ||
    manifest.license_partition !== "wikidata-cc0" ||
    manifest.full_wikidata_dump_downloaded !== false || manifest.cursor_advanced !== false ||
    typeof manifest.snapshot_id !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(manifest.snapshot_id)
  ) throw new Error("Wikidata stage manifest contract mismatch");
  const counts = requireRecord(manifest.counts, "Wikidata counts");
  for (const name of ["tracked_qids", "entities", "entities_with_revision"]) {
    requireCount(counts[name], `Wikidata ${name}`);
  }
  const rockStyleCount = counts.rock_style_qids ?? 0;
  requireCount(rockStyleCount, "Wikidata rock_style_qids");
  if (
    counts.tracked_qids < 1 || counts.entities !== counts.tracked_qids ||
    counts.entities_with_revision !== counts.entities || rockStyleCount > counts.tracked_qids
  ) throw new Error("Wikidata tracked entity closure is incomplete");
  if (manifest.rock_style_scope === null || manifest.rock_style_scope === undefined) {
    if (rockStyleCount !== 0) throw new Error("Wikidata Rock style scope evidence is missing");
  } else {
    const scope = requireRecord(manifest.rock_style_scope, "Wikidata Rock style scope");
    if (scope.root_qid !== "Q11399" || scope.license !== "CC0-1.0" ||
        scope.qid_count !== rockStyleCount || rockStyleCount < 1 ||
        typeof scope.snapshot_id !== "string" || !scope.snapshot_id ||
        !/^[a-f0-9]{64}$/u.test(scope.qid_set_sha256 ?? "") ||
        !/^[a-f0-9]{64}$/u.test(scope.catalog_sha256 ?? "") ||
        !Number.isSafeInteger(scope.catalog_bytes) || scope.catalog_bytes < 1) {
      throw new Error("Wikidata Rock style scope evidence is invalid");
    }
  }
  const source = requireRecord(manifest.source, "Wikidata source evidence");
  const endpoint = new URL(source.endpoint);
  if (endpoint.protocol !== "https:") throw new Error("Wikidata source endpoint must use HTTPS");
}

async function verifyArtifact(directory, filename, evidence, label) {
  if (basename(filename) !== filename) throw new Error(`${label} path is not a basename`);
  requireDigest(evidence.sha256, `${label} SHA-256`);
  requireCount(evidence.bytes, `${label} bytes`);
  const path = join(directory, filename);
  const entry = await lstat(path);
  const resolved = await realpath(path);
  if (
    !entry.isFile() || entry.isSymbolicLink() || !isPathAtOrWithin(directory, resolved)
  ) throw new Error(`${label} must be a contained regular non-symlink file`);
  if (entry.size !== evidence.bytes) {
    throw new Error(`${label} has ${entry.size} bytes, expected ${evidence.bytes}`);
  }
  const digest = await sha256File(resolved);
  if (digest !== evidence.sha256) throw new Error(`${label} SHA-256 mismatch`);
  return { path: resolved, bytes: entry.size, sha256: digest };
}

async function copyJsonLines(sourcePath, targetPath, compressed, expectedSource) {
  const sourceHash = createHash("sha256");
  let sourceBytes = 0;
  const sourceInspector = new Transform({
    transform(chunk, _encoding, callback) {
      sourceHash.update(chunk);
      sourceBytes += chunk.byteLength;
      callback(null, chunk);
    },
  });
  const contentHash = createHash("sha256");
  let bytes = 0;
  let lines = 0;
  let lastByte = null;
  const inspector = new Transform({
    transform(chunk, _encoding, callback) {
      contentHash.update(chunk);
      bytes += chunk.byteLength;
      for (const byte of chunk) if (byte === 10) lines += 1;
      if (chunk.byteLength) lastByte = chunk[chunk.byteLength - 1];
      callback(null, chunk);
    },
  });
  const streams = [createReadStream(sourcePath), sourceInspector];
  if (compressed) streams.push(createGunzip());
  streams.push(inspector, createWriteStream(targetPath, { flags: "wx", mode: 0o600 }));
  await pipeline(streams);
  const sourceSha256 = sourceHash.digest("hex");
  if (sourceBytes !== expectedSource.bytes || sourceSha256 !== expectedSource.sha256) {
    throw new Error(`${basename(sourcePath)} changed after artifact verification`);
  }
  if (bytes > 0 && lastByte !== 10) throw new Error(`${basename(sourcePath)} must end with a newline`);
  return {
    path: targetPath,
    bytes,
    sha256: contentHash.digest("hex"),
    lines,
    source_bytes: sourceBytes,
    source_sha256: sourceSha256,
  };
}

async function readMusicBrainzStage(psqlCommand, database, stageSchema) {
  const indexList = requiredMusicBrainzIndexes.map(sqlLiteral).join(", ");
  const result = await runPsql(psqlCommand, database, [
    "-At", "-c",
    `SELECT json_build_object('snapshot_id', snapshot_id, 'schema_sequence', schema_sequence, 'source_archive_sha256', source_archive_sha256, 'canonical_index_count', (SELECT count(*)::integer FROM pg_indexes WHERE schemaname = '${stageSchema}' AND indexname IN (${indexList})))::text FROM ${stageSchema}.musicwiki_stage_meta;`,
  ]);
  const lines = result.stdout.trim().split("\n").filter(Boolean);
  if (lines.length !== 1) throw new Error("MusicBrainz PostgreSQL stage metadata is missing");
  try {
    return requireRecord(JSON.parse(lines[0]), "MusicBrainz PostgreSQL stage metadata");
  } catch {
    throw new Error("MusicBrainz PostgreSQL stage metadata is malformed");
  }
}

function renderProjection(input) {
  const discogsYear = input.discogs.snapshot.slice(0, 4);
  const replacements = {
    "__CANONICAL_SCHEMA__": input.canonicalSchema,
    "__MUSICBRAINZ_SCHEMA__": input.musicBrainzSchema,
    "__DISCOGS_ARTISTS_PATH__": sqlLiteral(input.paths.artists),
    "__DISCOGS_RELEASES_PATH__": sqlLiteral(input.paths.releases),
    "__DISCOGS_MASTERS_PATH__": sqlLiteral(input.paths.masters),
    "__DISCOGS_STYLES_PATH__": sqlLiteral(input.paths.styles),
    "__WIKIDATA_ENTITIES_PATH__": sqlLiteral(input.paths.wikidata),
    "__MB_SOURCE_SNAPSHOT_ID__": sqlLiteral(`offline:musicbrainz:${input.musicBrainz.snapshot_id}`),
    "__MB_UPSTREAM_VERSION__": sqlLiteral(input.musicBrainz.snapshot_id),
    "__MB_RETRIEVED_AT__": sqlLiteral(input.musicBrainz.generated_at),
    "__GENERATED_AT__": sqlLiteral(input.generatedAt),
    "__MB_SOURCE_URL__": sqlLiteral(
      `https://data.metabrainz.org/pub/musicbrainz/data/fullexport/${input.musicBrainz.snapshot_id}/mbdump.tar.bz2`,
    ),
    "__MB_ARCHIVE_SHA256__": sqlLiteral(input.musicBrainz.source.archive_sha256),
    "__DISCOGS_SOURCE_SNAPSHOT_ID__": sqlLiteral(`offline:discogs:${input.discogs.snapshot}`),
    "__DISCOGS_UPSTREAM_VERSION__": sqlLiteral(input.discogs.snapshot),
    "__DISCOGS_RETRIEVED_AT__": sqlLiteral(input.discogs.generated_at),
    "__DISCOGS_SOURCE_URL__": sqlLiteral(`https://data.discogs.com/?prefix=data/${discogsYear}/`),
    "__DISCOGS_MANIFEST_SHA256__": sqlLiteral(input.discogsManifestSha256),
    "__WIKIDATA_SOURCE_SNAPSHOT_ID__": sqlLiteral(`offline:wikidata:${input.wikidata.snapshot_id}`),
    "__WIKIDATA_UPSTREAM_VERSION__": sqlLiteral(input.wikidata.snapshot_id),
    "__WIKIDATA_RETRIEVED_AT__": sqlLiteral(input.wikidata.generated_at),
    "__WIKIDATA_SOURCE_URL__": sqlLiteral(input.wikidata.source.endpoint),
    "__WIKIDATA_MANIFEST_SHA256__": sqlLiteral(input.wikidataManifestSha256),
  };
  let rendered = input.template;
  for (const [placeholder, replacement] of Object.entries(replacements)) {
    if (!rendered.includes(placeholder)) throw new Error(`projection template lacks ${placeholder}`);
    rendered = rendered.replaceAll(placeholder, replacement);
  }
  const unresolved = rendered.match(/__[A-Z0-9_]+__/g);
  if (unresolved) throw new Error(`projection template has unresolved placeholders: ${unresolved.join(", ")}`);
  return rendered;
}

function parseAudit(stdout) {
  const lines = stdout.trim().split("\n").filter(Boolean);
  if (lines.length < 1) throw new Error("canonical projection returned no audit JSON");
  let value;
  try {
    value = JSON.parse(lines.at(-1));
  } catch {
    throw new Error("canonical projection audit is malformed");
  }
  const audit = requireRecord(value, "canonical projection audit");
  const keys = Object.keys(audit).sort();
  if (
    keys.length !== auditFields.length ||
    keys.some((field, index) => field !== [...auditFields].sort()[index])
  ) throw new Error("canonical projection audit fields do not match the contract");
  for (const field of auditFields) requireCount(audit[field], `canonical audit ${field}`);
  return audit;
}

function validateAudit(metrics, discogs, wikidata) {
  const observedStyles = discogs.counts.accepted_styles + discogs.counts.candidate_styles;
  if (metrics.wikidata_rock_styles !== wikidata.counts.rock_style_qids ||
      metrics.discogs_style_identities !== observedStyles ||
      metrics.styles !== metrics.wikidata_rock_styles + metrics.discogs_only_styles ||
      metrics.published_styles < metrics.wikidata_rock_styles ||
      metrics.published_styles > metrics.styles) {
    throw new Error("canonical style closure count mismatch");
  }
  if (metrics.qualifying_artists !== discogs.counts.qualifying_artists) {
    throw new Error("canonical qualifying artist closure count mismatch");
  }
  if (
    metrics.styles < 1 || metrics.style_relations < 1 || metrics.artists < metrics.qualifying_artists ||
    metrics.release_groups < 1 || metrics.releases < 1 || metrics.media < 1 ||
    metrics.identity_evidence < 1 ||
    metrics.accounted_identity_evidence !== metrics.identity_evidence ||
    metrics.unquarantined_conflicts !== 0 || metrics.missing_artist_references !== 0 ||
    metrics.missing_release_group_references !== 0 || metrics.missing_medium_references !== 0 ||
    metrics.missing_track_references !== 0
  ) throw new Error("canonical projection failed closure or reference audit");
}

function expectedDiscogsLines(manifest, kind) {
  const mapping = {
    artists: manifest.counts.referenced_artists,
    releases: manifest.counts.selected_releases,
    masters: manifest.counts.selected_masters,
    labels: manifest.counts.selected_labels,
    style_evidence: manifest.counts.accepted_styles + manifest.counts.candidate_styles,
  };
  return mapping[kind];
}

async function validateStageDirectory(requestedPath, label) {
  if (!isAbsolute(requestedPath)) throw new Error(`${label} stage must be an absolute path`);
  const entry = await lstat(requestedPath);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error(`${label} stage must be a non-symlink directory`);
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

async function runPsql(command, database, args) {
  return execFileAsync(command, ["-v", "ON_ERROR_STOP=1", "-d", database, ...args], {
    maxBuffer: 20 * 1024 * 1024,
  });
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function stripPath(evidence) {
  const { path: _path, ...rest } = evidence;
  return rest;
}

function requireRecord(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function recordOrEmpty(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function requireDigest(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function requireCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function validateTimestamp(value, label) {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO-8601 UTC timestamp`);
  }
  return value;
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function isPathAtOrWithin(parent, candidate) {
  const difference = relative(parent, candidate);
  return difference === "" || (!difference.startsWith(`..${sep}`) && difference !== "..");
}
