/**
 * Query compiler: QueryPlan (validated IR) → CompiledQuery (neutral, engine-
 * agnostic). See docs/architecture.md §9.
 */
export { compilePlan } from "./compiler.js";
export { deriveChartHint, isTimeDimension } from "./chart.js";
