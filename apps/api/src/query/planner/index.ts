/**
 * NL → QueryPlan planner (docs/architecture.md §10).
 *
 * Public surface: `planQuery` (the hybrid entry point) and the supporting types.
 */

export { matchDeterministic } from "./deterministic.js";
export { planQuery } from "./hybrid.js";
export { AnthropicLlmPlanner, defaultLlmPlanner } from "./llm.js";
export type {
  LlmPlanner,
  PlanContext,
  PlanOptions,
  PlanResult,
} from "./types.js";
export { SUPPORTED_QUESTIONS } from "./types.js";
