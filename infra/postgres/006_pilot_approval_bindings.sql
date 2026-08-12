ALTER TABLE approvals
  ADD COLUMN project_id text REFERENCES projects(id),
  ADD COLUMN workflow text,
  ADD COLUMN evidence_digest text,
  ADD COLUMN policy_hash text,
  ADD COLUMN expires_at timestamptz,
  ADD CONSTRAINT chk_approval_pilot_binding_complete CHECK (
    (project_id IS NULL AND workflow IS NULL AND evidence_digest IS NULL
      AND policy_hash IS NULL AND expires_at IS NULL)
    OR
    (project_id IS NOT NULL AND length(project_id) BETWEEN 1 AND 256
      AND project_id = btrim(project_id)
      AND workflow IS NOT NULL AND length(workflow) BETWEEN 1 AND 256
      AND workflow = btrim(workflow)
      AND evidence_digest IS NOT NULL AND evidence_digest ~ '^[a-f0-9]{64}$'
      AND policy_hash IS NOT NULL AND policy_hash ~ '^[a-f0-9]{64}$'
      AND expires_at IS NOT NULL)
  );

CREATE INDEX idx_approvals_pilot_expiry
  ON approvals(project_id, workflow, state, expires_at)
  WHERE project_id IS NOT NULL;
