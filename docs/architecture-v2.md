# Agent Trace Analytics — Architecture Note

Owner: Aniketh · A mini PostHog/Mixpanel for AI agent traces.

We log traces from agent runs (LLM calls, tool calls, errors, retries) and make them
queryable in plain English with charts and a trace explorer. This note explains how the
thing is built and, more importantly, why it's built this way and where it would bend.

One framing point up front, because it drives almost every decision below. The benchmark
dataset in the brief is ~1M events, and honestly almost any engine handles 1M. The real
target came from the cofounder: the system should be designed for up to **1 billion events
per day**, ~4KB per event, with peak traffic around 10× the average. So ~11.6k events/sec
average, ~116k/sec at peak, ~4TB/day raw. What actually ships here is a local prototype, but
the choices are made against that number, not against 1M. When the prototype takes a
shortcut, we say so and say what we'd do instead.

The whole thing is one TypeScript monorepo. The shape:

```
SDK ──(HTTP or gRPC)──▶ /capture ──▶ queue (Redis) ──▶ worker ──▶ store (DuckDB or ClickHouse)
        validate, pull the big                                          ▲
        payload out to blob storage          natural-language query ────┘──▶ plan ──▶ SQL ──▶ chart
```

Three things are deliberately swappable behind interfaces: the store (DuckDB or ClickHouse),
the queue (Redis now, Kafka later), and the blob store (local disk now, S3 later). Swapping
any of them is a new adapter class plus a config flag. Nothing upstream changes.

---

## SDK design

The SDK is what an agent author actually touches, so it's built to be hard to misuse. It's
hierarchical: you start a trace, start a run inside it, and capture events inside the run.

```ts
const analytics = initAgentAnalytics({ apiKey, host });
const trace = analytics.startTrace({ agentName: "research-agent", userId });
const run = trace.startRun({ input: "Find pricing for sandbox providers" });
run.captureLLMCall({ model: "gpt-5.2", latencyMs: 842, inputTokens: 1200, outputTokens: 310, costUsd: 0.0142 });
run.captureToolCall({ toolName: "web_search", latencyMs: 1200, status: "success" });
run.end({ status: "success", output: "…" });
await trace.end();
```

Why a trace *and* a run, when the fixture treated them as the same thing? Because a real
agent retries. A trace is the logical thread — one task, one conversation. A run is one
attempt at it. When the whole agent re-runs after a failure, that's a second run on the same
trace. That distinction is the difference between "this task failed" and "this task failed
twice before it worked," and you can't recover it later if you flattened it at log time. For
the common case where there's only ever one run, there's sugar (`analytics.startRun(...)`)
so nobody has to think about it.

Each capture call auto-stamps the boring stuff — event id, trace/run id, step index,
timestamp, agent, user. The developer never hand-assembles an event. The tradeoff worth
calling out: the API is hierarchical but the data that goes over the wire is flat (one row
per event, trace/run ids copied onto each). Flat is what the storage layer wants, hierarchy
is what the developer wants, so we give each side the shape it likes and translate in the
middle.

There's also an optional `at` timestamp on every capture, so you can log past events
(replay, backfill, the benchmark simulator spreading traffic across a week). Defaults to now.

---

## Batching and retry behavior

The rule here is simple: the SDK must never make the agent slow or crash it. Everything is
non-blocking.

Events go into an in-memory queue and flush in batches — when 50 pile up, or every 5 seconds,
whichever comes first. You can also `flush()` on demand and `shutdown()` flushes one last time
on the way out (important for short-lived scripts that would otherwise exit with events still
buffered).

Sends retry with exponential backoff plus jitter. If the server says it's overloaded (429) or
hiccups (5xx), the SDK backs off and tries again. A real 4xx (bad request) is permanent, so we
drop it and call `onError` rather than retry forever. Every event carries a client-generated
id, which is what makes retries safe — if a batch half-landed and we resend it, the server
dedups by id instead of double-counting.

Two honest tradeoffs:

- The in-memory queue is bounded. If the agent produces faster than we can ship for long
  enough, we drop the newest events and tell you via `onError`. The alternative is blocking the
  agent or growing memory unbounded, both worse. For analytics (where you're aggregating, not
  billing), dropping a little tail under sustained overload is acceptable. We chose drop-newest
  and we say so.
- Backoff means an event can be delivered seconds late under pressure. Fine for dashboards,
  and the event keeps its real timestamp, so late delivery doesn't move it on the timeline.

