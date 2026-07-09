# Relayer v2 — Security & Privacy Notes

## Key isolation (D2/S1)

All secrets (`RELAYER_PRIVATE_KEY`, `RELAYER_RAILGUN_MNEMONIC`, optional
`BROADCASTER_RAILGUN_ADDRESS`) reach ONLY the actor container. Compose passes no secret env
vars to the watcher; the watcher serves the widest surface (chain data + public HTTP) with
nothing to steal. Postgres is not exposed outside the compose network (S4) and the roles are
split: `watcher_rw` cannot touch the `actor` schema, `actor_rw` only reads the published
`indexed` views.

## Privacy rules P1–P6 (spec §12) — implementation audit

- **P1 (global streams only):** watcher endpoints accept block cursors and protocol
  contract addresses only; `/v1/logs` rejects any address outside the indexed-contract
  allowlist with 400. No endpoint accepts a wallet address, npk, commitment, or nullifier.
- **P2 (client-side matching):** v1's `GET /cctp-status/:messageHash` does not exist in v2
  (test-asserted); delivery status is the uniform `/cctp/delivered` cursor feed.
- **P3 (no identifiers):** no auth, cookies, sessions, or per-client tokens anywhere; fee
  quotes are global per chain.
- **P4 (log & retention hygiene):** pino redacts IPs/headers/keys; calldata is logged as
  selector + length only; rate-limiter IP state is in-memory only and swept; job and
  idempotency rows contain only public chain data / client-chosen opaque keys. The VPS
  reverse proxy MUST disable or anonymize access logs on the actor path and the watcher
  path (deployment checklist item — cannot be enforced from this repo).
- **P5 (history stays client-side):** no per-user materialization exists; all tables are
  keyed by chain events or dedup keys.
- **P6 (residual leak, documented):** `POST /relay` necessarily ties the submitter's IP to
  a transaction at submission time. This is unavoidable in a direct-HTTP relayer
  architecture; it is mitigated by P4 (nothing is retained) and users may reach the
  endpoint via their own network privacy layer (VPN/Tor). Structural fixes (Waku-style
  broadcaster networking) are explicitly out of scope for v2 (spec §1).

## Fail-closed behaviors preserved (S2)

Selector allowlist, per-chain target allowlist, fee verification before submission
(gasless plaintext + broadcaster note-decrypt paths; any verification error rejects),
CCTP message classification (§8.5: empty recipient set relays nothing), 256 KiB body
limit, per-IP rate limits. No testing-mode or SNARK-bypass pathways exist (S3).
