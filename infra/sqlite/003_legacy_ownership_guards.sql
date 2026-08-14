-- Fail closed before stamping this migration if an unversioned/legacy database
-- contains ownership relationships that the original schema did not enforce.
CREATE TABLE _storage_integrity_guard (
  valid INTEGER NOT NULL CHECK (valid = 1)
);

INSERT INTO _storage_integrity_guard(valid)
SELECT 0 WHERE EXISTS (
  SELECT 1 FROM workspaces w
  LEFT JOIN runs r ON r.id = w.run_id
  WHERE r.id IS NULL
  UNION ALL
  SELECT 1 FROM workspace_leases l
  LEFT JOIN workspaces w ON w.id = l.workspace_id AND w.run_id = l.run_id
  LEFT JOIN runs r ON r.id = l.run_id
  WHERE w.id IS NULL OR r.id IS NULL
  UNION ALL
  SELECT 1 FROM runs r
  LEFT JOIN workspaces w ON w.id = r.workspace_id AND w.run_id = r.id
  WHERE r.workspace_id IS NOT NULL AND w.id IS NULL
);

DROP TABLE _storage_integrity_guard;

CREATE TRIGGER trg_workspace_run_owner_insert
BEFORE INSERT ON workspaces
WHEN NOT EXISTS (SELECT 1 FROM runs r WHERE r.id = NEW.run_id)
BEGIN
  SELECT RAISE(ABORT, 'workspace owner run does not exist');
END;

CREATE TRIGGER trg_workspace_owner_immutable
BEFORE UPDATE OF id, run_id ON workspaces
WHEN NEW.id <> OLD.id OR NEW.run_id <> OLD.run_id
BEGIN
  SELECT RAISE(ABORT, 'workspace identity and run ownership are immutable');
END;

CREATE TRIGGER trg_workspace_lease_owner_insert
BEFORE INSERT ON workspace_leases
WHEN NOT EXISTS (
  SELECT 1 FROM workspaces w JOIN runs r ON r.id = w.run_id
  WHERE w.id = NEW.workspace_id AND w.run_id = NEW.run_id
)
BEGIN
  SELECT RAISE(ABORT, 'workspace lease owner mismatch');
END;

CREATE TRIGGER trg_workspace_lease_owner_update
BEFORE UPDATE OF workspace_id, run_id ON workspace_leases
WHEN NOT EXISTS (
  SELECT 1 FROM workspaces w JOIN runs r ON r.id = w.run_id
  WHERE w.id = NEW.workspace_id AND w.run_id = NEW.run_id
)
BEGIN
  SELECT RAISE(ABORT, 'workspace lease owner mismatch');
END;

CREATE TRIGGER trg_run_workspace_owner_insert
BEFORE INSERT ON runs
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspaces w WHERE w.id = NEW.workspace_id AND w.run_id = NEW.id
)
BEGIN
  SELECT RAISE(ABORT, 'run workspace owner mismatch');
END;

CREATE TRIGGER trg_run_workspace_owner_update
BEFORE UPDATE OF workspace_id ON runs
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspaces w WHERE w.id = NEW.workspace_id AND w.run_id = NEW.id
)
BEGIN
  SELECT RAISE(ABORT, 'run workspace owner mismatch');
END;
