import {
  assessRepresentativeValidation,
  indexSourceValidation,
} from "./cross-source-validation.mjs";

const wikidataEntityRoot = "https://www.wikidata.org/wiki/Special:EntityData";

export function buildBoundedRockCatalog({
  styleCatalog,
  representatives,
  sourceValidation,
  seed,
  generatedAt,
  generationId,
  sourceFingerprintSha256,
}) {
  const validationIndexes = indexSourceValidation(sourceValidation);
  const selectedStyles = [...styleCatalog.styles];
  if (selectedStyles.length !== 828) {
    throw new Error(`Bounded frontend generation requires 828 styles, got ${selectedStyles.length}.`);
  }
  const allStylesByQid = new Map(
    [...styleCatalog.styles, ...styleCatalog.excluded].map((style) => [style.qid, style]),
  );
  const selectedQids = new Set(selectedStyles.map((style) => style.qid));
  const seedStyleByQid = new Map(seed.styles.map((style) => [style.wikidata_qid, style]));
  const styleIdByQid = new Map(selectedStyles.map((style) => [
    style.qid,
    seedStyleByQid.get(style.qid)?.internal_id ?? `mw:style:wikidata:${style.qid.toLowerCase()}`,
  ]));
  const rejectedStyleQids = new Set(
    (sourceValidation.rejected_candidates ?? [])
      .filter((candidate) => candidate.resolution_status === "rejected-for-ancestor-fallback")
      .map((candidate) => candidate.style_qid),
  );
  const directRepresentativeByQid = new Map(
    representatives.representatives
      .filter((record) => !rejectedStyleQids.has(record.style_qid))
      .map((record) => [
      record.style_qid,
      applyRepresentativeReplacement(record, sourceValidation),
      ]),
  );
  const seedArtistById = new Map(seed.artists.map((artist) => [artist.internal_id, artist]));
  const seedArtistByMbid = new Map(seed.artists.map((artist) => [artist.musicbrainz_mbid, artist]));
  const seedReleaseById = new Map(seed.release_groups.map((release) => [release.internal_id, release]));
  const seedReleaseByMbid = new Map(
    seed.release_groups.map((release) => [release.musicbrainz_mbid, release]),
  );

  const canonicalStyles = selectedStyles.map((style) => {
    const seedStyle = seedStyleByQid.get(style.qid);
    return {
    internal_id: styleIdByQid.get(style.qid),
    canonical_name: seedStyle?.canonical_name ?? style.label,
    sort_name: seedStyle?.canonical_name ?? style.label,
    description: style.description ?? "",
    origin_date_text: seedStyle?.era ?? style.origin_date ?? null,
    region_text: seedStyle?.region ?? nonEmptyJoined(style.country_labels) ?? null,
    inclusion_status: "accepted",
    wikidata_qid: style.qid,
    source_revision_id: style.source_revision_id ?? null,
    source_url: `${wikidataEntityRoot}/${style.qid}.json`,
    source_snapshot_id: styleCatalog.snapshot_id,
    parent_qids: [...(style.parent_qids ?? [])],
    country_qids: [...(style.country_qids ?? [])],
    instance_of_qids: [...(style.instance_of_qids ?? [])],
    };
  });
  const canonicalArtists = new Map(seed.artists.map((artist) => [artist.internal_id, {
    internal_id: artist.internal_id,
    canonical_name: artist.canonical_name,
    sort_name: artist.canonical_name,
    artist_type: null,
    description: "",
    musicbrainz_mbid: artist.musicbrainz_mbid,
    wikidata_qid: null,
    source_url: artist.source_url,
    source_snapshot_id: "experiment-v1-musicbrainz-seed",
    source_revision_id: null,
  }]));
  const canonicalReleaseGroups = new Map(seed.release_groups.map((release) => [
    release.internal_id,
    {
      internal_id: release.internal_id,
      canonical_name: release.canonical_name,
      primary_type: release.primary_type,
      secondary_types: [...release.secondary_types],
      first_release_date_text: release.first_release_date,
      description: "",
      cover_art_url: null,
      cover_art_source: null,
      musicbrainz_mbid: release.musicbrainz_mbid,
      wikidata_qid: null,
      source_url: release.source_url,
      source_snapshot_id: "experiment-v1-musicbrainz-seed",
      source_revision_id: null,
      artist_ids: [...release.artist_ids],
    },
  ]));
  const representativeArtists = [];
  const representativeReleaseGroups = [];
  const frontendStyles = [];
  const frontendArtists = [];
  const frontendReleaseGroups = [];
  const associationEvidence = [];
  const entitySourceAssertions = [];
  const representativeValidations = [];

  for (const style of selectedStyles) {
    const styleId = styleIdByQid.get(style.qid);
    const seedStyle = seedStyleByQid.get(style.qid);
    if (seedStyle) {
      const artist = requiredById(seedArtistById, seedStyle.artist_ids[0], "seed artist");
      const release = representativeSeedRelease(seed, artist.internal_id);
      const evidenceId = `mw:evidence:seed-representative:${style.qid.toLowerCase()}`;
      const validation = assessRepresentativeValidation({
        selectionBasis: "curated-seed",
        artistMusicbrainzMbid: artist.musicbrainz_mbid,
        releaseMusicbrainzMbid: release.musicbrainz_mbid,
        artistDiscogsId: null,
        releaseDiscogsMasterId: null,
        indexes: validationIndexes,
      });
      assertNoSourceConflict(styleId, validation);
      representativeValidations.push({ style_id: styleId, ...validation });
      representativeArtists.push({
        style_id: styleId,
        artist_id: artist.internal_id,
        asserted_style_id: styleId,
        source_snapshot_id: "experiment-v1-musicbrainz-seed",
        selection_basis: "curated-seed",
        confidence_band: "high",
        ancestor_distance: 0,
        selection_score: null,
        evidence_locator: artist.source_url,
        occurrence_id: artist.internal_id,
        evidence_id: evidenceId,
        ...validation,
      });
      representativeReleaseGroups.push({
        style_id: styleId,
        artist_id: artist.internal_id,
        release_group_id: release.internal_id,
        source_snapshot_id: "experiment-v1-musicbrainz-seed",
        selection_basis: "curated-seed",
        selection_score: null,
        evidence_locator: release.source_url,
        occurrence_id: release.internal_id,
        evidence_id: evidenceId,
        ...validation,
      });
      associationEvidence.push({
        evidence_id: evidenceId,
        source_dataset: "MusicBrainz",
        source_record_id: artist.musicbrainz_mbid,
        source_url: artist.source_url,
        claim: `${artist.canonical_name} is the curated representative for ${style.label}.`,
        retrieved_at: generatedAt,
        snapshot_version: "experiment-v1",
        license_partition: "musicbrainz-core-cc0",
      });
      frontendStyles.push(frontendStyle(style, styleId, artist.internal_id, seedStyle));
      frontendArtists.push(frontendArtist({
        occurrenceId: artist.internal_id,
        canonicalArtistId: artist.internal_id,
        artistName: artist.canonical_name,
        styleId,
        mbid: artist.musicbrainz_mbid,
        qid: null,
        sourceUrl: artist.source_url,
        selectionBasis: "curated-seed",
        assertedStyleId: styleId,
        ancestorDistance: 0,
        evidenceId,
        validation,
      }));
      frontendReleaseGroups.push(frontendRelease({
        occurrenceId: release.internal_id,
        canonicalReleaseId: release.internal_id,
        artistOccurrenceId: artist.internal_id,
        releaseName: release.canonical_name,
        primaryType: release.primary_type,
        secondaryTypes: release.secondary_types,
        firstReleaseDate: release.first_release_date,
        mbid: release.musicbrainz_mbid,
        qid: null,
        sourceUrl: release.source_url,
        evidenceId,
        validation,
      }));
      appendSourceAssertions(entitySourceAssertions, {
        artistId: artist.internal_id,
        releaseGroupId: release.internal_id,
        artistMbid: artist.musicbrainz_mbid,
        releaseMbid: release.musicbrainz_mbid,
        artistQid: null,
        releaseQid: null,
        artistDiscogsId: null,
        releaseDiscogsMasterId: null,
        validation,
        sourceValidation,
        representatives,
      });
      continue;
    }

    const resolved = resolveRepresentative(
      style.qid,
      allStylesByQid,
      directRepresentativeByQid,
    );
    const record = resolved.record;
    const selectionBasis = resolved.distance === 0
      ? "wikidata-direct-genre"
      : "wikidata-ancestor-fallback";
    const validation = assessRepresentativeValidation({
      selectionBasis,
      artistMusicbrainzMbid: record.artist_musicbrainz_mbid,
      releaseMusicbrainzMbid: record.album_musicbrainz_release_group_mbid,
      artistDiscogsId: record.artist_discogs_id,
      releaseDiscogsMasterId: record.album_discogs_master_id,
      indexes: validationIndexes,
    });
    assertNoSourceConflict(styleId, validation);
    representativeValidations.push({ style_id: styleId, ...validation });
    const canonicalArtistId = canonicalArtistIdFor(record, seedArtistByMbid, validation);
    const existingArtist = seedArtistByMbid.get(record.artist_musicbrainz_mbid);
    if (!canonicalArtists.has(canonicalArtistId)) {
      canonicalArtists.set(canonicalArtistId, {
        internal_id: canonicalArtistId,
        canonical_name: record.artist_name,
        sort_name: record.artist_name,
        artist_type: null,
        description: "",
        musicbrainz_mbid: validation.musicbrainz_status === "verified"
          ? record.artist_musicbrainz_mbid
          : null,
        discogs_id: validation.discogs_status === "verified" ? record.artist_discogs_id : null,
        wikidata_qid: record.artist_qid,
        source_url: validation.musicbrainz_status === "verified"
          ? `https://musicbrainz.org/artist/${record.artist_musicbrainz_mbid}`
          : existingArtist?.source_url ?? `${wikidataEntityRoot}/${record.artist_qid}.json`,
        source_snapshot_id: validation.musicbrainz_status === "verified"
          ? sourceValidation.sources.musicbrainz.snapshot_id
          : representatives.snapshot_id,
        source_revision_id: record.artist_revision_id,
      });
    }
    const canonicalReleaseId = canonicalReleaseIdFor(
      record,
      canonicalArtistId,
      seedReleaseByMbid,
      validation,
    );
    const existingRelease = seedReleaseByMbid.get(record.album_musicbrainz_release_group_mbid);
    if (!canonicalReleaseGroups.has(canonicalReleaseId)) {
      canonicalReleaseGroups.set(canonicalReleaseId, {
        internal_id: canonicalReleaseId,
        canonical_name: record.album_name,
        primary_type: "Album",
        secondary_types: [],
        first_release_date_text: record.first_release_date,
        description: "",
        cover_art_url: null,
        cover_art_source: null,
        musicbrainz_mbid: validation.musicbrainz_status === "verified"
          ? record.album_musicbrainz_release_group_mbid
          : null,
        discogs_master_id: validation.discogs_status === "verified"
          ? record.album_discogs_master_id
          : null,
        wikidata_qid: record.album_qid,
        source_url: validation.musicbrainz_status === "verified"
          ? `https://musicbrainz.org/release-group/${record.album_musicbrainz_release_group_mbid}`
          : existingRelease?.source_url ?? `${wikidataEntityRoot}/${record.album_qid}.json`,
        source_snapshot_id: validation.musicbrainz_status === "verified"
          ? sourceValidation.sources.musicbrainz.snapshot_id
          : representatives.snapshot_id,
        source_revision_id: record.album_revision_id,
        artist_ids: [canonicalArtistId],
      });
    }
    const assertedStyleId = styleIdByQid.get(resolved.assertedStyleQid);
    if (!assertedStyleId) {
      throw new Error(`Representative fallback resolved to unselected style ${resolved.assertedStyleQid}.`);
    }
    const evidenceId = `mw:evidence:representative:${style.qid.toLowerCase()}`;
    const occurrenceArtistId = `mw:graph-artist:${style.qid.toLowerCase()}:${record.artist_qid.toLowerCase()}`;
    const releaseOccurrenceSource = record.album_qid?.toLowerCase() ??
      `musicbrainz:${record.album_musicbrainz_release_group_mbid}`;
    const occurrenceReleaseId = `mw:graph-release-group:${style.qid.toLowerCase()}:${releaseOccurrenceSource}`;
    representativeArtists.push({
      style_id: styleId,
      artist_id: canonicalArtistId,
      asserted_style_id: assertedStyleId,
      source_snapshot_id: representatives.snapshot_id,
      selection_basis: selectionBasis,
      confidence_band: representativeConfidence(selectionBasis, validation),
      ancestor_distance: resolved.distance,
      selection_score: record.artist_sitelinks,
      evidence_locator: `entities.${record.artist_qid}.claims.P136`,
      occurrence_id: occurrenceArtistId,
      evidence_id: evidenceId,
      ...validation,
    });
    representativeReleaseGroups.push({
      style_id: styleId,
      artist_id: canonicalArtistId,
      release_group_id: canonicalReleaseId,
      source_snapshot_id: representatives.snapshot_id,
      selection_basis: record.release_resolution_basis ?? "wikidata-performer-album",
      selection_score: record.album_sitelinks,
      evidence_locator: record.album_qid
        ? `entities.${record.album_qid}.claims.P175`
        : record.release_resolution_evidence_locator,
      occurrence_id: occurrenceReleaseId,
      evidence_id: evidenceId,
      ...validation,
    });
    associationEvidence.push({
      evidence_id: evidenceId,
      source_dataset: "Wikidata",
      source_record_id: `${record.artist_qid}@${record.artist_revision_id ?? "unknown"}#P136`,
      source_url: `${wikidataEntityRoot}/${record.artist_qid}.json`,
      claim: resolved.distance === 0
        ? `${record.artist_name} explicitly declares ${style.label} as a genre.`
        : `${record.artist_name} explicitly declares ancestor style ${allStylesByQid.get(resolved.assertedStyleQid)?.label ?? resolved.assertedStyleQid}; it is used as a ${resolved.distance}-edge fallback for ${style.label}.`,
      retrieved_at: representatives.retrieved_at,
      snapshot_version: representatives.snapshot_id,
      license_partition: "wikidata-cc0",
    });
    frontendStyles.push(frontendStyle(style, styleId, occurrenceArtistId));
    frontendArtists.push(frontendArtist({
      occurrenceId: occurrenceArtistId,
      canonicalArtistId,
      artistName: record.artist_name,
      styleId,
      mbid: record.artist_musicbrainz_mbid,
      qid: record.artist_qid,
      sourceUrl: `${wikidataEntityRoot}/${record.artist_qid}.json`,
      selectionBasis,
      assertedStyleId,
      ancestorDistance: resolved.distance,
      evidenceId,
      validation,
    }));
    frontendReleaseGroups.push(frontendRelease({
      occurrenceId: occurrenceReleaseId,
      canonicalReleaseId,
      artistOccurrenceId: occurrenceArtistId,
      releaseName: record.album_name,
      primaryType: "Album",
      secondaryTypes: [],
      firstReleaseDate: record.first_release_date,
      mbid: record.album_musicbrainz_release_group_mbid,
      qid: record.album_qid,
      sourceUrl: record.album_qid
        ? `${wikidataEntityRoot}/${record.album_qid}.json`
        : `https://musicbrainz.org/release-group/${record.album_musicbrainz_release_group_mbid}`,
      evidenceId,
      validation,
    }));
    appendSourceAssertions(entitySourceAssertions, {
      artistId: canonicalArtistId,
      releaseGroupId: canonicalReleaseId,
      artistMbid: record.artist_musicbrainz_mbid,
      releaseMbid: record.album_musicbrainz_release_group_mbid,
      artistQid: record.artist_qid,
      releaseQid: record.album_qid,
      artistDiscogsId: record.artist_discogs_id,
      releaseDiscogsMasterId: record.album_discogs_master_id,
      validation,
      sourceValidation,
      representatives,
    });
  }

  const { assertions: styleRelationsV2, evidence: relationEvidence } = buildStyleRelations({
    selectedStyles,
    styleIdByQid,
    styleCatalog,
  });
  const legacyRelationsV2 = adaptLegacyRelations(seed, styleRelationsV2);
  styleRelationsV2.push(...legacyRelationsV2.assertions);
  relationEvidence.push(...legacyRelationsV2.evidence);

  assertExactProjection(frontendStyles, frontendArtists, frontendReleaseGroups);
  const selectedArtistIds = new Set(frontendArtists.map((artist) => artist.internal_id));
  const frontendPaths = seed.paths.map((path) => ({
    ...path,
    artist_ids: path.artist_ids.filter((artistId) => selectedArtistIds.has(artistId)),
  }));
  for (const path of frontendPaths) {
    if (path.artist_ids.length === 0 || !selectedArtistIds.has(path.recording_artist_id)) {
      throw new Error(`Published path ${path.path_id} lost its required representative artist.`);
    }
  }
  const frontendRecordings = seed.recordings.filter((recording) =>
    recording.artist_ids.some((artistId) => selectedArtistIds.has(artistId))
  );
  const allEvidence = uniqueBy(
    [...seed.evidence, ...relationEvidence, ...associationEvidence],
    (record) => record.evidence_id,
  );
  const requiredPartitions = uniqueBy([
    ...seed.required_partitions,
    { partition_id: "wikidata-cc0", license: "CC0-1.0", status: "ready" },
    { partition_id: "musicbrainz-core-cc0", license: "CC0-1.0", status: "ready" },
    { partition_id: "discogs-cc0", license: "CC0-1.0", status: "ready" },
  ], (partition) => partition.partition_id);
  const validationCounts = countBy(
    representativeValidations,
    (record) => record.validation_status,
  );
  const representativeCandidateReviews = (sourceValidation.rejected_candidates ?? []).map((candidate) => {
    const styleId = styleIdByQid.get(candidate.style_qid);
    if (!styleId) throw new Error(`Rejected representative references unpublished style ${candidate.style_qid}.`);
    const resolution = sourceValidation.representative_replacements?.find(
      (record) => record.style_qid === candidate.style_qid &&
        record.artist_qid === candidate.artist_qid &&
        record.rejected_album_qid === candidate.rejected_album_qid,
    ) ?? null;
    return {
      review_id: `mw:representative-review:${candidate.style_qid.toLowerCase()}:${candidate.artist_qid.toLowerCase()}:${candidate.rejected_album_qid.toLowerCase()}`,
      style_id: styleId,
      candidate_artist_qid: candidate.artist_qid,
      candidate_album_qid: candidate.rejected_album_qid,
      review_status: candidate.resolution_status.replaceAll("-", "_"),
      conflict_codes: [...candidate.conflicts],
      resolution_payload: resolution ?? {},
      source_snapshot_ids: [
        representatives.snapshot_id,
        sourceValidation.sources.musicbrainz.snapshot_id,
        sourceValidation.sources.discogs.snapshot_id,
      ],
      reviewed_at: sourceValidation.retrieved_at,
    };
  });

  const canonical = {
    schema_version: "2.0",
    generation_id: generationId,
    generated_at: generatedAt,
    source_fingerprint_sha256: sourceFingerprintSha256,
    preserved_seed_artist_count: seed.artists.length,
    source_snapshots: [
      sourceSnapshot(styleCatalog, "wikidata", "wikidata-cc0"),
      sourceSnapshot(representatives, "wikidata", "wikidata-cc0"),
      sourceSnapshotFromValidation(sourceValidation.sources.musicbrainz, "musicbrainz"),
      sourceSnapshotFromValidation(sourceValidation.sources.discogs, "discogs"),
      {
        snapshot_id: "experiment-v1-musicbrainz-seed",
        source_name: "musicbrainz",
        upstream_version: seed.snapshot_id,
        retrieved_at: generatedAt,
        source_url: "https://musicbrainz.org/ws/2/",
        license_partition: "musicbrainz-core-cc0",
        redistributable: true,
      },
    ],
    styles: canonicalStyles,
    artists: [...canonicalArtists.values()],
    release_groups: [...canonicalReleaseGroups.values()],
    representative_artists: representativeArtists,
    representative_release_groups: representativeReleaseGroups,
    representative_validations: representativeValidations,
    representative_candidate_reviews: representativeCandidateReviews,
    entity_source_assertions: uniqueBy(entitySourceAssertions, (record) => record.assertion_id),
    source_entities: sourceEntitiesFromValidation(sourceValidation),
    style_relations_v2: styleRelationsV2,
    relation_evidence: relationEvidence,
    association_evidence: associationEvidence,
    catalog_evidence: allEvidence,
    frontend_context: {
      schema_version: "1.0",
      catalog_version: "2.0",
      preserved_seed_artist_count: seed.artists.length,
      sampling_note:
        "PostgreSQL-exported bounded projection: all 828 styles, exactly one representative artist occurrence and one representative album occurrence per style. Cross-source validation status remains explicit.",
      selection_policy: {
        style_count: 828,
        artist_occurrences_per_style: 1,
        release_group_occurrences_per_style: 1,
        representative_priority: ["curated-seed", "wikidata-direct-genre", "wikidata-ancestor-fallback"],
        validation_counts: validationCounts,
      },
      recordings: frontendRecordings,
      relations: seed.relations,
      paths: frontendPaths,
      required_partitions: requiredPartitions,
    },
  };
  const directCount = representativeArtists.filter(
    (row) => row.selection_basis === "wikidata-direct-genre",
  ).length;
  const fallbackCount = representativeArtists.filter(
    (row) => row.selection_basis === "wikidata-ancestor-fallback",
  ).length;
  const seedCount = representativeArtists.filter((row) => row.selection_basis === "curated-seed").length;
  return {
    canonical,
    summary: {
      styles: frontendStyles.length,
      canonical_artists: canonicalArtists.size,
      artist_occurrences: frontendArtists.length,
      canonical_release_groups: canonicalReleaseGroups.size,
      release_group_occurrences: frontendReleaseGroups.length,
      style_relations_v2: styleRelationsV2.length,
      curated_seed_associations: seedCount,
      direct_associations: directCount,
      ancestor_fallback_associations: fallbackCount,
      cross_verified_associations: validationCounts.cross_verified ?? 0,
      single_source_associations: validationCounts.single_source ?? 0,
      curated_associations: validationCounts.curated ?? 0,
      conflicted_associations: validationCounts.conflicted ?? 0,
    },
  };
}

