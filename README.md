# armada-relayer

Privacy/CCTP transaction relayer for the Armada protocol.

**relayer v2** (`relayer-v2/`) is the current implementation: two services sharing Postgres,
run with Docker Compose.

```
watcher (Ponder, :42069)  ──writes──►  Postgres 16  ◄──reads/writes──  actor (Express, :3001)
   indexes chain events, serves the /v1/* read API      /relay /fees /status /cctp/delivered;
   (the only process issuing eth_getLogs)                runs the CCTP job machine; holds keys
```

- **Spec:** [`specs/RELAYER_V2.md`](specs/RELAYER_V2.md)
- **Full docs** (architecture, every env var, run modes): [`relayer-v2/README.md`](relayer-v2/README.md)
- **Contract addresses** come from the central registry submodule
  ([armada-deployments](https://github.com/ship-armada/armada-deployments)) at `deployments/registry`.

## Deploy (Sepolia)

Requires Docker + Docker Compose. Images are prebuilt by CI and published to GHCR — nothing
compiles on the host.

```bash
# Clone with the deployments submodule (required — the watcher won't boot without it)
git clone --recurse-submodules https://github.com/ship-armada/armada-relayer.git
cd armada-relayer

# Provide secrets (see the table below)
cp relayer-v2/compose/secrets.env.example relayer-v2/compose/secrets.env
# edit relayer-v2/compose/secrets.env

# Pull images and start
COMPOSE="docker compose -f relayer-v2/compose/docker-compose.yml \
  --env-file relayer-v2/compose/sepolia.env --env-file relayer-v2/compose/secrets.env"
$COMPOSE pull && $COMPOSE up -d

# Verify (the watcher reports 'stale' until it finishes backfilling — expected)
$COMPOSE ps
curl -s localhost:3001/health  | jq .status   # actor
curl -s localhost:42069/health | jq .status   # watcher
```

Expose the actor (`:3001`) and watcher (`:42069`) through a reverse proxy; keep Postgres
internal. When running behind a proxy, add `RELAYER_TRUST_PROXY=true` to `sepolia.env` so the
actor's per-IP rate limiter reads the real client IP from `X-Forwarded-For` instead of the
proxy's address. Pin a specific build with `IMAGE_TAG=<git-sha>`.

**Minimum `secrets.env`:**

| Variable | Description |
|---|---|
| `RELAYER_PRIVATE_KEY` | EOA that submits transactions and pays gas. |
| `RELAYER_RAILGUN_MNEMONIC` | 12/24-word mnemonic for the 0zk fee wallet (boot-fails if absent). |
| `POSTGRES_PASSWORD`, `WATCHER_DB_PASSWORD`, `ACTOR_DB_PASSWORD` | Database passwords (set before first boot — roles are created once). |
| `HUB_RPC`, `CLIENT_A_RPC`, `CLIENT_B_RPC` | *(optional)* paid RPC URLs; the public fallbacks in `sepolia.env` work but rate-limit. |

Everything else has defaults in `sepolia.env`. Full reference:
[`relayer-v2/README.md`](relayer-v2/README.md#env-reference).

## Local development

Requires local Anvil chains from the [monorepo](https://github.com/ship-armada/armada-poc)
(`npm run chains` + `npm run setup`) for contract deployments. Then:

```bash
npm run relayer-v2   # docker compose up --build; mock CCTP + flat monorepo manifests
```

See [`relayer-v2/README.md`](relayer-v2/README.md#run-modes) for host-mode iteration,
observability, and e2e drivers.

## Development

```bash
npm --prefix relayer-v2/actor test
npm --prefix relayer-v2/watcher test
```

CI runs tests on every PR and publishes images on merge to `main`. Contribute via feature
branches and PRs; install with `npm install --legacy-peer-deps`.
