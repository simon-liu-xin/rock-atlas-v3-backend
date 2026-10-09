\set ON_ERROR_STOP on

DROP SCHEMA IF EXISTS mb_sample CASCADE;
CREATE SCHEMA mb_sample;

CREATE UNLOGGED TABLE mb_sample.artist (
  id text, gid text, name text, sort_name text,
  begin_date_year text, begin_date_month text, begin_date_day text,
  end_date_year text, end_date_month text, end_date_day text,
  type text, area text, gender text, comment text, edits_pending text,
  last_updated text, ended text, begin_area text, end_area text
);
CREATE UNLOGGED TABLE mb_sample.artist_type (
  id text, name text, parent text, child_order text, description text, gid text
);
CREATE UNLOGGED TABLE mb_sample.artist_credit (
  id text, name text, artist_count text, ref_count text, created text, edits_pending text, gid text
);
CREATE UNLOGGED TABLE mb_sample.artist_credit_name (
  artist_credit text, position text, artist text, name text, join_phrase text
);
CREATE UNLOGGED TABLE mb_sample.release_group (
  id text, gid text, name text, artist_credit text, type text, comment text,
  edits_pending text, last_updated text
);
CREATE UNLOGGED TABLE mb_sample.release_group_primary_type (
  id text, name text, parent text, child_order text, description text, gid text
);
CREATE UNLOGGED TABLE mb_sample.release_group_secondary_type (
  id text, name text, parent text, child_order text, description text, gid text
);
CREATE UNLOGGED TABLE mb_sample.release_group_secondary_type_join (
  release_group text, secondary_type text, created text
);
CREATE UNLOGGED TABLE mb_sample.release (
  id text, gid text, name text, artist_credit text, release_group text, status text,
  packaging text, language text, script text, barcode text, comment text,
  edits_pending text, quality text, last_updated text
);
CREATE UNLOGGED TABLE mb_sample.release_status (
  id text, name text, parent text, child_order text, description text, gid text
);
CREATE UNLOGGED TABLE mb_sample.release_packaging (
  id text, name text, parent text, child_order text, description text, gid text
);
CREATE UNLOGGED TABLE mb_sample.release_country (
  release text, country text, date_year text, date_month text, date_day text
);
CREATE UNLOGGED TABLE mb_sample.release_unknown_country (
  release text, date_year text, date_month text, date_day text
);
CREATE UNLOGGED TABLE mb_sample.iso_3166_1 (area text, code text);
CREATE UNLOGGED TABLE mb_sample.medium (
  id text, release text, position text, format text, name text, edits_pending text,
  last_updated text, track_count text, gid text
);
CREATE UNLOGGED TABLE mb_sample.medium_format (
  id text, name text, parent text, child_order text, year text, has_discids text,
  description text, gid text
);
CREATE UNLOGGED TABLE mb_sample.track (
  id text, gid text, recording text, medium text, position text, number text, name text,
  artist_credit text, length text, edits_pending text, last_updated text, is_data_track text
);
CREATE UNLOGGED TABLE mb_sample.recording (
  id text, gid text, name text, artist_credit text, length text, comment text,
  edits_pending text, last_updated text, video text
);
CREATE UNLOGGED TABLE mb_sample.url (
  id text, gid text, url text, edits_pending text, last_updated text
);
CREATE UNLOGGED TABLE mb_sample.link (
  id text, link_type text,
  begin_date_year text, begin_date_month text, begin_date_day text,
  end_date_year text, end_date_month text, end_date_day text,
  attribute_count text, created text, ended text
);
CREATE UNLOGGED TABLE mb_sample.link_type (
  id text, parent text, child_order text, gid text, entity_type0 text, entity_type1 text,
  name text, description text, link_phrase text, reverse_link_phrase text,
  long_link_phrase text, last_updated text, is_deprecated text, has_dates text,
  entity0_cardinality text, entity1_cardinality text
);
CREATE UNLOGGED TABLE mb_sample.l_artist_url (
  id text, link text, entity0 text, entity1 text, edits_pending text, last_updated text,
  link_order text, entity0_credit text, entity1_credit text
);
CREATE UNLOGGED TABLE mb_sample.l_release_group_url (
  id text, link text, entity0 text, entity1 text, edits_pending text, last_updated text,
  link_order text, entity0_credit text, entity1_credit text
);
CREATE UNLOGGED TABLE mb_sample.l_release_url (
  id text, link text, entity0 text, entity1 text, edits_pending text, last_updated text,
  link_order text, entity0_credit text, entity1_credit text
);

