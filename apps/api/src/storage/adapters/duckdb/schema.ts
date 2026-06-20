/**
 * DuckDB schema (DDL) — one wide `events` table + derived `runs`/`traces` VIEWS
 * (docs/architecture.md §6). At demo size, views give always-correct rollups at
 * zero maintenance cost; production would materialise them as rollup tables and,
 * for ClickHouse, AggregatingMergeTree MVs fired on insert (§7).
 *
 * Columns are snake_case and typed to mirror `EventRow` (see field-map.ts for the
 * logical→physical mapping). `metadata` is stored as a JSON string.
 */

export const EVENTS_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS events (
  event_id      VARCHAR PRIMARY KEY,
  trace_id      VARCHAR NOT NULL,
  run_id        VARCHAR NOT NULL,
  project_id    VARCHAR NOT NULL,
  event_type    VARCHAR NOT NULL,
  timestamp     TIMESTAMP NOT NULL,
  agent_name    VARCHAR NOT NULL,
  user_id       VARCHAR NOT NULL,
  step_index    INTEGER NOT NULL,
  model         VARCHAR,
  tool_name     VARCHAR,
  status        VARCHAR,
  error_type    VARCHAR,
  latency_ms    DOUBLE,
  input_tokens  BIGINT,
  output_tokens BIGINT,
  cost_usd      DOUBLE,
  metadata      JSON
);
`;

/**
 * `runs` view — one row per run, derived from its events.
 *
 * Design decisions:
 *  - primary_model: representative model for the run = the model of the highest
 *    step_index event that actually carried a non-null model
 *    (`arg_max(model, step_index)` over non-null models). This matches the
 *    "last model used" rule and the §9 worked compilation (argMax over step_index).
 *  - outcome: status of the run_completed event if present; else "running".
 *    Mapped to the Outcome enum: "success"/"failed" pass through, anything else
 *    (including a missing terminal event) becomes "running".
 *  - duration_ms: wall-clock = epoch_ms(max(ts)) - epoch_ms(min(ts)) (§5).
 *  - compute_ms: sum of per-event latency_ms (§5).
 *  - step_count: max(step_index)+1 (stepIndex is 0-based per run, §3).
 *  - cost/tokens: plain SUM (terminal events carry no independent measure, §5).
 */
export const RUNS_VIEW_DDL = `
CREATE OR REPLACE VIEW runs AS
SELECT
  run_id,
  any_value(trace_id)                                              AS trace_id,
  any_value(project_id)                                           AS project_id,
  any_value(agent_name)                                           AS agent_name,
  any_value(user_id)                                              AS user_id,
  arg_max(model, step_index) FILTER (WHERE model IS NOT NULL)      AS primary_model,
  coalesce(
    max(CASE WHEN event_type = 'run_completed' THEN
      CASE WHEN status IN ('success', 'failed') THEN status ELSE 'running' END
    END),
    'running'
  )                                                                AS outcome,
  min(timestamp)                                                   AS started_at,
  max(timestamp)                                                   AS ended_at,
  (epoch_ms(max(timestamp)) - epoch_ms(min(timestamp)))            AS duration_ms,
  coalesce(sum(latency_ms), 0)                                     AS compute_ms,
  (max(step_index) + 1)                                            AS step_count,
  coalesce(sum(cost_usd), 0)                                       AS cost_usd,
  coalesce(sum(input_tokens), 0)                                   AS total_input_tokens,
  coalesce(sum(output_tokens), 0)                                  AS total_output_tokens,
  coalesce(sum(input_tokens), 0) + coalesce(sum(output_tokens), 0) AS total_tokens,
  count(*) FILTER (WHERE event_type = 'error')                     AS error_count,
  count(*) FILTER (WHERE event_type = 'retry')                     AS retry_count
FROM events
GROUP BY run_id;
`;

/**
 * `traces` view — one row per trace, aggregated over its runs.
 *
 * Design decisions:
 *  - outcome: outcome of the LATEST run by started_at (`arg_max(outcome,
 *    started_at)`). Rationale: a trace groups run-level retries / re-invocations
 *    (§3); the most recent run reflects the trace's final disposition (e.g. a
 *    retried run that finally succeeded → trace "success").
 *  - run_count: count(distinct run_id).
 *  - started/ended/duration: min/max across runs; duration is wall-clock.
 *  - cost_usd: SUM over runs (never double-counts; §5).
 */
export const TRACES_VIEW_DDL = `
CREATE OR REPLACE VIEW traces AS
SELECT
  trace_id,
  any_value(project_id)                                AS project_id,
  any_value(agent_name)                                AS agent_name,
  arg_max(outcome, started_at)                         AS outcome,
  count(DISTINCT run_id)                               AS run_count,
  min(started_at)                                      AS started_at,
  max(ended_at)                                        AS ended_at,
  (epoch_ms(max(ended_at)) - epoch_ms(min(started_at))) AS duration_ms,
  coalesce(sum(cost_usd), 0)                           AS cost_usd
FROM runs
GROUP BY trace_id;
`;

/** All DDL statements, in dependency order. */
export const SCHEMA_DDL: readonly string[] = [
  EVENTS_TABLE_DDL,
  RUNS_VIEW_DDL,
  TRACES_VIEW_DDL,
];
