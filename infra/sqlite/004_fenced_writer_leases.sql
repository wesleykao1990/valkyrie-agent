ALTER TABLE workspaces ADD COLUMN lease_epoch INTEGER NOT NULL DEFAULT 0
  CHECK (lease_epoch >= 0 AND lease_epoch <= 9007199254740991);

ALTER TABLE workspace_leases ADD COLUMN owner_id TEXT NOT NULL DEFAULT '';
ALTER TABLE workspace_leases ADD COLUMN fencing_token INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workspace_leases ADD COLUMN state TEXT NOT NULL DEFAULT 'active'
  CHECK (state IN ('active', 'quarantined'));
ALTER TABLE workspace_leases ADD COLUMN acquired_at TEXT NOT NULL DEFAULT '';
ALTER TABLE workspace_leases ADD COLUMN quarantined_at TEXT;
ALTER TABLE workspace_leases ADD COLUMN quarantine_reason TEXT;

UPDATE workspace_leases
SET owner_id = run_id,
    fencing_token = 1,
    acquired_at = heartbeat_at;

UPDATE workspaces
SET lease_epoch = 1
WHERE EXISTS (
  SELECT 1 FROM workspace_leases l WHERE l.workspace_id = workspaces.id
);

CREATE TABLE _fenced_lease_integrity_guard (
  valid INTEGER NOT NULL CHECK (valid = 1)
);

INSERT INTO _fenced_lease_integrity_guard(valid)
SELECT 0 WHERE EXISTS (
  SELECT 1
  FROM workspace_leases l
  JOIN workspaces w ON w.id = l.workspace_id AND w.run_id = l.run_id
  WHERE l.mode <> 'writer'
    OR l.owner_id = ''
    OR l.owner_id <> trim(l.owner_id)
    OR length(l.owner_id) > 256
    OR l.fencing_token < 1
    OR l.fencing_token > 9007199254740991
    OR l.fencing_token <> w.lease_epoch
    OR l.acquired_at = ''
    OR l.expires_at <= l.heartbeat_at
    OR l.acquired_at > l.heartbeat_at
);

DROP TABLE _fenced_lease_integrity_guard;

CREATE INDEX idx_workspace_leases_reconciliation
  ON workspace_leases(state, expires_at, heartbeat_at);

CREATE TRIGGER trg_workspace_lease_epoch_monotonic
BEFORE UPDATE OF lease_epoch ON workspaces
WHEN NEW.lease_epoch < OLD.lease_epoch
BEGIN
  SELECT RAISE(ABORT, 'workspace lease epoch cannot decrease');
END;

CREATE TRIGGER trg_workspace_lease_fence_insert
BEFORE INSERT ON workspace_leases
WHEN NEW.owner_id = ''
  OR NEW.owner_id <> trim(NEW.owner_id)
  OR length(NEW.owner_id) > 256
  OR NEW.mode <> 'writer'
  OR NEW.fencing_token < 1
  OR NEW.fencing_token > 9007199254740991
  OR NEW.acquired_at = ''
  OR NEW.expires_at <= NEW.heartbeat_at
  OR NEW.acquired_at > NEW.heartbeat_at
  OR NOT EXISTS (
    SELECT 1 FROM workspaces w
    WHERE w.id = NEW.workspace_id
      AND w.run_id = NEW.run_id
      AND w.lease_epoch = NEW.fencing_token
  )
  OR (NEW.state = 'active' AND (NEW.quarantined_at IS NOT NULL OR NEW.quarantine_reason IS NOT NULL))
  OR (NEW.state = 'quarantined' AND (
    NEW.quarantined_at IS NULL
    OR NEW.quarantined_at < NEW.acquired_at
    OR NEW.quarantine_reason IS NULL
    OR NEW.quarantine_reason = ''
    OR NEW.quarantine_reason <> trim(NEW.quarantine_reason)
    OR length(NEW.quarantine_reason) > 1000
  ))
BEGIN
  SELECT RAISE(ABORT, 'invalid fenced workspace lease');
END;

CREATE TRIGGER trg_workspace_lease_fence_update
BEFORE UPDATE OF workspace_id, run_id, owner_id, mode, fencing_token, state, expires_at, heartbeat_at, acquired_at, quarantined_at, quarantine_reason
ON workspace_leases
WHEN NEW.owner_id = ''
  OR NEW.owner_id <> trim(NEW.owner_id)
  OR length(NEW.owner_id) > 256
  OR NEW.mode <> 'writer'
  OR NEW.fencing_token < 1
  OR NEW.fencing_token > 9007199254740991
  OR NEW.acquired_at = ''
  OR NEW.expires_at <= NEW.heartbeat_at
  OR NEW.acquired_at > NEW.heartbeat_at
  OR NOT EXISTS (
    SELECT 1 FROM workspaces w
    WHERE w.id = NEW.workspace_id
      AND w.run_id = NEW.run_id
      AND w.lease_epoch = NEW.fencing_token
  )
  OR (NEW.state = 'active' AND (NEW.quarantined_at IS NOT NULL OR NEW.quarantine_reason IS NOT NULL))
  OR (NEW.state = 'quarantined' AND (
    NEW.quarantined_at IS NULL
    OR NEW.quarantined_at < NEW.acquired_at
    OR NEW.quarantine_reason IS NULL
    OR NEW.quarantine_reason = ''
    OR NEW.quarantine_reason <> trim(NEW.quarantine_reason)
    OR length(NEW.quarantine_reason) > 1000
  ))
BEGIN
  SELECT RAISE(ABORT, 'invalid fenced workspace lease');
END;
