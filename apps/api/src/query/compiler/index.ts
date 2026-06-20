/**
 * Query compiler: QueryPlan (validated IR) → CompiledQuery (neutral, engine-
 * agnostic). See docs/architecture.md §9.
 */

export { deriveChartHint, isTimeDimension } from "./chart.js";
export { compilePlan } from "./compiler.js";
