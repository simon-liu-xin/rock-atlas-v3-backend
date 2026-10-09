BEGIN;

-- Apply after database/offline-rock-v1.sql. The legacy binary
-- style_relation_assertion table remains available only as migration input.
CREATE TABLE IF NOT EXISTS mw_offline.style_relation (
  relation_id text PRIMARY KEY CHECK (relation_id LIKE 'mw:relation:%'),
  relation_kind text NOT NULL CHECK (
    relation_kind IN (
      'evolves_into',
      'fusion_of',
      'influences',
      'subgenre_of',
      'backlash_against',
      'associated_with',
      'sounds_like',
      'co_tagged_with',
      'unrelated_within_scope'
    )
  ),
  direction text NOT NULL CHECK (direction IN ('directed', 'undirected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (relation_kind IN (
      'evolves_into', 'fusion_of', 'influences', 'subgenre_of', 'backlash_against'
    ) AND direction = 'directed') OR
    (relation_kind IN (
      'associated_with', 'sounds_like', 'co_tagged_with', 'unrelated_within_scope'
    ) AND direction = 'undirected')
  )
);

CREATE TABLE IF NOT EXISTS mw_offline.style_relation_participant (
  relation_id text NOT NULL
    REFERENCES mw_offline.style_relation(relation_id) ON DELETE CASCADE,
  style_id text NOT NULL REFERENCES mw_offline.style(internal_id),
  participant_role text NOT NULL CHECK (participant_role IN ('source', 'target', 'peer')),
  ordinal smallint NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (relation_id, style_id),
  UNIQUE (relation_id, participant_role, ordinal)
);

CREATE TABLE IF NOT EXISTS mw_offline.style_relation_assertion_v2 (
  assertion_id text PRIMARY KEY CHECK (assertion_id LIKE 'mw:assertion:%'),
  relation_id text NOT NULL
    REFERENCES mw_offline.style_relation(relation_id) ON DELETE CASCADE,
  claim_key text NOT NULL CHECK (claim_key LIKE 'mw:claim:%'),
  assertion_kind text NOT NULL CHECK (assertion_kind IN ('fact', 'inferred', 'candidate')),
  stance text NOT NULL CHECK (stance IN ('supports', 'disputes')),
  review_status text NOT NULL CHECK (
    review_status IN ('accepted', 'contested', 'rejected', 'unreviewed')
  ),
  metadata_completeness text NOT NULL CHECK (
    metadata_completeness IN ('participants_only', 'partial_context', 'contextualized')
  ),
  claim_geographies text[] NOT NULL DEFAULT '{}',
  claim_contexts text[] NOT NULL DEFAULT '{}',
  time_start timestamptz,
  time_end timestamptz,
  time_precision text CHECK (time_precision IN ('instant', 'range', 'decade', 'unknown')),
  confidence_band text NOT NULL CHECK (confidence_band IN ('low', 'medium', 'high')),
  source_datasets text[] NOT NULL CHECK (cardinality(source_datasets) > 0),
  snapshot_version text NOT NULL,
  pipeline_version text NOT NULL,
  license_partition text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (time_start IS NULL OR time_end IS NULL OR time_end >= time_start),
  CHECK (
    (time_start IS NULL AND time_end IS NULL AND time_precision IS NULL) OR
    time_precision IS NOT NULL
  )
);

CREATE TABLE IF NOT EXISTS mw_offline.style_relation_evidence (
  evidence_id text PRIMARY KEY CHECK (evidence_id LIKE 'mw:evidence:%'),
  source_snapshot_id text REFERENCES mw_offline.source_snapshot(snapshot_id),
  source_dataset text NOT NULL,
  source_record_id text NOT NULL,
  source_url text NOT NULL,
  evidence_locator text NOT NULL,
  claim_text text NOT NULL,
  retrieved_at timestamptz NOT NULL,
  license_partition text NOT NULL
);

