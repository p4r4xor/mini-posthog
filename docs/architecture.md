# Agent Trace Analytics, Architecture Note

Owner: Aniketh. A mini PostHog/Mixpanel for AI agent traces: log traces from agent runs,
make them queryable in plain English, show charts and a trace explorer.

The brief's dataset is ~1M events but the design target is 1 billion events/day, potentially ~4KB each,
peak ~10x average. So ~116k events/sec at peak, ~4TB/day raw. What we ship here is a local
prototype but every choice below is made against the billion. Where the prototype cuts a
corner, we say so.

The whole thing is one TypeScript monorepo:

```
SDK --(HTTP or gRPC)--> /capture --> queue (Redis) --> worker --> store (DuckDB or ClickHouse)
                          validate, pull the big payload out to blob storage
        natural-language query --> plan --> SQL --> chart
```

Good thing imo: Store, queue, and blob store all sit behind interfaces, so each is one adapter class plus a
config flag to swap.

## SDK design

Hierarchical and hard to misuse: start a trace, start a run inside it, capture events inside
the run. Each capture auto-stamps the ids, step index, and timestamp so the developer never
hand-builds an event.

```ts
const trace = analytics.startTrace({ agentName: "research-agent", userId });
const run = trace.startRun({ input: "Find pricing for sandbox providers" });
run.captureLLMCall({ model: "gpt-5.2", latencyMs: 842, inputTokens: 1200, outputTokens: 310, costUsd: 0.0142 });
run.end({ status: "success", output: "..." });
await trace.end();
```

One decision I made worth calling out: trace vs run.

- A trace is the logical task (one conversation). A run is one attempt at it. When an agent
  retries, that's a second run on the same trace.
- We keep them separate because "this task failed" and "this task failed twice then worked"
  are different facts, and we can't recover the second one if we flatten at log time.
- For the common single-run case there's sugar (`analytics.startRun`) so nobody pays for it.


## Batching and retry behavior

The rule: never block or crash the agent.

- Events buffer in memory and flush at 50 events or every 5 seconds. `flush()` and
  `shutdown()` force a final send for short scripts.
- Retries use exponential backoff with jitter. 429/5xx retry, 4xx drops and calls `onError`.
- Every event carries a client id so a resent half-landed batch dedups instead of
  double-counting.
- The buffer is bounded. Under sustained overload we drop newest and report via `onError`.
  Blocking the agent or growing memory unbounded are both worse. For analytics a dropped tail
  is acceptable.

## Ingestion protocol

`/capture` never touches the database. At 116k events/sec we can't write to the analytical
store on the request path. So `/capture` checks the key, validates, externalizes the payload,
enqueues, and returns `202`. A worker drains the queue and does the batched idempotent insert.
Queue too deep, and `/capture` returns `429` so backpressure is a number we watch. While we can delegate this to the stream we enqueue, we decided to not do so to keep the prototype simple.

Payload externalization: the 4KB per event is almost all prompt/response text that nobody
aggregates. We strip it to blob storage and put a tiny reference in its place, so the event
through the queue and into the hot store is ~300 bytes. The explorer fetches the text back by
reference when someone opens a trace. That turns 4TB/day into ~300GB/day in the hot path.

Decision: the queue.

- Option Redis Streams: already running, zero new ops, simple. Con: the stream is capped, and
  when full Redis trims oldest-first, so a sustained overload can drop unconsumed events. The
  RAM buffer window is minutes.
- Option Kafka: disk-backed backlog (days, not minutes), partitions, replication.
  Con: another system to run, felt overkill for a prototype.
- Picked Redis now. It's enough to prove the decoupling. Both sit behind one `EventQueue` port
  so Kafka later is one adapter. We pair the cap with the edge 429 so we shed load at the door
  before trimming bites.

How the Redis path stays safe: a worker pulls a batch and acks only after the insert lands. If
it dies mid-insert the batch stays unacked and another worker reclaims it after a timeout.
Nothing is lost. A batch that keeps failing goes to a dead-letter stream after a few tries
instead of blocking the line.

Idempotency is at-least-once plus the client id: DuckDB uses a primary key with `ON CONFLICT
DO NOTHING`, ClickHouse uses ReplacingMergeTree plus insert-time dedup. The port just promises
"insert is idempotent".

