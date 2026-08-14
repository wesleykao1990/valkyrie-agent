-- Immutable, approval-gated external effects.  A plan records the exact
-- bounded request and evidence that authorized it; it never changes the
-- lifecycle/status of its completed evidence run.
CREATE TABLE external_action_plans (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  workflow TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('linear_create_issue','linear_evidence_comment','github_create_draft_pr')),
  provider TEXT NOT NULL CHECK (provider IN ('linear','github')),
  marker TEXT NOT NULL,
  target_json TEXT NOT NULL CHECK (json_valid(target_json) AND json_type(target_json)='object' AND length(CAST(target_json AS BLOB))<=16384),
  spec_json TEXT NOT NULL CHECK (json_valid(spec_json) AND json_type(spec_json)='object' AND length(CAST(spec_json AS BLOB))<=16384),
  request_hash TEXT NOT NULL CHECK (length(request_hash)=64 AND request_hash NOT GLOB '*[^a-f0-9]*'),
  evidence_digest TEXT NOT NULL CHECK (length(evidence_digest)=64 AND evidence_digest NOT GLOB '*[^a-f0-9]*'),
  policy_hash TEXT NOT NULL CHECK (length(policy_hash)=64 AND policy_hash NOT GLOB '*[^a-f0-9]*'),
  approval_id TEXT NOT NULL UNIQUE REFERENCES approvals(id) ON DELETE RESTRICT,
  approval_action TEXT NOT NULL,
  exact_effect TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending_approval','authorized','executing','ambiguous','succeeded','denied','expired','failed','quarantined')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 8),
  provider_receipt_json TEXT CHECK (provider_receipt_json IS NULL OR (json_valid(provider_receipt_json) AND json_type(provider_receipt_json)='object' AND length(CAST(provider_receipt_json AS BLOB))<=8192)),
  result_json TEXT CHECK (result_json IS NULL OR (json_valid(result_json) AND json_type(result_json)='object' AND length(CAST(result_json AS BLOB))<=16384)),
  last_error_code TEXT,
  last_error_fingerprint TEXT CHECK (last_error_fingerprint IS NULL OR (length(last_error_fingerprint)=64 AND last_error_fingerprint NOT GLOB '*[^a-f0-9]*')),
  reconciliation_json TEXT CHECK (reconciliation_json IS NULL OR (json_valid(reconciliation_json) AND json_type(reconciliation_json)='object' AND length(CAST(reconciliation_json AS BLOB))<=8192)),
  authorized_outbox_id TEXT REFERENCES outbox_events(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (provider, marker),
  CHECK (length(id) BETWEEN 1 AND 128 AND id = trim(id)),
  CHECK (length(run_id) BETWEEN 1 AND 128 AND run_id = trim(run_id)),
  CHECK (length(project_id) BETWEEN 1 AND 128 AND project_id = trim(project_id)),
  CHECK (length(workflow) BETWEEN 1 AND 128 AND workflow = trim(workflow)),
  CHECK (length(provider) BETWEEN 1 AND 32 AND provider = trim(provider)),
  CHECK (length(marker) BETWEEN 1 AND 256 AND marker = trim(marker)),
  CHECK (length(approval_action) BETWEEN 1 AND 256 AND approval_action = trim(approval_action)),
  CHECK (length(exact_effect) BETWEEN 1 AND 2048 AND exact_effect = trim(exact_effect)),
  CHECK (length(expires_at)>0 AND length(created_at)>0 AND length(updated_at)>0),
  CHECK (updated_at >= created_at),
  CHECK ((last_error_code IS NULL AND last_error_fingerprint IS NULL)
    OR (last_error_code IS NOT NULL AND length(last_error_code) BETWEEN 1 AND 128
      AND last_error_code = trim(last_error_code) AND last_error_fingerprint IS NOT NULL)),
  CHECK ((kind LIKE 'linear_%' AND provider='linear') OR (kind LIKE 'github_%' AND provider='github'))
);

CREATE INDEX idx_external_action_plans_run_state
  ON external_action_plans(run_id, state, updated_at DESC);
CREATE INDEX idx_external_action_plans_project_state
  ON external_action_plans(project_id, state, created_at DESC);
CREATE INDEX idx_external_action_plans_expiry
  ON external_action_plans(state, expires_at, id);
