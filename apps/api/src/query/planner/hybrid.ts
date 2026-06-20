import { QueryPlan, type TimeRange } from "@ata/contracts";
import { matchDeterministic } from "./deterministic.js";
import { defaultLlmPlanner } from "./llm.js";
import {
  type PlanContext,
  type PlanOptions,
  type PlanResult,
  SUPPORTED_QUESTIONS,
} from "./types.js";

/**
 * The hybrid planner (docs/architecture.md §10).
 *
 * Pipeline: deterministic templates → constrained LLM fallback → reject.
 *
 * SAFETY BOUNDARY: every candidate plan — whether from a template or the LLM —
 * is run through `QueryPlan.safeParse` before it is returned. The LLM only fills
 * slots; nothing unvalidated ever reaches the compiler/engine. All LLM/network
 * errors are caught and converted to a clean rejection, never re-thrown.
 */

const DEFAULT_LOOKBACK_DAYS = 7;

function reject(reason: string): PlanResult {
  return { ok: false, reason, supported: [...SUPPORTED_QUESTIONS] };
}

/** Resolve the time window: explicit override, else `now − lookback → now`. */
function resolveTimeRange(opts: PlanOptions, now: Date): TimeRange {
  if (opts.timeRange) return opts.timeRange;
  const days = opts.defaultLookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return { from: from.toISOString(), to: now.toISOString() };
}

/**
 * Translate a natural-language question into a validated QueryPlan.
 *
 * Never throws on bad NL or model output — returns `{ ok: false, ... }` with the
 * supported catalog instead.
 */
export async function planQuery(nl: string, opts: PlanOptions = {}): Promise<PlanResult> {
  const now = opts.now ?? new Date();
  const timeRange = resolveTimeRange(opts, now);
  const ctx: PlanContext = { now, timeRange };

  // 1) Deterministic templates first.
  const deterministic = matchDeterministic(nl, ctx);
  if (deterministic) {
    const parsed = QueryPlan.safeParse(deterministic);
    if (parsed.success) {
      return { ok: true, plan: parsed.data, source: "deterministic" };
    }
    // A template produced an invalid plan — a bug, but never throw at callers.
    return reject("Internal: the matched template produced an invalid plan.");
  }

  // 2) LLM fallback (constrained, slot-filling only).
  const llm = opts.llm ?? defaultLlmPlanner();
  if (!llm.available()) {
    return reject(
      "Could not understand the question, and the LLM planner is unavailable.",
    );
  }

  let raw: unknown;
  try {
    raw = await llm.plan(nl, ctx);
  } catch {
    return reject("Could not understand the question (the planner failed).");
  }

  // Inject the resolved time window if the model omitted it (per the prompt).
  const candidate = injectTimeRange(raw, timeRange);

  // 3) Validate — the safety boundary. Off-grammar output is rejected.
  const parsed = QueryPlan.safeParse(candidate);
  if (parsed.success) {
    return { ok: true, plan: parsed.data, source: "llm" };
  }
  return reject("The question does not map to a supported query.");
}

/** Merge the host-resolved time range into a plan-shaped object if absent. */
function injectTimeRange(raw: unknown, timeRange: TimeRange): unknown {
  if (raw === null || typeof raw !== "object") return raw;
  const obj = raw as Record<string, unknown>;
  if (obj.timeRange !== undefined) return raw;
  return { ...obj, timeRange };
}