Decision: transport (started on HTTP then added gRPC).

- Why gRPC on paper: protobuf is binary so it's smaller on the wire and 3 to 10x cheaper to
  encode/decode than JSON.parse, and the schema doubles as validation so we don't re-check
  every field. HTTP/2 multiplexes many event streams over one long-lived connection instead of
  HTTP/1.1 churning a connection per request (TLS handshakes, head-of-line blocking). Client
  streaming plus HTTP/2 flow control gives backpressure at the transport layer, finer than
  app-level 429 round-trips. HPACK compresses the repeated auth and content-type headers. And
  OTLP is gRPC-first so picking it gives instrumentation interop for free.
- What we actually saw: no direct win. On loopback our HTTP/JSON path beat gRPC (numbers in
  performance results). I think that's an implementation thing (pure-JS grpc-js vs native
  JSON.parse on one machine) more than the protocol. Both transports call the same ingestion
  code so we keep HTTP first-class and run gRPC alongside it.

## Storage engine choice

We wrote two adapters behind one `EventStore` interface and benchmarked both. Two reasons: to
prove the interface holds if one QueryPlan compiles to two very different engines, and because
we hadn't used DuckDB and wanted to see where it lands. DuckDB won the 1M benchmark. It's a
nice result but I don't think that's the prod answer.

Decision: table shape.

- Option flat wide table: one row per event, all attributes as columns, a JSON bag for the
  long tail. Pro: every query is a plain GROUP BY. Con: lots of null columns.
- Option nested spans: con, forces array-unnesting on every query.
- Option one table per event type: con, forces joins, which columnar engines are bad at.
- Picked flat. The nulls are basically free because columnar storage compresses runs of nulls
  to almost nothing.

Decision: the engine.

- Option DuckDB: embedded, in-process, one file, zero ops, and fastest on a single machine at
  1M. Con: single writer, scales only vertically.
- Option ClickHouse: columnar, scales horizontally and vertically, streaming ingest, can pre-aggregate. It's
  also where Langfuse and Laminar landed after Postgres dashboards hit tens of seconds. Con:
  needs a server, and per-query overhead makes it slower than DuckDB at 1M.
- Picked ClickHouse for prod, DuckDB as the zero-setup default so anyone can clone and
  run without Docker.

Our ClickHouse schema uses what matters at scale: ReplacingMergeTree for dedup, LowCardinality
for repeated strings (model, tool, agent) so `GROUP BY model` is nearly free, Enum8 for the
fixed event types, Decimal for money, daily partitions (drop a day by dropping a partition),
and an ORDER BY of tenant then date so time-bounded queries skip almost everything. Point
lookups ("fetch this trace") use a bloom-filter skip index.

What we'd add on ClickHouse later, not built yet:

- Materialized views (AggregatingMergeTree) to keep dashboard rollups updated as events
  arrive, so a chart reads thousands of pre-aggregated rows instead of billions. This is
  pre-aggregation, and it's the biggest lever for dashboard latency. The prototype computes
  the same rollups as plain views at query time.
- Projections: an alternate sort order stored inside the table for specific heavy queries,
  added reactively when one shows up slow.
- Retention: a TTL or scheduled DROP PARTITION removes a whole day in one operation.
- Downsampling: past some age, roll per-second rows up to per-hour and drop the raw, so we
  keep the shape of history without storing every event forever.

How it holds as data grows: 10M is sub-second on DuckDB (benchmarked). 100M is where
ClickHouse's compression and pre-aggregation start to matter. 1B/day is ClickHouse clustered.
The data model never changes across these. That's the point of the flat table plus the
interface.

## Schema/data model

One source table, two derived rollups.

- events: the flat row above, append-only, one per event.
- runs and traces: derived from events, not stored at write time. 
  - A run's cost is the sum of
  its events' costs, its outcome is the status of its last event, its duration is last minus
  first timestamp. The prototype uses a view and prod might use a MV. 
  - We derive
  instead of denormalizing because the outcome isn't known until the run ends and backfilling
  would mean mutations which columnar engines hate.

Two things easy to get wrong:

- Latency is three different fields: per-call latency (on the event), run wall-clock (computed
  from timestamps), and compute time (sum of step latencies). They aren't interchangeable, so
  the grammar keeps them distinct and rejects "duration of an event".
