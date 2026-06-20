import {
  CATEGORICAL_DIMENSIONS,
  DISTINCT_FIELDS,
  EVENT_MEASURES,
  EVENT_STATUSES,
  EVENT_TYPES,
  FILTERABLE_FIELDS,
  OUTCOMES,
  ROLLUP_MEASURES,
  TIME_GRAINS,
} from "@ata/contracts";

/**
 * The LLM planner whitelist prompt + the hand-written JSON Schema for the
 * forced tool call (docs/architecture.md §10, step 2).
 *
 * The schema mirrors the QueryPlan Zod contract closely enough to steer the
 * model, but it is NOT the source of truth — the hybrid layer re-validates with
 * `QueryPlan.safeParse`. This file only constrains; it never trusts.
 */

export const EMIT_TOOL_NAME = "emit_query_plan";

/** Default model id; overridable via the LlmPlanner config. */
export const DEFAULT_MODEL = "claude-sonnet-4-6";

/** System prompt enumerating the closed grammar the model may emit. */
export function buildSystemPrompt(): string {
  return [
    "You translate a natural-language analytics question into a closed, typed",
    "QueryPlan for an AI-agent trace-analytics engine. You do NOT write SQL or",
    "code. You ONLY call the `emit_query_plan` tool with values drawn from the",
    "whitelists below. If the question cannot be expressed within this grammar,",
    "still call the tool with your best valid attempt — never invent fields.",
    "",
    "GRAINS (level): event | run | trace.",
    `  - event: reads raw events. Measures: ${EVENT_MEASURES.join(", ")}.`,
    `  - run/trace: reads rollups. Measures: ${ROLLUP_MEASURES.join(", ")}.`,
    "  - latencyMs is EVENT grain only; durationMs/computeMs/stepCount are run/trace grain only.",
    "",
    "AGGREGATIONS (metric.agg): count, count_distinct, sum, avg, min, max, ratio, quantile.",
    "  - count needs no field.",
    `  - count_distinct.field must be one of: ${DISTINCT_FIELDS.join(", ")}.`,
    "  - sum/avg/min/max require metric.field (a measure valid at the chosen grain).",
    "  - quantile requires metric.field (a numeric measure) AND metric.p in (0,1),",
    "    e.g. p95 latency → { agg: 'quantile', field: 'latencyMs', p: 0.95 }.",
    "  - ratio requires metric.ratio { numerator: Filter[], denominator: Filter[] }",
    "    and no metric.field; it computes countIf(numerator)/countIf(denominator).",
    "",
    "DIMENSIONS (group-by): categorical one of [" +
      CATEGORICAL_DIMENSIONS.join(", ") +
      "], or a time bucket { time: <grain> } where grain ∈ [" +
      TIME_GRAINS.join(", ") +
      "].",
    "",
    `FILTERS: { field, op, value }. field ∈ [${FILTERABLE_FIELDS.join(", ")}].`,
    "  op ∈ [eq, neq, in, gt, gte, lt, lte]. Known enum values:",
    `  eventType ∈ [${EVENT_TYPES.join(", ")}];`,
    `  status ∈ [${EVENT_STATUSES.join(", ")}];`,
    `  outcome ∈ [${OUTCOMES.join(", ")}].`,
    "",
    "OTHER: sort { by: 'metric'|'time'|<categorical dim>, dir: 'asc'|'desc' } (optional);",
    "  limit (optional positive int); chartHint ∈ [line, bar, table] (required).",
    "  Use 'line' for time-series, 'bar' for categorical breakdowns, 'table' for detail.",
    "  Do NOT set timeRange — the host injects it.",
  ].join("\n");
}

/** Hand-written JSON Schema mirroring QueryPlan, used as the tool input schema. */
export function buildInputSchema(): Record<string, unknown> {
  const filterSchema = {
    type: "object",
    additionalProperties: false,
    required: ["field", "op", "value"],
    properties: {
      field: { type: "string", enum: [...FILTERABLE_FIELDS] },
      op: { type: "string", enum: ["eq", "neq", "in", "gt", "gte", "lt", "lte"] },
      value: {
        anyOf: [
          { type: "string" },
          { type: "number" },
          { type: "boolean" },
          { type: "array", items: { type: "string" } },
          { type: "array", items: { type: "number" } },
        ],
      },
    },
  };

  const dimensionSchema = {
    anyOf: [
      { type: "string", enum: [...CATEGORICAL_DIMENSIONS] },
      {
        type: "object",
        additionalProperties: false,
        required: ["time"],
        properties: { time: { type: "string", enum: [...TIME_GRAINS] } },
      },
    ],
  };

  return {
    type: "object",
    additionalProperties: false,
    required: ["level", "metric", "chartHint"],
    properties: {
      level: { type: "string", enum: ["event", "run", "trace"] },
      metric: {
        type: "object",
        additionalProperties: false,
        required: ["agg"],
        properties: {
          agg: {
            type: "string",
            enum: [
              "count",
              "count_distinct",
              "sum",
              "avg",
              "min",
              "max",
              "ratio",
              "quantile",
            ],
          },
          field: {
            type: "string",
            enum: [
              ...new Set<string>([
                ...EVENT_MEASURES,
                ...ROLLUP_MEASURES,
                ...DISTINCT_FIELDS,
              ]),
            ],
          },
          p: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 1 },
          ratio: {
            type: "object",
            additionalProperties: false,
            required: ["numerator"],
            properties: {
              numerator: { type: "array", minItems: 1, items: filterSchema },
              denominator: { type: "array", items: filterSchema },
            },
          },
        },
      },
      dimensions: { type: "array", items: dimensionSchema },
      filters: { type: "array", items: filterSchema },
      sort: {
        type: "object",
        additionalProperties: false,
        required: ["by", "dir"],
        properties: {
          by: {
            anyOf: [
              { type: "string", enum: ["metric", "time"] },
              { type: "string", enum: [...CATEGORICAL_DIMENSIONS] },
            ],
          },
          dir: { type: "string", enum: ["asc", "desc"] },
        },
      },
      limit: { type: "integer", minimum: 1, maximum: 10000 },
      chartHint: { type: "string", enum: ["line", "bar", "table"] },
    },
  };
}
