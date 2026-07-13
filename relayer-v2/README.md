# Armada Relayer v2 — Watcher/Actor

Implementation of `specs/RELAYER_V2.md`: a Ponder-based chain **watcher** (indexer + public
read API, no secrets) and a transaction **actor** (`/relay`, `/fees`, CCTP job state machine,
holds all keys), sharing Postgres, orchestrated with Docker Compose, observable via Prometheus.

```
watcher (Ponder, :42069)  ──writes──►  Postgres 16  ◄──reads/writes──  actor (Express, :3001)
        │ indexes events, serves /v1/* read API          │ /relay /fees /status /cctp/delivered /health
        └── the ONLY process issuing eth_getLogs (D1)    └── keys: EOA + Railgun 0zk (D2)
```

## Implementer decisions (spec §17.1 — recorded here as required)

1. **Ponder version:** pinned `0.16.8`. Direct-SQL mechanism verified against the installed
   package source (not just docs): `ponder start --schema watcher --views-schema indexed`
   publishes all indexed tables as views in the `indexed` schema, plus `_ponder_meta` and
   `_ponder_checkpoint` (per-chain progress; fixed-width checkpoint strings decoded by
   `actor/src/db/indexed-reader.ts#decodePonderCheckpoint`). The actor reads ONLY the
   `indexed` views (never Ponder's internal `watcher` schema).
2. **Migration tool:** `node-pg-migrate` (v7), run programmatically at actor boot from
   `actor/migrations/*.sql` (tracked in `actor.schema_migrations`).
3. **Logger:** pino (structured JSON; IP/key/calldata redaction per §10.2/P4).
4. **Reorg burden:** carried by the **actor-side confirmation gate** (§8.3): work discovery
   only claims messages at `block_number <= lastIndexedBlock(chain) − confirmations`
   (L1: 6, L2: 2, local: 0). Ponder additionally reconciles reorgs internally; the gate is
   the normative guard for relaying.
5. **Grafana:** starter dashboard JSON committed (`compose/grafana/dashboards/`), provisioned
   automatically in the `obs` profile.

## Run modes

### Local (full stack)

```bash
# Prereqs: Anvil chains on the host (monorepo `npm run chains` + `npm run setup`);
# point DEPLOYMENTS_DIR at the monorepo's deployments/ (local manifests are generated
# there by `npm run setup` as privacy-pool-{hub,client,clientB}.json).
npm run relayer-v2          # docker compose up --build (postgres + watcher + actor)
# with observability (local-only per ruling §17.2.3):
docker compose -f relayer-v2/compose/docker-compose.yml -f relayer-v2/compose/docker-compose.obs.yml \
  --env-file relayer-v2/compose/local.env --profile obs up --build
```

### Fast iteration (services on host, Postgres in compose)

```bash
docker compose -f relayer-v2/compose/docker-compose.yml --env-file relayer-v2/compose/local.env up postgres -d
npm run watcher:dev         # ponder dev
npm run actor:dev           # tsx watch (needs DATABASE_URL + RELAYER_RAILGUN_MNEMONIC env)
```

### Sepolia / mainnet

Deploys **pull prebuilt images** from GHCR (published by CI on merge to main) instead of
building on the box:

```bash
git submodule update --init deployments/registry   # central deployment registry (§7.2)
cp relayer-v2/compose/secrets.env.example relayer-v2/compose/secrets.env  # fill in
# GHCR images are private by default — either make the packages public, or log in first:
#   echo <PAT-with-read:packages> | docker login ghcr.io -u <user> --password-stdin
npm run relayer-v2:sepolia   # docker compose pull && up -d; sepolia.env sets DEPLOYMENT_INSTANCE=demo1
# Pin a specific build instead of :latest — IMAGE_TAG=<git-sha> npm run relayer-v2:sepolia
# mainnet is a CONFIGURATION POSTURE (§7.2): config builds/validates, but boot fails loudly
# until a mainnet instance is published in the registry and named via DEPLOYMENT_INSTANCE.
```

Images: `ghcr.io/ship-armada/armada-{actor,watcher}:{latest|<git-sha>}`. Local mode
(`npm run relayer-v2`) still builds the working tree with `up --build` and tags it as the same
image name — no pull needed for dev.

Testnet/mainnet manifests come from the **central registry**
([ship-armada/armada-deployments](https://github.com/ship-armada/armada-deployments), a pinned
submodule at `deployments/registry`) — pick the instance with `DEPLOYMENT_INSTANCE`. Local/e2e
uses flat files from the monorepo instead (no registry). See `deployments/README.md`.

## Env reference

| Variable | Where | Default | Notes |
|---|---|---|---|
| `NETWORK` (alias `DEPLOY_ENV`) | both | `local` | `local\|sepolia\|mainnet` (§7.2) |
| `CCTP_MODE` | actor | `mock` local, `real` else | v1 semantics; mainnet+mock forbidden |
| `DATABASE_URL` | both | — | per-role URLs in compose (`watcher_rw` / `actor_rw`, §5) |
| `HUB_RPC` / `CLIENT_A_RPC` / `CLIENT_B_RPC` | both | local defaults only | v1 names; for sepolia/mainnet set ONLY in `secrets.env` (§11.1) as comma-separated lists — watcher pools all URLs, actor uses the first |
| `IRIS_API_URL` | actor | per network (§7.2) | override the Iris base URL |
| `DEPLOYMENTS_DIR` | both | `../../deployments` | manifest root; registry defaults to `<dir>/registry` (§7.2) |
| `DEPLOYMENT_INSTANCE` | both | — (flat files) | registry instance, e.g. `demo1`; unset ⇒ flat local manifests |
| `DEPLOYMENT_ENVIRONMENT` | both | per network | registry env dir (`testnet`/`mainnet`); derived from `NETWORK` |
| `DEPLOYMENT_REGISTRY_DIR` | both | `<DEPLOYMENTS_DIR>/registry` | override the registry root explicitly |
| `RELAYER_PRIVATE_KEY` | actor | — | falls back to deployer key with a loud warning (§6.5) |
| `RELAYER_RAILGUN_MNEMONIC` | actor | — | 12/24 words; boot-fails if absent (§6.5) |
| `BROADCASTER_RAILGUN_ADDRESS` | actor | — | optional 0zk assertion (§6.5) |
| `RAILGUN_DB_PATH` | actor | `./state/railgun-db` | LevelDB on the `actor-railgun-db` volume |
| `FEE_TTL_SECONDS` | actor | 300 | §6.1 |
| `FEE_VARIANCE_BUFFER_BPS` | actor | 2000 | §6.1 |
| `FEE_PROFIT_MARGIN_BPS` | actor | 0 | v1 hardcodes 0; bump for production |
| `ETH_USD_PRICE_STATIC` (alias `ETH_USDC_PRICE`) | actor | — (required) | emergency price floor, all networks (§8.8) |
| `ETH_USD_FEED_ADDRESS` | actor | — | required on sepolia/mainnet (§8.8) |
| `ETH_USD_MAX_STALENESS_MS` | actor | 5400000 | §8.8.1 |
| `ETH_USD_MIN` / `ETH_USD_MAX` | actor | 100 / 100000 | §8.8.2 |
| `WORK_POLL_INTERVAL_MS` | actor | 2000 local / 5000 else | §8.3 |
| `RELAYER_STUCK_TX_THRESHOLD_MS` | actor | 600000 (min 60000) | §6.4 (v1 name; `STUCK_TX_THRESHOLD_MS` alias) |
| `RELAYER_ATTESTATION_AGE_MS` | actor | 3600000 (min 60000) | §6.4 (v1 name; `MAX_ATTESTATION_AGE_MS` alias) |
| `FALLBACK_ACTIVATE_AFTER_MS` | actor | 120000 | §8.7 |
| `RELAYER_RATE_LIMIT_RELAY_PER_MIN` / `RELAYER_RATE_LIMIT_GET_PER_MIN` | actor | 10 / 60 | §6.3 (v1 names) |
| `RELAYER_PORT` / `RELAYER_MAX_BODY_BYTES` | actor | 3001 / 262144 | v1 names |
| `RELAYER_TRUST_PROXY` | actor | false | honor X-Forwarded-For only when true (§6.3) |
| `INDEXED_SCHEMA` | actor | `indexed` | watcher's published views schema |
| `DATABASE_SCHEMA` / `VIEWS_SCHEMA` | watcher | `watcher` / `indexed` | Ponder schemas (§5) |
| `POLLING_INTERVAL_<chainId>` | watcher | §7.2 table | override poll cadence |

Repo conventions: every committed env template is listed in `.gitignore` (`!` negations)
AND `.githooks/pre-commit` `ALLOWED_ENV_FILES`; enable hooks with
`git config core.hooksPath .githooks`.

## HTTP surfaces

- **Actor (`relayerUrl`, :3001)** — §9.1: `/`, `/fees[?chainId]`, `POST /relay`,
  `/status/:txHash[?chainId]`, `/cctp/delivered?destinationDomain=N[&sinceMs][&limit]`,
  `/health`, `/metrics` (bind internally; not through the public proxy).
  v1's `GET /cctp-status/:messageHash` intentionally does not exist (P2, §16.1).
- **Watcher (`indexerUrl`, :42069)** — §7.3: `/v1/commitments`, `/v1/nullifiers`, `/v1/logs`,
  `/v1/quick-sync/:chainId?startingBlock=N` (hub only; engine `AccumulatedEvents` decoded from
  raw logs, block-window paginated via `servedThroughBlock`/`indexedThrough` — cap
  `QUICK_SYNC_MAX_BLOCK_WINDOW`, default 100k), `/v1/health` (rich §6.6 payload — Ponder's
  built-in `/health` bare-200 shadows the root path; see DEV-8), `/ready`, `/status`,
  `/metrics` (Ponder built-ins). Quick-sync has no consumer until the frontend F5 gate (§18).

## Migration runbook (§14)

1. **M1 — watcher first.** Deploy postgres + watcher alongside v1 (v1 untouched). Watcher
   backfills from manifest `deployBlock`s. Gate: differential test green against Sepolia;
   watcher healthy 48 h.
2. **M2 — frontend reads move.** Set `VITE_INDEXER_URL` (watcher path behind the existing
   reverse proxy, e.g. `https://<host>/indexer/`). Access logs on read paths disabled (P4).
3. **M3 — actor cutover.**
   ```bash
   # stop v1 gracefully (it persists cursors/pending state), then:
   DATABASE_URL=postgres://actor_rw:...@host/armada \
     npx tsx relayer-v2/actor/scripts/import-v1-state.ts /path/to/relayer/state
   docker compose ... up actor -d
   ```
   The import loads v1 `processed` dedup keys as `delivered` and in-flight messages as
   `attested`/`submitted` (verify file shapes first — DEF-4). Replay protection on the
   destination contracts backstops any gap.
4. **M4 — decommission** after 7 clean days: archive v1 state, remove v1 from the process
   manager, PR moving `relayer/` → `_legacy/`.

**Rollback:** stop the actor, restart v1 (its state files are untouched by v2). The
destination-chain replay protection bounds double-relay cost in either direction.

## Testing

```bash
npm test                          # actor (117) + watcher (13) unit suites
# Postgres-backed integration slice:
docker run -d --rm --name pg -e POSTGRES_PASSWORD=test -e POSTGRES_DB=t -p 55432:5432 postgres:16-alpine
ACTOR_TEST_PG_URL=postgres://postgres:test@127.0.0.1:55432/t npm --prefix relayer-v2/actor test
```

Chain-driven integration/e2e suites (§15.2/§15.3 differential test, failure drills, v1/v2
parity replay, frontend e2e) require the monorepo's local stack and v1 recordings — see
`.context/deviations.md` DEF-3.
