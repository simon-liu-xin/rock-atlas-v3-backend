import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const runnerPath = "scripts/offline-data/project_offline_canonical.mjs";

describe("offline canonical production projector", () => {
  test("defines a generation-scoped three-source projection without fuzzy identity joins", async () => {
    const sql = await readFile("database/offline-canonical-project-v1.sql", "utf8");

    for (const placeholder of ["__CANONICAL_SCHEMA__", "__MUSICBRAINZ_SCHEMA__"]) {
      expect(sql).toContain(placeholder);
    }
    for (const stage of [
      "stage_discogs_artist",
      "stage_discogs_release",
      "stage_discogs_master",
      "stage_discogs_style",
      "stage_wikidata_entity",
    ]) {
      expect(sql).toContain(stage);
    }
    expect(sql).toContain("stage_artist_crosswalk");
    expect(sql).toContain("qualifies_rock");
    expect(sql).toContain("selected_mb_release_group");
    expect(sql).toContain("selected_mb_release");
    expect(sql).toContain("discogs-fallback");
    expect(sql).toContain("identity_conflict_queue");
    expect(sql).toContain("co_tagged_with");
    expect(sql).toContain("subgenre_of");
    expect(sql).toContain("influenced_by");
    expect(sql).not.toMatch(/levenshtein|similarity\s*\(|fuzzystrmatch/i);
    expect(sql).not.toContain("mw_offline");
  });

  test("package exposes the canonical production projection command", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8"));
    expect(packageJson.scripts["data:project:canonical"]).toBe(
      "node scripts/offline-data/project_offline_canonical.mjs",
    );
  });

  test("verifies all stages, executes the isolated projection and atomically publishes its audit", async () => {
    const fixture = await createFixture();
    const execution = await runCli(fixture);
    const manifest = JSON.parse(execution.stdout);
    const committed = JSON.parse(
      await readFile(join(fixture.outputDir, "canonical-project-manifest.json"), "utf8"),
    );
    const calls = await readPsqlCalls(fixture.logPath);

    expect(execution.stderr).toBe("");
    expect(committed).toEqual(manifest);
    expect(manifest).toMatchObject({
      manifest_version: "1.0",
      generated_at: "2026-08-03T13:00:00.000Z",
      mode: "offline-canonical-postgres-project",
      network_requests_executed: 0,
      archives_downloaded_this_run: false,
      generation_id: "mb-20260801-002250__discogs-20260801",
      canonical_schema: "canon_mb_20260801_002250__discogs_20260801",
      database: "musicwiki_stage_test",
      projection_audit_passed: true,
      metrics: fixture.audit,
      completeness: { operationally_complete: false },
    });
    expect(manifest.inputs.discogs.files.artists.lines).toBe(2);
    expect(manifest.inputs.wikidata.entities.lines).toBe(1);
    expect(calls.filter((args) => args.includes("-f"))).toHaveLength(2);
    expect(calls.some((args) => args.join(" ").includes("DROP SCHEMA"))).toBe(false);
    expect((await readdir(fixture.root)).filter((name) => name.startsWith(".canonical-project-")))
      .toEqual([]);
  });

  test("rejects tampered Discogs and Wikidata artifacts before touching PostgreSQL", async () => {
    const discogsFixture = await createFixture();
    await writeFile(join(discogsFixture.discogsStage, "artists.jsonl.gz"), "tampered", "utf8");
    await expect(runCli(discogsFixture)).rejects.toMatchObject({
      stderr: expect.stringContaining("Discogs artists"),
    });
    expect(await readPsqlCalls(discogsFixture.logPath)).toEqual([]);

    const wikidataFixture = await createFixture();
    await writeFile(join(wikidataFixture.wikidataStage, "entities.jsonl"), "{}\n", "utf8");
    await expect(runCli(wikidataFixture)).rejects.toMatchObject({
      stderr: expect.stringContaining("Wikidata entities"),
    });
    expect(await readPsqlCalls(wikidataFixture.logPath)).toEqual([]);
  });

  test("rejects a mismatched MusicBrainz database stage before schema creation", async () => {
    const fixture = await createFixture();
    await expect(
      runCli(fixture, { MUSICWIKI_FAKE_MB_STAGE_MISMATCH: "1" }),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("MusicBrainz PostgreSQL stage") });
    const calls = await readPsqlCalls(fixture.logPath);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.join(" ")).toContain("musicwiki_stage_meta");
    expect(calls.some((args) => args.includes("-f"))).toBe(false);
  });

  test("drops only its generation schema and removes temporary output on projection failure", async () => {
    const fixture = await createFixture();
    await expect(runCli(fixture, { MUSICWIKI_FAKE_PROJECT_FAIL: "1" })).rejects.toMatchObject({
      stderr: expect.stringContaining("psql"),
    });
    const calls = await readPsqlCalls(fixture.logPath);
    expect(calls.some((args) => args.join(" ").includes(
      "DROP SCHEMA canon_mb_20260801_002250__discogs_20260801 CASCADE",
    ))).toBe(true);
    await expect(stat(fixture.outputDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(fixture.root)).filter((name) => name.startsWith(".canonical-project-")))
      .toEqual([]);
  });

  test("refuses occupied output directories or canonical schemas without mutation", async () => {
    const outputFixture = await createFixture();
    await writeFile(outputFixture.outputDir, "occupied", "utf8");
    await expect(runCli(outputFixture)).rejects.toMatchObject({
      stderr: expect.stringContaining("must not already exist"),
    });
    expect(await readPsqlCalls(outputFixture.logPath)).toEqual([]);

    const schemaFixture = await createFixture();
    await expect(runCli(schemaFixture, { MUSICWIKI_FAKE_SCHEMA_EXISTS: "1" }))
      .rejects.toMatchObject({ stderr: expect.stringContaining("already exists") });
    const calls = await readPsqlCalls(schemaFixture.logPath);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.join(" ")).toContain("to_regnamespace");
    expect(calls.some((args) => args.join(" ").includes("DROP SCHEMA"))).toBe(false);
  });
});