function resolveRepresentative(styleQid, allStylesByQid, directByQid) {
  const direct = directByQid.get(styleQid);
  if (direct) return { record: direct, assertedStyleQid: styleQid, distance: 0 };
  const visited = new Set([styleQid]);
  let frontier = [styleQid];
  for (let distance = 1; frontier.length > 0; distance += 1) {
    const next = [];
    for (const currentQid of frontier) {
      const current = allStylesByQid.get(currentQid);
      for (const parentQid of [...(current?.parent_qids ?? [])].sort(compareQids)) {
        if (visited.has(parentQid)) continue;
        visited.add(parentQid);
        const representative = directByQid.get(parentQid);
        if (representative) {
          return { record: representative, assertedStyleQid: parentQid, distance };
        }
        if (allStylesByQid.has(parentQid)) next.push(parentQid);
      }
    }
    frontier = next;
  }
  throw new Error(`No evidenced representative artist/album pair found for ${styleQid} or its ancestors.`);
}

function buildStyleRelations({ selectedStyles, styleIdByQid, styleCatalog }) {
  const assertions = [];
  const evidence = [];
  for (const style of selectedStyles) {
    for (const parentQid of [...(style.parent_qids ?? [])].sort(compareQids)) {
      const targetId = styleIdByQid.get(parentQid);
      if (!targetId) continue;
      const sourceId = styleIdByQid.get(style.qid);
      const suffix = `wikidata:${style.qid.toLowerCase()}:p279:${parentQid.toLowerCase()}`;
      const evidenceId = `mw:evidence:${suffix}`;
      assertions.push({
        assertion_id: `mw:assertion:${suffix}`,
        relation_id: `mw:relation:${suffix}`,
        claim_key: `mw:claim:${suffix}`,
        relation_type: "subgenre_of",
        direction: "directed",
        participants: [
          { style_id: sourceId, role: "source", ordinal: 0 },
          { style_id: targetId, role: "target", ordinal: 0 },
        ],
        assertion_kind: "fact",
        stance: "supports",
        review_status: "accepted",
        metadata_completeness: "participants_only",
        claim_scope: { geographies: [], contexts: [] },
        time_context: null,
        confidence_band: "high",
        evidence_ids: [evidenceId],
        source_datasets: ["Wikidata"],
        snapshot_version: styleCatalog.snapshot_id,
        pipeline_version: "bounded-catalog-v2",
        license_partition: "wikidata-cc0",
      });
      evidence.push({
        evidence_id: evidenceId,
        source_dataset: "Wikidata",
        source_record_id: `${style.qid}@${style.source_revision_id ?? "unknown"}#P279`,
        source_url: `${wikidataEntityRoot}/${style.qid}.json`,
        claim: `${style.qid} declares subclass of ${parentQid}.`,
        retrieved_at: styleCatalog.retrieved_at,
        snapshot_version: styleCatalog.snapshot_id,
        license_partition: "wikidata-cc0",
      });
    }
  }
  return { assertions, evidence };
}

