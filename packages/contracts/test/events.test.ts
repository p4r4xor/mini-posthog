import { describe, expect, it } from "vitest";
import { CaptureEvent, captureEventToRow } from "../src/index.js";

const base = {
  eventId: "evt_1",
  traceId: "trace_1",
  runId: "run_1",
  timestamp: "2026-05-07T09:12:30.123Z",
  agentName: "research-agent",
  userId: "user_42",
  stepIndex: 0,
};

describe("CaptureEvent validation", () => {
  it("accepts a well-formed llm_call", () => {
    const parsed = CaptureEvent.safeParse({
      ...base,
      stepIndex: 1,
      eventType: "llm_call",
      model: "gpt-5.2",
      status: "success",
      latencyMs: 842,
      inputTokens: 1200,
      outputTokens: 310,
      costUsd: 0.0142,
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an llm_call missing required token counts", () => {
    const parsed = CaptureEvent.safeParse({
      ...base,
      eventType: "llm_call",
      model: "gpt-5.2",
      status: "success",
      latencyMs: 842,
      costUsd: 0.0142,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a run_completed that tries to carry costUsd (would double-count)", () => {
    const parsed = CaptureEvent.safeParse({
      ...base,
      eventType: "run_completed",
      status: "success",
      output: "done",
      costUsd: 0.0142,
    });
    expect(parsed.success).toBe(false);
  });

  it("defaults metadata to an empty object", () => {
    const parsed = CaptureEvent.parse({
      ...base,
      eventType: "run_started",
      status: "running",
      input: "Find pricing",
    });
    expect(parsed.metadata).toEqual({});
  });
});

describe("captureEventToRow", () => {
  it("flattens type-specific fields and nulls the rest", () => {
    const event = CaptureEvent.parse({
      ...base,
      stepIndex: 2,
      eventType: "tool_call",
      toolName: "web_search",
      status: "success",
      latencyMs: 1200,
    });
    const row = captureEventToRow(event, "proj_dev");

    expect(row.projectId).toBe("proj_dev");
    expect(row.toolName).toBe("web_search");
    expect(row.latencyMs).toBe(1200);
    expect(row.model).toBeNull();
    expect(row.inputTokens).toBeNull();
    expect(row.costUsd).toBeNull();
    expect(row.errorType).toBeNull();
  });
});
