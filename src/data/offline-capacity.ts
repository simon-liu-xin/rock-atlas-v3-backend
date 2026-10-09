export interface OfflineSourceFile {
  name: string;
  bytes: number;
  license_partition:
    | "musicbrainz-core-cc0"
    | "musicbrainz-derived-nc"
    | "discogs-cc0"
    | "wikidata-cc0";
}

export interface OfflineCapacityInput {
  generated_at: string;
  musicbrainz_files: OfflineSourceFile[];
  discogs_files: OfflineSourceFile[];
  discogs_catalog_statistics?: {
    total_releases: number;
    rock_releases: number;
    rock_masters: number;
  };
  wikidata_files: OfflineSourceFile[];
}

export interface OfflineCapacityAssessment {
  generated_at: string;
  optional_nc_archive_bytes: number;
  discogs_selectivity: {
    total_releases: number;
    rock_seed_releases: number;
    rock_masters: number;
    rock_seed_release_fraction: number;
    complete_catalog_selected_release_fraction: null;
    lower_bound_selected_release_fraction: number;
    upper_bound_selected_release_fraction: 1;
    capacity_effect: "informational-until-full-scan";
  } | null;
  recommended: {
    bootstrap_strategy: "tracked-qid-api";
    includes_full_wikidata_dump: false;
    required_archive_bytes: number;
    estimated_stable_working_bytes: number;
    estimated_peak_working_bytes: number;
    provisioned_disk_bytes: number;
  };
  full_wikidata_variant: {
    bootstrap_strategy: "full-json-dump";
    includes_full_wikidata_dump: true;
    required_archive_bytes: number;
    estimated_peak_working_bytes: number;
    provisioned_disk_bytes: number;
  };
  assumptions: {
    musicbrainz_postgres_budget_bytes: number;
    discogs_streaming_multiplier: number;
    wikidata_tracked_subset_budget_bytes: number;
    application_indexes_budget_bytes: number;
    full_wikidata_parse_scratch_bytes: number;
    refresh_headroom_multiplier: number;
    retained_archive_generations: number;
  };
}

const DECIMAL_GB = 1000 ** 3;

export function parseMusicBrainzDirectory(html: string): OfflineSourceFile[] {
  return parseDirectory(html, (name) => {
    if (name === "mbdump.tar.bz2") return "musicbrainz-core-cc0";
    if (name === "mbdump-derived.tar.bz2") return "musicbrainz-derived-nc";
    return null;
  });
}

export function parseDiscogsDirectory(html: string): OfflineSourceFile[] {
  return parseDirectory(html, (name) =>
    /^discogs_\d{8}_(?:CHECKSUM\.txt|(?:artists|labels|masters|releases)\.xml\.gz)$/.test(name)
      ? "discogs-cc0"
      : null,
  );
}

export function parseWikidataDirectory(html: string): OfflineSourceFile[] {
  return parseDirectory(html, (name) =>
    /^(latest-all\.json\.bz2|latest-truthy\.nt\.bz2)$/.test(name)
      ? "wikidata-cc0"
      : null,
  );
}

export function selectLatestCompleteDiscogsSnapshot(files: OfflineSourceFile[]): {
  snapshot_id: string;
  files: OfflineSourceFile[];
} {
  const requiredKinds = new Set(["CHECKSUM", "artists", "labels", "masters", "releases"]);
  const snapshots = new Map<string, { files: OfflineSourceFile[]; kinds: Set<string> }>();

  for (const file of files) {
    const match = file.name.match(
      /^discogs_(\d{8})_(CHECKSUM)(?:\.txt)$|^discogs_(\d{8})_(artists|labels|masters|releases)\.xml\.gz$/,
    );
    const snapshotId = match?.[1] ?? match?.[3];
    const kind = match?.[2] ?? match?.[4];
    if (!snapshotId || !kind) continue;
    const snapshot = snapshots.get(snapshotId) ?? { files: [], kinds: new Set<string>() };
    snapshot.files.push(file);
    snapshot.kinds.add(kind);
    snapshots.set(snapshotId, snapshot);
  }

  const completeSnapshotId = [...snapshots.entries()]
    .filter(([, snapshot]) =>
      [...requiredKinds].every((requiredKind) => snapshot.kinds.has(requiredKind)),
    )
    .map(([snapshotId]) => snapshotId)
    .sort()
    .at(-1);
  if (!completeSnapshotId) throw new Error("Discogs directory has no complete monthly snapshot");

  return {
    snapshot_id: completeSnapshotId,
    files: snapshots.get(completeSnapshotId)?.files ?? [],
  };
}

