/**
 * Streaming dataset generation for the benchmark (docs/architecture.md §8).
 *
 * We reuse the REAL simulator generator through the REAL SDK so the benchmark
 * exercises the same code path that ships - but we swap the SDK's HTTP transport
 * for a COLLECTING transport: a `globalThis.fetch` stub that parses the POST
 * `{events}` body and pushes the CaptureEvents into an in-memory array (no
 * network, no API server).
 *
 * CRITICAL - bounded memory: the previous design materialised ALL CaptureEvents
 * AND all mapped EventRows at once (multiple GB → laptop crash). This version
 * STREAMS: it drains the collecting buffer incrementally, maps to EventRow, and
 * hands the caller fixed-size batches via `onBatch`, clearing buffers as it goes.
 * Peak heap is therefore ≈ ONE batch (tens of MB), independent of total events.
 *
 * Timestamps are spread across a historical window by the generator (it stamps
 * every capture's `at`), driven by the `--days` flag → realistic time-series.
 */

import type { CaptureEvent, EventRow } from "@ata/contracts";
import { captureEventToRow } from "@ata/contracts";
import { initAgentAnalytics } from "@ata/sdk";
import { generateTrace, type TraceContext } from "@ata/simulator/generator";
import { mulberry32, type Rng } from "@ata/simulator/rng";
import { driveCalls } from "@ata/simulator/run-simulation";

const PROJECT_ID = "proj_dev";
const API_KEY = "dev_project_key";
const HOST = "http://bench";

/** How many rows to sample for the rawBytes estimate (avoids serializing all). */
const SAMPLE_SIZE = 1000;

export interface GenOptions {
  /** Target number of wire events to generate. */
  events: number;
  /** Historical window length in days, ending at `now`. */
  days: number;
  /** PRNG seed for reproducibility (default 1). Same seed → identical data. */
  seed?: number;
  /** Rows handed to `onBatch` at a time (default 20_000). Bounds peak memory. */
  batchSize?: number;
  /** Override "now" (ms epoch); defaults to Date.now(). */
  nowMs?: number;
  /** Progress callback fired roughly every batch. */
  onProgress?: (generated: number, target: number) => void;
}

export interface GenSummary {
  /** Number of EventRows emitted. */
  events: number;
  /** Number of distinct traces generated. */
  traces: number;
  /** Estimated raw size: sampled-average row JSON bytes × total events. */
  rawBytes: number;
  /** The historical window the events span. */
  window: { fromMs: number; toMs: number };
}

/** A batch consumer: receives a chunk of rows, persists it, resolves when done. */
export type BatchSink = (rows: EventRow[]) => Promise<void>;

/**
 * Install a collecting `fetch` stub that captures every `{events}` POST body.
 * Returns the collected array plus a restore function. The stub satisfies the
 * SDK transport contract: 200 OK so no retries fire.
 */
function installCollectingTransport(): {
  collected: CaptureEvent[];
  restore: () => void;
} {
  const collected: CaptureEvent[] = [];
  const original = globalThis.fetch;

  const stub: typeof fetch = async (_input, init) => {
    const body = init?.body;
    if (typeof body === "string") {
      const parsed = JSON.parse(body) as { events?: CaptureEvent[] };
      if (parsed.events) {
        for (const e of parsed.events) collected.push(e);
      }
    }
    return new Response(null, { status: 200 });
  };

  globalThis.fetch = stub;
  return {
    collected,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

/**
 * Generate ~`events` realistic EventRows by driving the simulator generator
 * through the real SDK + a collecting transport, STREAMING fixed-size batches to
 * `onBatch`. Never accumulates all rows; never JSON.stringifies all rows. Peak
 * memory is one `pending` buffer (≈ batchSize rows) + one `collected` flush.
 */
export async function streamGenerate(
  opts: GenOptions,
  onBatch: BatchSink,
): Promise<GenSummary> {
  const seed = opts.seed ?? 1;
  const batchSize = opts.batchSize ?? 20_000;
  const nowMs = opts.nowMs ?? Date.now();
  const windowStartMs = nowMs - opts.days * 24 * 60 * 60 * 1000;
  const windowEndMs = nowMs;

  const { collected, restore } = installCollectingTransport();

  // Pending mapped rows waiting to be flushed to the sink (the ONLY accumulator,
  // and it is drained down to < batchSize on every push).
  const pending: EventRow[] = [];
  let totalEvents = 0;
  let traces = 0;

  // rawBytes estimate from a SAMPLE: serialize only the first ~SAMPLE_SIZE rows.
  let sampledRows = 0;
  let sampledBytes = 0;

  /**
   * Drain the collecting buffer: map each CaptureEvent → EventRow into `pending`,
   * then CLEAR `collected` so it can't grow unbounded. Flush full batches.
   */
  const drain = async (): Promise<void> => {
    for (let i = 0; i < collected.length; i++) {
      const row = captureEventToRow(collected[i]!, PROJECT_ID);
      pending.push(row);
      totalEvents++;
      if (sampledRows < SAMPLE_SIZE) {
        sampledBytes += Buffer.byteLength(JSON.stringify(row), "utf8");
        sampledRows++;
      }
    }
    // Free the collected CaptureEvents - they have been mapped into `pending`.
    collected.length = 0;

    while (pending.length >= batchSize) {
      await onBatch(pending.splice(0, batchSize));
    }
  };

  try {
    // flushAt sized so the SDK's bounded queue drains via our explicit flush()
    // cadence before it can overflow (drop-newest backpressure). We await flush()
    // every `flushEvery` emitted events, then immediately drain → batches out.
    const client = initAgentAnalytics({
      apiKey: API_KEY,
      host: HOST,
      flushAt: 1000,
      flushIntervalMs: 10_000_000,
    });

    const flushEvery = batchSize;
    const rng: Rng = mulberry32(seed);
    let emitted = 0;
    let lastFlush = 0;

    while (emitted < opts.events) {
      const ctx: TraceContext = { index: traces, windowStartMs, windowEndMs };
      emitted += driveCalls(client, generateTrace(rng, ctx));
      traces++;
      if (emitted - lastFlush >= flushEvery) {
        lastFlush = emitted;
        await client.flush();
        await drain();
        opts.onProgress?.(totalEvents, opts.events);
      }
    }

    // Final SDK flush, then drain everything left and emit the final partial batch.
    await client.flush();
    await client.shutdown();
    await drain();
    if (pending.length > 0) {
      await onBatch(pending.splice(0, pending.length));
    }
    opts.onProgress?.(totalEvents, opts.events);

    const avgRowBytes = sampledRows > 0 ? sampledBytes / sampledRows : 0;
    const rawBytes = Math.round(avgRowBytes * totalEvents);

    return {
      events: totalEvents,
      traces,
      rawBytes,
      window: { fromMs: windowStartMs, toMs: windowEndMs },
    };
  } finally {
    restore();
  }
}
