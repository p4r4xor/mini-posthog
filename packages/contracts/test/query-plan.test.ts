import { describe, expect, it } from "vitest";
import { QueryPlan } from "../src/index.js";

const timeRange = {
  from: "2026-05-01T00:00:00.000Z",
  to: "2026-05-08T00:00:00.000Z",
};

describe("QueryPlan validation", () => {
  it("accepts 'avg LLM latency by model over time' (event grain)", () => {
    const parsed = QueryPlan.safeParse({
      level: "event",
      metric: { agg: "avg", field: "latencyMs" },
      dimensions: ["model", { time: "hour" }],
      filters: [{ field: "eventType", op: "eq", value: "llm_call" }],
      timeRange,
      sort: { by: "time", dir: "asc" },
      chartHint: "line",
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts 'cost per successful run by model' (run grain)", () => {
    const parsed = QueryPlan.safeParse({
      level: "run",
      metric: { agg: "avg", field: "costUsd" },
      dimensions: ["model"],
      filters: [{ field: "outcome", op: "eq", value: "success" }],
      timeRange,
      chartHint: "bar",
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts an error-rate ratio metric", () => {
    const parsed = QueryPlan.safeParse({
      level: "event",
      metric: {
        agg: "ratio",
        ratio: {
          numerator: [{ field: "status", op: "eq", value: "failed" }],
          denominator: [],
        },
      },
      dimensions: ["toolName"],
      timeRange,
      chartHint: "bar",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a run/trace measure used at event grain", () => {
    const parsed = QueryPlan.safeParse({
      level: "event",
      metric: { agg: "avg", field: "durationMs" },
      timeRange,
      chartHint: "table",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects an event measure used at run grain", () => {
    const parsed = QueryPlan.safeParse({
      level: "run",
      metric: { agg: "avg", field: "latencyMs" },
      timeRange,
      chartHint: "bar",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a non-count metric with no field", () => {
    const parsed = QueryPlan.safeParse({
      level: "event",
      metric: { agg: "sum" },
      timeRange,
      chartHint: "bar",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a ratio metric without a ratio spec", () => {
    const parsed = QueryPlan.safeParse({
      level: "event",
      metric: { agg: "ratio" },
      timeRange,
      chartHint: "bar",
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts a p95 latency quantile (event grain)", () => {
    const parsed = QueryPlan.safeParse({
      level: "event",
      metric: { agg: "quantile", field: "latencyMs", p: 0.95 },
      dimensions: ["model"],
      filters: [{ field: "eventType", op: "eq", value: "llm_call" }],
      timeRange,
      chartHint: "bar",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a quantile metric without p", () => {
    const parsed = QueryPlan.safeParse({
      level: "event",
      metric: { agg: "quantile", field: "latencyMs" },
      timeRange,
      chartHint: "bar",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects p on a non-quantile metric", () => {
    const parsed = QueryPlan.safeParse({
      level: "event",
      metric: { agg: "avg", field: "latencyMs", p: 0.95 },
      timeRange,
      chartHint: "bar",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects count_distinct over a non-identifier field", () => {
    const parsed = QueryPlan.safeParse({
      level: "event",
      metric: { agg: "count_distinct", field: "latencyMs" },
      timeRange,
      chartHint: "bar",
    });
    expect(parsed.success).toBe(false);
  });
});
