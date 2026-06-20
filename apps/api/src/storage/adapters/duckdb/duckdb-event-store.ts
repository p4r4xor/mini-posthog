import {
  DuckDBInstance,
  type DuckDBConnection,
} from "@duckdb/node-api";
import type {
  AggregateResult,
  CellValue,
  CompiledQuery,
  EventRow,
  EventStore,
  EventType,
  InsertResult,
  Outcome,
  ResultColumn,
  RunSummary,
  TraceDetail,
  TraceFilter,
  TraceSummary,
} from "@ata/contracts";
import { SCHEMA_DDL } from "./schema.js";
import { renderAggregate } from "./sql-render.js";

/**
 * DuckDB implementation of the `EventStore` port (docs/architecture.md §6).
 *
 * One wide `events` table is the source of truth; `runs`/`traces` are SQL views
 * deriving rollups (see schema.ts). The neutral `CompiledQuery` is rendered to
 * DuckDB SQL with bound parameters by sql-render.ts — the only dialect-specific
 * code in the query path.
 */
export class DuckDBEventStore implements EventStore {
  private readonly path: string;
  private instance: DuckDBInstance | null = null;
  private connection: DuckDBConnection | null = null;

  constructor(path = ":memory:") {
    this.path = path;
  }

  async init(): Promise<void> {
    if (!this.instance) {
      this.instance = await DuckDBInstance.create(this.path);
    }
    if (!this.connection) {
      this.connection = await this.instance.connect();
    }
    for (const ddl of SCHEMA_DDL) {
      await this.connection.run(ddl);
    }
  }

  private conn(): DuckDBConnection {
    if (!this.connection) {
      throw new Error("DuckDBEventStore not initialised — call init() first");
    }
    return this.connection;
  }

  /**
   * Insert a batch idempotently by event_id. We use the event_id PRIMARY KEY plus
   * `INSERT ... ON CONFLICT (event_id) DO NOTHING`, wrapped in a transaction so the
   * batch is atomic. Duplicates are computed from the row-count delta.
   *
   * NOTE: a DuckDB Appender is faster for bulk load, but it bypasses conflict
   * handling; correctness (idempotent dedup) wins here over raw throughput.
   */
  async insertBatch(rows: EventRow[]): Promise<InsertResult> {
    const conn = this.conn();
    if (rows.length === 0) return { inserted: 0, duplicates: 0 };

    const before = await this.countEvents();

    await conn.run("BEGIN TRANSACTION");
    try {
      const insertSql = `
        INSERT INTO events (
          event_id, trace_id, run_id, project_id, event_type, timestamp,
          agent_name, user_id, step_index, model, tool_name, status, error_type,
          latency_ms, input_tokens, output_tokens, cost_usd, metadata
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18
        )
        ON CONFLICT (event_id) DO NOTHING
      `;
      const prepared = await conn.prepare(insertSql);
      for (const row of rows) {
        prepared.clearBindings();
        prepared.bindVarchar(1, row.eventId);
        prepared.bindVarchar(2, row.traceId);
        prepared.bindVarchar(3, row.runId);
        prepared.bindVarchar(4, row.projectId);
        prepared.bindVarchar(5, row.eventType);
        // Bind timestamp as a normalised "YYYY-MM-DD HH:MM:SS.mmm" varchar; DuckDB
        // casts it to TIMESTAMP on insert (UTC, offset stripped from the ISO input).
        prepared.bindVarchar(6, toDuckTimestamp(row.timestamp));
        prepared.bindVarchar(7, row.agentName);
        prepared.bindVarchar(8, row.userId);
        prepared.bindInteger(9, row.stepIndex);
        bindNullableVarchar(prepared, 10, row.model);
        bindNullableVarchar(prepared, 11, row.toolName);
        bindNullableVarchar(prepared, 12, row.status);
        bindNullableVarchar(prepared, 13, row.errorType);
        bindNullableDouble(prepared, 14, row.latencyMs);
        bindNullableBigInt(prepared, 15, row.inputTokens);
        bindNullableBigInt(prepared, 16, row.outputTokens);
        bindNullableDouble(prepared, 17, row.costUsd);
        prepared.bindVarchar(18, JSON.stringify(row.metadata ?? {}));
        await prepared.run();
      }
      prepared.destroySync();
      await conn.run("COMMIT");
    } catch (err) {
      await conn.run("ROLLBACK");
      throw err;
    }

    const after = await this.countEvents();
    const inserted = after - before;
    return { inserted, duplicates: rows.length - inserted };
  }

  private async countEvents(): Promise<number> {
    const reader = await this.conn().runAndReadAll("SELECT count(*) AS n FROM events");
    const rows = reader.getRowObjectsJS();
    return Number(rows[0]?.n ?? 0);
  }

