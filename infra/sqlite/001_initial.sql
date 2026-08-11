CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  objective TEXT NOT NULL,
  current_milestone TEXT NOT NULL,
  health TEXT NOT NULL,
  linear_team TEXT NOT NULL,
  repository TEXT NOT NULL,
  vault_path TEXT NOT NULL,
  memory_namespace TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  source TEXT NOT NULL,
  source_id TEXT,
  title TEXT NOT NULL,
  objective TEXT NOT NULL,
  status TEXT NOT NULL,
  priority TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  root_runtime TEXT NOT NULL,
  workflow TEXT,
  status TEXT NOT NULL,
  stage TEXT,
  stage_index INTEGER NOT NULL DEFAULT 0,
  budget_usd REAL NOT NULL,
  cost_usd REAL NOT NULL DEFAULT 0,
  workspace_id TEXT REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  native_run_id TEXT,
  next_action_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS run_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT UNIQUE NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(id),
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  path TEXT NOT NULL,
  provider TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_leases (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id),
  run_id TEXT NOT NULL REFERENCES runs(id),
  mode TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  action TEXT NOT NULL,
  exact_effect TEXT NOT NULL,
  state TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence_json)),
  requested_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT,
  decision TEXT
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  kind TEXT NOT NULL,
  uri TEXT NOT NULL,
  checksum TEXT NOT NULL,
  media_type TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_proposals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  run_id TEXT REFERENCES runs(id),
  claim TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence_json)),
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  reviewer TEXT,
  target_note TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_status_next ON runs(status, next_action_at);
CREATE INDEX IF NOT EXISTS idx_events_run_seq ON run_events(run_id, seq);
CREATE INDEX IF NOT EXISTS idx_approvals_state ON approvals(state);
CREATE INDEX IF NOT EXISTS idx_memory_state ON memory_proposals(state);
