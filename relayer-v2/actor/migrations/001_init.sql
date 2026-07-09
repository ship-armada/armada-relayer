-- ABOUTME: Initial actor schema (spec §5.2): cctp_jobs (one row per claimed MessageSent)
-- ABOUTME: and idempotency (durable POST /relay idempotency). Public chain data only (P4).
CREATE SCHEMA IF NOT EXISTS actor;

CREATE TABLE actor.cctp_jobs (
  dedup_key          text PRIMARY KEY,          -- "${sourceTxHash}:${logIndex}"
  message_hash       text NOT NULL,             -- keccak256(messageBytes); Iris lookup key
  message_bytes      text NOT NULL,
  source_domain      int  NOT NULL,
  destination_domain int  NOT NULL,
  nonce              text NOT NULL,             -- bytes32 hex (zero at source in CCTP V2)
  source_tx_hash     text NOT NULL,
  source_block       bigint NOT NULL,
  state              text NOT NULL,             -- see spec §8.4
  detected_at        timestamptz NOT NULL,
  poll_attempts      int  NOT NULL DEFAULT 0,
  last_iris_status   text,
  -- attestation bytes persisted so attested jobs resume across restarts without
  -- re-polling Iris (deviation DEV-6; semantic addition to the §5.2 column set)
  attestation        text,
  retry_attempts     int  NOT NULL DEFAULT 0,
  next_retry_at      timestamptz,
  submitted_tx_hash  text,
  submitted_at       timestamptz,
  delivered_tx_hash  text,
  delivered_block    bigint,
  delivered_at       timestamptz,
  dead_letter_reason text,
  updated_at         timestamptz NOT NULL
);
CREATE INDEX ON actor.cctp_jobs (state);
CREATE INDEX ON actor.cctp_jobs (destination_domain, delivered_at);

CREATE TABLE actor.idempotency (
  key        text PRIMARY KEY,                  -- client-supplied, <= 200 chars
  tx_hash    text NOT NULL,
  status     text NOT NULL,                     -- pending|confirmed|failed
  chain_id   int  NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
