# Relayer v2 — Watcher/Actor Architecture Specification

## 1. Purpose and Scope

This document specifies **relayer v2**: a greenfield rewrite of the Armada relayer as two cooperating services — a chain **watcher** (indexer, built on Ponder) and a transaction **actor** (job-driven submitter) — sharing a Postgres database, orchestrated with Docker Compose, and observable via Prometheus.

**In scope:** full v1 functional parity (privacy relay, CCTP relay in mock and Iris modes, fees, health), the new event-indexing/read-API functionality (shielded-sync event streams, quick-sync feed, CCTP delivered feed), database schema, HTTP API contracts, configuration, observability, orchestration, migration/cutover, and testing requirements.

**In scope (additionally):** mainnet as a first-class configuration target (§7.2, §11, §15.4), and the frontend (armada-interface) changes required in tandem with v2, including cross-workstream blockers in both directions (§18).

**Out of scope:** contract changes (none required), Waku-style broadcaster networking (documented residual leak, see §12 P6), mainnet *deployment* itself (v2 must be mainnet-ready by configuration; the deployment event is operational work outside this spec).

**Document authority:** This spec is authoritative for relayer v2. Where it conflicts with `.claude/PLAN_EVENT_INDEXING.md`, this spec wins; that plan's Phase 2 ("in-relayer indexer module") is **superseded** by this architecture. The plan's privacy rules (P1–P6) are incorporated here as §12 and remain normative. v1 behavior described in §6–§8 was extracted from the `relayer/` codebase on branch `iskay/relayer-hardening`; if v1 code and this document disagree on a preserved behavior, **v1 code wins** and this document must be corrected.

Requirement keywords MUST / MUST NOT / SHOULD / MAY are used per RFC 2119.

---

## 2. Background and Motivation

The v1 relayer (`relayer/`) is a single Node process that intertwines two kinds of work with opposite engineering needs:

1. **Watching** — reactive chain reading (detect `MessageSent`, maintain cursors, backfill, reorg safety). Idempotent; re-running is harmless.
2. **Acting** — transactional side effects (`/relay` submission, fee verification, Iris attestation polling, `relayWithHook` broadcasts, nonce management, stuck-tx recovery). Holds private keys; re-running is never harmless.

v1 hand-rolls the watching layer (`cursor-store`, `rpc-bisecting`, `get-logs-chunked`, pending-store schema migrations) and has required repeated hardening. Meanwhile the frontend needs indexed event data (shielded sync, tx status) that nothing serves today, and the project is **RPC-budget constrained** — `eth_getLogs` polling across three chains already hits provider limits.

v2 resolves all three pressures:

- **Exactly one process issues `eth_getLogs`** (the watcher). The actor discovers work via local SQL. RPC duplication is structurally impossible, not merely mitigated.
- The watching layer is delegated to **Ponder** (cursors, backfill, reorg handling, RPC batching/caching are framework concerns, not bespoke code).
- The indexed data doubles as the **frontend read API** (event streams, quick-sync, delivered feed), moving N-users × per-device scanning onto infrastructure we control.
- **Keys live only in the actor**, which has a small input surface. The watcher, exposed to the widest surface (chain data + public HTTP), holds no secrets.

---

## 3. Definitions

| Term | Meaning |
|---|---|
| **Watcher** | The Ponder-based indexing service (`armada-watcher`). Reads chains, writes indexed events to Postgres, serves the public read API. |
| **Actor** | The transaction-submitting service (`armada-actor`). Serves `/relay`/`/fees`, runs the CCTP job state machine, holds all keys. |
| **Hub** | Ethereum chain hosting the PrivacyPool (local Anvil 31337 / Ethereum Sepolia 11155111). |
| **Clients** | Chains hosting `PrivacyPoolClient` (local 31338/31339; Base Sepolia 84532, Arbitrum Sepolia 421614). |
| **Job** | A row in `actor.cctp_jobs` representing one CCTP message's relay lifecycle. |
| **dedupKey** | `${sourceTxHash}:${logIndex}` — canonical unique identifier for a `MessageSent` log (v1 convention, preserved). |
| **Manifest** | Deployment JSON under `deployments/` (addresses + `deployBlock`). Single source of truth for contract addresses. |
| **P1–P6** | The privacy rules defined in §12. |

---

## 4. Architecture Overview

```
                        ┌─ Docker Compose ─────────────────────────────────────┐
                        │                                                       │
  Hub RPC ──────────┐   │  ┌─────────────────┐        ┌───────────────────┐    │
  Client A RPC ─────┼──►│  │  armada-watcher │        │   armada-actor    │    │
  Client B RPC ─────┘   │  │  (Ponder)       │        │   (Express + jobs)│    │
   (getLogs: watcher    │  │                 │        │                   │    │
    ONLY)               │  │  indexes events │        │  /relay /fees     │◄───┼── users (writes)
                        │  │  read API :42069│◄───────┼──/status /health  │    │
                        │  │  /metrics       │  SQL   │  /cctp/delivered  │    │
                        │  └───────┬─────────┘        │  /metrics         │    │
                        │          │ writes           │  keys: EOA + 0zk  │────┼──► tx submission,
                        │          ▼                  └────────┬──────────┘    │    Iris API, gas reads
                        │  ┌─────────────────┐   reads/writes  │               │    (NO getLogs while
                        │  │   Postgres 16   │◄────────────────┘               │     watcher healthy)
                        │  └─────────────────┘                                 │
                        │  [obs profile: prometheus + grafana]                 │
                        └───────────────────────────────────────────────────────┘
                                   ▲                          ▲
                          indexerUrl (reads)          relayerUrl (reads + writes)
                                   └────── armada-interface ──┘
```

### 4.1 Design principles (normative)

- **D1 — Single scanner.** Only the watcher issues `eth_getLogs`/block-range queries in steady state. The actor's RPC usage is limited to: tx submission, receipt polling for its own txs, nonce/balance reads, gas-price reads, and the fallback scanner (§8.7) when the watcher is stale.
- **D2 — Keys only in the actor.** The watcher process MUST NOT have access to `RELAYER_PRIVATE_KEY`, `RELAYER_RAILGUN_MNEMONIC`, or any secret. Compose MUST NOT pass secret env vars to the watcher container.
- **D3 — Database as the interface.** The services communicate only through Postgres. No HTTP calls between watcher and actor.
- **D4 — Chain as root of trust.** Indexed data is a liveness optimization for consumers. Nothing in this system asks anyone to trust indexed data for correctness: the frontend validates merkle roots on-chain, and the destination chain's replay protection is the final dedup authority.
- **D5 — Fail closed on relaying.** Any message that cannot be positively classified as ours-to-relay is skipped (v1 `classifyMessageForRelay` semantics, §8.5).
- **D6 — Privacy rules P1–P6 (§12)** bind every endpoint and every log line.

### 4.2 Repository layout