function adaptLegacyRelations(seed, existingAssertions) {
  const shapeKeys = new Set(existingAssertions.map(relationShapeKey));
  const evidenceById = new Map(seed.evidence.map((record) => [record.evidence_id, record]));
  const assertions = [];
  const evidence = [];
  for (const relation of seed.relations) {
    let relationType;
    let participants;
    if (relation.relation_type === "influenced_by") {
      relationType = "influences";
      participants = [
        { style_id: relation.target_id, role: "source", ordinal: 0 },
        { style_id: relation.source_id, role: "target", ordinal: 0 },
      ];
    } else if (relation.relation_type === "subgenre_of") {
      relationType = "subgenre_of";
      participants = [
        { style_id: relation.source_id, role: "source", ordinal: 0 },
        { style_id: relation.target_id, role: "target", ordinal: 0 },
      ];
    } else {
      continue;
    }
    const records = relation.evidence_ids.map((id) => requiredById(evidenceById, id, "relation evidence"));
    const partitions = new Set(records.map((record) => record.license_partition));
    if (partitions.size !== 1 || records.length === 0) continue;
    const assertion = {
      assertion_id: relation.internal_id.replace("mw:relation:", "mw:assertion:"),
      relation_id: relation.internal_id,
      claim_key: relation.internal_id.replace("mw:relation:", "mw:claim:"),
      relation_type: relationType,
      direction: "directed",
      participants,
      assertion_kind: relation.assertion_kind,
      stance: "supports",
      review_status: relation.assertion_kind === "candidate" ? "unreviewed" : "accepted",
      metadata_completeness: "participants_only",
      claim_scope: { geographies: [], contexts: [] },
      time_context: null,
      confidence_band: relation.assertion_kind === "fact" ? "high" : "medium",
      evidence_ids: [...relation.evidence_ids],
      source_datasets: [...new Set(records.map((record) => record.source_dataset))],
      snapshot_version: seed.snapshot_id,
      pipeline_version: "bounded-catalog-v2-seed-adapter",
      license_partition: records[0].license_partition,
    };
    const shapeKey = relationShapeKey(assertion);
    if (shapeKeys.has(shapeKey)) continue;
    shapeKeys.add(shapeKey);
    assertions.push(assertion);
    evidence.push(...records);
  }
  return { assertions, evidence: uniqueBy(evidence, (record) => record.evidence_id) };
}

