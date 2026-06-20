/**
 * Benchmark harness CLI (docs/architecture.md §8).
 *
 * Generates a realistic ~N-event dataset via the real simulator + SDK, loads it
 * into each storage adapter, runs the supported-query catalog × K iterations,
 * and reports p50/p95 latency, ingest throughput, on-disk size, and compression
 * ratio — the numbers that fill the §8 storage-engine decision table.
 *
 * Memory safety: the dataset is STREAMED into each engine — generation produces
 * fixed-size batches that are bulk-inserted and then freed, so peak heap is one
 * batch (tens of MB), regardless of `--events`. The dataset is regenerated per
 * engine; generation is deterministic (same seed → byte-identical data), so the
 * comparison stays fair without ever holding the whole dataset in memory.
 *
 * Usage:
 *   tsx src/index.ts [--events N] [--iterations K] [--engines a,b] [--days D] [--seed S]
 *
 * Defaults: --events 200000 --iterations 25 --engines duckdb,clickhouse --days 7 --seed 1
 * (1M must be explicit: --events 1000000 — so an accidental run stays cheap.)
 */
import type { StorageEngine } from "@ata/contracts";
import { streamGenerate } from "./dataset.js";
import { measureDiskBytes, streamLoad } from "./engines.js";
import { buildQueries } from "./queries.js";
import {
  type BenchResults,
  type EngineSummary,
  printReport,
  toMarkdown,
  writeResults,
} from "./report.js";
import { benchmarkEngine } from "./run-bench.js";

interface Args {
  events: number;
  iterations: number;
  engines: StorageEngine[];
  days: number;
  seed: number;
}

const ALL_ENGINES: StorageEngine[] = ["duckdb", "clickhouse"];

function parseArgs(argv: string[]): Args {
  const map = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        map.set(key, next);
        i++;
      } else {
        map.set(key, "true");
      }
    }
  }

  const num = (key: string, def: number): number => {
    const v = map.get(key);
    if (v === undefined) return def;
    const n = Number(v.replace(/_/g, ""));
    if (!Number.isFinite(n) || n <= 0)
      throw new Error(`--${key} must be a positive number`);
    return n;
  };

  const enginesRaw = map.get("engines");
  let engines: StorageEngine[] = ALL_ENGINES;
  if (enginesRaw) {
    engines = enginesRaw.split(",").map((s) => s.trim()) as StorageEngine[];
    for (const e of engines) {
      if (e !== "duckdb" && e !== "clickhouse") {
        throw new Error(`Unknown engine "${e}" — choose from: ${ALL_ENGINES.join(", ")}`);
      }
    }
  }

  return {
    events: Math.trunc(num("events", 200_000)),
    iterations: Math.trunc(num("iterations", 25)),
    engines,
    days: Math.trunc(num("days", 7)),
    seed: Math.trunc(num("seed", 1)),
  };
}

function pct(loaded: number, total: number): string {
  return `${((loaded / total) * 100).toFixed(0)}%`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  console.log(
    `\n[bench] events=${args.events.toLocaleString()} iterations=${args.iterations} ` +
      `engines=${args.engines.join(",")} days=${args.days} seed=${args.seed}`,
  );

  // Pin "now" up-front so the dataset window (and thus the compiled catalog) is
  // identical across engines even though we regenerate per engine.
  const nowMs = Date.now();
  const window = {
    fromMs: nowMs - args.days * 24 * 60 * 60 * 1000,
    toMs: nowMs,
  };

  // Compile the catalog ONCE against the (fixed) window — fail loudly if broken.
  console.log("[bench] planning + compiling the query catalog …");
  const queries = await buildQueries(window);
  console.log(
    `[bench] ${queries.length} queries compiled (sources: ${queries.map((q) => q.source).join(",")})`,
  );

  // For each engine: STREAM-generate + bulk-load → benchmark → measure disk → close.
  // Regenerating per engine keeps peak memory at one batch; deterministic seed
  // guarantees byte-identical data, so the comparison is still fair.
  const summaries: EngineSummary[] = [];
  let traces = 0;
  let generateMs = 0;
  for (const engine of args.engines) {
    console.log(`\n[bench] === ${engine} ===`);
    console.log(`[bench] streaming + loading ~${args.events.toLocaleString()} events …`);
    let lastLogged = 0;
    const genStart = performance.now();
    const load = await streamLoad(engine, (onBatch) =>
      streamGenerate(
        {
          events: args.events,
          days: args.days,
          seed: args.seed,
          nowMs,
          onProgress: (c, t) => {
            if (c - lastLogged >= 100_000 || c >= t) {
              lastLogged = c;
              console.log(
                `[bench]   generated+loaded ${c.toLocaleString()} / ${t.toLocaleString()} (${pct(c, t)})`,
              );
            }
          },
        },
        onBatch,
      ),
    );
    generateMs = performance.now() - genStart;
    traces = load.gen.traces;
    console.log(
      `[bench] loaded ${load.inserted.toLocaleString()} rows in ${(load.loadMs / 1000).toFixed(1)}s ` +
        `(${Math.round(load.eventsPerSec).toLocaleString()} events/sec), ` +
        `raw ${(load.gen.rawBytes / 1024 / 1024).toFixed(1)} MB, ` +
        `${load.gen.traces.toLocaleString()} traces`,
    );

    console.log(
      `[bench] running ${queries.length} queries × ${args.iterations} iterations …`,
    );
    const timings = await benchmarkEngine(
      load.store,
      queries,
      args.iterations,
      (nl, t) => {
        console.log(
          `[bench]   ${nl.padEnd(40)} p50=${t.p50Ms.toFixed(2)}ms p95=${t.p95Ms.toFixed(2)}ms rows=${t.rowCount}`,
        );
      },
    );

    // Close the load store BEFORE measuring DuckDB disk (single-writer lock).
    await load.store.close();
    const diskBytes = await measureDiskBytes(engine);
    const compressionRatio = diskBytes > 0 ? load.gen.rawBytes / diskBytes : 0;
    console.log(
      `[bench] on-disk ${(diskBytes / 1024 / 1024).toFixed(1)} MB (${compressionRatio.toFixed(2)}× vs raw)`,
    );

    summaries.push({
      engine,
      rowsLoaded: load.inserted,
      loadMs: load.loadMs,
      ingestEventsPerSec: load.eventsPerSec,
      diskBytes,
      rawBytes: load.gen.rawBytes,
      compressionRatio,
      timings,
    });
  }

  // 4) Report.
  const results: BenchResults = {
    generatedAt: new Date().toISOString(),
    events: args.events,
    iterations: args.iterations,
    days: args.days,
    seed: args.seed,
    traces,
    generateMs,
    engines: summaries,
  };

  printReport(results);
  const path = writeResults(results);
  console.log(`[bench] results written to ${path}`);
  console.log("\n[bench] Markdown table:\n");
  console.log(toMarkdown(results));
  console.log("");
}

main().catch((err) => {
  console.error("[bench] FAILED:", err);
  process.exitCode = 1;
});
