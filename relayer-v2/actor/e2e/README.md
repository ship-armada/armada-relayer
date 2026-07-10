# e2e drivers (§15.2)

Chain-driven checks that run against the monorepo's local stack. Prereqs (in the monorepo
clone, `.context/armada-poc`): `npm run chains`, then `npm run setup` (writes local
manifests to its `deployments/`).

```bash
# role-initialized postgres (see compose/initdb), host-mapped:
docker run -d --rm --name armada-e2e-pg -p 15432:5432 \
  -e POSTGRES_PASSWORD=pgroot -e POSTGRES_DB=armada \
  -e WATCHER_DB_PASSWORD=wpw -e ACTOR_DB_PASSWORD=apw \
  -v $PWD/relayer-v2/compose/initdb:/docker-entrypoint-initdb.d:ro postgres:16-alpine

# watcher (host mode):
cd relayer-v2/watcher && \
  DATABASE_URL=postgres://watcher_rw:wpw@127.0.0.1:15432/armada \
  DEPLOYMENTS_DIR=<clone>/deployments NETWORK=local npm run start

# actor (host mode):
cd relayer-v2/actor && \
  DATABASE_URL=postgres://actor_rw:apw@127.0.0.1:15432/armada \
  DEPLOYMENTS_DIR=<clone>/deployments NETWORK=local \
  ETH_USD_PRICE_STATIC=3000 RAILGUN_DB_PATH=/tmp/armada-actor-railgun \
  RELAYER_RAILGUN_MNEMONIC="test test test test test test test test test test test junk" \
  npm run start

# drive a cross-chain shield and wait for delivery:
DEPLOYMENTS_DIR=<clone>/deployments node e2e/drive-xchain-shield.mjs

# the load-bearing differential test (watcher rows == eth_getLogs truth):
DEPLOYMENTS_DIR=<clone>/deployments \
  DATABASE_URL=postgres://actor_rw:apw@127.0.0.1:15432/armada node e2e/differential-check.mjs
```

Failure drills: kill the watcher mid-flow (fallback scanner must engage within
`FALLBACK_ACTIVATE_AFTER_MS` and the message must still deliver); kill the actor while a
job is `submitted` (restart must resume it to `delivered`).
