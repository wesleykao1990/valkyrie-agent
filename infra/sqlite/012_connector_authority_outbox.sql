-- Narrow, revision-bound external authority evidence.  This is not a
-- provider payload/roadmap replica; the control-plane store owns the
-- compare-and-set semantics for changes to identity or revision.
CREATE TABLE authority_bindings (
  provider TEXT NOT NULL,
  local_kind TEXT NOT NULL,
  local_id TEXT NOT NULL,
  external_kind TEXT,
  external_id TEXT NOT NULL,
  revision TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  payload_hash TEXT NOT NULL CHECK (length(payload_hash)=64 AND payload_hash NOT GLOB '*[^a-f0-9]*'),
  fresh_until TEXT NOT NULL,
  PRIMARY KEY (provider, local_kind, local_id),
  CHECK (length(provider) BETWEEN 1 AND 128 AND provider = trim(provider)),
  CHECK (length(local_kind) BETWEEN 1 AND 128 AND local_kind = trim(local_kind)),
  CHECK (length(local_id) BETWEEN 1 AND 256 AND local_id = trim(local_id)),
  CHECK (external_kind IS NULL OR (length(external_kind) BETWEEN 1 AND 128 AND external_kind = trim(external_kind))),
  CHECK (length(external_id) BETWEEN 1 AND 256 AND external_id = trim(external_id)),
  CHECK (length(revision) BETWEEN 1 AND 512 AND revision = trim(revision)),
  CHECK (length(observed_at) > 0 AND length(fresh_until) > 0 AND fresh_until > observed_at)
);

CREATE INDEX idx_authority_bindings_provider_observed
  ON authority_bindings(provider, observed_at DESC, local_kind, local_id);
CREATE INDEX idx_authority_bindings_freshness
  ON authority_bindings(fresh_until, provider, local_kind, local_id);
CREATE UNIQUE INDEX uq_authority_bindings_external_identity
  ON authority_bindings(provider, external_id);

-- A delivery row is created lazily by a consumer claim.  There is therefore
-- no consumer registry and no phantom delivery rows for every historical
-- outbox event.
CREATE TABLE outbox_deliveries (
  outbox_id TEXT NOT NULL REFERENCES outbox_events(id) ON DELETE RESTRICT,
  consumer_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','claimed','delivered','dead')),
  claim_owner_id TEXT,
  claim_token TEXT,
  claim_expires_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 8),
  next_attempt_at TEXT,
  delivered_at TEXT,
  last_error_code TEXT,
  last_error_fingerprint TEXT
    CHECK (last_error_fingerprint IS NULL OR (length(last_error_fingerprint)=64 AND last_error_fingerprint NOT GLOB '*[^a-f0-9]*')),
  receipt_external_id TEXT,
  receipt_external_revision TEXT,
  receipt_payload_hash TEXT
    CHECK (receipt_payload_hash IS NULL OR (length(receipt_payload_hash)=64 AND receipt_payload_hash NOT GLOB '*[^a-f0-9]*')),
  receipt_observed_at TEXT,
  attempt_history_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(attempt_history_json) AND json_type(attempt_history_json)='array'),
  PRIMARY KEY (outbox_id, consumer_id),
  CHECK (length(consumer_id) BETWEEN 1 AND 128 AND consumer_id = trim(consumer_id)),
  CHECK (
    (claim_owner_id IS NULL AND claim_token IS NULL AND claim_expires_at IS NULL)
    OR
    (claim_owner_id IS NOT NULL AND length(claim_owner_id) BETWEEN 1 AND 256
      AND claim_owner_id = trim(claim_owner_id)
      AND claim_token IS NOT NULL AND length(claim_token)=64 AND claim_token NOT GLOB '*[^a-f0-9]*'
      AND claim_expires_at IS NOT NULL)
  ),
  CHECK ((last_error_code IS NULL AND last_error_fingerprint IS NULL)
    OR (last_error_code IS NOT NULL AND length(last_error_code) BETWEEN 1 AND 128
      AND last_error_code = trim(last_error_code) AND last_error_fingerprint IS NOT NULL)),
  CHECK ((receipt_external_id IS NULL AND receipt_external_revision IS NULL
      AND receipt_payload_hash IS NULL AND receipt_observed_at IS NULL)
    OR (receipt_external_id IS NOT NULL AND length(receipt_external_id) BETWEEN 1 AND 256
      AND receipt_external_id = trim(receipt_external_id)
      AND receipt_external_revision IS NOT NULL AND length(receipt_external_revision) BETWEEN 1 AND 512
      AND receipt_external_revision = trim(receipt_external_revision)
      AND receipt_payload_hash IS NOT NULL AND receipt_observed_at IS NOT NULL)),
  CHECK (
    (state = 'pending' AND claim_owner_id IS NULL AND claim_token IS NULL AND claim_expires_at IS NULL
      AND delivered_at IS NULL AND next_attempt_at IS NOT NULL)
    OR
    (state = 'claimed' AND claim_owner_id IS NOT NULL AND claim_token IS NOT NULL
      AND claim_expires_at IS NOT NULL AND delivered_at IS NULL AND next_attempt_at IS NULL)
    OR
    (state = 'delivered' AND delivered_at IS NOT NULL AND next_attempt_at IS NULL)
    OR
    (state = 'dead' AND claim_owner_id IS NULL AND claim_token IS NULL AND claim_expires_at IS NULL
      AND delivered_at IS NULL AND next_attempt_at IS NULL)
  )
);

CREATE INDEX idx_outbox_deliveries_consumer_claimable
  ON outbox_deliveries(consumer_id, state, next_attempt_at, claim_expires_at, outbox_id);
CREATE INDEX idx_outbox_deliveries_retention
  ON outbox_deliveries(state, delivered_at, outbox_id);
