-- ABOUTME: Adds relay_message: the Iris-returned MessageV2 bytes (nonce/finality filled) that
-- ABOUTME: the attestation actually signs — v1 broadcasts these, not the locally-observed bytes.
ALTER TABLE actor.cctp_jobs ADD COLUMN relay_message text;
