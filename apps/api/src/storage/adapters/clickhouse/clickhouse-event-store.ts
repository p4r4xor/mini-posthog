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
import { type ClickHouseClient, createClient } from "@clickhouse/client";
import type { ClickHouseConfig } from "../../../config.js";
import { schemaDdl } from "./schema.js";
import { renderAggregate } from "./sql-render.js";

/**
 * ClickHouse implementation of the `EventStore` port (docs/architecture.md §6,
 * "Production storage refinements"). It is the second engine behind the same port
 * as the DuckDB adapter and produces the SAME logical results (engine =
 * "clickhouse").
 *
 * One wide `events` table (ReplacingMergeTree) is the source of truth; `runs` /
 * `traces` are SQL views deriving rollups (see schema.ts). The neutral
 * `CompiledQuery` is rendered to ClickHouse SQL with bound params by sql-render.ts.
 */
export class ClickHouseEventStore implements EventStore {
  private readonly cfg: ClickHouseConfig;
  private client: ClickHouseClient | null = null;

  constructor(cfg: ClickHouseConfig) {
    this.cfg = cfg;
  }

  async init(): Promise<void> {
    // Connect to the server WITHOUT a database first, so we can create it.
    const bootstrap = createClient({
      url: this.cfg.url,
      username: this.cfg.username,
      password: this.cfg.password,
    });
    try {
      await bootstrap.command({
        query: `CREATE DATABASE IF NOT EXISTS ${this.cfg.database}`,
      });
    } finally {
      await bootstrap.close();
    }

    // Now bind the client to the (now-existing) database.
    this.client = createClient({
      url: this.cfg.url,
      username: this.cfg.username,
      password: this.cfg.password,
      database: this.cfg.database,
    });

    for (const ddl of schemaDdl(this.cfg.database)) {
      await this.client.command({ query: ddl });
    }
  }

  private c(): ClickHouseClient {
    if (!this.client) {
      throw new Error("ClickHouseEventStore not initialised — call init() first");
    }
    return this.client;
  }

  /**
   * Insert a batch idempotently by event_id.
   *
   * ClickHouse has no unique constraint / `ON CONFLICT`. Our durable backstop is the
   * `ReplacingMergeTree` engine (event_id last in ORDER BY), but RMT dedup is
   * *eventual* (merge-time): until a merge runs, duplicate event_ids are visible,
   * and `SELECT … FINAL` (which forces correctness) is expensive. So we ALSO
   * **dedup before insert** (docs §6/§12): query which of the batch's event_ids
   * already exist, insert only the new rows, and report exact inserted/duplicates.
   * This keeps reads correct without ever paying for FINAL. (We also dedup within
   * the batch itself, so a batch carrying the same event_id twice counts once.)
   */
  async insertBatch(rows: EventRow[]): Promise<InsertResult> {
    if (rows.length === 0) return { inserted: 0, duplicates: 0 };
    const client = this.c();

    // De-dup within the batch (keep first occurrence per event_id).
    const byId = new Map<string, EventRow>();
    for (const row of rows) {
      if (!byId.has(row.eventId)) byId.set(row.eventId, row);
    }
    const uniqueRows = [...byId.values()];

    // Which of these event_ids already exist? (cheap: bloom-filter skip index + PK).
    const ids = [...byId.keys()];
    const existing = await client.query({
      query: `SELECT DISTINCT event_id FROM events WHERE event_id IN {ids:Array(String)}`,
      query_params: { ids },
      format: "JSONEachRow",
    });
    const existingRows = await existing.json<{ event_id: string }>();
    const existingIds = new Set(existingRows.map((r) => r.event_id));

    const toInsert = uniqueRows.filter((r) => !existingIds.has(r.eventId));

    if (toInsert.length > 0) {
      await client.insert({
        table: "events",
        values: toInsert.map(toInsertRow),
        format: "JSONEachRow",
      });
    }

    const inserted = toInsert.length;
    return { inserted, duplicates: rows.length - inserted };
  }

  async aggregate(query: CompiledQuery, projectId: string): Promise<AggregateResult> {
    const client = this.c();
    // Tenant scoping is enforced here, always — prepend a projectId predicate so no
    // query path can accidentally read across projects.
    const scoped: CompiledQuery = {
      ...query,
      where: [
        { kind: "compare", column: "projectId", op: "eq", value: projectId },
        ...query.where,
      ],
    };
    const { sql, params } = renderAggregate(scoped);

    const start = performance.now();
    const rs = await client.query({
      query: sql,
      query_params: params,
      format: "JSONEachRow",
    });
    const rawRows = await rs.json<Record<string, unknown>>();
    const latencyMs = performance.now() - start;

    const columns = buildColumns(query);
    const resultRows = rawRows.map((raw) => normaliseRow(raw, columns));

    return {
      columns,
      rows: resultRows,
      rowCount: resultRows.length,
      latencyMs,
      engine: "clickhouse",
    };
  }

