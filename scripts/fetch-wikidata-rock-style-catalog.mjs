import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const WIKIDATA_QUERY_ENDPOINT = "https://query.wikidata.org/sparql";
const ROOT_STYLE_QID = "Q11399";
const TARGET_STYLE_COUNT = 828;
const OUTPUT_URL = new URL(
  "../data/sources/global-style-mock-v1/wikidata-rock-styles.json",
  import.meta.url,
);
const USER_AGENT = "RockAtlasStyleCatalog/1.0 (local open-data fixture builder)";
const MUSIC_GENRE_QID = "Q188451";
const MUSICAL_SCENE_QID = "Q28820001";
const MUSICAL_MOVEMENT_QID = "Q12020884";

const query = `SELECT ?genre ?genreLabel ?genreDescription
       (GROUP_CONCAT(DISTINCT STRAFTER(STR(?parent), "/entity/"); separator="|") AS ?parentQids)
       (GROUP_CONCAT(DISTINCT STRAFTER(STR(?instance), "/entity/"); separator="|") AS ?instanceQids)
       (GROUP_CONCAT(DISTINCT STRAFTER(STR(?country), "/entity/"); separator="|") AS ?countryQids)
       (GROUP_CONCAT(DISTINCT ?countryLabel; separator=" | ") AS ?countries)
       (MIN(?start) AS ?earliestDate)
       (MAX(?revision) AS ?sourceRevision)
WHERE {
  ?genre wdt:P279* wd:${ROOT_STYLE_QID} .
  ?genre schema:version ?revision .
  OPTIONAL { ?genre wdt:P279 ?parent . }
  OPTIONAL { ?genre wdt:P31 ?instance . }
  OPTIONAL { ?genre wdt:P495 ?country . }
  OPTIONAL { ?genre wdt:P571|wdt:P580 ?start . }
  SERVICE wikibase:label {
    bd:serviceParam wikibase:language "en,mul,sv".
    ?genre rdfs:label ?genreLabel.
    ?genre schema:description ?genreDescription.
    ?country rdfs:label ?countryLabel.
  }
}
GROUP BY ?genre ?genreLabel ?genreDescription
ORDER BY ?genre`;

const response = await fetch(`${WIKIDATA_QUERY_ENDPOINT}?${new URLSearchParams({
  query,
  format: "json",
})}`, {
  headers: {
    accept: "application/sparql-results+json",
    "user-agent": USER_AGENT,
  },
});
if (!response.ok) throw new Error(`Wikidata Query Service returned ${response.status}.`);

const result = await response.json();
const candidates = result.results.bindings.map((binding) => ({
  qid: entityId(binding.genre.value),
  label: binding.genreLabel?.value ?? entityId(binding.genre.value),
  description: binding.genreDescription?.value ?? "",
  parent_qids: splitIds(binding.parentQids?.value),
  instance_of_qids: splitIds(binding.instanceQids?.value),
  country_qids: splitIds(binding.countryQids?.value),
  country_labels: splitText(binding.countries?.value, " | "),
  origin_date: binding.earliestDate?.value ?? null,
  source_revision_id: binding.sourceRevision?.value ?? null,
}));
if (candidates.length < TARGET_STYLE_COUNT) {
  throw new Error(`Expected at least ${TARGET_STYLE_COUNT} items in the current ${ROOT_STYLE_QID} closure, got ${candidates.length}.`);
}

const enriched = candidates.map((candidate) => {
  return {
    ...candidate,
    selection_score: selectionScore(candidate, candidate.label, candidate.description),
  };
});

const ranked = [...enriched].sort((left, right) =>
  right.selection_score - left.selection_score ||
  left.label.localeCompare(right.label, "en") ||
  numericQid(left.qid) - numericQid(right.qid)
);
const selectedQids = new Set(ranked.slice(0, TARGET_STYLE_COUNT).map((style) => style.qid));
if (!selectedQids.has(ROOT_STYLE_QID)) throw new Error("Rock music root was excluded unexpectedly.");

const styles = enriched
  .filter((style) => selectedQids.has(style.qid))
  .sort((left, right) => left.label.localeCompare(right.label, "en") || numericQid(left.qid) - numericQid(right.qid))
  .map(({ selection_score: _score, ...style }) => style);
const excluded = enriched
  .filter((style) => !selectedQids.has(style.qid))
  .sort((left, right) => right.selection_score - left.selection_score || numericQid(left.qid) - numericQid(right.qid))
  .map((style) => ({
    qid: style.qid,
    label: style.label,
    description: style.description,
    parent_qids: style.parent_qids,
    instance_of_qids: style.instance_of_qids,
    country_qids: style.country_qids,
    country_labels: style.country_labels,
    origin_date: style.origin_date,
    source_revision_id: style.source_revision_id,
    selection_score: style.selection_score,
    reason: "Below the deterministic metadata-quality cutoff for the 828-style UI fixture.",
  }));

const payload = {
  schema_version: "1.0",
  snapshot_id: `wikidata-rock-styles-${new Date().toISOString().slice(0, 10)}`,
  retrieved_at: new Date().toISOString(),
  license: "CC0-1.0",
  source: {
    dataset: "Wikidata",
    root_qid: ROOT_STYLE_QID,
    query_endpoint: WIKIDATA_QUERY_ENDPOINT,
    entity_endpoint_template: "https://www.wikidata.org/wiki/Special:EntityData/{QID}.json",
    query,
    query_sha256: createHash("sha256").update(query).digest("hex"),
    candidate_count: candidates.length,
    selected_count: styles.length,
    excluded_count: excluded.length,
  },
  selection_policy: {
    target_count: TARGET_STYLE_COUNT,
    statement: "Keep the 828 highest-quality real entities in the current Q11399 subclass closure; never synthesize a style identity.",
    ranking: [
      "instance of music genre (Q188451)",
      "instance of musical scene (Q28820001) or musical movement (Q12020884)",
      "genre-like description, usable label, description, origin metadata, then stable label/QID tie-break",
    ],
  },
  excluded,
  styles,
};

await mkdir(new URL(".", OUTPUT_URL), { recursive: true });
await writeFile(OUTPUT_URL, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
console.log(`Wrote ${styles.length} real Wikidata styles to ${fileURLToPath(OUTPUT_URL)}.`);

function selectionScore(candidate, label, description) {
  const lowerDescription = description.toLowerCase();
  let score = 0;
  if (candidate.instance_of_qids.includes(MUSIC_GENRE_QID)) score += 10_000;
  if (candidate.instance_of_qids.includes(MUSICAL_SCENE_QID)) score += 1_000;
  if (candidate.instance_of_qids.includes(MUSICAL_MOVEMENT_QID)) score += 900;
  if (/\b(?:music genre|subgenre|form of|rock movement|genre of music)\b/.test(lowerDescription)) {
    score += 800;
  }
  if (!/^Q\d+$/.test(label)) score += 100;
  if (description) score += 20;
  if (candidate.origin_date) score += 10;
  score += Math.min(9, candidate.parent_qids.length);
  return score;
}

function splitIds(value = "") {
  return [...new Set(value.split("|").filter((id) => /^Q\d+$/.test(id)))].sort(
    (left, right) => numericQid(left) - numericQid(right),
  );
}

function splitText(value = "", separator) {
  return [...new Set(value.split(separator).map((entry) => entry.trim()).filter(Boolean))];
}

function entityId(url) {
  const qid = url.split("/").at(-1);
  if (!qid || !/^Q\d+$/.test(qid)) throw new Error(`Invalid Wikidata entity URL: ${url}`);
  return qid;
}

function numericQid(qid) {
  return Number(qid.slice(1));
}
