/**
 * Toy agent simulator CLI — generates realistic agent traces through @ata/sdk.
 *
 * Run via tsx:
 *   tsx src/index.ts --mode demo --events 2000 --host http://localhost:3000
 *   tsx src/index.ts --mode benchmark            # ~1,000,000 events
 *
 * Flags:
 *   --mode demo|benchmark   preset target event count (demo≈2k, benchmark≈1M)
 *   --events <N>            explicit target wire-event count (overrides preset)
 *   --host <url>            ingestion host (default http://localhost:3000)
 *   --api-key <key>         project API key (default dev_project_key)
 *   --days <n>              historical window length, ending now (default 7)
 *   --seed <n>              PRNG seed for reproducibility (default 1)
 *   --flush-at <n>          SDK flush batch size (default 500)
 *
 * After generating it flushes + shuts down the SDK and prints throughput.
 * See docs/architecture.md §11 (SDK) + the Simulator Requirements in README.
 */
import { runSimulation } from "./run-simulation.js";

interface Args {
  mode: "demo" | "benchmark";
  events?: number;
  host: string;
  apiKey: string;
  days: number;
  seed: number;
  flushAt: number;
}

function parseArgs(argv: readonly string[]): Args {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const num = (name: string): number | undefined => {
    const v = get(name);
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${v}"`);
    return n;
  };

  const modeRaw = get("--mode") ?? "demo";
  if (modeRaw !== "demo" && modeRaw !== "benchmark") {
    throw new Error(`--mode must be "demo" or "benchmark", got "${modeRaw}"`);
  }

  return {
    mode: modeRaw,
    events: num("--events"),
    host: get("--host") ?? "http://localhost:3000",
    apiKey: get("--api-key") ?? "dev_project_key",
    days: num("--days") ?? 7,
    seed: num("--seed") ?? 1,
    flushAt: num("--flush-at") ?? 500,
  };
}

const PRESET_EVENTS = { demo: 2_000, benchmark: 1_000_000 } as const;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const targetEvents = args.events ?? PRESET_EVENTS[args.mode];

  console.log(
    `[simulator] mode=${args.mode} target=${targetEvents.toLocaleString()} events ` +
      `host=${args.host} days=${args.days} seed=${args.seed} flushAt=${args.flushAt}`,
  );

  const result = await runSimulation({
    host: args.host,
    apiKey: args.apiKey,
    targetEvents,
    days: args.days,
    seed: args.seed,
    flushAt: args.flushAt,
    onProgress: (emitted, target) => {
      const pct = ((emitted / target) * 100).toFixed(1);
      console.log(
        `[simulator] ${emitted.toLocaleString()} / ${target.toLocaleString()} (${pct}%)`,
      );
    },
  });

  console.log(
    `[simulator] done: ${result.events.toLocaleString()} events across ` +
      `${result.traces.toLocaleString()} traces in ${(result.elapsedMs / 1000).toFixed(2)}s ` +
      `→ ${Math.round(result.eventsPerSec).toLocaleString()} events/sec` +
      (result.dropped > 0 ? ` (dropped ${result.dropped.toLocaleString()})` : ""),
  );
}

main().catch((err) => {
  console.error("[simulator] failed:", err);
  process.exitCode = 1;
});