---

## Ingestion protocol

`/capture` does **not** touch the database. That's the single most important thing about it,
and it's a direct consequence of the 1B/day target — at ~116k events/sec peak you cannot
write to the analytical store on the request path, the store would fall over.

So the path is decoupled end to end. `/capture` does four cheap things and returns: it checks
the API key, validates each event, pulls the big payload out (more on that in a second), drops
the event onto a queue, and replies `202 Accepted`. A separate worker drains the queue and does
the heavy, batched, idempotent insert into the store. If the queue backs up past a threshold,
`/capture` starts returning `429` and the SDK backs off — backpressure becomes a number you
watch (queue depth) instead of a crash.

The payload trick is worth explaining because it's where the cost math lives. That ~4KB per
event is almost entirely prompt and response text, which nobody aggregates — you only read it
when you open one trace. So before an event hits the queue, we strip the `input`/`output` text
out to blob storage and replace it with a tiny reference. The event that flows through the
queue and into the hot store is ~300 bytes of actual analytical columns. Concretely: 4KB ×
1B/day is 4TB/day; the slim version is more like 200–400GB/day, and the 4TB of text sits in
cheap object storage that you touch rarely. The queue and the expensive columnar store only
ever carry the small thing. When the explorer needs the full prompt, it fetches it back from
the blob by reference.

Idempotency is at-least-once plus the client event id. DuckDB enforces it with a primary key
and `ON CONFLICT DO NOTHING`. ClickHouse has no unique constraint, so it uses a
ReplacingMergeTree (which collapses duplicate ids when it merges) backed up by deduping at
insert time, so reads don't have to pay for `FINAL`. The point is the interface just says
"insert is idempotent" and each engine keeps that promise its own way.

Two transports sit in front of all this — plain HTTP/JSON and gRPC — and both call the exact
same ingestion code. More on why two in the storage and performance sections.

For local dev the queue is just an in-memory array and the worker runs in the same process, so
you don't need Docker to see it work. Point one env var at Redis and it's the real async
pipeline. Same code either way.

---

## Storage engine choice

This is the decision the brief cares about most, so here's the full reasoning.

We built two real adapters behind one interface and decided between them with a benchmark plus
a production argument, rather than asserting one. The short version: **DuckDB is the local /
embedded engine, ClickHouse is the production engine.** They're not competitors here, they're
two points on a scale.

**Why a wide, flat events table either way.** Every query we care about ("avg latency by
model", "which tools fail the most") is a per-event aggregation. So we store one row per event
in one denormalized table — trace/run attributes copied onto each row — plus a JSON bag for the
long tail of metadata. We deliberately did not model this as nested spans or as one table per
event type. Nested would force array-unnesting on every query; per-type tables would force
joins, and joins are exactly what columnar engines are bad at. The flat table has a lot of null
columns (a tool call has no token count), but columnar storage compresses runs of nulls to
almost nothing, so sparsity is basically free.

**Why ClickHouse for the real target.** At 1B/day you need a columnar engine that does
concurrent streaming ingest, scales horizontally, and can pre-aggregate. ClickHouse is built
for exactly that, and it's what the serious players in this space (Langfuse, Helicone) all
migrated *to* after Postgres dashboards started taking tens of seconds. Our ClickHouse schema
uses the things that matter at scale: ReplacingMergeTree for dedup, `LowCardinality` for the
repeated strings (model, tool, agent — turns `GROUP BY model` nearly free), `Enum8` for the
fixed event-type set, `Decimal` for money so float error doesn't accumulate, **daily
partitions** (a day is ~1B rows, which is a sensibly-sized partition and lets you drop old data
by dropping a partition), and an ORDER BY that puts the tenant and date first so time-bounded
tenant queries skip almost everything. High-cardinality lookups like "fetch this one trace" use
a bloom-filter skip index, because the sort key is tuned for aggregation, not point lookups —
you can't have one key be good at both.

**Why DuckDB for local.** It's an embedded, in-process, columnar engine — "SQLite for
analytics." Zero ops, no container, one file, and on a single machine it's genuinely fast (it
beats ClickHouse on our 1M benchmark, more on that below). For a developer who wants to clone
and run, that's the right default. It's also a legitimate "query Parquet on a laptop" engine
for the cold path.

