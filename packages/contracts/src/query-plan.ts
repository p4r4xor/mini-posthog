import { z } from "zod";
import { IsoTimestamp, TimeGrain } from "./common.js";

/**
 * QueryPlan - the typed intermediate representation between NL translation and the
 * query engine (docs/architecture.md §9).
 *
 * We NEVER let natural language or an LLM produce SQL. A translator (deterministic
 * or LLM) only fills the slots of this closed, validated structure; a single
 * compiler is the only thing that renders SQL, from an already-validated plan, with
 * bound parameters. Every field is an enum or a whitelisted name, so there is no
 * injection surface, and one plan compiles to both DuckDB and ClickHouse.
 *
 * The two sides (planner, compiler) depend ONLY on this type and never on each
 * other - so each is testable in isolation.
 */

/** What one row represents before aggregation. Selects the source table. */
export const QueryLevel = z.enum(["event", "run", "trace"]);
export type QueryLevel = z.infer<typeof QueryLevel>;

export const Aggregation = z.enum([
  "count",
  "count_distinct",
  "sum",
  "avg",
  "min",
  "max",
  "ratio",
  "quantile",
]);
export type Aggregation = z.infer<typeof Aggregation>;

/** Measures valid at the EVENT grain (per-operation values stored on the row). */
export const EVENT_MEASURES = [
  "latencyMs",
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "costUsd",
] as const;

/** Measures valid at the RUN/TRACE grain (derived in rollups, never on raw events). */
export const ROLLUP_MEASURES = [
  "durationMs",
  "computeMs",
  "stepCount",
  "costUsd",
  "totalTokens",
] as const;

/** Identifiers valid as the target of `count_distinct`. */
export const DISTINCT_FIELDS = ["runId", "traceId", "eventId", "userId"] as const;

const MEASURE_FIELDS = [
  ...new Set<string>([...EVENT_MEASURES, ...ROLLUP_MEASURES, ...DISTINCT_FIELDS]),
] as [string, ...string[]];
export const MetricField = z.enum(MEASURE_FIELDS);
export type MetricField = z.infer<typeof MetricField>;

/** Categorical group-by / filter dimensions. */
export const CATEGORICAL_DIMENSIONS = [
  "agentName",
  "model",
  "toolName",
  "status",
  "eventType",
  "userId",
  "errorType",
  "outcome",
] as const;
export const CategoricalDimension = z.enum(CATEGORICAL_DIMENSIONS);
export type CategoricalDimension = z.infer<typeof CategoricalDimension>;

/** A time-bucket dimension, e.g. `{ time: "hour" }`. */
export const TimeDimension = z.object({ time: TimeGrain });
export type TimeDimension = z.infer<typeof TimeDimension>;

export const Dimension = z.union([CategoricalDimension, TimeDimension]);
export type Dimension = z.infer<typeof Dimension>;

export const FilterOp = z.enum(["eq", "neq", "in", "gt", "gte", "lt", "lte"]);
export type FilterOp = z.infer<typeof FilterOp>;

/** Fields a filter may target (dimensions + numeric measures + timestamp). */
export const FILTERABLE_FIELDS = [
  ...CATEGORICAL_DIMENSIONS,
  "latencyMs",
  "costUsd",
  "inputTokens",
  "outputTokens",
  "timestamp",
] as const;
export const FilterField = z.enum(FILTERABLE_FIELDS);
export type FilterField = z.infer<typeof FilterField>;

export const FilterValue = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
  z.array(z.number()),
]);

export const Filter = z.object({
  field: FilterField,
  op: FilterOp,
  value: FilterValue,
});
export type Filter = z.infer<typeof Filter>;

/**
 * A ratio metric: `countIf(numerator) / countIf(denominator)`.
 * e.g. "error rate" = countIf(status=failed) / count(*) (empty denominator = all).
 */
export const RatioSpec = z.object({
  numerator: z.array(Filter).min(1),
  denominator: z.array(Filter).default([]),
});
export type RatioSpec = z.infer<typeof RatioSpec>;

