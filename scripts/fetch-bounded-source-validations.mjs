import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = resolve(repositoryRoot, "data/sources/rock-catalog-v2");
const representativesPath = resolve(sourceRoot, "wikidata-representatives.json");
const seedPath = resolve(repositoryRoot, "data/fixtures/experiment-v1/sample.json");
const outputPath = resolve(sourceRoot, "cross-source-validations.json");
const cacheRoot = resolve(sourceRoot, "validation-cache");
const userAgent = "RockAtlasCatalog/3.0 (bounded multi-source catalog; contact: local-development)";
const musicBrainzEndpoint = "https://musicbrainz.org/ws/2";
const discogsEndpoint = "https://api.discogs.com";
const musicBrainzBatchSize = 40;
const discogsIntervalMs = numberEnvironment("MUSICWIKI_DISCOGS_MIN_INTERVAL_MS", 2_500, 250);
const sourceCacheMaxAgeMs = numberEnvironment(
  "MUSICWIKI_SOURCE_CACHE_MAX_AGE_MS",
  24 * 60 * 60 * 1_000,
  0,
);

const [representativesBytes, seedBytes] = await Promise.all([
  readFile(representativesPath),
  readFile(seedPath),
]);
const representatives = JSON.parse(representativesBytes);
const seed = JSON.parse(seedBytes);
const seedPairs = seed.styles.map((style) => {
  const artist = required(seed.artists, style.artist_ids[0], "seed artist");
  const release = seed.release_groups
    .filter((candidate) => candidate.artist_ids.includes(artist.internal_id))
    .sort((left, right) =>
      String(left.first_release_date ?? "9999").localeCompare(String(right.first_release_date ?? "9999")) ||
      left.internal_id.localeCompare(right.internal_id)
    )[0];
  if (!release) throw new Error(`Seed artist ${artist.internal_id} has no release group.`);
  return {
    artist_musicbrainz_mbid: artist.musicbrainz_mbid,
    album_musicbrainz_release_group_mbid: release.musicbrainz_mbid,
  };
});
const pairs = [...representatives.representatives, ...seedPairs];
const artistMbids = unique(pairs.map((pair) => pair.artist_musicbrainz_mbid).filter(Boolean));
const releaseMbids = unique(
  pairs.map((pair) => pair.album_musicbrainz_release_group_mbid).filter(Boolean),
);
const discogsMasters = unique(
  representatives.representatives.map((pair) => pair.album_discogs_master_id).filter(Boolean),
);
const artistsNeedingDirectDiscogsLookup = unique(
  representatives.representatives
    .filter((pair) => pair.artist_discogs_id && !pair.album_discogs_master_id)
    .map((pair) => pair.artist_discogs_id),
);

await mkdir(cacheRoot, { recursive: true });
const counters = { musicbrainz_requests: 0, discogs_requests: 0, retries: 0 };
const musicbrainzArtists = await fetchMusicBrainzBatches({
  entity: "artist",
  field: "arid",
  resultKey: "artists",
  ids: artistMbids,
  normalize: normalizeMusicBrainzArtist,
});
const musicbrainzReleaseGroups = await fetchMusicBrainzBatches({
  entity: "release-group",
  field: "rgid",
  resultKey: "release-groups",
  ids: releaseMbids,
  normalize: normalizeMusicBrainzReleaseGroup,
});

let lastDiscogsRequestAt = 0;
const discogsMasterRecords = [];
for (const id of discogsMasters) {
  const record = await fetchDiscogsResource("master", id);
  if (record) discogsMasterRecords.push(normalizeDiscogsMaster(record));
}
const discogsArtistRecords = [];
for (const id of artistsNeedingDirectDiscogsLookup) {
  const record = await fetchDiscogsResource("artist", id);
  if (record) discogsArtistRecords.push(normalizeDiscogsArtist(record));
}