- Cost lives on the operation that spent it, never on the terminal event. The fixture put a
  rollup cost on `trace_completed`, so summing it plus per-call costs double-counts. In our
  model the LLM call carries cost, the run-completed event carries none, so `SUM(cost)` is
  always right.

The code keeps four shapes with explicit mappers between them (wire event, storage row, domain
object, query result) so the wire contract stays stable while storage changes underneath.

## Query translation approach

We never let natural language or an LLM emit SQL. In the middle is a typed QueryPlan: a level
(event/run/trace), a metric, dimensions, filters, a time range, sort, limit, chart hint. A
separate compiler is the only thing that turns a validated plan into parameterized SQL.

This buys safety (every field is a whitelisted enum, no injection surface), portability (one
plan compiles to both engines), and testability (planner and compiler test separately).

The dialects differ in small mechanical ways the compiler owns per engine. Same plan, two
render functions:

| | DuckDB | ClickHouse |
|---|---|---|
| percentile | `quantile_cont(col, p)` | `quantile(p)(col)` |
| time bucket | `date_trunc('hour', ts)` | `toStartOfHour(ts)` |
| dedup | PK `ON CONFLICT DO NOTHING` | ReplacingMergeTree |

A third engine is a third render function with nothing upstream touched.

Translation is layered, cheapest first, and most questions never reach the LLM:

1. Parse a time window if present ("on 18th June", "last 24 hours").
2. Exact templates for the catalog questions.
3. A slot composer for `<aggregation> <measure> by <dimension>`, which covers the long tail
   ("total cost by user", "p99 latency by model") with nothing hardcoded.
4. Only then, and only with an API key, Claude fills a QueryPlan via tool-use, validated by the
   same schema. The LLM fills slots, it never writes SQL.

No valid plan, and the question is rejected with the supported list. The `level` field is what
makes the catalog tractable: "cost per run" and "avg latency" look alike but aggregate
different things, and `level` tells the compiler which source to read.

## Frontend charting approach

Small React app, two screens. The query screen is a text box plus example questions, and shows
the chart along with query latency, which engine served it, and whether the plan came from a
template or the LLM. Chart type follows the plan's hint (line / bar / table), and the renderer
reads each column's role rather than hardcoding names, so it works for any plan. The explorer
is a filterable trace list that opens one trace's timeline, where the externalized payload gets
fetched back. Recharts because the brief didn't want time on pixel polish.

## Performance results

Storage, 1M events, single node, 12 iterations:

| | DuckDB | ClickHouse |
|---|---|---|
| Query latency (typical) | 6 to 25 ms | 25 to 80 ms |
| Bulk ingest | ~68k ev/s | ~95k ev/s |
| On-disk size | 232 MB | 96 MB |
| Compression vs raw JSON | 2.0x | 4.9x |

At 1M on one machine DuckDB is 2 to 4x faster on queries because it runs in-process while
ClickHouse pays a round-trip. A decision made on this number picks DuckDB. That's why we make
the real call at 1B. Even here ClickHouse is 2.4x smaller and ingests ~40% faster. And the
benchmark can't touch what actually matters at scale: horizontal scale, streaming ingest,
materialized views.

Transport, gRPC vs HTTP/JSON, 100k events, loopback. This surprised us. Protobuf is 7.4x
smaller on the wire (44 vs 326 bytes), a real win across a network. But on loopback throughput
our HTTP/JSON path beat gRPC because Node's JSON parser is native C++ while `@grpc/grpc-js` is
pure JS with per-call overhead. So here gRPC buys wire size not throughput. We keep HTTP
first-class and treat the wire win as the reason to run gRPC alongside it.

Both engines return identical results for the same question, confirming the query model is
engine-neutral.

## List of supported natural-language query patterns

No API key needed; the deterministic layers cover everything below. The eight from the brief
work exactly. Beyond those, the composer handles `<aggregation> <measure> by <dimension> [over
<grain>] [top N]`.

- Aggregations: count, distinct count, sum, avg, min, max, percentile (p50/p90/p95/p99 or
  median), ratios.
