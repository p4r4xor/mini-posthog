/**
 * @ata/api entrypoint — server bootstrap (docs/architecture.md §12).
 *
 * Wires the async ingestion spine: HTTP /capture → EventQueue → IngestionWorker →
 * EventStore, with payloads externalized to a BlobStore. The worker runs in-process
 * here for the prototype; in production it's a separate, horizontally-scaled
 * deployment. The app builder lives in http/app.ts so tests can inject deps.
 */
import { LocalBlobStore } from "./blob/local-blob-store.js";
import {
  API_PORT,
  BLOB_DIR,
  GRPC_PORT,
  MAX_QUEUE_DEPTH,
  QUEUE_KIND,
  REDIS_URL,
  STORAGE_ENGINE,
  WORKER_BATCH_MS,
  WORKER_BATCH_SIZE,
} from "./config.js";
import { startGrpcServer } from "./grpc/server.js";
import { buildApp } from "./http/app.js";
import { IngestionService } from "./ingestion/ingestion-service.js";
import { createQueue } from "./ingestion/queue/queue-factory.js";
import { IngestionWorker } from "./ingestion/worker.js";
import { QueryService } from "./query/query-service.js";
import { createEventStore } from "./storage/store-factory.js";

async function main(): Promise<void> {
  const store = createEventStore(STORAGE_ENGINE);
  await store.init();

  const blob = new LocalBlobStore(BLOB_DIR);
  const queue = createQueue(QUEUE_KIND, { redisUrl: REDIS_URL });

  const ingestion = new IngestionService(queue, blob, { maxQueueDepth: MAX_QUEUE_DEPTH });
  const worker = new IngestionWorker(queue, store, {
    batchSize: WORKER_BATCH_SIZE,
    batchMs: WORKER_BATCH_MS,
  });

  // Start the worker loop (in-process for the prototype).
  const workerAbort = new AbortController();
  void worker.start(workerAbort.signal);

  const app = await buildApp({
    store,
    ingestion,
    query: new QueryService(store),
    blob,
  });

  // gRPC ingestion transport (binary) in front of the same IngestionService.
  const grpc = await startGrpcServer(ingestion, GRPC_PORT);

  const shutdown = async (): Promise<void> => {
    workerAbort.abort();
    grpc.server.forceShutdown();
    await app.close();
    await queue.close();
    await store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await app.listen({ port: API_PORT, host: "0.0.0.0" });
  console.log(
    `[ata/api] HTTP :${API_PORT}  gRPC :${grpc.port}  (engine=${STORAGE_ENGINE}, queue=${QUEUE_KIND})`,
  );
}

main().catch((err) => {
  console.error("[ata/api] failed to start", err);
  process.exit(1);
});
