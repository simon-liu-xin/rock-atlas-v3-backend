import { readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";

import { parseReviewedRockStyleCatalog } from "../../src/data/wikidata-rock-style-scope.ts";

describe("reviewed Wikidata Rock style scope", () => {
  test("accepts the current 828-style real-data snapshot as a complete input scope", async () => {
    const value = JSON.parse(await readFile(
      "data/sources/global-style-mock-v1/wikidata-rock-styles.json",
      "utf8",
    ));
    const catalog = parseReviewedRockStyleCatalog(value);
    expect(catalog.styles).toHaveLength(828);
    expect(new Set(catalog.styles.map((style) => style.qid)).size).toBe(828);
    expect(catalog.styles.some((style) => style.qid === "Q11399")).toBe(true);
  });

  test("rejects duplicate identities and scopes without the Rock root", () => {
    const style = {
      qid: "Q1",
      label: "Fixture",
      description: "fixture",
      parent_qids: [],
      country_labels: [],
      origin_date: null,
      source_revision_id: null,
    };
    const catalog = {
      schema_version: "1.0",
      snapshot_id: "fixture",
      license: "CC0-1.0",
      source: { root_qid: "Q11399" },
      styles: [style, style],
    };
    expect(() => parseReviewedRockStyleCatalog(catalog)).toThrow(/duplicate/iu);
    expect(() => parseReviewedRockStyleCatalog({ ...catalog, styles: [style] })).toThrow(/Q11399/iu);
  });
});
