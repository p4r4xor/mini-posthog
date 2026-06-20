/**
 * Engine setup + STREAMING load for the benchmark (docs/architecture.md §6, §8).
 *
 * For each engine we construct the real adapter behind the `EventStore` port,
 * give it a CLEAN slate (DuckDB: delete the on-disk file; ClickHouse: DROP +
 * recreate the table/views in a dedicated `ata_bench` database), then STREAM the
 * dataset in via the fast `store.bulkInsert(rows)` path one batch at a time. The
 * generator drives the batches (see `streamGenerate`), so peak memory is one
 * batch regardless of total event count. We time the total load to report ingest
 * throughput (events/sec) and measure on-disk size afterward.
 */
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CLICKHOUSE_CONFIG } from "@ata/api/config";
import { ClickHouseEventStore, DuckDBEventStore } from "@ata/api/storage";
import type { EventRow, EventStore, StorageEngine } from "@ata/contracts";
import { createClient } from "@clickhouse/client";
import type { BatchSink, GenSummary } from "./dataset.js";

/**
 * The fast bulk-load path lives on both adapters but is intentionally NOT on the
 * `EventStore` contract (it is non-idempotent, loader-only). Both adapters
 * implement it, so we narrow to this shape for the benchmark loader.
 */
type BulkStore = EventStore & { bulkInsert(rows: EventRow[]): Promise<number> };

const __dirname = dirname(fileURLToPath(import.meta.url));
/** bench/results/ — output dir for the DuckDB file + results.json. */
export const RESULTS_DIR = resolve(__dirname, "..", "results");
const DUCKDB_PATH = resolve(RESULTS_DIR, "bench.duckdb");
const CH_DATABASE = "ata_bench";

/** ClickHouse config pointed at the dedicated benchmark database. */
const CH_BENCH_CONFIG = { ...CLICKHOUSE_CONFIG, database: CH_DATABASE };

export interface LoadResult {
  engine: StorageEngine;
  store: EventStore;
  /** Rows inserted via the fast bulk path. */
  inserted: number;
  /** Total load wall-clock (ms) — spans generation + bulkInsert (streamed). */
  loadMs: number;
  /** Ingest throughput: rows / (loadMs/1000). */
  eventsPerSec: number;
  /** The generation summary (events, traces, rawBytes, window). */
  gen: GenSummary;
}

/** Remove the DuckDB file (and its WAL) so each run loads from scratch. */
function cleanDuckDbFile(): void {
  for (const suffix of ["", ".wal"]) {
    const p = `${DUCKDB_PATH}${suffix}`;
    if (existsSync(p)) rmSync(p);
  }
}

/** DROP the ClickHouse table + views so init recreates them empty. */
async function cleanClickHouse(): Promise<void> {
  const bootstrap = createClient({
    url: CH_BENCH_CONFIG.url,
    username: CH_BENCH_CONFIG.username,
    password: CH_BENCH_CONFIG.password,
  });
  try {
    await bootstrap.command({
      query: `CREATE DATABASE IF NOT EXISTS ${CH_DATABASE}`,
    });
    // Views depend on the table; drop views first, then the table.
    for (const obj of ["traces", "runs"]) {
      await bootstrap.command({ query: `DROP VIEW IF EXISTS ${CH_DATABASE}.${obj}` });
    }
    await bootstrap.command({ query: `DROP TABLE IF EXISTS ${CH_DATABASE}.events` });
  } finally {
    await bootstrap.close();
  }
}

/** Construct + clean + init the store for `engine` (typed with the bulk path). */
export async function setupEngine(engine: StorageEngine): Promise<BulkStore> {
  mkdirSync(RESULTS_DIR, { recursive: true });
  if (engine === "duckdb") {
    cleanDuckDbFile();
    const store = new DuckDBEventStore(DUCKDB_PATH);
    await store.init();
    return store;
  }
  await cleanClickHouse();
  const store = new ClickHouseEventStore(CH_BENCH_CONFIG);
  await store.init();
  return store;
}

/**
 * Force on-disk persistence and measure size for the given engine. Call AFTER
 * the query benchmark, once the load store has been closed (DuckDB is a single
 * read-write process — the loading connection must be released before we open a
 * fresh one to CHECKPOINT and stat the file).
 */
export async function measureDiskBytes(engine: StorageEngine): Promise<number> {
  if (engine === "duckdb") {
    // CHECKPOINT flushes the WAL into the main file so statSync sees true size.
    await runDuckCheckpoint(DUCKDB_PATH);
    return statSync(DUCKDB_PATH).size;
  }

  // ClickHouse: sum active part bytes on disk for the events table.
  const client = createClient({
    url: CH_BENCH_CONFIG.url,
    username: CH_BENCH_CONFIG.username,
    password: CH_BENCH_CONFIG.password,
    database: CH_DATABASE,
  });
  try {
    const rs = await client.query({
      query: `SELECT sum(bytes_on_disk) AS bytes FROM system.parts
              WHERE database = {db:String} AND table = 'events' AND active`,
      query_params: { db: CH_DATABASE },
      format: "JSONEachRow",
    });
    const rows = await rs.json<{ bytes: string | number | null }>();
    return Number(rows[0]?.bytes ?? 0);
  } finally {
    await client.close();
  }
}

/** Open a short-lived DuckDB connection just to CHECKPOINT the file. */
async function runDuckCheckpoint(path: string): Promise<void> {
  const { DuckDBInstance } = await import("@duckdb/node-api");
  const instance = await DuckDBInstance.create(path);
  const conn = await instance.connect();
  try {
    await conn.run("CHECKPOINT");
  } finally {
    conn.closeSync();
    instance.closeSync();
  }
}

/**
 * STREAM the dataset into `engine` via the fast `bulkInsert` path. The `generate`
 * function (a partially-applied `streamGenerate`) drives batch production and
 * hands us one batch at a time through the sink — we persist each batch and then
 * let it be garbage-collected, so peak memory is one batch, NOT the whole dataset.
 *
 * The whole load (generation + inserts, which interleave) is timed for ingest
 * throughput. Returns the store (kept open for the query phase) + the generation
 * summary (events, traces, rawBytes, window).
 */
export async function streamLoad(
  engine: StorageEngine,
  generate: (onBatch: BatchSink) => Promise<GenSummary>,
): Promise<LoadResult> {
  const store = await setupEngine(engine);

  let inserted = 0;
  const start = performance.now();
  const gen = await generate(async (rows) => {
    inserted += await store.bulkInsert(rows);
  });
  const loadMs = performance.now() - start;

  return {
    engine,
    store,
    inserted,
    loadMs,
    eventsPerSec: inserted / (loadMs / 1000),
    gen,
  };
}
