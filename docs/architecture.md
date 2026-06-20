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

## 2. Open questions (sent to assignment-giver by Aniketh; we proceed on defaults)

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

### Production storage refinements (ClickHouse adapter)

Decisions validated against independent design passes (PostHog/Langfuse + LLM critiques) and folded into the CH adapter (the DuckDB adapter gets equivalents for free via automatic dictionary compression):

- **Column types:** `Enum8` for `event_type` (a *closed* 7-value set — 1 byte, validated at insert); `LowCardinality(String)` for the *open* bounded sets (`agent_name`, `model`, `tool_name`, `status`, `error_type`) — dictionary-encoded, so `GROUP BY model` is near-free; `Decimal(12,6)` for `cost_usd` (exact money; float sums of many tiny costs drift); `DateTime64(3)`; `Nullable` only on sparse measures.
- **Idempotency:** ClickHouse has no unique constraint / no `ON CONFLICT`, so the DuckDB PK trick doesn't port. Use **`ReplacingMergeTree`** with `event_id` last in the `ORDER BY` — duplicate `event_id`s collapse at merge time. **Caveat:** RMT dedup is *eventual* (merge-time); until a merge runs, duplicates are visible, and `SELECT … FINAL` (which forces correctness) is expensive. So we pair RMT with **API-side dedup by `event_id`** (ingestion, §12) so reads never need `FINAL`. Our events are immutable, so RMT is used purely for dedup, never for mutable-status updates.
- **Sort key:** `PARTITION BY toYYYYMM(timestamp)`; `ORDER BY (project_id, toDate(timestamp), event_type, …, event_id)` — date-first (universal time filters + better downstream compression), `event_id` last for the RMT dedup key without polluting the filter prefix.
- **Point lookups vs aggregation:** the aggregation-optimized sort key does *not* give fast single-`trace_id` lookups for the explorer. Resolve with a **bloom-filter skip index / `PROJECTION` on `trace_id` + `run_id`**, not by making `trace_id` the primary key (which would wreck aggregation).
- **Payload externalization (production):** `input`/`output` prompt & response text is large, high-entropy, and never aggregated — at 10B events it bloats the hot table. Production move (Langfuse/Helicone do this): store payload text in **S3/blob and keep only a reference + the analytical columns** in the event row. The prototype keeps text inline in `metadata`; the SDK could later mark a field as payload vs property. `metadata` itself is JSON (general; nested `tags`) + materialize hot keys — chosen over `Map(String,String)` (queryable but string-only) for generality.

### Cross-grain filtering (known extension)

The current `QueryPlan` expresses a metric at one grain. A genuine future need is an **event-grain metric filtered by a run/trace-grain attribute** (e.g. "token usage *for successful runs* by model"). We deliberately keep events pure (streaming-correct; no write-time outcome denormalization that would need mutations). When needed, the compiler will **join `events` → the much-smaller `runs` rollup on `run_id`** (a join to a 1-row-per-run table is cheap even in CH, or backed by a dictionary) — getting denormalized read-simplicity without the write-time-mutation problem.

### The EventStore seam

