import type { EventType, Outcome, TimeGrain } from "./common.js";
import type { FilterOp } from "./query-plan.js";
import type { CellValue, ResultColumn } from "./query-result.js";

/**
 * The storage seam (ports & adapters). Everything here is engine-neutral: the
 * DuckDB and ClickHouse adapters implement `EventStore`; the rest of the system
 * depends only on this interface (docs/architecture.md §6).
 */

// ---------------------------------------------------------------------------
// Persistence shapes
// ---------------------------------------------------------------------------

/**
 * The flat, wide storage row - one per event. Typed hot columns for what we
 * filter/group on, plus the `metadata` JSON tail. Sparse columns (e.g. `model`
 * only on LLM events) are null and compress to ~nothing in a columnar store.
 */
export interface EventRow {
  eventId: string;
  traceId: string;
  runId: string;
  projectId: string;
  eventType: EventType;
  timestamp: string;
  agentName: string;
  userId: string;
  stepIndex: number;
  model: string | null;
  toolName: string | null;
  status: string | null;
  errorType: string | null;
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  metadata: Record<string, unknown>;
}

/** A run rollup (derived from its events). Powers run-level metrics + run list. */
export interface RunSummary {
  runId: string;
  traceId: string;
  projectId: string;
  agentName: string;
  userId: string;
  /** Representative model for the run (e.g. last model used). */
  primaryModel: string | null;
  outcome: Outcome;
  startedAt: string;
  endedAt: string | null;
  /** Wall-clock: endedAt − startedAt. */
  durationMs: number | null;
  /** Sum of constituent event latencies. */
  computeMs: number;
  stepCount: number;
  costUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  errorCount: number;
  retryCount: number;
}

/** A trace rollup (derived from its runs). Powers trace-level metrics. */
export interface TraceSummary {
  traceId: string;
  projectId: string;
  agentName: string;
  outcome: Outcome;
  runCount: number;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  costUsd: number;
}

/** A trace with its runs and full event timeline - the explorer detail view. */
export interface TraceDetail extends TraceSummary {
  runs: RunSummary[];
  events: EventRow[];
}

/** Filters for the trace/run explorer list. */
export interface TraceFilter {
  projectId: string;
  from?: string;
  to?: string;
  agentName?: string;
  model?: string;
  toolName?: string;
  status?: string;
  userId?: string;
  limit?: number;
  offset?: number;
}

// ---------------------------------------------------------------------------
// Compiled query - the neutral IR the compiler hands to an adapter
// ---------------------------------------------------------------------------

/** Which logical source a compiled query reads (resolved from QueryLevel). */
export type SourceTable = "events" | "runs" | "traces";

/**
 * NOTE on `column` fields throughout `CompiledQuery`: these are LOGICAL field
 * identifiers from the contract vocabulary (e.g. "latencyMs", "model",
 * "timestamp", "durationMs") - NOT physical SQL column names. Each EventStore
 * adapter owns the logical→physical mapping (snake_case columns, etc.) and the
 * dialect rendering. This keeps the compiler fully engine-agnostic.
 *
 * Logical fields available per source:
 *   - events: EventRow fields (eventId, traceId, runId, eventType, timestamp,
 *             agentName, userId, model, toolName, status, errorType, latencyMs,
 *             inputTokens, outputTokens, costUsd) + derived "totalTokens"
 *   - runs:   RunSummary fields (durationMs, computeMs, stepCount, costUsd,
 *             outcome, agentName, primaryModel→"model", userId, ...)
 *   - traces: TraceSummary fields (durationMs, costUsd, outcome, agentName, ...)
 */
export type CompiledPredicate =
  | { kind: "compare"; column: string; op: FilterOp; value: unknown }
  | { kind: "timeRange"; column: string; from: string; to: string };

/** The aggregate expression to compute, over a logical field (see note above). */
export type CompiledMetric =
  | { kind: "count"; alias: string }
  | { kind: "count_distinct"; column: string; alias: string }
  | { kind: "simple"; fn: "sum" | "avg" | "min" | "max"; column: string; alias: string }
  | { kind: "quantile"; column: string; p: number; alias: string }
  | {
      kind: "ratio";
      numerator: CompiledPredicate[];
      denominator: CompiledPredicate[];
      alias: string;
    };

/** A group-by key: a plain column or a time bucket. */
export type CompiledGroupKey =
  | { kind: "column"; column: string; alias: string }
  | { kind: "timeBucket"; column: string; grain: TimeGrain; alias: string };

/**
 * The neutral, validated query the compiler produces. Each adapter renders this
 * to its own dialect (date bucketing, parameter placeholders) - the only
 * engine-specific code in the query path.
 */
export interface CompiledQuery {
  source: SourceTable;
  metric: CompiledMetric;
  groupBy: CompiledGroupKey[];
  where: CompiledPredicate[];
  orderBy?: { ref: string; dir: "asc" | "desc" };
  limit?: number;
}

// ---------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------

export interface InsertResult {
  inserted: number;
  duplicates: number;
}

/**
 * The lean result an adapter returns from `aggregate`. The adapter measures its
 * own execution latency and shapes columns/rows; the query service wraps this
 * into a `QueryResult` by attaching the plan + chart hint (it owns those).
 */
export interface AggregateResult {
  columns: ResultColumn[];
  rows: Array<Record<string, CellValue>>;
  rowCount: number;
  /** Storage-side execution time in ms (the visible "query latency"). */
  latencyMs: number;
  engine: StorageEngine;
}

/**
 * The storage port. Adapters own how `runs`/`traces` rollups are derived
 * (DuckDB: views/rollup tables; ClickHouse: AggregatingMergeTree MVs) - the rest
 * of the system never sees that.
 */
export interface EventStore {
  /** Create schema / connect. Idempotent. */
  init(): Promise<void>;
  /** Insert a batch of rows; idempotent by eventId. */
  insertBatch(rows: EventRow[]): Promise<InsertResult>;
  /**
   * Execute a compiled analytics query, scoped to a project. Tenant scoping is a
   * REQUIRED argument (not an injectable predicate the caller might forget): the
   * adapter always constrains to `projectId`, so cross-tenant leaks aren't possible.
   */
  aggregate(query: CompiledQuery, projectId: string): Promise<AggregateResult>;
  /** List traces for the explorer. */
  listTraces(filter: TraceFilter): Promise<TraceSummary[]>;
  /** Fetch one trace with its runs + event timeline. */
  getTrace(projectId: string, traceId: string): Promise<TraceDetail | null>;
  /** Release resources. */
  close(): Promise<void>;
}

/** Identifies a storage engine implementation. */
export type StorageEngine = "duckdb" | "clickhouse";
