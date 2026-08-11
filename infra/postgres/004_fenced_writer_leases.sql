ALTER TABLE workspaces
  ADD COLUMN lease_epoch bigint NOT NULL DEFAULT 0
    CHECK (lease_epoch >= 0 AND lease_epoch <= 9007199254740991);

ALTER TABLE workspace_leases
  ADD COLUMN owner_id text,
  ADD COLUMN fencing_token bigint,
  ADD COLUMN state text NOT NULL DEFAULT 'active',
  ADD COLUMN acquired_at timestamptz,
  ADD COLUMN quarantined_at timestamptz,
  ADD COLUMN quarantine_reason text;

UPDATE workspace_leases
SET owner_id = run_id,
    fencing_token = 1,
    acquired_at = heartbeat_at;

UPDATE workspaces w
SET lease_epoch = 1
WHERE EXISTS (
  SELECT 1 FROM workspace_leases l WHERE l.workspace_id = w.id
);

ALTER TABLE workspace_leases
  ALTER COLUMN owner_id SET NOT NULL,
  ALTER COLUMN fencing_token SET NOT NULL,
  ALTER COLUMN acquired_at SET NOT NULL,
  ADD CONSTRAINT chk_workspace_lease_owner_id
    CHECK (length(owner_id) BETWEEN 1 AND 256 AND owner_id = btrim(owner_id)),
  ADD CONSTRAINT chk_workspace_lease_mode
    CHECK (mode = 'writer'),
  ADD CONSTRAINT chk_workspace_lease_fencing_token
    CHECK (fencing_token BETWEEN 1 AND 9007199254740991),
  ADD CONSTRAINT chk_workspace_lease_state
    CHECK (state IN ('active', 'quarantined')),
  ADD CONSTRAINT chk_workspace_lease_timestamps
    CHECK (expires_at > heartbeat_at AND acquired_at <= heartbeat_at),
  ADD CONSTRAINT chk_workspace_lease_quarantine_evidence
    CHECK (
      (state = 'active' AND quarantined_at IS NULL AND quarantine_reason IS NULL)
      OR
      (state = 'quarantined' AND quarantined_at IS NOT NULL
        AND quarantined_at >= acquired_at
        AND length(quarantine_reason) BETWEEN 1 AND 1000
        AND quarantine_reason = btrim(quarantine_reason))
    );

ALTER TABLE workspaces
  ADD CONSTRAINT uq_workspaces_id_lease_epoch UNIQUE (id, lease_epoch);

ALTER TABLE workspace_leases
  ADD CONSTRAINT fk_workspace_lease_fencing_epoch
  FOREIGN KEY (workspace_id, fencing_token)
  REFERENCES workspaces(id, lease_epoch)
  DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX idx_workspace_leases_reconciliation
  ON workspace_leases(state, expires_at, heartbeat_at);

CREATE FUNCTION prevent_workspace_lease_epoch_regression()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.lease_epoch < OLD.lease_epoch THEN
    RAISE EXCEPTION 'workspace lease epoch cannot decrease';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_workspace_lease_epoch_monotonic
BEFORE UPDATE OF lease_epoch ON workspaces
FOR EACH ROW EXECUTE FUNCTION prevent_workspace_lease_epoch_regression();
