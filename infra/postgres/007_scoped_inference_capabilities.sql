ALTER TABLE runs ADD CONSTRAINT uq_runs_id_project UNIQUE (id,project_id);

CREATE TABLE inference_capabilities (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES runs(id),
  project_id text NOT NULL REFERENCES projects(id),
  workflow text NOT NULL,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  provider text NOT NULL,
  model text NOT NULL,
  api text NOT NULL CHECK (api='openai-completions'),
  roles_json jsonb NOT NULL,
  max_requests integer NOT NULL CHECK (max_requests BETWEEN 1 AND 8),
  max_input_tokens integer NOT NULL CHECK (max_input_tokens BETWEEN 1 AND 128000),
  max_output_tokens integer NOT NULL CHECK (max_output_tokens BETWEEN 1 AND 32768),
  max_cost_micros bigint NOT NULL CHECK (max_cost_micros BETWEEN 0 AND 100000000),
  max_elapsed_ms integer NOT NULL CHECK (max_elapsed_ms BETWEEN 100 AND 600000),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('active','revoked','exhausted','expired')),
  policy_hash text NOT NULL CHECK (policy_hash ~ '^[a-f0-9]{64}$'),
  FOREIGN KEY (run_id, project_id) REFERENCES runs(id, project_id)
);

ALTER TABLE inference_capabilities ADD CONSTRAINT uq_inference_capability_id_run UNIQUE (id,run_id);

CREATE TABLE inference_requests (
  id text PRIMARY KEY,
  capability_id text NOT NULL REFERENCES inference_capabilities(id),
  run_id text NOT NULL REFERENCES runs(id),
  role text NOT NULL CHECK (role IN ('implementer','verifier_initial','repair','verifier_final')),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('reserved','completed','failed')),
  provider_request_id text,
  response_hash text CHECK (response_hash IS NULL OR response_hash ~ '^[a-f0-9]{64}$'),
  input_tokens integer NOT NULL DEFAULT 0 CHECK (input_tokens BETWEEN 0 AND 128000),
  output_tokens integer NOT NULL DEFAULT 0 CHECK (output_tokens BETWEEN 0 AND 32768),
  cost_micros bigint NOT NULL DEFAULT 0 CHECK (cost_micros BETWEEN 0 AND 100000000),
  reserved_at timestamptz NOT NULL,
  completed_at timestamptz,
  failure_code text,
  UNIQUE(capability_id, role),
  FOREIGN KEY (capability_id, run_id) REFERENCES inference_capabilities(id, run_id)
);

CREATE INDEX idx_inference_capabilities_run_state ON inference_capabilities(run_id,state,expires_at);
CREATE INDEX idx_inference_requests_capability_state ON inference_requests(capability_id,state,reserved_at);