\copy mb_sample.artist FROM '/workspace/data/sources/offline-poc/.cache/musicbrainz-sample-extracted/mbdump/artist' WITH (FORMAT text)
\copy mb_sample.artist_type FROM '/workspace/data/sources/offline-poc/.cache/musicbrainz-sample-extracted/mbdump/artist_type' WITH (FORMAT text)
\copy mb_sample.artist_credit FROM '/workspace/data/sources/offline-poc/.cache/musicbrainz-sample-extracted/mbdump/artist_credit' WITH (FORMAT text)
\copy mb_sample.artist_credit_name FROM '/workspace/data/sources/offline-poc/.cache/musicbrainz-sample-extracted/mbdump/artist_credit_name' WITH (FORMAT text)
\copy mb_sample.release_group FROM '/workspace/data/sources/offline-poc/.cache/musicbrainz-sample-extracted/mbdump/release_group' WITH (FORMAT text)
\copy mb_sample.release_group_primary_type FROM '/workspace/data/sources/offline-poc/.cache/musicbrainz-sample-extracted/mbdump/release_group_primary_type' WITH (FORMAT text)
\copy mb_sample.release_group_secondary_type FROM '/workspace/data/sources/offline-poc/.cache/musicbrainz-sample-extracted/mbdump/release_group_secondary_type' WITH (FORMAT text)
\copy mb_sample.release_group_secondary_type_join FROM '/workspace/data/sources/offline-poc/.cache/musicbrainz-sample-extracted/mbdump/release_group_secondary_type_join' WITH (FORMAT text)
\copy mb_sample.release FROM '/workspace/data/sources/offline-poc/.cache/musicbrainz-sample-extracted/mbdump/release' WITH (FORMAT text)
\copy mb_sample.release_status FROM '/workspace/data/sources/offline-poc/.cache/musicbrainz-sample-extracted/mbdump/release_status' WITH (FORMAT text)
\copy mb_sample.release_packaging FROM '/workspace/data/sources/offline-poc/.cache/musicbrainz-sample-extracted/mbdump/release_packaging' WITH (FORMAT text)
\copy mb_sample.release_country FROM '/workspace/data/sources/offline-poc/.cache/musicbrainz-sample-extracted/mbdump/release_country' WITH (FORMAT text)
\copy mb_sample.release_unknown_country FROM '/workspace/data/sources/offline-poc/.cache/musicbrainz-sample-extracted/mbdump/release_unknown_country' WITH (FORMAT text)
\copy mb_sample.iso_3166_1 FROM '/workspace/data/sources/offline-poc/.cache/musicbrainz-sample-extracted/mbdump/iso_3166_1' WITH (FORMAT text)
\copy mb_sample.medium FROM '/workspace/data/sources/offline-poc/.cache/musicbrainz-sample-extracted/mbdump/medium' WITH (FORMAT text)
\copy mb_sample.medium_format FROM '/workspace/data/sources/offline-poc/.cache/musicbrainz-sample-extracted/mbdump/medium_format' WITH (FORMAT text)
\copy mb_sample.track FROM '/workspace/data/sources/offline-poc/.cache/musicbrainz-sample-extracted/mbdump/track' WITH (FORMAT text)
\copy mb_sample.recording FROM '/workspace/data/sources/offline-poc/.cache/musicbrainz-sample-extracted/mbdump/recording' WITH (FORMAT text)
\copy mb_sample.url FROM '/workspace/data/sources/offline-poc/.cache/musicbrainz-sample-extracted/mbdump/url' WITH (FORMAT text)
\copy mb_sample.link FROM '/workspace/data/sources/offline-poc/.cache/musicbrainz-sample-extracted/mbdump/link' WITH (FORMAT text)
\copy mb_sample.link_type FROM '/workspace/data/sources/offline-poc/.cache/musicbrainz-sample-extracted/mbdump/link_type' WITH (FORMAT text)
\copy mb_sample.l_artist_url FROM '/workspace/data/sources/offline-poc/.cache/musicbrainz-sample-extracted/mbdump/l_artist_url' WITH (FORMAT text)
\copy mb_sample.l_release_group_url FROM '/workspace/data/sources/offline-poc/.cache/musicbrainz-sample-extracted/mbdump/l_release_group_url' WITH (FORMAT text)
\copy mb_sample.l_release_url FROM '/workspace/data/sources/offline-poc/.cache/musicbrainz-sample-extracted/mbdump/l_release_url' WITH (FORMAT text)