export const Metric = z.object({
  agg: Aggregation,
  field: MetricField.optional(),
  /** Quantile fraction in (0,1) - required when agg is "quantile" (0.95 = p95). */
  p: z.number().gt(0).lt(1).optional(),
  ratio: RatioSpec.optional(),
});
export type Metric = z.infer<typeof Metric>;

export const TimeRange = z.object({ from: IsoTimestamp, to: IsoTimestamp });
export type TimeRange = z.infer<typeof TimeRange>;

/** Sort by the metric, by a named dimension, or by the time bucket. */
export const Sort = z.object({
  by: z.union([z.literal("metric"), z.literal("time"), CategoricalDimension]),
  dir: z.enum(["asc", "desc"]),
});
export type Sort = z.infer<typeof Sort>;

export const ChartHint = z.enum(["line", "bar", "table"]);
export type ChartHint = z.infer<typeof ChartHint>;

const EVENT_MEASURE_SET = new Set<string>(EVENT_MEASURES);
const ROLLUP_MEASURE_SET = new Set<string>(ROLLUP_MEASURES);
const DISTINCT_FIELD_SET = new Set<string>(DISTINCT_FIELDS);
/** Fields meaningful at every grain (so they don't trip the grain checks). */
const GRAIN_AGNOSTIC = new Set<string>(["costUsd", "totalTokens"]);

export const QueryPlan = z
  .object({
    level: QueryLevel,
    metric: Metric,
    dimensions: z.array(Dimension).default([]),
    filters: z.array(Filter).default([]),
    timeRange: TimeRange,
    sort: Sort.optional(),
    limit: z.number().int().positive().max(10_000).optional(),
    chartHint: ChartHint,
  })
  .superRefine((plan, ctx) => {
    const { agg, field, ratio } = plan.metric;

    // ratio ⇒ must carry a ratio spec, and nothing else makes sense
    if (agg === "ratio" && !ratio) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["metric", "ratio"],
        message: "ratio metric requires metric.ratio { numerator, denominator }",
      });
    }
    if (agg !== "ratio" && ratio) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["metric", "ratio"],
        message: "metric.ratio is only valid when agg is 'ratio'",
      });
    }

    // count needs no field; ratio uses predicates; everything else needs a field
    if (agg !== "count" && agg !== "ratio" && !field) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["metric", "field"],
        message: `agg '${agg}' requires metric.field`,
      });
    }

    // quantile needs p in (0,1) over a numeric measure; p is meaningless elsewhere
    if (agg === "quantile") {
      if (plan.metric.p === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["metric", "p"],
          message: "quantile metric requires metric.p in (0,1), e.g. 0.95 for p95",
        });
      }
      if (field && DISTINCT_FIELD_SET.has(field)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["metric", "field"],
          message: "quantile requires a numeric measure field, not an identifier",
        });
      }
    } else if (plan.metric.p !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["metric", "p"],
        message: "metric.p is only valid when agg is 'quantile'",
      });
    }

    if (agg === "count_distinct" && field && !DISTINCT_FIELD_SET.has(field)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["metric", "field"],
        message: `count_distinct field must be one of ${DISTINCT_FIELDS.join(", ")}`,
      });
    }

    // Grain compatibility: this is how "queries that don't fit the model" fail
    // structurally instead of silently returning wrong numbers.
    if (field && !GRAIN_AGNOSTIC.has(field) && !DISTINCT_FIELD_SET.has(field)) {
      const isEventMeasure = EVENT_MEASURE_SET.has(field);
      const isRollupMeasure = ROLLUP_MEASURE_SET.has(field);
      if (plan.level === "event" && isRollupMeasure && !isEventMeasure) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["metric", "field"],
          message: `'${field}' is a run/trace-level measure and cannot be used at level 'event'`,
        });
      }
      if (plan.level !== "event" && isEventMeasure && !isRollupMeasure) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["metric", "field"],
          message: `'${field}' is an event-level measure and cannot be used at level '${plan.level}'`,
        });
      }
    }
  });
export type QueryPlan = z.infer<typeof QueryPlan>;