**Expected query patterns.** Two grains, really. Event-level aggregations (latency by model,
tokens by agent) read the events table directly. Run/trace-level questions (cost per run,
slowest traces, steps per run) read derived rollups. Almost everything is `GROUP BY <a couple
of dimensions>` with an aggregate over a time range, sometimes a top-N. Dashboards are
time-series; the explorer is point lookups and filtered lists.

**Write / ingestion tradeoffs.** ClickHouse hates small frequent inserts (it makes too many
parts and complains), so the worker accumulates large batches before inserting. That's the
whole reason the queue + worker exist. DuckDB is single-writer, which is fine for the
prototype's in-process worker but is one of the reasons it can't be the production store.

**Indexing / partitioning / materialization.** Covered above for ClickHouse — daily partitions,
ORDER BY (project, date, event_type, …), LowCardinality + Enum8, bloom-filter skip indexes.
The rollups (runs/traces) are SQL views today; in production they'd be incremental
materialized views (AggregatingMergeTree) so dashboards read pre-aggregated rows instead of
scanning raw. DuckDB gets the same logical rollups as views and leans on its zonemaps +
insertion order for skipping.

**Local development complexity.** DuckDB: none — `pnpm install` and run, no Docker. ClickHouse:
one `docker compose up`. We made DuckDB the default precisely so the common case has zero
setup, and the production engine is one command away when you want it.

**Would it work in production?** ClickHouse yes, that's the point — it's a re-host, not a
rewrite, because the query layer talks to an engine-neutral interface. DuckDB on a single node
genuinely carries you a long way (tens to ~100M rows), but it's single read-write process and
vertical-only, so past that it's the embedded/edge engine, not the cluster.

**What changes at 10M / 100M / 1B.** At 10M, honestly nothing — DuckDB on a laptop is fine,
sub-second. At 100M, both engines are still single-node viable, but ClickHouse's compression
and materialized views start to matter; this is around where you'd switch the production
deployment to ClickHouse. At 1B/day, ClickHouse clustered is the answer and DuckDB is out: you
need a Kafka/Redpanda buffer in front (the API can't absorb the spike alone), payloads in S3
not inline, hot data in ClickHouse and cold data aged out to Parquet on a TTL. The data model
doesn't change across any of these — that's the payoff of the flat table and the engine
interface.

---

## Schema / data model

There's one source-of-truth table and two derived rollups.

The **events table** is the wide flat row described above: ids, timestamp, agent, user,
event type, and then the columns that are only sometimes set (model, tool, status, error type,
latency, tokens, cost) plus a `metadata` JSON bag. One row per event, append-only.

The **runs** and **traces** rollups are derived from events, not stored separately at write
time. A run's cost is the sum of its events' costs; its outcome is the status of its final
event; its duration is last-timestamp minus first. We compute these at read time (a view in the
prototype, an incremental materialized view in production). We deliberately don't denormalize
the run outcome onto every event row at write time, because you don't know the final outcome
until the run ends and events stream in before that — figuring it out later would mean
mutations, which columnar engines hate. Deriving it is correct regardless of arrival order.

Two modeling details that are easy to get wrong and that we got deliberately right:

- **Latency means three different things and we keep them separate.** Per-call latency (how
  long one LLM call took) lives on the event. Wall-clock duration (how long a run took) is
  computed from timestamps, not stored. "Compute time" (sum of step latencies) is a third
  thing. They're not interchangeable — a run's wall-clock isn't the sum of its steps — so the
  query grammar exposes them as distinct fields and rejects nonsense like "duration of an event."
- **Cost lives on the operation that spent it, never on the terminal event.** The fixture put a
  cost on `trace_completed` that was really a rollup of the same money; if you sum that plus the
  per-call costs you double-count. In our model the LLM call carries its cost, the run-completed
  event carries none, and the type system enforces it. So `SUM(cost)` is always correct.

Under that, the code keeps four representations with explicit translation between them: the wire
event the SDK sends (a strict, validated contract), the storage row, the internal domain
objects, and the query result the frontend gets. They're separate on purpose so the wire
contract can stay stable while the storage layout changes underneath.

---

## Query translation approach

We never let natural language (or an LLM) produce SQL. That's the one hard rule, for safety.

Instead there's a small, closed, typed thing in the middle called a QueryPlan — basically "what
to compute": a level (event / run / trace), a metric (an aggregation over a field, or a ratio,
or a percentile), some group-by dimensions, filters, a time range, sort, limit, and a chart
hint. A question becomes a validated QueryPlan, and a separate compiler is the only thing that
turns a *validated* plan into SQL with bound parameters. The translator and the SQL engine
never touch each other — they only agree on the plan shape. That buys three things: safety (no
SQL injection surface, every field is a whitelisted enum), portability (one plan compiles to
both DuckDB and ClickHouse dialects), and testability (you can test the planner with
hand-written plans and the engine with hand-written plans, separately).

