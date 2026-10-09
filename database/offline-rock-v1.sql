BEGIN;

CREATE SCHEMA IF NOT EXISTS mw_offline;

CREATE TABLE IF NOT EXISTS mw_offline.source_snapshot (
  snapshot_id text PRIMARY KEY,
  source_name text NOT NULL CHECK (source_name IN ('musicbrainz', 'discogs', 'wikidata')),
  upstream_version text NOT NULL,
  retrieved_at timestamptz NOT NULL,
  source_url text NOT NULL,
  checksum_algorithm text,
  checksum_value text,
  license_partition text NOT NULL,
  redistributable boolean NOT NULL,
  status text NOT NULL CHECK (status IN ('staged', 'validated', 'published', 'superseded', 'failed'))
);

CREATE TABLE IF NOT EXISTS mw_offline.ingestion_checkpoint (
  pipeline_name text PRIMARY KEY,
  source_snapshot_id text REFERENCES mw_offline.source_snapshot(snapshot_id),
  cursor_value text,
  updated_at timestamptz NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS mw_offline.source_entity (
  source_snapshot_id text NOT NULL REFERENCES mw_offline.source_snapshot(snapshot_id),
  source_entity_type text NOT NULL,
  external_id text NOT NULL,
  payload jsonb NOT NULL,
  payload_sha256 text NOT NULL,
  PRIMARY KEY (source_snapshot_id, source_entity_type, external_id)
);

CREATE TABLE IF NOT EXISTS mw_offline.entity_source_assertion (
  assertion_id text PRIMARY KEY CHECK (assertion_id LIKE 'mw:source-assertion:%'),
  entity_type text NOT NULL CHECK (entity_type IN ('artist', 'release_group')),
  internal_id text NOT NULL,
  source_snapshot_id text NOT NULL REFERENCES mw_offline.source_snapshot(snapshot_id),
  source_name text NOT NULL CHECK (source_name IN ('musicbrainz', 'discogs', 'wikidata')),
  assertion_kind text NOT NULL CHECK (assertion_kind IN ('identity', 'credit')),
  external_namespace text NOT NULL,
  external_id text NOT NULL,
  verification_status text NOT NULL CHECK (
    verification_status IN ('observed', 'corroborated', 'unresolved', 'disputed')
  ),
  evidence_locator text NOT NULL,
  assertion_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (source_snapshot_id, external_namespace, external_id, assertion_kind)
);

CREATE TABLE IF NOT EXISTS mw_offline.catalog_evidence (
  evidence_id text PRIMARY KEY CHECK (evidence_id LIKE 'mw:evidence:%'),
  source_dataset text NOT NULL,
  source_record_id text NOT NULL,
  source_url text NOT NULL,
  claim_text text NOT NULL,
  retrieved_at timestamptz NOT NULL,
  snapshot_version text NOT NULL,
  license_partition text NOT NULL
);

CREATE TABLE IF NOT EXISTS mw_offline.frontend_projection_context (
  context_key text PRIMARY KEY,
  payload jsonb NOT NULL,
  source_snapshot_id text NOT NULL REFERENCES mw_offline.source_snapshot(snapshot_id),
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$')
);

CREATE TABLE IF NOT EXISTS mw_offline.style (
  internal_id text PRIMARY KEY CHECK (internal_id LIKE 'mw:style:%'),
  canonical_name text NOT NULL,
  sort_name text NOT NULL,
  description text NOT NULL DEFAULT '',
  origin_date_text text,
  region_text text,
  source_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  inclusion_status text NOT NULL CHECK (inclusion_status IN ('accepted', 'candidate', 'rejected')),
  first_seen_snapshot_id text NOT NULL REFERENCES mw_offline.source_snapshot(snapshot_id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz
);

CREATE TABLE IF NOT EXISTS mw_offline.representative_candidate_review (
  review_id text PRIMARY KEY CHECK (review_id LIKE 'mw:representative-review:%'),
  style_id text NOT NULL REFERENCES mw_offline.style(internal_id),
  candidate_artist_qid text NOT NULL CHECK (candidate_artist_qid ~ '^Q[0-9]+$'),
  candidate_album_qid text NOT NULL CHECK (candidate_album_qid ~ '^Q[0-9]+$'),
  review_status text NOT NULL CHECK (
    review_status IN ('reconciled', 'rejected_for_ancestor_fallback')
  ),
  conflict_codes text[] NOT NULL CHECK (cardinality(conflict_codes) > 0),
  resolution_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_snapshot_ids text[] NOT NULL CHECK (cardinality(source_snapshot_ids) >= 2),
  reviewed_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS mw_offline.artist (
  internal_id text PRIMARY KEY CHECK (internal_id LIKE 'mw:artist:%'),
  canonical_name text NOT NULL,
  sort_name text NOT NULL,
  artist_type text,
  description text NOT NULL DEFAULT '',
  begin_date_text text,
  end_date_text text,
  country_code text,
  source_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_seen_snapshot_id text NOT NULL REFERENCES mw_offline.source_snapshot(snapshot_id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz
);

CREATE TABLE IF NOT EXISTS mw_offline.artist_alias (
  artist_id text NOT NULL REFERENCES mw_offline.artist(internal_id),
  alias text NOT NULL,
  locale text,
  alias_type text,
  source_snapshot_id text NOT NULL REFERENCES mw_offline.source_snapshot(snapshot_id),
  PRIMARY KEY (artist_id, alias, locale, source_snapshot_id)
);

CREATE TABLE IF NOT EXISTS mw_offline.release_group (
  internal_id text PRIMARY KEY CHECK (internal_id LIKE 'mw:release-group:%'),
  canonical_name text NOT NULL,
  primary_type text NOT NULL,
  secondary_types text[] NOT NULL DEFAULT '{}',
  first_release_date_text text,
  description text NOT NULL DEFAULT '',
  cover_art_url text CHECK (cover_art_url IS NULL OR cover_art_url LIKE 'https://%'),
  cover_art_source text,
  source_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_seen_snapshot_id text NOT NULL REFERENCES mw_offline.source_snapshot(snapshot_id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz
);

CREATE TABLE IF NOT EXISTS mw_offline.release_group_artist (
  release_group_id text NOT NULL REFERENCES mw_offline.release_group(internal_id),
  artist_id text NOT NULL REFERENCES mw_offline.artist(internal_id),
  credit_position integer NOT NULL,
  credited_name text,
  join_phrase text,
  PRIMARY KEY (release_group_id, credit_position)
);

CREATE TABLE IF NOT EXISTS mw_offline.release (
  internal_id text PRIMARY KEY CHECK (internal_id LIKE 'mw:release:%'),
  release_group_id text NOT NULL REFERENCES mw_offline.release_group(internal_id),
  title text NOT NULL,
  release_date_text text,
  country_code text,
  status text,
  packaging text,
  barcode text,
  first_seen_snapshot_id text NOT NULL REFERENCES mw_offline.source_snapshot(snapshot_id),
  retired_at timestamptz
);

CREATE TABLE IF NOT EXISTS mw_offline.release_event (
  release_id text NOT NULL REFERENCES mw_offline.release(internal_id),
  event_position integer NOT NULL CHECK (event_position > 0),
  country_code text,
  date_year smallint,
  date_month smallint CHECK (date_month BETWEEN 1 AND 12),
  date_day smallint CHECK (date_day BETWEEN 1 AND 31),
  source_snapshot_id text NOT NULL REFERENCES mw_offline.source_snapshot(snapshot_id),
  PRIMARY KEY (release_id, event_position)
);

CREATE TABLE IF NOT EXISTS mw_offline.medium (
  release_id text NOT NULL REFERENCES mw_offline.release(internal_id),
  position integer NOT NULL,
  format_name text,
  track_count integer,
  PRIMARY KEY (release_id, position)
);

CREATE TABLE IF NOT EXISTS mw_offline.recording (
  internal_id text PRIMARY KEY CHECK (internal_id LIKE 'mw:recording:%'),
  canonical_name text NOT NULL,
  length_ms integer,
  video boolean NOT NULL DEFAULT false,
  first_seen_snapshot_id text NOT NULL REFERENCES mw_offline.source_snapshot(snapshot_id),
  retired_at timestamptz
);

CREATE TABLE IF NOT EXISTS mw_offline.recording_artist (
  recording_id text NOT NULL REFERENCES mw_offline.recording(internal_id),
  artist_id text NOT NULL REFERENCES mw_offline.artist(internal_id),
  credit_position integer NOT NULL,
  credited_name text,
  join_phrase text,
  PRIMARY KEY (recording_id, credit_position)
);

CREATE TABLE IF NOT EXISTS mw_offline.track (
  release_id text NOT NULL,
  medium_position integer NOT NULL,
  position integer NOT NULL,
  recording_id text REFERENCES mw_offline.recording(internal_id),
  title text NOT NULL,
  number_text text,
  length_ms integer,
  PRIMARY KEY (release_id, medium_position, position),
  FOREIGN KEY (release_id, medium_position)
    REFERENCES mw_offline.medium(release_id, position)
);

CREATE TABLE IF NOT EXISTS mw_offline.external_identity (
  internal_id text NOT NULL,
  namespace text NOT NULL,
  external_id text NOT NULL,
  source_snapshot_id text NOT NULL REFERENCES mw_offline.source_snapshot(snapshot_id),
  assertion_status text NOT NULL CHECK (assertion_status IN ('accepted', 'conflicted', 'retired')),
  PRIMARY KEY (namespace, external_id, source_snapshot_id)
);

CREATE TABLE IF NOT EXISTS mw_offline.identity_evidence (
  evidence_id text PRIMARY KEY,
  entity_type text NOT NULL CHECK (entity_type IN ('artist', 'release_group', 'release', 'style')),
  evidence_source text NOT NULL CHECK (
    evidence_source IN ('musicbrainz-url', 'wikidata-claims', 'discogs-url', 'manual-evidence')
  ),
  source_snapshot_id text NOT NULL REFERENCES mw_offline.source_snapshot(snapshot_id),
  evidence_locator text NOT NULL,
  evidence_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mw_offline.identity_evidence_identifier (
  evidence_id text NOT NULL REFERENCES mw_offline.identity_evidence(evidence_id) ON DELETE CASCADE,
  namespace text NOT NULL,
  external_id text NOT NULL,
  PRIMARY KEY (evidence_id, namespace, external_id)
);

CREATE TABLE IF NOT EXISTS mw_offline.identity_component (
  component_id text PRIMARY KEY,
  entity_type text NOT NULL CHECK (entity_type IN ('artist', 'release_group', 'release', 'style')),
  canonical_internal_id text,
  decision_status text NOT NULL CHECK (decision_status IN ('accepted', 'conflicted', 'pending')),
  identifier_count integer NOT NULL CHECK (identifier_count > 0),
  evidence_count integer NOT NULL CHECK (evidence_count > 0),
  decision_details jsonb NOT NULL DEFAULT '{}'::jsonb,
  decided_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (decision_status = 'accepted' AND canonical_internal_id IS NOT NULL) OR
    (decision_status <> 'accepted' AND canonical_internal_id IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS mw_offline.identity_component_identifier (
  component_id text NOT NULL REFERENCES mw_offline.identity_component(component_id) ON DELETE CASCADE,
  namespace text NOT NULL,
  external_id text NOT NULL,
  PRIMARY KEY (component_id, namespace, external_id)
);

CREATE TABLE IF NOT EXISTS mw_offline.identity_component_evidence (
  component_id text NOT NULL REFERENCES mw_offline.identity_component(component_id) ON DELETE CASCADE,
  evidence_id text NOT NULL REFERENCES mw_offline.identity_evidence(evidence_id),
  PRIMARY KEY (component_id, evidence_id)
);

CREATE TABLE IF NOT EXISTS mw_offline.identity_conflict_queue (
  component_id text PRIMARY KEY REFERENCES mw_offline.identity_component(component_id) ON DELETE CASCADE,
  conflict_namespaces text[] NOT NULL,
  resolution_status text NOT NULL CHECK (resolution_status IN ('open', 'accepted', 'rejected')),
  resolution_evidence_locator text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mw_offline.artist_style_assertion (
  artist_id text NOT NULL REFERENCES mw_offline.artist(internal_id),
  style_id text NOT NULL REFERENCES mw_offline.style(internal_id),
  source_snapshot_id text NOT NULL REFERENCES mw_offline.source_snapshot(snapshot_id),
  assertion_basis text NOT NULL CHECK (
    assertion_basis IN (
      'wikidata-direct-genre',
      'curated-seed',
      'manual-evidence'
    )
  ),
  confidence_status text NOT NULL CHECK (confidence_status IN ('observed', 'inferred', 'disputed')),
  evidence_locator text NOT NULL,
  PRIMARY KEY (artist_id, style_id, source_snapshot_id, assertion_basis)
);

-- Release-level classifications are source facts. They must not be copied into
-- artist_style_assertion, because a credited artist is not thereby proven to
-- have a direct style assertion.
CREATE TABLE IF NOT EXISTS mw_offline.release_style_assertion (
  release_group_id text NOT NULL REFERENCES mw_offline.release_group(internal_id),
  style_id text NOT NULL REFERENCES mw_offline.style(internal_id),
  source_snapshot_id text NOT NULL REFERENCES mw_offline.source_snapshot(snapshot_id),
  assertion_basis text NOT NULL CHECK (
    assertion_basis IN ('discogs-release-style', 'musicbrainz-release-group-tag', 'manual-evidence')
  ),
  confidence_status text NOT NULL CHECK (confidence_status IN ('observed', 'inferred', 'disputed')),
  evidence_locators text[] NOT NULL CHECK (cardinality(evidence_locators) > 0),
  PRIMARY KEY (release_group_id, style_id, source_snapshot_id, assertion_basis)
);

-- Artist qualification is an explicit derived relation. It remains separate
-- from direct artist facts and retains the complete source-release lineage.
CREATE TABLE IF NOT EXISTS mw_offline.artist_style_qualification (
  artist_id text NOT NULL REFERENCES mw_offline.artist(internal_id),
  style_id text NOT NULL REFERENCES mw_offline.style(internal_id),
  source_snapshot_id text NOT NULL REFERENCES mw_offline.source_snapshot(snapshot_id),
  derivation_rule_version text NOT NULL,
  source_release_group_ids text[] NOT NULL CHECK (cardinality(source_release_group_ids) > 0),
  evidence_locators text[] NOT NULL CHECK (cardinality(evidence_locators) > 0),
  confidence_status text NOT NULL CHECK (confidence_status IN ('derived', 'disputed')),
  PRIMARY KEY (artist_id, style_id, source_snapshot_id, derivation_rule_version)
);

-- Canonical artist entities are shared. This table records the one artist selected
-- for each style in a bounded frontend generation without duplicating that artist.
CREATE TABLE IF NOT EXISTS mw_offline.style_representative_artist (
  style_id text PRIMARY KEY REFERENCES mw_offline.style(internal_id),
  artist_id text NOT NULL REFERENCES mw_offline.artist(internal_id),
  asserted_style_id text NOT NULL REFERENCES mw_offline.style(internal_id),
  source_snapshot_id text NOT NULL REFERENCES mw_offline.source_snapshot(snapshot_id),
  selection_basis text NOT NULL CHECK (
    selection_basis IN ('wikidata-direct-genre', 'wikidata-ancestor-fallback', 'curated-seed')
  ),
  confidence_band text NOT NULL CHECK (confidence_band IN ('low', 'medium', 'high')),
  ancestor_distance smallint NOT NULL CHECK (ancestor_distance >= 0),
  selection_score integer,
  evidence_locator text NOT NULL,
  occurrence_id text NOT NULL UNIQUE CHECK (occurrence_id LIKE 'mw:%'),
  evidence_id text NOT NULL REFERENCES mw_offline.catalog_evidence(evidence_id),
  validation_status text NOT NULL CHECK (
    validation_status IN ('cross_verified', 'single_source', 'curated')
  ),
  verified_sources text[] NOT NULL DEFAULT '{}',
  musicbrainz_status text NOT NULL CHECK (
    musicbrainz_status IN ('verified', 'unresolved', 'not_applicable')
  ),
  discogs_status text NOT NULL CHECK (
    discogs_status IN ('verified', 'unresolved', 'not_applicable')
  ),
  conflict_details jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (
    jsonb_typeof(conflict_details) = 'array' AND jsonb_array_length(conflict_details) = 0
  ),
  selected_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (style_id, artist_id),
  CHECK (
    (
      selection_basis IN ('wikidata-direct-genre', 'curated-seed')
      AND style_id = asserted_style_id
      AND ancestor_distance = 0
    ) OR (
      selection_basis = 'wikidata-ancestor-fallback'
      AND style_id <> asserted_style_id
      AND ancestor_distance > 0
    )
  )
);

CREATE TABLE IF NOT EXISTS mw_offline.style_representative_release_group (
  style_id text PRIMARY KEY,
  artist_id text NOT NULL,
  release_group_id text NOT NULL REFERENCES mw_offline.release_group(internal_id),
  source_snapshot_id text NOT NULL REFERENCES mw_offline.source_snapshot(snapshot_id),
  selection_basis text NOT NULL CHECK (
    selection_basis IN (
      'wikidata-performer-album',
      'musicbrainz-credited-album-reconciliation',
      'curated-seed'
    )
  ),
  selection_score integer,
  evidence_locator text NOT NULL,
  occurrence_id text NOT NULL UNIQUE CHECK (occurrence_id LIKE 'mw:%'),
  evidence_id text NOT NULL REFERENCES mw_offline.catalog_evidence(evidence_id),
  validation_status text NOT NULL CHECK (
    validation_status IN ('cross_verified', 'single_source', 'curated')
  ),
  verified_sources text[] NOT NULL DEFAULT '{}',
  musicbrainz_status text NOT NULL CHECK (
    musicbrainz_status IN ('verified', 'unresolved', 'not_applicable')
  ),
  discogs_status text NOT NULL CHECK (
    discogs_status IN ('verified', 'unresolved', 'not_applicable')
  ),
  conflict_details jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (
    jsonb_typeof(conflict_details) = 'array' AND jsonb_array_length(conflict_details) = 0
  ),
  selected_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (style_id, artist_id)
    REFERENCES mw_offline.style_representative_artist(style_id, artist_id)
);

CREATE TABLE IF NOT EXISTS mw_offline.catalog_publication (
  generation_id text PRIMARY KEY CHECK (generation_id ~ '^rock-catalog-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$'),
  source_fingerprint_sha256 text NOT NULL UNIQUE CHECK (source_fingerprint_sha256 ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN ('staged', 'validated', 'published', 'superseded', 'failed')),
  style_count integer NOT NULL CHECK (style_count > 0),
  representative_artist_count integer NOT NULL CHECK (representative_artist_count = style_count),
  representative_release_group_count integer NOT NULL CHECK (
    representative_release_group_count = style_count
  ),
  cross_verified_count integer NOT NULL CHECK (cross_verified_count >= 0),
  single_source_count integer NOT NULL CHECK (single_source_count >= 0),
  curated_count integer NOT NULL CHECK (curated_count >= 0),
  conflicted_count integer NOT NULL CHECK (conflicted_count = 0),
  relation_count integer NOT NULL CHECK (relation_count >= 0),
  frontend_export_path text,
  frontend_export_sha256 text CHECK (
    frontend_export_sha256 IS NULL OR frontend_export_sha256 ~ '^[a-f0-9]{64}$'
  ),
  generated_at timestamptz NOT NULL,
  published_at timestamptz,
  CHECK (
    (status = 'published' AND frontend_export_path IS NOT NULL
      AND frontend_export_sha256 IS NOT NULL AND published_at IS NOT NULL)
    OR status <> 'published'
  ),
  CHECK (cross_verified_count + single_source_count + curated_count = style_count)
);

CREATE TABLE IF NOT EXISTS mw_offline.style_relation_assertion (
  from_style_id text NOT NULL REFERENCES mw_offline.style(internal_id),
  to_style_id text NOT NULL REFERENCES mw_offline.style(internal_id),
  relation_kind text NOT NULL CHECK (
    relation_kind IN ('subgenre_of', 'influenced_by', 'fusion_of', 'co_tagged_with')
  ),
  source_snapshot_id text NOT NULL REFERENCES mw_offline.source_snapshot(snapshot_id),
  confidence_status text NOT NULL CHECK (confidence_status IN ('observed', 'inferred', 'disputed')),
  evidence_locator text NOT NULL,
  PRIMARY KEY (from_style_id, to_style_id, relation_kind, source_snapshot_id)
);

CREATE INDEX IF NOT EXISTS artist_sort_name_idx ON mw_offline.artist (sort_name);
CREATE INDEX IF NOT EXISTS source_snapshot_status_idx
  ON mw_offline.source_snapshot (status, retrieved_at DESC);
CREATE INDEX IF NOT EXISTS source_entity_type_idx
  ON mw_offline.source_entity (source_entity_type, external_id);
CREATE INDEX IF NOT EXISTS entity_source_assertion_internal_idx
  ON mw_offline.entity_source_assertion (entity_type, internal_id, verification_status);
CREATE INDEX IF NOT EXISTS entity_source_assertion_external_idx
  ON mw_offline.entity_source_assertion (external_namespace, external_id);
CREATE INDEX IF NOT EXISTS style_first_seen_snapshot_idx
  ON mw_offline.style (first_seen_snapshot_id);
CREATE INDEX IF NOT EXISTS artist_first_seen_snapshot_idx
  ON mw_offline.artist (first_seen_snapshot_id);
CREATE INDEX IF NOT EXISTS release_group_sort_idx ON mw_offline.release_group (canonical_name);
CREATE INDEX IF NOT EXISTS release_group_first_seen_snapshot_idx
  ON mw_offline.release_group (first_seen_snapshot_id);
CREATE INDEX IF NOT EXISTS release_group_artist_artist_idx
  ON mw_offline.release_group_artist (artist_id, release_group_id);
CREATE INDEX IF NOT EXISTS release_group_type_idx
  ON mw_offline.release_group (primary_type);
CREATE INDEX IF NOT EXISTS release_event_country_date_idx
  ON mw_offline.release_event (country_code, date_year, date_month, date_day);
CREATE INDEX IF NOT EXISTS recording_artist_artist_idx
  ON mw_offline.recording_artist (artist_id, recording_id);
CREATE INDEX IF NOT EXISTS external_identity_internal_idx
  ON mw_offline.external_identity (internal_id, namespace);
CREATE INDEX IF NOT EXISTS identity_evidence_identifier_lookup_idx
  ON mw_offline.identity_evidence_identifier (namespace, external_id);
CREATE INDEX IF NOT EXISTS identity_component_identifier_lookup_idx
  ON mw_offline.identity_component_identifier (namespace, external_id);
CREATE INDEX IF NOT EXISTS identity_component_status_idx
  ON mw_offline.identity_component (decision_status, entity_type);
CREATE INDEX IF NOT EXISTS artist_style_style_idx
  ON mw_offline.artist_style_assertion (style_id, artist_id);
CREATE INDEX IF NOT EXISTS artist_style_snapshot_idx
  ON mw_offline.artist_style_assertion (source_snapshot_id);
CREATE INDEX IF NOT EXISTS release_style_style_idx
  ON mw_offline.release_style_assertion (style_id, release_group_id);
CREATE INDEX IF NOT EXISTS release_style_snapshot_idx
  ON mw_offline.release_style_assertion (source_snapshot_id);
CREATE INDEX IF NOT EXISTS artist_style_qualification_style_idx
  ON mw_offline.artist_style_qualification (style_id, artist_id);
CREATE INDEX IF NOT EXISTS artist_style_qualification_snapshot_idx
  ON mw_offline.artist_style_qualification (source_snapshot_id);
CREATE INDEX IF NOT EXISTS style_representative_artist_artist_idx
  ON mw_offline.style_representative_artist (artist_id, style_id);
CREATE INDEX IF NOT EXISTS style_representative_artist_validation_idx
  ON mw_offline.style_representative_artist (validation_status, style_id);
CREATE INDEX IF NOT EXISTS style_representative_artist_asserted_style_idx
  ON mw_offline.style_representative_artist (asserted_style_id, style_id);
CREATE INDEX IF NOT EXISTS style_representative_artist_snapshot_idx
  ON mw_offline.style_representative_artist (source_snapshot_id);
CREATE INDEX IF NOT EXISTS style_representative_release_group_artist_idx
  ON mw_offline.style_representative_release_group (artist_id, style_id);
CREATE INDEX IF NOT EXISTS style_representative_release_group_release_idx
  ON mw_offline.style_representative_release_group (release_group_id, style_id);
CREATE INDEX IF NOT EXISTS style_representative_release_group_snapshot_idx
  ON mw_offline.style_representative_release_group (source_snapshot_id);
CREATE INDEX IF NOT EXISTS style_relation_to_idx
  ON mw_offline.style_relation_assertion (to_style_id, relation_kind);
CREATE INDEX IF NOT EXISTS style_relation_snapshot_idx
  ON mw_offline.style_relation_assertion (source_snapshot_id);

COMMIT;
