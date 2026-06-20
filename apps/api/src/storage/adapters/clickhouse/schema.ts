/**
 * ClickHouse schema (DDL) - one wide `events` table (ReplacingMergeTree) + derived
 * `runs`/`traces` VIEWs, implementing the "Production storage refinements
 * (ClickHouse adapter)" subsection of docs/architecture.md §6.
 *
 * Column-type decisions (§6 refinements):
 *  - `Enum8` for `event_type`  - a closed 7-value set, 1 byte, validated at insert.
 *  - `LowCardinality(String)` for the open-but-bounded sets (`agent_name`, `model`,
 *    `tool_name`, `status`, `error_type`, `project_id`) - dictionary-encoded, so
 *    `GROUP BY model` is near-free.
 *  - `Decimal(12,6)` for `cost_usd` - exact money; float sums of many tiny costs drift.
 *  - `DateTime64(3,'UTC')` for `timestamp`; `Nullable` only on sparse measures.
 *
 * Engine / layout (§6 refinements):
 *  - `ReplacingMergeTree` with `event_id` LAST in the ORDER BY: duplicate event_ids
 *    collapse at merge time (our durable, eventual dedup backstop). Events are
 *    immutable, so RMT is used purely for dedup, never for mutable-status updates.
 *  - `PARTITION BY toDate(timestamp)` (DAILY) and
 *    `ORDER BY (project_id, event_type, timestamp, event_id)`. Daily (not monthly)
 *    partitioning is the right call at the design target of up to 1B events/day:
 *    one day ≈ 1B rows is already a large, right-sized partition; retention/TTL is
 *    day-granular (drop the oldest day = O(1) partition drop); and recent-time
 *    queries prune to a handful of partitions. Monthly would make 30B-row
 *    partitions - unwieldy for merges/TTL. (365 partitions/yr is well under CH's
 *    keep-it-under-~1-2k guidance.) The day is now the partition, so `toDate` is
 *    dropped from the sort key; `event_id` last gives the RMT dedup key without
 *    polluting the filter prefix.
 *  - data-skipping bloom-filter indexes on `trace_id` / `run_id`: the
 *    aggregation-optimized sort key does NOT give fast single-id explorer point
 *    lookups, so we resolve them with skip indexes rather than wrecking the sort
 *    key (§6 "Point lookups vs aggregation").
 *
 * Rollups (`runs`/`traces`) are plain ClickHouse VIEWs here. PRODUCTION would use
 * incremental AggregatingMergeTree materialized views fired on insert (§7) - but at
 * prototype scale VIEWs keep the rollups always-correct at zero maintenance cost
 * and give an apples-to-apples benchmark parity with the DuckDB adapter (which also
 * uses views). The rollup rules mirror the DuckDB adapter exactly (schema.ts there).
 */

/** DDL for the wide source-of-truth `events` table. `{db}` is substituted in. */
export function eventsTableDdl(db: string): string {
  return `
CREATE TABLE IF NOT EXISTS ${db}.events (
  event_id      String,
  trace_id      String,
  run_id        String,
  project_id    LowCardinality(String),
  event_type    Enum8('run_started'=1,'llm_call'=2,'tool_call'=3,'step_completed'=4,'error'=5,'retry'=6,'run_completed'=7),
  timestamp     DateTime64(3, 'UTC'),
  agent_name    LowCardinality(String),
  user_id       String,
  step_index    UInt32,
  model         LowCardinality(Nullable(String)),
  tool_name     LowCardinality(Nullable(String)),
  status        LowCardinality(Nullable(String)),
  error_type    LowCardinality(Nullable(String)),
  latency_ms    Nullable(Float64),
  input_tokens  Nullable(UInt32),
  output_tokens Nullable(UInt32),
  cost_usd      Nullable(Decimal(12, 6)),
  metadata      String,
  INDEX idx_trace trace_id TYPE bloom_filter GRANULARITY 4,
  INDEX idx_run   run_id   TYPE bloom_filter GRANULARITY 4
)
ENGINE = ReplacingMergeTree
PARTITION BY toDate(timestamp)
ORDER BY (project_id, event_type, timestamp, event_id);
`;
}

