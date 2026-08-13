CREATE TABLE engineering_routing_assessments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  task_id TEXT REFERENCES tasks(id),
  literal_request TEXT NOT NULL CHECK (length(literal_request) BETWEEN 1 AND 16384),
  request_hash TEXT NOT NULL CHECK (length(request_hash)=64 AND request_hash NOT GLOB '*[^a-f0-9]*'),
  context_digest TEXT NOT NULL CHECK (length(context_digest)=64 AND context_digest NOT GLOB '*[^a-f0-9]*'),
  context_sources_json TEXT NOT NULL CHECK (
    json_valid(context_sources_json)
    AND json_type(context_sources_json)='object'
    AND json_type(context_sources_json,'$.linear') IS NOT NULL
    AND json_type(context_sources_json,'$.git') IS NOT NULL
    AND json_type(context_sources_json,'$.projectBrain') IS NOT NULL
  ),
  dimensions_json TEXT NOT NULL CHECK (
    json_valid(dimensions_json)
    AND json_type(dimensions_json)='object'
    AND json_type(dimensions_json,'$.structure')='integer' AND json_extract(dimensions_json,'$.structure') BETWEEN 0 AND 2
    AND json_type(dimensions_json,'$.verifiability')='integer' AND json_extract(dimensions_json,'$.verifiability') BETWEEN 0 AND 2
    AND json_type(dimensions_json,'$.iteration')='integer' AND json_extract(dimensions_json,'$.iteration') BETWEEN 0 AND 2
    AND json_type(dimensions_json,'$.risk')='integer' AND json_extract(dimensions_json,'$.risk') BETWEEN 0 AND 2
    AND json_type(dimensions_json,'$.duration')='integer' AND json_extract(dimensions_json,'$.duration') BETWEEN 0 AND 2
    AND json_type(dimensions_json,'$.isolation')='integer' AND json_extract(dimensions_json,'$.isolation') BETWEEN 0 AND 2
  ),
  hard_signals_json TEXT NOT NULL CHECK (
    json_valid(hard_signals_json)
    AND json_type(hard_signals_json)='object'
    AND json_type(hard_signals_json,'$.explicitLoop') IN ('true','false')
    AND json_type(hard_signals_json,'$.durableBackground') IN ('true','false')
    AND json_type(hard_signals_json,'$.approvalOrEvidenceGate') IN ('true','false')
    AND json_type(hard_signals_json,'$.multipleCandidates') IN ('true','false')
  ),
  preference TEXT NOT NULL CHECK (preference IN ('auto','direct','atomic-lite','atomic-full')),
  final_action TEXT NOT NULL CHECK (final_action IN ('analysis_only','prepare_reviewable_result')),
  baseline_shape TEXT NOT NULL CHECK (baseline_shape IN ('direct','atomic-lite','atomic-full')),
  selected_shape TEXT NOT NULL CHECK (selected_shape IN ('direct','atomic-lite','atomic-full')),
  score INTEGER NOT NULL CHECK (
    score BETWEEN 0 AND 12
    AND score = json_extract(dimensions_json,'$.structure')
      + json_extract(dimensions_json,'$.verifiability')
      + json_extract(dimensions_json,'$.iteration')
      + json_extract(dimensions_json,'$.risk')
      + json_extract(dimensions_json,'$.duration')
      + json_extract(dimensions_json,'$.isolation')
  ),
  reasons_json TEXT NOT NULL CHECK (json_valid(reasons_json) AND json_type(reasons_json)='array' AND json_array_length(reasons_json) BETWEEN 0 AND 32),
  policy_version TEXT NOT NULL CHECK (
    length(policy_version) BETWEEN 1 AND 128
    AND policy_version NOT GLOB '*[^A-Za-z0-9_.:-]*'
    AND policy_version NOT GLOB '[^A-Za-z0-9]*'
  ),
  execution_supported INTEGER NOT NULL CHECK (execution_supported IN (0,1)),
  unsupported_reasons_json TEXT NOT NULL CHECK (
    json_valid(unsupported_reasons_json)
    AND json_type(unsupported_reasons_json)='array'
    AND json_array_length(unsupported_reasons_json) BETWEEN 0 AND 32
  ),
  status TEXT NOT NULL CHECK (status IN ('assessed','unsupported','expired')),
  run_id TEXT UNIQUE REFERENCES runs(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX idx_engineering_routing_assessments_project_created
  ON engineering_routing_assessments(project_id,created_at DESC,id DESC);
CREATE INDEX idx_engineering_routing_assessments_status_expiry
  ON engineering_routing_assessments(status,expires_at,created_at);

CREATE TRIGGER trg_engineering_routing_assessment_task_binding
BEFORE INSERT ON engineering_routing_assessments
WHEN NEW.task_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM tasks WHERE id=NEW.task_id AND project_id=NEW.project_id
)
BEGIN SELECT RAISE(ABORT, 'routing assessment task must belong to its project'); END;

CREATE TRIGGER trg_engineering_routing_assessment_task_update_binding
BEFORE UPDATE OF project_id,task_id ON engineering_routing_assessments
WHEN NEW.task_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM tasks WHERE id=NEW.task_id AND project_id=NEW.project_id
)
BEGIN SELECT RAISE(ABORT, 'routing assessment task must belong to its project'); END;