  async listTraces(filter: TraceFilter): Promise<TraceSummary[]> {
    const client = this.c();
    const params: Record<string, unknown> = {};
    const conds: string[] = [];
    let n = 0;
    const add = (value: unknown, type: string): string => {
      const name = `p${n++}`;
      params[name] = value;
      return `{${name}:${type}}`;
    };

    // projectId is always present.
    conds.push(`t.project_id = ${add(filter.projectId, "String")}`);
    if (filter.from)
      conds.push(`t.started_at >= ${add(toChDateTime(filter.from), "String")}`);
    if (filter.to) conds.push(`t.started_at < ${add(toChDateTime(filter.to), "String")}`);
    if (filter.agentName) conds.push(`t.agent_name = ${add(filter.agentName, "String")}`);
    if (filter.status) conds.push(`t.outcome = ${add(filter.status, "String")}`);

    // model / toolName / userId are run/event-level; resolve via the runs view so
    // the explorer can filter traces that contain a matching run.
    const runConds: string[] = [];
    if (filter.model) runConds.push(`r.primary_model = ${add(filter.model, "String")}`);
    if (filter.userId) runConds.push(`r.user_id = ${add(filter.userId, "String")}`);
    if (filter.toolName) {
      runConds.push(
        `r.run_id IN (SELECT run_id FROM events WHERE tool_name = ${add(filter.toolName, "String")})`,
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

    const rs = await client.query({
      query: sql,
      query_params: params,
      format: "JSONEachRow",
    });
    const raw = await rs.json<Record<string, unknown>>();
    return raw.map(mapTraceSummary);
  }

  async getTrace(projectId: string, traceId: string): Promise<TraceDetail | null> {
    const client = this.c();
    const idParams = { pid: projectId, tid: traceId };

    const traceRs = await client.query({
      query: `SELECT * FROM traces WHERE project_id = {pid:String} AND trace_id = {tid:String}`,
      query_params: idParams,
      format: "JSONEachRow",
    });
    const traceRows = await traceRs.json<Record<string, unknown>>();
    if (traceRows.length === 0) return null;
    const summary = mapTraceSummary(traceRows[0]!);

    const runRs = await client.query({
      query: `SELECT * FROM runs WHERE project_id = {pid:String} AND trace_id = {tid:String} ORDER BY started_at ASC`,
      query_params: idParams,
      format: "JSONEachRow",
    });
    const runs = (await runRs.json<Record<string, unknown>>()).map(mapRunSummary);

    const eventRs = await client.query({
      query: `SELECT * FROM events WHERE project_id = {pid:String} AND trace_id = {tid:String} ORDER BY step_index ASC, timestamp ASC`,
      query_params: idParams,
      format: "JSONEachRow",
    });
    const events = (await eventRs.json<Record<string, unknown>>()).map(mapEventRow);

    return { ...summary, runs, events };
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Insert row shaping (EventRow → ClickHouse JSONEachRow record)
// ---------------------------------------------------------------------------

/**
 * Shape an EventRow into the physical snake_case record ClickHouse ingests.
 *  - timestamp → "YYYY-MM-DD HH:MM:SS.mmm" UTC (DateTime64(3) literal).
 *  - cost_usd → string form of the number so Decimal(12,6) is parsed exactly
 *    (floats round-trip lossily through JSON for money).
 *  - metadata → JSON string (the column is `String`).
 *  - nullable measures pass through as null.
 */
function toInsertRow(row: EventRow): Record<string, unknown> {
  return {
    event_id: row.eventId,
    trace_id: row.traceId,
    run_id: row.runId,
    project_id: row.projectId,
    event_type: row.eventType,
    timestamp: toChDateTime(row.timestamp),
    agent_name: row.agentName,
    user_id: row.userId,
    step_index: row.stepIndex,
    model: row.model,
    tool_name: row.toolName,
    status: row.status,
    error_type: row.errorType,
    latency_ms: row.latencyMs,
    input_tokens: row.inputTokens,
    output_tokens: row.outputTokens,
    cost_usd: row.costUsd == null ? null : String(row.costUsd),
    metadata: JSON.stringify(row.metadata ?? {}),
  };
}

/**
 * Normalise an ISO-8601 timestamp into a ClickHouse DateTime64(3) literal
 * "YYYY-MM-DD HH:MM:SS.mmm" in UTC. We store UTC so comparisons and bucketing are
 * stable regardless of input offset.
 */
function toChDateTime(iso8601: string): string {
  const d = new Date(iso8601);
  if (Number.isNaN(d.getTime())) return iso8601;
  const pad = (val: number, w = 2) => String(val).padStart(w, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.` +
    `${pad(d.getUTCMilliseconds(), 3)}`
  );
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

/** Convert a raw ClickHouse JSON row into chart-ready CellValues keyed by alias. */
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

/**
 * ClickHouse JSON returns numeric types (Decimal, UInt64/Int64, Float as a string
 * in some cases) as strings to avoid JS precision loss. We normalise measures back
 * to JS numbers; time/dimension values pass through as strings.
 */
function toCellValue(value: unknown, role: ResultColumn["role"]): CellValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  if (role === "measure") {
    // measures are always numeric in our metric set; coerce CH's string-encoded
    // Decimal/Int64/Float64 to a JS number.
    const num = typeof value === "number" ? value : Number(value);
    return Number.isNaN(num) ? null : num;
  }
  if (typeof value === "number") return value;
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
// Value helpers (CH JSON encodes Decimals/UInt64 as strings — normalise)
// ---------------------------------------------------------------------------

function str(v: unknown): string {
  return v == null ? "" : String(v);
}
function strOrNull(v: unknown): string | null {
  return v == null ? null : String(v);
}
function num(v: unknown): number {
  if (v == null) return 0;
  return typeof v === "number" ? v : Number(v);
}
function numOrNull(v: unknown): number | null {
  if (v == null) return null;
  return typeof v === "number" ? v : Number(v);
}
/**
 * Normalise a ClickHouse DateTime64 value ("YYYY-MM-DD HH:MM:SS.mmm", UTC) into an
 * ISO-8601 string so contract shapes match the DuckDB adapter.
 */
function iso(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  const s = String(v);
  // CH returns "2026-05-07 09:00:00.000"; treat as UTC and convert to ISO.
  const d = new Date(s.includes("T") ? s : `${s.replace(" ", "T")}Z`);
  return Number.isNaN(d.getTime()) ? s : d.toISOString();
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
