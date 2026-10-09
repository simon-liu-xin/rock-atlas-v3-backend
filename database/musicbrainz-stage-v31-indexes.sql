\set ON_ERROR_STOP on

CREATE UNIQUE INDEX artist_id_idx ON __STAGE_SCHEMA__.artist (id);
CREATE UNIQUE INDEX artist_gid_idx ON __STAGE_SCHEMA__.artist (gid);
CREATE UNIQUE INDEX artist_type_id_idx ON __STAGE_SCHEMA__.artist_type (id);
CREATE UNIQUE INDEX artist_credit_id_idx ON __STAGE_SCHEMA__.artist_credit (id);
CREATE INDEX artist_credit_name_credit_idx
  ON __STAGE_SCHEMA__.artist_credit_name (artist_credit);
CREATE INDEX artist_credit_name_artist_idx
  ON __STAGE_SCHEMA__.artist_credit_name (artist);

CREATE UNIQUE INDEX release_group_id_idx ON __STAGE_SCHEMA__.release_group (id);
CREATE UNIQUE INDEX release_group_gid_idx ON __STAGE_SCHEMA__.release_group (gid);
CREATE INDEX release_group_artist_credit_idx
  ON __STAGE_SCHEMA__.release_group (artist_credit);
CREATE UNIQUE INDEX release_group_primary_type_id_idx
  ON __STAGE_SCHEMA__.release_group_primary_type (id);
CREATE UNIQUE INDEX release_group_secondary_type_id_idx
  ON __STAGE_SCHEMA__.release_group_secondary_type (id);
CREATE INDEX release_group_secondary_join_group_idx
  ON __STAGE_SCHEMA__.release_group_secondary_type_join (release_group);

CREATE UNIQUE INDEX release_id_idx ON __STAGE_SCHEMA__.release (id);
CREATE UNIQUE INDEX release_gid_idx ON __STAGE_SCHEMA__.release (gid);
CREATE INDEX release_release_group_idx ON __STAGE_SCHEMA__.release (release_group);
CREATE UNIQUE INDEX release_status_id_idx ON __STAGE_SCHEMA__.release_status (id);
CREATE UNIQUE INDEX release_packaging_id_idx
  ON __STAGE_SCHEMA__.release_packaging (id);
CREATE INDEX release_country_release_idx
  ON __STAGE_SCHEMA__.release_country (release);
CREATE INDEX release_unknown_country_release_idx
  ON __STAGE_SCHEMA__.release_unknown_country (release);
CREATE INDEX iso_3166_1_area_idx ON __STAGE_SCHEMA__.iso_3166_1 (area);

CREATE UNIQUE INDEX medium_id_idx ON __STAGE_SCHEMA__.medium (id);
CREATE INDEX medium_release_idx ON __STAGE_SCHEMA__.medium (release);
CREATE UNIQUE INDEX medium_format_id_idx ON __STAGE_SCHEMA__.medium_format (id);
CREATE INDEX track_medium_idx ON __STAGE_SCHEMA__.track (medium);
CREATE INDEX track_recording_idx ON __STAGE_SCHEMA__.track (recording);
CREATE UNIQUE INDEX recording_id_idx ON __STAGE_SCHEMA__.recording (id);
CREATE UNIQUE INDEX recording_gid_idx ON __STAGE_SCHEMA__.recording (gid);
CREATE INDEX recording_artist_credit_idx
  ON __STAGE_SCHEMA__.recording (artist_credit);

CREATE UNIQUE INDEX url_id_idx ON __STAGE_SCHEMA__.url (id);
CREATE UNIQUE INDEX link_id_idx ON __STAGE_SCHEMA__.link (id);
CREATE UNIQUE INDEX link_type_id_idx ON __STAGE_SCHEMA__.link_type (id);
CREATE INDEX l_artist_url_entity0_idx
  ON __STAGE_SCHEMA__.l_artist_url (entity0);
CREATE INDEX l_artist_url_entity1_idx
  ON __STAGE_SCHEMA__.l_artist_url (entity1);
CREATE INDEX l_release_group_url_entity0_idx
  ON __STAGE_SCHEMA__.l_release_group_url (entity0);
CREATE INDEX l_release_group_url_entity1_idx
  ON __STAGE_SCHEMA__.l_release_group_url (entity1);
CREATE INDEX l_release_url_entity0_idx
  ON __STAGE_SCHEMA__.l_release_url (entity0);
CREATE INDEX l_release_url_entity1_idx
  ON __STAGE_SCHEMA__.l_release_url (entity1);

ANALYZE __STAGE_SCHEMA__.artist;
ANALYZE __STAGE_SCHEMA__.artist_credit_name;
ANALYZE __STAGE_SCHEMA__.release_group;
ANALYZE __STAGE_SCHEMA__.release;
ANALYZE __STAGE_SCHEMA__.release_country;
ANALYZE __STAGE_SCHEMA__.release_unknown_country;
ANALYZE __STAGE_SCHEMA__.medium;
ANALYZE __STAGE_SCHEMA__.track;
ANALYZE __STAGE_SCHEMA__.recording;
ANALYZE __STAGE_SCHEMA__.url;
ANALYZE __STAGE_SCHEMA__.l_artist_url;
ANALYZE __STAGE_SCHEMA__.l_release_group_url;
ANALYZE __STAGE_SCHEMA__.l_release_url;