function relationShapeKey(assertion) {
  return JSON.stringify({
    relation_type: assertion.relation_type,
    participants: [...assertion.participants].sort((left, right) =>
      left.role.localeCompare(right.role) || left.ordinal - right.ordinal ||
      left.style_id.localeCompare(right.style_id)
    ),
  });
}

function canonicalArtistIdFor(record, seedArtistByMbid, validation) {
  return (validation.musicbrainz_status === "verified"
    ? seedArtistByMbid.get(record.artist_musicbrainz_mbid)?.internal_id
    : null) ??
    `mw:artist:wikidata:${record.artist_qid.toLowerCase()}`;
}

function canonicalReleaseIdFor(record, canonicalArtistId, seedReleaseByMbid, validation) {
  const existing = validation.musicbrainz_status === "verified"
    ? seedReleaseByMbid.get(record.album_musicbrainz_release_group_mbid)
    : null;
  if (existing?.artist_ids.includes(canonicalArtistId)) return existing.internal_id;
  if (record.album_qid) return `mw:release-group:wikidata:${record.album_qid.toLowerCase()}`;
  if (validation.musicbrainz_status === "verified" && record.album_musicbrainz_release_group_mbid) {
    return `mw:release-group:musicbrainz:${record.album_musicbrainz_release_group_mbid}`;
  }
  throw new Error(`Release candidate for ${record.style_qid} has no accepted canonical identity.`);
}