const representativeReplacements = [];
const rejectedCandidates = [];
for (const pair of representatives.representatives) {
  const musicbrainzArtist = musicbrainzArtists.find(
    (record) => record.id === pair.artist_musicbrainz_mbid,
  );
  const musicbrainzRelease = musicbrainzReleaseGroups.find(
    (record) => record.id === pair.album_musicbrainz_release_group_mbid,
  );
  const discogsMaster = discogsMasterRecords.find(
    (record) => String(record.id) === String(pair.album_discogs_master_id),
  );
  const conflicts = [];
  const musicbrainzCreditsArtist = musicbrainzRelease?.artist_credit_ids
    .includes(pair.artist_musicbrainz_mbid) === true;
  const discogsCreditsArtist = Boolean(
    pair.album_discogs_master_id && discogsMaster &&
    discogsMaster.artist_ids.map(String).includes(String(pair.artist_discogs_id)),
  );
  if (musicbrainzRelease && !musicbrainzCreditsArtist) {
    conflicts.push("musicbrainz-release-credit-mismatch");
  }
  if (discogsMaster && !discogsCreditsArtist) {
    conflicts.push("discogs-master-credit-mismatch");
  }
  if (conflicts.length === 0) continue;
  const rejected = {
    style_qid: pair.style_qid,
    artist_qid: pair.artist_qid,
    rejected_album_qid: pair.album_qid,
    rejected_musicbrainz_release_group_mbid: pair.album_musicbrainz_release_group_mbid,
    rejected_discogs_master_id: pair.album_discogs_master_id,
    conflicts,
  };

  let resolution = null;
  if (musicbrainzCreditsArtist && !discogsCreditsArtist) {
    resolution = {
      retain_wikidata_album: true,
      artist_musicbrainz_mbid: pair.artist_musicbrainz_mbid,
      album_musicbrainz_release_group_mbid: pair.album_musicbrainz_release_group_mbid,
      artist_discogs_id: null,
      album_discogs_master_id: null,
      replacement_release_group: musicbrainzRelease,
      resolution_basis: "musicbrainz-credit-discogs-identity-quarantined",
    };
  } else if (!musicbrainzCreditsArtist && discogsCreditsArtist) {
    resolution = {
      retain_wikidata_album: true,
      artist_musicbrainz_mbid: null,
      album_musicbrainz_release_group_mbid: null,
      artist_discogs_id: pair.artist_discogs_id,
      album_discogs_master_id: pair.album_discogs_master_id,
      replacement_release_group: null,
      resolution_basis: "discogs-credit-musicbrainz-identity-quarantined",
    };
  } else if (pair.artist_musicbrainz_mbid && musicbrainzArtist &&
      namesLikelyMatch(pair.artist_name, musicbrainzArtist.name)) {
    const alternative = await fetchMusicBrainzRepresentativeRelease(pair.artist_musicbrainz_mbid);
    if (alternative) {
      if (!musicbrainzReleaseGroups.some((record) => record.id === alternative.id)) {
        musicbrainzReleaseGroups.push(alternative);
      }
      resolution = {
        retain_wikidata_album: false,
        artist_musicbrainz_mbid: pair.artist_musicbrainz_mbid,
        album_musicbrainz_release_group_mbid: alternative.id,
        artist_discogs_id: null,
        album_discogs_master_id: null,
        replacement_release_group: alternative,
        resolution_basis: "musicbrainz-credited-album-reconciliation",
      };
    }
  }

  rejectedCandidates.push({
    ...rejected,
    resolution_status: resolution ? "reconciled" : "rejected-for-ancestor-fallback",
  });
  if (!resolution) continue;
  representativeReplacements.push({
    style_qid: pair.style_qid,
    artist_qid: pair.artist_qid,
    rejected_album_qid: pair.album_qid,
    ...resolution,
    evidence_locator: `${musicBrainzEndpoint}/release-group?artist=${pair.artist_musicbrainz_mbid}&type=album`,
  });
}
musicbrainzReleaseGroups.sort((left, right) => left.id.localeCompare(right.id));

