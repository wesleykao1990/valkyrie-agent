ALTER TABLE inference_requests
  ADD COLUMN provider_session_id TEXT
    CHECK (provider_session_id IS NULL OR (
      length(provider_session_id) BETWEEN 1 AND 128
      AND provider_session_id NOT GLOB '*[^A-Za-z0-9_.:-]*'
      AND provider_session_id NOT GLOB '[^A-Za-z0-9]*'
    ));

ALTER TABLE inference_requests
  ADD COLUMN provider_session_reused INTEGER NOT NULL DEFAULT 0
    CHECK (provider_session_reused IN (0,1));

CREATE INDEX idx_inference_requests_capability_role_provider_session
  ON inference_requests(capability_id,role,provider_session_id);

CREATE UNIQUE INDEX uq_inference_requests_active_role
  ON inference_requests(capability_id,role) WHERE state='reserved';
