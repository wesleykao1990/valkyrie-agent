ALTER TABLE runs
  ADD COLUMN worker_claimed_by text,
  ADD COLUMN worker_claim_expires_at timestamptz;

ALTER TABLE outbox_events
  ADD COLUMN available_at timestamptz,
  ADD COLUMN attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN last_error text;

UPDATE outbox_events SET available_at = created_at WHERE available_at IS NULL;
ALTER TABLE outbox_events ALTER COLUMN available_at SET NOT NULL;

CREATE TABLE idempotency_keys (
  scope text NOT NULL,
  key text NOT NULL,
  request_hash text NOT NULL,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  response_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  PRIMARY KEY (scope, key)
);

CREATE UNIQUE INDEX uq_tasks_source_identity
  ON tasks(project_id, source, source_id) WHERE source_id IS NOT NULL;
CREATE UNIQUE INDEX uq_workspaces_run_id ON workspaces(run_id);
CREATE UNIQUE INDEX uq_workspace_id_run_id ON workspaces(id, run_id);
CREATE UNIQUE INDEX uq_workspace_leases_run_id ON workspace_leases(run_id);
CREATE UNIQUE INDEX uq_pending_approval_action
  ON approvals(run_id, action) WHERE state = 'pending';
CREATE INDEX idx_runs_claimable
  ON runs(status, next_action_at, worker_claim_expires_at);
CREATE INDEX idx_outbox_pending
  ON outbox_events(available_at, created_at) WHERE published_at IS NULL;
CREATE INDEX idx_idempotency_expiry ON idempotency_keys(expires_at);

ALTER TABLE workspace_leases
  ADD CONSTRAINT fk_workspace_lease_owner
  FOREIGN KEY (workspace_id, run_id) REFERENCES workspaces(id, run_id)
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE runs
  ADD CONSTRAINT fk_runs_workspace
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
  DEFERRABLE INITIALLY DEFERRED;
