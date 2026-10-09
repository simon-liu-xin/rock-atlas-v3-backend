import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const styleCatalogPath = resolve(
  repositoryRoot,
  "data/sources/global-style-mock-v1/wikidata-rock-styles.json",
);
const outputDirectory = resolve(repositoryRoot, "data/sources/rock-catalog-v2");
const batchDirectory = resolve(outputDirectory, "representative-batches");
const outputPath = resolve(outputDirectory, "wikidata-representatives.json");
const endpoint = "https://query.wikidata.org/sparql";
const userAgent = "RockAtlasCatalog/2.0 (bounded open-data catalog builder)";
const batchSize = Number(process.env.MUSICWIKI_WIKIDATA_BATCH_SIZE ?? 80);
const maxAttempts = 5;

if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100) {
  throw new Error("MUSICWIKI_WIKIDATA_BATCH_SIZE must be an integer between 1 and 100.");
}

const styleCatalogBytes = await readFile(styleCatalogPath);
const styleCatalogSha256 = sha256(styleCatalogBytes);
const styleCatalog = JSON.parse(styleCatalogBytes);
const candidates = [...styleCatalog.styles, ...styleCatalog.excluded]
  .sort((left, right) => numericQid(left.qid) - numericQid(right.qid));
if (new Set(candidates.map((style) => style.qid)).size !== candidates.length) {
  throw new Error("Style catalog contains duplicate Wikidata QIDs.");
}

await mkdir(batchDirectory, { recursive: true });
const batches = chunk(candidates, batchSize);
const batchRecords = [];
let networkRequests = 0;
let retries = 0;

for (let index = 0; index < batches.length; index += 1) {
  const styles = batches[index];
  const query = representativeQuery(styles.map((style) => style.qid));
  const querySha256 = sha256(query);
  const batchPath = resolve(batchDirectory, `${String(index + 1).padStart(3, "0")}.json`);
  const cached = await readCachedBatch(batchPath, querySha256, styleCatalogSha256);
  if (cached) {
    batchRecords.push(...cached.records);
    continue;
  }

  const startedAt = new Date().toISOString();
  const result = await fetchBatch(query, () => {
    networkRequests += 1;
  }, () => {
    retries += 1;
  });
  const records = normalizeBindings(result.results.bindings, styles.map((style) => style.qid));
  const payload = {
    schema_version: "1.0",
    batch_index: index + 1,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    query_sha256: querySha256,
    style_catalog_sha256: styleCatalogSha256,
    style_qids: styles.map((style) => style.qid),
    records,
  };
  await atomicWriteJson(batchPath, payload);
  batchRecords.push(...records);
}

const directByStyle = new Map();
for (const record of batchRecords) {
  const current = directByStyle.get(record.style_qid);
  if (!current || compareRepresentative(record, current) < 0) {
    directByStyle.set(record.style_qid, record);
  }
}

const payload = {
  schema_version: "1.0",
  snapshot_id: `wikidata-rock-representatives-${new Date().toISOString().slice(0, 10)}`,
  retrieved_at: new Date().toISOString(),
  license: "CC0-1.0",
  source: {
    dataset: "Wikidata",
    query_endpoint: endpoint,
    style_snapshot_id: styleCatalog.snapshot_id,
    style_snapshot_sha256: styleCatalogSha256,
    selection_statement:
      "For each style with direct coverage, select the most-sitelinked artist that explicitly declares the style and has an album; then select that artist's most-sitelinked album.",
    batch_size: batchSize,
    batch_count: batches.length,
    network_requests: networkRequests,
    retries,
  },
  coverage: {
    candidate_styles: candidates.length,
    styles_with_direct_artist_album: directByStyle.size,
    styles_without_direct_artist_album: candidates.length - directByStyle.size,
  },
  representatives: [...directByStyle.values()].sort(
    (left, right) => numericQid(left.style_qid) - numericQid(right.style_qid),
  ),
};
await atomicWriteJson(outputPath, payload);
console.log(JSON.stringify({ output: outputPath, ...payload.coverage }, null, 2));

