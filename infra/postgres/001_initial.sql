-- Production-target schema. The zero-dependency prototype currently uses SQLite.
CREATE TABLE IF NOT EXISTS projects (
  id text PRIMARY KEY,
  name text NOT NULL,
  objective text NOT NULL,
  current_milestone text NOT NULL,
  health text NOT NULL,
  linear_team text NOT NULL,
  repository text NOT NULL,
  vault_path text NOT NULL,
  memory_namespace text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tasks (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id),
  source text NOT NULL,
  source_id text,
  title text NOT NULL,
  objective text NOT NULL,
  status text NOT NULL,
  priority text NOT NULL DEFAULT 'normal',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS runs (
  id text PRIMARY KEY,
  task_id text REFERENCES tasks(id),
  project_id text NOT NULL REFERENCES projects(id),
  root_runtime text NOT NULL,
  workflow text,
  status text NOT NULL,
  stage text,
  stage_index integer NOT NULL DEFAULT 0,
  budget_usd numeric(12,4) NOT NULL,
  cost_usd numeric(12,4) NOT NULL DEFAULT 0,
  workspace_id text,
  native_run_id text,
  next_action_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS run_events (
  seq bigserial PRIMARY KEY,
  id text UNIQUE NOT NULL,
  run_id text NOT NULL REFERENCES runs(id),
  type text NOT NULL,
  message text NOT NULL,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workspaces (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES runs(id),
  path text NOT NULL,
  provider text NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workspace_leases (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id),
  run_id text NOT NULL REFERENCES runs(id),
  mode text NOT NULL,
  expires_at timestamptz NOT NULL,
  heartbeat_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES runs(id),
  action text NOT NULL,
  exact_effect text NOT NULL,
  state text NOT NULL,
  evidence_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  requested_at timestamptz NOT NULL,
  resolved_at timestamptz,
  resolved_by text,
  decision text
);

CREATE TABLE IF NOT EXISTS artifacts (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES runs(id),
  kind text NOT NULL,
  uri text NOT NULL,
  checksum text NOT NULL,
  media_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memory_proposals (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id),
  run_id text REFERENCES runs(id),
  claim text NOT NULL,
  evidence_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  state text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  reviewer text,
  target_note text
);

CREATE TABLE IF NOT EXISTS outbox_events (
  id text PRIMARY KEY,
  topic text NOT NULL,
  aggregate_id text NOT NULL,
  payload_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_runs_project_status ON runs(project_id, status);
CREATE INDEX IF NOT EXISTS idx_run_events_run_seq ON run_events(run_id, seq);
CREATE INDEX IF NOT EXISTS idx_approvals_state ON approvals(state);
CREATE INDEX IF NOT EXISTS idx_memory_proposals_state ON memory_proposals(state);
