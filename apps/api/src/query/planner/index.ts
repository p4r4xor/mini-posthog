/**
 * NL → QueryPlan planner (docs/architecture.md §10).
 *
 * Public surface: `planQuery` (the hybrid entry point) and the supporting types.
 */
export { planQuery } from "./hybrid.js";
export { matchDeterministic } from "./deterministic.js";
export { AnthropicLlmPlanner, defaultLlmPlanner } from "./llm.js";
export { SUPPORTED_QUESTIONS } from "./types.js";
export type {
  PlanResult,
  PlanOptions,
  PlanContext,
  LlmPlanner,
} from "./types.js";
