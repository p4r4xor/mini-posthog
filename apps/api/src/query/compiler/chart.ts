import type { ChartHint, Dimension, QueryPlan } from "@ata/contracts";

/**
 * Chart selection actually lives in the planner - the plan already carries
 * `chartHint`, and the compiler's job is a faithful QueryPlan→CompiledQuery
 * translation, not chart selection. We still expose a tiny helper so callers
 * (and tests) have one place that documents the intended mapping.
 *
 * Heuristic (matches the §9 catalog):
 *   - a time dimension present        → "line" (time-series)
 *   - >0 categorical dimensions, no time → "bar"  (categorical breakdown)
 *   - no dimensions                   → "table" (a single scalar / detail)
 */
export function deriveChartHint(plan: QueryPlan): ChartHint {
  const dimensions = plan.dimensions ?? [];
  const hasTime = dimensions.some(isTimeDimension);
  if (hasTime) return "line";
  const hasCategorical = dimensions.some((d) => !isTimeDimension(d));
  if (hasCategorical) return "bar";
  return "table";
}

/** Narrowing guard for the `{ time: grain }` dimension variant. */
export function isTimeDimension(
  dim: Dimension,
): dim is Extract<Dimension, { time: unknown }> {
  return typeof dim === "object" && dim !== null && "time" in dim;
}
