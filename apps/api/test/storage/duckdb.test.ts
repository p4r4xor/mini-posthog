import { beforeEach, afterEach, describe, expect, it } from "vitest";
import type { CompiledQuery, EventRow } from "@ata/contracts";
import { DuckDBEventStore } from "../../src/storage/index.js";

const PROJECT = "dev_project";

/** Build an EventRow with sensible defaults; override per event. */
function ev(partial: Partial<EventRow> & Pick<EventRow, "eventId" | "eventType">): EventRow {
  return {
    traceId: "trace_1",
    runId: "run_1",
    projectId: PROJECT,
    timestamp: "2026-05-07T09:00:00.000Z",
    agentName: "research-agent",
    userId: "user_42",
    stepIndex: 0,
    model: null,
    toolName: null,
    status: null,
    errorType: null,
    latencyMs: null,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    metadata: {},
    ...partial,
  };
}

/**
 * Two traces, mirroring the fixture shapes:
 *  - trace_1 / run_1 (research-agent): run_started, llm_call(gpt-5.2),
 *    tool_call(web_search), error(web_fetch), retry(web_fetch), run_completed(success)
 *  - trace_2 / run_2 (coder-agent): run_started, llm_call(claude-4.5),
 *    tool_call(code_exec), run_completed(failed)
 */
function sampleEvents(): EventRow[] {
  return [
    // ---- trace_1 / run_1 ----
    ev({ eventId: "e1", eventType: "run_started", stepIndex: 0, status: "running",
      timestamp: "2026-05-07T09:00:00.000Z" }),
    ev({ eventId: "e2", eventType: "llm_call", stepIndex: 1, model: "gpt-5.2",
      status: "success", latencyMs: 800, inputTokens: 1200, outputTokens: 300,
      costUsd: 0.014, timestamp: "2026-05-07T09:00:02.000Z" }),
    ev({ eventId: "e3", eventType: "tool_call", stepIndex: 2, toolName: "web_search",
      status: "success", latencyMs: 1200, timestamp: "2026-05-07T09:00:04.000Z" }),
    ev({ eventId: "e4", eventType: "error", stepIndex: 3, toolName: "web_fetch",
      status: "failed", errorType: "rate_limit", latencyMs: 600,
      timestamp: "2026-05-07T09:00:07.000Z" }),
    ev({ eventId: "e5", eventType: "retry", stepIndex: 4, toolName: "web_fetch",
      status: "success", latencyMs: 900, timestamp: "2026-05-07T09:00:08.000Z" }),
    ev({ eventId: "e6", eventType: "run_completed", stepIndex: 5, status: "success",
      timestamp: "2026-05-07T09:00:12.000Z" }),

    // ---- trace_2 / run_2 ----
    ev({ eventId: "f1", eventType: "run_started", traceId: "trace_2", runId: "run_2",
      agentName: "coder-agent", userId: "user_7", stepIndex: 0, status: "running",
      timestamp: "2026-05-07T10:00:00.000Z" }),
    ev({ eventId: "f2", eventType: "llm_call", traceId: "trace_2", runId: "run_2",
      agentName: "coder-agent", userId: "user_7", stepIndex: 1, model: "claude-4.5",
      status: "success", latencyMs: 1500, inputTokens: 2000, outputTokens: 500,
      costUsd: 0.05, timestamp: "2026-05-07T10:00:03.000Z" }),
    ev({ eventId: "f3", eventType: "tool_call", traceId: "trace_2", runId: "run_2",
      agentName: "coder-agent", userId: "user_7", stepIndex: 2, toolName: "code_exec",
      status: "failed", latencyMs: 400, timestamp: "2026-05-07T10:00:05.000Z" }),
    ev({ eventId: "f4", eventType: "run_completed", traceId: "trace_2", runId: "run_2",
      agentName: "coder-agent", userId: "user_7", stepIndex: 3, status: "failed",
      timestamp: "2026-05-07T10:00:09.000Z" }),
  ];
}