interface Fixture {
  root: string;
  musicbrainzStage: string;
  discogsStage: string;
  wikidataStage: string;
  outputDir: string;
  psqlPath: string;
  logPath: string;
  audit: Record<string, number>;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "musicwiki-canonical-project-"));
  const musicbrainzStage = join(root, "musicbrainz");
  const discogsStage = join(root, "discogs");
  const wikidataStage = join(root, "wikidata");
  await Promise.all([
    mkdir(musicbrainzStage), mkdir(discogsStage), mkdir(wikidataStage),
  ]);
  const mbDigest = "a".repeat(64);
  await writeJson(join(musicbrainzStage, "musicbrainz-stage-manifest.json"), {
    manifest_version: "1.0",
    generated_at: "2026-08-03T12:00:00.000Z",
    mode: "musicbrainz-core-postgres-stage",
    network_requests_executed: 0,
    archive_downloaded_this_run: false,
    license_partition: "musicbrainz-core-cc0",
    snapshot_id: "20260801-002250",
    schema_sequence: 31,
    stage_schema: "raw_mb_20260801_002250",
    database: "musicwiki_stage_test",
    source: {
      archive_filename: "mbdump.tar.bz2",
      archive_bytes: 123,
      archive_sha256: mbDigest,
      timestamp: "2026-08-01T00:22:50Z",
    },
    counts: { selected_members: 26, selected_tables: 24, imported_tables: 24, extracted_bytes: 456 },
    row_counts: Object.fromEntries([
      "artist", "artist_type", "artist_credit", "artist_credit_name", "release_group",
      "release_group_primary_type", "release_group_secondary_type",
      "release_group_secondary_type_join", "release", "release_status", "release_packaging",
      "release_country", "release_unknown_country", "iso_3166_1", "medium", "medium_format",
      "track", "recording", "url", "link", "link_type", "l_artist_url",
      "l_release_group_url", "l_release_url",
    ].map((table) => [table, 1])),
    indexes: {
      template: "database/musicbrainz-stage-v31-indexes.sql",
      rendered_relative_path: "stage-indexes.sql",
      bytes: 123,
      sha256: "b".repeat(64),
    },
  });

  const discogsRows = {
    artists: [
      { external_id: "10", name: "Mapped Rock", qualifies_rock: true, aliases: [], name_variations: [], urls: [] },
      { external_id: "20", name: "Fallback Rock", qualifies_rock: true, aliases: [], name_variations: [], urls: [] },
    ],
    releases: [
      { external_id: "101", title: "Studio", artists: [{ external_id: "10", name: "Mapped Rock" }], genres: ["Rock"], styles: ["Grunge", "Alternative Rock"], formats: [{ name: "Album" }], master_external_id: "501", released: "1991", country: "US" },
      { external_id: "102", title: "Fallback Live", artists: [{ external_id: "20", name: "Fallback Rock" }], genres: ["Rock"], styles: ["Grunge"], formats: [{ name: "Album" }], master_external_id: "502", released: "1992", country: "US" },
    ],
    masters: [
      { external_id: "501", title: "Studio", artists: [{ external_id: "10", name: "Mapped Rock" }], year: "1991" },
      { external_id: "502", title: "Fallback Live", artists: [{ external_id: "20", name: "Fallback Rock" }], year: "1992" },
    ],
    labels: [],
    style_evidence: [
      { style: "Grunge", classification: "accepted", rock_only_release_count: 2, mixed_rock_release_count: 0 },
      { style: "Alternative Rock", classification: "accepted", rock_only_release_count: 1, mixed_rock_release_count: 0 },
    ],
  };
  const outputs: Record<string, { path: string; bytes: number; sha256: string }> = {};
  for (const [kind, rows] of Object.entries(discogsRows)) {
    const filename = `${kind.replace("style_evidence", "style-evidence")}.jsonl.gz`;
    const bytes = gzipSync(rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""));
    await writeFile(join(discogsStage, filename), bytes);
    outputs[kind] = { path: filename, bytes: bytes.byteLength, sha256: sha256(bytes) };
  }
  await writeJson(join(discogsStage, "discogs-stage-manifest.json"), {
    manifest_version: "1.0",
    generated_at: "2026-08-03T12:05:00.000Z",
    source: "discogs",
    snapshot: "20260801",
    input_scope: "fixture",
    input_verification: { status: "fixture-unverified", algorithm: null, files: {} },
    counts: {
      releases_scanned_per_pass: 2, release_elements_read: 4, rock_seed_releases: 2,
      qualifying_artists: 2, selected_releases: 2, referenced_artists: 2,
      selected_masters: 2, selected_labels: 0, accepted_styles: 2, candidate_styles: 0,
    },
    reference_audit: { missing_artists: 0, missing_masters: 0, missing_labels: 0 },
    completeness_evidence: { qualifying_catalog_owner_misses: 0, unclassified_rock_styles: 0 },
    outputs,
  });

  const wikidataEntity = {
    qid: "Q11399", revision_id: 1,
    roles: ["rock-style"],
    rock_style: {
      qid: "Q11399", label: "Rock music", description: "root",
      parent_qids: [], country_labels: [], origin_date: null, source_revision_id: "1",
    },
    payload: { id: "Q11399", lastrevid: 1, claims: {} },
  };
  const wikidataBytes = Buffer.from(`${JSON.stringify(wikidataEntity)}\n`);
  await writeFile(join(wikidataStage, "entities.jsonl"), wikidataBytes);
  await writeJson(join(wikidataStage, "wikidata-stage-manifest.json"), {
    manifest_version: "1.0", snapshot_id: "tracked-20260803",
    generated_at: "2026-08-03T12:10:00.000Z", mode: "tracked-qid-api-stage",
    license_partition: "wikidata-cc0", full_wikidata_dump_downloaded: false,
    cursor_advanced: false,
    source: { endpoint: "https://www.wikidata.org/w/api.php", user_agent: "MusicWiki/0.1", batch_size: 50 },
    counts: { tracked_qids: 1, rock_style_qids: 1, batches: 1, entities: 1, entities_with_revision: 1, network_requests_executed: 1, retries: 0, network_bytes_downloaded: 100 },
    rock_style_scope: {
      snapshot_id: "fixture", root_qid: "Q11399", license: "CC0-1.0", qid_count: 1,
      qid_set_sha256: "c".repeat(64), catalog_bytes: 123, catalog_sha256: "d".repeat(64),
    },
    output: { relative_path: "entities.jsonl", bytes: wikidataBytes.byteLength, sha256: sha256(wikidataBytes) },
  });

  const audit = {
    styles: 3, published_styles: 3, wikidata_rock_styles: 1, discogs_only_styles: 2,
    discogs_style_identities: 2, style_relations: 2, published_relations: 2,
    qualifying_artists: 2, artists: 3,
    mapped_musicbrainz_artists: 2, fallback_discogs_artists: 1,
    release_groups: 3, studio_release_groups: 1, live_release_groups: 1,
    releases: 4, media: 4, recordings: 2, tracks: 2,
    identity_evidence: 2, accounted_identity_evidence: 2,
    identity_components: 2, identity_conflicts: 1, unquarantined_conflicts: 0,
    missing_artist_references: 0, missing_release_group_references: 0,
    missing_medium_references: 0, missing_track_references: 0,
  };
  const logPath = join(root, "psql-calls.jsonl");
  const psqlPath = join(root, "fake-psql.mjs");
  await writeFile(psqlPath, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.MUSICWIKI_FAKE_PSQL_LOG, JSON.stringify(args) + "\\n");