Translation is layered, cheapest first, and most questions never reach the LLM:

1. Parse a time window out of the question if there is one ("on 18th June", "last 24 hours").
2. Exact templates for the catalog questions.
3. A slot composer for everything else — it pulls `<aggregation> <measure> by <dimension>`
   out of the sentence and builds a plan. This is what makes "total cost by user" or "p99 LLM
   latency by model" work without anyone hardcoding them.
4. Only if all of that misses, and only if there's an API key, fall back to Claude — which is
   constrained to emit a QueryPlan via tool-use, and whose output is run through the *same*
   validator before anything happens. The LLM fills slots; it never gets to be creative with SQL.

If nothing produces a valid plan, the question is rejected cleanly with the list of what's
supported. It's never guessed and never run as raw SQL.

The one idea that makes the catalog tractable is `level`. "Cost per run by model" and "avg
latency by model" look similar but one aggregates runs and the other aggregates events. The
`level` field says which, and the compiler points at the right source (events vs the runs
rollup). Without it, half the catalog would be special cases.

---

## Frontend charting approach

It's a small React app, deliberately plain. Two screens.

The query screen is a text box plus a row of example questions. You ask, it shows a chart and —
importantly — the query latency, the engine that served it, and whether the plan came from a
template or the LLM. The chart type is driven by the plan's `chartHint`: a time series renders
as a line, a categorical breakdown as bars, detail as a table. The renderer never hardcodes
column names — it looks at each result column's role (is it the time axis, a dimension, or the
measure) and lays it out accordingly, so it works for any plan the query layer produces, not
just the eight examples.

The explorer is the other screen: a filterable list of traces (by time, agent, model, tool,
status) that opens into a single trace's timeline of events. This is where the externalized
payload gets fetched back, so you can read the actual prompt and response.

Recharts because it's the boring, reliable choice and the brief explicitly didn't want us
spending time on pixel polish.

---

## Performance results

We benchmarked two things: the storage engines, and the two transports. Both results are more
honest than the marketing version, which I think is the point.

**Storage (1M events, single node, 12 iterations).** Loaded 1M events into each engine, ran the
catalog.

| | DuckDB | ClickHouse |
|---|---|---|
| Query latency (typical) | 6–25 ms | 25–80 ms |
| Bulk ingest | ~68k ev/s | ~95k ev/s |
| On-disk size | 232 MB | 96 MB |
| Compression vs raw JSON | 2.0× | 4.9× |

The honest read: at 1M on one machine, **DuckDB is ~2–4× faster on queries**, because it runs
in-process and ClickHouse pays a network round-trip and per-query overhead that dominates at
this size. So if the 1M benchmark were the decision, it'd pick DuckDB. It isn't, and that's the
whole reason we framed it as a sanity check, not the decision. Even at 1M, the things that
actually matter at scale already favor ClickHouse — it's 2.4× smaller on disk and ingests ~40%
faster — and the benchmark can't even exercise the rest (concurrent multi-tenant serving,
horizontal scale, streaming ingest, materialized-view dashboards). The decision is made at
1B/day, where DuckDB simply can't play.

**Transport (gRPC vs HTTP/JSON, 100k events, loopback).** This one surprised me and is worth
being honest about. gRPC's protobuf is **7.4× smaller on the wire** for a typical small event
(326 bytes of JSON vs 44 bytes) — that's a real bandwidth and cost win across a network. But on
CPU and raw loopback throughput, our HTTP/JSON path actually *beat* gRPC. Two reasons, both
about our stack rather than the protocols in theory: Node's JSON parser is native C++ and very
fast, and `@grpc/grpc-js` is a pure-JS implementation with real per-call overhead. So in this
prototype, gRPC isn't a throughput win — it's a wire-size win, and its real throughput
advantages (multiplexing across many connections, a native server, bandwidth savings over a WAN)
only show up off a single-machine loopback. Which is exactly why we keep HTTP as a first-class
transport instead of treating it as a fallback.

Both engines return identical results for the same NL question, which also validates that the
query model is genuinely engine-neutral.

---

## Production scaling notes

