\set ON_ERROR_STOP on

WITH relation_sizes AS (
  SELECT
    n.nspname AS schema_name,
    c.relname AS table_name,
    pg_relation_size(c.oid) AS heap_bytes,
    pg_indexes_size(c.oid) AS index_bytes,
    pg_total_relation_size(c.oid) AS total_bytes
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('mb_sample', 'mw_offline') AND c.relkind = 'r'
), schema_sizes AS (
  SELECT
    schema_name,
    sum(heap_bytes)::bigint AS heap_bytes,
    sum(index_bytes)::bigint AS index_bytes,
    sum(total_bytes)::bigint AS total_bytes
  FROM relation_sizes
  GROUP BY schema_name
), nine_inch_nails_groups AS (
  SELECT release_group_id
  FROM mw_offline.release_group_artist
  WHERE artist_id = 'mw:artist:mb:b7ffd2af-418f-4be2-bdd1-22f8b48613da'
), nine_inch_nails_releases AS (
  SELECT release.internal_id
  FROM mw_offline.release release
  JOIN nine_inch_nails_groups groups ON groups.release_group_id = release.release_group_id
), nine_inch_nails_media AS (
  SELECT medium.release_id, medium.position
  FROM mw_offline.medium medium
  JOIN nine_inch_nails_releases release ON release.internal_id = medium.release_id
), nine_inch_nails_catalog AS (
  SELECT jsonb_build_object(
    'release_groups', (SELECT count(*) FROM nine_inch_nails_groups),
    'live_release_groups', (
      SELECT count(*) FROM mw_offline.release_group release_group
      JOIN nine_inch_nails_groups groups ON groups.release_group_id = release_group.internal_id
      WHERE release_group.secondary_types @> ARRAY['Live']::text[]
    ),
    'releases', (SELECT count(*) FROM nine_inch_nails_releases),
    'media', (SELECT count(*) FROM nine_inch_nails_media),
    'tracks', (
      SELECT count(*) FROM mw_offline.track track
      JOIN nine_inch_nails_media medium
        ON medium.release_id = track.release_id AND medium.position = track.medium_position
    ),
    'unique_recordings', (
      SELECT count(DISTINCT track.recording_id) FROM mw_offline.track track
      JOIN nine_inch_nails_media medium
        ON medium.release_id = track.release_id AND medium.position = track.medium_position
    ),
    'releases_per_release_group', round(
      (SELECT count(*) FROM nine_inch_nails_releases)::numeric /
      NULLIF((SELECT count(*) FROM nine_inch_nails_groups), 0), 4
    ),
    'media_per_release', round(
      (SELECT count(*) FROM nine_inch_nails_media)::numeric /
      NULLIF((SELECT count(*) FROM nine_inch_nails_releases), 0), 4
    ),
    'tracks_per_medium', round(
      (SELECT count(*) FROM mw_offline.track track
       JOIN nine_inch_nails_media medium
         ON medium.release_id = track.release_id AND medium.position = track.medium_position)::numeric /
      NULLIF((SELECT count(*) FROM nine_inch_nails_media), 0), 4
    )
  ) AS value
), row_counts AS (
  SELECT jsonb_build_object(
    'artists', (SELECT count(*) FROM mw_offline.artist),
    'release_groups', (SELECT count(*) FROM mw_offline.release_group),
    'release_group_artist_edges', (SELECT count(*) FROM mw_offline.release_group_artist),
    'releases', (SELECT count(*) FROM mw_offline.release),
    'release_events', (SELECT count(*) FROM mw_offline.release_event),
    'media', (SELECT count(*) FROM mw_offline.medium),
    'tracks', (SELECT count(*) FROM mw_offline.track),
    'recordings', (SELECT count(*) FROM mw_offline.recording),
    'recording_artist_edges', (SELECT count(*) FROM mw_offline.recording_artist),
    'live_release_groups', (
      SELECT count(*) FROM mw_offline.release_group
      WHERE secondary_types @> ARRAY['Live']::text[]
    )
  ) AS value
), explicit_url_identity_evidence AS (
  SELECT jsonb_build_object(
    'total', count(*),
    'artists', count(*) FILTER (WHERE entity_type = 'artist'),
    'release_groups', count(*) FILTER (WHERE entity_type = 'release_group'),
    'releases', count(*) FILTER (WHERE entity_type = 'release'),
    'discogs_targets', count(*) FILTER (WHERE external_namespace LIKE 'discogs-%'),
    'wikidata_targets', count(*) FILTER (WHERE external_namespace = 'wikidata-item')
  ) AS value
  FROM mb_sample.explicit_url_identity
), storage AS (
  SELECT jsonb_object_agg(
    CASE schema_name WHEN 'mb_sample' THEN 'staging' ELSE 'canonical' END,
    jsonb_build_object(
      'heap_bytes', heap_bytes,
      'index_bytes', index_bytes,
      'total_relation_bytes', total_bytes
    )
  ) AS value
  FROM schema_sizes
)
SELECT jsonb_pretty(jsonb_build_object(
  'report_version', '1.0',
  'generated_at', now(),
  'database', 'PostgreSQL 18 MusicBrainz monthly sample PoC',
  'row_counts', row_counts.value,
  'explicit_url_identity_evidence', explicit_url_identity_evidence.value,
  'nine_inch_nails_catalog', nine_inch_nails_catalog.value,
  'storage', storage.value,
  'relation_sizes', (
    SELECT jsonb_agg(to_jsonb(relation_sizes) ORDER BY schema_name, table_name)
    FROM relation_sizes
  ),
  'limitations', jsonb_build_array(
    'The official sample contains three seed artists and is not statistically representative of Rock.',
    'Nine Inch Nails is used only to measure complete-discography edition and track expansion.',
    'Full-dump size planning must continue to use official full-export storage budgets.'
  )
))
FROM row_counts, nine_inch_nails_catalog, explicit_url_identity_evidence, storage;
