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

### Backpressure & idempotency (four layers)

| Layer | Mechanism | Status |
| --- | --- | --- |
| SDK in-memory queue | bounded `maxQueueSize`, drop-newest + `onError` | built |
| SDK → API transport | retry w/ exp backoff + jitter on `429`/`5xx` (server can push back) | built |
| API ingestion | validate → batched write; **emit `429` when the buffer is full** | partial (429 shedding TODO) |
| Kafka shock-absorber | decouples API from DB; CH outage → events buffer; backpressure = consumer lag, not a crash | documented |

**Idempotency** is at-least-once + client-generated `eventId`. DuckDB enforces it
with a PK (`ON CONFLICT DO NOTHING`); ClickHouse can't (no unique constraint), so
it uses `ReplacingMergeTree` (eventual, merge-time dedup) **plus API-side `eventId`
dedup** so reads avoid the expensive `FINAL`. ClickHouse's native
insert-block dedup also catches byte-identical batch retries for free. The
`EventStore` contract just says "idempotent insert"; each adapter satisfies it its
own way — the rest of the system never knows.

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