CREATE FUNCTION mb_sample.date_text(year_text text, month_text text, day_text text)
RETURNS text
LANGUAGE sql
IMMUTABLE
RETURN CASE
  WHEN year_text IS NULL THEN NULL
  WHEN month_text IS NULL THEN year_text
  WHEN day_text IS NULL THEN year_text || '-' || lpad(month_text, 2, '0')
  ELSE year_text || '-' || lpad(month_text, 2, '0') || '-' || lpad(day_text, 2, '0')
END;

INSERT INTO mw_offline.source_snapshot (
  snapshot_id, source_name, upstream_version, retrieved_at, source_url,
  checksum_algorithm, checksum_value, license_partition, redistributable, status
) VALUES (
  'poc:musicbrainz:sample-20260801',
  'musicbrainz',
  '20260801-000001',
  '2026-08-01T00:57:36Z',
  'https://data.metabrainz.org/pub/musicbrainz/data/sample/20260801-000001/mbdump-sample.tar.xz',
  'sha256',
  :'sample_sha256',
  'rock-core-cc0',
  true,
  'validated'
);

INSERT INTO mw_offline.artist (
  internal_id, canonical_name, sort_name, artist_type, begin_date_text, end_date_text,
  country_code, first_seen_snapshot_id
)
SELECT
  'mw:artist:mb:' || artist.gid,
  artist.name,
  artist.sort_name,
  artist_type.name,
  mb_sample.date_text(artist.begin_date_year, artist.begin_date_month, artist.begin_date_day),
  mb_sample.date_text(artist.end_date_year, artist.end_date_month, artist.end_date_day),
  country.code,
  'poc:musicbrainz:sample-20260801'
FROM mb_sample.artist artist
LEFT JOIN mb_sample.artist_type artist_type ON artist_type.id = artist.type
LEFT JOIN mb_sample.iso_3166_1 country ON country.area = artist.area;

INSERT INTO mw_offline.release_group (
  internal_id, canonical_name, primary_type, secondary_types, first_seen_snapshot_id
)
SELECT
  'mw:release-group:mb:' || release_group.gid,
  release_group.name,
  COALESCE(primary_type.name, 'Other'),
  ARRAY(
    SELECT secondary_type.name
    FROM mb_sample.release_group_secondary_type_join type_join
    JOIN mb_sample.release_group_secondary_type secondary_type
      ON secondary_type.id = type_join.secondary_type
    WHERE type_join.release_group = release_group.id
    ORDER BY secondary_type.name
  ),
  'poc:musicbrainz:sample-20260801'
FROM mb_sample.release_group release_group
LEFT JOIN mb_sample.release_group_primary_type primary_type ON primary_type.id = release_group.type;

