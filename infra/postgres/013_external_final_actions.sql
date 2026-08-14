-- Immutable, approval-gated external effects.  A plan records the exact
-- bounded request and evidence that authorized it; it never changes the
-- lifecycle/status of its completed evidence run.
CREATE TABLE external_action_plans (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  workflow text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('linear_create_issue','linear_evidence_comment','github_create_draft_pr')),
  provider text NOT NULL CHECK (provider IN ('linear','github')),
  marker text NOT NULL,
  target_json jsonb NOT NULL CHECK (jsonb_typeof(target_json)='object' AND octet_length(target_json::text)<=16384),
  spec_json jsonb NOT NULL CHECK (jsonb_typeof(spec_json)='object' AND octet_length(spec_json::text)<=16384),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  evidence_digest text NOT NULL CHECK (evidence_digest ~ '^[a-f0-9]{64}$'),
  policy_hash text NOT NULL CHECK (policy_hash ~ '^[a-f0-9]{64}$'),
  approval_id text NOT NULL UNIQUE REFERENCES approvals(id) ON DELETE RESTRICT,
  approval_action text NOT NULL,
  exact_effect text NOT NULL,
  expires_at timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('pending_approval','authorized','executing','ambiguous','succeeded','denied','expired','failed','quarantined')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 8),
  provider_receipt_json jsonb CHECK (provider_receipt_json IS NULL OR (jsonb_typeof(provider_receipt_json)='object' AND octet_length(provider_receipt_json::text)<=8192)),
  result_json jsonb CHECK (result_json IS NULL OR (jsonb_typeof(result_json)='object' AND octet_length(result_json::text)<=16384)),
  last_error_code text,
  last_error_fingerprint text CHECK (last_error_fingerprint IS NULL OR last_error_fingerprint ~ '^[a-f0-9]{64}$'),
  reconciliation_json jsonb CHECK (reconciliation_json IS NULL OR (jsonb_typeof(reconciliation_json)='object' AND octet_length(reconciliation_json::text)<=8192)),
  authorized_outbox_id text REFERENCES outbox_events(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (provider, marker),
  CHECK (length(id) BETWEEN 1 AND 128 AND id = btrim(id)),
  CHECK (length(run_id) BETWEEN 1 AND 128 AND run_id = btrim(run_id)),
  CHECK (length(project_id) BETWEEN 1 AND 128 AND project_id = btrim(project_id)),
  CHECK (length(workflow) BETWEEN 1 AND 128 AND workflow = btrim(workflow)),
  CHECK (length(provider) BETWEEN 1 AND 32 AND provider = btrim(provider)),
  CHECK (length(marker) BETWEEN 1 AND 256 AND marker = btrim(marker)),
  CHECK (length(approval_action) BETWEEN 1 AND 256 AND approval_action = btrim(approval_action)),
  CHECK (length(exact_effect) BETWEEN 1 AND 2048 AND exact_effect = btrim(exact_effect)),
  CHECK (updated_at >= created_at),
  CHECK ((last_error_code IS NULL AND last_error_fingerprint IS NULL)
    OR (last_error_code IS NOT NULL AND length(last_error_code) BETWEEN 1 AND 128
      AND last_error_code = btrim(last_error_code) AND last_error_fingerprint IS NOT NULL)),
  CHECK ((kind LIKE 'linear_%' AND provider='linear') OR (kind LIKE 'github_%' AND provider='github'))
);

CREATE INDEX idx_external_action_plans_run_state
  ON external_action_plans(run_id, state, updated_at DESC);
CREATE INDEX idx_external_action_plans_project_state
  ON external_action_plans(project_id, state, created_at DESC);
CREATE INDEX idx_external_action_plans_expiry
  ON external_action_plans(state, expires_at, id);
