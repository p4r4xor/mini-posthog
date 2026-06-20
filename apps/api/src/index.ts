/**
 * @ata/api entrypoint — server bootstrap.
 *
 * Selects the storage engine from config, initialises it, wires the ingestion +
 * query services into the Fastify app, and listens. The app builder lives in
 * http/app.ts so integration tests can inject an in-memory store.
 */
import { API_PORT, STORAGE_ENGINE } from "./config.js";
import { buildApp } from "./http/app.js";
import { IngestionService } from "./ingestion/ingestion-service.js";
import { QueryService } from "./query/query-service.js";
import { createEventStore } from "./storage/store-factory.js";

async function main(): Promise<void> {
  const store = createEventStore(STORAGE_ENGINE);
  await store.init();

  const app = await buildApp({
    store,
    ingestion: new IngestionService(store),
    query: new QueryService(store),
  });

  await app.listen({ port: API_PORT, host: "0.0.0.0" });
  console.log(`[ata/api] listening on :${API_PORT} (engine=${STORAGE_ENGINE})`);
}

main().catch((err) => {
  console.error("[ata/api] failed to start", err);
  process.exit(1);
});
