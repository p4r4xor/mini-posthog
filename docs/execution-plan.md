# Execution Plan & Parallelization

How we build the slice in `docs/architecture.md`, structured so independent
components can be built in parallel (by separate sub-agents/tasks) and integrated
against stable contracts.

## Principle: contracts first, then fan out

Everything hangs off `packages/contracts` (wire DTO, `QueryPlan`, `QueryResult`)
and the `EventStore` interface. Once those two seams are frozen, the rest of the
modules can be built independently and tested in isolation against them. This is
the whole reason for the layered design — it makes the work parallelizable.

## Phase 0 — Foundation (serial, blocking; do first)

- [ ] Monorepo scaffold (pnpm workspaces, tsconfig, lint, vitest).
- [ ] `packages/contracts`: Zod schemas + derived types for `CaptureEvent` (the
      event union), `QueryPlan`, `QueryResult`, `EventRow`, rollup shapes.
- [ ] `EventStore` interface + `CompiledQuery` shape.
- [ ] Domain types + mappers skeleton (DTO↔domain↔row).

> Gate: contracts compile and are imported by a trivial test. Nothing else starts
> until these are frozen, because they are the integration boundary.

## Phase 1 — Parallel build (independent work units)

Each unit owns its files, depends only on the frozen contracts, and ships with its
own tests. Suitable to assign to separate sub-agents/tasks.

| # | Unit | Owns | Depends on | Parallel-safe |
| --- | --- | --- | --- | --- |
| A | **SDK** | `packages/sdk/*` (client, trace, run, batch-queue, transport) | contracts | yes — mock HTTP |
| B | **DuckDB adapter** | `storage/adapters/duckdb/*` + schema/migrations | EventStore, EventRow | yes |
| C | **ClickHouse adapter** | `storage/adapters/clickhouse/*` + DDL + docker-compose | EventStore, EventRow | yes |
| D | **Query compiler** | `query/compiler/*` (QueryPlan→CompiledQuery, dialects) | QueryPlan, CompiledQuery | yes — test w/ hand-written plans |
| E | **NL planner** | `query/planner/*` (deterministic + LLM + hybrid) | QueryPlan | yes — test independent of engine |
| F | **Ingestion API** | `http/capture`, `ingestion/*` (validate, dedup, buffer) | contracts, EventStore | yes — test w/ in-memory store |
| G | **Query API** | `http/query`, `http/traces`, `query.service` | compiler, planner, EventStore | partly — after D/E land |
| H | **Frontend** | `apps/web/*` (NL input, charts, explorer, api-client) | contracts (+ mock server) | yes — mock API responses |
| I | **Simulator** | `simulator/*` (demo + 1M generator) | SDK | yes — after A's surface stabilizes |
| J | **Benchmark harness** | `bench/*` | adapters + compiler | after B/C/D |

Dependency notes:
- A, B, C, D, E, F, H can start immediately once Phase 0 is frozen (H against a
  mock API, F against an in-memory `EventStore`).
- G integrates D+E+EventStore. I needs A's public surface. J needs B+C+D + a
  dataset from I.

## Phase 2 — Integration & data

- [ ] Wire G to real adapters; end-to-end `capture → store → query → UI`.
- [ ] Run I to produce demo + 1M datasets into both engines.
- [ ] Run J; record p50/p95 + on-disk size into `docs/architecture.md` §8.

## Phase 3 — Decision, polish, docs

- [ ] Fill the storage decision (§8) from benchmark numbers + production argument.
- [ ] Supported-query catalog + "unsupported fails cleanly" checks.
- [ ] Submission README (setup/run), architecture note finalize, "what we skipped".

## Suggested first agent fan-out (after Phase 0)

Three independent streams that rarely touch the same files:
1. **Storage stream** — units B + C + J (one owner end-to-end on persistence).
2. **Query stream** — units D + E + G (the QueryPlan pipeline).
3. **Edge stream** — units A + F + I (SDK ↔ ingestion ↔ simulator) and H (frontend).

Integration points are only the frozen contracts + `EventStore`, so streams
collide minimally. Worktree isolation per stream if agents mutate shared config.
