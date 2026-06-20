/**
 * @ata/sdk - PostHog-like logging SDK for agent traces.
 *
 * Hierarchical trace → run → event API with single-run sugar; events are
 * auto-stamped with the wire envelope, batched, and shipped to `POST /capture`
 * with retry + backpressure. See docs/architecture.md §11/§12.
 *
 * @example
 * ```ts
 * const analytics = initAgentAnalytics({ apiKey, host });
 * const run = analytics.startRun({ agentName, userId, input });
 * run.captureLLMCall({ model, latencyMs, inputTokens, outputTokens, costUsd });
 * run.end({ status: "success", output });
 * await analytics.shutdown();
 * ```
 */
export { initAgentAnalytics } from "./client.js";
export { PermanentTransportError } from "./transport.js";
export type {
  AnalyticsClient,
  AnalyticsConfig,
  CaptureErrorOptions,
  CaptureLLMCallOptions,
  CaptureRetryOptions,
  CaptureStepOptions,
  CaptureToolCallOptions,
  EndRunOptions,
  OnError,
  Run,
  StartRunOptions,
  StartRunSugarOptions,
  StartTraceOptions,
  Tags,
  Trace,
} from "./types.js";