const retrievedAt = new Date().toISOString();
const date = retrievedAt.slice(0, 10);
const payload = {
  schema_version: "1.0",
  snapshot_id: `bounded-cross-source-${date}`,
  retrieved_at: retrievedAt,
  input_sha256: sha256(Buffer.concat([representativesBytes, seedBytes])),
  representative_replacements: representativeReplacements,
  rejected_candidates: rejectedCandidates,
  sources: {
    musicbrainz: {
      snapshot_id: `musicbrainz-api-bounded-${date}`,
      source_url: musicBrainzEndpoint,
      license_partition: "musicbrainz-core-cc0",
      retrieved_at: retrievedAt,
      requested_artist_ids: artistMbids,
      requested_release_group_ids: releaseMbids,
      missing_artist_ids: artistMbids.filter((id) =>
        !musicbrainzArtists.some((record) => record.id === id)
      ),
      missing_release_group_ids: releaseMbids.filter((id) =>
        !musicbrainzReleaseGroups.some((record) => record.id === id)
      ),
      artists: musicbrainzArtists,
      release_groups: musicbrainzReleaseGroups,
    },
    discogs: {
      snapshot_id: `discogs-api-bounded-${date}`,
      source_url: discogsEndpoint,
      license_partition: "discogs-cc0",
      retrieved_at: retrievedAt,
      requested_artist_ids: artistsNeedingDirectDiscogsLookup.map(String),
      requested_master_ids: discogsMasters.map(String),
      missing_artist_ids: artistsNeedingDirectDiscogsLookup
        .filter((id) => !discogsArtistRecords.some((record) => String(record.id) === String(id)))
        .map(String),
      missing_master_ids: discogsMasters
        .filter((id) => !discogsMasterRecords.some((record) => String(record.id) === String(id)))
        .map(String),
      artists: discogsArtistRecords,
      masters: discogsMasterRecords,
    },
  },
  requests: counters,
};
await atomicWriteJson(outputPath, payload);
console.log(JSON.stringify({
  output: outputPath,
  musicbrainz: {
    artists: musicbrainzArtists.length,
    release_groups: musicbrainzReleaseGroups.length,
    missing_artists: payload.sources.musicbrainz.missing_artist_ids.length,
    missing_release_groups: payload.sources.musicbrainz.missing_release_group_ids.length,
  },
  discogs: {
    artists: discogsArtistRecords.length,
    masters: discogsMasterRecords.length,
    missing_artists: payload.sources.discogs.missing_artist_ids.length,
    missing_masters: payload.sources.discogs.missing_master_ids.length,
  },
  requests: counters,
  reconciled_representatives: representativeReplacements.length,
}, null, 2));

async function fetchMusicBrainzRepresentativeRelease(artistId) {
  const cachePath = resolve(cacheRoot, `musicbrainz-artist-release-groups-${artistId}.json`);
  const cached = await readFreshJson(cachePath);
  let records;
  if (cached?.artist_id === artistId && Array.isArray(cached.records)) {
    records = cached.records;
  } else {
    const url = new URL(`${musicBrainzEndpoint}/release-group`);
    url.search = new URLSearchParams({
      artist: artistId,
      type: "album",
      inc: "artist-credits",
      fmt: "json",
      limit: "100",
    }).toString();
    const response = await fetchWithRetry(url, "musicbrainz");
    const result = await response.json();
    records = (result["release-groups"] ?? []).map(normalizeMusicBrainzReleaseGroup);
    await atomicWriteJson(cachePath, { artist_id: artistId, records });
    await delay(1_100);
  }
  return records
    .filter((record) => record.artist_credit_ids.includes(artistId))
    .filter((record) => record.primary_type === "Album" && record.secondary_types.length === 0)
    .sort((left, right) =>
      String(left.first_release_date || "9999").localeCompare(String(right.first_release_date || "9999")) ||
      left.id.localeCompare(right.id)
    )[0] ?? null;
}

async function fetchMusicBrainzBatches({ entity, field, resultKey, ids, normalize }) {
  const records = [];
  for (let index = 0; index < ids.length; index += musicBrainzBatchSize) {
    const batch = ids.slice(index, index + musicBrainzBatchSize);
    const query = `${field}:(${batch.join(" OR ")})`;
    const cachePath = resolve(
      cacheRoot,
      `musicbrainz-${entity}-${String(index / musicBrainzBatchSize + 1).padStart(3, "0")}-${sha256(query).slice(0, 12)}.json`,
    );
    const cached = await readFreshJson(cachePath);
    let body;
    if (cached?.query === query && Array.isArray(cached.records)) {
      body = cached.records;
    } else {
      const url = new URL(`${musicBrainzEndpoint}/${entity}/`);
      url.search = new URLSearchParams({ query, fmt: "json", limit: "100" }).toString();
      const response = await fetchWithRetry(url, "musicbrainz");
      const result = await response.json();
      body = (result[resultKey] ?? [])
        .filter((record) => batch.includes(record.id))
        .map(normalize);
      await atomicWriteJson(cachePath, { query, records: body });
      await delay(1_100);
    }
    records.push(...body);
  }
  return uniqueBy(records, (record) => record.id).sort((a, b) => a.id.localeCompare(b.id));
}

