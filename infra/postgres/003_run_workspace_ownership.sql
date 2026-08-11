ALTER TABLE runs
  ADD CONSTRAINT fk_runs_workspace_owner
  FOREIGN KEY (workspace_id, id) REFERENCES workspaces(id, run_id)
  DEFERRABLE INITIALLY DEFERRED;