```ts
interface EventStore {
  init(): Promise<void>
  insertBatch(rows: EventRow[]): Promise<InsertResult>     // idempotent by eventId
  aggregate(q: CompiledQuery): Promise<AggregateResult>     // analytics (adapter-timed)
  listTraces(f: TraceFilter): Promise<TraceSummary[]>       // explorer
  getTrace(projectId, traceId): Promise<TraceDetail | null>
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

### Benchmark results (1M events, local, 12 iterations)

Generated 1,000,007 events / 77,765 traces, bulk-loaded into each engine, ran the
supported-query catalog. Reproduce: `pnpm --filter @ata/bench bench --events 1000000`.

| Query | level | DuckDB p50 / p95 (ms) | ClickHouse p50 / p95 (ms) |
| --- | --- | ---: | ---: |
| Avg LLM latency by model over time | events | 11.9 / 17.3 | 42.0 / 46.1 |
| Which tools fail the most | events | 9.0 / 11.5 | 24.8 / 29.6 |
| Token usage by agent type | events | 6.0 / 8.7 | 27.4 / 30.4 |
| Cost per successful run by model | runs | 18.6 / 25.7 | 57.1 / 67.5 |
| Top 10 slowest traces | traces | 14.5 / 23.0 | 55.4 / 82.5 |
| Error rate by tool name | events | 9.3 / 14.0 | 26.7 / 33.3 |
| Number of runs per hour | events | 16.3 / 21.6 | 51.5 / 69.5 |
| Avg steps per run by outcome | runs | 13.4 / 16.9 | 41.0 / 53.4 |
| p95 LLM latency by model | events | 16.0 / 23.9 | 37.7 / 40.8 |

| Metric | DuckDB | ClickHouse |
| --- | ---: | ---: |
| Bulk ingest throughput | 68k ev/s | **95k ev/s** |
| On-disk size | 232 MB | **96 MB** |
| Compression vs raw JSON | 2.05× | **4.94×** |
| Query latency @1M | **faster (in-process)** | higher (HTTP + per-query overhead) |

**The honest finding — and why it does NOT pick the production engine.** At 1M on a
single node, **DuckDB is ~2–4× faster on queries** — it runs in-process, while every
ClickHouse query pays an HTTP round-trip + fixed per-query overhead that dominates at
this size (matches the literature: DuckDB wins below ~10 GB by avoiding client-server
overhead). So if the 1M benchmark *were* the decision, it would pick DuckDB. It isn't —
and that's the point: **the benchmark is a local correctness/parity + compression check,
not the scaling decision.** The decision is made from the design target (§ below), where
the levers that matter already show in ClickHouse's favor even at 1M: **2.4× smaller on
disk, ~40% faster bulk ingest**, plus the things this benchmark can't exercise on a
laptop — concurrent multi-tenant serving, horizontal scale, streaming ingest, and
incremental MV rollups.

### Decision: DuckDB embedded/local, ClickHouse for the 1B-events/day target

The design parameter (from the cofounder) is **up to 1B events/day, ~4 KB/event,
peak 10× average** → ~**11.6k events/s average, ~116k peak**, ~**4 TB/day raw**,
~1.5 PB/year. Sizing the decision to that, not the 1M benchmark:

- **1M (local/CI):** DuckDB — embedded, zero-ops, fastest in-process. Our default + benchmark engine.
- **10M:** both sub-second single-node; DuckDB is the sweet spot.
- **100M:** both viable single-node (ClickBench-class: CH ~148 ms vs DuckDB ~348 ms once concurrency/scan size grows); ClickHouse's compression + MV rollups start to matter.
- **1B/day:** **ClickHouse, clustered.** DuckDB is structurally out — single read-write process, vertical-only, batch-not-stream (the DuckGres lesson: PostHog had to wrap it in the PG wire protocol + DuckLake to get production access patterns). At 116k peak eps you need concurrent streaming ingest + MV-served dashboards + horizontal scale — ClickHouse's home turf.
- **10B/day:** Kafka/Redpanda shock-absorber is mandatory (the API can't write synchronously); **payload externalization to S3** (the 4 KB is mostly prompt/response text — keep ~200–400 B analytical rows in CH, 4 TB/day of payloads in cheap object storage); hot CH + cold Parquet, TTL-aged by day-partition.

**DuckDB still earns its place at scale** via **federated joins** (its real DuckGres
value): answer "cost per successful run for Pro-tier users" by joining cold trace
Parquet in S3 with an *external* Postgres billing DB in ephemeral DuckDB compute —
something ClickHouse-alone handles poorly. That's why the engine seam (and a DuckDB
path) stays even when ClickHouse is the hot path.

**Duckgres' real production value isn't embedded query — it's federated joins.**
At scale the sharp use case is answering "cost per successful run for Pro-tier
users" by joining trace events (cold, in S3/Parquet) with an *external* Postgres
billing DB, in ephemeral DuckDB compute you pay for only while the query runs —
something ClickHouse-alone handles poorly. That's the strongest argument for
keeping the engine seam (and a DuckDB path) even if ClickHouse is the hot path.

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
- **`quantile`** = a percentile over a numeric measure, with `metric.p` in (0,1),
  e.g. "p95 LLM latency by model" = `{ agg:"quantile", field:"latencyMs", p:0.95 }`
  → CH `quantile(0.95)(latency_ms)` / DuckDB `quantile_cont(latency_ms, 0.95)`.
  Percentiles are first-class because avg latency hides tail behavior.
- **`time` dimension** carries a grain (minute/hour/day) → bucketed timestamp.

Full aggregation set: `count, count_distinct, sum, avg, min, max, ratio, quantile`.

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

A question becomes a validated `QueryPlan` through layers that each fall forward to
the next — most queries never reach the LLM:

1. **Time window** — `parseTimeRange(nl)` extracts "on 18th June" / "last 24 hours"
   / "between June 1 and June 10" / "yesterday". Precedence: **NL-parsed > explicit
   request `timeRange` (UI) > default 7-day lookback**.
2. **Deterministic templates** — keyword match for the 8 catalog questions → exact
   plans. Offline, free, fast.
3. **Slot composer** — for anything outside the catalog, extract
   `<agg> <measure> by <dimension> [over <grain>] [failed/successful] [top N]` into a
   valid plan ("total cost by user", "p99 LLM latency by model", "errors by error
   type", "average run duration by agent", …). Still offline, no API key. Dimension
   implies the event-type scope (`by model`→`llm_call`) so there are no null buckets.
4. **LLM planner (optional)** — Claude, constrained to emit a `QueryPlan` via
   tool-use, only when 2–3 miss *and* `ANTHROPIC_API_KEY` is set.
5. **Validate** — every candidate (template, composer, or LLM) passes
   `QueryPlan.safeParse` before use. This is the single safety gate; off-grammar
   output is rejected, never executed.
6. **Compile** — the validated plan → `CompiledQuery` → the adapter's SQL with
   bound parameters.

No arbitrary SQL/code ever reaches the engine. Unsupported NL → clean rejection with
the supported catalog. Known grammar gaps (ratio-of-sums, HAVING, multi-metric,
period-over-period) are tracked in §17.

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

## 12. Ingestion protocol — the async spine (BUILT)

The pipeline is decoupled end-to-end; `/capture` never touches the database:

```
SDK ─HTTP {events}─▶ POST /capture ─▶ IngestionService ─▶ EventQueue ─▶ IngestionWorker ─▶ EventStore
                         │ validate                 (slim events)        │ batch + idempotent insert
                         └─ externalize payload ─▶ BlobStore (S3/FS)     ▼  return 202 / 429