/**
 * `runs` view - one row per run, derived from its events. Rollup rules match the
 * DuckDB adapter:
 *  - primary_model: last non-null model by step_index (argMaxIf guarded for nulls).
 *  - outcome: status of the run_completed event if 'success'/'failed', else 'running'.
 *  - duration_ms: wall-clock = dateDiff('millisecond', min(ts), max(ts)) (§5).
 *  - compute_ms: sum of per-event latency_ms (§5).
 *  - step_count: max(step_index)+1 (0-based per run, §3).
 *  - cost/tokens: plain SUM (terminal events carry no independent measure, §5).
 *
 * cost_usd is summed as Decimal then cast to Float64 so the view column is a plain
 * number (the adapter normalises Decimals from JSON anyway).
 */
export function runsViewDdl(db: string): string {
  return `
CREATE VIEW IF NOT EXISTS ${db}.runs AS
SELECT
  run_id,
  any(trace_id)                                                       AS trace_id,
  any(project_id)                                                     AS project_id,
  any(agent_name)                                                     AS agent_name,
  any(user_id)                                                        AS user_id,
  argMaxIf(model, step_index, model IS NOT NULL)                      AS primary_model,
  coalesce(
    maxIf(
      if(status IN ('success', 'failed'), status, 'running'),
      event_type = 'run_completed'
    ),
    'running'
  )                                                                   AS outcome,
  min(timestamp)                                                      AS started_at,
  max(timestamp)                                                      AS ended_at,
  dateDiff('millisecond', min(timestamp), max(timestamp))            AS duration_ms,
  toFloat64(coalesce(sum(latency_ms), 0))                             AS compute_ms,
  (max(step_index) + 1)                                               AS step_count,
  toFloat64(coalesce(sum(cost_usd), 0))                              AS cost_usd,
  toFloat64(coalesce(sum(input_tokens), 0))                           AS total_input_tokens,
  toFloat64(coalesce(sum(output_tokens), 0))                          AS total_output_tokens,
  toFloat64(coalesce(sum(input_tokens), 0) + coalesce(sum(output_tokens), 0)) AS total_tokens,
  countIf(event_type = 'error')                                       AS error_count,
  countIf(event_type = 'retry')                                       AS retry_count
FROM ${db}.events
GROUP BY run_id;
`;
}

/**
 * `traces` view - one row per trace, aggregated over its runs. Rollup rules match
 * the DuckDB adapter:
 *  - outcome: outcome of the LATEST run by started_at (argMax over started_at).
 *  - run_count: uniqExact(run_id).
 *  - started/ended/duration: min/max across runs; duration is wall-clock.
 *  - cost_usd: SUM over runs (never double-counts; §5).
 */
export function tracesViewDdl(db: string): string {
  // The inner subquery is the run rollup (identical logic to the \`runs\` view) but
  // built directly over \`events\` with PREFIXED (r_*) aliases. We can't reference
  // the \`runs\` view here: ClickHouse inlines views at definition time, so the
  // runs view's own aggregates (min/max/argMax over events) would nest inside
  // these aggregates AND the inner \`started_at\` alias would collide with the outer
  // \`started_at\` alias - both raise ILLEGAL_AGGREGATION. Distinct inner alias
  // names + a true subquery scope avoid that.
  return `
CREATE VIEW IF NOT EXISTS ${db}.traces AS
SELECT
  trace_id,
  any(r_project)                                      AS project_id,
  any(r_agent)                                        AS agent_name,
  argMax(r_outcome, r_started)                        AS outcome,
  uniqExact(run_id)                                   AS run_count,
  min(r_started)                                      AS started_at,
  max(r_ended)                                        AS ended_at,
  dateDiff('millisecond', min(r_started), max(r_ended)) AS duration_ms,
  toFloat64(sum(r_cost))                              AS cost_usd
FROM (
  SELECT
    run_id,
    any(trace_id)                                                AS trace_id,
    any(project_id)                                              AS r_project,
    any(agent_name)                                              AS r_agent,
    min(timestamp)                                               AS r_started,
    max(timestamp)                                               AS r_ended,
    toFloat64(coalesce(sum(cost_usd), 0))                        AS r_cost,
    coalesce(
      maxIf(
        if(status IN ('success', 'failed'), status, 'running'),
        event_type = 'run_completed'
      ),
      'running'
    )                                                            AS r_outcome
  FROM ${db}.events
  GROUP BY run_id
)
GROUP BY trace_id;
`;
}

/** All schema DDL (table + views), in dependency order, for a given database. */
export function schemaDdl(db: string): readonly string[] {
  return [eventsTableDdl(db), runsViewDdl(db), tracesViewDdl(db)];
}
