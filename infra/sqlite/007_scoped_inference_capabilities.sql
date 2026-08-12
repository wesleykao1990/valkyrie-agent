CREATE TABLE inference_capabilities (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  workflow TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash)=64 AND token_hash NOT GLOB '*[^a-f0-9]*'),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  api TEXT NOT NULL CHECK (api='openai-completions'),
  roles_json TEXT NOT NULL CHECK (json_valid(roles_json)),
  max_requests INTEGER NOT NULL CHECK (max_requests BETWEEN 1 AND 8),
  max_input_tokens INTEGER NOT NULL CHECK (max_input_tokens BETWEEN 1 AND 128000),
  max_output_tokens INTEGER NOT NULL CHECK (max_output_tokens BETWEEN 1 AND 32768),
  max_cost_micros INTEGER NOT NULL CHECK (max_cost_micros BETWEEN 0 AND 100000000),
  max_elapsed_ms INTEGER NOT NULL CHECK (max_elapsed_ms BETWEEN 100 AND 600000),
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active','revoked','exhausted','expired')),
  policy_hash TEXT NOT NULL CHECK (length(policy_hash)=64 AND policy_hash NOT GLOB '*[^a-f0-9]*')
);

CREATE TABLE inference_requests (
  id TEXT PRIMARY KEY,
  capability_id TEXT NOT NULL REFERENCES inference_capabilities(id),
  run_id TEXT NOT NULL REFERENCES runs(id),
  role TEXT NOT NULL CHECK (role IN ('implementer','verifier_initial','repair','verifier_final')),
  request_hash TEXT NOT NULL CHECK (length(request_hash)=64 AND request_hash NOT GLOB '*[^a-f0-9]*'),
  state TEXT NOT NULL CHECK (state IN ('reserved','completed','failed')),
  provider_request_id TEXT,
  response_hash TEXT CHECK (response_hash IS NULL OR (length(response_hash)=64 AND response_hash NOT GLOB '*[^a-f0-9]*')),
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens BETWEEN 0 AND 128000),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens BETWEEN 0 AND 32768),
  cost_micros INTEGER NOT NULL DEFAULT 0 CHECK (cost_micros BETWEEN 0 AND 100000000),
  reserved_at TEXT NOT NULL,
  completed_at TEXT,
  failure_code TEXT,
  UNIQUE(capability_id, role)
);

CREATE INDEX idx_inference_capabilities_run_state ON inference_capabilities(run_id,state,expires_at);
CREATE INDEX idx_inference_requests_capability_state ON inference_requests(capability_id,state,reserved_at);

CREATE TRIGGER trg_inference_capability_run_binding
BEFORE INSERT ON inference_capabilities
WHEN NOT EXISTS (
  SELECT 1 FROM runs WHERE id=NEW.run_id AND project_id=NEW.project_id AND workflow=NEW.workflow
)
BEGIN SELECT RAISE(ABORT, 'inference capability must match its run project and workflow'); END;

CREATE TRIGGER trg_inference_request_run_binding
BEFORE INSERT ON inference_requests
WHEN NOT EXISTS (
  SELECT 1 FROM inference_capabilities WHERE id=NEW.capability_id AND run_id=NEW.run_id
)
BEGIN SELECT RAISE(ABORT, 'inference request must match its capability run'); END;