```
relayer-v2/
├── watcher/                 # Ponder app (own package.json)
│   ├── ponder.config.ts     # chains/contracts derived from deployments/ manifests
│   ├── ponder.schema.ts
│   ├── src/                 # indexing functions + API routes (Hono)
│   └── abis/                # generated from Hardhat artifacts (see §7.2)
├── actor/                   # Express + job runner (own package.json)
│   ├── src/
│   │   ├── main.ts
│   │   ├── http/            # routes
│   │   ├── jobs/            # CCTP state machine, work discovery, fallback scanner
│   │   ├── relay/           # privacy relay, fee calculator, verifiers (ported from v1)
│   │   ├── wallet/          # wallet manager, nonce coordinator, railgun wallet (ported)
│   │   └── db/              # migrations + query layer for the actor schema
│   └── migrations/
├── compose/
│   ├── docker-compose.yml
│   ├── docker-compose.obs.yml     # prometheus + grafana profile
│   └── prometheus.yml
└── README.md
```

v1 (`relayer/`) MUST remain untouched and runnable until cutover completes (§14). Repo conventions apply throughout: `ABOUTME:` file headers, TDD, no `--no-verify`, `npm install --legacy-peer-deps`. The two packages MUST keep dependencies independent (the actor needs the Railgun SDK; the watcher must not).

---

## 5. Shared Database

