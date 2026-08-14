CREATE UNIQUE INDEX uq_workspaces_id_run_id_for_sandbox
  ON workspaces(id, run_id);

CREATE TABLE sandbox_instances (
  run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL,
  lease_owner_id TEXT NOT NULL,
  fencing_token INTEGER NOT NULL CHECK (fencing_token BETWEEN 1 AND 9007199254740991),
  provider TEXT NOT NULL CHECK (provider = 'docker-compatible'),
  engine_id TEXT,
  image_ref TEXT NOT NULL,
  policy_hash TEXT NOT NULL CHECK (length(policy_hash) = 64),
  workspace_digest TEXT NOT NULL CHECK (length(workspace_digest) = 64),
  context_digest TEXT NOT NULL CHECK (length(context_digest) = 64),
  context_content_hash TEXT NOT NULL CHECK (length(context_content_hash) = 64),
  workdir_digest TEXT NOT NULL CHECK (length(workdir_digest) = 64),
  state TEXT NOT NULL CHECK (state IN (
    'provisioning', 'ready', 'running', 'freezing', 'exporting', 'cleaned', 'quarantined'
  )),
  cleanup_attempts INTEGER NOT NULL DEFAULT 0 CHECK (cleanup_attempts BETWEEN 0 AND 1000),
  last_cleanup_at TEXT,
  quarantine_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id, run_id) REFERENCES workspaces(id, run_id) DEFERRABLE INITIALLY DEFERRED,
  CHECK (length(lease_owner_id) BETWEEN 1 AND 256 AND lease_owner_id = trim(lease_owner_id)),
  CHECK (engine_id IS NULL OR (length(engine_id) = 64 AND engine_id NOT GLOB '*[^a-f0-9]*')),
  CHECK (length(image_ref) BETWEEN 72 AND 1000 AND instr(image_ref, '@sha256:') > 1),
  CHECK (updated_at >= created_at),
  CHECK ((cleanup_attempts = 0 AND last_cleanup_at IS NULL) OR (cleanup_attempts > 0 AND last_cleanup_at IS NOT NULL)),
  CHECK (
    (state = 'quarantined' AND quarantine_reason IS NOT NULL
      AND length(quarantine_reason) BETWEEN 1 AND 1000 AND quarantine_reason = trim(quarantine_reason))
    OR
    (state <> 'quarantined' AND quarantine_reason IS NULL)
  )
);

CREATE INDEX idx_sandbox_instances_reconciliation
  ON sandbox_instances(state, updated_at, cleanup_attempts);
