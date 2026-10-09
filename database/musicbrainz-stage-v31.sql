\set ON_ERROR_STOP on

CREATE SCHEMA __STAGE_SCHEMA__;

CREATE TABLE __STAGE_SCHEMA__.musicwiki_stage_meta (
  snapshot_id text PRIMARY KEY,
  schema_sequence integer NOT NULL CHECK (schema_sequence = 31),
  source_archive_sha256 text NOT NULL CHECK (source_archive_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL
);

CREATE UNLOGGED TABLE __STAGE_SCHEMA__.artist (
  id text, gid text, name text, sort_name text,
  begin_date_year text, begin_date_month text, begin_date_day text,
  end_date_year text, end_date_month text, end_date_day text,
  type text, area text, gender text, comment text, edits_pending text,
  last_updated text, ended text, begin_area text, end_area text
);
CREATE UNLOGGED TABLE __STAGE_SCHEMA__.artist_type (
  id text, name text, parent text, child_order text, description text, gid text
);
CREATE UNLOGGED TABLE __STAGE_SCHEMA__.artist_credit (
  id text, name text, artist_count text, ref_count text, created text, edits_pending text, gid text
);
CREATE UNLOGGED TABLE __STAGE_SCHEMA__.artist_credit_name (
  artist_credit text, position text, artist text, name text, join_phrase text
);
CREATE UNLOGGED TABLE __STAGE_SCHEMA__.release_group (
  id text, gid text, name text, artist_credit text, type text, comment text,
  edits_pending text, last_updated text
);
CREATE UNLOGGED TABLE __STAGE_SCHEMA__.release_group_primary_type (
  id text, name text, parent text, child_order text, description text, gid text
);
CREATE UNLOGGED TABLE __STAGE_SCHEMA__.release_group_secondary_type (
  id text, name text, parent text, child_order text, description text, gid text
);
CREATE UNLOGGED TABLE __STAGE_SCHEMA__.release_group_secondary_type_join (
  release_group text, secondary_type text, created text
);
CREATE UNLOGGED TABLE __STAGE_SCHEMA__.release (
  id text, gid text, name text, artist_credit text, release_group text, status text,
  packaging text, language text, script text, barcode text, comment text,
  edits_pending text, quality text, last_updated text
);
CREATE UNLOGGED TABLE __STAGE_SCHEMA__.release_status (
  id text, name text, parent text, child_order text, description text, gid text
);
CREATE UNLOGGED TABLE __STAGE_SCHEMA__.release_packaging (
  id text, name text, parent text, child_order text, description text, gid text
);
CREATE UNLOGGED TABLE __STAGE_SCHEMA__.release_country (
  release text, country text, date_year text, date_month text, date_day text
);
CREATE UNLOGGED TABLE __STAGE_SCHEMA__.release_unknown_country (
  release text, date_year text, date_month text, date_day text
);
CREATE UNLOGGED TABLE __STAGE_SCHEMA__.iso_3166_1 (area text, code text);
CREATE UNLOGGED TABLE __STAGE_SCHEMA__.medium (
  id text, release text, position text, format text, name text, edits_pending text,
  last_updated text, track_count text, gid text
);
CREATE UNLOGGED TABLE __STAGE_SCHEMA__.medium_format (
  id text, name text, parent text, child_order text, year text, has_discids text,
  description text, gid text
);
CREATE UNLOGGED TABLE __STAGE_SCHEMA__.track (
  id text, gid text, recording text, medium text, position text, number text, name text,
  artist_credit text, length text, edits_pending text, last_updated text, is_data_track text
);
CREATE UNLOGGED TABLE __STAGE_SCHEMA__.recording (
  id text, gid text, name text, artist_credit text, length text, comment text,
  edits_pending text, last_updated text, video text
);
CREATE UNLOGGED TABLE __STAGE_SCHEMA__.url (
  id text, gid text, url text, edits_pending text, last_updated text
);
CREATE UNLOGGED TABLE __STAGE_SCHEMA__.link (
  id text, link_type text,
  begin_date_year text, begin_date_month text, begin_date_day text,
  end_date_year text, end_date_month text, end_date_day text,
  attribute_count text, created text, ended text
);
CREATE UNLOGGED TABLE __STAGE_SCHEMA__.link_type (
  id text, parent text, child_order text, gid text, entity_type0 text, entity_type1 text,
  name text, description text, link_phrase text, reverse_link_phrase text,
  long_link_phrase text, last_updated text, is_deprecated text, has_dates text,
  entity0_cardinality text, entity1_cardinality text
);
CREATE UNLOGGED TABLE __STAGE_SCHEMA__.l_artist_url (
  id text, link text, entity0 text, entity1 text, edits_pending text, last_updated text,
  link_order text, entity0_credit text, entity1_credit text
);
CREATE UNLOGGED TABLE __STAGE_SCHEMA__.l_release_group_url (
  id text, link text, entity0 text, entity1 text, edits_pending text, last_updated text,
  link_order text, entity0_credit text, entity1_credit text
);
CREATE UNLOGGED TABLE __STAGE_SCHEMA__.l_release_url (
  id text, link text, entity0 text, entity1 text, edits_pending text, last_updated text,
  link_order text, entity0_credit text, entity1_credit text
);