- **Engine:** Postgres 16 (container; named volume). PGlite is NOT used — two processes share the DB, which requires a real server.
- **Schemas & ownership:**
  - Ponder manages its own internal schemas and publishes a stable queryable schema/views for indexed tables. The actor MUST read indexed data only through the published views (never Ponder's internal tables). The implementing agent MUST verify the current Ponder direct-SQL mechanism (`ponder start --schema <name>` / published views) against the pinned Ponder version's docs and record the choice in `relayer-v2/README.md`.
  - `actor` schema — owned by the actor; the watcher never reads or writes it, with one exception: the watcher's API MAY read `actor.cctp_jobs` if the delivered feed is ever moved there (it is not, in this spec — see §9.2).
- **Roles:** `watcher_rw` (Ponder schemas only), `actor_rw` (actor schema RW + read-only grant on the published indexed views). Compose provisions both via init script.
- **Migrations:** actor schema uses a migration tool (`node-pg-migrate` or drizzle-kit; implementer's choice, recorded in README). Ponder migrates its own tables.

### 5.1 Indexed tables (watcher-owned; exact columns may be adjusted to Ponder idioms, semantic content is normative)

| Table | Columns (semantic) | Source event |
|---|---|---|
| `commitment_batch` | id (`chainId:txHash:logIndex`), kind (`shield`\|`transact`), treeNumber, startPosition, commitmentCount, blockNumber, txHash, logIndex, rawData, rawTopics | Hub `Shield`, `Transact` |
| `nullifier` | id (`chainId:txHash:logIndex:i`), treeNumber, hash, blockNumber, txHash, logIndex | Hub `Nullified` (one row per array element) |
| `unshield` | id, toAddress, tokenAddress, amount, fee, blockNumber, txHash | Hub `Unshield` |
| `cctp_message_sent` | id (= dedupKey), chainId, sourceDomain, destinationDomain, messageBytes, messageHash, sourceTxHash, logIndex, blockNumber, blockTimestamp | All chains `MessageSent` |
| `cctp_message_received` | id, chainId, sourceDomain, nonce, caller, destinationTxHash, blockNumber | All chains `MessageReceived` |
| `xchain_initiated` | id, chainId, kind (`shield`\|`unshield`), domain, amount, nonce, txHash, blockNumber | Client `CrossChainShieldInitiated`, Hub `CrossChainUnshieldInitiated` |
| `unshield_received` | id, chainId, recipient, amount, txHash, blockNumber | Client `UnshieldReceived` |

`rawData`/`rawTopics` are stored verbatim so the read API can serve the frontend's `Raw*` envelope shapes and the quick-sync decoder without re-encoding risk.

### 5.2 Actor tables

```sql
-- actor.cctp_jobs — one row per MessageSent the actor has claimed for relay
CREATE TABLE actor.cctp_jobs (
  dedup_key         text PRIMARY KEY,          -- "${sourceTxHash}:${logIndex}"
  message_hash      text NOT NULL,             -- keccak256(messageBytes); Iris lookup key
  message_bytes     text NOT NULL,
  source_domain     int  NOT NULL,
  destination_domain int NOT NULL,
  nonce             text NOT NULL,             -- bytes32 hex (zero at source in CCTP V2)
  source_tx_hash    text NOT NULL,
  source_block      bigint NOT NULL,
  state             text NOT NULL,             -- see §8.4
  detected_at       timestamptz NOT NULL,
  poll_attempts     int  NOT NULL DEFAULT 0,
  last_iris_status  text,
  retry_attempts    int  NOT NULL DEFAULT 0,
  next_retry_at     timestamptz,
  submitted_tx_hash text,
  submitted_at      timestamptz,
  delivered_tx_hash text,
  delivered_block   bigint,
  delivered_at      timestamptz,
  dead_letter_reason text,
  updated_at        timestamptz NOT NULL
);
CREATE INDEX ON actor.cctp_jobs (state);
CREATE INDEX ON actor.cctp_jobs (destination_domain, delivered_at);

-- actor.idempotency — durable POST /relay idempotency (replaces v1 JSON store)
CREATE TABLE actor.idempotency (
  key        text PRIMARY KEY,                 -- client-supplied, ≤ 200 chars
  tx_hash    text NOT NULL,
  status     text NOT NULL,                    -- pending|confirmed|failed
  chain_id   int  NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
```

All contents of both tables are public chain data or client-chosen opaque keys; neither table stores IPs, user agents, or any request metadata (P4).

**Retention:** `actor.cctp_jobs` and `actor.idempotency` rows are kept indefinitely at current scale (public data; row counts are tiny). Revisit trigger: if either table exceeds 1M rows or Postgres storage becomes a VPS concern, spec a pruning policy then — never prune `delivered` rows younger than the frontend's maximum tx lifecycle (60 min) plus 24 h.

---

## 6. Preserved v1 Behavior — Normative Constants

v2 MUST preserve the following v1 semantics and constants exactly (source: v1 code on `iskay/relayer-hardening`). Any deliberate deviation MUST be listed in §15 (Deviations) of this document before implementation.

### 6.1 Fee schedule & calculator

- `FeeSchedule` shape: `{ cacheId, expiresAt, chainId, broadcasterRailgunAddress, fees: { transfer, unshield, crossContract, crossChainShield, crossChainUnshield, shield, shieldXchain } }` (all fee values: USDC raw units, 6 decimals, as strings).
- `cacheId` format `fee-{chainId}-{timestampMs}-{counter}`; includes chainId so a quote cannot be replayed cross-chain.
- Fee formula: `gasEstimate × gasPrice × (ethUsdcPrice / 1e18) × (1 + profitMarginBps/10000) × 1e6`, floored at 10,000 raw units (0.01 USDC). Gas price from `provider.getFeeData()` (fallback `maxFeePerGas`, then 1 gwei). **Deviation (§16.6):** v2 sources `ethUsdcPrice` from a Chainlink feed on sepolia/mainnet (§8.8) instead of v1's static config value; the formula and every other constant are unchanged.
- Gas estimates per operation: transfer/unshield/crossChainShield/crossChainUnshield 500,000; crossContract 2,000,000; gaslessShield 300,000; gaslessCrossChainShield 400,000.
- Quote TTL `feeTtlSeconds` (default 300 s); one-deep previous-schedule retention with variance buffer `feeTtlSeconds × feeVarianceBufferBps / 10000` ms (default bps 2000).

### 6.2 `/relay` validation pipeline (order preserved)

1. chainId configured → else `INVALID_CHAIN` (400)
2. `to` in per-chain target allowlist (case-insensitive) → else `INVALID_TARGET` (400)
3. `feesCacheId` resolves to current-or-previous schedule within variance buffer → else `FEE_EXPIRED` (402)
4. selector ∈ allowed set → else `INVALID_DATA` (400). Allowed: `transact` 0xd8ae136a, `lendAndShield` 0xf2987ad1, `redeemAndShield` 0x0793b70e, `atomicCrossChainUnshield` 0xe484d408, `gaslessShield`, `gaslessCrossChainShield` (selectors derived from wrapper ABIs).
5. Fee verification:
   - Proof-bearing path: broadcaster fee verifier — normalize wrapper calldata to synthetic `transact`, decrypt commitments via the relayer Railgun wallet's viewing key (`extractFirstNoteERC20AmountMap`), assert decrypted USDC ≥ advertised fee → else `FEE_INSUFFICIENT` (402). Advertised fee for `transact` = `min(fees.transfer, fees.unshield)`.
   - Gasless path: decode plaintext fee arg (`gaslessShield` arg index 2; `gaslessCrossChainShield` permitInput[2]), assert `to` equals the configured wrapper for that chain, assert fee ≥ advertised → `INVALID_TARGET` / `INVALID_DATA` / `FEE_INSUFFICIENT` accordingly.
6. Wallet lock check → `RELAYER_BUSY` (503)
7. Gas estimation (revert check) → `GAS_ESTIMATION_FAILED` (422)
8. Submit with 20% gas buffer via nonce coordinator; duplicate calldata (10-min chain-scoped dedup cache) → `DUPLICATE_TX` (409); broadcast failure → `SUBMISSION_FAILED` (502).

Error-code → HTTP-status map preserved verbatim (including 402 for fee errors, 429 for rate limiting).

### 6.3 Idempotency & rate limiting

- Optional `idempotencyKey` on `POST /relay` (≤ 200 chars): first call executes, repeats return the recorded result; terminal status backfilled from `/status` lookups. v2 stores this in `actor.idempotency` (durable across restarts — an improvement over v1's file store, same semantics).
- Per-IP token buckets: `POST /relay` default 10/min; GET endpoints default 60/min; refill capacity/60 per second; 429 on exhaustion; `RELAYER_TRUST_PROXY` honors `X-Forwarded-For` only when explicitly enabled. Rate-limiter state is in-memory and MUST NOT be persisted (P4).

### 6.4 CCTP job state machine constants

- `MAX_RELAY_RETRIES = 5`; retry backoff `2000 ms × 2^n` (2s, 4s, 8s, 16s, 32s).
- `STUCK_TX_THRESHOLD_MS` default 600,000 (10 min; env-overridable, min 60 s): in-flight broadcast without receipt → clear submitted state, re-enter submission with fresh nonce.
- `MAX_ATTESTATION_AGE_MS` default 3,600,000 (1 h; env-overridable, min 60 s): message older than this without attestation → dead-letter.
- Iris attestation polling concurrency: 8 per tick.
- Message classification (fail-closed, §8.5) preserved bit-for-bit: min length 376 bytes; burn-message body version must equal 1; `mintRecipient` (offset 184) MUST be in the known-recipients set (empty set ⇒ relay nothing); `destinationCaller` (offset 108) must be zero or equal the configured HookRouter.

### 6.5 Wallet & nonce management

- Single EOA across chains (`RELAYER_PRIVATE_KEY`; deployer-key fallback with loud warning on non-local). Per-chain nonce streams serialized by a nonce coordinator seeded from `getTransactionCount(pending)`; nonce advances only on successful broadcast; `reset(chainId)` re-seeds after stuck-tx recovery.
- Railgun 0zk wallet from `RELAYER_RAILGUN_MNEMONIC` (12/24 words; boot-fails if absent); LevelDB engine state on a persistent volume; optional `BROADCASTER_RAILGUN_ADDRESS` assertion; mnemonic never logged; derived walletId/0zk address are the only loggable identifiers.

### 6.6 Health classification

Per-chain: `unhealthy` if never scanned or `now − lastScanAt > 10 × pollInterval`; `stale` if `> 3 × pollInterval`; `degraded` if last tick errored or `lagBlocks > 100`; else `healthy`. Rollup worst-wins; `/health` returns HTTP 503 only when rollup is `stale` or `unhealthy`. In v2 the actor's `/health` derives chain scan freshness from the **watcher's** indexing progress (read from Postgres) plus its own job-queue stats, preserving the response shape (§9.1).

---

## 7. armada-watcher Specification

### 7.1 Framework & version

Ponder, pinned to the latest stable release at implementation time. The implementing agent MUST record the pinned version and verify the following against its documentation (APIs move between versions): custom API routes (Hono), direct-SQL/published-views mechanism, per-chain `pollingInterval`, finality/confirmation configuration, and the built-in Prometheus `/metrics` endpoint.

### 7.2 Chains, contracts, ABIs

- Chain set and RPC URLs resolve from `NETWORK=local|sepolia|mainnet` + env (same URL semantics as `config/networks.ts`). Contract addresses and `startBlock` (= manifest `deployBlock`) MUST be read from `deployments/` manifests at config-build time — never hardcoded.

  | NETWORK | Hub | Clients | Iris |
  |---|---|---|---|
  | `local` | Anvil 31337 (domain 100) | 31338 (101), 31339 (102) | mock mode |
  | `sepolia` | Ethereum Sepolia 11155111 (domain 0) | Base Sepolia 84532 (6), Arbitrum Sepolia 421614 (3) | `https://iris-api-sandbox.circle.com` |
  | `mainnet` | Ethereum 1 (domain 0) | Base 8453 (6), Arbitrum One 42161 (3) | `https://iris-api.circle.com` |

  Mainnet is a **configuration posture, not a deployment**: config MUST build and validate for `NETWORK=mainnet` (manifest schema, domain pairing, Iris prod URL) even before mainnet manifests exist; missing manifests fail loudly at boot, not silently. The mainnet client-chain pairing above mirrors the Sepolia pairing and MUST be re-confirmed against the Launch-2 deployment plan before mainnet manifests are authored.
- ABIs are generated from Hardhat artifacts by a script (`npm run watcher:abis`) that fails if artifacts are missing or drift from the checked-in copies. Manual ABI editing is prohibited.
- Indexed contracts/events: exactly the §5.1 catalogue.
- Per-chain `pollingInterval`: local 1,000 ms; Sepolia hub 12,000 ms; Base/Arb Sepolia 5,000 ms (defaults; env-overridable). Realtime indexing MUST respect a confirmation depth consistent with v1 (L1: 6, L2: 2, local: 0) — via Ponder's finality handling; if the pinned version indexes to head with reorg reconciliation, that satisfies this requirement and the actor's work discovery applies its own confirmation gate instead (§8.3).

### 7.3 Read API (public; served by the watcher's HTTP server)

All endpoints are P1-compliant global streams or public-data lookups. JSON, CORS `*`, no auth, no cookies. Cursor pagination: `limit` default 1,000 / max 1,000 rows; responses include `nextCursor` (block-based) and `indexedThrough` (highest fully indexed block for the queried chain).

| Endpoint | Query params | Response |
|---|---|---|
| `GET /v1/commitments` | `fromBlock` (req), `toBlock`, `limit` | `{ items: RawCommitment[], nextCursor, indexedThrough }` — `RawCommitment = { blockNumber, txHash, logIndex, data, topics }` (matches `apps/armada-interface/src/lib/events/EventSource.ts`) |
| `GET /v1/nullifiers` | same | `{ items: RawNullifier[], ... }` — `{ blockNumber, txHash, logIndex, hash }` |
| `GET /v1/logs` | `chainId` (req), `address` (req), `fromBlock` (req), `toBlock`, `limit` | `{ items: RawTxLog[], ... }`. `address` MUST be validated against the allowlist of indexed protocol contracts for that chain; any other address → 400. (This is a contract-address filter, never a user filter — P1.) |
| `GET /v1/quick-sync/:chainId` | `startingBlock` (req) | **Fast-follow — NOT in initial v2 delivery** (ruling, §17.2): implemented only once the frontend engine-port gate (plan Phase 4) is decided. Contract when built: `AccumulatedEvents` — `{ commitmentEvents, unshieldEvents, nullifierEvents }` in the exact TypeScript shapes of the pinned `@railgun-community/engine` version, decoded server-side from stored raw logs (§5.1 `rawData` preserves this option). A compile-time type test MUST pin these shapes against the engine package so an SDK bump fails the build. Note: this requires engine *types* only (dev dependency) — S6's runtime-SDK exclusion for the watcher still holds. |
| `GET /health` | — | `{ status, chains: [{ chainId, lastIndexedBlock, head, lagBlocks, lastEventAt }], generatedAt }`; 200/503 semantics mirror §6.6 |
| `GET /metrics` | — | Prometheus text format (Ponder built-in + any custom API metrics) |

Historical closed-range responses (where `toBlock ≤ indexedThrough − confirmationDepth`) MUST set `Cache-Control: public, max-age=86400, immutable`; open-ended/near-head responses `max-age=5`. This makes CDN fronting a config change, not a code change.

### 7.4 What the watcher must never do

No key material (D2). No tx submission. No per-user query shapes (P1). No request-identifying logs (P4). No reads/writes of the `actor` schema.

---

## 8. armada-actor Specification

### 8.1 Runtime

Node 20+, TypeScript, Express v5, ethers v6, `prom-client`, `pg`. Single instance (the job claim logic uses `FOR UPDATE SKIP LOCKED` so an accidental second instance is safe, but multi-instance operation is out of scope).

### 8.2 Module inventory (ports from v1 — reuse logic and tests, adapt storage to Postgres)

| v2 module | Ported from v1 | Change |
|---|---|---|
| `relay/fee-calculator` | `modules/fee-calculator.ts` | none (constants §6.1) |
| `relay/privacy-relay` | `modules/privacy-relay.ts` | none (pipeline §6.2) |
| `relay/broadcaster-fee-verifier` | `modules/broadcaster-fee-verifier.ts` | none |
| `relay/gasless-fee-verifier` | `modules/gasless-fee-verifier.ts` | none |
| `wallet/wallet-manager`, `wallet/nonce-coordinator` | `modules/wallet-manager.ts`, `lib/nonce-coordinator.ts` | none |
| `wallet/railgun-wallet` | `modules/railgun-wallet.ts` | LevelDB path → mounted volume |
| `jobs/state-machine` | `modules/iris-relay.ts` + `cctp-relay.ts` | **rewritten DB-driven** (§8.4); constants §6.4 preserved; per-tick logic ported with its tests |
| `jobs/classify` | `classifyMessageForRelay` | port verbatim as a pure function + its test vectors |
| `http/*` | `modules/http-api.ts` | endpoints §9.1 |
| `db/idempotency` | `modules/idempotency-store.ts` | JSON file → `actor.idempotency` |
| (deleted) | `lib/cursor-store`, `get-logs-chunked` (steady-state), `rpc-bisecting`, `pending-state-store`, `json-state-store`, `dead-letter-store`, `retry-queue-store`, `cctp-delivery-store` | replaced by watcher + `actor.cctp_jobs` (a bounded copy of the chunked/bisecting scan logic survives inside the fallback scanner, §8.7) |

### 8.3 Work discovery

Every `workPollIntervalMs` (default 2,000 ms local / 5,000 ms sepolia), the actor runs one local SQL query per destination-domain group:

```sql
SELECT s.* FROM indexed.cctp_message_sent s
LEFT JOIN actor.cctp_jobs j ON j.dedup_key = s.id
WHERE j.dedup_key IS NULL
  AND s.block_number <= $indexedThrough_minus_confirmation_depth
ORDER BY s.block_number
LIMIT 100
FOR UPDATE OF j SKIP LOCKED;  -- claim by inserting job rows in the same transaction
```

For each row: run `classify` (§8.5); if `relay: false`, insert a job directly in state `skipped` with the reason (so re-discovery doesn't loop); else insert in state `detected`. **Additional dedup gate:** if a matching `indexed.cctp_message_received` row already exists for the message (matched via the actor's own prior job, or — for foreign/manual deliveries — via destination-side lookahead), insert as `already_delivered`. The destination contract's replay protection remains the final safety net (D4).

Work discovery performs **zero RPC calls**.

### 8.4 Job state machine

States: `detected → awaiting_attestation → attested → submitted → delivered`, with terminal side-states `dead_letter`, `skipped`, `already_delivered`.

| Transition | Trigger | Notes |
|---|---|---|
| `detected → awaiting_attestation` | Iris mode: immediately. Mock mode: skipped (see below). | |
| `awaiting_attestation → attested` | Iris returns `complete` attestation for `message_hash` | poll respecting `MAX_ATTESTATION_AGE_MS`, concurrency 8 |
| `attested → submitted` | `relayWithHook` broadcast succeeds | sets `submitted_tx_hash`, `submitted_at`; on broadcast failure: `retry_attempts++`, `next_retry_at = now + 2000×2^retry_attempts`; > `MAX_RELAY_RETRIES` → `dead_letter` |
| `submitted → delivered` | destination receipt observed | receipt via the actor's own `getTransactionReceipt` polling of `submitted_tx_hash` (its own tx — allowed RPC), corroborated by `indexed.cctp_message_received` when it lands. Records `delivered_tx_hash`, `delivered_block`, `delivered_at`. |
| `submitted → attested` (stuck) | `now − submitted_at > STUCK_TX_THRESHOLD_MS` | clear submitted fields, nonce-coordinator `reset(chainId)`, re-submit |
| `* → dead_letter` | attestation expiry / retries exhausted / permanent classify failure post-claim | `dead_letter_reason` set; counted in health `deadLetterCount` |

**Mock mode (`CCTP_MODE=mock`, local):** `detected → attested` immediately with the mock attestation bytes; the rest of the machine is identical. This preserves v1's local-dev behavior while exercising the same code path.

All transitions are single-row transactional updates; the process crashing mid-tick MUST leave jobs resumable from their persisted state (v1's restart-resume guarantee, now for free via Postgres).

### 8.5 Message classification (fail-closed; preserved from v1)

`classify(messageHex, knownRecipients, hookRouter)` → `{relay: true, mintRecipient}` | `{relay: false, reason}` with exactly the v1 checks: length ≥ 376 bytes; burn body version == 1; `mintRecipient` ∈ known recipient set (bytes32-padded pool addresses from manifests; empty set rejects all); `destinationCaller` zero or == configured HookRouter. Port the v1 unit-test vectors unchanged.

### 8.6 HTTP API — see §9.1.

### 8.7 Fallback scanner (escape hatch; normally idle)

If the watcher's indexing freshness for a chain (from Postgres) exceeds `FALLBACK_ACTIVATE_AFTER_MS` (default 120,000), the actor MAY activate a bounded direct `MessageSent` scan for that chain: cursor from the last indexed block, chunked with the v1 chunker/bisecting logic, feeding work discovery directly. It deactivates as soon as the watcher catches up past the fallback cursor. Activation and deactivation MUST increment metrics and log loudly (`armada_actor_fallback_scanner_active` gauge). This is the only circumstance in which the actor issues `getLogs` (D1 exception).

### 8.8 ETH/USD price source (fee calculator input)

The `ethUsdcPrice` term of the fee formula (§6.1) is sourced as follows:

- **local:** static value from committed env (`ETH_USD_PRICE_STATIC`), matching v1 behavior. No feed exists on Anvil.
- **sepolia / mainnet:** Chainlink ETH/USD aggregator on the **hub chain**, read via `latestRoundData()` once per fee-schedule regeneration (i.e., at most one extra `eth_call` per `feeTtlSeconds` per chain schedule — no measurable RPC-budget impact). Feed address from committed env (`ETH_USD_FEED_ADDRESS`); boot fails loudly if unset on these networks.

Guards (all MUST):

1. **Staleness:** if `updatedAt` is older than `ETH_USD_MAX_STALENESS_MS` (default 5,400,000 ms = 1.5 h; ETH/USD heartbeat is 1 h, +50% buffer), the reading is rejected.
2. **Sanity clamp:** readings outside `[ETH_USD_MIN, ETH_USD_MAX]` (committed env; set generously wide, e.g. 100–100,000) are rejected. Protects against feed malfunction producing absurd quotes.
3. **Fallback chain:** rejected/failed reading → hold the last-known-good value and mark price-degraded (health + metric); if no accepted reading has ever occurred this boot, fall back to `ETH_USD_PRICE_STATIC` (which therefore MUST be set on all networks and kept roughly current as the emergency floor). Quotes are never refused due to price-source failure; degradation is signaled, not user-facing.
4. **Decimals:** the aggregator's `decimals()` is read once at boot and used to normalize; no hardcoded 8-decimal assumption.
5. **Observability:** `armada_actor_eth_usd_price` gauge updated on every accepted reading; `armada_actor_eth_usd_price_degraded` gauge (0/1) reflects fallback state; alert per §10.3.

---

## 9. HTTP API Contracts

### 9.1 Actor (`relayerUrl`, default port 3001 — preserves the v1 public surface)

| Endpoint | Method | Behavior |
|---|---|---|
| `/` | GET | service banner + endpoint list |
| `/fees[?chainId=N]` | GET | `FeeSchedule` (§6.1); default chain = hub; 404 for unknown chain |
| `/relay` | POST | `RelayRequest = { chainId, to, data, feesCacheId, idempotencyKey? }` → `{ txHash, status: "pending" }`; pipeline §6.2; errors §6.2/§6.3 |
| `/status/:txHash[?chainId=N]` | GET | `{ status: pending\|confirmed\|failed, blockNumber?, error? }`; fan-out across chains when chainId omitted; backfills idempotency terminal status |
| `/cctp/delivered?destinationDomain=N[&sinceMs=T][&limit=K]` | GET | `{ records: DeliveredRecord[], generatedAt }` where `DeliveredRecord = { dedupKey, sourceDomain, destinationDomain, nonce, sourceTxHash, destinationTxHash, destinationBlock, deliveredAt }`, from `actor.cctp_jobs` rows in state `delivered` with `delivered_at > sinceMs`, ordered ascending, `limit` default/max 200. **Replaces v1's `GET /cctp-status/:messageHash`**, which MUST NOT exist in v2 (P2: per-message lookups link a poller to a specific tx; the cursor feed is uniform for all watchers of a corridor). |
| `/health` | GET | v1 `RelayerHealth` shape (§6.6): per-chain scan freshness sourced from watcher progress in Postgres; `pendingCount`/`deadLetterCount` from `actor.cctp_jobs`; `counters` field retained for frontend compatibility, mirroring a subset of Prometheus counters |
| `/metrics` | GET | Prometheus text format (§10.1). SHOULD be bound to the internal network / not exposed through the public reverse proxy. |

Rate limiting per §6.3 applies to all public endpoints. Frontend impact: only the delivery-wait tick changes (poll `/cctp/delivered` and match `sourceTxHash` locally, RPC window-scan as fallback) — everything else is shape-identical to v1.

### 9.2 Watcher (`indexerUrl`, default port 42069) — see §7.3.

The delivered feed intentionally lives on the actor (it owns the authoritative job data and the frontend already has `relayerUrl`); event streams live on the watcher. The frontend MAY additionally match `MessageReceived` from `GET /v1/logs` as a third-tier fallback.

---

## 10. Observability

### 10.1 Prometheus metrics (actor; `prom-client`, default registry + custom)

| Metric | Type | Labels | Maps from v1 |
|---|---|---|---|
| `armada_actor_relay_submissions_total` | counter | `selector`, `outcome` (`success`\|`fail`), `code` (error code or `""`) | `submitSuccess.*`, `submitFail.*` |
| `armada_actor_fee_verifier_rejects_total` | counter | `code` | `feeVerifierRejects.*` |
| `armada_actor_rate_limited_total` | counter | `endpoint` | `rateLimited` |
| `armada_actor_idempotent_replays_total` | counter | — | `idempotentReplay` |
| `armada_actor_cctp_jobs` | gauge | `state`, `destination_domain` | pending/dead-letter counts |
| `armada_actor_cctp_job_transitions_total` | counter | `from`, `to` | — |
| `armada_actor_iris_polls_total` | counter | `result` (`complete`\|`pending`\|`error`) | — |
| `armada_actor_rpc_requests_total` | counter | `chain`, `method` | — (budget guardrail: `method="eth_getLogs"` MUST stay at 0 while the watcher is healthy) |
| `armada_actor_fallback_scanner_active` | gauge | `chain` | — |
| `armada_actor_wallet_balance_wei` | gauge | `chain` | — (refreshed each fee-schedule regeneration; alert < 0.1 ETH) |
| `armada_actor_eth_usd_price` | gauge | — | — (§8.8; last accepted feed reading) |
| `armada_actor_eth_usd_price_degraded` | gauge | — | — (§8.8; 1 while serving last-known-good/static fallback) |
| `armada_actor_http_request_duration_seconds` | histogram | `route`, `method`, `status` | — |

Watcher metrics: Ponder's built-in `/metrics` (indexing progress, RPC usage, lag) suffices; no custom watcher metrics are required beyond it.

### 10.2 Logging

Structured JSON logs (pino or console-JSON; implementer's choice). MUST NOT log: request IPs, mnemonics/keys/viewing keys, full calldata (first 10 bytes are fine, matching v1). The compose reverse-proxy example and the VPS deployment notes MUST disable or anonymize access logs on all read paths (P4).

### 10.3 Health & alerting

`/health` on both services as specified. The `obs` compose profile ships a Prometheus scrape config (both `/metrics`) and a starter Grafana dashboard (job states, chain lag, RPC request rate, relay outcomes, wallet balance, ETH/USD price). Per ruling (§17.2), the `obs` profile runs **locally only** for now — it is not deployed to the VPS; VPS alerting relies on `/health` checks until that changes. Alert rules (Prometheus alerting or external): watcher lag > 10× poll interval; `armada_actor_fallback_scanner_active > 0` for > 10 min; `dead_letter` transitions > 0; wallet balance < 0.1 ETH; actor `eth_getLogs` rate > 0 while watcher healthy; `armada_actor_eth_usd_price_degraded == 1` for > 15 min.

---

## 11. Orchestration (Docker Compose)

### 11.1 Services (`relayer-v2/compose/docker-compose.yml`)

| Service | Image/build | Ports | Depends on | Secrets |
|---|---|---|---|---|
| `postgres` | `postgres:16-alpine` | internal only | — | DB password via env file |
| `watcher` | build `relayer-v2/watcher` | `42069` | postgres (healthy) | **none** (D2) |
| `actor` | build `relayer-v2/actor` | `3001` | postgres (healthy); watcher (started, NOT healthy — the actor must boot and serve `/fees`/`/relay` even if the watcher is down; job discovery simply idles and the fallback scanner may engage) | `relayer-v2/compose/secrets.env` (gitignored): `RELAYER_PRIVATE_KEY`, `RELAYER_RAILGUN_MNEMONIC`, optional `BROADCASTER_RAILGUN_ADDRESS` |
| `prometheus`, `grafana` | `obs` profile only | `9090`, `3000` | — | none |

- Healthchecks: postgres `pg_isready`; watcher/actor HTTP `/health` (interval 10 s, start period 30 s). Restart policy `unless-stopped`.
- Volumes: `pgdata`, `actor-railgun-db` (LevelDB), `grafana-data`.
- Env layering: `NETWORK` selects `local|sepolia|mainnet`; non-secret config via `compose/local.env` / `compose/sepolia.env` / `compose/mainnet.env` (committed); secrets only via `secrets.env` (gitignored). **Every committed env template needs BOTH a `!` negation in `.gitignore` AND an entry in `.githooks/pre-commit` `ALLOWED_ENV_FILES`** (repo convention); `secrets.env` must be covered by the ignore rules before it is ever created.
- Local mode: Anvil chains run on the host (`npm run chains`); containers reach them via `host.docker.internal` (with `extra_hosts: host-gateway` for Linux). Manifests are mounted read-only from `deployments/`.
- Public exposure (per ruling, §17.2): the watcher is exposed as a **path** behind the existing VPS reverse proxy (e.g. `https://<host>/indexer/` → `watcher:42069`) — no new hostname/TLS; the actor keeps its existing exposure. Access logs on both paths disabled/anonymized (P4). The current VPS is assumed adequate for postgres + both services; Postgres memory SHOULD be capped in compose (`shared_buffers` conservative) and disk monitored — resize is a deployment decision, not a spec change.
- RPC provider (per ruling, §17.2): sepolia and mainnet use a **paid RPC key**, shared by watcher and actor via the committed env files' URL variables (key itself in `secrets.env` if embedded in the URL — treat provider URLs with embedded keys as secrets per repo convention). Public endpoints remain acceptable as fallback URLs.

### 11.2 Developer workflow

- Fast iteration MAY run either service directly on the host (`npm run watcher:dev`, `npm run actor:dev`) against a compose-provided Postgres (`docker compose up postgres`).
- `docker compose up` (full stack) is the canonical mode for VPS deployment and for e2e tests. Root `package.json` gains: `relayer-v2`, `relayer-v2:sepolia`, `watcher:dev`, `actor:dev`, `watcher:abis`.

---

## 12. Privacy Requirements (normative; inherited from PLAN_EVENT_INDEXING §2)

- **P1 — Global streams only.** Read endpoints serve full event streams from a cursor (identical for every caller at the same cursor) or lookups of inherently public chain data. No endpoint accepts a wallet address, npk, commitment hash, nullifier, or other shielded-domain identifier. (`/v1/logs`' `address` param is restricted to protocol contract addresses.)
- **P2 — Client-side matching.** Consumers match their own txs/notes locally. This spec removes v1's `GET /cctp-status/:messageHash` in favor of the `/cctp/delivered` cursor feed for exactly this reason.
- **P3 — No identifiers.** No auth/cookies/sessions/per-client tokens on read endpoints; fee quotes remain global.
- **P4 — Log & retention hygiene.** No IP retention anywhere in v2 (app logs, Postgres, reverse proxy). Job rows contain only public chain data. Rate-limiter IP state is in-memory only.
- **P5 — History stays client-side.** No server-side materialization of any per-user history.
- **P6 — Residual leak.** `POST /relay` ties submitter IP to a tx at submission time; unavoidable in this architecture; mitigated by P4; structural fixes are out of scope and documented in SECURITY.md.

---

## 13. Security Requirements

- S1. Keys only in the actor (D2); compose MUST make this structurally true (no secret env on the watcher service).
- S2. All v1 fail-closed behaviors preserved: selector allowlist, target allowlist, fee verification before submission, message classification (§8.5), body-size limit (default 256 KiB), rate limits.
- S3. No testing-mode or SNARK-bypass pathways exist in v2 code (repo standing rule).
- S4. Postgres is not exposed outside the compose network; role separation per §5.
- S5. Pre-commit sensitive-data check applies; new state/volume dirs gitignored before first run.
- S6. Dependencies: watcher excludes the Railgun SDK; actor pins the same SDK versions as v1 (engine 9.5.1 / wallet 10.8.1) unless a deliberate upgrade is specced separately.

---

## 14. Migration & Cutover

Transition states are allowed to violate D1 (both v1 scanner and watcher polling) for a bounded period.

1. **M1 — Watcher ships first.** Deploy postgres + watcher alongside v1. Watcher backfills from manifest `deployBlock`s. v1 continues relaying untouched. Verify: differential test (§15.3) green against Sepolia; watcher `/health` healthy for 48 h.
2. **M2 — Frontend reads move.** Set `VITE_INDEXER_URL`; frontend adopts watcher streams and (already or now) the delivered feed per `.claude/PLAN_EVENT_INDEXING.md` Phases 3–4. No relaying changes.
3. **M3 — Actor cutover.** Stop v1 (graceful; it persists cursors/pending state). Start actor. Bootstrapping rules: actor's work discovery is bounded by watcher data, so no boot-lookback knob is needed; to avoid re-relaying v1's recent deliveries, the cutover script MUST import v1's `relayer/state/pending-*.json` `processed` dedup keys and any in-flight pending messages into `actor.cctp_jobs` (states `delivered` — with null destination fields where unknown — and `attested`/`submitted` respectively). The destination contract's replay protection backstops any import gap (a re-relay attempt reverts; bounded gas waste, no correctness issue).
4. **M4 — Decommission.** After 7 days of clean operation (no dead-letters attributable to v2, no fallback-scanner activations, frontend healthy): archive `relayer/` state files, remove v1 from the VPS process manager, and open a PR moving `relayer/` to `_legacy/` (do not delete; repo convention).

Rollback: M3 is reversible by stopping the actor and restarting v1 (its own state files untouched by v2); the same dedup backstop bounds the cost.

---

## 15. Testing Requirements (unit + integration + e2e for every component; repo no-exceptions policy)

### 15.1 Unit

- Actor: every ported module keeps its v1 test suite (adapted to Postgres via a test container or in-process pg mock); state-machine transition table exhaustively tested including stuck-tx, retry exhaustion, attestation expiry, mock mode; classify test vectors ported verbatim; fee formula golden tests; idempotency semantics; rate limiter; price source (§8.8): accepted reading updates gauge, stale reading rejected → last-known-good, out-of-clamp rejected, no-reading-yet → static fallback, decimals normalization, degraded flag transitions.
- Watcher: decode helpers (raw log → schema rows; raw log → engine `AccumulatedEvents` types) with fixture logs generated from local-chain runs; config derivation from manifests; the engine-type compile-time pin.

### 15.2 Integration (local stack: `npm run chains` + `npm run setup` + compose)

- Drive shield / transact / unshield / xchain-shield / xchain-unshield / gasless flows via existing Hardhat helpers; assert: watcher rows match `eth_getLogs` ground truth (**differential test — the load-bearing check**); actor relays each CCTP message exactly once; `/cctp/delivered` feed contents; `/relay` pipeline parity (each error code reproducible).
- Failure drills: kill watcher mid-flow → actor fallback scanner engages, message still delivered; kill actor mid-flight (state `submitted`) → restart resumes to `delivered`; kill postgres → both services recover on restore.

### 15.3 e2e / parity

- Frontend e2e (local): full xchain unshield through the UI against compose stack; indexer-on vs indexer-off parity.
- v1/v2 parity suite: replay a recorded set of v1 request/response pairs (`/fees`, `/relay` error cases, `/status`, `/health` shape) against v2 and assert shape-compatibility.
- RPC-budget assertion: with the stack healthy under a scripted load, `armada_actor_rpc_requests_total{method="eth_getLogs"}` == 0 and watcher `getLogs` rate ≤ configured poll cadence per chain.

### 15.4 Acceptance criteria (all MUST pass before M3)

- [ ] All §15.1–15.3 suites green in CI and locally.
- [ ] Differential test green against Sepolia backfill (M1).
- [ ] All §6 constants verified preserved (checklist review against v1 source).
- [ ] P1–P6 review: endpoint audit + log audit + proxy config audit.
- [ ] Prometheus metrics present and scraped in the obs profile; alerts fire in a drill.
- [ ] Compose cold-start on a clean machine (local mode) reaches healthy in < 5 min with only documented steps.
- [ ] `NETWORK=mainnet` config posture validated: config builds, domain/chain pairing asserted, missing-manifest boot failure is loud and specific; a config-level unit test covers all three networks.
- [ ] Frontend compatibility invariants (§18.3) verified: v1-parity endpoints unchanged, `VITE_INDEXER_URL` unset leaves the app fully functional.
- [ ] README covers: run modes, env reference, migration runbook, rollback.

---

## 16. Deviations from v1 (deliberate; the only allowed ones)

1. `GET /cctp-status/:messageHash` removed → replaced by `/cctp/delivered` cursor feed (P2).
2. Idempotency store: JSON file → Postgres table (same semantics, durable).
3. Counters: in-process reset-on-restart map → Prometheus (a `/health.counters` compatibility subset remains).
4. Cursor/pending/dead-letter/retry-queue/delivery JSON stores → Postgres job table + watcher indexing.
5. Health "scan freshness" is derived from watcher indexing progress rather than an in-process scanner.
6. `ethUsdcPrice` fee-formula input: static config value → Chainlink ETH/USD feed on sepolia/mainnet with staleness/clamp/fallback guards (§8.8); local mode unchanged (static). The static value survives on all networks as the emergency fallback.

Any further deviation discovered during implementation MUST be added here and flagged to a human before merging.

---

## 17. Open Questions

### 17.1 Implementer decisions (delegated — record choices in `relayer-v2/README.md`)

1. Ponder pinned version + the concrete direct-SQL mechanism (verify against docs; record in README).
2. Migration tool for the actor schema (node-pg-migrate vs drizzle-kit).
3. Logger choice (pino vs structured console).
4. Whether Ponder's own finality handling or the actor-side confirmation gate (§7.2/§8.3) carries the reorg burden for work discovery — pick one, document, and cover with the kill-drill tests.
5. Grafana dashboard scope (starter JSON committed vs provisioned-by-hand).

### 17.2 Resolved human rulings (decision log — 2026-07-09; none pending)

1. **v1 stopgap:** none. No new backend work on v1. The frontend builds the two-tier delivery tick (F2) against the v2 `/cctp/delivered` contract only; it degrades gracefully (404 → RPC scan) until the actor exists.
2. **Quick-sync endpoint:** fast-follow, not initial v2 scope (§7.3). Built when the frontend engine-port gate (plan Phase 4) is decided.
3. **VPS & exposure:** current VPS assumed adequate (monitor; resize is operational). Watcher exposed as a path behind the existing reverse proxy; `obs` profile local-only (§10.3, §11.1).
4. **RPC provider:** one paid key for sepolia/mainnet, shared by watcher and actor (§11.1); public endpoints as fallbacks.
5. **Directory naming:** `relayer-v2/` accepted as the permanent name (version markers have repo precedent, e.g. `TX_SIGNING_V2_AMENDMENT.md`, `hub-v3.json`); M4 unchanged — v1 moves to `_legacy/`, no rename of v2.
6. **Mainnet fee pricing:** option B — Chainlink ETH/USD feed with guards, specified in §8.8; deviation recorded in §16.6.
7. **Mainnet:** in v2 scope as a configuration posture (§7.2, §11, §15.4).

---

## 18. Frontend Integration (armada-interface) & Cross-Workstream Blockers

This section specifies the frontend work required in tandem with relayer v2, and the dependency edges in both directions. Frontend file references are to `apps/armada-interface/src/`. The detailed frontend phasing in `.claude/PLAN_EVENT_INDEXING.md` (Phases 3–4) remains valid; this section is the authoritative dependency map between that work and v2's milestones (M1–M4, §14).

### 18.1 Required frontend changes

| # | Change | Where | Depends on | Notes |
|---|---|---|---|---|
| F1 | `RpcEventSource` implementation (fallback tier; currently a stub returning `[]`) | `lib/events/RpcEventSource.ts` via `getLogsChunked` | **nothing** | Can ship any time; required regardless of v2. |
| F2 | Two-tier delivery-wait tick: poll `GET /cctp/delivered` (§9.1), match own `sourceTxHash` locally; fall back to the existing `scanCctpDeliveryWindow` RPC tick on 404/network error/relayer-unhealthy. Persist both the feed cursor (`sinceMs`) and the scan cursor in `record.artifacts`. | `features/unshield-xchain/handler.ts`, shield-xchain equivalent, `lib/relayer.ts`, `config/relayer.ts` | v2 actor (M3) for live data; **shippable before M3** — v1 does not serve the endpoint, the 404 path degrades to today's behavior | Per ruling §17.2.1: no v1 backend work; this is the only delivery-status integration path. |
| F3 | `IndexerEventSource` against watcher §7.3 shapes + `FallbackEventSource` decorator (indexer-first, per-call RPC fallback) composed in the `lib/events/index.ts` factory | `lib/events/IndexerEventSource.ts` (stub exists) | watcher deployed + `VITE_INDEXER_URL` set (M2) | Strict response validation; cursor pagination honoring `FetchRange` + `AbortSignal`. |
| F4 | Indexer health poll (60 s, react-query, visibility-gated) + degradation surface in the status-banner pattern | new hook alongside `hooks/useRelayerHealth.ts` | watcher (M1/M2) | Polling-matrix row already reserved in `PLAN_ARMADA_INTERFACE.md`. |
| F5 | Quick-sync adoption: engine-level `initForWallet` port, `quickSyncEvents` → `GET /v1/quick-sync`, on-chain `MerklerootValidator`, nullifier cross-check | `lib/railgun/init.ts` and related | watcher quick-sync endpoint (fast-follow per ruling §17.2.2) **and** the plan's Phase-4 engine-port gate (still open — the one remaining decision, owned by the frontend workstream) | MUST NOT ship without root validation + nullifier cross-check (plan §7 items 3–4). |
| F6 | Mainnet network config: `NetworkMode` gains `'mainnet'`; chain identities per §7.2 table; `VITE_NETWORK=mainnet` | `config/network.ts`, `config/wagmi.ts`, `config/deployments.ts` | mainnet manifests | Mirrors the existing `local|sepolia` pattern; per `config/CLAUDE.md`, all env reads stay in `config/`. |

### 18.2 Blockers: frontend ← v2 (frontend work blocked by v2)

- F2 live operation (not merge) blocks on **M3**; F3/F4 block on **M1–M2** (watcher deployed at its path-based URL, §11.1); F5 blocks on the quick-sync endpoint (fast-follow, §17.2.2) and the engine-port gate. Nothing else in the frontend is blocked by v2.

### 18.3 Blockers: v2 ← frontend (v2 work blocked by, or constrained by, the frontend)

- **B1 — `/cctp-status` removal precondition (blocks M3):** v2 deletes v1's `GET /cctp-status/:messageHash` (§16.1). Before M3, verify the frontend never adopted it. As of this writing, `lib/relayer.ts` consumes only `/fees`, `/relay`, `/status/:txHash`, `/health` — and MUST NOT adopt `/cctp-status` in the interim (it is P2-non-compliant and dies at M3). F2 is the sanctioned replacement.
- **B2 — v1-parity contract (permanent constraint):** `/fees` (`FeeSchedule` incl. `cacheId`/`broadcasterRailgunAddress`), `/relay` (request shape, error codes, HTTP statuses incl. 402/409/429), `/status/:txHash`, and `/health` (shape consumed by `useRelayerHealth`, including the `counters` field) MUST remain byte-shape-compatible through M3 so the actor is a drop-in behind the same `relayerUrl`. The §15.3 parity suite enforces this; any frontend change to these consumers during the transition must keep both v1 and v2 acceptable.
- **B3 — quick-sync type coupling:** the watcher's `AccumulatedEvents` decode is pinned to the engine version the *frontend* ships (9.5.1). A frontend Railgun SDK upgrade during v2 development requires re-pinning the watcher's type test (§7.3) in the same change window — coordinate the two repos' PRs.
- **B4 — none of F1–F4 may become a hard dependency:** the app MUST remain fully functional with `VITE_INDEXER_URL` unset and the relayer unreachable-for-reads (D4 posture; acceptance criterion in §15.4).

### 18.4 Rollout coupling (what the frontend does at each v2 milestone)

| v2 milestone | Frontend action |
|---|---|
| M1 (watcher live, backfilled) | none required; F3/F4 may begin integration against the deployed watcher |
| M2 (reads move) | set `VITE_INDEXER_URL` (Netlify env for hosted builds); ship F3/F4 |
| M3 (actor cutover) | none required — `relayerUrl` unchanged; F2's feed tier starts returning 200 and activates naturally |
| M4 (v1 retired) | none; confirm no lingering references to v1-only behavior |