async function fetchDiscogsResource(kind, id) {
  const cachePath = resolve(cacheRoot, `discogs-${kind}-${id}.json`);
  const cached = await readFreshJson(cachePath);
  if (cached?.kind === kind && String(cached.id) === String(id)) return cached.record;
  const waitMs = Math.max(0, discogsIntervalMs - (Date.now() - lastDiscogsRequestAt));
  if (waitMs) await delay(waitMs);
  const resource = kind === "master" ? "masters" : "artists";
  const response = await fetchWithRetry(`${discogsEndpoint}/${resource}/${id}`, "discogs", true);
  lastDiscogsRequestAt = Date.now();
  const record = response.status === 404 ? null : await response.json();
  await atomicWriteJson(cachePath, { kind, id: String(id), record });
  return record;
}

async function fetchWithRetry(url, source, allowNotFound = false) {
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    counters[`${source}_requests`] += 1;
    const response = await fetch(url, {
      headers: { accept: "application/json", "user-agent": userAgent },
      signal: AbortSignal.timeout(30_000),
    });
    if (response.ok || (allowNotFound && response.status === 404)) return response;
    if (![429, 502, 503, 504].includes(response.status) || attempt === 6) {
      throw new Error(`${source} returned HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    }
    counters.retries += 1;
    const retryAfter = Number(response.headers.get("retry-after") ?? 0);
    await delay(Math.max(retryAfter * 1_000, 2 ** attempt * 1_000));
  }
  throw new Error(`${source} retry loop terminated unexpectedly.`);
}

function normalizeMusicBrainzArtist(record) {
  return {
    id: record.id,
    name: record.name,
    sort_name: record["sort-name"] ?? record.name,
    type: record.type ?? null,
    country: record.country ?? null,
  };
}

function normalizeMusicBrainzReleaseGroup(record) {
  return {
    id: record.id,
    title: record.title,
    first_release_date: record["first-release-date"] ?? null,
    primary_type: record["primary-type"] ?? null,
    secondary_types: record["secondary-types"] ?? [],
    artist_credit_ids: (record["artist-credit"] ?? [])
      .map((credit) => credit.artist?.id)
      .filter(Boolean),
  };
}

function normalizeDiscogsMaster(record) {
  return {
    id: Number(record.id),
    title: record.title,
    year: Number.isSafeInteger(record.year) && record.year > 0 ? record.year : null,
    artist_ids: (record.artists ?? []).map((artist) => Number(artist.id)).filter(Number.isSafeInteger),
    resource_url: record.resource_url,
  };
}

function normalizeDiscogsArtist(record) {
  return {
    id: Number(record.id),
    name: record.name,
    resource_url: record.resource_url,
  };
}

function required(values, id, kind) {
  const value = values.find((record) => record.internal_id === id);
  if (!value) throw new Error(`Missing ${kind} ${id}.`);
  return value;
}

function unique(values) {
  return [...new Set(values)].sort((left, right) => String(left).localeCompare(String(right)));
}

function uniqueBy(values, key) {
  return [...new Map(values.map((value) => [key(value), value])).values()];
}

function namesLikelyMatch(left, right) {
  const normalize = (value) => String(value ?? "")
    .normalize("NFKD")
    .replaceAll(/[^\p{Letter}\p{Number}]+/gu, "")
    .toLocaleLowerCase("en");
  return normalize(left) === normalize(right);
}

function numberEnvironment(name, fallback, minimum) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < minimum) throw new Error(`${name} must be at least ${minimum}.`);
  return value;
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function readFreshJson(path) {
  try {
    const metadata = await stat(path);
    if (Date.now() - metadata.mtimeMs > sourceCacheMaxAgeMs) return null;
    return await readJson(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function atomicWriteJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  await rename(temporaryPath, path);
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