CREATE TABLE IF NOT EXISTS mw_offline.style_relation_assertion_evidence_v2 (
  assertion_id text NOT NULL
    REFERENCES mw_offline.style_relation_assertion_v2(assertion_id) ON DELETE CASCADE,
  evidence_id text NOT NULL
    REFERENCES mw_offline.style_relation_evidence(evidence_id),
  PRIMARY KEY (assertion_id, evidence_id)
);

CREATE OR REPLACE FUNCTION mw_offline.validate_style_relation_v2()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  checked_relation_id text := COALESCE(NEW.relation_id, OLD.relation_id);
  checked_relation mw_offline.style_relation%ROWTYPE;
  source_count integer;
  target_count integer;
  peer_count integer;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.relation_id IS DISTINCT FROM OLD.relation_id THEN
    RAISE EXCEPTION 'relation_id is immutable; replace the relation instead';
  END IF;

  SELECT * INTO checked_relation
  FROM mw_offline.style_relation
  WHERE relation_id = checked_relation_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT
    count(*) FILTER (WHERE participant_role = 'source'),
    count(*) FILTER (WHERE participant_role = 'target'),
    count(*) FILTER (WHERE participant_role = 'peer')
  INTO source_count, target_count, peer_count
  FROM mw_offline.style_relation_participant
  WHERE relation_id = checked_relation_id;

  IF checked_relation.relation_kind = 'fusion_of' THEN
    IF NOT (
      checked_relation.relation_kind = 'fusion_of' AND source_count >= 2 AND target_count = 1
      AND peer_count = 0
    ) THEN
      RAISE EXCEPTION 'fusion_of % requires at least two sources and exactly one target',
        checked_relation_id;
    END IF;
  ELSIF checked_relation.direction = 'directed' THEN
    IF NOT (source_count = 1 AND target_count = 1 AND peer_count = 0) THEN
      RAISE EXCEPTION 'directed relation % requires one source and one target',
        checked_relation_id;
    END IF;
  ELSIF NOT (source_count = 0 AND target_count = 0 AND peer_count = 2) THEN
    RAISE EXCEPTION 'undirected relation % requires exactly two peers', checked_relation_id;
  END IF;

  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION mw_offline.validate_style_relation_assertion_v2()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  checked_assertion_id text := COALESCE(NEW.assertion_id, OLD.assertion_id);
  checked_assertion mw_offline.style_relation_assertion_v2%ROWTYPE;
  checked_relation mw_offline.style_relation%ROWTYPE;
  evidence_count integer;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.assertion_id IS DISTINCT FROM OLD.assertion_id THEN
    RAISE EXCEPTION 'assertion_id is immutable; replace the assertion instead';
  END IF;

  SELECT * INTO checked_assertion
  FROM mw_offline.style_relation_assertion_v2
  WHERE assertion_id = checked_assertion_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT * INTO checked_relation
  FROM mw_offline.style_relation
  WHERE relation_id = checked_assertion.relation_id;

  IF checked_relation.relation_kind = 'unrelated_within_scope'
     AND cardinality(checked_assertion.claim_geographies) = 0
     AND cardinality(checked_assertion.claim_contexts) = 0 THEN
    RAISE EXCEPTION 'unrelated_within_scope assertion % requires an explicit claim scope',
      checked_assertion_id;
  END IF;

  IF checked_relation.relation_kind = 'unrelated_within_scope'
     AND checked_assertion.stance = 'supports'
     AND checked_assertion.review_status = 'accepted'
     AND checked_assertion.assertion_kind <> 'fact' THEN
    RAISE EXCEPTION 'accepted non-relation assertion % must be a fact', checked_assertion_id;
  END IF;

  SELECT count(*) INTO evidence_count
  FROM mw_offline.style_relation_assertion_evidence_v2
  WHERE assertion_id = checked_assertion_id;

  IF checked_assertion.review_status = 'accepted' AND evidence_count = 0 THEN
    RAISE EXCEPTION 'accepted assertion % requires evidence', checked_assertion_id;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM mw_offline.style_relation_assertion_evidence_v2 link
    JOIN mw_offline.style_relation_evidence evidence
      ON evidence.evidence_id = link.evidence_id
    WHERE link.assertion_id = checked_assertion_id
      AND evidence.license_partition <> checked_assertion.license_partition
  ) THEN
    RAISE EXCEPTION 'assertion % and its evidence must share a license partition',
      checked_assertion_id;
  END IF;

  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION mw_offline.validate_style_relation_evidence_v2()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  checked_evidence_id text := COALESCE(NEW.evidence_id, OLD.evidence_id);
