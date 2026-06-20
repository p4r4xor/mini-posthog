import { describe, expect, it } from "vitest";
import { planQuery } from "../../src/query/planner/index.js";

// Fixed "now" for deterministic timeRange resolution.
const NOW = new Date("2026-06-20T12:00:00.000Z");

/** Resolve a question through the hybrid planner and return the plan (or throw). */
async function plan(nl: string) {
  const r = await planQuery(nl, { now: NOW });
  if (!r.ok) throw new Error(`unexpectedly rejected: ${nl} (${r.reason})`);
  return r.plan;
}

describe("composePlan - broad slot-based coverage (beyond the catalog)", () => {
  it("total cost by user → event sum(costUsd) by userId", async () => {
    const p = await plan("total cost by user");
    expect(p.level).toBe("event");
    expect(p.metric).toMatchObject({ agg: "sum", field: "costUsd" });
    expect(p.dimensions).toEqual(["userId"]);
    expect(p.chartHint).toBe("bar");
  });

  it("average latency by tool → event avg(latencyMs), scoped to tool_call", async () => {
    const p = await plan("average latency by tool");
    expect(p.metric).toMatchObject({ agg: "avg", field: "latencyMs" });
    expect(p.dimensions).toEqual(["toolName"]);
    expect(p.filters).toContainEqual({
      field: "eventType",
      op: "eq",
      value: "tool_call",
    });
  });

  it("p99 LLM latency by model → quantile p=0.99, scoped to llm_call", async () => {
    const p = await plan("p99 LLM latency by model");
    expect(p.metric).toMatchObject({ agg: "quantile", field: "latencyMs", p: 0.99 });
    expect(p.dimensions).toEqual(["model"]);
    expect(p.filters).toContainEqual({ field: "eventType", op: "eq", value: "llm_call" });
  });

  it("number of llm calls by model → count scoped to llm_call", async () => {
    const p = await plan("number of llm calls by model");
    expect(p.metric).toMatchObject({ agg: "count" });
    expect(p.dimensions).toEqual(["model"]);
    expect(p.filters).toContainEqual({ field: "eventType", op: "eq", value: "llm_call" });
  });

  it("errors by error type → count scoped to error events", async () => {
    const p = await plan("errors by error type");
    expect(p.metric).toMatchObject({ agg: "count" });
    expect(p.dimensions).toEqual(["errorType"]);
    expect(p.filters).toContainEqual({ field: "eventType", op: "eq", value: "error" });
  });

  it("average run duration by agent → run grain, avg(durationMs)", async () => {
    const p = await plan("average run duration by agent");
    expect(p.level).toBe("run");
    expect(p.metric).toMatchObject({ agg: "avg", field: "durationMs" });
    expect(p.dimensions).toEqual(["agentName"]);
  });

  it("token usage by model over time → sum(totalTokens) by model + hour, line", async () => {
    const p = await plan("token usage by model over time");
    expect(p.metric).toMatchObject({ agg: "sum", field: "totalTokens" });
    expect(p.dimensions).toEqual(["model", { time: "hour" }]);
    expect(p.chartHint).toBe("line");
    expect(p.sort).toEqual({ by: "time", dir: "asc" });
  });

  it("supports all time grains: second / minute / hour / day / week / month", async () => {
    const cases: Array<[string, string]> = [
      ["average LLM latency by model per second", "second"],
      ["average LLM latency by model per minute", "minute"],
      ["average LLM latency by model per day", "day"],
      ["average LLM latency by model per week", "week"],
      ["average LLM latency by model per month", "month"],
    ];
    for (const [nl, grain] of cases) {
      const p = await plan(nl);
      expect(p.dimensions).toContainEqual({ time: grain });
    }
  });

  it("which models cost the most → ranking: sum(costUsd) by model desc, limited", async () => {
    const p = await plan("which models cost the most");
    expect(p.metric).toMatchObject({ agg: "sum", field: "costUsd" });
    expect(p.dimensions).toEqual(["model"]);
    expect(p.sort).toEqual({ by: "metric", dir: "desc" });
    expect(p.limit).toBeGreaterThan(0);
  });

  it("composes with the NL time parser: 'total cost by agent yesterday'", async () => {
    const p = await plan("total cost by agent yesterday");
    expect(p.metric).toMatchObject({ agg: "sum", field: "costUsd" });
    expect(p.dimensions).toEqual(["agentName"]);
    expect(p.timeRange).toEqual({
      from: "2026-06-19T00:00:00.000Z",
      to: "2026-06-20T00:00:00.000Z",
    });
  });

  it("still rejects genuinely unsupported questions (no LLM)", async () => {
    const r = await planQuery("what is the weather today", { now: NOW });
    expect(r.ok).toBe(false);
  });
});
