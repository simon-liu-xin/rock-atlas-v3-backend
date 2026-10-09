\set ON_ERROR_STOP on

INSERT INTO mw_offline.source_snapshot (
  snapshot_id,
  source_name,
  upstream_version,
  retrieved_at,
  source_url,
  checksum_algorithm,
  checksum_value,
  license_partition,
  redistributable,
  status
) VALUES
  (
    'poc:musicbrainz:experiment-v1',
    'musicbrainz',
    'experiment-v1',
    now(),
    'data/sources/experiment-v1/source-snapshot.json',
    'sha256',
    '49c1b5774327567df926fa115605940784b6d06f42fd183cbdbff61910330ade',
    'rock-core-cc0',
    true,
    'published'
  ),
  (
    'poc:discogs:d2542ed',
    'discogs',
    'd2542edaa53dbc0ce6b96e90699d555a93370e70',
    now(),
    'data/sources/offline-poc/discogs-rock-summary.json',
    NULL,
    NULL,
    'rock-discogs-cc0',
    true,
    'published'
  ),
  (
    'poc:wikidata:100-qids',
    'wikidata',
    '100 tracked QIDs under Q11399',
    now(),
    'data/sources/offline-poc/manifest.json',
    'sha256',
    'b7047612f4658a3d16ec5a27f975827516784e2d2d1e9f37311589b760363cda',
    'rock-core-cc0',
    true,
    'published'
  );

CREATE TEMP TABLE poc_payload AS
SELECT pg_read_file('/workspace/data/sources/experiment-v1/source-snapshot.json')::jsonb AS document;

INSERT INTO mw_offline.style (
  internal_id,
  canonical_name,
  sort_name,
  inclusion_status,
  first_seen_snapshot_id
)
SELECT
  style->>'internal_id',
  style->>'canonical_name',
  style->>'canonical_name',
  'accepted',
  'poc:wikidata:100-qids'
FROM poc_payload, LATERAL jsonb_array_elements(document->'styles') AS style;

INSERT INTO mw_offline.artist (
  internal_id,
  canonical_name,
  sort_name,
  artist_type,
  begin_date_text,
  end_date_text,
  country_code,
  first_seen_snapshot_id
)
SELECT
  artist->>'internal_id',
  artist->>'canonical_name',
  COALESCE(artist->>'sort_name', artist->>'canonical_name'),
  artist->>'artist_type',
  artist->'life_span'->>'begin',
  artist->'life_span'->>'end',
  artist->>'country',
  'poc:musicbrainz:experiment-v1'
FROM poc_payload, LATERAL jsonb_array_elements(document->'artists') AS artist;

INSERT INTO mw_offline.release_group (
  internal_id,
  canonical_name,
  primary_type,
  secondary_types,
  first_release_date_text,
  first_seen_snapshot_id
)
SELECT
  release_group->>'internal_id',
  release_group->>'canonical_name',
  COALESCE(release_group->>'primary_type', 'Other'),
  ARRAY(SELECT jsonb_array_elements_text(release_group->'secondary_types')),
  release_group->>'first_release_date',
  'poc:musicbrainz:experiment-v1'
FROM poc_payload, LATERAL jsonb_array_elements(document->'release_groups') AS release_group;

INSERT INTO mw_offline.release_group_artist (
  release_group_id,
  artist_id,
  credit_position,
  credited_name
)
SELECT
  release_group->>'internal_id',
  artist_id.value #>> '{}',
  artist_id.ordinality::integer,
  artist.canonical_name
FROM poc_payload
CROSS JOIN LATERAL jsonb_array_elements(document->'release_groups') AS release_group
CROSS JOIN LATERAL jsonb_array_elements(release_group->'artist_ids') WITH ORDINALITY AS artist_id(value, ordinality)
JOIN mw_offline.artist artist ON artist.internal_id = artist_id.value #>> '{}';

INSERT INTO mw_offline.recording (
  internal_id,
  canonical_name,
  length_ms,
  first_seen_snapshot_id
)
SELECT
  recording->>'internal_id',
  recording->>'canonical_name',
  NULLIF(recording->>'length_ms', '')::integer,
  'poc:musicbrainz:experiment-v1'
FROM poc_payload, LATERAL jsonb_array_elements(document->'recordings') AS recording;

INSERT INTO mw_offline.recording_artist (
  recording_id,
  artist_id,
  credit_position,
  credited_name
)
SELECT
  recording->>'internal_id',
  artist_id.value #>> '{}',
  artist_id.ordinality::integer,
  artist.canonical_name
FROM poc_payload
CROSS JOIN LATERAL jsonb_array_elements(document->'recordings') AS recording
CROSS JOIN LATERAL jsonb_array_elements(recording->'artist_ids') WITH ORDINALITY AS artist_id(value, ordinality)
JOIN mw_offline.artist artist ON artist.internal_id = artist_id.value #>> '{}';

INSERT INTO mw_offline.artist_style_assertion (
  artist_id,
  style_id,
  source_snapshot_id,
  assertion_basis,
  confidence_status,
  evidence_locator
)
SELECT
  artist->>'internal_id',
  artist->>'experiment_style_id',
  'poc:musicbrainz:experiment-v1',
  'manual-evidence',
  'observed',
  artist->>'source_url'
FROM poc_payload, LATERAL jsonb_array_elements(document->'artists') AS artist;

INSERT INTO mw_offline.external_identity (
  internal_id,
  namespace,
  external_id,
  source_snapshot_id,
  assertion_status
)
SELECT style->>'internal_id', 'wikidata', style->>'wikidata_qid', 'poc:wikidata:100-qids', 'accepted'
FROM poc_payload, LATERAL jsonb_array_elements(document->'styles') AS style
UNION ALL
SELECT artist->>'internal_id', 'musicbrainz-artist', artist->>'musicbrainz_mbid', 'poc:musicbrainz:experiment-v1', 'accepted'
FROM poc_payload, LATERAL jsonb_array_elements(document->'artists') AS artist
UNION ALL
SELECT release_group->>'internal_id', 'musicbrainz-release-group', release_group->>'musicbrainz_mbid', 'poc:musicbrainz:experiment-v1', 'accepted'
FROM poc_payload, LATERAL jsonb_array_elements(document->'release_groups') AS release_group
UNION ALL
SELECT recording->>'internal_id', 'musicbrainz-recording', recording->>'musicbrainz_mbid', 'poc:musicbrainz:experiment-v1', 'accepted'
FROM poc_payload, LATERAL jsonb_array_elements(document->'recordings') AS recording;

ANALYZE mw_offline.style;
ANALYZE mw_offline.artist;
ANALYZE mw_offline.release_group;
ANALYZE mw_offline.recording;