function applyRepresentativeReplacement(record, validationDocument) {
  const replacement = validationDocument.representative_replacements?.find(
    (candidate) => candidate.style_qid === record.style_qid &&
      candidate.artist_qid === record.artist_qid &&
      candidate.rejected_album_qid === record.album_qid,
  );
  if (!replacement) return record;
  const release = replacement.replacement_release_group;
  return {
    ...record,
    artist_musicbrainz_mbid: replacement.artist_musicbrainz_mbid,
    artist_discogs_id: replacement.artist_discogs_id,
    album_qid: replacement.retain_wikidata_album ? record.album_qid : null,
    album_name: release?.title ?? record.album_name,
    album_sitelinks: replacement.retain_wikidata_album ? record.album_sitelinks : 0,
    album_musicbrainz_release_group_mbid: replacement.album_musicbrainz_release_group_mbid,
    album_discogs_master_id: replacement.album_discogs_master_id,
    album_revision_id: replacement.retain_wikidata_album ? record.album_revision_id : null,
    first_release_date: release?.first_release_date || record.first_release_date || null,
    release_resolution_basis: replacement.retain_wikidata_album
      ? "wikidata-performer-album"
      : "musicbrainz-credited-album-reconciliation",
    release_resolution_evidence_locator: replacement.evidence_locator,
  };
}

