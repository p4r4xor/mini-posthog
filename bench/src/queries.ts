/**
 * The supported-query catalog for the benchmark (docs/architecture.md §9).
 *
 * The 8 published catalog questions PLUS "p95 LLM latency by model" (the §9
 * quantile example). Each NL string is run through the REAL hybrid planner
 * (`planQuery`) and compiled with the REAL compiler (`compilePlan`) - exactly
 * the app path. If any catalog query fails to plan we throw loudly: a broken
 * catalog is a benchmark-invalidating bug, not something to silently skip.
 */
import { compilePlan } from "@ata/api/compiler";
import { planQuery } from "@ata/api/planner";
import type { CompiledQuery } from "@ata/contracts";

/** The NL catalog: §9's 8 questions + the p95 quantile example. */
export const CATALOG: readonly string[] = [
  "Average LLM latency by model over time",
  "Which tools fail the most",
  "Token usage by agent type",
  "Cost per successful run by model",
  "Top 10 slowest traces",
  "Error rate by tool name",
  "Number of runs per hour",
  "Average steps per run by outcome",
  "p95 LLM latency by model",
];

export interface BenchQuery {
  /** The natural-language question. */
  nl: string;
  /** The compiled, engine-neutral query the adapter executes. */
  compiled: CompiledQuery;
  /** Which planner stage produced the plan (should be deterministic for all). */
  source: "deterministic" | "llm";
  /** The query level - surfaced because run/trace levels hit the rollup views. */
  level: CompiledQuery["source"];
}

/**
 * Plan + compile the whole catalog against the given dataset window. Throws if
 * any query fails to plan (fail loudly).
 */
export async function buildQueries(window: {
  fromMs: number;
  toMs: number;
}): Promise<BenchQuery[]> {
  const now = new Date(window.toMs);
  const timeRange = {
    from: new Date(window.fromMs).toISOString(),
    to: new Date(window.toMs).toISOString(),
  };

  const queries: BenchQuery[] = [];
  for (const nl of CATALOG) {
    const result = await planQuery(nl, { now, timeRange });
    if (!result.ok) {
      throw new Error(
        `Catalog query failed to plan: "${nl}" - ${result.reason}. ` +
          `The benchmark requires every catalog query to compile.`,
      );
    }
    const compiled = compilePlan(result.plan);
    queries.push({ nl, compiled, source: result.source, level: compiled.source });
  }
  return queries;
}
