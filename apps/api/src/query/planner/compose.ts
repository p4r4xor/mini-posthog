import type { Dimension, Filter, Metric, QueryPlan } from "@ata/contracts";
import type { PlanContext } from "./types.js";

/**
 * General slot-based planner (docs/architecture.md §10).
 *
 * Runs AFTER the exact catalog templates and BEFORE the LLM fallback. Instead of
 * matching whole sentences, it extracts SLOTS from the question —
 *
 *   <agg> <measure> by <dimension> [over <grain>] [failed/successful] [top <N>]
 *
 * — and assembles a valid QueryPlan. One composer covers hundreds of phrasings
 * deterministically (no API key): "total cost by user", "p99 tool latency by
 * tool", "number of llm calls by model", "average run duration by agent",
 * "which models cost the most", etc. The time window is resolved separately by
 * the hybrid layer (parseTimeRange) and injected via `ctx.timeRange`.
 *
 * Anything it can't confidently shape returns null → the hybrid falls through to
 * the LLM (or a clean rejection). The hybrid re-validates every plan with Zod, so
 * a malformed composition is rejected, never executed.
 */

const has = (t: string, ...needles: (string | RegExp)[]): boolean =>
  needles.some((n) => (typeof n === "string" ? t.includes(n) : n.test(t)));

/** A measure mention → its logical field + the grain it's valid at. */
interface MeasureHit {
  field:
    | "latencyMs"
    | "costUsd"
    | "totalTokens"
    | "durationMs"
    | "stepCount"
    | "computeMs";
  grain: "event" | "rollup";
}

function detectMeasure(t: string): MeasureHit | null {
  // Order matters: duration/steps (rollup) before generic latency.
  if (has(t, "duration", "how long", "runtime", "wall clock", "wall-clock"))
    return { field: "durationMs", grain: "rollup" };
  if (has(t, "compute time", "processing time", "time spent"))
    return { field: "computeMs", grain: "rollup" };
  if (has(t, "step", "steps")) return { field: "stepCount", grain: "rollup" };
  if (has(t, "latency", "latencies", "response time", "slow", "fast"))
    return { field: "latencyMs", grain: "event" };
  if (has(t, "cost", "spend", "spending", "usd", "dollar", "expensive", "cheap"))
    return { field: "costUsd", grain: "event" };
  if (has(t, "token", "tokens")) return { field: "totalTokens", grain: "event" };
  return null;
}

/** Aggregation from explicit keywords (else a sensible default per measure). */
function detectAgg(
  t: string,
  field: MeasureHit["field"],
): { agg: Metric["agg"]; p?: number } {
  const pm =
    t.match(/\bp(\d{2,3})\b/) ?? t.match(/(\d{2,3})(?:th|st|nd|rd)?\s*percentile/);
  if (pm) {
    const n = Number(pm[1]);
    if (n > 0 && n < 100) return { agg: "quantile", p: n / 100 };
  }
  if (has(t, "median")) return { agg: "quantile", p: 0.5 };
  if (has(t, "average", "avg", "mean")) return { agg: "avg" };
  if (has(t, "max", "maximum", "highest", "longest", "slowest", "peak", "most expensive"))
    return { agg: "max" };
  if (has(t, "min", "minimum", "lowest", "shortest", "fastest", "cheapest"))
    return { agg: "min" };
  if (has(t, "total", "sum", "overall", "how much")) return { agg: "sum" };
  // Defaults: additive measures sum; latency/duration/steps average.
  if (field === "costUsd" || field === "totalTokens") return { agg: "sum" };
  return { agg: "avg" };
}

/** Categorical group-by dimension, if any. */
function detectCategorical(t: string): Dimension | null {
  // "error type" / "event type" first so "errors by error type" isn't caught as a
  // bare entity below.
  if (has(t, "error type", "by errortype")) return "errorType";
  if (has(t, "event type", "by eventtype")) return "eventType";
  if (has(t, "by outcome", "per outcome")) return "outcome";
  if (has(t, "by status", "per status")) return "status";
  // Bare plural / "which X" also implies a group-by, not just "by X".
  if (has(t, "by model", "per model", "which model", "models", "each model"))
    return "model";
  if (has(t, "by tool", "per tool", "which tool", "tools", "each tool"))
    return "toolName";
  if (has(t, "by agent", "per agent", "agent type", "which agent", "agents"))
    return "agentName";
  if (has(t, "by user", "per user", "which user", "users")) return "userId";
  return null;
}

/** Time-bucket grain, if the question asks for a time series. */
function detectGrain(
  t: string,
): "second" | "minute" | "hour" | "day" | "week" | "month" | null {
  if (has(t, "per second", "by second", "each second", "secondly")) return "second";
  if (has(t, "per minute", "by minute", "minutely")) return "minute";
  if (has(t, "per month", "by month", "monthly", "each month")) return "month";
  if (has(t, "per week", "by week", "weekly", "each week")) return "week";
  if (has(t, "per day", "by day", "daily", "each day")) return "day";
  if (has(t, "per hour", "by hour", "hourly", "each hour")) return "hour";
  if (has(t, "over time", "time series", "timeseries", "trend")) return "hour";
  return null;
}

