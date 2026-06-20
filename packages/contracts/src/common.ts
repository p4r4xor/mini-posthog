import { z } from "zod";

/**
 * Shared primitives and enums used across every contract layer.
 * Keeping them in one place means the SDK, ingestion, query, and storage layers
 * all agree on the same vocabulary (event types, statuses, time grains).
 */

/** Event types in our model. Lifecycle is per-RUN (see docs/architecture.md §3). */
export const EVENT_TYPES = [
  "run_started",
  "llm_call",
  "tool_call",
  "step_completed",
  "error",
  "retry",
  "run_completed",
] as const;
export const EventType = z.enum(EVENT_TYPES);
export type EventType = z.infer<typeof EventType>;

/** Per-event operation status. */
export const EVENT_STATUSES = ["running", "success", "failed"] as const;
export const EventStatus = z.enum(EVENT_STATUSES);
export type EventStatus = z.infer<typeof EventStatus>;

/** Derived outcome of a run or trace (never "running" once terminal). */
export const OUTCOMES = ["success", "failed", "running"] as const;
export const Outcome = z.enum(OUTCOMES);
export type Outcome = z.infer<typeof Outcome>;

/** Time bucket granularity for time-series queries. */
export const TIME_GRAINS = ["second", "minute", "hour", "day", "week", "month"] as const;
export const TimeGrain = z.enum(TIME_GRAINS);
export type TimeGrain = z.infer<typeof TimeGrain>;

/** ISO-8601 timestamp with offset (e.g. "2026-05-07T09:12:30.123Z"). */
export const IsoTimestamp = z.iso.datetime({ offset: true });
export type IsoTimestamp = z.infer<typeof IsoTimestamp>;

/** A non-empty identifier string. */
export const Id = z.string().min(1);

/** Free-form metadata bag — the JSON tail of the wide-event model. */
export const Metadata = z.record(z.string(), z.unknown());
export type Metadata = z.infer<typeof Metadata>;
