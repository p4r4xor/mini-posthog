/**
 * Driver: feed the pure generator's SimCall stream through a real @ata/sdk
 * client. This is the only place that talks to the SDK; the generator stays
 * pure and testable. Tests reuse `driveCalls` with a fake client to capture the
 * exact SDK calls without any network.
 */
import type { AnalyticsClient, Run, Trace } from "@ata/sdk";
import { initAgentAnalytics } from "@ata/sdk";
import { generateTrace, type SimCall, type TraceContext } from "./generator.js";
import { mulberry32, type Rng } from "./rng.js";

/** The subset of the SDK surface the driver needs (lets tests substitute a fake). */
export interface SdkLike {
  startTrace(opts: {
    agentName: string;
    userId: string;
    tags?: Record<string, unknown>;
  }): Trace;
}

/**
 * Replay a single trace's SimCalls against an SDK-like client. Returns the
 * number of wire events emitted (everything except start_trace/end_trace).
 */
export function driveCalls(sdk: SdkLike, calls: Iterable<SimCall>): number {
  let trace: Trace | undefined;
  let run: Run | undefined;
  let events = 0;

  for (const c of calls) {
    switch (c.kind) {
      case "start_trace":
        trace = sdk.startTrace({
          agentName: c.agentName,
          userId: c.userId,
          tags: c.tags,
        });
        break;
      case "start_run":
        if (!trace) throw new Error("start_run before start_trace");
        run = trace.startRun({ input: c.input, at: c.at });
        events++;
        break;
      case "llm_call":
        run?.captureLLMCall({
          model: c.model,
          latencyMs: c.latencyMs,
          inputTokens: c.inputTokens,
          outputTokens: c.outputTokens,
          costUsd: c.costUsd,
          status: c.status,
          at: c.at,
        });
        events++;
        break;
      case "tool_call":
        run?.captureToolCall({
          toolName: c.toolName,
          latencyMs: c.latencyMs,
          status: c.status,
          ...(c.costUsd !== undefined ? { costUsd: c.costUsd } : {}),
          at: c.at,
        });
        events++;
        break;
      case "step":
        run?.captureStep({ latencyMs: c.latencyMs, at: c.at });
        events++;
        break;
      case "error":
        run?.captureError({
          errorType: c.errorType,
          message: c.message,
          ...(c.toolName !== undefined ? { toolName: c.toolName } : {}),
          latencyMs: c.latencyMs,
          at: c.at,
        });
        events++;
        break;
      case "retry":
        run?.captureRetry({
          attempt: c.attempt,
          ...(c.toolName !== undefined ? { toolName: c.toolName } : {}),
          status: c.status,
          latencyMs: c.latencyMs,
          at: c.at,
        });
        events++;
        break;
      case "end_run":
        run?.end({
          status: c.status,
          ...(c.output !== undefined ? { output: c.output } : {}),
          at: c.at,
        });
        events++;
        run = undefined;
        break;
      case "end_trace":
        trace?.end();
        trace = undefined;
        break;
    }
  }
  return events;
}

export interface SimulationOptions {
  host: string;
  apiKey: string;
  /** Target wire-event count; generation stops once reached. */
  targetEvents: number;
  /** Historical window length in days, ending at `now`. */
  days: number;
  /** PRNG seed (default 1) for reproducibility. */
  seed?: number;
  /** SDK flush batch size. */
  flushAt?: number;
  flushIntervalMs?: number;
  /** Override "now" (ms epoch) for deterministic tests. Defaults to Date.now(). */
  nowMs?: number;
  /** Progress callback (fires every ~`progressEvery` events). */
  onProgress?: (emitted: number, target: number) => void;
  progressEvery?: number;
}

export interface SimulationResult {
  traces: number;
  events: number;
  /** Events dropped by the SDK (transport failures / backpressure). */
  dropped: number;
  elapsedMs: number;
  eventsPerSec: number;
}

/**
 * Full simulation: generate traces until the target event count is reached,
 * driving each through a real SDK client, then flush + shutdown. Returns
 * throughput stats.
 */
export async function runSimulation(opts: SimulationOptions): Promise<SimulationResult> {
  const seed = opts.seed ?? 1;
  const nowMs = opts.nowMs ?? Date.now();
  const windowStartMs = nowMs - opts.days * 24 * 60 * 60 * 1000;
  const windowEndMs = nowMs;
  const progressEvery = opts.progressEvery ?? 50_000;

  let dropped = 0;
  const client: AnalyticsClient = initAgentAnalytics({
    apiKey: opts.apiKey,
    host: opts.host,
    flushAt: opts.flushAt ?? 500,
    flushIntervalMs: opts.flushIntervalMs ?? 2000,
    onError: (_err, droppedEvents) => {
      dropped += droppedEvents.length;
    },
  });

  const rng: Rng = mulberry32(seed);
  const start = performance.now();
  let traces = 0;
  let events = 0;
  let lastProgress = 0;

  while (events < opts.targetEvents) {
    const ctx: TraceContext = { index: traces, windowStartMs, windowEndMs };
    events += driveCalls(client, generateTrace(rng, ctx));
    traces++;
    if (opts.onProgress && events - lastProgress >= progressEvery) {
      lastProgress = events;
      opts.onProgress(events, opts.targetEvents);
    }
    // Periodically yield to the event loop so the SDK's async flush + transport
    // can make progress (keeps the in-memory queue from ballooning at 1M scale).
    if (traces % 200 === 0) await Promise.resolve();
  }

  await client.flush();
  await client.shutdown();

  const elapsedMs = performance.now() - start;
  return {
    traces,
    events,
    dropped,
    elapsedMs,
    eventsPerSec: events / (elapsedMs / 1000),
  };
}
