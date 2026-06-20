import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CaptureEvent, TraceDetail, TraceSummary } from "@ata/contracts";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalBlobStore } from "../../src/blob/local-blob-store.js";
import { buildApp } from "../../src/http/app.js";
import { IngestionService } from "../../src/ingestion/ingestion-service.js";
import { MemoryEventQueue } from "../../src/ingestion/queue/memory-queue.js";
import { IngestionWorker } from "../../src/ingestion/worker.js";
import { QueryService } from "../../src/query/query-service.js";
import { DuckDBEventStore } from "../../src/storage/index.js";

const API_KEY = "dev_project_key";
const TIME_RANGE = { from: "2026-05-07T00:00:00.000Z", to: "2026-05-08T00:00:00.000Z" };

function sampleEvents(): CaptureEvent[] {
  return [
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
      status: "failed",
      latencyMs: 1200,
    },
    {
      eventType: "run_completed",
      eventId: "e6",
      traceId: "trace_1",
      runId: "run_1",
      timestamp: "2026-05-07T09:00:12.000Z",
      agentName: "research-agent",
      userId: "user_42",
      stepIndex: 3,
      status: "success",
      output: "done",
    },
  ];
}

let store: DuckDBEventStore;
let queue: MemoryEventQueue;
let worker: IngestionWorker;
let blob: LocalBlobStore;
let blobDir: string;
let app: FastifyInstance;

beforeEach(async () => {
  store = new DuckDBEventStore(":memory:");
  await store.init();
  blobDir = mkdtempSync(join(tmpdir(), "ata-blob-"));
  blob = new LocalBlobStore(blobDir);
  queue = new MemoryEventQueue();
  worker = new IngestionWorker(queue, store, { batchSize: 1000, batchMs: 5 });
  app = await buildApp({
    store,
    ingestion: new IngestionService(queue, blob, { maxQueueDepth: 100_000 }),
    query: new QueryService(store),
    blob,
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await store.close();
  rmSync(blobDir, { recursive: true, force: true });
});

/** Drain the queue through the worker (simulates the async worker, deterministically). */
async function drain(): Promise<void> {
  while ((await queue.depth()) > 0) await queue.pump(worker.handleBatch, 1000);
}

async function capture(events: unknown[], key: string | null = API_KEY) {
  return app.inject({
    method: "POST",
    url: "/capture",
    headers: key ? { "x-api-key": key } : {},
    payload: { events },
  });
}

describe("POST /capture (async pipeline)", () => {
  it("accepts a valid batch with 202 and buffers it", async () => {
    const events = sampleEvents();
    const res = await capture(events);
    expect(res.statusCode).toBe(202);
    expect(res.json().accepted).toBe(events.length);
    expect(await queue.depth()).toBe(events.length); // buffered, not yet inserted
    await drain();
    expect(await queue.depth()).toBe(0);
  });

  it("rejects a malformed event but buffers the valid ones", async () => {
    const events: unknown[] = sampleEvents();
    events.push({ eventType: "llm_call", eventId: "bad", traceId: "t", runId: "r" });
    const res = await capture(events);
    expect(res.statusCode).toBe(202);
    expect(res.json().accepted).toBe(sampleEvents().length);
    expect(res.json().rejected).toBe(1);
  });

  it("rejects when x-api-key is missing", async () => {
    const res = await capture(sampleEvents(), null);
    expect(res.statusCode).toBe(401);
  });

  it("returns 429 when the queue backlog exceeds the limit", async () => {
    const back = await buildApp({
      store,
      ingestion: new IngestionService(queue, blob, { maxQueueDepth: 3 }),
      query: new QueryService(store),
      blob,
    });
    await back.ready();
    // First call buffers 4 events → depth 4 ≥ 3, so the next is shed.
    const first = await back.inject({
      method: "POST",
      url: "/capture",
      headers: { "x-api-key": API_KEY },
      payload: { events: sampleEvents() },
    });
    expect(first.statusCode).toBe(202);
    const second = await back.inject({
      method: "POST",
      url: "/capture",
      headers: { "x-api-key": API_KEY },
      payload: { events: sampleEvents() },
    });
    expect(second.statusCode).toBe(429);
    await back.close();
  });

  it("is idempotent: re-posting drains to a stable row count", async () => {
    await capture(sampleEvents());
    await capture(sampleEvents()); // at-least-once: same events again
    await drain();
    const detail = await store.getTrace("proj_dev", "trace_1");
    expect(detail?.events.length).toBe(4); // deduped by eventId at the worker/store
  });

  it("externalizes payload: 4 KB text goes to the blob, not the queue/row", async () => {
    const big = "x".repeat(4096);
    // `input` is a top-level field on run_started - the large payload.
    await capture([
      {
        ...sampleEvents()[0],
        eventId: "p1",
        input: big,
        metadata: { tags: { env: "prod" } },
      },
    ]);
    await drain();

    // Raw stored row keeps only a payloadRef (+ small props) - NOT the 4 KB text.
    const raw = await store.getTrace("proj_dev", "trace_1");
    const rawMeta = raw?.events[0]?.metadata as Record<string, unknown>;
    expect(typeof rawMeta.payloadRef).toBe("string");
    expect(rawMeta.input).toBeUndefined();
    expect(rawMeta.tags).toEqual({ env: "prod" });

    // The explorer hydrates the full text back from the blob store.
    const res = await app.inject({ method: "GET", url: "/traces/trace_1" });
    const detail = res.json() as TraceDetail;
    const meta = detail.events[0]?.metadata as Record<string, unknown>;
    expect(meta.input).toBe(big);
  });
});

describe("POST /query (after draining)", () => {
  beforeEach(async () => {
    await capture(sampleEvents());
    await drain();
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
    expect(body.result.rows.length).toBeGreaterThan(0);
    expect(typeof body.result.meta.latencyMs).toBe("number");
  });

  it("rejects an unsupported question", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/query",
      payload: { q: "what's the weather", timeRange: TIME_RANGE },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().ok).toBe(false);
  });
});

describe("GET /traces (after draining)", () => {
  beforeEach(async () => {
    await capture(sampleEvents());
    await drain();
  });

  it("lists trace summaries", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/traces?from=${TIME_RANGE.from}&to=${TIME_RANGE.to}`,
    });
    expect(res.statusCode).toBe(200);
    const traces = res.json() as TraceSummary[];
    expect(traces.some((t) => t.traceId === "trace_1")).toBe(true);
  });

  it("returns a trace detail with events", async () => {
    const res = await app.inject({ method: "GET", url: "/traces/trace_1" });
    const detail = res.json() as TraceDetail;
    expect(detail.events.length).toBe(4);
  });

  it("returns 404 for an unknown trace", async () => {
    const res = await app.inject({ method: "GET", url: "/traces/nope" });
    expect(res.statusCode).toBe(404);
  });
});
