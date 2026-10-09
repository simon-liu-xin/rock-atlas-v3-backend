BEGIN;

CREATE SCHEMA IF NOT EXISTS mw_catalog_control_v3;

CREATE TABLE IF NOT EXISTS mw_catalog_control_v3.generation_registry (
  generation_id text PRIMARY KEY CHECK (
    generation_id ~ '^mw:catalog-generation:[a-z0-9][a-z0-9._-]*$'
  ),
  canonical_schema name NOT NULL UNIQUE,
  lifecycle_state text NOT NULL CHECK (
    lifecycle_state IN (
      'building', 'projected', 'audited', 'publish-ready',
      'switching', 'published', 'retired', 'failed'
    )
  ),
  schema_version text NOT NULL,
  source_snapshot_set jsonb NOT NULL CHECK (jsonb_typeof(source_snapshot_set) = 'array'),
  active_operation_id text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  published_at timestamptz,
  retired_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS generation_registry_v3_one_published_idx
  ON mw_catalog_control_v3.generation_registry ((lifecycle_state))
  WHERE lifecycle_state = 'published';

CREATE TABLE IF NOT EXISTS mw_catalog_control_v3.generation_core_counts (
  generation_id text PRIMARY KEY REFERENCES mw_catalog_control_v3.generation_registry(generation_id)
    ON DELETE CASCADE,
  style_count bigint NOT NULL CHECK (style_count >= 0),
  artist_count bigint NOT NULL CHECK (artist_count >= 0),
  release_group_count bigint NOT NULL CHECK (release_group_count >= 0),
  release_count bigint NOT NULL CHECK (release_count >= 0),
  recording_count bigint NOT NULL CHECK (recording_count >= 0),
  relation_count bigint NOT NULL CHECK (relation_count >= 0),
  assertion_count bigint NOT NULL CHECK (assertion_count >= 0),
  evidence_count bigint NOT NULL CHECK (evidence_count >= 0)
);

CREATE TABLE IF NOT EXISTS mw_catalog_control_v3.generation_projection_counts (
  generation_id text NOT NULL REFERENCES mw_catalog_control_v3.generation_registry(generation_id)
    ON DELETE CASCADE,
  projection_name text NOT NULL,
  style_occurrence_count bigint NOT NULL CHECK (style_occurrence_count >= 0),
  artist_occurrence_count bigint NOT NULL CHECK (artist_occurrence_count >= 0),
  release_occurrence_count bigint NOT NULL CHECK (release_occurrence_count >= 0),
  visible_relation_count bigint NOT NULL CHECK (visible_relation_count >= 0),
  PRIMARY KEY (generation_id, projection_name)
);

CREATE TABLE IF NOT EXISTS mw_catalog_control_v3.generation_transition_event (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  generation_id text NOT NULL REFERENCES mw_catalog_control_v3.generation_registry(generation_id),
  operation_id text NOT NULL UNIQUE CHECK (
    operation_id ~ '^mw:catalog-operation:[a-z0-9][a-z0-9._-]*$'
  ),
  from_state text NOT NULL,
  to_state text NOT NULL,
  actor text NOT NULL,
  reason text NOT NULL,
  occurred_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS mw_catalog_control_v3.publication_operation (
  operation_id text PRIMARY KEY CHECK (
    operation_id ~ '^mw:catalog-operation:[a-z0-9][a-z0-9._-]*$'
  ),
  channel text NOT NULL,
  generation_id text NOT NULL REFERENCES mw_catalog_control_v3.generation_registry(generation_id),
  operation_kind text NOT NULL CHECK (operation_kind IN ('publish', 'rollback')),
  operation_state text NOT NULL CHECK (
    operation_state IN (
      'prepared', 'artifacts-verified', 'pointer-committed',
      'reconciled', 'aborted', 'recovery-pending'
    )
  ),
  expected_pointer_generation_id text,
  committed_pointer_sha256 text CHECK (
    committed_pointer_sha256 IS NULL OR committed_pointer_sha256 ~ '^[a-f0-9]{64}$'
  ),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  error_details jsonb
);

CREATE TABLE IF NOT EXISTS mw_catalog_control_v3.publication_transition_event (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  operation_id text NOT NULL REFERENCES mw_catalog_control_v3.publication_operation(operation_id),
  transition_id text NOT NULL UNIQUE,
  from_state text NOT NULL,
  to_state text NOT NULL,
  actor text NOT NULL,
  reason text NOT NULL,
  occurred_at timestamptz NOT NULL
);

CREATE OR REPLACE FUNCTION mw_catalog_control_v3.transition_generation(
  p_generation_id text,
  p_operation_id text,
  p_expected_state text,
  p_next_state text,
  p_actor text,
  p_reason text,
  p_occurred_at timestamptz
) RETURNS mw_catalog_control_v3.generation_registry
LANGUAGE plpgsql
AS $function$
DECLARE
  current_row mw_catalog_control_v3.generation_registry;
  prior_event mw_catalog_control_v3.generation_transition_event;
  allowed boolean;
BEGIN
  SELECT * INTO current_row
  FROM mw_catalog_control_v3.generation_registry
  WHERE generation_id = p_generation_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'catalog generation % does not exist', p_generation_id; END IF;

  SELECT * INTO prior_event
  FROM mw_catalog_control_v3.generation_transition_event
  WHERE operation_id = p_operation_id;
  IF FOUND THEN
    IF prior_event.generation_id = p_generation_id
      AND prior_event.from_state = p_expected_state
      AND prior_event.to_state = p_next_state
      AND prior_event.actor = p_actor
      AND prior_event.reason = p_reason
      AND prior_event.occurred_at = p_occurred_at
    THEN RETURN current_row;
    END IF;
    RAISE EXCEPTION 'catalog operation id % was reused with different input', p_operation_id;
  END IF;

  IF current_row.lifecycle_state <> p_expected_state THEN
    RAISE EXCEPTION 'catalog transition expected % but generation is %',
      p_expected_state, current_row.lifecycle_state;
  END IF;
  allowed := CASE p_expected_state
    WHEN 'building' THEN p_next_state IN ('projected', 'failed')
    WHEN 'projected' THEN p_next_state IN ('audited', 'failed')
    WHEN 'audited' THEN p_next_state IN ('publish-ready', 'failed')
    WHEN 'publish-ready' THEN p_next_state IN ('switching', 'failed')
    WHEN 'switching' THEN p_next_state IN ('published', 'failed')
    WHEN 'published' THEN p_next_state = 'retired'
    ELSE false
  END;
  IF NOT allowed THEN
    RAISE EXCEPTION '% -> % is not an allowed catalog transition', p_expected_state, p_next_state;
  END IF;

  UPDATE mw_catalog_control_v3.generation_registry
  SET lifecycle_state = p_next_state,
      active_operation_id = p_operation_id,
      updated_at = p_occurred_at,
      published_at = CASE WHEN p_next_state = 'published' THEN p_occurred_at ELSE published_at END,
      retired_at = CASE WHEN p_next_state = 'retired' THEN p_occurred_at ELSE retired_at END
  WHERE generation_id = p_generation_id
    AND lifecycle_state = p_expected_state
  RETURNING * INTO current_row;
  IF NOT FOUND THEN RAISE EXCEPTION 'catalog transition lost compare-and-swap race'; END IF;

  INSERT INTO mw_catalog_control_v3.generation_transition_event (
    generation_id, operation_id, from_state, to_state, actor, reason, occurred_at
  ) VALUES (
    p_generation_id, p_operation_id, p_expected_state, p_next_state,
    p_actor, p_reason, p_occurred_at
  );
  RETURN current_row;
END
$function$;

CREATE OR REPLACE FUNCTION mw_catalog_control_v3.transition_publication_operation(
  p_operation_id text,
  p_transition_id text,
  p_expected_state text,
  p_next_state text,
  p_actor text,
  p_reason text,
  p_occurred_at timestamptz
) RETURNS mw_catalog_control_v3.publication_operation
LANGUAGE plpgsql
AS $function$
DECLARE
  current_row mw_catalog_control_v3.publication_operation;
  prior_event mw_catalog_control_v3.publication_transition_event;
  allowed boolean;
BEGIN
  SELECT * INTO current_row
  FROM mw_catalog_control_v3.publication_operation
  WHERE operation_id = p_operation_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'publication operation % does not exist', p_operation_id; END IF;

  SELECT * INTO prior_event
  FROM mw_catalog_control_v3.publication_transition_event
  WHERE transition_id = p_transition_id;
  IF FOUND THEN
    IF prior_event.operation_id = p_operation_id
      AND prior_event.from_state = p_expected_state
      AND prior_event.to_state = p_next_state
      AND prior_event.actor = p_actor
      AND prior_event.reason = p_reason
      AND prior_event.occurred_at = p_occurred_at
    THEN RETURN current_row;
    END IF;
    RAISE EXCEPTION 'publication transition id % was reused with different input', p_transition_id;
  END IF;

  IF current_row.operation_state <> p_expected_state THEN
    RAISE EXCEPTION 'publication transition expected % but operation is %',
      p_expected_state, current_row.operation_state;
  END IF;
  allowed := CASE p_expected_state
    WHEN 'prepared' THEN p_next_state IN ('artifacts-verified', 'aborted')
    WHEN 'artifacts-verified' THEN p_next_state IN ('pointer-committed', 'aborted')
    WHEN 'pointer-committed' THEN p_next_state IN ('reconciled', 'recovery-pending')
    WHEN 'recovery-pending' THEN p_next_state IN ('reconciled', 'aborted')
    ELSE false
  END;
  IF NOT allowed THEN
    RAISE EXCEPTION '% -> % is not an allowed publication transition',
      p_expected_state, p_next_state;
  END IF;

  UPDATE mw_catalog_control_v3.publication_operation
  SET operation_state = p_next_state, updated_at = p_occurred_at
  WHERE operation_id = p_operation_id
    AND operation_state = p_expected_state
  RETURNING * INTO current_row;
  IF NOT FOUND THEN RAISE EXCEPTION 'publication transition lost compare-and-swap race'; END IF;

  INSERT INTO mw_catalog_control_v3.publication_transition_event (
    operation_id, transition_id, from_state, to_state, actor, reason, occurred_at
  ) VALUES (
    p_operation_id, p_transition_id, p_expected_state, p_next_state,
    p_actor, p_reason, p_occurred_at
  );
  RETURN current_row;
END
$function$;

COMMIT;