function representativeQuery(qids) {
  const values = qids.map((qid) => `wd:${qid}`).join(" ");
  return `SELECT ?genre ?artist ?artistLabel ?artistLinks ?artistMbid ?artistDiscogsId ?artistRevision
       ?album ?albumLabel ?albumLinks ?albumMbid ?albumDiscogsMasterId ?albumRevision
       (MIN(?date) AS ?firstRelease)
WHERE {
  {
    SELECT ?genre (MAX(?candidateLinks) AS ?artistLinks) WHERE {
      VALUES ?genre { ${values} }
      ?candidate wdt:P136 ?genre ; wikibase:sitelinks ?candidateLinks .
      { ?candidate wdt:P31/wdt:P279* wd:Q215380 . }
      UNION
      { ?candidate wdt:P31 wd:Q5 . }
      FILTER EXISTS {
        ?candidateAlbum wdt:P175 ?candidate ; wdt:P31/wdt:P279* wd:Q482994 .
      }
    }
    GROUP BY ?genre
  }
  ?artist wdt:P136 ?genre ;
          wikibase:sitelinks ?artistLinks ;
          schema:version ?artistRevision .
  { ?artist wdt:P31/wdt:P279* wd:Q215380 . }
  UNION
  { ?artist wdt:P31 wd:Q5 . }
  OPTIONAL { ?artist wdt:P434 ?artistMbid . }
  OPTIONAL { ?artist wdt:P1953 ?artistDiscogsId . }
  {
    SELECT ?artist (MAX(?candidateAlbumLinks) AS ?albumLinks) WHERE {
      ?candidateAlbum wdt:P175 ?artist ;
                      wdt:P31/wdt:P279* wd:Q482994 ;
                      wikibase:sitelinks ?candidateAlbumLinks .
    }
    GROUP BY ?artist
  }
  ?album wdt:P175 ?artist ;
         wdt:P31/wdt:P279* wd:Q482994 ;
         wikibase:sitelinks ?albumLinks ;
         schema:version ?albumRevision .
  OPTIONAL { ?album wdt:P436 ?albumMbid . }
  OPTIONAL { ?album wdt:P1954 ?albumDiscogsMasterId . }
  OPTIONAL { ?album wdt:P577 ?date . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul". }
}
GROUP BY ?genre ?artist ?artistLabel ?artistLinks ?artistMbid ?artistDiscogsId ?artistRevision
         ?album ?albumLabel ?albumLinks ?albumMbid ?albumDiscogsMasterId ?albumRevision
ORDER BY ?genre ?artist ?album`;
}

async function fetchBatch(query, onRequest, onRetry) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    onRequest();
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        accept: "application/sparql-results+json",
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": userAgent,
      },
      body: new URLSearchParams({ query, format: "json" }),
    });
    if (response.ok) return response.json();
    if (![429, 502, 503, 504].includes(response.status) || attempt === maxAttempts) {
      throw new Error(`Wikidata Query Service returned ${response.status}: ${(await response.text()).slice(0, 500)}`);
    }
    onRetry();
    const retryAfter = Number(response.headers.get("retry-after") ?? 0);
    const delayMs = Math.max(1_100, retryAfter * 1_000, 2 ** attempt * 1_000);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
  }
  throw new Error("Wikidata Query Service retry loop terminated unexpectedly.");
}

function normalizeBindings(bindings, allowedQids) {
  const allowed = new Set(allowedQids);
  return bindings.map((binding) => {
    const styleQid = entityId(binding.genre.value);
    if (!allowed.has(styleQid)) throw new Error(`Unexpected style result ${styleQid}.`);
    return {
      style_qid: styleQid,
      artist_qid: entityId(binding.artist.value),
      artist_name: binding.artistLabel?.value ?? entityId(binding.artist.value),
      artist_sitelinks: Number(binding.artistLinks.value),
      artist_musicbrainz_mbid: binding.artistMbid?.value ?? null,
      artist_discogs_id: binding.artistDiscogsId?.value ?? null,
      artist_revision_id: binding.artistRevision?.value ?? null,
      album_qid: entityId(binding.album.value),
      album_name: binding.albumLabel?.value ?? entityId(binding.album.value),
      album_sitelinks: Number(binding.albumLinks.value),
      album_musicbrainz_release_group_mbid: binding.albumMbid?.value ?? null,
      album_discogs_master_id: binding.albumDiscogsMasterId?.value ?? null,
      album_revision_id: binding.albumRevision?.value ?? null,
      first_release_date: normalizeDate(binding.firstRelease?.value),
    };
  });
}

function compareRepresentative(left, right) {
  return right.artist_sitelinks - left.artist_sitelinks ||
    right.album_sitelinks - left.album_sitelinks ||
    numericQid(left.artist_qid) - numericQid(right.artist_qid) ||
    numericQid(left.album_qid) - numericQid(right.album_qid);
}

async function readCachedBatch(path, querySha256, styleSnapshotSha256) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (value.query_sha256 !== querySha256 ||
        value.style_catalog_sha256 !== styleSnapshotSha256 ||
        !Array.isArray(value.records)) return null;
    return value;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function atomicWriteJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  await rename(temporaryPath, path);
}

function chunk(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function entityId(url) {
  const qid = url.split("/").at(-1);
  if (!qid || !/^Q\d+$/.test(qid)) throw new Error(`Invalid Wikidata entity URL: ${url}`);
  return qid;
}

function numericQid(qid) {
  return Number(qid.slice(1));
}

function normalizeDate(value) {
  if (!value) return null;
  return /^\d{4}-\d{2}-\d{2}T/.test(value) ? value.slice(0, 10) : value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