const command = args.join(" ");
if (command.includes("musicwiki_stage_meta")) {
  const value = process.env.MUSICWIKI_FAKE_MB_STAGE_MISMATCH === "1"
    ? { snapshot_id: "wrong", schema_sequence: 31, source_archive_sha256: "${mbDigest}", canonical_index_count: 37 }
    : { snapshot_id: "20260801-002250", schema_sequence: 31, source_archive_sha256: "${mbDigest}", canonical_index_count: 37 };
  process.stdout.write(JSON.stringify(value) + "\\n");
  process.exit(0);
}
if (command.includes("to_regnamespace")) {
  if (process.env.MUSICWIKI_FAKE_SCHEMA_EXISTS === "1") process.stdout.write("occupied\\n");
  process.exit(0);
}
if (process.env.MUSICWIKI_FAKE_PROJECT_FAIL === "1" && command.includes("canonical-project.sql")) {
  process.stderr.write("forced psql projection failure\\n");
  process.exit(7);
}
if (command.includes("canonical-project.sql")) process.stdout.write(JSON.stringify(${JSON.stringify(audit)}) + "\\n");
`, "utf8");
  await chmod(psqlPath, 0o700);
  return {
    root, musicbrainzStage, discogsStage, wikidataStage,
    outputDir: join(root, "canonical"), psqlPath, logPath, audit,
  };
}

async function runCli(fixture: Fixture, environment: Record<string, string> = {}) {
  return execFileAsync("node", [
    runnerPath,
    "--musicbrainz-stage", fixture.musicbrainzStage,
    "--discogs-stage", fixture.discogsStage,
    "--wikidata-stage", fixture.wikidataStage,
    "--generation", "mb-20260801-002250__discogs-20260801",
    "--output-dir", fixture.outputDir,
    "--psql-command", fixture.psqlPath,
    "--generated-at", "2026-08-03T13:00:00.000Z",
  ], {
    env: { ...process.env, MUSICWIKI_FAKE_PSQL_LOG: fixture.logPath, ...environment },
  });
}

async function readPsqlCalls(path: string): Promise<string[][]> {
  const content = await readFile(path, "utf8").catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  });
  return content.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
