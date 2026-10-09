\set ON_ERROR_STOP on

WITH table_sizes AS (
  SELECT
    c.relname AS table_name,
    pg_relation_size(c.oid) AS heap_bytes,
    pg_indexes_size(c.oid) AS index_bytes,
    pg_total_relation_size(c.oid) AS total_bytes
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'mw_offline' AND c.relkind = 'r'
),
storage AS (
  SELECT
    sum(heap_bytes)::bigint AS heap_bytes,
    sum(index_bytes)::bigint AS index_bytes,
    sum(total_bytes)::bigint AS total_relation_bytes
  FROM table_sizes
),
canonical AS (
  SELECT
    (SELECT count(*) FROM mw_offline.style) AS styles,
    (SELECT count(*) FROM mw_offline.artist) AS artists,
    (SELECT count(*) FROM mw_offline.release_group) AS release_groups,
    (SELECT count(*) FROM mw_offline.release) AS releases,
    (SELECT count(*) FROM mw_offline.recording) AS recordings
),
discography AS (
  SELECT
    min(release_group_count)::integer AS minimum,
    max(release_group_count)::integer AS maximum,
    round(avg(release_group_count), 2) AS average
  FROM (
    SELECT artist_id, count(*) AS release_group_count
    FROM mw_offline.release_group_artist
    GROUP BY artist_id
  ) counts
),
type_counts AS (
  SELECT jsonb_object_agg(primary_type, entity_count ORDER BY primary_type) AS value
  FROM (
    SELECT primary_type, count(*) AS entity_count
    FROM mw_offline.release_group
    GROUP BY primary_type
  ) counts
)
SELECT jsonb_pretty(
  jsonb_build_object(
    'report_version', '1.0',
    'generated_at', now(),
    'database', 'PostgreSQL 18 sample PoC',
    'row_counts', jsonb_build_object(
      'source_snapshots', (SELECT count(*) FROM mw_offline.source_snapshot),
      'styles', canonical.styles,
      'artists', canonical.artists,
      'release_groups', canonical.release_groups,
      'releases', canonical.releases,
      'recordings', canonical.recordings,
      'release_group_artist_edges', (SELECT count(*) FROM mw_offline.release_group_artist),
      'recording_artist_edges', (SELECT count(*) FROM mw_offline.recording_artist),
      'artist_style_assertions', (SELECT count(*) FROM mw_offline.artist_style_assertion),
      'external_identities', (SELECT count(*) FROM mw_offline.external_identity)
    ),
    'storage', jsonb_build_object(
      'heap_bytes', storage.heap_bytes,
      'index_bytes', storage.index_bytes,
      'total_relation_bytes', storage.total_relation_bytes,
      'canonical_entities', canonical.styles + canonical.artists + canonical.release_groups + canonical.releases + canonical.recordings,
      'bytes_per_canonical_entity', round(
        storage.total_relation_bytes::numeric /
        NULLIF(canonical.styles + canonical.artists + canonical.release_groups + canonical.releases + canonical.recordings, 0),
        2
      ),
      'index_to_heap_ratio', round(storage.index_bytes::numeric / NULLIF(storage.heap_bytes, 0), 4)
    ),
    'release_groups_per_artist', to_jsonb(discography),
    'release_group_type_counts', type_counts.value,
    'table_sizes', (SELECT jsonb_agg(to_jsonb(table_sizes) ORDER BY table_name) FROM table_sizes),
    'limitations', jsonb_build_array(
      'Page-level overhead dominates this 329-entity sample.',
      'The frozen fixture contains representative ReleaseGroups, not every edition or track.',
      'Use this report to validate schema and measurement, not to extrapolate linearly to full scale.'
    )
  )
)
FROM storage, canonical, discography, type_counts;
