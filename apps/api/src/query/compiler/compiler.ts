import { z } from "zod";
import {
  QueryPlan as QueryPlanSchema,
  type QueryPlan,
  type Filter,
  type QueryLevel,
} from "@ata/contracts";
import type {
  CompiledQuery,
  CompiledMetric,
  CompiledGroupKey,
  CompiledPredicate,
  SourceTable,
} from "@ata/contracts";
import { isTimeDimension } from "./chart.js";

/**
 * The pre-parse input shape: `dimensions`/`filters`/ratio `denominator` are
 * optional because the schema fills them via `.default([])`. Accepting this lets
 * callers hand us a minimal literal; we normalize via `QueryPlan.parse` below.
 */
export type QueryPlanInput = z.input<typeof QueryPlanSchema>;

/**
 * The query compiler (docs/architecture.md §9).
 *
 * It is the ONLY place a validated `QueryPlan` becomes a neutral `CompiledQuery`.
 * It never emits SQL and never imports an engine adapter: every `column` it emits
 * is a LOGICAL field name from the contract vocabulary (e.g. "latencyMs",
 * "model", "timestamp"). Each EventStore adapter owns the logical→physical
 * mapping and the dialect rendering, so one compiled plan serves both DuckDB and
 * ClickHouse.
 */

/** Alias for the single computed measure column in every result. */
const METRIC_ALIAS = "value";
/** Alias/column for a time-bucket group key. */
const BUCKET_ALIAS = "bucket";
const TIMESTAMP_COLUMN = "timestamp";

/** QueryLevel → the logical source table the compiled query reads. */
const LEVEL_TO_SOURCE: Record<QueryLevel, SourceTable> = {
  event: "events",
  run: "runs",
  trace: "traces",
};

/**
 * Compile a validated `QueryPlan` into the neutral `CompiledQuery` IR.
 *
 * The plan is already schema-validated by the caller; we still `QueryPlan.parse`
 * defensively to normalize defaults (e.g. empty `dimensions`/`filters`, empty
 * ratio denominator) and re-assert the cross-field invariants before compiling.
 */
export function compilePlan(plan: QueryPlan | QueryPlanInput): CompiledQuery {
  const normalized: QueryPlan = QueryPlanSchema.parse(plan);

  const source = LEVEL_TO_SOURCE[normalized.level];
  const metric = compileMetric(normalized);
  const groupBy = compileGroupBy(normalized);
  const where = compileWhere(normalized);

  const compiled: CompiledQuery = {
    source,
    metric,
    groupBy,
    where,
  };

  const orderBy = compileOrderBy(normalized);
  if (orderBy) compiled.orderBy = orderBy;
  if (normalized.limit !== undefined) compiled.limit = normalized.limit;

  return compiled;
}

/** metric → CompiledMetric (always aliased "value"). */
function compileMetric(plan: QueryPlan): CompiledMetric {
  const { agg, field, ratio } = plan.metric;

  switch (agg) {
    case "count":
      return { kind: "count", alias: METRIC_ALIAS };

    case "count_distinct":
      return {
        kind: "count_distinct",
        column: requireField(field, agg),
        alias: METRIC_ALIAS,
      };

    case "sum":
    case "avg":
    case "min":
    case "max":
      return {
        kind: "simple",
        fn: agg,
        column: requireField(field, agg),
        alias: METRIC_ALIAS,
      };

    case "ratio": {
      // `ratio` validity (presence of spec) is guaranteed by QueryPlan.parse.
      if (!ratio) {
        throw new Error("ratio metric requires metric.ratio");
      }
      return {
        kind: "ratio",
        numerator: ratio.numerator.map(filterToPredicate),
        denominator: ratio.denominator.map(filterToPredicate),
        alias: METRIC_ALIAS,
      };
    }

    default: {
      // Exhaustiveness guard — unreachable for a validated plan.
      const _never: never = agg;
      throw new Error(`unsupported aggregation: ${String(_never)}`);
    }
  }
}

/** dimensions → groupBy[]: categorical column or a timestamp time-bucket. */
function compileGroupBy(plan: QueryPlan): CompiledGroupKey[] {
  return plan.dimensions.map((dim): CompiledGroupKey => {
    if (isTimeDimension(dim)) {
      return {
        kind: "timeBucket",
        column: TIMESTAMP_COLUMN,
        grain: dim.time,
        alias: BUCKET_ALIAS,
      };
    }
    // Categorical dimension: its name is both the logical column and the alias.
    return { kind: "column", column: dim, alias: dim };
  });
}

/**
 * filters + timeRange → where[]. The plan's `timeRange` is ALWAYS emitted as a
 * dedicated `timeRange` predicate over the logical "timestamp" column, so every
 * compiled query is time-bounded.
 */
function compileWhere(plan: QueryPlan): CompiledPredicate[] {
  const predicates: CompiledPredicate[] = plan.filters.map(filterToPredicate);
  predicates.push({
    kind: "timeRange",
    column: TIMESTAMP_COLUMN,
    from: plan.timeRange.from,
    to: plan.timeRange.to,
  });
  return predicates;
}

/** A single Filter → a `compare` predicate over its logical field. */
function filterToPredicate(filter: Filter): CompiledPredicate {
  return {
    kind: "compare",
    column: filter.field,
    op: filter.op,
    value: filter.value,
  };
}

/**
 * sort → orderBy. The sort key references a result alias:
 *   - "metric"          → the metric alias ("value")
 *   - "time"            → the time-bucket alias ("bucket")
 *   - a dimension name  → that categorical column's alias (its own name)
 */
function compileOrderBy(
  plan: QueryPlan,
): { ref: string; dir: "asc" | "desc" } | undefined {
  const { sort } = plan;
  if (!sort) return undefined;

  let ref: string;
  if (sort.by === "metric") ref = METRIC_ALIAS;
  else if (sort.by === "time") ref = BUCKET_ALIAS;
  else ref = sort.by; // a categorical dimension name

  return { ref, dir: sort.dir };
}

/** Guard: non-count(/ratio) aggregations require a field. */
function requireField(field: string | undefined, agg: string): string {
  if (!field) {
    throw new Error(`aggregation '${agg}' requires metric.field`);
  }
  return field;
}
