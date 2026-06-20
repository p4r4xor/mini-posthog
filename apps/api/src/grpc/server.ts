import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { resolveProjectId } from "../config.js";
import type { IngestionService } from "../ingestion/ingestion-service.js";
import { protoEventToWire } from "./proto-map.js";

/**
 * gRPC ingestion transport (docs/architecture.md §12) — a binary, HTTP/2,
 * schema-enforced front door for high-throughput server SDKs. It is ONLY a
 * transport: both RPCs map protobuf → wire events and call the SAME
 * `IngestionService.capture(...)`, so the spine (validate → externalize → enqueue
 * → worker → store) is identical to HTTP. HTTP stays for browsers/debugging.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = join(__dirname, "../../proto/capture.proto");

interface CaptureResponseMsg {
  accepted: number;
  duplicates: number;
  rejected: number;
}

function projectIdFromMetadata(metadata: grpc.Metadata): string | null {
  const values = metadata.get("x-api-key");
  const key = values.length > 0 ? String(values[0]) : undefined;
  return key ? resolveProjectId(key) : null;
}

/** Run a batch of decoded proto events through the shared ingestion path. */
async function ingest(
  ingestion: IngestionService,
  projectId: string,
  protoEvents: unknown[],
): Promise<CaptureResponseMsg> {
  const wire = (protoEvents ?? []).map((e) =>
    protoEventToWire(e as Record<string, unknown>),
  );
  const result = await ingestion.capture(wire, projectId);
  if (result.status === "backpressure") {
    // gRPC's 429: tell the client to back off.
    throw {
      code: grpc.status.RESOURCE_EXHAUSTED,
      message: `ingestion overloaded (depth ${result.depth})`,
    };
  }
  const r = result.response;
  return { accepted: r.accepted, duplicates: r.duplicates, rejected: r.rejected };
}

export interface GrpcServerHandle {
  server: grpc.Server;
  port: number;
}

/** Build, bind, and start the gRPC server. `port: 0` picks an ephemeral port. */
export function startGrpcServer(
  ingestion: IngestionService,
  port: number,
): Promise<GrpcServerHandle> {
  const pkgDef = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true, // decoded objects use proto field names (event_id, …) — matches proto-map
    longs: Number,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const proto = grpc.loadPackageDefinition(pkgDef) as unknown as {
    ata: { capture: { v1: { IngestService: { service: grpc.ServiceDefinition } } } };
  };
  const service = proto.ata.capture.v1.IngestService.service;

  const server = new grpc.Server();
  server.addService(service, {
    // Unary batch.
    Capture: (
      call: grpc.ServerUnaryCall<{ events: unknown[] }, CaptureResponseMsg>,
      callback: grpc.sendUnaryData<CaptureResponseMsg>,
    ) => {
      const projectId = projectIdFromMetadata(call.metadata);
      if (!projectId) {
        callback({ code: grpc.status.UNAUTHENTICATED, message: "invalid x-api-key" });
        return;
      }
      ingest(ingestion, projectId, call.request.events)
        .then((res) => callback(null, res))
        .catch((err) => callback(err as grpc.ServiceError));
    },

    // Client-streaming: the SDK streams events over one HTTP/2 call; HTTP/2 flow
    // control is the transport-level backpressure.
    CaptureStream: (
      call: grpc.ServerReadableStream<unknown, CaptureResponseMsg>,
      callback: grpc.sendUnaryData<CaptureResponseMsg>,
    ) => {
      const projectId = projectIdFromMetadata(call.metadata);
      if (!projectId) {
        callback({ code: grpc.status.UNAUTHENTICATED, message: "invalid x-api-key" });
        return;
      }
      const events: unknown[] = [];
      call.on("data", (e: unknown) => events.push(e));
      call.on("end", () => {
        ingest(ingestion, projectId, events)
          .then((res) => callback(null, res))
          .catch((err) => callback(err as grpc.ServiceError));
      });
      call.on("error", (err) => callback(err as grpc.ServiceError));
    },
  });

  return new Promise((resolve, reject) => {
    server.bindAsync(
      `0.0.0.0:${port}`,
      grpc.ServerCredentials.createInsecure(),
      (err, boundPort) => {
        if (err) return reject(err);
        resolve({ server, port: boundPort });
      },
    );
  });
}
