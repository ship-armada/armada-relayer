# deployments/

Deployment manifests — single source of truth for contract addresses and `deployBlock`
(spec §7.2). Layout: `deployments/<network>/hub.json` and `deployments/<network>/client-<chainId>.json`.

The `local/` manifests here are PLACEHOLDERS (deterministic Anvil first-deploy addresses)
authored because this workspace lacks the monorepo's real manifests — see
`.context/deviations.md` DEV-2. `sepolia/` and `mainnet/` are intentionally absent: both
services fail loudly at boot when a required manifest is missing, per spec §7.2.
