CREATE TABLE sandbox_instances (
  run_id text PRIMARY KEY REFERENCES runs(id) ON DELETE RESTRICT,
  workspace_id text NOT NULL,
  lease_owner_id text NOT NULL,
  fencing_token bigint NOT NULL CHECK (fencing_token BETWEEN 1 AND 9007199254740991),
  provider text NOT NULL CHECK (provider = 'docker-compatible'),
  engine_id text,
  image_ref text NOT NULL,
  policy_hash text NOT NULL CHECK (policy_hash ~ '^[a-f0-9]{64}$'),
  workspace_digest text NOT NULL CHECK (workspace_digest ~ '^[a-f0-9]{64}$'),
  context_digest text NOT NULL CHECK (context_digest ~ '^[a-f0-9]{64}$'),
  context_content_hash text NOT NULL CHECK (context_content_hash ~ '^[a-f0-9]{64}$'),
  workdir_digest text NOT NULL CHECK (workdir_digest ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN (
    'provisioning', 'ready', 'running', 'freezing', 'exporting', 'cleaned', 'quarantined'
  )),
  cleanup_attempts integer NOT NULL DEFAULT 0 CHECK (cleanup_attempts BETWEEN 0 AND 1000),
  last_cleanup_at timestamptz,
  quarantine_reason text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  FOREIGN KEY (workspace_id, run_id) REFERENCES workspaces(id, run_id) DEFERRABLE INITIALLY DEFERRED,
  CHECK (length(lease_owner_id) BETWEEN 1 AND 256 AND lease_owner_id = btrim(lease_owner_id)),
  CHECK (engine_id IS NULL OR engine_id ~ '^[a-f0-9]{64}$'),
  CHECK (length(image_ref) BETWEEN 72 AND 1000 AND strpos(image_ref, '@sha256:') > 1),
  CHECK (updated_at >= created_at),
  CHECK ((cleanup_attempts = 0 AND last_cleanup_at IS NULL) OR (cleanup_attempts > 0 AND last_cleanup_at IS NOT NULL)),
  CHECK (
    (state = 'quarantined' AND quarantine_reason IS NOT NULL
      AND length(quarantine_reason) BETWEEN 1 AND 1000 AND quarantine_reason = btrim(quarantine_reason))
    OR
    (state <> 'quarantined' AND quarantine_reason IS NULL)
  )
);

CREATE INDEX idx_sandbox_instances_reconciliation
  ON sandbox_instances(state, updated_at, cleanup_attempts);
