ALTER TABLE approvals ADD COLUMN project_id TEXT REFERENCES projects(id);
ALTER TABLE approvals ADD COLUMN workflow TEXT;
ALTER TABLE approvals ADD COLUMN evidence_digest TEXT
  CHECK (evidence_digest IS NULL OR (
    length(evidence_digest) = 64 AND evidence_digest NOT GLOB '*[^a-f0-9]*'
  ));
ALTER TABLE approvals ADD COLUMN policy_hash TEXT
  CHECK (policy_hash IS NULL OR (
    length(policy_hash) = 64 AND policy_hash NOT GLOB '*[^a-f0-9]*'
  ));
ALTER TABLE approvals ADD COLUMN expires_at TEXT;

CREATE TRIGGER trg_approval_pilot_binding_insert
BEFORE INSERT ON approvals
WHEN NOT (
  (NEW.project_id IS NULL AND NEW.workflow IS NULL AND NEW.evidence_digest IS NULL
    AND NEW.policy_hash IS NULL AND NEW.expires_at IS NULL)
  OR
  (NEW.project_id IS NOT NULL AND length(NEW.project_id) BETWEEN 1 AND 256
    AND NEW.project_id = trim(NEW.project_id)
    AND NEW.workflow IS NOT NULL AND length(NEW.workflow) BETWEEN 1 AND 256
    AND NEW.workflow = trim(NEW.workflow)
    AND NEW.evidence_digest IS NOT NULL AND NEW.policy_hash IS NOT NULL
    AND NEW.expires_at IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'pilot approval binding must be complete or entirely null');
END;

CREATE TRIGGER trg_approval_pilot_binding_update
BEFORE UPDATE OF project_id, workflow, evidence_digest, policy_hash, expires_at ON approvals
WHEN NOT (
  (NEW.project_id IS NULL AND NEW.workflow IS NULL AND NEW.evidence_digest IS NULL
    AND NEW.policy_hash IS NULL AND NEW.expires_at IS NULL)
  OR
  (NEW.project_id IS NOT NULL AND length(NEW.project_id) BETWEEN 1 AND 256
    AND NEW.project_id = trim(NEW.project_id)
    AND NEW.workflow IS NOT NULL AND length(NEW.workflow) BETWEEN 1 AND 256
    AND NEW.workflow = trim(NEW.workflow)
    AND NEW.evidence_digest IS NOT NULL AND NEW.policy_hash IS NOT NULL
    AND NEW.expires_at IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'pilot approval binding must be complete or entirely null');
END;

CREATE INDEX idx_approvals_pilot_expiry
  ON approvals(project_id, workflow, state, expires_at)
  WHERE project_id IS NOT NULL;