function representativeSeedRelease(seed, artistId) {
  const candidates = seed.release_groups.filter((release) => release.artist_ids.includes(artistId));
  candidates.sort((left, right) => compareNullableDates(left.first_release_date, right.first_release_date) ||
    left.internal_id.localeCompare(right.internal_id));
  const release = candidates[0];
  if (!release) throw new Error(`Seed representative artist ${artistId} has no release group.`);
  return release;
}

function frontendStyle(style, styleId, artistOccurrenceId, seedStyle = null) {
  return {
    internal_id: styleId,
    canonical_name: seedStyle?.canonical_name ?? style.label,
    description: style.description ?? "",
    era: seedStyle?.era ?? (style.origin_date
      ? `${style.origin_date.slice(0, 4)}s`
      : "Era not stated in Wikidata"),
    region: seedStyle?.region ?? nonEmptyJoined(style.country_labels) ?? "Region not stated in Wikidata",
    artist_ids: [artistOccurrenceId],
    wikidata_qid: style.qid,
    source_revision_id: style.source_revision_id ?? null,
    source_url: `${wikidataEntityRoot}/${style.qid}.json`,
  };
}

function nonEmptyJoined(values) {
  const joined = values?.join(" / ").trim();
  return joined || null;
}

function frontendArtist(options) {
  return {
    internal_id: options.occurrenceId,
    canonical_entity_id: options.canonicalArtistId,
    canonical_name: options.artistName,
    style_id: options.styleId,
    musicbrainz_mbid: options.mbid ?? null,
    wikidata_qid: options.qid,
    source_url: options.sourceUrl,
    association_basis: options.selectionBasis,
    asserted_style_id: options.assertedStyleId,
    ancestor_distance: options.ancestorDistance,
    evidence_id: options.evidenceId,
    validation_status: options.validation.validation_status,
    verified_sources: [...options.validation.verified_sources],
  };
}

