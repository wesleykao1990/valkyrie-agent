CREATE TABLE comparisons (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  objective TEXT NOT NULL CHECK (length(objective) BETWEEN 1 AND 4096),
  contract_hash TEXT NOT NULL CHECK (length(contract_hash)=64 AND contract_hash NOT GLOB '*[^a-f0-9]*'),
  status TEXT NOT NULL CHECK (status IN ('running','complete','failed')),
  selection_policy TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE comparison_candidates (
  comparison_id TEXT NOT NULL REFERENCES comparisons(id),
  run_id TEXT NOT NULL UNIQUE REFERENCES runs(id),
  runtime TEXT NOT NULL,
  workflow TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 8),
  status TEXT NOT NULL CHECK (status IN ('running','evidence_ready','accepted','rejected','failed')),
  metrics_json TEXT CHECK (metrics_json IS NULL OR json_valid(metrics_json)),
  evidence_digest TEXT CHECK (evidence_digest IS NULL OR (length(evidence_digest)=64 AND evidence_digest NOT GLOB '*[^a-f0-9]*')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (comparison_id, run_id),
  UNIQUE (comparison_id, runtime),
  UNIQUE (comparison_id, ordinal)
);

CREATE INDEX idx_comparison_candidates_comparison ON comparison_candidates(comparison_id,ordinal);

CREATE TRIGGER trg_comparison_candidate_run_binding
BEFORE INSERT ON comparison_candidates
WHEN NOT EXISTS (
  SELECT 1 FROM comparisons c JOIN runs r ON r.id=NEW.run_id
  WHERE c.id=NEW.comparison_id AND c.project_id=r.project_id AND c.task_id=r.task_id
    AND r.root_runtime=NEW.runtime AND r.workflow=NEW.workflow
)
BEGIN SELECT RAISE(ABORT, 'comparison candidate must match comparison and run identity'); END;
