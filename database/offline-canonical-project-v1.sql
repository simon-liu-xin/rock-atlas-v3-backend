\set ON_ERROR_STOP on

BEGIN ISOLATION LEVEL REPEATABLE READ;

LOCK TABLE __MUSICBRAINZ_SCHEMA__.musicwiki_stage_meta IN SHARE MODE;
DO $musicbrainz_stage$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM __MUSICBRAINZ_SCHEMA__.musicwiki_stage_meta
    WHERE snapshot_id = __MB_UPSTREAM_VERSION__
      AND schema_sequence = 31
      AND source_archive_sha256 = __MB_ARCHIVE_SHA256__
  ) THEN RAISE EXCEPTION 'MusicBrainz stage identity changed before projection'; END IF;
END
$musicbrainz_stage$;

CREATE UNLOGGED TABLE __CANONICAL_SCHEMA__.stage_discogs_artist (payload jsonb NOT NULL);
CREATE UNLOGGED TABLE __CANONICAL_SCHEMA__.stage_discogs_release (payload jsonb NOT NULL);
CREATE UNLOGGED TABLE __CANONICAL_SCHEMA__.stage_discogs_master (payload jsonb NOT NULL);
CREATE UNLOGGED TABLE __CANONICAL_SCHEMA__.stage_discogs_style (payload jsonb NOT NULL);
CREATE UNLOGGED TABLE __CANONICAL_SCHEMA__.stage_wikidata_entity (payload jsonb NOT NULL);

\copy __CANONICAL_SCHEMA__.stage_discogs_artist (payload) FROM __DISCOGS_ARTISTS_PATH__ WITH (FORMAT csv, DELIMITER E'\x1f', QUOTE E'\x1e', ESCAPE E'\x1e')
\copy __CANONICAL_SCHEMA__.stage_discogs_release (payload) FROM __DISCOGS_RELEASES_PATH__ WITH (FORMAT csv, DELIMITER E'\x1f', QUOTE E'\x1e', ESCAPE E'\x1e')
\copy __CANONICAL_SCHEMA__.stage_discogs_master (payload) FROM __DISCOGS_MASTERS_PATH__ WITH (FORMAT csv, DELIMITER E'\x1f', QUOTE E'\x1e', ESCAPE E'\x1e')
\copy __CANONICAL_SCHEMA__.stage_discogs_style (payload) FROM __DISCOGS_STYLES_PATH__ WITH (FORMAT csv, DELIMITER E'\x1f', QUOTE E'\x1e', ESCAPE E'\x1e')
\copy __CANONICAL_SCHEMA__.stage_wikidata_entity (payload) FROM __WIKIDATA_ENTITIES_PATH__ WITH (FORMAT csv, DELIMITER E'\x1f', QUOTE E'\x1e', ESCAPE E'\x1e')