```

**Two transports, one spine.** Events arrive over either **HTTP** (`POST /capture`,
JSON — browsers/debug) or **gRPC** (`IngestService.Capture` unary + `CaptureStream`
client-streaming, binary protobuf — high-throughput server SDKs; auth via `x-api-key`
metadata). Both map to wire `CaptureEvent`s and call the **same**
`IngestionService.capture(...)` — see §16 for the gRPC-vs-HTTP rationale.

- **`POST /capture`** — `x-api-key` → `projectId` (401 if unknown). Validates each
  `CaptureEvent` (per-event partial success). **Externalizes payload** (top-level
  `input`/`output` text → BlobStore, replaced by a small `metadata.payloadRef`).
  Enqueues the **slim** events and returns **202** (or **429** when queue
  depth ≥ `maxQueueDepth` — the SDK backs off). It does NOT write to the DB.
- **`EventQueue`** (port) — `MemoryEventQueue` (tests) / `RedisStreamQueue`
  (`XADD`+`MAXLEN`, consumer-group `XREADGROUP`→`XACK`, `XAUTOCLAIM` crash recovery,
  dead-letter stream). Carries slim events (~300 B), never the ~4 KB payload.
- **`IngestionWorker`** — drains in large batches → `captureEventToRow` →
  `store.insertBatch` (idempotent by `eventId`; at-least-once safe). In-process for
  the prototype; a separate, horizontally-scaled deployment in prod (scale on
  consumer lag).
- **Payload externalization** — the prompt/response text (the bulk of 4 KB/event,
  never aggregated) goes to object storage (FS now, S3 in prod), keeping the queue
  and hot store ~200–400 B/row (§6). The explorer hydrates it back on read.
- **Local project/API-key** — hardcoded `dev_project_key` → `projectId`, carried
  into every row's leading sort key (multi-tenant-ready, single-tenant in the demo).

### Backpressure & idempotency (layers, current status)

| Layer | Mechanism | Status |
| --- | --- | --- |
| SDK in-memory queue | bounded `maxQueueSize`, drop-newest + `onError` | **built** |
| SDK → API transport | retry w/ exp backoff + jitter on `429`/`5xx` | **built** |
| API edge | validate + externalize + enqueue; **`429` when queue depth ≥ cap** | **built** |
| Queue buffer | Redis Streams decouples API from DB; DB stall → events buffer; backpressure = depth/lag, not a crash | **built (Redis, local)** |
| Durable buffer at scale | Kafka/Redpanda: disk-backed (days), partitions, replication | documented (§8) |

**Idempotency** is at-least-once + client `eventId`. DuckDB enforces it with a PK
(`ON CONFLICT DO NOTHING`); ClickHouse uses `ReplacingMergeTree` (eventual,
merge-time dedup) **+ the worker's batched `insertBatch`** so normal reads avoid
`FINAL`. The `EventStore` contract just says "idempotent insert"; each adapter
satisfies it its own way.

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
  contracts/   # Zod schemas + types: CaptureEvent, QueryPlan, QueryResult, EventStore (shared)
  sdk/         # client · trace · run · batch-queue · transport(retry)
apps/
  api/src/
    http/app.ts          # routes: /capture, /query, /traces, /health
    config.ts            # project/api-key, engine + queue selection, knobs
    blob/                # BlobStore port + LocalBlobStore (payload externalization)
    ingestion/
      ingestion-service.ts # edge: validate → externalize → enqueue → 429
      payload.ts           # externalizePayload / hydratePayload
      worker.ts            # IngestionWorker: drain queue → batched idempotent insert
      queue/               # EventQueue port + memory + redis-stream + factory
    query/
      planner/   # NL→QueryPlan: time-range · deterministic · compose · llm · hybrid
      compiler/  # QueryPlan→CompiledQuery (engine-neutral)
      query-service.ts
    storage/
      adapters/duckdb/     # DuckDBEventStore + schema + field-map + sql-render
      adapters/clickhouse/ # ClickHouseEventStore + schema (RMT, daily partitions, …)
      store-factory.ts
  web/src/
    features/query/      # NL input · examples · chart/table · latency
    features/explorer/   # run/trace list + detail + filters
    api-client/          # typed over contracts
simulator/     # uses the SDK → demo + ~1M benchmark datasets
bench/         # streams a dataset into each engine → latency/size/compression report
docs/architecture.md ; docker-compose.yml (ClickHouse 26.5 + Redis 7.4)
```

