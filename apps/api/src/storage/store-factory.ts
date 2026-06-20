import type { EventStore, StorageEngine } from "@ata/contracts";
import { DuckDBEventStore } from "./index.js";

/**
 * Options for constructing an EventStore. `path` is the DuckDB database file (or
 * ":memory:"); ignored by engines that don't take a local path.
 */
export interface CreateEventStoreOptions {
  /** DuckDB database path; defaults to env `ATA_DB_PATH` else a local file. */
  path?: string;
}

const DEFAULT_DB_PATH = "ata.duckdb";

/**
 * Construct the EventStore for the requested engine. The rest of the system
 * depends only on the `EventStore` port (docs/architecture.md §6), so swapping
 * engines is a one-line config change here.
 */
export function createEventStore(
  engine: StorageEngine,
  opts: CreateEventStoreOptions = {},
): EventStore {
  switch (engine) {
    case "duckdb": {
      const path = opts.path ?? process.env.ATA_DB_PATH ?? DEFAULT_DB_PATH;
      return new DuckDBEventStore(path);
    }
    case "clickhouse":
      throw new Error("ClickHouse adapter not yet wired (wave 3)");
    default: {
      const exhaustive: never = engine;
      throw new Error(`Unknown storage engine: ${String(exhaustive)}`);
    }
  }
}
