BEGIN;

CREATE SCHEMA IF NOT EXISTS mw_catalog_control;
CREATE SCHEMA IF NOT EXISTS mw_catalog_public;

CREATE TABLE IF NOT EXISTS mw_catalog_control.generation_registry (
  generation_id text PRIMARY KEY,
  schema_name name NOT NULL UNIQUE,
  source_fingerprint_sha256 text NOT NULL CHECK (
    source_fingerprint_sha256 ~ '^[a-f0-9]{64}$'
  ),
  status text NOT NULL CHECK (status IN ('validated', 'published', 'superseded', 'failed')),
  style_count integer NOT NULL CHECK (style_count > 0),
  representative_artist_count integer NOT NULL CHECK (representative_artist_count = style_count),
  representative_release_group_count integer NOT NULL CHECK (
    representative_release_group_count = style_count
  ),
  cross_verified_count integer NOT NULL DEFAULT 0 CHECK (cross_verified_count >= 0),
  single_source_count integer NOT NULL DEFAULT 0 CHECK (single_source_count >= 0),
  curated_count integer NOT NULL DEFAULT 0 CHECK (curated_count >= 0),
  conflicted_count integer NOT NULL DEFAULT 0 CHECK (conflicted_count = 0),
  relation_count integer NOT NULL CHECK (relation_count >= 0),
  frontend_export_path text NOT NULL,
  frontend_export_sha256 text NOT NULL CHECK (frontend_export_sha256 ~ '^[a-f0-9]{64}$'),
  generated_at timestamptz NOT NULL,
  published_at timestamptz,
  superseded_at timestamptz,
  CHECK ((status = 'published' AND published_at IS NOT NULL) OR status <> 'published')
);

ALTER TABLE mw_catalog_control.generation_registry
  ADD COLUMN IF NOT EXISTS cross_verified_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS single_source_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS curated_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS conflicted_count integer NOT NULL DEFAULT 0;

ALTER TABLE mw_catalog_control.generation_registry
  DROP CONSTRAINT IF EXISTS generation_registry_source_fingerprint_sha256_key;

CREATE INDEX IF NOT EXISTS generation_registry_source_fingerprint_idx
  ON mw_catalog_control.generation_registry (source_fingerprint_sha256, generated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS generation_registry_one_current_idx
  ON mw_catalog_control.generation_registry ((status))
  WHERE status = 'published';

CREATE INDEX IF NOT EXISTS generation_registry_generated_idx
  ON mw_catalog_control.generation_registry (generated_at DESC, generation_id);

COMMIT;
