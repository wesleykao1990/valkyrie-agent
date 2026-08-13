CREATE TABLE comparisons (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  objective TEXT NOT NULL CHECK (length(objective) BETWEEN 1 AND 4096),
  contract_hash TEXT NOT NULL CHECK (contract_hash ~ '^[a-f0-9]{64}$'),
  status TEXT NOT NULL CHECK (status IN ('running','complete','failed')),
  selection_policy TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ
);

CREATE TABLE comparison_candidates (
  comparison_id TEXT NOT NULL REFERENCES comparisons(id),
  run_id TEXT NOT NULL UNIQUE REFERENCES runs(id),
  runtime TEXT NOT NULL,
  workflow TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 8),
  status TEXT NOT NULL CHECK (status IN ('running','evidence_ready','accepted','rejected','failed')),
  metrics_json JSONB,
  evidence_digest TEXT CHECK (evidence_digest IS NULL OR evidence_digest ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (comparison_id,run_id),
  UNIQUE (comparison_id,runtime),
  UNIQUE (comparison_id,ordinal)
);

CREATE INDEX idx_comparison_candidates_comparison ON comparison_candidates(comparison_id,ordinal);

CREATE OR REPLACE FUNCTION enforce_comparison_candidate_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM comparisons c JOIN runs r ON r.id=NEW.run_id
    WHERE c.id=NEW.comparison_id AND c.project_id=r.project_id AND c.task_id=r.task_id
      AND r.root_runtime=NEW.runtime AND r.workflow=NEW.workflow
  ) THEN RAISE EXCEPTION 'comparison candidate must match comparison and run identity'; END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_comparison_candidate_run_binding
BEFORE INSERT ON comparison_candidates
FOR EACH ROW EXECUTE FUNCTION enforce_comparison_candidate_binding();
