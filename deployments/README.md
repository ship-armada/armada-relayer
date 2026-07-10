# deployments/

Deployment manifests — the single source of truth for contract addresses and `deployBlock`
(spec §7.2). **v2 consumes the central registry, not files committed here.**

## `registry/` — git submodule → [ship-armada/armada-deployments](https://github.com/ship-armada/armada-deployments)

Pinned to a commit; bump = update the submodule pointer in a reviewable commit.

```bash
git submodule update --init deployments/registry   # after clone / in CI / before docker build
```

Testnet/mainnet manifests resolve from `registry/<environment>/<instance>/<chain>/privacy-pool.json`
(+ `yield.json` on the hub). Select the instance with `DEPLOYMENT_INSTANCE` (e.g. `demo1` for
Sepolia); the environment (`testnet`/`mainnet`) derives from `NETWORK`. Registry root defaults
to this `registry/` dir; override with `DEPLOYMENT_REGISTRY_DIR`.

## Local / e2e — flat files (no registry)

The registry has no `local` instance (anvil addresses are ephemeral). When `DEPLOYMENT_INSTANCE`
is unset, the loaders read flat `privacy-pool-{hub|client|clientB}.json` + `yield-hub.json` from
`DEPLOYMENTS_DIR` — for local runs point that at the monorepo clone's `deployments/` after
`npm run setup` (see `relayer-v2/actor/e2e/README.md`). Nothing flat is committed here.