BEGIN
  IF EXISTS (
    SELECT 1
    FROM mw_offline.style_relation_evidence evidence
    JOIN mw_offline.style_relation_assertion_evidence_v2 link
      ON link.evidence_id = evidence.evidence_id
    JOIN mw_offline.style_relation_assertion_v2 assertion
      ON assertion.assertion_id = link.assertion_id
    WHERE evidence.evidence_id = checked_evidence_id
      AND evidence.license_partition <> assertion.license_partition
  ) THEN
    RAISE EXCEPTION 'evidence % must share the license partition of every linked assertion',
      checked_evidence_id;
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS style_relation_cardinality_check
  ON mw_offline.style_relation;
DROP TRIGGER IF EXISTS style_relation_participant_cardinality_check
  ON mw_offline.style_relation_participant;
DROP TRIGGER IF EXISTS style_relation_assertion_check
  ON mw_offline.style_relation_assertion_v2;
DROP TRIGGER IF EXISTS style_relation_assertion_evidence_check
  ON mw_offline.style_relation_assertion_evidence_v2;
DROP TRIGGER IF EXISTS style_relation_evidence_lineage_check
  ON mw_offline.style_relation_evidence;

CREATE CONSTRAINT TRIGGER style_relation_cardinality_check
AFTER INSERT OR UPDATE ON mw_offline.style_relation
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION mw_offline.validate_style_relation_v2();

CREATE CONSTRAINT TRIGGER style_relation_participant_cardinality_check
AFTER INSERT OR UPDATE OR DELETE ON mw_offline.style_relation_participant
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION mw_offline.validate_style_relation_v2();

CREATE CONSTRAINT TRIGGER style_relation_assertion_check
AFTER INSERT OR UPDATE ON mw_offline.style_relation_assertion_v2
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION mw_offline.validate_style_relation_assertion_v2();

CREATE CONSTRAINT TRIGGER style_relation_assertion_evidence_check
AFTER INSERT OR UPDATE OR DELETE ON mw_offline.style_relation_assertion_evidence_v2
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION mw_offline.validate_style_relation_assertion_v2();

CREATE CONSTRAINT TRIGGER style_relation_evidence_lineage_check
AFTER INSERT OR UPDATE ON mw_offline.style_relation_evidence
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION mw_offline.validate_style_relation_evidence_v2();

CREATE INDEX IF NOT EXISTS style_relation_kind_idx
  ON mw_offline.style_relation (relation_kind, direction);
CREATE INDEX IF NOT EXISTS style_relation_participant_style_role_idx
  ON mw_offline.style_relation_participant (style_id, participant_role, relation_id);
CREATE INDEX IF NOT EXISTS style_relation_assertion_relation_idx
  ON mw_offline.style_relation_assertion_v2 (relation_id);
CREATE INDEX IF NOT EXISTS style_relation_assertion_active_idx
  ON mw_offline.style_relation_assertion_v2 (relation_id, assertion_kind)
  WHERE review_status = 'accepted' AND stance = 'supports';
CREATE INDEX IF NOT EXISTS style_relation_assertion_claim_idx
  ON mw_offline.style_relation_assertion_v2 (claim_key, review_status);
CREATE INDEX IF NOT EXISTS style_relation_assertion_evidence_evidence_idx
  ON mw_offline.style_relation_assertion_evidence_v2 (evidence_id, assertion_id);
CREATE INDEX IF NOT EXISTS style_relation_evidence_snapshot_idx
  ON mw_offline.style_relation_evidence (source_snapshot_id)
  WHERE source_snapshot_id IS NOT NULL;

COMMIT;
