// ABOUTME: §8.8 pre-deploy check: runs the actor's real ChainlinkPriceSource against the live
// ABOUTME: hub-chain ETH/USD feed and reports every guard's verdict. Usage: npx tsx e2e/verify-feed.mts
import { JsonRpcProvider } from "ethers";
import { ChainlinkPriceSource, chainlinkAggregator } from "../src/relay/price-source.js";

const RPC = process.env.HUB_RPC ?? "https://ethereum-sepolia-rpc.publicnode.com";
const FEED = process.env.ETH_USD_FEED_ADDRESS ?? "0x694AA1769357215DE4FAC081bf1f309aDC325306";
const provider = new JsonRpcProvider(RPC, undefined, { staticNetwork: true });
const reader = chainlinkAggregator(FEED, provider);

const { answer, updatedAt } = await reader.latestRoundData();
const ageMin = (Date.now() / 1000 - Number(updatedAt)) / 60;
console.log(`feed ${FEED}`);
console.log(
  `raw answer: ${answer}  updatedAt: ${new Date(Number(updatedAt) * 1000).toISOString()}  age: ${ageMin.toFixed(1)} min`,
);
console.log(`staleness guard: ${ageMin < 90 ? "PASS" : "FAIL"} (limit 90 min = 1h heartbeat + 50%)`);

const source = new ChainlinkPriceSource(reader, {
  maxStalenessMs: 5_400_000,
  min: 100,
  max: 100_000,
  staticFallback: Number(process.env.ETH_USD_PRICE_STATIC ?? 3000),
  onReading: (r) => console.log(`gauge update: price=${r.price} degraded=${r.degraded}`),
});
const reading = await source.refresh();
console.log(`ChainlinkPriceSource verdict: price=$${reading.price} degraded=${reading.degraded}`);
if (reading.degraded) {
  console.error("GUARDS REJECTED THE LIVE FEED");
  process.exit(1);
}
console.log("§8.8 guards accept the live feed ✓");
