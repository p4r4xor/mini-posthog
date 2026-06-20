/**
 * Transport micro-benchmark: gRPC (binary protobuf) vs HTTP (JSON) for event
 * ingestion. Isolates the TRANSPORT cost — no DB, no queue — so the numbers show
 * what choosing gRPC actually buys: smaller wire, cheaper (de)serialization, higher
 * loopback throughput. Both servers do the same minimal work (decode + count).
 *
 *   pnpm --filter @ata/bench exec tsx src/transport-bench.ts [--events N]
 *
 * Two event profiles are measured:
 *   - analytical: a typical llm_call (~the dominant event; no big text)
 *   - payload:    a run_started carrying ~3 KB of prompt text (the heavy case)
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import Fastify from "fastify";
import protobuf from "protobufjs";

const PROTO_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../apps/api/proto/capture.proto",
);

const arg = (name: string, def: number): number => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? Number(process.argv[i + 1]) : def;
};
const TOTAL = arg("--events", 100_000);
const BATCH = 500;

// --- sample events -----------------------------------------------------------
// HTTP carries our wire CaptureEvent (camelCase); gRPC carries the proto Event
// (snake_case). Same logical event, each in its transport's native shape.

function httpAnalytical(i: number) {
  return {
    eventType: "llm_call",
    eventId: `e${i}`,
    traceId: `t${i >> 3}`,
    runId: `r${i >> 3}`,
    timestamp: "2026-06-18T09:00:02.000Z",
    agentName: "research-agent",
    userId: "user_0042",
    stepIndex: i % 8,
    model: "gpt-5.2",
    status: "success",
    latencyMs: 842,
    inputTokens: 1200,
    outputTokens: 310,
    costUsd: 0.0142,
    metadata: { tags: { env: "prod", tier: "pro" } },
  };
}
function protoAnalytical(i: number) {
  return {
    event_type: "LLM_CALL",
    event_id: `e${i}`,
    trace_id: `t${i >> 3}`,
    run_id: `r${i >> 3}`,
    timestamp: "2026-06-18T09:00:02.000Z",
    agent_name: "research-agent",
    user_id: "user_0042",
    step_index: i % 8,
    model: "gpt-5.2",
    status: "success",
    latency_ms: 842,
    input_tokens: 1200,
    output_tokens: 310,
    cost_usd: 0.0142,
    metadata_json: JSON.stringify({ tags: { env: "prod", tier: "pro" } }),
  };
}
const BIG = "x".repeat(3072);
function httpPayload(i: number) {
  return {
    ...httpAnalytical(i),
    eventType: "run_started",
    status: "running",
    input: BIG,
  };
}
function protoPayload(i: number) {
  return {
    ...protoAnalytical(i),
    event_type: "RUN_STARTED",
    status: "running",
    input: BIG,
  };
}

// --- protobuf message (standalone encode/decode for size + CPU) --------------
const root = protobuf.loadSync(PROTO_PATH);
const EventMsg = root.lookupType("ata.capture.v1.Event");

function fmt(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

// A) wire size --------------------------------------------------------------
function wireSize(label: string, http: object, proto: object): void {
  const jsonBytes = Buffer.byteLength(JSON.stringify(http));
  const protoBytes = EventMsg.encode(EventMsg.fromObject(proto)).finish().length;
  console.log(
    `  ${label.padEnd(11)} JSON ${String(jsonBytes).padStart(5)} B  |  protobuf ${String(protoBytes).padStart(5)} B  |  ${fmt(jsonBytes / protoBytes)}× smaller`,
  );
}

// B) serialization CPU (encode + decode, no network) ------------------------
function serdeCpu(label: string, http: object, proto: object, iters: number): void {
  // JSON round-trip
  let c0 = process.cpuUsage();
  let t0 = performance.now();
  for (let i = 0; i < iters; i++) JSON.parse(JSON.stringify(http));
  const jsonMs = performance.now() - t0;
  const jsonCpu = (process.cpuUsage(c0).user + process.cpuUsage(c0).system) / 1000;

  // protobuf round-trip
  const pm = EventMsg.fromObject(proto);
  c0 = process.cpuUsage();
  t0 = performance.now();
  for (let i = 0; i < iters; i++) EventMsg.decode(EventMsg.encode(pm).finish());
  const protoMs = performance.now() - t0;

  console.log(
    `  ${label.padEnd(11)} JSON ${fmt((jsonMs * 1000) / iters).padStart(6)} µs/ev  |  protobuf ${fmt((protoMs * 1000) / iters).padStart(6)} µs/ev  |  ${fmt(jsonMs / protoMs)}× faster`,
  );
  void jsonCpu;
}

// C) end-to-end loopback throughput -----------------------------------------
async function httpThroughput(make: (i: number) => object): Promise<number> {
  const app = Fastify({ logger: false });
  let count = 0;
  app.post("/capture", async (req) => {
    count += (req.body as { events: unknown[] }).events.length;
    return { n: count };
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const url = `http://127.0.0.1:${port}/capture`;

  const t0 = performance.now();
  for (let i = 0; i < TOTAL; i += BATCH) {
    const events: object[] = [];
    for (let j = i; j < Math.min(i + BATCH, TOTAL); j++) events.push(make(j));
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events }),
    });
  }
  const secs = (performance.now() - t0) / 1000;
  await app.close();
  return TOTAL / secs;
}

async function grpcThroughput(
  make: (i: number) => object,
  streaming: boolean,
): Promise<number> {
  const def = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const pkg = grpc.loadPackageDefinition(def) as never as {
    ata: { capture: { v1: { IngestService: { service: grpc.ServiceDefinition } } } };
  };
  const svc = pkg.ata.capture.v1.IngestService.service;
  let count = 0;
  const server = new grpc.Server();
  server.addService(svc, {
    Capture: (
      call: grpc.ServerUnaryCall<{ events: unknown[] }, unknown>,
      cb: grpc.sendUnaryData<unknown>,
    ) => {
      count += call.request.events.length;
      cb(null, { accepted: call.request.events.length, duplicates: 0, rejected: 0 });
    },
    CaptureStream: (
      call: grpc.ServerReadableStream<unknown, unknown>,
      cb: grpc.sendUnaryData<unknown>,
    ) => {
      let n = 0;
      call.on("data", () => n++);
      call.on("end", () => {
        count += n;
        cb(null, { accepted: n, duplicates: 0, rejected: 0 });
      });
    },
  });
  const port = await new Promise<number>((res, rej) =>
    server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (e, p) =>
      e ? rej(e) : res(p),
    ),
  );
  const ClientCtor = pkg.ata.capture.v1.IngestService as unknown as new (
    a: string,
    c: grpc.ChannelCredentials,
  ) => grpc.Client & Record<string, (...a: never[]) => unknown>;
  const client = new ClientCtor(`127.0.0.1:${port}`, grpc.credentials.createInsecure());

  const t0 = performance.now();
  for (let i = 0; i < TOTAL; i += BATCH) {
    const events: object[] = [];
    for (let j = i; j < Math.min(i + BATCH, TOTAL); j++) events.push(make(j));
    await new Promise<void>((resolve, reject) => {
      if (streaming) {
        const stream = (
          client.CaptureStream as never as (
            cb: (e: unknown) => void,
          ) => grpc.ClientWritableStream<unknown>
        )((e: unknown) => (e ? reject(e as Error) : resolve()));
        for (const e of events) stream.write(e);
        stream.end();
      } else {
        (client.Capture as never as (a: unknown, cb: (e: unknown) => void) => void)(
          { events },
          (e: unknown) => (e ? reject(e as Error) : resolve()),
        );
      }
    });
  }
  const secs = (performance.now() - t0) / 1000;
  client.close();
  server.forceShutdown();
  return TOTAL / secs;
}

async function main(): Promise<void> {
  console.log(`\nTRANSPORT BENCHMARK — ${fmt(TOTAL)} events, batch ${BATCH}, loopback\n`);

  console.log("A) wire size per event");
  wireSize("analytical", httpAnalytical(1), protoAnalytical(1));
  wireSize("payload~3KB", httpPayload(1), protoPayload(1));

  console.log("\nB) serialization CPU (encode + decode round-trip)");
  serdeCpu("analytical", httpAnalytical(1), protoAnalytical(1), 200_000);
  serdeCpu("payload~3KB", httpPayload(1), protoPayload(1), 100_000);

  console.log("\nC) end-to-end loopback throughput (analytical events)");
  const http = await httpThroughput(httpAnalytical);
  const grpcUnary = await grpcThroughput(protoAnalytical, false);
  const grpcStream = await grpcThroughput(protoAnalytical, true);
  console.log(`  HTTP/JSON          ${fmt(http).padStart(10)} ev/s`);
  console.log(
    `  gRPC unary         ${fmt(grpcUnary).padStart(10)} ev/s  (${fmt(grpcUnary / http)}×)`,
  );
  console.log(
    `  gRPC client-stream ${fmt(grpcStream).padStart(10)} ev/s  (${fmt(grpcStream / http)}×)`,
  );
  console.log("");
}

main().catch((err) => {
  console.error("[transport-bench] failed:", err);
  process.exitCode = 1;
});
