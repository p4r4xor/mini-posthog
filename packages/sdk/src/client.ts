/**
 * Top-level client: wires config defaults, the batch queue, and trace/run
 * factories together. This is what {@link initAgentAnalytics} returns.
 */
import type { CaptureEvent } from "@ata/contracts";
import { BatchQueue } from "./batch-queue.js";
import { TraceImpl } from "./trace.js";
import type {
  AnalyticsClient,
  AnalyticsConfig,
  OnError,
  ResolvedConfig,
  Run,
  StartRunSugarOptions,
  StartTraceOptions,
  Trace,
} from "./types.js";

const DEFAULTS = {
  flushAt: 50,
  flushIntervalMs: 5000,
  maxRetries: 3,
  maxQueueSize: 100_000,
  retryBaseMs: 200,
} as const;

/** Fallback error sink: warn, but never throw on the agent's hot path. */
const defaultOnError: OnError = (err, dropped) => {
  console.warn(`[ata/sdk] dropped ${dropped.length} event(s): ${err.message}`);
};

function resolveConfig(config: AnalyticsConfig): ResolvedConfig {
  if (!config.apiKey) throw new Error("initAgentAnalytics: apiKey is required");
  if (!config.host) throw new Error("initAgentAnalytics: host is required");
  return {
    apiKey: config.apiKey,
    host: config.host,
    flushAt: config.flushAt ?? DEFAULTS.flushAt,
    flushIntervalMs: config.flushIntervalMs ?? DEFAULTS.flushIntervalMs,
    maxRetries: config.maxRetries ?? DEFAULTS.maxRetries,
    maxQueueSize: config.maxQueueSize ?? DEFAULTS.maxQueueSize,
    retryBaseMs: config.retryBaseMs ?? DEFAULTS.retryBaseMs,
    onError: config.onError ?? defaultOnError,
  };
}

class AnalyticsClientImpl implements AnalyticsClient {
  private readonly queue: BatchQueue;
  private readonly enqueue: (event: CaptureEvent) => void;

  constructor(readonly config: ResolvedConfig) {
    this.queue = new BatchQueue(config);
    this.queue.start();
    this.enqueue = (event) => {
      this.queue.enqueue(event);
    };
  }

  startTrace(opts: StartTraceOptions): Trace {
    return new TraceImpl({
      traceId: opts.traceId ?? `trace_${crypto.randomUUID()}`,
      agentName: opts.agentName,
      userId: opts.userId,
      tags: opts.tags,
      enqueue: this.enqueue,
    });
  }

  /** Sugar: a trace with exactly one run for the common single-run case. */
  startRun(opts: StartRunSugarOptions): Run {
    const trace = this.startTrace({
      agentName: opts.agentName,
      userId: opts.userId,
      tags: opts.tags,
    });
    return trace.startRun({
      input: opts.input,
      ...(opts.at !== undefined ? { at: opts.at } : {}),
    });
  }

  flush(): Promise<void> {
    return this.queue.flush();
  }

  shutdown(): Promise<void> {
    return this.queue.shutdown();
  }
}

/** Construct an {@link AnalyticsClient}. Entry point for the SDK. */
export function initAgentAnalytics(config: AnalyticsConfig): AnalyticsClient {
  return new AnalyticsClientImpl(resolveConfig(config));
}
