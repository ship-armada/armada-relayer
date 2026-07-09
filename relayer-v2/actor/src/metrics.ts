// ABOUTME: Prometheus metrics for the actor (§10.1) via prom-client: relay outcomes, fee
// ABOUTME: rejects, job states/transitions, Iris polls, RPC budget guardrail, price gauges.
import client from "prom-client";

export interface ActorMetrics {
  registry: client.Registry;
  relaySubmission(selector: string, outcome: "success" | "fail", code: string): void;
  feeVerifierReject(code: string): void;
  rateLimited(endpoint: string): void;
  idempotentReplay(): void;
  setCctpJobs(state: string, destinationDomain: number, count: number): void;
  jobTransition(from: string, to: string): void;
  irisPoll(result: "complete" | "pending" | "error"): void;
  rpcRequest(chain: number, method: string): void;
  setFallbackActive(chain: number, active: boolean): void;
  setWalletBalance(chain: number, wei: bigint): void;
  setEthUsdPrice(price: number, degraded: boolean): void;
  observeHttp(route: string, method: string, status: number, seconds: number): void;
}

export function createMetrics(registry?: client.Registry): ActorMetrics {
  const reg = registry ?? new client.Registry();
  client.collectDefaultMetrics({ register: reg });

  const relaySubmissions = new client.Counter({
    name: "armada_actor_relay_submissions_total",
    help: "POST /relay submissions by selector and outcome",
    labelNames: ["selector", "outcome", "code"],
    registers: [reg],
  });
  const feeVerifierRejects = new client.Counter({
    name: "armada_actor_fee_verifier_rejects_total",
    help: "Fee verification rejections by code",
    labelNames: ["code"],
    registers: [reg],
  });
  const rateLimited = new client.Counter({
    name: "armada_actor_rate_limited_total",
    help: "Requests rejected by the per-IP token bucket",
    labelNames: ["endpoint"],
    registers: [reg],
  });
  const idempotentReplays = new client.Counter({
    name: "armada_actor_idempotent_replays_total",
    help: "POST /relay calls answered from the idempotency store",
    registers: [reg],
  });
  const cctpJobs = new client.Gauge({
    name: "armada_actor_cctp_jobs",
    help: "CCTP jobs by state and destination domain",
    labelNames: ["state", "destination_domain"],
    registers: [reg],
  });
  const jobTransitions = new client.Counter({
    name: "armada_actor_cctp_job_transitions_total",
    help: "CCTP job state transitions",
    labelNames: ["from", "to"],
    registers: [reg],
  });
  const irisPolls = new client.Counter({
    name: "armada_actor_iris_polls_total",
    help: "Iris attestation polls by result",
    labelNames: ["result"],
    registers: [reg],
  });
  const rpcRequests = new client.Counter({
    name: "armada_actor_rpc_requests_total",
    help: "Actor-issued RPC requests; eth_getLogs MUST stay 0 while the watcher is healthy (D1)",
    labelNames: ["chain", "method"],
    registers: [reg],
  });
  const fallbackActive = new client.Gauge({
    name: "armada_actor_fallback_scanner_active",
    help: "1 while the fallback MessageSent scanner is active for a chain (§8.7)",
    labelNames: ["chain"],
    registers: [reg],
  });
  const walletBalance = new client.Gauge({
    name: "armada_actor_wallet_balance_wei",
    help: "Relayer EOA balance in wei per chain (alert < 0.1 ETH)",
    labelNames: ["chain"],
    registers: [reg],
  });
  const ethUsdPrice = new client.Gauge({
    name: "armada_actor_eth_usd_price",
    help: "Last accepted ETH/USD feed reading (§8.8)",
    registers: [reg],
  });
  const ethUsdDegraded = new client.Gauge({
    name: "armada_actor_eth_usd_price_degraded",
    help: "1 while serving last-known-good/static fallback price (§8.8)",
    registers: [reg],
  });
  const httpDuration = new client.Histogram({
    name: "armada_actor_http_request_duration_seconds",
    help: "HTTP request duration",
    labelNames: ["route", "method", "status"],
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [reg],
  });

  return {
    registry: reg,
    relaySubmission: (selector, outcome, code) =>
      relaySubmissions.labels(selector, outcome, code).inc(),
    feeVerifierReject: (code) => feeVerifierRejects.labels(code).inc(),
    rateLimited: (endpoint) => rateLimited.labels(endpoint).inc(),
    idempotentReplay: () => idempotentReplays.inc(),
    setCctpJobs: (state, domain, count) => cctpJobs.labels(state, String(domain)).set(count),
    jobTransition: (from, to) => jobTransitions.labels(from, to).inc(),
    irisPoll: (result) => irisPolls.labels(result).inc(),
    rpcRequest: (chain, method) => rpcRequests.labels(String(chain), method).inc(),
    setFallbackActive: (chain, active) => fallbackActive.labels(String(chain)).set(active ? 1 : 0),
    setWalletBalance: (chain, wei) => walletBalance.labels(String(chain)).set(Number(wei)),
    setEthUsdPrice: (price, degraded) => {
      if (!degraded) ethUsdPrice.set(price);
      ethUsdDegraded.set(degraded ? 1 : 0);
    },
    observeHttp: (route, method, status, seconds) =>
      httpDuration.labels(route, method, String(status)).observe(seconds),
  };
}
