import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const runnerPath = "scripts/offline-data/fetch_wikidata_tracked.mjs";
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("Wikidata tracked entity production stage CLI", () => {
  test("streams all entities into an audited atomic stage", async () => {
    const requests: URL[] = [];
    const endpoint = await serve((url) => {
      requests.push(url);
      const qids = url.searchParams.get("ids")?.split("|") ?? [];
      return {
        entities: Object.fromEntries(
          qids.map((qid) => [qid, { id: qid, lastrevid: Number(qid.slice(1)) + 500, labels: {} }]),
        ),
      };
    });
    const fixtureRoot = await mkdtemp(join(tmpdir(), "musicwiki-wikidata-stage-"));
    const qidsPath = join(fixtureRoot, "qids.json");
    const outputDir = join(fixtureRoot, "stage-20260803");
    await writeFile(
      qidsPath,
      `${JSON.stringify([
        ...Array.from({ length: 51 }, (_, index) => `Q${51 - index}`),
        "Q1",
        " q2 ",
      ])}\n`,
      "utf8",
    );

    const { stdout, stderr } = await runCli({ endpoint, qidsPath, outputDir });
    expect(stderr).toBe("");
    const manifest = JSON.parse(stdout);
    const committedManifest = JSON.parse(
      await readFile(join(outputDir, "wikidata-stage-manifest.json"), "utf8"),
    );
    const entityBytes = await readFile(join(outputDir, "entities.jsonl"));
    const entities = entityBytes
      .toString("utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(committedManifest).toEqual(manifest);
    expect(manifest).toMatchObject({
      manifest_version: "1.0",
      snapshot_id: "20260803T110000Z",
      generated_at: "2026-08-03T11:00:00.000Z",
      mode: "tracked-qid-api-stage",
      license_partition: "wikidata-cc0",
      full_wikidata_dump_downloaded: false,
      cursor_advanced: false,
      counts: {
        tracked_qids: 51,
        batches: 2,
        entities: 51,
        entities_with_revision: 51,
        network_requests_executed: 2,
        retries: 0,
      },
      output: {
        relative_path: "entities.jsonl",
        bytes: entityBytes.byteLength,
        sha256: sha256(entityBytes),
      },
    });
    expect(entities.map((entity) => entity.qid)).toEqual(
      Array.from({ length: 51 }, (_, index) => `Q${index + 1}`),
    );
    expect(entities.every((entity) => entity.revision_id > 0 && entity.payload.id === entity.qid))
      .toBe(true);
    expect(requests.map((url) => url.searchParams.get("ids")?.split("|").length)).toEqual([50, 1]);
    expect((await stat(outputDir)).isDirectory()).toBe(true);
    expect((await readdir(fixtureRoot)).filter((name) => name.startsWith(".wikidata-stage-")))
      .toEqual([]);
  });

  test("unions the reviewed Rock style scope and preserves its canonical metadata", async () => {
    const endpoint = await serve((url) => {
      const qids = url.searchParams.get("ids")?.split("|") ?? [];
      return {
        entities: Object.fromEntries(qids.map((qid) => [qid, {
          id: qid,
          lastrevid: Number(qid.slice(1)) + 100,
          labels: {},
          claims: {},
        }])),
      };
    });
    const fixtureRoot = await mkdtemp(join(tmpdir(), "musicwiki-wikidata-rock-scope-"));
    const qidsPath = join(fixtureRoot, "qids.json");
    const catalogPath = join(fixtureRoot, "rock-styles.json");
    const outputDir = join(fixtureRoot, "stage");
    await writeFile(qidsPath, '["Q1"]\n');
    await writeFile(catalogPath, `${JSON.stringify({
      schema_version: "1.0",
      snapshot_id: "wikidata-rock-styles-fixture",
      license: "CC0-1.0",
      source: { root_qid: "Q11399" },
      styles: [
        { qid: "Q1", label: "Fixture Rock", description: "fixture", parent_qids: ["Q11399"], country_labels: [], origin_date: null, source_revision_id: "101" },
        { qid: "Q11399", label: "Rock music", description: "root", parent_qids: [], country_labels: [], origin_date: null, source_revision_id: "11499" },
      ],
    })}\n`);

    const { stdout } = await runCli({ endpoint, qidsPath, outputDir, rockStyleCatalog: catalogPath });
    const manifest = JSON.parse(stdout);
    const entities = (await readFile(join(outputDir, "entities.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    expect(manifest.counts).toMatchObject({ tracked_qids: 2, rock_style_qids: 2 });
    expect(manifest.rock_style_scope).toMatchObject({
      snapshot_id: "wikidata-rock-styles-fixture",
      root_qid: "Q11399",
      qid_count: 2,
    });
    expect(entities).toEqual(expect.arrayContaining([
      expect.objectContaining({
        qid: "Q1",
        roles: ["rock-style"],
        rock_style: expect.objectContaining({ label: "Fixture Rock", parent_qids: ["Q11399"] }),
      }),
      expect.objectContaining({ qid: "Q11399", roles: ["rock-style"] }),
    ]));
  });

  test.each([
    {
      label: "missing revision",
      maxBatchBytes: 100_000,
      response: (qid: string) => ({ entities: { [qid]: { id: qid, labels: {} } } }),
      expected: "lastrevid",
    },
    {
      label: "oversized batch",
      maxBatchBytes: 10,
      response: (qid: string) => ({ entities: { [qid]: { id: qid, lastrevid: 1 } } }),
      expected: "byte budget",
    },
  ])("leaves no final or temporary stage after $label", async ({ maxBatchBytes, response, expected }) => {
    const endpoint = await serve((url) => response(url.searchParams.get("ids") ?? "Q1"));
    const fixtureRoot = await mkdtemp(join(tmpdir(), "musicwiki-wikidata-stage-fail-"));
    const qidsPath = join(fixtureRoot, "qids.json");
    const outputDir = join(fixtureRoot, "failed-stage");
    await writeFile(qidsPath, '["Q1"]\n', "utf8");

    await expect(runCli({ endpoint, qidsPath, outputDir, maxBatchBytes })).rejects.toMatchObject({
      stderr: expect.stringContaining(expected),
    });
    await expect(stat(outputDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(fixtureRoot)).filter((name) => name.startsWith(".wikidata-stage-")))
      .toEqual([]);
  });

  test("rejects relative or pre-existing output directories before network access", async () => {
    let requestCount = 0;
    const endpoint = await serve(() => {
      requestCount += 1;
      return { entities: {} };
    });
    const fixtureRoot = await mkdtemp(join(tmpdir(), "musicwiki-wikidata-stage-path-"));
    const qidsPath = join(fixtureRoot, "qids.json");
    const outputDir = join(fixtureRoot, "existing-stage");
    await writeFile(qidsPath, '["Q1"]\n', "utf8");
    await writeFile(outputDir, "occupied", "utf8");

    await expect(runCli({ endpoint, qidsPath, outputDir })).rejects.toMatchObject({
      stderr: expect.stringContaining("must not already exist"),
    });
    await expect(
      execFileAsync("node", [
        runnerPath,
        "--tracked-qids",
        qidsPath,
        "--output-dir",
        "relative-stage",
        "--snapshot",
        "20260803T110000Z",
        "--contact",
        "test@example.com",
      ]),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("absolute") });
    expect(requestCount).toBe(0);
  });

  test("package exposes the production Wikidata stage command", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8"));
    expect(packageJson.scripts["data:stage:wikidata"]).toBe(
      "node scripts/offline-data/fetch_wikidata_tracked.mjs",
    );
  });
});

async function runCli(options: {
  endpoint: string;
  qidsPath: string;
  outputDir: string;
  maxBatchBytes?: number;
  rockStyleCatalog?: string;
}) {
  return execFileAsync("node", [
    runnerPath,
    "--tracked-qids",
    options.qidsPath,
    ...(options.rockStyleCatalog ? ["--rock-style-catalog", options.rockStyleCatalog] : []),
    "--output-dir",
    options.outputDir,
    "--snapshot",
    "20260803T110000Z",
    "--endpoint",
    options.endpoint,
    "--contact",
    "test@example.com",
    "--generated-at",
    "2026-08-03T11:00:00.000Z",
    "--max-batch-bytes",
    String(options.maxBatchBytes ?? 100_000),
    "--max-attempts",
    "2",
    "--timeout-ms",
    "5000",
  ]);
}

async function serve(payload: (url: URL) => unknown): Promise<string> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const body = JSON.stringify(payload(url));
    response.writeHead(200, {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body)),
    });
    response.end(body);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server has no TCP address");
  return `http://127.0.0.1:${address.port}/w/api.php`;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
