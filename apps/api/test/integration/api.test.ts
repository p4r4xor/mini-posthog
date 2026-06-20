import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { CaptureEvent, TraceDetail, TraceSummary } from "@ata/contracts";
import { DuckDBEventStore } from "../../src/storage/index.js";
import { IngestionService } from "../../src/ingestion/ingestion-service.js";
import { QueryService } from "../../src/query/query-service.js";
import { buildApp } from "../../src/http/app.js";

const API_KEY = "dev_project_key";
const TIME_RANGE = {
  from: "2026-05-07T00:00:00.000Z",
  to: "2026-05-08T00:00:00.000Z",
};

/** A small, valid batch across two runs/traces. */
function sampleEvents(): CaptureEvent[] {
  return [
    // trace_1 / run_1 — research-agent
    {
      eventType: "run_started",
      eventId: "e1",
      traceId: "trace_1",
      runId: "run_1",
      timestamp: "2026-05-07T09:00:00.000Z",
      agentName: "research-agent",
      userId: "user_42",
      stepIndex: 0,
      status: "running",
      input: "find papers",
    },
    {
      eventType: "llm_call",
      eventId: "e2",
      traceId: "trace_1",
      runId: "run_1",
      timestamp: "2026-05-07T09:00:02.000Z",
      agentName: "research-agent",
      userId: "user_42",
      stepIndex: 1,
      model: "gpt-5.2",
      status: "success",
      latencyMs: 800,
      inputTokens: 1200,
      outputTokens: 300,
      costUsd: 0.014,
    },
    {
      eventType: "tool_call",
      eventId: "e3",
      traceId: "trace_1",
      runId: "run_1",
      timestamp: "2026-05-07T09:00:04.000Z",
      agentName: "research-agent",
      userId: "user_42",
      stepIndex: 2,
      toolName: "web_search",
      status: "success",
      latencyMs: 1200,
    },
    {
      eventType: "error",
      eventId: "e4",
      traceId: "trace_1",
      runId: "run_1",
      timestamp: "2026-05-07T09:00:07.000Z",
      agentName: "research-agent",
      userId: "user_42",
      stepIndex: 3,
      status: "failed",
      errorType: "rate_limit",
      toolName: "web_fetch",
      latencyMs: 600,
    },
    {
      eventType: "retry",
      eventId: "e5",
      traceId: "trace_1",
      runId: "run_1",
      timestamp: "2026-05-07T09:00:08.000Z",
      agentName: "research-agent",
      userId: "user_42",
      stepIndex: 4,
      attempt: 1,
      toolName: "web_fetch",
      status: "success",
      latencyMs: 900,
    },
    {
      eventType: "run_completed",
      eventId: "e6",
      traceId: "trace_1",
      runId: "run_1",
      timestamp: "2026-05-07T09:00:12.000Z",
      agentName: "research-agent",
      userId: "user_42",
      stepIndex: 5,
      status: "success",
      output: "done",
    },
    // trace_2 / run_2 — coder-agent (a second failing tool to make the ranking meaningful)
    {
      eventType: "tool_call",
      eventId: "f1",
      traceId: "trace_2",
      runId: "run_2",
      timestamp: "2026-05-07T10:00:04.000Z",
      agentName: "coder-agent",
      userId: "user_7",
      stepIndex: 0,
      toolName: "code_exec",
      status: "failed",
      latencyMs: 1500,
    },
    {
      eventType: "error",
      eventId: "f2",
      traceId: "trace_2",
      runId: "run_2",
      timestamp: "2026-05-07T10:00:05.000Z",
      agentName: "coder-agent",
      userId: "user_7",
      stepIndex: 1,
      status: "failed",
      errorType: "timeout",
      toolName: "code_exec",
    },
  ];
}

let store: DuckDBEventStore;
let app: FastifyInstance;

beforeEach(async () => {
  store = new DuckDBEventStore(":memory:");
  await store.init();
  app = await buildApp({
    store,
    ingestion: new IngestionService(store),
    query: new QueryService(store),
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await store.close();
});

async function capture(events: unknown[], key: string | null = API_KEY) {
  return app.inject({
    method: "POST",
    url: "/capture",
    headers: key ? { "x-api-key": key } : {},
    payload: { events },
  });
}

describe("GET /health", () => {
  it("returns ok", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});

describe("POST /capture", () => {
  it("accepts a valid batch", async () => {
    const events = sampleEvents();
    const res = await capture(events);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accepted).toBe(events.length);
    expect(body.rejected).toBe(0);
    expect(body.duplicates).toBe(0);
  });

  it("rejects a malformed event but accepts the valid ones", async () => {
    const events: unknown[] = sampleEvents();
    events.push({ eventType: "llm_call", eventId: "bad", traceId: "t", runId: "r" });
    const res = await capture(events);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accepted).toBe(sampleEvents().length);
    expect(body.rejected).toBe(1);
    expect(body.results.some((r: { status: string }) => r.status === "rejected")).toBe(true);
  });

  it("rejects when x-api-key is missing", async () => {
    const res = await capture(sampleEvents(), null);
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBeTruthy();
  });

  it("is idempotent: re-posting reports duplicates and row count is stable", async () => {
    const events = sampleEvents();
    const first = await capture(events);
    expect(first.json().accepted).toBe(events.length);

    const second = await capture(events);
    const body = second.json();
    expect(body.accepted).toBe(0);
    expect(body.duplicates).toBe(events.length);

    // Verify store row count is stable via a trace detail event count.
    const detail = await store.getTrace("proj_dev", "trace_1");
    expect(detail?.events.length).toBe(6);
  });
});

describe("POST /query", () => {
  beforeEach(async () => {
    await capture(sampleEvents());
  });

  it("answers a supported question", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/query",
      payload: { q: "which tools fail the most", timeRange: TIME_RANGE },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.source).toBe("deterministic");
    expect(Array.isArray(body.result.rows)).toBe(true);
    expect(body.result.rows.length).toBeGreaterThan(0);
    expect(typeof body.result.meta.latencyMs).toBe("number");
    expect(body.result.meta.plan).toBeTruthy();
  });

  it("rejects an unsupported question", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/query",
      payload: { q: "what's the weather", timeRange: TIME_RANGE },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.supported.length).toBeGreaterThan(0);
  });
});

describe("GET /traces", () => {
  beforeEach(async () => {
    await capture(sampleEvents());
  });

  it("lists trace summaries", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/traces?from=${TIME_RANGE.from}&to=${TIME_RANGE.to}`,
    });
    expect(res.statusCode).toBe(200);
    const traces = res.json() as TraceSummary[];
    expect(Array.isArray(traces)).toBe(true);
    expect(traces.length).toBeGreaterThan(0);
    expect(traces.some((t) => t.traceId === "trace_1")).toBe(true);
  });

  it("returns a trace detail with events", async () => {
    const res = await app.inject({ method: "GET", url: "/traces/trace_1" });
    expect(res.statusCode).toBe(200);
    const detail = res.json() as TraceDetail;
    expect(detail.traceId).toBe("trace_1");
    expect(detail.events.length).toBe(6);
  });

  it("returns 404 for an unknown trace", async () => {
    const res = await app.inject({ method: "GET", url: "/traces/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBeTruthy();
  });
});