INSERT INTO mw_offline.release_group_artist (
  release_group_id, artist_id, credit_position, credited_name, join_phrase
)
SELECT
  'mw:release-group:mb:' || release_group.gid,
  'mw:artist:mb:' || artist.gid,
  credit_name.position::integer,
  credit_name.name,
  credit_name.join_phrase
FROM mb_sample.release_group release_group
JOIN mb_sample.artist_credit_name credit_name
  ON credit_name.artist_credit = release_group.artist_credit
JOIN mb_sample.artist artist ON artist.id = credit_name.artist;

WITH preferred_event AS (
  SELECT DISTINCT ON (release_id)
    release_id,
    country_code,
    date_year,
    date_month,
    date_day
  FROM (
    SELECT
      release_country.release AS release_id,
      country.code AS country_code,
      release_country.date_year,
      release_country.date_month,
      release_country.date_day,
      0 AS unknown_order
    FROM mb_sample.release_country release_country
    LEFT JOIN mb_sample.iso_3166_1 country ON country.area = release_country.country
    UNION ALL
    SELECT release, NULL, date_year, date_month, date_day, 1
    FROM mb_sample.release_unknown_country
  ) events
  ORDER BY release_id, unknown_order, date_year NULLS LAST, date_month NULLS LAST,
    date_day NULLS LAST, country_code NULLS LAST
)
INSERT INTO mw_offline.release (
  internal_id, release_group_id, title, release_date_text, country_code, status,
  packaging, barcode, first_seen_snapshot_id
)
SELECT
  'mw:release:mb:' || release.gid,
  'mw:release-group:mb:' || release_group.gid,
  release.name,
  mb_sample.date_text(event.date_year, event.date_month, event.date_day),
  event.country_code,
  release_status.name,
  release_packaging.name,
  release.barcode,
  'poc:musicbrainz:sample-20260801'
FROM mb_sample.release release
JOIN mb_sample.release_group release_group ON release_group.id = release.release_group
LEFT JOIN preferred_event event ON event.release_id = release.id
LEFT JOIN mb_sample.release_status release_status ON release_status.id = release.status
LEFT JOIN mb_sample.release_packaging release_packaging ON release_packaging.id = release.packaging;

WITH events AS (
  SELECT
    release_country.release AS release_id,
    country.code AS country_code,
    release_country.date_year,
    release_country.date_month,
    release_country.date_day,
    0 AS unknown_order
  FROM mb_sample.release_country release_country
  LEFT JOIN mb_sample.iso_3166_1 country ON country.area = release_country.country
  UNION ALL
  SELECT release, NULL, date_year, date_month, date_day, 1
  FROM mb_sample.release_unknown_country
), numbered AS (
  SELECT
    events.*,
    row_number() OVER (
      PARTITION BY release_id
      ORDER BY unknown_order, date_year NULLS LAST, date_month NULLS LAST,
        date_day NULLS LAST, country_code NULLS LAST
    )::integer AS event_position
  FROM events
)
INSERT INTO mw_offline.release_event (
  release_id, event_position, country_code, date_year, date_month, date_day, source_snapshot_id
)
SELECT
  'mw:release:mb:' || release.gid,
  numbered.event_position,
  numbered.country_code,
  numbered.date_year::smallint,
  numbered.date_month::smallint,
  numbered.date_day::smallint,
  'poc:musicbrainz:sample-20260801'
FROM numbered
JOIN mb_sample.release release ON release.id = numbered.release_id;

INSERT INTO mw_offline.medium (release_id, position, format_name, track_count)
SELECT
  'mw:release:mb:' || release.gid,
  medium.position::integer,
  medium_format.name,
  medium.track_count::integer
FROM mb_sample.medium medium
JOIN mb_sample.release release ON release.id = medium.release
LEFT JOIN mb_sample.medium_format medium_format ON medium_format.id = medium.format;

INSERT INTO mw_offline.recording (
  internal_id, canonical_name, length_ms, video, first_seen_snapshot_id
)
SELECT
  'mw:recording:mb:' || recording.gid,
  recording.name,
  recording.length::integer,
  recording.video::boolean,
  'poc:musicbrainz:sample-20260801'
