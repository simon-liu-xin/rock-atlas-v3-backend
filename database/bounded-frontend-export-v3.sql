WITH context AS (
  SELECT payload
  FROM __SCHEMA__.frontend_projection_context
  WHERE context_key = 'catalog'
),
publication AS (
  SELECT * FROM __SCHEMA__.catalog_publication
  LIMIT 1
),
styles AS (
  SELECT jsonb_agg(jsonb_build_object(
    'internal_id', style.internal_id,
    'canonical_name', style.canonical_name,
    'description', style.description,
    'era', COALESCE(style.origin_date_text, 'Era not stated in Wikidata'),
    'region', COALESCE(style.region_text, 'Region not stated in Wikidata'),
    'artist_ids', jsonb_build_array(representative.occurrence_id),
    'wikidata_qid', style.source_metadata->>'wikidata_qid',
    'source_revision_id', style.source_metadata->>'source_revision_id',
    'source_url', style.source_metadata->>'source_url'
  ) ORDER BY style.internal_id) AS value
  FROM __SCHEMA__.style style
  JOIN __SCHEMA__.style_representative_artist representative
    ON representative.style_id = style.internal_id
),
artists AS (
  SELECT jsonb_agg(jsonb_build_object(
    'internal_id', representative.occurrence_id,
    'canonical_entity_id', artist.internal_id,
    'canonical_name', artist.canonical_name,
    'style_id', representative.style_id,
    'musicbrainz_mbid', NULLIF(artist.source_metadata->>'musicbrainz_mbid', ''),
    'wikidata_qid', NULLIF(artist.source_metadata->>'wikidata_qid', ''),
    'discogs_id', NULLIF(artist.source_metadata->>'discogs_id', ''),
    'source_url', artist.source_metadata->>'source_url',
    'association_basis', representative.selection_basis,
    'asserted_style_id', representative.asserted_style_id,
    'ancestor_distance', representative.ancestor_distance,
    'evidence_id', representative.evidence_id,
    'validation_status', representative.validation_status,
    'verified_sources', to_jsonb(representative.verified_sources)
  ) ORDER BY representative.style_id) AS value
  FROM __SCHEMA__.style_representative_artist representative
  JOIN __SCHEMA__.artist artist ON artist.internal_id = representative.artist_id
),
release_groups AS (
  SELECT jsonb_agg(jsonb_build_object(
    'internal_id', selected_release.occurrence_id,
    'canonical_entity_id', release_group.internal_id,
    'canonical_name', release_group.canonical_name,
    'artist_ids', jsonb_build_array(selected_artist.occurrence_id),
    'primary_type', release_group.primary_type,
    'secondary_types', to_jsonb(release_group.secondary_types),
    'first_release_date', release_group.first_release_date_text,
    'musicbrainz_mbid', NULLIF(release_group.source_metadata->>'musicbrainz_mbid', ''),
    'wikidata_qid', NULLIF(release_group.source_metadata->>'wikidata_qid', ''),
    'discogs_master_id', NULLIF(release_group.source_metadata->>'discogs_master_id', ''),
    'source_url', release_group.source_metadata->>'source_url',
    'evidence_id', selected_release.evidence_id,
    'validation_status', selected_release.validation_status,
    'verified_sources', to_jsonb(selected_release.verified_sources)
  ) ORDER BY selected_release.style_id) AS value
  FROM __SCHEMA__.style_representative_release_group selected_release
  JOIN __SCHEMA__.style_representative_artist selected_artist
    ON selected_artist.style_id = selected_release.style_id
   AND selected_artist.artist_id = selected_release.artist_id
  JOIN __SCHEMA__.release_group release_group
    ON release_group.internal_id = selected_release.release_group_id
),
relations_v2 AS (
  SELECT jsonb_agg(jsonb_build_object(
    'assertion_id', assertion.assertion_id,
    'relation_id', assertion.relation_id,
    'claim_key', assertion.claim_key,
    'relation_type', relation.relation_kind,
    'direction', relation.direction,
    'participants', (
      SELECT jsonb_agg(jsonb_build_object(
        'style_id', participant.style_id,
        'role', participant.participant_role,
        'ordinal', participant.ordinal
      ) ORDER BY participant.participant_role, participant.ordinal, participant.style_id)
      FROM __SCHEMA__.style_relation_participant participant
      WHERE participant.relation_id = relation.relation_id
    ),
    'assertion_kind', assertion.assertion_kind,
    'stance', assertion.stance,
    'review_status', assertion.review_status,
    'metadata_completeness', assertion.metadata_completeness,
    'claim_scope', jsonb_build_object(
      'geographies', to_jsonb(assertion.claim_geographies),
      'contexts', to_jsonb(assertion.claim_contexts)
    ),
    'time_context', CASE
      WHEN assertion.time_start IS NULL AND assertion.time_end IS NULL THEN NULL
      ELSE jsonb_build_object(
        'start', to_jsonb(assertion.time_start),
        'end', to_jsonb(assertion.time_end),
        'precision', assertion.time_precision
      )
    END,
    'confidence_band', assertion.confidence_band,
    'evidence_ids', COALESCE((
      SELECT jsonb_agg(link.evidence_id ORDER BY link.evidence_id)
      FROM __SCHEMA__.style_relation_assertion_evidence_v2 link
      WHERE link.assertion_id = assertion.assertion_id
    ), '[]'::jsonb),
    'source_datasets', to_jsonb(assertion.source_datasets),
    'snapshot_version', assertion.snapshot_version,
    'pipeline_version', assertion.pipeline_version,
    'license_partition', assertion.license_partition
  ) ORDER BY assertion.assertion_id) AS value
  FROM __SCHEMA__.style_relation_assertion_v2 assertion
  JOIN __SCHEMA__.style_relation relation USING (relation_id)
),
evidence AS (
  SELECT jsonb_agg(jsonb_build_object(
    'evidence_id', evidence.evidence_id,
    'source_dataset', evidence.source_dataset,
    'source_record_id', evidence.source_record_id,
    'source_url', evidence.source_url,
    'claim', evidence.claim_text,
    'retrieved_at', to_jsonb(evidence.retrieved_at),
    'snapshot_version', evidence.snapshot_version,
    'license_partition', evidence.license_partition
  ) ORDER BY evidence.evidence_id) AS value
  FROM __SCHEMA__.catalog_evidence evidence
)
SELECT jsonb_build_object(
  'schema_version', context.payload->'schema_version',
  'catalog_version', context.payload->'catalog_version',
  'snapshot_id', publication.generation_id,
  'generated_at', to_jsonb(publication.generated_at),
  'source_fingerprint_sha256', publication.source_fingerprint_sha256,
  'preserved_seed_artist_count', context.payload->'preserved_seed_artist_count',
  'sampling_note', context.payload->'sampling_note',
  'selection_policy', context.payload->'selection_policy',
  'styles', styles.value,
  'artists', artists.value,
  'release_groups', release_groups.value,
  'recordings', context.payload->'recordings',
  'relations', context.payload->'relations',
  'style_relations_v2', relations_v2.value,
  'evidence', evidence.value,
  'paths', context.payload->'paths',
  'required_partitions', context.payload->'required_partitions'
)::text
FROM context, publication, styles, artists, release_groups, relations_v2, evidence;
