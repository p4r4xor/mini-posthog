# Agent Trace Analytics — Architecture & Design

A mini PostHog/Mixpanel for AI agent traces: log traces from an SDK, ingest them,
store them in an analytical engine, and make them explorable through natural-language
queries, charts, and a trace explorer.

This document is the single source of design truth. It is written to be reviewed
end-to-end before implementation and to double as the architecture note in the
final submission.

---

## 1. Scope

Scoping is itself a success criterion ("ability to scope a large product into a
credible 6-hour prototype"). We deliberately build a **thin but complete vertical
slice** and document — not build — the production scale-out.

### In scope (what we build)

| Area | What we build |
| --- | --- |
| SDK | TS SDK: `init`, hierarchical `trace`/`run`, typed capture methods, count+time batching, retry w/ backoff, explicit `flush`/`shutdown` |
| Ingestion | `POST /capture` — validate, dedup by `eventId`, buffer, batched write. Hardcoded local project + API key |
| Storage | One wide `events` table + derived `runs`/`traces` rollups, behind one `EventStore` interface. **Two real adapters: DuckDB + ClickHouse** |
| Query | Typed `QueryPlan` IR → per-dialect compiler → parameterized SQL. Event/run/trace grains |
| NL | Hybrid: deterministic templates first, LLM-constrained planner fallback. Never emits SQL/code |
| Frontend | NL input + example questions, chart/table output, visible query latency, trace/run explorer with filters |
| Simulator | Uses the SDK. Demo dataset (fast) + ~1M-event benchmark dataset |
| Benchmark | Harness running the supported queries across both engines, reporting p50/p95 + on-disk size |

### Evaluation-level targets

- **L1 (vertical slice):** SDK → `/capture` → storage → UI shows traces → hardcoded queries work.
- **L2 (real prototype):** good trace/event model, batching+retries, multiple chart types, visible latency, NL → real queries.
- **L3 (systems):** earned storage decision, indexing/MV strategy, 1M dataset, fast common queries, **unsupported queries fail cleanly**.
- **L4 (production judgment):** scaling path to 10M/100M/1B, ClickHouse↔DuckDB tradeoffs, backpressure/schema-evolution/multi-tenancy/retention/cost discussed.

### Out of scope (documented, not built)

Production auth, billing, cloud deploy, complex permissions, full multi-tenant
account management, pixel-perfect UI. A real async queue + worker (we do
in-process batched writes and document the Kafka/queue/worker path). Cold-tier
object storage (documented). These are intentional — see §13.

---

## 2. Open questions (sent to assignment-giver; we proceed on defaults)

None of these block work; each has a documented default we ship if unanswered.

1. **Rollup measures on terminal events.** `trace_completed` carries `latencyMs`
   and `costUsd` that look like trace-level rollups, not independent values.
   Are constituent events meant to sum to the totals, or are the totals
   authoritative? → **Default:** measures are owned by the operation event;
   terminal/lifecycle events carry no independent summable measure. `SUM` is
   always safe. See §5, §6.
2. **Run→model attribution.** "Cost per run by model" is ambiguous if a run calls
   several models. → **Default:** per-event attribution for "by model" metrics; a
   representative run-model only when the grain is genuinely run-level.
3. **SLA.** Target query latency regardless of event count? → **Default:** p95 < 1s
   on the 1M dataset for supported queries; we publish measured numbers.
4. **Trace vs run hierarchy.** Confirmed by stakeholder: **one trace → many runs**
   (run-level retries + re-invocations/turns). We use `run_started`/`run_completed`
   as the operative lifecycle; trace is the grouping. The fixture is 1:1 and names
   everything `trace_*`, so we confirm to avoid an evaluation mismatch.
5. **Storage management expectations.** Retention/downsampling/pre-aggregation
   required, or is raw-event storage + query-time aggregation fine for the
   prototype? → **Default:** prototype does query-time aggregation + rollup tables;
   we document downsampling/retention/tiering for production (§7).
6. **NL scope.** Fixed catalog of supported patterns (clean rejection outside) vs
   open-ended best-effort? → **Default:** a published supported-pattern catalog;
   anything that doesn't map to a valid plan is rejected with a helpful message,
   never guessed.

---

## 3. Domain: trace, run, event

- **Run** = one complete agent invocation: a prompt → reasoning/LLM/tool/step
  events, possibly step-level retries and errors → a final response with one
  outcome. `stepIndex` is scoped to the run. A run has exactly one outcome.
- **Trace** = the logical thread grouping related runs — **run-level retries**
  (whole invocation re-attempted) and **re-invocations / conversational turns** on
  the same task/session. Trace outcome and totals are *derived* from its runs.
- **Two kinds of retry**, deliberately distinguished:
  - **Step-level retry** — re-attempt one tool/LLM call → a `retry` *event inside a run*.
  - **Run-level retry** — re-run the whole agent → a *new run inside the trace*.

### Event types (our model)

`run_started`, `llm_call`, `tool_call`, `step_completed`, `error`, `retry`,
`run_completed`. (Deliberate, documented divergence from the fixture's `trace_*`
naming — our lifecycle is per-run; trace state is derivable. See open question #4.)

---

## 4. Layered data model (no shortcuts)

Four representations, each owned by one layer, with explicit mappers between them.
No layer reads another's representation.

| Layer | Type | Owns | Why distinct |
| --- | --- | --- | --- |
| **Wire DTO** | `CaptureEvent` (discriminated union on `eventType`) | public ingestion contract, versioned, validated at the edge | SDK↔API stability; this is "validation for required fields" |
| **Domain** | `TraceEvent` union **+ `Run`/`Trace` aggregate roots** | business logic (ingest, trace assembly, analytics semantics) | the aggregates are *derived*, not in the fixture; needed for run/trace metrics |
| **Storage row** | `EventRow` (typed hot columns + `metadata` JSON) | persistence, engine-neutral schema | wide-table/JSON-bag pattern; absorbs schema evolution |
| **Query result** | `QueryResult { columns, rows, meta, chartHint }` | API → frontend | shaped for charting + latency display |

Each event type is a proper union member: `LLMCallEvent` carries
`model/inputTokens/outputTokens/costUsd/latencyMs`; `ToolCallEvent` carries
`toolName/status/latencyMs`; `ErrorEvent` carries `errorType`; etc. The compiler
enforces that an LLM call cannot be missing tokens. Shared envelope on every event:
`eventId, traceId, runId, stepIndex, timestamp, agentName, userId, projectId,
metadata`.

Contracts (Zod schemas → derived TS types) live in `packages/contracts` and are
the single source of truth shared by SDK, API, and web.

---

## 5. Measure semantics (the subtle part)

Three structurally different "latency" computations, so the schema separates them:

| Metric | Meaning | Computation | Grain |
| --- | --- | --- | --- |
| LLM/tool call latency | per-call latency | `avg/quantile(latencyMs)` | event |
| Trace/run duration | **wall-clock** | `max(ts) − min(ts)` | run/trace (derived) |
| Compute time | **summed component latency** | `sum(latencyMs)` | run/trace (rollup) |

**Schema consequence:** `latencyMs` is *strictly* a per-event operation latency.
Duration is never stored in that column — it is derived in the `runs`/`traces`
rollups from `min/max(timestamp)` as a separate field (`durationMs`). Rollups also
carry `computeMs` (sum of step latencies), `costUsd` (Σ event costs), `stepCount`.

**Cost:** an additive per-operation measure on the event that incurs it (LLM call,
or a tool call if it costs money). Trace/run cost = plain `SUM(costUsd)`. Terminal
events carry no independent cost in our model, so `SUM` never double-counts.

The QueryPlan's `metric.field` offers `latencyMs` at event grain only, and
`durationMs`/`computeMs` at run/trace grain only; the validator rejects
nonsensical combinations (e.g. `durationMs` at `level: event`) — this is how
"queries that don't fit the model" fail structurally instead of silently lying.

---

## 6. Storage architecture

### Table layout — one wide table + derived rollups

- **`events`** — append-only, one row per event, all types, typed hot columns +
  `metadata` JSON. Source of truth. Powers every event-level query + the trace
  timeline. Sparse columns (e.g. `model` only on LLM events) cost ~nothing:
  columnar engines compress null/empty runs in a row group to almost zero.
- **`runs`** — one row per run (derived: `costUsd`, `durationMs`, `computeMs`,
  `stepCount`, `outcome`, primary agent/model). Powers run-level metrics + run list.
- **`traces`** — one row per trace (rollup over its runs). Powers trace-level
  metrics + "slowest traces".

This maps directly to the QueryPlan `level: event|run|trace`: the compiler routes
`event` → `events`, `run`/`trace` → the rollup tables. The two-grain query problem
and the table layout are the same problem.

Rejected: **per-event-type tables** (separate `llm_calls`, `tool_calls`, …). The
trace explorer and cross-type queries would need UNIONs/joins, which ClickHouse
specifically penalizes; the dense-schema win is erased by null compression anyway.

### How each engine stores it

- **DuckDB:** single-file columnar DB. Tables split into **row groups (~122,880
  rows)**; each column compressed independently with a **zonemap (min/max)** used to
  skip row groups — the analogue of ClickHouse granule min/max. No in-file time
  partitioning; pruning comes from **insertion order + zonemaps**, so we write
  roughly time-ordered. Real partitioning = Hive-partitioned **Parquet on disk**
  queried in place (the DuckLake pattern). Rollups = materialized rollup tables
  (views at demo size).
- **ClickHouse:** `MergeTree` family. `PARTITION BY toYYYYMM(timestamp)`,
  `ORDER BY (project_id, toDate(timestamp), event_type, …)` (low-cardinality
  first → sparse PK skips + partition pruning). Rollups = **AggregatingMergeTree
  materialized views** fired on insert. Hot `metadata` keys → **materialized
  columns**; high-cardinality filters → **bloom-filter skip indexes / projections**.

### The EventStore seam

```ts
interface EventStore {
  init(): Promise<void>
  insertBatch(rows: EventRow[]): Promise<InsertResult>   // idempotent by eventId
  aggregate(q: CompiledQuery): Promise<QueryResult>        // analytics
  listTraces(f: TraceFilter): Promise<TraceSummary[]>      // explorer
  getTrace(id: string): Promise<TraceDetail>
  close(): Promise<void>
}
```

Adapters: `DuckDBEventStore`, `ClickHouseEventStore`. Swapping engines = one new
class + a config flag; nothing upstream moves. The compiler emits a neutral plan
that each adapter renders to its dialect (date bucketing, param syntax).

---

## 7. Storage management at scale (Grafana/Prometheus lens)

Dashboard queries ("runs per hour", "latency over time") are time-series; at large
volumes we do **not** scan raw events to draw them — the same reason Prometheus has
recording rules and Thanos has downsampling.

- **Time-partition + TTL raw events.** `toYYYYMM` (daily at high volume); expire raw
  after a retention window.
- **Pre-aggregated rollup MVs = recording rules.** Minute/hour-grained
  AggregatingMergeTree MVs keyed by common dimensions (model, tool, agent, status).
  Dashboards read the rollup, not raw. Biggest scale lever.
- **Downsampling = Thanos.** Minute grain for recent data, hour/day for old;
  expire fine grain early, keep coarse rollups long.
- **High-cardinality filters** (`userId`, `traceId`): bloom-filter skip indexes /
  projections (CH); write order + zonemaps (DuckDB).
- **Cold tiering.** Age old partitions to Parquet on object storage — CH tiered
  storage / `S3` tables; DuckDB reads them in place (DuckLake/DuckGres decoupled
  storage). Hot recent data local, cold history in Parquet.

The engine comparison therefore includes "how cheaply can each maintain
incremental rollups," where CH's MV-on-insert is a genuine edge; for DuckDB we
measure rebuild-rollup cost and document the gap.

---

## 8. Storage engine decision (earned, not asserted)

We implement **both DuckDB and ClickHouse** and decide via benchmark + a
production-translation argument on two axes:

- **Query-engine quality** — latency/compression on our workload (measured).
- **Operational/production fit** — concurrent ingest+serving, horizontal scale,
  streaming writes, multi-tenancy (reasoned).

The DuckGres lesson (PostHog wrapping DuckDB in the Postgres wire protocol +
DuckLake) is the spine of the production argument: embedded DuckDB's limitation is
not speed but the **access pattern** — single read-write process, vertical-only,
batch-not-stream. ClickHouse is built for concurrent streaming ingest + serving.

**Benchmark plan:** simulator generates 1M events → load into each adapter → run
the supported queries × N iterations → report p50/p95 latency + on-disk size. That
table goes here once measured.

**Scaling path (to fill with reasoning):** 1M → DuckDB trivially; 10M → both
sub-second single node, DuckDB sweet spot; 100M → both viable single node (CH
~148ms vs DuckDB ~348ms on ClickBench-class workloads); 1B → ClickHouse clustered
wins by orders of magnitude, DuckDB runs but multi-user serving strains → either CH
or DuckGres/DuckLake decoupled storage.

---

## 9. QueryPlan contract (NL ↔ query engine)

We never let NL/LLM produce SQL. A small, closed, typed **IR** describes *what* to
compute; one compiler is the only thing that writes SQL, from a validated plan,
with bound parameters. Buys safety (enums/whitelist only), portability (one IR →
DuckDB + ClickHouse), testability (translator and engine never import each other).

```ts
QueryPlan {
  level:      'event' | 'run' | 'trace'   // population before aggregation
  metric:     { agg, field, ratio? }       // count|count_distinct|sum|avg|min|max|ratio
  dimensions: Dimension[]                   // agentName|model|toolName|status|eventType|userId|errorType | {time: grain}
  filters:    Filter[]                      // {field, op∈{eq,neq,in,gt,gte,lt,lte}, value}
  timeRange:  { from, to }
  sort?, limit?, chartHint                   // line|bar|table
}
```

- **`level`** decides whether the compiler injects a run/trace-rollup CTE before
  the outer aggregation. Event-level reads `events`; run/trace reads the rollups.
- **`ratio`** = numerator predicate / denominator predicate (both counts), e.g.
  "error rate by tool" = `countIf(status='failed') / count(*)`.
- **`time` dimension** carries a grain (minute/hour/day) → bucketed timestamp.

### Supported-query catalog (reverse-engineered from the prompt)

| NL question | level | metric | dims | sort/limit | chart |
| --- | --- | --- | --- | --- | --- |
| Avg LLM latency by model over time | event | avg(latencyMs) | model, time(hour) | time↑ | line |
| Which tools fail the most | event | count | toolName | count↓, 10 | bar |
| Token usage by agent type | event | sum(totalTokens) | agentName | — | bar |
| Cost per successful run by model | run | avg(costUsd) | model | — | bar |
| Top 10 slowest traces | trace | durationMs | traceId | dur↓, 10 | table |
| Error rate by tool name | event | ratio(failed/all) | toolName | — | bar |
| Number of runs per hour | event | count_distinct(runId) | time(hour) | time↑ | line |
| Avg steps per run by outcome | run | avg(stepCount) | outcome | — | bar |

### Worked compilation (event grain)

Plan for "avg LLM latency by model over time" →

DuckDB:
```sql
SELECT date_trunc('hour', timestamp) AS bucket, model, avg(latency_ms) AS value
FROM events WHERE event_type=$1 AND timestamp>=$2 AND timestamp<$3
GROUP BY bucket, model ORDER BY bucket ASC;
```
ClickHouse:
```sql
SELECT toStartOfHour(timestamp) AS bucket, model, avg(latency_ms) AS value
FROM events WHERE event_type={p1:String} AND timestamp>={p2:DateTime64} AND timestamp<{p3:DateTime64}
GROUP BY bucket, model ORDER BY bucket ASC;
```

### Worked compilation (run grain — the `level` twist)

"Cost per successful run by model" injects a rollup CTE first:
```sql
WITH runs AS (
  SELECT run_id, sum(cost_usd) AS run_cost,
         argMax(model, step_index)  AS run_model,
         argMax(status, step_index) AS run_status
  FROM events WHERE timestamp>={p1} AND timestamp<{p2} GROUP BY run_id)
SELECT run_model AS model, avg(run_cost) AS value
FROM runs WHERE run_status={p3:String} GROUP BY run_model;
```
In production the `runs` CTE is the materialized `runs` rollup table, not a subquery.

---

## 10. NL translation (hybrid)

1. **Deterministic templates** run first — keyword/regex match the catalog + common
   variants → `QueryPlan`. Offline, free, fast; covers the example questions.
2. **LLM planner** fallback — Claude, constrained to emit the `QueryPlan` JSON via a
   tool/output schema, given the metric/dimension/field whitelist in the prompt.
3. **Validate** the output against the same Zod schema; reject if off-grammar.
4. **Compile** the validated plan to the active dialect with bound params.

No arbitrary SQL/code ever reaches the engine. Unsupported NL → clean rejection
with a helpful message and the supported catalog.

---

## 11. SDK design

PostHog-like, hierarchical to support one-trace-many-runs, with single-run sugar.

```ts
const analytics = initAgentAnalytics({ apiKey, host, flushAt: 50, flushIntervalMs: 5000 });
const trace = analytics.startTrace({ agentName, userId, tags });
const run = trace.startRun({ input });
run.captureLLMCall({ model, latencyMs, inputTokens, outputTokens, costUsd });
run.captureToolCall({ toolName, latencyMs, status });
run.captureRetry({ toolName, attempt });   // step-level retry
run.end({ status, output });
const run2 = trace.startRun({ input });     // run-level retry / next turn
run2.end({ status });
await trace.end();                           // derives trace outcome from runs
await analytics.flush();
```

- Every capture auto-stamps `traceId + runId + stepIndex` from its run handle, so
  the wire stays flat (matches storage) while the API stays hierarchical.
- **Sugar:** `analytics.startRun({agentName, userId, input})` opens a trace with one
  run for the common case; `trace.captureLLMCall(...)` delegates to an implicit
  current run.
- **Batching:** `BatchQueue` flushes at `flushAt` count or `flushIntervalMs`.
- **Transport:** `POST /capture` with exponential backoff + jitter, capped retries;
  client-generated `eventId` → server-side idempotent dedup.
- **Lifecycle:** explicit `flush()`; `shutdown()` flushes + clears timer.
- **Backpressure:** bounded in-memory queue with a documented drop/block policy.

---

## 12. Ingestion protocol

- `POST /capture` accepts a batch of `CaptureEvent`s. Validates (required fields per
  event type) and returns fast with per-event status (207-style partial success).
- **Dedup** by `eventId` (at-least-once friendly).
- **Buffer + batched write** to the active `EventStore` (ClickHouse needs large
  batches — never per-event inserts).
- **Local project/API-key:** hardcoded `dev_project_key` → `projectId`, carried into
  every row's leading sort key (multi-tenant-ready schema even though single-tenant
  in the demo).
- **Distributed path (documented, not built):** thin validate-and-enqueue endpoint →
  queue (Kafka/Redis) → async workers → batched insert; big payloads pass references
  not values; dead-letter on repeated failure; horizontal worker scaling for
  backpressure.

---

## 13. Frontend

- NL query input + clickable example questions.
- Chart/table output (line for time-series, bar for categorical, table for detail);
  chart type from `chartHint`, user-overridable.
- **Visible query latency** badge (from `QueryResult.meta`).
- Trace/run explorer: run list with filters (time range, agent, model, tool,
  status) → run detail timeline of events.
- Typed API client over `packages/contracts`. Plain, usable, not polished.

---

## 14. Repository structure

```
packages/
  contracts/   # Zod schemas + types: CaptureEvent, QueryPlan, QueryResult (shared)
  sdk/         # client · trace · run · batch-queue · transport(retry)
apps/
  api/src/
    http/        # controllers: /capture, /query, /traces (validation + wiring)
    ingestion/   # IngestionService: validate→dedup→buffer→batched write
    query/
      planner/   # NL→QueryPlan: deterministic · llm · hybrid
      compiler/  # QueryPlan→CompiledQuery (per-dialect)
      query.service.ts
    domain/      # event unions, Run/Trace aggregates, mappers/
    storage/     # event-store.ts (interface) + adapters/{duckdb,clickhouse}/
  web/src/
    features/query/      # NL input · examples · chart/table · latency
    features/explorer/   # run/trace list + detail + filters
    api-client/          # typed over contracts
simulator/     # uses SDK → demo + ~1M benchmark datasets
bench/         # runs catalog queries across adapters → latency/size report
docs/architecture.md
```

Stack: TS everywhere, pnpm workspaces. API on Node (Fastify/Express). Web on
React + Vite + a chart lib (Recharts). DuckDB via `@duckdb/node-api`; ClickHouse via
`@clickhouse/client` (Docker for local).

---

## 15. Non-goals

Production auth, billing, cloud deploy, complex permissions, full multi-tenant
account management, pixel-perfect UI, a real queue/worker, cold-tier object
storage. All documented where they would change for production.