function frontendRelease(options) {
  return {
    internal_id: options.occurrenceId,
    canonical_entity_id: options.canonicalReleaseId,
    canonical_name: options.releaseName,
    artist_ids: [options.artistOccurrenceId],
    primary_type: options.primaryType,
    secondary_types: [...options.secondaryTypes],
    first_release_date: options.firstReleaseDate,
    musicbrainz_mbid: options.mbid ?? null,
    wikidata_qid: options.qid,
    source_url: options.sourceUrl,
    evidence_id: options.evidenceId,
    validation_status: options.validation.validation_status,
    verified_sources: [...options.validation.verified_sources],
  };
}

function sourceSnapshot(source, sourceName, licensePartition) {
  return {
    snapshot_id: source.snapshot_id,
    source_name: sourceName,
    upstream_version: source.snapshot_id,
    retrieved_at: source.retrieved_at,
    source_url: source.source?.query_endpoint ?? "https://query.wikidata.org/sparql",
    license_partition: licensePartition,
    redistributable: true,
  };
}

function sourceSnapshotFromValidation(source, sourceName) {
  return {
    snapshot_id: source.snapshot_id,
    source_name: sourceName,
    upstream_version: source.snapshot_id,
    retrieved_at: source.retrieved_at,
    source_url: source.source_url,
    license_partition: source.license_partition,
    redistributable: true,
  };
}

function sourceEntitiesFromValidation(validation) {
  const musicbrainz = validation.sources.musicbrainz;
  const discogs = validation.sources.discogs;
  return [
    ...musicbrainz.artists.map((payload) => ({
      source_snapshot_id: musicbrainz.snapshot_id,
      source_entity_type: "artist",
      external_id: payload.id,
      payload,
    })),
    ...musicbrainz.release_groups.map((payload) => ({
      source_snapshot_id: musicbrainz.snapshot_id,
      source_entity_type: "release_group",
      external_id: payload.id,
      payload,
    })),
    ...discogs.artists.map((payload) => ({
      source_snapshot_id: discogs.snapshot_id,
      source_entity_type: "artist",
      external_id: String(payload.id),
      payload,
    })),
    ...discogs.masters.map((payload) => ({
      source_snapshot_id: discogs.snapshot_id,
      source_entity_type: "release_group",
      external_id: String(payload.id),
      payload,
    })),
  ];
}

