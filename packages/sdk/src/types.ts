/**
 * Public configuration + handle types for @ata/sdk.
 *
 * The shapes here are deliberately the *ergonomic* surface the caller uses —
 * the SDK auto-stamps the rest of the wire envelope (eventId/traceId/runId/
 * stepIndex/timestamp/agentName/userId/metadata) before enqueueing, so callers
 * never hand-assemble a `CaptureEvent`.
 */
import type { CaptureEvent, Metadata } from "@ata/contracts";

/** Tags attached at trace level; merged into each event's `metadata.tags`. */
export type Tags = Record<string, unknown>;

/**
 * Called when events are permanently dropped: a non-retryable transport
 * failure (HTTP 4xx other than 429), retry budget exhausted, or backpressure
 * (queue full). `droppedEvents` is the batch/event that was discarded.
 */
export type OnError = (err: Error, droppedEvents: CaptureEvent[]) => void;

/** Configuration for {@link initAgentAnalytics}. */
export interface AnalyticsConfig {
  /** API key sent as the `x-api-key` header. Resolves to a project server-side. */
  apiKey: string;
  /** Base URL of the ingestion API; events POST to `${host}/capture`. */
  host: string;
  /** Flush once the queue reaches this many events. Default 50. */
  flushAt?: number;
  /** Background flush interval in ms. Default 5000. Injectable for tests. */
  flushIntervalMs?: number;
  /** Max transport retries (in addition to the first attempt). Default 3. */
  maxRetries?: number;
  /** Hard cap on the in-memory queue; excess events are dropped. Default 100000. */
  maxQueueSize?: number;
  /** Base backoff in ms: delay = retryBaseMs * 2^attempt + jitter. Default 200. */
  retryBaseMs?: number;
  /** Hook invoked with any permanently-dropped events. Defaults to console.warn. */
  onError?: OnError;
}

/** Fully-resolved config (all defaults applied). Internal. */
export interface ResolvedConfig {
  apiKey: string;
  host: string;
  flushAt: number;
  flushIntervalMs: number;
  maxRetries: number;
  maxQueueSize: number;
  retryBaseMs: number;
  onError: OnError;
}

export interface StartTraceOptions {
  agentName: string;
  userId: string;
  tags?: Tags;
  /** Provide to correlate with an external id; generated if absent. */
  traceId?: string;
}

export interface StartRunOptions {
  input: string;
  /** Provide to correlate with an external id; generated if absent. */
  runId?: string;
}

/** Sugar: open a trace with a single run in one call. */
export interface StartRunSugarOptions {
  agentName: string;
  userId: string;
  input: string;
  tags?: Tags;
}

export interface CaptureLLMCallOptions {
  model: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  status?: "success" | "failed";
  metadata?: Metadata;
}

export interface CaptureToolCallOptions {
  toolName: string;
  latencyMs: number;
  status?: "success" | "failed";
  costUsd?: number;
  metadata?: Metadata;
}

export interface CaptureStepOptions {
  latencyMs?: number;
  metadata?: Metadata;
}

export interface CaptureErrorOptions {
  errorType: string;
  message?: string;
  toolName?: string;
  latencyMs?: number;
  metadata?: Metadata;
}

export interface CaptureRetryOptions {
  attempt: number;
  toolName?: string;
  status?: "success" | "failed";
  latencyMs?: number;
  metadata?: Metadata;
}

export interface EndRunOptions {
  status: "success" | "failed";
  output?: string;
}

/** A live run handle. Auto-stamps trace/run/step context onto every capture. */
export interface Run {
  readonly traceId: string;
  readonly runId: string;
  captureLLMCall(opts: CaptureLLMCallOptions): void;
  captureToolCall(opts: CaptureToolCallOptions): void;
  captureStep(opts?: CaptureStepOptions): void;
  captureError(opts: CaptureErrorOptions): void;
  captureRetry(opts: CaptureRetryOptions): void;
  end(opts: EndRunOptions): void;
}

/** A live trace handle grouping one or more runs. */
export interface Trace {
  readonly traceId: string;
  startRun(opts: StartRunOptions): Run;
  /** Marks the trace closed (bookkeeping only; no server event). */
  end(): void;
}

/** The top-level client returned by {@link initAgentAnalytics}. */
export interface AnalyticsClient {
  startTrace(opts: StartTraceOptions): Trace;
  /** Sugar for the common single-run case. */
  startRun(opts: StartRunSugarOptions): Run;
  /** Drain the queue, sending all pending events. */
  flush(): Promise<void>;
  /** Stop the background timer and perform a final flush. */
  shutdown(): Promise<void>;
}
