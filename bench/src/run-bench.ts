/**
 * The measurement loop (docs/architecture.md §8).
 *
 * For each engine × each catalog query: warm up (3 runs, JIT + CH connection +
 * OS page cache), then K timed iterations of `store.aggregate(compiled,
 * projectId)`. We measure WALL-CLOCK with performance.now() around the call -
 * i.e. the user-perceived latency including the ClickHouse HTTP round-trip - not
 * just the adapter's self-reported execution time. We report p50 and p95 (ms)
 * and the rowCount the query returned.
 */
import type { CompiledQuery, EventStore } from "@ata/contracts";
import type { BenchQuery } from "./queries.js";

const PROJECT_ID = "proj_dev";
const WARMUP_RUNS = 3;

export interface QueryTiming {
  nl: string;
  level: CompiledQuery["source"];
  p50Ms: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
  rowCount: number;
  iterations: number;
}

/** Percentile (0..1) of a sample by the nearest-rank method on a sorted copy. */
function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return Number.NaN;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil(p * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx]!;
}

/** Time one query: warmups (discarded) then `iterations` measured runs. */
async function timeQuery(
  store: EventStore,
  query: BenchQuery,
  iterations: number,
): Promise<QueryTiming> {
  let rowCount = 0;

  for (let i = 0; i < WARMUP_RUNS; i++) {
    const res = await store.aggregate(query.compiled, PROJECT_ID);
    rowCount = res.rowCount;
  }

  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    const res = await store.aggregate(query.compiled, PROJECT_ID);
    samples.push(performance.now() - start);
    rowCount = res.rowCount;
  }

  return {
    nl: query.nl,
    level: query.level,
    p50Ms: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
    minMs: Math.min(...samples),
    maxMs: Math.max(...samples),
    rowCount,
    iterations,
  };
}

/** Run the whole catalog against one engine's store. */
export async function benchmarkEngine(
  store: EventStore,
  queries: BenchQuery[],
  iterations: number,
  onQuery?: (nl: string, t: QueryTiming) => void,
): Promise<QueryTiming[]> {
  const timings: QueryTiming[] = [];
  for (const query of queries) {
    const timing = await timeQuery(store, query, iterations);
    timings.push(timing);
    onQuery?.(query.nl, timing);
  }
  return timings;
}
