ALTER TABLE inference_requests
  ADD COLUMN provider_session_id text
    CHECK (provider_session_id IS NULL OR provider_session_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
  ADD COLUMN provider_session_reused boolean NOT NULL DEFAULT false
    CHECK (provider_session_reused IN (true,false));

CREATE INDEX idx_inference_requests_capability_role_provider_session
  ON inference_requests(capability_id,role,provider_session_id);

CREATE UNIQUE INDEX uq_inference_requests_active_role
  ON inference_requests(capability_id,role) WHERE state='reserved';
