import { describe, it, expect } from "vitest";
import { z } from "zod";
import { QueryPlan as QueryPlanSchema } from "@ata/contracts";
import type { CompiledPredicate } from "@ata/contracts";
import { compilePlan, deriveChartHint } from "../../src/query/compiler/index.js";

/**
 * The *input* shape (pre-parse): `dimensions`/`filters` are optional because the
 * schema fills them via `.default([])`. We build catalog plans against this so
 * each inline literal stays minimal yet type-correct.
 */
type QueryPlan = z.input<typeof QueryPlanSchema>;

/**
 * Compiles every query in the §9 supported-query catalog and asserts the
 * resulting CompiledQuery shape. Each QueryPlan is built inline.
 */

const FROM = "2026-06-01T00:00:00.000Z";
const TO = "2026-06-20T00:00:00.000Z";
const timeRange = { from: FROM, to: TO };

/** The time-range predicate that must appear in every compiled query. */
function timeRangePredicate(where: CompiledPredicate[]): CompiledPredicate | undefined {
  return where.find((p) => p.kind === "timeRange");
}

describe("compilePlan — §9 catalog", () => {
  it("1. Avg LLM latency by model over time (event, line)", () => {
    const plan: QueryPlan = {
      level: "event",
      metric: { agg: "avg", field: "latencyMs" },
      dimensions: ["model", { time: "hour" }],
      filters: [{ field: "eventType", op: "eq", value: "llm_call" }],
      timeRange,
      sort: { by: "time", dir: "asc" },
      chartHint: "line",
    };
    const q = compilePlan(plan);

    expect(q.source).toBe("events");
    expect(q.metric).toEqual({ kind: "simple", fn: "avg", column: "latencyMs", alias: "value" });
    expect(q.groupBy).toEqual([
      { kind: "column", column: "model", alias: "model" },
      { kind: "timeBucket", column: "timestamp", grain: "hour", alias: "bucket" },
    ]);
    // where contains the eventType compare AND the always-present timeRange.
    expect(q.where).toContainEqual({ kind: "compare", column: "eventType", op: "eq", value: "llm_call" });
    expect(timeRangePredicate(q.where)).toEqual({
      kind: "timeRange",
      column: "timestamp",
      from: FROM,
      to: TO,
    });
    expect(q.orderBy).toEqual({ ref: "bucket", dir: "asc" });
    expect(q.limit).toBeUndefined();
  });

  it("2. Which tools fail the most (event, bar, top 10)", () => {
    const plan: QueryPlan = {
      level: "event",
      metric: { agg: "count" },
      dimensions: ["toolName"],
      filters: [
        { field: "eventType", op: "eq", value: "tool_call" },
        { field: "status", op: "eq", value: "failed" },
      ],
      timeRange,
      sort: { by: "metric", dir: "desc" },
      limit: 10,
      chartHint: "bar",
    };
    const q = compilePlan(plan);

    expect(q.source).toBe("events");
    expect(q.metric).toEqual({ kind: "count", alias: "value" });
    // count metric produces NO column.
    expect("column" in q.metric).toBe(false);
    expect(q.groupBy).toEqual([{ kind: "column", column: "toolName", alias: "toolName" }]);
    expect(q.orderBy).toEqual({ ref: "value", dir: "desc" });
    expect(q.limit).toBe(10);
    expect(timeRangePredicate(q.where)).toBeDefined();
  });

  it("3. Token usage by agent type (event, bar)", () => {
    const plan: QueryPlan = {
      level: "event",
      metric: { agg: "sum", field: "totalTokens" },
      dimensions: ["agentName"],
      timeRange,
      chartHint: "bar",
    };
    const q = compilePlan(plan);

    expect(q.source).toBe("events");
    expect(q.metric).toEqual({ kind: "simple", fn: "sum", column: "totalTokens", alias: "value" });
    expect(q.groupBy).toEqual([{ kind: "column", column: "agentName", alias: "agentName" }]);
    // No filters → where is exactly the timeRange predicate.
    expect(q.where).toEqual([{ kind: "timeRange", column: "timestamp", from: FROM, to: TO }]);
    expect(q.orderBy).toBeUndefined();
  });

  it("4. Cost per successful run by model (run, bar) — level routes to runs", () => {
    const plan: QueryPlan = {
      level: "run",
      metric: { agg: "avg", field: "costUsd" },
      dimensions: ["model"],
      filters: [{ field: "status", op: "eq", value: "success" }],
      timeRange,
      chartHint: "bar",
    };
    const q = compilePlan(plan);

    expect(q.source).toBe("runs");
    expect(q.metric).toEqual({ kind: "simple", fn: "avg", column: "costUsd", alias: "value" });
    expect(q.groupBy).toEqual([{ kind: "column", column: "model", alias: "model" }]);
    expect(q.where).toContainEqual({ kind: "compare", column: "status", op: "eq", value: "success" });
    expect(timeRangePredicate(q.where)).toBeDefined();
  });

  it("5. Top 10 slowest traces (trace, table) — orderBy + limit", () => {
    // traceId isn't a CATEGORICAL_DIMENSION; the `traces` rollup is already one
    // row per trace, so "top 10 slowest" is max(durationMs), no group-by, sorted
    // by the metric desc with limit 10.
    const plan: QueryPlan = {
      level: "trace",
      metric: { agg: "max", field: "durationMs" },
      dimensions: [],
      timeRange,
      sort: { by: "metric", dir: "desc" },
      limit: 10,
      chartHint: "table",
    };
    const q = compilePlan(plan);

    expect(q.source).toBe("traces");
    expect(q.metric).toEqual({ kind: "simple", fn: "max", column: "durationMs", alias: "value" });
    expect(q.groupBy).toEqual([]);
    expect(q.orderBy).toEqual({ ref: "value", dir: "desc" });
    expect(q.limit).toBe(10);
    expect(timeRangePredicate(q.where)).toBeDefined();
  });

  it("6. Error rate by tool name (event, bar) — ratio expansion", () => {
    const plan: QueryPlan = {
      level: "event",
      metric: {
        agg: "ratio",
        ratio: {
          numerator: [{ field: "status", op: "eq", value: "failed" }],
          denominator: [], // empty = all
        },
      },
      dimensions: ["toolName"],
      filters: [{ field: "eventType", op: "eq", value: "tool_call" }],
      timeRange,
      chartHint: "bar",
    };
    const q = compilePlan(plan);

    expect(q.source).toBe("events");
    expect(q.metric).toEqual({
      kind: "ratio",
      alias: "value",
      numerator: [{ kind: "compare", column: "status", op: "eq", value: "failed" }],
      denominator: [],
    });
    expect(q.groupBy).toEqual([{ kind: "column", column: "toolName", alias: "toolName" }]);
    expect(timeRangePredicate(q.where)).toBeDefined();
  });

  it("7. Number of runs per hour (event, line) — count_distinct(runId)", () => {
    const plan: QueryPlan = {
      level: "event",
      metric: { agg: "count_distinct", field: "runId" },
      dimensions: [{ time: "hour" }],
      timeRange,
      sort: { by: "time", dir: "asc" },
      chartHint: "line",
    };
    const q = compilePlan(plan);

    expect(q.source).toBe("events");
    expect(q.metric).toEqual({ kind: "count_distinct", column: "runId", alias: "value" });
    expect(q.groupBy).toEqual([{ kind: "timeBucket", column: "timestamp", grain: "hour", alias: "bucket" }]);
    expect(q.orderBy).toEqual({ ref: "bucket", dir: "asc" });
    expect(timeRangePredicate(q.where)).toBeDefined();
  });

  it("8. Avg steps per run by outcome (run, bar)", () => {
    const plan: QueryPlan = {
      level: "run",
      metric: { agg: "avg", field: "stepCount" },
      dimensions: ["outcome"],
      timeRange,
      chartHint: "bar",
    };
    const q = compilePlan(plan);

    expect(q.source).toBe("runs");
    expect(q.metric).toEqual({ kind: "simple", fn: "avg", column: "stepCount", alias: "value" });
    expect(q.groupBy).toEqual([{ kind: "column", column: "outcome", alias: "outcome" }]);
    expect(timeRangePredicate(q.where)).toBeDefined();
  });
});