function appendSourceAssertions(target, options) {
  const add = (record) => target.push({
    assertion_id: `mw:source-assertion:${record.source}:${record.entity_type}:${record.external_id}`,
    internal_id: record.internal_id,
    entity_type: record.entity_type,
    source_snapshot_id: record.source_snapshot_id,
    source_name: record.source,
    assertion_kind: record.assertion_kind ?? "identity",
    external_namespace: record.external_namespace,
    external_id: String(record.external_id),
    verification_status: record.verification_status,
    evidence_locator: record.evidence_locator,
    assertion_payload: record.assertion_payload ?? {},
  });

  if (options.artistQid) {
    add({
      source: "wikidata",
      entity_type: "artist",
      internal_id: options.artistId,
      source_snapshot_id: options.representatives.snapshot_id,
      external_namespace: "wikidata-item",
      external_id: options.artistQid,
      verification_status: options.validation.validation_status === "cross_verified"
        ? "corroborated"
        : "observed",
      evidence_locator: `entities.${options.artistQid}`,
    });
  }
  if (options.releaseQid) {
    add({
      source: "wikidata",
      entity_type: "release_group",
      internal_id: options.releaseGroupId,
      source_snapshot_id: options.representatives.snapshot_id,
      external_namespace: "wikidata-item",
      external_id: options.releaseQid,
      verification_status: options.validation.validation_status === "cross_verified"
        ? "corroborated"
        : "observed",
      evidence_locator: `entities.${options.releaseQid}`,
    });
  }
  if (options.validation.musicbrainz_status === "verified") {
    add({
      source: "musicbrainz",
      entity_type: "artist",
      internal_id: options.artistId,
      source_snapshot_id: options.sourceValidation.sources.musicbrainz.snapshot_id,
      external_namespace: "musicbrainz-artist",
      external_id: options.artistMbid,
      verification_status: "corroborated",
      evidence_locator: `artists.${options.artistMbid}`,
    });
    add({
      source: "musicbrainz",
      entity_type: "release_group",
      internal_id: options.releaseGroupId,
      source_snapshot_id: options.sourceValidation.sources.musicbrainz.snapshot_id,
      external_namespace: "musicbrainz-release-group",
      external_id: options.releaseMbid,
      verification_status: "corroborated",
      evidence_locator: `release_groups.${options.releaseMbid}`,
    });
    add({
      source: "musicbrainz",
      entity_type: "release_group",
      internal_id: options.releaseGroupId,
      source_snapshot_id: options.sourceValidation.sources.musicbrainz.snapshot_id,
      external_namespace: "musicbrainz-artist-credit",
      external_id: `${options.releaseMbid}:${options.artistMbid}`,
      assertion_kind: "credit",
      verification_status: "corroborated",
      evidence_locator: `release_groups.${options.releaseMbid}.artist_credit_ids`,
      assertion_payload: { artist_id: options.artistId },
    });
  }
  if (options.validation.discogs_status === "verified") {
    add({
      source: "discogs",
      entity_type: "artist",
      internal_id: options.artistId,
      source_snapshot_id: options.sourceValidation.sources.discogs.snapshot_id,
      external_namespace: "discogs-artist",
      external_id: options.artistDiscogsId,
      verification_status: "corroborated",
      evidence_locator: `artists.${options.artistDiscogsId}`,
    });
    if (options.releaseDiscogsMasterId) {
      add({
        source: "discogs",
        entity_type: "release_group",
        internal_id: options.releaseGroupId,
        source_snapshot_id: options.sourceValidation.sources.discogs.snapshot_id,
        external_namespace: "discogs-master",
        external_id: options.releaseDiscogsMasterId,
        verification_status: "corroborated",
        evidence_locator: `masters.${options.releaseDiscogsMasterId}`,
      });
      add({
        source: "discogs",
        entity_type: "release_group",
        internal_id: options.releaseGroupId,
        source_snapshot_id: options.sourceValidation.sources.discogs.snapshot_id,
        external_namespace: "discogs-artist-credit",
        external_id: `${options.releaseDiscogsMasterId}:${options.artistDiscogsId}`,
        assertion_kind: "credit",
        verification_status: "corroborated",
        evidence_locator: `masters.${options.releaseDiscogsMasterId}.artist_ids`,
        assertion_payload: { artist_id: options.artistId },
      });
    }
  }
}

function representativeConfidence(selectionBasis, validation) {
  if (selectionBasis === "curated-seed") return "high";
  if (selectionBasis === "wikidata-ancestor-fallback") {
    return validation.validation_status === "cross_verified" ? "medium" : "low";
  }
  return validation.validation_status === "cross_verified" ? "high" : "medium";
}

function assertNoSourceConflict(styleId, validation) {
  if (validation.validation_status === "conflicted") {
    throw new Error(`Cross-source conflict for ${styleId}: ${validation.conflicts.join(" ")}`);
  }
}

function countBy(values, key) {
  const result = {};
  for (const value of values) {
    const bucket = key(value);
    result[bucket] = (result[bucket] ?? 0) + 1;
  }
  return result;
}

function assertExactProjection(styles, artists, releases) {
  if (styles.length !== 828 || artists.length !== 828 || releases.length !== 828) {
    throw new Error(
      `Frontend projection must be 828/828/828, got ${styles.length}/${artists.length}/${releases.length}.`,
    );
  }
  if (new Set(styles.map((style) => style.internal_id)).size !== 828 ||
      new Set(artists.map((artist) => artist.internal_id)).size !== 828 ||
      new Set(releases.map((release) => release.internal_id)).size !== 828) {
    throw new Error("Frontend projection contains duplicate occurrence IDs.");
  }
  const artistIds = new Set(artists.map((artist) => artist.internal_id));
  const releaseArtistIds = new Set(releases.flatMap((release) => release.artist_ids));
  for (const style of styles) {
    if (style.artist_ids.length !== 1 || !artistIds.has(style.artist_ids[0])) {
      throw new Error(`Style ${style.internal_id} does not have exactly one valid artist occurrence.`);
    }
  }
  if (releaseArtistIds.size !== 828 || [...artistIds].some((id) => !releaseArtistIds.has(id))) {
    throw new Error("Every artist occurrence must have exactly one release-group occurrence.");
  }
}

function requiredById(collection, id, kind) {
  const value = collection instanceof Map
    ? collection.get(id)
    : collection.find((item) => item.internal_id === id || item.evidence_id === id);
  if (!value) throw new Error(`Missing ${kind} ${id}.`);
  return value;
}

function uniqueBy(values, keyFor) {
  return [...new Map(values.map((value) => [keyFor(value), value])).values()];
}

function compareQids(left, right) {
  return Number(left.slice(1)) - Number(right.slice(1));
}

function compareNullableDates(left, right) {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left.localeCompare(right);
}