const TIME_RANGE = { from: "2026-05-07T00:00:00.000Z", to: "2026-05-08T00:00:00.000Z" };

let store: DuckDBEventStore;

beforeEach(async () => {
  store = new DuckDBEventStore(":memory:");
  await store.init();
});

afterEach(async () => {
  await store.close();
});

describe("DuckDBEventStore", () => {
  it("inserts a batch of events across runs/traces", async () => {
    const result = await store.insertBatch(sampleEvents());
    expect(result.inserted).toBe(10);
    expect(result.duplicates).toBe(0);
  });

  it("is idempotent by eventId (dedup)", async () => {
    const batch = sampleEvents();
    const first = await store.insertBatch(batch);
    expect(first.inserted).toBe(10);

    const second = await store.insertBatch(batch);
    expect(second.inserted).toBe(0);
    expect(second.duplicates).toBe(10);

    // Row count unchanged: a count(*) aggregate over all events.
    const countQuery: CompiledQuery = {
      source: "events",
      metric: { kind: "count", alias: "value" },
      groupBy: [],
      where: [{ kind: "timeRange", column: "timestamp", ...TIME_RANGE }],
    };
    const agg = await store.aggregate(countQuery);
    expect(agg.rows[0]!.value).toBe(10);
  });

  it("aggregates count by toolName (event grain)", async () => {
    await store.insertBatch(sampleEvents());
    const query: CompiledQuery = {
      source: "events",
      metric: { kind: "count", alias: "value" },
      groupBy: [{ kind: "column", column: "toolName", alias: "toolName" }],
      where: [
        { kind: "compare", column: "eventType", op: "eq", value: "tool_call" },
        { kind: "timeRange", column: "timestamp", ...TIME_RANGE },
      ],
      orderBy: { ref: "value", dir: "desc" },
    };
    const res = await store.aggregate(query);
    expect(res.engine).toBe("duckdb");
    expect(res.columns).toEqual([
      { name: "toolName", role: "dimension" },
      { name: "value", role: "measure" },
    ]);
    const counts = Object.fromEntries(res.rows.map((r) => [r.toolName, r.value]));
    expect(counts.web_search).toBe(1);
    expect(counts.code_exec).toBe(1);
    expect(typeof res.latencyMs).toBe("number");
  });

  it("aggregates avg latencyMs by model (event grain)", async () => {
    await store.insertBatch(sampleEvents());
    const query: CompiledQuery = {
      source: "events",
      metric: { kind: "simple", fn: "avg", column: "latencyMs", alias: "value" },
      groupBy: [{ kind: "column", column: "model", alias: "model" }],
      where: [
        { kind: "compare", column: "eventType", op: "eq", value: "llm_call" },
        { kind: "timeRange", column: "timestamp", ...TIME_RANGE },
      ],
    };
    const res = await store.aggregate(query);
    const byModel = Object.fromEntries(res.rows.map((r) => [r.model, r.value]));
    expect(byModel["gpt-5.2"]).toBe(800);
    expect(byModel["claude-4.5"]).toBe(1500);
  });

  it("aggregates avg costUsd by model at the run grain", async () => {
    await store.insertBatch(sampleEvents());
    const query: CompiledQuery = {
      source: "runs",
      metric: { kind: "simple", fn: "avg", column: "costUsd", alias: "value" },
      groupBy: [{ kind: "column", column: "model", alias: "model" }],
      where: [],
    };
    const res = await store.aggregate(query);
    const byModel = Object.fromEntries(res.rows.map((r) => [r.model, r.value]));
    // run_1 primary_model = gpt-5.2 (last non-null model), cost = 0.014
    // run_2 primary_model = claude-4.5, cost = 0.05
    expect(byModel["gpt-5.2"]).toBeCloseTo(0.014, 5);
    expect(byModel["claude-4.5"]).toBeCloseTo(0.05, 5);
  });

  it("computes ratio (error rate) by toolName", async () => {
    await store.insertBatch(sampleEvents());
    const query: CompiledQuery = {
      source: "events",
      metric: {
        kind: "ratio",
        alias: "value",
        numerator: [{ kind: "compare", column: "status", op: "eq", value: "failed" }],
        denominator: [],
      },
      groupBy: [{ kind: "column", column: "toolName", alias: "toolName" }],
      where: [
        { kind: "compare", column: "eventType", op: "in", value: ["tool_call", "error"] },
        { kind: "timeRange", column: "timestamp", ...TIME_RANGE },
      ],
    };
    const res = await store.aggregate(query);
    const byTool = Object.fromEntries(res.rows.map((r) => [r.toolName, r.value]));
    // web_fetch: 1 error (failed) of 1 → 1.0 ; code_exec: 1 failed of 1 → 1.0
    // web_search: 0 failed of 1 → 0
    expect(byTool.web_search).toBe(0);
    expect(byTool.code_exec).toBe(1);
  });

  it("buckets a count over time (day grain)", async () => {
    await store.insertBatch(sampleEvents());
    const query: CompiledQuery = {
      source: "events",
      metric: { kind: "count_distinct", column: "runId", alias: "value" },
      groupBy: [{ kind: "timeBucket", column: "timestamp", grain: "day", alias: "bucket" }],
      where: [{ kind: "timeRange", column: "timestamp", ...TIME_RANGE }],
      orderBy: { ref: "bucket", dir: "asc" },
    };
    const res = await store.aggregate(query);
    expect(res.columns[0]).toEqual({ name: "bucket", role: "time" });
    // Both runs on the same day → 2 distinct runIds in one bucket.
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]!.value).toBe(2);
    expect(typeof res.rows[0]!.bucket).toBe("string");
  });

  it("listTraces returns trace summaries", async () => {
    await store.insertBatch(sampleEvents());
    const traces = await store.listTraces({ projectId: PROJECT });
    expect(traces).toHaveLength(2);
    const t1 = traces.find((t) => t.traceId === "trace_1")!;
    expect(t1.agentName).toBe("research-agent");
    expect(t1.outcome).toBe("success");
    expect(t1.runCount).toBe(1);
    expect(t1.costUsd).toBeCloseTo(0.014, 5);
    expect(t1.durationMs).toBe(12000);

    const t2 = traces.find((t) => t.traceId === "trace_2")!;
    expect(t2.outcome).toBe("failed");

    // Filter by agentName.
    const onlyCoder = await store.listTraces({ projectId: PROJECT, agentName: "coder-agent" });
    expect(onlyCoder).toHaveLength(1);
    expect(onlyCoder[0]!.traceId).toBe("trace_2");
  });

  it("getTrace returns detail with events ordered by step_index", async () => {
    await store.insertBatch(sampleEvents());
    const detail = await store.getTrace(PROJECT, "trace_1");
    expect(detail).not.toBeNull();
    expect(detail!.traceId).toBe("trace_1");
    expect(detail!.runs).toHaveLength(1);
    const run = detail!.runs[0]!;
    expect(run.runId).toBe("run_1");
    expect(run.outcome).toBe("success");
    expect(run.primaryModel).toBe("gpt-5.2");
    expect(run.stepCount).toBe(6);
    expect(run.errorCount).toBe(1);
    expect(run.retryCount).toBe(1);
    expect(run.computeMs).toBe(800 + 1200 + 600 + 900);

    expect(detail!.events).toHaveLength(6);
    const stepIndices = detail!.events.map((e) => e.stepIndex);
    expect(stepIndices).toEqual([0, 1, 2, 3, 4, 5]);
    // metadata round-trips.
    expect(detail!.events[0]!.eventType).toBe("run_started");
  });

  it("getTrace returns null for unknown trace", async () => {
    await store.insertBatch(sampleEvents());
    const detail = await store.getTrace(PROJECT, "nope");
    expect(detail).toBeNull();
  });
});