- Measures: latency, cost, tokens (event); duration, compute time, step count (run).
- Dimensions: model, tool, agent, user, status, outcome, error type, event type.
- Time: relative ("last 24 hours", "yesterday", "this week") and absolute ("on 20/06/2026",
  "between June 1 and June 10", "since June 15"); grain per second to month.

Anything unmapped is rejected with the supported list. Known gaps, each a small grammar
addition: ratio of two sums, HAVING on the aggregate, multi-metric results, period-over-period,
grouping by a metadata field.

## prod scaling notes

The shape at 1B/day, ~116k/sec peak, ~4TB/day raw text:

```
SDK --> L7 LB --> API replicas --> Kafka (partitioned) --> worker pool --> ClickHouse (sharded + replicated)
                                       big payload --> S3                  dashboard reads from ClickHouse
```

- Kafka in front of the store for a disk-backed buffer (days not minutes), partitioned so
  workers scale out.
- Workers as a separate Go/Rust deployment scaling on consumer lag, not in-process.
- Hot/cold split: recent data in ClickHouse on fast disk, old partitions aged to Parquet on
  S3 by TTL. Payloads already live in object storage.
- Materialized views for dashboards instead of query-time views.
- gRPC trap: L4 load balancers break its long-lived HTTP/2 connections, so it needs an
  L7-aware balancer (Envoy) or client-side balancing.
- Multi-tenancy: the query interface requires a project id, so no path can read across tenants
  by omission.

Rough sizing, back of the envelope and not measured at this scale. The slim event is ~300
bytes and ClickHouse compressed our data ~5x, so the hot store is ~60 to 100 GB/day and 90
days hot is a few TB per shard. A 3-shard 2-replica cluster of mid nodes (16 vCPU / 64 GB /
NVMe) carries the peak with query headroom. The text payloads are the real bulk: ~2 TB/day to
S3 after compression, aged out on a TTL. That lands near $0.0003 to $0.0004 per 1k events, and
the bill is dominated by cold text in S3 not the hot store. Which is the whole reason we pull
the payload out at the edge.

Migrating DuckDB to prod is a re-host because the query layer talks to the interface not the
engine. The cutover I'd run: dual-write to both engines, shadow-read and diff results for a
week, then flip reads to ClickHouse and retire DuckDB. No SDK or query-plan change, only the
adapter swaps.

## Observability

At this scale we operate by metrics, not by reading logs. The ones that matter:

- Ingestion: consumer lag (the early warning), enqueue rate vs insert rate, 429 rate,
  dead-letter count.
- Query: p50/p95/p99 latency and which planner layer served it (template, composer, or LLM).
- Storage: parts per partition (insert health), disk per shard, compression ratio.
- Per-tenant volume and error rate so one noisy project is visible instead of hiding in the
  aggregate.

The first thing I'd alert on is consumer lag trending up. It means inserts are falling behind
ingestion and it is exactly what turns into dropped events if ignored. The prototype already
exposes queue depth and per-query timing in the UI, which are the first two of these.

## Notes on what was intentionally skipped

Per the brief: no real auth, billing, deploy, permissions, or account management (project and
key are hardcoded for dev), and no pixel-perfect UI.

Designed but not built, because they only pay off at scale: full OTLP on ingestion (we speak
our own protobuf), materialized views, Kafka, S3 blob store, cold-Parquet tiering, TTL
retention, downsampling, projections, out-of-process workers, and full metrics plus alerting
(the prototype exposes queue depth and per-query timing only). Each is a swap behind an
interface that already exists.

## Summary

The choices, in one line each:

- Flat wide events table, so every query is a GROUP BY and the model survives an engine swap.
- ClickHouse for prod (columnar, horizontal, pre-aggregation), DuckDB as the zero-setup
  default, behind one interface.
- Async ingestion: `/capture` validates, externalizes, enqueues, 202; worker does the insert;
  backpressure is queue depth plus 429.
- Redis Streams now, Kafka later, behind one queue port.
- A typed QueryPlan between language and SQL, never NL straight to SQL.

What would be better with more time: materialized views and projections, Kafka, S3 plus
hot/cold tiering with retention and downsampling, out-of-process workers, metrics and
alerting, a richer plan grammar, and full OTLP. Each is an adapter behind an interface we
already have, so getting there is a re-host, not a rewrite.
