CREATE TABLE engineering_routing_assessments (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id),
  task_id text REFERENCES tasks(id),
  literal_request text NOT NULL CHECK (length(literal_request) BETWEEN 1 AND 16384),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  context_digest text NOT NULL CHECK (context_digest ~ '^[a-f0-9]{64}$'),
  context_sources_json jsonb NOT NULL CHECK (
    jsonb_typeof(context_sources_json)='object'
    AND context_sources_json ? 'linear'
    AND context_sources_json ? 'git'
    AND context_sources_json ? 'projectBrain'
  ),
  dimensions_json jsonb NOT NULL CHECK (
    jsonb_typeof(dimensions_json)='object'
    AND jsonb_typeof(dimensions_json->'structure')='number' AND (dimensions_json->>'structure') ~ '^[0-2]$'
    AND jsonb_typeof(dimensions_json->'verifiability')='number' AND (dimensions_json->>'verifiability') ~ '^[0-2]$'
    AND jsonb_typeof(dimensions_json->'iteration')='number' AND (dimensions_json->>'iteration') ~ '^[0-2]$'
    AND jsonb_typeof(dimensions_json->'risk')='number' AND (dimensions_json->>'risk') ~ '^[0-2]$'
    AND jsonb_typeof(dimensions_json->'duration')='number' AND (dimensions_json->>'duration') ~ '^[0-2]$'
    AND jsonb_typeof(dimensions_json->'isolation')='number' AND (dimensions_json->>'isolation') ~ '^[0-2]$'
  ),
  hard_signals_json jsonb NOT NULL CHECK (
    jsonb_typeof(hard_signals_json)='object'
    AND jsonb_typeof(hard_signals_json->'explicitLoop')='boolean'
    AND jsonb_typeof(hard_signals_json->'durableBackground')='boolean'
    AND jsonb_typeof(hard_signals_json->'approvalOrEvidenceGate')='boolean'
    AND jsonb_typeof(hard_signals_json->'multipleCandidates')='boolean'
  ),
  preference text NOT NULL CHECK (preference IN ('auto','direct','atomic-lite','atomic-full')),
  final_action text NOT NULL CHECK (final_action IN ('analysis_only','prepare_reviewable_result')),
  baseline_shape text NOT NULL CHECK (baseline_shape IN ('direct','atomic-lite','atomic-full')),
  selected_shape text NOT NULL CHECK (selected_shape IN ('direct','atomic-lite','atomic-full')),
  score integer NOT NULL CHECK (
    score BETWEEN 0 AND 12
    AND score = CASE
      WHEN (dimensions_json->>'structure') ~ '^[0-2]$'
       AND (dimensions_json->>'verifiability') ~ '^[0-2]$'
       AND (dimensions_json->>'iteration') ~ '^[0-2]$'
       AND (dimensions_json->>'risk') ~ '^[0-2]$'
       AND (dimensions_json->>'duration') ~ '^[0-2]$'
       AND (dimensions_json->>'isolation') ~ '^[0-2]$'
      THEN (dimensions_json->>'structure')::integer
        + (dimensions_json->>'verifiability')::integer
        + (dimensions_json->>'iteration')::integer
        + (dimensions_json->>'risk')::integer
        + (dimensions_json->>'duration')::integer
        + (dimensions_json->>'isolation')::integer
      ELSE -1
    END
  ),
  reasons_json jsonb NOT NULL CHECK (jsonb_typeof(reasons_json)='array' AND jsonb_array_length(reasons_json) BETWEEN 0 AND 32),
  policy_version text NOT NULL CHECK (policy_version ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
  execution_supported boolean NOT NULL,
  unsupported_reasons_json jsonb NOT NULL CHECK (
    jsonb_typeof(unsupported_reasons_json)='array'
    AND jsonb_array_length(unsupported_reasons_json) BETWEEN 0 AND 32
  ),
  status text NOT NULL CHECK (status IN ('assessed','unsupported','expired')),
  run_id text UNIQUE REFERENCES runs(id),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE INDEX idx_engineering_routing_assessments_project_created
  ON engineering_routing_assessments(project_id,created_at DESC,id DESC);
CREATE INDEX idx_engineering_routing_assessments_status_expiry
  ON engineering_routing_assessments(status,expires_at,created_at);

CREATE OR REPLACE FUNCTION enforce_engineering_routing_assessment_task_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.task_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM tasks WHERE id=NEW.task_id AND project_id=NEW.project_id
  ) THEN
    RAISE EXCEPTION 'routing assessment task must belong to its project';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_engineering_routing_assessment_task_binding
BEFORE INSERT OR UPDATE OF project_id,task_id ON engineering_routing_assessments
FOR EACH ROW EXECUTE FUNCTION enforce_engineering_routing_assessment_task_binding();
