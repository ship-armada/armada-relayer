# deployments/

Deployment manifests — single source of truth for contract addresses and `deployBlock`
(spec §7.2). File naming follows the monorepo convention:
`privacy-pool-{hub|client|clientB}{-sepolia|-mainnet}.json` plus `yield-hub{-env}.json`
(supplies the ArmadaYieldAdapter for the hub target allowlist).

- **Sepolia manifests are committed here**, copied VERBATIM from the monorepo's
  `deployments/` (see `.context/deviations.md` TODO-5 for the sync-ownership decision).
- **Local manifests are generated artifacts** — the monorepo's `npm run setup` writes
  `privacy-pool-hub.json` etc.; point `DEPLOYMENTS_DIR` at the monorepo clone's
  `deployments/` for local runs. Test fixtures live under each package's
  `test/fixtures/deployments/`.
- **Mainnet manifests are intentionally absent**: both services fail loudly at boot when a
  required manifest is missing, per spec §7.2 (mainnet is a configuration posture).
