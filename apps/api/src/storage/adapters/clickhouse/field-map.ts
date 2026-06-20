import type { SourceTable } from "@ata/contracts";

/**
 * Logical→physical column mapping for the ClickHouse adapter (docs/architecture.md
 * §6). Identical logical vocabulary to the DuckDB adapter - the compiler hands us
 * the same camelCase logical names; each adapter owns its own physical mapping +
 * dialect. Physical columns are snake_case and match schema.ts.
 *
 * `events` is the wide source-of-truth table; `runs`/`traces` are SQL views that
 * derive rollups from it. Each source exposes a different logical-field set, so we
 * keep one map per source.
 */

/**
 * Logical fields that resolve to a SQL EXPRESSION rather than a bare column.
 * `totalTokens` only exists at the event grain as (input + output); at the rollup
 * grain it is materialised as a real `total_tokens` column in the view.
 */
const EVENT_EXPRESSIONS: Record<string, string> = {
  totalTokens: "(coalesce(input_tokens, 0) + coalesce(output_tokens, 0))",
};

const EVENT_COLUMNS: Record<string, string> = {
  eventId: "event_id",
  traceId: "trace_id",
  runId: "run_id",
  projectId: "project_id",
  eventType: "event_type",
  timestamp: "timestamp",
  agentName: "agent_name",
  userId: "user_id",
  stepIndex: "step_index",
  model: "model",
  toolName: "tool_name",
  status: "status",
  errorType: "error_type",
  latencyMs: "latency_ms",
  inputTokens: "input_tokens",
  outputTokens: "output_tokens",
  costUsd: "cost_usd",
};

const RUN_COLUMNS: Record<string, string> = {
  runId: "run_id",
  traceId: "trace_id",
  projectId: "project_id",
  agentName: "agent_name",
  userId: "user_id",
  // RunSummary.primaryModel is exposed under the logical name "model".
  model: "primary_model",
  primaryModel: "primary_model",
  outcome: "outcome",
  startedAt: "started_at",
  endedAt: "ended_at",
  timestamp: "started_at",
  durationMs: "duration_ms",
  computeMs: "compute_ms",
  stepCount: "step_count",
  costUsd: "cost_usd",
  totalTokens: "total_tokens",
  inputTokens: "total_input_tokens",
  outputTokens: "total_output_tokens",
  errorCount: "error_count",
  retryCount: "retry_count",
};

const TRACE_COLUMNS: Record<string, string> = {
  traceId: "trace_id",
  projectId: "project_id",
  agentName: "agent_name",
  outcome: "outcome",
  runCount: "run_count",
  startedAt: "started_at",
  endedAt: "ended_at",
  timestamp: "started_at",
  durationMs: "duration_ms",
  costUsd: "cost_usd",
};

const COLUMNS_BY_SOURCE: Record<SourceTable, Record<string, string>> = {
  events: EVENT_COLUMNS,
  runs: RUN_COLUMNS,
  traces: TRACE_COLUMNS,
};

const EXPRESSIONS_BY_SOURCE: Record<SourceTable, Record<string, string>> = {
  events: EVENT_EXPRESSIONS,
  // At rollup grain totalTokens is a materialised column (handled by COLUMNS map).
  runs: {},
  traces: {},
};

/**
 * Resolve a logical field name to a physical SQL fragment (column or expression)
 * for the given source. Throws on unknown fields - the compiler only emits
 * whitelisted names, so an unknown name is a programming error, not user input.
 */
export function resolveField(source: SourceTable, logical: string): string {
  const expr = EXPRESSIONS_BY_SOURCE[source][logical];
  if (expr) return expr;
  const col = COLUMNS_BY_SOURCE[source][logical];
  if (col) return col;
  throw new Error(`Unknown logical field "${logical}" for source "${source}"`);
}

/** Physical table/view name backing a logical source. */
export function resolveSource(source: SourceTable): string {
  return source;
}
