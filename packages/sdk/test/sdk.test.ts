import { CaptureEvent } from "@ata/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initAgentAnalytics } from "../src/index.js";

/** Build an `ok` fetch Response stub. */
function okResponse(): Response {
  return new Response(
    JSON.stringify({ accepted: 1, duplicates: 0, rejected: 0, results: [] }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
}

/** Extract the parsed JSON bodies of every fetch call. */
function sentBodies(fetchMock: ReturnType<typeof vi.fn>): { events: unknown[] }[] {
  return fetchMock.mock.calls.map((call) =>
    JSON.parse(String((call[1] as RequestInit).body)),
  );
}

/** Flatten all events sent across all fetch calls. */
function allSentEvents(fetchMock: ReturnType<typeof vi.fn>): unknown[] {
  return sentBodies(fetchMock).flatMap((b) => b.events);
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => okResponse());
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("batching thresholds", () => {
  it("does not send while below flushAt", () => {
    const client = initAgentAnalytics({ apiKey: "k", host: "http://x", flushAt: 5 });
    const run = client.startRun({ agentName: "a", userId: "u", input: "hi" });
    // run_started (1) + 2 captures = 3 events, below flushAt=5.
    run.captureStep();
    run.captureStep();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends exactly one batch when reaching flushAt", async () => {
    const client = initAgentAnalytics({ apiKey: "k", host: "http://x", flushAt: 3 });
    const run = client.startRun({ agentName: "a", userId: "u", input: "hi" }); // 1
    run.captureStep(); // 2
    run.captureStep(); // 3 -> triggers flush
    await client.flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(allSentEvents(fetchMock)).toHaveLength(3);
  });
});

describe("flush()", () => {
  it("sends pending events on demand", async () => {
    const client = initAgentAnalytics({ apiKey: "k", host: "http://x", flushAt: 1000 });
    const run = client.startRun({ agentName: "a", userId: "u", input: "hi" });
    run.captureToolCall({ toolName: "search", latencyMs: 10 });
    expect(fetchMock).not.toHaveBeenCalled();
    await client.flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(allSentEvents(fetchMock)).toHaveLength(2);
  });
});

describe("wire-contract conformance", () => {
  it("every built event parses against CaptureEvent", async () => {
    const client = initAgentAnalytics({ apiKey: "k", host: "http://x", flushAt: 1000 });
    const trace = client.startTrace({
      agentName: "researcher",
      userId: "user_1",
      tags: { env: "test", team: "core" },
    });
    const run = trace.startRun({ input: "what is the weather?" });
    run.captureLLMCall({
      model: "claude-opus-4",
      latencyMs: 1200,
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.01,
      metadata: { temperature: 0.7 },
    });
    run.captureToolCall({
      toolName: "weather_api",
      latencyMs: 80,
      status: "success",
      costUsd: 0.001,
    });
    run.captureStep({ latencyMs: 5 });
    run.captureRetry({
      attempt: 1,
      toolName: "weather_api",
      status: "failed",
      latencyMs: 90,
    });
    run.captureError({
      errorType: "TimeoutError",
      message: "took too long",
      toolName: "weather_api",
    });
    run.end({ status: "success", output: "It is sunny." });
    trace.end();

    await client.flush();

    const events = allSentEvents(fetchMock);
    expect(events).toHaveLength(7); // run_started + 5 captures + run_completed
    for (const ev of events) {
      const parsed = CaptureEvent.safeParse(ev);
      expect(
        parsed.success,
        JSON.stringify({ ev, error: parsed.success ? null : parsed.error.format() }),
      ).toBe(true);
    }
  });

  it("merges trace tags into metadata.tags", async () => {
    const client = initAgentAnalytics({ apiKey: "k", host: "http://x", flushAt: 1000 });
    const run = client.startRun({
      agentName: "a",
      userId: "u",
      input: "x",
      tags: { env: "prod" },
    });
    run.captureStep();
    await client.flush();
    const events = allSentEvents(fetchMock) as {
      metadata: { tags?: Record<string, unknown> };
    }[];
    for (const ev of events) {
      expect(ev.metadata.tags).toMatchObject({ env: "prod" });
    }
  });

  it("run_completed carries no summable measures", async () => {
    const client = initAgentAnalytics({ apiKey: "k", host: "http://x", flushAt: 1000 });
    const run = client.startRun({ agentName: "a", userId: "u", input: "x" });
    run.end({ status: "success", output: "done" });
    await client.flush();
    const events = allSentEvents(fetchMock) as Record<string, unknown>[];
    const completed = events.find((e) => e.eventType === "run_completed")!;
    expect(completed).toBeDefined();
    expect(completed.costUsd).toBeUndefined();
    expect(completed.latencyMs).toBeUndefined();
    expect(completed.inputTokens).toBeUndefined();
  });
});

describe("stepIndex", () => {
  it("auto-increments within a run starting at 0", async () => {
    const client = initAgentAnalytics({ apiKey: "k", host: "http://x", flushAt: 1000 });
    const run = client.startRun({ agentName: "a", userId: "u", input: "x" });
    run.captureStep();
    run.captureStep();
    run.end({ status: "success" });
    await client.flush();
    const events = allSentEvents(fetchMock) as { eventType: string; stepIndex: number }[];
    expect(events.map((e) => e.stepIndex)).toEqual([0, 1, 2, 3]);
    expect(events[0]?.eventType).toBe("run_started");
  });

  it("resets per run within a trace", async () => {
    const client = initAgentAnalytics({ apiKey: "k", host: "http://x", flushAt: 1000 });
    const trace = client.startTrace({ agentName: "a", userId: "u" });
    const r1 = trace.startRun({ input: "x" });
    r1.captureStep();
    const r2 = trace.startRun({ input: "y" });
    r2.captureStep();
    await client.flush();
    const events = allSentEvents(fetchMock) as { runId: string; stepIndex: number }[];
    const byRun = new Map<string, number[]>();
    for (const e of events)
      byRun.set(e.runId, [...(byRun.get(e.runId) ?? []), e.stepIndex]);
    for (const indices of byRun.values()) expect(indices).toEqual([0, 1]);
  });
});

describe("transport request shape", () => {
  it("sets x-api-key header and { events: [...] } body", async () => {
    const client = initAgentAnalytics({
      apiKey: "secret-key",
      host: "http://example.test",
      flushAt: 1000,
    });
    const run = client.startRun({ agentName: "a", userId: "u", input: "x" });
    run.captureStep();
    await client.flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://example.test/capture");
    expect((init as RequestInit).method).toBe("POST");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("secret-key");
    expect(headers["content-type"]).toBe("application/json");
    const body = JSON.parse(String((init as RequestInit).body));
    expect(Array.isArray(body.events)).toBe(true);
    expect(Object.keys(body)).toEqual(["events"]);
  });
});

describe("retry", () => {
  it("retries a transient 500 then succeeds", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("err", { status: 500 }))
      .mockResolvedValueOnce(okResponse());

    const client = initAgentAnalytics({
      apiKey: "k",
      host: "http://x",
      flushAt: 1000,
      retryBaseMs: 1,
    });
    const run = client.startRun({ agentName: "a", userId: "u", input: "x" });
    run.captureStep();
    await client.flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a rejected (network) call then succeeds", async () => {
    fetchMock
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(okResponse());

    const client = initAgentAnalytics({
      apiKey: "k",
      host: "http://x",
      flushAt: 1000,
      retryBaseMs: 1,
    });
    const run = client.startRun({ agentName: "a", userId: "u", input: "x" });
    run.captureStep();
    await client.flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("drops batch and calls onError on a permanent 4xx", async () => {
    fetchMock.mockResolvedValue(new Response("bad", { status: 400 }));
    const onError = vi.fn();
    const client = initAgentAnalytics({
      apiKey: "k",
      host: "http://x",
      flushAt: 1000,
      retryBaseMs: 1,
      onError,
    });
    const run = client.startRun({ agentName: "a", userId: "u", input: "x" });
    run.captureStep();
    await client.flush();

    expect(fetchMock).toHaveBeenCalledTimes(1); // no retries on permanent 4xx
    expect(onError).toHaveBeenCalledTimes(1);
    const [, dropped] = onError.mock.calls[0]!;
    expect(dropped).toHaveLength(2);
  });
});

describe("backpressure", () => {
  it("drops the newest event and notifies onError when the queue is full", () => {
    const onError = vi.fn();
    const client = initAgentAnalytics({
      apiKey: "k",
      host: "http://x",
      flushAt: 1000,
      maxQueueSize: 1,
      onError,
    });
    // run_started fills the single slot; the next capture is dropped.
    const run = client.startRun({ agentName: "a", userId: "u", input: "x" });
    run.captureStep();
    expect(onError).toHaveBeenCalledTimes(1);
    const [err, dropped] = onError.mock.calls[0]!;
    expect((err as Error).message).toMatch(/queue full/);
    expect(dropped).toHaveLength(1);
  });
});

describe("timer flush", () => {
  it("flushes on the interval timer", async () => {
    vi.useFakeTimers();
    const client = initAgentAnalytics({
      apiKey: "k",
      host: "http://x",
      flushAt: 1000,
      flushIntervalMs: 1000,
    });
    const run = client.startRun({ agentName: "a", userId: "u", input: "x" });
    run.captureStep();
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(allSentEvents(fetchMock)).toHaveLength(2);
  });
});

describe("lifecycle", () => {
  it("shutdown clears the timer and flushes remaining events", async () => {
    vi.useFakeTimers();
    const client = initAgentAnalytics({
      apiKey: "k",
      host: "http://x",
      flushAt: 1000,
      flushIntervalMs: 1000,
    });
    const run = client.startRun({ agentName: "a", userId: "u", input: "x" });
    run.captureStep();
    await client.shutdown();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Timer is cleared: advancing time triggers no further flushes.
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
