import type { QueryPlan } from "@ata/contracts";
import type { PlanContext } from "./types.js";

/**
 * Deterministic template planner (docs/architecture.md §10, step 1).
 *
 * Runs FIRST: free, offline, fast. Normalized keyword/regex matching maps the
 * §9 catalog questions — plus reasonable phrasings — onto fully-formed
 * QueryPlans. Returns `null` when no template matches so the hybrid layer can
 * fall through to the LLM.
 *
 * Every template returns a structurally-valid QueryPlan; the hybrid layer still
 * re-validates with the Zod schema (single safety boundary, no special cases).
 */

/** Lowercase, collapse whitespace, strip most punctuation for stable matching. */
function normalize(nl: string): string {
  return nl
    .toLowerCase()
    .replace(/[^a-z0-9%\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** True if every token/regex in `needles` is present in the normalized text. */
function has(text: string, ...needles: (string | RegExp)[]): boolean {
  return needles.every((n) => (typeof n === "string" ? text.includes(n) : n.test(text)));
}

/** True if any of the alternatives is present. */
function hasAny(text: string, ...needles: (string | RegExp)[]): boolean {
  return needles.some((n) => (typeof n === "string" ? text.includes(n) : n.test(text)));
}

type Template = (text: string, ctx: PlanContext) => QueryPlan | null;

/**
 * Percentile latency (p50/p90/p95/p99 or "median") → event, quantile(latencyMs).
 * Ordered before the avg template so "p95 latency by model" maps to a quantile.
 */
const percentileLatency: Template = (text, ctx) => {
  const isLatency = hasAny(text, "latency", "latencies");
  if (!isLatency) return null;

  let p: number | null = null;
  const m = text.match(/\bp(\d{2,3})\b/) ?? text.match(/(\d{2,3})th percentile/);
  if (m?.[1]) {
    const n = Number(m[1]);
    if (n > 0 && n < 100) p = n / 100;
  } else if (hasAny(text, "median")) {
    p = 0.5;
  } else if (has(text, "percentile")) {
    p = 0.95;
  }
  if (p === null) return null;

  const byModel = has(text, "model");
  const byTool = has(text, "tool");
  const overTime = hasAny(text, "over time", /per (hour|day|minute)/, "trend");

  const dimensions: QueryPlan["dimensions"] = [];
  if (byModel) dimensions.push("model");
  if (byTool) dimensions.push("toolName");
  if (overTime) dimensions.push({ time: "hour" });

  const eventType = byTool && !byModel ? "tool_call" : "llm_call";

  return {
    level: "event",
    metric: { agg: "quantile", field: "latencyMs", p },
    dimensions,
    filters: [{ field: "eventType", op: "eq", value: eventType }],
    timeRange: ctx.timeRange,
    sort: overTime ? { by: "time", dir: "asc" } : { by: "metric", dir: "desc" },
    chartHint: overTime ? "line" : "bar",
  };
};

/** Avg LLM latency by model over time → event, avg(latencyMs), [model, time(hour)], line. */
const avgLlmLatencyByModelOverTime: Template = (text, ctx) => {
  const isLatency = hasAny(text, "latency", "latencies");
  const byModel = has(text, "model");
  const overTime = hasAny(
    text,
    "over time",
    "time series",
    "timeseries",
    "trend",
    /per (hour|day|minute)/,
  );
  if (isLatency && byModel && overTime) {
    return {
      level: "event",
      metric: { agg: "avg", field: "latencyMs" },
      dimensions: ["model", { time: "hour" }],
      filters: [{ field: "eventType", op: "eq", value: "llm_call" }],
      timeRange: ctx.timeRange,
      sort: { by: "time", dir: "asc" },
      chartHint: "line",
    };
  }
  return null;
};

/** Which tools fail the most / top failing tools → event, count, toolName, status=failed, count↓ 10, bar. */
const topFailingTools: Template = (text, ctx) => {
  const aboutTools = has(text, "tool");
  const aboutFailure = hasAny(
    text,
    "fail",
    "failing",
    "failures",
    "error",
    "errors",
    "broken",
  );
  const ranking = hasAny(text, "most", "top", "worst", "which");
  if (aboutTools && aboutFailure && ranking) {
    return {
      level: "event",
      metric: { agg: "count" },
      dimensions: ["toolName"],
      // Scope to tool_call events so failed non-tool events (e.g. failed
      // llm_calls, run-fatal errors with no tool) don't bucket under a null tool.
      filters: [
        { field: "eventType", op: "eq", value: "tool_call" },
        { field: "status", op: "eq", value: "failed" },
      ],
      timeRange: ctx.timeRange,
      sort: { by: "metric", dir: "desc" },
      limit: 10,
      chartHint: "bar",
    };
  }
  return null;
};

/** Token usage by agent (type) → event, sum(totalTokens), agentName, bar. */
const tokenUsageByAgent: Template = (text, ctx) => {
  const aboutTokens = hasAny(text, "token", "tokens", "token usage");
  const byAgent = hasAny(text, "agent", "agent type", "by agent");
  if (aboutTokens && byAgent) {
    return {
      level: "event",
      metric: { agg: "sum", field: "totalTokens" },
      dimensions: ["agentName"],
      filters: [],
      timeRange: ctx.timeRange,
      chartHint: "bar",
    };
  }
  return null;
};

/** Cost per successful run by model → run, avg(costUsd), model, outcome=success, bar. */
const costPerSuccessfulRunByModel: Template = (text, ctx) => {
  const aboutCost = hasAny(text, "cost", "spend", "spending", "usd", "dollars");
  const perRun = hasAny(text, "run", "runs");
  const byModel = has(text, "model");
  const successful = hasAny(text, "success", "successful", "succeeded");
  if (aboutCost && perRun && byModel && successful) {
    return {
      level: "run",
      metric: { agg: "avg", field: "costUsd" },
      dimensions: ["model"],
      filters: [{ field: "outcome", op: "eq", value: "success" }],
      timeRange: ctx.timeRange,
      chartHint: "bar",
    };
  }
  return null;
};

/** Top 10 slowest traces → trace, max(durationMs), no dims, dur↓ 10, table. */
const slowestTraces: Template = (text, ctx) => {
  const aboutTraces = hasAny(text, "trace", "traces");
  const slow = hasAny(
    text,
    "slow",
    "slowest",
    "longest",
    "slowest traces",
    /longest (running|duration)/,
  );
  if (aboutTraces && slow) {
    return {
      level: "trace",
      metric: { agg: "max", field: "durationMs" },
      dimensions: [],
      filters: [],
      timeRange: ctx.timeRange,
      sort: { by: "metric", dir: "desc" },
      limit: 10,
      chartHint: "table",
    };
  }
  return null;
};

/** Error rate by tool → event, ratio(status=failed / all), toolName, bar. */
const errorRateByTool: Template = (text, ctx) => {
  const aboutErrorRate = has(text, /error rate|failure rate|fail rate/);
  const byTool = has(text, "tool");
  if (aboutErrorRate && byTool) {
    return {
      level: "event",
      metric: {
        agg: "ratio",
        ratio: {
          numerator: [{ field: "status", op: "eq", value: "failed" }],
          denominator: [],
        },
      },
      dimensions: ["toolName"],
      // Scope to tool_call events: error rate = failed tool_calls / all tool_calls
      // per tool, so non-tool failures don't appear under a null tool bucket.
      filters: [{ field: "eventType", op: "eq", value: "tool_call" }],
      timeRange: ctx.timeRange,
      chartHint: "bar",
    };
  }
  return null;
};

/** Number of runs per hour → event, count_distinct(runId), time(hour), time↑, line. */
const runsPerHour: Template = (text, ctx) => {
  const aboutRuns = hasAny(text, "run", "runs");
  const perHour = hasAny(text, "per hour", "hourly", "by hour", "each hour");
  const counting = hasAny(
    text,
    "number",
    "count",
    "how many",
    "volume",
    "throughput",
    "per hour",
    "hourly",
  );
  if (aboutRuns && perHour && counting) {
    return {
      level: "event",
      metric: { agg: "count_distinct", field: "runId" },
      dimensions: [{ time: "hour" }],
      filters: [],
      timeRange: ctx.timeRange,
      sort: { by: "time", dir: "asc" },
      chartHint: "line",
    };
  }
  return null;
};

/** Average steps per run by outcome → run, avg(stepCount), outcome, bar. */
const avgStepsPerRunByOutcome: Template = (text, ctx) => {
  const aboutSteps = hasAny(text, "step", "steps");
  const perRun = hasAny(text, "run", "runs", "per run");
  const byOutcome = hasAny(text, "outcome", "by outcome", "result");
  if (aboutSteps && perRun && byOutcome) {
    return {
      level: "run",
      metric: { agg: "avg", field: "stepCount" },
      dimensions: ["outcome"],
      filters: [],
      timeRange: ctx.timeRange,
      chartHint: "bar",
    };
  }
  return null;
};

/**
 * Ordered list of templates. Order matters where phrasings overlap: the more
 * specific "error rate by tool" must run before the broader "top failing tools".
 */
const TEMPLATES: Template[] = [
  percentileLatency,
  avgLlmLatencyByModelOverTime,
  errorRateByTool,
  topFailingTools,
  tokenUsageByAgent,
  costPerSuccessfulRunByModel,
  slowestTraces,
  runsPerHour,
  avgStepsPerRunByOutcome,
];

/**
 * Try every template in order; return the first QueryPlan that matches, or
 * `null` if the NL doesn't map to any known catalog pattern.
 */
export function matchDeterministic(nl: string, ctx: PlanContext): QueryPlan | null {
  const text = normalize(nl);
  if (text.length === 0) return null;
  for (const template of TEMPLATES) {
    const plan = template(text, ctx);
    if (plan) return plan;
  }
  return null;
}
