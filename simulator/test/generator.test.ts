/**
 * Generator tests - no network. We capture events two ways:
 *  - directly from the pure `generateTrace` SimCall stream, and
 *  - by driving a REAL @ata/sdk client whose `fetch` is mocked, then parsing
 *    the captured request bodies with the `CaptureEvent` wire schema.
 */
import { CaptureEvent } from "@ata/contracts";
import { initAgentAnalytics } from "@ata/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateTrace, type SimCall, type TraceContext } from "../src/generator.js";
import { mulberry32 } from "../src/rng.js";
import { driveCalls, runSimulation } from "../src/run-simulation.js";

const WINDOW_END = Date.UTC(2026, 5, 20, 12, 0, 0); // 2026-06-20T12:00:00Z
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

function ctx(index: number): TraceContext {
  return { index, windowStartMs: WINDOW_END - SEVEN_DAYS, windowEndMs: WINDOW_END };
}

/** Generate N traces' worth of SimCalls from a fresh seeded rng. */
function generate(n: number, seed = 1): SimCall[] {
  const rng = mulberry32(seed);
  const calls: SimCall[] = [];
  for (let i = 0; i < n; i++) {
    for (const c of generateTrace(rng, ctx(i))) calls.push(c);
  }
  return calls;
}

describe("generateTrace", () => {
  it("yields a variety of event types, agents, models, and tools", () => {
    const calls = generate(300);
    const kinds = new Set(calls.map((c) => c.kind));
    // Lifecycle + every capture kind should appear across 300 traces.
    for (const k of [
      "start_trace",
      "start_run",
      "llm_call",
      "tool_call",
      "error",
      "retry",
      "end_run",
      "end_trace",
    ]) {
      expect(kinds.has(k as SimCall["kind"])).toBe(true);
    }

    const agents = new Set(
      calls
        .filter((c) => c.kind === "start_trace")
        .map((c) => (c as Extract<SimCall, { kind: "start_trace" }>).agentName),
    );
    const models = new Set(
      calls
        .filter((c) => c.kind === "llm_call")
        .map((c) => (c as Extract<SimCall, { kind: "llm_call" }>).model),
    );
    const tools = new Set(
      calls
        .filter((c) => c.kind === "tool_call")
        .map((c) => (c as Extract<SimCall, { kind: "tool_call" }>).toolName),
    );

    expect(agents.size).toBeGreaterThan(1);
    expect(models.size).toBeGreaterThan(1);
    expect(tools.size).toBeGreaterThan(1);
  });

  it("produces successes AND failures", () => {
    const calls = generate(300);
    const outcomes = new Set(
      calls
        .filter((c) => c.kind === "end_run")
        .map((c) => (c as Extract<SimCall, { kind: "end_run" }>).status),
    );
    expect(outcomes.has("success")).toBe(true);
    expect(outcomes.has("failed")).toBe(true);
  });

  it("includes traces with more than one run (run-level retry)", () => {
    // Count start_run between each start_trace/end_trace boundary.
    const calls = generate(300);
    let runsInTrace = 0;
    let multiRunTraces = 0;
    for (const c of calls) {
      if (c.kind === "start_trace") runsInTrace = 0;
      else if (c.kind === "start_run") runsInTrace++;
      else if (c.kind === "end_trace" && runsInTrace > 1) multiRunTraces++;
    }
    expect(multiRunTraces).toBeGreaterThan(0);
  });

  it("is deterministic: same seed → identical event-kind stream", () => {
    const a = generate(50, 42).map((c) => c.kind);
    const b = generate(50, 42).map((c) => c.kind);
    expect(a).toEqual(b);
  });

  it("differs across seeds", () => {
    const a = generate(50, 1).map((c) => c.kind);
    const b = generate(50, 2).map((c) => c.kind);
    expect(a).not.toEqual(b);
  });

  it("timestamps fall within the window and are non-decreasing within a run", () => {
    const from = WINDOW_END - SEVEN_DAYS;
    const calls = generate(200);
    let last = -Infinity;
    let inRun = false;
    for (const c of calls) {
      if (c.kind === "start_run") {
        inRun = true;
        last = -Infinity;
      }
      if ("at" in c) {
        const t = Date.parse(c.at);
        expect(t).toBeGreaterThanOrEqual(from);
        // Allow a little slack past window end for advancing latency at the tail.
        expect(t).toBeLessThanOrEqual(WINDOW_END + 10 * 60 * 1000);
        if (inRun) {
          expect(t).toBeGreaterThanOrEqual(last);
          last = t;
        }
      }
      if (c.kind === "end_run") inRun = false;
    }
  });

  it("every produced event is a valid wire CaptureEvent (driven through the SDK)", async () => {
    const captured: unknown[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { events: unknown[] };
      captured.push(...body.events);
      return new Response(
        JSON.stringify({
          accepted: body.events.length,
          duplicates: 0,
          rejected: 0,
          results: [],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = initAgentAnalytics({
      apiKey: "dev_project_key",
      host: "http://localhost:9",
      flushAt: 100,
      flushIntervalMs: 10_000,
    });
    const rng = mulberry32(7);
    for (let i = 0; i < 30; i++)
      driveCalls(
        client as unknown as Parameters<typeof driveCalls>[0],
        generateTrace(rng, ctx(i)),
      );
    await client.flush();
    await client.shutdown();

    expect(captured.length).toBeGreaterThan(0);
    for (const ev of captured) {
      const parsed = CaptureEvent.safeParse(ev);
      if (!parsed.success)
        throw new Error(
          `invalid wire event: ${JSON.stringify(parsed.error.issues)}\n${JSON.stringify(ev)}`,
        );
    }
  });
});

describe("runSimulation", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { events: unknown[] };
      return new Response(
        JSON.stringify({
          accepted: body.events.length,
          duplicates: 0,
          rejected: 0,
          results: [],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("reaches the target event count and reports throughput", async () => {
    const result = await runSimulation({
      host: "http://localhost:9",
      apiKey: "dev_project_key",
      targetEvents: 1500,
      days: 7,
      seed: 3,
      flushAt: 200,
      nowMs: WINDOW_END,
    });
    expect(result.events).toBeGreaterThanOrEqual(1500);
    expect(result.traces).toBeGreaterThan(0);
    expect(result.eventsPerSec).toBeGreaterThan(0);
    expect(result.dropped).toBe(0);
  });

  it("is reproducible: same seed → identical trace/event counts", async () => {
    const opts = {
      host: "http://localhost:9",
      apiKey: "dev_project_key",
      targetEvents: 1200,
      days: 7,
      seed: 9,
      nowMs: WINDOW_END,
    } as const;
    const a = await runSimulation({ ...opts });
    const b = await runSimulation({ ...opts });
    expect(a.events).toBe(b.events);
    expect(a.traces).toBe(b.traces);
  });
});