  async aggregate(query: CompiledQuery, projectId: string): Promise<AggregateResult> {
    const conn = this.conn();
    // Tenant scoping is enforced here, always — prepend a projectId predicate so
    // no query path can accidentally read across projects.
    const scoped: CompiledQuery = {
      ...query,
      where: [
        { kind: "compare", column: "projectId", op: "eq", value: projectId },
        ...query.where,
      ],
    };
    const { sql, params } = renderAggregate(scoped);

    const start = performance.now();
    const reader = await conn.runAndReadAll(sql, params as never[]);
    const rawRows = reader.getRowObjectsJS();
    const latencyMs = performance.now() - start;

    const columns = buildColumns(query);
    const rows = rawRows.map((raw) => normaliseRow(raw, columns));

    return {
      columns,
      rows,
      rowCount: rows.length,
      latencyMs,
      engine: "duckdb",
    };
  }

  async listTraces(filter: TraceFilter): Promise<TraceSummary[]> {
    const conn = this.conn();
    const params: unknown[] = [];
    const conds: string[] = [];

    const add = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };

    // projectId is always present.
    conds.push(`t.project_id = ${add(filter.projectId)}`);
    if (filter.from) conds.push(`t.started_at >= ${add(toDuckTimestamp(filter.from))}`);
    if (filter.to) conds.push(`t.started_at < ${add(toDuckTimestamp(filter.to))}`);
    if (filter.agentName) conds.push(`t.agent_name = ${add(filter.agentName)}`);
    if (filter.status) conds.push(`t.outcome = ${add(filter.status)}`);

    // model / toolName / userId are run/event-level; resolve via the runs view so
    // the explorer can filter traces that contain a matching run.
    const runConds: string[] = [];
    if (filter.model) runConds.push(`r.primary_model = ${add(filter.model)}`);
    if (filter.userId) runConds.push(`r.user_id = ${add(filter.userId)}`);
    if (filter.toolName) {
      runConds.push(
        `r.run_id IN (SELECT run_id FROM events WHERE tool_name = ${add(filter.toolName)})`,
      );
    }
    if (runConds.length > 0) {
      conds.push(
        `t.trace_id IN (SELECT r.trace_id FROM runs r WHERE ${runConds.join(" AND ")})`,
      );
    }

    let sql = `SELECT t.* FROM traces t`;
    if (conds.length > 0) sql += ` WHERE ${conds.join(" AND ")}`;
    sql += ` ORDER BY t.started_at DESC`;
    if (filter.limit !== undefined) sql += ` LIMIT ${Math.trunc(filter.limit)}`;
    if (filter.offset !== undefined) sql += ` OFFSET ${Math.trunc(filter.offset)}`;

