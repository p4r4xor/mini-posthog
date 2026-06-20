import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalBlobStore } from "../../src/blob/local-blob-store.js";
import { type GrpcServerHandle, startGrpcServer } from "../../src/grpc/server.js";
import { IngestionService } from "../../src/ingestion/ingestion-service.js";
import { MemoryEventQueue } from "../../src/ingestion/queue/memory-queue.js";
import { IngestionWorker } from "../../src/ingestion/worker.js";
import { DuckDBEventStore } from "../../src/storage/index.js";

const PROTO_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../proto/capture.proto",
);
const API_KEY = "dev_project_key";

function makeClient(port: number) {
  const def = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const proto = grpc.loadPackageDefinition(def) as never as {
    ata: {
      capture: {
        v1: { IngestService: new (a: string, c: grpc.ChannelCredentials) => grpc.Client };
      };
    };
  };
  return new proto.ata.capture.v1.IngestService(
    `localhost:${port}`,
    grpc.credentials.createInsecure(),
  ) as grpc.Client & Record<string, (...args: never[]) => unknown>;
}

function md(key?: string): grpc.Metadata {
  const m = new grpc.Metadata();
  if (key) m.set("x-api-key", key);
  return m;
}

const events = () => [
  {
    event_id: "g1",
    trace_id: "trace_g",
    run_id: "run_g",
    timestamp: "2026-06-18T09:00:00.000Z",
    agent_name: "research-agent",
    user_id: "u1",
    step_index: 0,
    event_type: "RUN_STARTED",
    status: "running",
    input: "find papers",
    metadata_json: JSON.stringify({ tags: { env: "prod" } }),
  },
  {
    event_id: "g2",
    trace_id: "trace_g",
    run_id: "run_g",
    timestamp: "2026-06-18T09:00:02.000Z",
    agent_name: "research-agent",
    user_id: "u1",
    step_index: 1,
    event_type: "LLM_CALL",
    model: "gpt-5.2",
    status: "success",
    latency_ms: 800,
    input_tokens: 1200,
    output_tokens: 300,
    cost_usd: 0.014,
  },
  {
    event_id: "g3",
    trace_id: "trace_g",
    run_id: "run_g",
    timestamp: "2026-06-18T09:00:12.000Z",
    agent_name: "research-agent",
    user_id: "u1",
    step_index: 2,
    event_type: "RUN_COMPLETED",
    status: "success",
    output: "done",
  },
];

let store: DuckDBEventStore;
let queue: MemoryEventQueue;
let worker: IngestionWorker;
let blobDir: string;
let handle: GrpcServerHandle;
let client: ReturnType<typeof makeClient>;

beforeEach(async () => {
  store = new DuckDBEventStore(":memory:");
  await store.init();
  blobDir = mkdtempSync(join(tmpdir(), "ata-grpc-"));
  queue = new MemoryEventQueue();
  worker = new IngestionWorker(queue, store, { batchSize: 1000, batchMs: 5 });
  const ingestion = new IngestionService(queue, new LocalBlobStore(blobDir), {
    maxQueueDepth: 100_000,
  });
  handle = await startGrpcServer(ingestion, 0); // ephemeral port
  client = makeClient(handle.port);
});

afterEach(async () => {
  client.close();
  handle.server.forceShutdown();
  await store.close();
  rmSync(blobDir, { recursive: true, force: true });
});

async function drain(): Promise<void> {
  while ((await queue.depth()) > 0) await queue.pump(worker.handleBatch, 1000);
}

describe("gRPC ingestion → same spine", () => {
  it("Capture (unary) buffers a batch and reaches the store", async () => {
    const res = await new Promise<{ accepted: number; rejected: number }>(
      (resolve, reject) => {
        client.Capture(
          { events: events() } as never,
          md(API_KEY) as never,
          ((err: grpc.ServiceError | null, r: { accepted: number; rejected: number }) =>
            err ? reject(err) : resolve(r)) as never,
        );
      },
    );
    expect(res.accepted).toBe(3);
    expect(res.rejected).toBe(0);

    await drain();
    const detail = await store.getTrace("proj_dev", "trace_g");
    expect(detail?.events.length).toBe(3);
    // payload externalization works over gRPC too: input went to the blob.
    const runStarted = detail?.events.find((e) => e.eventType === "run_started");
    expect((runStarted?.metadata as Record<string, unknown>).payloadRef).toBeTruthy();
  });

  it("rejects with UNAUTHENTICATED when x-api-key is missing", async () => {
    await expect(
      new Promise((resolve, reject) => {
        client.Capture(
          { events: events() } as never,
          md() as never,
          ((err: grpc.ServiceError | null, r: unknown) =>
            err ? reject(err) : resolve(r)) as never,
        );
      }),
    ).rejects.toMatchObject({ code: grpc.status.UNAUTHENTICATED });
  });

  it("CaptureStream (client-streaming) ingests a streamed flow", async () => {
    const res = await new Promise<{ accepted: number }>((resolve, reject) => {
      const stream = (
        client.CaptureStream as unknown as (
          m: grpc.Metadata,
          cb: (e: grpc.ServiceError | null, r: { accepted: number }) => void,
        ) => grpc.ClientWritableStream<unknown>
      )(md(API_KEY), (err, r) => (err ? reject(err) : resolve(r)));
      for (const e of events()) stream.write(e);
      stream.end();
    });
    expect(res.accepted).toBe(3);
    await drain();
    expect((await store.getTrace("proj_dev", "trace_g"))?.events.length).toBe(3);
  });
});
