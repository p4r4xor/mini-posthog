import type { CompiledQuery, EventStore, QueryResult, TimeRange } from "@ata/contracts";
import { compilePlan } from "./compiler/index.js";
import type { LlmPlanner } from "./planner/index.js";
import { planQuery } from "./planner/index.js";

export interface RunQueryOptions {
  /** Project to scope the query to (injected as a where predicate). */
  projectId: string;
  /** Explicit time window; otherwise the planner's default lookback applies. */
  timeRange?: TimeRange;
  /** Result cap; applied only when the compiled plan has no limit of its own. */
  limit?: number;
  /** Inject a fake LLM planner in tests; defaults to the real Anthropic client. */
  llm?: LlmPlanner;
}

export type RunQueryResult =
  | { ok: true; source: "deterministic" | "llm"; result: QueryResult }
  | { ok: false; reason: string; supported: string[] };

/**
 * Query service (docs/architecture.md §9): NL → plan → compile → scope → run.
 *
 * It plans the question, compiles the validated plan to a neutral CompiledQuery,
 * injects a project-scoping predicate (tenancy is enforced here, never trusted
 * from the client), runs it on the store, and composes the chart-ready
 * QueryResult by attaching the plan + chart hint it owns.
 */
export class QueryService {
  constructor(private readonly store: EventStore) {}

  async run(q: string, opts: RunQueryOptions): Promise<RunQueryResult> {
    const plan = await planQuery(q, {
      timeRange: opts.timeRange,
      llm: opts.llm,
    });
    if (!plan.ok) {
      return { ok: false, reason: plan.reason, supported: plan.supported };
    }

    const compiled: CompiledQuery = compilePlan(plan.plan);

    // Apply caller limit only when the plan didn't specify one.
    if (opts.limit !== undefined && compiled.limit === undefined) {
      compiled.limit = opts.limit;
    }

    // Tenancy is enforced by the store (aggregate requires a projectId), so it
    // cannot be forgotten on any query path.
    const agg = await this.store.aggregate(compiled, opts.projectId);

    const result: QueryResult = {
      columns: agg.columns,
      rows: agg.rows,
      meta: {
        latencyMs: agg.latencyMs,
        rowCount: agg.rowCount,
        engine: agg.engine,
        plan: plan.plan,
      },
      chartHint: plan.plan.chartHint,
    };

    return { ok: true, source: plan.source, result };
  }
}
