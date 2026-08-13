-- Narrow, revision-bound external authority evidence.  The store, rather
-- than a generic upsert, owns compare-and-set refresh semantics.
CREATE TABLE authority_bindings (
  provider text NOT NULL,
  local_kind text NOT NULL,
  local_id text NOT NULL,
  external_kind text,
  external_id text NOT NULL,
  revision text NOT NULL,
  observed_at timestamptz NOT NULL,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  fresh_until timestamptz NOT NULL,
  PRIMARY KEY (provider, local_kind, local_id),
  CHECK (length(provider) BETWEEN 1 AND 128 AND provider = btrim(provider)),
  CHECK (length(local_kind) BETWEEN 1 AND 128 AND local_kind = btrim(local_kind)),
  CHECK (length(local_id) BETWEEN 1 AND 256 AND local_id = btrim(local_id)),
  CHECK (external_kind IS NULL OR (length(external_kind) BETWEEN 1 AND 128 AND external_kind = btrim(external_kind))),
  CHECK (length(external_id) BETWEEN 1 AND 256 AND external_id = btrim(external_id)),
  CHECK (length(revision) BETWEEN 1 AND 512 AND revision = btrim(revision)),
  CHECK (fresh_until > observed_at)
);

CREATE INDEX idx_authority_bindings_provider_observed
  ON authority_bindings(provider, observed_at DESC, local_kind, local_id);
CREATE INDEX idx_authority_bindings_freshness
  ON authority_bindings(fresh_until, provider, local_kind, local_id);
CREATE UNIQUE INDEX uq_authority_bindings_external_identity
  ON authority_bindings(provider, external_id);

-- Delivery state is created lazily when a consumer claims work.  Existing
-- pending outbox rows are not copied into this table by the migration.
CREATE TABLE outbox_deliveries (
  outbox_id text NOT NULL REFERENCES outbox_events(id) ON DELETE RESTRICT,
  consumer_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('pending','claimed','delivered','dead')),
  claim_owner_id text,
  claim_token text,
  claim_expires_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 8),
  next_attempt_at timestamptz,
  delivered_at timestamptz,
  last_error_code text,
  last_error_fingerprint text CHECK (last_error_fingerprint IS NULL OR last_error_fingerprint ~ '^[a-f0-9]{64}$'),
  receipt_external_id text,
  receipt_external_revision text,
  receipt_payload_hash text CHECK (receipt_payload_hash IS NULL OR receipt_payload_hash ~ '^[a-f0-9]{64}$'),
  receipt_observed_at timestamptz,
  attempt_history_json jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(attempt_history_json)='array'),
  PRIMARY KEY (outbox_id, consumer_id),
  CHECK (length(consumer_id) BETWEEN 1 AND 128 AND consumer_id = btrim(consumer_id)),
  CHECK (
    (claim_owner_id IS NULL AND claim_token IS NULL AND claim_expires_at IS NULL)
    OR
    (claim_owner_id IS NOT NULL AND length(claim_owner_id) BETWEEN 1 AND 256
      AND claim_owner_id = btrim(claim_owner_id)
      AND claim_token IS NOT NULL AND claim_token ~ '^[a-f0-9]{64}$'
      AND claim_expires_at IS NOT NULL)
  ),
  CHECK ((last_error_code IS NULL AND last_error_fingerprint IS NULL)
    OR (last_error_code IS NOT NULL AND length(last_error_code) BETWEEN 1 AND 128
      AND last_error_code = btrim(last_error_code) AND last_error_fingerprint IS NOT NULL)),
  CHECK ((receipt_external_id IS NULL AND receipt_external_revision IS NULL
      AND receipt_payload_hash IS NULL AND receipt_observed_at IS NULL)
    OR (receipt_external_id IS NOT NULL AND length(receipt_external_id) BETWEEN 1 AND 256
      AND receipt_external_id = btrim(receipt_external_id)
      AND receipt_external_revision IS NOT NULL AND length(receipt_external_revision) BETWEEN 1 AND 512
      AND receipt_external_revision = btrim(receipt_external_revision)
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