FROM mb_sample.recording recording;

INSERT INTO mw_offline.recording_artist (
  recording_id, artist_id, credit_position, credited_name, join_phrase
)
SELECT
  'mw:recording:mb:' || recording.gid,
  'mw:artist:mb:' || artist.gid,
  credit_name.position::integer,
  credit_name.name,
  credit_name.join_phrase
FROM mb_sample.recording recording
JOIN mb_sample.artist_credit_name credit_name
  ON credit_name.artist_credit = recording.artist_credit
JOIN mb_sample.artist artist ON artist.id = credit_name.artist;

INSERT INTO mw_offline.track (
  release_id, medium_position, position, recording_id, title, number_text, length_ms
)
SELECT
  'mw:release:mb:' || release.gid,
  medium.position::integer,
  track.position::integer,
  'mw:recording:mb:' || recording.gid,
  track.name,
  track.number,
  track.length::integer
FROM mb_sample.track track
JOIN mb_sample.medium medium ON medium.id = track.medium
JOIN mb_sample.release release ON release.id = medium.release
JOIN mb_sample.recording recording ON recording.id = track.recording;

INSERT INTO mw_offline.external_identity (
  internal_id, namespace, external_id, source_snapshot_id, assertion_status
)
SELECT 'mw:artist:mb:' || gid, 'musicbrainz-artist', gid,
  'poc:musicbrainz:sample-20260801', 'accepted' FROM mb_sample.artist
UNION ALL
SELECT 'mw:release-group:mb:' || gid, 'musicbrainz-release-group', gid,
  'poc:musicbrainz:sample-20260801', 'accepted' FROM mb_sample.release_group
UNION ALL
SELECT 'mw:release:mb:' || gid, 'musicbrainz-release', gid,
  'poc:musicbrainz:sample-20260801', 'accepted' FROM mb_sample.release
UNION ALL
SELECT 'mw:recording:mb:' || gid, 'musicbrainz-recording', gid,
  'poc:musicbrainz:sample-20260801', 'accepted' FROM mb_sample.recording;

CREATE UNLOGGED TABLE mb_sample.explicit_url_identity (
  evidence_id text,
  entity_type text,
  canonical_namespace text,
  canonical_external_id text,
  external_namespace text,
  external_id text,
  evidence_locator text,
  resource_url text,
  link_type_name text
);

INSERT INTO mb_sample.explicit_url_identity
SELECT
  'mb-url:artist:' || relation.id,
  'artist',
  'musicbrainz-artist',
  artist.gid,
  CASE WHEN lower(resource.url) LIKE '%discogs.com/%' THEN 'discogs-artist' ELSE 'wikidata-item' END,
  COALESCE(
    (regexp_match(lower(resource.url), 'discogs\.com/(?:[a-z]{2}(?:-[a-z]{2})?/)?artist/([1-9][0-9]*)'))[1],
    (regexp_match(upper(resource.url), 'WIKIDATA\.ORG/(?:WIKI|ENTITY)/(Q[1-9][0-9]*)'))[1]
  ),
  'l_artist_url:' || relation.id,
  resource.url,
  link_type.name
FROM mb_sample.l_artist_url relation
JOIN mb_sample.artist artist ON artist.id = relation.entity0
JOIN mb_sample.url resource ON resource.id = relation.entity1
LEFT JOIN mb_sample.link link ON link.id = relation.link
LEFT JOIN mb_sample.link_type link_type ON link_type.id = link.link_type
WHERE
  lower(resource.url) ~ 'discogs\.com/(?:[a-z]{2}(?:-[a-z]{2})?/)?artist/[1-9][0-9]*'
  OR upper(resource.url) ~ 'WIKIDATA\.ORG/(?:WIKI|ENTITY)/Q[1-9][0-9]*'
