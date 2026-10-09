import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildOfflineCapacityAssessment,
  parseDiscogsDirectory,
  parseMusicBrainzDirectory,
  parseWikidataDirectory,
  selectLatestCompleteDiscogsSnapshot,
} from "../src/data/offline-capacity.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(
  await readFile(resolve(root, "config/offline-data-sources-v1.json"), "utf8"),
);
const outputPath = argumentValue("--output");
const generatedAt = new Date().toISOString();
const userAgent = `MusicWiki/0.1 (offline-capacity-probe${
  process.env.MUSICWIKI_CONTACT ? `; ${process.env.MUSICWIKI_CONTACT}` : ""
})`;

const musicBrainzSnapshot = (
  await fetchText(config.sources.musicbrainz.latest_pointer)
).trim();
assertSnapshotId(musicBrainzSnapshot, /^\d{8}-\d{6}$/, "MusicBrainz");
const musicBrainzBaseUrl = config.sources.musicbrainz.snapshot_url_template.replace(
  "{snapshot}",
  musicBrainzSnapshot,
);
const musicBrainzHtml = await fetchText(musicBrainzBaseUrl);
const musicBrainzFiles = await Promise.all(
  parseMusicBrainzDirectory(musicBrainzHtml).map(async (file) => ({
    ...file,
    bytes: await fetchContentLength(new URL(file.name, musicBrainzBaseUrl)),
  })),
);

const discogsYear = generatedAt.slice(0, 4);
const discogsDirectoryUrl = config.sources.discogs.directory_url_template.replace(
  "{year}",
  discogsYear,
);
const allDiscogsFiles = parseDiscogsDirectory(await fetchText(discogsDirectoryUrl));
const discogsSelection = selectLatestCompleteDiscogsSnapshot(allDiscogsFiles);
const discogsSnapshot = discogsSelection.snapshot_id;
const discogsFiles = discogsSelection.files;
const [discogsStatistics, discogsRockReleaseSearch, discogsRockMasterSearch] = await Promise.all([
  fetchJson(config.sources.discogs.statistics_url),
  fetchJson(config.sources.discogs.rock_release_statistics_url),
  fetchJson(config.sources.discogs.rock_master_statistics_url),
]);
const discogsCatalogStatistics = {
  total_releases: requireCount(discogsStatistics.statistics?.releases, "Discogs total releases"),
  rock_releases: requireCount(
    discogsRockReleaseSearch.pagination.items,
    "Discogs Rock releases",
  ),
  rock_masters: requireCount(discogsRockMasterSearch.pagination.items, "Discogs Rock masters"),
};

const wikidataFiles = parseWikidataDirectory(
  await fetchText(config.sources.wikidata.entity_directory),
);

const assessment = buildOfflineCapacityAssessment({
  generated_at: generatedAt,
  musicbrainz_files: musicBrainzFiles,
  discogs_files: discogsFiles,
  discogs_catalog_statistics: discogsCatalogStatistics,
  wikidata_files: wikidataFiles,
});

const report = {
  snapshot_version: "1.0",
  generated_at: generatedAt,
  probe_mode: "metadata-only",
  full_archives_downloaded: false,
  source_snapshots: {
    musicbrainz: {
      snapshot_id: musicBrainzSnapshot,
      directory_url: musicBrainzBaseUrl,
      files: musicBrainzFiles,
    },
    discogs: {
      snapshot_id: discogsSnapshot,
      directory_url: discogsDirectoryUrl,
      files: discogsFiles,
      catalog_statistics: {
        ...(discogsStatistics.statistics ?? {}),
        rock_seed_releases: discogsCatalogStatistics.rock_releases,
        rock_masters: discogsCatalogStatistics.rock_masters,
        rock_seed_release_fraction: assessment.discogs_selectivity?.rock_seed_release_fraction ?? null,
      },
    },
    wikidata: {
      snapshot_id: "latest-directory-links",
      directory_url: config.sources.wikidata.entity_directory,
      files: wikidataFiles,
    },
  },
  assessment,
};

const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (outputPath) {
  const absoluteOutput = resolve(root, outputPath);
  await mkdir(dirname(absoluteOutput), { recursive: true });
  await writeFile(absoluteOutput, serialized, "utf8");
}
process.stdout.write(serialized);

async function fetchText(url) {
  const response = await fetch(url, { headers: { "user-agent": userAgent } });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.text();
}

async function fetchJson(url) {
  return JSON.parse(await fetchText(url));
}

async function fetchContentLength(url) {
  const response = await fetch(url, {
    method: "HEAD",
    headers: { "user-agent": userAgent },
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  const value = response.headers.get("content-length");
  if (!value || !/^\d+$/.test(value)) {
    throw new Error(`${url} did not return a numeric Content-Length`);
  }
  return Number(value);
}

function assertSnapshotId(value, pattern, source) {
  if (!pattern.test(value)) throw new Error(`${source} returned invalid snapshot id: ${value}`);
}

function requireCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is not a valid count`);
  return value;
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}
