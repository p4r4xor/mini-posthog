import { z } from "zod";
import { Id, IsoTimestamp, Metadata } from "./common.js";

/**
 * The wire DTO: what the SDK sends to `POST /capture`. This is the public
 * ingestion contract — versioned, validated at the edge, and stable.
 *
 * It is a discriminated union on `eventType`. Each variant carries exactly the
 * fields that make sense for it; the type system + Zod enforce that, e.g., an
 * `llm_call` cannot be missing token counts and a `run_completed` cannot carry an
 * independent `costUsd` (that would double-count — see docs/architecture.md §5).
 *
 * `projectId` is intentionally NOT on the wire: it is resolved server-side from
 * the API key and stamped onto the storage row.
 */

/** Fields common to every event. `agentName`/`userId` are denormalized per event. */
const envelope = {
  eventId: Id,
  traceId: Id,
  runId: Id,
  timestamp: IsoTimestamp,
  agentName: Id,
  userId: Id,
  /** Ordinal within the run; resets per run. */
  stepIndex: z.number().int().nonnegative(),
  metadata: Metadata.default({}),
};

/** A run begins: carries the user prompt. */
export const RunStartedEvent = z
  .object({
    ...envelope,
    eventType: z.literal("run_started"),
    status: z.literal("running"),
    input: z.string(),
  })
  .strict();

/** A single LLM call. Tokens + cost are required and additive at this grain. */
export const LlmCallEvent = z
  .object({
    ...envelope,
    eventType: z.literal("llm_call"),
    model: Id,
    status: z.enum(["success", "failed"]),
    latencyMs: z.number().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative(),
  })
  .strict();

/** A single tool call. `costUsd` is optional (most tools are free). */
export const ToolCallEvent = z
  .object({
    ...envelope,
    eventType: z.literal("tool_call"),
    toolName: Id,
    status: z.enum(["success", "failed"]),
    latencyMs: z.number().nonnegative(),
    costUsd: z.number().nonnegative().optional(),
  })
  .strict();

/** An intermediate reasoning/processing step that completed. */
export const StepCompletedEvent = z
  .object({
    ...envelope,
    eventType: z.literal("step_completed"),
    latencyMs: z.number().nonnegative().optional(),
  })
  .strict();

/** An error. May be associated with a tool. */
export const ErrorEvent = z
  .object({
    ...envelope,
    eventType: z.literal("error"),
    status: z.literal("failed"),
    errorType: Id,
    toolName: Id.optional(),
    message: z.string().optional(),
    latencyMs: z.number().nonnegative().optional(),
  })
  .strict();

/** A step-level retry (re-attempt of one tool/LLM call). */
export const RetryEvent = z
  .object({
    ...envelope,
    eventType: z.literal("retry"),
    attempt: z.number().int().positive(),
    toolName: Id.optional(),
    status: z.enum(["success", "failed"]).optional(),
    latencyMs: z.number().nonnegative().optional(),
  })
  .strict();

/**
 * A run ends. Carries only the outcome + optional output. Deliberately NO
 * cost/latency/token fields: rollup totals are derived from the constituent
 * events, so terminal events never carry summable measures.
 */
export const RunCompletedEvent = z
  .object({
    ...envelope,
    eventType: z.literal("run_completed"),
    status: z.enum(["success", "failed"]),
    output: z.string().optional(),
  })
  .strict();

export const CaptureEvent = z.discriminatedUnion("eventType", [
  RunStartedEvent,
  LlmCallEvent,
  ToolCallEvent,
  StepCompletedEvent,
  ErrorEvent,
  RetryEvent,
  RunCompletedEvent,
]);
export type CaptureEvent = z.infer<typeof CaptureEvent>;

export type RunStartedEvent = z.infer<typeof RunStartedEvent>;
export type LlmCallEvent = z.infer<typeof LlmCallEvent>;
export type ToolCallEvent = z.infer<typeof ToolCallEvent>;
export type StepCompletedEvent = z.infer<typeof StepCompletedEvent>;
export type ErrorEvent = z.infer<typeof ErrorEvent>;
export type RetryEvent = z.infer<typeof RetryEvent>;
export type RunCompletedEvent = z.infer<typeof RunCompletedEvent>;

/** The body of a `POST /capture` request: a batch of events. */
export const CaptureRequest = z.object({
  events: z.array(CaptureEvent).min(1).max(1000),
});
export type CaptureRequest = z.infer<typeof CaptureRequest>;

/** Per-event ingestion result (partial-success / 207-style response). */
export const CaptureEventResult = z.object({
  eventId: Id,
  status: z.enum(["accepted", "duplicate", "rejected"]),
  error: z.string().optional(),
});
export type CaptureEventResult = z.infer<typeof CaptureEventResult>;

export const CaptureResponse = z.object({
  accepted: z.number().int().nonnegative(),
  duplicates: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  results: z.array(CaptureEventResult),
});
export type CaptureResponse = z.infer<typeof CaptureResponse>;