    const reader = await conn.runAndReadAll(sql, params as never[]);
    return reader.getRowObjectsJS().map(mapTraceSummary);
  }

  async getTrace(projectId: string, traceId: string): Promise<TraceDetail | null> {
    const conn = this.conn();

    const traceReader = await conn.runAndReadAll(
      `SELECT * FROM traces WHERE project_id = $1 AND trace_id = $2`,
      [projectId, traceId] as never[],
    );
    const traceRows = traceReader.getRowObjectsJS();
    if (traceRows.length === 0) return null;
    const summary = mapTraceSummary(traceRows[0]!);

    const runReader = await conn.runAndReadAll(
      `SELECT * FROM runs WHERE project_id = $1 AND trace_id = $2 ORDER BY started_at ASC`,
      [projectId, traceId] as never[],
    );
    const runs = runReader.getRowObjectsJS().map(mapRunSummary);

    const eventReader = await conn.runAndReadAll(
      `SELECT * FROM events WHERE project_id = $1 AND trace_id = $2 ORDER BY step_index ASC, timestamp ASC`,
      [projectId, traceId] as never[],
    );
    const events = eventReader.getRowObjectsJS().map(mapEventRow);

    return { ...summary, runs, events };
  }

  async close(): Promise<void> {
    if (this.connection) {
      this.connection.closeSync();
      this.connection = null;
    }
    if (this.instance) {
      this.instance.closeSync();
      this.instance = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Result column shaping
// ---------------------------------------------------------------------------

function buildColumns(query: CompiledQuery): ResultColumn[] {
  const cols: ResultColumn[] = [];
  for (const key of query.groupBy) {
    cols.push({
      name: key.alias,
      role: key.kind === "timeBucket" ? "time" : "dimension",
    });
  }
  cols.push({ name: query.metric.alias, role: "measure" });
  return cols;
}

/** Convert a raw DuckDB JS row into chart-ready CellValues keyed by alias. */
function normaliseRow(
  raw: Record<string, unknown>,
  columns: ResultColumn[],
): Record<string, CellValue> {
  const out: Record<string, CellValue> = {};
  for (const col of columns) {
    out[col.name] = toCellValue(raw[col.name], col.role);
  }
  return out;
}

function toCellValue(value: unknown, role: ResultColumn["role"]): CellValue {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    // A "time" bucket may arrive as a DuckDB-formatted string; pass through.
    return value;
  }
  // Fallback for any exotic DuckDB value type.
  return String(value);
}

// ---------------------------------------------------------------------------
// Row mappers (physical snake_case → contract camelCase shapes)
// ---------------------------------------------------------------------------

function mapTraceSummary(r: Record<string, unknown>): TraceSummary {
  return {
    traceId: str(r.trace_id),
    projectId: str(r.project_id),
    agentName: str(r.agent_name),
    outcome: asOutcome(r.outcome),
    runCount: num(r.run_count),
    startedAt: iso(r.started_at)!,
    endedAt: iso(r.ended_at),
    durationMs: numOrNull(r.duration_ms),
    costUsd: num(r.cost_usd),
  };
}

function mapRunSummary(r: Record<string, unknown>): RunSummary {
  return {
    runId: str(r.run_id),
    traceId: str(r.trace_id),
    projectId: str(r.project_id),
    agentName: str(r.agent_name),
    userId: str(r.user_id),
    primaryModel: strOrNull(r.primary_model),
    outcome: asOutcome(r.outcome),
    startedAt: iso(r.started_at)!,
    endedAt: iso(r.ended_at),
    durationMs: numOrNull(r.duration_ms),
    computeMs: num(r.compute_ms),
    stepCount: num(r.step_count),
    costUsd: num(r.cost_usd),
    totalInputTokens: num(r.total_input_tokens),
    totalOutputTokens: num(r.total_output_tokens),
    errorCount: num(r.error_count),
    retryCount: num(r.retry_count),
  };
}

function mapEventRow(r: Record<string, unknown>): EventRow {
  return {
    eventId: str(r.event_id),
    traceId: str(r.trace_id),
    runId: str(r.run_id),
    projectId: str(r.project_id),
    eventType: str(r.event_type) as EventType,
    timestamp: iso(r.timestamp)!,
    agentName: str(r.agent_name),
    userId: str(r.user_id),
    stepIndex: num(r.step_index),
    model: strOrNull(r.model),
    toolName: strOrNull(r.tool_name),
    status: strOrNull(r.status),
    errorType: strOrNull(r.error_type),
    latencyMs: numOrNull(r.latency_ms),
    inputTokens: numOrNull(r.input_tokens),
    outputTokens: numOrNull(r.output_tokens),
    costUsd: numOrNull(r.cost_usd),
    metadata: parseMetadata(r.metadata),
  };
}

// ---------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------

function str(v: unknown): string {
  return v == null ? "" : String(v);
}
function strOrNull(v: unknown): string | null {
  return v == null ? null : String(v);
}
function num(v: unknown): number {
  if (v == null) return 0;
  return typeof v === "bigint" ? Number(v) : Number(v);
}
function numOrNull(v: unknown): number | null {
  if (v == null) return null;
  return typeof v === "bigint" ? Number(v) : Number(v);
}
function iso(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}
function asOutcome(v: unknown): Outcome {
  const s = strOrNull(v);
  return s === "success" || s === "failed" ? s : "running";
}

function parseMetadata(v: unknown): Record<string, unknown> {
  if (v == null) return {};
  if (typeof v === "object") return v as Record<string, unknown>;
  if (typeof v === "string") {
    try {
      const parsed: unknown = JSON.parse(v);
      return parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

/**
 * Normalise an ISO-8601 timestamp (e.g. "2026-05-07T09:12:30.123Z") into a
 * DuckDB TIMESTAMP literal "YYYY-MM-DD HH:MM:SS.mmm" in UTC. We store UTC so
 * comparisons and date_trunc bucketing are stable regardless of input offset.
 */
function toDuckTimestamp(iso8601: string): string {
  const d = new Date(iso8601);
  if (Number.isNaN(d.getTime())) {
    // Let DuckDB attempt to parse the raw string rather than silently corrupt.
    return iso8601;
  }
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.` +
    `${pad(d.getUTCMilliseconds(), 3)}`
  );
}

// ---------------------------------------------------------------------------
// Nullable bind helpers (typed bind → exact column types)
// ---------------------------------------------------------------------------

interface Binder {
  bindVarchar(i: number, v: string): void;
  bindDouble(i: number, v: number): void;
  bindBigInt(i: number, v: bigint): void;
  bindNull(i: number): void;
}

function bindNullableVarchar(p: Binder, i: number, v: string | null): void {
  if (v == null) p.bindNull(i);
  else p.bindVarchar(i, v);
}
function bindNullableDouble(p: Binder, i: number, v: number | null): void {
  if (v == null) p.bindNull(i);
  else p.bindDouble(i, v);
}
function bindNullableBigInt(p: Binder, i: number, v: number | null): void {
  if (v == null) p.bindNull(i);
  else p.bindBigInt(i, BigInt(Math.trunc(v)));
}
