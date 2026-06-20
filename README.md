# Agent Trace Analytics

A mini PostHog/Mixpanel for **AI agent traces** — log traces from an SDK, ingest them
through an async pipeline, store them in a **swappable analytical engine (DuckDB or
ClickHouse)**, and explore them with **natural-language queries**, charts, and a trace
explorer.

- **Full design + rationale:** [`docs/architecture.md`](docs/architecture.md) — component
  communication map (§15), design rationale (§16), pending/skipped (§17–§18), the earned
  storage decision + 1M benchmark (§8).
- **Original assignment:** [`docs/TASK.md`](docs/TASK.md).

```
SDK ─HTTP/JSON or gRPC─▶ /capture ─▶ EventQueue (Redis Streams) ─▶ Worker ─▶ EventStore (DuckDB│ClickHouse)
        │ validate + externalize payload → BlobStore (FS│S3)                 ▲
        └ 202 / 429 (backpressure)                          NL query ─▶ planner → compiler → aggregate → chart
```

## Packages

| Path | What |
| --- | --- |
| `packages/contracts` | Shared Zod schemas + types: the wire `CaptureEvent`, `QueryPlan` IR, `QueryResult`, `EventStore` port — the contract everything depends on |
| `packages/sdk` | TS logging SDK: hierarchical trace→run→event, count/time batching, retry w/ backoff, bounded-queue backpressure, `flush`/`shutdown` |
| `apps/api` | Ingestion (HTTP + gRPC → queue → worker → store), NL query, trace explorer |
| `apps/web` | React + Recharts UI: NL query + charts + trace explorer |
| `simulator` | Toy agent simulator — generates realistic traces **through the SDK** (demo + ~1M) |
| `bench` | Storage benchmark (DuckDB vs ClickHouse) + transport benchmark (gRPC vs HTTP) |

## Prerequisites

- **Node ≥ 20**, **pnpm 8+**
- **Docker** — only for the ClickHouse + Redis path; the DuckDB quick-start needs nothing.

```bash
pnpm install
```

## Quick start (DuckDB — zero external dependencies)

Embedded DuckDB + in-memory queue, no Docker. Fastest way to see it end-to-end.

```bash
# 1) API on :3000 (HTTP) + :50051 (gRPC), DuckDB engine, in-memory queue
pnpm --filter @ata/api start

# 2) generate a demo dataset through the real SDK (new terminal)
pnpm --filter @ata/simulator exec tsx src/index.ts --mode demo --events 2000

# 3) web UI on :5173 (proxies API calls to :3000)
pnpm --filter @ata/web dev
```

Open **http://localhost:5173** and click an example question. With the in-memory queue the
worker runs in-process, so events are queryable immediately.

## Production engine (ClickHouse + Redis Streams)

```bash
docker compose up -d                      # ClickHouse 26.5 + Redis 7.4
ATA_ENGINE=clickhouse ATA_QUEUE=redis pnpm --filter @ata/api start
pnpm --filter @ata/simulator exec tsx src/index.ts --mode demo --events 20000
```

The web UI, queries, and explorer are identical — the **engine and queue are swapped by
env vars only**. With Redis, ingestion is fully async (capture returns `202`; a worker
drains the stream into ClickHouse), and prompt/response payloads are externalized to the
blob store (only a small reference flows through the queue).

## Simulator

```bash
pnpm --filter @ata/simulator exec tsx src/index.ts \
  --mode demo|benchmark  --events N  --host http://localhost:3000 \
  --api-key dev_project_key  --days 7  --seed 1
```

`demo` ≈ 2,000 events; `benchmark` ≈ 1,000,000. Deterministic (seeded), spreads events
over a historical window, multiple agents/models/tools, successes + failures + retries.

## Benchmarks

```bash
# storage: DuckDB vs ClickHouse (streaming load, memory-safe) — needs ClickHouse up
pnpm --filter @ata/bench exec tsx src/index.ts --events 200000 --engines duckdb,clickhouse

# transport: gRPC vs HTTP — wire size, serialization CPU, loopback throughput
pnpm --filter @ata/bench exec tsx src/transport-bench.ts --events 100000
```

Latest results + interpretation live in `docs/architecture.md` §8.

## Tests & quality gate

```bash
pnpm lint        # Biome (lint + format)
pnpm typecheck   # tsc across all packages
pnpm test        # vitest — the ClickHouse suite needs `docker compose up -d clickhouse`
pnpm check       # lint + typecheck + test
```

A **pre-commit hook** runs lint + typecheck + tests (excluding the ClickHouse suite, which
needs a server); **CI** (`.github/workflows/ci.yml`) runs the full gate with a ClickHouse
service.

## Configuration (env vars)

| Var | Default | Purpose |
| --- | --- | --- |
| `ATA_ENGINE` | `duckdb` | storage engine: `duckdb` \| `clickhouse` |
| `ATA_DB_PATH` | `ata.duckdb` | DuckDB file path |
| `ATA_PORT` | `3000` | HTTP port |
| `ATA_GRPC_PORT` | `50051` | gRPC port |
| `ATA_QUEUE` | `memory` | ingestion queue: `memory` \| `redis` |
| `ATA_REDIS_URL` | `redis://localhost:6379` | Redis Streams URL |
| `ATA_BLOB_DIR` | `<cwd>/data/blobs` | externalized-payload dir (FS blob store) |
| `ATA_MAX_QUEUE_DEPTH` | `100000` | edge backpressure threshold (→ 429) |
| `ATA_WORKER_BATCH` / `_MS` | `5000` / `1000` | worker insert batch size / max wait |
| `ATA_CH_URL/USER/PASSWORD/DATABASE` | `http://localhost:8123` / `ata` / `ata` / `ata` | ClickHouse connection |
| `ANTHROPIC_API_KEY` | — | optional; enables the LLM fallback planner |

Local project/API-key are hardcoded for dev: API key **`dev_project_key`** → project
**`proj_dev`**.

## Supported natural-language queries

Deterministic-first (no API key needed): exact catalog templates → a slot composer →
time-range parsing; an optional Claude fallback (`ANTHROPIC_API_KEY`) covers the long tail.
Full grammar in `docs/architecture.md` §9–§10. Representative examples:

- **Catalog:** *"Average LLM latency by model over time"*, *"Which tools fail the most?"*,
  *"Token usage by agent type"*, *"Cost per successful run by model"*, *"Top 10 slowest
  traces"*, *"Error rate by tool name"*, *"Number of runs per hour"*, *"Average steps per
  run by outcome"*.
- **Composer families** (`<agg> <measure> by <dimension> [over <grain>] [top N]`): *"total
  cost by user"*, *"p99 LLM latency by model"*, *"number of llm calls by model"*, *"errors
  by error type"*, *"average run duration by agent"*, *"which models cost the most"*.
- **Time ranges:** *"… on 20/06/2026"*, *"… last 24 hours"*, *"… yesterday"*, *"… this
  week"*, *"… between June 1 and June 10"*, *"… since June 15"*.
- **Grains:** *"… per second / minute / hour / day / week / month"*.

Unsupported questions are rejected cleanly with the supported list (never guessed, never
run as raw SQL).

## What was intentionally skipped

Per the brief: production auth, billing, cloud deploy, complex permissions, full
multi-tenant account management, pixel-perfect UI. Documented production-but-not-built
items (gRPC→full OTLP, AggregatingMergeTree rollup MVs, Kafka/Redpanda, S3 blob store,
cold-Parquet tiering) are in `docs/architecture.md` §17.
