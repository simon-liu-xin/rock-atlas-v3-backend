import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const canonicalPath = resolve(repositoryRoot, "data/published/rock-catalog-v2/canonical-catalog.json");
const frontendCandidatePath = resolve(repositoryRoot, "data/published/rock-catalog-v2/frontend-catalog.json");
const frontendContextPath = resolve(repositoryRoot, "data/published/rock-catalog-v2/frontend-context.json");
const manifestPath = resolve(repositoryRoot, "data/published/rock-catalog-v2/manifest.json");
const baseSchemaPath = resolve(repositoryRoot, "database/offline-rock-v1.sql");
const relationSchemaPath = resolve(repositoryRoot, "database/style-relation-v2.sql");
const controlSchemaPath = resolve(repositoryRoot, "database/catalog-control-v1.sql");
const frontendExportSqlPath = resolve(repositoryRoot, "database/bounded-frontend-export-v3.sql");
const archiveRoot = resolve(repositoryRoot, "data/archive/rock-catalog-v2-static");
const containerName = process.env.MUSICWIKI_CATALOG_POSTGRES_CONTAINER ?? "musicwiki-catalog-postgres-v2";
const volumeName = process.env.MUSICWIKI_CATALOG_POSTGRES_VOLUME ?? "musicwiki-catalog-postgres-v2";
const databaseName = "musicwiki";

const [canonicalBytes, frontendContextBytes, manifestBytes] = await Promise.all([
  readFile(canonicalPath),
  readFile(frontendContextPath),
  readFile(manifestPath),
]);
const canonical = JSON.parse(canonicalBytes);
const manifest = JSON.parse(manifestBytes);
validateArtifacts(canonical, frontendContextBytes, manifest);
const schemaName = generationSchema(canonical.generation_id);

await ensurePostgres();
await runPsql(await readFile(controlSchemaPath, "utf8"));
const registered = await queryText(
  `SELECT status FROM mw_catalog_control.generation_registry WHERE generation_id = ${sqlLiteral(canonical.generation_id)};`,
);
let createdSchema = false;
if (!registered) {
  const existingSchema = await queryText(`SELECT to_regnamespace(${sqlLiteral(schemaName)})::text;`);
  if (existingSchema) {
    throw new Error(`Unregistered catalog schema already exists: ${schemaName}`);
  }
  const baseSchema = (await readFile(baseSchemaPath, "utf8")).replaceAll("mw_offline", schemaName);
  const relationSchema = (await readFile(relationSchemaPath, "utf8")).replaceAll("mw_offline", schemaName);
  await runPsql(`${baseSchema}\n${relationSchema}`);
  createdSchema = true;
  try {
    await runPsql(loadSql(schemaName, canonical));
  } catch (error) {
    await runPsql(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE;`).catch(() => undefined);
    throw error;
  }
}

let immutable;
try {
  if (registered && registered !== "published") {
    throw new Error(`Generation ${canonical.generation_id} is registered as ${registered}, not published.`);
  }
  const frontend = await exportFrontendFromPostgres(schemaName);
  const frontendBytes = Buffer.from(`${JSON.stringify(frontend, null, 2)}\n`);
  validateFrontendExport(frontend, canonical);
  await atomicWrite(frontendCandidatePath, frontendBytes);
  immutable = await publishImmutableFrontend(canonical, frontendBytes);
  if (!registered) await runPsql(publishSql(schemaName, canonical, immutable));
  await publishFinalManifest(manifest, frontendBytes);
  await publishPointer(canonical, immutable);
} catch (error) {
  if (createdSchema) {
    const registryStatus = await queryText(
      `SELECT status FROM mw_catalog_control.generation_registry WHERE generation_id = ${sqlLiteral(canonical.generation_id)};`,
    ).catch(() => "");
    if (!registryStatus) {
      await runPsql(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE;`).catch(() => undefined);
    }
  }
  throw error;
}

const report = JSON.parse(await queryText(reportSql(schemaName)));
console.log(JSON.stringify({
  mode: registered ? "reconciled-existing-generation" : "loaded-and-published",
  container: containerName,
  volume: volumeName,
  database: databaseName,
  schema: schemaName,
  generation_id: canonical.generation_id,
  archived_pointer: "data/archive/rock-catalog-v2-static/current.json",
  archived_catalog: immutable.relativePath,
  next_step: "npm run data:catalog:v3",
  counts: report,
}, null, 2));