The numbers again: ~1B events/day, ~4KB each, ~10× peak → ~116k events/sec peak, ~4TB/day raw,
~1.5PB/year before compression. Designing for that:

- **Buffer in front of the store is mandatory.** The prototype uses Redis Streams, which is
  perfect for one container and demonstrates the decoupling. In production I'd move to
  Kafka/Redpanda. The deciding factor isn't throughput (both clear 116k/sec), it's the buffer
  window: Redis holds the backlog in RAM, so a DB outage gives you minutes; Kafka holds it on
  disk, so you get days, plus partitions and replication. Redis trims under pressure, which can
  drop un-consumed events exactly when you're overloaded — acceptable for analytics, not great.
  The payload-externalization trick stretches Redis's RAM window roughly 13× (because only the
  ~300-byte slim event is buffered, not the 4KB), but Kafka is still the right call at the top of
  the range.
- **Workers scale horizontally on consumer lag.** They're in-process here; in production they're
  a separate deployment, and you'd probably write them in Go or Rust for cheap deserialization.
  Saying that in the doc proves the point as well as building it would.
- **Hot/cold split.** Recent data in ClickHouse on fast disk; age old partitions out to Parquet
  on S3 with a TTL. Payloads already live in S3. This is what keeps the storage bill from being
  the dominant cost.
- **Materialized views for dashboards.** At 1B/day you cannot scan raw events to draw a chart.
  Dashboards read pre-aggregated rollups (AggregatingMergeTree), which is the recording-rule
  pattern. The prototype uses query-time views instead, which is correct but wouldn't hold at
  scale.
- **gRPC's one operational trap:** L4 load balancers break it, because its long-lived HTTP/2
  connections pin to a single backend. You need an L7-aware balancer (Envoy) or client-side load
  balancing. Worth knowing before you turn it on.
- **Multi-tenancy** is enforced where it can't be forgotten: the query interface *requires* a
  project id, so there's no code path that can read across tenants by omission.

---

## List of supported natural-language query patterns

No API key needed for any of this — the deterministic layers cover it. The LLM only kicks in
(if a key is set) for phrasings outside the patterns below.

The eight from the brief, exactly: average LLM latency by model over time; which tools fail the
most; token usage by agent type; cost per successful run by model; top 10 slowest traces; error
rate by tool name; number of runs per hour; average steps per run by outcome.

Beyond those, the slot composer handles `<aggregation> <measure> by <dimension> [over <grain>]
[top N]`, which covers a large surface, e.g.: total cost by user, p99 LLM latency by model,
number of LLM calls by model, errors by error type, average run duration by agent, which models
cost the most.

- Aggregations: count, distinct count, sum, average, min, max, percentile (p50/p90/p95/p99 or
  median), and rates (ratios).
- Measures: latency, cost, tokens (event level); duration, compute time, step count (run level).
- Dimensions: model, tool, agent, user, status, outcome, error type, event type.
- Time windows in the question: relative ("last 24 hours", "past 3 weeks", "today",
  "yesterday", "this/last week or month") and absolute ("on 18th June", "on 2026-06-20", "on
  20/06/2026", "between June 1 and June 10", "since June 15").
- Time-series granularity: per second, minute, hour, day, week, or month.

Anything that doesn't map gets rejected with the supported list. Known gaps, which would each be
a small addition to the plan grammar: ratio of two sums (cost per 1k tokens), HAVING-style
filters on the aggregate (tools with error rate > 10%), more than one metric in a result,
period-over-period comparison, grouping by a metadata/tag field, and arbitrary "for <this
specific agent>" filters.

---

## Notes on what was intentionally skipped

Per the brief, and called out so it's clear these were choices, not misses:

- No real auth, billing, cloud deploy, permissions, or multi-tenant account management. The
  project and API key are hardcoded for local dev.
- No pixel-perfect UI. It's clean and usable, not designed.

Things that are designed and documented but deliberately not built, because they only earn their
keep at production scale:

- gRPC speaks our own protobuf, not full OpenTelemetry/OTLP. Going OTLP would unlock the
  instrumentation ecosystem but it's a data-model remodel, not a transport swap.
- Rollups are query-time views, not incremental materialized views.
- Redis instead of Kafka/Redpanda; local-disk blob store instead of S3; no cold-Parquet tiering
  or TTL retention yet.
- Workers run in-process rather than as a separate, independently-scaled deployment.

Everything in that second list is a swap behind an interface we already have, which was the
whole idea — keep the prototype small, but make the production version a re-host, not a rewrite.