Stack: TS everywhere, pnpm workspaces, Biome (lint+format), vitest, a pre-commit
gate + CI. API on Fastify. Web on React 19 + Vite 8 + Recharts. DuckDB via
`@duckdb/node-api`; ClickHouse via `@clickhouse/client`; Redis via `ioredis`.

---

## 15. Component architecture — who talks to whom, and why

### Components

| Component | Where it runs | Responsibility |
| --- | --- | --- |
| **SDK** (`@ata/sdk`) | inside the user's agent process | build `CaptureEvent`s, batch, retry, flush, backpressure |
| **`@ata/contracts`** | shared library | the *lingua franca*: wire DTO, `QueryPlan`, `QueryResult`, `EventRow`, `EventStore` port, mappers |
| **HTTP layer** (`http/app.ts`) | API process | thin Fastify routes; auth + shape-check only |
| **IngestionService** | API process | edge: validate → externalize payload → enqueue → 429 |
| **BlobStore** | API process → FS/S3 | store/fetch large payload text |
| **EventQueue** | API ↔ Redis | buffer between edge and DB (Redis Streams) |
| **IngestionWorker** | API process (prod: separate) | drain queue → batched idempotent insert |
| **QueryService** | API process | orchestrate planner → compiler → store → `QueryResult` |
| **planner / compiler** | API process | NL → `QueryPlan` → `CompiledQuery` |
| **EventStore adapter** | API ↔ DuckDB/ClickHouse | persistence + analytics SQL |
| **Web** (`@ata/web`) | browser | NL query UI + trace explorer |
| **Simulator / Bench** | CLI | generate data via the SDK / benchmark the adapters |

### Write path (who calls whom, what crosses, why the boundary)

| Edge | What crosses | Why this boundary exists |
| --- | --- | --- |
| agent → **SDK** | method calls (`captureLLMCall`, …) | ergonomic API; hides batching/retry/transport |
| SDK → **`/capture`** | HTTP POST, `{events}` + `x-api-key` | network seam; lets retry/backoff/idempotency live client-side; server-language-agnostic |
| `/capture` → **IngestionService** | validated request | keep HTTP thin; logic unit-testable |
| IngestionService → **BlobStore** | `input`/`output` text | keep ~4 KB out of the queue + hot store (cost) |
| IngestionService → **EventQueue** | slim events + `projectId` | decouple ingest from DB; absorb 10× peak; 429 backpressure |
| Worker ← **EventQueue** | slim events (consumer group) | drain at the DB's pace; horizontal scaling; at-least-once |
| Worker → **EventStore** | `EventRow[]` (large batch) | idempotent batched write; engine-neutral via the port |

### Read path

| Edge | What crosses | Why |
| --- | --- | --- |
| web → **`/query`** | `{ q }` (natural language) | the product surface |
| QueryService → **planner** | `nl` → `QueryPlan` | NL kept entirely separate from execution |
| QueryService → **compiler** | `QueryPlan` → `CompiledQuery` | one validated IR; safety + portability |
| QueryService → **EventStore.aggregate** | `CompiledQuery` + `projectId` | tenant scoping enforced in the signature |
| web → **`/traces`/`:id`** | filters / id → `TraceSummary[]`/`TraceDetail` | explorer; `getTrace` then hydrates payloads from BlobStore |
| planner → **Anthropic** (optional) | constrained tool-use → unvalidated plan | long-tail NL; output re-validated by `QueryPlan` (the gate) |