async function ensurePostgres() {
  const inspected = await execFileAsync("docker", ["inspect", containerName]).catch(() => null);
  if (!inspected) {
    const initialPassword = randomBytes(24).toString("base64url");
    await execFileAsync("docker", [
      "run", "--name", containerName,
      "--env", "POSTGRES_DB=musicwiki",
      "--env", `POSTGRES_PASSWORD=${initialPassword}`,
      "--mount", `type=volume,source=${volumeName},target=/var/lib/postgresql`,
      "--detach", "postgres:18-alpine",
    ]);
  } else {
    const running = JSON.parse(inspected.stdout)[0]?.State?.Running === true;
    if (!running) await execFileAsync("docker", ["start", containerName]);
  }
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const ready = await execFileAsync("docker", [
      "exec", containerName, "pg_isready", "-U", "postgres", "-d", databaseName,
    ]).catch(() => null);
    if (ready?.stdout.includes("accepting connections")) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw new Error("PostgreSQL container did not become ready.");
}

async function runPsql(sql) {
  await new Promise((resolveRun, rejectRun) => {
    const child = spawn("docker", [
      "exec", "-i", containerName,
      "psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", databaseName,
    ], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", rejectRun);
    child.on("close", (code) => {
      if (code === 0) resolveRun(stdout);
      else rejectRun(new Error(`psql failed (${code}): ${stderr || stdout}`));
    });
    child.stdin.end(sql);
  });
}

async function queryText(sql) {
  const result = await execFileAsync("docker", [
    "exec", containerName,
    "psql", "-v", "ON_ERROR_STOP=1", "-At", "-U", "postgres", "-d", databaseName,
    "-c", sql,
  ], { maxBuffer: 64 * 1024 * 1024 });
  return result.stdout.trim();
}

function loadSql(schema, payload) {
  const json = JSON.stringify(payload);
  if (json.includes("$musicwiki_catalog_payload$")) throw new Error("Catalog payload collides with SQL delimiter.");
  return `\\set ON_ERROR_STOP on
BEGIN ISOLATION LEVEL SERIALIZABLE;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';
CREATE TEMP TABLE stage_catalog_payload (doc jsonb NOT NULL) ON COMMIT DROP;
INSERT INTO stage_catalog_payload VALUES ($musicwiki_catalog_payload$${json}$musicwiki_catalog_payload$::jsonb);

INSERT INTO ${schema}.source_snapshot (
  snapshot_id, source_name, upstream_version, retrieved_at, source_url,
  license_partition, redistributable, status
)
SELECT snapshot_id, source_name, upstream_version, retrieved_at::timestamptz,
  source_url, license_partition, redistributable, 'validated'
FROM jsonb_to_recordset((SELECT doc->'source_snapshots' FROM stage_catalog_payload)) AS source(
  snapshot_id text, source_name text, upstream_version text, retrieved_at text,
  source_url text, license_partition text, redistributable boolean
);

INSERT INTO ${schema}.style (
  internal_id, canonical_name, sort_name, description, origin_date_text, region_text,
  source_metadata, inclusion_status, first_seen_snapshot_id, updated_at
)
SELECT internal_id, canonical_name, sort_name, description, origin_date_text, region_text,
  jsonb_build_object(
    'wikidata_qid', wikidata_qid,
    'source_revision_id', source_revision_id,
    'parent_qids', parent_qids,
    'country_qids', country_qids,
    'instance_of_qids', instance_of_qids,
    'source_url', source_url
  ), inclusion_status, source_snapshot_id, ${sqlLiteral(payload.generated_at)}::timestamptz
FROM jsonb_to_recordset((SELECT doc->'styles' FROM stage_catalog_payload)) AS style(
  internal_id text, canonical_name text, sort_name text, description text,
  origin_date_text text, region_text text, inclusion_status text, wikidata_qid text,
  source_revision_id text, source_url text, source_snapshot_id text,
  parent_qids jsonb, country_qids jsonb, instance_of_qids jsonb, payload_sha256 text
);

INSERT INTO ${schema}.representative_candidate_review (
  review_id, style_id, candidate_artist_qid, candidate_album_qid, review_status,
  conflict_codes, resolution_payload, source_snapshot_ids, reviewed_at
)
SELECT review_id, style_id, candidate_artist_qid, candidate_album_qid, review_status,
  ARRAY(SELECT jsonb_array_elements_text(conflict_codes)), resolution_payload,
  ARRAY(SELECT jsonb_array_elements_text(source_snapshot_ids)), reviewed_at::timestamptz
FROM jsonb_to_recordset((SELECT doc->'representative_candidate_reviews' FROM stage_catalog_payload)) AS review(
  review_id text, style_id text, candidate_artist_qid text, candidate_album_qid text,
  review_status text, conflict_codes jsonb, resolution_payload jsonb,
  source_snapshot_ids jsonb, reviewed_at text
);

INSERT INTO ${schema}.artist (
  internal_id, canonical_name, sort_name, artist_type, description, source_metadata,
  first_seen_snapshot_id, updated_at
)
SELECT internal_id, canonical_name, sort_name, artist_type, description,
  jsonb_build_object(
    'musicbrainz_mbid', musicbrainz_mbid,
    'discogs_id', discogs_id,
    'wikidata_qid', wikidata_qid,
    'source_revision_id', source_revision_id,
    'source_url', source_url
  ), source_snapshot_id, ${sqlLiteral(payload.generated_at)}::timestamptz
FROM jsonb_to_recordset((SELECT doc->'artists' FROM stage_catalog_payload)) AS artist(
  internal_id text, canonical_name text, sort_name text, artist_type text, description text,
  musicbrainz_mbid text, discogs_id text, wikidata_qid text, source_revision_id text, source_url text,
  source_snapshot_id text, payload_sha256 text
);

INSERT INTO ${schema}.release_group (
  internal_id, canonical_name, primary_type, secondary_types, first_release_date_text,
  description, cover_art_url, cover_art_source, source_metadata,
  first_seen_snapshot_id, updated_at
)
SELECT internal_id, canonical_name, primary_type,
  ARRAY(SELECT jsonb_array_elements_text(secondary_types)), first_release_date_text,
  description, cover_art_url, cover_art_source,
  jsonb_build_object(
    'musicbrainz_mbid', musicbrainz_mbid,
    'discogs_master_id', discogs_master_id,
    'wikidata_qid', wikidata_qid,
    'source_revision_id', source_revision_id,
    'source_url', source_url
  ), source_snapshot_id, ${sqlLiteral(payload.generated_at)}::timestamptz
FROM jsonb_to_recordset((SELECT doc->'release_groups' FROM stage_catalog_payload)) AS release_group(
  internal_id text, canonical_name text, primary_type text, secondary_types jsonb,
  first_release_date_text text, description text, cover_art_url text, cover_art_source text,
  musicbrainz_mbid text, discogs_master_id text, wikidata_qid text, source_revision_id text, source_url text,
  source_snapshot_id text, artist_ids jsonb, payload_sha256 text
);

INSERT INTO ${schema}.release_group_artist (
  release_group_id, artist_id, credit_position, credited_name, join_phrase
)
SELECT release_group.internal_id, artist_id.value,
  artist_id.ordinality::integer - 1, artist.canonical_name, ''
FROM jsonb_to_recordset((SELECT doc->'release_groups' FROM stage_catalog_payload)) AS release_group(
  internal_id text, artist_ids jsonb
)
CROSS JOIN LATERAL jsonb_array_elements_text(release_group.artist_ids)
  WITH ORDINALITY AS artist_id(value, ordinality)
JOIN ${schema}.artist artist ON artist.internal_id = artist_id.value;

INSERT INTO ${schema}.source_entity (
  source_snapshot_id, source_entity_type, external_id, payload, payload_sha256
)
SELECT source_snapshot_id, source_entity_type, external_id, payload, payload_sha256
FROM jsonb_to_recordset((SELECT doc->'source_entities' FROM stage_catalog_payload)) AS source_entity(
  source_snapshot_id text, source_entity_type text, external_id text,
  payload jsonb, payload_sha256 text
);

INSERT INTO ${schema}.source_entity (
  source_snapshot_id, source_entity_type, external_id, payload, payload_sha256
)
SELECT source_snapshot_id, 'style', wikidata_qid,
  to_jsonb(style) - 'payload_sha256', payload_sha256
FROM jsonb_to_recordset((SELECT doc->'styles' FROM stage_catalog_payload)) AS style(
  internal_id text, canonical_name text, sort_name text, description text,
  origin_date_text text, region_text text, inclusion_status text, wikidata_qid text,
  source_revision_id text, source_url text, source_snapshot_id text,
  parent_qids jsonb, country_qids jsonb, instance_of_qids jsonb, payload_sha256 text
)
UNION ALL
SELECT source_snapshot_id, 'artist', COALESCE(musicbrainz_mbid, wikidata_qid, internal_id),
  to_jsonb(artist) - 'payload_sha256', payload_sha256
FROM jsonb_to_recordset((SELECT doc->'artists' FROM stage_catalog_payload)) AS artist(
  internal_id text, canonical_name text, sort_name text, artist_type text, description text,
  musicbrainz_mbid text, discogs_id text, wikidata_qid text, source_revision_id text, source_url text,
  source_snapshot_id text, payload_sha256 text
)
UNION ALL
SELECT source_snapshot_id, 'release_group', COALESCE(musicbrainz_mbid, wikidata_qid, internal_id),
  to_jsonb(release_group) - 'payload_sha256', payload_sha256
FROM jsonb_to_recordset((SELECT doc->'release_groups' FROM stage_catalog_payload)) AS release_group(
  internal_id text, canonical_name text, primary_type text, secondary_types jsonb,
  first_release_date_text text, description text, cover_art_url text, cover_art_source text,
  musicbrainz_mbid text, discogs_master_id text, wikidata_qid text, source_revision_id text, source_url text,
  source_snapshot_id text, artist_ids jsonb, payload_sha256 text
)
ON CONFLICT (source_snapshot_id, source_entity_type, external_id) DO NOTHING;

INSERT INTO ${schema}.entity_source_assertion (
  assertion_id, entity_type, internal_id, source_snapshot_id, source_name,
  assertion_kind, external_namespace, external_id, verification_status,
  evidence_locator, assertion_payload
)
SELECT assertion_id, entity_type, internal_id, source_snapshot_id, source_name,
  assertion_kind, external_namespace, external_id, verification_status,
  evidence_locator, assertion_payload
FROM jsonb_to_recordset((SELECT doc->'entity_source_assertions' FROM stage_catalog_payload)) AS assertion(
  assertion_id text, entity_type text, internal_id text, source_snapshot_id text,
  source_name text, assertion_kind text, external_namespace text, external_id text,
  verification_status text, evidence_locator text, assertion_payload jsonb
);

INSERT INTO ${schema}.external_identity (
  internal_id, namespace, external_id, source_snapshot_id, assertion_status
)
SELECT internal_id, 'wikidata-item', wikidata_qid, source_snapshot_id, 'accepted'
FROM jsonb_to_recordset((SELECT doc->'styles' FROM stage_catalog_payload)) AS style(
  internal_id text, wikidata_qid text, source_snapshot_id text
)
UNION ALL
SELECT internal_id, external_namespace, external_id, source_snapshot_id, 'accepted'
FROM ${schema}.entity_source_assertion
WHERE assertion_kind = 'identity'
  AND verification_status IN ('observed', 'corroborated');

INSERT INTO ${schema}.catalog_evidence (
  evidence_id, source_dataset, source_record_id, source_url, claim_text,
  retrieved_at, snapshot_version, license_partition
)
SELECT evidence_id, source_dataset, source_record_id, source_url, claim,
  retrieved_at::timestamptz, snapshot_version, license_partition
FROM jsonb_to_recordset((SELECT doc->'catalog_evidence' FROM stage_catalog_payload)) AS evidence(
  evidence_id text, source_dataset text, source_record_id text, source_url text,
  claim text, retrieved_at text, snapshot_version text, license_partition text
);

INSERT INTO ${schema}.frontend_projection_context (
  context_key, payload, source_snapshot_id, payload_sha256
)
SELECT 'catalog', doc->'frontend_context',
  (doc->'source_snapshots'->0->>'snapshot_id'), doc->>'frontend_context_sha256'
FROM stage_catalog_payload;

INSERT INTO ${schema}.artist_style_assertion (
  artist_id, style_id, source_snapshot_id, assertion_basis, confidence_status, evidence_locator
)
SELECT artist_id, asserted_style_id, source_snapshot_id,
  CASE WHEN selection_basis = 'curated-seed' THEN 'curated-seed' ELSE 'wikidata-direct-genre' END,
  'observed', min(evidence_locator)
FROM jsonb_to_recordset((SELECT doc->'representative_artists' FROM stage_catalog_payload)) AS representative(
  style_id text, artist_id text, asserted_style_id text, source_snapshot_id text, selection_basis text,
  evidence_locator text
)
GROUP BY artist_id, asserted_style_id, source_snapshot_id,
  CASE WHEN selection_basis = 'curated-seed' THEN 'curated-seed' ELSE 'wikidata-direct-genre' END;

INSERT INTO ${schema}.style_representative_artist (
  style_id, artist_id, asserted_style_id, source_snapshot_id, selection_basis,
  confidence_band, ancestor_distance, selection_score, evidence_locator,
  occurrence_id, evidence_id, validation_status, verified_sources,
  musicbrainz_status, discogs_status, conflict_details, selected_at
)
SELECT style_id, artist_id, asserted_style_id, source_snapshot_id, selection_basis,
  confidence_band, ancestor_distance, selection_score, evidence_locator, occurrence_id,
  evidence_id, validation_status,
  ARRAY(SELECT jsonb_array_elements_text(verified_sources)),
  musicbrainz_status, discogs_status, conflicts,
  ${sqlLiteral(payload.generated_at)}::timestamptz
FROM jsonb_to_recordset((SELECT doc->'representative_artists' FROM stage_catalog_payload)) AS representative(
  style_id text, artist_id text, asserted_style_id text, source_snapshot_id text,
  selection_basis text, confidence_band text, ancestor_distance smallint,
  selection_score integer, evidence_locator text, occurrence_id text, evidence_id text,
  validation_status text, verified_sources jsonb, musicbrainz_status text,
  discogs_status text, conflicts jsonb
);

INSERT INTO ${schema}.style_representative_release_group (
  style_id, artist_id, release_group_id, source_snapshot_id, selection_basis,
  selection_score, evidence_locator, occurrence_id, evidence_id, validation_status,
  verified_sources, musicbrainz_status, discogs_status, conflict_details, selected_at
)
SELECT style_id, artist_id, release_group_id, source_snapshot_id, selection_basis,
  selection_score, evidence_locator, occurrence_id, evidence_id, validation_status,
  ARRAY(SELECT jsonb_array_elements_text(verified_sources)),
  musicbrainz_status, discogs_status, conflicts,
  ${sqlLiteral(payload.generated_at)}::timestamptz
FROM jsonb_to_recordset((SELECT doc->'representative_release_groups' FROM stage_catalog_payload)) AS representative(
  style_id text, artist_id text, release_group_id text, source_snapshot_id text,
  selection_basis text, selection_score integer, evidence_locator text,
  occurrence_id text, evidence_id text, validation_status text, verified_sources jsonb,
  musicbrainz_status text, discogs_status text, conflicts jsonb
);

INSERT INTO ${schema}.style_relation (relation_id, relation_kind, direction)
SELECT DISTINCT ON (relation_id) relation_id, relation_type, direction
FROM jsonb_to_recordset((SELECT doc->'style_relations_v2' FROM stage_catalog_payload)) AS relation(
  relation_id text, relation_type text, direction text
) ORDER BY relation_id;

INSERT INTO ${schema}.style_relation_participant (
  relation_id, style_id, participant_role, ordinal
)
SELECT DISTINCT relation.relation_id, participant.style_id, participant.role,
  participant.ordinal
FROM jsonb_to_recordset((SELECT doc->'style_relations_v2' FROM stage_catalog_payload)) AS relation(
  relation_id text, participants jsonb
)
CROSS JOIN LATERAL jsonb_to_recordset(relation.participants) AS participant(
  style_id text, role text, ordinal smallint
);

INSERT INTO ${schema}.style_relation_evidence (
  evidence_id, source_snapshot_id, source_dataset, source_record_id, source_url,
  evidence_locator, claim_text, retrieved_at, license_partition
)
SELECT evidence_id,
  CASE WHEN snapshot_version IN (SELECT snapshot_id FROM ${schema}.source_snapshot)
    THEN snapshot_version ELSE NULL END,
  source_dataset, source_record_id, source_url, source_record_id, claim,
  retrieved_at::timestamptz, license_partition
FROM jsonb_to_recordset((SELECT doc->'relation_evidence' FROM stage_catalog_payload)) AS evidence(
  evidence_id text, source_dataset text, source_record_id text, source_url text,
  claim text, retrieved_at text, snapshot_version text, license_partition text
);

INSERT INTO ${schema}.style_relation_assertion_v2 (
  assertion_id, relation_id, claim_key, assertion_kind, stance, review_status,
  metadata_completeness, claim_geographies, claim_contexts,
  time_start, time_end, time_precision, confidence_band, source_datasets,
  snapshot_version, pipeline_version, license_partition, created_at
)
SELECT assertion_id, relation_id, claim_key, assertion_kind, stance, review_status,
  metadata_completeness,
  ARRAY(SELECT jsonb_array_elements_text(claim_scope->'geographies')),
  ARRAY(SELECT jsonb_array_elements_text(claim_scope->'contexts')),
  NULLIF(time_context->>'start', '')::timestamptz,
  NULLIF(time_context->>'end', '')::timestamptz,
  NULLIF(time_context->>'precision', ''),
  confidence_band,
  ARRAY(SELECT jsonb_array_elements_text(source_datasets)),
  snapshot_version, pipeline_version, license_partition,
  ${sqlLiteral(payload.generated_at)}::timestamptz
FROM jsonb_to_recordset((SELECT doc->'style_relations_v2' FROM stage_catalog_payload)) AS assertion(
  assertion_id text, relation_id text, claim_key text, assertion_kind text,
  stance text, review_status text, metadata_completeness text,
  claim_scope jsonb, time_context jsonb, confidence_band text,
  source_datasets jsonb, snapshot_version text, pipeline_version text,
  license_partition text
);

INSERT INTO ${schema}.style_relation_assertion_evidence_v2 (assertion_id, evidence_id)
SELECT assertion.assertion_id, evidence_id.value
FROM jsonb_to_recordset((SELECT doc->'style_relations_v2' FROM stage_catalog_payload)) AS assertion(
  assertion_id text, evidence_ids jsonb
)
CROSS JOIN LATERAL jsonb_array_elements_text(assertion.evidence_ids) AS evidence_id(value);

INSERT INTO ${schema}.catalog_publication (
  generation_id, source_fingerprint_sha256, status, style_count,
  representative_artist_count, representative_release_group_count,
  cross_verified_count, single_source_count, curated_count, conflicted_count, relation_count,
  frontend_export_path, frontend_export_sha256, generated_at
)
SELECT
  ${sqlLiteral(payload.generation_id)}, ${sqlLiteral(payload.source_fingerprint_sha256)},
  'validated', 828, 828, 828,
  count(*) FILTER (WHERE validation_status = 'cross_verified'),
  count(*) FILTER (WHERE validation_status = 'single_source'),
  count(*) FILTER (WHERE validation_status = 'curated'),
  0,
  (SELECT count(DISTINCT relation_id) FROM ${schema}.style_relation),
  NULL, NULL,
  ${sqlLiteral(payload.generated_at)}::timestamptz
FROM ${schema}.style_representative_artist;

DO $validation$
BEGIN
  IF (SELECT count(*) FROM ${schema}.style) <> 828
     OR (SELECT count(*) FROM ${schema}.style_representative_artist) <> 828
     OR (SELECT count(*) FROM ${schema}.style_representative_release_group) <> 828 THEN
    RAISE EXCEPTION 'bounded catalog cardinality validation failed';
  END IF;
  IF EXISTS (
    SELECT 1 FROM ${schema}.style_representative_artist representative
    LEFT JOIN ${schema}.style_representative_release_group release
      ON release.style_id = representative.style_id AND release.artist_id = representative.artist_id
    WHERE release.style_id IS NULL
  ) THEN RAISE EXCEPTION 'representative artist without release group'; END IF;
  IF EXISTS (
    SELECT 1 FROM ${schema}.style_representative_artist
    WHERE (validation_status = 'cross_verified' AND cardinality(verified_sources) < 2)
       OR (validation_status = 'single_source' AND cardinality(verified_sources) <> 1)
       OR jsonb_array_length(conflict_details) <> 0
  ) THEN RAISE EXCEPTION 'representative validation contract failed'; END IF;
  IF EXISTS (
    SELECT 1 FROM ${schema}.entity_source_assertion assertion
    WHERE (assertion.entity_type = 'artist' AND NOT EXISTS (
      SELECT 1 FROM ${schema}.artist WHERE internal_id = assertion.internal_id
    )) OR (assertion.entity_type = 'release_group' AND NOT EXISTS (
      SELECT 1 FROM ${schema}.release_group WHERE internal_id = assertion.internal_id
    ))
  ) THEN RAISE EXCEPTION 'source assertion points at a missing canonical entity'; END IF;
  IF (SELECT count(*) FROM ${schema}.frontend_projection_context WHERE context_key = 'catalog') <> 1
  THEN RAISE EXCEPTION 'frontend projection context is missing'; END IF;
  IF (SELECT count(*) FROM ${schema}.representative_candidate_review) < 1
     OR EXISTS (
       SELECT 1
       FROM ${schema}.representative_candidate_review review,
         unnest(review.source_snapshot_ids) snapshot_id
       WHERE NOT EXISTS (
         SELECT 1 FROM ${schema}.source_snapshot source
         WHERE source.snapshot_id = snapshot_id
       )
     )
  THEN RAISE EXCEPTION 'representative candidate review audit is incomplete'; END IF;
END
$validation$;
COMMIT;`;
}

function publishSql(schema, payload, immutable) {
  return `BEGIN;
SELECT pg_advisory_xact_lock(hashtext('musicwiki-catalog-publish-v1'));
UPDATE ${schema}.catalog_publication
SET frontend_export_path = ${sqlLiteral(immutable.relativePath)},
    frontend_export_sha256 = ${sqlLiteral(immutable.sha)}
WHERE generation_id = ${sqlLiteral(payload.generation_id)} AND status = 'validated';
UPDATE mw_catalog_control.generation_registry
SET status = 'superseded', superseded_at = now()
WHERE status = 'published' AND generation_id <> ${sqlLiteral(payload.generation_id)};
INSERT INTO mw_catalog_control.generation_registry (
  generation_id, schema_name, source_fingerprint_sha256, status,
  style_count, representative_artist_count, representative_release_group_count,
  cross_verified_count, single_source_count, curated_count, conflicted_count,
  relation_count, frontend_export_path, frontend_export_sha256,
  generated_at, published_at
)
SELECT publication.generation_id, ${sqlLiteral(schema)}::name,
  publication.source_fingerprint_sha256, 'published', publication.style_count,
  publication.representative_artist_count, publication.representative_release_group_count,
  publication.cross_verified_count, publication.single_source_count,
  publication.curated_count, publication.conflicted_count,
  publication.relation_count, ${sqlLiteral(immutable.relativePath)},
  publication.frontend_export_sha256, publication.generated_at, now()
FROM ${schema}.catalog_publication publication;
UPDATE ${schema}.catalog_publication
SET status = 'published', published_at = now(), frontend_export_path = ${sqlLiteral(immutable.relativePath)}
WHERE generation_id = ${sqlLiteral(payload.generation_id)};

CREATE OR REPLACE VIEW mw_catalog_public.catalog_manifest AS
SELECT generation_id, source_fingerprint_sha256, style_count,
  representative_artist_count, representative_release_group_count,
  relation_count, frontend_export_path, frontend_export_sha256,
  generated_at, published_at,
  cross_verified_count, single_source_count, curated_count, conflicted_count
FROM ${schema}.catalog_publication WHERE status = 'published';

CREATE OR REPLACE VIEW mw_catalog_public.style_overview AS
SELECT style.internal_id AS style_id, style.canonical_name, style.description,
  style.origin_date_text, style.region_text, style.source_metadata,
  representative.artist_id, artist.canonical_name AS artist_name,
  representative.selection_basis AS artist_selection_basis,
  representative.asserted_style_id, representative.ancestor_distance,
  release.release_group_id, release_group.canonical_name AS release_group_name,
  release_group.first_release_date_text, release_group.cover_art_url,
  representative.validation_status, representative.verified_sources,
  representative.occurrence_id AS artist_occurrence_id,
  release.occurrence_id AS release_group_occurrence_id
FROM ${schema}.style style
JOIN ${schema}.style_representative_artist representative
  ON representative.style_id = style.internal_id
JOIN ${schema}.artist artist ON artist.internal_id = representative.artist_id
JOIN ${schema}.style_representative_release_group release
  ON release.style_id = style.internal_id AND release.artist_id = representative.artist_id
JOIN ${schema}.release_group release_group
  ON release_group.internal_id = release.release_group_id;

CREATE OR REPLACE VIEW mw_catalog_public.style_relation_graph AS
SELECT relation.relation_id, relation.relation_kind, relation.direction,
  jsonb_agg(DISTINCT jsonb_build_object(
    'style_id', participant.style_id,
    'role', participant.participant_role,
    'ordinal', participant.ordinal
  )) AS participants,
  jsonb_agg(DISTINCT assertion.assertion_id) AS assertion_ids,
  jsonb_agg(DISTINCT evidence.evidence_id) FILTER (WHERE evidence.evidence_id IS NOT NULL)
    AS evidence_ids
FROM ${schema}.style_relation relation
JOIN ${schema}.style_relation_participant participant USING (relation_id)
JOIN ${schema}.style_relation_assertion_v2 assertion USING (relation_id)
LEFT JOIN ${schema}.style_relation_assertion_evidence_v2 link
  ON link.assertion_id = assertion.assertion_id
LEFT JOIN ${schema}.style_relation_evidence evidence ON evidence.evidence_id = link.evidence_id
WHERE assertion.stance = 'supports' AND assertion.review_status = 'accepted'
GROUP BY relation.relation_id, relation.relation_kind, relation.direction;
COMMIT;`;
}

async function publishImmutableFrontend(payload, bytes) {
  const sha = sha256(bytes);
  const relativePath = `data/archive/rock-catalog-v2-static/generations/${payload.generation_id}.json`;
  const path = resolve(repositoryRoot, relativePath);
  await mkdir(dirname(path), { recursive: true });
  try {
    const existing = await readFile(path);
    if (sha256(existing) !== sha) throw new Error(`Immutable generation path has different content: ${path}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await atomicWrite(path, bytes);
  }
  return { path, relativePath, sha };
}

async function exportFrontendFromPostgres(schema) {
  const template = await readFile(frontendExportSqlPath, "utf8");
  if (!template.includes("__SCHEMA__")) {
    throw new Error("Frontend SQL export template is missing its schema placeholder.");
  }
  const raw = await queryText(template.replaceAll("__SCHEMA__", schema));
  if (!raw) throw new Error("PostgreSQL frontend export returned no JSON.");
  return JSON.parse(raw);
}

function validateFrontendExport(frontend, canonical) {
  if (frontend.snapshot_id !== canonical.generation_id || frontend.schema_version !== "1.0") {
    throw new Error("PostgreSQL frontend export does not match the canonical generation.");
  }
  if (frontend.styles?.length !== 828 || frontend.artists?.length !== 828 ||
      frontend.release_groups?.length !== 828) {
    throw new Error("PostgreSQL frontend export failed the 828/828/828 cardinality contract.");
  }
  const artistIds = new Set(frontend.artists.map((artist) => artist.internal_id));
  const releaseArtistIds = new Set(frontend.release_groups.flatMap((release) => release.artist_ids));
  if (artistIds.size !== 828 || releaseArtistIds.size !== 828 ||
      [...artistIds].some((artistId) => !releaseArtistIds.has(artistId))) {
    throw new Error("PostgreSQL frontend export lost a representative artist/release occurrence.");
  }
  const acceptedStatuses = new Set(["cross_verified", "single_source", "curated"]);
  for (const item of [...frontend.artists, ...frontend.release_groups]) {
    if (!acceptedStatuses.has(item.validation_status) || !Array.isArray(item.verified_sources) ||
        item.verified_sources.length === 0) {
      throw new Error(`Frontend entity ${item.internal_id} has invalid source validation metadata.`);
    }
  }
  if (frontend.style_relations_v2?.length !== canonical.style_relations_v2.length) {
    throw new Error("PostgreSQL frontend export relation count differs from the canonical catalog.");
  }
}

async function publishFinalManifest(baseManifest, frontendBytes) {
  const manifest = structuredClone(baseManifest);
  manifest.outputs.frontend = {
    path: "data/published/rock-catalog-v2/frontend-catalog.json",
    bytes: frontendBytes.byteLength,
    sha256: sha256(frontendBytes),
    origin: "postgresql-generation",
  };
  manifest.validation.frontend_export_origin = "postgresql-generation";
  await atomicWrite(manifestPath, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
}

async function publishPointer(payload, immutable) {
  const pointer = {
    pointer_version: "1.0",
    generation_id: payload.generation_id,
    catalog_url: `/data/rock-catalog-v2/generations/${payload.generation_id}.json`,
    catalog_sha256: immutable.sha,
    generated_at: payload.generated_at,
  };
  await atomicWrite(resolve(archiveRoot, "current.json"), Buffer.from(`${JSON.stringify(pointer, null, 2)}\n`));
}

async function atomicWrite(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, bytes, { flag: "wx" });
  await rename(temporary, path);
}

function reportSql(schema) {
  return `SELECT json_build_object(
    'styles', (SELECT count(*) FROM ${schema}.style),
    'canonical_artists', (SELECT count(*) FROM ${schema}.artist),
    'representative_artists', (SELECT count(*) FROM ${schema}.style_representative_artist),
    'canonical_release_groups', (SELECT count(*) FROM ${schema}.release_group),
    'representative_release_groups', (SELECT count(*) FROM ${schema}.style_representative_release_group),
    'style_relations_v2', (SELECT count(*) FROM ${schema}.style_relation),
    'relation_assertions_v2', (SELECT count(*) FROM ${schema}.style_relation_assertion_v2),
    'source_entities', (SELECT count(*) FROM ${schema}.source_entity),
    'source_assertions', (SELECT count(*) FROM ${schema}.entity_source_assertion),
    'candidate_reviews', (SELECT count(*) FROM ${schema}.representative_candidate_review),
    'cross_verified', (SELECT count(*) FROM ${schema}.style_representative_artist WHERE validation_status = 'cross_verified'),
    'single_source', (SELECT count(*) FROM ${schema}.style_representative_artist WHERE validation_status = 'single_source'),
    'curated', (SELECT count(*) FROM ${schema}.style_representative_artist WHERE validation_status = 'curated'),
    'conflicted', 0,
    'fallback_associations', (
      SELECT count(*) FROM ${schema}.style_representative_artist
      WHERE selection_basis = 'wikidata-ancestor-fallback'
    )
  )::text;`;
}

function validateArtifacts(canonical, frontendContextBytes, manifest) {
  if (canonical.schema_version !== "2.0" || canonical.generation_id !== manifest.generation_id) {
    throw new Error("Canonical catalog and manifest generation do not match.");
  }
  if (sha256(frontendContextBytes) !== manifest.outputs.frontend_context.sha256 ||
      sha256(frontendContextBytes) !== canonical.frontend_context_sha256) {
    throw new Error("Frontend projection context failed SHA-256 verification.");
  }
  if (canonical.publication.frontend_export_path !== null ||
      canonical.publication.frontend_export_sha256 !== null) {
    throw new Error("Canonical build must not contain a precomputed frontend export.");
  }
  if (canonical.styles.length !== 828 || canonical.representative_artists.length !== 828 ||
      canonical.representative_release_groups.length !== 828) {
    throw new Error("Canonical catalog failed bounded cardinality validation.");
  }
  for (const collection of [canonical.styles, canonical.artists, canonical.release_groups]) {
    if (collection.some((entity) => !/^[a-f0-9]{64}$/.test(entity.payload_sha256 ?? ""))) {
      throw new Error("Canonical entity is missing its payload SHA-256.");
    }
  }
  if (canonical.representative_validations.some((record) => record.validation_status === "conflicted")) {
    throw new Error("Canonical catalog contains a cross-source conflict.");
  }
}

function generationSchema(generationId) {
  const value = `catalog_${generationId.replace(/^rock-catalog-/, "").replaceAll(/[^a-zA-Z0-9]+/g, "_")}`.toLowerCase();
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new Error("Invalid derived catalog schema name.");
  return value;
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