/** Restrict to the event type a measure/dimension implies (keeps results clean). */
function eventTypeFilter(
  t: string,
  field: MeasureHit["field"],
  dim: Dimension | null,
): Filter | null {
  const v = (value: string): Filter => ({ field: "eventType", op: "eq", value });
  // The group-by dimension implies the event type that carries it: `model` is set
  // only on llm_call, `toolName` only on tool/error/retry — scoping avoids a null
  // bucket (e.g. "cost by model" summing non-LLM events into a null group).
  if (dim === "model") return v("llm_call");
  if (dim === "toolName") return v("tool_call");
  if (field === "totalTokens") return v("llm_call");
  if (field === "latencyMs") {
    if (has(t, "tool")) return v("tool_call");
    if (has(t, "llm")) return v("llm_call");
  }
  if (has(t, "llm call", "llm calls")) return v("llm_call");
  if (has(t, "tool call", "tool calls")) return v("tool_call");
  return null;
}

/** "top N" / ranking → sort+limit; null when the order isn't a ranking. */
function detectRanking(t: string): { dir: "asc" | "desc"; limit: number } | null {
  const topN = t.match(/\b(?:top|first|bottom)\s+(\d+)\b/);
  const limit = topN ? Number(topN[1]) : 10;
  if (
    has(
      t,
      "top",
      "most",
      "highest",
      "worst",
      "biggest",
      "largest",
      "slowest",
      "expensive",
    )
  )
    return { dir: "desc", limit };
  if (has(t, "least", "lowest", "fewest", "smallest", "fastest", "cheapest"))
    return { dir: "asc", limit };
  return null;
}

export function composePlan(text: string, ctx: PlanContext): QueryPlan | null {
  const t = text;

  const measure = detectMeasure(t);
  const categorical = detectCategorical(t);
  const grain = detectGrain(t);

  // Count intent: explicit ("number of …") or an entity noun being tallied
  // ("errors by error type", "retries by tool") when there's no measure.
  const countNoun = has(
    t,
    "errors",
    "error",
    "retries",
    "retry",
    "llm call",
    "llm calls",
    "tool call",
    "tool calls",
    "requests",
    "events",
  );
  const countIntent =
    has(t, "number of", "how many", "count of", "volume", "throughput") ||
    (!measure && countNoun);
  if (!measure && !countIntent) return null;

  const dimensions: Dimension[] = [];
  if (categorical) dimensions.push(categorical);
  if (grain) dimensions.push({ time: grain });

  const filters: Filter[] = [];
  // failed / successful scoping (status at event grain, outcome at run/trace).
  const failed = has(t, "failed", "failing", "failure", "errored");
  const success = has(t, "successful", "succeeded", "success");

  let metric: Metric;
  let level: QueryPlan["level"] = "event";

  if (!measure) {
    // Count / volume of an entity: count_distinct the entity, else a plain count.
    if (/\bruns?\b/.test(t)) metric = { agg: "count_distinct", field: "runId" };
    else if (/\btraces?\b/.test(t)) metric = { agg: "count_distinct", field: "traceId" };
    else if (/\busers?\b/.test(t)) metric = { agg: "count_distinct", field: "userId" };
    else metric = { agg: "count" };
    if (has(t, "error", "errors"))
      filters.push({ field: "eventType", op: "eq", value: "error" });
    else if (has(t, "retry", "retries"))
      filters.push({ field: "eventType", op: "eq", value: "retry" });
    else if (has(t, "llm call", "llm calls"))
      filters.push({ field: "eventType", op: "eq", value: "llm_call" });
    else if (has(t, "tool call", "tool calls"))
      filters.push({ field: "eventType", op: "eq", value: "tool_call" });
  } else {
    const m = measure;
    // Grain: rollup measures read runs (or traces if the question says "trace").
    if (m.grain === "rollup") {
      level = has(t, "trace", "traces") ? "trace" : "run";
    } else if (
      has(t, "per run", "by run", "each run") &&
      (m.field === "costUsd" || m.field === "totalTokens")
    ) {
      level = "run";
    }
    const { agg, p } = detectAgg(t, m.field);
    metric = p !== undefined ? { agg, field: m.field, p } : { agg, field: m.field };
    // event-type scoping only at event grain (rollup columns have no eventType).
    if (level === "event") {
      const et = eventTypeFilter(t, m.field, categorical);
      if (et) filters.push(et);
    }
  }

  // status / outcome scoping.
  if (failed && !success) {
    filters.push(
      level === "event"
        ? { field: "status", op: "eq", value: "failed" }
        : { field: "outcome", op: "eq", value: "failed" },
    );
  } else if (success && !failed) {
    filters.push(
      level === "event"
        ? { field: "status", op: "eq", value: "success" }
        : { field: "outcome", op: "eq", value: "success" },
    );
  }

  // sort + limit.
  const ranking = detectRanking(t);
  let sort: QueryPlan["sort"];
  let limit: number | undefined;
  if (grain) {
    sort = { by: "time", dir: "asc" }; // time series read chronologically
  } else if (ranking && categorical) {
    sort = { by: "metric", dir: ranking.dir };
    limit = ranking.limit;
  }

  const chartHint: QueryPlan["chartHint"] = grain
    ? "line"
    : categorical
      ? "bar"
      : "table";

  const plan: QueryPlan = {
    level,
    metric,
    dimensions,
    filters,
    timeRange: ctx.timeRange,
    chartHint,
    ...(sort ? { sort } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
  return plan;
}