**The three load-bearing seams** (everything else is replaceable behind them):
`EventStore` (DuckDB ↔ ClickHouse), `EventQueue` (Redis ↔ Kafka), `BlobStore`
(FS ↔ S3). Swapping any is a new adapter class + a config flag — no call site moves.

---

## 16. Design rationale — why this way

- **Wide flat event table + JSON bag** (not nested spans, not per-type tables): the
  query patterns are per-event aggregations; flat rows avoid joins (ClickHouse's
  weak spot) and absorb schema change. Sparse nulls compress to ~nothing. (§4, §6)
- **Four layered types + mappers** (wire DTO / domain / row / result): the wire is a
  strict contract that makes illegal events unrepresentable; storage is optimized
  for scan; neither leaks into the other. (§4, §5)
- **`QueryPlan` IR, never NL→SQL**: one closed, validated structure → safety (no
  injection), portability (one plan → two dialects), testability (planner and engine
  never import each other). (§9)
- **`EventStore` port + two real adapters**: the storage choice is *earned by a
  benchmark + a 1B/day argument*, not asserted — and stays swappable. DuckDB =
  embedded/local; ClickHouse = production scale. (§8)
- **Async queue + worker + payload externalization**: the design target is up to
  **1B events/day** (§8). `/capture` must return fast and shed load; the queue
  absorbs the 10× peak; keeping 4 KB payloads out of the queue/hot store is the cost
  lever that makes the buffer and the cluster affordable. (§6, §12)
- **Redis Streams now, Kafka/Redpanda in prod**: Redis is one container and the
  durability gap is acceptable for analytics; Kafka wins at scale on disk-backed
  buffering (days vs RAM-minutes), partitions, and replication. Payload
  externalization stretches Redis's RAM-bounded window ~13×. (§8)
- **Deterministic-first hybrid NL**: templates + a slot composer cover the bulk
  offline (no API key, fast, predictable); the LLM is a constrained fallback behind
  the same validation gate. (§10)
- **Tenant scoping in the `aggregate` signature**: scoping is a required argument the
  adapter always applies, so a cross-tenant leak isn't a thing a caller can forget.
- **ClickHouse specifics**: daily partitions (day-granular TTL at 1B/day), `RMT`
  dedup, `LowCardinality`/`Enum8`, bloom skip-indexes for explorer lookups. (§6)
- **Quality gate**: Biome + strict TS + vitest + a pre-commit hook + CI — so
  cross-package drift and regressions are caught by the CLI, not the editor.

---

## 17. Pending & intentionally deferred

Honest accounting of what is **not** built, why, and what it would take.

**Built since first draft:** the async ingestion spine (queue + worker + 429),
payload externalization, NL time-range parsing + the slot composer, the 1M
benchmark, and **gRPC ingestion** (own-protobuf `Capture` + `CaptureStream`,
alongside HTTP — §12/§16).

**Next up (highest signal):**
- **AggregatingMergeTree materialized views** for time-series/rollups. `runs`/`traces`
  are query-time views today; at 1B/day dashboards must read incremental MVs. (§7)
- **Full OTLP compatibility** — our gRPC is own-protobuf; speaking OTLP/GenAI
  conventions would unlock the OpenTelemetry instrumentation ecosystem (a remodel,
  not a transport swap).

**Production hardening (documented, would swap an adapter):**
- **Kafka/Redpanda** behind `EventQueue`; **S3** behind `BlobStore`; cold **Parquet**
  tiering + **TTL/retention**; a **separate worker deployment** (Rust/Go) scaled on
  consumer lag.
- **Real auth / multi-tenant account management** (hardcoded dev key today).
- **Wire `schemaVersion`** + a protobuf schema registry; pipeline observability
  (consumer-lag metrics, DLQ monitoring).

**Query grammar extensions (small IR additions):**
- ratio-of-sums (`cost per 1k tokens`), `HAVING` (`tools with error rate > 10%`),
  multi-metric results, period-over-period comparison, group-by `metadata`/tags.

**Cross-grain filtering** (event metric filtered by a run/trace attribute) — planned
as an `events → runs` join (§6 "Cross-grain filtering").

**UI polish:** a time-range picker on the query view (NL parsing works today; the
API already accepts an explicit range), payload display in the explorer, chart styling.

---

## 18. Non-goals (per the brief)

Production auth, billing, cloud deployment, complex permissions, full multi-tenant
account management, and pixel-perfect UI are out of scope by the brief. Each is noted
above where it would change for production.