export function buildOfflineCapacityAssessment(
  input: OfflineCapacityInput,
): OfflineCapacityAssessment {
  const musicBrainzCoreBytes = sumBytes(
    input.musicbrainz_files.filter(
      (file) => file.license_partition === "musicbrainz-core-cc0",
    ),
  );
  const discogsBytes = sumBytes(input.discogs_files);
  const optionalNcBytes = sumBytes(
    input.musicbrainz_files.filter(
      (file) => file.license_partition === "musicbrainz-derived-nc",
    ),
  );
  const fullWikidataBytes =
    input.wikidata_files.find((file) => file.name === "latest-all.json.bz2")?.bytes ?? 0;
  const discogsSelectivity = buildDiscogsSelectivity(input.discogs_catalog_statistics);

  const assumptions = {
    musicbrainz_postgres_budget_bytes: 100 * DECIMAL_GB,
    discogs_streaming_multiplier: 3,
    wikidata_tracked_subset_budget_bytes: 10 * DECIMAL_GB,
    application_indexes_budget_bytes: 100 * DECIMAL_GB,
    full_wikidata_parse_scratch_bytes: 300 * DECIMAL_GB,
    refresh_headroom_multiplier: 1.35,
    retained_archive_generations: 2,
  };

  const requiredArchiveBytes = musicBrainzCoreBytes + discogsBytes;
  const recommendedStableWorkingBytes = Math.ceil(
    requiredArchiveBytes * assumptions.retained_archive_generations +
      assumptions.musicbrainz_postgres_budget_bytes +
      discogsBytes * assumptions.discogs_streaming_multiplier +
      assumptions.wikidata_tracked_subset_budget_bytes +
      assumptions.application_indexes_budget_bytes,
  );
  const recommendedWorkingBytes = Math.ceil(
    recommendedStableWorkingBytes * assumptions.refresh_headroom_multiplier,
  );
  const fullWikidataWorkingBytes =
    recommendedWorkingBytes +
    fullWikidataBytes * assumptions.retained_archive_generations +
    assumptions.full_wikidata_parse_scratch_bytes;

  return {
    generated_at: input.generated_at,
    optional_nc_archive_bytes: optionalNcBytes,
    discogs_selectivity: discogsSelectivity,
    recommended: {
      bootstrap_strategy: "tracked-qid-api",
      includes_full_wikidata_dump: false,
      required_archive_bytes: requiredArchiveBytes,
      estimated_stable_working_bytes: recommendedStableWorkingBytes,
      estimated_peak_working_bytes: recommendedWorkingBytes,
      provisioned_disk_bytes: nextDeviceTier(recommendedWorkingBytes),
    },
    full_wikidata_variant: {
      bootstrap_strategy: "full-json-dump",
      includes_full_wikidata_dump: true,
      required_archive_bytes: requiredArchiveBytes + fullWikidataBytes,
      estimated_peak_working_bytes: fullWikidataWorkingBytes,
      provisioned_disk_bytes: nextDeviceTier(fullWikidataWorkingBytes),
    },
    assumptions,
  };
}

function buildDiscogsSelectivity(
  statistics: OfflineCapacityInput["discogs_catalog_statistics"],
): OfflineCapacityAssessment["discogs_selectivity"] {
  if (!statistics) return null;
  for (const [name, value] of Object.entries(statistics)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Invalid Discogs ${name}: ${value}`);
    }
  }
  if (statistics.total_releases < 1 || statistics.rock_releases > statistics.total_releases) {
    throw new Error("Discogs Rock release count must fit within the total release count");
  }
  const fraction = Math.round((statistics.rock_releases / statistics.total_releases) * 10 ** 7) / 10 ** 7;
  return {
    total_releases: statistics.total_releases,
    rock_seed_releases: statistics.rock_releases,
    rock_masters: statistics.rock_masters,
    rock_seed_release_fraction: fraction,
    complete_catalog_selected_release_fraction: null,
    lower_bound_selected_release_fraction: fraction,
    upper_bound_selected_release_fraction: 1,
    capacity_effect: "informational-until-full-scan",
  };
}

function parseDirectory(
  html: string,
  classify: (name: string) => OfflineSourceFile["license_partition"] | null,
): OfflineSourceFile[] {
  const files: OfflineSourceFile[] = [];
  for (const line of html.split(/\r?\n/)) {
    const anchor = line.match(/<a\s+[^>]*href="[^"]*"[^>]*>([^<]+)<\/a>/i);
    const anchorName = anchor?.[1];
    if (!anchorName) continue;
    const name = decodeHtml(anchorName.trim());
    const licensePartition = classify(name);
    if (!licensePartition) continue;
    const text = decodeHtml(line.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    const bytes = parseSizeFromLine(text);
    if (bytes === null) continue;
    files.push({ name, bytes, license_partition: licensePartition });
  }
  return files;
}

function parseSizeFromLine(line: string): number | null {
  const unitMatches = [...line.matchAll(/(\d+(?:\.\d+)?)\s*(TB|GB|MB|KB|T|G|M|K|B)\b/gi)];
  const unitMatch = unitMatches.at(-1);
  if (unitMatch) {
    const rawValue = unitMatch[1];
    const rawUnit = unitMatch[2];
    if (!rawValue || !rawUnit) return null;
    const value = Number(rawValue);
    const unit = rawUnit.toUpperCase();
    const decimal = unit.endsWith("B") && unit !== "B";
    const exponents: Record<string, number> = {
      B: 0,
      K: 1,
      KB: 1,
      M: 2,
      MB: 2,
      G: 3,
      GB: 3,
      T: 4,
      TB: 4,
    };
    const exponent = exponents[unit];
    if (exponent === undefined) return null;
    return Math.round(value * (decimal ? 1000 : 1024) ** exponent);
  }

  const exact = line.match(/(\d{6,})\s*$/);
  return exact ? Number(exact[1]) : null;
}

function decodeHtml(value: string): string {
  return value.replaceAll("&amp;", "&").replaceAll("&quot;", '"');
}

function sumBytes(files: OfflineSourceFile[]): number {
  return files.reduce((total, file) => total + file.bytes, 0);
}

function nextDeviceTier(bytes: number): number {
  const tiers = [128, 256, 512, 1000, 2000, 4000].map((gigabytes) => gigabytes * DECIMAL_GB);
  return tiers.find((tier) => tier >= bytes) ?? Math.ceil(bytes / (1000 * DECIMAL_GB)) * 1000 * DECIMAL_GB;
}