DO $validation$
BEGIN
  IF EXISTS (
    SELECT 1 FROM __CANONICAL_SCHEMA__.stage_discogs_artist
    WHERE payload->>'external_id' !~ '^[1-9][0-9]*$'
      OR COALESCE(payload->>'name', '') = ''
      OR jsonb_typeof(payload->'qualifies_rock') <> 'boolean'
  ) THEN RAISE EXCEPTION 'invalid Discogs artist stage row'; END IF;
  IF EXISTS (
    SELECT 1 FROM __CANONICAL_SCHEMA__.stage_discogs_release
    WHERE payload->>'external_id' !~ '^[1-9][0-9]*$'
      OR COALESCE(payload->>'title', '') = ''
      OR jsonb_typeof(payload->'artists') <> 'array'
      OR jsonb_array_length(payload->'artists') = 0
  ) THEN RAISE EXCEPTION 'invalid Discogs release stage row'; END IF;
  IF EXISTS (
    SELECT 1 FROM __CANONICAL_SCHEMA__.stage_discogs_master
    WHERE payload->>'external_id' !~ '^[1-9][0-9]*$'
      OR COALESCE(payload->>'title', '') = ''
      OR jsonb_typeof(payload->'artists') <> 'array'
  ) THEN RAISE EXCEPTION 'invalid Discogs master stage row'; END IF;
  IF EXISTS (
    SELECT 1 FROM __CANONICAL_SCHEMA__.stage_discogs_style
    WHERE COALESCE(payload->>'style', '') = ''
      OR payload->>'classification' NOT IN ('accepted', 'candidate')
  ) THEN RAISE EXCEPTION 'invalid Discogs style stage row'; END IF;
  IF EXISTS (
    SELECT 1 FROM __CANONICAL_SCHEMA__.stage_wikidata_entity
    WHERE payload->>'qid' !~ '^Q[1-9][0-9]*$'
      OR COALESCE((payload->>'revision_id')::bigint, 0) < 1
      OR jsonb_typeof(payload->'payload') <> 'object'
      OR (payload ? 'roles' AND jsonb_typeof(payload->'roles') <> 'array')
      OR (
        COALESCE(payload->'roles', '[]'::jsonb) ? 'rock-style'
        AND (
          jsonb_typeof(payload->'rock_style') <> 'object'
          OR payload #>> '{rock_style,qid}' <> payload->>'qid'
          OR COALESCE(payload #>> '{rock_style,label}', '') = ''
          OR jsonb_typeof(payload #> '{rock_style,parent_qids}') <> 'array'
          OR jsonb_typeof(payload #> '{rock_style,country_labels}') <> 'array'
        )
      )
  ) THEN RAISE EXCEPTION 'invalid Wikidata entity stage row'; END IF;
END
$validation$;

CREATE UNIQUE INDEX stage_discogs_artist_id_idx
  ON __CANONICAL_SCHEMA__.stage_discogs_artist ((payload->>'external_id'));
CREATE UNIQUE INDEX stage_discogs_release_id_idx
  ON __CANONICAL_SCHEMA__.stage_discogs_release ((payload->>'external_id'));
CREATE UNIQUE INDEX stage_discogs_master_id_idx
  ON __CANONICAL_SCHEMA__.stage_discogs_master ((payload->>'external_id'));
CREATE UNIQUE INDEX stage_discogs_style_name_idx
  ON __CANONICAL_SCHEMA__.stage_discogs_style ((lower(payload->>'style')));
CREATE UNIQUE INDEX stage_wikidata_qid_idx
  ON __CANONICAL_SCHEMA__.stage_wikidata_entity ((payload->>'qid'));

INSERT INTO __CANONICAL_SCHEMA__.source_snapshot (
  snapshot_id, source_name, upstream_version, retrieved_at, source_url,
  checksum_algorithm, checksum_value, license_partition, redistributable, status
) VALUES
  (__MB_SOURCE_SNAPSHOT_ID__, 'musicbrainz', __MB_UPSTREAM_VERSION__, __MB_RETRIEVED_AT__,
    __MB_SOURCE_URL__, 'sha256', __MB_ARCHIVE_SHA256__, 'musicbrainz-core-cc0', true, 'validated'),
  (__DISCOGS_SOURCE_SNAPSHOT_ID__, 'discogs', __DISCOGS_UPSTREAM_VERSION__, __DISCOGS_RETRIEVED_AT__,
    __DISCOGS_SOURCE_URL__, 'sha256', __DISCOGS_MANIFEST_SHA256__, 'discogs-cc0', true, 'validated'),
  (__WIKIDATA_SOURCE_SNAPSHOT_ID__, 'wikidata', __WIKIDATA_UPSTREAM_VERSION__, __WIKIDATA_RETRIEVED_AT__,
    __WIKIDATA_SOURCE_URL__, 'sha256', __WIKIDATA_MANIFEST_SHA256__, 'wikidata-cc0', true, 'validated');

CREATE UNLOGGED TABLE __CANONICAL_SCHEMA__.stage_wd_claim AS
SELECT
  entity.payload->>'qid' AS qid,
  (entity.payload->>'revision_id')::bigint AS revision_id,
  property.key AS property,
  normalized.claim_value
FROM __CANONICAL_SCHEMA__.stage_wikidata_entity entity
CROSS JOIN LATERAL jsonb_each(COALESCE(entity.payload #> '{payload,claims}', '{}'::jsonb)) property
CROSS JOIN LATERAL jsonb_array_elements(property.value) claim
CROSS JOIN LATERAL (
  SELECT CASE jsonb_typeof(claim.value #> '{mainsnak,datavalue,value}')
    WHEN 'string' THEN claim.value #>> '{mainsnak,datavalue,value}'
    WHEN 'object' THEN claim.value #>> '{mainsnak,datavalue,value,id}'
    ELSE NULL
  END AS claim_value
) normalized
WHERE property.key IN ('P434', 'P1953', 'P436', 'P1954', 'P5813', 'P2206', 'P9219', 'P279', 'P737')
  AND COALESCE(claim.value->>'rank', 'normal') <> 'deprecated'
  AND normalized.claim_value IS NOT NULL;
CREATE INDEX stage_wd_claim_lookup_idx
  ON __CANONICAL_SCHEMA__.stage_wd_claim (qid, property, claim_value);

CREATE UNLOGGED TABLE __CANONICAL_SCHEMA__.stage_artist_crosswalk (
  mbid text NOT NULL,
  discogs_id text NOT NULL,
  qid text,
  evidence_id text NOT NULL,
  evidence_source text NOT NULL,
  evidence_locator text NOT NULL,
  accepted boolean NOT NULL DEFAULT false
);

INSERT INTO __CANONICAL_SCHEMA__.stage_artist_crosswalk
  (mbid, discogs_id, qid, evidence_id, evidence_source, evidence_locator)
SELECT DISTINCT
  artist.gid,
  (regexp_match(lower(resource.url), 'discogs\.com/(?:[a-z]{2}(?:-[a-z]{2})?/)?artist/([1-9][0-9]*)'))[1],
  NULL,
  'mb-url:artist:' || relation.id,
  'musicbrainz-url',
  'l_artist_url:' || relation.id
FROM __MUSICBRAINZ_SCHEMA__.l_artist_url relation
JOIN __MUSICBRAINZ_SCHEMA__.artist artist ON artist.id = relation.entity0
JOIN __MUSICBRAINZ_SCHEMA__.url resource ON resource.id = relation.entity1
JOIN __CANONICAL_SCHEMA__.stage_discogs_artist discogs
  ON discogs.payload->>'external_id' =
    (regexp_match(lower(resource.url), 'discogs\.com/(?:[a-z]{2}(?:-[a-z]{2})?/)?artist/([1-9][0-9]*)'))[1]
WHERE lower(resource.url) ~ 'discogs\.com/(?:[a-z]{2}(?:-[a-z]{2})?/)?artist/[1-9][0-9]*'
UNION ALL
SELECT DISTINCT
  (regexp_match(lower(profile_url.value), 'musicbrainz\.org/artist/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})'))[1],
  discogs.payload->>'external_id',
  NULL,
  'discogs-url:artist:' || (discogs.payload->>'external_id') || ':' || md5(profile_url.value),
  'discogs-url',
  'artist:' || (discogs.payload->>'external_id') || '#url'
FROM __CANONICAL_SCHEMA__.stage_discogs_artist discogs
CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(discogs.payload->'urls', '[]'::jsonb)) profile_url
JOIN __MUSICBRAINZ_SCHEMA__.artist artist
  ON lower(artist.gid) =
    (regexp_match(lower(profile_url.value), 'musicbrainz\.org/artist/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})'))[1]
WHERE lower(profile_url.value) ~ 'musicbrainz\.org/artist/[0-9a-f-]{36}'
UNION ALL
SELECT DISTINCT
  lower(mb.claim_value),
  discogs.claim_value,
  mb.qid,
  'wikidata:artist:' || mb.qid || ':' || mb.revision_id || ':' || md5(lower(mb.claim_value) || ':' || discogs.claim_value),
  'wikidata-claims',
  mb.qid || '@' || mb.revision_id || '#artist'
FROM __CANONICAL_SCHEMA__.stage_wd_claim mb
JOIN __CANONICAL_SCHEMA__.stage_wd_claim discogs ON discogs.qid = mb.qid
JOIN __MUSICBRAINZ_SCHEMA__.artist artist ON lower(artist.gid) = lower(mb.claim_value)
JOIN __CANONICAL_SCHEMA__.stage_discogs_artist discogs_artist
  ON discogs_artist.payload->>'external_id' = discogs.claim_value
WHERE mb.property = 'P434' AND discogs.property = 'P1953'
  AND mb.claim_value ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
  AND discogs.claim_value ~ '^[1-9][0-9]*$';

UPDATE __CANONICAL_SCHEMA__.stage_artist_crosswalk edge
SET accepted = true
WHERE (SELECT count(DISTINCT other.mbid)
       FROM __CANONICAL_SCHEMA__.stage_artist_crosswalk other
       WHERE other.discogs_id = edge.discogs_id) = 1
  AND (SELECT count(DISTINCT other.discogs_id)
       FROM __CANONICAL_SCHEMA__.stage_artist_crosswalk other
       WHERE other.mbid = edge.mbid) = 1;

CREATE UNLOGGED TABLE __CANONICAL_SCHEMA__.stage_release_group_crosswalk AS
SELECT DISTINCT
  release_group.gid AS mbid,
  (regexp_match(lower(resource.url), 'discogs\.com/(?:[a-z]{2}(?:-[a-z]{2})?/)?master/([1-9][0-9]*)'))[1] AS discogs_id,
  NULL::text AS qid,
  'mb-url:release-group:' || relation.id AS evidence_id,
  'musicbrainz-url'::text AS evidence_source,
  'l_release_group_url:' || relation.id AS evidence_locator,
  false AS accepted
FROM __MUSICBRAINZ_SCHEMA__.l_release_group_url relation
JOIN __MUSICBRAINZ_SCHEMA__.release_group release_group ON release_group.id = relation.entity0
JOIN __MUSICBRAINZ_SCHEMA__.url resource ON resource.id = relation.entity1
JOIN __CANONICAL_SCHEMA__.stage_discogs_master discogs
  ON discogs.payload->>'external_id' =
    (regexp_match(lower(resource.url), 'discogs\.com/(?:[a-z]{2}(?:-[a-z]{2})?/)?master/([1-9][0-9]*)'))[1]
WHERE lower(resource.url) ~ 'discogs\.com/(?:[a-z]{2}(?:-[a-z]{2})?/)?master/[1-9][0-9]*'
UNION ALL
SELECT DISTINCT
  lower(mb.claim_value), discogs.claim_value, mb.qid,
  'wikidata:release-group:' || mb.qid || ':' || mb.revision_id || ':' || md5(lower(mb.claim_value) || ':' || discogs.claim_value),
  'wikidata-claims', mb.qid || '@' || mb.revision_id || '#release_group', false
FROM __CANONICAL_SCHEMA__.stage_wd_claim mb
JOIN __CANONICAL_SCHEMA__.stage_wd_claim discogs ON discogs.qid = mb.qid
JOIN __MUSICBRAINZ_SCHEMA__.release_group release_group ON lower(release_group.gid) = lower(mb.claim_value)
JOIN __CANONICAL_SCHEMA__.stage_discogs_master discogs_master
  ON discogs_master.payload->>'external_id' = discogs.claim_value
WHERE mb.property = 'P436' AND discogs.property = 'P1954'
  AND mb.claim_value ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
  AND discogs.claim_value ~ '^[1-9][0-9]*$';

UPDATE __CANONICAL_SCHEMA__.stage_release_group_crosswalk edge
SET accepted = true
WHERE (SELECT count(DISTINCT other.mbid)
       FROM __CANONICAL_SCHEMA__.stage_release_group_crosswalk other
       WHERE other.discogs_id = edge.discogs_id) = 1
  AND (SELECT count(DISTINCT other.discogs_id)
       FROM __CANONICAL_SCHEMA__.stage_release_group_crosswalk other
       WHERE other.mbid = edge.mbid) = 1;

CREATE UNLOGGED TABLE __CANONICAL_SCHEMA__.stage_release_crosswalk AS
SELECT DISTINCT
  release.gid AS mbid,
  (regexp_match(lower(resource.url), 'discogs\.com/(?:[a-z]{2}(?:-[a-z]{2})?/)?release/([1-9][0-9]*)'))[1] AS discogs_id,
  NULL::text AS qid,
  'mb-url:release:' || relation.id AS evidence_id,
  'musicbrainz-url'::text AS evidence_source,
  'l_release_url:' || relation.id AS evidence_locator,
  false AS accepted
FROM __MUSICBRAINZ_SCHEMA__.l_release_url relation
JOIN __MUSICBRAINZ_SCHEMA__.release release ON release.id = relation.entity0
JOIN __MUSICBRAINZ_SCHEMA__.url resource ON resource.id = relation.entity1
JOIN __CANONICAL_SCHEMA__.stage_discogs_release discogs
  ON discogs.payload->>'external_id' =
    (regexp_match(lower(resource.url), 'discogs\.com/(?:[a-z]{2}(?:-[a-z]{2})?/)?release/([1-9][0-9]*)'))[1]
WHERE lower(resource.url) ~ 'discogs\.com/(?:[a-z]{2}(?:-[a-z]{2})?/)?release/[1-9][0-9]*'
UNION ALL
SELECT DISTINCT
  lower(mb.claim_value), discogs.claim_value, mb.qid,
  'wikidata:release:' || mb.qid || ':' || mb.revision_id || ':' || md5(lower(mb.claim_value) || ':' || discogs.claim_value),
  'wikidata-claims', mb.qid || '@' || mb.revision_id || '#release', false
FROM __CANONICAL_SCHEMA__.stage_wd_claim mb
JOIN __CANONICAL_SCHEMA__.stage_wd_claim discogs ON discogs.qid = mb.qid
JOIN __MUSICBRAINZ_SCHEMA__.release release ON lower(release.gid) = lower(mb.claim_value)
JOIN __CANONICAL_SCHEMA__.stage_discogs_release discogs_release
  ON discogs_release.payload->>'external_id' = discogs.claim_value
WHERE mb.property = 'P5813' AND discogs.property = 'P2206'
  AND mb.claim_value ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
  AND discogs.claim_value ~ '^[1-9][0-9]*$';

UPDATE __CANONICAL_SCHEMA__.stage_release_crosswalk edge
SET accepted = true
WHERE (SELECT count(DISTINCT other.mbid)
       FROM __CANONICAL_SCHEMA__.stage_release_crosswalk other
       WHERE other.discogs_id = edge.discogs_id) = 1
  AND (SELECT count(DISTINCT other.discogs_id)
       FROM __CANONICAL_SCHEMA__.stage_release_crosswalk other
       WHERE other.mbid = edge.mbid) = 1;

CREATE UNLOGGED TABLE __CANONICAL_SCHEMA__.selected_mb_artist AS
SELECT DISTINCT artist.id
FROM __MUSICBRAINZ_SCHEMA__.artist artist
JOIN __CANONICAL_SCHEMA__.stage_artist_crosswalk crosswalk
  ON lower(crosswalk.mbid) = lower(artist.gid) AND crosswalk.accepted
JOIN __CANONICAL_SCHEMA__.stage_discogs_artist discogs
  ON discogs.payload->>'external_id' = crosswalk.discogs_id
WHERE (discogs.payload->>'qualifies_rock')::boolean;

CREATE UNLOGGED TABLE __CANONICAL_SCHEMA__.selected_mb_release_group AS
SELECT DISTINCT release_group.id
FROM __MUSICBRAINZ_SCHEMA__.release_group release_group
JOIN __MUSICBRAINZ_SCHEMA__.artist_credit_name credit
  ON credit.artist_credit = release_group.artist_credit
JOIN __CANONICAL_SCHEMA__.selected_mb_artist artist ON artist.id = credit.artist;

CREATE UNLOGGED TABLE __CANONICAL_SCHEMA__.selected_mb_release AS
SELECT DISTINCT release.id
FROM __MUSICBRAINZ_SCHEMA__.release release
JOIN __CANONICAL_SCHEMA__.selected_mb_release_group release_group
  ON release_group.id = release.release_group;

CREATE UNLOGGED TABLE __CANONICAL_SCHEMA__.selected_mb_recording AS
SELECT DISTINCT recording.id
FROM __MUSICBRAINZ_SCHEMA__.recording recording
JOIN __MUSICBRAINZ_SCHEMA__.track track ON track.recording = recording.id
JOIN __MUSICBRAINZ_SCHEMA__.medium medium ON medium.id = track.medium
JOIN __CANONICAL_SCHEMA__.selected_mb_release release ON release.id = medium.release;

CREATE UNLOGGED TABLE __CANONICAL_SCHEMA__.selected_mb_artist_all AS
SELECT id FROM __CANONICAL_SCHEMA__.selected_mb_artist
UNION
SELECT credit.artist
FROM __MUSICBRAINZ_SCHEMA__.release_group release_group
JOIN __CANONICAL_SCHEMA__.selected_mb_release_group selected ON selected.id = release_group.id
JOIN __MUSICBRAINZ_SCHEMA__.artist_credit_name credit
  ON credit.artist_credit = release_group.artist_credit
UNION
SELECT credit.artist
FROM __MUSICBRAINZ_SCHEMA__.recording recording
JOIN __CANONICAL_SCHEMA__.selected_mb_recording selected ON selected.id = recording.id
JOIN __MUSICBRAINZ_SCHEMA__.artist_credit_name credit
  ON credit.artist_credit = recording.artist_credit
UNION
SELECT artist.id
FROM __MUSICBRAINZ_SCHEMA__.artist artist
JOIN __CANONICAL_SCHEMA__.stage_artist_crosswalk crosswalk
  ON lower(crosswalk.mbid) = lower(artist.gid) AND crosswalk.accepted;

CREATE INDEX selected_mb_artist_all_idx ON __CANONICAL_SCHEMA__.selected_mb_artist_all (id);
CREATE INDEX selected_mb_release_group_idx ON __CANONICAL_SCHEMA__.selected_mb_release_group (id);
CREATE INDEX selected_mb_release_idx ON __CANONICAL_SCHEMA__.selected_mb_release (id);
CREATE INDEX selected_mb_recording_idx ON __CANONICAL_SCHEMA__.selected_mb_recording (id);

CREATE FUNCTION __CANONICAL_SCHEMA__.date_text(year_text text, month_text text, day_text text)
RETURNS text
LANGUAGE sql
IMMUTABLE
RETURN CASE
  WHEN year_text IS NULL OR year_text = E'\\N' THEN NULL
  WHEN month_text IS NULL OR month_text = E'\\N' THEN year_text
  WHEN day_text IS NULL OR day_text = E'\\N' THEN year_text || '-' || lpad(month_text, 2, '0')
  ELSE year_text || '-' || lpad(month_text, 2, '0') || '-' || lpad(day_text, 2, '0')
END;

INSERT INTO __CANONICAL_SCHEMA__.artist (
  internal_id, canonical_name, sort_name, artist_type, begin_date_text, end_date_text,
  country_code, source_metadata, first_seen_snapshot_id
)
SELECT
  'mw:artist:mb:' || artist.gid,
  artist.name,
  artist.sort_name,
  NULLIF(artist_type.name, E'\\N'),
  __CANONICAL_SCHEMA__.date_text(artist.begin_date_year, artist.begin_date_month, artist.begin_date_day),
  __CANONICAL_SCHEMA__.date_text(artist.end_date_year, artist.end_date_month, artist.end_date_day),
  NULLIF(country.code, E'\\N'),
  jsonb_build_object(
    'source_url', 'https://musicbrainz.org/artist/' || artist.gid,
    'musicbrainz_mbid', artist.gid
  ),
  __MB_SOURCE_SNAPSHOT_ID__
FROM __MUSICBRAINZ_SCHEMA__.artist artist
JOIN __CANONICAL_SCHEMA__.selected_mb_artist_all selected ON selected.id = artist.id
LEFT JOIN __MUSICBRAINZ_SCHEMA__.artist_type artist_type ON artist_type.id = artist.type
LEFT JOIN __MUSICBRAINZ_SCHEMA__.iso_3166_1 country ON country.area = artist.area;

INSERT INTO __CANONICAL_SCHEMA__.release_group (
  internal_id, canonical_name, primary_type, secondary_types, source_metadata,
  first_seen_snapshot_id
)
SELECT
  'mw:release-group:mb:' || release_group.gid,
  release_group.name,
  COALESCE(NULLIF(primary_type.name, E'\\N'), 'Other'),
  ARRAY(
    SELECT secondary_type.name
    FROM __MUSICBRAINZ_SCHEMA__.release_group_secondary_type_join type_join
    JOIN __MUSICBRAINZ_SCHEMA__.release_group_secondary_type secondary_type
      ON secondary_type.id = type_join.secondary_type
    WHERE type_join.release_group = release_group.id
    ORDER BY secondary_type.name
  ),
  jsonb_build_object(
    'source_url', 'https://musicbrainz.org/release-group/' || release_group.gid,
    'musicbrainz_mbid', release_group.gid
  ),
  __MB_SOURCE_SNAPSHOT_ID__
FROM __MUSICBRAINZ_SCHEMA__.release_group release_group
JOIN __CANONICAL_SCHEMA__.selected_mb_release_group selected ON selected.id = release_group.id
LEFT JOIN __MUSICBRAINZ_SCHEMA__.release_group_primary_type primary_type
  ON primary_type.id = release_group.type;

INSERT INTO __CANONICAL_SCHEMA__.release_group_artist (
  release_group_id, artist_id, credit_position, credited_name, join_phrase
)
SELECT
  'mw:release-group:mb:' || release_group.gid,
  'mw:artist:mb:' || artist.gid,
  credit.position::integer,
  credit.name,
  NULLIF(credit.join_phrase, E'\\N')
FROM __MUSICBRAINZ_SCHEMA__.release_group release_group
JOIN __CANONICAL_SCHEMA__.selected_mb_release_group selected ON selected.id = release_group.id
JOIN __MUSICBRAINZ_SCHEMA__.artist_credit_name credit
  ON credit.artist_credit = release_group.artist_credit
JOIN __MUSICBRAINZ_SCHEMA__.artist artist ON artist.id = credit.artist;

WITH preferred_event AS (
  SELECT DISTINCT ON (release_id)
    release_id, country_code, date_year, date_month, date_day
  FROM (
    SELECT
      release_country.release AS release_id,
      NULLIF(country.code, E'\\N') AS country_code,
      NULLIF(release_country.date_year, E'\\N') AS date_year,
      NULLIF(release_country.date_month, E'\\N') AS date_month,
      NULLIF(release_country.date_day, E'\\N') AS date_day,
      0 AS unknown_order
    FROM __MUSICBRAINZ_SCHEMA__.release_country release_country
    LEFT JOIN __MUSICBRAINZ_SCHEMA__.iso_3166_1 country ON country.area = release_country.country
    UNION ALL
    SELECT release, NULL, NULLIF(date_year, E'\\N'), NULLIF(date_month, E'\\N'),
      NULLIF(date_day, E'\\N'), 1
    FROM __MUSICBRAINZ_SCHEMA__.release_unknown_country
  ) events
  ORDER BY release_id, unknown_order, date_year NULLS LAST, date_month NULLS LAST,
    date_day NULLS LAST, country_code NULLS LAST
)
INSERT INTO __CANONICAL_SCHEMA__.release (
  internal_id, release_group_id, title, release_date_text, country_code, status,
  packaging, barcode, first_seen_snapshot_id
)
SELECT
  'mw:release:mb:' || release.gid,
  'mw:release-group:mb:' || release_group.gid,
  release.name,
  __CANONICAL_SCHEMA__.date_text(event.date_year, event.date_month, event.date_day),
  event.country_code,
  NULLIF(release_status.name, E'\\N'),
  NULLIF(release_packaging.name, E'\\N'),
  NULLIF(release.barcode, E'\\N'),
  __MB_SOURCE_SNAPSHOT_ID__
FROM __MUSICBRAINZ_SCHEMA__.release release
JOIN __CANONICAL_SCHEMA__.selected_mb_release selected ON selected.id = release.id
JOIN __MUSICBRAINZ_SCHEMA__.release_group release_group ON release_group.id = release.release_group
LEFT JOIN preferred_event event ON event.release_id = release.id
LEFT JOIN __MUSICBRAINZ_SCHEMA__.release_status release_status ON release_status.id = release.status
LEFT JOIN __MUSICBRAINZ_SCHEMA__.release_packaging release_packaging
  ON release_packaging.id = release.packaging;

UPDATE __CANONICAL_SCHEMA__.release_group release_group
SET first_release_date_text = dates.first_release_date_text
FROM (
  SELECT release_group_id, min(release_date_text) AS first_release_date_text
  FROM __CANONICAL_SCHEMA__.release
  WHERE release_date_text IS NOT NULL
  GROUP BY release_group_id
) dates
WHERE dates.release_group_id = release_group.internal_id;

WITH events AS (
  SELECT
    release_country.release AS release_id,
    NULLIF(country.code, E'\\N') AS country_code,
    NULLIF(release_country.date_year, E'\\N') AS date_year,
    NULLIF(release_country.date_month, E'\\N') AS date_month,
    NULLIF(release_country.date_day, E'\\N') AS date_day,
    0 AS unknown_order
  FROM __MUSICBRAINZ_SCHEMA__.release_country release_country
  LEFT JOIN __MUSICBRAINZ_SCHEMA__.iso_3166_1 country ON country.area = release_country.country
  UNION ALL
  SELECT release, NULL, NULLIF(date_year, E'\\N'), NULLIF(date_month, E'\\N'),
    NULLIF(date_day, E'\\N'), 1
  FROM __MUSICBRAINZ_SCHEMA__.release_unknown_country
), numbered AS (
  SELECT events.*,
    row_number() OVER (
      PARTITION BY release_id
      ORDER BY unknown_order, date_year NULLS LAST, date_month NULLS LAST,
        date_day NULLS LAST, country_code NULLS LAST
    )::integer AS event_position
  FROM events
)
INSERT INTO __CANONICAL_SCHEMA__.release_event (
  release_id, event_position, country_code, date_year, date_month, date_day, source_snapshot_id
)
SELECT
  'mw:release:mb:' || release.gid,
  numbered.event_position,
  numbered.country_code,
  numbered.date_year::smallint,
  numbered.date_month::smallint,
  numbered.date_day::smallint,
  __MB_SOURCE_SNAPSHOT_ID__
FROM numbered
JOIN __MUSICBRAINZ_SCHEMA__.release release ON release.id = numbered.release_id
JOIN __CANONICAL_SCHEMA__.selected_mb_release selected ON selected.id = release.id;

INSERT INTO __CANONICAL_SCHEMA__.medium (release_id, position, format_name, track_count)
SELECT
  'mw:release:mb:' || release.gid,
  medium.position::integer,
  NULLIF(medium_format.name, E'\\N'),
  NULLIF(medium.track_count, E'\\N')::integer
FROM __MUSICBRAINZ_SCHEMA__.medium medium
JOIN __MUSICBRAINZ_SCHEMA__.release release ON release.id = medium.release
JOIN __CANONICAL_SCHEMA__.selected_mb_release selected ON selected.id = release.id
LEFT JOIN __MUSICBRAINZ_SCHEMA__.medium_format medium_format ON medium_format.id = medium.format;

INSERT INTO __CANONICAL_SCHEMA__.recording (
  internal_id, canonical_name, length_ms, video, first_seen_snapshot_id
)
SELECT
  'mw:recording:mb:' || recording.gid,
  recording.name,
  NULLIF(recording.length, E'\\N')::integer,
  COALESCE(NULLIF(recording.video, E'\\N')::boolean, false),
  __MB_SOURCE_SNAPSHOT_ID__
FROM __MUSICBRAINZ_SCHEMA__.recording recording
JOIN __CANONICAL_SCHEMA__.selected_mb_recording selected ON selected.id = recording.id;

INSERT INTO __CANONICAL_SCHEMA__.recording_artist (
  recording_id, artist_id, credit_position, credited_name, join_phrase
)
SELECT
  'mw:recording:mb:' || recording.gid,
  'mw:artist:mb:' || artist.gid,
  credit.position::integer,
  credit.name,
  NULLIF(credit.join_phrase, E'\\N')
FROM __MUSICBRAINZ_SCHEMA__.recording recording
JOIN __CANONICAL_SCHEMA__.selected_mb_recording selected ON selected.id = recording.id
JOIN __MUSICBRAINZ_SCHEMA__.artist_credit_name credit
  ON credit.artist_credit = recording.artist_credit
JOIN __MUSICBRAINZ_SCHEMA__.artist artist ON artist.id = credit.artist;

INSERT INTO __CANONICAL_SCHEMA__.track (
  release_id, medium_position, position, recording_id, title, number_text, length_ms
)
SELECT
  'mw:release:mb:' || release.gid,
  medium.position::integer,
  track.position::integer,
  'mw:recording:mb:' || recording.gid,
  track.name,
  NULLIF(track.number, E'\\N'),
  NULLIF(track.length, E'\\N')::integer
FROM __MUSICBRAINZ_SCHEMA__.track track
JOIN __MUSICBRAINZ_SCHEMA__.medium medium ON medium.id = track.medium
JOIN __MUSICBRAINZ_SCHEMA__.release release ON release.id = medium.release
JOIN __CANONICAL_SCHEMA__.selected_mb_release selected_release ON selected_release.id = release.id
JOIN __MUSICBRAINZ_SCHEMA__.recording recording ON recording.id = track.recording
JOIN __CANONICAL_SCHEMA__.selected_mb_recording selected_recording
  ON selected_recording.id = recording.id;

CREATE UNLOGGED TABLE __CANONICAL_SCHEMA__.stage_discogs_artist_resolution AS
SELECT
  discogs.payload->>'external_id' AS external_id,
  CASE WHEN accepted.mbid IS NOT NULL
    THEN 'mw:artist:mb:' || accepted.mbid
    ELSE 'mw:artist:discogs:' || (discogs.payload->>'external_id')
  END AS internal_id,
  accepted.mbid IS NOT NULL AS mapped_to_musicbrainz
FROM __CANONICAL_SCHEMA__.stage_discogs_artist discogs
LEFT JOIN LATERAL (
  SELECT min(crosswalk.mbid) AS mbid
  FROM __CANONICAL_SCHEMA__.stage_artist_crosswalk crosswalk
  WHERE crosswalk.discogs_id = discogs.payload->>'external_id' AND crosswalk.accepted
) accepted ON true;
CREATE UNIQUE INDEX stage_discogs_artist_resolution_idx
  ON __CANONICAL_SCHEMA__.stage_discogs_artist_resolution (external_id);

INSERT INTO __CANONICAL_SCHEMA__.artist (
  internal_id, canonical_name, sort_name, artist_type, source_metadata,
  first_seen_snapshot_id
)
SELECT
  resolution.internal_id,
  discogs.payload->>'name',
  discogs.payload->>'name',
  'Discogs fallback',
  jsonb_build_object(
    'source_url', 'https://www.discogs.com/artist/' || (discogs.payload->>'external_id'),
    'discogs_artist_id', discogs.payload->>'external_id'
  ),
  __DISCOGS_SOURCE_SNAPSHOT_ID__
FROM __CANONICAL_SCHEMA__.stage_discogs_artist discogs
JOIN __CANONICAL_SCHEMA__.stage_discogs_artist_resolution resolution
  ON resolution.external_id = discogs.payload->>'external_id'
WHERE NOT resolution.mapped_to_musicbrainz;

INSERT INTO __CANONICAL_SCHEMA__.artist_alias (
  artist_id, alias, locale, alias_type, source_snapshot_id
)
SELECT DISTINCT
  resolution.internal_id,
  alias.value,
  NULL,
  'Discogs alias',
  __DISCOGS_SOURCE_SNAPSHOT_ID__
FROM __CANONICAL_SCHEMA__.stage_discogs_artist discogs
JOIN __CANONICAL_SCHEMA__.stage_discogs_artist_resolution resolution
  ON resolution.external_id = discogs.payload->>'external_id'
CROSS JOIN LATERAL jsonb_array_elements_text(
  COALESCE(discogs.payload->'aliases', '[]'::jsonb) ||
  COALESCE(discogs.payload->'name_variations', '[]'::jsonb)
) alias
WHERE alias.value <> ''
ON CONFLICT DO NOTHING;

CREATE UNLOGGED TABLE __CANONICAL_SCHEMA__.stage_discogs_master_resolution AS
SELECT
  master.payload->>'external_id' AS external_id,
  CASE WHEN accepted.mbid IS NOT NULL
    THEN 'mw:release-group:mb:' || accepted.mbid
    ELSE 'mw:release-group:discogs:' || (master.payload->>'external_id')
  END AS internal_id,
  accepted.mbid IS NOT NULL AS mapped_to_musicbrainz
FROM __CANONICAL_SCHEMA__.stage_discogs_master master
LEFT JOIN LATERAL (
  SELECT min(crosswalk.mbid) AS mbid
  FROM __CANONICAL_SCHEMA__.stage_release_group_crosswalk crosswalk
  JOIN __MUSICBRAINZ_SCHEMA__.release_group release_group
    ON lower(release_group.gid) = lower(crosswalk.mbid)
  JOIN __CANONICAL_SCHEMA__.selected_mb_release_group selected ON selected.id = release_group.id
  WHERE crosswalk.discogs_id = master.payload->>'external_id' AND crosswalk.accepted
) accepted ON true;
CREATE UNIQUE INDEX stage_discogs_master_resolution_idx
  ON __CANONICAL_SCHEMA__.stage_discogs_master_resolution (external_id);

CREATE UNLOGGED TABLE __CANONICAL_SCHEMA__.stage_discogs_release_resolution AS
SELECT
  release.payload->>'external_id' AS external_id,
  CASE WHEN accepted.mbid IS NOT NULL
    THEN 'mw:release:mb:' || accepted.mbid
    ELSE 'mw:release:discogs:' || (release.payload->>'external_id')
  END AS internal_id,
  accepted.mbid IS NOT NULL AS mapped_to_musicbrainz
FROM __CANONICAL_SCHEMA__.stage_discogs_release release
LEFT JOIN LATERAL (
  SELECT min(crosswalk.mbid) AS mbid
  FROM __CANONICAL_SCHEMA__.stage_release_crosswalk crosswalk
  JOIN __MUSICBRAINZ_SCHEMA__.release mb_release
    ON lower(mb_release.gid) = lower(crosswalk.mbid)
  JOIN __CANONICAL_SCHEMA__.selected_mb_release selected ON selected.id = mb_release.id
  WHERE crosswalk.discogs_id = release.payload->>'external_id' AND crosswalk.accepted
) accepted ON true;
CREATE UNIQUE INDEX stage_discogs_release_resolution_idx
  ON __CANONICAL_SCHEMA__.stage_discogs_release_resolution (external_id);

-- discogs-fallback keeps every selected album that has no unambiguous MusicBrainz identity.
INSERT INTO __CANONICAL_SCHEMA__.release_group (
  internal_id, canonical_name, primary_type, secondary_types, first_release_date_text,
  source_metadata, first_seen_snapshot_id
)
SELECT
  resolution.internal_id,
  master.payload->>'title',
  'Other',
  ARRAY['Discogs fallback'],
  NULLIF(master.payload->>'year', ''),
  jsonb_build_object(
    'source_url', 'https://www.discogs.com/master/' || (master.payload->>'external_id'),
    'discogs_master_id', master.payload->>'external_id'
  ),
  __DISCOGS_SOURCE_SNAPSHOT_ID__
FROM __CANONICAL_SCHEMA__.stage_discogs_master master
JOIN __CANONICAL_SCHEMA__.stage_discogs_master_resolution resolution
  ON resolution.external_id = master.payload->>'external_id'
WHERE NOT resolution.mapped_to_musicbrainz
UNION ALL
SELECT
  'mw:release-group:discogs-release:' || (release.payload->>'external_id'),
  release.payload->>'title',
  'Other',
  ARRAY['Discogs fallback'],
  NULLIF(release.payload->>'released', ''),
  jsonb_build_object(
    'source_url', 'https://www.discogs.com/release/' || (release.payload->>'external_id'),
    'discogs_release_id', release.payload->>'external_id'
  ),
  __DISCOGS_SOURCE_SNAPSHOT_ID__
FROM __CANONICAL_SCHEMA__.stage_discogs_release release
JOIN __CANONICAL_SCHEMA__.stage_discogs_release_resolution resolution
  ON resolution.external_id = release.payload->>'external_id'
WHERE NOT resolution.mapped_to_musicbrainz
  AND COALESCE(release.payload->>'master_external_id', '') = '';

INSERT INTO __CANONICAL_SCHEMA__.release_group_artist (
  release_group_id, artist_id, credit_position, credited_name, join_phrase
)
SELECT
  master_resolution.internal_id,
  artist_resolution.internal_id,
  credit.ordinality::integer - 1,
  credit.value->>'name',
  NULLIF(credit.value->>'join', '')
FROM __CANONICAL_SCHEMA__.stage_discogs_master master
JOIN __CANONICAL_SCHEMA__.stage_discogs_master_resolution master_resolution
  ON master_resolution.external_id = master.payload->>'external_id'
CROSS JOIN LATERAL jsonb_array_elements(master.payload->'artists') WITH ORDINALITY credit(value, ordinality)
JOIN __CANONICAL_SCHEMA__.stage_discogs_artist_resolution artist_resolution
  ON artist_resolution.external_id = credit.value->>'external_id'
WHERE NOT master_resolution.mapped_to_musicbrainz
UNION ALL
SELECT
  'mw:release-group:discogs-release:' || (release.payload->>'external_id'),
  artist_resolution.internal_id,
  credit.ordinality::integer - 1,
  credit.value->>'name',
  NULLIF(credit.value->>'join', '')
FROM __CANONICAL_SCHEMA__.stage_discogs_release release
JOIN __CANONICAL_SCHEMA__.stage_discogs_release_resolution release_resolution
  ON release_resolution.external_id = release.payload->>'external_id'
CROSS JOIN LATERAL jsonb_array_elements(release.payload->'artists') WITH ORDINALITY credit(value, ordinality)
JOIN __CANONICAL_SCHEMA__.stage_discogs_artist_resolution artist_resolution
  ON artist_resolution.external_id = credit.value->>'external_id'
WHERE NOT release_resolution.mapped_to_musicbrainz
  AND COALESCE(release.payload->>'master_external_id', '') = '';

INSERT INTO __CANONICAL_SCHEMA__.release (
  internal_id, release_group_id, title, release_date_text, country_code,
  status, packaging, barcode, first_seen_snapshot_id
)
SELECT
  release_resolution.internal_id,
  COALESCE(master_resolution.internal_id,
    'mw:release-group:discogs-release:' || (release.payload->>'external_id')),
  release.payload->>'title',
  NULLIF(release.payload->>'released', ''),
  NULLIF(release.payload->>'country', ''),
  NULL,
  NULL,
  NULL,
  __DISCOGS_SOURCE_SNAPSHOT_ID__
FROM __CANONICAL_SCHEMA__.stage_discogs_release release
JOIN __CANONICAL_SCHEMA__.stage_discogs_release_resolution release_resolution
  ON release_resolution.external_id = release.payload->>'external_id'
LEFT JOIN __CANONICAL_SCHEMA__.stage_discogs_master_resolution master_resolution
  ON master_resolution.external_id = release.payload->>'master_external_id'
WHERE NOT release_resolution.mapped_to_musicbrainz;

INSERT INTO __CANONICAL_SCHEMA__.medium (release_id, position, format_name, track_count)
SELECT
  release_resolution.internal_id,
  format.ordinality::integer,
  NULLIF(format.value->>'name', ''),
  NULL
FROM __CANONICAL_SCHEMA__.stage_discogs_release release
JOIN __CANONICAL_SCHEMA__.stage_discogs_release_resolution release_resolution
  ON release_resolution.external_id = release.payload->>'external_id'
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(release.payload->'formats', '[]'::jsonb))
  WITH ORDINALITY format(value, ordinality)
WHERE NOT release_resolution.mapped_to_musicbrainz;

CREATE UNLOGGED TABLE __CANONICAL_SCHEMA__.stage_wikidata_rock_style AS
SELECT
  entity.payload->>'qid' AS qid,
  (entity.payload->>'revision_id')::bigint AS revision_id,
  'mw:style:wikidata:' || lower(entity.payload->>'qid') AS internal_id,
  entity.payload #>> '{rock_style,label}' AS canonical_name,
  COALESCE(entity.payload #>> '{rock_style,description}', '') AS description,
  NULLIF(entity.payload #>> '{rock_style,origin_date}', '') AS origin_date_text,
  NULLIF(array_to_string(ARRAY(
    SELECT jsonb_array_elements_text(entity.payload #> '{rock_style,country_labels}')
  ), ' | '), '') AS region_text,
  COALESCE(entity.payload #> '{rock_style,parent_qids}', '[]'::jsonb) AS parent_qids,
  NULLIF(entity.payload #>> '{rock_style,source_revision_id}', '') AS scope_revision_id
FROM __CANONICAL_SCHEMA__.stage_wikidata_entity entity
WHERE COALESCE(entity.payload->'roles', '[]'::jsonb) ? 'rock-style';
CREATE UNIQUE INDEX stage_wikidata_rock_style_qid_idx
  ON __CANONICAL_SCHEMA__.stage_wikidata_rock_style (qid);

-- P9219 is accepted only as a one-to-one Wikidata/Discogs style crosswalk.
CREATE UNLOGGED TABLE __CANONICAL_SCHEMA__.stage_style_wikidata AS
SELECT DISTINCT
  claim.qid,
  claim.revision_id,
  lower(claim.claim_value) AS external_id,
  rock_style.internal_id,
  false AS accepted
FROM __CANONICAL_SCHEMA__.stage_wd_claim claim
JOIN __CANONICAL_SCHEMA__.stage_wikidata_rock_style rock_style
  ON rock_style.qid = claim.qid
JOIN __CANONICAL_SCHEMA__.stage_discogs_style discogs_style
  ON lower(discogs_style.payload->>'style') = lower(claim.claim_value)
WHERE claim.property = 'P9219';
CREATE UNIQUE INDEX stage_style_wikidata_pair_idx
  ON __CANONICAL_SCHEMA__.stage_style_wikidata (qid, external_id);

UPDATE __CANONICAL_SCHEMA__.stage_style_wikidata edge
SET accepted = true
WHERE (SELECT count(DISTINCT other.external_id)
       FROM __CANONICAL_SCHEMA__.stage_style_wikidata other
       WHERE other.qid = edge.qid) = 1
  AND (SELECT count(DISTINCT other.qid)
       FROM __CANONICAL_SCHEMA__.stage_style_wikidata other
       WHERE other.external_id = edge.external_id) = 1;

CREATE UNLOGGED TABLE __CANONICAL_SCHEMA__.stage_style_resolution AS
SELECT
  lower(discogs_style.payload->>'style') AS external_id,
  COALESCE(mapping.internal_id,
    'mw:style:discogs:' || md5(lower(discogs_style.payload->>'style'))) AS internal_id,
  discogs_style.payload->>'style' AS canonical_name,
  discogs_style.payload->>'classification' AS inclusion_status
FROM __CANONICAL_SCHEMA__.stage_discogs_style discogs_style
LEFT JOIN __CANONICAL_SCHEMA__.stage_style_wikidata mapping
  ON mapping.external_id = lower(discogs_style.payload->>'style') AND mapping.accepted;
CREATE UNIQUE INDEX stage_style_resolution_idx
  ON __CANONICAL_SCHEMA__.stage_style_resolution (external_id);

INSERT INTO __CANONICAL_SCHEMA__.style (
  internal_id, canonical_name, sort_name, description, origin_date_text,
  region_text, source_metadata, inclusion_status, first_seen_snapshot_id
)
SELECT
  internal_id,
  canonical_name,
  lower(canonical_name),
  description,
  origin_date_text,
  region_text,
  jsonb_build_object(
    'source_url', 'https://www.wikidata.org/wiki/Special:EntityData/' || qid || '.json',
    'wikidata_qid', qid,
    'revision_id', revision_id,
    'scope_revision_id', scope_revision_id,
    'parent_qids', parent_qids
  ),
  'accepted',
  __WIKIDATA_SOURCE_SNAPSHOT_ID__
FROM __CANONICAL_SCHEMA__.stage_wikidata_rock_style;

INSERT INTO __CANONICAL_SCHEMA__.style AS canonical_style (
  internal_id, canonical_name, sort_name, source_metadata,
  inclusion_status, first_seen_snapshot_id
)
SELECT
  internal_id,
  canonical_name,
  lower(canonical_name),
  jsonb_build_object('discogs_style', external_id),
  inclusion_status,
  __DISCOGS_SOURCE_SNAPSHOT_ID__
FROM __CANONICAL_SCHEMA__.stage_style_resolution
ON CONFLICT (internal_id) DO UPDATE SET
  source_metadata = canonical_style.source_metadata || EXCLUDED.source_metadata,
  inclusion_status = CASE
    WHEN canonical_style.inclusion_status = 'accepted' OR EXCLUDED.inclusion_status = 'accepted'
      THEN 'accepted'
    ELSE EXCLUDED.inclusion_status
  END;

INSERT INTO __CANONICAL_SCHEMA__.release_style_assertion (
  release_group_id, style_id, source_snapshot_id, assertion_basis,
  confidence_status, evidence_locators
)
SELECT
  COALESCE(
    master_resolution.internal_id,
    'mw:release-group:discogs-release:' || (release.payload->>'external_id')
  ),
  style_resolution.internal_id,
  __DISCOGS_SOURCE_SNAPSHOT_ID__,
  'discogs-release-style',
  'observed',
  array_agg(
    DISTINCT 'discogs:release:' || (release.payload->>'external_id')
    ORDER BY 'discogs:release:' || (release.payload->>'external_id')
  )
FROM __CANONICAL_SCHEMA__.stage_discogs_release release
CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(release.payload->'genres', '[]'::jsonb)) genre
CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(release.payload->'styles', '[]'::jsonb)) style
JOIN __CANONICAL_SCHEMA__.stage_style_resolution style_resolution
  ON style_resolution.external_id = lower(style.value)
LEFT JOIN __CANONICAL_SCHEMA__.stage_discogs_master_resolution master_resolution
  ON master_resolution.external_id = release.payload->>'master_external_id'
WHERE genre.value = 'Rock'
GROUP BY COALESCE(
  master_resolution.internal_id,
  'mw:release-group:discogs-release:' || (release.payload->>'external_id')
), style_resolution.internal_id;

INSERT INTO __CANONICAL_SCHEMA__.artist_style_qualification (
  artist_id, style_id, source_snapshot_id, derivation_rule_version,
  source_release_group_ids, evidence_locators, confidence_status
)
SELECT
  credit.artist_id,
  classification.style_id,
  classification.source_snapshot_id,
  'release-credit-style-qualification-v1',
  array_agg(DISTINCT classification.release_group_id ORDER BY classification.release_group_id),
  array_agg(DISTINCT evidence_locator ORDER BY evidence_locator),
  'derived'
FROM __CANONICAL_SCHEMA__.release_style_assertion classification
JOIN __CANONICAL_SCHEMA__.release_group_artist credit
  ON credit.release_group_id = classification.release_group_id
CROSS JOIN LATERAL unnest(classification.evidence_locators) evidence_locator
WHERE classification.source_snapshot_id = __DISCOGS_SOURCE_SNAPSHOT_ID__
GROUP BY credit.artist_id, classification.style_id, classification.source_snapshot_id;

INSERT INTO __CANONICAL_SCHEMA__.style_relation_assertion (
  from_style_id, to_style_id, relation_kind, source_snapshot_id,
  confidence_status, evidence_locator
)
SELECT
  left_style.internal_id,
  right_style.internal_id,
  'co_tagged_with',
  __DISCOGS_SOURCE_SNAPSHOT_ID__,
  'observed',
  min('discogs:release:' || (release.payload->>'external_id'))
FROM __CANONICAL_SCHEMA__.stage_discogs_release release
CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(release.payload->'genres', '[]'::jsonb)) genre
CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(release.payload->'styles', '[]'::jsonb)) left_name
CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(release.payload->'styles', '[]'::jsonb)) right_name
JOIN __CANONICAL_SCHEMA__.stage_style_resolution left_style
  ON left_style.external_id = lower(left_name.value)
JOIN __CANONICAL_SCHEMA__.stage_style_resolution right_style
  ON right_style.external_id = lower(right_name.value)
WHERE genre.value = 'Rock' AND left_style.internal_id < right_style.internal_id
GROUP BY left_style.internal_id, right_style.internal_id
ON CONFLICT DO NOTHING;

CREATE UNLOGGED TABLE __CANONICAL_SCHEMA__.stage_discogs_relation_v2 AS
SELECT
  'mw:relation:' || md5(
    'co_tagged_with:' || left_style.internal_id || ':' || right_style.internal_id
  ) AS relation_id,
  left_style.internal_id AS left_style_id,
  right_style.internal_id AS right_style_id,
  min(release.payload->>'external_id') AS release_external_id
FROM __CANONICAL_SCHEMA__.stage_discogs_release release
CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(release.payload->'genres', '[]'::jsonb)) genre
CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(release.payload->'styles', '[]'::jsonb)) left_name
CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(release.payload->'styles', '[]'::jsonb)) right_name
JOIN __CANONICAL_SCHEMA__.stage_style_resolution left_style
  ON left_style.external_id = lower(left_name.value)
JOIN __CANONICAL_SCHEMA__.stage_style_resolution right_style
  ON right_style.external_id = lower(right_name.value)
WHERE genre.value = 'Rock' AND left_style.internal_id < right_style.internal_id
GROUP BY left_style.internal_id, right_style.internal_id;

INSERT INTO __CANONICAL_SCHEMA__.style_relation (relation_id, relation_kind, direction)
SELECT relation_id, 'co_tagged_with', 'undirected'
FROM __CANONICAL_SCHEMA__.stage_discogs_relation_v2
ON CONFLICT DO NOTHING;

INSERT INTO __CANONICAL_SCHEMA__.style_relation_participant (
  relation_id, style_id, participant_role, ordinal
)
SELECT relation_id, left_style_id, 'peer', 0
FROM __CANONICAL_SCHEMA__.stage_discogs_relation_v2
UNION ALL
SELECT relation_id, right_style_id, 'peer', 1
FROM __CANONICAL_SCHEMA__.stage_discogs_relation_v2;

INSERT INTO __CANONICAL_SCHEMA__.style_relation_evidence (
  evidence_id, source_snapshot_id, source_dataset, source_record_id,
  source_url, evidence_locator, claim_text, retrieved_at, license_partition
)
SELECT
  'mw:evidence:discogs:co-tagged:' || substring(relation_id from 13),
  __DISCOGS_SOURCE_SNAPSHOT_ID__,
  'Discogs',
  'release:' || release_external_id,
  'https://www.discogs.com/release/' || release_external_id,
  'release.' || release_external_id || '.styles',
  left_style_id || ' and ' || right_style_id || ' co-occur on a Rock release',
  __DISCOGS_RETRIEVED_AT__,
  'discogs-cc0'
FROM __CANONICAL_SCHEMA__.stage_discogs_relation_v2
ON CONFLICT DO NOTHING;

INSERT INTO __CANONICAL_SCHEMA__.style_relation_assertion_v2 (
  assertion_id, relation_id, claim_key, assertion_kind, stance, review_status,
  metadata_completeness, claim_geographies, claim_contexts,
  confidence_band, source_datasets, snapshot_version, pipeline_version,
  license_partition, created_at
)
SELECT
  'mw:assertion:' || substring(relation_id from 13),
  relation_id,
  'mw:claim:' || substring(relation_id from 13),
  'inferred',
  'supports',
  'accepted',
  'participants_only',
  ARRAY[]::text[],
  ARRAY[]::text[],
  'medium',
  ARRAY['Discogs'],
  __DISCOGS_UPSTREAM_VERSION__,
  'offline-canonical-v2',
  'discogs-cc0',
  __GENERATED_AT__::timestamptz
FROM __CANONICAL_SCHEMA__.stage_discogs_relation_v2;

INSERT INTO __CANONICAL_SCHEMA__.style_relation_assertion_evidence_v2 (
  assertion_id, evidence_id
)
SELECT
  'mw:assertion:' || substring(relation_id from 13),
  'mw:evidence:discogs:co-tagged:' || substring(relation_id from 13)
FROM __CANONICAL_SCHEMA__.stage_discogs_relation_v2;

INSERT INTO __CANONICAL_SCHEMA__.style_relation_assertion (
  from_style_id, to_style_id, relation_kind, source_snapshot_id,
  confidence_status, evidence_locator
)
SELECT DISTINCT
  subject.internal_id,
  object.internal_id,
  CASE relation.property WHEN 'P279' THEN 'subgenre_of' ELSE 'influenced_by' END,
  __WIKIDATA_SOURCE_SNAPSHOT_ID__,
  'observed',
  relation.qid || '@' || relation.revision_id || '#' || relation.property
FROM __CANONICAL_SCHEMA__.stage_wd_claim relation
JOIN __CANONICAL_SCHEMA__.stage_wikidata_rock_style subject
  ON subject.qid = relation.qid
JOIN __CANONICAL_SCHEMA__.stage_wikidata_rock_style object
  ON object.qid = upper(relation.claim_value)
WHERE relation.property IN ('P279', 'P737')
  AND relation.claim_value ~* '^Q[1-9][0-9]*$'
  AND subject.internal_id <> object.internal_id
ON CONFLICT DO NOTHING;

-- Publish the same evidence-backed Wikidata claims into the V2 participant model.
-- P737 means "subject is influenced by object", so its energy direction is object -> subject.
CREATE UNLOGGED TABLE __CANONICAL_SCHEMA__.stage_style_relation_v2 AS
SELECT DISTINCT
  'mw:relation:' || md5(
    CASE relation.property WHEN 'P279' THEN 'subgenre_of' ELSE 'influences' END
    || ':' ||
    CASE relation.property WHEN 'P279' THEN subject.internal_id ELSE object.internal_id END
    || ':' ||
    CASE relation.property WHEN 'P279' THEN object.internal_id ELSE subject.internal_id END
  ) AS relation_id,
  CASE relation.property WHEN 'P279' THEN 'subgenre_of' ELSE 'influences' END AS relation_kind,
  CASE relation.property WHEN 'P279' THEN subject.internal_id ELSE object.internal_id END
    AS source_style_id,
  CASE relation.property WHEN 'P279' THEN object.internal_id ELSE subject.internal_id END
    AS target_style_id,
  'mw:evidence:wikidata:' || lower(relation.qid) || ':' || relation.revision_id
    || ':' || lower(relation.property) || ':' || lower(relation.claim_value) AS evidence_id,
  relation.qid,
  relation.revision_id,
  relation.property,
  upper(relation.claim_value) AS object_qid
FROM __CANONICAL_SCHEMA__.stage_wd_claim relation
JOIN __CANONICAL_SCHEMA__.stage_wikidata_rock_style subject
  ON subject.qid = relation.qid
JOIN __CANONICAL_SCHEMA__.stage_wikidata_rock_style object
  ON object.qid = upper(relation.claim_value)
WHERE relation.property IN ('P279', 'P737')
  AND relation.claim_value ~* '^Q[1-9][0-9]*$'
  AND subject.internal_id <> object.internal_id;

INSERT INTO __CANONICAL_SCHEMA__.style_relation (relation_id, relation_kind, direction)
SELECT relation_id, relation_kind, 'directed'
FROM __CANONICAL_SCHEMA__.stage_style_relation_v2
ON CONFLICT DO NOTHING;

INSERT INTO __CANONICAL_SCHEMA__.style_relation_participant (
  relation_id, style_id, participant_role, ordinal
)
SELECT relation_id, source_style_id, 'source', 0
FROM __CANONICAL_SCHEMA__.stage_style_relation_v2
UNION ALL
SELECT relation_id, target_style_id, 'target', 0
FROM __CANONICAL_SCHEMA__.stage_style_relation_v2;

INSERT INTO __CANONICAL_SCHEMA__.style_relation_evidence (
  evidence_id, source_snapshot_id, source_dataset, source_record_id,
  source_url, evidence_locator, claim_text, retrieved_at, license_partition
)
SELECT
  evidence_id,
  __WIKIDATA_SOURCE_SNAPSHOT_ID__,
  'Wikidata',
  qid || '@' || revision_id || '#' || property,
  'https://www.wikidata.org/wiki/Special:EntityData/' || qid || '.json',
  'entities.' || qid || '.claims.' || property,
  CASE property
    WHEN 'P279' THEN qid || ' declares subclass of ' || object_qid
    ELSE qid || ' declares influenced by ' || object_qid
  END,
  __WIKIDATA_RETRIEVED_AT__,
  'wikidata-cc0'
FROM __CANONICAL_SCHEMA__.stage_style_relation_v2
ON CONFLICT DO NOTHING;

INSERT INTO __CANONICAL_SCHEMA__.style_relation_assertion_v2 (
  assertion_id, relation_id, claim_key, assertion_kind, stance, review_status,
  metadata_completeness, claim_geographies, claim_contexts,
  confidence_band, source_datasets, snapshot_version, pipeline_version,
  license_partition, created_at
)
SELECT
  'mw:assertion:' || substring(relation_id from 13),
  relation_id,
  'mw:claim:' || substring(relation_id from 13),
  'fact',
  'supports',
  'accepted',
  'participants_only',
  ARRAY[]::text[],
  ARRAY[]::text[],
  'high',
  ARRAY['Wikidata'],
  __WIKIDATA_UPSTREAM_VERSION__,
  'offline-canonical-v2',
  'wikidata-cc0',
  __GENERATED_AT__::timestamptz
FROM __CANONICAL_SCHEMA__.stage_style_relation_v2;

INSERT INTO __CANONICAL_SCHEMA__.style_relation_assertion_evidence_v2 (
  assertion_id, evidence_id
)
SELECT 'mw:assertion:' || substring(relation_id from 13), evidence_id
FROM __CANONICAL_SCHEMA__.stage_style_relation_v2;

CREATE UNLOGGED TABLE __CANONICAL_SCHEMA__.stage_identity_edge AS
SELECT 'artist'::text AS entity_type, 'musicbrainz-artist'::text AS canonical_namespace,
  mbid, 'discogs-artist'::text AS external_namespace, discogs_id, qid,
  evidence_id, evidence_source, evidence_locator, accepted
FROM __CANONICAL_SCHEMA__.stage_artist_crosswalk
UNION ALL
SELECT 'release_group', 'musicbrainz-release-group', mbid, 'discogs-master', discogs_id, qid,
  evidence_id, evidence_source, evidence_locator, accepted
FROM __CANONICAL_SCHEMA__.stage_release_group_crosswalk
UNION ALL
SELECT 'release', 'musicbrainz-release', mbid, 'discogs-release', discogs_id, qid,
  evidence_id, evidence_source, evidence_locator, accepted
FROM __CANONICAL_SCHEMA__.stage_release_crosswalk;

INSERT INTO __CANONICAL_SCHEMA__.identity_evidence (
  evidence_id, entity_type, evidence_source, source_snapshot_id,
  evidence_locator, evidence_payload, recorded_at
)
SELECT DISTINCT
  evidence_id,
  entity_type,
  evidence_source,
  CASE evidence_source
    WHEN 'musicbrainz-url' THEN __MB_SOURCE_SNAPSHOT_ID__
    WHEN 'discogs-url' THEN __DISCOGS_SOURCE_SNAPSHOT_ID__
    ELSE __WIKIDATA_SOURCE_SNAPSHOT_ID__
  END,
  evidence_locator,
  jsonb_build_object('accepted_crosswalk', accepted),
  __GENERATED_AT__::timestamptz
FROM __CANONICAL_SCHEMA__.stage_identity_edge;

INSERT INTO __CANONICAL_SCHEMA__.identity_evidence_identifier
  (evidence_id, namespace, external_id)
SELECT evidence_id, canonical_namespace, mbid
FROM __CANONICAL_SCHEMA__.stage_identity_edge
UNION
SELECT evidence_id, external_namespace, discogs_id
FROM __CANONICAL_SCHEMA__.stage_identity_edge
UNION
SELECT evidence_id, 'wikidata-item', qid
FROM __CANONICAL_SCHEMA__.stage_identity_edge WHERE qid IS NOT NULL;

INSERT INTO __CANONICAL_SCHEMA__.identity_evidence (
  evidence_id, entity_type, evidence_source, source_snapshot_id,
  evidence_locator, evidence_payload, recorded_at
)
SELECT
  'wikidata:style-scope:' || qid || ':' || revision_id,
  'style',
  'wikidata-claims',
  __WIKIDATA_SOURCE_SNAPSHOT_ID__,
  qid || '@' || revision_id || '#rock-style-scope',
  jsonb_build_object('scope', 'reviewed-rock-style', 'parent_qids', parent_qids),
  __GENERATED_AT__::timestamptz
FROM __CANONICAL_SCHEMA__.stage_wikidata_rock_style;

INSERT INTO __CANONICAL_SCHEMA__.identity_evidence_identifier
  (evidence_id, namespace, external_id)
SELECT 'wikidata:style-scope:' || qid || ':' || revision_id,
  'wikidata-item', qid
FROM __CANONICAL_SCHEMA__.stage_wikidata_rock_style
UNION ALL
SELECT 'wikidata:style-scope:' || rock_style.qid || ':' || rock_style.revision_id,
  'discogs-style', mapping.external_id
FROM __CANONICAL_SCHEMA__.stage_wikidata_rock_style rock_style
JOIN __CANONICAL_SCHEMA__.stage_style_wikidata mapping
  ON mapping.qid = rock_style.qid;

INSERT INTO __CANONICAL_SCHEMA__.identity_component (
  component_id, entity_type, canonical_internal_id, decision_status,
  identifier_count, evidence_count, decision_details, decided_at
)
SELECT
  'component:' || entity_type || ':' || md5(mbid),
  entity_type,
  CASE WHEN bool_and(accepted) THEN
    CASE entity_type
      WHEN 'artist' THEN 'mw:artist:mb:' || mbid
      WHEN 'release_group' THEN 'mw:release-group:mb:' || mbid
      WHEN 'release' THEN 'mw:release:mb:' || mbid
    END
  ELSE NULL END,
  CASE WHEN bool_and(accepted) THEN 'accepted' ELSE 'conflicted' END,
  1 + count(DISTINCT external_namespace || ':' || discogs_id)::integer
    + count(DISTINCT qid)::integer,
  count(DISTINCT evidence_id)::integer,
  jsonb_build_object('rule', 'explicit-id-bidirectional-uniqueness'),
  __GENERATED_AT__::timestamptz
FROM __CANONICAL_SCHEMA__.stage_identity_edge
GROUP BY entity_type, mbid;

INSERT INTO __CANONICAL_SCHEMA__.identity_component (
  component_id, entity_type, canonical_internal_id, decision_status,
  identifier_count, evidence_count, decision_details, decided_at
)
SELECT
  'component:style:' || md5(rock_style.qid),
  'style',
  CASE WHEN count(mapping.qid) = 0 OR bool_and(mapping.accepted)
    THEN rock_style.internal_id ELSE NULL END,
  CASE WHEN count(mapping.qid) = 0 OR bool_and(mapping.accepted)
    THEN 'accepted' ELSE 'conflicted' END,
  (1 + count(DISTINCT mapping.external_id))::integer,
  1,
  jsonb_build_object(
    'rule', 'reviewed-wikidata-style-with-explicit-discogs-crosswalk',
    'discogs_mapping_count', count(DISTINCT mapping.external_id)
  ),
  __GENERATED_AT__::timestamptz
FROM __CANONICAL_SCHEMA__.stage_wikidata_rock_style rock_style
LEFT JOIN __CANONICAL_SCHEMA__.stage_style_wikidata mapping
  ON mapping.qid = rock_style.qid
GROUP BY rock_style.qid, rock_style.internal_id;

INSERT INTO __CANONICAL_SCHEMA__.identity_component_identifier
  (component_id, namespace, external_id)
SELECT DISTINCT 'component:' || entity_type || ':' || md5(mbid), canonical_namespace, mbid
FROM __CANONICAL_SCHEMA__.stage_identity_edge
UNION
SELECT DISTINCT 'component:' || entity_type || ':' || md5(mbid), external_namespace, discogs_id
FROM __CANONICAL_SCHEMA__.stage_identity_edge
UNION
SELECT DISTINCT 'component:' || entity_type || ':' || md5(mbid), 'wikidata-item', qid
FROM __CANONICAL_SCHEMA__.stage_identity_edge WHERE qid IS NOT NULL;

INSERT INTO __CANONICAL_SCHEMA__.identity_component_identifier
  (component_id, namespace, external_id)
SELECT 'component:style:' || md5(qid), 'wikidata-item', qid
FROM __CANONICAL_SCHEMA__.stage_wikidata_rock_style
UNION ALL
SELECT DISTINCT 'component:style:' || md5(qid), 'discogs-style', external_id
FROM __CANONICAL_SCHEMA__.stage_style_wikidata;

INSERT INTO __CANONICAL_SCHEMA__.identity_component_evidence (component_id, evidence_id)
SELECT DISTINCT 'component:' || entity_type || ':' || md5(mbid), evidence_id
FROM __CANONICAL_SCHEMA__.stage_identity_edge;

INSERT INTO __CANONICAL_SCHEMA__.identity_component_evidence (component_id, evidence_id)
SELECT 'component:style:' || md5(qid),
  'wikidata:style-scope:' || qid || ':' || revision_id
FROM __CANONICAL_SCHEMA__.stage_wikidata_rock_style;

INSERT INTO __CANONICAL_SCHEMA__.identity_conflict_queue (
  component_id, conflict_namespaces, resolution_status, updated_at
)
SELECT
  component.component_id,
  CASE WHEN component.entity_type = 'style'
    THEN ARRAY['discogs-style', 'wikidata-item']
    ELSE ARRAY(SELECT DISTINCT edge.external_namespace
      FROM __CANONICAL_SCHEMA__.stage_identity_edge edge
      WHERE component.component_id = 'component:' || edge.entity_type || ':' || md5(edge.mbid)
      ORDER BY edge.external_namespace)
  END,
  'open',
  __GENERATED_AT__::timestamptz
FROM __CANONICAL_SCHEMA__.identity_component component
WHERE component.decision_status = 'conflicted';

INSERT INTO __CANONICAL_SCHEMA__.external_identity (
  internal_id, namespace, external_id, source_snapshot_id, assertion_status
)
SELECT 'mw:artist:mb:' || artist.gid, 'musicbrainz-artist', artist.gid,
  __MB_SOURCE_SNAPSHOT_ID__, 'accepted'
FROM __MUSICBRAINZ_SCHEMA__.artist artist
JOIN __CANONICAL_SCHEMA__.selected_mb_artist_all selected ON selected.id = artist.id
UNION ALL
SELECT 'mw:release-group:mb:' || release_group.gid, 'musicbrainz-release-group', release_group.gid,
  __MB_SOURCE_SNAPSHOT_ID__, 'accepted'
FROM __MUSICBRAINZ_SCHEMA__.release_group release_group
JOIN __CANONICAL_SCHEMA__.selected_mb_release_group selected ON selected.id = release_group.id
UNION ALL
SELECT 'mw:release:mb:' || release.gid, 'musicbrainz-release', release.gid,
  __MB_SOURCE_SNAPSHOT_ID__, 'accepted'
FROM __MUSICBRAINZ_SCHEMA__.release release
JOIN __CANONICAL_SCHEMA__.selected_mb_release selected ON selected.id = release.id
UNION ALL
SELECT 'mw:recording:mb:' || recording.gid, 'musicbrainz-recording', recording.gid,
  __MB_SOURCE_SNAPSHOT_ID__, 'accepted'
FROM __MUSICBRAINZ_SCHEMA__.recording recording
JOIN __CANONICAL_SCHEMA__.selected_mb_recording selected ON selected.id = recording.id
UNION ALL
SELECT resolution.internal_id, 'discogs-artist', resolution.external_id,
  __DISCOGS_SOURCE_SNAPSHOT_ID__, 'accepted'
FROM __CANONICAL_SCHEMA__.stage_discogs_artist_resolution resolution
UNION ALL
SELECT resolution.internal_id, 'discogs-master', resolution.external_id,
  __DISCOGS_SOURCE_SNAPSHOT_ID__, 'accepted'
FROM __CANONICAL_SCHEMA__.stage_discogs_master_resolution resolution
UNION ALL
SELECT resolution.internal_id, 'discogs-release', resolution.external_id,
  __DISCOGS_SOURCE_SNAPSHOT_ID__, 'accepted'
FROM __CANONICAL_SCHEMA__.stage_discogs_release_resolution resolution
UNION ALL
SELECT internal_id, 'discogs-style', external_id,
  __DISCOGS_SOURCE_SNAPSHOT_ID__, 'accepted'
FROM __CANONICAL_SCHEMA__.stage_style_resolution
UNION ALL
SELECT internal_id, 'wikidata-item', qid,
  __WIKIDATA_SOURCE_SNAPSHOT_ID__, 'accepted'
FROM __CANONICAL_SCHEMA__.stage_wikidata_rock_style
ON CONFLICT DO NOTHING;

ANALYZE __CANONICAL_SCHEMA__.artist;
ANALYZE __CANONICAL_SCHEMA__.release_group;
ANALYZE __CANONICAL_SCHEMA__.release;
ANALYZE __CANONICAL_SCHEMA__.medium;
ANALYZE __CANONICAL_SCHEMA__.recording;
ANALYZE __CANONICAL_SCHEMA__.track;
ANALYZE __CANONICAL_SCHEMA__.style;

DROP TABLE __CANONICAL_SCHEMA__.stage_wd_claim;
DROP TABLE __CANONICAL_SCHEMA__.stage_artist_crosswalk;
DROP TABLE __CANONICAL_SCHEMA__.stage_release_group_crosswalk;
DROP TABLE __CANONICAL_SCHEMA__.stage_release_crosswalk;
DROP TABLE __CANONICAL_SCHEMA__.selected_mb_artist;
DROP TABLE __CANONICAL_SCHEMA__.selected_mb_release_group;
DROP TABLE __CANONICAL_SCHEMA__.selected_mb_release;
DROP TABLE __CANONICAL_SCHEMA__.selected_mb_recording;
DROP TABLE __CANONICAL_SCHEMA__.selected_mb_artist_all;
DROP TABLE __CANONICAL_SCHEMA__.stage_discogs_artist_resolution;
DROP TABLE __CANONICAL_SCHEMA__.stage_discogs_master_resolution;
DROP TABLE __CANONICAL_SCHEMA__.stage_discogs_release_resolution;
DROP TABLE __CANONICAL_SCHEMA__.stage_style_resolution;
DROP TABLE __CANONICAL_SCHEMA__.stage_style_wikidata;
DROP TABLE __CANONICAL_SCHEMA__.stage_wikidata_rock_style;
DROP TABLE __CANONICAL_SCHEMA__.stage_discogs_relation_v2;
DROP TABLE __CANONICAL_SCHEMA__.stage_identity_edge;
DROP TABLE __CANONICAL_SCHEMA__.stage_style_relation_v2;
DROP TABLE __CANONICAL_SCHEMA__.stage_discogs_artist;
DROP TABLE __CANONICAL_SCHEMA__.stage_discogs_release;
DROP TABLE __CANONICAL_SCHEMA__.stage_discogs_master;
DROP TABLE __CANONICAL_SCHEMA__.stage_discogs_style;
DROP TABLE __CANONICAL_SCHEMA__.stage_wikidata_entity;

COMMIT;

SELECT json_build_object(
  'styles', (SELECT count(*) FROM __CANONICAL_SCHEMA__.style),
  'published_styles', (
    SELECT count(*) FROM __CANONICAL_SCHEMA__.style
    WHERE inclusion_status = 'accepted' AND retired_at IS NULL
  ),
  'wikidata_rock_styles', (
    SELECT count(*) FROM __CANONICAL_SCHEMA__.style
    WHERE first_seen_snapshot_id = __WIKIDATA_SOURCE_SNAPSHOT_ID__
  ),
  'discogs_only_styles', (
    SELECT count(*) FROM __CANONICAL_SCHEMA__.style
    WHERE first_seen_snapshot_id = __DISCOGS_SOURCE_SNAPSHOT_ID__
  ),
  'discogs_style_identities', (
    SELECT count(*) FROM __CANONICAL_SCHEMA__.external_identity
    WHERE namespace = 'discogs-style' AND source_snapshot_id = __DISCOGS_SOURCE_SNAPSHOT_ID__
  ),
  'style_relations', (SELECT count(*) FROM __CANONICAL_SCHEMA__.style_relation_assertion),
  'published_relations', (
    SELECT count(DISTINCT assertion.relation_id)
    FROM __CANONICAL_SCHEMA__.style_relation_assertion_v2 assertion
    WHERE assertion.stance = 'supports' AND assertion.review_status = 'accepted'
      AND NOT EXISTS (
        SELECT 1
        FROM __CANONICAL_SCHEMA__.style_relation_participant participant
        JOIN __CANONICAL_SCHEMA__.style style ON style.internal_id = participant.style_id
        WHERE participant.relation_id = assertion.relation_id
          AND (style.inclusion_status <> 'accepted' OR style.retired_at IS NOT NULL)
      )
  ),
  'qualifying_artists', (
    SELECT count(DISTINCT artist_id) FROM __CANONICAL_SCHEMA__.artist_style_qualification
    WHERE derivation_rule_version = 'release-credit-style-qualification-v1'
  ),
  'artists', (SELECT count(*) FROM __CANONICAL_SCHEMA__.artist),
  'mapped_musicbrainz_artists', (
    SELECT count(*) FROM __CANONICAL_SCHEMA__.artist
    WHERE internal_id LIKE 'mw:artist:mb:%'
  ),
  'fallback_discogs_artists', (
    SELECT count(*) FROM __CANONICAL_SCHEMA__.artist
    WHERE internal_id LIKE 'mw:artist:discogs:%'
  ),
  'release_groups', (SELECT count(*) FROM __CANONICAL_SCHEMA__.release_group),
  'studio_release_groups', (
    SELECT count(*) FROM __CANONICAL_SCHEMA__.release_group WHERE lower(primary_type) = 'album'
  ),
  'live_release_groups', (
    SELECT count(*) FROM __CANONICAL_SCHEMA__.release_group WHERE 'Live' = ANY(secondary_types)
  ),
  'releases', (SELECT count(*) FROM __CANONICAL_SCHEMA__.release),
  'media', (SELECT count(*) FROM __CANONICAL_SCHEMA__.medium),
  'recordings', (SELECT count(*) FROM __CANONICAL_SCHEMA__.recording),
  'tracks', (SELECT count(*) FROM __CANONICAL_SCHEMA__.track),
  'identity_evidence', (SELECT count(*) FROM __CANONICAL_SCHEMA__.identity_evidence),
  'accounted_identity_evidence', (
    SELECT count(DISTINCT evidence_id) FROM __CANONICAL_SCHEMA__.identity_component_evidence
  ),
  'identity_components', (SELECT count(*) FROM __CANONICAL_SCHEMA__.identity_component),
  'identity_conflicts', (SELECT count(*) FROM __CANONICAL_SCHEMA__.identity_conflict_queue),
  'unquarantined_conflicts', (
    SELECT count(*)
    FROM __CANONICAL_SCHEMA__.identity_component component
    LEFT JOIN __CANONICAL_SCHEMA__.identity_conflict_queue conflict
      ON conflict.component_id = component.component_id
    WHERE component.decision_status = 'conflicted' AND conflict.component_id IS NULL
  ),
  'missing_artist_references', (
    SELECT count(*) FROM __CANONICAL_SCHEMA__.release_group_artist credit
    LEFT JOIN __CANONICAL_SCHEMA__.artist artist ON artist.internal_id = credit.artist_id
    WHERE artist.internal_id IS NULL
  ),
  'missing_release_group_references', (
    SELECT count(*) FROM __CANONICAL_SCHEMA__.release release
    LEFT JOIN __CANONICAL_SCHEMA__.release_group release_group
      ON release_group.internal_id = release.release_group_id
    WHERE release_group.internal_id IS NULL
  ),
  'missing_medium_references', (
    SELECT count(*) FROM __CANONICAL_SCHEMA__.track track
    LEFT JOIN __CANONICAL_SCHEMA__.medium medium
      ON medium.release_id = track.release_id AND medium.position = track.medium_position
    WHERE medium.release_id IS NULL
  ),
  'missing_track_references', (
    SELECT count(*) FROM __CANONICAL_SCHEMA__.track track
    LEFT JOIN __CANONICAL_SCHEMA__.recording recording
      ON recording.internal_id = track.recording_id
    WHERE track.recording_id IS NOT NULL AND recording.internal_id IS NULL
  )
)::text;