describe("compilePlan — invariants & negative checks", () => {
  it("count metric never emits a column", () => {
    const q = compilePlan({
      level: "event",
      metric: { agg: "count" },
      timeRange,
      chartHint: "table",
    });
    expect(q.metric.kind).toBe("count");
    expect("column" in q.metric).toBe(false);
  });

  it("compiles a quantile metric (p95 latency) carrying its fraction", () => {
    const q = compilePlan({
      level: "event",
      metric: { agg: "quantile", field: "latencyMs", p: 0.95 },
      dimensions: ["model"],
      timeRange,
      chartHint: "bar",
    });
    expect(q.metric).toMatchObject({ kind: "quantile", column: "latencyMs", p: 0.95 });
  });

  it("timeRange predicate is always present, even with zero filters/dimensions", () => {
    const q = compilePlan({
      level: "event",
      metric: { agg: "count" },
      timeRange,
      chartHint: "table",
    });
    expect(q.where).toEqual([{ kind: "timeRange", column: "timestamp", from: FROM, to: TO }]);
    expect(q.groupBy).toEqual([]);
  });

  it("dimension-name sort references that dimension's alias", () => {
    const q = compilePlan({
      level: "event",
      metric: { agg: "count" },
      dimensions: ["model"],
      timeRange,
      sort: { by: "model", dir: "asc" },
      chartHint: "bar",
    });
    expect(q.orderBy).toEqual({ ref: "model", dir: "asc" });
  });

  it("multi-value `in` filter passes the array value through", () => {
    const q = compilePlan({
      level: "event",
      metric: { agg: "count" },
      filters: [{ field: "model", op: "in", value: ["gpt-4o", "claude-3"] }],
      timeRange,
      chartHint: "table",
    });
    expect(q.where).toContainEqual({
      kind: "compare",
      column: "model",
      op: "in",
      value: ["gpt-4o", "claude-3"],
    });
  });

  it("rejects a structurally invalid plan via defensive QueryPlan.parse (avg without field)", () => {
    // `avg` without a field is only caught at runtime by the schema's superRefine
    // (field is structurally optional), proving compilePlan re-validates defensively.
    expect(() =>
      compilePlan({ level: "event", metric: { agg: "avg" }, timeRange, chartHint: "bar" }),
    ).toThrow();
  });

  it("deriveChartHint mirrors the catalog heuristic", () => {
    expect(
      deriveChartHint({
        level: "event",
        metric: { agg: "count" },
        dimensions: [{ time: "hour" }],
        filters: [],
        timeRange,
        chartHint: "line",
      }),
    ).toBe("line");
    expect(
      deriveChartHint({
        level: "event",
        metric: { agg: "count" },
        dimensions: ["model"],
        filters: [],
        timeRange,
        chartHint: "bar",
      }),
    ).toBe("bar");
    expect(
      deriveChartHint({
        level: "event",
        metric: { agg: "count" },
        dimensions: [],
        filters: [],
        timeRange,
        chartHint: "table",
      }),
    ).toBe("table");
  });
});