UNION ALL
SELECT
  'mb-url:release-group:' || relation.id,
  'release_group',
  'musicbrainz-release-group',
  release_group.gid,
  CASE WHEN lower(resource.url) LIKE '%discogs.com/%' THEN 'discogs-master' ELSE 'wikidata-item' END,
  COALESCE(
    (regexp_match(lower(resource.url), 'discogs\.com/(?:[a-z]{2}(?:-[a-z]{2})?/)?master/([1-9][0-9]*)'))[1],
    (regexp_match(upper(resource.url), 'WIKIDATA\.ORG/(?:WIKI|ENTITY)/(Q[1-9][0-9]*)'))[1]
  ),
  'l_release_group_url:' || relation.id,
  resource.url,
  link_type.name
FROM mb_sample.l_release_group_url relation
JOIN mb_sample.release_group release_group ON release_group.id = relation.entity0
JOIN mb_sample.url resource ON resource.id = relation.entity1
LEFT JOIN mb_sample.link link ON link.id = relation.link
LEFT JOIN mb_sample.link_type link_type ON link_type.id = link.link_type
WHERE
  lower(resource.url) ~ 'discogs\.com/(?:[a-z]{2}(?:-[a-z]{2})?/)?master/[1-9][0-9]*'
  OR upper(resource.url) ~ 'WIKIDATA\.ORG/(?:WIKI|ENTITY)/Q[1-9][0-9]*'
UNION ALL
SELECT
  'mb-url:release:' || relation.id,
  'release',
  'musicbrainz-release',
  release.gid,
  CASE WHEN lower(resource.url) LIKE '%discogs.com/%' THEN 'discogs-release' ELSE 'wikidata-item' END,
  COALESCE(
    (regexp_match(lower(resource.url), 'discogs\.com/(?:[a-z]{2}(?:-[a-z]{2})?/)?release/([1-9][0-9]*)'))[1],
    (regexp_match(upper(resource.url), 'WIKIDATA\.ORG/(?:WIKI|ENTITY)/(Q[1-9][0-9]*)'))[1]
  ),
  'l_release_url:' || relation.id,
  resource.url,
  link_type.name
FROM mb_sample.l_release_url relation
JOIN mb_sample.release release ON release.id = relation.entity0
JOIN mb_sample.url resource ON resource.id = relation.entity1
LEFT JOIN mb_sample.link link ON link.id = relation.link
LEFT JOIN mb_sample.link_type link_type ON link_type.id = link.link_type
WHERE
  lower(resource.url) ~ 'discogs\.com/(?:[a-z]{2}(?:-[a-z]{2})?/)?release/[1-9][0-9]*'
  OR upper(resource.url) ~ 'WIKIDATA\.ORG/(?:WIKI|ENTITY)/Q[1-9][0-9]*';

INSERT INTO mw_offline.identity_evidence (
  evidence_id, entity_type, evidence_source, source_snapshot_id,
  evidence_locator, evidence_payload
)
SELECT
  evidence_id,
  entity_type,
  'musicbrainz-url',
  'poc:musicbrainz:sample-20260801',
  evidence_locator,
  jsonb_build_object('resource_url', resource_url, 'link_type', link_type_name)
FROM mb_sample.explicit_url_identity;

INSERT INTO mw_offline.identity_evidence_identifier (evidence_id, namespace, external_id)
SELECT evidence_id, canonical_namespace, canonical_external_id
FROM mb_sample.explicit_url_identity
UNION ALL
SELECT evidence_id, external_namespace, external_id
FROM mb_sample.explicit_url_identity;

ANALYZE mb_sample.artist;
ANALYZE mb_sample.release_group;
ANALYZE mb_sample.release;
ANALYZE mb_sample.medium;
ANALYZE mb_sample.track;
ANALYZE mb_sample.recording;
ANALYZE mb_sample.explicit_url_identity;
ANALYZE mw_offline.artist;
ANALYZE mw_offline.release_group;
ANALYZE mw_offline.release;
ANALYZE mw_offline.medium;
ANALYZE mw_offline.track;
ANALYZE mw_offline.recording;
