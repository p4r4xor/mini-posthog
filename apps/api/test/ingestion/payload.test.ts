import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CaptureEvent, EventRow } from "@ata/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalBlobStore } from "../../src/blob/local-blob-store.js";
import { externalizePayload, hydratePayload } from "../../src/ingestion/payload.js";

let dir: string;
let blob: LocalBlobStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ata-payload-"));
  blob = new LocalBlobStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** run_started carries the prompt in the top-level `input` field. */
const runStarted = (
  input: string,
  metadata: Record<string, unknown> = {},
): CaptureEvent => ({
  eventType: "run_started",
  eventId: "evt_1",
  traceId: "t1",
  runId: "r1",
  timestamp: "2026-06-18T00:00:00.000Z",
  agentName: "research-agent",
  userId: "u1",
  stepIndex: 0,
  status: "running",
  input,
  metadata,
});

describe("payload externalization", () => {
  it("moves the top-level input text to the blob, leaving a slim event + ref", async () => {
    const big = "y".repeat(4096);
    const slim = await externalizePayload(
      runStarted(big, { tags: { env: "prod" } }),
      blob,
    );
    const meta = slim.metadata as Record<string, unknown>;

    // The 4 KB text is gone from the event that gets enqueued…
    expect((slim as { input?: string }).input).toBe("");
    // …replaced by a tiny ref; small props stay inline.
    expect(typeof meta.payloadRef).toBe("string");
    expect(meta.tags).toEqual({ env: "prod" });
    // The slim event serializes to far less than the raw payload (4 KB never queued).
    expect(JSON.stringify(slim).length).toBeLessThan(big.length);
    // The payload is retrievable from the blob store.
    const stored = await blob.get(meta.payloadRef as string);
    expect(JSON.parse(stored ?? "{}")).toEqual({ input: big });
  });

  it("is a no-op when there is no payload (e.g. a tool_call)", async () => {
    const toolCall: CaptureEvent = {
      eventType: "tool_call",
      eventId: "x",
      traceId: "t1",
      runId: "r1",
      timestamp: "2026-06-18T00:00:00.000Z",
      agentName: "a",
      userId: "u",
      stepIndex: 1,
      toolName: "web_search",
      status: "success",
      latencyMs: 100,
      metadata: {},
    };
    const slim = await externalizePayload(toolCall, blob);
    expect((slim.metadata as Record<string, unknown>).payloadRef).toBeUndefined();
  });

  it("hydrates the payload back from the blob for the explorer", async () => {
    const slim = await externalizePayload(runStarted("hello world", { t: 1 }), blob);
    const row = { metadata: slim.metadata } as EventRow;
    const hydrated = await hydratePayload(row, blob);
    expect(hydrated.input).toBe("hello world");
    expect(hydrated.t).toBe(1);
    expect(hydrated.payloadRef).toBeUndefined();
  });
});
