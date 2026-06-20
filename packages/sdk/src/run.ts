/**
 * Run handle implementation.
 *
 * A run is one complete agent invocation (docs/architecture.md §3). Every
 * capture method:
 *   - builds the correct `CaptureEvent` variant,
 *   - auto-stamps the shared envelope (eventId/traceId/runId/timestamp/
 *     agentName/userId/stepIndex),
 *   - merges the trace's `tags` into `metadata.tags`,
 *   - enqueues it.
 *
 * `stepIndex` is run-scoped: `run_started` is 0, and every subsequent captured
 * event in the run auto-increments. The wire stays flat (matches storage) while
 * the API stays hierarchical.
 */
import type { CaptureEvent, Metadata } from "@ata/contracts";
import type {
  CaptureErrorOptions,
  CaptureLLMCallOptions,
  CaptureRetryOptions,
  CaptureStepOptions,
  CaptureToolCallOptions,
  EndRunOptions,
  Run,
  Tags,
} from "./types.js";

/** Context the trace injects into each run it spawns. */
export interface RunContext {
  traceId: string;
  runId: string;
  agentName: string;
  userId: string;
  tags: Tags | undefined;
  enqueue: (event: CaptureEvent) => void;
}

export class RunImpl implements Run {
  readonly traceId: string;
  readonly runId: string;
  private nextStepIndex = 0;
  private ended = false;

  constructor(
    private readonly ctx: RunContext,
    input: string,
    at?: string | Date,
  ) {
    this.traceId = ctx.traceId;
    this.runId = ctx.runId;
    // run_started is always the first event (stepIndex 0).
    this.emit(
      {
        eventType: "run_started",
        status: "running",
        input,
      },
      at,
    );
  }

  captureLLMCall(opts: CaptureLLMCallOptions): void {
    this.emit(
      {
        eventType: "llm_call",
        model: opts.model,
        status: opts.status ?? "success",
        latencyMs: opts.latencyMs,
        inputTokens: opts.inputTokens,
        outputTokens: opts.outputTokens,
        costUsd: opts.costUsd,
        ...(opts.metadata ? { metadata: this.buildMetadata(opts.metadata) } : {}),
      },
      opts.at,
    );
  }

  captureToolCall(opts: CaptureToolCallOptions): void {
    this.emit(
      {
        eventType: "tool_call",
        toolName: opts.toolName,
        status: opts.status ?? "success",
        latencyMs: opts.latencyMs,
        ...(opts.costUsd !== undefined ? { costUsd: opts.costUsd } : {}),
        ...(opts.metadata ? { metadata: this.buildMetadata(opts.metadata) } : {}),
      },
      opts.at,
    );
  }

  captureStep(opts: CaptureStepOptions = {}): void {
    this.emit(
      {
        eventType: "step_completed",
        ...(opts.latencyMs !== undefined ? { latencyMs: opts.latencyMs } : {}),
        ...(opts.metadata ? { metadata: this.buildMetadata(opts.metadata) } : {}),
      },
      opts.at,
    );
  }

  captureError(opts: CaptureErrorOptions): void {
    this.emit(
      {
        eventType: "error",
        status: "failed",
        errorType: opts.errorType,
        ...(opts.message !== undefined ? { message: opts.message } : {}),
        ...(opts.toolName !== undefined ? { toolName: opts.toolName } : {}),
        ...(opts.latencyMs !== undefined ? { latencyMs: opts.latencyMs } : {}),
        ...(opts.metadata ? { metadata: this.buildMetadata(opts.metadata) } : {}),
      },
      opts.at,
    );
  }

  captureRetry(opts: CaptureRetryOptions): void {
    this.emit(
      {
        eventType: "retry",
        attempt: opts.attempt,
        ...(opts.toolName !== undefined ? { toolName: opts.toolName } : {}),
        ...(opts.status !== undefined ? { status: opts.status } : {}),
        ...(opts.latencyMs !== undefined ? { latencyMs: opts.latencyMs } : {}),
        ...(opts.metadata ? { metadata: this.buildMetadata(opts.metadata) } : {}),
      },
      opts.at,
    );
  }

  /**
   * Terminal event for the run. Carries only outcome + optional output —
   * deliberately no cost/latency/token fields, since rollup totals are derived
   * from constituent events (docs/architecture.md §5).
   */
  end(opts: EndRunOptions): void {
    if (this.ended) return;
    this.ended = true;
    this.emit(
      {
        eventType: "run_completed",
        status: opts.status,
        ...(opts.output !== undefined ? { output: opts.output } : {}),
      },
      opts.at,
    );
  }

  /**
   * Stamp the shared envelope onto a variant-specific payload and enqueue.
   * Always supplies `metadata` (with trace tags merged) so the wire event is
   * complete even when the caller passed none.
   *
   * The payload carries the variant's `eventType` + its own fields; we cast to
   * `CaptureEvent` after stamping. The discriminated-union `Omit` would
   * distribute and trip excess-property checks per variant, so we accept a
   * structural payload here and rely on each call site building a valid variant.
   */
  private emit(
    payload: { eventType: CaptureEvent["eventType"]; metadata?: Metadata } & Record<
      string,
      unknown
    >,
    at?: string | Date,
  ): void {
    const { metadata, ...rest } = payload;
    const timestamp =
      at === undefined
        ? new Date().toISOString()
        : typeof at === "string"
          ? at
          : at.toISOString();
    const event = {
      eventId: crypto.randomUUID(),
      traceId: this.ctx.traceId,
      runId: this.ctx.runId,
      timestamp,
      agentName: this.ctx.agentName,
      userId: this.ctx.userId,
      stepIndex: this.nextStepIndex++,
      metadata: this.buildMetadata(metadata),
      ...rest,
    } as CaptureEvent;
    this.ctx.enqueue(event);
  }

  /** Merge trace-level tags into `metadata.tags` without mutating caller input. */
  private buildMetadata(metadata: Metadata | undefined): Metadata {
    const base: Metadata = { ...(metadata ?? {}) };
    if (this.ctx.tags) {
      const existing =
        typeof base.tags === "object" && base.tags !== null
          ? (base.tags as Record<string, unknown>)
          : {};
      base.tags = { ...this.ctx.tags, ...existing };
    }
    return base;
  }
}
