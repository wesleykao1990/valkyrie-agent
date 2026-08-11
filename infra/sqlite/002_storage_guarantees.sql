ALTER TABLE runs ADD COLUMN worker_claimed_by TEXT;
ALTER TABLE runs ADD COLUMN worker_claim_expires_at TEXT;

CREATE TABLE outbox_events (
  id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at TEXT NOT NULL,
  available_at TEXT NOT NULL,
  published_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);

CREATE TABLE idempotency_keys (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  created_at TEXT NOT NULL,
  expires_at TEXT,
  PRIMARY KEY (scope, key)
);

CREATE UNIQUE INDEX uq_tasks_source_identity
  ON tasks(project_id, source, source_id) WHERE source_id IS NOT NULL;
CREATE UNIQUE INDEX uq_workspaces_run_id ON workspaces(run_id);
CREATE UNIQUE INDEX uq_workspace_leases_run_id ON workspace_leases(run_id);
CREATE UNIQUE INDEX uq_pending_approval_action
  ON approvals(run_id, action) WHERE state = 'pending';
CREATE INDEX idx_runs_claimable
  ON runs(status, next_action_at, worker_claim_expires_at);
CREATE INDEX idx_outbox_pending
  ON outbox_events(available_at, created_at) WHERE published_at IS NULL;
CREATE INDEX idx_idempotency_expiry ON idempotency_keys(expires_at);
